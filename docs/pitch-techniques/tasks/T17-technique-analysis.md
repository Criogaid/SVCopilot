# T17 — 只读技法分析

- 状态：`blocked`
- 权威：[实施计划](../implementation-plan.md) §12、§17 提交 17
- 依赖：T08、T16 达标选型
- 解锁：T18

## 目标

从 captured computed pitch 中给出可解释技法参数与证据，低质量输入必须返回证据不足而非伪精确结果。

## 交付边界

- 分段、拟合、拒绝判据和错误码只引用权威计划。
- 工具保持只读，零 setter、零 Undo、零宿主控制。
- 摘要包含置信度和关键证据；dense samples、solver trace 和候选详情进 Artifact。
- 不把检测结果描述为审美判断，也不替代人类试听。

## 验收

- synthetic 已知参数恢复、混合技法、null/低覆盖/粗采样和错误模型测试通过。
- 请求重复执行结果确定，Artifact 分页和 response budget 通过。
- MCP 自描述让独立客户端知道何时不能使用结果。

## 完成条件

分析结果可供诊断与比较使用，并对证据边界保持诚实。
