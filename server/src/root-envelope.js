// 根信封字段全集的唯一权威（计划 §10.2.1）。
//
// 「未列出的字段就是禁止的」只有在字段集恰好枚举于一处时才可执行。散落在 40 多个
// 服务里的 return 语句无法承担这个角色：每个服务只知道自己返回什么，没人知道全集。
//
// 这里做的是**审计**，不是重写。字段名分三类：
//   1. 契约字段（ROOT_ENVELOPE_FIELDS）—— 模型可以依赖的语义，跨 operation 一致；
//   2. 业务载荷 —— 应当在 `data` 之内，出现在根级即为契约违规；
//   3. 已登记的例外（LEGACY_ROOT_FIELDS）—— 迁移期仍在根级、但已知要收进 data 的字段。
// 第 3 类逐项写明理由与去处，因此"还没迁完"是可数的，而不是一句"以后再说"。

/**
 * 契约字段全集。出现条件见计划 §10.2.1。
 */
export const ROOT_ENVELOPE_FIELDS = Object.freeze({
  status: "恒存在。取值见冻结矩阵（result-status.js）",
  effects: "除 succeeded/no_change/planned/dry_run 外恒存在",
  data: "业务结果存在时",
  error: "失败类 status",
  warnings: "非空时；每项 {code, count, first?, detail?}",
  timing: "diagnostics === true 时",
  retryable: "仅为 true 时（默认 false 省略）",
  next: "存在可执行下一步时",
  verification: "曾尝试读回验证时（出现即 attempted）",
  rollback: "曾尝试补偿时（出现即 attempted）",
  undo: "曾开启 Undo 边界时",
  processing: "请求了 waitFor 且已观察时",
  recovery: "outcome_unknown 时",
  invalidatedContexts: "本次调用失效了 Context 时",
  evidence: "conflict 类失败的有界证据",
});

/**
 * `detail` 只允许出现在两处，层级固定。它**不是**根级字段：
 * 根级的 `detail` 会与「业务明细」和「错误证据」两种含义混在一起。
 */
export const DETAIL_PATHS = Object.freeze(["data.detail", "error.detail"]);

/**
 * 迁移期仍出现在根级的字段。每项必须写明它属于哪个 operation、为什么还没收进
 * `data`、以及最终去处——否则这张表会变成豁免口。
 */
export const LEGACY_ROOT_FIELDS = Object.freeze({
  // sv_status(doctor)：安装诊断不是「对某个工程对象的操作」，它的字段是诊断报告本身。
  // 计划 §10.3 把 doctor 的结论放在 data 里，但报告结构（versions/bridge/transport/
  // findings/stores/surface/hostProfiles）远超 data 的一层，迁移会牵动 doctor-cli
  // 的人类可读输出。B2 一并处理。
  kind: "sv_status(doctor)：报告类型标签；移入 data 或由 operation 唯一决定",
  installationHealthy: "sv_status(doctor)：安装健康结论 -> data.installationHealthy",
  generatedAt: "sv_status(doctor)：报告生成时刻 -> data",
  versions: "sv_status(doctor) -> data",
  bridge: "sv_status(doctor) -> data",
  transport: "sv_status(doctor) -> data",
  manifest: "sv_status(doctor) -> data",
  surface: "sv_status(doctor) -> data",
  stores: "sv_status(doctor) -> data",
  findings: "sv_status(doctor) -> data",
  hostProfiles: "sv_status(doctor) -> data",

  // sv_status(search_api / describe_api)：官方 API 文档查询，纯读取。
  query: "sv_status(search_api)：回显查询串 -> data",
  results: "sv_status(search_api) -> data",
  total: "sv_status(search_api) -> data",
  name: "sv_status(describe_api) -> data",
  description: "sv_status(describe_api) -> data",
  extends: "sv_status(describe_api) -> data",
  members: "sv_status(describe_api) -> data",
  methods: "sv_status(describe_api) -> data",
  creatableTypes: "sv_status(describe_api) -> data",
  source: "sv_status(describe_api) -> data",

  // sv_artifact(release)：幂等释放结果。计划 §10.8 的 data 是 {released}。
  released: "sv_artifact(release) -> data.released",
  artifactId: "sv_artifact(release)：回显入参，应当直接删除（§4.2 规则 3）",

  // mutation 家族：事务语义字段。atomicity 说明的是「本次写入用的是哪种保证」，
  // 属于结果语义而非业务载荷，B2 决定它是并入 verification 还是留在根级。
  atomicity: "全部 mutation：verified_compensation | none；B2 决定归属",
  indexBase: "mutation/read：恒为 0，可由契约声明一次而不必逐次返回",
  responseMode: "回显入参；§3.6 规定 responseMode 从外部 schema 删除",
  target: "mutation：目标描述 -> data.target",
  contextId: "read/plan：新建或复用的 Context -> data.contextId",
  observedAt: "read -> data.observedAt",
  contextExpiresAt: "read -> data.contextExpiresAt",
  snapshotToken: "read -> data.snapshotToken",
  changedSinceToken: "read -> data",
  consistency: "read -> data.consistency",
  page: "read 分页 -> data.page",
  artifactRef: "read/plan：明细引用 -> data.detail（§10.2.1 固定层级）",
  summary: "plan/analysis -> data.summary",
  sections: "analysis -> data.sections",
  operations: "plan/mutation -> data.operations",
  curves: "mutation -> data.curves",
  changes: "mutation -> data.changes",
  clampedCount: "mutation -> data",
  undoRecords: "mutation：与 undo.expectedUserUndoSteps 重复",
  undoLabel: "mutation：回显入参 -> data",
  undoLabelApplied: "mutation -> data",
  targetUuid: "mutation：与 target.groupUuid 重复",
  resolvedParameters: "mutation -> data",
  preflightMode: "mutation -> data",
  steps: "sv_raw(run) -> data.steps",
  exports: "sv_raw(run) -> data.exports",
  completedSteps: "sv_raw(run) -> data",
  handleOwnership: "sv_raw(run) -> data",
  timings: "全部服务：应当统一为契约字段 `timing`（单数）并只在 diagnostics 时返回",
  apply: "plan：交接信封 -> data.apply（§10.5 已如此规定）",
  applyRequests: "plan：已弃用别名，B2 删除",
  patchRequest: "plan：已弃用别名，B2 删除",
  restructureRequest: "plan：已弃用别名，B2 删除",
  detail: "根级 detail 违反 §10.2.1 的固定层级；移入 data.detail 或 error.detail",
});

/**
 * 分类一个根级字段。
 *
 * @param {string} field
 * @returns {"contract"|"legacy"|"violation"}
 */
export function classifyRootField(field) {
  if (Object.hasOwn(ROOT_ENVELOPE_FIELDS, field)) return "contract";
  if (Object.hasOwn(LEGACY_ROOT_FIELDS, field)) return "legacy";
  return "violation";
}

/**
 * `status` 按契约恒存在，但下列 operation 目前直接透出宿主值或文档对象，根本没有
 * 信封。它们全部是纯读取，因此"缺 status"不会让模型误判写入结果——这也是为什么
 * 这些是最后迁移的一批。
 *
 * 登记而不是忽略：这张表让「还欠几个」可数，B2 的信封迁移每完成一个就删一行。
 */
export const STATUSLESS_OPERATIONS = Object.freeze({
  ping: "宿主 pong 标量；B2 包成 {status, data:{pong:true}}",
  root: "sv_raw：宿主 root handle 图，直接透出；B2 按 §10.9 包成 data.handle/data.result",
  call: "sv_raw：宿主返回值直接透出；同上",
  index: "sv_raw：宿主字段值直接透出；同上",
  free: "sv_raw：宿主释放计数直接透出；同上",
  search_api: "sv_status：官方文档搜索结果 -> {status, data:{matches}}（§10.3）",
  describe_api: "sv_status：官方 API 类描述 -> {status, data}（§10.3）",
});

/**
 * @param {string} operation
 * @returns {boolean} 该 operation 是否已登记为「暂无信封」
 */
export function isStatuslessOperation(operation) {
  return Object.hasOwn(STATUSLESS_OPERATIONS, operation);
}

/**
 * 审计一个根信封：返回未登记的根级字段。空数组表示没有引入新的违规。
 *
 * @param {object} envelope
 * @returns {string[]}
 */
export function unregisteredRootFields(envelope) {
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) return [];
  return Object.keys(envelope)
    .filter((field) => classifyRootField(field) === "violation")
    .sort();
}
