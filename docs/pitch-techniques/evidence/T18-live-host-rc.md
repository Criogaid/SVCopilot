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
创建的 Artifact lease 已释放。人工试听仍是 `pending_human`。另有 11 个 MVP 场景尚未完成，
本文件不是 T18 通过声明。P2b 明确为未启动：H3a 仍为 `unknown`，H3b 仅
`partially_observed`，所以不启用 `PitchControlCurve`。

场景 5（显式 `pitchDelta` 振音）已经完成 plan、零副作用 dry-run、一个 Undo 的 commit、
稳定等待、computed-pitch 比较和内容 token 恢复。它产生 `102` 个 `pitchDelta` 点，并用
`vibratoEnv: 0` 的 94 点抑制宿主包络；`363 / 384` 个有效帧的比较 P95 为
`104.86298 cent`。恢复后 `pitchDelta` 回到 2 个基线点、`vibratoEnv` 回到 0 个点，
`sinceToken` 返回 `no_change`。三项可寻址 lease 当场释放；其余 5 项在 30 分钟租期后由一次
已追踪、随即释放的只读快照触发 prune。doctor 最终报告 Artifact `0 entries / 0 bytes`，
因此场景 5 的 cleanup 门禁已经闭合并计为通过。

场景 12 是条件项：T16 已选用进程内 `node-bounded-richards`，而非外部 worker，因此没有可注入
的 worker crash。T16 已验证该后端的 timeout 后恢复；本场景标为 `not_applicable`，不把它伪装成
一次真机 crash 通过。

场景 1（130 BPM 恒速 Richards）在首次 RC 中先以零写入失败，暴露了纳秒规范化端点越过
transition oracle 和多条不相交曲线先查锚点后过滤范围的两个规划器缺陷。修复提交 `2ac7187`
加入了同形离线回归，完整测试为 `846 / 846`，MCP smoke 通过；重启后同一真实结构成功规划两条
上下行 Richards curve，共 `117` 点。dry-run 为零写入、零 Undo，commit 为一个用户 Undo；
宿主插值 `122` 个样本的最大误差为 `8.04e-6 cent`。稳定后的 `519 / 768` 个有效 computed-pitch
frame 中，before/after 的 MAE 为 `2.935 cent`，P95 为 `25.536 cent`，变化集中在两个 transition
区域。恢复事务把两段范围从 `55 / 62` 点还原到 `0 / 7` 个基线点，最终 `sinceToken` 返回
`no_change`；4 个 lease 全部显式释放，doctor 为 Artifact `0 entries / 0 bytes`。人工试听仍为
`pending_human`。

场景 3 在两个不重叠范围分别编译 overshoot 与 preparation，使用权威默认阻尼 `0.5422`、
`0.6681` 和连续 C1 taper。两条曲线共 `134` 点；dry-run 零写入、零 Undo，commit 一个用户
Undo，宿主插值 `140` 个样本的最大误差为 `4.03e-6 cent`。`519 / 768` 个有效帧的 before/after
比较中，整体 MAE 为 `1.368 cent`、P95 为 `12.902 cent`，两个目标音符中心分别变化
`+16.727 cent` 与 `-12.778 cent`，方向与请求一致；这些数值只证明模型写入和观测链路，不替代
人工听感。恢复事务把两段范围从 `72 / 62` 点还原到 `11 / 0` 个基线点，最终 token 精确匹配；
4 个 lease 全部显式释放，doctor 再次为 Artifact `0 entries / 0 bytes`。

完整机器可读记录见 [T18-live-host-rc.json](T18-live-host-rc.json)。
