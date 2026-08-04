# T18 — 全链路真机 RC

- 状态：`in_progress`
- 权威：[实施计划](../implementation-plan.md) §13、§16.5、§17 提交 18
- 依赖：T13、T15、T17；T14 仅在启用 P2b 时加入
- 解锁：T19、T20

## 目标

在真实 SynthV 上证明 MVP 的规划、单事务写入、处理等待、computed-pitch 比较和恢复闭环。

## 交付边界

- 逐场景执行 snapshot → plan → dry-run → isolated commit → wait → compare → cleanup。
- 覆盖权威计划 MVP 场景、排列稳定性、失败恢复和长 group 性能。
- P2b 使用独立条件清单，未启用不得拖累 MVP RC。
- 所有观测写入 acceptance Artifact，不把本机 fixture 当通用宿主事实。

## 验收

- 每次正常 commit 一个 Undo；所有临时轨、选择、播放、handle 和 Artifact 清空。
- 原工程最终 token 与测试前一致，无法恢复则停止并报告。
- 记录阶段 timings、host calls、PIPE/MCP bytes、median/p95 和人工试听待办。

## 完成条件

MVP 获得可复核真机 RC 证据，所有跳过项都有门禁原因。

## 当前进展

- 已提交运行时 H2 profile 接入（`2ca23eb`）与诊断可观测性（`fe572e7`）。
- 已重启单一 MCP 进程并确认精确 profile 匹配；MVP 场景 4 已完成一次可恢复真机闭环：
  [T18-live-host-rc.json](../evidence/T18-live-host-rc.json)。该记录只通过场景 4，另有
  13 个 MVP 场景尚未完成，P2b 也明确保持未启动。
- 场景 5 已证明写入、比较和内容恢复，但 Artifact descriptor 无法完全枚举，清理门禁仍开着；
  它在证据中保持 `in_progress`，不计入通过场景。
