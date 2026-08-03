# T20 — 评估、文档与发布

- 状态：`blocked`
- 权威：[实施计划](../implementation-plan.md) §15、§18–§20、§17 提交 20
- 依赖：T18；T19 仅在启用闭环时需要
- 解锁：正式发布

## 目标

汇总可复现证据，更新消费者文档和能力声明，并以实际完成范围发布。

## 交付边界

- 发布 corpus、canonical hashes、benchmark、host acceptance matrix 和依赖 provenance。
- Consumer README 只解释可用能力、dry-run/commit、Undo、限制和恢复规则。
- 开发细节留在 docs；未启用 T14/T19 明确列为 capability-gated，而非缺陷。
- 更新版本、capabilities、schema resource、guide 和 NOTICE，避免计数漂移。

## 验收

- 完整测试、MCP smoke、Lua dispatcher、真机 acceptance 与独立模型可发现性通过。
- 发布说明中的每项能力可映射到提交与机械证据。
- 仓库无生成时间戳噪声、机器路径、真实工程数据或未释放 Artifact。

## 完成条件

§19 完成定义逐项闭合；未完成条件能力不会阻塞已达标 MVP 的诚实发布。
