import assert from "node:assert/strict";
import test from "node:test";

import { ArtifactStore, planReference } from "../server/src/artifact-store.js";
import { ExecutionCoordinator } from "../server/src/execution-coordinator.js";
import { ParameterCurveService } from "../server/src/parameter-curve.js";
import { buildPlanArtifact } from "../server/src/plan-reference.js";
import {
  buildHostInterpolationPostcondition,
  createHostInterpolationBaselineFingerprint,
  normalizeHostInterpolationPostcondition,
} from "../server/src/pitch-techniques/host-interpolation.js";

const Q = 705600000;

// Automation 模型：有序控制点数组 + 线性插值 + 朴素 simplify（移除线性可省略点）。
function createCurveModel() {
  let nextHandle = 300;
  const handle = (type) => ({ __handle__: nextHandle++, __type__: type, __epoch__: 1 });
  const h = {
    project: handle("Project"),
    sv: handle("SV"),
    timeAxis: handle("TimeAxis"),
    track: handle("Track"),
    ref: handle("NoteGroupReference"),
    instrumentalRef: handle("NoteGroupReference"),
    group: handle("NoteGroup"),
    automation: handle("Automation"),
  };
  const model = {
    handles: h,
    points: [
      [0, 0],
      [Q, 0.5],
      [2 * Q, 1],
    ],
    undoCount: 0,
    failures: [],
    groupOnset: 4 * Q,
    interpolationMethod: "Linear",
    meterMarks: [{ position: 0, positionBlick: 0, numerator: 4, denominator: 4 }],
    definition: {
      displayName: "Loudness",
      typeName: "loudness",
      range: [-24, 24],
      defaultValue: 0,
    },
  };
  const sortPoints = () => model.points.sort((a, b) => a[0] - b[0]);
  const inRange = (from, to) => model.points.filter(([b]) => b >= from && b <= to);
  const interpolate = (b) => {
    sortPoints();
    if (model.points.length === 0) return model.definition.defaultValue;
    if (b <= model.points[0][0]) return model.points[0][1];
    const last = model.points[model.points.length - 1];
    if (b >= last[0]) return last[1];
    for (let index = 1; index < model.points.length; index += 1) {
      const [b1, v1] = model.points[index - 1];
      const [b2, v2] = model.points[index];
      if (b >= b1 && b <= b2) return v1 + ((v2 - v1) * (b - b1)) / (b2 - b1);
    }
    return model.definition.defaultValue;
  };
  model.host = {
    epoch: () => 1,
    roots: async () => ({ project: h.project, sv: h.sv }),
    free: async () => {},
    index: async ({ field }) => (field === "QUARTER" ? Q : null),
    call: async ({ handle: target, method, args = [] }) => {
      const failure = model.failures.find(
        (item) => item.method === method && item.remainingSkips-- <= 0
      );
      if (failure) {
        model.failures.splice(model.failures.indexOf(failure), 1);
        const error = new Error(failure.message ?? `injected failure for ${method}`);
        if (failure.code) error.code = failure.code;
        throw error;
      }
      const id = target?.__handle__;
      if (id === h.project.__handle__) {
        if (method === "getNumTracks") return 1;
        if (method === "getTrack") return h.track;
        if (method === "getTimeAxis") return h.timeAxis;
        if (method === "newUndoRecord") return ++model.undoCount;
      }
      if (id === h.timeAxis.__handle__ && method === "getAllMeasureMarks") {
        return structuredClone(model.meterMarks);
      }
      if (id === h.track.__handle__) {
        if (method === "getNumGroups") return 2;
        if (method === "getGroupReference") return args[0] === 1 ? h.ref : h.instrumentalRef;
      }
      if (id === h.instrumentalRef.__handle__ && method === "isInstrumental") return true;
      if (id === h.ref.__handle__) {
        if (method === "isInstrumental") return false;
        if (method === "getTarget") return h.group;
        if (method === "getVoice") return model.voice ?? { vocalModeParams: {} };
        // 首音符组内 onset 为 0，因此 getOnset == getTimeOffset。
        if (method === "getOnset") return model.groupOnset;
        if (method === "getTimeOffset") return model.groupOnset;
      }
      if (id === h.group.__handle__) {
        if (method === "getParameter") {
          return String(args[0]).toLowerCase() === model.definition.typeName.toLowerCase()
            ? h.automation
            : null;
        }
        if (method === "getUUID") return "curve-group";
      }
      if (id === h.automation.__handle__) {
        if (method === "getDefinition") return { ...model.definition, range: [...model.definition.range] };
        if (method === "getType") return model.definition.typeName;
        if (method === "getInterpolationMethod") return model.interpolationMethod;
        if (method === "getAllPoints") {
          model.getAllPointsCalls = (model.getAllPointsCalls ?? 0) + 1;
          if (
            model.maxAllPointsPerCall !== undefined &&
            model.points.length > model.maxAllPointsPerCall
          ) {
            const error = new Error("SynthV bridge result exceeds 65536 bytes");
            error.code = "FRAME_TOO_LARGE";
            throw error;
          }
          return sortPoints().map((point) => [...point]);
        }
        if (method === "getPoints") {
          model.getPointsCalls = (model.getPointsCalls ?? 0) + 1;
          const slice = inRange(args[0], args[1]);
          // 模拟 Relay 帧上限：单次返回点数超过 maxPointsPerCall 时命令失败但连接存活。
          if (model.maxPointsPerCall !== undefined && slice.length > model.maxPointsPerCall) {
            const error = new Error("SynthV bridge result exceeds 65536 bytes");
            error.code = "FRAME_TOO_LARGE";
            throw error;
          }
          return slice.map((point) => [...point]);
        }
        if (method === "get") {
          const offset = model.wroteCurve
            ? typeof model.getValueOffsetAfterWrite === "function"
              ? model.getValueOffsetAfterWrite(args[0])
              : (model.getValueOffsetAfterWrite ?? 0)
            : 0;
          return interpolate(args[0]) + offset;
        }
        if (method === "add") {
          model.wroteCurve = true;
          if (model.ignoreAdd) return false;
          const value = model.coerceValuesToFloat32 ? Math.fround(args[1]) : args[1];
          const storedValue = value + (model.writeValueOffset ?? 0);
          const existing = model.points.find(([b]) => b === args[0]);
          if (existing) existing[1] = storedValue;
          else model.points.push([args[0], storedValue]);
          sortPoints();
          return true;
        }
        if (method === "remove") {
          if (model.ignoreRemove) return false;
          model.wroteCurve = true;
          (model.removeCalls ??= []).push([...args]);
          const before = model.points.length;
          model.points = model.points.filter(([b]) => b < args[0] || b >= args[1]);
          return model.points.length !== before;
        }
        if (method === "simplify") {
          if (model.ignoreSimplify) return false;
          const [from, to, threshold = 0] = args;
          // 朴素实现：移除范围内可被相邻两点线性插值近似的点。
          let changed = false;
          for (let index = model.points.length - 2; index >= 1; index -= 1) {
            const [b, v] = model.points[index];
            if (b < from || b > to) continue;
            const [b1, v1] = model.points[index - 1];
            const [b2, v2] = model.points[index + 1];
            const linear = v1 + ((v2 - v1) * (b - b1)) / (b2 - b1);
            if (Math.abs(linear - v) <= threshold) {
              model.points.splice(index, 1);
              changed = true;
            }
          }
          return changed;
        }
      }
      throw new Error(`unsupported curve call ${id}.${method}`);
    },
  };
  return model;
}

function createService(model) {
  return new ParameterCurveService(
    { withExclusive: (task) => task(model.host) },
    { now: () => 1000 }
  );
}

function createRangeContextService(
  model,
  { shared = false, artifactStore = null, sessionId = null } = {}
) {
  const notes = [
    { __handle__: 850, __type__: "Note", __epoch__: 1 },
    { __handle__: 851, __type__: "Note", __epoch__: 1 },
  ];
  const noteState = {
    indexInGroup: 0,
    onsetBlick: 0,
    durationBlick: 2 * Q,
    pitch: 60,
    lyrics: "do",
    phonemesOverride: "d ow",
    languageOverride: "english",
    detuneCents: 0,
  };
  const noteStates = [
    noteState,
    {
      indexInGroup: 1,
      onsetBlick: 3 * Q,
      durationBlick: Q,
      pitch: 62,
      lyrics: "re",
      phonemesOverride: "r ey",
      languageOverride: "english",
      detuneCents: 0,
    },
  ];
  const originalCall = model.host.call;
  model.host.call = async (request) => {
    const id = request.handle?.__handle__;
    if (id === model.handles.group.__handle__ && request.method === "getNote") {
      return notes[request.args[0] - 1] ?? null;
    }
    const noteIndex = notes.findIndex((note) => note.__handle__ === id);
    if (noteIndex >= 0) {
      const state = noteStates[noteIndex];
      const getters = {
        getIndexInParent: state.indexInGroup + 1,
        getOnset: state.onsetBlick,
        getDuration: state.durationBlick,
        getPitch: state.pitch,
        getLyrics: state.lyrics,
        getPhonemes: state.phonemesOverride,
        getLanguageOverride: state.languageOverride,
        getDetune: state.detuneCents,
      };
      if (Object.hasOwn(getters, request.method)) return getters[request.method];
    }
    return originalCall(request);
  };
  const contextId = "ctx_range";
  const sharedTargetOccurrences = shared ? [0, 1] : [0];
  const stored = {
    epoch: 1,
    contextId,
    context: {
      kind: "range",
      quarterBlick: Q,
      meterMarks: [{ position: 0, positionBlick: 0, numerator: 4, denominator: 4 }],
      range: { from: { blick: 4 * Q }, to: { blick: 8 * Q } },
      occurrences: [
        {
          occurrence: 0,
          trackIndex: 0,
          groupIndex: 0,
          targetGroupUuid: "curve-group",
          timeOffsetBlick: model.groupOnset,
          sharedTargetOccurrences,
          noteFingerprints: noteStates.map((state) => ({ ...state })),
        },
      ],
    },
  };
  const snapshotService = {
    getContext(requestedContextId, epoch) {
      if (requestedContextId !== contextId) throw new Error("unknown context");
      if (epoch !== stored.epoch) throw new Error("stale context");
      return stored;
    },
  };
  const service = new ParameterCurveService(
    { withExclusive: (task) => task(model.host) },
    { now: () => 1000, snapshotService, artifactStore, sessionId }
  );
  return { service, contextId, noteState, noteStates, stored, snapshotService };
}

// 在单曲线宿主模型上追加独立 Automation，用于验证跨曲线事务边界。
function addBatchCurves(model) {
  const definitions = {
    tension: { displayName: "Tension", typeName: "tension", range: [0, 1], defaultValue: 0 },
    breathiness: {
      displayName: "Breathiness",
      typeName: "breathiness",
      range: [-1, 1],
      defaultValue: 0,
    },
    pitchDelta: {
      displayName: "Pitch Deviation",
      typeName: "pitchDelta",
      range: [-100, 100],
      defaultValue: 0,
    },
    vocalMode_Powerful: {
      displayName: "Powerful",
      typeName: "vocalMode_Powerful",
      range: [0, 150],
      defaultValue: 0,
    },
  };
  const handles = Object.fromEntries(
    Object.keys(definitions).map((parameter, index) => [
      parameter,
      { __handle__: 900 + index, __type__: "Automation", __epoch__: 1 },
    ])
  );
  model.batchPoints = Object.fromEntries(
    Object.keys(definitions).map((parameter) => [parameter, [[0, 0]]])
  );
  model.parameterLookupCount = 0;
  model.voice = {
    vocalModeParams: {
      Powerful: { pitch: 100, timbre: 100, pronunciation: 100 },
    },
  };
  const parameterByHandle = new Map(
    Object.entries(handles).map(([parameter, handle]) => [handle.__handle__, parameter])
  );
  const originalCall = model.host.call;
  model.host.call = async (request) => {
    const id = request.handle?.__handle__;
    if (id === model.handles.group.__handle__ && request.method === "getParameter") {
      model.parameterLookupCount += 1;
      const requested = String(request.args?.[0] ?? "");
      if (requested.toLowerCase() === "loudness") return model.handles.automation;
      if (model.forceParameterFallback === requested) return handles.pitchDelta;
      return handles[requested] ?? (model.unknownParameterFallsBack ? handles.pitchDelta : null);
    }
    const parameter = parameterByHandle.get(id);
    if (!parameter) return originalCall(request);

    const points = model.batchPoints[parameter];
    const definition = definitions[parameter];
    if (request.method === "getDefinition") return { ...definition, range: [...definition.range] };
    if (request.method === "getType") return parameter;
    if (request.method === "getInterpolationMethod") return "Linear";
    if (request.method === "getAllPoints") return points.map((point) => [...point]);
    if (request.method === "remove") {
      const [from, to] = request.args;
      model.batchPoints[parameter] = points.filter(([blick]) => blick < from || blick >= to);
      return true;
    }
    if (request.method === "add") {
      if (
        model.failBatchParameter === parameter &&
        model.failBatchMethod === "add" &&
        !model.batchFailureUsed
      ) {
        model.batchFailureUsed = true;
        const error = new Error(`injected failure for ${parameter}.add`);
        error.code = "ARGUMENT_MISMATCH";
        throw error;
      }
      if (
        model.failBatchRollbackParameter === parameter &&
        model.batchFailureUsed &&
        !model.batchRollbackFailureUsed
      ) {
        model.batchRollbackFailureUsed = true;
        const error = new Error(`injected rollback failure for ${parameter}.add`);
        error.code = "ARGUMENT_MISMATCH";
        throw error;
      }
      const [blick, value] = request.args;
      const current = model.batchPoints[parameter];
      const existing = current.find((point) => point[0] === blick);
      if (existing) existing[1] = value;
      else current.push([blick, value]);
      current.sort((left, right) => left[0] - right[0]);
      return true;
    }
    if (request.method === "simplify") return false;
    if (request.method === "get") {
      return model.batchPoints[parameter].find((point) => point[0] === request.args[0])?.[1] ?? 0;
    }
    throw new Error(`unsupported batch curve call ${parameter}.${request.method}`);
  };
  return model;
}

function fourCurveRequest(overrides = {}) {
  return {
    target: { ...TARGET, expectedGroupUuid: "curve-group" },
    curves: [
      {
        parameter: "loudness",
        mode: "replace",
        range: { fromBlick: 0, toBlick: 2 * Q },
        points: [{ blick: 0, value: 2 }],
      },
      {
        parameter: "tension",
        mode: "replace",
        range: { fromBlick: 0, toBlick: 2 * Q },
        points: [{ blick: 0, value: 0.2 }],
      },
      {
        parameter: "breathiness",
        mode: "replace",
        range: { fromBlick: 0, toBlick: 2 * Q },
        points: [{ blick: 0, value: 0.3 }],
      },
      {
        parameter: "pitchDelta",
        mode: "replace",
        range: { fromBlick: 0, toBlick: 2 * Q },
        points: [{ blick: 0, value: -10 }],
      },
    ],
    atomic: true,
    // action 无默认值（§10.6）；这些用例默认描述提交，dry-run 用例显式覆盖。
    action: "commit",
    ...overrides,
  };
}

const TARGET = { trackIndex: 0, groupIndex: 0 };

function configurePitchDelta(model) {
  model.definition = {
    displayName: "Pitch Deviation",
    typeName: "pitchDelta",
    range: [-1200, 1200],
    defaultValue: 0,
  };
  return model;
}

function hostInterpolationConfig({
  method = "Linear",
  baselineSamples = [
    { blick: 0, value: 0 },
    { blick: Q, value: 0.5 },
    { blick: 2 * Q, value: 1 },
  ],
  mandatorySamples = [
    { blick: 0, value: 1 },
    { blick: 2 * Q, value: 3 },
  ],
  adaptiveMidpoints = [
    { blick: Q, value: 2, leftBlick: 0, rightBlick: 2 * Q },
  ],
  maxFitErrorCent = 0.01,
} = {}) {
  return buildHostInterpolationPostcondition({
    interpolationEvidence: {
      method,
      source: "host_getInterpolationMethod",
      capturedAtContextId: "ctx_host_interpolation",
      resolvedParameter: "pitchDelta",
    },
    baselineSamples,
    mandatorySamples,
    adaptiveMidpoints,
    maxFitErrorCent,
  });
}

function pitchDeltaCurveRequest(overrides = {}) {
  return oneCurve({
    target: TARGET,
    parameter: "pitchDelta",
    mode: "replace",
    range: { fromBlick: 0, toBlick: 2 * Q },
    points: [
      { blick: 0, value: 1 },
      { blick: 2 * Q, value: 3 },
    ],
    hostInterpolation: hostInterpolationConfig(),
    ...overrides,
  });
}

// 单数 sv_patch_parameter_curve 已删除：它是复数的严格子集（curves 长度为 1 即等价），
// 却占全部 schema 的 10%，还让模型每次都要判断"该调哪个"。这些用例仍然描述"一条
// 曲线"的行为，因此统一走复数端点并读 curves[0]，而不是保留一份并行契约。
function oneCurve(request) {
  const { target, action, atomic, undoLabel, ...curve } = request;
  return {
    target,
    curves: [curve],
    // action 无默认值（§10.6）：省略即写入的旧 dryRun 语义已删除。这些用例里
    // "不带 action" 表达的是提交，因此在辅助函数里补成 commit，而不是让每个调用点
    // 都重复一遍。
    action: action ?? "commit",
    ...(atomic === undefined ? {} : { atomic }),
    ...(undoLabel === undefined ? {} : { undoLabel }),
  };
}

test("sv_get_parameter_curve reports definition, dual coordinates, and stats", async () => {
  const model = createCurveModel();
  const service = createService(model);
  const result = await service.getCurve({
    target: TARGET,
    parameter: "loudness",
    range: { fromBlick: 0, toBlick: 3 * Q },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.data.definition.range, [-24, 24]);
  assert.equal(result.data.interpolationMethod, "Linear");
  assert.deepEqual(result.data.points[1], {
    localBlick: Q,
    absoluteBlick: 4 * Q + Q,
    value: 0.5,
  });
  assert.deepEqual(result.data.stats, { count: 3, min: 0, max: 1, mean: 0.5 });
  assert.equal(result.data.group.uuid, "curve-group");
});

test("sv_get_parameter_curve supports absolute-coordinate ranges", async () => {
  const model = createCurveModel();
  const service = createService(model);
  const result = await service.getCurve({
    target: TARGET,
    parameter: "loudness",
    range: { fromBlick: 4 * Q + Q, toBlick: 4 * Q + 3 * Q, coordinate: "absolute" },
  });
  assert.deepEqual(
    result.data.points.map((point) => point.localBlick),
    [Q, 2 * Q]
  );
  assert.equal(result.data.range.localFromBlick, Q);
});

test("sv_patch_parameter_curves replace: dryRun has no side effects, real write verifies exactly", async () => {
  const model = createCurveModel();
  const service = createService(model);
  const request = {
    target: TARGET,
    parameter: "loudness",
    mode: "replace",
    range: { fromBlick: 0, toBlick: 2 * Q },
    points: [
      { blick: 0, value: 1 },
      { blick: Q, value: 2 },
    ],
  };

  const plan = await service.patchCurves(oneCurve({ ...request, action: "dry_run" }));
  assert.equal(plan.status, "dry_run");
  assert.equal(plan.curves[0].before.pointCount, 3);
  assert.equal(plan.curves[0].planned.pointCount, 2);
  assert.equal(model.undoCount, 0);
  assert.equal(model.points.length, 3);

  const result = await service.patchCurves(oneCurve(request));
  assert.equal(result.ok, true);
  assert.equal(result.status, "succeeded");
  assert.equal(result.effects, "verified");
  assert.equal(result.curves[0].verification.mode, "exact");
  assert.equal(result.verification.passed, true);
  assert.deepEqual(model.points, [
    [0, 1],
    [Q, 2],
  ]);
  assert.equal(model.undoCount, 2);
  assert.equal(result.curves[0].after.pointCount, 2);
  assert.equal(result.curves[0].after.stats.max, 2);
});

test("sealed pitchDelta interpolation preflights baseline evidence and verifies host samples", async () => {
  const model = configurePitchDelta(createCurveModel());
  const service = createService(model);
  const dryRun = await service.patchCurves(pitchDeltaCurveRequest({ action: "dry_run" }));
  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.status, "dry_run");
  assert.equal(dryRun.curves[0].hostInterpolation.preflight.passed, true);
  assert.equal(model.undoCount, 0);
  assert.deepEqual(model.points, [
    [0, 0],
    [Q, 0.5],
    [2 * Q, 1],
  ]);

  const committed = await service.patchCurves(pitchDeltaCurveRequest());
  const hostEvidence = committed.curves[0].verification.evidence.hostInterpolation;
  assert.equal(committed.ok, true);
  assert.equal(hostEvidence.passed, true);
  assert.equal(hostEvidence.mandatorySampleCount, 2);
  assert.equal(hostEvidence.adaptiveMidpointCount, 1);
  assert.equal(hostEvidence.maxAbsErrorCent, 0);
  assert.equal(hostEvidence.preflight.baselineSampleCount, 3);
  assert.deepEqual(model.removeCalls, [[0, 2 * Q + 1]]);
  assert.equal(model.undoCount, 2);

  const changedBaseline = configurePitchDelta(createCurveModel());
  changedBaseline.points[1][1] = 0.75;
  const baselineFailure = await createService(changedBaseline).patchCurves(pitchDeltaCurveRequest());
  assert.equal(baselineFailure.ok, false);
  assert.equal(baselineFailure.error.code, "CURVE_BASELINE_CHANGED");
  assert.equal(baselineFailure.effects, "none");
  assert.equal(changedBaseline.undoCount, 0);

  const changedInterpolation = configurePitchDelta(createCurveModel());
  changedInterpolation.interpolationMethod = "Cosine";
  const methodFailure = await createService(changedInterpolation).patchCurves(pitchDeltaCurveRequest());
  assert.equal(methodFailure.ok, false);
  assert.equal(methodFailure.error.code, "INTERPOLATION_CHANGED");
  assert.deepEqual(methodFailure.error.details, {
    expectedMethod: "linear",
    observedMethod: "cosine",
    parameter: "pitchDelta",
  });
  assert.equal(methodFailure.effects, "none");
  assert.equal(changedInterpolation.undoCount, 0);

  assert.throws(
    () => hostInterpolationConfig({ baselineSamples: [] }),
    { code: "INVALID_ARGUMENTS" }
  );
  const sealedPostcondition = hostInterpolationConfig();
  assert.throws(
    () =>
      createHostInterpolationBaselineFingerprint({
        interpolationEvidence: sealedPostcondition.interpolationEvidence,
        samples: [],
      }),
    { code: "INVALID_ARGUMENTS" }
  );
  assert.throws(
    () =>
      normalizeHostInterpolationPostcondition({
        ...sealedPostcondition,
        baseline: { ...sealedPostcondition.baseline, samples: [] },
      }),
    { code: "INVALID_ARGUMENTS" }
  );
  assert.throws(
    () => hostInterpolationConfig({ adaptiveMidpoints: [] }),
    { code: "INVALID_ARGUMENTS" }
  );

  const cubic = configurePitchDelta(createCurveModel());
  cubic.interpolationMethod = "Cubic";
  cubic.getValueOffsetAfterWrite = (blick) => (blick === Q ? 0.25 : 0);
  const cubicResult = await createService(cubic).patchCurves(
    pitchDeltaCurveRequest({
      hostInterpolation: hostInterpolationConfig({
        method: "Cubic",
        adaptiveMidpoints: [
          { blick: Q, value: 2.25, leftBlick: 0, rightBlick: 2 * Q },
        ],
      }),
    })
  );
  assert.equal(cubicResult.ok, true);
  assert.equal(
    cubicResult.curves[0].verification.evidence.hostInterpolation.maxAbsErrorCent,
    0
  );
});

test("sealed pitchDelta interpolation failure rolls back or reports rollback failure", async () => {
  const ignoredSetter = configurePitchDelta(createCurveModel());
  ignoredSetter.ignoreRemove = true;
  ignoredSetter.ignoreAdd = true;
  const ignoredResult = await createService(ignoredSetter).patchCurves(pitchDeltaCurveRequest());
  assert.equal(ignoredResult.ok, false);
  assert.equal(ignoredResult.error.code, "POSTCONDITION_FAILED");
  assert.equal(ignoredResult.status, "rolled_back");
  assert.equal(ignoredResult.rollback.verified, true);

  const interpolationOverrun = configurePitchDelta(createCurveModel());
  interpolationOverrun.getValueOffsetAfterWrite = (blick) => (blick === Q ? 0.1 : 0);
  const overrunResult = await createService(interpolationOverrun).patchCurves(pitchDeltaCurveRequest());
  const overrunEvidence = overrunResult.curves[0].verification.evidence.hostInterpolation;
  assert.equal(overrunResult.ok, false);
  assert.equal(overrunResult.error.code, "POSTCONDITION_FAILED");
  assert.equal(overrunResult.status, "rolled_back");
  assert.equal(overrunEvidence.passed, false);
  assert.equal(overrunEvidence.firstMismatch.source, "adaptive_midpoint");
  assert.ok(overrunEvidence.maxAbsErrorCent > overrunEvidence.maxFitErrorCent);
  assert.equal(overrunResult.rollback.verified, true);

  const rollbackFailure = configurePitchDelta(createCurveModel());
  rollbackFailure.getValueOffsetAfterWrite = (blick) => (blick === Q ? 0.1 : 0);
  rollbackFailure.failures.push({ method: "add", remainingSkips: 2, code: "ARGUMENT_MISMATCH" });
  const rollbackFailureResult = await createService(rollbackFailure).patchCurves(pitchDeltaCurveRequest());
  assert.equal(rollbackFailureResult.ok, false);
  assert.equal(rollbackFailureResult.error.code, "POSTCONDITION_FAILED");
  assert.equal(rollbackFailureResult.status, "rollback_failed");
  assert.equal(rollbackFailureResult.rollback.verified, false);
});

test("sealed pitchDelta interpolation disconnect remains outcome_unknown without retry", async () => {
  const model = configurePitchDelta(createCurveModel());
  // 前置基线恰好读取三次；第四次 get 是写后必保锚点采样，模拟此时连接断开。
  model.failures.push({ method: "get", remainingSkips: 3, code: "HOST_TIMEOUT" });
  const result = await createService(model).patchCurves(pitchDeltaCurveRequest());
  assert.equal(result.ok, false);
  assert.equal(result.status, "outcome_unknown");
  assert.equal(result.error.code, "HOST_TIMEOUT");
  assert.equal(result.rollback.attempted, false);
  assert.equal(result.effects, "unknown");
});

test("sv_patch_parameter_curves accepts host float32 value quantization", async () => {
  const model = createCurveModel();
  model.coerceValuesToFloat32 = true;
  const result = await createService(model).patchCurves(oneCurve({
    target: TARGET,
    parameter: "loudness",
    mode: "replace",
    range: { fromBlick: 0, toBlick: 2 * Q },
    points: [
      { blick: 0, value: 0.2 },
      { blick: Q, value: 0.8 },
      { blick: 2 * Q, value: 0.3 },
    ],
  }));

  assert.equal(result.ok, true);
  assert.equal(result.verification.passed, true);
  assert.equal(result.curves[0].verification.evidence.valueTolerance, 48e-6);
  assert.ok(result.curves[0].verification.evidence.maxValueDelta > 0);
  assert.ok(
    result.curves[0].verification.evidence.maxValueDelta <= result.curves[0].verification.evidence.valueTolerance
  );
  assert.equal(result.curves[0].verification.evidence.firstMismatch, undefined);
});

test("sv_patch_parameter_curves reports the first value mismatch with delta evidence", async () => {
  const model = createCurveModel();
  model.writeValueOffset = 0.001;
  const result = await createService(model).patchCurves(oneCurve({
    target: TARGET,
    parameter: "loudness",
    mode: "replace",
    atomic: false,
    range: { fromBlick: 0, toBlick: Q },
    points: [{ blick: 0, value: 0.2 }],
  }));

  assert.equal(result.ok, false);
  assert.equal(result.status, "partial");
  assert.equal(result.verification.passed, false);
  assert.deepEqual(result.curves[0].verification.evidence.firstMismatch.requested, {
    blick: 0,
    value: 0.2,
  });
  assert.equal(result.curves[0].verification.evidence.firstMismatch.observed.blick, 0);
  assert.ok(Math.abs(result.curves[0].verification.evidence.firstMismatch.delta.value - 0.001) < 1e-12);
  assert.ok(
    result.curves[0].verification.evidence.firstMismatch.absoluteValueDelta >
      result.curves[0].verification.evidence.valueTolerance
  );
});

test("sv_patch_parameter_curves add mode shifts existing control points and clamps to range", async () => {
  const model = createCurveModel();
  model.points = [
    [0, 23],
    [Q, 0],
  ];
  const service = createService(model);
  const result = await service.patchCurves(oneCurve({
    target: TARGET,
    parameter: "loudness",
    mode: "add",
    amount: 5,
    range: { fromBlick: 0, toBlick: 2 * Q },
  }));

  assert.equal(result.ok, true);
  assert.equal(result.curves[0].clampedCount, 1);
  assert.ok(result.warnings.some((warning) => warning.code === "CLAMPED_TO_RANGE"));
  assert.deepEqual(model.points, [
    [0, 24],
    [Q, 5],
  ]);
});

test("sv_patch_parameter_curves scale mode multiplies control points", async () => {
  const model = createCurveModel();
  const service = createService(model);
  const result = await service.patchCurves(oneCurve({
    target: TARGET,
    parameter: "loudness",
    mode: "scale",
    amount: 2,
    range: { fromBlick: Q, toBlick: 2 * Q },
  }));
  assert.equal(result.ok, true);
  // 范围外的 [0,0] 不受影响。
  assert.deepEqual(model.points, [
    [0, 0],
    [Q, 1],
    [2 * Q, 2],
  ]);
});

test("sv_patch_parameter_curves rejects explicit out-of-range values before writing", async () => {
  const model = createCurveModel();
  const service = createService(model);
  const result = await service.patchCurves(oneCurve({
    target: TARGET,
    parameter: "loudness",
    mode: "replace",
    range: { fromBlick: 0, toBlick: Q },
    points: [{ blick: 0, value: 99 }],
  }));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "VALUE_OUT_OF_RANGE");
  assert.equal(result.effects, "none");
  assert.equal(model.undoCount, 0);
  assert.equal(model.points.length, 3);
});

test("sv_patch_parameter_curves atomic mode restores journaled points on mid-apply failure", async () => {
  const model = createCurveModel();
  model.failures.push({ method: "add", remainingSkips: 1, code: "ARGUMENT_MISMATCH" });
  const service = createService(model);
  const result = await service.patchCurves(oneCurve({
    target: TARGET,
    parameter: "loudness",
    mode: "replace",
    range: { fromBlick: 0, toBlick: 2 * Q },
    points: [
      { blick: 0, value: 1 },
      { blick: Q, value: 2 },
    ],
  }));

  assert.equal(result.ok, false);
  assert.equal(result.status, "rolled_back");
  assert.equal(result.rollback.verified, true);
  assert.equal(result.effects, "reverted");
  assert.deepEqual(model.points, [
    [0, 0],
    [Q, 0.5],
    [2 * Q, 1],
  ]);
});

test("sv_patch_parameter_curves simplify uses tolerance-sampled verification", async () => {
  const model = createCurveModel();
  const service = createService(model);
  const result = await service.patchCurves(oneCurve({
    target: TARGET,
    parameter: "loudness",
    mode: "replace",
    range: { fromBlick: 0, toBlick: 4 * Q },
    // 中间两点均在两端线性插值上，simplify 应移除它们。
    points: [
      { blick: 0, value: 0 },
      { blick: Q, value: 1 },
      { blick: 2 * Q, value: 2 },
      { blick: 3 * Q, value: 3 },
    ],
    simplifyThreshold: 0.01,
  }));

  assert.equal(result.ok, true);
  assert.equal(result.curves[0].verification.mode, "tolerance_sampled");
  assert.equal(result.verification.passed, true);
  assert.equal(result.curves[0].after.pointCount, 2);
  assert.ok(result.curves[0].verification.evidence.maxDeviation <= 0.01);
});

test("sv_patch_parameter_curves validates target and parameter", async () => {
  const model = createCurveModel();
  const service = createService(model);
  const instrumental = await service.patchCurves(oneCurve({
    target: { trackIndex: 0, groupIndex: 1 },
    parameter: "loudness",
    mode: "add",
    amount: 1,
    range: { fromBlick: 0, toBlick: Q },
  }));
  assert.equal(instrumental.error.code, "INVALID_TARGET");

  const unknown = await service.patchCurves(oneCurve({
    target: TARGET,
    parameter: "nonexistent",
    mode: "add",
    amount: 1,
    range: { fromBlick: 0, toBlick: Q },
  }));
  assert.equal(unknown.error.code, "UNKNOWN_PARAMETER");

  // replace 缺 points：批量端点把输入校验失败包进信封并指出出错的曲线索引，
  // 而不是抛异常——调用方总能知道是哪一条曲线的问题。
  const missingPoints = await service.patchCurves(oneCurve({
    target: TARGET,
    parameter: "loudness",
    mode: "replace",
    range: { fromBlick: 0, toBlick: Q },
  }));
  assert.equal(missingPoints.status, "failed");
  assert.equal(missingPoints.error.code, "INVALID_ARGUMENTS");
  assert.equal(missingPoints.curves[0].status, "failed");
});

test("curve read and patch reject typos before host parameter lookup", async () => {
  const model = addBatchCurves(createCurveModel());
  model.unknownParameterFallsBack = true;
  const service = createService(model);
  const patch = await service.patchCurves(oneCurve({
    target: TARGET,
    parameter: "loudnes",
    mode: "replace",
    range: { fromBlick: 0, toBlick: Q },
    points: [{ blick: 0, value: 1 }],
  }));
  assert.equal(patch.ok, false);
  assert.equal(patch.error.code, "UNKNOWN_PARAMETER");
  await assert.rejects(
    service.getCurve({
      target: TARGET,
      parameter: "pitchDelt",
      range: { fromBlick: 0, toBlick: Q },
    }),
    (error) => error.code === "UNKNOWN_PARAMETER"
  );
  assert.equal(model.parameterLookupCount, 0);
  assert.equal(model.undoCount, 0);
});

const WINDOW = 8 * Q;

test("sv_get_parameter_curve filters a wide range from one getAllPoints call", async () => {
  const model = createCurveModel();
  // 300 个点分布在 3 个读取窗口内。
  model.points = Array.from({ length: 300 }, (_, index) => [index * (WINDOW * 3 / 300), index % 10]);
  const service = createService(model);
  const result = await service.getCurve({
    target: TARGET,
    parameter: "loudness",
    range: { fromBlick: 0, toBlick: 3 * WINDOW },
    maxPoints: 100,
  });

  assert.equal(result.ok, true);
  assert.equal(model.getAllPointsCalls, 1);
  assert.equal(model.getPointsCalls ?? 0, 0);
  assert.equal(result.data.points.length, 100);
  assert.equal(result.data.complete, false);
  assert.ok(Number.isFinite(result.data.nextFromBlick));
  assert.ok(result.warnings.some((warning) => warning.code === "POINTS_TRUNCATED"));

  // 从 nextFromBlick 续读能覆盖剩余点。
  const rest = await service.getCurve({
    target: TARGET,
    parameter: "loudness",
    range: { fromBlick: result.data.nextFromBlick, toBlick: 3 * WINDOW },
    maxPoints: 2000,
  });
  assert.equal(result.data.points.length + rest.data.points.length, 300);
});

test("sv_patch_parameter_curves refuses ranges denser than the journal cap", async () => {
  const model = createCurveModel();
  model.points = Array.from({ length: 4001 }, (_, index) => [index, 0]);
  const service = createService(model);
  const result = await service.patchCurves(oneCurve({
    target: TARGET,
    parameter: "loudness",
    mode: "add",
    amount: 1,
    range: { fromBlick: 0, toBlick: 8 * Q },
  }));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "CURVE_TOO_DENSE");
  assert.equal(result.effects, "none");
  assert.equal(model.undoCount, 0);
});

test("sv_patch_parameter_curves rolls back when the read-back getAllPoints throws", async () => {
  const model = createCurveModel();
  const service = createService(model);
  // journal 读是第 1 次 getAllPoints；写后读回是第 2 次。
  model.failures.push({ method: "getAllPoints", remainingSkips: 1, code: "UNKNOWN_HANDLE" });
  const result = await service.patchCurves(oneCurve({
    target: TARGET,
    parameter: "loudness",
    mode: "replace",
    range: { fromBlick: 0, toBlick: 2 * Q },
    points: [{ blick: 0, value: 1 }],
  }));

  assert.equal(result.ok, false);
  assert.equal(result.status, "rolled_back");
  assert.equal(result.error.code, "UNKNOWN_HANDLE");
  assert.equal(result.rollback.verified, true);
  assert.deepEqual(model.points, [
    [0, 0],
    [Q, 0.5],
    [2 * Q, 1],
  ]);
  assert.equal(model.undoCount, 2);
});

test("sv_patch_parameter_curves simplify verification flags residual out-of-tolerance points", async () => {
  const model = createCurveModel();
  // simplify 一个点都不移除，并偷偷加一个偏离计划曲线的点。
  const service = createService(model);
  const original = model.host.call;
  model.host.call = async (request) => {
    if (request.method === "simplify") {
      model.points.push([Q / 2, 20]);
      model.points.sort((a, b) => a[0] - b[0]);
      return true;
    }
    return original(request);
  };
  const result = await service.patchCurves(oneCurve({
    target: TARGET,
    parameter: "loudness",
    mode: "replace",
    range: { fromBlick: 0, toBlick: 2 * Q },
    points: [
      { blick: 0, value: 0 },
      { blick: Q, value: 1 },
    ],
    simplifyThreshold: 0.01,
  }));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "POSTCONDITION_FAILED");
  assert.equal(result.curves[0].verification.evidence.unexpectedObservedPointCount, 1);
  assert.equal(result.status, "rolled_back");
});

test("sv_patch_parameter_curves rejects leftover points for non-linear interpolation", async () => {
  const model = createCurveModel();
  model.interpolationMethod = "Cosine";
  model.points = [
    [0, 0],
    [Q / 2, 0.25],
    [2 * Q, 1],
  ];
  // 模拟 remove/simplify 都静默未生效；旧实现按 Linear 计算会误把中间点视为合法。
  model.ignoreRemove = true;
  model.ignoreSimplify = true;
  const result = await createService(model).patchCurves(oneCurve({
    target: TARGET,
    parameter: "loudness",
    mode: "replace",
    range: { fromBlick: 0, toBlick: 2 * Q },
    points: [
      { blick: 0, value: 0 },
      { blick: 2 * Q, value: 1 },
    ],
    simplifyThreshold: 0.01,
  }));

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "POSTCONDITION_FAILED");
  assert.equal(result.curves[0].verification.evidence.unexpectedObservedPointCount, 1);
  assert.equal(result.curves[0].verification.evidence.maxObservedPointDeviation, 0);
});

test("sv_get_parameter_curve bisects windows on FRAME_TOO_LARGE and completes", async () => {
  const model = createCurveModel();
  // 2000 个点均匀分布在 2 个默认窗口内；单帧最多 300 点，必须二分才能读完。
  model.points = Array.from({ length: 2000 }, (_, index) => [
    Math.floor(index * ((2 * WINDOW) / 2000)),
    index % 5,
  ]);
  model.maxPointsPerCall = 300;
  model.maxAllPointsPerCall = 300;
  const service = createService(model);
  const result = await service.getCurve({
    target: TARGET,
    parameter: "loudness",
    range: { fromBlick: 0, toBlick: 2 * WINDOW },
    maxPoints: 2000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.complete, true);
  assert.equal(result.data.points.length, 2000);
  assert.equal(model.getAllPointsCalls, 1);
  assert.ok(model.getPointsCalls > 2);
});

test("sv_get_parameter_curve reports CURVE_TOO_DENSE when even the minimum window overflows", async () => {
  const model = createCurveModel();
  model.points = Array.from({ length: 50 }, (_, index) => [index, 0]);
  model.maxPointsPerCall = 0;
  model.maxAllPointsPerCall = 0;
  const service = createService(model);
  await assert.rejects(
    service.getCurve({
      target: TARGET,
      parameter: "loudness",
      range: { fromBlick: 0, toBlick: 8 * Q },
    }),
    (error) => error.code === "CURVE_TOO_DENSE"
  );
});

test("sv_patch_parameter_curves fails an empty replace when the host silently ignores remove", async () => {
  const model = createCurveModel();
  model.ignoreRemove = true;
  const service = createService(model);
  const result = await service.patchCurves(oneCurve({
    target: TARGET,
    parameter: "loudness",
    mode: "replace",
    range: { fromBlick: 0, toBlick: 2 * Q },
    points: [],
    simplifyThreshold: 0.01,
  }));

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "POSTCONDITION_FAILED");
  // planned 为空时残留点必须判为失败，而不是因插值无定义被跳过。
  // （模型 simplify 合法移除了共线中点，范围内仍剩 2 个残留点。）
  assert.equal(result.verification.passed, false);
  assert.equal(result.curves[0].verification.evidence.observedPointCount, 2);
  assert.equal(result.curves[0].verification.evidence.unexpectedObservedPointCount, 2);
  assert.ok(
    Object.values(result.curves[0].verification.evidence).every(
      (value) => typeof value !== "number" || Number.isFinite(value)
    )
  );
});

test("sv_patch_parameter_curves dry-run preflights four curves without writes or Undo", async () => {
  const model = addBatchCurves(createCurveModel());
  const before = {
    loudness: model.points.map((point) => [...point]),
    tension: model.batchPoints.tension.map((point) => [...point]),
  };
  const result = await createService(model).patchCurves(
    fourCurveRequest({ action: "dry_run", undoLabel: "Tune Lead 1" })
  );

  assert.equal(result.ok, true);
  assert.equal(result.status, "dry_run");
  assert.equal(result.effects, "none");
  assert.equal(result.curves.length, 4);
  assert.ok(result.curves.every((curve) => curve.status === "planned"));
  assert.equal(result.undoRecords, 0);
  assert.equal(result.undoLabel, "Tune Lead 1");
  assert.equal(result.undoLabelApplied, false);
  assert.equal(model.undoCount, 0);
  assert.deepEqual(model.points, before.loudness);
  assert.deepEqual(model.batchPoints.tension, before.tension);
  // 唯一形状（§10.6 规则 14）：before/planned 的计数与统计恒定返回，因此 dry-run
  // 的证据不再依赖调用方先选对档位。逐点数组仍不内联（规则 10）。
  assert.equal(result.curves[0].before.pointCount, 3);
  assert.equal(result.curves[0].planned.pointCount, 1);
  assert.equal(result.curves[0].before.points, undefined);
  assert.equal(result.curves[0].planned.points, undefined);
});

test("sv_patch_parameter_curves commits and verifies four curves in one Undo interval", async () => {
  const model = addBatchCurves(createCurveModel());
  let tick = 1000;
  const service = new ParameterCurveService(
    { withExclusive: (task) => task(model.host) },
    { now: () => tick++ }
  );
  const result = await service.patchCurves(fourCurveRequest({ }));

  assert.equal(result.ok, true);
  assert.equal(result.status, "succeeded");
  assert.equal(result.targetUuid, "curve-group");
  assert.equal(result.undoRecords, 1);
  assert.equal(model.undoCount, 2);
  assert.ok(result.curves.every((curve) => curve.verified === true));
  assert.deepEqual(model.points, [[0, 2]]);
  assert.deepEqual(model.batchPoints.tension, [[0, 0.2]]);
  assert.deepEqual(model.batchPoints.breathiness, [[0, 0.3]]);
  assert.deepEqual(model.batchPoints.pitchDelta, [[0, -10]]);
  assert.ok(result.timings.serviceTotalMs >= result.timings.coordinatorQueueMs);
  assert.equal(
    result.timings.serviceTotalMs,
    result.timings.validationMs +
      result.timings.coordinatorQueueMs +
      result.timings.operationMs
  );
  for (const field of [
    "validationMs",
    "coordinatorQueueMs",
    "preflightReadMs",
    "hostWriteMs",
    "verificationMs",
    "rollbackMs",
    "operationMs",
    "serviceTotalMs",
  ]) {
    assert.equal(Number.isFinite(result.timings[field]), true);
    assert.ok(result.timings[field] >= 0);
  }
});

test("large successful curve transactions move per-curve evidence into one detail artifact", async () => {
  const model = addBatchCurves(createCurveModel());
  const artifactStore = new ArtifactStore({ now: () => 1000 });
  const sessionId = "sess_curve_detail";
  const service = new ParameterCurveService(
    { withExclusive: (task) => task(model.host) },
    { now: () => 1000, artifactStore, sessionId }
  );
  const curves = Array.from({ length: 30 }, (_, index) => ({
    parameter: "loudness",
    mode: "replace",
    range: { fromBlick: index * 1000, toBlick: index * 1000 + 100 },
    points: [{ blick: index * 1000, value: index / 10 }],
  }));
  const result = await service.patchCurves({
    action: "dry_run",
    target: { ...TARGET, expectedGroupUuid: "curve-group" },
    curves,
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.detailsOmitted, true);
  assert.equal(result.curves, undefined);
  assert.equal(result.curveSummary.total, 30);
  assert.equal(result.curveSummary.statuses.planned, 30);
  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") < 16 * 1024);
  const detail = artifactStore.resolve({
    artifactId: result.detailRef.artifactId,
    expectedKind: "curve-transaction-detail",
    sessionId,
  });
  assert.equal(detail.payload.curves.length, 30);
  assert.ok(detail.payload.curves.every((curve) => curve.before && curve.planned));
  assert.equal(model.undoCount, 0);
});

test("sv_patch_parameter_curves rolls every touched curve back when a later write fails", async () => {
  const model = addBatchCurves(createCurveModel());
  const beforeLoudness = model.points.map((point) => [...point]);
  const beforeTension = model.batchPoints.tension.map((point) => [...point]);
  model.failBatchParameter = "tension";
  model.failBatchMethod = "add";
  const result = await createService(model).patchCurves(fourCurveRequest());

  assert.equal(result.ok, false);
  assert.equal(result.status, "rolled_back");
  assert.equal(result.effects, "reverted");
  assert.equal(result.error.phase, "execute");
  assert.equal(result.error.curveIndex, 1);
  assert.equal(result.error.parameter, "tension");
  assert.equal(result.rollback.verified, true);
  assert.equal(result.rollback.curves.length, 2);
  assert.deepEqual(model.points, beforeLoudness);
  assert.deepEqual(model.batchPoints.tension, beforeTension);
  assert.deepEqual(model.batchPoints.breathiness, [[0, 0]]);
  assert.equal(model.undoCount, 2);
});

test("sv_patch_parameter_curves rejects a stale UUID before reading Automation", async () => {
  const model = addBatchCurves(createCurveModel());
  const request = fourCurveRequest();
  request.target.expectedGroupUuid = "stale-group";
  const result = await createService(model).patchCurves(request);

  assert.equal(result.ok, false);
  assert.equal(result.status, "conflict");
  assert.equal(result.effects, "none");
  assert.equal(result.error.code, "TARGET_CONFLICT");
  assert.equal(result.target.groupUuid, "curve-group");
  assert.equal(model.parameterLookupCount, 0);
  assert.equal(model.undoCount, 0);
});

test("sv_patch_parameter_curves leaves prepared curves untouched when preflight later fails", async () => {
  const model = addBatchCurves(createCurveModel());
  const request = fourCurveRequest();
  request.curves[1].parameter = "notAParameter";
  const result = await createService(model).patchCurves(request);

  assert.equal(result.ok, false);
  assert.equal(result.status, "failed");
  assert.equal(result.effects, "none");
  assert.equal(result.error.phase, "preflight");
  assert.equal(result.error.curveIndex, 1);
  assert.equal(result.curves[0].status, "not_attempted");
  assert.equal(result.curves[1].status, "failed");
  assert.equal(model.undoCount, 0);
  assert.deepEqual(model.points, [
    [0, 0],
    [Q, 0.5],
    [2 * Q, 1],
  ]);
});

test("sv_patch_parameter_curves accepts float32 quantization through the shared verifier", async () => {
  const model = addBatchCurves(createCurveModel());
  model.coerceValuesToFloat32 = true;
  const request = fourCurveRequest({ });
  request.curves = [
    {
      parameter: "loudness",
      mode: "replace",
      range: { fromBlick: 0, toBlick: 2 * Q },
      points: [
        { blick: 0, value: 0.2 },
        { blick: Q, value: 0.8 },
      ],
    },
  ];
  const result = await createService(model).patchCurves(request);

  assert.equal(result.ok, true);
  assert.equal(result.curves[0].verified, true);
  assert.equal(result.curves[0].verification.evidence.valueTolerance, 48e-6);
  assert.ok(result.curves[0].verification.evidence.maxValueDelta > 0);
});

test("sv_patch_parameter_curves reports rollback_failed with per-curve evidence", async () => {
  const model = addBatchCurves(createCurveModel());
  model.failBatchParameter = "tension";
  model.failBatchMethod = "add";
  model.failBatchRollbackParameter = "tension";
  const result = await createService(model).patchCurves(fourCurveRequest());

  assert.equal(result.ok, false);
  assert.equal(result.status, "rollback_failed");
  assert.equal(result.effects, "may_remain");
  assert.equal(result.rollback.attempted, true);
  assert.equal(result.rollback.verified, false);
  assert.equal(result.undo.automaticRollback, true);
  assert.ok(
    result.rollback.curves.some(
      (curve) => curve.parameter === "tension" && curve.verified === false && curve.error
    )
  );
});

test("sv_patch_parameter_curves rejects typos before the host can apply its default curve", async () => {
  const model = addBatchCurves(createCurveModel());
  model.unknownParameterFallsBack = true;
  const service = createService(model);
  for (const parameter of [
    "pitchDelt",
    "tensionn",
    "loudnes",
    "breathines",
    "definitelyNotAParameter",
    "toneShift",
  ]) {
    const request = fourCurveRequest({ action: "dry_run" });
    request.curves = [
      {
        parameter,
        mode: "replace",
        range: { fromBlick: 0, toBlick: Q },
        points: [{ blick: 0, value: 0 }],
      },
    ];
    const result = await service.patchCurves(request);
    assert.equal(result.ok, false);
    assert.equal(result.status, "failed");
    assert.equal(result.effects, "none");
    assert.equal(result.error.code, "UNKNOWN_PARAMETER");
    assert.equal(result.error.requestedParameter, parameter);
    assert.ok(result.error.availableParameters.includes("pitchDelta"));
    assert.equal(result.curves[0].requestedParameter, parameter);
    assert.equal(result.curves[0].resolvedParameter, null);
  }
  assert.equal(model.parameterLookupCount, 0);
  assert.equal(model.undoCount, 0);
});

test("sv_patch_parameter_curves validates dynamic vocal modes and reports aliases", async () => {
  const model = addBatchCurves(createCurveModel());
  const service = createService(model);
  const valid = fourCurveRequest({ action: "dry_run" });
  valid.curves = [
    {
      parameter: "VOCALMODE_POWERFUL",
      mode: "replace",
      range: { fromBlick: 0, toBlick: Q },
      points: [{ blick: 0, value: 75 }],
    },
  ];
  const validResult = await service.patchCurves(valid);
  assert.equal(validResult.ok, true);
  assert.equal(validResult.curves[0].requestedParameter, "VOCALMODE_POWERFUL");
  assert.equal(validResult.curves[0].resolvedParameter, "vocalMode_Powerful");

  const invalid = fourCurveRequest({ action: "dry_run" });
  invalid.curves = [
    {
      parameter: "vocalMode_NoSuchMode",
      mode: "replace",
      range: { fromBlick: 0, toBlick: Q },
      points: [{ blick: 0, value: 75 }],
    },
  ];
  const invalidResult = await service.patchCurves(invalid);
  assert.equal(invalidResult.ok, false);
  assert.equal(invalidResult.error.code, "UNKNOWN_PARAMETER");
  assert.ok(invalidResult.error.availableParameters.includes("vocalMode_Powerful"));
});

test("sv_patch_parameter_curves rejects a host fallback that disagrees with the whitelist", async () => {
  const model = addBatchCurves(createCurveModel());
  model.forceParameterFallback = "tension";
  const request = fourCurveRequest({ action: "dry_run" });
  request.curves = [request.curves[1]];
  const result = await createService(model).patchCurves(request);

  assert.equal(result.ok, false);
  assert.equal(result.effects, "none");
  assert.equal(result.error.code, "PARAMETER_RESOLUTION_MISMATCH");
  assert.equal(result.error.requestedParameter, "tension");
  assert.equal(result.error.observedTypeName, "pitchDelta");
  assert.equal(result.error.observedDefinitionTypeName, "pitchDelta");
  assert.equal(model.undoCount, 0);
});

test("sv_patch_parameter_curves wraps input validation failures in the batch envelope", async () => {
  const model = addBatchCurves(createCurveModel());
  const request = fourCurveRequest();
  request.curves[0].points = [{ blick: 0, value: Number.NaN }];
  const result = await createService(model).patchCurves(request);

  assert.equal(result.ok, false);
  assert.equal(result.status, "failed");
  assert.equal(result.effects, "none");
  assert.equal(result.error.code, "INVALID_ARGUMENTS");
  assert.equal(result.error.phase, "validate");
  assert.equal(result.undoRecords, 0);
  assert.equal(result.target.expectedGroupUuid, "curve-group");
  assert.equal(result.timings.dispatcherQueueMs, null);
  assert.ok(Number.isFinite(result.timings.validationMs));
  assert.equal(result.timings.coordinatorQueueMs, null);
  assert.ok(Number.isFinite(result.timings.serviceTotalMs));
});

test("sv_patch_parameter_curves measures ExecutionCoordinator wait separately", async () => {
  const model = addBatchCurves(createCurveModel());
  const coordinator = new ExecutionCoordinator();
  let clock = 0;
  let releaseFirst;
  let reportFirstEntered;
  const firstEntered = new Promise((resolve) => {
    reportFirstEntered = resolve;
  });
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const originalCall = model.host.call;
  let shouldBlock = true;
  model.host.call = async (request) => {
    if (shouldBlock && request.method === "getNumTracks") {
      shouldBlock = false;
      reportFirstEntered();
      await firstGate;
    }
    return originalCall(request);
  };
  const service = new ParameterCurveService(
    {
      withExclusive: (task) => coordinator.runExclusive(() => task(model.host)),
    },
    { now: () => clock }
  );
  const first = service.patchCurves(fourCurveRequest({ action: "dry_run" }));
  await firstEntered;
  clock = 100;
  const second = service.patchCurves(fourCurveRequest({ action: "dry_run" }));
  await Promise.resolve();
  clock = 1000;
  releaseFirst();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(firstResult.ok, true);
  assert.equal(secondResult.ok, true);
  assert.equal(secondResult.timings.dispatcherQueueMs, null);
  assert.equal(secondResult.timings.validationMs, 0);
  assert.equal(secondResult.timings.coordinatorQueueMs, 900);
  assert.equal(secondResult.timings.operationMs, 0);
  assert.equal(secondResult.timings.serviceTotalMs, 900);
});

test("sv_patch_parameter_curves reports point-count evidence and rejects overlapping aliases", async () => {
  const model = addBatchCurves(createCurveModel());
  const planned = await createService(model).patchCurves(
    fourCurveRequest({ action: "dry_run" })
  );
  // 唯一形状（§10.6 规则 14）：before/planned 返回计数与统计，不内联逐点数组
  // ——逐点明细是唯一会随曲线长度无界增长的部分，按规则 10 只走 Artifact。
  assert.equal(planned.curves[0].before.pointCount, 3);
  assert.equal(planned.curves[0].planned.pointCount, 1);
  assert.equal(planned.curves[0].before.points, undefined);
  assert.equal(planned.curves[0].planned.points, undefined);
  assert.ok(planned.curves[0].before.stats);
  assert.ok(planned.curves[0].planned.stats);

  const duplicate = fourCurveRequest();
  duplicate.curves[1].parameter = "LOUDNESS";
  const duplicateResult = await createService(model).patchCurves(duplicate);
  assert.equal(duplicateResult.ok, false);
  assert.equal(duplicateResult.error.code, "OVERLAPPING_CURVE_RANGES");
  assert.equal(duplicateResult.effects, "none");
  assert.equal(duplicateResult.undoRecords, 0);
  assert.equal(duplicateResult.target.groupUuid, "curve-group");
  assert.equal(duplicateResult.curves[0].status, "not_applied");
  assert.equal(duplicateResult.curves[0].resolvedParameter, "loudness");
  assert.equal(duplicateResult.curves[1].status, "failed");
  assert.equal(duplicateResult.curves[1].resolvedParameter, "loudness");
  assert.equal(duplicateResult.error.resolvedParameter, "loudness");
  assert.ok(Number.isFinite(duplicateResult.timings.serviceTotalMs));
});

test("same Automation parameter may use disjoint ranges in one Undo transaction", async () => {
  const model = createCurveModel();
  const result = await createService(model).patchCurves({
    target: TARGET,
    curves: [
      {
        parameter: "loudness",
        mode: "replace",
        range: { fromBlick: 0, toBlick: Q / 2 },
        points: [{ blick: 0, value: 2 }],
      },
      {
        parameter: "LOUDNESS",
        mode: "replace",
        range: { fromBlick: Q + 1, toBlick: 2 * Q },
        points: [{ blick: 2 * Q, value: 3 }],
      },
    ],
    action: "commit",
    atomic: true,
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.undoRecords, 1);
  assert.equal(result.undo.expectedUserUndoSteps, 1);
  assert.equal(model.undoCount, 2);
  assert.ok(result.curves.every((curve) => curve.verified === true));
  assert.deepEqual(model.points, [
    [0, 2],
    [Q, 0.5],
    [2 * Q, 3],
  ]);
});

test("disjoint ranges of one parameter roll back together when a later range fails", async () => {
  const model = createCurveModel();
  const before = structuredClone(model.points);
  model.failures.push({ method: "remove", remainingSkips: 1, code: "INJECTED_FAILURE" });
  const result = await createService(model).patchCurves({
    target: TARGET,
    curves: [
      {
        parameter: "loudness",
        mode: "replace",
        range: { fromBlick: 0, toBlick: Q / 2 },
        points: [{ blick: 0, value: 2 }],
      },
      {
        parameter: "loudness",
        mode: "replace",
        range: { fromBlick: Q + 1, toBlick: 2 * Q },
        points: [{ blick: 2 * Q, value: 3 }],
      },
    ],
    action: "commit",
    atomic: true,
  });

  assert.equal(result.status, "rolled_back");
  assert.equal(result.effects, "reverted");
  assert.equal(result.rollback.verified, true);
  assert.equal(result.undoRecords, 1);
  assert.deepEqual(model.points, before);
});

test("sv_patch_parameter_curves expands a planRef without consulting SnapshotService", async () => {
  const sessionId = "sess_curve_plan";
  const artifactStore = new ArtifactStore({ now: () => 1000 });
  const model = createCurveModel();
  const { service, contextId, stored, snapshotService } = createRangeContextService(model, {
    artifactStore,
    sessionId,
  });
  const occurrence = stored.context.occurrences[0];
  const { payload } = buildPlanArtifact({
    targetTool: "sv_patch_parameter_curves",
    mutationRequest: {
      target: { contextId, occurrence: 0, expectedGroupUuid: "curve-group" },
      action: "dry_run",
      atomic: true,
      curves: [
        {
          parameter: "loudness",
          mode: "replace",
          range: { fromBlick: 0, toBlick: Q },
          points: [{ blick: 0, value: 0.25 }],
        },
      ],
    },
    targetGroupUuid: occurrence.targetGroupUuid,
    occurrence: 0,
    expectedTimeOffsetBlick: occurrence.timeOffsetBlick,
    capsule: { stored, occurrence, noteIndexes: [] },
  });
  const reference = planReference(
    artifactStore.seal({
      kind: "plan",
      schemaVersion: "1",
      sessionId,
      sourceEpoch: 1,
      payload,
    })
  );
  snapshotService.getContext = () => {
    throw new Error("PlanRef mutation must not consult SnapshotService.getContext");
  };

  const result = await service.patchCurves({ planRef: reference, action: "dry_run" });
  assert.equal(result.status, "dry_run");
  assert.equal(result.curves[0].planned.pointCount, 1);
  assert.equal(model.undoCount, 0);
});

test("range context resolves note anchors and musical positions in batch dry-run", async () => {
  const model = createCurveModel();
  const { service, contextId } = createRangeContextService(model);
  const result = await service.patchCurves({
    target: { contextId, occurrence: 0 },
    action: "dry_run",
    curves: [
      {
        parameter: "loudness",
        mode: "replace",
        range: { coordinate: "local", fromBlick: 0, toBlick: 2 * Q },
        points: [
          {
            anchor: {
              note: 0,
              position: "center",
              offset: { unit: "quarter", value: 0.25 },
            },
            value: 1,
          },
          { musicalPosition: { bar: 2, beat: 1 }, value: 2 },
        ],
      },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "dry_run");
  assert.equal(result.target.contextId, contextId);
  assert.equal(result.target.trackIndex, 0);
  assert.deepEqual(
    result.curves[0].resolvedPositions.map((point) => [point.source, point.localBlick]),
    [
      ["musicalPosition", 0],
      ["noteAnchor", Q + Q / 4],
    ]
  );
  assert.equal(model.undoCount, 0);
});

test("range context resolves semantic read bounds without exposing raw BLICK inputs", async () => {
  const model = createCurveModel();
  const { service, contextId } = createRangeContextService(model);
  const result = await service.getCurve({
    target: { contextId, occurrence: 0 },
    parameter: "loudness",
    range: {
      from: { musicalPosition: { bar: 2, beat: 1 } },
      to: { anchor: { note: 0, position: "end" } },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.range.coordinate, "semantic");
  assert.equal(result.data.range.localFromBlick, 0);
  assert.equal(result.data.range.localToBlick, 2 * Q);
  assert.equal(result.data.range.from.source, "musicalPosition");
  assert.equal(result.data.range.to.source, "noteAnchor");
});

test("a one-curve dry-run reports semantic range and resolved point evidence", async () => {
  const model = createCurveModel();
  const { service, contextId } = createRangeContextService(model);
  const result = await service.patchCurves(oneCurve({
    target: { contextId, occurrence: 0 },
    parameter: "loudness",
    mode: "replace",
    range: {
      from: { anchor: { note: 0, position: "onset" } },
      to: { anchor: { note: 0, position: "end" } },
    },
    points: [{ anchor: { note: 0, position: "center" }, value: 1 }],
    action: "dry_run",
  }));
  assert.equal(result.ok, true);
  assert.equal(result.curves[0].range.coordinate, "semantic");
  assert.equal(result.curves[0].resolvedPositions[0].source, "noteAnchor");
  assert.equal(result.curves[0].resolvedPositions[0].localBlick, Q);
  assert.equal(model.undoCount, 0);
});

test("semantic ranges support snapshot boundaries and adjacent-note gap anchors", async () => {
  const model = createCurveModel();
  const { service, contextId } = createRangeContextService(model);
  const result = await service.patchCurves({
    target: { contextId, occurrence: 0 },
    action: "dry_run",
    curves: [
      {
        parameter: "loudness",
        mode: "replace",
        range: { from: { rangeBoundary: "start" }, to: { rangeBoundary: "end" } },
        points: [
          {
            gap: {
              afterNote: 0,
              beforeNote: 1,
              position: "center",
            },
            value: 1,
          },
        ],
      },
    ],
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.curves[0].range.localFromBlick, 0);
  assert.equal(result.curves[0].range.localToBlick, 4 * Q);
  assert.equal(result.curves[0].resolvedPositions[0].source, "noteGap");
  assert.equal(result.curves[0].resolvedPositions[0].localBlick, 2 * Q + Q / 2);
});

test("musical positions reject a range context whose meter map changed", async () => {
  const model = createCurveModel();
  const { service, contextId } = createRangeContextService(model);
  model.meterMarks = [{ position: 0, positionBlick: 0, numerator: 3, denominator: 4 }];
  const result = await service.patchCurves({
    target: { contextId, occurrence: 0 },
    action: "dry_run",
    curves: [
      {
        parameter: "loudness",
        mode: "replace",
        range: { coordinate: "local", fromBlick: 0, toBlick: 2 * Q },
        points: [{ musicalPosition: { bar: 2, beat: 1 }, value: 1 }],
      },
    ],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "STALE_CONTEXT");
  assert.equal(result.effects, "none");
  assert.equal(model.undoCount, 0);
});

test("semantic curve points reject duplicate resolved positions before writing", async () => {
  const model = createCurveModel();
  const { service, contextId } = createRangeContextService(model);
  const result = await service.patchCurves({
    target: { contextId, occurrence: 0 },
    action: "dry_run",
    curves: [
      {
        parameter: "loudness",
        mode: "replace",
        range: { coordinate: "local", fromBlick: 0, toBlick: 2 * Q },
        points: [
          { anchor: { note: 0, position: "onset" }, value: 1 },
          { musicalPosition: { bar: 2, beat: 1 }, value: 2 },
        ],
      },
    ],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "DUPLICATE_RESOLVED_POSITION");
  assert.equal(result.effects, "none");
  assert.equal(model.undoCount, 0);
});

test("note anchors reject stale fingerprints", async () => {
  const model = createCurveModel();
  const { service, contextId, noteState } = createRangeContextService(model);
  noteState.pitch = 61;
  const result = await service.patchCurves({
    target: { contextId, occurrence: 0 },
    action: "dry_run",
    curves: [
      {
        parameter: "loudness",
        mode: "replace",
        range: { coordinate: "local", fromBlick: 0, toBlick: 2 * Q },
        points: [
          { anchor: { note: 0, position: "onset" }, value: 1 },
        ],
      },
    ],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "STALE_CONTEXT");
  assert.equal(model.undoCount, 0);
});

function expectedNoteN0() {
  return {
    indexInGroup: 0,
    onsetBlick: 0,
    durationBlick: 2 * Q,
    pitch: 60,
    lyrics: "do",
    phonemesOverride: "d ow",
    languageOverride: "english",
    detuneCents: 0,
  };
}

test("target.expectedNotes passes preflight when the anchor note is unchanged", async () => {
  const model = createCurveModel();
  const { service, contextId } = createRangeContextService(model);
  const result = await service.patchCurves({
    target: {
      contextId,
      occurrence: 0,
      expectedTimeOffsetBlick: model.groupOnset,
      expectedNotes: [expectedNoteN0()],
    },
    action: "dry_run",
    curves: [
      {
        parameter: "loudness",
        mode: "replace",
        range: { coordinate: "local", fromBlick: 0, toBlick: 2 * Q },
        points: [
          { blick: 0, value: 1 },
          { blick: Q, value: 2 },
        ],
      },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "dry_run");
  assert.equal(model.undoCount, 0);
});

test("partial expectedNotes fingerprints fail INVALID_ARGUMENTS, not a false STALE_CONTEXT", async () => {
  const model = createCurveModel();
  const { service, contextId } = createRangeContextService(model);
  // verifyAnchoredNote 做 8 字段严格全等：缺字段若放行会与宿主观测必然不等，
  // 把"调用方少给字段"误报成"音符漂移"。归一化阶段必须直接拒绝。
  const result = await service.patchCurves({
    target: {
      contextId,
      occurrence: 0,
      expectedNotes: [{ indexInGroup: 0, onsetBlick: 0 }],
    },
    action: "dry_run",
    curves: [
      {
        parameter: "loudness",
        mode: "replace",
        range: { coordinate: "local", fromBlick: 0, toBlick: 2 * Q },
        points: [
          { blick: 0, value: 1 },
          { blick: Q, value: 2 },
        ],
      },
    ],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "INVALID_ARGUMENTS");
  assert.match(result.error.message, /full snapshot fingerprint/);
  assert.equal(model.undoCount, 0);
});

test("target.expectedNotes rejects duplicate note indexes before the fingerprint cache can hide a conflict", async () => {
  const model = createCurveModel();
  const { service, contextId, noteStates } = createRangeContextService(model);
  const duplicateIdentity = {
    ...noteStates[1],
    indexInGroup: 0,
  };
  const result = await service.patchCurves({
    target: {
      contextId,
      occurrence: 0,
      expectedNotes: [expectedNoteN0(), duplicateIdentity],
    },
    action: "dry_run",
    curves: [
      {
        parameter: "loudness",
        mode: "replace",
        range: { coordinate: "local", fromBlick: 0, toBlick: 2 * Q },
        points: [
          { blick: 0, value: 1 },
          { blick: Q, value: 2 },
        ],
      },
    ],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "INVALID_ARGUMENTS");
  assert.match(result.error.message, /duplicate.*indexInGroup/i);
  assert.equal(model.undoCount, 0);
});

test("expectedTimeOffsetBlick catches a reference move that note fingerprints cannot see", async () => {
  const model = createCurveModel();
  const { service, contextId } = createRangeContextService(model);
  const capturedOffset = model.groupOnset;
  // setTimeOffset 移动整个 reference：UUID 与组内本地音符指纹全部不变，仅 live getTimeOffset 变化。
  model.groupOnset = capturedOffset + Q;
  const absoluteCurves = [
    {
      parameter: "loudness",
      mode: "replace",
      range: { coordinate: "absolute", fromBlick: capturedOffset, toBlick: capturedOffset + 2 * Q },
      points: [
        { blick: capturedOffset, value: 1 },
        { blick: capturedOffset + Q, value: 2 },
      ],
    },
  ];
  // 只带 expectedNotes（本地指纹）：守卫看不到移动，提交"成功"——这正是被审计指出的漏洞形态。
  const fingerprintsOnly = await service.patchCurves({
    target: { contextId, occurrence: 0, expectedNotes: [expectedNoteN0()] },
    action: "commit",
    curves: absoluteCurves,
  });
  assert.equal(fingerprintsOnly.ok, true);
  // 加上 expectedTimeOffsetBlick：移动被判定为 STALE_CONTEXT，effects none、零 Undo。
  const guarded = await service.patchCurves({
    target: {
      contextId,
      occurrence: 0,
      expectedTimeOffsetBlick: capturedOffset,
      expectedNotes: [expectedNoteN0()],
    },
    action: "commit",
    curves: absoluteCurves,
  });
  assert.equal(guarded.ok, false);
  assert.equal(guarded.error.code, "STALE_CONTEXT");
  assert.match(guarded.error.message, /timeOffsetBlick/);
  assert.equal(guarded.effects, "none");
});

test("target.expectedNotes fails STALE_CONTEXT and writes nothing when the anchor note drifts", async () => {
  const model = createCurveModel();
  const { service, contextId, noteState } = createRangeContextService(model);
  // group UUID 不变、contextId 未失效，仅音符被 UI/raw API 从 onset 0 挪到 Q（绝对 BLICK 曲线会落到旧位置）。
  noteState.onsetBlick = Q;
  const result = await service.patchCurves({
    target: { contextId, occurrence: 0, expectedNotes: [expectedNoteN0()] },
    action: "commit",
    curves: [
      {
        parameter: "loudness",
        mode: "replace",
        range: { coordinate: "local", fromBlick: 0, toBlick: 2 * Q },
        points: [
          { blick: 0, value: 1 },
          { blick: Q, value: 2 },
        ],
      },
    ],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "STALE_CONTEXT");
  assert.equal(result.effects, "none");
  assert.equal(model.undoCount, 0);
});

test("shared target occurrences require explicit mutation confirmation", async () => {
  const model = createCurveModel();
  const { service, contextId } = createRangeContextService(model, { shared: true });
  const request = {
    target: { contextId, occurrence: 0 },
    action: "dry_run",
    curves: [
      {
        parameter: "loudness",
        mode: "replace",
        range: { coordinate: "local", fromBlick: 0, toBlick: 2 * Q },
        points: [{ blick: 0, value: 1 }],
      },
    ],
  };
  const preview = await service.patchCurves(request);
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.ok(preview.warnings.some((warning) => warning.code === "SHARED_TARGET_DRY_RUN"));
  assert.equal(model.undoCount, 0);

  const rejected = await service.patchCurves({ ...request, action: "commit" });
  assert.equal(rejected.error.code, "SHARED_TARGET_REQUIRES_CONFIRMATION");
  assert.equal(model.undoCount, 0);

  const accepted = await service.patchCurves({
    ...request,
    action: "commit",
    target: { ...request.target, allowSharedTargetMutation: true },
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.target.sharedTargetOccurrences.length, 2);
  assert.equal(model.undoCount, 2);
});

test("shared target mathematical no-op does not require mutation confirmation", async () => {
  const model = createCurveModel();
  const { service, contextId } = createRangeContextService(model, { shared: true });
  const result = await service.patchCurves({
    action: "commit",
    target: { contextId, occurrence: 0 },
    curves: [
      {
        parameter: "loudness",
        mode: "add",
        amount: 0,
        range: { coordinate: "local", fromBlick: 0, toBlick: 2 * Q },
      },
    ],
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, "no_change");
  assert.equal(result.effects, "none");
  assert.equal(result.undo.expectedUserUndoSteps, 0);
  assert.equal(model.undoCount, 0);
});

test("sv_get_parameter_curve enforces expectedGroupUuid on direct targets like the write path", async () => {
  const model = createCurveModel();
  const service = createService(model);
  // 读路径必须与写路径共用同一目标身份守卫：错误 UUID 不能返回真实组的点。
  await assert.rejects(
    service.getCurve({
      target: { trackIndex: 0, groupIndex: 0, expectedGroupUuid: "wrong-uuid" },
      parameter: "loudness",
      range: { fromBlick: 0, toBlick: 2 * Q },
    }),
    (error) => error.code === "TARGET_CONFLICT"
  );
  const ok = await service.getCurve({
    target: { trackIndex: 0, groupIndex: 0, expectedGroupUuid: "curve-group" },
    parameter: "loudness",
    range: { fromBlick: 0, toBlick: 2 * Q },
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.data.points.length, 3);

  // 写端行为不变：同样的错误 UUID → conflict。
  const write = await service.patchCurves(oneCurve({
    target: { trackIndex: 0, groupIndex: 0, expectedGroupUuid: "wrong-uuid" },
    parameter: "loudness",
    mode: "add",
    amount: 1,
    range: { fromBlick: 0, toBlick: 2 * Q },
  }));
  assert.equal(write.ok, false);
  assert.equal(write.status, "conflict");
  assert.equal(write.error.code, "TARGET_CONFLICT");
  assert.equal(model.undoCount, 0);
});

test("mathematical no-op curve writes return no_change without undo records", async () => {
  const model = createCurveModel();
  const service = createService(model);

  // add 0：范围内有点但值不变。
  const addZero = await service.patchCurves(oneCurve({
    target: { trackIndex: 0, groupIndex: 0 },
    parameter: "loudness",
    mode: "add",
    amount: 0,
    range: { fromBlick: 0, toBlick: 2 * Q },
  }));
  assert.equal(addZero.ok, true);
  assert.equal(addZero.status, "no_change");
  assert.equal(addZero.effects, "none");
  assert.equal(addZero.undo.boundaryCallsCompleted, 0);
  assert.equal(addZero.undo.expectedUserUndoSteps, 0);
  assert.equal(model.undoCount, 0);
  assert.deepEqual(model.points, [[0, 0], [Q, 0.5], [2 * Q, 1]]);

  // scale 1 在空范围（affected point set 为空）同样 no_change。
  const scaleEmpty = await service.patchCurves(oneCurve({
    target: { trackIndex: 0, groupIndex: 0 },
    parameter: "loudness",
    mode: "scale",
    amount: 1,
    range: { fromBlick: 10 * Q, toBlick: 11 * Q },
  }));
  assert.equal(scaleEmpty.status, "no_change");
  assert.equal(model.undoCount, 0);

  // replace 相同点集也是 no_change。
  const replaceSame = await service.patchCurves(oneCurve({
    target: { trackIndex: 0, groupIndex: 0 },
    parameter: "loudness",
    mode: "replace",
    points: [
      { blick: 0, value: 0 },
      { blick: Q, value: 0.5 },
      { blick: 2 * Q, value: 1 },
    ],
    range: { fromBlick: 0, toBlick: 2 * Q },
  }));
  assert.equal(replaceSame.status, "no_change");
  assert.equal(model.undoCount, 0);

  // 批量端点同样上报 no_change 且 undoRecords 为 0。
  const batch = await service.patchCurves({
    target: { trackIndex: 0, groupIndex: 0 },
    curves: [
      { parameter: "loudness", mode: "scale", amount: 1, range: { fromBlick: 0, toBlick: 2 * Q } },
    ],
    action: "commit",
  });
  assert.equal(batch.status, "no_change");
  assert.equal(batch.undoRecords, 0);
  assert.equal(batch.curves[0].status, "no_change");
  assert.equal(model.undoCount, 0);

  // 真实修改仍然开一步 Undo。
  const real = await service.patchCurves(oneCurve({
    target: { trackIndex: 0, groupIndex: 0 },
    parameter: "loudness",
    mode: "add",
    amount: 0.5,
    range: { fromBlick: 0, toBlick: 2 * Q },
  }));
  assert.equal(real.status, "succeeded");
  assert.equal(model.undoCount, 2);
});

test("a no-op plan with simplifyThreshold still writes because simplify may remove points", async () => {
  const model = createCurveModel();
  // 中间点 [Q, 0.5] 恰好线性可省略：simplify 会移除它，因此不能按 no_change 跳过。
  const service = createService(model);
  const result = await service.patchCurves(oneCurve({
    target: { trackIndex: 0, groupIndex: 0 },
    parameter: "loudness",
    mode: "add",
    amount: 0,
    simplifyThreshold: 0.01,
    range: { fromBlick: 0, toBlick: 2 * Q },
  }));
  assert.equal(result.ok, true);
  assert.equal(result.status, "succeeded");
  assert.equal(model.points.length, 2);
  assert.equal(model.undoCount, 2);
});
