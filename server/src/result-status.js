// status × effects × isError 的唯一权威（计划 §4.5）。
//
// 冻结这张表的意义不是"记下十个字符串"，而是让「哪些结论可表达」成为机械可判定的：
// 任何服务返回矩阵外的 status、或与 status 不相容的 effects，都在编码阶段抛错，
// 而不是安静地流到模型面前。事务结论（partial / rollback_failed / outcome_unknown）
// 必须能如实表达——契约表达不了它们时，实现就只能撒谎。
//
// isError 的判据是「调用方要求的操作是否完成」，不是「是否需要人工恐慌」。
// isError 不影响 structuredContent 的传输：两种取值下客户端拿到的数据完全一样，
// 因此该字段应当如实反映"没做成"。

/**
 * retryable 语义：
 *   never       —— 成功类结论，无需重试。
 *   recapture   —— 重新快照 + 重新规划后可再试，但不得原样重放。
 *   by_code     —— 由 error.code 决定（如 HOST_TIMEOUT 可重放，INVALID_ARGUMENTS 不可）。
 *   forbidden   —— 绝不自动重试：宿主可能已有残留写入，重放会二次叠加。
 */
export const RESULT_STATUS_MATRIX = Object.freeze({
  succeeded: { effects: ["verified"], isError: false, retry: "never" },
  no_change: { effects: ["none"], isError: false, retry: "never" },
  planned: { effects: ["none"], isError: false, retry: "never" },
  dry_run: { effects: ["none"], isError: false, retry: "never" },
  conflict: { effects: ["none"], isError: true, retry: "recapture" },
  failed: { effects: ["none"], isError: true, retry: "by_code" },
  // 补偿已读回验证成功。正确的下一步是重新快照再规划，而不是重放同一 payload，
  // 因此这里刻意不是 retryable——它与「只有 effects:none 才允许自动重试」一致。
  rolled_back: { effects: ["reverted"], isError: true, retry: "never" },
  rollback_failed: { effects: ["may_remain", "unknown"], isError: true, retry: "forbidden" },
  partial: { effects: ["may_remain"], isError: true, retry: "forbidden" },
  outcome_unknown: { effects: ["unknown"], isError: true, retry: "forbidden" },
});

export const RESULT_STATUSES = Object.freeze(Object.keys(RESULT_STATUS_MATRIX));

// 这四个 status 的 effects 由 status 唯一确定，且计划 §10.2.1 规定线上可省略。
// 其余六个必须出现在响应里：模型需要知道"宿主里还剩什么"。
const IMPLIED_EFFECTS = new Set(["succeeded", "no_change", "planned", "dry_run"]);

/**
 * 补齐省略的 effects。只有当 status 的允许集合恰好一个取值时才能推导——
 * `rollback_failed` 可以是 may_remain 或 unknown，那个区别只有服务自己知道，
 * 猜一个就是在编造证据。
 *
 * @param {object} envelope
 * @returns {object} 新对象；不修改入参
 */
export function fillCanonicalEffects(envelope) {
  const entry = RESULT_STATUS_MATRIX[envelope.status];
  if (!entry) return envelope;
  if (envelope.effects !== undefined) return envelope;
  if (IMPLIED_EFFECTS.has(envelope.status)) return envelope;
  if (entry.effects.length !== 1) return envelope;
  return { ...envelope, effects: entry.effects[0] };
}

/**
 * @param {string} status
 * @returns {boolean}
 */
export function isErrorStatus(status) {
  return RESULT_STATUS_MATRIX[status]?.isError === true;
}

/**
 * @param {string} status
 * @returns {boolean} 该 status 是否绝不允许客户端原样重放
 */
export function forbidsAutomaticRetry(status) {
  const entry = RESULT_STATUS_MATRIX[status];
  return entry ? entry.retry === "forbidden" : false;
}

/**
 * 校验根信封的 status/effects/retryable 三者相容。不相容即抛错：这是实现 bug，
 * 不是可以降级上报的运行时状况。
 *
 * @param {object} envelope
 * @returns {void}
 */
export function assertStatusEnvelope(envelope) {
  const { status, effects, retryable } = envelope;
  const entry = RESULT_STATUS_MATRIX[status];
  if (!entry) {
    throw new Error(
      `status "${status}" is not in the frozen matrix; allowed: ${RESULT_STATUSES.join(", ")}`
    );
  }

  if (effects === undefined) {
    if (!IMPLIED_EFFECTS.has(status)) {
      throw new Error(`status "${status}" must carry effects (one of ${entry.effects.join(", ")})`);
    }
  } else if (!entry.effects.includes(effects)) {
    throw new Error(
      `status "${status}" cannot pair with effects "${effects}"; allowed: ${entry.effects.join(", ")}`
    );
  }

  // 硬规则：只有"宿主里什么都没留下"才允许客户端原样重放。
  if (retryable === true) {
    if (entry.retry === "forbidden" || entry.retry === "never") {
      throw new Error(`status "${status}" must not be marked retryable`);
    }
    const resolvedEffects = effects ?? entry.effects[0];
    if (resolvedEffects !== "none") {
      throw new Error(
        `retryable:true requires effects:"none"; got "${resolvedEffects}" on status "${status}"`
      );
    }
  }
}

/**
 * status 的规范 effects。服务省略 effects 时用它补齐，保持线上形状一致。
 *
 * @param {string} status
 * @returns {string|undefined}
 */
export function canonicalEffects(status) {
  return RESULT_STATUS_MATRIX[status]?.effects[0];
}

// ---------------------------------------------------------------------------
// 服务内部 status -> 矩阵 status 的投影
// ---------------------------------------------------------------------------
//
// 若干服务的内部 status 承载的是**状态机取值**（audition 的 playing/restored/…）
// 或**观测结论**（wait_processing 的 pending/coverage），而不是「调用方要求的操作
// 是否完成」。它们对服务自身有用，但放到根 status 上会让矩阵失去意义：模型无法再
// 靠一个封闭集合判断成败。
//
// 因此在编码边界一次性投影。状态机取值不丢失——它继续留在 `data.state` 里，那才是
// 它的归属（计划 §10.7 的 audition `data` 示例正是这样）。
const STATUS_PROJECTION = new Map([
  // audition 状态机：这些都表示"这次调用要求的动作做到了"。
  ["playing", { status: "succeeded", effects: "verified" }],
  ["stopped", { status: "succeeded", effects: "verified" }],
  ["stopped_by_user", { status: "succeeded", effects: "verified" }],
  ["restored", { status: "succeeded", effects: "verified" }],
  // 恢复成功但刻意跳过了人类之后的改动：仍然是做到了，差异由 warnings 说明。
  ["partially_restored", { status: "succeeded", effects: "verified" }],
  // 恢复没能读回证明：mixer solo / 播放头可能仍是 audition 设置的值。
  ["restore_failed", { status: "partial", effects: "may_remain" }],

  // 写入已通过读回验证，只是 phoneme 观察失败。降级为嵌套 processing.status 加一条
  // warning（§4.5）；顶层保持 succeeded/verified，否则模型会重放已经成功的 mutation。
  ["processing_observation_failed", { status: "succeeded", effects: "verified" }],

  // chunked-mutation 的「补偿跑过但没能证明恢复」：与"补偿明确失败"对模型是同一个
  // 结论（不能断定宿主已回到原状），因此归入 rollback_failed，用 effects 区分
  // "可能有残留"与"无法观测"。
  ["rollback_unverified", { status: "rollback_failed", effects: "unknown" }],

  // 写入后读回不符：部分写入残留在宿主里。
  ["verification_failed", { status: "partial", effects: "may_remain" }],

  // wait_processing 未在超时前达成条件。零写入，因此 effects:"none" 且可原样重放
  // （再等一轮可能就绪）——这正是矩阵允许 retryable 的唯一情形。
  ["processing_pending", { status: "failed", effects: "none", retryable: true }],
  ["stability_pending", { status: "failed", effects: "none", retryable: true }],
  ["phoneme_coverage_unsatisfied", { status: "failed", effects: "none", retryable: true }],
]);

/**
 * 把服务返回的根信封投影成矩阵内的 status/effects。
 * 已在矩阵内的 status 原样返回（只补齐省略的 effects）。
 *
 * @param {object} envelope
 * @returns {object} 新对象；不修改入参
 */
export function projectStatusEnvelope(envelope) {
  const { status } = envelope;
  if (typeof status !== "string") return envelope;
  if (RESULT_STATUS_MATRIX[status]) return envelope;

  const projected = STATUS_PROJECTION.get(status);
  if (!projected) {
    throw new Error(
      `status "${status}" is neither in the frozen matrix nor registered for projection; ` +
        `add it to RESULT_STATUS_MATRIX or STATUS_PROJECTION in result-status.js`
    );
  }

  return {
    ...envelope,
    status: projected.status,
    effects: envelope.effects ?? projected.effects,
    ...(projected.retryable ? { retryable: true } : {}),
    // 状态机取值不丢：它移到 data.state（若服务尚未自己放进去）。
    ...(projected.status !== status && isPlainObject(envelope.data)
      ? { data: { state: envelope.data.state ?? status, ...envelope.data } }
      : {}),
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
