// 规划器统一交接信封（主计划 P0-D）。
//
// 问题：expression / lyrics / quantize / harmony / pitch gesture 五个规划器各自返回 applyRequests、
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
// actionable plan 只通过 planRef 交接，响应不再内联 mutation 请求。

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
        "The sealed plan may restore its bounded context capsule while the artifact lease remains valid; the target tool still resolves the live target and rejects target drift before writing.",
    });
  }
  if (args.target?.contextId) {
    preconditions.push({
      kind: "context_valid",
      contextId: args.target.contextId,
      detail:
        "The sealed plan may restore its bounded context capsule while the artifact lease remains valid; the target tool still resolves the live target and rejects target drift before writing.",
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

/**
 * 把封存好的 PlanRef 装进 apply 信封，并把 planRef-only 规则钉在**这一个**边界上。
 *
 * 为什么规则住在这里而不是各 planner 里：五个 planner 此前各写一遍"seal 成功就替换
 * arguments、失败就留着 inline 的那份"，于是"失败会内联"这条行为被抄了五份，没有任何
 * 一处能被单独修好。§11 条目 7 删除 inline apply，因此这里只有两种合法结局：
 *
 * 1. actionable plan（有 mutation 要提交）→ apply.arguments 恒为 {planRef, action}。
 *    封存失败不再降级成内联：内联既超出 §4.4 的 16 KiB 预算（实测 320 KB），又绕过
 *    plan-ledger 的防重放——一份没有 planRef 的 payload 可以被无限次提交，而 mode:"add"
 *    的曲线补丁会因此叠加两次。失败必须是结构化错误，让调用方知道计划没有产出。
 * 2. no-change plan（没有任何要提交的东西）→ apply 允许为 null。这不是降级：没有
 *    mutation 就没有什么可封存，返回一个空的 planRef 才是编造。
 *
 * @param {object|null} envelope - buildApplyEnvelope 的返回值（no-change 时为 null）
 * @param {string|string[]|null} planRef - 已封存的 artifactId；多调用计划按调用顺序传数组
 * @param {string|null} expiresAt
 * @returns {object|null}
 */
export function sealApplyEnvelope(envelope, planRef, expiresAt) {
  // no-change：没有 actionable 内容，apply:null 是诚实答案（结局 2）。
  if (!envelope?.arguments) return envelope ?? null;
  // 单个 planRef 与 K 个（expression 的多次调用）走同一条路径：把它们统一成数组，
  // 避免"一次调用"和"多次调用"各写一份替换逻辑——那正是内联兜底被抄五份的成因。
  const refs = Array.isArray(planRef) ? planRef : [planRef];
  const callCount = 1 + (envelope.additionalCalls?.length ?? 0);
  // 每一次调用都必须有自己的 planRef：少一个就意味着那一次要么内联、要么静默消失。
  if (
    refs.length !== callCount ||
    refs.some((ref) => typeof ref !== "string" || ref.length === 0) ||
    new Set(refs).size !== refs.length ||
    typeof expiresAt !== "string" ||
    expiresAt.length === 0
  ) {
    throw planSealError();
  }
  return {
    ...envelope,
    arguments: { planRef: refs[0], action: "dry_run" },
    expiresAt,
    ...(envelope.additionalCalls
      ? {
          additionalCalls: envelope.additionalCalls.map((call, index) => ({
            ...call,
            arguments: { planRef: refs[index + 1], action: "dry_run" },
          })),
        }
      : {}),
  };
}

/**
 * 封存失败的结构化错误。单独成函数，方便 planner 在 seal 抛错时复用同一个错误码，
 * 而不是各自造一个近似的。
 */
export function planSealError(cause) {
  const error = new Error(
    "the plan could not be sealed into an artifact, so there is no planRef to hand back; " +
      "plans are submitted by planRef only (the inline payload path was removed because it " +
      "exceeds the response budget and bypasses replay protection). If the artifact quota is " +
      "full, release old artifacts you already hold, then re-run the planner."
  );
  error.code = "PLAN_SEAL_FAILED";
  if (cause?.message) error.details = { cause: cause.message };
  return error;
}
