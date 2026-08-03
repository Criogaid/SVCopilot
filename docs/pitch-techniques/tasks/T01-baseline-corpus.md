# T01 — 基线与 Synthetic Corpus

- 状态：`done`
- 权威：[实施计划](../implementation-plan.md) §6、§15.1、§16.5、§17 提交 1
- 依赖：无
- 解锁：T02、T05、T06、T07、T16

## 目标

冻结可重复比较的实现、协议、宿主和性能基线，并建立后续数学任务共享的 synthetic corpus。

## 交付边界

- 记录当前 commit、接口版本、Lua protocol、宿主版本及公开 surface 计数。
- 建立权威计划 §6.2 要求的确定性 fixtures、seed 和期望分类。
- 为 corpus 添加加载与完整性测试；不得把实时宿主观测硬编码为数学真值。
- 只建立证据基础，不实现新模型、planner 或写入路径。

## 验收

- corpus 可由干净 checkout 重放，hash 稳定，损坏或缺项会立即失败。
- 现有完整测试全绿，基线记录不包含机器私有路径或真实工程歌词。
- 提交证据包含测试时间、serialized bytes 和运行环境。

## 完成条件

基线与 corpus 可供 T05–T07、T16 直接消费，且没有第二份公式或 schema。

## 完成记录

- 证据：[T01-baseline.md](../evidence/T01-baseline.md)
- 提交：本任务的独立提交见 Git history；证据记录的是提交前冻结的基线 commit。
- 宿主：未连接；仅运行 PIPE/Lua harness，零 setter、零 Undo。
