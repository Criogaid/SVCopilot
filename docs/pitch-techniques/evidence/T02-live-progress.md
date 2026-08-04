# T02 TimeAxis H1 实机进展

## 已采集场景

2026-08-03，活动 MCP 会话附着到 SynthV 2.2.1，bridge protocol 为 2。恒速工程的原始、
可回放证据见 [T02-time-axis-constant-live.json](T02-time-axis-constant-live.json)。

| 项目 | 结果 |
|---|---:|
| tempo marks | 1（position 0，120 BPM） |
| QUARTER | 705600000 BLICK |
| 工程时长 | 197215200000 BLICK |
| 采样点 | 200 |
| Node 秒值最大误差 | 0 s |
| 宿主 BLICK 往返最大误差 | 1 BLICK |
| Node BLICK 往返最大误差 | 0 BLICK |
| setter / Undo | 0 / 0 |

采样通过四个受限 `mode: "read"` workflow 完成，批次规模为 63、63、63、11；每批返回
`boundaryCallsCompleted: 0`。`TimeAxis.getAllTempoMarks()` 的官方字段为 `position`，采集器
已将其显式投影为内部 evidence 契约的 `positionBlick`，没有兼容别名。

## 回放与状态

`validateTimeAxisProbeReport()` 已重放 Artifact，`summarizeTimeAxisEvidence()` 的结论为：

```json
{
  "status": "partially_observed",
  "t03Disposition": "not_determined",
  "observedScenarios": ["constant"],
  "sampleCountByScenario": { "constant": 200 }
}
```

`npm test` 通过 856 项测试。H1 需要另行读取一个含恰好一个 tempo step 的工程和一个含多个
tempo mark 的密集变速工程；每个工程均须达到至少 200 点，才能作出 T03 的机械裁定。
