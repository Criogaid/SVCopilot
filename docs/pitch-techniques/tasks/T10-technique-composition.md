# T10 — 确定性技法组合与约束

- 状态：`done`
- 权威：[实施计划](../implementation-plan.md) F5b、F6、§9.3、§17 提交 10
- 依赖：T09
- 解锁：T11

## 目标

把多个 canonical TechniqueIR 确定性组合成有界贡献曲线，保证输入排列不改变 plan hash 或结果。

## 交付边界

- 按权威优先级与 canonical key 排序，显式处理 overlap、null gap 和总点数预算。
- 先组合 contribution，再检查最终曲线边界；不得按调用顺序覆盖。
- 明细默认聚合，超预算 evidence 使用 Artifact。
- 不接触宿主、不生成最终写入请求。

## 验收

- 同一技法集合的全排列输出、hash 和警告完全一致。
- null gap 两侧互不影响；越界证据能区分 contribution 与 final 阶段。
- 10,000 samples 与高技法数量下满足性能和响应预算。

## 完成条件

组合器产生唯一、可验证、可交给 T11 编译的贡献曲线。

## 完成记录

- 证据：[T10-technique-composition.md](../evidence/T10-technique-composition.md)
- 提交：本任务的独立提交见 Git history。
- 宿主：未接触；零 host call、零 setter、零 Undo。
- 序列化：未新增公开 schema、MCP 或 Artifact surface，公开字节变化为 0；dense 结果保持内部，
  后续 planner 负责 Artifact 分页投影。
