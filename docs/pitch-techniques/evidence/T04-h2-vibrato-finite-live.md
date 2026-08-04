# T04 H2 有限 computed-pitch 补充证据

采集时间：`2026-08-04T04:32:10.4487041-03:00`

在用户明确允许的临时工程中，单一人声 occurrence 的隔离 Automation 区间获得每组
`363 / 384` 个有限 computed-pitch frame。所有写入先经 dry-run，commit 后等待两次稳定轮询，
控制点读回通过，再用原始控制点恢复；最终内容 token 与实验前一致。

| 比较 | 观测 |
|---|---|
| `vibratoEnv=1` 的显式正弦 | 最大差异 `49.6563 cent`，证明夹具有判别力 |
| `0.2` 相对 `1` | 有/无显式正弦的差分指标最大偏差 `8.41e-6 cent` |
| `1.8` 相对 `1` | 有/无显式正弦的差分指标最大偏差 `5.25e-6 cent` |
| `0` 相对 `1` | 已直接测得，且有/无显式正弦的差分指标最大偏差 `1.03e-5 cent` |

因此确认 `vibratoEnv` 是原生包络的比例因子，且与显式 `pitchDelta` 可加。显式颤音的
安全抑制值为同批 `vibratoEnv` `replace: 0`。`dF0VbrMod` 和与 PitchControl 的组合没有由本次
实验覆盖，仍保持 `unknown`。完整脱敏机器记录见
[T04-h2-vibrato-finite-live.json](T04-h2-vibrato-finite-live.json)。
