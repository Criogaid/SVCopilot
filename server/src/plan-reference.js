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
 * @returns {{ targetTool: string, mutationRequest: object }}
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
  if (
    plan.contextSnapshot &&
    snapshotStore &&
    !snapshotStore.get(plan.contextSnapshot.contextId)
  ) {
    snapshotStore.restore(plan.contextSnapshot.contextId, plan.contextSnapshot.snapshot);
  }

  const mutationRequest = canonicalClone(plan.mutationRequest);
  mutationRequest.dryRun = action === "dry_run";
  applyConfirmations(mutationRequest, expectedTargetTool, confirmations);
  applyExecutionOptions(mutationRequest, expectedTargetTool, executionOptions);

  return {
    targetTool: plan.targetTool,
    mutationRequest,
  };
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

// 选择器有两种写法，因为 5 个 planner 共用本构造器，而计划 §B2 步骤 5 要求逐对迁移：
//   noteIndexes —— 组内 index（§3.1），已迁移的那一对使用；
//   noteIds     —— 字符串 ID，尚未迁移的 planner 使用，随各自那一对迁移时删除。
//
// 两者都不传表示"封存全部指纹"。这里刻意**不**做静默兜底：如果把未知选择器当成
// "不过滤"，一次拼错的键名就会让 capsule 封存整个 occurrence，而那正是 capsule
// 要避免的（§4.3.2 最小完整集）。
export function buildPlanContextSnapshot(stored, occurrence, { noteIndexes, noteIds } = {}) {
  if (!stored || typeof stored.contextId !== "string" || !occurrence) {
    throw codedError("INVALID_ARGUMENTS", "plan context snapshot requires a stored context and occurrence");
  }
  if (noteIndexes !== undefined && noteIds !== undefined) {
    throw codedError(
      "INVALID_ARGUMENTS",
      "pass either noteIndexes or noteIds, not both"
    );
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
  } else if (noteIds !== undefined) {
    if (!Array.isArray(noteIds) || noteIds.some((noteId) => typeof noteId !== "string")) {
      throw codedError("INVALID_ARGUMENTS", "plan context snapshot noteIds must be strings");
    }
    const requested = new Set(noteIds);
    selectedFingerprints = fingerprints.filter((fingerprint) =>
      requested.has(fingerprint.noteId)
    );
    if (selectedFingerprints.length !== requested.size) {
      throw codedError(
        "INVALID_ARGUMENTS",
        "plan context snapshot noteIds must belong to the selected occurrence"
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
