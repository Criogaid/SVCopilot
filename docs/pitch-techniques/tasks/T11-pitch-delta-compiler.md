# T11 — `pitchDelta` 编译器

- 状态：`done`
- 权威：[实施计划](../implementation-plan.md) F1b、F5a、§9.3、§17 提交 11
- 依赖：T08、T10
- 解锁：T12、T13、T15

## 目标

把组合后的秒域 contribution 唯一映射为 group-relative `pitchDelta` 曲线，并保持 score-step 处绝对音高连续。

## 交付边界

- 使用权威计划定义的 anchor、score-step 映射和局部/绝对时间关系。
- 覆盖上下行、rest、gap/overlap、等音高、短音符、大音程和 BLICK 分辨率限制。
- 预合成基线与贡献后生成 replace 计划；不得引入逐点写或第二事务。
- 本任务只编译与 dry-run，不宣称宿主插值后已满足误差。

## 验收

- 文档实例、上下行连续性和边界拒绝由 unit/property tests 固定。
- 相同 IR 与 frozen evidence 产生字节稳定的 mutation plan。
- 373-note fixture 的 host-call、点数和 serialized bytes 处于既有预算。

## 完成条件

编译结果能被现有 parameter-curve 事务消费，并明确标记为尚待 T12 验证。

## 完成记录

- 证据：[T11-pitch-delta-compiler.md](../evidence/T11-pitch-delta-compiler.md)。
- 交付：新增纯函数 `server/src/pitch-techniques/pitch-delta-compiler.js`，消费已冻结的 T09 IR、T10
  composition 和 snapshot evidence，生成 `pitchDelta` 的 `mode:"replace"`、`action:"dry_run"` 请求。
  transition 的 start / boundary-before / boundary-at / end 以及 Richards inflection 均为必保锚点；
  结果使用既有 `dense-table-v1`，可由 `normalizeCurveInput()` 直接消费。
- 验证：专用编译器测试 7/7；关联 compiler/IR/compose/parameter-curve 测试 76/76；reference oracle
  83/83；完整 `npm test` 862/862。
- 序列化：373-note fixture 生成一个 1,492-point replace curve，计划 mutation 保持在 16 KiB 内；
  本任务未新增 MCP schema 或公开响应字段。
- 宿主：未接触；零 host call、零 setter、零 Undo。`pending_t12_host_interpolation` 仅表示 T12
  仍须用宿主 `Automation.get()` 验证，不是插值通过的宣称。
- 提交：本任务的独立提交见 Git history。
