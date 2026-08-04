# T20 — 评估、文档与发布

- 状态：`done`
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

## 完成记录

- 证据：[T20-release-evidence.json](../evidence/T20-release-evidence.json) 与
  [T20-release-evidence.md](../evidence/T20-release-evidence.md)。
- 发布：接口版本升至 `0.10.0`；capabilities、pitch workflow guide、consumer README 和
  `THIRD_PARTY_NOTICES.md` 同步公开模型、求解器、单位、写面、宿主矩阵、恢复规则与依赖台账。
- 可复现性：固定合成 specimen 机械重算 request / IR / compiler plan 三类 canonical hash；
  T01 corpus、T16 benchmark、T18 live RC、host profile 与 package lock 均由文件散列绑定。
- 验证：完整测试 850/850、独立 reference 83/83、MCP smoke、已加载与 staging Lua dispatcher
  各 42/42；live doctor 返回接口 `0.10.0`、profile 精确匹配、Artifact / handle / pending 均为 0。
- 条件能力：T03 因 H1 parity 不需要；T14 与 T19 保持 `conditional` 且在 capabilities 中禁用，
  不降低已发布 `pitchDelta` MVP、单步开环或事务恢复契约。
- 提交：本任务的独立提交见 Git history。
