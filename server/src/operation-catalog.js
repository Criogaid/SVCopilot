// 紧凑 facade 的 operation catalog。
//
// 唯一的 schema 来源是 index.js 的 TOOLS：这里只维护「工具 → facade 分组」的路由标签，
// 不复制任何 inputSchema。复制会立刻产生第二份需要手工同步的契约，而 catalog 的
// 全部价值正是消除它——facade 暴露的必须与 direct tool 校验的是同一个对象。
//
// 新增工具必须在 FACADE_BY_TOOL 登记（raw dispatcher 显式登记为 null=不进入 compact
// profile）。未登记时 buildOperationCatalog 抛错，让「加了工具但 compact profile 不
// 认识」在 npm test 阶段失败，而不是等到某个客户端发现工具消失。

// facade 分组的稳定顺序；决定 tools/list 中 facade 工具的出现顺序。
export const FACADE_ORDER = ["status", "read", "plan", "edit", "delete", "audition", "artifact"];

// null 表示该工具刻意不进入 compact profile。
const FACADE_BY_TOOL = new Map([
  // raw dispatcher 与通用 workflow 执行器：保留在现有 raw/full profile，
  // 不进入 compact——它们的语义是宿主原生的，facade 无法为其提供有意义的收敛。
  ["sv_root", null],
  ["sv_call", null],
  ["sv_index", null],
  ["sv_free", null],
  ["sv_run", null],

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
  ["sv_analyze_phrase", "read"],
  ["sv_analyze_vocal_context", "read"],
  ["sv_style_profile", "read"],
  ["sv_validate_lyrics_prosody", "read"],

  ["sv_plan_expression", "plan"],
  ["sv_plan_pitch_gesture", "plan"],
  ["sv_align_lyrics", "plan"],
  ["sv_quantize_notes", "plan"],
  ["sv_generate_harmony", "plan"],

  ["sv_set_lyrics", "edit"],
  ["sv_patch_notes", "edit"],
  ["sv_restructure_notes", "edit"],
  ["sv_patch_parameter_curve", "edit"],
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

  ["sv_release_artifact", "artifact"],
]);

// read/plan 分组只允许只读工具。这个约束是可从 annotations 机械判定的，
// 因此由 buildOperationCatalog 强制，而不是靠 review 记得检查。
const READ_ONLY_FACADES = new Set(["status", "read", "plan"]);

/**
 * operation 名 = 工具名去掉 `sv_` 前缀。规则化派生，不手工维护第二套命名。
 */
export function operationNameForTool(toolName) {
  return toolName.startsWith("sv_") ? toolName.slice(3) : toolName;
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
 * @returns {{operations: Map<string, object>, facades: Map<string, object[]>, excluded: string[]}}
 */
export function buildOperationCatalog(tools) {
  if (!Array.isArray(tools)) throw new Error("tools must be an array");

  const operations = new Map();
  const facades = new Map();
  const excluded = [];

  for (const tool of tools) {
    if (!FACADE_BY_TOOL.has(tool.name)) {
      throw new Error(
        `tool "${tool.name}" has no compact-facade routing label; register it in operation-catalog.js`
      );
    }
    const facade = FACADE_BY_TOOL.get(tool.name);
    if (facade === null) {
      excluded.push(tool.name);
      continue;
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
      // 同一对象引用，不做深拷贝：facade 与 direct tool 必须校验同一份 schema。
      inputSchema: tool.inputSchema,
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
      throw new Error(`compact-facade routing label references unknown tool "${name}"`);
    }
  }

  return { operations, facades, excluded };
}
