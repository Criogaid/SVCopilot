# T02 TimeAxis H1 预检记录

## 状态

本记录不是 H1 的终态实机证据。2026-08-03 的 `npm run doctor -- --json` 仅确认 bridge
脚本存在且 protocol 为 2；`hostState` 为 `not_started`，没有连接中的 SynthV 可执行
只读探针。

现有 fixture `synthv-2.2.1-win32-v2` 保留先前恒速工程的 45 点观察：

```json
{
  "status": "partially_observed",
  "sampleCount": 45,
  "nodeParityMaxDeviationSeconds": 0,
  "hostRoundTripMaxDeviationBlick": 1,
  "t03Disposition": "not_determined"
}
```

它没有覆盖 tempo mark 边界、单点阶跃或密集变速，不能解锁 Hz 门限，也不能判断 T03。

## 已就绪的捕获路径

`npm run time-axis:capture -- --scenario <constant|tempo_step|dense_tempo> --output <artifact>`
通过 MCP raw read 调用 `Project.getDuration()`、`TimeAxis.getAllTempoMarks()`、
`TimeAxis.getSecondsFromBlick()` 和 `TimeAxis.getBlickFromSeconds()`。每个 Artifact 至少
200 个 BLICK 位置，包含 tempo mark 的 `-1/0/+1`，并包含原始读数和可回放的误差摘要。

三个 Artifact 可作为重复的 `--time-axis-evidence <artifact>` 传给
`npm run host-profile:capture --`。聚合器只在全部必需场景各有至少 200 点时将 H1 标为
`confirmed` 或 `contradicted`；否则保持 `partially_observed`。完整通过时 T03 为
`not_required`；完整的非边界偏差时为 `required`；纯边界偏差要求先修 Node 规则并重测。

## 离线验证

- `node --test test/host-profile.test.mjs test/time-axis-evidence.test.mjs test/time-axis-capture.test.mjs`: 23 passed。
- 捕获序列的注入宿主测试记录 200 次 `getSecondsFromBlick` 与 200 次
  `getBlickFromSeconds`，零 setter、零 `newUndoRecord()`。
- `npm test`: 812 passed。
- `npm run smoke:mcp`: passed。
- `git diff --exit-code -- api-docs`: clean。
