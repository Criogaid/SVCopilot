// Context 失效策略的回归（计划 §4.6 / §13.5）。
//
// 这个文件挡住的是「只在成功路径失效」这个不安全的窄条件。判据必须是
// writeAttempted：一次抛错的 setter 既不成功也不失败，但它可能已经改了工程，
// 而那个 Context 的 fingerprint 从此不再描述宿主。
import assert from "node:assert/strict";
import test from "node:test";

import { TOOLS } from "../server/src/index.js";
import { buildOperationCatalog } from "../server/src/operation-catalog.js";
import { SnapshotStore } from "../server/src/snapshot.js";
import {
  CONTEXT_INVALIDATION_BY_OPERATION,
  INVALIDATION_SCOPES,
  invalidateContextsFor,
  invalidationPolicyFor,
} from "../server/src/context-invalidation.js";

const Q = 705_600_000;

function rangeContext(targetGroupUuid, { trackIndex = 0 } = {}) {
  return {
    epoch: 1,
    scope: { kind: "range" },
    context: {
      kind: "range",
      occurrences: [
        {
          occurrenceId: `c_x:t:${trackIndex}:r:0`,
          trackIndex,
          groupIndex: 0,
          targetGroupUuid,
          groupNoteCount: 2,
          sharedTargetOccurrences: [],
          noteFingerprints: [
            { indexInGroup: 0, onsetBlick: 0, durationBlick: Q, pitch: 60, lyrics: "占" },
          ],
        },
      ],
    },
  };
}

function store() {
  return new SnapshotStore({ now: () => 1000 });
}

test("every operation has a registered invalidation policy", () => {
  // 新增 operation 忘记登记时必须失败：默认值无论取 none 还是 target_group 都会
  // 在某一半的情形下出错。
  const { operations } = buildOperationCatalog(TOOLS);
  const missing = [...operations.keys()].filter(
    (operation) => !CONTEXT_INVALIDATION_BY_OPERATION[operation]
  );
  assert.deepEqual(missing, [], `these operations have no invalidation policy: ${missing.join(", ")}`);

  const stale = Object.keys(CONTEXT_INVALIDATION_BY_OPERATION).filter(
    (operation) => !operations.has(operation)
  );
  assert.deepEqual(stale, [], `these policies name unknown operations: ${stale.join(", ")}`);
});

test("every policy uses a known scope and states its reason", () => {
  for (const [operation, policy] of Object.entries(CONTEXT_INVALIDATION_BY_OPERATION)) {
    assert.ok(
      INVALIDATION_SCOPES.includes(policy.scope),
      `${operation} uses unknown scope "${policy.scope}"`
    );
    assert.ok(policy.reason.length >= 8, `${operation} must state why`);
  }
  assert.equal(invalidationPolicyFor("patch_notes").scope, "target_group");
  assert.throws(() => invalidationPolicyFor("brand_new"), /no context invalidation policy/);
});

test("read-only and planner operations never invalidate", () => {
  // 纯内存分析与规划器绝不碰宿主，因此失效只会白花一次重新快照。
  for (const operation of [
    "snapshot_range",
    "analyze_phrase",
    "analyze_vocal_context",
    "style_profile",
    "check_prosody",
    "compare_computed_pitch",
    "plan_expression",
    "plan_pitch_gesture",
    "align_lyrics",
    "quantize_notes",
    "generate_harmony",
    "get_parameter_curve",
    "get_voice_profile",
    "wait_processing",
  ]) {
    assert.equal(
      CONTEXT_INVALIDATION_BY_OPERATION[operation].scope,
      "none",
      `${operation} must not invalidate`
    );
  }
});

test("a write attempt invalidates even when the write failed", () => {
  // §4.6 的核心：partial / rollback_failed / outcome_unknown / 半途抛错都必须失效。
  // 判据是 writeAttempted，而不是 status——那正是"只在成功后失效"漏掉的路径。
  for (const description of ["succeeded", "partial", "rollback_failed", "outcome_unknown"]) {
    const instance = store();
    const context = instance.create(rangeContext("uuid-a"));
    const result = invalidateContextsFor({
      store: instance,
      operation: "patch_notes",
      writeAttempted: true,
      targetGroupUuid: "uuid-a",
    });
    assert.deepEqual(result.invalidatedContexts, [context.contextId], description);
    assert.equal(instance.get(context.contextId), null, `${description} must invalidate`);
    // reason 要能区分"被写入失效"与"过期"，否则模型不知道该不该重新快照。
    assert.equal(instance.reasonFor(context.contextId), "invalidated_by_mutation");
  }
});

test("a zero-write path keeps the context alive", () => {
  // dry-run 与零 setter 的 no_change 都没碰过宿主。
  const instance = store();
  const context = instance.create(rangeContext("uuid-a"));
  const result = invalidateContextsFor({
    store: instance,
    operation: "patch_notes",
    writeAttempted: false,
    targetGroupUuid: "uuid-a",
  });
  assert.deepEqual(result.invalidatedContexts, []);
  assert.ok(instance.get(context.contextId), "dry-run must not invalidate");
});

test("every context capturing the same note group is invalidated, not just one", () => {
  // 同一个 NoteGroup 可以被多个 Context 捕获（不同 range、先后两次快照）。
  // 只删发起写入的那一个会让其余继续被信任，而它们的 fingerprint 已经过期。
  const instance = store();
  const first = instance.create(rangeContext("uuid-a"));
  const second = instance.create(rangeContext("uuid-a"));
  const unrelated = instance.create(rangeContext("uuid-b"));

  const result = invalidateContextsFor({
    store: instance,
    operation: "patch_parameter_curves",
    writeAttempted: true,
    targetGroupUuid: "uuid-a",
  });
  assert.deepEqual(result.invalidatedContexts.sort(), [first.contextId, second.contextId].sort());
  assert.ok(instance.get(unrelated.contextId), "a different target must stay valid");
});

test("clone_track invalidates everything because track indices shift", () => {
  // 插入一条轨道后，所有 Context 里记录的 trackIndex 都可能指向别的轨道。
  // 按 NoteGroup 失效在这里不够：变的是索引本身的含义。
  const instance = store();
  const a = instance.create(rangeContext("uuid-a", { trackIndex: 0 }));
  const b = instance.create(rangeContext("uuid-b", { trackIndex: 5 }));

  const result = invalidateContextsFor({
    store: instance,
    operation: "clone_track",
    writeAttempted: true,
  });
  assert.deepEqual(result.invalidatedContexts.sort(), [a.contextId, b.contextId].sort());
  assert.equal(instance.stats().entries, 0);
});

test("editor state changes do not invalidate musical contexts", () => {
  // selection 与 audition 只动 UI 与 mixer：没有音符、曲线或 Undo 记录改变。
  const instance = store();
  const context = instance.create(rangeContext("uuid-a"));
  for (const operation of ["set_selection", "start", "stop", "restore", "compare", "stop_compare"]) {
    const result = invalidateContextsFor({
      store: instance,
      operation,
      writeAttempted: true,
      targetGroupUuid: "uuid-a",
    });
    assert.deepEqual(result.invalidatedContexts, [], `${operation} must not invalidate`);
  }
  assert.ok(instance.get(context.contextId));
});

test("a write with an unknown target falls back to invalidating everything", () => {
  // 写入已发生却不知道目标时，保守方向是全量失效：留下一个被信任的过期 Context
  // 比多要一次重新快照危险得多。
  const instance = store();
  const context = instance.create(rangeContext("uuid-a"));
  const result = invalidateContextsFor({
    store: instance,
    operation: "patch_notes",
    writeAttempted: true,
    // 没有 targetGroupUuid
  });
  assert.equal(result.scope, "project_structure");
  assert.deepEqual(result.invalidatedContexts, [context.contextId]);
});

test("sv_raw writes are honestly classified as unknown-target", () => {
  // sv_raw 可以调用任意官方 setter。声明 target_group 会假装知道目标；声明 none
  // 会在它确实写入后留下被信任的过期 Context。因此单独一类，按保守方向处理。
  assert.equal(CONTEXT_INVALIDATION_BY_OPERATION.call.scope, "unknown_host_write");
  assert.equal(CONTEXT_INVALIDATION_BY_OPERATION.run.scope, "unknown_host_write");
  // 只读的 raw op 不失效。
  for (const operation of ["root", "index", "free"]) {
    assert.equal(CONTEXT_INVALIDATION_BY_OPERATION[operation].scope, "none");
  }

  const instance = store();
  const context = instance.create(rangeContext("uuid-a"));
  const result = invalidateContextsFor({
    store: instance,
    operation: "call",
    writeAttempted: true,
  });
  assert.deepEqual(result.invalidatedContexts, [context.contextId]);
});

test("group and selection contexts are conservatively invalidated", () => {
  // 它们只记 track/group 索引，拿不到 targetGroupUuid，因此无法证明自己没被影响。
  // 宁可多失效一个（代价是重新快照），也不能让过期 Context 继续被信任。
  const instance = store();
  const selection = instance.create({
    epoch: 1,
    scope: { kind: "selection" },
    context: { kind: "selection", trackIndex: 0, groupIndex: 0, noteIndices: [0], fingerprints: [] },
  });
  const result = invalidateContextsFor({
    store: instance,
    operation: "patch_notes",
    writeAttempted: true,
    targetGroupUuid: "uuid-a",
  });
  assert.deepEqual(result.invalidatedContexts, [selection.contextId]);
});

test("invalidated bytes are released immediately", () => {
  // 失效若只是从索引里摘掉条目，配额就会被幽灵条目占住。
  const instance = store();
  instance.create(rangeContext("uuid-a"));
  assert.ok(instance.stats().accountedBytes > 0);
  invalidateContextsFor({
    store: instance,
    operation: "patch_notes",
    writeAttempted: true,
    targetGroupUuid: "uuid-a",
  });
  assert.equal(instance.stats().accountedBytes, 0);
});
