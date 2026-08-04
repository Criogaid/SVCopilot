# T13 — `plan_pitch_gesture` 公开迁移

- 状态：`done`
- 权威：[实施计划](../implementation-plan.md) §9.0–§9.6、§17 提交 13
- 依赖：T12
- 解锁：T15、T18

## 目标

把新技法 family 接入现有 `sv_plan/plan_pitch_gesture`，形成 snapshot → plan → dry-run → commit 的公开 MVP。

## 交付边界

- 同一提交迁移 schema、normalize/handler、IR 生成、PlanRef/apply、description、guide 和测试。
- `plan_expression` 不再拥有音高技法；不得保留兼容 alias 或双输出形状。
- 请求使用短 ordinal/index，响应默认摘要，完整 evidence 进入 Artifact。
- breath/special lyric、缺 capture、共享目标和过期上下文沿用现有安全契约。

## 验收

- 每个 discriminator 至少一条完整公开正例与边界负例。
- planner 确定性、PlanRef-only、ledger、dry-run 零副作用及单事务 commit 测试通过。
- `tools/list`、`sv_describe`、workflow guide 和 MCP smoke 同步。

## 完成条件

MVP 可由只看 MCP 自描述的客户端正确规划和执行，不需要读取内部 IR。
