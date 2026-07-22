import assert from "node:assert/strict";
import test from "node:test";

import { NotePatchService } from "../server/src/note-patch.js";
import { SnapshotService, SnapshotStore } from "../server/src/snapshot.js";

// 独立的宿主模型：支持全部可 patch 字段、按 (方法, 调用序号) 注入失败，用于补偿回滚测试。
function createPatchModel() {
  const handles = {
    project: handle(1, "Project"),
    sv: handle(2, "SV"),
    mainEditor: handle(3, "MainEditorView"),
    track: handle(4, "Track"),
    groupReference: handle(5, "NoteGroupReference"),
    group: handle(6, "NoteGroup"),
    selection: handle(7, "TrackInnerSelectionState"),
    notes: [handle(8, "Note"), handle(9, "Note"), handle(10, "Note")],
  };
  const notes = [
    noteState(0, 0, 705600, 60, "a"),
    noteState(1, 705600, 705600, 62, "i"),
    noteState(2, 1411200, 705600, 64, "u"),
  ];
  const model = {
    handles,
    notes,
    undoCount: 0,
    failures: [],
    ignoreSetters: new Set(),
    host: null,
  };
  model.host = {
    epoch: () => 1,
    roots: async () => ({
      project: handles.project,
      sv: handles.sv,
      mainEditor: handles.mainEditor,
    }),
    free: async () => {},
    index: async () => null,
    call: async ({ handle: target, method, args = [] }) => {
      const failure = model.failures.find((item) => item.method === method && item.remainingSkips-- <= 0);
      if (failure) {
        model.failures.splice(model.failures.indexOf(failure), 1);
        const error = new Error(failure.message ?? `injected failure for ${method}`);
        if (failure.code) error.code = failure.code;
        throw error;
      }
      const id = target?.__handle__;
      if (id === handles.project.__handle__) {
        if (method === "newUndoRecord") return ++model.undoCount;
        if (method === "getTrack") return handles.track;
        if (method === "getNumTracks") return 1;
      }
      if (id === handles.mainEditor.__handle__) {
        if (method === "getCurrentTrack") return handles.track;
        if (method === "getCurrentGroup") return handles.groupReference;
        if (method === "getSelection") return handles.selection;
      }
      if (id === handles.selection.__handle__ && method === "getSelectedNotes") {
        return handles.notes;
      }
      if (id === handles.track.__handle__) {
        if (method === "getIndexInParent") return 1;
        if (method === "getName") return "Main";
        if (method === "getNumGroups") return 1;
        if (method === "getGroupReference") return handles.groupReference;
      }
      if (id === handles.groupReference.__handle__) {
        if (method === "getIndexInParent") return 1;
        if (method === "getTarget") return handles.group;
        if (method === "isInstrumental") return false;
        if (method === "isMain") return true;
        if (method === "getOnset" || method === "getTimeOffset" || method === "getPitchOffset")
          return 0;
        if (method === "getVoice") return { paramTension: 0 };
      }
      if (id === handles.group.__handle__) {
        if (method === "getName") return "Main Group";
        if (method === "getUUID") return "group-1";
        if (method === "getNumNotes") return notes.length;
        if (method === "getNote") return handles.notes[args[0] - 1] ?? null;
      }
      const noteIndex = handles.notes.findIndex((note) => note.__handle__ === id);
      if (noteIndex >= 0) return callNote(model, notes[noteIndex], method, args);
      if (id === handles.sv.__handle__ && method === "getPhonemesForGroup") {
        return notes.map((note) => (note.lyrics ? `${note.lyrics}-phoneme` : ""));
      }
      throw new Error(`unsupported call ${id}.${method}`);
    },
  };
  return model;
}

function callNote(model, note, method, args) {
  const getters = {
    getIndexInParent: note.index + 1,
    getOnset: note.onset,
    getDuration: note.duration,
    getPitch: note.pitch,
    getLyrics: note.lyrics,
    getPhonemes: note.phonemes,
    getLanguageOverride: note.language,
    getDetune: note.detune,
  };
  if (Object.hasOwn(getters, method)) return getters[method];
  // 模拟真实 PIPE 解码：返回 null-prototype 的深层对象。
  if (method === "getAttributes") return toNullProto(note.attributes);
  if (model.ignoreSetters.has(method)) return null;
  if (method === "setLyrics") note.lyrics = args[0];
  else if (method === "setPhonemes") note.phonemes = args[0];
  else if (method === "setLanguageOverride") note.language = args[0];
  else if (method === "setPitch") note.pitch = args[0];
  else if (method === "setOnset") note.onset = args[0];
  else if (method === "setDuration") note.duration = args[0];
  else if (method === "setDetune") note.detune = args[0];
  else if (method === "setAttributes") {
    for (const [key, item] of Object.entries(args[0])) note.attributes[key] = item;
  }
  else throw new Error(`unsupported note method ${method}`);
  return null;
}

function toNullProto(value) {
  if (Array.isArray(value)) return value.map(toNullProto);
  if (value !== null && typeof value === "object") {
    const out = Object.create(null);
    for (const [key, item] of Object.entries(value)) out[key] = toNullProto(item);
    return out;
  }
  return value;
}

function noteState(index, onset, duration, pitch, lyrics) {
  return {
    index,
    onset,
    duration,
    pitch,
    lyrics,
    phonemes: "",
    language: "",
    detune: 0,
    attributes: { tF0Offset: 0, dur: 1 },
  };
}

function handle(id, type) {
  return { __handle__: id, __type__: type, __epoch__: 1 };
}

function injectFailure(model, method, { skip = 0, code, message } = {}) {
  model.failures.push({ method, remainingSkips: skip, code, message });
}

async function createFixture() {
  const model = createPatchModel();
  const session = { withExclusive: (task) => task(model.host) };
  const snapshots = new SnapshotService(session, {
    store: new SnapshotStore({ now: () => 1000 }),
    now: () => 1000,
  });
  const service = new NotePatchService(session, snapshots, {
    sleepFn: async () => {},
    now: () => 1000,
  });
  const snapshot = await snapshots.snapshot({ scope: { kind: "selection" } });
  return { model, snapshots, service, snapshot };
}

const nid = (snapshot, index) => `${snapshot.contextId}:n:${index}`;

test("sv_patch_notes dryRun plans a diff without any host side effect", async () => {
  const { model, service, snapshot } = await createFixture();
  const result = await service.patchNotes({
    contextId: snapshot.contextId,
    dryRun: true,
    patches: [
      { noteId: nid(snapshot, 0), set: { lyrics: "ka", pitch: 61 } },
      { noteId: nid(snapshot, 2), set: { lyrics: "u" } },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "dry_run");
  assert.equal(result.effects, "none");
  assert.equal(result.atomicity, "verified_compensation");
  assert.equal(result.data.plannedChangedNotes, 1);
  assert.deepEqual(
    result.data.plannedDiff.map((entry) => [entry.field, entry.from, entry.to]),
    [
      ["pitch", 60, 61],
      ["lyrics", "a", "ka"],
    ]
  );
  assert.equal(model.undoCount, 0);
  assert.equal(model.notes[0].lyrics, "a");
  assert.equal(model.notes[0].pitch, 60);
});

test("sv_patch_notes applies multi-field patches deterministically and verifies read-back", async () => {
  const { model, service, snapshot } = await createFixture();
  const result = await service.patchNotes({
    contextId: snapshot.contextId,
    waitFor: "phonemes",
    timeoutMs: 100,
    pollIntervalMs: 20,
    patches: [
      {
        noteId: nid(snapshot, 1),
        expected: { lyrics: "i" },
        set: { lyrics: "mi", detuneCents: -8, attributes: { tF0Offset: 0.5 } },
      },
      { noteId: nid(snapshot, 0), set: { durationBlick: 352800, pitch: 63 } },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "succeeded");
  assert.equal(result.effects, "verified");
  assert.equal(result.verification.passed, true);
  // 写入顺序：note 位置升序，位置内按字段表顺序。
  assert.deepEqual(
    result.data.appliedDiff.map((entry) => [entry.position, entry.field]),
    [
      [0, "durationBlick"],
      [0, "pitch"],
      [1, "lyrics"],
      [1, "detuneCents"],
      [1, "attributes"],
    ]
  );
  assert.equal(result.data.processedNotes, 2);
  assert.equal(result.data.actuallyChangedNotes, 2);
  assert.equal(model.notes[0].duration, 352800);
  assert.equal(model.notes[0].pitch, 63);
  assert.equal(model.notes[1].lyrics, "mi");
  assert.equal(model.notes[1].detune, -8);
  assert.equal(model.notes[1].attributes.tF0Offset, 0.5);
  assert.equal(model.notes[1].attributes.dur, 1);
  assert.equal(model.undoCount, 2);
  assert.equal(result.undo.expectedUserUndoSteps, 1);
  assert.equal(result.data.processing.state, "ready");
  assert.equal(
    result.verification.evidence.observed[nid(snapshot, 1)].lyrics,
    "mi"
  );
});

test("sv_patch_notes rejects expected mismatches before any write", async () => {
  const { model, service, snapshot } = await createFixture();
  const result = await service.patchNotes({
    contextId: snapshot.contextId,
    patches: [
      { noteId: nid(snapshot, 0), expected: { lyrics: "wrong" }, set: { lyrics: "ka" } },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "failed");
  assert.equal(result.effects, "none");
  assert.equal(result.error.code, "EXPECTED_MISMATCH");
  assert.deepEqual(result.data.mismatches, [
    { noteId: nid(snapshot, 0), field: "lyrics", expected: "wrong", observed: "a" },
  ]);
  assert.equal(model.undoCount, 0);
  assert.equal(model.notes[0].lyrics, "a");
});

test("sv_patch_notes reports no_change without undo records for a no-op set", async () => {
  const { model, service, snapshot } = await createFixture();
  const result = await service.patchNotes({
    contextId: snapshot.contextId,
    patches: [{ noteId: nid(snapshot, 0), set: { lyrics: "a", pitch: 60 } }],
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "no_change");
  assert.equal(result.effects, "none");
  assert.equal(model.undoCount, 0);
});

test("sv_patch_notes atomic mode rolls back applied writes on mid-apply failure", async () => {
  const { model, service, snapshot } = await createFixture();
  injectFailure(model, "setLyrics", { code: "ARGUMENT_MISMATCH", message: "injected setLyrics failure" });
  const result = await service.patchNotes({
    contextId: snapshot.contextId,
    patches: [
      { noteId: nid(snapshot, 0), set: { pitch: 61, detuneCents: 10 } },
      { noteId: nid(snapshot, 1), set: { lyrics: "mi" } },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "rolled_back");
  assert.equal(result.effects, "reverted");
  assert.equal(result.error.code, "ARGUMENT_MISMATCH");
  assert.equal(result.rollback.attempted, true);
  assert.equal(result.rollback.verified, true);
  // 已写出的 pitch/detune 被恢复。
  assert.equal(model.notes[0].pitch, 60);
  assert.equal(model.notes[0].detune, 0);
  assert.equal(model.notes[1].lyrics, "i");
  assert.equal(model.undoCount, 2);
  assert.deepEqual(result.rollback.evidence.restored[nid(snapshot, 0)], {
    pitch: 60,
    detuneCents: 0,
  });
});

test("sv_patch_notes atomic mode rolls back on read-back mismatch", async () => {
  const { model, service, snapshot } = await createFixture();
  // setPitch 静默不生效：写入被宿主忽略，读回验证必须失败并触发补偿。
  model.ignoreSetters.add("setPitch");
  const result = await service.patchNotes({
    contextId: snapshot.contextId,
    patches: [{ noteId: nid(snapshot, 0), set: { pitch: 61, lyrics: "ka" } }],
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "rolled_back");
  assert.equal(result.error.code, "POSTCONDITION_FAILED");
  assert.equal(result.verification.passed, false);
  assert.equal(result.rollback.verified, true);
  assert.equal(model.notes[0].lyrics, "a");
  assert.equal(model.notes[0].pitch, 60);
});

test("sv_patch_notes non-atomic mode reports partial and leaves applied writes", async () => {
  const { model, service, snapshot } = await createFixture();
  injectFailure(model, "setLyrics", { code: "ARGUMENT_MISMATCH" });
  const result = await service.patchNotes({
    contextId: snapshot.contextId,
    atomic: false,
    patches: [
      { noteId: nid(snapshot, 0), set: { pitch: 61 } },
      { noteId: nid(snapshot, 1), set: { lyrics: "mi" } },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "partial");
  assert.equal(result.effects, "may_remain");
  assert.equal(result.atomicity, "none");
  assert.equal(result.rollback.attempted, false);
  assert.equal(model.notes[0].pitch, 61);
  assert.equal(result.data.actuallyChangedNotes, 1);
});

test("sv_patch_notes reports outcome_unknown without compensation when the host detaches", async () => {
  const { model, service, snapshot } = await createFixture();
  injectFailure(model, "setLyrics", { code: "HOST_DETACHED", message: "bridge detached" });
  const result = await service.patchNotes({
    contextId: snapshot.contextId,
    patches: [
      { noteId: nid(snapshot, 0), set: { pitch: 61 } },
      { noteId: nid(snapshot, 1), set: { lyrics: "mi" } },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "outcome_unknown");
  assert.equal(result.effects, "unknown");
  assert.equal(result.rollback.attempted, false);
  // 宿主断开后不做补偿写入；已生效的 pitch 保留。
  assert.equal(model.notes[0].pitch, 61);
});

test("sv_patch_notes reports rollback_failed when compensation itself fails", async () => {
  const { model, service, snapshot } = await createFixture();
  injectFailure(model, "setLyrics", { code: "ARGUMENT_MISMATCH" });
  injectFailure(model, "setPitch", { skip: 1, code: "ARGUMENT_MISMATCH", message: "rollback write refused" });
  const result = await service.patchNotes({
    contextId: snapshot.contextId,
    patches: [
      { noteId: nid(snapshot, 0), set: { pitch: 61 } },
      { noteId: nid(snapshot, 1), set: { lyrics: "mi" } },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "rollback_failed");
  assert.equal(result.effects, "may_remain");
  assert.equal(result.rollback.attempted, true);
  assert.equal(result.rollback.verified, false);
  assert.equal(result.rollback.error.message, "rollback write refused");
  assert.equal(model.notes[0].pitch, 61);
});

test("sv_patch_notes validates noteIds, duplicates, and field names", async () => {
  const { service, snapshot } = await createFixture();
  // noteId/重复类错误在独占段内发现，返回结构化失败而不是 reject。
  const invalidId = await service.patchNotes({
    contextId: snapshot.contextId,
    patches: [{ noteId: "other:n:0", set: { lyrics: "x" } }],
  });
  assert.equal(invalidId.ok, false);
  assert.equal(invalidId.error.code, "INVALID_NOTE_ID");
  assert.equal(invalidId.effects, "none");

  const outOfRange = await service.patchNotes({
    contextId: snapshot.contextId,
    patches: [{ noteId: nid(snapshot, 9), set: { lyrics: "x" } }],
  });
  assert.equal(outOfRange.error.code, "NOTE_INDEX_OUT_OF_RANGE");

  const duplicate = await service.patchNotes({
    contextId: snapshot.contextId,
    patches: [
      { noteId: nid(snapshot, 0), set: { lyrics: "x" } },
      { noteId: nid(snapshot, 0), set: { pitch: 61 } },
    ],
  });
  assert.equal(duplicate.error.code, "DUPLICATE_NOTE_ID");

  await assert.rejects(
    service.patchNotes({
      contextId: snapshot.contextId,
      patches: [{ noteId: nid(snapshot, 0), set: { color: "red" } }],
    }),
    (error) => error.code === "UNKNOWN_FIELD"
  );
  await assert.rejects(
    service.patchNotes({
      contextId: snapshot.contextId,
      patches: [{ noteId: nid(snapshot, 0), set: { pitch: 200 } }],
    }),
    (error) => error.code === "INVALID_ARGUMENTS"
  );
});

test("sv_patch_notes warns when onset changes may reorder notes", async () => {
  const { service, snapshot } = await createFixture();
  const result = await service.patchNotes({
    contextId: snapshot.contextId,
    dryRun: true,
    patches: [{ noteId: nid(snapshot, 0), set: { onsetBlick: 2116800 } }],
  });
  assert.ok(result.warnings.some((warning) => warning.code === "NOTE_ORDER_MAY_CHANGE"));
});

test("sv_patch_notes invalidates the context after a successful write", async () => {
  const { snapshots, service, snapshot } = await createFixture();
  const result = await service.patchNotes({
    contextId: snapshot.contextId,
    waitFor: "none",
    patches: [{ noteId: nid(snapshot, 0), set: { lyrics: "ka" } }],
  });
  assert.equal(result.ok, true);
  assert.equal(snapshots.store.get(snapshot.contextId), null);
});

test("sv_patch_notes verifies null-prototype nested attributes from the pipe decoder", async () => {
  const { model, service, snapshot } = await createFixture();
  const result = await service.patchNotes({
    contextId: snapshot.contextId,
    waitFor: "none",
    patches: [
      {
        noteId: nid(snapshot, 0),
        set: { attributes: { tF0Offset: 0.25, expr: { depth: 1, kind: "soft" } } },
      },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "succeeded");
  assert.equal(result.verification.passed, true);
  assert.deepEqual(model.notes[0].attributes.expr, { depth: 1, kind: "soft" });
});

test("sv_patch_notes atomic mode rolls back when the read-back getter throws", async () => {
  const { model, service, snapshot } = await createFixture();
  // 注入发生在快照之后：resolve 指纹 3 次 + 写前 current 读 1 次，第 5 次才是读回验证。
  injectFailure(model, "getLyrics", { skip: 4, code: "UNKNOWN_HANDLE", message: "getter exploded" });
  const result = await service.patchNotes({
    contextId: snapshot.contextId,
    patches: [{ noteId: nid(snapshot, 0), set: { lyrics: "ka" } }],
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "rolled_back");
  assert.equal(result.error.code, "UNKNOWN_HANDLE");
  assert.equal(result.rollback.attempted, true);
  assert.equal(result.rollback.verified, true);
  assert.equal(model.notes[0].lyrics, "a");
  // Undo 边界已开必须已关。
  assert.equal(model.undoCount, 2);
});

test("sv_patch_notes accepts fractional detuneCents", async () => {
  const { model, service, snapshot } = await createFixture();
  const result = await service.patchNotes({
    contextId: snapshot.contextId,
    waitFor: "none",
    patches: [{ noteId: nid(snapshot, 0), set: { detuneCents: -7.5 } }],
  });
  assert.equal(result.ok, true);
  assert.equal(model.notes[0].detune, -7.5);
});
