import assert from "node:assert/strict";
import test from "node:test";

import { NoteStructureService } from "../server/src/note-structure.js";
import { SnapshotService, SnapshotStore } from "../server/src/snapshot.js";

const Q = 705600;

// 可变 group 模型：notes 数组按 onset 排序，addNote/removeNote/clone/SV.create 全部可用，
// getIndexInParent 返回执行时的活动 index。
function createStructureModel() {
  let nextHandle = 400;
  const handle = (type) => ({ __handle__: nextHandle++, __type__: type, __epoch__: 1 });
  const h = {
    project: handle("Project"),
    sv: handle("SV"),
    mainEditor: handle("MainEditorView"),
    track: handle("Track"),
    groupReference: handle("NoteGroupReference"),
    group: handle("NoteGroup"),
    selection: handle("TrackInnerSelectionState"),
  };
  const model = {
    handles: h,
    states: new Map(), // handleId -> note state
    groupNotes: [], // handleId[]，按 onset 排序
    undoCount: 0,
    failures: [],
  };
  const makeNote = (state) => {
    const noteHandle = handle("Note");
    model.states.set(noteHandle.__handle__, { ...state });
    return noteHandle;
  };
  const sortGroup = () => {
    model.groupNotes.sort(
      (a, b) => model.states.get(a).onset - model.states.get(b).onset
    );
  };
  for (const state of [
    { onset: 0, duration: Q, pitch: 60, lyrics: "a", phonemes: "", language: "", detune: 0 },
    { onset: Q, duration: Q, pitch: 62, lyrics: "i", phonemes: "", language: "", detune: 0 },
    { onset: 2 * Q, duration: Q, pitch: 64, lyrics: "u", phonemes: "", language: "", detune: 0 },
  ]) {
    model.groupNotes.push(makeNote(state).__handle__);
  }
  const noteHandleById = (id) => ({ __handle__: id, __type__: "Note", __epoch__: 1 });

  model.host = {
    epoch: () => 1,
    roots: async () => ({ project: h.project, sv: h.sv, mainEditor: h.mainEditor }),
    free: async () => {},
    index: async () => null,
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
      if (target === undefined || target === null) {
        if (method === "create" && args[0] === "Note") {
          return makeNote({ onset: 0, duration: Q, pitch: 60, lyrics: "la", phonemes: "", language: "", detune: 0 });
        }
      }
      if (id === h.project.__handle__) {
        if (method === "newUndoRecord") return ++model.undoCount;
        if (method === "getTrack") return h.track;
        if (method === "getNumTracks") return 1;
      }
      if (id === h.mainEditor.__handle__) {
        if (method === "getCurrentTrack") return h.track;
        if (method === "getCurrentGroup") return h.groupReference;
        if (method === "getSelection") return h.selection;
      }
      if (id === h.selection.__handle__ && method === "getSelectedNotes") {
        return model.groupNotes.map(noteHandleById);
      }
      if (id === h.track.__handle__) {
        if (method === "getIndexInParent") return 1;
        if (method === "getName") return "Main";
        if (method === "getNumGroups") return 1;
        if (method === "getGroupReference") return h.groupReference;
      }
      if (id === h.groupReference.__handle__) {
        if (method === "getIndexInParent") return 1;
        if (method === "getTarget") return h.group;
        if (method === "isInstrumental") return false;
        if (method === "isMain") return true;
        if (method === "getOnset" || method === "getTimeOffset" || method === "getPitchOffset")
          return 0;
        if (method === "getVoice") return { paramTension: 0 };
      }
      if (id === h.group.__handle__) {
        if (method === "getName") return "Main Group";
        if (method === "getUUID") return "group-1";
        if (method === "getNumNotes") return model.groupNotes.length;
        if (method === "getNote") return noteHandleById(model.groupNotes[args[0] - 1]);
        if (method === "addNote") {
          const noteId = args[0].__handle__;
          if (!model.states.has(noteId)) throw new Error(`unknown note handle ${noteId}`);
          model.groupNotes.push(noteId);
          sortGroup();
          return model.groupNotes.indexOf(noteId) + 1;
        }
        if (method === "removeNote") {
          model.groupNotes.splice(args[0] - 1, 1);
          return null;
        }
      }
      if (id === h.sv.__handle__ && method === "getPhonemesForGroup") {
        return model.groupNotes.map((noteId) => {
          const lyrics = model.states.get(noteId).lyrics;
          return lyrics && lyrics !== "-" ? `${lyrics}-phoneme` : "";
        });
      }
      const state = model.states.get(id);
      if (state) {
        const getters = {
          getIndexInParent: model.groupNotes.indexOf(id) + 1,
          getOnset: state.onset,
          getDuration: state.duration,
          getPitch: state.pitch,
          getLyrics: state.lyrics,
          getPhonemes: state.phonemes,
          getLanguageOverride: state.language,
          getDetune: state.detune,
        };
        if (Object.hasOwn(getters, method)) return getters[method];
        if (method === "clone") return makeNote(state);
        if (method === "setLyrics") state.lyrics = args[0];
        else if (method === "setPhonemes") state.phonemes = args[0];
        else if (method === "setLanguageOverride") state.language = args[0];
        else if (method === "setPitch") state.pitch = args[0];
        else if (method === "setOnset") state.onset = args[0];
        else if (method === "setDuration") state.duration = args[0];
        else if (method === "setTimeRange") {
          state.onset = args[0];
          state.duration = args[1];
        } else throw new Error(`unsupported note method ${method}`);
        sortGroup();
        return null;
      }
      throw new Error(`unsupported structure call ${id}.${method}`);
    },
  };
  model.groupLyrics = () =>
    model.groupNotes.map((id) => model.states.get(id).lyrics);
  return model;
}

async function createFixture() {
  const model = createStructureModel();
  const session = { withExclusive: (task) => task(model.host) };
  const snapshots = new SnapshotService(session, {
    store: new SnapshotStore({ now: () => 1000 }),
    now: () => 1000,
  });
  const service = new NoteStructureService(session, snapshots, {
    sleepFn: async () => {},
    now: () => 1000,
  });
  const snapshot = await snapshots.snapshot({ scope: { kind: "selection" } });
  return { model, snapshots, service, snapshot };
}

const nid = (snapshot, index) => `${snapshot.contextId}:n:${index}`;

test("sv_restructure_notes dryRun plans without side effects", async () => {
  const { model, service, snapshot } = await createFixture();
  const result = await service.restructureNotes({
    contextId: snapshot.contextId,
    dryRun: true,
    operations: [
      { op: "insert", note: { onsetBlick: 3 * Q, durationBlick: Q, pitch: 65, lyrics: "e" } },
      { op: "delete", noteId: nid(snapshot, 0) },
    ],
  });
  assert.equal(result.status, "dry_run");
  assert.equal(result.data.initialNoteCount, 3);
  assert.equal(result.data.expectedNoteCount, 3);
  assert.equal(model.undoCount, 0);
  assert.equal(model.groupNotes.length, 3);
});

test("sv_restructure_notes inserts a note at the sorted position", async () => {
  const { model, service, snapshot } = await createFixture();
  const result = await service.restructureNotes({
    contextId: snapshot.contextId,
    waitFor: "none",
    operations: [
      { op: "insert", note: { onsetBlick: Q + Q / 2, durationBlick: Q / 2, pitch: 63, lyrics: "ya" } },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "succeeded");
  assert.equal(result.effects, "verified");
  assert.equal(result.data.finalNoteCount, 4);
  assert.deepEqual(model.groupLyrics(), ["a", "i", "ya", "u"]);
  assert.equal(result.data.appliedOperations[0].indexInGroup, 2);
  assert.equal(model.undoCount, 2);
});

test("sv_restructure_notes delete honors expected preconditions", async () => {
  const { model, service, snapshot } = await createFixture();
  const mismatch = await service.restructureNotes({
    contextId: snapshot.contextId,
    operations: [{ op: "delete", noteId: nid(snapshot, 1), expected: { lyrics: "wrong" } }],
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.error.code, "EXPECTED_MISMATCH");
  assert.equal(model.groupNotes.length, 3);

  const result = await service.restructureNotes({
    contextId: snapshot.contextId,
    waitFor: "none",
    operations: [{ op: "delete", noteId: nid(snapshot, 1), expected: { lyrics: "i" } }],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(model.groupLyrics(), ["a", "u"]);
});

test("sv_restructure_notes splits a note with an extender second half", async () => {
  const { model, service, snapshot } = await createFixture();
  const result = await service.restructureNotes({
    contextId: snapshot.contextId,
    waitFor: "none",
    operations: [{ op: "split", noteId: nid(snapshot, 0), atBlick: Q / 4 }],
  });
  assert.equal(result.ok, true);
  assert.equal(model.groupNotes.length, 4);
  const [first, second] = model.groupNotes.map((id) => model.states.get(id));
  assert.equal(first.duration, Q / 4);
  assert.equal(second.onset, Q / 4);
  assert.equal(second.duration, (3 * Q) / 4);
  assert.equal(second.lyrics, "-");
  assert.equal(second.pitch, first.pitch);
});

test("sv_restructure_notes merges consecutive notes and can concat lyrics", async () => {
  const { model, service, snapshot } = await createFixture();
  const result = await service.restructureNotes({
    contextId: snapshot.contextId,
    waitFor: "none",
    operations: [
      { op: "merge", noteIds: [nid(snapshot, 0), nid(snapshot, 1)], lyricsJoin: "concat" },
    ],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(model.groupLyrics(), ["ai", "u"]);
  const merged = model.states.get(model.groupNotes[0]);
  assert.equal(merged.duration, 2 * Q);
});

test("sv_restructure_notes rejects non-consecutive merges before writing", async () => {
  const { model, service, snapshot } = await createFixture();
  const result = await service.restructureNotes({
    contextId: snapshot.contextId,
    operations: [{ op: "merge", noteIds: [nid(snapshot, 0), nid(snapshot, 2)] }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "INVALID_ARGUMENTS");
  assert.equal(model.undoCount, 0);
  assert.equal(model.groupNotes.length, 3);
});

test("sv_restructure_notes atomic mode restores structure on mid-apply failure", async () => {
  const { model, service, snapshot } = await createFixture();
  // 第一个 addNote（insert）成功；第二个 addNote（split 的第二个音符）失败。
  model.failures.push({ method: "addNote", remainingSkips: 1, code: "ARGUMENT_MISMATCH" });
  const result = await service.restructureNotes({
    contextId: snapshot.contextId,
    operations: [
      { op: "insert", note: { onsetBlick: 5 * Q, durationBlick: Q, pitch: 65, lyrics: "e" } },
      { op: "delete", noteId: nid(snapshot, 1) },
      { op: "split", noteId: nid(snapshot, 2), atBlick: 2 * Q + Q / 2 },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "rolled_back");
  assert.equal(result.rollback.verified, true);
  assert.equal(result.effects, "reverted");
  assert.equal(model.groupNotes.length, 3);
  assert.deepEqual(model.groupLyrics(), ["a", "i", "u"]);
  // split 原音符的时长被恢复。
  assert.equal(model.states.get(model.groupNotes[2]).duration, Q);
});

test("sv_restructure_notes invalidates the context after a successful write", async () => {
  const { snapshots, service, snapshot } = await createFixture();
  const result = await service.restructureNotes({
    contextId: snapshot.contextId,
    waitFor: "none",
    operations: [{ op: "delete", noteId: nid(snapshot, 0) }],
  });
  assert.equal(result.ok, true);
  assert.equal(snapshots.store.get(snapshot.contextId), null);
});
