// 工具 profile 条件优化：根据启用 profile 过滤 ListTools，减少模型可见工具定义体积。
// full 是默认兼容 profile；core/music/raw 只在明确需要时通过启动配置启用。

const PROFILES = new Map();

/**
 * 注册一个工具 profile。
 *
 * @param {string} name
 * @param {string[]} tools - 该 profile 启用的工具名列表
 */
export function registerToolProfile(name, tools) {
  if (typeof name !== "string" || !name) {
    throw new Error("profile name must be a non-empty string");
  }
  if (!Array.isArray(tools)) {
    throw new Error("profile tools must be an array");
  }
  PROFILES.set(name, tools);
}

/**
 * 获取启用的工具列表。
 *
 * @param {string} profileName
 * @param {object[]} allTools - 完整 TOOLS 数组
 * @returns {object[]}
 */
export function filterToolsByProfile(profileName, allTools) {
  const tools = PROFILES.get(profileName);
  if (!tools) {
    throw new Error(`unknown tool profile: ${profileName}`);
  }
  const set = new Set(tools);
  return allTools.filter((tool) => set.has(tool.name));
}

/**
 * 判断某工具是否在 profile 中启用。
 */
export function isToolEnabled(profileName, toolName) {
  const tools = PROFILES.get(profileName);
  if (!tools) {
    throw new Error(`unknown tool profile: ${profileName}`);
  }
  return tools.includes(toolName);
}

/**
 * 获取已注册的 profile 名称。
 */
export function registeredToolProfiles() {
  return [...PROFILES.keys()];
}

// 默认注册四个 profile（供参考；具体工具名单由调用方决定）。
// core：普通消费者常用的快照、分析、编辑、等待和试听闭环。
const CORE_TOOLS = [
  "sv_ping",
  "sv_release_artifact",
  "sv_snapshot",
  "sv_snapshot_range",
  "sv_wait_for_processing",
  "sv_patch_notes",
  "sv_edit_phrase",
  "sv_analyze_vocal_context",
  "sv_start_audition",
  "sv_get_audition",
  "sv_stop_audition",
  "sv_restore_audition",
  "sv_get_voice_profile",
  "sv_set_selection",
];

// music：所有高层音乐工具。
const MUSIC_TOOLS = [
  ...CORE_TOOLS,
  "sv_set_lyrics",
  "sv_restructure_notes",
  "sv_get_parameter_curve",
  "sv_patch_parameter_curve",
  "sv_patch_parameter_curves",
  "sv_patch_pitch_controls",
  "sv_plan_pitch_gesture",
  "sv_bake_computed_pitch",
  "sv_compare_computed_pitch",
  "sv_plan_expression",
  "sv_align_lyrics",
  "sv_analyze_phrase",
  "sv_style_profile",
  "sv_validate_lyrics_prosody",
  "sv_quantize_notes",
  "sv_generate_harmony",
  "sv_audition_compare",
  "sv_get_audition_compare",
  "sv_stop_audition_compare",
  "sv_clone_track_from_template",
];

// raw：dispatcher 与官方 API 查询。
const RAW_TOOLS = [
  "sv_root",
  "sv_call",
  "sv_index",
  "sv_free",
  "sv_search_api",
  "sv_describe",
  "sv_run",
  "sv_release_artifact",
];

// full：当前全部能力。
registerToolProfile("full", [...MUSIC_TOOLS, ...RAW_TOOLS]);
registerToolProfile("core", CORE_TOOLS);
registerToolProfile("music", MUSIC_TOOLS);
registerToolProfile("raw", RAW_TOOLS);
