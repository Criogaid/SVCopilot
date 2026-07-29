// 统一响应投影：业务模块生成规范领域结果，ProjectionEngine 决定 compact/standard/audit 的最终形态。
// Phase 2 先定义接口和通用工具，各业务 kind 的投影 policy 按 kind 注册。

const POLICIES = new Map();

/**
 * 注册一种 kind 的投影策略。
 *
 * @param {string} kind
 * @param {object} policy
 * @param {function} policy.summarize - (canonical, options) => summary object
 * @param {function} [policy.chooseRepresentativeItems] - (canonical, options) => object
 * @param {function} [policy.paginateDetail] - (canonical, options) => detail object
 */
export function registerProjection(kind, policy) {
  if (typeof kind !== "string" || !kind) {
    throw new Error("projection kind must be a non-empty string");
  }
  if (typeof policy?.summarize !== "function") {
    throw new Error("projection policy must provide summarize()");
  }
  POLICIES.set(kind, policy);
}

/**
 * 投影一个规范领域结果。
 *
 * @param {object} options
 * @param {string} options.kind
 * @param {unknown} options.canonical
 * @param {string} [options.mode] - "compact" | "standard" | "audit"，默认 "standard"
 * @param {object} [options.options] - 传给 policy 的额外参数
 * @returns {{ mode: string, summary: object, representative?: object, detail?: object }}
 */
export function project({ kind, canonical, mode = "standard", options = {} }) {
  if (!["compact", "standard", "audit"].includes(mode)) {
    throw new Error(`unsupported projection mode: ${mode}`);
  }
  const policy = POLICIES.get(kind);
  if (!policy) {
    throw new Error(`unknown projection kind: ${kind}`);
  }

  const summary = policy.summarize(canonical, options);
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
    throw new Error(`projection policy ${kind}.summarize() must return an object`);
  }
  const result = { mode, summary };

  if (mode === "standard" || mode === "audit") {
    if (typeof policy.chooseRepresentativeItems === "function") {
      result.representative = policy.chooseRepresentativeItems(canonical, options);
    }
  }

  if (mode === "audit") {
    if (typeof policy.paginateDetail === "function") {
      result.detail = policy.paginateDetail(canonical, options);
    }
  }

  return result;
}

/**
 * 获取已注册的 kind 列表（用于 capabilities/debug）。
 */
export function registeredProjectionKinds() {
  return [...POLICIES.keys()];
}
