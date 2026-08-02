// 省略「可由其它字段完全推导」的响应字段（计划 §11 删除项 17、§14 门禁「默认/空字段被省略」）。
//
// 这些字段不是错的，是**冗余**的：它们的取值可以从信封里已有的东西一字不差地推出来。
// 一个恒为 false 的布尔、一个恒为空的数组，占的是模型的注意力预算，却不携带任何模型
// 还不知道的信息。
//
// 为什么放在编码器边界而不是逐个服务里改：§10.2.1 的出现条件是一条**跨 operation**
// 的契约（「warnings 非空时」「retryable 仅为 true 时」「verification 出现即 attempted」），
// 而每个服务只知道自己返回什么。散到 40 多处 return 去改等于把同一条规则抄 40 遍，
// 且下一个新服务默认又是违规的。这里是所有 MCP 结果的唯一出口，折叠一次契约就对
// 整个 surface 成立——与 foldLegacyRootFields 同一个理由。
//
// **反例（必须保留的字段）**，这条边界比省略规则本身更重要：
//   - `passed: false` / `verified: false` —— 「尝试过且失败」与「从未尝试」是两件事。
//     省略它会让一次失败的读回验证看起来像一次没做过验证的成功写入。
//   - `effects` 的任何取值 —— 由 status 唯一推导时已经在 fillCanonicalEffects 补齐，
//     那是「补」不是「省」；矩阵允许多值时（rollback_failed）必须原样保留。
//   - `retryable: true` —— 只有 false 是默认值。
//
// 省略只针对**恒等于默认值**的情形，绝不针对「值恰好是 falsy」。

/**
 * `attempted` 在这两个容器里由「字段是否出现」承载（§10.2.1：出现即 attempted）。
 * 因此 attempted:false 意味着整个容器该消失，attempted:true 则意味着这个键本身冗余。
 */
const ATTEMPT_GATED_FIELDS = Object.freeze(["verification", "rollback"]);

// 计时字段（`timing` / `timings`）**不在**这里省略，尽管 §10.2.1 说它只该在
// diagnostics === true 时出现。原因是那条规则依赖一个还不存在的东西：facade 信封
// 目前只接受 {operation, arguments}，没有 §10.2.1 要求的外层 `diagnostics`
// （只有 sv_patch_notes 在自己的业务 schema 里声明了一个同名开关）。没有那个外层
// 开关，「只在请求时返回」就退化成「永远不返回」——那不是省略冗余，而是删掉一项
// 调用方无法再取回的证据。timing 的门控必须与 facade diagnostics 一起做。

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * 空 `detail` 是「没有明细」，与「有明细但没读」不同：后者由 detail 引用本身表达
 * （artifact + expiresAt + totalBytes），前者应当整个消失。
 */
function isEmptyDetail(value) {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (isPlainObject(value)) return Object.keys(value).length === 0;
  return false;
}

function pruneDetailContainer(container) {
  if (!isPlainObject(container)) return container;
  if (!Object.hasOwn(container, "detail")) return container;
  if (!isEmptyDetail(container.detail)) return container;
  const { detail: _detail, ...rest } = container;
  return rest;
}

/**
 * 去掉一个 attempt-gated 容器里的 `attempted` 键。容器出现本身就是 attempted 的证据，
 * 因此键内再写一遍 true 是同义重复。
 */
function stripAttemptedKey(container) {
  if (!isPlainObject(container)) return container;
  if (container.attempted !== true) return container;
  const { attempted: _attempted, ...rest } = container;
  return rest;
}

/**
 * 省略可推导字段。
 *
 * @param {object} envelope - 已完成 status 投影与 effects 补齐的根信封
 * @returns {object} 新对象；不修改入参（服务可能仍持有它做后续判断）
 */
export function omitDerivableFields(envelope) {
  if (!isPlainObject(envelope)) return envelope;
  // 没有信封的 operation（sv_raw 的 handle 图、官方文档查询）直接透出宿主值：
  // 在那些形状上套用根信封的出现条件会删掉宿主自己的字段。
  if (typeof envelope.status !== "string") return envelope;

  const pruned = {};
  for (const [field, value] of Object.entries(envelope)) {
    // 空 warnings：§10.2.1「非空时」。空数组与「没有警告」是同一件事。
    if (field === "warnings" && Array.isArray(value) && value.length === 0) continue;

    // retryable 只在为 true 时出现；false 是默认值，且 assertStatusEnvelope 只对
    // true 有约束，因此省略它不会放宽任何一条相容性检查。
    if (field === "retryable" && value !== true) continue;

    if (ATTEMPT_GATED_FIELDS.includes(field) && isPlainObject(value)) {
      // attempted:false —— 这一步从未发生过，整个容器都是噪声。容器内的
      // passed:null / verified:null 也只是「没有结论」的另一种写法。
      if (value.attempted === false) continue;
      pruned[field] = pruneDetailContainer(stripAttemptedKey(value));
      continue;
    }

    if (field === "data" || field === "error") {
      pruned[field] = pruneDetailContainer(value);
      continue;
    }

    pruned[field] = value;
  }
  return pruned;
}
