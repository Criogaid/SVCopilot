# T15 — 单步开环 Pitch Correction

- 状态：`blocked`
- 权威：[实施计划](../implementation-plan.md) §10、§17 提交 15
- 依赖：T08、T13；需要已 commit 且保留 correction target 的 source PlanRef
- 解锁：T18、T19

## 目标

基于重新观测的 computed pitch 生成一次可审查的开环修正计划，不在工具内部循环提交。

## 交付边界

- 实现分段求解、权重、正则、秩前置和数值溢出边界，严格消费 source PlanRef。
- null gap 分块，低覆盖和不足证据在求解前拒绝。
- 输出普通 sealed PlanRef；执行继续走现有 mutation transaction。
- 不声称“改善”，真实改善必须由提交后重新 snapshot/compare 证明。

## 验收

- synthetic exact/null/低秩/溢出/边界案例与 [reference](../reference/) 一致。
- schema、ledger、Artifact capsule、MCP 错误投影和响应预算通过。
- 一次 plan + dry-run + commit 最多一个 Undo。

## 完成条件

修正计划可独立复算、拒绝不充分证据，并且没有隐藏闭环状态。
