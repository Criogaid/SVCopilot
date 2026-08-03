# T14 — 条件 PitchControlCurve 编译

- 状态：`conditional`
- 权威：[实施计划](../implementation-plan.md) F5a、§9、§13.1 P2b、§17 提交 14
- 依赖：T04 中 H3a、H3b、H4 全部通过；T13
- 解锁：T18 的 P2b 条件验收

## 目标

仅在三个独立宿主门禁都成立时，为 TechniqueIR 增加 PitchControlCurve 编译目标。

## 交付边界

- 复用现有 pitch-control 身份、fingerprint、journal、verify 和 rollback 内核。
- 明确 surface/reference-frame 白名单与双写面冲突策略。
- 不改变 `pitchDelta` MVP 的完成定义，也不自动混用两个写面。
- 任一宿主证据缺失时不注册公开能力。

## 验收

- 坐标往返、插值族、共享目标、浮点容差和故障恢复测试通过。
- 真机 dry-run/isolated commit/readback/cleanup 形成独立证据。
- MCP 能力与 profile 一致，不在 unsupported host 上虚假暴露。

## 完成条件

第二写面可独立验证并保持一个 Undo；否则任务保持条件未启用。
