# T04 — H2–H8 可恢复宿主证据

- 状态：`done`
- 权威：[实施计划](../implementation-plan.md) §7.2–§7.4、§17 提交 4
- 依赖：T02 profile v2 结构就绪；SV Live Probe 可用
- 解锁：T12、T14、T18、T19

## 目标

用隔离临时轨回答原生颤音、双写面、插值、重算延迟、旧结果、Undo 和细微波动等宿主未知量。

## 交付边界

- 按 H2–H8 分项捕获输入、宿主版本、观测值、恢复证据和结论强度。
- 每个写实验执行保存、隔离、写入、等待、读回、恢复、再读回；失败也必须给恢复状态。
- profile 只记录真实可观察事实；未覆盖组合保持 `unknown`。
- 不在本任务实现 planner、编译器或闭环策略。

## 验收

- 所有临时轨、handle、Artifact 和播放状态清理；原工程内容 token 前后一致。
- 写实验的 Undo 数、处理延迟和插值证据可机器读取。
- H3a/H3b/H4 分开裁定，任一缺失都不能误解锁 T14。

## 完成条件

H2–H8 各有结论或明确未测原因，条件任务能仅凭 profile 判断是否可启动。

## 完成记录

- 证据：[T04-host-pitch-live.md](../evidence/T04-host-pitch-live.md) 与机器可读
  [Artifact](../evidence/T04-host-pitch-live.json)。
- H4 的 13 个 `getValueAt()` 密集读点确认为 `piecewise_linear`；H3b 只得到两 occurrence
  的 direct coordinate readback，仍为 `partially_observed`。
- H2、H3a、H5、H6、H8 的隔离夹具 computed pitch 均为全 null，保持 `unknown`；H7 未作人工
  Ctrl+Z 观察，保持 `unknown`。因此 T14、显式颤音和闭环任务仍不会被误解锁。
- 临时 track/library group 删除后，track/library 数量和全范围内容 token 都恢复；13 个导出 handle
  与 83 个 raw cleanup warning 句柄均已显式释放。0.2/1.8 `vibratoEnv` 的 float32 严格相等断言
  返回 `partial` 后未重试写入，而是直接删除夹具并验证恢复。
- 验证：`node --test ../test/host-profile.test.mjs` 18/18；`npm test` 858/858；profile 与
  Artifact JSON 均通过严格解析。公开 MCP schema、handler 和响应字节预算未改变。
- 宿主：仅临时对象写入；每个写 workflow 记录 2 个 Undo boundary call（预期 1 个用户 Undo 步），
  没有人工 Ctrl+Z 证据。
- 提交：本任务的独立提交见 Git history。
