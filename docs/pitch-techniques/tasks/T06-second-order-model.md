# T06 — 二阶瞬态模型

- 状态：`done`
- 权威：[实施计划](../implementation-plan.md) F2、F2b、F3、§8、§17 提交 6
- 依赖：T01 corpus
- 解锁：T09

## 目标

实现瞬态响应与首峰参数化的明确分层，闭合角频率、分子单位、阻尼分支和尾部策略。

## 交付边界

- 复用 [reference](../reference/) 的论文 oracle 与工程派生测试，不在任务包重述公式。
- 覆盖欠阻尼、临界邻域、过阻尼产品范围、无阻尼限制和数值溢出。
- 实现权威计划规定的 reject/taper 行为与错误证据。
- 不实现 TechniqueIR、宿主插值或 planner surface。

## 验收

- 论文方程数值例、首峰、尾部和全阻尼扫参通过。
- 单位错误、不可表示相位、未收敛尾部和 taper 冲突分别返回指定错误族。
- 合法有限输入不产生 NaN、Infinity 或静默裁剪。

## 完成条件

瞬态 primitive 可由 T09 消费，且论文响应与工程边界没有混写。

## 完成记录

- 证据：[T06-second-order-model.md](../evidence/T06-second-order-model.md)
- 提交：本任务的独立提交见 Git history。
- 宿主：未接触；零 host call、零 setter、零 Undo。
- 序列化：未新增公开 schema、MCP 或 Artifact surface，字节变化为 0。
