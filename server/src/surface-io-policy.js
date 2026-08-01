// SurfaceIoPolicy：MCP surface 的传输形状注册表（计划 §2.3）。
//
// 它**不是**第二套路由。业务 handler 永远不读它——真正的路由是 OperationCatalog，
// 真正的校验是各 operation 自己的 Ajv schema。这里只记录「每个暴露面的传输形状与
// 预算」，供门禁审计。若 handler 开始读它来决定语义，就会出现两份互相漂移的真相。
//
// 覆盖三类边界，key 一律带 kind 前缀：operation / tool / resource / bridge 可以同名
// （`sv_describe` 既是工具又几乎是 operation 名），不带前缀会互相吞掉。

import { buildOperationCatalog } from "./operation-catalog.js";

// 计划 §2.3 的策略分类。requestShape/responseShape 只能取这些值。
export const POLICY_SHAPES = Object.freeze([
  "scalar-inline",
  "bounded-inline",
  "range-scoped",
  "range-scoped-grouped",
  "mutation-plan-ref",
  "artifact-summary",
  "raw-dispatch",
  "editor-state",
]);

// 响应预算（§4.4 规则 8/9）。error 预算比 success 小：错误绝不该塞进大型证据。
export const COMPACT_MAX_BYTES = 16 * 1024;
export const ERROR_MAX_BYTES = 8 * 1024;
// 请求预算：facade 信封 + 业务 arguments。grouped planner 请求是最大的一类。
export const REQUEST_MAX_BYTES = 16 * 1024;

/**
 * 合法回显白名单（§10.2.2）。§4.4 规则 7 禁止回显调用方刚发过的输入，但少数字段是
 * **必要业务证据**：省略它们会让模型无法确定下一步。每项都必须写明理由。
 */
const ALLOWED_ECHOES = Object.freeze({
  invalidatedContexts:
    "全部 mutation：告知哪些 Context 已不可用。即使等于请求的 contextId 也必须返回——" +
    "模型无从推断服务端到底失效了哪些。",
  "data.id":
    "audition get/stop/restore/get_compare/stop_compare：幂等状态机的身份确认。" +
    "多个 audition 并发时省略它就无法分辨这是哪一个的终态。",
  "evidence.occurrence":
    "conflict 类失败：定位冲突位置。多 occurrence 请求下它等于输入值，但仍必需。",
  "evidence.note":
    "conflict 类失败：定位冲突到具体 Note。同上。",
});

export function allowedEchoReason(field) {
  return ALLOWED_ECHOES[field] ?? null;
}

export function isAllowedEcho(field) {
  return Object.hasOwn(ALLOWED_ECHOES, field);
}

// operation -> 形状。按 facade 分组书写，因为同组 operation 的传输形状基本一致；
// 但逐个登记而不是按组推导——推导会让「新增 operation 未登记」这条门禁失效。
const OPERATION_POLICIES = {
  // sv_status：轻量状态与官方文档查询，不碰工程数据。
  ping: { request: "scalar-inline", response: "scalar-inline", hostTraffic: "single-call" },
  doctor: { request: "scalar-inline", response: "bounded-inline", hostTraffic: "none" },
  search_api: { request: "bounded-inline", response: "bounded-inline", hostTraffic: "none" },
  describe_api: { request: "bounded-inline", response: "bounded-inline", hostTraffic: "none" },

  // sv_read：捕获与分析。snapshot 系列产出 Context 与 Artifact 明细。
  snapshot: { request: "bounded-inline", response: "artifact-summary", hostTraffic: "paged-read" },
  snapshot_range: {
    request: "bounded-inline",
    response: "artifact-summary",
    hostTraffic: "bulk-read",
  },
  wait_processing: { request: "range-scoped", response: "bounded-inline", hostTraffic: "polling" },
  get_parameter_curve: {
    request: "range-scoped",
    response: "artifact-summary",
    hostTraffic: "bounded-read",
  },
  get_voice_profile: {
    request: "range-scoped",
    response: "bounded-inline",
    hostTraffic: "bounded-read",
  },
  // 以下四个是纯内存分析：读 SnapshotStore，绝不碰宿主。
  compare_computed_pitch: {
    request: "range-scoped",
    response: "artifact-summary",
    hostTraffic: "none",
  },
  analyze_phrase: { request: "range-scoped", response: "artifact-summary", hostTraffic: "none" },
  analyze_vocal_context: {
    request: "range-scoped",
    response: "artifact-summary",
    hostTraffic: "none",
  },
  style_profile: { request: "range-scoped", response: "artifact-summary", hostTraffic: "none" },
  check_prosody: { request: "range-scoped", response: "artifact-summary", hostTraffic: "none" },

  // sv_plan：全部纯内存，产出 PlanRef。
  plan_expression: {
    request: "range-scoped-grouped",
    response: "mutation-plan-ref",
    hostTraffic: "none",
  },
  plan_pitch_gesture: {
    request: "range-scoped-grouped",
    response: "mutation-plan-ref",
    hostTraffic: "none",
  },
  align_lyrics: {
    request: "range-scoped-grouped",
    response: "mutation-plan-ref",
    hostTraffic: "none",
  },
  quantize_notes: {
    request: "range-scoped-grouped",
    response: "mutation-plan-ref",
    hostTraffic: "none",
  },
  generate_harmony: {
    request: "range-scoped-grouped",
    response: "mutation-plan-ref",
    hostTraffic: "none",
  },

  // sv_edit：写入。全部走事务核（Undo 边界 + 读回验证 + 逆序补偿）。
  set_lyrics: { request: "range-scoped", response: "mutation-plan-ref", hostTraffic: "write" },
  patch_notes: { request: "range-scoped", response: "mutation-plan-ref", hostTraffic: "write" },
  restructure_notes: {
    request: "range-scoped",
    response: "mutation-plan-ref",
    hostTraffic: "write",
  },
  patch_parameter_curves: {
    request: "range-scoped-grouped",
    response: "mutation-plan-ref",
    hostTraffic: "write",
  },
  patch_pitch_controls: {
    request: "range-scoped-grouped",
    response: "mutation-plan-ref",
    hostTraffic: "write",
  },
  bake_computed_pitch: {
    request: "range-scoped",
    response: "mutation-plan-ref",
    hostTraffic: "write",
  },
  edit_phrase: {
    request: "range-scoped-grouped",
    response: "mutation-plan-ref",
    hostTraffic: "write",
  },
  // selection 是编辑器 UI 状态，不开 Undo 记录。
  set_selection: { request: "editor-state", response: "editor-state", hostTraffic: "write" },
  clone_track: { request: "bounded-inline", response: "mutation-plan-ref", hostTraffic: "write" },

  // sv_audition：非阻塞播放状态机，只动 mixer solo 与播放头。
  start: { request: "editor-state", response: "editor-state", hostTraffic: "write" },
  get: { request: "editor-state", response: "editor-state", hostTraffic: "bounded-read" },
  stop: { request: "editor-state", response: "editor-state", hostTraffic: "write" },
  restore: { request: "editor-state", response: "editor-state", hostTraffic: "write" },
  compare: { request: "editor-state", response: "editor-state", hostTraffic: "write" },
  get_compare: { request: "editor-state", response: "editor-state", hostTraffic: "bounded-read" },
  stop_compare: { request: "editor-state", response: "editor-state", hostTraffic: "write" },

  // sv_artifact：进程内不可变数据的租期管理，不碰宿主。
  release: { request: "scalar-inline", response: "scalar-inline", hostTraffic: "none" },

  // sv_raw：官方 API 逃生通道。参数任意，但 handle 只用短整数 + epoch。
  root: { request: "raw-dispatch", response: "raw-dispatch", hostTraffic: "single-call" },
  call: { request: "raw-dispatch", response: "raw-dispatch", hostTraffic: "single-call" },
  index: { request: "raw-dispatch", response: "raw-dispatch", hostTraffic: "single-call" },
  free: { request: "raw-dispatch", response: "raw-dispatch", hostTraffic: "single-call" },
  run: { request: "raw-dispatch", response: "raw-dispatch", hostTraffic: "step-graph" },
};

// tool-level：facade 本身的调度信封。sv_describe 不套 operation，因此只有 tool policy。
const TOOL_POLICIES = {
  sv_status: { request: "bounded-inline", response: "bounded-inline" },
  sv_read: { request: "bounded-inline", response: "artifact-summary" },
  sv_plan: { request: "range-scoped-grouped", response: "mutation-plan-ref" },
  sv_edit: { request: "range-scoped-grouped", response: "mutation-plan-ref" },
  sv_audition: { request: "editor-state", response: "editor-state" },
  sv_artifact: { request: "scalar-inline", response: "scalar-inline" },
  sv_raw: { request: "raw-dispatch", response: "raw-dispatch" },
  sv_describe: { request: "bounded-inline", response: "bounded-inline" },
};

// 静态 resource 与 resource template（§2.3 规则 7）。全部只读、无宿主流量。
const RESOURCE_POLICIES = {
  "svapi://manifest": { response: "artifact-summary" },
  "svapi://class/{class}": { response: "bounded-inline" },
  "svcopilot://capabilities": { response: "bounded-inline" },
  "svcopilot://operations": { response: "bounded-inline" },
  "svcopilot://guide/music-workflows": { response: "bounded-inline" },
  "svcopilot://guide/music-workflows/{recipe}": { response: "bounded-inline" },
  "svcopilot://schemas/music-workflow": { response: "bounded-inline" },
  "svcopilot://schemas/{tool}": { response: "bounded-inline" },
  "svcopilot://artifacts": { response: "bounded-inline" },
  "svcopilot://artifacts/{artifactId}/{contentHash}": { response: "artifact-summary" },
  "svcopilot://artifacts/{artifactId}/{contentHash}/pages/{cursor}": {
    response: "artifact-summary",
  },
};

/**
 * negotiated bridge opcode（§2.3 规则 8）。这条边界不消耗 LLM token，但同样需要
 * frame/item/field/allocation 上限，否则一次 bulk read 就能撑爆 64 KiB frame。
 */
const BRIDGE_POLICIES = {
  read_note_fingerprints_v1: {
    maxFrameBytes: 64 * 1024,
    maxItems: 512,
    maxFields: 8,
    maxAllocations: 512 * 8,
  },
};

/**
 * 构建完整 policy 列表。key 带 kind 前缀，供门禁做「恰好登记一次」的计数。
 *
 * @param {object[]} tools - index.js 的 TOOLS
 * @returns {object[]}
 */
export function buildSurfaceIoPolicies(tools) {
  const { operations } = buildOperationCatalog(tools);
  const policies = [];

  for (const [operation, shape] of Object.entries(OPERATION_POLICIES)) {
    const entry = operations.get(operation);
    if (!entry) {
      throw new Error(
        `SurfaceIoPolicy registers unknown operation "${operation}"; remove it or fix the name`
      );
    }
    policies.push({
      key: `operation:${operation}`,
      kind: "operation",
      operation,
      tool: entry.facade,
      requestShape: shape.request,
      responseShape: shape.response,
      hostTraffic: shape.hostTraffic,
      requestMaxBytes: REQUEST_MAX_BYTES,
      compactMaxBytes: COMPACT_MAX_BYTES,
      errorMaxBytes: ERROR_MAX_BYTES,
      allowedEchoes: ALLOWED_ECHOES,
    });
  }

  for (const [tool, shape] of Object.entries(TOOL_POLICIES)) {
    policies.push({
      key: `tool:${tool}`,
      kind: "tool",
      tool,
      requestShape: shape.request,
      responseShape: shape.response,
      requestMaxBytes: REQUEST_MAX_BYTES,
      compactMaxBytes: COMPACT_MAX_BYTES,
      errorMaxBytes: ERROR_MAX_BYTES,
    });
  }

  for (const [uri, shape] of Object.entries(RESOURCE_POLICIES)) {
    policies.push({
      key: `resource:${uri}`,
      kind: "resource",
      uri,
      responseShape: shape.response,
      compactMaxBytes: COMPACT_MAX_BYTES,
    });
  }

  for (const [op, limits] of Object.entries(BRIDGE_POLICIES)) {
    policies.push({ key: `bridge:${op}`, kind: "bridge", bridgeOp: op, ...limits });
  }

  return policies;
}

/**
 * 请求 schema 里已经不存在、且绝不允许回归的字段名（§2.3 规则 3 / §11）。
 *
 * 这张表只放**已经清掉**的字段：门禁对它断言"必须为空"，因此任何回归立即失败。
 * 尚未清掉的写在 LEGACY_REQUEST_FIELDS——把它们混进这里只会让门禁一直红着，
 * 从而失去发现新问题的能力。
 */
export const BANNED_REQUEST_FIELDS = Object.freeze([
  "contextSnapshot",
  "detailRef",
  "planRefObject",
  "occurrenceId",
  "sourceOccurrenceId",
  "targetOccurrenceId",
  // usePlanRef:false 曾允许把整份 mutation payload 内联回响应里。它不只是体积问题：
  // 内联路径绕过 Plan Artifact，因此也绕过 plan-ledger 的防重放——同一份 mode:"add"
  // 曲线可以被提交两次而 preflight 全部通过。规划器现在一律交接 planRef。
  "usePlanRef",
  // dryRun 是**布尔**，因此有默认值，而默认值在写操作上指向错误的方向：省略它就
  // 等于同意写入。`action` 是无默认的 enum，所以「忘了填」在 schema 层就被挡住，
  // 不会变成一次真实写入。两者不能并存——那会让同一个请求有两处说法。
  "dryRun",
]);

/**
 * 迁移期仍存在于请求 schema 里的长身份/开关。B2 逐对 planner→apply 迁移时清空。
 * 与 root-envelope 的 LEGACY 表同理：登记让「还欠多少」可数，且门禁会拒绝过期条目。
 */
export const LEGACY_REQUEST_FIELDS = Object.freeze({
  responseMode: "§3.6：响应形状由契约规定，不由调用方选择（B2）",
  cursor: "§4.1：offset 分页降级为待数据评估（C2）",
});
