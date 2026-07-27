import assert from "node:assert/strict";
import test from "node:test";

import { SelectionService } from "../server/src/selection.js";
import { SnapshotStore } from "../server/src/snapshot.js";

// P1-E 验收：高层 selection 必须以读回为准。
//
// 关键场景来自真实宿主观测：unselectNote() 改变了状态却返回 false。模型 host 默认
// 复现这一行为——若服务改用宿主 boolean 判定 changed，这些测试会立刻失败。

const Q = 705600000;

function createModel(options = {}) {
  const {
    noteCount = 6,
    lyingBooleans = true,
    selected = [],
    groupUuid = "uuid-selection",
  } = options;
  let nextHandle = 900;
  const handle = (type) => ({ __handle__: nextHandle++, __type__: type, __epoch__: 1 });
  const h = {
    project: handle("Project"),
    sv: handle("SV"),
    mainEditor: handle("MainEditorView"),
    selection: handle("TrackInnerSelectionState"),
    group: handle("NoteGroupReference"),
    target: handle("NoteGroup"),
  };
  const notes = Array.from({ length: noteCount }, (_, index) => ({
    handle: handle("Note"),
    indexInGroup: index,
    lyrics: `n${index}`,
    pitch: 60 + index,
    onsetBlick: index * Q,
    durationBlick: Q,
  }));
  const model = {
    handles: h,
    notes,
    selected: new Set(selected),
    calls: [],
    lyingBooleans,
    failOnGetNote: null,
  };

  model.host = {
    epoch: () => 1,
    roots: async () => ({ project: h.project, sv: h.sv, mainEditor: h.mainEditor }),
    free: async () => {},
    index: async () => null,
    call: async ({ handle: target, method, args = [] }) => {
      const id = target?.__handle__;
      model.calls.push(method);
      if (id === h.mainEditor.__handle__) {
        if (method === "getSelection") return h.selection;
        if (method === "getCurrentGroup") return h.group;
      }
      if (id === h.group.__handle__ && method === "getTarget") return h.target;
      if (id === h.target.__handle__) {
        if (method === "getUUID") return groupUuid;
        if (method === "getNumNotes") return model.notes.length;
        if (method === "getNote") {
          if (model.failOnGetNote !== null && args[0] - 1 === model.failOnGetNote) {
            const error = new Error("note vanished");
            error.code = "HOST_CALL_FAILED";
            throw error;
          }
          const note = model.notes[args[0] - 1];
          if (!note) throw new Error(`no note at native index ${args[0]}`);
          return note.handle;
        }
      }
      if (id === h.selection.__handle__) {
        if (method === "getSelectedNotes") {
          return [...model.selected]
            .sort((left, right) => left - right)
            .map((index) => model.notes[index].handle);
        }
        if (method === "clearNotes") {
          const had = model.selected.size > 0;
          model.selected.clear();
          // 宿主的返回值不可信：默认恒返回 false，即使状态确实变了。
          return model.lyingBooleans ? false : had;
        }
        if (method === "selectNote") {
          const note = model.notes.find((item) => item.handle.__handle__ === args[0].__handle__);
          const had = model.selected.has(note.indexInGroup);
          model.selected.add(note.indexInGroup);
          return model.lyingBooleans ? false : !had;
        }
        if (method === "unselectNote") {
          const note = model.notes.find((item) => item.handle.__handle__ === args[0].__handle__);
          const had = model.selected.has(note.indexInGroup);
          model.selected.delete(note.indexInGroup);
          // 这正是真实宿主上观察到的行为：状态改变，返回 false。
          return model.lyingBooleans ? false : had;
        }
      }
      const note = model.notes.find((item) => item.handle.__handle__ === id);
      if (note) {
        if (method === "getIndexInParent") return note.indexInGroup + 1;
        if (method === "getLyrics") return note.lyrics;
        if (method === "getPitch") return note.pitch;
        if (method === "getOnset") return note.onsetBlick;
        if (method === "getDuration") return note.durationBlick;
      }
      throw new Error(`unexpected call ${method} on handle ${id}`);
    },
  };
  return model;
}

function createService(model, store = new SnapshotStore({ now: () => 1000 })) {
  return {
    service: new SelectionService(
      { withExclusive: (task) => task(model.host) },
      { snapshotService: { store }, now: () => 2000 }
    ),
    store,
  };
}

// group/selection context：noteId 形如 ctx:n:<selectedIndex>，notes[] 携带 indexInGroup。
function createGroupContext(store, indices) {
  const stored = store.create({
    epoch: 1,
    scope: { kind: "group" },
    observedAt: new Date(1000).toISOString(),
    context: { kind: "group" },
    baseData: { group: { uuid: "uuid-selection" } },
    notes: indices.map((indexInGroup) => ({ indexInGroup })),
  });
  return stored;
}

function createRangeContext(store, indices, occurrenceSuffix = ":t:0:r:0") {
  const stored = store.create({
    epoch: 1,
    scope: { kind: "range" },
    observedAt: new Date(1000).toISOString(),
    context: { kind: "range", occurrences: [] },
  });
  const occurrenceId = `${stored.contextId}${occurrenceSuffix}`;
  stored.context.occurrences.push({
    occurrenceId,
    trackIndex: 0,
    groupIndex: 0,
    targetGroupUuid: "uuid-selection",
    timeOffsetBlick: 0,
    pitchOffsetSemitone: 0,
    sharedTargetOccurrences: [occurrenceId],
    noteFingerprints: indices.map((indexInGroup, position) => ({
      indexInGroup,
      onsetBlick: indexInGroup * Q,
      durationBlick: Q,
      pitch: 60 + indexInGroup,
      lyrics: `n${indexInGroup}`,
      phonemesOverride: "",
      languageOverride: "",
      detuneCents: 0,
      noteId: `${occurrenceId}:n:${position}`,
    })),
  });
  stored.context.quarterBlick = Q;
  return { stored, occurrenceId };
}

test("changed comes from read-back even when the host boolean lies", async () => {
  const model = createModel({ selected: [1, 2] });
  const { service } = createService(model);

  const result = await service.setSelection({ operation: "clear" });

  // 宿主对 clearNotes 返回 false，但读回证明选择确实被清空了。
  assert.equal(result.data.hostResults[0].hostReturn, false);
  assert.equal(result.changed, true);
  assert.deepEqual(result.data.before.indexInGroup, [1, 2]);
  assert.deepEqual(result.data.after.indexInGroup, []);
  assert.equal(result.provenance.changedBasis, "read_back_before_after_comparison_not_host_boolean");
  assert.ok(
    result.warnings.some((warning) => warning.code === "HOST_RETURN_DISAGREES_WITH_READBACK"),
    "a lying host boolean must be surfaced, not hidden"
  );
});

test("removing a note reports changed despite unselectNote returning false", async () => {
  const model = createModel({ selected: [0, 1, 2] });
  const { service } = createService(model);

  const result = await service.setSelection({ operation: "remove", indexInGroup: [1] });

  const unselect = result.data.hostResults.find((entry) => entry.action === "unselectNote");
  assert.equal(unselect.hostReturn, false, "the model must reproduce the real host's lie");
  assert.equal(result.changed, true);
  assert.deepEqual(result.data.after.indexInGroup, [0, 2]);
});

test("a genuine no-op reports changed:false without a contradiction warning", async () => {
  const model = createModel({ selected: [0, 3] });
  const { service } = createService(model);

  // 已选中的音符再 add 一次：状态不变。
  const result = await service.setSelection({ operation: "add", indexInGroup: [0, 3] });

  assert.equal(result.changed, false);
  assert.deepEqual(result.data.after.indexInGroup, [0, 3]);
  // 宿主也说 false，两者一致，不应发出矛盾警告。
  assert.ok(!result.warnings.some((warning) => warning.code === "HOST_RETURN_DISAGREES_WITH_READBACK"));
});

test("select replaces the selection while add extends it", async () => {
  const replaceModel = createModel({ selected: [0, 1] });
  const replace = await createService(replaceModel).service.setSelection({
    operation: "select",
    indexInGroup: [4],
  });
  assert.deepEqual(replace.data.after.indexInGroup, [4]);
  assert.equal(replace.data.hostResults[0].action, "clearNotes");

  const addModel = createModel({ selected: [0, 1] });
  const add = await createService(addModel).service.setSelection({
    operation: "add",
    indexInGroup: [4],
  });
  assert.deepEqual(add.data.after.indexInGroup, [0, 1, 4]);
  assert.ok(!add.data.hostResults.some((entry) => entry.action === "clearNotes"));
});

test("selection never creates an Undo record", async () => {
  const model = createModel({ selected: [] });
  const { service } = createService(model);
  const result = await service.setSelection({ operation: "add", indexInGroup: [2] });

  assert.equal(result.undo.recordCreated, false);
  assert.equal(result.undo.reason, "selection_is_ui_state");
  // 官方 API 本就不为 selection 建 Undo：绝不能调用 newUndoRecord。
  assert.ok(!model.calls.includes("newUndoRecord"));
});

test("group-context noteIds resolve through the stored indexInGroup", async () => {
  const model = createModel({ selected: [] });
  const store = new SnapshotStore({ now: () => 1000 });
  const { service } = createService(model, store);
  // 选择区快照里第 0、1 项分别是 group 内的第 2、5 个音符。
  const stored = createGroupContext(store, [2, 5]);

  const result = await service.setSelection({
    operation: "select",
    contextId: stored.contextId,
    noteIds: [`${stored.contextId}:n:0`, `${stored.contextId}:n:1`],
  });

  assert.deepEqual(result.data.requestedPositions, [2, 5]);
  assert.deepEqual(result.data.after.indexInGroup, [2, 5]);
  assert.deepEqual(
    result.data.notes.map((note) => note.lyrics),
    ["n2", "n5"]
  );
});

test("range-context noteIds resolve and can be narrowed by occurrenceId", async () => {
  const model = createModel({ selected: [] });
  const store = new SnapshotStore({ now: () => 1000 });
  const { service } = createService(model, store);
  const { stored, occurrenceId } = createRangeContext(store, [1, 3, 4]);

  const result = await service.setSelection({
    operation: "select",
    contextId: stored.contextId,
    occurrenceId,
    noteIds: [`${occurrenceId}:n:0`, `${occurrenceId}:n:2`],
  });

  assert.deepEqual(result.data.requestedPositions, [1, 4]);
  assert.deepEqual(result.data.after.indexInGroup, [1, 4]);

  await assert.rejects(
    () =>
      service.setSelection({
        operation: "select",
        contextId: stored.contextId,
        occurrenceId: `${stored.contextId}:t:9:r:9`,
        noteIds: [`${occurrenceId}:n:0`],
      }),
    (error) => error.code === "UNKNOWN_NOTE_ID"
  );
});

test("context noteIds reject a different current editor group before selection changes", async () => {
  const model = createModel({ selected: [1], groupUuid: "uuid-current-editor" });
  const { service, store } = createService(model);
  const { stored, occurrenceId } = createRangeContext(store, [1, 2]);

  await assert.rejects(
    () =>
      service.setSelection({
        operation: "select",
        contextId: stored.contextId,
        occurrenceId,
        noteIds: [`${occurrenceId}:n:1`],
      }),
    (error) =>
      error.code === "CURRENT_GROUP_MISMATCH" &&
      error.details?.expectedGroupUuid === "uuid-selection" &&
      error.details?.observedGroupUuid === "uuid-current-editor"
  );
  assert.deepEqual([...model.selected], [1], "a target mismatch must not mutate selection");
  assert.equal(
    model.calls.includes("clearNotes"),
    false,
    "identity validation must precede selection mutation"
  );
});

test("a note index beyond the live group fails instead of selecting the wrong note", async () => {
  // 快照记录了 group 内第 9 个音符，但宿主现在只有 6 个：结构漂移必须失败。
  const model = createModel({ noteCount: 6 });
  const store = new SnapshotStore({ now: () => 1000 });
  const { service } = createService(model, store);
  const stored = createGroupContext(store, [9]);

  await assert.rejects(
    () =>
      service.setSelection({
        operation: "select",
        contextId: stored.contextId,
        noteIds: [`${stored.contextId}:n:0`],
      }),
    (error) => error.code === "NOTE_INDEX_OUT_OF_RANGE"
  );
  await assert.rejects(
    () => service.setSelection({ operation: "add", indexInGroup: [42] }),
    (error) => error.code === "NOTE_INDEX_OUT_OF_RANGE"
  );
});

test("duplicate targets collapse with a warning", async () => {
  const model = createModel({ selected: [] });
  const { service } = createService(model);
  const result = await service.setSelection({ operation: "select", indexInGroup: [3, 3, 1] });

  assert.deepEqual(result.data.requestedPositions, [1, 3]);
  assert.ok(result.warnings.some((warning) => warning.code === "DUPLICATE_SELECTION_TARGETS"));
});

test("an expired context is rejected rather than silently ignored", async () => {
  const model = createModel({ selected: [] });
  const { service } = createService(model);
  await assert.rejects(
    () =>
      service.setSelection({
        operation: "select",
        contextId: "ctx_gone",
        noteIds: ["ctx_gone:n:0"],
      }),
    (error) => error.code === "UNKNOWN_CONTEXT"
  );
});

test("malformed requests are rejected before touching the host", async () => {
  const model = createModel({ selected: [] });
  const { service } = createService(model);
  const cases = [
    {},
    { operation: "toggle" },
    { operation: "clear", indexInGroup: [0] },
    { operation: "select" },
    { operation: "select", indexInGroup: [0], noteIds: ["x"] },
    { operation: "select", noteIds: ["x"] },
    { operation: "select", indexInGroup: [] },
    { operation: "select", indexInGroup: [-1] },
    { operation: "select", indexInGroup: [0], contextId: "ctx_x" },
    { operation: "select", contextId: "ctx_x", noteIds: [] },
    { operation: "select", unknownField: true },
  ];
  for (const request of cases) {
    await assert.rejects(
      () => service.setSelection(request),
      (error) => error.code === "INVALID_ARGUMENTS",
      `expected INVALID_ARGUMENTS for ${JSON.stringify(request)}`
    );
  }
  assert.equal(model.calls.length, 0, "validation must happen before any host call");
});

test("an honest host that reports change truthfully produces no contradiction warning", async () => {
  const model = createModel({ selected: [0], lyingBooleans: false });
  const { service } = createService(model);
  const result = await service.setSelection({ operation: "add", indexInGroup: [2] });

  assert.equal(result.changed, true);
  assert.ok(result.data.hostResults.some((entry) => entry.hostReturn === true));
  assert.ok(!result.warnings.some((warning) => warning.code === "HOST_RETURN_DISAGREES_WITH_READBACK"));
});
