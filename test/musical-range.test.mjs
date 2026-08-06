import assert from "node:assert/strict";
import test from "node:test";

import { ArtifactStore } from "../server/src/artifact-store.js";
import { ComputedPitchCompareService } from "../server/src/computed-pitch-compare.js";
import { decodeDense } from "../server/src/dense-codec.js";
import {
  RANGE_PAGE_LIMITS,
  RangeSnapshotService,
  getStoredComputedPitch,
} from "../server/src/musical-range.js";
import { StyleProfileService } from "../server/src/style-profile.js";
import { blickToMusical, musicalToBlick, normalizeMusicalPoint } from "../server/src/musical-time.js";

const Q = 705600000;
const BAR_4_4 = 4 * Q;
const FX_PARAMS = Object.freeze({
  compressor: { enabled: true, attack: 0.1, ratio: 4, threshold: -12 },
  room: {
    enabled: false,
    positionX: 0,
    positionY: 0,
    reflectionGain: 0,
    size: 15,
  },
  reverb: {
    enabled: true,
    type: "clean",
    preDelay: 0.05,
    decay: 1,
    dryWetRatio: 0.5,
  },
  postRoomEq: {
    enabled: false,
    lowShelf: { freq: 25, gain: 0 },
    filters: [
      { freq: 100, gain: 0, q: 0.71 },
      { freq: 1000, gain: 0, q: 0.71 },
      { freq: 10000, gain: 0, q: 0.71 },
    ],
  },
});

// 两轨模型：track0 一个跨小节 vocal group + 一个范围外 group；track1 instrumental。
// 小节 0-7 为 4/4，第 8 小节起 3/4；测试跨拍号换算。
function createRangeModel() {
  let nextHandle = 100;
  const handle = (type) => ({ __handle__: nextHandle++, __type__: type, __epoch__: 1 });
  const h = {
    project: handle("Project"),
    sv: handle("SV"),
    mainEditor: handle("MainEditorView"),
    timeAxis: handle("TimeAxis"),
    tracks: [handle("Track"), handle("Track")],
    mixers: [handle("TrackMixer"), handle("TrackMixer")],
    refs: [handle("NoteGroupReference"), handle("NoteGroupReference"), handle("NoteGroupReference")],
    groups: [handle("NoteGroup"), handle("NoteGroup")],
    notes: [handle("Note"), handle("Note"), handle("Note"), handle("Note")],
    automations: Object.fromEntries(
      ["pitchDelta", "tension", "loudness", "breathiness"].map((name) => [name, handle("Automation")])
    ),
  };
  const meterMarks = [
    { position: 0, positionBlick: 0, numerator: 4, denominator: 4 },
    { position: 8, positionBlick: 8 * BAR_4_4, numerator: 3, denominator: 4 },
  ];
  const tempoMarks = [{ position: 0, positionSeconds: 0, bpm: 120 }];
  // group0 onset 在第 2 小节开头（bar index 1），组内音符 onset 为组内相对 blick。
  const group0Onset = BAR_4_4;
  const noteState = [
    { onset: 0, duration: Q, pitch: 60, lyrics: "do" },
    { onset: Q, duration: Q, pitch: 62, lyrics: "re" },
    { onset: 3 * Q, duration: Q, pitch: 64, lyrics: "mi" }, // 与 re 之间有 1 拍休止
    { onset: 8 * BAR_4_4, duration: Q, pitch: 65, lyrics: "fa" }, // 绝对位置落在 3/4 段
  ];
  const model = {
    hostCalls: [],
    computedPitchCalls: [],
    fetchedNotesOfOutOfRangeGroup: false,
    secondReferenceInRange: false,
    noteState,
  };
  model.host = {
    epoch: () => 1,
    roots: async () => ({ project: h.project, sv: h.sv, mainEditor: h.mainEditor }),
    free: async () => {},
    index: async ({ field }) => {
      if (field === "QUARTER") return Q;
      throw new Error(`unsupported range index ${field}`);
    },
    call: async ({ handle: target, method, args = [] }) => {
      model.hostCalls.push(method);
      const id = target?.__handle__;
      if (id === h.project.__handle__) {
        if (method === "getTimeAxis") return h.timeAxis;
        if (method === "getNumTracks") return 2;
        if (method === "getTrack") return h.tracks[args[0] - 1];
      }
      if (id === h.timeAxis.__handle__) {
        if (method === "getAllMeasureMarks") return meterMarks.map((mark) => ({ ...mark }));
        if (method === "getAllTempoMarks") return tempoMarks.map((mark) => ({ ...mark }));
      }
      if (id === h.sv.__handle__) {
        if (method === "getPhonemesForGroup") return ["d ow", "r ey", "m iy", "f aa"];
        if (method === "getComputedPitchForGroup") {
          model.computedPitchCalls.push(args);
          return Array.from({ length: args[3] }, (_, index) => 60 + index / 100);
        }
      }
      const trackIndex = h.tracks.findIndex((track) => track.__handle__ === id);
      if (trackIndex >= 0) {
        if (method === "getName") return trackIndex === 0 ? "Vocal" : "Backing";
        if (method === "getNumGroups") return trackIndex === 0 ? 2 : 1;
        if (method === "getMixer") return h.mixers[trackIndex];
        if (method === "getGroupReference") {
          return trackIndex === 0 ? h.refs[args[0] - 1] : h.refs[2];
        }
      }
      const mixerIndex = h.mixers.findIndex((mixer) => mixer.__handle__ === id);
      if (mixerIndex >= 0) {
        if (method === "getGainDecibel") return mixerIndex === 0 ? 0 : -6;
        if (method === "getPan") return 0;
        if (method === "isMuted") return false;
        if (method === "isSolo") return mixerIndex === 0;
        if (method === "getFxParams") {
          return { ...structuredClone(FX_PARAMS), ignoredHostField: "not projected" };
        }
      }
      if (id === h.refs[0].__handle__) {
        // 官方语义：getOnset = timeOffset + 首音符组内 onset（此处首音符 onset 为 0）。
        if (method === "getOnset") return group0Onset;
        if (method === "getEnd") return group0Onset + 9 * BAR_4_4;
        if (method === "isInstrumental") return false;
        if (method === "isMain") return true;
        if (method === "getTimeOffset") return group0Onset;
        if (method === "getPitchOffset") return 0;
        if (method === "getTarget") return h.groups[0];
        if (method === "getVoice") return { paramTension: 0.2 };
      }
      if (id === h.refs[1].__handle__) {
        if (model.secondReferenceInRange) {
          if (method === "getOnset") return 2 * BAR_4_4;
          if (method === "getEnd") return 4 * BAR_4_4;
          if (method === "getTarget") return h.groups[0];
          if (method === "isInstrumental") return false;
          if (method === "isMain") return false;
          if (method === "getTimeOffset") return 2 * BAR_4_4;
          if (method === "getPitchOffset") return 0;
          if (method === "getVoice") return { paramTension: 0.2 };
        }
        // 完全在范围之后的 group：除 onset/end 外不应被访问。
        if (method === "getOnset") return 40 * BAR_4_4;
        if (method === "getEnd") return 44 * BAR_4_4;
        if (method === "getTarget") {
          model.fetchedNotesOfOutOfRangeGroup = true;
          return h.groups[1];
        }
        if (method === "isInstrumental") return false;
        if (method === "isMain") return false;
        if (method === "getTimeOffset") return 40 * BAR_4_4;
        if (method === "getPitchOffset") return 0;
      }
      if (id === h.refs[2].__handle__) {
        if (method === "getOnset") return 0;
        if (method === "getEnd") return 20 * BAR_4_4;
        if (method === "isInstrumental") return true;
        if (method === "isMain") return false;
        if (method === "getTimeOffset" || method === "getPitchOffset") return 0;
      }
      if (id === h.groups[0].__handle__) {
        if (method === "getName") return "Verse";
        if (method === "getUUID") return "uuid-verse";
        if (method === "getNumNotes") return noteState.length;
        if (method === "getScale") return { root: "F#", type: "Major" };
        if (method === "getNote") return h.notes[args[0] - 1];
        if (method === "getParameter") return h.automations[args[0]];
      }
      const automationName = Object.entries(h.automations).find(
        ([, automation]) => automation.__handle__ === id
      )?.[0];
      if (automationName) {
        if (method === "getType") return automationName;
        if (method === "getDefinition") {
          return { typeName: automationName, range: [-1, 1], defaultValue: 0 };
        }
        if (method === "getInterpolationMethod") return "Linear";
        if (method === "getAllPoints") {
          return automationName === "tension"
            ? [
                [0, 0.1],
                [Q, 0.2],
              ]
            : [];
        }
      }
      const noteIndex = h.notes.findIndex((note) => note.__handle__ === id);
      if (noteIndex >= 0) {
        const state = noteState[noteIndex];
        const getters = {
          getOnset: state.onset,
          getDuration: state.duration,
          getPitch: state.pitch,
          getLyrics: state.lyrics,
          getPhonemes: "",
          getLanguageOverride: "",
          getDetune: 0,
          getIndexInParent: noteIndex + 1,
          getAttributes: { rapAccent: noteIndex / 10 },
        };
        if (Object.hasOwn(getters, method)) return getters[method];
      }
      throw new Error(`unsupported range call ${id}.${method}`);
    },
  };
  return model;
}

function createService(model, options = {}) {
  return new RangeSnapshotService(
    { withExclusive: (task) => task(model.host) },
    { now: () => 1000, ...options }
  );
}

test("range detail seals a self-contained hash-bound artifact with dense Automation points", async () => {
  const model = createRangeModel();
  const artifactStore = new ArtifactStore({ now: () => 1000 });
  const service = createService(model, { artifactStore, sessionId: "sess_range" });
  const result = await service.snapshot({
    scope: { kind: "range", from: { bar: 1 }, to: { bar: 20 } },
    include: ["notes", "tempoMap", "meterMap", "automation"],
    automationParameters: ["tension"],
  });

  assert.ok(result.artifactRef, JSON.stringify(result.warnings));
  assert.match(result.artifactRef.resourceUri, /svcopilot:\/\/artifacts\/a_.+\/sha256_/);
  assert.equal(result.page.detailCursor === result.artifactRef, false);
  assert.equal(result.warnings.some((warning) => warning.code === "ARTIFACT_SEAL_FAILED"), false);
  const artifact = artifactStore.resolve({
    artifactId: result.artifactRef.artifactId,
    expectedContentHash: result.artifactRef.contentHash,
    sessionId: "sess_range",
  });
  const densePoints = artifact.payload.data.automation[0].points;
  assert.equal(densePoints.encoding, "dense-table-v1");
  const decoded = decodeDense(densePoints);
  assert.equal(decoded.length, 2);
  assert.deepEqual(
    decoded.map((point) => point.localBlick),
    [0, Q]
  );
  const denseNotes = artifact.payload.data.notes;
  assert.equal(artifact.payload.data.noteEncoding, "dense-table-v1");
  assert.equal(denseNotes.encoding, "dense-table-v1");
  const decodedNotes = decodeDense(denseNotes);
  assert.equal(decodedNotes.length, result.data.notes.length);
  assert.equal(decodedNotes[0].lyrics, result.data.notes[0].lyrics);
  assert.equal(decodedNotes[0]["musical.bar"], result.data.notes[0].musical.bar);
  assert.equal(decodedNotes[0].restBeforeBlick, result.data.notes[0].restBeforeBlick);
  assert.equal(artifact.payload.context.noteIdentitySource, "data.notes");
  assert.equal(
    Object.hasOwn(artifact.payload.context.occurrences[0], "noteFingerprints"),
    false,
    "range detail must not repeat fingerprints already encoded in dense notes"
  );
});

test("range snapshot converts 1-based bar/beat to blick and back across meter changes", async () => {
  const model = createRangeModel();
  const service = createService(model);
  const result = await service.snapshot({
    scope: { kind: "range", from: { bar: 1 }, to: { bar: 20 } },
    include: ["notes", "tempoMap", "meterMap"],
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.barBase, 1);
  assert.equal(result.data.beatBase, 1);
  assert.equal(result.data.range.from.blick, 0);
  assert.equal(result.data.timebase.quarterBlick, Q);
  // bar 20 = 8 小节 4/4 + 11 小节 3/4。
  assert.equal(result.data.range.to.blick, 8 * BAR_4_4 + 11 * 3 * Q);
  assert.deepEqual(result.data.meterMap, [
    { bar: 1, positionBlick: 0, numerator: 4, denominator: 4 },
    { bar: 9, positionBlick: 8 * BAR_4_4, numerator: 3, denominator: 4 },
  ]);
  assert.equal(result.data.tempoMap[0].bpm, 120);

  const notes = result.data.notes;
  assert.equal(notes.length, 4);
  // note0 绝对位置 = bar 2 beat 1（组 onset 在 bar 2）。
  assert.deepEqual(
    notes.map((note) => [note.musical.bar, note.musical.beat]),
    [
      [2, 1],
      [2, 2],
      [2, 4],
      // 组 onset(1 bar) + 8 bars = 绝对第 9 小节边界，即 3/4 段第 1 小节后 1 bar → bar 10 beat 1。
      [10, 2],
    ]
  );
  assert.equal(notes[3].musical.numerator, 3);
  assert.equal(notes[0].absoluteOnsetBlick, BAR_4_4);
});

test("range snapshot reports rests, neighbor lyrics, and group uuid per note", async () => {
  const model = createRangeModel();
  const service = createService(model);
  const result = await service.snapshot({
    scope: { kind: "range", from: { bar: 1 }, to: { bar: 30 } },
  });
  const notes = result.data.notes;
  assert.deepEqual(
    notes.map((note) => [note.restBeforeBlick, note.prevLyrics, note.nextLyrics]),
    [
      [null, null, "re"],
      [0, "do", "mi"],
      [Q, "re", "fa"],
      [8 * BAR_4_4 - 4 * Q, "mi", null],
    ]
  );
  assert.ok(notes.every((note) => note.groupUuid === "uuid-verse"));
  assert.ok(notes.every((note) => note.absoluteEndBlick === note.absoluteOnsetBlick + note.durationBlick));
});

test("range snapshot includes a sustained note that starts before the range", async () => {
  const model = createRangeModel();
  model.noteState[0].duration = 2 * Q;
  const service = createService(model);
  const result = await service.snapshot({
    scope: {
      kind: "range",
      trackIndices: [0],
      from: { bar: 2, beat: 2 },
      to: { bar: 2, beat: 3 },
    },
    include: ["notes"],
  });

  assert.ok(result.data.notes.some((note) => note.indexInGroup === 0));
  assert.equal(result.data.notes.find((note) => note.indexInGroup === 0).absoluteOnsetBlick, BAR_4_4);
});

test("range snapshot filters by range, skips out-of-range groups, and honors trackIndices", async () => {
  const model = createRangeModel();
  const service = createService(model);
  const result = await service.snapshot({
    scope: { kind: "range", trackIndices: [0], from: { bar: 2 }, to: { bar: 2, beat: 3 } },
  });

  // 只有 do(bar2 beat1) 和 re(bar2 beat2) 落在 [bar2 beat1, bar2 beat3)。
  assert.deepEqual(result.data.notes.map((note) => note.lyrics), ["do", "re"]);
  assert.equal(result.data.tracks.length, 1);
  assert.equal(model.fetchedNotesOfOutOfRangeGroup, false);
  assert.equal(result.data.tracks[0].groups.length, 1);
  assert.deepEqual(result.data.tracks[0].groups[0].hostDeclaredScale, {
    status: "observed",
    root: "F#",
    type: "Major",
  });
});

test("range snapshot includes mixer state and reports unsupported includes", async () => {
  const model = createRangeModel();
  const service = createService(model);
  const result = await service.snapshot({
    scope: { kind: "range", from: { bar: 1 }, to: { bar: 3 } },
    include: ["notes", "mixer", "automation", "retakes"],
  });

  assert.deepEqual(result.data.tracks[0].mixer, {
    gainDecibel: 0,
    pan: 0,
    muted: false,
    solo: true,
    fxParameters: { status: "observed", ...FX_PARAMS },
  });
  const codes = result.warnings.filter((warning) => warning.code === "UNSUPPORTED_INCLUDE");
  assert.equal(codes.length, 1);
  assert.equal(result.data.automation.length, 4);
  assert.equal(
    result.data.automation.find((curve) => curve.resolvedParameter === "tension").points.length,
    2
  );
  // instrumental track 也报告 mixer，但没有 notes。
  assert.deepEqual(result.data.tracks[1].mixer, {
    gainDecibel: -6,
    pan: 0,
    muted: false,
    solo: false,
    fxParameters: { status: "observed", ...FX_PARAMS },
  });
  assert.ok(result.data.tracks[1].groups[0].instrumental);
});

test("optional scale and FX getters degrade on hosts that do not expose them", async () => {
  const model = createRangeModel();
  const originalCall = model.host.call;
  model.host.call = async (request) => {
    if (request.method === "getScale" || request.method === "getFxParams") {
      const error = new Error(`no such method: ${request.method}`);
      error.code = "UNKNOWN_METHOD";
      throw error;
    }
    return originalCall(request);
  };
  const result = await createService(model).snapshot({
    scope: { kind: "range", from: { bar: 1 }, to: { bar: 3 } },
    include: ["notes", "mixer"],
  });
  assert.deepEqual(result.data.tracks[0].groups[0].hostDeclaredScale, {
    status: "unavailable",
  });
  assert.deepEqual(result.data.tracks[0].mixer.fxParameters, {
    status: "unavailable",
  });
});

// 通信故障绝不能退化成「宿主没有这个能力」：unavailable 会被封存进 range artifact，
// 一次超时就会在证据里留下一条与老宿主无法区分的假结论。
//
// UNSUPPORTED_HOST_CAPABILITY 也在这里而不在 unavailable 一侧：这两个 getter 走核心
// call opcode，该 code 只可能来自 bulk 的 supportsOp 门禁或桥的 `unknown op`，
// 意味着协议层不兼容，而不是某个方法缺失。
for (const { code, message, label } of [
  { code: "HOST_TIMEOUT", message: "timeout waiting for host", label: "a host timeout" },
  { code: "HOST_DETACHED", message: "host detached", label: "a bridge disconnect" },
  { code: "HOST_CALL_FAILED", message: "host call failed", label: "an unclassified host failure" },
  {
    code: "UNSUPPORTED_HOST_CAPABILITY",
    message: "the connected SynthV bridge does not advertise call",
    label: "a bridge protocol incompatibility",
  },
]) {
  test(`${label} during getScale fails the capture instead of reporting unavailable`, async () => {
    const model = createRangeModel();
    const originalCall = model.host.call;
    model.host.call = async (request) => {
      if (request.method === "getScale") {
        const error = new Error(message);
        error.code = code;
        throw error;
      }
      return originalCall(request);
    };
    await assert.rejects(
      () =>
        createService(model).snapshot({
          scope: { kind: "range", from: { bar: 1 }, to: { bar: 3 } },
          include: ["notes"],
        }),
      (error) => error.code === code
    );
  });

  test(`${label} during getFxParams fails the capture instead of reporting unavailable`, async () => {
    const model = createRangeModel();
    const originalCall = model.host.call;
    model.host.call = async (request) => {
      if (request.method === "getFxParams") {
        const error = new Error(message);
        error.code = code;
        throw error;
      }
      return originalCall(request);
    };
    await assert.rejects(
      () =>
        createService(model).snapshot({
          scope: { kind: "range", from: { bar: 1 }, to: { bar: 3 } },
          include: ["notes", "mixer"],
        }),
      (error) => error.code === code
    );
  });
}

test("invalid optional scale and FX data is isolated with stable warnings", async () => {
  const model = createRangeModel();
  const originalCall = model.host.call;
  model.host.call = async (request) => {
    if (request.method === "getScale") return { root: 60, type: "Major" };
    if (request.method === "getFxParams") return { compressor: {} };
    return originalCall(request);
  };
  const result = await createService(model).snapshot({
    scope: { kind: "range", from: { bar: 1 }, to: { bar: 3 } },
    include: ["notes", "mixer"],
  });
  assert.deepEqual(result.data.tracks[0].groups[0].hostDeclaredScale, {
    status: "invalid",
  });
  assert.deepEqual(result.data.tracks[0].mixer.fxParameters, {
    status: "invalid",
  });
  const warningCodes = new Set(result.warnings.map((warning) => warning.code));
  assert.ok(warningCodes.has("HOST_DECLARED_SCALE_INVALID"));
  assert.ok(warningCodes.has("HOST_FX_PARAMETERS_INVALID"));
});

test("range snapshot token is stable and sinceToken returns no_change", async () => {
  const model = createRangeModel();
  const service = createService(model);
  const request = { scope: { kind: "range", from: { bar: 1 }, to: { bar: 4 } } };
  const first = await service.snapshot(request);
  const hostCallsAfterFirst = model.hostCalls.length;
  const second = await service.snapshot({ ...request, sinceToken: first.snapshotToken });
  const hostCallsAfterRefresh = model.hostCalls.length;

  assert.equal(second.status, "no_change");
  // no_change 不再返回 data:null（§10.2.1 折叠需要 data 是对象）；status 已说明这件事。
  assert.equal(second.status, "no_change");
  assert.equal(second.snapshotToken, first.snapshotToken);
  assert.notEqual(second.contextId, first.contextId);
  assert.match(second.contextExpiresAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(second.page.detailCursor);
  const identityPage = await service.snapshot({ cursor: second.page.detailCursor });
  assert.equal(identityPage.contextId, second.contextId);
  assert.ok(identityPage.data.notes.every((note) => Number.isSafeInteger(note.id)));
  assert.ok(hostCallsAfterRefresh > hostCallsAfterFirst);
  assert.equal(model.hostCalls.length, hostCallsAfterRefresh);

  const different = await service.snapshot({
    scope: { kind: "range", from: { bar: 1 }, to: { bar: 5 } },
    sinceToken: first.snapshotToken,
  });
  assert.equal(different.status, "succeeded");
  assert.equal(different.changedSinceToken, true);
});

test("range snapshot rejects unknown fields at every request level", async () => {
  const model = createRangeModel();
  const service = createService(model);
  const baseScope = { kind: "range", from: { bar: 1 }, to: { bar: 2 } };
  for (const request of [
    { scope: baseScope, responseMod: "compact" },
    { scope: baseScope, definitelyUnknownOption: true },
    { scope: { ...baseScope, trackIndice: [0] } },
    {
      scope: {
        ...baseScope,
        from: { bar: 1, beat: { numerator: 1, denominator: 2, typo: true } },
      },
    },
    { scope: baseScope, computedPitchSampling: { frames: 4, framez: 4 } },
    { scope: baseScope, budgets: { notes: 1, notez: 1 } },
  ]) {
    await assert.rejects(
      service.snapshot(request),
      (error) => error.code === "INVALID_ARGUMENTS" && /unknown field/.test(error.message)
    );
  }
  assert.equal(model.hostCalls.length, 0);
});

test("range snapshot rejects mixed cursor and host-read arguments", async () => {
  const model = createRangeModel();
  const service = createService(model);
  const first = await service.snapshot({
    scope: { kind: "range", from: { bar: 1 }, to: { bar: 2 } },
  });
  // cursor 读取只翻已捕获的数据，因此不接受任何会触发宿主读取的字段。
  const cursor = service.store.get(first.contextId).storeCursor;
  assert.ok(typeof cursor === "string" && cursor.length > 0);
  await assert.rejects(
    service.snapshot({ cursor, sinceToken: "snap_x" }),
    (error) => error.code === "INVALID_ARGUMENTS" && /cursor reads/.test(error.message)
  );
});

test("range snapshot validates scope and track indices", async () => {
  const model = createRangeModel();
  const service = createService(model);
  await assert.rejects(
    service.snapshot({ scope: { kind: "range", from: { bar: 3 }, to: { bar: 3 } } }),
    (error) => error.code === "INVALID_RANGE"
  );
  await assert.rejects(
    service.snapshot({ scope: { kind: "range", from: { bar: 0 }, to: { bar: 2 } } }),
    (error) => error.code === "INVALID_SCOPE"
  );
  await assert.rejects(
    service.snapshot({
      scope: { kind: "range", trackIndices: [5], from: { bar: 1 }, to: { bar: 2 } },
    }),
    (error) => error.code === "TRACK_INDEX_OUT_OF_RANGE"
  );
  await assert.rejects(
    service.snapshot({
      scope: { kind: "range", from: { bar: 1 }, to: { bar: 2 } },
      include: ["bogus"],
    }),
    (error) => error.code === "INVALID_ARGUMENTS"
  );
});

test("range snapshot returns one editable context with all tuning includes", async () => {
  const model = createRangeModel();
  const service = createService(model);
  const result = await service.snapshot({
    scope: { kind: "range", trackIndices: [0], from: { bar: 1 }, to: { bar: 12 } },
    include: [
      "notes",
      "voiceParameters",
      "automation",
      "computedPitch",
      "attributes",
      "processing",
    ],
    automationParameters: ["tension"],
    computedPitchSampling: { frames: 4 },
    budgets: { bytes: RANGE_PAGE_LIMITS.maximums.bytes },
  });

  // 96-bit Base64URL 短 ID，不再是 UUID 文本。
  assert.match(result.contextId, /^c_[A-Za-z0-9_-]{16}$/);
  assert.equal(result.data.notes.length, 4);
  assert.equal(result.data.attributes.length, 4);
  assert.equal(result.data.automation.length, 1);
  assert.deepEqual(result.data.automation[0].points[0].musical, {
    bar: 2,
    beat: 1,
    tickInBeatBlick: 0,
    numerator: 4,
    denominator: 4,
  });
  assert.equal(result.data.computedPitch.length, 1);
  assert.equal(result.data.computedPitch[0].values.length, 4);
  assert.equal(result.data.tracks[0].groups[0].processing.state, "ready");
  assert.deepEqual(result.data.tracks[0].groups[0].processing.phonemes, [
    "d ow",
    "r ey",
    "m iy",
    "f aa",
  ]);
  // 身份是组内 index（§3.1）：note.id 与 indexInGroup 是同一个值。
  assert.ok(result.data.notes.every((note) => note.id === note.indexInGroup));
  const stored = service.store.get(result.contextId);
  assert.equal(stored.context.kind, "range");
  assert.equal(stored.context.occurrences[0].targetGroupUuid, "uuid-verse");
  assert.equal(stored.context.occurrences[0].noteFingerprints.length, 4);
  assert.ok(Number.isFinite(result.timings.hostReadMs));
});

test("range snapshot budgets page captured data without repeating host reads", async () => {
  const model = createRangeModel();
  const service = createService(model);
  const first = await service.snapshot({
    scope: { kind: "range", trackIndices: [0], from: { bar: 1 }, to: { bar: 12 } },
    include: ["notes", "automation", "computedPitch", "attributes"],
    automationParameters: ["tension"],
    computedPitchSampling: { frames: 4 },
    budgets: { notes: 1, attributes: 1, automationPoints: 1, computedPitchFrames: 1 },
  });
  assert.equal(first.page.complete, false);
  assert.equal(first.page.returned.notes, 1);
  assert.equal(first.page.returned.automationPoints, 1);
  const hostCallCount = model.hostCalls.length;

  const second = await service.snapshot({ cursor: first.page.nextCursor });
  assert.equal(second.page.index, 1);
  assert.equal(model.hostCalls.length, hostCallCount);
  assert.equal(second.contextId, first.contextId);
  assert.equal(second.snapshotToken, first.snapshotToken);
});

test("range snapshot samples computed pitch with absolute BLICK for offset occurrences", async () => {
  const model = createRangeModel();
  const service = createService(model);
  const result = await service.snapshot({
    scope: {
      kind: "range",
      trackIndices: [0],
      from: { bar: 2 },
      to: { bar: 4 },
    },
    include: ["computedPitch"],
    computedPitchSampling: { frames: 4 },
  });

  assert.equal(model.computedPitchCalls.length, 1);
  const [, startBlick, intervalBlick, frames] = model.computedPitchCalls[0];
  assert.equal(startBlick, BAR_4_4);
  assert.equal(intervalBlick, BAR_4_4 / 2);
  assert.equal(frames, 4);
  assert.equal(result.data.computedPitch[0].startBlick, BAR_4_4);
});

test("range snapshot enforces global Automation and computed-pitch capture limits", async () => {
  const automationModel = createRangeModel();
  const automationService = createService(automationModel, {
    captureLimits: { automationPoints: 1, computedPitchFrames: 20_000 },
  });
  await assert.rejects(
    automationService.snapshot({
      scope: { kind: "range", trackIndices: [0], from: { bar: 1 }, to: { bar: 3 } },
      include: ["automation"],
      automationParameters: ["tension"],
    }),
    (error) => error.code === "SNAPSHOT_AUTOMATION_LIMIT_REACHED"
  );

  const pitchModel = createRangeModel();
  const pitchService = createService(pitchModel, {
    captureLimits: { automationPoints: 20_000, computedPitchFrames: 1 },
  });
  await assert.rejects(
    pitchService.snapshot({
      scope: { kind: "range", trackIndices: [0], from: { bar: 1 }, to: { bar: 3 } },
      include: ["computedPitch"],
      computedPitchSampling: { frames: 2 },
    }),
    (error) => error.code === "SNAPSHOT_COMPUTED_PITCH_CAPTURE_LIMIT_REACHED"
  );
});

test("range snapshot returns captured items inline and pages by byte budget", async () => {
  assert.equal(RANGE_PAGE_LIMITS.defaults.bytes, 8 * 1024);
  const model = createRangeModel();
  const service = createService(model);
  // responseMode 已删除（§10.6 规则 14）：不再有「摘要档」与「明细档」之分。
  // range 读取的唯一形状就是按预算分页的逐项数据——它的体积上界由 budgets 保证，
  // 而不是由调用方先猜一个档位。cursor 分页本身属于 C2，不在本轮变更范围内。
  const result = await service.snapshot({
    scope: { kind: "range", trackIndices: [0], from: { bar: 1 }, to: { bar: 12 } },
    include: ["notes", "automation"],
    automationParameters: ["tension"],
  });
  assert.equal(result.data.notes.length, 4);
  assert.equal(result.data.automation[0].points.length, 2);
  assert.equal(result.data.summaries, undefined);
  assert.equal(result.page.complete, true);
  assert.equal(result.data.snapshotComplete, true);
});

test("range snapshot accepts exact decimal and rational beats", async () => {
  const model = createRangeModel();
  const service = createService(model);
  const decimal = await service.snapshot({
    scope: { kind: "range", trackIndices: [0], from: { bar: 2, beat: 1.5 }, to: { bar: 2, beat: 3 } },
  });
  assert.equal(decimal.data.range.from.blick, BAR_4_4 + Q / 2);
  const rational = await service.snapshot({
    scope: {
      kind: "range",
      trackIndices: [0],
      from: { bar: 2, beat: { numerator: 3, denominator: 2 } },
      to: { bar: 2, beat: 3 },
    },
  });
  assert.equal(rational.data.range.from.blick, decimal.data.range.from.blick);
});

test("range occurrence identity distinguishes references to one shared target", async () => {
  const model = createRangeModel();
  model.secondReferenceInRange = true;
  const result = await createService(model).snapshot({
    scope: { kind: "range", trackIndices: [0], from: { bar: 1 }, to: { bar: 6 } },
    include: ["notes"],
  });
  const groups = result.data.tracks[0].groups;
  assert.equal(groups.length, 2);
  // ordinal 由服务端按完整 occurrences 数组分配，消费方不必自己 indexOf——
  // 各自推导会在数组被过滤后给出不同编号（§3.1 规则 1）。
  assert.deepEqual(
    groups.map((group) => group.occurrence),
    [0, 1]
  );
  assert.deepEqual(groups[0].sharedTargetOccurrences, [
    groups[0].occurrence,
    groups[1].occurrence,
  ]);
});

test("musicalToBlick reaches fractional positions inside the last beat of a measure", () => {
  const marks = [{ position: 0, positionBlick: 0, numerator: 4, denominator: 4 }];
  // 4/4 的 beat 4.5（"第 4 拍的后半"——切分/上勾/句末表现最常用的锚点）此前因
  // off-by-one 完全不可达，且没有任何等价写法。
  const half = musicalToBlick(normalizeMusicalPoint({ bar: 1, beat: 4.5 }), marks, Q);
  assert.equal(half, 3.5 * Q);
  assert.equal(
    musicalToBlick(normalizeMusicalPoint({ bar: 1, beat: 4.75 }), marks, Q),
    3.75 * Q
  );
  assert.equal(
    musicalToBlick(normalizeMusicalPoint({ bar: 2, beat: 4.25 }), marks, Q),
    (4 + 3.25) * Q
  );

  // 往返：blick → musical 落回第 4 拍 + 半拍余量，两侧对"最后一拍"的可达性对称。
  const round = blickToMusical(half, marks, Q);
  assert.equal(round.bar, 1);
  assert.equal(round.beat, 4);
  assert.equal(round.tickInBeatBlick, Q / 2);

  // 3/4 的 3.5 同样可达；6/8 的 6.5 也是。
  const waltz = [{ position: 0, positionBlick: 0, numerator: 3, denominator: 4 }];
  assert.equal(musicalToBlick(normalizeMusicalPoint({ bar: 1, beat: 3.5 }), waltz, Q), 2.5 * Q);
  const compound = [{ position: 0, positionBlick: 0, numerator: 6, denominator: 8 }];
  assert.equal(
    musicalToBlick(normalizeMusicalPoint({ bar: 1, beat: 6.5 }), compound, Q),
    5.5 * (Q / 2)
  );

  // 下一小节的 downbeat（beat N+1）与整数越界拍仍然拒绝。
  assert.throws(
    () => musicalToBlick(normalizeMusicalPoint({ bar: 1, beat: 5 }), marks, Q),
    (error) => error.code === "INVALID_MUSICAL_POSITION"
  );
  assert.throws(
    () => musicalToBlick(normalizeMusicalPoint({ bar: 1, beat: { numerator: 10, denominator: 2 } }), marks, Q),
    (error) => error.code === "INVALID_MUSICAL_POSITION"
  );
});

test("range snapshot stores computed pitch for sv_compare_computed_pitch", async () => {
  const model = createRangeModel();
  const service = createService(model);
  const snap = await service.snapshot({
    scope: { kind: "range", trackIndices: [0], from: { bar: 1 }, to: { bar: 12 } },
    include: ["notes", "computedPitch"],
    computedPitchSampling: { frames: 40 },
  });
  const stored = service.store.get(snap.contextId);
  const occurrence = stored.context.occurrences[0];
  // 供 compare 使用的上下文增量：pitchOffset、tempo map 与未分页 computed-pitch 序列。
  assert.equal(occurrence.pitchOffsetSemitone, 0);
  assert.ok(Array.isArray(stored.context.tempoMarks) && stored.context.tempoMarks.length > 0);
  const series = getStoredComputedPitch(stored, occurrence.occurrence);
  assert.equal(series.values.length, 40);
  assert.equal(series.evidence.observedFrames, 40);
  assert.equal(getStoredComputedPitch(stored, 9), null);

  // 端到端：真实 snapshot 存储 → compare 纯内存分析，全程零额外宿主访问。
  const hostCallsBeforeCompare = model.hostCalls.length;
  const compareService = new ComputedPitchCompareService({
    store: service.store,
    now: () => 2000,
  });
  const result = await compareService.compare({
    mode: "compare_to_target",
    contextId: snap.contextId,
  });
  assert.equal(result.ok, true);
  // 对外身份是 ordinal（§3.1）：请求里填什么，响应里就回什么。
  assert.equal(result.occurrence.occurrence, 0);
  assert.ok(result.summary.validFrameCount > 0);
  assert.ok(Number.isFinite(result.summary.maeCent));
  assert.equal(result.provenance.pitchSource, "computedPitch");
  assert.equal(model.hostCalls.length, hostCallsBeforeCompare);
});

test("range snapshot stores automation/voice/processing profiles for sv_style_profile", async () => {
  const model = createRangeModel();
  const service = createService(model);
  const snap = await service.snapshot({
    scope: { kind: "range", trackIndices: [0], from: { bar: 1 }, to: { bar: 12 } },
    include: ["notes", "automation", "voiceParameters", "processing"],
    automationParameters: ["tension"],
  });
  const stored = service.store.get(snap.contextId);
  const occurrence = stored.context.occurrences[0];
  // v0.7.0 基础层增补：occurrence 级 voice/processing 纯数据剖面 + 未分页 automation 曲线。
  assert.equal(occurrence.voiceParameters.paramTension, 0.2);
  assert.equal(occurrence.processing.state, "ready");
  assert.ok(occurrence.processing.phonemeCoverage);
  assert.equal(stored.context.automationCaptured, true);
  const curves = stored.context.automationByOccurrence[occurrence.occurrence];
  assert.equal(curves.length, 1);
  assert.equal(curves[0].resolvedParameter, "tension");
  assert.equal(curves[0].points.length, 2);

  // 端到端：真实 snapshot 存储 → style profile 纯内存聚合，零额外宿主访问。
  const hostCallsBefore = model.hostCalls.length;
  const profileService = new StyleProfileService({ store: service.store, now: () => 2000 });
  const result = await profileService.profile({
    targets: [{ contextId: snap.contextId, label: "verse" }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.targets[0].sections.parameters.status, "captured");
  assert.equal(result.targets[0].sections.parameters.curves[0].parameter, "tension");
  assert.equal(result.targets[0].sections.vocalModes.status, "captured");
  assert.equal(result.aggregate.byLabel.verse.noteCount, result.targets[0].noteCount);
  assert.equal(model.hostCalls.length, hostCallsBefore);
});
