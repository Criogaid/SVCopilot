// 规划引用解析：把只读 plan artifact 展开为目标 mutation 工具的规范请求。
// 目标工具仍须走自己的 normalization、target resolution、shared-target 检查、live preflight 和 rollback。
import { canonicalClone } from "./canonical-json.js";
import { operationNameForTool } from "./operation-catalog.js";
import { assertSealedCapsuleSatisfies } from "./scope-source.js";

const EXECUTION_OPTIONS_BY_TOOL = Object.freeze({
  sv_patch_notes: new Set(["atomic", "waitFor", "timeoutMs", "pollIntervalMs"]),
  sv_patch_parameter_curves: new Set(["atomic", "undoLabel"]),
  sv_patch_pitch_controls: new Set(["atomic", "waitFor", "timeoutMs", "pollIntervalMs"]),
  sv_restructure_notes: new Set(["atomic", "waitFor", "timeoutMs", "pollIntervalMs"]),
});

/**
 * 解析 planRef，返回目标 mutation 工具的规范请求。
 *
 * @param {object} options
 * @param {string} options.planRef - 裸 artifactId 字符串（§4.3）
 * @param {string} options.expectedTargetTool - 调用方期望的目标工具名
 * @param {string} options.sessionId
 * @param {ArtifactStore} options.artifactStore
 * @param {PlanExecutionLedger} [options.planLedger] - 防重放；缺省时不做执行态检查
 * @returns {{ targetTool: string, mutationRequest: object, ledgerRef: string|null }}
 */
export function resolvePlanReference({
  planRef,
  action,
  confirmations,
  executionOptions,
  expectedTargetTool,
  sessionId,
  artifactStore,
  snapshotStore,
  planLedger = null,
}) {
  if (typeof planRef !== "string" || planRef.length === 0) {
    throw codedError("INVALID_ARGUMENTS", "planRef must be the artifactId string from apply.planRef");
  }

  // 目标校验完全在服务端：kind、实例归属与 targetTool 都按 artifactId 查 sealed
  // payload 得到。调用方回传 contentHash 从不构成校验——它与 artifactId 出自同一次
  // 响应，不匹配只说明调用方改坏了自己刚收到的东西。
  const artifact = artifactStore.resolve({
    artifactId: planRef,
    expectedKind: "plan",
    sessionId,
  });

  const plan = artifact.payload;
  if (plan.targetTool !== expectedTargetTool) {
    throw codedError(
      "PLAN_TARGET_MISMATCH",
      `plan targets ${plan.targetTool}, expected ${expectedTargetTool}`
    );
  }
  if (!["dry_run", "commit"].includes(action)) {
    throw codedError("INVALID_ARGUMENTS", "planRef action must be dry_run or commit");
  }
  // capsule 不写回 store（§4.3.2）：只读证据一旦进了 store 就会被别人查到、
  // 被 LRU 淘汰、并与真实快照混淆。改为随返回值交给调用方，由它显式传给
  // getContext——用途因此在调用点可见，而不是藏在一次副作用里。
  const capsule =
    plan.contextSnapshot && !snapshotStore?.get(plan.contextSnapshot.contextId)
      ? { ...canonicalClone(plan.contextSnapshot.snapshot), contextId: plan.contextSnapshot.contextId }
      : null;

  const mutationRequest = canonicalClone(plan.mutationRequest);
  if (capsule) {
    // Plan capsule 只封存目标 occurrence，因此它在 capsule 内的 ordinal 恒为 0。
    // 原 Context 仍在时必须保留原 ordinal；只有真正切到 capsule 时才能重映射。
    if (Number.isSafeInteger(mutationRequest.occurrence)) mutationRequest.occurrence = 0;
    if (
      mutationRequest.target &&
      typeof mutationRequest.target === "object" &&
      Number.isSafeInteger(mutationRequest.target.occurrence)
    ) {
      mutationRequest.target.occurrence = 0;
    }
  }
  // 执行请求只带 action（§10.6）；dryRun 布尔已从整个 surface 删除。
  mutationRequest.action = action;
  applyConfirmations(mutationRequest, expectedTargetTool, confirmations);
  applyExecutionOptions(mutationRequest, expectedTargetTool, executionOptions);

  // ledger 推进必须排在**全部纯参数校验之后**，且仍在返回调用方之前。
  //
  // 两个约束同时成立：一个已提交的计划不该走到 live preflight（preflight 会通过——
  // 工程状态确实满足计划的前提，计划只是已经生效过了，§4.3.1），但一个连参数都没
  // 通过校验的请求根本没碰宿主，不该消耗掉 PlanRef 的唯一一次 commit 机会。
  //
  // 先前的顺序把两者搞混了：`executionOptions: {waitFor}` 这种纯参数错误会把条目
  // 推进到 committing 并永久卡死，此后任何 commit 都拿到 PLAN_ALREADY_EXECUTED，
  // 而宿主从未被触碰。上面的展开与校验全是纯内存操作，因此把 ledger 挪到它们之后
  // 不会放宽任何防重放保证。
  if (planLedger) {
    if (action === "commit") planLedger.beginCommit(planRef);
    else planLedger.noteDryRun(planRef);
  }

  return {
    targetTool: plan.targetTool,
    mutationRequest,
    // commit 的结果必须回填 ledger；null 表示这次不是 commit 或未启用 ledger。
    ledgerRef: planLedger && action === "commit" ? planRef : null,
    capsule,
  };
}

/**
 * 用写入结果推进 ledger 终态。
 *
 * 必须在**每条**返回路径上调用，包括失败路径：beginCommit 已经把条目推进到
 * committing，不 settle 就会永久停在那里并拒绝一切后续 commit。零写入的失败
 * （failed/conflict）由 ledger 自己退回 dry_run_seen，因此这里无须区分。
 *
 * @param {PlanExecutionLedger|null} planLedger
 * @param {string|null} ledgerRef - resolvePlanReference 返回的 ledgerRef
 * @param {object} result - 目标工具的返回值（读取 status）
 * @returns {object} 原样返回 result，便于 `return settlePlanLedger(...)`
 */
export function settlePlanLedger(planLedger, ledgerRef, result) {
  if (!planLedger || !ledgerRef) return result;
  const status = typeof result?.status === "string" ? result.status : null;
  // status 不在写入结论矩阵里（例如 dry_run）说明调用方把非 commit 结果传了进来；
  // 静默忽略比抛错更危险，但这里也不能让一次记账失败掩盖真实的写入结果。
  try {
    if (status) planLedger.settle(ledgerRef, status);
  } catch {
    // ledger 记账失败不改变宿主已经发生的事实，因此不覆盖 result。
  }
  return result;
}

/**
 * 构建用于封存的 plan payload。
 *
 * @param {object} options
 * @param {string} options.targetTool
 * @param {object} options.mutationRequest
 * @param {string} [options.targetGroupUuid]
 * @param {number} [options.occurrence]
 * @param {number} [options.expectedTimeOffsetBlick]
 * @param {object} [options.fingerprints]
 * @param {{stored: object, occurrence: object, noteIndexes?: number[]}} [options.capsule]
 *   要封存的 context capsule 来源。capsule **只能**在这里构造：以前
 *   `buildPlanContextSnapshot` 是导出的，于是"构造 capsule"和"校验 capsule 是否完整"
 *   分处两个模块，没有任何一处同时看得见两侧——`groupNoteCount` 被漏封存的缺陷正是
 *   藏在这道缝里。现在唯一的入口就是这个函数，构造完立刻校验。
 * @returns {{ kind: "plan", payload: object }}
 */
export function buildPlanArtifact({
  targetTool,
  mutationRequest,
  targetGroupUuid,
  occurrence,
  expectedTimeOffsetBlick,
  fingerprints = {},
  capsule,
}) {
  const contextSnapshot =
    capsule === undefined
      ? undefined
      : buildPlanContextSnapshot(capsule.stored, capsule.occurrence, {
          noteIndexes: capsule.noteIndexes,
        });
  // capsule 完整性在**封存时**校验，而不是等 apply 走到一半。
  //
  // 这条校验（CAPSULE_REQUIREMENTS_BY_OPERATION + assertCapsuleSatisfies）此前只被
  // 测试调用过，生产路径一次都没走到——于是 capsule 漏掉 groupNoteCount 的真实缺陷
  // 一直没人发现：每个越界检查都写成 `groupNoteCount ?? fingerprints.length`，而
  // capsule 只封存被触及的那几个指纹，回退值因此是被过滤后的数量。
  //
  // 放在这里而不是 resolve 时：封存是 planner 自己的代码路径，此刻失败指向的是
  // planner 少存了东西；等到 resolve 才发现，报错会出现在无辜的执行方那一侧。
  if (contextSnapshot !== undefined) {
    assertSealedCapsuleSatisfies(
      operationNameForTool(targetTool),
      contextSnapshot.snapshot,
      contextSnapshot.snapshot?.epoch
    );
  }
  return {
    kind: "plan",
    payload: {
      targetTool,
      mutationRequest,
      ...(targetGroupUuid !== undefined ? { targetGroupUuid } : {}),
      ...(occurrence !== undefined ? { occurrence } : {}),
      ...(expectedTimeOffsetBlick !== undefined ? { expectedTimeOffsetBlick } : {}),
      fingerprints,
      ...(contextSnapshot !== undefined ? { contextSnapshot } : {}),
    },
  };
}

// 选择器是组内 index（§3.1）。不传表示"封存全部指纹"。
//
// **不导出**：capsule 的唯一构造入口是 buildPlanArtifact，它构造完立刻校验完整性。
// 以前这个函数是导出的，于是五个 planner 各自构造 capsule、而校验器住在另一个模块里，
// 两边谁也不认识谁——那道缝正是 groupNoteCount 缺陷藏身的地方。
function buildPlanContextSnapshot(stored, occurrence, { noteIndexes } = {}) {
  if (!stored || typeof stored.contextId !== "string" || !occurrence) {
    throw codedError("INVALID_ARGUMENTS", "plan context snapshot requires a stored context and occurrence");
  }
  const fingerprints = Array.isArray(occurrence.noteFingerprints)
    ? occurrence.noteFingerprints
    : [];
  let selectedFingerprints = fingerprints;
  if (noteIndexes !== undefined) {
    // 选择器是组内 index（§3.1）：字符串 ID 只是同一事实的更长写法，而 index 在
    // 快照里稳定、能直接与 expectedNotes 对齐。
    if (
      !Array.isArray(noteIndexes) ||
      noteIndexes.some((index) => !Number.isSafeInteger(index) || index < 0)
    ) {
      throw codedError(
        "INVALID_ARGUMENTS",
        "plan context snapshot noteIndexes must be non-negative integers"
      );
    }
    const requested = new Set(noteIndexes);
    selectedFingerprints = fingerprints.filter((fingerprint) =>
      requested.has(fingerprint.indexInGroup)
    );
    if (selectedFingerprints.length !== requested.size) {
      throw codedError(
        "INVALID_ARGUMENTS",
        "plan context snapshot noteIndexes must belong to the selected occurrence"
      );
    }
  }
  // Capsule 只保留恢复 live preflight 所需字段；分析结果、voice、Automation 等大块数据不进入计划。
  const minimalOccurrence = {
    // capsule 只封存一个 occurrence，因此它在 capsule 内的 ordinal 恒为 0——原 Context
    // 里的 ordinal 不能带进来：capsule 的 occurrences 数组只有一项，带一个非 0 的编号
    // 会让 scope-source 的 ordinal 一致性检查（正确地）拒绝它。
    occurrence: 0,
    trackIndex: occurrence.trackIndex,
    groupIndex: occurrence.groupIndex,
    targetGroupUuid: occurrence.targetGroupUuid,
    ...(Number.isFinite(occurrence.timeOffsetBlick)
      ? { timeOffsetBlick: occurrence.timeOffsetBlick }
      : {}),
    ...(Number.isFinite(occurrence.pitchOffsetSemitone)
      ? { pitchOffsetSemitone: occurrence.pitchOffsetSemitone }
      : {}),
    // groupNoteCount 必须原样封存，绝不能靠 noteFingerprints.length 推导。
    //
    // capsule 通常只保留被计划触及的那几个音符（noteIndexes 过滤），而每个越界检查
    // 都写成 `occurrence.groupNoteCount ?? fingerprints.length`。少了它，回退值就是
    // **被过滤后**的数量：一个 9 音符的组只封存 1 个指纹时，note 5 会被判成
    // NOTE_INDEX_OUT_OF_RANGE——那是个假的结构漂移报告，而真正的越界与它无法区分。
    groupNoteCount:
      occurrence.groupNoteCount ?? (Array.isArray(fingerprints) ? fingerprints.length : 0),
    sharedTargetOccurrences: Array.isArray(occurrence.sharedTargetOccurrences)
      ? occurrence.sharedTargetOccurrences
      : [],
    noteFingerprints: selectedFingerprints,
  };
  return {
    contextId: stored.contextId,
    snapshot: {
      epoch: stored.epoch,
      scope: stored.scope,
      observedAt: stored.observedAt,
      context: {
        kind: stored.context?.kind ?? "range",
        occurrences: [minimalOccurrence],
      },
    },
  };
}

function applyConfirmations(request, targetTool, confirmations) {
  if (confirmations === undefined) return;
  if (!confirmations || typeof confirmations !== "object" || Array.isArray(confirmations)) {
    throw codedError("INVALID_ARGUMENTS", "confirmations must be an object");
  }
  const unknown = Object.keys(confirmations).filter((key) => key !== "allowSharedTargetMutation");
  if (unknown.length > 0) {
    throw codedError("INVALID_ARGUMENTS", `unknown confirmation: ${unknown.join(", ")}`);
  }
  if (
    confirmations.allowSharedTargetMutation !== undefined &&
    typeof confirmations.allowSharedTargetMutation !== "boolean"
  ) {
    throw codedError("INVALID_ARGUMENTS", "allowSharedTargetMutation confirmation must be a boolean");
  }
  if (confirmations.allowSharedTargetMutation === undefined) return;
  if (targetTool === "sv_patch_notes" || targetTool === "sv_restructure_notes") {
    request.allowSharedTargetMutation = confirmations.allowSharedTargetMutation;
    return;
  }
  request.target = {
    ...request.target,
    allowSharedTargetMutation: confirmations.allowSharedTargetMutation,
  };
}

function applyExecutionOptions(request, targetTool, executionOptions) {
  if (executionOptions === undefined) return;
  if (!executionOptions || typeof executionOptions !== "object" || Array.isArray(executionOptions)) {
    throw codedError("INVALID_ARGUMENTS", "executionOptions must be an object");
  }
  const allowed = EXECUTION_OPTIONS_BY_TOOL[targetTool] ?? new Set();
  const unknown = Object.keys(executionOptions).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw codedError(
      "INVALID_ARGUMENTS",
      `executionOptions not supported by ${targetTool}: ${unknown.join(", ")}`
    );
  }
  Object.assign(request, canonicalClone(executionOptions));
}

function codedError(code, message) {
  const error = new Error(`[${code}] ${message}`);
  error.code = code;
  return error;
}
