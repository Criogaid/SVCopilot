# SV2 可解释音高技法系统实施计划

## 0. 文档信息

- 上游研究：`docs/deep-research-report.md`
- 可行性依据：`docs/INTERPRETABLE_PITCH_TECHNIQUE_FEASIBILITY_REPORT.md`
- 实施基线：SVCopilot `0c91ebf`
- 计划类型：增量交付；每阶段独立可验收、可停止
- 兼容策略：项目仍处开发阶段，不为尚未发布的内部契约保留兼容分支；schema、handler、guide 与测试必须成对迁移

## 1. 目标

在不重建 MCP、传输和事务基础设施的前提下，为 SVCopilot 增加一条可解释的音高技法链路：

```text
LLM 意图或显式参数
  -> TechniqueIR
  -> 连续目标曲线
  -> SV2 写面编译
  -> PlanRef dry-run / commit
  -> computed-pitch 评价
  -> 可选的有界校准
```

首个可发布目标是“生成、审阅、安全落地”，不是“自动听感调优”。

## 2. 非目标

- 不新建第二个 MCP server。
- 不要求 Python；任何计算后端都必须经过统一 benchmark 门禁。
- 不把 Lua bridge 变成数学运行时。
- 不暴露宿主 handle、完整 curve arrays 或内部 solver 状态给普通 LLM 响应。
- 不提供成功提交后的长期 `restore_transaction`。
- 不自动规避 shared NoteGroup 风险。
- 不承诺对任意录音自动识别全部演唱技法。
- 不把 computed-pitch 误差下降等同于听感改善。

## 3. 实施原则

1. **Node 是唯一编排权威。** MCP schema、Context、PlanRef、Artifact、ledger、事务和宿主协调继续留在 Node。
2. **模型先纯函数。** 前向模型不得读 store、宿主或环境变量；相同输入必须逐字节确定。
3. **单位必须进入类型。** seconds、BLICK、cents、semitones 不用裸 `number` 跨层传递而不标单位。
4. **生成与执行分离。** planner 只产出 PlanRef；写入继续走现有 mutation kernel。
5. **大数据默认外置。** dense samples、完整 IR、fit traces 和 per-point evidence 进入 Artifact。
6. **先离线后宿主。** 数学正确性先用 synthetic corpus 封闭验证，再进入 SV Live Probe。
7. **失败必须可分类。** 不可识别、数据不足、宿主未处理、事务失败和听感未知是不同结论。
8. **不隐藏研究不确定性。** fit result 必须带 termination、residual、bounds、initialization 和 identifiability evidence。
9. **每阶段保持全绿。** 不允许用大范围 fixture 重写掩盖架构错误。

## 4. 目标架构

### 4.1 模块边界

建议的新模块名称是实施锚点，可在首个提交中按现有命名规则微调，但职责不得混合：

| 模块 | 职责 | 禁止职责 |
|---|---|---|
| `technique-ir.js` | schema-independent normalization、版本、单位、约束 | 宿主读取、拟合、写入 |
| `pitch-models/second-order.js` | 二阶瞬态前向模型 | 参数搜索 |
| `pitch-models/richards.js` | 可识别 logistic/Richards 前向模型 | AVA GUI/HMM |
| `pitch-models/vibrato.js` | rate/depth/phase/drift/envelope 颤音 | 宿主时间换算 |
| `pitch-models/compose.js` | 技法叠加、clamp、冲突 | PlanRef、Artifact |
| `technique-compiler.js` | seconds -> BLICK、cents -> 写面、采样与简化 | 宿主写入 |
| `technique-fit-adapter.js` | 统一 solver 请求、响应和 capability | 绑定某一种语言实现 |
| `technique-evaluation.js` | synthetic/observed curve 指标 | 音乐审美判断 |
| `technique-plan.js` | Context scope、IR 构造、Artifact、PlanRef | mutation |
| `technique-calibration.js` | 有界宿主试写/观测/接受/补偿状态机 | 长期恢复 token |

### 4.2 Surface 归属

不增加顶层工具；使用现有 facade：

| Facade | 新 operation | 作用 |
|---|---|---|
| `sv_plan` | `plan_pitch_techniques` | 从显式技法或受限意图生成 TechniqueIR 和 PlanRef |
| `sv_read` | `analyze_pitch_techniques` | 从 captured computed pitch 做只读分解/拟合 |
| `sv_edit` | 复用 `patch_parameter_curves` / `patch_pitch_controls` | 执行 planner 产出的 PlanRef |
| `sv_edit` | `calibrate_pitch_techniques`（后置阶段） | 单次请求内有限轮反馈校准 |
| `sv_artifact` | 复用 | 读取 IR、dense samples、fit evidence、iteration trace |

如果最终发现 `calibrate_pitch_techniques` 不能满足当前事务诚实性，则不暴露该 operation，保留“离线拟合 + 单次 commit + 只读比较”。

### 4.3 TechniqueIR v1

最小契约：

```json
{
  "schemaVersion": 1,
  "modelVersion": "technique-models-v1",
  "scope": {"contextId": "ctx_...", "occurrence": 0},
  "timeDomain": "seconds",
  "pitchUnit": "cents_relative_to_score",
  "techniques": [
    {
      "id": "tech_0",
      "kind": "portamento",
      "anchor": {"fromNote": 4, "toNote": 5},
      "model": {
        "family": "richards_identifiable",
        "inflectionSeconds": 2.14,
        "steepnessPerSecond": 16,
        "asymmetry": 1
      }
    }
  ],
  "composition": {"rule": "sum_then_clamp", "maxAbsCents": 200},
  "targetSurface": "pitchDelta"
}
```

约束：

- `occurrence` 是 Context 内 ordinal；单 occurrence 时请求可省略，canonical IR 必须显式化。
- Note 锚点仅使用 `indexInGroup` 数字。
- `targetSurface` 只能是 `pitchDelta` 或 `pitchControlCurve`。
- `pitchDelta` 输出为 cents；`pitchControlCurve` 编译输出为 group-relative semitone。
- 模型 span 必须由 anchor 和 seconds 参数推导，不允许再附一份冲突的 BLICK span。
- canonical IR 不保存完整 note fingerprints；Plan capsule 只封存真正涉及的 notes 和目标守卫。
- technique 数、总采样点、单 technique 时长和输出范围均有硬上限。

## 5. 阶段总览

| 阶段 | 交付物 | 宿主依赖 | 可独立发布 |
|---|---|---|---|
| P0 | 基线、golden corpus、契约决策 | 无 | 否 |
| P1 | TechniqueIR 与三个前向模型 | 无 | 内部库 |
| P2 | 组合器与双写面编译器 | 无 | 内部库 |
| P3 | `plan_pitch_techniques` + PlanRef | 只读快照夹具 | **是，首个 MVP** |
| P4 | 拟合后端 benchmark 与选型 | 无 | 研究工具 |
| P5 | `analyze_pitch_techniques` | captured computed pitch | 是，预览版 |
| P6 | 宿主编译保真验收 | SV Live Probe | 是，RC 门禁 |
| P7 | 有界闭环校准 | SV Live Probe | 条件式 |
| P8 | 评估、文档、发布证据 | 人工试听 + 宿主 | 正式版 |

## 6. P0：冻结基线与研究夹具

### 6.1 工作项

1. 固定当前 main commit、Node/Lua protocol、host profile 和测试总数。
2. 建立 synthetic corpus，至少覆盖：
   - 欠阻尼、临界阻尼、过阻尼；
   - 上行/下行 logistic；
   - asymmetry 边界；
   - 4/5.5/7/9 Hz 颤音；
   - depth/rate drift；
   - tempo change 前后同一秒域技法；
   - 重叠 portamento + vibrato + overshoot；
   - null gap、全 null 和低 coverage。
3. 为每个 case 保存：输入参数、dense curve、期望不变量、允许误差和 seed。
4. 建立真实宿主夹具清单：
   - 12-note 小 group；
   - 373-note 大 group；
   - 变速 group；
   - 同一 target 的两个 reference；
   - 有既有 `pitchDelta` 的 group；
   - 有既有 PitchControl 的 group；
   - computed pitch 全 null、部分 finite、充分 finite 三种状态。
5. 记录 current behavior，而非把研究报告示例数字写成断言。

### 6.2 门禁

- `npm test` 与 MCP smoke 全绿。
- corpus JSON 可 canonical hash，重复生成 hash 相同。
- 所有单位、误差阈值和随机 seed 显式。
- 没有真实歌词或用户工程内容进入仓库 fixture。

## 7. P1：TechniqueIR 与前向模型

### 7.1 二阶瞬态

实现：

- `secondOrderResponse({time, naturalHz, dampingRatio, gain, onsetSeconds, polarity})`；
- 对 `zeta < 1 - eps`、`|zeta - 1| <= eps`、`zeta > 1 + eps` 分支计算；
- time < onset 返回 0；
- 所有输出必须 finite；
- 参数 bounds 与业务技法 preset 分离。

测试：

- 三个阻尼分支连续；
- `zeta -> 1` 左右极限不爆炸；
- 首峰时间/幅度符合解析或高精度参考；
- 负 polarity 镜像；
- 极小/极大参数返回结构化校验错误而非 NaN。

### 7.2 Richards/logistic

实现可识别参数：

```text
lower, upper, inflectionSeconds, steepnessPerSecond, asymmetry
```

不暴露原 AVA 式中同时自由的 `A + M`。测试覆盖：

- 上行/下行端点；
- inflection 对齐；
- asymmetry = 1 退化为普通 logistic；
- 大指数通过稳定分支计算，无 overflow；
- 平移时间只改变 inflection，不改变 shape。

### 7.3 时变颤音

实现：

- phase 为 radians；rate 为 Hz；depth 为 cents；
- raised-cosine 或同等连续 envelope；
- 可选线性/分段 rate drift 与 center drift；
- fade 长度超过 span 时按确定规则归一，不出现交叠增益异常。

测试：

- 零 depth 恒为零；
- 固定 rate 的过零间隔正确；
- 秒域频率在 tempo change 前后不变；
- envelope 起止连续；
- 同 seed/输入逐字节相同。

### 7.4 P1 退出标准

- synthetic forward golden 全绿；
- property tests 不产生 NaN/Infinity；
- 纯模型包不 import store、session、Artifact 或 host adapter；
- Node 单线程生成 10,000 samples 的 p95 在基线机器上小于 20 ms，或记录经批准的新阈值。

## 8. P2：组合器与编译器

### 8.1 组合规则

确定以下唯一语义：

1. 各 technique 先在相对 score cents 域求值；
2. 同写面默认相加；
3. 显式 exclusive technique 重叠时报冲突，不按后写覆盖；
4. 合成后统一 clamp；
5. 输出 `clampedRanges`、`contributors` 摘要和完整 detail Artifact；
6. technique 顺序不影响结果。

### 8.2 时间编译

- 先生成绝对 seconds 采样位置；
- 对每个位置调用现有 `blickAtSeconds` 或等价 TimeAxis 映射；
- 相邻点映射到同一整数 BLICK 时按确定规则合并；
- 不用 `getBlickFromSeconds(duration)` 代替绝对坐标差；
- 保存 seconds/BLICK 往返误差统计。

### 8.3 `pitchDelta` 编译

- 输出现有 parameter-curve mutation 格式；
- 默认 `mode:"replace"` 仅覆盖明确 span，或 `mode:"add"` 明确与旧曲线相加；
- 读取/声明 Automation interpolation；
- 简化后在目标插值语义下重新采样，验证 `maxErrorCents <= epsilonCents`。

### 8.4 `PitchControlCurve` 编译

- dense 绝对 sounding pitch 先换为 group-relative semitone；
- anchor 和 points 使用现有 PitchControl 契约；
- 默认只 add SVCopilot-owned control；
- 任何 replace/delete 必须带 expected fingerprint；
- `pitchDelta` 同时存在时返回 `PITCH_SURFACE_INTERACTION_REQUIRES_REVIEW`，不自动清除。

### 8.5 压缩

复用/抽取当前 RDP 内核，但补充：

- vertical cents/semitone error，而非混合时间与音高的欧氏距离；
- 强制保留 span 端点、音符边界、技法拐点、envelope 边界和 polarity change；
- 点数上限不能通过放宽调用方 epsilon 静默满足；
- 超预算返回 `CURVE_POINT_BUDGET_EXCEEDED` 和 required/allowed evidence。

### 8.6 P2 退出标准

- 两个写面在 synthetic corpus 上均满足声明误差；
- technique 输入顺序置换不改变 canonical output hash；
- tempo-change case 的颤音 Hz 误差低于 0.5%；
- 任何编译失败均在 PlanRef 封存和宿主写入前发生；
- 10,000 dense samples 编译和简化 p95 小于 50 ms，或记录批准阈值。

## 9. P3：接入现有 planner 与 PlanRef

### 9.1 请求契约

`sv_plan(operation:"plan_pitch_techniques")` 接受：

```json
{
  "contextId": "ctx_...",
  "occurrence": 0,
  "techniques": [
    {
      "kind": "portamento",
      "fromNote": 4,
      "toNote": 5,
      "shape": "richards",
      "durationSeconds": 0.18,
      "asymmetry": 1.1
    }
  ],
  "targetSurface": "pitchDelta",
  "constraints": {"maxAbsCents": 200, "maxPoints": 1200, "epsilonCents": 1.0},
  "execution": {"atomic": true, "undoLabel": "SV Copilot pitch techniques"}
}
```

Planner 响应只返回：

- `status:"planned"`、`effects:"none"`；
- technique/curve/point 摘要；
- warnings 与 `requiresHumanAudition:true`；
- `apply:{tool, arguments:{planRef, action:"dry_run"}, expiresAt}`；
- 可选 detail Artifact。

不得返回完整 points、完整 fingerprints 或 inline mutation。

### 9.2 Capsule

只封存：

- target group UUID；
- occurrence 的 time/pitch offset；
- 被 anchor 引用的 note fingerprints；
- shared-target evidence；
- 实际 mutation payload；
- model/compiler version 与 canonical IR hash。

不得封存整个 373-note occurrence，除非所有 notes 都实际参与且有测试证明必要。

### 9.3 测试闭环

schema、handler、planner、operation catalog、guide 和测试同一批提交。至少覆盖：

- 单 occurrence 省略 ordinal；
- multi occurrence 缺 ordinal；
- note index 越界/未捕获；
- breath/continuation 的显式策略；
- shared target dry-run 与 commit 确认；
- PlanRef 先 dry-run 后 commit；
- PlanRef 防重放；
- Context TTL 后 capsule 仍能 live preflight；
- stale note/timeOffset/UUID 拒绝且零写入；
- compact response 预算；
- Artifact 释放和配额。

### 9.4 P3 退出标准

- 通过现有 8-facade MCP surface 调用，无新增 direct public tool；
- dry-run 零 setter、零 Undo；
- commit 最多一个用户 Undo，读回验证通过；
- 失败语义完全使用当前 `status x effects x isError` 矩阵；
- 12-note 与 373-note planner 响应均在 IO policy 预算内；
- 本阶段即可作为“可解释前向技法规划 MVP”发布。

## 10. P4：拟合后端 benchmark 与语言选型

### 10.1 统一 adapter 契约

先定义语言无关协议：

```json
{
  "protocolVersion": 1,
  "operation": "fit_richards",
  "requestId": "fit_...",
  "samples": {"timeSeconds": [0.0], "cents": [0.0], "mask": [true]},
  "initial": {},
  "bounds": {},
  "loss": {"kind": "huber", "scaleCents": 8},
  "limits": {"maxIterations": 200, "timeoutMs": 1000, "multiStarts": 8},
  "seed": 1
}
```

响应必须含：

```json
{
  "ok": true,
  "solver": {"engine": "...", "version": "..."},
  "termination": "converged",
  "parameters": {},
  "metrics": {"rmseCents": 0.0, "maxAbsCents": 0.0, "iterations": 0},
  "identifiability": {"multiStartSpread": {}, "acceptable": true},
  "warnings": []
}
```

### 10.2 候选实现

至少比较：

1. Node 实现或维护活跃的 JS LM 库；
2. Rust 原生 helper 或 WASM；
3. Python 3.10+ + SciPy `least_squares`。

可以淘汰明显不满足安装或维护要求的候选，但必须记录证据。

### 10.3 同环境门禁

每个候选在同一 corpus、同一 seed、预热后 20 次测量：

| 指标 | 必须满足 |
|---|---|
| forward parity | 与 Node canonical model 最大偏差 <= `1e-9` cents，或解释浮点差异 |
| clean synthetic recovery | 95% case 参数落在预设容差内 |
| noisy recovery | median curve RMSE <= 5 cents |
| invalid/degenerate input | 100% 结构化拒绝，不 hang、不 NaN |
| p95 单 transition fit | <= 100 ms |
| p95 20-technique phrase fit | <= 1500 ms |
| determinism | 同 seed 输出 canonical hash 相同 |
| timeout | 超时后 worker 可继续服务下一请求 |
| deployment | Windows/macOS 安装流程有自动测试 |
| license | 可发行且 NOTICE 完整 |

阈值允许在 P0 基线后修订一次，但修订必须记录测量数据，不能为某候选倒推放宽。

### 10.4 选型规则

- Node 达标：优先 Node，不增加运行时。
- Node 不达标而 Rust 达标：优先预编译 Rust helper；WASM 只有在性能和打包均更优时采用。
- 只有 SciPy 明显胜出：采用可选 Python worker，并提供 doctor capability；前向规划仍不依赖 Python。
- 没有候选达标：P5 停止，不用低可信 fit 污染正式 surface；MVP 仍停在 P3。

## 11. P5：只读技法分析与拟合

### 11.1 处理流程

1. 从 snapshot capsule 取得 notes、tempo map 和 computed-pitch samples；
2. 保留 null mask，不做零填充；
3. 转成 score-relative cents；
4. baseline estimation；
5. vibrato candidate detection 与 flatten；
6. transition candidate detection；
7. Richards fit；
8. second-order transient candidate/fit；
9. 有界 joint refinement；
10. 输出 explained/residual coverage。

### 11.2 初版候选检测

首版不必立即移植完整 AVA HMM。先用：

- score note boundary windows；
- 一阶导数方向和连续性；
- minimum duration / cents movement；
- vibrato-filtered curve；
- 明确的 candidate confidence。

只有 heuristic 在 synthetic + host corpus 上不足时再移植 AVA 三状态 HMM。避免先搬一套 MATLAB pipeline，再发现宿主 computed pitch 的分布不同。

### 11.3 输出纪律

普通响应只返回：

- technique counts/type；
- explainedCoverage、residualRmseCents；
- confidence/identifiability 摘要；
- warnings；
- detail Artifact。

完整 samples、每次 multi-start、residual curve、候选窗口和 rejected fits 只在 Artifact。

### 11.4 错误分类

至少定义：

- `COMPUTED_PITCH_NOT_CAPTURED`；
- `INSUFFICIENT_COMPUTED_PITCH`；
- `SAMPLING_RATE_TOO_LOW`；
- `NO_TECHNIQUE_CANDIDATE`（成功的空分析，不是内部错误）；
- `MODEL_NOT_IDENTIFIABLE`；
- `FIT_DID_NOT_CONVERGE`；
- `FIT_WORKER_UNAVAILABLE`；
- `FIT_TIMEOUT`。

### 11.5 P5 退出标准

- synthetic mixed corpus 的 technique detection F1 和参数恢复达到 P0 设定阈值；
- all-null、合法无声区和 processing pending 不混淆；
- 结果由 model/solver version 可完整复现；
- 分析 operation 绝不调用 setter/newUndoRecord；
- 373-note case 主响应符合 IO budget，detail 可分页/释放。

## 12. P6：真实宿主编译保真验收

### 12.1 SV Live Probe 场景

每个场景执行 snapshot -> plan -> dry-run -> isolated commit -> wait -> compare -> restore fixture：

1. constant-tempo single note vibrato；
2. tempo-change spanning vibrato；
3. ascending/descending portamento；
4. overshoot/preparation；
5. overlapping techniques；
6. `pitchDelta` target；
7. PitchControl target；
8. existing pitchDelta/PitchControl coexistence；
9. shared target two occurrences；
10. 12-note 与 373-note scalability；
11. partial-null/full-null computed pitch；
12. stale Context and host reconnect。

### 12.2 记录指标

- requested dense curve vs compiled curve error；
- compiled curve vs computed pitch error；
- seconds/BLICK roundtrip；
- points before/after simplification；
- processing attempts/coverage/stability；
- host calls、PIPE bytes、service time、wall time；
- Undo count；
- rollback verification；
- Artifact bytes 和 MCP response bytes。

### 12.3 P6 退出标准

- 编译曲线误差满足调用者 epsilon；
- 变速场景颤音 rate 偏差 <= 1%；
- 所有 commit 一个 Undo；
- shared target 未确认时零写入；
- failed/rolled_back/unknown 路径与工程最终状态一致；
- 原 fixture 内容、handles、pending executions、Artifact 全部清理；
- 人工试听记录与客观指标分栏，不得互相代替。

## 13. P7：有界闭环校准（条件阶段）

### 13.1 安全状态机

只允许单次 operation 内运行：

```text
captured
  -> candidate_applied
  -> observing
  -> accepted
     or restoring -> restored
     or uncertain
```

约束：

- 最大 3 次候选写入；
- 第一次写前保存完整旧状态；
- 全过程持有 ExecutionCoordinator 独占权；
- 总 host deadline、单次 processing deadline、点数和范围有硬上限；
- 每轮只更新已声明写面；
- objective 没有改善时恢复上一已验证状态；
- 只有最终接受状态进入成功响应；
- 任何断连/超时导致状态不可证明时返回 `outcome_unknown`；
- 不返回可在之后调用的 restore token。

### 13.2 优化策略

第一版只做低风险策略：

- identity/diagonal response approximation；
- L2 平滑与幅度正则；
- backtracking step size；
- objective = weighted RMSE + max-error penalty + smoothness penalty；
- 不联合优化两个写面；
- 不改变 notes、voice、lyrics 或 structure。

### 13.3 发布门禁

只有以下条件全部满足才暴露 operation：

- 故障注入覆盖第一轮、第二轮和最终验证失败；
- disconnect/hang 结果诚实；
- 恢复读回 100% 通过；
- 真实宿主 corpus 上 median objective 至少改善 30%；
- 任一 case 不得恶化超过 10 cents RMSE 而仍报告 accepted；
- 一个请求最多一个用户 Undo；
- p95 在 60 秒外层上限内留至少 10 秒安全余量；
- 人工确认临时写入不会造成不可接受的 UI/播放副作用。

若任何门禁不满足，删除/不注册该 operation，保留 P5 的只读建议流程。

## 14. P8：评估与发布

### 14.1 自动评估

- synthetic parameter recovery；
- model branch/property tests；
- compiler max-error tests；
- Context/PlanRef/stale/shared-target tests；
- transaction fault injection；
- token/Artifact/PIPE budgets；
- Windows/macOS packaging；
- solver reproducibility；
- full `npm test` + MCP smoke。

### 14.2 人工 A/B

使用现有 `sv_audition_compare`，采用 blinded、随机顺序的 A/B；记录：

- phrase/fixture ID，不记录私人歌词；
- host/profile/model/compiler/solver version；
- technique parameters；
- objective metrics；
- 人工偏好和可选理由；
- 未听、无法判断和无差异是合法结果。

没有音频资源返回给 MCP，因此所有听感结论保持 `human_only`。

### 14.3 发布证据

发布包必须包含：

- capability 列表；
- model/solver 版本；
- 支持和不支持的技法；
- 单位与写面说明；
- host acceptance matrix；
- benchmark；
- 许可证/NOTICE ledger；
- 已知限制；
- 恢复与 `outcome_unknown` 操作指南。

## 15. 测试矩阵

| 层 | 必测内容 |
|---|---|
| Schema | unknown field、union discriminator、bounds、单位、operation routing |
| Model | damping branches、overflow、continuity、determinism、property tests |
| Composition | overlap、order independence、clamp、exclusive conflict |
| Compiler | tempo map、coordinate offset、unit conversion、interpolation、epsilon |
| Planner | Context/occurrence/note index、breath/continuation、capsule cropping |
| PlanRef | dry-run-before-commit、ledger、TTL、target mismatch、replay |
| Mutation | one Undo、read-back、float tolerance、rollback、disconnect |
| Analysis | null mask、coverage、sampling rate、identifiability、timeout |
| Artifact | budget、paging、hash、release、quota、no payload duplication |
| Performance | 12/373 notes、10k samples、20 techniques、host calls/PIPE bytes |
| Host | constant/variable tempo、two surfaces、shared target、reconnect |

## 16. 性能与传输预算

初始门禁；P0 允许基于测量修订一次：

| 项目 | 预算 |
|---|---|
| planner 普通响应 | <= 4 KiB |
| analysis 普通响应 | <= 4 KiB |
| error 普通响应 | <= 2 KiB |
| TechniqueIR inline | <= 8 KiB，否则 Artifact |
| 单 technique dense samples | <= 2000 |
| 单请求 techniques | <= 64 |
| 单 Plan compiled points | <= 4000 |
| Node forward+compile p95 | <= 100 ms（不含宿主） |
| worker single fit p95 | <= 100 ms |
| worker phrase fit p95 | <= 1500 ms |
| host dry-run | 不得出现与 group 全量规模无关的隐藏遍历 |
| host commit | 必须报告阶段 timings，不用 service time 冒充 wall time |

诊断必须分开报告：MCP request/response bytes、Artifact bytes、PIPE bytes、host calls、worker bytes、operation/service/wall timings。

## 17. 提交序列建议

每项独立提交、提交前全绿：

1. `Add synthetic technique-model corpus and invariants`
2. `Introduce versioned TechniqueIR normalization`
3. `Implement stable second-order transient model`
4. `Implement identifiable Richards transition model`
5. `Implement time-varying vibrato model`
6. `Compose and constrain technique curves deterministically`
7. `Compile TechniqueIR to existing SV2 pitch surfaces`
8. `Expose plan_pitch_techniques through the plan facade`
9. `Benchmark replaceable nonlinear-fit backends`
10. `Add read-only pitch-technique decomposition`
11. `Validate compilation fidelity on the live host`
12. `Add bounded calibration only if safety gates pass`
13. `Publish evaluation and dependency provenance`

不允许把 schema 改动、handler 改动和 guide/test 迁移拆成不同提交；不允许用兼容 alias 暂时保留旧错误契约。

## 18. Definition of Done

### 18.1 MVP 完成（P3）

- TechniqueIR v1、三个前向模型、组合器、双写面编译器完成；
- `plan_pitch_techniques` 可从现有 facade 发现和调用；
- 返回 PlanRef-only apply envelope；
- dry-run/commit 复用现有安全事务；
- synthetic、schema、Artifact、PlanRef 和 IO budget 测试全绿；
- 明确标注 `human_only`。

### 18.2 分析预览完成（P5）

- 拟合后端经统一 benchmark 选定；
- computed pitch 可输出可解释技法与残差；
- all-null/低采样/不可识别均诚实拒绝；
- solver/model 版本和 evidence 可复现。

### 18.3 RC 完成（P6）

- constant/variable tempo、两个写面、shared target、12/373 notes 实机通过；
- 编译误差、Undo、事务、性能和清理证据完整；
- 无发布阻塞级 host defect。

### 18.4 正式完成

- P8 自动和人工评价完成；
- 许可证/NOTICE、已知限制和操作指南齐全；
- 若 P7 未通过，则正式范围明确不含自动闭环，不影响 P3/P5/P6 发布；
- 文档不得宣称音频渲染、通用歌手校准或自动听感优化。

## 19. 立即下一步

从 P0 开始，不先安装任何新语言运行时：

1. 创建 synthetic corpus 和不变量测试；
2. 从现有 `expression-plan.js` / `pitch-gesture-plan.js` 抽取可复用的秒域采样事实，而不是直接重构两个 planner；
3. 建立 `TechniqueIR` 和纯模型模块；
4. 通过 P1/P2 离线门禁后，再决定如何接入 planner；
5. 直到 P4 benchmark 才决定拟合后端语言。

这条顺序确保：即使拟合或闭环研究最终失败，项目仍会获得一个可发布、可解释、事务安全的前向技法规划能力。
