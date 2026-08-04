# T18 真机 RC 进度

采集时间：`2026-08-04T05:25:18.4196724-03:00`

已在重启后的单一 MCP 服务和用户允许的临时工程中完成 MVP 场景 4：
`host_envelope` 振音。运行时 profile 与 `Synthesizer V Studio 2 Pro 2.2.1 / win32`
精确匹配，因而允许使用已确认的 H2 语义。

该场景按 snapshot → plan → dry-run → commit → wait → compare → cleanup 执行。dry-run
为零 setter、零 Undo；commit 的 `vibratoEnv` 117 个点全部读回，事务报告一个用户 Undo，
宿主插值 `118` 个样本的最大误差为 `4.11e-8 cent`（调用方阈值 `1 cent`）。等待后有
`363 / 384` 个有限 computed-pitch frame，比较结果显示振音深度由 `74.23115 cent` 变为
`24.22554 cent`。这证明该写入路径和量测链路可工作，不对自然度作自动化结论。

清理事务移除了全部 117 个临时 `vibratoEnv` 点，最终内容 token 与实验前精确一致；本场景
创建的 Artifact lease 已释放。人工试听仍是 `pending_human`。其余 13 个 MVP 场景尚未完成，
本文件不是 T18 通过声明。P2b 明确为未启动：H3a 仍为 `unknown`，H3b 仅
`partially_observed`，所以不启用 `PitchControlCurve`。

场景 5（显式 `pitchDelta` 振音）已经完成 plan、零副作用 dry-run、一个 Undo 的 commit、
稳定等待、computed-pitch 比较和内容 token 恢复。它产生 `102` 个 `pitchDelta` 点，并用
`vibratoEnv: 0` 的 94 点抑制宿主包络；`363 / 384` 个有效帧的比较 P95 为
`104.86298 cent`。恢复后 `pitchDelta` 回到 2 个基线点、`vibratoEnv` 回到 0 个点，
`sinceToken` 返回 `no_change`。不过 artifact store 不提供剩余 descriptor 枚举，三项可寻址
lease 已释放但 session 仍有 5 项；因此该场景状态保持 `in_progress`，不得计为通过。

完整机器可读记录见 [T18-live-host-rc.json](T18-live-host-rc.json)。
