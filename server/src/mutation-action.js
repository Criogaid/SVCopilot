// mutation 请求的 `action` 归一化（计划 §10.6、§13.4 规则 5）。
//
// 为什么这件事值得一个共享模块：`action` 不是 `dryRun` 的改名，而是把「省略等于写入」
// 反转成「省略即拒绝」。旧的 `dryRun: {type:"boolean", default:false}` 让"我忘了填"
// 和"我确实要提交"变成同一个请求——在写操作上，默认值指向了错误的方向。
//
// enum 没有默认值，因此 schema 层就能挡住漏填。但六个 mutation service 各自归一化
// 请求，如果每个都自己写一遍 `action === "dry_run"`，那么某一天有人把某处写成
// `action !== "commit"`（对 undefined 的结论相反）就会静默恢复旧的危险默认。
// 收敛成一个函数后，"写还是不写"在整个服务端只有一处定义。
//
// 内部各 service 仍用 `dryRun` 布尔驱动自己的执行路径：那是实现细节，改它没有收益。
// 本模块只负责把外部契约翻译成那个布尔。

export const MUTATION_ACTIONS = Object.freeze(["dry_run", "commit"]);

/**
 * 把外部 `action` 翻译成内部 dryRun 布尔。
 *
 * @param {unknown} action - 请求里的 action 字段
 * @param {object} [options]
 * @param {string} [options.path] - JSON Pointer，用于错误定位
 * @returns {boolean} true 表示本次不写宿主
 */
export function dryRunFromAction(action, { path = "/action" } = {}) {
  if (!MUTATION_ACTIONS.includes(action)) {
    // 缺失与拼错走同一条路径：两者都意味着调用方没有明确表达"要写"，
    // 而在写操作上，把不明确当成同意是不可接受的。
    const error = new Error(
      `action must be one of ${MUTATION_ACTIONS.join(", ")}; a write must be requested explicitly`
    );
    error.code = "INVALID_ARGUMENTS";
    error.details = { path, rule: MUTATION_ACTIONS.join(" | "), got: action };
    throw error;
  }
  return action === "dry_run";
}
