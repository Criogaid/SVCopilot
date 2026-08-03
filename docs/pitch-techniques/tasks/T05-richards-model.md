# T05 — Richards Transition 模型

- 状态：`done`
- 权威：[实施计划](../implementation-plan.md) F1、F1b、§8、§17 提交 5
- 依赖：T01 corpus
- 解锁：T09

## 目标

实现 raw 与有限区间端点归一 Richards 前向模型，并机械证明权威计划规定的边界、方向和稳定性。

## 交付边界

- 生产实现只能调用 [reference](../reference/) 所验证的同一业务定义，不复制另一套 oracle。
- 覆盖上下行、端点、拐点、极值、非法输入和数值稳定分支。
- 保持纯函数、零宿主依赖、零 MCP 依赖。
- 不实现 score-step 映射、IR 组合或写入。

## 验收

- reference 数值例、属性测试和文档实例全部通过。
- 所有有限合法输入输出有限；不可表示输入结构化拒绝。
- 10,000 samples 性能达到权威计划门禁，记录 median/p95。

## 完成条件

模型可以作为 T09 的单一 transition primitive，且误差与来源分类可追溯。

## 完成记录

- 证据：[T05-richards-model.md](../evidence/T05-richards-model.md)
- 提交：本任务的独立提交见 Git history。
- 宿主：未接触；零 host call、零 setter、零 Undo。
- 序列化：未新增公开 schema、MCP 或 Artifact surface，字节变化为 0。
