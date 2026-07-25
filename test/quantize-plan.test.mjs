import assert from "node:assert/strict";
import test from "node:test";

import { QuantizePlanService } from "../server/src/quantize-plan.js";
import { SnapshotStore } from "../server/src/snapshot.js";

const Q = 705600000;
const BAR_4_4 = 4 * Q;

function createStore() {
  return new SnapshotStore({ now: () => 1000 });
}

function createStoredContext(store, options = {}) {
  const {
    notes = [],
    meterMarks = [{ position: 0, positionBlick: 0, numerator: 4, denominator: 4 }],
    timeOffsetBlick = 0,
    extraOccurrenceWithNotes = false,
    uuid = "uuid-quantize-test",
  } = options;
  const stored = store.create({
    epoch: 1,
    scope: { kind: "range" },
    observedAt: new Date(1000).toISOString(),
    context: { kind: "range", occurrences: [] },
  });
  const occurrenceId = `${stored.contextId}:t:0:r:0`;
  const noteFingerprints = notes.map((note, index) => ({
    indexInGroup: index,
    onsetBlick: note.onsetBlick,
    durationBlick: note.durationBlick,
    pitch: note.pitch ?? 60,
    lyrics: note.lyrics ?? `n${index}`,
    phonemesOverride: "",
    languageOverride: "",
    detuneCents: 0,
    noteId: `${occurrenceId}:n:${index}`,
  }));
  stored.context.occurrences.push({
    occurrenceId,
    trackIndex: 0,
    groupIndex: 0,
    targetGroupUuid: uuid,
    timeOffsetBlick,
    pitchOffsetSemitone: 0,
    sharedTargetOccurrences: [occurrenceId],
    noteFingerprints,
  });
  if (extraOccurrenceWithNotes) {
    const secondId = `${stored.contextId}:t:0:r:1`;
    stored.context.occurrences.push({
      occurrenceId: secondId,
      trackIndex: 0,
      groupIndex: 1,
      targetGroupUuid: uuid,
      timeOffsetBlick,
      pitchOffsetSemitone: 0,
      sharedTargetOccurrences: [occurrenceId, secondId],
      noteFingerprints: noteFingerprints.map((fingerprint, index) => ({
        ...fingerprint,
        noteId: `${secondId}:n:${index}`,
      })),
    });
  }
  stored.context.quarterBlick = Q;
  stored.context.meterMarks = meterMarks;
  stored.context.tempoMarks = [{ positionBlick: 0, positionSeconds: 0, bpm: 120 }];
  return { stored, occurrenceId };
}

function createService(store) {
  return new QuantizePlanService({ store, now: () => 2000 });
}

test("full-strength 1/8 quantization snaps offsets and emits expected preconditions", async () => {
  const store = createStore();
  const { stored, occurrenceId } = createStoredContext(store, {
    notes: [
      { onsetBlick: Q / 8, durationBlick: Q }, // → 0
      { onsetBlick: Q + Q / 5, durationBlick: Q }, // → Q
      { onsetBlick: 2.4 * Q, durationBlick: Q }, // → 2.5Q（1/8 网格）
      { onsetBlick: 3 * Q, durationBlick: Q }, // 已在格上：no change
    ],
  });
  const result = await createService(store).plan({
    contextId: stored.contextId,
    grid: { division: "1/8" },
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "planned");
  assert.equal(result.effects, "none");
  assert.equal(result.summary.noteCount, 4);
  assert.equal(result.summary.changedCount, 3);
  assert.deepEqual(
    result.perNote.map((item) => item.plannedOnsetBlick),
    [0, Q, 2.5 * Q, 3 * Q]
  );
  const patch = result.patchRequest;
  assert.equal(patch.tool, "sv_patch_notes");
  assert.equal(patch.arguments.contextId, stored.contextId);
  assert.equal(patch.arguments.patches.length, 3);
  const first = patch.arguments.patches[0];
  assert.equal(first.noteId, `${occurrenceId}:n:0`);
  assert.deepEqual(first.expected, { onsetBlick: Q / 8, durationBlick: Q });
  assert.deepEqual(first.set, { onsetBlick: 0 });
  assert.equal(result.provenance.humanize, "not_provided_conflicts_with_deterministic_planner_contract");
});

test("strength interpolates linearly toward the grid target", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, {
    notes: [{ onsetBlick: Q + Q / 2, durationBlick: Q }], // 1/4 网格目标可为 Q 或 2Q（round 取偶入 2Q）
  });
  const result = await createService(store).plan({
    contextId: stored.contextId,
    grid: { division: "1/4" },
    strength: 0.5,
  });
  // 目标 2Q，delta = Q/2，strength 0.5 → 移动 Q/4。
  assert.equal(result.perNote[0].plannedOnsetBlick, 1.5 * Q + Q / 4);
});

test("triplet grids quantize to third-of-beat positions", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, {
    notes: [{ onsetBlick: Math.round(Q / 3) + 1000, durationBlick: Q / 4 }],
  });
  const result = await createService(store).plan({
    contextId: stored.contextId,
    grid: { division: "1/8T" },
  });
  // 1/8T = 3 格/拍：目标是 barLength/12 的整数倍 = Q/3 处。
  assert.equal(result.perNote[0].plannedOnsetBlick, Math.round((BAR_4_4 / 12) * 1));
});

test("swing shifts odd grid slots late by swing×half-step", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, {
    notes: [
      { onsetBlick: 0, durationBlick: Q / 4 }, // 偶数格：不动
      { onsetBlick: Q / 2, durationBlick: Q / 4 }, // 奇数格（1/8 网格 index 1）
    ],
  });
  const result = await createService(store).plan({
    contextId: stored.contextId,
    grid: { division: "1/8" },
    swing: 0.5,
  });
  assert.equal(result.perNote[0].plannedOnsetBlick, 0);
  // step = Q/2，swing 0.5 → 后移 0.5*step/2 = Q/8。
  assert.equal(result.perNote[1].plannedOnsetBlick, Q / 2 + Q / 8);
  // swing + 三连音直接拒绝。
  await assert.rejects(
    createService(store).plan({
      contextId: stored.contextId,
      grid: { division: "1/8T" },
      swing: 0.3,
    }),
    (error) => error.code === "INVALID_ARGUMENTS"
  );
});

test("the grid re-anchors at meter changes", async () => {
  const store = createStore();
  // 小节 0 为 4/4，小节 1 起 3/4。3/4 段第 2 拍附近的音符必须按 3/4 小节起点对齐。
  const { stored } = createStoredContext(store, {
    meterMarks: [
      { position: 0, positionBlick: 0, numerator: 4, denominator: 4 },
      { position: 1, positionBlick: BAR_4_4, numerator: 3, denominator: 4 },
    ],
    notes: [{ onsetBlick: BAR_4_4 + Q + Q / 8, durationBlick: Q / 2 }],
  });
  const result = await createService(store).plan({
    contextId: stored.contextId,
    grid: { division: "1/4" },
  });
  assert.equal(result.perNote[0].plannedOnsetBlick, BAR_4_4 + Q);
});

test("colliding notes keep their original onset with a warning", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, {
    notes: [
      { onsetBlick: Q - Q / 8, durationBlick: Q / 8 }, // → Q
      { onsetBlick: Q + Q / 8, durationBlick: Q / 2 }, // → Q 碰撞 → 保留原位
    ],
  });
  const result = await createService(store).plan({
    contextId: stored.contextId,
    grid: { division: "1/4" },
  });
  assert.equal(result.perNote[0].plannedOnsetBlick, Q);
  assert.equal(result.perNote[1].plannedOnsetBlick, Q + Q / 8);
  assert.equal(result.perNote[1].onsetReverted, true);
  assert.equal(result.perNote[1].revertReason, "collision");
  assert.ok(result.warnings.some((warning) => warning.code === "QUANTIZE_COLLISION"));
  assert.equal(result.summary.revertedCount, 1);
  assert.equal(result.review.requiresHumanReview, true);
});

test("onset changes that introduce overlaps are reverted unless durations are quantized", async () => {
  const store = createStore();
  const notes = [
    { onsetBlick: 0, durationBlick: 2 * Q + Q / 8 }, // 到 2.125Q（略过网格线）
    { onsetBlick: 2 * Q + Q / 3, durationBlick: Q }, // 1/4 网格 → 2Q，会左移进前音
  ];
  const first = createStoredContext(store, { notes });
  const reverted = await createService(store).plan({
    contextId: first.stored.contextId,
    grid: { division: "1/4" },
  });
  // 后音左移引入重叠（原本 2.125Q < 2.333Q 不重叠）→ 撤销后音。
  assert.equal(reverted.perNote[1].plannedOnsetBlick, 2 * Q + Q / 3);
  assert.equal(reverted.perNote[1].revertReason, "overlap");
  assert.ok(reverted.warnings.some((warning) => warning.code === "OVERLAP_AFTER_QUANTIZE"));

  const second = createStoredContext(store, { notes });
  const trimmed = await createService(store).plan({
    contextId: second.stored.contextId,
    grid: { division: "1/4" },
    quantizeDurations: true,
  });
  // quantizeDurations：后音吸到 2Q，前音时值吸到 2Q（恰好消除重叠）。
  assert.equal(trimmed.perNote[1].plannedOnsetBlick, 2 * Q);
  assert.equal(trimmed.perNote[0].plannedDurationBlick, 2 * Q);
  assert.ok(!trimmed.warnings.some((warning) => warning.code === "OVERLAP_AFTER_QUANTIZE"));
});

test("set.onsetBlick is written in group-local coordinates when the occurrence has a time offset", async () => {
  const store = createStore();
  const offset = 2 * BAR_4_4;
  const { stored } = createStoredContext(store, {
    timeOffsetBlick: offset,
    // 组内本地 onset Q/8 → 绝对 offset+Q/8 → 吸附到绝对 offset（恰在小节边界）→ 本地 0。
    notes: [{ onsetBlick: Q / 8, durationBlick: Q }],
  });
  const result = await createService(store).plan({
    contextId: stored.contextId,
    grid: { division: "1/4" },
  });
  assert.equal(result.perNote[0].originalOnsetBlick, offset + Q / 8);
  assert.equal(result.perNote[0].plannedOnsetBlick, offset);
  const patch = result.patchRequest.arguments.patches[0];
  assert.deepEqual(patch.expected, { onsetBlick: Q / 8, durationBlick: Q });
  assert.deepEqual(patch.set, { onsetBlick: 0 });
});

test("already-quantized ranges report no_change without a patchRequest", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, {
    notes: [
      { onsetBlick: 0, durationBlick: Q },
      { onsetBlick: Q, durationBlick: Q },
    ],
  });
  const result = await createService(store).plan({
    contextId: stored.contextId,
    grid: { division: "1/4" },
  });
  assert.equal(result.status, "no_change");
  assert.equal(result.patchRequest, null);
  assert.equal(result.continuation, undefined);
});

test("plans above the patch cap return the first 200 plus a continuation workflow", async () => {
  const store = createStore();
  const count = 201;
  const notes = Array.from({ length: count }, (_, index) => ({
    onsetBlick: index * Q + Q / 8, // 全部偏移 1/8 拍
    durationBlick: Q / 2,
  }));
  const { stored } = createStoredContext(store, { notes });
  const result = await createService(store).plan({
    contextId: stored.contextId,
    grid: { division: "1/4" },
  });
  assert.equal(result.summary.changedCount, count);
  assert.equal(result.patchRequest.arguments.patches.length, 200);
  assert.equal(result.continuation.reason, "PATCH_CAP");
  assert.equal(result.continuation.remainingChangedCount, 1);
  assert.ok(result.warnings.some((warning) => warning.code === "PLAN_EXCEEDS_PATCH_CAP"));
});

test("the continuation loop converges across simulated commit/re-snapshot rounds", async () => {
  const store = createStore();
  const count = 201;
  const buildNotes = (applied) =>
    Array.from({ length: count }, (_, index) => ({
      onsetBlick: index * Q + (index < applied ? 0 : Q / 8),
      durationBlick: Q / 2,
    }));
  const service = createService(store);
  const options = { grid: { division: "1/4" } };

  const round1 = createStoredContext(store, { notes: buildNotes(0) });
  const first = await service.plan({
    contextId: round1.stored.contextId,
    occurrenceId: round1.occurrenceId,
    ...options,
  });
  assert.equal(first.patchRequest.arguments.patches.length, 200);
  assert.equal(first.continuation.remainingChangedCount, 1);

  // 模拟提交：前 200 项已应用，context 失效，重拍快照产生新 contextId。
  store.delete(round1.stored.contextId);
  const round2 = createStoredContext(store, { notes: buildNotes(200) });
  // 同参重跑（携带旧 occurrenceId）：短期身份记录证明同一 target UUID 后按位置重锚定。
  const second = await service.plan({
    contextId: round2.stored.contextId,
    occurrenceId: round1.occurrenceId,
    ...options,
  });
  assert.ok(second.warnings.some((warning) => warning.code === "STALE_SELECTOR_REANCHORED"));
  assert.equal(second.patchRequest.arguments.patches.length, 1);
  // 续轮 patch 引用新 occurrence 的 noteId（预烤批次不可能提前知道）。
  assert.ok(
    second.patchRequest.arguments.patches[0].noteId.startsWith(round2.stored.contextId)
  );
  assert.equal(second.continuation, undefined);

  store.delete(round2.stored.contextId);
  const round3 = createStoredContext(store, { notes: buildNotes(201) });
  const third = await service.plan({
    contextId: round3.stored.contextId,
    occurrenceId: round3.occurrenceId,
    ...options,
  });
  assert.equal(third.status, "no_change");
});

test("a reanchored selector is rejected when the target group UUID changed", async () => {
  const store = createStore();
  const count = 201;
  const notes = Array.from({ length: count }, (_, index) => ({
    onsetBlick: index * Q + Q / 8,
    durationBlick: Q / 2,
  }));
  const service = createService(store);
  const round1 = createStoredContext(store, { notes, uuid: "uuid-original" });
  await service.plan({
    contextId: round1.stored.contextId,
    occurrenceId: round1.occurrenceId,
    grid: { division: "1/4" },
  });
  store.delete(round1.stored.contextId);
  const round2 = createStoredContext(store, { notes, uuid: "uuid-different" });
  await assert.rejects(
    service.plan({
      contextId: round2.stored.contextId,
      occurrenceId: round1.occurrenceId,
      grid: { division: "1/4" },
    }),
    (error) => error.code === "STALE_CONTEXT"
  );
  // 无身份记录的伪造 selector 直接 UNKNOWN_OCCURRENCE。
  await assert.rejects(
    service.plan({
      contextId: round2.stored.contextId,
      occurrenceId: "ctx_forged:t:0:r:0",
      grid: { division: "1/4" },
    }),
    (error) => error.code === "UNKNOWN_OCCURRENCE"
  );
});

test("noteIds select a subset and responseMode governs perNote size", async () => {
  const store = createStore();
  const count = 130;
  const notes = Array.from({ length: count }, (_, index) => ({
    onsetBlick: index * Q + Q / 8,
    durationBlick: Q / 2,
  }));
  const { stored, occurrenceId } = createStoredContext(store, { notes });
  const service = createService(store);
  const subset = await service.plan({
    contextId: stored.contextId,
    noteIds: [`${occurrenceId}:n:3`, `${occurrenceId}:n:7`],
    grid: { division: "1/4" },
  });
  assert.equal(subset.summary.noteCount, 2);
  assert.equal(subset.patchRequest.arguments.patches.length, 2);

  const standard = await service.plan({ contextId: stored.contextId, grid: { division: "1/4" } });
  assert.equal(standard.perNote.length, 100);
  assert.equal(standard.perNoteTruncated, true);
  assert.ok(standard.warnings.some((warning) => warning.code === "PER_NOTE_TRUNCATED"));
  assert.equal(standard.summary.noteCount, count);

  const compact = await service.plan({
    contextId: stored.contextId,
    grid: { division: "1/4" },
    responseMode: "compact",
  });
  assert.equal(compact.perNote, undefined);
  assert.equal(compact.summary.noteCount, count);

  const verbose = await service.plan({
    contextId: stored.contextId,
    grid: { division: "1/4" },
    responseMode: "verbose",
  });
  assert.equal(verbose.perNote.length, count);
});

test("identical requests produce identical planIds (determinism)", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, {
    notes: [{ onsetBlick: Q / 8, durationBlick: Q }],
  });
  const service = createService(store);
  const request = { contextId: stored.contextId, grid: { division: "1/8" }, strength: 0.75 };
  const first = await service.plan(request);
  const second = await service.plan(request);
  assert.equal(first.planId, second.planId);
});

test("quantize resolves contexts honestly across error paths", async () => {
  const store = createStore();
  const service = createService(store);
  await assert.rejects(
    service.plan({ contextId: "ctx_missing", grid: { division: "1/8" } }),
    (error) => error.code === "UNKNOWN_CONTEXT"
  );
  const empty = createStoredContext(store, { notes: [] });
  await assert.rejects(
    service.plan({ contextId: empty.stored.contextId, grid: { division: "1/8" } }),
    (error) => error.code === "NOTES_NOT_CAPTURED"
  );
  const ambiguous = createStoredContext(store, {
    notes: [{ onsetBlick: 0, durationBlick: Q }],
    extraOccurrenceWithNotes: true,
  });
  await assert.rejects(
    service.plan({ contextId: ambiguous.stored.contextId, grid: { division: "1/8" } }),
    (error) => error.code === "AMBIGUOUS_CONTEXT"
  );
  const known = createStoredContext(store, { notes: [{ onsetBlick: 0, durationBlick: Q }] });
  await assert.rejects(
    service.plan({
      contextId: known.stored.contextId,
      noteIds: [`${known.occurrenceId}:n:9`],
      grid: { division: "1/8" },
    }),
    (error) => error.code === "UNKNOWN_NOTE_ID"
  );
});

test("quantize rejects malformed requests before touching the store", async () => {
  const store = createStore();
  const service = createService(store);
  for (const request of [
    {},
    { contextId: "ctx" },
    { contextId: "ctx", grid: {} },
    { contextId: "ctx", grid: { division: "1/6" } },
    { contextId: "ctx", grid: { division: "1/8" }, strength: 0 },
    { contextId: "ctx", grid: { division: "1/8" }, strength: 1.5 },
    { contextId: "ctx", grid: { division: "1/8" }, swing: -0.1 },
    { contextId: "ctx", grid: { division: "1/8" }, quantizeDurations: "yes" },
    { contextId: "ctx", grid: { division: "1/8" }, noteIds: [] },
    { contextId: "ctx", grid: { division: "1/8" }, noteIds: ["a", "a"] },
    { contextId: "ctx", grid: { division: "1/8" }, responseMode: "loud" },
    { contextId: "ctx", grid: { division: "1/8" }, bogus: true },
  ]) {
    await assert.rejects(service.plan(request), (error) => error.code === "INVALID_ARGUMENTS");
  }
});
