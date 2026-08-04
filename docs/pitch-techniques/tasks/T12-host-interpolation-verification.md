# T12 — 宿主插值后置验证

- 状态：`ready`
- 权威：[实施计划](../implementation-plan.md) §9.4、F5c、§17 提交 12
- 依赖：T04 的 H4 证据、T11
- 解锁：T13、T18

## 目标

把宿主实际插值读回纳入同一事务的 postcondition，验证最终曲线而不是仅验证控制点数量。

## 交付边界

- commit 前复核 target、baseline、插值方法和所需 capture evidence。
- 写后通过独立 getter 采样宿主结果，使用权威计划误差门禁。
- 失败进入现有 journal/rollback/ledger 状态机；不可证明结果不得自动重试。
- evidence 超主响应预算时输出摘要与 detailRef。

## 验收

- 成功、宿主忽略 setter、插值超差、断连、rollback 成功/失败均有故障注入。
- dry-run 零 setter/Undo；commit 最多一个用户 Undo。
- 真机样本证明 host interpolation，而非 fake-host 自证。

## 完成条件

写入成功只在实际宿主曲线达到门禁时成立，失败状态与恢复证据诚实。
