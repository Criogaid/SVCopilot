// facade 的 operation catalog。
//
// 唯一的 schema 来源是 index.js 的 TOOLS：这里只维护「工具 → facade 分组」的路由标签，
// 不复制任何 inputSchema。复制会立刻产生第二份需要手工同步的契约，而 catalog 的
// 全部价值正是消除它——facade 暴露的必须与 direct tool 校验的是同一个对象。
//
// 每个工具都必须在 FACADE_BY_TOOL 登记。未登记时 buildOperationCatalog 抛错，让
// 「加了工具但 facade 不认识」在服务器启动/npm test 阶段失败，而不是等到某个客户端
// 发现工具不可达。没有「排除」选项：facade 是唯一 surface，被排除就等于不可达。
import { jsonContentHash } from "./schema-identity.js";

export const FACADE_ORDER = [
  "status",
  "read",
  "plan",
  "edit",
  "audition",
  "artifact",
  "raw",
];

const FACADE_BY_TOOL = new Map([
  // raw dispatcher 与通用 workflow 执行器：高层工具尚未覆盖的官方 SV2 API 只能
  // 从这里进入，因此它必须有 facade 归属，否则 8-tool surface 会砍掉逃生通道。
  ["sv_root", "raw"],
  ["sv_call", "raw"],
  ["sv_index", "raw"],
  ["sv_free", "raw"],
  ["sv_run", "raw"],

  ["sv_ping", "status"],
  ["sv_doctor", "status"],
  ["sv_search_api", "status"],
  ["sv_describe", "status"],

  ["sv_snapshot", "read"],
  ["sv_snapshot_range", "read"],
  ["sv_wait_for_processing", "read"],
  ["sv_get_parameter_curve", "read"],
  ["sv_get_voice_profile", "read"],
  ["sv_compare_computed_pitch", "read"],
  ["sv_analyze_pitch_techniques", "read"],
  ["sv_analyze_phrase", "read"],
  ["sv_analyze_vocal_context", "read"],
  ["sv_style_profile", "read"],
  ["sv_validate_lyrics_prosody", "read"],

  ["sv_plan_expression", "plan"],
  ["sv_plan_pitch_correction", "plan"],
  ["sv_plan_pitch_gesture", "plan"],
  ["sv_align_lyrics", "plan"],
  ["sv_quantize_notes", "plan"],
  ["sv_generate_harmony", "plan"],

  ["sv_set_lyrics", "edit"],
  ["sv_patch_notes", "edit"],
  ["sv_restructure_notes", "edit"],
  ["sv_patch_parameter_curves", "edit"],
  ["sv_patch_pitch_controls", "edit"],
  ["sv_bake_computed_pitch", "edit"],
  ["sv_edit_phrase", "edit"],
  ["sv_set_selection", "edit"],
  ["sv_clone_track_from_template", "edit"],

  ["sv_start_audition", "audition"],
  ["sv_get_audition", "audition"],
  ["sv_stop_audition", "audition"],
  ["sv_restore_audition", "audition"],
  ["sv_audition_compare", "audition"],
  ["sv_get_audition_compare", "audition"],
  ["sv_stop_audition_compare", "audition"],

  ["sv_read_artifact", "artifact"],
  ["sv_release_artifact", "artifact"],
]);

// read/plan/status 分组只允许只读工具。这个约束是可从 annotations 机械判定的，
// 因此由 buildOperationCatalog 强制，而不是靠 review 记得检查。
const READ_ONLY_FACADES = new Set(["status", "read", "plan"]);

// operation 名默认由工具名去掉 `sv_` 机械派生。下列例外因为语义在 facade 分组里
// 已经明确，去掉冗余动词/后缀——`sv_audition` 分组内不必再重复一遍 audition。
const OPERATION_NAME_OVERRIDES = new Map([
  ["sv_wait_for_processing", "wait_processing"],
  ["sv_validate_lyrics_prosody", "check_prosody"],
  ["sv_clone_track_from_template", "clone_track"],
  ["sv_start_audition", "start"],
  ["sv_get_audition", "get"],
  ["sv_stop_audition", "stop"],
  ["sv_restore_audition", "restore"],
  ["sv_audition_compare", "compare"],
  ["sv_get_audition_compare", "get_compare"],
  ["sv_stop_audition_compare", "stop_compare"],
  // sv_describe 这个工具名让位给 schema discovery 工具，官方 API 描述改叫 describe_api。
  ["sv_describe", "describe_api"],
  ["sv_read_artifact", "read"],
  ["sv_release_artifact", "release"],
]);

/**
 * operation 名 = 工具名去掉 `sv_` 前缀，除 OPERATION_NAME_OVERRIDES 登记的例外。
 */
export function operationNameForTool(toolName) {
  const override = OPERATION_NAME_OVERRIDES.get(toolName);
  if (override) return override;
  return toolName.startsWith("sv_") ? toolName.slice(3) : toolName;
}

/**
 * 内部 handler 名 → 模型可调用的 facade 工具名。未登记的工具是路由漂移，必须抛错
 * 而不是返回 undefined——静默返回会让 workflow guide 生成一个不存在的工具名。
 *
 * @param {string} toolName
 * @returns {string}
 */
export function facadeForTool(toolName) {
  const facade = FACADE_BY_TOOL.get(toolName);
  if (facade === undefined) {
    throw new Error(`tool "${toolName}" has no facade routing label`);
  }
  return `sv_${facade}`;
}

// 取描述的第一句作为 operation 摘要；catalog 资源用它做目录，tools/list 不带摘要。
function deriveSummary(description) {
  const text = String(description ?? "").trim();
  if (!text) return "";
  const match = text.match(/^(.+?[.!?])(\s|$)/s);
  const first = match ? match[1] : text;
  return first.length > 200 ? `${first.slice(0, 197)}...` : first;
}

/**
 * 从完整 TOOLS 数组构建 operation catalog。
 *
 * @param {object[]} tools - index.js 的 TOOLS
 * @returns {{operations: Map<string, object>, facades: Map<string, object[]>}}
 */
export function buildOperationCatalog(tools) {
  if (!Array.isArray(tools)) throw new Error("tools must be an array");

  const operations = new Map();
  const facades = new Map();

  for (const tool of tools) {
    const facade = FACADE_BY_TOOL.get(tool.name);
    if (facade === undefined) {
      throw new Error(
        `tool "${tool.name}" has no facade routing label; register it in operation-catalog.js`
      );
    }
    if (!FACADE_ORDER.includes(facade)) {
      throw new Error(`tool "${tool.name}" maps to unknown facade group "${facade}"`);
    }
    if (READ_ONLY_FACADES.has(facade) && tool.annotations?.readOnlyHint !== true) {
      throw new Error(
        `tool "${tool.name}" is not read-only and must not be routed through facade group "${facade}"`
      );
    }

    const operation = {
      operation: operationNameForTool(tool.name),
      tool: tool.name,
      facade: `sv_${facade}`,
      summary: deriveSummary(tool.description),
      // 完整描述必须保留：facade 是唯一 surface，模型读不到 direct tool 的
      // description，而那里承载着 Undo 边界、human_only 判断等安全语义。
      // 只留首句摘要会把这些约束从模型视野里删掉。
      description: tool.description,
      // 同一对象引用，不做深拷贝：facade 与内部 handler 必须校验同一份 schema。
      inputSchema: tool.inputSchema,
      schemaHash: jsonContentHash(tool.inputSchema),
      annotations: tool.annotations,
    };
    if (operations.has(operation.operation)) {
      throw new Error(`duplicate operation name: ${operation.operation}`);
    }
    operations.set(operation.operation, operation);
    if (!facades.has(facade)) facades.set(facade, []);
    facades.get(facade).push(operation);
  }

  // 登记了但 TOOLS 里不存在的工具名同样是漂移，必须报错。
  for (const name of FACADE_BY_TOOL.keys()) {
    if (!tools.some((tool) => tool.name === name)) {
      throw new Error(`facade routing label references unknown tool "${name}"`);
    }
  }

  return { operations, facades };
}
