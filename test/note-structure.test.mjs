import assert from "node:assert/strict";
import test from "node:test";

import { ArtifactStore, planReference } from "../server/src/artifact-store.js";
import { NoteStructureService } from "../server/src/note-structure.js";
import { buildPlanArtifact, buildPlanContextSnapshot } from "../server/src/plan-reference.js";
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
    ignoreSetters: new Set(),
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
        if (model.ignoreSetters.has(method)) return null;
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

// 身份就是组内 index（§3.1）；保留 helper 让测试改动最小、意图仍可读。
const nid = (_snapshot, index) => index;

test("sv_restructure_notes dryRun plans without side effects", async () => {
  const { model, service, snapshot } = await createFixture();
  const result = await service.restructureNotes({
    contextId: snapshot.contextId,
    dryRun: true,
    operations: [
      { op: "insert", note: { onsetBlick: 3 * Q, durationBlick: Q, pitch: 65, lyrics: "e" } },
      { op: "delete", noteIndex: nid(snapshot, 0) },
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
    operations: [{ op: "delete", noteIndex: nid(snapshot, 1), expected: { lyrics: "wrong" } }],
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.error.code, "EXPECTED_MISMATCH");
  assert.equal(model.groupNotes.length, 3);

  const result = await service.restructureNotes({
    contextId: snapshot.contextId,
    waitFor: "none",
    operations: [{ op: "delete", noteIndex: nid(snapshot, 1), expected: { lyrics: "i" } }],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(model.groupLyrics(), ["a", "u"]);
});

test("sv_restructure_notes splits a note with an extender second half", async () => {
  const { model, service, snapshot } = await createFixture();
  const result = await service.restructureNotes({
    contextId: snapshot.contextId,
    waitFor: "none",
    operations: [{ op: "split", noteIndex: nid(snapshot, 0), atBlick: Q / 4 }],
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
      { op: "merge", notes: [nid(snapshot, 0), nid(snapshot, 1)], lyricsJoin: "concat" },
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
    operations: [{ op: "merge", notes: [nid(snapshot, 0), nid(snapshot, 2)] }],
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
      { op: "delete", noteIndex: nid(snapshot, 1) },
      { op: "split", noteIndex: nid(snapshot, 2), atBlick: 2 * Q + Q / 2 },
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
    operations: [{ op: "delete", noteIndex: nid(snapshot, 0) }],
  });
  assert.equal(result.ok, true);
  assert.equal(snapshots.store.get(snapshot.contextId), null);
});

test("sv_restructure_notes detects silently ignored setters via field read-back", async () => {
  const { model, service, snapshot } = await createFixture();
  // 宿主静默忽略 setDuration：merge 后 first 时长不变，仅数量验证会漏掉。
  model.ignoreSetters.add("setDuration");
  const result = await service.restructureNotes({
    contextId: snapshot.contextId,
    waitFor: "none",
    operations: [{ op: "merge", notes: [nid(snapshot, 0), nid(snapshot, 1)] }],
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "POSTCONDITION_FAILED");
  assert.ok(result.verification.evidence.fieldMismatches.some((entry) => entry.getter === "getDuration"));
  // setter 从未生效，补偿读回等于旧值 → rolled_back。
  assert.equal(result.status, "rolled_back");
  assert.equal(model.groupNotes.length, 3);
  assert.deepEqual(model.groupLyrics(), ["a", "i", "u"]);
});

test("sv_restructure_notes rolls back when the verification getter throws", async () => {
  const { model, service, snapshot } = await createFixture();
  // 注入点：快照后 getNumNotes 依次是 initialNoteCount(1) → verify(2)。
  model.failures.push({ method: "getNumNotes", remainingSkips: 1, code: "UNKNOWN_HANDLE" });
  const result = await service.restructureNotes({
    contextId: snapshot.contextId,
    operations: [{ op: "delete", noteIndex: nid(snapshot, 0) }],
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "rolled_back");
  assert.equal(result.error.code, "UNKNOWN_HANDLE");
  assert.equal(result.rollback.verified, true);
  assert.equal(model.groupNotes.length, 3);
  assert.equal(model.undoCount, 2);
});

test("sv_restructure_notes verifies inserted phoneme and language overrides", async () => {
  const { model, service, snapshot } = await createFixture();
  model.ignoreSetters.add("setPhonemes");
  const result = await service.restructureNotes({
    contextId: snapshot.contextId,
    waitFor: "none",
    operations: [
      {
        op: "insert",
        note: {
          onsetBlick: 5 * Q,
          durationBlick: Q,
          pitch: 65,
          lyrics: "e",
          phonemesOverride: "e h",
          languageOverride: "japanese",
        },
      },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "POSTCONDITION_FAILED");
  assert.ok(
    result.verification.evidence.fieldMismatches.some((entry) => entry.getter === "getPhonemes")
  );
  assert.equal(result.status, "rolled_back");
  assert.equal(model.groupNotes.length, 3);
});

// range context fixture：结构与 sv_snapshot_range prepareStoredRange 存储的 occurrence 一致。
function createRangeFixture({
  shared = false,
  extraOccurrence = false,
  artifactStore = null,
  sessionId = null,
} = {}) {
  const model = createStructureModel();
  const session = { withExclusive: (task) => task(model.host) };
  const snapshots = new SnapshotService(session, {
    store: new SnapshotStore({ now: () => 1000 }),
    now: () => 1000,
  });
  const service = new NoteStructureService(session, snapshots, {
    sleepFn: async () => {},
    now: () => 1000,
    artifactStore,
    sessionId,
  });
  const entry = snapshots.store.create({
    epoch: 1,
    scope: { kind: "range" },
    observedAt: new Date(1000).toISOString(),
    context: { kind: "range", occurrences: [] },
  });
  const occurrenceId = `${entry.contextId}:t:0:r:0`;
  const secondOccurrenceId = `${entry.contextId}:t:1:r:0`;
  const noteFingerprints = model.groupNotes.map((id, index) => {
    const state = model.states.get(id);
    return {
      noteId: `${occurrenceId}:n:${index}`,
      indexInGroup: index,
      onsetBlick: state.onset,
      durationBlick: state.duration,
      pitch: state.pitch,
      lyrics: state.lyrics,
      phonemesOverride: state.phonemes,
      languageOverride: state.language,
      detuneCents: state.detune,
    };
  });
  entry.context.occurrences.push({
    occurrenceId,
    trackIndex: 0,
    groupIndex: 0,
    targetGroupUuid: "group-1",
    timeOffsetBlick: 0,
    sharedTargetOccurrences: shared ? [occurrenceId, secondOccurrenceId] : [occurrenceId],
    noteFingerprints,
  });
  if (extraOccurrence) {
    entry.context.occurrences.push({
      occurrenceId: secondOccurrenceId,
      trackIndex: 1,
      groupIndex: 0,
      targetGroupUuid: "group-1",
      timeOffsetBlick: 0,
      sharedTargetOccurrences: [],
      noteFingerprints: [],
    });
  }
  return { model, snapshots, service, entry, contextId: entry.contextId, occurrenceId };
}

test("sv_restructure_notes expands a planRef through its capsule without touching the store", async () => {
  const sessionId = "sess_structure_plan";
  const artifactStore = new ArtifactStore({ now: () => 1000 });
  const { model, snapshots, service, entry, contextId, occurrenceId } = createRangeFixture({
    artifactStore,
    sessionId,
  });
  const occurrence = entry.context.occurrences[0];
  const { payload } = buildPlanArtifact({
    targetTool: "sv_restructure_notes",
    mutationRequest: {
      contextId,
      occurrenceId,
      operations: [
        {
          op: "insert",
          note: { onsetBlick: 3 * Q, durationBlick: Q, pitch: 67, lyrics: "go" },
        },
      ],
      dryRun: true,
      atomic: true,
    },
    targetGroupUuid: occurrence.targetGroupUuid,
    occurrenceId,
    contextSnapshot: buildPlanContextSnapshot(entry, occurrence),
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
  snapshots.store.delete(contextId);

  const result = await service.restructureNotes({
    planRef: reference,
    action: "dry_run",
  });
  assert.equal(result.status, "dry_run");
  assert.equal(result.data.expectedNoteCount, 4);
  assert.equal(model.groupNotes.length, 3);
  // capsule 是只读证据，绝不写回 store：写回会让它被别人查到、被 LRU 淘汰，
  // 并与真实快照混淆（§4.3.2）。
  assert.equal(snapshots.store.get(contextId), null);
});

test("sv_restructure_notes accepts a range context and resolves notes by group index", async () => {
  const { model, snapshots, service, contextId, occurrenceId } = createRangeFixture();
  const result = await service.restructureNotes({
    contextId,
    operations: [
      { op: "split", noteIndex: 1, atBlick: Q + Q / 2 },
      { op: "delete", noteIndex: 2 },
    ],
    waitFor: "none",
  });

  assert.equal(result.ok, true);
  assert.equal(result.effects, "verified");
  // split +1、delete -1：数量不变，但第二个音符被拆为两半。
  assert.equal(result.data.finalNoteCount, 3);
  assert.deepEqual(model.groupLyrics(), ["a", "i", "-"]);
  assert.equal(model.undoCount, 2);
  assert.equal(snapshots.store.get(contextId), null);
});

test("sv_restructure_notes insert-only on a multi-occurrence range needs occurrenceId", async () => {
  const { model, service, contextId, occurrenceId } = createRangeFixture({
    extraOccurrence: true,
  });
  const ambiguous = await service.restructureNotes({
    contextId,
    operations: [{ op: "insert", note: { onsetBlick: 3 * Q, durationBlick: Q, pitch: 67 } }],
    waitFor: "none",
  });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.error.code, "AMBIGUOUS_CONTEXT");
  assert.deepEqual(ambiguous.error.details.candidateOccurrences, [
    occurrenceId,
    `${contextId}:t:1:r:0`,
  ]);
  assert.equal(model.groupNotes.length, 3);

  const explicit = await service.restructureNotes({
    contextId,
    occurrenceId,
    operations: [{ op: "insert", note: { onsetBlick: 3 * Q, durationBlick: Q, pitch: 67, lyrics: "go" } }],
    allowSharedTargetMutation: true,
    waitFor: "none",
  });
  assert.equal(explicit.ok, true);
  assert.equal(model.groupNotes.length, 4);
});

test("sv_restructure_notes range context enforces shared-target confirmation", async () => {
  const { model, service, contextId, occurrenceId } = createRangeFixture({ shared: true });
  const refused = await service.restructureNotes({
    contextId,
    operations: [{ op: "delete", noteIndex: 0 }],
    waitFor: "none",
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "SHARED_TARGET_REQUIRES_CONFIRMATION");
  assert.ok(Array.isArray(refused.error.details.projectTargetOccurrences));
  assert.equal(model.groupNotes.length, 3);
  assert.equal(model.undoCount, 0);

  const confirmed = await service.restructureNotes({
    contextId,
    operations: [{ op: "delete", noteIndex: 0 }],
    allowSharedTargetMutation: true,
    waitFor: "none",
  });
  assert.equal(confirmed.ok, true);
  assert.deepEqual(model.groupLyrics(), ["i", "u"]);
});

test("sv_restructure_notes rejects a merge whose notes stopped being adjacent after an earlier insert", async () => {
  const { model, service, snapshot } = await createFixture();
  // 同请求先 insert 一个落在 n0/n1 之间的音符：计划期指纹判定 n0/n1 相邻，
  // 执行期活动 index 已变为 1 和 3。旧实现会把新音符静默埋进合并时值并报 succeeded。
  const result = await service.restructureNotes({
    contextId: snapshot.contextId,
    waitFor: "none",
    operations: [
      { op: "insert", note: { onsetBlick: Q / 2, durationBlick: Q / 4, pitch: 61, lyrics: "n" } },
      { op: "merge", notes: [nid(snapshot, 0), nid(snapshot, 1)] },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "rolled_back");
  assert.equal(result.error.code, "INVALID_ARGUMENTS");
  assert.match(result.error.message, /no longer consecutive at execution time/);
  assert.equal(result.rollback.verified, true);
  // 组恢复原状：3 个原始音符，时值/歌词未被合并破坏。
  assert.equal(model.groupNotes.length, 3);
  assert.deepEqual(model.groupLyrics(), ["a", "i", "u"]);
  assert.equal(model.states.get(model.groupNotes[0]).duration, Q);
  assert.equal(model.undoCount, 2);
});

test("sv_restructure_notes keeps verified success when post-commit processing observation fails", async () => {
  const { model, service, snapshot } = await createFixture();
  // 结构写入与读回验证完成、Undo 边界关闭后，处理观测失败只降级 processing 子结果。
  model.failures.push({
    method: "getPhonemesForGroup",
    remainingSkips: 0,
    code: "HOST_TIMEOUT",
    message: "Timeout waiting for SynthV bridge",
  });
  const result = await service.restructureNotes({
    contextId: snapshot.contextId,
    waitFor: "phonemes",
    timeoutMs: 100,
    pollIntervalMs: 20,
    operations: [
      { op: "split", noteIndex: nid(snapshot, 0), atBlick: Q / 2, secondLyrics: "-" },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "processing_observation_failed");
  assert.equal(result.effects, "verified");
  assert.equal(result.verification.passed, true);
  assert.equal(result.data.processing.state, "unknown");
  assert.equal(result.data.processing.error.code, "HOST_TIMEOUT");
  assert.ok(result.warnings.some((warning) => warning.code === "PROCESSING_OBSERVATION_FAILED"));
  // 拆分已提交且验证通过：4 个音符、一步干净 Undo。
  assert.equal(model.groupNotes.length, 4);
  assert.equal(model.undoCount, 2);
});
