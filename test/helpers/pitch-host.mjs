// 共享的 PitchControl 假宿主模型。默认语义是确定性测试替身，不等同于真机保证：
//   - 排序、插入索引、remove 后状态、clone 和数值存储可由 Host Profile 校准。
//   - 未确认语义在宽松模式标记为 simulator_default，严格模式直接拒绝使用。
//   - PitchControlPoint 没有 getPoints/getValueAt/setPoints（调用即抛 "no such method"，
//     与真实宿主经 classifyHostError 后的 UNKNOWN_METHOD 一致）；PitchControlCurve 有。
// 供 pitch-control(读)、pitch-control-patch(写)、bake-computed-pitch 三个测试文件复用。
// 支持逐方法故障注入（failures: [{method, code, message, remainingSkips}]）与 Undo 计数。

import {
  hostModelDefaultsFromProfile,
  validateHostBehaviorProfile,
} from "../../tools/lib/host-behavior-profile.mjs";

const DEFAULT_Q = 705600000;

export function createPitchHostModel(options = {}) {
  const hostProfile = options.hostProfile
    ? validateHostBehaviorProfile(options.hostProfile)
    : null;
  const profileDefaults = hostProfile
    ? hostModelDefaultsFromProfile(hostProfile)
    : {};
  const evidencePolicy = options.evidencePolicy ?? "allow-simulator-default";
  if (!["allow-simulator-default", "require-confirmed"].includes(evidencePolicy)) {
    throw new TypeError("evidencePolicy must be allow-simulator-default or require-confirmed");
  }
  const {
    uuid = "uuid-group-1",
    timeOffsetBlick = 0,
    pitchOffsetSemitone = 0,
    referenceOnsetBlick = null,
    referenceEndBlick = null,
    notes = null,
    controls = [],
    computedPitchValues = null,
    automationPoints = [],
    quarterBlick = profileDefaults.quarterBlick ?? DEFAULT_Q,
    // shared-target：第二个 NoteGroupReference 指向同一 group，但 offset 不同。
    secondReference = null,
  } = options;
  const hostVersion = profileDefaults.hostVersion ?? "2.2.1";

  let nextHandle = 1000;
  const handle = (type) => ({ __handle__: nextHandle++, __type__: type, __epoch__: 1 });
  const h = {
    project: handle("Project"),
    sv: handle("SV"),
    mainEditor: handle("MainEditorView"),
    timeAxis: handle("TimeAxis"),
    track: handle("Track"),
    reference: handle("NoteGroupReference"),
    reference2: secondReference ? handle("NoteGroupReference") : null,
    group: handle("NoteGroup"),
    automation: handle("Automation"),
  };

  const noteList = (notes ?? [
    { onset: 0, duration: quarterBlick, pitch: 60, lyrics: "a" },
    { onset: quarterBlick, duration: quarterBlick, pitch: 62, lyrics: "i" },
    { onset: 2 * quarterBlick, duration: quarterBlick, pitch: 64, lyrics: "u" },
  ]).map((state) => ({ handle: handle("Note"), state: { phonemes: "", language: "", detune: 0, ...state } }));

  const model = {
    handles: h,
    uuid,
    timeOffsetBlick,
    pitchOffsetSemitone,
    quarterBlick,
    notes: noteList,
    // controls: [{ id, state:{kind,position,pitch,points,scriptData,detached} }]，按 position 升序。
    controls: [],
    automationPoints: automationPoints.map((point) => [point[0], point[1]]),
    undoCount: 0,
    hostCalls: [],
    failures: [],
    ignoreSetters: new Set(),
  };
  const semanticCoverage = new Map();
  const useSemantic = (key, simulatorDefault) => {
    const fact = hostProfile?.semantics?.[key];
    if (fact?.status === "confirmed") {
      semanticCoverage.set(key, { key, source: "live_profile", status: "confirmed" });
      return fact.value;
    }
    const status = fact?.status ?? "missing";
    if (evidencePolicy === "require-confirmed") {
      semanticCoverage.set(key, { key, source: "unconfirmed", status });
      const error = new Error(`host semantic ${key} is ${status}; live confirmation is required`);
      error.code = "UNCONFIRMED_HOST_SEMANTIC";
      error.semanticKey = key;
      error.semanticStatus = status;
      throw error;
    }
    semanticCoverage.set(key, { key, source: "simulator_default", status });
    return simulatorDefault;
  };
  const requireReferenceBoundary = (explicit, derived, label) => {
    if (explicit !== null && explicit !== undefined) return explicit;
    const independent = useSemantic(
      "occurrence.referenceBoundsIndependentOfNoteBounds",
      false
    );
    if (independent === true) {
      const error = new Error(
        `${label} must be supplied because the live profile confirms independent reference bounds`
      );
      error.code = "HOST_SCENARIO_REQUIRED";
      error.scenarioField = label;
      throw error;
    }
    return derived;
  };

  const sortControls = () => {
    const ordering = useSemantic("pitchControl.ordering", "position_ascending");
    const equalAnchor = useSemantic(
      "pitchControl.equalAnchorTieBreak",
      "insertion_stable"
    );
    if (ordering === "insertion_order") return;
    const direction = ordering === "position_descending" ? -1 : 1;
    model.controls.sort(
      (a, b) =>
        direction * (a.state.position - b.state.position) ||
        (equalAnchor === "insertion_stable" ? a.seq - b.seq : b.seq - a.seq)
    );
  };

  let seq = 0;
  const makeControlState = (spec) => ({
    kind: spec.kind,
    position: spec.position ?? 0,
    pitch: spec.pitch ?? 60,
    points:
      spec.kind === "curve"
        ? (spec.points ?? []).map((point) => [point[0], point[1]])
        : null,
    scriptData: { ...(spec.scriptData ?? {}) },
  });
  const attach = (state) => {
    const entry = { id: handle(state.kind === "curve" ? "PitchControlCurve" : "PitchControlPoint").__handle__, state, seq: seq++ };
    model.controls.push(entry);
    sortControls();
    return entry;
  };
  for (const spec of controls) attach(makeControlState(spec));

  const controlById = (id) => model.controls.find((entry) => entry.id === id);
  const liveIndex = (entry) => model.controls.indexOf(entry) + 1;

  const newControlHandle = (kind) => {
    const state = makeControlState({ kind, position: 0, pitch: 60, points: [] });
    return { id: handle(kind === "curve" ? "PitchControlCurve" : "PitchControlPoint").__handle__, state, seq: seq++, detached: true };
  };

  const unknownMethod = (method) => {
    const error = new Error(`no such method: ${method}`);
    error.code = "UNKNOWN_METHOD";
    throw error;
  };

  const dispatchControl = (floating, method, args) => {
    // floating 可能是 group 内的 entry 或 detached 自建对象（create/clone 产物）。
    const state = floating.state;
    const isCurve = state.kind === "curve";
    if (method === "getPosition") return state.position;
    if (method === "getPitch") return state.pitch;
    if (method === "getIndexInParent") {
      const idx = model.controls.indexOf(floating);
      return idx < 0
        ? useSemantic("pitchControl.remove.indexAfterRemove", 0)
        : idx + 1;
    }
    if (method === "getPoints") {
      if (!isCurve) unknownMethod(method);
      return state.points.map((point) => [point[0], point[1]]);
    }
    if (method === "getValueAt") {
      if (!isCurve) unknownMethod(method);
      return interpolate(state, args[0]);
    }
    if (method === "clone") {
      const sourceAllowed = floating.detached
        ? useSemantic("pitchControl.clone.detachedSourceAllowed", false)
        : useSemantic("pitchControl.clone.attachedAllowed", true);
      if (!sourceAllowed) {
        const error = new Error("cannot clone a detached pitch control");
        error.code = "HOST_CALL_FAILED";
        throw error;
      }
      const deepPoints = useSemantic("pitchControl.clone.deepPoints", true);
      const copiesScriptData = useSemantic(
        "pitchControl.clone.copiesScriptData",
        true
      );
      const copy = {
        id: handle(state.kind === "curve" ? "PitchControlCurve" : "PitchControlPoint").__handle__,
        state: makeControlState({
          kind: state.kind,
          position: state.position,
          pitch: state.pitch,
          points: deepPoints ? state.points ?? [] : [],
          scriptData: copiesScriptData ? state.scriptData : {},
        }),
        seq: seq++,
        detached: useSemantic("pitchControl.clone.detached", true),
      };
      model.floating = model.floating ?? new Map();
      model.floating.set(copy.id, copy);
      return { __handle__: copy.id, __type__: state.kind === "curve" ? "PitchControlCurve" : "PitchControlPoint", __epoch__: 1 };
    }
    if (method === "getScriptDataKeys") return Object.keys(state.scriptData);
    if (method === "getScriptData") {
      if (Object.hasOwn(state.scriptData, args[0])) return state.scriptData[args[0]];
      const missing = useSemantic(
        "pitchControl.scriptData.missingValue",
        "undefined"
      );
      return missing === "null" ? null : undefined;
    }
    if (method === "hasScriptData") return Object.hasOwn(state.scriptData, args[0]);
    if (model.ignoreSetters.has(method)) return null;
    if (method === "setPosition") {
      state.position = args[0];
      if (
        !floating.detached &&
        useSemantic("pitchControl.attachedSet.reorders", true)
      ) {
        sortControls();
      }
      return null;
    }
    if (method === "setPitch") {
      const numericStorage = useSemantic(
        "pitchControl.numericStorage",
        "double"
      );
      state.pitch = numericStorage === "float32" ? Math.fround(args[0]) : args[0];
      return null;
    }
    if (method === "setPoints") {
      if (!isCurve) unknownMethod(method);
      const numericStorage = useSemantic(
        "pitchControl.numericStorage",
        "double"
      );
      state.points = (args[0] ?? []).map((point) => [
        point[0],
        numericStorage === "float32" ? Math.fround(point[1]) : point[1],
      ]);
      return null;
    }
    if (method === "setScriptData") {
      state.scriptData[args[0]] = args[1];
      return null;
    }
    if (method === "removeScriptData") {
      delete state.scriptData[args[0]];
      return null;
    }
    if (method === "clearScriptData") {
      state.scriptData = {};
      return null;
    }
    throw new Error(`unsupported control method ${method}`);
  };

  const interpolate = (state, time) => {
    const points = state.points;
    if (points.length === 0) return 0;
    if (time <= points[0][0]) return points[0][1];
    if (time >= points[points.length - 1][0]) return points[points.length - 1][1];
    for (let index = 1; index < points.length; index += 1) {
      const [t1, v1] = points[index];
      if (time === t1) return v1;
      if (time < t1) {
        const [t0, v0] = points[index - 1];
        return v0 + ((v1 - v0) * (time - t0)) / (t1 - t0);
      }
    }
    return points[points.length - 1][1];
  };

  model.host = {
    epoch: () => 1,
    roots: async () => ({ project: h.project, sv: h.sv, mainEditor: h.mainEditor }),
    free: async () => {},
    index: async ({ field }) => {
      if (field === "QUARTER") return quarterBlick;
      throw new Error(`unsupported pitch index ${field}`);
    },
    call: async ({ handle: target, method, args = [] }) => {
      model.hostCalls.push(method);
      const failure = model.failures.find((item) => item.method === method && item.remainingSkips-- <= 0);
      if (failure) {
        model.failures.splice(model.failures.indexOf(failure), 1);
        const error = new Error(failure.message ?? `injected failure for ${method}`);
        if (failure.code) error.code = failure.code;
        throw error;
      }
      const id = target?.__handle__;
      if (target === undefined || target === null) {
        if (method === "create") {
          useSemantic("pitchControl.numericStorage", "double");
          // SV.create 收官方类型名；内部状态机用 "curve"/"point" 判别。
          const kind = args[0] === "PitchControlCurve" ? "curve" : "point";
          const created = newControlHandle(kind);
          model.floating = model.floating ?? new Map();
          model.floating.set(created.id, created);
          return { __handle__: created.id, __type__: args[0], __epoch__: 1 };
        }
        if (method === "getHostInfo") return { hostVersion };
      }
      if (id === h.sv.__handle__) {
        // getComputedPitchForGroup 是对 SV 根对象调用的（不是 undefined target）。
        if (method === "getComputedPitchForGroup") {
          const frames = args[3];
          const result = Array.from({ length: frames }, (_, index) =>
            Array.isArray(computedPitchValues) ? computedPitchValues[index] ?? null : 60 + index / 100
          );
          if (result.some(Number.isFinite)) {
            useSemantic(
              "computedPitch.coordinateSpace",
              "occurrence_absolute_blick"
            );
          } else {
            useSemantic(
              "computedPitch.pendingRepresentation",
              "requested_length_null_array"
            );
          }
          return result;
        }
        if (method === "getPhonemesForGroup") return noteList.map((note) => note.state.lyrics || "");
        if (method === "getComputedAttributesForGroup") return noteList.map(() => ({}));
      }
      if (id === h.project.__handle__) {
        if (method === "newUndoRecord") return ++model.undoCount;
        if (method === "getTimeAxis") return h.timeAxis;
        if (method === "getNumTracks") return 1;
        if (method === "getTrack") return h.track;
      }
      if (id === h.timeAxis.__handle__) {
        if (method === "getAllMeasureMarks") {
          return [{ position: 0, positionBlick: 0, numerator: 4, denominator: 4 }];
        }
        if (method === "getAllTempoMarks") return [{ position: 0, positionSeconds: 0, bpm: 120 }];
        if (method === "getBlickFromSeconds") return Math.round(args[0] * quarterBlick * 2);
        if (method === "getSecondsFromBlick") return args[0] / (quarterBlick * 2);
      }
      if (id === h.track.__handle__) {
        if (method === "getName") return "Vocal";
        if (method === "getNumGroups") return h.reference2 ? 2 : 1;
        if (method === "getGroupReference") {
          return args[0] === 2 && h.reference2 ? h.reference2 : h.reference;
        }
        if (method === "getIndexInParent") return 1;
      }
      if (id === h.reference.__handle__) {
        if (method === "getOnset") {
          return requireReferenceBoundary(
            referenceOnsetBlick,
            timeOffsetBlick + (noteList[0]?.state.onset ?? 0),
            "referenceOnsetBlick"
          );
        }
        if (method === "getEnd") {
          return requireReferenceBoundary(
            referenceEndBlick,
            timeOffsetBlick + 4 * quarterBlick,
            "referenceEndBlick"
          );
        }
        if (method === "isInstrumental") return false;
        if (method === "isMain") return true;
        if (method === "getTimeOffset") return timeOffsetBlick;
        if (method === "getPitchOffset") return pitchOffsetSemitone;
        if (method === "getTarget") return h.group;
        if (method === "getVoice") return { paramTension: 0 };
        if (method === "getIndexInParent") return 1;
      }
      if (h.reference2 && id === h.reference2.__handle__) {
        const offset = secondReference.timeOffsetBlick ?? 0;
        const pitchOffset = secondReference.pitchOffsetSemitone ?? 0;
        if (method === "getOnset") {
          return requireReferenceBoundary(
            secondReference.referenceOnsetBlick,
            offset + (noteList[0]?.state.onset ?? 0),
            "secondReference.referenceOnsetBlick"
          );
        }
        if (method === "getEnd") {
          return requireReferenceBoundary(
            secondReference.referenceEndBlick,
            offset + 4 * quarterBlick,
            "secondReference.referenceEndBlick"
          );
        }
        if (method === "isInstrumental") return false;
        if (method === "isMain") return false;
        if (method === "getTimeOffset") return offset;
        if (method === "getPitchOffset") return pitchOffset;
        if (method === "getTarget") return h.group;
        if (method === "getVoice") return { paramTension: 0 };
        if (method === "getIndexInParent") return 2;
      }
      if (id === h.group.__handle__) {
        if (method === "getName") return "Group";
        if (method === "getUUID") return uuid;
        if (method === "getNumNotes") return noteList.length;
        if (method === "getNote") return noteList[args[0] - 1].handle;
        if (method === "getNumPitchControls") return model.controls.length;
        if (method === "getPitchControl") {
          const entry = model.controls[args[0] - 1];
          if (!entry) throw new Error(`getPitchControl index out of range: ${args[0]}`);
          return { __handle__: entry.id, __type__: entry.state.kind === "curve" ? "PitchControlCurve" : "PitchControlPoint", __epoch__: 1 };
        }
        if (method === "addPitchControl") {
          const controlId = args[0]?.__handle__;
          const floating = model.floating?.get(controlId);
          const existing = controlById(controlId);
          if (existing) return liveIndex(existing);
          if (!floating) throw new Error(`addPitchControl: unknown control handle ${controlId}`);
          floating.detached = false;
          model.controls.push(floating);
          sortControls();
          const indexBase = useSemantic(
            "pitchControl.add.returnIndexBase",
            1
          );
          return liveIndex(floating) - (indexBase === 0 ? 1 : 0);
        }
        if (method === "removePitchControl") {
          const removed = model.controls.splice(args[0] - 1, 1)[0];
          if (removed) removed.detached = true;
          return null;
        }
        if (method === "getParameter") return h.automation;
      }
      if (id === h.automation.__handle__) {
        if (method === "getType") return "pitchDelta";
        if (method === "getDefinition") return { typeName: "pitchDelta", range: [-1200, 1200], defaultValue: 0 };
        if (method === "getInterpolationMethod") return "Linear";
        if (method === "getAllPoints") return model.automationPoints.map((point) => [point[0], point[1]]);
        if (method === "getPoints") {
          const [from, to] = args;
          return model.automationPoints
            .filter(([blick]) => blick >= from && blick <= to)
            .map((point) => [point[0], point[1]]);
        }
        if (method === "removeAll") {
          model.automationPoints = [];
          return null;
        }
        if (method === "remove") {
          const [from, to] = args;
          model.automationPoints = model.automationPoints.filter((point) => point[0] < from || point[0] >= to);
          return null;
        }
        if (method === "add") {
          model.automationPoints.push([args[0], args[1]]);
          model.automationPoints.sort((a, b) => a[0] - b[0]);
          return null;
        }
        if (method === "get") {
          const blick = args[0];
          const points = model.automationPoints;
          if (points.length === 0) return 0;
          const exact = points.find((point) => point[0] === blick);
          if (exact) return exact[1];
          const right = points.findIndex((point) => point[0] > blick);
          if (right <= 0 || right === -1) return 0;
          const left = points[right - 1];
          const next = points[right];
          return left[1] + ((next[1] - left[1]) * (blick - left[0])) / (next[0] - left[0]);
        }
      }
      const noteIndex = noteList.findIndex((note) => note.handle.__handle__ === id);
      if (noteIndex >= 0) {
        const state = noteList[noteIndex].state;
        const getters = {
          getIndexInParent: noteIndex + 1,
          getOnset: state.onset,
          getDuration: state.duration,
          getPitch: state.pitch,
          getLyrics: state.lyrics,
          getPhonemes: state.phonemes,
          getLanguageOverride: state.language,
          getDetune: state.detune,
        };
        if (Object.hasOwn(getters, method)) return getters[method];
      }
      const controlEntry = controlById(id) ?? model.floating?.get(id);
      if (controlEntry) return dispatchControl(controlEntry, method, args);
      throw new Error(`unsupported pitch host call ${id}.${method}`);
    },
  };

  // 便捷读数：当前 group 内 (kind, position, pitch, scriptData) 快照，便于断言最终全集。
  model.controlsSnapshot = () =>
    model.controls.map((entry) => ({
      kind: entry.state.kind,
      position: entry.state.position,
      pitch: entry.state.pitch,
      points: entry.state.points ? entry.state.points.map((point) => [point[0], point[1]]) : null,
      scriptData: { ...entry.state.scriptData },
    }));
  model.semanticEvidence = (key) => hostProfile?.semantics?.[key] ?? null;
  model.semanticCoverage = () => [...semanticCoverage.values()];
  model.assertNoUnconfirmedSemantics = () => {
    const unconfirmed = [...semanticCoverage.values()].filter(
      (item) => item.source !== "live_profile"
    );
    if (unconfirmed.length > 0) {
      const error = new Error(
        `fake host used ${unconfirmed.length} unconfirmed semantics`
      );
      error.code = "UNCONFIRMED_HOST_SEMANTICS_USED";
      error.semantics = unconfirmed;
      throw error;
    }
  };
  return model;
}
