// 规划器统一交接信封（主计划 P0-D）。
//
// 问题：expression / lyrics / quantize / harmony 四个规划器各自返回 applyRequests、
// patchRequest、restructureRequest 三种形状，LLM 必须记住四套协议才能找到"下一步调什么"。
// 本模块把它们收敛成一个 apply 顶层字段，各规划器仍自行决定 tool 与 arguments。
//
// 诚实性边界（不得在统一过程中被稀释）：
// - apply.arguments 必须逐字通过目标工具公布的 inputSchema，不做任何"信封专用"改写。
// - atomicity 一律是 "verified_compensation"（读回补偿），不是 ACID；工具返回的
//   rolled_back / rollback_failed / partial / outcome_unknown 语义不因信封改变。
// - plan 不是跳过 live preflight 的凭据：宿主没有 revision API，preconditions 只描述
//   规划时观测到的前提，仍由目标工具在写入前对活宿主重新校验。
// - expectedUserUndoSteps 是"用户需要按几次撤销"的诚实计数：expression 的非相邻表现手法簇
//   会拆成 K 次调用即 K 条 Undo 记录，不能谎报为 1。
//
// 大型计划优先通过 planRef 交接，避免在响应里重复内联 mutation 请求。

export const PLAN_ATOMICITY = "verified_compensation";

// 目标工具在写入前会对活宿主重新校验的前提条件。规划器只声明"我基于什么规划的"。
function preconditionsFor(calls) {
  const preconditions = [];
  const first = calls[0];
  const args = first.arguments;
  if (typeof args.contextId === "string") {
    preconditions.push({
      kind: "context_valid",
      contextId: args.contextId,
      detail:
        "Inline apply needs a live snapshot context. A sealed planRef may restore its bounded context capsule while the artifact lease remains valid; both paths still resolve the live target and reject target drift before writing.",
    });
  }
  if (args.target?.contextId) {
    preconditions.push({
      kind: "context_valid",
      contextId: args.target.contextId,
      detail:
        "Inline apply needs a live snapshot context. A sealed planRef may restore its bounded context capsule while the artifact lease remains valid; both paths still resolve the live target and reject target drift before writing.",
    });
  }
  if (Array.isArray(args.patches) && args.patches.some((patch) => patch.expected)) {
    preconditions.push({
      kind: "note_fields_unchanged",
      detail:
        "Each patch carries expected field values checked against the live note before any write (EXPECTED_MISMATCH → a human edited the note; re-snapshot and re-plan).",
    });
  }
  if (Array.isArray(args.target?.expectedNotes) && args.target.expectedNotes.length > 0) {
    preconditions.push({
      kind: "note_anchors_unchanged",
      noteCount: args.target.expectedNotes.length,
      detail:
        "Curve positions are anchored to these note fingerprints; a moved or edited note fails STALE_CONTEXT with effects none instead of writing at stale positions.",
    });
  }
  if (Number.isFinite(args.target?.expectedTimeOffsetBlick)) {
    preconditions.push({
      kind: "reference_offset_unchanged",
      expectedTimeOffsetBlick: args.target.expectedTimeOffsetBlick,
      detail:
        "The whole NoteGroupReference must not have been moved via setTimeOffset since the snapshot.",
    });
  }
  return preconditions;
}

/**
 * 构造统一 apply 信封。
 *
 * @param {Array<{tool: string, arguments: object}>|null} calls
 *   按提交顺序排列的调用；null 或空数组表示无事可做（no_change），返回 null。
 * @param {{sharedTargetConfirmationRequired?: boolean}} [options]
 */
export function buildApplyEnvelope(calls, options = {}) {
  if (!Array.isArray(calls) || calls.length === 0) return null;
  const [first, ...rest] = calls;
  return {
    tool: first.tool,
    arguments: first.arguments,
    atomicity: PLAN_ATOMICITY,
    // K 次调用 = K 条用户可见的 Undo 记录。
    expectedUserUndoSteps: calls.length,
    ...(calls.length > 1
      ? {
          callIndex: 0,
          callCount: calls.length,
          // 必须按顺序提交；每次都先 dryRun 再提交，中途失败不会自动回滚已提交的前序调用。
          additionalCalls: rest.map((call, index) => ({
            callIndex: index + 1,
            tool: call.tool,
            arguments: call.arguments,
          })),
          sequencing:
            "Submit these calls in order, dry-running each before committing it. They are separate transactions: a failure in a later call does NOT roll back earlier committed calls.",
        }
      : {}),
    preconditions: preconditionsFor(calls),
    ...(options.sharedTargetConfirmationRequired
      ? {
          requiresSharedTargetConfirmation: true,
          sharedTargetNote:
            "The target NoteGroup has multiple project occurrences, so this edit changes all of them. Set allowSharedTargetMutation:true only on explicit human instruction.",
        }
      : {}),
    planIsNotAPreflightToken:
      "This plan does not authorize skipping live preflight: SynthV exposes no project revision, so the target tool re-validates against the live host before writing.",
  };
}
