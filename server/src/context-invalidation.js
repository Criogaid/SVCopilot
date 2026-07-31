// 按 operation 登记的 Context 失效策略（计划 §4.6）。
//
// 「mutation 成功后失效」是不安全的窄条件。正确规则是：
//
//   只要发生过宿主写入尝试，就不能继续信任相关 Context。
//
// 因此 partial / rollback_failed / outcome_unknown / 连接丢失 / 只完成部分 setter 的
// 故障路径全部必须失效。即使补偿已读回验证成功也要失效——宿主可能存在 journal
// 没有覆盖的派生状态（例如自动重算的音素）。
//
// 判据刻意是 writeAttempted 而不是 status：status 描述"结果如何"，而这里要问的是
// "有没有碰过宿主"。一次抛错的 setter 既不成功也不失败，但它可能已经改了工程。

/**
 * 失效范围：
 *   none            —— 零写入路径（dry-run / planner / 纯读取 / 零 setter 的 no_change）。
 *   target_group    —— 失效所有捕获了该 NoteGroup 的 Context。
 *   project_structure —— 失效全部 Context：轨道索引的含义变了。
 *   editor_state    —— 不按音乐 mutation 失效（selection / audition 只动 UI 与 mixer）。
 */
export const INVALIDATION_SCOPES = Object.freeze([
  "none",
  "target_group",
  "project_structure",
  "editor_state",
  // sv_raw 可以调用任意官方 setter，我们无法从 op 名推断它写了什么。
  // 这一类如实表达"发生过写入但目标未知"，并按保守方向（全量失效）处理。
  "unknown_host_write",
]);

export const CONTEXT_INVALIDATION_BY_OPERATION = Object.freeze({
  // ---- 音乐 mutation：任何 setter 或 Undo 边界都让目标组的 Context 过期 ----
  set_lyrics: { scope: "target_group", reason: "歌词写入改变 Note fingerprint，并触发音素重算。" },
  patch_notes: { scope: "target_group", reason: "字段写入改变 Note fingerprint，快照比对随即失效。" },
  restructure_notes: {
    scope: "target_group",
    reason: "插入/删除/拆分/合并改变组内编号，快照 index 不再对应同一个音符。",
  },
  patch_parameter_curves: {
    scope: "target_group",
    // 曲线写入不改 Note fingerprint，因此技术上 contextId 仍可用于定位音符。
    // 但 Automation 已经变了，任何基于该 Context 的曲线分析都会得出过期结论——
    // 而调用方无法从 contextId 判断"哪一部分还能信"。
    reason: "Automation 已改变；基于旧 Context 的曲线分析会给出过期结论。",
  },
  patch_pitch_controls: {
    scope: "target_group",
    reason: "宿主在每次 add/remove 后重排 PitchControl，封存的邻接关系随即失效。",
  },
  bake_computed_pitch: {
    scope: "target_group",
    reason: "写入一条新 PitchControlCurve；基于旧 Context 的曲线分析随即过期。",
  },
  edit_phrase: {
    scope: "target_group",
    reason: "一个 Undo 内组合 note/structure/curve/voice 编辑，上述任一都足以失效。",
  },
  // clone_track 插入轨道，于是所有 Context 里的 trackIndex 都可能指向别的轨道。
  // 按 NoteGroup 失效在这里不够：变的不是某个音符组，而是索引本身的含义。
  clone_track: {
    scope: "project_structure",
    reason: "插入轨道后所有已记录的 trackIndex 都可能指向别的轨道。",
  },

  // ---- editor state：不是音乐 mutation ----
  set_selection: {
    scope: "editor_state",
    reason: "选择是 UI 状态，不开 Undo 记录，也不改变任何音符。",
  },
  start: { scope: "editor_state", reason: "只动 mixer solo 与播放头，不开 Undo 记录。" },
  stop: { scope: "editor_state", reason: "只动 mixer solo 与播放头，并恢复到试听前的值。" },
  restore: { scope: "editor_state", reason: "只动 mixer solo 与播放头，从 recovery payload 恢复。" },
  compare: { scope: "editor_state", reason: "只切换 mixer solo；A/B 刻意不做临时编辑。" },
  get: { scope: "none", reason: "只读 audition 状态机，不碰宿主与工程。" },
  get_compare: { scope: "none", reason: "只读 A/B 比较状态机，不碰宿主与工程。" },
  stop_compare: { scope: "editor_state", reason: "只动 mixer solo 与播放头，并恢复原值。" },

  // ---- 纯读取与规划：绝不失效 ----
  ping: { scope: "none", reason: "只探测桥连通性，不碰工程数据。" },
  doctor: { scope: "none", reason: "只读安装诊断，绝不连接宿主。" },
  search_api: { scope: "none", reason: "查询本地官方文档镜像，不接触宿主。" },
  describe_api: { scope: "none", reason: "查询本地官方文档镜像，不接触宿主。" },
  snapshot: { scope: "none", reason: "捕获本身不失效已有 Context，两者可并存。" },
  snapshot_range: { scope: "none", reason: "捕获新 Context 不影响已有 Context 的有效性。" },
  wait_processing: { scope: "none", reason: "轮询只读计算结果，不写任何字段。" },
  get_parameter_curve: { scope: "none", reason: "只读 Automation 控制点，零 setter。" },
  get_voice_profile: { scope: "none", reason: "只读可观测 voice parameters，零 setter。" },
  compare_computed_pitch: { scope: "none", reason: "纯内存分析：只读 SnapshotStore，绝不碰宿主。" },
  analyze_phrase: { scope: "none", reason: "纯内存分析：只读 SnapshotStore，绝不碰宿主。" },
  analyze_vocal_context: { scope: "none", reason: "纯内存分析：复用四个分析器，零宿主调用。" },
  style_profile: { scope: "none", reason: "纯内存分析：只读 SnapshotStore，绝不碰宿主。" },
  check_prosody: { scope: "none", reason: "纯内存分析：只读 SnapshotStore，绝不碰宿主。" },
  plan_expression: { scope: "none", reason: "规划器绝不写宿主：只产出 PlanRef。" },
  plan_pitch_gesture: { scope: "none", reason: "规划器绝不写宿主：只产出 PlanRef。" },
  align_lyrics: { scope: "none", reason: "规划器绝不写宿主：只产出 PlanRef。" },
  quantize_notes: { scope: "none", reason: "规划器绝不写宿主：只产出 PlanRef。" },
  generate_harmony: { scope: "none", reason: "规划器绝不写宿主：只产出 PlanRef。" },
  release: { scope: "none", reason: "只释放进程内 artifact 租期，不接触宿主。" },

  // ---- raw dispatcher ----
  // 这里是诚实性的边界：sv_raw 可以调用任意官方 setter，我们无法从 op 名判断
  // 它写了什么。声明 target_group 会假装知道目标；声明 none 会在它确实写入后
  // 留下被信任的过期 Context。因此单独标一类，由 B2 决定是要求调用方声明目标、
  // 还是保守地全量失效。
  root: { scope: "none", reason: "只取 root 对象 handle，零 setter。" },
  index: { scope: "none", reason: "读取宿主对象的一个字段，零 setter。" },
  free: { scope: "none", reason: "释放进程内 handle 登记，不改变工程。" },
  call: {
    scope: "unknown_host_write",
    reason:
      "可调用任意官方 setter，无法从 op 名推断目标。B2 需在此要求显式目标声明，" +
      "或保守地按 project_structure 失效。",
  },
  run: {
    scope: "unknown_host_write",
    reason: "step graph 可包含任意 setter，同 call。",
  },
});

/**
 * @param {string} operation
 * @returns {{scope: string, reason: string}}
 */
export function invalidationPolicyFor(operation) {
  const policy = CONTEXT_INVALIDATION_BY_OPERATION[operation];
  if (!policy) {
    throw codedError(
      "INVALID_ARGUMENTS",
      `operation "${operation}" has no context invalidation policy; register it in context-invalidation.js`
    );
  }
  return policy;
}

/**
 * 按策略执行失效。判据是 writeAttempted，不是 status（见文件头注释）。
 *
 * @param {object} options
 * @param {object} options.store - SnapshotStore
 * @param {string} options.operation
 * @param {boolean} options.writeAttempted - 是否已执行 setter 或开启 Undo 边界
 * @param {string} [options.targetGroupUuid] - target_group 范围必需
 * @returns {{scope: string, invalidatedContexts: string[]}}
 */
export function invalidateContextsFor({ store, operation, writeAttempted, targetGroupUuid }) {
  const { scope } = invalidationPolicyFor(operation);
  if (scope === "none" || scope === "editor_state") {
    return { scope, invalidatedContexts: [] };
  }
  // 零写入路径不失效：dry-run 与零 setter 的 no_change 都没碰过宿主，
  // 让调用方重新快照只是白花一次往返。
  if (!writeAttempted) return { scope, invalidatedContexts: [] };

  if (scope === "project_structure" || scope === "unknown_host_write") {
    return {
      scope,
      invalidatedContexts: store.invalidateAllForProjectStructureChange(),
    };
  }
  if (typeof targetGroupUuid !== "string" || targetGroupUuid === "") {
    // 写入已发生却不知道目标：保守地全量失效。留下被信任的过期 Context 比多要一次
    // 重新快照危险得多。
    return {
      scope: "project_structure",
      invalidatedContexts: store.invalidateAllForProjectStructureChange(),
    };
  }
  return {
    scope,
    invalidatedContexts: store.invalidateContextsForTarget(targetGroupUuid),
  };
}

function codedError(code, message) {
  const error = new Error(`[${code}] ${message}`);
  error.code = code;
  return error;
}
