# T03 — 条件批量 TimeAxis Opcode

- 状态：`conditional`
- 裁定：`not_required`
- 权威：[实施计划](../implementation-plan.md) §7.1a、§17 提交 3
- 依赖：T02 明确裁定必须由宿主批量换算
- 解锁：T08 的生产时间映射

## 目标

仅在 T02 证明 Node 换算不足时，提供一次 PIPE 往返完成一批 TimeAxis 映射的只读 bridge opcode。

## 交付边界

- 同批修改 Node 协议、握手能力、已加载 Lua 脚本与 `staging/` 副本。
- 固定字段 allowlist、批量上限、深度/帧预算和结构化错误。
- 不返回 handle，不调用 setter，不引入逐点 PIPE fallback。
- 若 T02 判定不需要，实现应保持不存在，并将任务记录为 `not_required` 证据，而非伪完成。

## 验收

- Node 协议、Lua dispatcher、PIPE E2E、帧上限和能力协商测试通过。
- 批量结果与逐点宿主 oracle 在 T02 corpus 上一致，并显著减少往返。
- 断连、版本不匹配和超限不会附着错误能力或返回部分伪成功。

## 完成条件

生产时间映射有唯一实现路径，且不会牺牲现有 PIPE 安全边界。

## 裁定记录

T02 的恒速、单点阶跃与多点密集变速 Artifact 各含 200 点，聚合结果为
`TIME_AXIS_NODE_PARITY_CONFIRMED`，Node 秒值最大误差
`1.4210854715202004e-14 s <= 1e-6 s`。因此生产路径保持 Node 分段换算，T03 不实现
批量 opcode，也不修改 Node 协议、Lua bridge 或能力协商。
