import assert from "node:assert/strict";
import test from "node:test";

import { RangeSnapshotService } from "../server/src/musical-range.js";

const Q = 705600;
const BAR_4_4 = 4 * Q;

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
  const model = { hostCalls: [], fetchedNotesOfOutOfRangeGroup: false };
  model.host = {
    epoch: () => 1,
    roots: async () => ({ project: h.project, sv: h.sv, mainEditor: h.mainEditor }),
    free: async () => {},
    index: async () => null,
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
        if (method === "getNote") return h.notes[args[0] - 1];
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
        };
        if (Object.hasOwn(getters, method)) return getters[method];
      }
      throw new Error(`unsupported range call ${id}.${method}`);
    },
  };
  return model;
}

function createService(model) {
  return new RangeSnapshotService(
    { withExclusive: (task) => task(model.host) },
    { now: () => 1000 }
  );
}

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
  });
  const codes = result.warnings.filter((warning) => warning.code === "UNSUPPORTED_INCLUDE");
  assert.equal(codes.length, 2);
  // instrumental track 也报告 mixer，但没有 notes。
  assert.deepEqual(result.data.tracks[1].mixer, {
    gainDecibel: -6,
    pan: 0,
    muted: false,
    solo: false,
  });
  assert.ok(result.data.tracks[1].groups[0].instrumental);
});

test("range snapshot token is stable and sinceToken returns no_change", async () => {
  const model = createRangeModel();
  const service = createService(model);
  const request = { scope: { kind: "range", from: { bar: 1 }, to: { bar: 4 } } };
  const first = await service.snapshot(request);
  const second = await service.snapshot({ ...request, sinceToken: first.snapshotToken });

  assert.equal(second.status, "no_change");
  assert.equal(second.data, null);
  assert.equal(second.snapshotToken, first.snapshotToken);

  const different = await service.snapshot({
    scope: { kind: "range", from: { bar: 1 }, to: { bar: 5 } },
    sinceToken: first.snapshotToken,
  });
  assert.equal(different.status, "succeeded");
  assert.equal(different.changedSinceToken, true);
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
