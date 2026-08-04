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
  [T18-live-host-rc.json](../evidence/T18-live-host-rc.json)。场景 4、5 已通过，另有
  11 个 MVP 场景尚未完成，P2b 也明确保持未启动。
- 场景 5 的内容 token 已恢复，全部残留 Artifact lease 已在 TTL 后 prune；doctor 最终为
  `0 entries / 0 bytes`，cleanup 门禁闭合。
- 场景 12 因 P4 已选进程内后端而标为 `not_applicable`；T16 的 timeout recovery 证据保留为
  该条件裁定的依据。
- 场景 1 的首次零写入 RC 暴露 130 BPM 规范化端点与多曲线锚点过滤缺陷；修复提交
  `2ac7187` 经 `846 / 846` 完整测试和 MCP smoke 后，在重启进程上完成两条上下行 Richards
  transition 的 plan、dry-run、单 Undo commit、computed-pitch compare、精确 token 恢复与
  Artifact `0 entries / 0 bytes` 清理门禁。
- 场景 3 已完成 overshoot / preparation 的双曲线闭环：默认阻尼分支、连续 taper、单 Undo、
  宿主插值读回、computed-pitch 方向性观测、精确 token 恢复和零 Artifact 均通过。当前还剩
  9 个 MVP 场景未完成。
