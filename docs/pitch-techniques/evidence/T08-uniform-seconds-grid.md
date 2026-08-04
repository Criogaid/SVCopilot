# T08 等秒网格与 Computed Pitch Compare

采集时间：`2026-08-04T00:02:55.6236799-03:00`

## 实现

`server/src/pitch-techniques/time-grid.js` 使用 T02 已确认的 `musical-time.js` 生产换算，先把每个
原始 `{startBlick, intervalBlick, values}` frame 映射为绝对秒，再生成唯一的
`uniform_seconds` 网格。线性插值仅发生在连续 finite run 内；null、无声和超过
`maxGapSeconds` 的间隔不会被桥接。网格保存 mask、BLICK 回投、tempo crossing 与来源采样元数据，
但这些大数组只存在于内存分析路径。

`sv_compare_computed_pitch` 的 coverage、transition、vibrato、anomaly frame 与
`compare_contexts` 帧配对现在都消费该网格。两个 context 分别按各自 tempo map 建轴；raw sampling
或秒轴不兼容会在统计前以 `ALIGNMENT_UNSUPPORTED` 拒绝，而不是按相同 BLICK 强行比较。

## 离线证据

| 断言 | 结果 |
|---|---|
| 恒速输入 | 原始 frame 时间、值与 null mask 保持逐项一致 |
| tempo step | 相邻 grid 时间恒定；4 Hz 合成颤音在 shared axis 上保持约 4 Hz |
| null gap | finite run 间没有插值桥接 |
| context compatibility | 不同 tempo map 产生不同轴时预检拒绝 |
| 特殊歌词与 coverage | 继续复用现有排除与低覆盖语义 |

代表性 shared-tempo-step `compare_contexts` 使用 160 个原始 frame，派生 279 个 uniform frame，
完整响应为 `4,255` UTF-8 bytes；响应只返回 sampling 摘要，测试固定为小于 `8 KiB`，不内联网格数组。

## 验证

| 命令 | 结果 |
|---|---|
| `node --test ../test/computed-pitch-compare.test.mjs ../test/pitch-techniques-time-grid.test.mjs` | 36 passed |
| 受影响 API/schema/workflow/efficiency suites | 78 passed |
| `npm test` | 855 passed |
| `git diff --check` | clean |

## 范围与门禁

本任务只使用离线 snapshot fixture；零 host call、零 setter、零 Undo。输入 schema 未变，MCP 描述和
workflow guide 已说明统一秒轴与拒绝条件。T04 的 H2/H3/H5/H6/H7/H8 结论未被本任务改变；
PitchControl、显式宿主颤音与闭环任务继续保持既有条件门禁。
