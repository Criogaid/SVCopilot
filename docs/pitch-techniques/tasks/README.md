# 音高技法实施任务索引

## 权威关系

- [implementation-plan.md](../implementation-plan.md) 是唯一实施权威，公式、JSON 契约、默认值、错误码和最终门禁只在该文件定义。
- [reference/](../reference/) 是集中式数学与契约 oracle；任务包不得复制、分叉或归档其中内容。
- 本目录只回答“下一次提交做什么、依赖什么、如何证明完成”，不得解释或修改业务契约。
- 任务包与权威计划冲突时，以权威计划为准；先修任务包，禁止据任务包反向猜测契约。

## 执行规则

状态只使用 `ready`、`blocked`、`conditional`、`in_progress`、`done`。领取任务时只将一个任务设为
`in_progress`；完成后记录提交哈希和证据位置。公开 surface 变化必须在同一提交完成 schema、handler、
planner/apply、description、guide 与测试的成对迁移。每项提交前运行受影响测试和完整 `npm test`；涉及
MCP、Lua 或宿主语义时，再执行对应 smoke、dispatcher 或可恢复真机验收。

任务不得引入兼容别名、第二套公式、内联大证据或未经 profile 证明的宿主事实。条件任务的门禁未满足时，
保持 `conditional`，不得为了清空列表而实现。

## 依赖波次

| 波次 | 可执行任务 | 说明 |
|---|---|---|
| A | T01、T02、T05、T06、T07 | 基线、只读宿主证据和纯离线模型可并行 |
| B | T03（条件）、T04、T08、T09 | 由 TimeAxis 裁定或数学模型解锁 |
| C | T10、T11、T16 | 组合、MVP 编译与拟合基准 |
| D | T12、T13、T15、T17 | 写入后置验证、公开 planner、修正与分析 |
| E | T14（条件）、T18 | 第二写面与真机 RC |
| F | T19（条件）、T20 | 有界闭环与正式发布 |

## 任务清单

| 任务 | 交付物 | 初始状态 |
|---|---|---|
| [T01](T01-baseline-corpus.md) | 基线与 synthetic corpus | ready |
| [T02](T02-time-axis-evidence.md) | H1 TimeAxis 证据与 profile v2 | ready |
| [T03](T03-time-axis-bulk-op.md) | 条件批量 TimeAxis opcode | conditional |
| [T04](T04-host-pitch-evidence.md) | H2–H8 可恢复宿主证据 | blocked |
| [T05](T05-richards-model.md) | Richards 模型 | ready |
| [T06](T06-second-order-model.md) | 二阶瞬态模型 | ready |
| [T07](T07-time-varying-vibrato.md) | 时变颤音模型 | ready |
| [T08](T08-uniform-seconds-grid.md) | 等秒网格与 compare 迁移 | blocked |
| [T09](T09-technique-ir.md) | TechniqueIR 与 canonicalization | blocked |
| [T10](T10-technique-composition.md) | 确定性组合与约束 | blocked |
| [T11](T11-pitch-delta-compiler.md) | `pitchDelta` 编译器 | blocked |
| [T12](T12-host-interpolation-verification.md) | 宿主插值后置验证 | blocked |
| [T13](T13-pitch-gesture-surface.md) | `plan_pitch_gesture` 成对迁移 | blocked |
| [T14](T14-pitch-control-compiler.md) | 条件 PitchControlCurve 编译 | conditional |
| [T15](T15-open-loop-correction.md) | 单步开环修正 | blocked |
| [T16](T16-fit-worker-benchmark.md) | FitWorker benchmark 与选型 | blocked |
| [T17](T17-technique-analysis.md) | 只读技法分析 | blocked |
| [T18](T18-live-host-rc.md) | 全链路真机 RC | blocked |
| [T19](T19-bounded-closed-loop.md) | 条件单 Undo 有界闭环 | conditional |
| [T20](T20-release-evidence.md) | 评估、文档与发布 | blocked |

## 通用完成证据

每个任务的最终记录至少包含：提交哈希、变更文件、执行命令、测试计数、序列化字节变化、是否接触宿主、
是否产生 Undo、未执行门禁及原因。禁止用离线测试替代真机结论，也禁止把未测写成通过。
