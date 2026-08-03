# T09 — TechniqueIR 与 Canonicalization

- 状态：`blocked`
- 权威：[实施计划](../implementation-plan.md) F5、F5a–F5c、F9、§8、§17 提交 9
- 依赖：T05、T06、T07
- 解锁：T10、T11

## 目标

实现 versioned TechniqueIR 的规范化、严格数值注册、稳定 canonical key 和证据前置条件。

## 交付边界

- 字段、量纲、quantum 和跨字段关系只来自权威计划与 [reference](../reference/)。
- 默认值物化后验证，量化后再次验证；未知数值字段立即失败。
- canonical key 排除非语义身份，碰撞返回可机器读取证据。
- IR 保持内部结构，不暴露为要求 LLM 手写的大型公开请求。

## 验收

- 全字段注册覆盖、safe integer、边界 lattice、排列稳定和碰撞测试通过。
- `0.1+0.2` 类噪声稳定归一，语义上可区分的值仍产生不同 key。
- 错误通过真实 MCP encoder 投影到 `structuredContent.error.details`。

## 完成条件

T10/T11 只能消费规范化且冻结的 IR，不存在旁路对象形状。
