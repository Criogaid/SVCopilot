import assert from "node:assert";
import { ArtifactStore } from "../server/src/artifact-store.js";
import {
  buildPlanArtifact as buildPlanArtifactRaw,
  resolvePlanReference,
} from "../server/src/plan-reference.js";
import { SnapshotStore } from "../server/src/snapshot.js";
import { PlanExecutionLedger } from "../server/src/plan-ledger.js";

const sessionId = "sess_plan";

function buildPlanArtifact(options) {
  if (options.capsule) return buildPlanArtifactRaw(options);
  const occurrence = {
    occurrence: 0,
    trackIndex: 0,
    groupIndex: 0,
    targetGroupUuid: options.targetGroupUuid ?? "grp_fixture",
    timeOffsetBlick: options.expectedTimeOffsetBlick ?? 0,
    groupNoteCount: 1,
    sharedTargetOccurrences: [],
    noteFingerprints: [
      {
        indexInGroup: 0,
        onsetBlick: 0,
        durationBlick: 705600000,
        pitch: 60,
        lyrics: "占",
        phonemesOverride: "",
        languageOverride: "",
        detuneCents: 0,
      },
    ],
  };
  const stored = {
    contextId: "ctx_plan_fixture",
    epoch: 1,
    context: { kind: "range", occurrences: [occurrence] },
  };
  return buildPlanArtifactRaw({
    ...options,
    capsule: { stored, occurrence },
  });
}

// actionable PlanRef 必须自带完整 scope；缺失时绝不能回退 SnapshotStore。
{
  assert.throws(
    () =>
      buildPlanArtifactRaw({
        targetTool: "sv_patch_notes",
        mutationRequest: { contextId: "ctx_missing_capsule", patches: [] },
      }),
    (error) => error.code === "PLAN_CAPSULE_INCOMPLETE"
  );

  const store = new ArtifactStore();
  const artifact = store.seal({
    kind: "plan",
    schemaVersion: "1",
    sessionId,
    payload: {
      targetTool: "sv_patch_notes",
      mutationRequest: { contextId: "ctx_missing_capsule", patches: [] },
    },
  });
  assert.throws(
    () =>
      resolvePlanReference({
        planRef: artifact.id,
        action: "dry_run",
        expectedTargetTool: "sv_patch_notes",
        sessionId,
        artifactStore: store,
      }),
    (error) => error.code === "PLAN_CAPSULE_INCOMPLETE"
  );
}

// 成功解析 plan artifact。
{
  const store = new ArtifactStore();
  const planPayload = buildPlanArtifact({
    targetTool: "sv_patch_notes",
    mutationRequest: { patches: [{ noteId: "n1", lyrics: "hello" }] },
    targetGroupUuid: "grp_1",
    occurrence: 1,
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
    action: "commit",
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
    occurrence: 0,
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
    capsule: { stored, occurrence },
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
  assert.strictEqual(resolved.scopeSource.kind, "plan_capsule");
  assert.strictEqual(resolved.scopeSource.capsule.epoch, 7);
  // capsule 只封存一个 occurrence，因此其局部 ordinal 恒为 0——源 Context 里的编号
  // 不会带进来（否则 scope-source 的一致性检查会正确地拒绝它）。
  assert.strictEqual(resolved.scopeSource.capsule.context.occurrences[0].occurrence, 0);
  assert.strictEqual(
    resolved.scopeSource.capsule.context.occurrences[0].targetGroupUuid,
    occurrence.targetGroupUuid
  );
}

// Context 仍在 store 里时也只使用 capsule：TTL 前后不能改变计划的身份解析路径。
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
    occurrence: 0,
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
    capsule: { stored, occurrence },
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
  assert.strictEqual(resolved.scopeSource.kind, "plan_capsule");
  assert.strictEqual(resolved.scopeSource.capsule.epoch, 7);
}

// ordinal 是源 Context 内的坐标；单 occurrence capsule 的局部坐标恒为 0。
// PlanRef 始终切到 capsule，因此是否过期都必须重映射为 0。
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
    occurrence: 3,
    trackIndex: 3,
    groupIndex: 0,
    targetGroupUuid: "grp_nonzero_ordinal",
    timeOffsetBlick: 0,
    sharedTargetOccurrences: [],
    noteFingerprints: [],
  };
  stored.context.occurrences.push(
    { occurrence: 0 },
    { occurrence: 1 },
    { occurrence: 2 },
    occurrence
  );
  const artifactStore = new ArtifactStore({ now: () => now });
  const sealPlan = (targetTool, mutationRequest) => {
    const { payload } = buildPlanArtifact({
      targetTool,
      mutationRequest,
      capsule: { stored, occurrence },
    });
    return artifactStore.seal({ kind: "plan", schemaVersion: "1", sessionId, payload });
  };

  const rootArtifact = sealPlan("sv_patch_notes", {
    contextId: stored.contextId,
    occurrence: 3,
    patches: [],
  });
  const beforeExpiry = resolvePlanReference({
    planRef: rootArtifact.id,
    action: "dry_run",
    expectedTargetTool: "sv_patch_notes",
    sessionId,
    artifactStore,
    snapshotStore,
  });
  assert.strictEqual(beforeExpiry.scopeSource.kind, "plan_capsule");
  assert.strictEqual(beforeExpiry.mutationRequest.occurrence, 0);

  const nestedArtifact = sealPlan("sv_patch_parameter_curves", {
    target: { contextId: stored.contextId, occurrence: 3 },
    curves: [],
  });
  now += 101;
  assert.strictEqual(snapshotStore.get(stored.contextId), null);
  const [rootAfterExpiry, nestedAfterExpiry] = [
    [rootArtifact, "sv_patch_notes"],
    [nestedArtifact, "sv_patch_parameter_curves"],
  ].map(([artifact, targetTool]) =>
    resolvePlanReference({
      planRef: artifact.id,
      action: "dry_run",
      expectedTargetTool: targetTool,
      sessionId,
      artifactStore,
      snapshotStore,
    })
  );
  assert.strictEqual(rootAfterExpiry.mutationRequest.occurrence, 0);
  assert.strictEqual(nestedAfterExpiry.mutationRequest.target.occurrence, 0);
  assert.strictEqual(rootAfterExpiry.scopeSource.kind, "plan_capsule");
  assert.strictEqual(nestedAfterExpiry.scopeSource.kind, "plan_capsule");
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
    { code: "PLAN_TARGET_MISMATCH" }
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
      { code: "INVALID_ARGUMENTS" },
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
    // 判据是结构化的 code 而不是 message 散文：只要它属于 artifact 生命周期
    // （UNKNOWN_ARTIFACT / ARTIFACT_NOT_FOUND / ARTIFACT_EXPIRED）就算通过，
    // 被当成 INVALID_ARGUMENTS 这类形状问题才是回归。
    (error) => /ARTIFACT/.test(error.code)
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

// 纯参数错误不得消耗 PlanRef 的唯一一次 commit 机会。
//
// 这是一个真实 bug 的回归：ledger 推进曾排在 applyConfirmations /
// applyExecutionOptions **之前**，于是 `executionOptions:{waitFor}` 这种目标工具
// 不支持的选项会把条目推到 committing 并永久卡死——宿主从未被触碰，PlanRef 却
// 再也无法提交。顺序本身就是契约，因此这里逐条钉住。
{
  const ledger = new PlanExecutionLedger();
  const store = new ArtifactStore({ planLedger: ledger });
  const artifact = store.seal({
    kind: "plan",
    schemaVersion: "1",
    sessionId,
    payload: buildPlanArtifact({
      targetTool: "sv_patch_parameter_curves",
      mutationRequest: { target: { contextId: "c_x" }, curves: [] },
    }).payload,
  });
  const base = {
    planRef: artifact.id,
    expectedTargetTool: "sv_patch_parameter_curves",
    sessionId,
    artifactStore: store,
    planLedger: ledger,
  };
  resolvePlanReference({ ...base, action: "dry_run" });

  // 每一种纯参数拒绝都必须让条目停在 dry_run_seen。
  const pureArgumentRejections = [
    // 目标工具不支持的 executionOptions。
    { executionOptions: { waitFor: "none" } },
    // 未知 confirmation 键。
    { confirmations: { bogusConfirmation: true } },
    // confirmation 值类型错误。
    { confirmations: { allowSharedTargetMutation: "yes" } },
    // executionOptions 不是对象。
    { executionOptions: [] },
  ];
  for (const overrides of pureArgumentRejections) {
    assert.throws(
      () => resolvePlanReference({ ...base, action: "commit", ...overrides }),
      (error) => error.code === "INVALID_ARGUMENTS",
      JSON.stringify(overrides)
    );
    assert.strictEqual(
      ledger.get(artifact.id).state,
      "dry_run_seen",
      `a pure-argument rejection must not consume the planRef: ${JSON.stringify(overrides)}`
    );
  }

  // 参数正确时才进入 committing——防重放保证没有被放宽。
  const accepted = resolvePlanReference({ ...base, action: "commit" });
  assert.strictEqual(accepted.ledgerRef, artifact.id);
  assert.strictEqual(ledger.get(artifact.id).state, "committing");
}

// 目标工具不匹配同样不得消耗 PlanRef：它连 artifact 都没认对。
{
  const ledger = new PlanExecutionLedger();
  const store = new ArtifactStore({ planLedger: ledger });
  const artifact = store.seal({
    kind: "plan",
    schemaVersion: "1",
    sessionId,
    payload: buildPlanArtifact({
      targetTool: "sv_patch_notes",
      mutationRequest: { contextId: "c_x", patches: [] },
    }).payload,
  });
  assert.throws(
    () =>
      resolvePlanReference({
        planRef: artifact.id,
        action: "commit",
        expectedTargetTool: "sv_restructure_notes",
        sessionId,
        artifactStore: store,
        planLedger: ledger,
      }),
    (error) => error.code === "PLAN_TARGET_MISMATCH"
  );
  assert.strictEqual(ledger.get(artifact.id).state, "sealed");
}


// capsule 必须独立封存 groupNoteCount，不能让消费者退化到用指纹条数推断。
//
// 这是一个真实缺陷的回归：capsule 通常只封存**被触及**的那几个音符指纹，而
// note-patch / note-structure / parameter-curve 的越界判定都写成
// `occurrence.groupNoteCount ?? fingerprints.length`。groupNoteCount 一旦丢失，
// 回退值就是被过滤后的条数，于是一个在真实 9 音符组里完全合法的 index 5 会被
// 判成 NOTE_INDEX_OUT_OF_RANGE——计划在过期后重放时静默缩小了合法范围。
{
  const store = new SnapshotStore({ now: () => 1000 });
  const stored = store.create({
    epoch: 1,
    scope: { kind: "range" },
    observedAt: new Date(1000).toISOString(),
    context: { kind: "range", occurrences: [] },
  });
  const occurrence = {
    occurrence: 0,
    trackIndex: 0,
    groupIndex: 0,
    targetGroupUuid: "grp_count",
    timeOffsetBlick: 0,
    groupNoteCount: 9,
    sharedTargetOccurrences: [],
    noteFingerprints: Array.from({ length: 9 }, (_, index) => ({
      indexInGroup: index,
      onsetBlick: index * 100,
      durationBlick: 100,
      pitch: 60,
      lyrics: `n${index}`,
    })),
  };
  stored.context.occurrences.push(occurrence);

  // 只封存一个被触及的音符——这正是 planner 的常态（noteIndexes 只列出要改的）。
  const { payload } = buildPlanArtifact({
    targetTool: "sv_patch_notes",
    mutationRequest: { contextId: stored.contextId, patches: [] },
    capsule: { stored, occurrence, noteIndexes: [5] },
  });
  const sealed = payload.capsule.context.occurrences[0];
  assert.strictEqual(sealed.noteFingerprints.length, 1);
  // 组内总数与被封存的指纹条数是两件不同的事实，必须各自存在。
  assert.strictEqual(sealed.groupNoteCount, 9);
  // 消费者共用的回退表达式在 capsule 上必须得出真实总数。
  assert.strictEqual(sealed.groupNoteCount ?? sealed.noteFingerprints.length, 9);
}

// PlanRef 的身份来源必须恒为封存 capsule，不能随原 Context 是否仍在 store 中改变。
// 否则同一个计划会在 TTL 前后走两套 target-resolution 路径，只有过期后才暴露缺陷。
{
  const store = new SnapshotStore({ now: () => 1000 });
  const stored = store.create({
    epoch: 9,
    scope: { kind: "range" },
    observedAt: new Date(1000).toISOString(),
    context: { kind: "range", occurrences: [] },
  });
  const occurrence = {
    occurrence: 0,
    trackIndex: 0,
    groupIndex: 0,
    targetGroupUuid: "grp_scope_source",
    timeOffsetBlick: 0,
    groupNoteCount: 1,
    sharedTargetOccurrences: [],
    noteFingerprints: [
      { indexInGroup: 0, onsetBlick: 0, durationBlick: 100, pitch: 60, lyrics: "占" },
    ],
  };
  stored.context.occurrences.push(occurrence);
  const artifactStore = new ArtifactStore({ now: () => 1000 });
  const { payload } = buildPlanArtifact({
    targetTool: "sv_patch_notes",
    mutationRequest: {
      contextId: stored.contextId,
      occurrence: 0,
      patches: [{ note: 0, set: { lyrics: "位" } }],
    },
    capsule: { stored, occurrence, noteIndexes: [0] },
  });
  assert.ok(payload.capsule, "plan payload must use the capsule field");
  assert.equal(Object.hasOwn(payload, "contextSnapshot"), false);
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
    snapshotStore: {
      get() {
        throw new Error("PlanRef resolution must not consult SnapshotStore");
      },
    },
  });
  assert.deepStrictEqual(resolved.scopeSource, {
    kind: "plan_capsule",
    capsule: payload.capsule,
  });
  assert.equal(Object.hasOwn(resolved, "capsule"), false);
}

// 封存时校验 capsule 完整性：缺判据的计划必须在 seal 阶段就失败，
// 而不是等 apply 在真实工程上走到一半才发现。
{
  const store = new SnapshotStore({ now: () => 1000 });
  const stored = store.create({
    epoch: 1,
    scope: { kind: "range" },
    observedAt: new Date(1000).toISOString(),
    context: { kind: "range", occurrences: [] },
  });
  const complete = {
    occurrence: 0,
    trackIndex: 0,
    groupIndex: 0,
    targetGroupUuid: "grp_validate",
    timeOffsetBlick: 0,
    groupNoteCount: 4,
    sharedTargetOccurrences: [],
    noteFingerprints: [{ indexInGroup: 0, onsetBlick: 0, durationBlick: 100, pitch: 60 }],
  };
  stored.context.occurrences.push(complete);

  // 完整 capsule 正常封存。
  assert.ok(
    buildPlanArtifact({
      targetTool: "sv_restructure_notes",
      mutationRequest: { contextId: stored.contextId, operations: [] },
      capsule: { stored, occurrence: complete },
    }).payload.capsule
  );

  // 缺目标身份：连"改的是哪个 NoteGroup"都不知道，因此不该封成一个可提交的计划。
  const { targetGroupUuid: _dropped, ...noTarget } = complete;
  assert.throws(
    () =>
      buildPlanArtifact({
        targetTool: "sv_patch_notes",
        mutationRequest: { contextId: stored.contextId, patches: [] },
        capsule: { stored, occurrence: noTarget },
      }),
    (error) => error.code === "PLAN_CAPSULE_INCOMPLETE" && /target/.test(error.message)
  );

  // 曲线写入缺 timeOffsetBlick：曲线锚在音符位置上，没有它无法换算 group-local 坐标。
  const { timeOffsetBlick: _noOffset, ...noOffset } = complete;
  assert.throws(
    () =>
      buildPlanArtifact({
        targetTool: "sv_patch_parameter_curves",
        mutationRequest: { target: { contextId: stored.contextId }, curves: [] },
        capsule: { stored, occurrence: noOffset },
      }),
    (error) => error.code === "PLAN_CAPSULE_INCOMPLETE" && /timeOffsetBlick/.test(error.message)
  );
}

console.log("plan-reference.test.mjs passed");
