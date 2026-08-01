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
  if (method === "getAttributes") {
    if (Object.keys(note.attributes).length === 0) {
      return { $sv: "table", shape: "unknown", entries: [] };
    }
    return toNullProto(note.attributes);
  }
  if (model.ignoreSetters.has(method)) return null;
  if (method === "setLyrics") note.lyrics = args[0];
  else if (method === "setPhonemes") note.phonemes = args[0];
  else if (method === "setLanguageOverride") note.language = args[0];
  else if (method === "setPitch") note.pitch = args[0];
  else if (method === "setOnset") note.onset = args[0];
  else if (method === "setDuration") note.duration = args[0];
  else if (method === "setDetune") note.detune = args[0];
  else if (method === "setAttributes") {
    // 官方 setAttributes 只更新给定字段；夹具保持相同语义，避免掩盖协议层信封回写。
    note.attributes = { ...note.attributes, ...args[0] };
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

// 身份就是组内 index（§3.1）；保留 helper 只为让测试改动最小、意图仍然可读。
const nid = (_snapshot, index) => index;

test("sv_patch_notes dryRun plans a diff without any host side effect", async () => {
  const { model, service, snapshot } = await createFixture();
  const result = await service.patchNotes({
    contextId: snapshot.contextId,
    dryRun: true,
    patches: [
      { note: nid(snapshot, 0), set: { lyrics: "ka", pitch: 61 } },
      { note: nid(snapshot, 2), set: { lyrics: "u" } },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "dry_run");
  assert.equal(result.effects, "none");
  assert.equal(result.atomicity, "verified_compensation");
  assert.equal(result.data.plannedChangedNotes, 1);
  assert.equal(result.data.attemptedChangedNotes, 0);
  assert.equal(result.data.remainingChangedNotes, 0);
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
        note: nid(snapshot, 1),
        expected: { lyrics: "i" },
        set: { lyrics: "mi", detuneCents: -8, attributes: { tF0Offset: 0.5 } },
      },
      { note: nid(snapshot, 0), set: { durationBlick: 352800, pitch: 63 } },
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
      { note: nid(snapshot, 0), expected: { lyrics: "wrong" }, set: { lyrics: "ka" } },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "failed");
  assert.equal(result.effects, "none");
  assert.equal(result.error.code, "EXPECTED_MISMATCH");
  assert.equal(result.data.attemptedChangedNotes, 0);
  assert.equal(result.data.remainingChangedNotes, 0);
  assert.deepEqual(result.data.mismatches, [
    { note: nid(snapshot, 0), field: "lyrics", expected: "wrong", observed: "a" },
  ]);
  assert.equal(model.undoCount, 0);
  assert.equal(model.notes[0].lyrics, "a");
});

test("sv_patch_notes reports no_change without undo records for a no-op set", async () => {
  const { model, service, snapshot } = await createFixture();
  const result = await service.patchNotes({
    contextId: snapshot.contextId,
    patches: [{ note: nid(snapshot, 0), set: { lyrics: "a", pitch: 60 } }],
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "no_change");
  assert.equal(result.effects, "none");
  assert.equal(result.data.attemptedChangedNotes, 0);
  assert.equal(result.data.remainingChangedNotes, 0);
  assert.equal(model.undoCount, 0);
});

test("sv_patch_notes atomic mode rolls back applied writes on mid-apply failure", async () => {
  const { model, service, snapshot } = await createFixture();
  injectFailure(model, "setLyrics", { code: "ARGUMENT_MISMATCH", message: "injected setLyrics failure" });
  const result = await service.patchNotes({
    contextId: snapshot.contextId,
    patches: [
      { note: nid(snapshot, 0), set: { pitch: 61, detuneCents: 10 } },
      { note: nid(snapshot, 1), set: { lyrics: "mi" } },
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
    patches: [{ note: nid(snapshot, 0), set: { pitch: 61, lyrics: "ka" } }],
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
      { note: nid(snapshot, 0), set: { pitch: 61 } },
      { note: nid(snapshot, 1), set: { lyrics: "mi" } },
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
      { note: nid(snapshot, 0), set: { pitch: 61 } },
      { note: nid(snapshot, 1), set: { lyrics: "mi" } },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "outcome_unknown");
  assert.equal(result.effects, "unknown");
  assert.equal(result.rollback.attempted, false);
  assert.equal(result.data.attemptedChangedNotes, 1);
  assert.equal(result.data.remainingChangedNotes, null);
  assert.equal(result.data.actuallyChangedNotes, null);
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
      { note: nid(snapshot, 0), set: { pitch: 61 } },
      { note: nid(snapshot, 1), set: { lyrics: "mi" } },
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

test("sv_patch_notes validates note indexes, duplicates, and field names", async () => {
  const { service, snapshot } = await createFixture();
  // index/重复类错误在独占段内发现，返回结构化失败而不是 reject。
  //
  // 「引用了别的上下文」不再是一种可能的输入：index 不携带 context/occurrence 前缀，
  // 因此那种请求在结构上无法表达，只剩下越界这一种失败。
  const outOfRange = await service.patchNotes({
    contextId: snapshot.contextId,
    patches: [{ note: nid(snapshot, 9), set: { lyrics: "x" } }],
  });
  assert.equal(outOfRange.error.code, "NOTE_INDEX_OUT_OF_RANGE");

  const duplicate = await service.patchNotes({
    contextId: snapshot.contextId,
    patches: [
      { note: nid(snapshot, 0), set: { lyrics: "x" } },
      { note: nid(snapshot, 0), set: { pitch: 61 } },
    ],
  });
  assert.equal(duplicate.error.code, "DUPLICATE_NOTE_INDEX");

  await assert.rejects(
    service.patchNotes({
      contextId: snapshot.contextId,
      patches: [{ note: nid(snapshot, 0), set: { color: "red" } }],
    }),
    (error) => error.code === "UNKNOWN_FIELD"
  );
  await assert.rejects(
    service.patchNotes({
      contextId: snapshot.contextId,
      patches: [{ note: nid(snapshot, 0), set: { pitch: 200 } }],
    }),
    (error) => error.code === "INVALID_ARGUMENTS"
  );
});

test("sv_patch_notes warns when onset changes may reorder notes", async () => {
  const { service, snapshot } = await createFixture();
  const result = await service.patchNotes({
    contextId: snapshot.contextId,
    dryRun: true,
    patches: [{ note: nid(snapshot, 0), set: { onsetBlick: 2116800 } }],
  });
  assert.ok(result.warnings.some((warning) => warning.code === "NOTE_ORDER_MAY_CHANGE"));
});

test("sv_patch_notes invalidates the context after a successful write", async () => {
  const { snapshots, service, snapshot } = await createFixture();
  const result = await service.patchNotes({
    contextId: snapshot.contextId,
    waitFor: "none",
    patches: [{ note: nid(snapshot, 0), set: { lyrics: "ka" } }],
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
        note: nid(snapshot, 0),
        set: { attributes: { tF0Offset: 0.25, expr: { depth: 1, kind: "soft" } } },
      },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "succeeded");
  assert.equal(result.verification.passed, true);
  assert.deepEqual(model.notes[0].attributes.expr, { depth: 1, kind: "soft" });
});

test("sv_patch_notes does not echo typed-v2 sentinels in partial attribute writes", async () => {
  const { model, service, snapshot } = await createFixture();
  model.notes[0].attributes.tF0Offset = { $sv: "number", value: "nan" };
  const writes = [];
  const originalCall = model.host.call;
  model.host.call = async (request) => {
    if (request.method === "setAttributes") writes.push(structuredClone(request.args[0]));
    return originalCall(request);
  };

  const result = await service.patchNotes({
    contextId: snapshot.contextId,
    waitFor: "none",
    patches: [{ note: nid(snapshot, 0), set: { attributes: { dur: 1.25 } } }],
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(writes, [{ dur: 1.25 }]);
  assert.deepEqual(model.notes[0].attributes.tF0Offset, { $sv: "number", value: "nan" });
});

test("sv_patch_notes normalizes a typed empty attribute table before writing", async () => {
  const { model, service, snapshot } = await createFixture();
  model.notes[0].attributes = {};
  const result = await service.patchNotes({
    contextId: snapshot.contextId,
    waitFor: "none",
    patches: [{ note: nid(snapshot, 0), set: { attributes: { muted: true } } }],
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(model.notes[0].attributes, { muted: true });
});

test("sv_patch_notes atomic mode rolls back when the read-back getter throws", async () => {
  const { model, service, snapshot } = await createFixture();
  // 注入发生在快照之后：resolve 指纹 3 次，第 4 次才是写后读回验证。
  injectFailure(model, "getLyrics", { skip: 3, code: "UNKNOWN_HANDLE", message: "getter exploded" });
  const result = await service.patchNotes({
    contextId: snapshot.contextId,
    patches: [{ note: nid(snapshot, 0), set: { lyrics: "ka" } }],
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
    patches: [{ note: nid(snapshot, 0), set: { detuneCents: -7.5 } }],
  });
  assert.equal(result.ok, true);
  assert.equal(model.notes[0].detune, -7.5);
});

test("sv_patch_notes reports rollback_failed when a merge-semantics host cannot remove new attribute keys", async () => {
  const { model, service, snapshot } = await createFixture();
  // 单测内模拟"合并"语义宿主：官方 setAttributes 语义未经真机确认，回滚验证在两种
  // 语义下都必须诚实——合并语义下 setAttributes(old) 删不掉新 key，必须报 rollback_failed。
  const originalCall = model.host.call;
  model.host.call = async (request) => {
    if (request.method === "setAttributes") {
      const noteIndex = model.handles.notes.findIndex(
        (note) => note.__handle__ === request.handle?.__handle__
      );
      if (noteIndex >= 0) {
        for (const [key, item] of Object.entries(request.args[0])) {
          model.notes[noteIndex].attributes[key] = item;
        }
        return null;
      }
    }
    return originalCall(request);
  };
  // pitch setter 被忽略触发回滚；attributes 已写入新 key，合并语义下无法删除。
  model.ignoreSetters.add("setPitch");
  const result = await service.patchNotes({
    contextId: snapshot.contextId,
    patches: [
      {
        note: nid(snapshot, 0),
        set: { pitch: 61, attributes: { brandNewKey: 0.7 } },
      },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "rollback_failed");
  assert.equal(result.rollback.verified, false);
  // attempted/remaining 拆分：曾写过 1 个音符，回滚后仍有 1 个偏离原状态。
  assert.equal(result.data.attemptedChangedNotes, 1);
  assert.equal(result.data.remainingChangedNotes, 1);
  assert.equal(result.data.actuallyChangedNotes, 1);
  assert.equal(model.notes[0].attributes.brandNewKey, 0.7);
});

test("sv_patch_notes reports rollback_failed under an undocumented replace-semantics host", async () => {
  const { model, service, snapshot } = await createFixture();
  const originalCall = model.host.call;
  model.host.call = async (request) => {
    if (request.method === "setAttributes") {
      const noteIndex = model.handles.notes.findIndex(
        (note) => note.__handle__ === request.handle?.__handle__
      );
      if (noteIndex >= 0) {
        model.notes[noteIndex].attributes = { ...request.args[0] };
        return null;
      }
    }
    return originalCall(request);
  };
  model.ignoreSetters.add("setPitch");
  const result = await service.patchNotes({
    contextId: snapshot.contextId,
    patches: [
      {
        note: nid(snapshot, 0),
        set: { pitch: 61, attributes: { brandNewKey: 0.7 } },
      },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "rollback_failed");
  assert.equal(result.rollback.verified, false);
  assert.equal(result.data.remainingChangedNotes, 1);
  assert.equal(model.notes[0].attributes.brandNewKey, undefined);
  assert.equal(model.notes[0].attributes.dur, undefined);
});

test("sv_patch_notes reports zero remaining changes after a verified rollback", async () => {
  const { model, service, snapshot } = await createFixture();
  injectFailure(model, "setLyrics", { code: "ARGUMENT_MISMATCH" });
  const result = await service.patchNotes({
    contextId: snapshot.contextId,
    patches: [
      { note: nid(snapshot, 0), set: { pitch: 61 } },
      { note: nid(snapshot, 1), set: { lyrics: "mi" } },
    ],
  });

  assert.equal(result.status, "rolled_back");
  assert.equal(result.data.attemptedChangedNotes, 1);
  assert.equal(result.data.remainingChangedNotes, 0);
  assert.equal(result.data.actuallyChangedNotes, 0);
});

// range context fixture：与 sv_snapshot_range prepareStoredRange 存储的 occurrence 结构一致。
function createRangeFixture({ shared = false, extraOccurrence = false } = {}) {
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
  const entry = snapshots.store.create({
    epoch: 1,
    scope: { kind: "range" },
    observedAt: new Date(1000).toISOString(),
    context: { kind: "range", occurrences: [] },
  });
  const noteFingerprints = model.notes.map((note) => ({
    indexInGroup: note.index,
    onsetBlick: note.onset,
    durationBlick: note.duration,
    pitch: note.pitch,
    lyrics: note.lyrics,
    phonemesOverride: note.phonemes,
    languageOverride: note.language,
    detuneCents: note.detune,
  }));
  entry.context.occurrences.push({
    occurrence: 0,
    trackIndex: 0,
    groupIndex: 0,
    targetGroupUuid: "group-1",
    timeOffsetBlick: 0,
    sharedTargetOccurrences: shared ? [0, 1] : [0],
    noteFingerprints,
  });
  if (extraOccurrence) {
    entry.context.occurrences.push({
      occurrence: 1,
      trackIndex: 1,
      groupIndex: 0,
      targetGroupUuid: "group-1",
      timeOffsetBlick: 0,
      sharedTargetOccurrences: [],
      noteFingerprints: [],
    });
  }
  return { model, snapshots, service, contextId: entry.contextId };
}

test("sv_patch_notes accepts a range context and resolves notes by group index", async () => {
  const { model, snapshots, service, contextId } = createRangeFixture();
  const result = await service.patchNotes({
    contextId,
    patches: [{ note: 1, set: { lyrics: "ne", pitch: 65 } }],
    waitFor: "none",
  });

  assert.equal(result.ok, true);
  assert.equal(result.effects, "verified");
  assert.equal(model.notes[1].lyrics, "ne");
  assert.equal(model.notes[1].pitch, 65);
  // Undo 边界一开一关；成功写入后 range context 失效。
  assert.equal(model.undoCount, 2);
  assert.equal(snapshots.store.get(contextId), null);
  assert.deepEqual(
    result.data.appliedDiff.map((entry) => entry.indexInGroup),
    [1, 1]
  );
});

test("sv_patch_notes range context enforces shared-target confirmation", async () => {
  const { model, service, contextId } = createRangeFixture({ shared: true });
  const refused = await service.patchNotes({
    contextId,
    patches: [{ note: 0, set: { lyrics: "x" } }],
    waitFor: "none",
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "SHARED_TARGET_REQUIRES_CONFIRMATION");
  assert.equal(refused.effects, "none");
  assert.ok(Array.isArray(refused.error.details.projectTargetOccurrences));
  assert.equal(model.notes[0].lyrics, "a");
  assert.equal(model.undoCount, 0);

  const confirmed = await service.patchNotes({
    contextId,
    patches: [{ note: 0, set: { lyrics: "x" } }],
    allowSharedTargetMutation: true,
    waitFor: "none",
  });
  assert.equal(confirmed.ok, true);
  assert.equal(model.notes[0].lyrics, "x");
});

test("sv_patch_notes range context dry-run defers the shared-target scan with warnings", async () => {
  const { model, service, contextId } = createRangeFixture({ shared: true });
  const result = await service.patchNotes({
    contextId,
    patches: [{ note: 0, set: { lyrics: "x" } }],
    dryRun: true,
    waitFor: "none",
  });
  assert.equal(result.status, "dry_run");
  assert.deepEqual(
    result.warnings.map((warning) => warning.code).sort(),
    ["SHARED_TARGET_CHECK_DEFERRED", "SHARED_TARGET_DRY_RUN"]
  );
  assert.equal(model.notes[0].lyrics, "a");
  assert.equal(model.undoCount, 0);
});

test("sv_patch_notes separates an out-of-range index from an uncaptured one", async () => {
  // 迁移到 index 身份后，「引用了别的 occurrence」与「一个请求里混用两个 occurrence」
  // 都不再是可能的输入：index 不携带 occurrence 前缀。剩下的两种失败必须保持可区分
  // （§3.2 规则 5）——越界靠重试永远不会成功，未捕获则需要重新捕获更宽的范围。
  const { service, contextId } = createRangeFixture();
  const outOfRange = await service.patchNotes({
    contextId,
    patches: [{ note: 999, set: { lyrics: "x" } }],
    waitFor: "none",
  });
  assert.equal(outOfRange.ok, false);
  assert.equal(outOfRange.error.code, "NOTE_INDEX_OUT_OF_RANGE");
  assert.equal(outOfRange.effects, "none");
});

test("sv_patch_notes range context detects stale fingerprints before writing", async () => {
  const { model, service, contextId } = createRangeFixture();
  model.notes[0].lyrics = "changed-behind-context";
  const result = await service.patchNotes({
    contextId,
    patches: [{ note: 0, set: { lyrics: "x" } }],
    waitFor: "none",
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "STALE_CONTEXT");
  assert.equal(model.undoCount, 0);
});

test("sv_patch_notes range preflight ignores unrelated note drift", async () => {
  const { model, service, contextId } = createRangeFixture();
  model.notes[2].lyrics = "unrelated-change";
  const result = await service.patchNotes({
    contextId,
    occurrence: 0,
    patches: [{ note: 0, expected: { lyrics: "a" }, set: { lyrics: "x" } }],
    dryRun: true,
    waitFor: "none",
  });

  assert.equal(result.status, "dry_run");
  assert.equal(result.data.plannedChangedNotes, 1);
  assert.equal(model.undoCount, 0);
});

test("sv_patch_notes resolves notes by group index and keeps diffs free of redundant identity", async () => {
  const { model, service, contextId } = createRangeFixture();
  const result = await service.patchNotes({
    contextId,
    occurrence: 0,
    patches: [{ note: 1, expected: { lyrics: "i" }, set: { lyrics: "ne" } }],
    dryRun: true,
    waitFor: "none",
  });

  assert.equal(result.status, "dry_run");
  assert.equal(model.notes[1].lyrics, "i");
  assert.deepEqual(result.data.plannedDiff, [
    {
      position: 1,
      indexInGroup: 1,
      field: "lyrics",
      from: "i",
      to: "ne",
    },
  ]);
  assert.equal("noteId" in result.data.plannedDiff[0], false);
});

test("sv_patch_notes requires the note field in every patch", async () => {
  // 只剩一种引用写法，因此"两种形式混用"不再可构造；要守的是必填与类型。
  const { service, contextId } = createRangeFixture();
  for (const patch of [{ set: { lyrics: "x" } }, { note: -1, set: { lyrics: "x" } }, { note: "0", set: { lyrics: "x" } }]) {
    await assert.rejects(
      service.patchNotes({
        contextId,
        occurrence: 0,
        patches: [patch],
        dryRun: true,
        waitFor: "none",
      }),
      { code: "INVALID_ARGUMENTS" },
      JSON.stringify(patch)
    );
  }
});

// 让夹具宿主宣告并实现批量读取原语，语义与真实 Lua 桥一致：
// 未设置字段以 typed-v2 nil 回传，索引 0-based，结果不含 handle。
function enableBulkReads(model) {
  const bulkCommands = [];
  model.bulkCommands = bulkCommands;
  model.host.supportsOp = (op) => op === "read_note_fingerprints_v1";
  model.host.bulk = async (command) => {
    bulkCommands.push(command);
    if (command.expectedGroupUuid !== undefined && command.expectedGroupUuid !== "group-1") {
      const error = new Error("STALE_GROUP_UUID: target group is group-1");
      error.code = "STALE_GROUP_UUID";
      throw error;
    }
    const encode = (field, note) => {
      const raw = {
        indexInGroup: note.index,
        onsetBlick: note.onset,
        durationBlick: note.duration,
        pitch: note.pitch,
        lyrics: note.lyrics,
        phonemesOverride: note.phonemes,
        languageOverride: note.language,
        detuneCents: note.detune,
      }[field];
      return raw === undefined ? null : raw;
    };
    return {
      groupUuid: "group-1",
      noteCount: model.notes.length,
      items: command.noteIndicesInGroup.map((index) => ({
        noteIndexInGroup: index,
        fingerprint: Object.fromEntries(
          command.fields.map((field) => [field, encode(field, model.notes[index])])
        ),
      })),
    };
  };
  return model;
}

test("sv_patch_notes routes scoped preflight through one bulk read", async () => {
  const legacy = createRangeFixture();
  const legacyResult = await legacy.service.patchNotes({
    contextId: legacy.contextId,
    occurrence: 0,
    patches: [{ note: 0, set: { lyrics: "x" } }],
    dryRun: true,
    waitFor: "none",
    diagnostics: true,
  });

  const bulk = createRangeFixture();
  enableBulkReads(bulk.model);
  const bulkResult = await bulk.service.patchNotes({
    contextId: bulk.contextId,
    occurrence: 0,
    patches: [{ note: 0, set: { lyrics: "x" } }],
    dryRun: true,
    waitFor: "none",
    diagnostics: true,
  });

  // 公开契约不能变：同一请求在新旧桥上返回同样的计划。
  assert.equal(bulkResult.status, legacyResult.status);
  assert.equal(bulkResult.effects, "none");
  assert.deepEqual(bulkResult.data.plannedDiff, legacyResult.data.plannedDiff);

  // 8 次指纹 getter 收敛成 1 次 internal op；getNote 仍保留（写入需要 handle）。
  assert.equal(legacyResult.diagnostics.hostCalls.byMethod.getLyrics.count, 1);
  assert.equal(bulkResult.diagnostics.hostCalls.byMethod.getLyrics, undefined);
  assert.equal(bulkResult.diagnostics.hostCalls.byMethod.getNote.count, 1);
  assert.equal(
    bulkResult.diagnostics.hostCalls.byMethod["$bulk:read_note_fingerprints_v1"].count,
    1
  );
  assert.ok(bulkResult.diagnostics.hostCalls.total < legacyResult.diagnostics.hostCalls.total);

  assert.deepEqual(bulkResult.diagnostics.bulkReads, {
    bulkHostCalls: 1,
    bulkNotes: 1,
    bulkFields: 8,
    fallbackUsed: false,
    fallbackReason: null,
  });
  assert.equal(legacyResult.diagnostics.bulkReads.fallbackUsed, true);
  assert.equal(legacyResult.diagnostics.bulkReads.fallbackReason, "HOST_CAPABILITY_ABSENT");

  // 批量请求必须带上快照的 group UUID，并且一次读完全部目标音符。
  const [command] = bulk.model.bulkCommands;
  assert.equal(command.expectedGroupUuid, "group-1");
  assert.deepEqual(command.noteIndicesInGroup, [0]);
  assert.equal(bulk.model.undoCount, 0);
});

test("bulk reads leave expected-mismatch and stale detection unchanged", async () => {
  const mismatch = createRangeFixture();
  enableBulkReads(mismatch.model);
  const mismatched = await mismatch.service.patchNotes({
    contextId: mismatch.contextId,
    occurrence: 0,
    patches: [{ note: 0, expected: { pitch: 99 }, set: { pitch: 61 } }],
    dryRun: true,
    waitFor: "none",
  });
  // expected 冲突仍由指纹判定，且不因来自批量读取而变成宿主错误。
  assert.equal(mismatched.ok, false);
  assert.equal(mismatched.status, "failed");
  assert.equal(mismatched.error.code, "EXPECTED_MISMATCH");
  assert.equal(mismatched.effects, "none");
  assert.deepEqual(mismatched.data.mismatches, [
    {
      note: 0,
      field: "pitch",
      expected: 99,
      observed: 60,
    },
  ]);
  assert.equal(mismatch.model.undoCount, 0);

  const stale = createRangeFixture();
  enableBulkReads(stale.model);
  stale.model.notes[0].lyrics = "changed-after-capture";
  const staleResult = await stale.service.patchNotes({
    contextId: stale.contextId,
    occurrence: 0,
    patches: [{ note: 0, set: { lyrics: "x" } }],
    dryRun: true,
    waitFor: "none",
  });
  // 批量读到的指纹必须仍然参与过期判定，不能因为来自 internal op 就被当成权威现状。
  assert.equal(staleResult.ok, false);
  assert.equal(staleResult.error.code, "STALE_CONTEXT");
  assert.equal(staleResult.effects, "none");
  assert.equal(stale.model.undoCount, 0);
});

test("sv_patch_notes diagnostics expose phases and method aggregates only when requested", async () => {
  const plainFixture = createRangeFixture();
  const plain = await plainFixture.service.patchNotes({
    contextId: plainFixture.contextId,
    occurrence: 0,
    patches: [{ note: 0, set: { lyrics: "x" } }],
    dryRun: true,
    waitFor: "none",
  });
  assert.equal("diagnostics" in plain, false);

  const diagnosticFixture = createRangeFixture();
  const diagnosed = await diagnosticFixture.service.patchNotes({
    contextId: diagnosticFixture.contextId,
    occurrence: 0,
    patches: [{ note: 0, set: { lyrics: "x" } }],
    dryRun: true,
    waitFor: "none",
    diagnostics: true,
  });

  assert.equal(diagnosed.status, "dry_run");
  assert.equal(diagnosed.diagnostics.timings.dispatcherQueueMs, null);
  assert.equal(typeof diagnosed.diagnostics.timings.targetResolutionMs, "number");
  assert.equal(typeof diagnosed.diagnostics.timings.fingerprintVerificationMs, "number");
  assert.equal(diagnosed.diagnostics.hostCalls.byMethod.getNote.count, 1);
  assert.equal(diagnosed.diagnostics.hostCalls.byMethod.getLyrics.count, 1);
  assert.ok(diagnosed.diagnostics.hostCalls.total > 0);
  assert.deepEqual(Object.keys(diagnosed.diagnostics.hostCalls.byMethod.getLyrics).sort(), [
    "count",
    "failed",
    "totalMs",
  ]);
});

test("sv_patch_notes reuses verified fingerprints for expected checks", async () => {
  const fixture = createRangeFixture();
  const result = await fixture.service.patchNotes({
    contextId: fixture.contextId,
    occurrence: 0,
    patches: [
      {
        note: 0,
        expected: { lyrics: "wrong" },
        set: { lyrics: "x" },
      },
    ],
    dryRun: true,
    waitFor: "none",
    diagnostics: true,
  });

  assert.equal(result.error.code, "EXPECTED_MISMATCH");
  assert.equal(result.diagnostics.hostCalls.byMethod.getLyrics.count, 1);
});

test("sv_patch_notes still reads attributes outside the verified fingerprint", async () => {
  const fixture = createRangeFixture();
  const result = await fixture.service.patchNotes({
    contextId: fixture.contextId,
    occurrence: 0,
    patches: [{ note: 0, set: { attributes: { muted: true } } }],
    dryRun: true,
    waitFor: "none",
    diagnostics: true,
  });

  assert.equal(result.status, "dry_run");
  assert.equal(result.diagnostics.hostCalls.byMethod.getAttributes.count, 1);
});

test("sv_patch_notes keeps post-write read-back after fingerprint reuse", async () => {
  const fixture = createRangeFixture();
  const result = await fixture.service.patchNotes({
    contextId: fixture.contextId,
    occurrence: 0,
    patches: [{ note: 0, set: { lyrics: "x" } }],
    waitFor: "none",
    diagnostics: true,
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.verification.passed, true);
  assert.equal(result.diagnostics.hostCalls.byMethod.getLyrics.count, 2);
});

test("sv_patch_notes keeps verified success when post-commit processing observation fails", async () => {
  const { model, service, snapshot } = await createFixture();
  // 提交与读回验证已完成、Undo 边界已关闭之后，处理观测失败不能把成功污染成
  // outcome_unknown/partial（对齐 phrase-edit 的 processing_observation_failed 降级）。
  injectFailure(model, "getPhonemesForGroup", {
    code: "HOST_TIMEOUT",
    message: "Timeout waiting for SynthV bridge",
  });
  const result = await service.patchNotes({
    contextId: snapshot.contextId,
    waitFor: "phonemes",
    patches: [{ note: nid(snapshot, 0), set: { lyrics: "ka" } }],
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "processing_observation_failed");
  assert.equal(result.effects, "verified");
  assert.equal(result.verification.passed, true);
  assert.equal(result.data.processing.state, "unknown");
  assert.equal(result.data.processing.error.code, "HOST_TIMEOUT");
  assert.ok(result.warnings.some((warning) => warning.code === "PROCESSING_OBSERVATION_FAILED"));
  // 写入已提交且是干净的一步 Undo；调用方绝不应据此重试写入。
  assert.equal(model.notes[0].lyrics, "ka");
  assert.equal(model.undoCount, 2);
  assert.equal(result.undo.expectedUserUndoSteps, 1);
});

test("sv_patch_notes no_change keeps the context valid for reuse", async () => {
  const { model, snapshots, service, snapshot } = await createFixture();
  const noop = await service.patchNotes({
    contextId: snapshot.contextId,
    waitFor: "none",
    patches: [{ note: nid(snapshot, 0), set: { lyrics: "a" } }],
  });
  assert.equal(noop.status, "no_change");
  // 没有写入发生，context 仍然准确；不应强迫调用方重新快照。
  assert.ok(snapshots.store.get(snapshot.contextId));

  const real = await service.patchNotes({
    contextId: snapshot.contextId,
    waitFor: "none",
    patches: [{ note: nid(snapshot, 0), set: { lyrics: "ka" } }],
  });
  assert.equal(real.ok, true);
  assert.equal(model.notes[0].lyrics, "ka");
});

test("sv_patch_notes tolerates float32 quantization on detune and attribute floats", async () => {
  const { model, service, snapshot } = await createFixture();
  // 模拟宿主以 float32 存储浮点：写入即量化，读回与请求值在第 7 位有效数字附近偏离。
  const originalCall = model.host.call;
  model.host.call = async (request) => {
    const noteIndex = model.handles.notes.findIndex(
      (note) => note.__handle__ === request.handle?.__handle__
    );
    if (noteIndex >= 0 && request.method === "setDetune") {
      model.notes[noteIndex].detune = Math.fround(request.args[0]);
      return null;
    }
    if (noteIndex >= 0 && request.method === "setAttributes") {
      const quantized = {};
      for (const [key, value] of Object.entries(request.args[0])) {
        quantized[key] = typeof value === "number" ? Math.fround(value) : value;
      }
      model.notes[noteIndex].attributes = {
        ...model.notes[noteIndex].attributes,
        ...quantized,
      };
      return null;
    }
    return originalCall(request);
  };
  const result = await service.patchNotes({
    contextId: snapshot.contextId,
    waitFor: "none",
    patches: [
      { note: nid(snapshot, 0), set: { detuneCents: -7.3, attributes: { tF0Offset: 0.1 } } },
    ],
  });

  // 量化误差在容差内：读回验证通过，不误触发回滚。
  assert.equal(result.ok, true);
  assert.equal(result.status, "succeeded");
  assert.equal(result.verification.passed, true);
  assert.equal(model.notes[0].detune, Math.fround(-7.3));
  assert.equal(model.notes[0].attributes.tF0Offset, Math.fround(0.1));
  assert.equal(model.notes[0].attributes.dur, 1);
});
