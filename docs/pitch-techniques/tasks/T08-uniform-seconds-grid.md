# T08 — 等秒网格与 Computed Pitch Compare

- 状态：`blocked`
- 权威：[实施计划](../implementation-plan.md) F4、§8、§17 提交 8
- 依赖：T02；若需要宿主批量换算则再依赖 T03
- 解锁：T11、T15、T17

## 目标

建立唯一等秒采样网格，并把 computed-pitch compare 迁移到该时间基准而不破坏现有 token 预算。

## 交付边界

- 时间映射只使用 T02 裁定的生产路径。
- 迁移 frame 配对、coverage、transition、vibrato Hz 与 tempo-change 处理。
- 保留 null frame 和特殊歌词事件的现有诚实语义。
- 大数组继续走摘要、上限和 Artifact，不回退为内联全量结果。

## 验收

- 恒速与 tempo change corpus 的采样位置、频率和覆盖率满足权威门禁。
- compare 两侧使用各自时间基准；网格不兼容时预检拒绝。
- 现有 computed-pitch compare、效率和 MCP 投影测试无回归。

## 完成条件

分析与修正链路共享一个已由宿主证据校准的秒域时间轴。
