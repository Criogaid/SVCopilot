# T02 TimeAxis H1 实机证据

## 场景与恢复

2026-08-04，活动 MCP 会话附着到 SynthV 2.2.1，bridge protocol 为 2。用户授权在当前
临时工程上准备两个 tempo fixture：先记录原始 map（仅 `position: 0`、`130 BPM`），在采样前
加入临时 marks，并在每个场景后删除并读回原始 map。准备和恢复不修改音符、轨道或歌词，且
所有 workflow 的显式 Undo boundary 均为 0。

| 场景 | Artifact | marks | 采样点 |
|---|---|---:|---:|
| constant | [constant](T02-time-axis-constant-live-v2.json) | 1 | 200 |
| tempo_step | [tempo step](T02-time-axis-tempo-step-live.json) | 2 | 200 |
| dense_tempo | [dense tempo](T02-time-axis-dense-tempo-live.json) | 8 | 200 |

每份 Artifact 都由四个受限 `mode: "read"` workflow（63、63、63、11 点）生成，包含各 mark 的
`-1/0/+1`。因此采样本身没有 setter、没有 `newUndoRecord()`，并记录了宿主的原始双向换算值。
临时 `addTempoMark` / `removeTempoMark` 只属于夹具准备与恢复，不属于 Artifact 的只读采样。

`TimeAxis.getAllTempoMarks()` 的官方位置字段为 `position`；采集器将其明确投影为 evidence
契约的 `positionBlick`，不接受兼容别名。

## 裁定

三个 Artifact 通过 `validateTimeAxisProbeReport()` 重放后，
`summarizeTimeAxisEvidence()` 得到：

```json
{
  "status": "confirmed",
  "resultCode": "TIME_AXIS_NODE_PARITY_CONFIRMED",
  "sampleCount": 600,
  "nodeParityMaxDeviationSeconds": 1.4210854715202004e-14,
  "hostRoundTripMaxDeviationBlick": 1,
  "t03Disposition": "not_required"
}
```

最大秒误差小于 `1e-6 s`，H1 已确认为 Node 分段换算可信。profile fixture
`synthv-2.2.1-win32-v2` 的 H1 fact 已更新为 `confirmed`；T03 保持未实现。

## 验证

- `node --test test/host-profile.test.mjs test/time-axis-evidence.test.mjs test/time-axis-capture.test.mjs`
- `npm test`
- 对三份 Artifact 运行 `validateTimeAxisProbeReport()` 和 `summarizeTimeAxisEvidence()`
