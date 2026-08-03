# T02 — H1 TimeAxis 证据与 Profile v2

- 状态：`blocked`
- 权威：[实施计划](../implementation-plan.md) §7.1、§7.2、§17 提交 2
- 依赖：T01 基线记录
- 解锁：T03 裁定、T04、T08

## 目标

用只读实机证据裁定 Node 与 SynthV 的秒/BLICK 换算是否满足全部 Hz 门禁，并扩展 host profile 表达结果。

## 交付边界

- 覆盖恒速、tempo mark 边界、阶跃变速和密集变速，完成权威计划要求的探针规模。
- 记录误差分布、采样范围、宿主/bridge 版本和原始证据 Artifact。
- 扩展 profile schema、捕获工具、fixture 与测试；未知结论保持 `unknown`。
- 只做读取，不调用 setter，不产生 Undo。

## 验收

- profile 可区分通过、失败、部分观测和未观测，不靠 message 文本推断。
- 同一证据重放得到相同裁定；敏感数据和完整脚本源码不进入响应。
- 明确写出 T03 是“需要”还是“不需要”，并给机械依据。

## 完成条件

H1 从 `partially_observed` 变成有证据的终态，T08 可据此使用确定门限。

## 当前阻塞

2026-08-03 的只读 `npm run doctor -- --json` 报告 bridge `hostState: "not_started"`。
因此不能采集恒速、阶跃和密集变速的实机 Artifact，也不能将 H1 升级为终态；当前
fixture 保持既有 45 点恒速结论 `partially_observed`，T03 裁定为 `not_determined`。

离线实现、回放验证和无 setter/Undo 的捕获序列已经完成，记录见
[T02-preflight.md](../evidence/T02-preflight.md)。在 SynthV 已启动且三个预置 tempo
工程可读时恢复本任务。
