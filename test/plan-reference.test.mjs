import assert from "node:assert";
import { ArtifactStore } from "../server/src/artifact-store.js";
import {
  buildPlanArtifact,
  buildPlanContextSnapshot,
  resolvePlanReference,
} from "../server/src/plan-reference.js";
import { SnapshotStore } from "../server/src/snapshot.js";
import { PlanExecutionLedger } from "../server/src/plan-ledger.js";

const sessionId = "sess_plan";

// 成功解析 plan artifact。
{
  const store = new ArtifactStore();
  const planPayload = buildPlanArtifact({
    targetTool: "sv_patch_notes",
    mutationRequest: { patches: [{ noteId: "n1", lyrics: "hello" }] },
    targetGroupUuid: "grp_1",
    occurrenceId: "occ_1",
    expectedTimeOffsetBlick: 100,
  });
  const artifact = store.seal({
    kind: "plan",
    schemaVersion: "1",
    sessionId,
    payload: planPayload.payload,
  });

  const resolved = resolvePlanReference({
    planRef: artifact.id,
    action: "commit",
    confirmations: { allowSharedTargetMutation: true },
    executionOptions: { atomic: true, waitFor: "none" },
    expectedTargetTool: "sv_patch_notes",
    sessionId,
    artifactStore: store,
  });

  assert.strictEqual(resolved.targetTool, "sv_patch_notes");
  assert.deepStrictEqual(resolved.mutationRequest, {
    patches: [{ noteId: "n1", lyrics: "hello" }],
    allowSharedTargetMutation: true,
    atomic: true,
    waitFor: "none",
    dryRun: false,
  });
}

// plan artifact 的租期长于可编辑 context；执行时应恢复被 TTL 淘汰的单 occurrence 上下文。
{
  let now = 1000;
  const snapshotStore = new SnapshotStore({ ttlMs: 100, now: () => now });
  const stored = snapshotStore.create({
    epoch: 7,
    scope: { kind: "range" },
    observedAt: new Date(now).toISOString(),
    context: { kind: "range", occurrences: [] },
  });
  const occurrence = {
    occurrenceId: `${stored.contextId}:t:0:r:0`,
    trackIndex: 0,
    groupIndex: 0,
    targetGroupUuid: "grp_restore",
    timeOffsetBlick: 0,
    sharedTargetOccurrences: [],
    noteFingerprints: [],
  };
  stored.context.occurrences.push(occurrence);

  const artifactStore = new ArtifactStore({ now: () => now });
  const { payload } = buildPlanArtifact({
    targetTool: "sv_patch_notes",
    mutationRequest: { contextId: stored.contextId, patches: [] },
    contextSnapshot: buildPlanContextSnapshot(stored, occurrence),
  });
  const artifact = artifactStore.seal({
    kind: "plan",
    schemaVersion: "1",
    sessionId,
    payload,
  });

  now += 101;
  assert.strictEqual(snapshotStore.get(stored.contextId), null);
  const resolved = resolvePlanReference({
    planRef: artifact.id,
    action: "dry_run",
    expectedTargetTool: "sv_patch_notes",
    sessionId,
    artifactStore,
    snapshotStore,
  });
  // capsule 交给调用方，**不**写回 store：只读证据一旦进 store 就会被别人查到、
  // 被 LRU 淘汰、并与真实快照混淆（§4.3.2）。
  assert.strictEqual(snapshotStore.get(stored.contextId), null);
  assert.strictEqual(resolved.capsule.epoch, 7);
  assert.strictEqual(resolved.capsule.contextId, stored.contextId);
  assert.strictEqual(
    resolved.capsule.context.occurrences[0].occurrenceId,
    occurrence.occurrenceId
  );
}

// context 仍在 store 里时不产出 capsule：真实快照优先，capsule 只是它过期后的替身。
{
  let now = 1000;
  const snapshotStore = new SnapshotStore({ now: () => now, ttlMs: 100 });
  const stored = snapshotStore.create({
    epoch: 7,
    scope: { kind: "range" },
    observedAt: new Date(now).toISOString(),
    context: { kind: "range", occurrences: [] },
  });
  const occurrence = {
    occurrenceId: `${stored.contextId}:t:0:r:0`,
    trackIndex: 0,
    groupIndex: 0,
    targetGroupUuid: "grp_live",
    timeOffsetBlick: 0,
    sharedTargetOccurrences: [],
    noteFingerprints: [],
  };
  stored.context.occurrences.push(occurrence);

  const artifactStore = new ArtifactStore({ now: () => now });
  const { payload } = buildPlanArtifact({
    targetTool: "sv_patch_notes",
    mutationRequest: { contextId: stored.contextId, patches: [] },
    contextSnapshot: buildPlanContextSnapshot(stored, occurrence),
  });
  const artifact = artifactStore.seal({
    kind: "plan",
    schemaVersion: "1",
    sessionId,
    payload,
  });
  const resolved = resolvePlanReference({
    planRef: artifact.id,
    action: "dry_run",
    expectedTargetTool: "sv_patch_notes",
    sessionId,
    artifactStore,
    snapshotStore,
  });
  assert.strictEqual(resolved.capsule, null);
}

// 目标工具不匹配报错。
{
  const store = new ArtifactStore();
  const { payload } = buildPlanArtifact({
    targetTool: "sv_patch_notes",
    mutationRequest: { patches: [] },
  });
  const artifact = store.seal({ kind: "plan", schemaVersion: "1", sessionId, payload });
  assert.throws(
    () =>
      resolvePlanReference({
        planRef: artifact.id,
        action: "dry_run",
        expectedTargetTool: "sv_patch_parameter_curves",
        sessionId,
        artifactStore: store,
      }),
    /PLAN_TARGET_MISMATCH/
  );
}

// planRef 形状：必须是裸 artifactId 字符串。
//
// contentHash 不匹配的用例随字段本身删除：调用方不再回传 hash，因此那种失败已经
// 不可构造。真正会发生的错误是把整个 apply 信封（或旧的 {artifactId} 对象）塞进
// planRef，所以守的是这一条。
{
  const store = new ArtifactStore();
  const { payload } = buildPlanArtifact({
    targetTool: "sv_patch_notes",
    mutationRequest: { patches: [] },
  });
  const artifact = store.seal({ kind: "plan", schemaVersion: "1", sessionId, payload });
  for (const badRef of [
    { artifactId: artifact.id },
    { planRef: artifact.id },
    "",
    undefined,
    42,
  ]) {
    assert.throws(
      () =>
        resolvePlanReference({
          planRef: badRef,
          action: "dry_run",
          expectedTargetTool: "sv_patch_notes",
          sessionId,
          artifactStore: store,
        }),
      /INVALID_ARGUMENTS/,
      JSON.stringify(badRef ?? null)
    );
  }
}

// 未知 artifactId 仍按 artifact 生命周期报错，而不是被当成形状问题。
{
  const store = new ArtifactStore();
  assert.throws(
    () =>
      resolvePlanReference({
        planRef: "a_doesNotExist",
        action: "dry_run",
        expectedTargetTool: "sv_patch_notes",
        sessionId,
        artifactStore: store,
      }),
    (error) => error.code === "UNKNOWN_ARTIFACT" || /ARTIFACT/.test(error.message)
  );
}

// action 必须显式；目标工具不支持的执行选项不得泄漏进 mutation 请求。
{
  const store = new ArtifactStore();
  const { payload } = buildPlanArtifact({
    targetTool: "sv_patch_parameter_curves",
    mutationRequest: { target: { contextId: "ctx_1" }, curves: [] },
  });
  const artifact = store.seal({ kind: "plan", schemaVersion: "1", sessionId, payload });
  const planRef = artifact.id;
  assert.throws(
    () =>
      resolvePlanReference({
        planRef,
        expectedTargetTool: "sv_patch_parameter_curves",
        sessionId,
        artifactStore: store,
      }),
    /action must be dry_run or commit/
  );
  assert.throws(
    () =>
      resolvePlanReference({
        planRef,
        action: "dry_run",
        executionOptions: { waitFor: "phonemes" },
        expectedTargetTool: "sv_patch_parameter_curves",
        sessionId,
        artifactStore: store,
      }),
    /executionOptions not supported/
  );
}

// 同一规划输入产生确定性 payload，不把封存时间混入 content hash。
{
  const options = {
    targetTool: "sv_patch_notes",
    mutationRequest: { contextId: "ctx_1", patches: [{ noteId: "n1", set: { lyrics: "x" } }] },
  };
  assert.deepStrictEqual(buildPlanArtifact(options), buildPlanArtifact(options));
  assert.strictEqual(Object.hasOwn(buildPlanArtifact(options).payload, "sealedAt"), false);
}

// ledger 接线：一个 planRef 至多 commit 一次。
//
// 这里测的不是 ledger 的状态机（plan-ledger.test.mjs 已覆盖），而是**接线**：
// seal 是否登记、resolve 是否在展开请求前检查、settle 是否推进终态。没有接线时
// 三者各自正确也挡不住重放。
{
  const ledger = new PlanExecutionLedger();
  const store = new ArtifactStore({ planLedger: ledger });
  const planPayload = buildPlanArtifact({
    targetTool: "sv_patch_notes",
    mutationRequest: { contextId: "ctx_1", patches: [{ note: 0, set: { lyrics: "x" } }] },
  });
  const artifact = store.seal({
    kind: "plan",
    schemaVersion: "1",
    sessionId,
    payload: planPayload.payload,
  });
  const planRef = artifact.id;
  const base = {
    planRef,
    expectedTargetTool: "sv_patch_notes",
    sessionId,
    artifactStore: store,
    planLedger: ledger,
  };

  // seal 即登记。
  assert.strictEqual(ledger.get(artifact.id)?.state, "sealed");

  // commit 必须先 dry-run：这把"先审阅再提交"从建议变成服务端约束。
  assert.throws(
    () => resolvePlanReference({ ...base, action: "commit" }),
    (error) => error.code === "PLAN_DRY_RUN_REQUIRED"
  );

  // dry-run 可重复，且不推进终态。
  resolvePlanReference({ ...base, action: "dry_run" });
  resolvePlanReference({ ...base, action: "dry_run" });
  assert.strictEqual(ledger.get(artifact.id).state, "dry_run_seen");
  assert.strictEqual(ledger.get(artifact.id).dryRunCount, 2);

  // 首次 commit 放行，并交回 ledgerRef 供 settle 使用。
  const committed = resolvePlanReference({ ...base, action: "commit" });
  assert.strictEqual(committed.ledgerRef, artifact.id);
  assert.strictEqual(ledger.get(artifact.id).state, "committing");

  // 停在 committing 时不得重放：宿主状态未知，重放会在未知之上再写一次。
  assert.throws(
    () => resolvePlanReference({ ...base, action: "commit" }),
    (error) => error.code === "PLAN_ALREADY_EXECUTED"
  );

  ledger.settle(artifact.id, "succeeded");
  assert.strictEqual(ledger.get(artifact.id).state, "committed");

  // 终态后连 dry-run 都拒绝：计划已生效，再"预览"会让调用方以为还能提交。
  assert.throws(
    () => resolvePlanReference({ ...base, action: "dry_run" }),
    (error) => error.code === "PLAN_ALREADY_EXECUTED"
  );
}

// 零写入的失败让计划回到可提交状态：mode:"add" 的重复叠加风险只存在于真的写过之后。
{
  const ledger = new PlanExecutionLedger();
  const store = new ArtifactStore({ planLedger: ledger });
  const artifact = store.seal({
    kind: "plan",
    schemaVersion: "1",
    sessionId,
    payload: buildPlanArtifact({
      targetTool: "sv_patch_notes",
      mutationRequest: { contextId: "ctx_1", patches: [{ note: 0, set: { lyrics: "x" } }] },
    }).payload,
  });
  const base = {
    planRef: artifact.id,
    expectedTargetTool: "sv_patch_notes",
    sessionId,
    artifactStore: store,
    planLedger: ledger,
  };
  resolvePlanReference({ ...base, action: "dry_run" });
  resolvePlanReference({ ...base, action: "commit" });
  ledger.settle(artifact.id, "failed");
  assert.strictEqual(ledger.get(artifact.id).state, "dry_run_seen");
  // 因此可以再次提交。
  assert.doesNotThrow(() => resolvePlanReference({ ...base, action: "commit" }));
}

// 非 plan artifact 不进 ledger：它们是只读证据，重复读取没有副作用。
{
  const ledger = new PlanExecutionLedger();
  const store = new ArtifactStore({ planLedger: ledger });
  const artifact = store.seal({
    kind: "analysis",
    schemaVersion: "1",
    sessionId,
    payload: { rows: [] },
  });
  assert.strictEqual(ledger.get(artifact.id), null);
}

console.log("plan-reference.test.mjs passed");
