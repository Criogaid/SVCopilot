// 规划引用解析：把只读 plan artifact 展开为目标 mutation 工具的规范请求。
// 目标工具仍须走自己的 normalization、target resolution、shared-target 检查、live preflight 和 rollback。
import { canonicalClone } from "./canonical-json.js";

const EXECUTION_OPTIONS_BY_TOOL = Object.freeze({
  sv_patch_notes: new Set(["atomic", "waitFor", "timeoutMs", "pollIntervalMs"]),
  sv_patch_parameter_curves: new Set(["atomic", "responseMode", "undoLabel"]),
  sv_patch_pitch_controls: new Set([
    "atomic",
    "responseMode",
    "waitFor",
    "timeoutMs",
    "pollIntervalMs",
  ]),
  sv_restructure_notes: new Set(["atomic", "waitFor", "timeoutMs", "pollIntervalMs"]),
});

/**
 * 解析 planRef，返回目标 mutation 工具的规范请求。
 *
 * @param {object} options
 * @param {{ artifactId: string, contentHash: string }} options.planRef
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
  if (!planRef || typeof planRef.artifactId !== "string" || typeof planRef.contentHash !== "string") {
    throw codedError("INVALID_ARGUMENTS", "planRef must contain artifactId and contentHash");
  }

  const artifact = artifactStore.resolve({
    artifactId: planRef.artifactId,
    expectedKind: "plan",
    expectedContentHash: planRef.contentHash,
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
  // 执行态检查必须在展开请求**之前**：一个已提交的计划不该走到 live preflight，
  // 因为 preflight 会通过——工程状态确实满足计划的前提，计划只是已经生效过了
  // （§4.3.1）。这一点 preflight 无法自己发现。
  if (planLedger) {
    if (action === "commit") planLedger.beginCommit(planRef.artifactId);
    else planLedger.noteDryRun(planRef.artifactId);
  }
  // capsule 不写回 store（§4.3.2）：只读证据一旦进了 store 就会被别人查到、
  // 被 LRU 淘汰、并与真实快照混淆。改为随返回值交给调用方，由它显式传给
  // getContext——用途因此在调用点可见，而不是藏在一次副作用里。
  const capsule =
    plan.contextSnapshot && !snapshotStore?.get(plan.contextSnapshot.contextId)
      ? { ...canonicalClone(plan.contextSnapshot.snapshot), contextId: plan.contextSnapshot.contextId }
      : null;

  const mutationRequest = canonicalClone(plan.mutationRequest);
  mutationRequest.dryRun = action === "dry_run";
  applyConfirmations(mutationRequest, expectedTargetTool, confirmations);
  applyExecutionOptions(mutationRequest, expectedTargetTool, executionOptions);

  return {
    targetTool: plan.targetTool,
    mutationRequest,
    // commit 的结果必须回填 ledger；null 表示这次不是 commit 或未启用 ledger。
    ledgerRef: planLedger && action === "commit" ? planRef.artifactId : null,
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
 * @param {string} [options.occurrenceId]
 * @param {number} [options.expectedTimeOffsetBlick]
 * @param {object} [options.fingerprints]
 * @returns {{ kind: "plan", payload: object }}
 */
export function buildPlanArtifact({
  targetTool,
  mutationRequest,
  targetGroupUuid,
  occurrenceId,
  expectedTimeOffsetBlick,
  fingerprints = {},
  contextSnapshot,
}) {
  return {
    kind: "plan",
    payload: {
      targetTool,
      mutationRequest,
      ...(targetGroupUuid !== undefined ? { targetGroupUuid } : {}),
      ...(occurrenceId !== undefined ? { occurrenceId } : {}),
      ...(expectedTimeOffsetBlick !== undefined ? { expectedTimeOffsetBlick } : {}),
      fingerprints,
      ...(contextSnapshot !== undefined ? { contextSnapshot } : {}),
    },
  };
}

// 选择器是组内 index（§3.1）。不传表示"封存全部指纹"。
export function buildPlanContextSnapshot(stored, occurrence, { noteIndexes } = {}) {
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
    occurrenceId: occurrence.occurrenceId,
    trackIndex: occurrence.trackIndex,
    groupIndex: occurrence.groupIndex,
    targetGroupUuid: occurrence.targetGroupUuid,
    ...(Number.isFinite(occurrence.timeOffsetBlick)
      ? { timeOffsetBlick: occurrence.timeOffsetBlick }
      : {}),
    ...(Number.isFinite(occurrence.pitchOffsetSemitone)
      ? { pitchOffsetSemitone: occurrence.pitchOffsetSemitone }
      : {}),
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
