# T04 H2-H8 实机证据

采集时间：`2026-08-04T02:33:04.428Z`

完整机器可读记录见 [T04-host-pitch-live.json](T04-host-pitch-live.json)。所有写入只发生在
克隆临时 track 与新建 library group；原 group 没有被修改。

| 项目 | 结论 | 证据强度 |
|---|---|---|
| H2 | 初始夹具全 null；后续有限帧矩阵确认包络缩放与显式 `pitchDelta` 可加 | `confirmed`（仅 `hostEnvelopeWithExplicitPitchDelta`） |
| H3a | 仅 `pitchDelta`、仅 PitchControl、二者共存均没有有限 computed pitch | `unknown` |
| H3b | 3 个 local anchor、2 个 occurrence offset 的 direct mapping 已读回 | `partially_observed` |
| H4 | 13 个 `getValueAt()` 点为分段线性 | `confirmed` |
| H5/H6 | 57 次只读 polling 没有可用非空序列 | `unknown` |
| H7 | 没有人工 Ctrl+Z 观察 | `unknown` |
| H8 | 69.33 Hz、384 帧没有有限帧 | `unknown` |

## 夹具恢复

| 核对项 | 前 | 后 |
|---|---:|---:|
| tracks | 4 | 4 |
| library groups | 3 | 3 |
| 全范围内容 token | 基线 | 匹配基线 |
| 导出 handles | 13 次释放 | 13 次成功 |
| raw cleanup warnings | 83 次补充释放 | 83 次成功 |

每个写 workflow 都使用 `before-and-after` boundary，返回 2 次 boundary call 与 1 个预期用户 Undo
步。0.2/1.8 `vibratoEnv` 被宿主以 float32 回读，严格 double equality 断言因此得到 `partial`；没有
重试该写入，直接删除整套临时夹具，并以项目读回确认恢复。

后续有限 computed-pitch H2 矩阵见 [T04-h2-vibrato-finite-live.md](T04-h2-vibrato-finite-live.md)。
它只更新 `vibrato.hostEnvelopeWithExplicitPitchDelta`；`dF0VbrMod`、PitchControl 组合和 H5--H8
仍没有被本次补充实验解锁。

## 验证

- `node --test ../test/host-profile.test.mjs`（从 `server/` 目录执行）
- `npm test`：858 passed
- profile fixture 的 `validateHostBehaviorProfile()`
- Artifact JSON parse
- 夹具删除后的同范围 `snapshotToken` 与临时实验前一致
