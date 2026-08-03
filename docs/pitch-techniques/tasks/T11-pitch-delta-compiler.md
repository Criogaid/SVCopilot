# T11 — `pitchDelta` 编译器

- 状态：`blocked`
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
