# T18 真机 RC 证据

最终复核时间：`2026-08-04T10:05:46.178-03:00`

已在重启后的单一 MCP 服务和用户允许的临时工程中完成 MVP 场景 4：
`host_envelope` 振音。运行时 profile 与 `Synthesizer V Studio 2 Pro 2.2.1 / win32`
精确匹配，因而允许使用已确认的 H2 语义。

该场景按 snapshot → plan → dry-run → commit → wait → compare → cleanup 执行。dry-run
为零 setter、零 Undo；commit 的 `vibratoEnv` 117 个点全部读回，事务报告一个用户 Undo，
宿主插值 `118` 个样本的最大误差为 `4.11e-8 cent`（调用方阈值 `1 cent`）。等待后有
`363 / 384` 个有限 computed-pitch frame，比较结果显示振音深度由 `74.23115 cent` 变为
`24.22554 cent`。这证明该写入路径和量测链路可工作，不对自然度作自动化结论。

清理事务移除了全部 117 个临时 `vibratoEnv` 点，最终内容 token 与实验前精确一致；本场景
创建的 Artifact lease 已释放。人工试听仍是 `pending_human`。最终有 13 个 MVP 场景通过、
1 个条件场景不适用，T18 的机械门禁已闭合。P2b 明确为未启动：H3a 仍为
`unknown`，H3b 仅
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

场景 6 在同一音符边界叠加 Richards transition、overshoot transient 和显式 `pitchDelta` 振音，
并用 `vibratoEnv: 0` 抑制宿主包络。原顺序与完全反转顺序产生相同 `planId`、相同 2 条曲线和
`154` 个点，证明规范化键不受调用方排列影响。dry-run 零写入、零 Undo；commit 为一个用户 Undo，
逐点最大误差为 `6.90e-6 cent`，两条曲线共 `166` 个宿主插值样本的最大误差为
`7.61e-6 cent`。处理稳定后仍有 `519 / 768` 个有效帧，before/after 比较 MAE 为
`17.516 cent`、P95 为 `76.142 cent`；该观测只证明三种贡献同时到达宿主，不替代人工听感。
恢复事务把 `pitchDelta` 从 103 点还原到 7 个基线点、`vibratoEnv` 从 51 点还原到 0 点，
逐点恢复误差为零且最终 token 精确匹配。5 个 lease 全部显式释放，doctor 为 Artifact
`0 entries / 0 bytes`、handle 0、pending execution 0。

场景 7 以单条 linear transition 单独验证 MVP 写面。计划只生成 `pitchDelta` 的 34 个点，
不要求 `vibratoEnv`，也不产生 PitchControl mutation；dry-run 为零写入、零 Undo。commit 为
一个用户 Undo，逐点最大误差为 `1.88e-6 cent`，35 个宿主插值样本的最大误差为
`2.38e-6 cent`。写后宿主快照中 `pitchDelta` 总点数从 67 增至 101，目标范围恰有 34 点，
而 `PitchControlCurve` 前后均为 0，直接证明只有 MVP Automation 写面发生变化。恢复将目标范围
从 34 点清空，最终 token 精确匹配；4 个 lease 全部显式释放，doctor 保持零残留。

场景 8 通过克隆 `NoteGroupReference` 但不复制 target，临时构造了偏移一个四分音符的第二
occurrence。快照明确报告共享 occurrence `[0,1]`。未确认 commit 在 preflight 返回
`SHARED_TARGET_REQUIRES_CONFIRMATION`、零写入、零 Undo；使用已授权的
`allowSharedTargetMutation` 后，同一 34 点 transition 以一个用户 Undo 提交。写后两个 occurrence
的目标范围都回读到 34 点，computed-pitch 分别比较 519 和 424 个有限帧，两个边界音符的中心变化
近乎一致。恢复先清空共享 target 的范围并匹配共享夹具 token，再删除临时引用并匹配原项目 token。
6 个 Artifact lease 与 9 个 raw handle 全部显式释放；doctor 为 Artifact `0 entries / 0 bytes`、
handle 0、pending execution 0。

场景 9 分别在真实 singer-bound target 上构造 12 音符和 373 音符规模。两者的单 transition
planner 均返回 34 点的 compact envelope，结构化主响应为 `1,817 bytes`，低于 8 KiB 目标；
长组 dense 快照为 `63,356` 至 `109,975 bytes`，只通过可分页 Artifact 承载。12 音符路径完成
零写入 dry-run、单 Undo commit、`196 / 768` 有限帧比较和曲线恢复；音符与 Automation 均恢复，
完整 token 的差异仅来自派生 computed pitch，244 个比较帧最大漂移 `0.000763 cent`。373 音符路径
同样以单 Undo 提交并通过 34 点和 35 个插值样本回读，但宿主在两个 30 秒窗口后仍返回 2,000 个
全空 computed-pitch frame，compare 如实返回 `INSUFFICIENT_COMPUTED_PITCH`，该观测转交场景 10。
清理分两批把组恢复为 198 音符，原始音符、节拍/拍号和 `pitchDelta` 内容 token 精确返回
`no_change`；全部 Artifact、raw handle 和 pending execution 再次归零。

场景 10 以纯只读快照覆盖 computed pitch 三态。全覆盖夹具的 `32 / 32` 帧全部进入统计且无 coverage
warning；部分覆盖夹具原始为 `7 / 32` 个有限帧，其中 2 帧落在音符外，最终有效覆盖 `5 / 32`
（`15.625%`），分析成功但明确返回 `LOW_COMPUTED_PITCH_COVERAGE`。场景 9 的 373 音符全空夹具
则为 `0 / 2000`，在处理等待超时后 compare 结构化返回 `INSUFFICIENT_COMPUTED_PITCH`，没有伪造
零误差。该场景没有 setter 或 Undo；两份新 Artifact 已显式释放，doctor 保持零残留。

场景 13 使用同一事务内的 `pitchDelta` 与 `vibratoEnv` 两条曲线注入逐参数后置漂移。dry-run
对两参数完成 baseline/interpolation preflight，保持零 setter、零 Undo。commit 写入并逐参数独立
回读：`pitchDelta` 的点与插值全部通过，`vibratoEnv` 点本身通过，但 adaptive midpoint 期望
`1.25`、宿主实测 `1`，误差 `0.25` 超过 `0.01` 门禁。事务因此返回
`POSTCONDITION_FAILED / rolled_back / effects:reverted`，在同一个用户 Undo 中按
`vibratoEnv → pitchDelta` 逆序补偿且两条曲线均验证恢复。最终双参数内容 token 精确
`no_change`；本场景两份 Artifact 已释放，当时保留的场景 11 跨重连 PlanRef 已在后续 MCP 重启时失效，
最终场景 11 已使用新 PlanRef 重新采集。

场景 14 在 300 帧 computed-pitch 快照中固定了连续 21 帧 null gap，并在两侧分别提交正向
overshoot 与负向 preparation。重启加载 `48c723e` 后，原先被 `1.907e-6 cent` float32 微差
阻断的 baseline fingerprint dry-run 通过；两条曲线共 175 点，以一个用户 Undo 提交，179 个
宿主插值样本最大误差为 `8.24e-6 cent`。比较结果保持 before/after 各 21 个 null frame，左右
目标音中心分别变化 `+5.876` 与 `-20.271 cent`，没有跨 gap 合成。恢复后完整 token 精确
`no_change`，5 份 Artifact 全部释放。

场景 2 使用后接长休止的音符构造可逆长窗：临时延长音符并改变音高，在 transition 边界加入
90 BPM 标记、在振音内部加入 170 BPM 标记。计划包含 Richards transition 与 5.5 Hz 显式振音，
两条曲线共 734 点；dry-run 零 setter/Undo，commit 一个用户 Undo，280 个宿主插值样本最大误差
`1.38e-5 cent`。500 个原始帧经跨 tempo 的等秒网格得到 551 个有效帧，振音实测 `5.46 Hz`，
相对偏差 `0.7273%`，通过 H1 后设定的真机 1% 门禁。曲线、音符、tempo 均恢复；长范围内容 token
精确 `no_change`，旧场景 2 中断残留也恢复为原始 `pitchDelta 35 / vibratoEnv 0`，Artifact、
handle 与 pending execution 全部归零。

场景 11 先在同一 bridge epoch 内生成 40 点 Richards transition 并完成零写入 dry-run，再向计划
范围注入 `5 cent` sentinel。旧 PlanRef 在 preflight 返回 `CURVE_BASELINE_CHANGED`，effects 为
`none`，host write、Undo boundary 和 Undo record 全为 0；清除 sentinel 后内容 token 精确
`no_change`。重新生成的 PlanRef 在 epoch 1 dry-run 成功，仅重启 Lua bridge 后以 commit 动作重放，
在 epoch 2 的 `0 ms` preflight 返回 `STALE_CONTEXT / outcome:unchanged`，仍为零写入、零 Undo。

同轮还验证了两个实机回归。`e2e3552` 让最后一个 `vibratoEnv` 端点值 `0.5` 在后续音符范围继续生效，
0.5 倍 host-envelope 计划得到 117 个值为 `0.25` 的点并通过 baseline fingerprint dry-run。重连后
首个快照暴露 scoped handle 释放使用裸整数的问题：旧进程留下 101 个已知 handle；`bd1539d` 改为
释放带 epoch 的完整 handle。重启加载后重复同一快照，Artifact 释放前后 handle 均为 0，内容 token
仍为 `no_change`，最终 Artifact `0 entries / 0 bytes`、pending execution 0、profile 精确匹配。

完整机器可读记录见 [T18-live-host-rc.json](T18-live-host-rc.json)。
