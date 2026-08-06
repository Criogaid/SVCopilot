# 可解释音高技法

本目录记录 SVCopilot `0.10.0` 可解释音高技法系统的当前范围、冻结契约、任务记录、
数学参考实现和真机证据。当前发布状态为 **MVP 已完成**，不是仍在等待实施的路线图。

## 当前能力

| 能力 | 公开 operation | 状态 |
|---|---|---|
| transition、overshoot、preparation、vibrato 前向规划 | `sv_plan_pitch_gesture` | 已发布 |
| 宿主 computed pitch 比较 | `sv_compare_computed_pitch` | 已发布 |
| transition、transient、vibrato 只读分析 | `sv_analyze_pitch_techniques` | 已发布 |
| 一次开环音高修正 | `sv_plan_pitch_correction` | 已发布 |
| `pitchDelta` 主写面与 `vibratoEnv` 辅助包络 | `sv_patch_parameter_curves` | 已发布 |
| `PitchControlCurve` 技法编译 | 无 | 条件能力，未启用 |
| 单 Undo 有界闭环校准 | 无 | 条件能力，未启用 |

MVP 只把 TechniqueIR 编译到 `pitchDelta`，需要时联动 `vibratoEnv`。仓库虽然提供通用
`PitchControl` 读取和编辑能力，但没有把音高技法编译到 `PitchControlCurve`；这两者不能混为一谈。

## 未启用项

这些项目是证据门禁的明确裁定，不是忘记实现：

| 任务 | 裁定 | 原因 |
|---|---|---|
| T03 批量 TimeAxis opcode | `not_required` | 600 点 H1 实测确认 Node 与宿主时间换算满足门禁 |
| T14 `PitchControlCurve` 编译 | `not_enabled` | H3a 仍为 `unknown`，H3b 仅 `partially_observed` |
| T19 单 Undo 有界闭环 | `not_enabled` | H5 重算稳定性和 H7 人工 Undo 证据仍为 `unknown` |

人工试听始终是 `human_only`，程序只报告曲线、插值和 computed-pitch 证据。T18 没有采集聚合
PIPE/MCP 字节百分位；发布证据将其保留为 transport evidence limit，不影响已完成的 MVP 门禁。

## 阅读顺序

1. [T20 发布证据](evidence/T20-release-evidence.md)：先看实际发布范围、宿主矩阵和限制。
2. [可行性裁定](feasibility.md)：查看研究来源、宿主未知量和最终可行性结论。
3. [实施计划](implementation-plan.md)：查看冻结的公式、schema、门禁和历史执行顺序。
4. [任务索引](tasks/README.md)：查看 T01–T20 的当前状态与逐任务完成记录。
5. [reference/](reference/)：查看数学 oracle、契约测试和数值门禁。
6. [evidence/](evidence/)：查看离线 benchmark、可恢复真机验收和机器可读证据。

`implementation-plan.md` 是冻结的设计与验收契约，不再充当实时进度表。当前状态以本页、
任务索引和 T20 机器可读发布台账为准。
