# T18 — 全链路真机 RC

- 状态：`done`
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
- 已重启单一 MCP 进程并确认精确 profile 匹配；MVP 场景 1、2、3、4、5、6、7、8、9、10、11、13、14
  已完成可恢复
  真机闭环：[T18-live-host-rc.json](../evidence/T18-live-host-rc.json)。场景 12 条件不适用，
  pending 清单为空；P2b 明确保持未启动。
- 场景 5 的内容 token 已恢复，全部残留 Artifact lease 已在 TTL 后 prune；doctor 最终为
  `0 entries / 0 bytes`，cleanup 门禁闭合。
- 场景 12 因 P4 已选进程内后端而标为 `not_applicable`；T16 的 timeout recovery 证据保留为
  该条件裁定的依据。
- 场景 1 的首次零写入 RC 暴露 130 BPM 规范化端点与多曲线锚点过滤缺陷；修复提交
  `2ac7187` 经 `846 / 846` 完整测试和 MCP smoke 后，在重启进程上完成两条上下行 Richards
  transition 的 plan、dry-run、单 Undo commit、computed-pitch compare、精确 token 恢复与
  Artifact `0 entries / 0 bytes` 清理门禁。
- 场景 3 已完成 overshoot / preparation 的双曲线闭环：默认阻尼分支、连续 taper、单 Undo、
  宿主插值读回、computed-pitch 方向性观测、精确 token 恢复和零 Artifact 均通过。
- 场景 6 已完成 Richards transition、overshoot transient、显式振音的重叠合成，并以完全反转
  的输入顺序获得相同 `planId`、曲线数和点数。单 Undo commit、166 个宿主插值样本、
  computed-pitch compare、精确 token 恢复与 Artifact `0 entries / 0 bytes` 均通过。
- 场景 7 已以写后宿主快照确认纯 transition 只改变 `pitchDelta` Automation：目标范围新增
  34 点，`PitchControlCurve` 前后均为 0，`vibratoEnv` 未触及。单 Undo、插值读回、精确 token
  恢复和零 Artifact 均通过。
- 场景 8 以临时共享引用验证两 occurrence：未确认路径在 preflight 零写入拒绝，确认路径一个
  用户 Undo，两个 occurrence 均回读到相同 target mutation 并完成 computed-pitch compare。
  Automation 与临时引用分层恢复后原项目 token 精确匹配，Artifact 与 raw handle 均归零。
- 场景 9 已在 singer-bound target 上完成 12 / 373 音符规模验证。两者 34 点 planner 主响应均为
  `1,817 bytes`，长组 dense 数据只进入可分页 Artifact；dry-run 零写入，正常 commit 各为一个
  用户 Undo 且宿主插值回读通过。12 音符路径完成 computed-pitch compare；373 音符路径连续两个
  30 秒窗口仍为全空 computed pitch，并明确转交场景 10，不伪报 compare 成功。长组临时音符分批
  移除后，可编辑内容 token 精确 `no_change`，Artifact、handle 和 pending execution 均归零。
- 场景 10 以只读快照固定 full / partial / all-null computed pitch 语义：全覆盖 `32 / 32` 正常
  分析；低覆盖有效 `5 / 32` 且返回 `LOW_COMPUTED_PITCH_COVERAGE`；全空 `0 / 2000` 返回
  `INSUFFICIENT_COMPUTED_PITCH`，不伪报零误差。该场景零 setter、零 Undo，Artifact 全部释放。
- 场景 13 在一个双参数事务中让 `vibratoEnv` adaptive midpoint 产生 `0.25` 的受控误差，验证
  `POSTCONDITION_FAILED` 会触发 `vibratoEnv → pitchDelta` 逆序补偿。两条曲线均读回恢复，一个
  用户 Undo，最终双参数 token 精确 `no_change`；场景自身 Artifact 全部释放。
- 场景 14 在 21 帧 null gap 两侧提交相反方向 transient；重启后验证 `48c723e` 修复的 float32
  baseline fingerprint，175 点以单 Undo 提交，null frame 数前后不变，左右中心变化方向相反，
  最终 token 精确 `no_change`，Artifact、handle 和 pending execution 均归零。
- 场景 2 通过可逆延长音符获得足够的分析窗，在 Richards transition 边界与显式振音内部设置
  `90 → 170 BPM` 阶跃。500 原始帧重采样为 551 个等秒有效帧，目标 `5.5 Hz` 实测 `5.46 Hz`，
  `0.7273%` 偏差通过真机 1% 门禁。曲线、音符、tempo 与中断前残留均已恢复，原项目长范围 token
  精确 `no_change`，资源计数归零。
- 场景 11 的同连接漂移在 preflight 返回 `CURVE_BASELINE_CHANGED`，跨 Lua bridge epoch 的旧
  PlanRef commit 返回 `STALE_CONTEXT`；两条拒绝路径均为 effects none、零 host write、零 Undo。
  sentinel 清除及重连后的内容 token 均为 `no_change`。同轮验证 `e2e3552` 的 Automation 端点
  clamp，并用 `bd1539d` 修复重连后 scoped handle 释放；重启复测后 Artifact、handle 和 pending
  execution 全部归零。

## 完成记录

- 证据：[T18-live-host-rc.json](../evidence/T18-live-host-rc.json) 与
  [T18-live-host-rc.md](../evidence/T18-live-host-rc.md)。
- 裁定：13 个 MVP 场景通过，外部 worker 场景因 P4 选择进程内后端而条件不适用；pending 为空。
- 验证：场景 11 完成同连接 stale baseline、跨 epoch stale Context、精确 token 恢复与资源归零；
  完整 `npm test` 849/849、`npm run smoke:mcp` 通过。
- 条件能力：H3a 仍为 `unknown`、H3b 为 `partially_observed`，所以 T14/T19 保持 `conditional`，
  不启用 `PitchControlCurve` 或闭环写入。
- 提交：本任务的独立提交见 Git history。
