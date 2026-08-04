# 可解释音高技法方案交叉验证后的合并执行计划

## 0. 文档信息

- 本文档是 `docs/CROSS_VALIDATION_PITCH_TECHNIQUE_REPORT.md` 的执行侧产物
- 合并来源（均未修改）：
  - **A 方案**：`docs/INTERPRETABLE_PITCH_TECHNIQUE_FEASIBILITY_REPORT.md` +
    `docs/INTERPRETABLE_PITCH_TECHNIQUE_IMPLEMENTATION_PLAN.md`
  - **B 方案**：`docs/DEEP_RESEARCH_FEASIBILITY_ASSESSMENT.md` +
    `docs/DEEP_RESEARCH_EXECUTION_PLAN.md`
  - 共同上游：`docs/deep-research-report.md`
- 基线：SVCopilot `0c91ebf`，60 个测试文件，41 operation / 7 facade + `sv_describe`
- 合并原则：**A 方案的阶段骨架 + B 方案的能力边界 + 交叉验证新增的两项前置**

本计划**取代**不了任何原文档；它记录的是在四份文档冲突处的裁定，
以及两份都遗漏的工作项。原文档的未冲突部分继续有效，本文不再重复。

## 1. 与 A 方案实施计划的差异一览

只列差异。A 方案未被提及的部分默认沿用。

| A 方案条目 | 本计划裁定 | 依据 |
|---|---|---|
| §4.3 `targetSurface: pitchDelta \| pitchControlCurve` | **扩展为三值 + 新增 `hostVibrato` 策略字段** | 交叉验证 X2 |
| §9.1 请求含 `execution:{atomic,undoLabel}` | **删除** | X5 |
| §16 planner/analysis 响应 ≤ 4 KiB、error ≤ 2 KiB | **改为 16 / 16 / 8 KiB** | X6 |
| §8.5 "复用/抽取当前 RDP 内核，但补充垂直误差" | **先读代码：垂直误差已实现**，改为补充强制锚点 | X-核验 |
| §8.6 "颤音 Hz 误差 < 0.5%" | **保留，但前置 P0.5 换算比对** | X1 |
| §10.2/§10.3 三候选 × 双平台 benchmark | **降级为 Node-first + 预声明失败触发** | X9 |
| §12 P6 场景清单 | **新增 tempo-ramp 场景与插值方法漂移场景** | X1 / X3 |
| §13.3 闭环 60 s 外层预算 | **改为由 P6 实测 processing p95 推导** | X7 |
| §14.2 用 `sv_audition_compare` 做 blinded A/B | **删除该服务，降级为人工操作指南** | X4 |
| §8 开源 pin = 写作时 HEAD | **改为审阅存档 SHA + 抓取日期** | X10 |
| §11.4 分解输出 residual | **拆为 `residual_unmodeled` / `residual_below_observability`** | X8 |
| §17 提交序列 13 项 | **新增 2 项前置提交，删除 1 项** | 见 §9 |

## 2. 新增前置阶段 P0.5：两项阻塞验证

A 方案的 P0 是纯离线的（corpus + fixture 清单）。本计划在 P0 与 P1 之间插入
一个**只读 / 纯契约**的 P0.5，因为 X1 与 X2 会使后续多项门禁失去意义。

### 2.1 P0.5-A：秒↔BLICK 换算一致性比对（只读真机）

**问题**：全仓库的规划路径从不调用宿主 `TimeAxis`。
`server/src/musical-time.js:130/144` 用快照捕获的 tempoMarks 做分段线性积分：

```
secondsAtBlick: positionSeconds + ((blick − positionBlick) / quarterBlick) × (60 / bpm)
blickAtSeconds: positionBlick + (seconds − positionSeconds) × quarterBlick × (bpm / 60)
```

唯一调用宿主换算的地方是 `server/src/audition.js:66-67`（试听区间）。
因此"颤音 Hz 在变速下不漂移"这一保证，实际依赖 Node 侧模型与宿主内部实现的一致性，
而这从未比对过。

**实验**（全部只读，不写入，不创建 Undo）：

1. 准备一个含至少 3 处 tempo change 的工程，其中一处为**渐变**（若 SynthV 支持 ramp）。
2. 通过 `sv_raw(call)` 对宿主 `TimeAxis.getSecondsFromBlick` 取一批 BLICK 的秒值；
   同一批 BLICK 用 `secondsAtBlick` 计算；报告逐点偏差、最大偏差、偏差随 BLICK 的分布。
3. 反向：`getBlickFromSeconds` vs `blickAtSeconds`，同样报告。
4. 采样点必须包含：每个 tempo mark 的**前一 BLICK、该 BLICK、后一 BLICK**
   （边界取整规则是最可能分歧的地方）。
5. 若存在 ramp：在 ramp 区间内密集采样，检验 Node 侧的阶跃假设是否产生系统性偏差。

**退出判据**：

- 记录最大绝对偏差（秒）与相对偏差（相对该点局部四分音符时长）。
- 若最大相对偏差 < 0.1%：A 方案的 0.5% / 1% Hz 门禁有效，直接进入 P1。
- 若偏差 ≥ 0.1% 且集中在 tempo mark 边界：修正 `musical-time.js` 的边界取整规则，重测。
- 若偏差来自 ramp：**规划路径必须改为逐点调用宿主 TimeAxis**，
  或在检测到 ramp 时拒绝 Hz 类技法并返回显式错误。这会改变 P2 编译器的
  宿主调用次数预算，必须在此阶段就确定，不能留到 P6。

**为什么必须前置**：若留到 P6 才发现，届时已有 P2 的编译器、P3 的 planner、
P5 的分解流水线全部建立在错误换算之上，且调试会指向模型而非换算。

### 2.2 P0.5-B：宿主颤音面契约冻结（纯契约，无宿主依赖）

**问题**：manifest 确认宿主有两个独立颤音面：

- `Automation` 的 `vibratoEnv`（`"Vibrato Envelope"`，range `0,2`，默认 `1`）
- `Note.getAttributes` 的 `dF0Vbr` / `dF0VbrMod` / `fF0Vbr` / `pF0Vbr` /
  `tF0VbrLeft` / `tF0VbrRight` / `tF0VbrStart`

而本仓库**已经在写 `vibratoEnv`**：`expression-plan.js:730` 的
`spoken_rap_transition` 意图会播种 `vibratoEnv 0.2` 压平宿主颤音，
`expression-gestures.js:262` 已把 `surface` 限定为 `pitchDelta | vibratoEnv`。

A 方案的 TechniqueIR 只有 `pitchDelta | pitchControlCurve`，组合器只处理同写面相加。
所以一个 IR 颤音写 `pitchDelta` 时，宿主自然颤音仍然生效 → **双重颤音**，
且组合器看不见它。更麻烦的是宿主自然颤音的存在与深度**官方 API 不可观测**
（`expression-plan.js:459` 已如实标注）。

**冻结以下契约**（无需真机，但必须在 IR v1 定版前完成）：

TechniqueIR 增加：

```json
{
  "targetSurface": "pitchDelta | pitchControlCurve | vibratoEnv",
  "hostVibrato": {
    "policy": "suppress | assume_absent | require_review",
    "suppressLevel": 0.0
  }
}
```

三种策略的语义与责任归属：

| policy | 行为 | 何时用 | 诚实性边界 |
|---|---|---|---|
| `suppress` | IR 颤音同时在 `vibratoEnv` 写 `suppressLevel`（默认 0），把颤音权威收归 IR | 需要精确颤音参数时的默认 | 多写一个写面 → 组合器必须把 `vibratoEnv` 纳入冲突检测 |
| `assume_absent` | 只写 `pitchDelta`，声明"假定宿主颤音不显著" | 短音、已知无颤音区 | **必须在响应里发 warning**：这是假定，不是观测 |
| `require_review` | 拒绝生成，返回 review 要求 | 无法判断时 | 最保守 |

**退出判据**：

- IR schema 含上述字段，`additionalProperties:false`。
- 组合器的冲突检测覆盖 `vibratoEnv` 与 `pitchDelta` 的跨面组合
  （`expression-plan.js:989` 已有"absolute 表现手法不能与同参数其他手法重叠"的先例，
  应对齐该语义而非另造一套）。
- `assume_absent` 路径**必须**产生 warning，且 warning 文本不得暗示已观测。
- 单元测试：同一颤音在三种 policy 下产生的 operation 集合互不相同，且
  `suppress` 的 `vibratoEnv` operation 与 `pitchDelta` operation 在同一事务内。

**为什么必须前置**：这是 IR 契约本身的缺口。IR v1 一旦冻结并被 planner
和 capsule 依赖，补一个改变写面集合的字段就是破坏性变更。

## 3. P1–P2 的修正项

A 方案 §7 / §8 整体沿用。以下三处修正。

### 3.1 RDP 改造前先读现有实现（修正 A §8.5）

A 方案 §8.5 要求"复用/抽取当前 RDP 内核，但补充 vertical cents/semitone error，
而非混合时间与音高的欧氏距离"。

核验 `server/src/bake-computed-pitch.js:296` 的实际实现：

```js
function perpendicularDistance(point, a, b) {
  const spanTime = b.localBlick - a.localBlick;
  if (spanTime === 0) return Math.abs(point.groupRelativeSemitone - a.groupRelativeSemitone);
  const t = (point.localBlick - a.localBlick) / spanTime;
  const interpolated = a.groupRelativeSemitone + t * (b.groupRelativeSemitone - a.groupRelativeSemitone);
  return Math.abs(point.groupRelativeSemitone - interpolated);
}
```

函数名叫 `perpendicularDistance`，但它按时间参数 `t` 线性插值后取
**音高绝对差**——这已经是垂直误差，不是欧氏距离。A 方案要求的改造**已经满足**。

**修正后的 P2 压缩工作项**：

1. 不改误差度量（已正确）。
2. 只补 A 方案要求的**强制锚点**：技法 span 端点、音符边界、
   技法拐点（Richards 的 `inflectionSeconds`、二阶的首峰时刻）、
   envelope 边界（颤音 fade in/out 起止）、polarity change。
   现有 `rdp()` 只强制保留首末点。
3. 保留 A 方案的 `CURVE_POINT_BUDGET_EXCEEDED` 要求——现有
   `BAKE_POINT_BUDGET_EXCEEDED` 已是这个语义（`bake-computed-pitch.js:274`），
   新编译器应复用同一错误族而非新造。
4. 顺带把函数改名（`verticalError`），因为当前名字会让下一个读者以为要改度量。

### 3.2 `pitchDelta` 编译必须封存插值方法（修正 A §8.3）

`Automation` 有 `getInterpolationMethod` 但**没有** `setInterpolationMethod`
（manifest 方法全集核验）。所以 `epsilonCents` 的误差保证不是本项目能选定的，
它是宿主状态的函数。

**新增要求**：

- 编译时读取并记录 `interpolationMethod`（`"Linear" | "Cosine" | "Cubic"`）。
- Plan capsule 封存该值。
- commit 时 live preflight 比对：不一致则拒绝并返回
  `INTERPOLATION_METHOD_DRIFTED`，说明"计划时按 X 语义保证 ≤ ε，现为 Y"。
- 误差报告字段必须携带 `interpolationBasis`，不得裸报一个 `maxErrorCents`。

现有 `Automation.getLinear` 提供了一个逃生口：它无论当前插值方法为何都按线性求值。
若某技法对插值语义敏感且不愿受 UI 状态影响，可用 `getLinear` 做**验证侧**读回
（但写入侧无法强制线性，所以这只能证明"若按线性解释则误差为 ε"，
不能证明用户听到的就是它）。这个区别必须写进响应，不能含混。

### 3.3 跨写面共存返回 review（沿用 A §8.4，加强措辞）

A 方案 §8.4 要求 `pitchDelta` 同时存在时返回
`PITCH_SURFACE_INTERACTION_REQUIRES_REVIEW`，不自动清除。**沿用**。

加强一点：官方 `PitchControlCurve` 描述只说 "overrides the generated pitch"，
**未定义**它与 `pitchDelta` 的合成语义。所以"override" 到底是否也 override
`pitchDelta` 是未知的。这不是保守起见的 review，而是**真机 P6 必须回答的问题**
（见 §5 场景 8）。在回答前，本计划禁止任何自动跨面清除或自动跨面补偿。

现有 `bake-computed-pitch.js` 的 `PITCH_DELTA_CLEAR_UNSUPPORTED` 已经是这个态度，
新编译器应对齐。

## 4. P3 planner 接入的修正项

### 4.1 请求契约（修正 A §9.1）

删除 `execution` 字段。修正后的请求：

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
  "hostVibrato": {"policy": "suppress", "suppressLevel": 0.0},
  "constraints": {"maxAbsCents": 200, "maxPoints": 1200, "epsilonCents": 1.0}
}
```

理由：`sv_plan_pitch_gesture` 与 `sv_plan_expression` 的 inputSchema
都不接受 `atomic` / `undoLabel` / `execution` / `dryRun`——这些只属于 mutation 工具
（`index.js:562` 的 `undoLabel`）。把执行语义放进 plan 请求违背 A 方案自己的
实施原则 #4，且 planner 不碰宿主，无从校验它。执行入口继续是
`apply.arguments` 的 `action: dry_run | commit`。

### 4.2 响应预算（修正 A §16）

对齐 `server/src/response-budget.js`：

```
COMPACT_MAX_BYTES = 16 KiB   （planner / analysis 普通响应）
ERROR_MAX_BYTES   =  8 KiB   （error 响应）
REQUEST_MAX_BYTES = 16 KiB   （facade 信封 + 业务 arguments）
```

这三个常量被 `surface-io-policy.js` 同源导入，正是为防止文档与代码判据漂移。
若确实要收紧到 4 KiB，必须同步修改 `response-budget.js` 并接受
`surface-io-policy.test.mjs` 与既有 planner 的降级逻辑重测——
本计划判定收益不足，**对齐现有值**。

二级降级沿用 `expression-plan.js:1432` 的既有模式：超过内联明细预算时
把 gestures/operations 移入 `detailRef`，保留完整的 summary / apply / review。

### 4.3 其余沿用

A 方案 §9.2 的 capsule 最小封存集、§9.3 的 11 项测试闭环、§9.4 的退出标准
全部沿用，无修正。特别肯定 §9.2 "不得封存整个 373-note occurrence"——
这与 `scope-source.js` 的 `CAPSULE_REQUIREMENTS_BY_OPERATION` 设计一致。

## 5. P4 后端选型的降级（修正 A §10）

### 5.1 保留 adapter 契约

**A 方案的 worker 协议予以采纳**，这是其相对 B 方案的实质架构优势：
协议一旦定死，换实现不改 MCP 契约。

请求 / 响应形状沿用 A 方案 §10.1，不改。

### 5.2 但把三候选竞标降级为 Node-first

A 方案 §10.3 要求每个候选满足"Windows/macOS 安装流程有自动测试"、
"license 可发行且 NOTICE 完整"、"p95 20-technique phrase fit ≤ 1500 ms"。
三个候选 × 两个平台的打包与安装自动化，工作量很可能超过拟合内核本身。

**修正后的 P4**：

1. 定义 adapter 契约（沿用 A §10.1）。
2. **只实现 Node 后端**，跑完 A 方案 §10.3 的全部功能与性能门禁
   （forward parity ≤ 1e-9 cents、clean recovery 95%、noisy median RMSE ≤ 5 cents、
   invalid input 100% 结构化拒绝、p95 单 transition ≤ 100 ms、
   p95 20-technique ≤ 1500 ms、determinism、timeout 后可继续服务）。
   跳过跨平台打包门禁——Node 后端不引入新运行时，现有打包链已覆盖。
3. **预声明失败触发条件**：以下任一不达标即启动第二候选评估，
   且必须记录具体不达标项与测量数据：
   - clean recovery < 95%；
   - noisy median RMSE > 5 cents；
   - p95 单 transition > 100 ms；
   - box constraints + Huber loss 出现无法通过重参数化解决的数值发散。
4. 第二候选优先 Rust 预编译 helper（A 方案 §10.4 的排序正确）。
   仅当 Rust 也不达标且 SciPy 明显胜出时，才引入可选 Python worker
   并提供 doctor capability。

**理由**：B 方案的 Node-first 默认在成本上正确，A 方案的可替换协议在架构上正确。
两者不冲突——先建协议再只做一个实现，是同时拿到两份收益的路径。

## 6. P5 分解流水线的修正项

### 6.1 residual 必须分两类（修正 A §11.1 第 10 步 / §11.4）

Saitou 四分量中的 fine fluctuation（>10 Hz 不规则抖动）在 computed pitch 上
**原理上不可靠观测**：采样间隔由调用方给定
（`musical-range.js:966`，`intervalBlick = ceil((end−start)/frames)`），
帧预算上限 20,000/快照、2,000/组；且宿主生成的 computed pitch 是否**包含**
fine fluctuation 本身未经真机确认。

若只报一个 `residualRmseCents`，模型会把采样不足当成"还有技法没找到"并继续堆技法。

**修正后的输出**：

```json
{
  "explainedCoverage": 0.87,
  "residual": {
    "unmodeled": {"rmseCents": 4.2, "basis": "above_nyquist_of_request_grid: false"},
    "belowObservability": {"rmseCents": 2.1, "basis": "sampling_interval_ms: 12.5, resolvable_hz: 40"}
  }
}
```

判据：给定采样间隔 `Δ`，可分辨的最高频率约为 `1/(2Δ)`，
但要保住**形状**需每周期 12–20 点（上游报告的工程判断，本计划采纳为启发式）。
低于该密度的频段一律归入 `belowObservability`，
并禁止分解器在该频段生成技法候选。

新增错误码（补充 A §11.4 的 8 项）：

- `FINE_FLUCTUATION_BELOW_OBSERVABILITY`——**不是错误，是成功的显式声明**，
  与 `NO_TECHNIQUE_CANDIDATE` 同族。

### 6.2 其余沿用

A 方案 §11.2 "首版不移植完整 AVA HMM，先用 score boundary + 一阶导数 +
最小时长/音分位移 + vibrato-filtered curve" 的判断正确，且与 B 方案
"先用现有 detrended-autocorrelation" 相容。仓库
`computed-pitch-compare.js` 已有 detrended-autocorrelation 颤音检测，
应先评估复用而非另写。**沿用 A 方案，附加"先读 `computed-pitch-compare.js`"。**

## 7. P6 真机验收的新增场景（补充 A §12.1）

A 方案的 12 个场景沿用。新增 3 个，均来自交叉验证发现。

| 编号 | 场景 | 回答什么 |
|---|---|---|
| 13 | **tempo ramp 区间内的颤音** | P0.5-A 若发现 ramp 偏差，此场景验证修正是否有效；若 SynthV 不支持 ramp，记录"不适用"而非跳过 |
| 14 | **commit 前用户在 UI 改插值方法** | `INTERPOLATION_METHOD_DRIFTED` 是否真的触发且零写入（X3） |
| 15 | **同一音符同时有 `pitchDelta` 与 `PitchControlCurve`，读回 computed pitch** | 回答官方文档未定义的问题：Curve 的 "override" 是否也 override `pitchDelta`（§3.3） |

场景 15 是**能力边界问题，不是回归测试**。它的答案决定：

- 若 Curve 完全 override `pitchDelta`：跨面共存只是浪费，review 提示可以降级为 warning。
- 若两者叠加：跨面共存是真实的双重修正风险，`PITCH_SURFACE_INTERACTION_REQUIRES_REVIEW`
  必须保持为硬拒绝。
- 若行为依赖区间重叠关系：需要更细的规则，且 IR 必须能表达它。

在此场景完成前，**编译器禁止提供任何跨面自动处置**。

### 7.1 记录指标（补充 A §12.2）

A 方案的 11 项指标沿用。新增：

- **单轮 processing 收敛时间的分布**（p50 / p95 / max）——这是 P7 外层预算的推导输入（X7）。
- **秒/BLICK 往返偏差**已在 A 方案清单内，但须按 tempo mark 边界 / 区间内部分别报告。

## 8. P7 闭环校准的修正项

### 8.1 外层预算改为实测推导（修正 A §13.3）

A 方案给出"p95 在 60 秒外层上限内留至少 10 秒安全余量"。核验传输层约束：

- 单次宿主调用超时 **10 s**（`transport-pipe.js:29`）
- **一次只能有一个 in-flight command**
- 桥空闲轮询 `IDLE_MS = 20`（`StartSynthVCopilotPipe.lua:6`）
- 严格 lockstep，Relay 必须对每帧立即回包

3 轮候选写入 × (写入 + processing 等待 + computed-pitch 读回) 在 60 s 内
**紧张但可能**——前提是每轮 processing 收敛远小于 10 s，
而这正是 P6 场景才能测到的量。60 s 是一个没有测量支撑的数字。

**修正**：外层预算 = `3 × (P6 实测单轮 processing p95 + 写入 p95 + 读回 p95) × 1.5`，
向上取整到 5 s 的倍数。若推导值超过 90 s，**降低轮数**而不是提高预算。

### 8.2 独占时长必须显式声明

持锁期间 MCP 客户端的其他调用在 ExecutionCoordinator 队列里排队（上限 64），
同时 SynthV UI 线程在 20 ms 轮询里空转数千次。这不是崩溃级问题，
但"一次调用锁死整个 MCP 面 N 秒"是产品行为，不是实现细节。

**要求**：`calibrate_pitch_techniques` 的 operation 描述必须声明
最长独占时长与期间其他调用的行为（排队，非拒绝）。
doctor 报告应能显示当前是否有校准在进行。

### 8.3 其余沿用

A 方案 §13.1 的状态机（`captured → candidate_applied → observing →
accepted | restoring→restored | uncertain`）、最大 3 次候选写入、
§13.2 的低风险优化策略、§13.3 的其余门禁（故障注入、恢复读回 100%、
median objective 改善 ≥ 30%、任一 case 不得恶化 > 10 cents 而仍报 accepted、
一请求一 Undo）全部沿用。

**同时采纳 B 方案对本阶段价值的质疑作为止损依据**：若 P6 实测显示单轮
processing 收敛慢到 3 轮无法在合理预算内完成，或 median 改善不足 30%，
则不注册该 operation，保留"一次前向生成 + 一次客观测量 + 人类判断"的
P5 只读流程。这不影响 P3/P5/P6 的可发布性。

## 9. P8 的范围削减

### 9.1 删除 blinded A/B 服务（修正 A §14.2）

A 方案 §14.2 规定"使用现有 `sv_audition_compare`，采用 blinded、随机顺序的 A/B"。

核验 `sv_audition_compare` 实际契约：它 A/B 的是"两个**已存在**版本在同一区间上的
**不同 track solo 配置**"，variant schema 只接受 `soloTrackIndices`,
且描述明确 "This tool **NEVER** applies a temporary musical edit for variant B"
（理由：官方无 Undo 调用，成功提交后没有通用恢复 token，
un-undoable 的 audition-only write 是不诚实的）。

要 A/B "TechniqueIR 版本 vs 基线"，必须先把两个版本各自**永久提交到两条不同轨道**。
而克隆轨又撞上 `NoteGroupReference.setTarget` 一次性约束
（"once set, the target can't be changed"）与 Singer 身份不透明
（主计划已列"克隆且保留隐藏 Singer：无法保证"）。

所以 A 方案 §14.2 不是"复用现有工具"，而是"需要一条尚不存在、
且被能力边界阻塞的双轨制备流程"。B 方案把它判为应移除，**更准确**。

**修正后的 P8 人工评价**：

- 删除自动化 A/B 服务。
- 改为交付一份**人工对比操作指南**：人在自己的工程里 commit → 试听 →
  Ctrl+Z → 试听，记录偏好。
- 客观指标（`sv_compare_computed_pitch`）与人工偏好**分栏记录**，
  互不代替——这一条是 A 方案 §12.3 已有的正确要求，继续沿用。
- 所有听感结论保持 `human_only`。

### 9.2 开源溯源收紧（修正 A §8）

A 方案的 7 个 pin 本轮全部验证可解析、许可证匹配、引用文件存在。
但其中三个仓库仍活跃（SVScripts 2026-07-28、VibratoScope 2026-07-21、
LibreSVIP **2026-08-02 当日**推送）。

pin 到写作时 HEAD 与不 pin 的实际区别，取决于是否在该 SHA 真的抓取并存档了
LICENSE/NOTICE。**要求**：改为"审阅并存档时的 SHA"，
并在 `THIRD_PARTY_NOTICES.md` 记录抓取日期。
仓库既有的 clean-room 政策（对 Hrauroras/SV2-Script 已执行一次）继续适用：
未复制表达性代码时无需分发许可证文本，但必须记录来源。

Saitou 论文按 A 方案 §8 末段处置：独立实现数学方法，不复制论文文本、
图表或参数表编排（JAIST 保存稿为 CC BY-NC-ND 4.0）。

### 9.3 其余沿用

A 方案 §14.1 自动评估清单、§14.3 发布证据清单沿用。
§14.3 应新增一项：**P0.5-A 的换算一致性报告**，
因为它是所有 Hz 类保证的证据基础。

## 10. 修正后的提交序列（修正 A §17）

A 方案 13 项 → 本计划 14 项（新增 2、删除 1）。每项独立提交、提交前全绿。

| # | 提交 | 相对 A 方案 |
|---|---|---|
| 1 | `Add synthetic technique-model corpus and invariants` | 沿用 |
| 2 | **`Report Node-vs-host time-axis conversion parity`** | **新增**（P0.5-A，只读工具 + 报告） |
| 3 | **`Freeze host-vibrato surface policy in TechniqueIR`** | **新增**（P0.5-B，纯契约） |
| 4 | `Introduce versioned TechniqueIR normalization` | 沿用，含 #3 的字段 |
| 5 | `Implement stable second-order transient model` | 沿用 |
| 6 | `Implement identifiable Richards transition model` | 沿用 |
| 7 | `Implement time-varying vibrato model` | 沿用 |
| 8 | `Compose and constrain technique curves deterministically` | 沿用，冲突检测含 `vibratoEnv` |
| 9 | `Compile TechniqueIR to existing SV2 pitch surfaces` | 沿用，含插值方法封存 |
| 10 | `Expose plan_pitch_techniques through the plan facade` | 沿用，删 `execution` 字段 |
| 11 | `Add a Node nonlinear-fit backend behind a replaceable adapter` | **改**（原"Benchmark replaceable backends"，降级为单后端 + 契约） |
| 12 | `Add read-only pitch-technique decomposition` | 沿用，residual 分两类 |
| 13 | `Validate compilation fidelity on the live host` | 沿用，+3 个新场景 |
| 14 | `Add bounded calibration only if safety gates pass` | 沿用，预算实测推导 |
| — | ~~`Publish evaluation and dependency provenance`~~ | **合并进 14**，A/B 服务已删 |

沿用 A 方案的两条纪律：不允许把 schema 改动、handler 改动和 guide/test 迁移
拆成不同提交；不允许用兼容 alias 暂时保留旧错误契约。

## 11. 修正后的 Definition of Done

### 11.1 前置完成（P0.5）

- 秒↔BLICK 换算一致性报告存在，最大相对偏差有记录值；
  若偏差 ≥ 0.1%，修正已落地并重测通过。
- TechniqueIR 含 `hostVibrato` 策略字段，三种 policy 的 operation 集合有测试区分，
  `assume_absent` 必发 warning。
- 上述两项完成前，任何 Hz 类门禁与 IR v1 冻结均不得声明达成。

### 11.2 MVP 完成（P3，沿用 A §18.1 + 修正）

- TechniqueIR v1（含 `hostVibrato`）、三个前向模型、组合器（含跨面冲突检测）、
  双写面编译器（含插值方法封存）完成；
- `plan_pitch_techniques` 可从现有 7-facade surface 发现和调用，
  无新增 direct public tool；
- 返回 PlanRef-only apply envelope，请求**不含** `execution` 字段；
- dry-run 零 setter、零 Undo；commit 最多一个用户 Undo，读回验证通过；
- 响应在 16 KiB 内，超出时二级降级到 `detailRef`；
- synthetic、schema、Artifact、PlanRef、IO budget 测试全绿；
- 明确标注 `human_only`。

### 11.3 分析预览完成（P5，沿用 A §18.2 + 修正）

- Node 拟合后端通过全部功能与性能门禁，或已记录不达标项并启动第二候选；
- computed pitch 可输出可解释技法与**两类** residual；
- all-null / 低采样 / 不可识别 / 低于可观测性四种情况互不混淆；
- solver / model 版本与 evidence 可复现。

### 11.4 RC 完成（P6，沿用 A §18.3 + 修正）

- 15 个真机场景通过（含 tempo ramp、插值漂移、跨面共存三项新增）；
- 场景 15 已回答"Curve 是否 override `pitchDelta`"，
  且编译器的跨面处置策略据此定稿；
- 单轮 processing 收敛时间分布已测，P7 外层预算已推导；
- 编译误差、Undo、事务、性能和清理证据完整；
- 无发布阻塞级 host defect。

### 11.5 正式完成

- P8 自动评估完成；人工评价以**操作指南 + 分栏记录**形式交付，
  不含自动化 A/B 服务；
- 许可证 / NOTICE ledger 含审阅存档 SHA 与抓取日期；
- 发布证据含 P0.5-A 换算一致性报告；
- 若 P7 未通过门禁，正式范围明确不含自动闭环，不影响 P3/P5/P6 发布；
- 文档不得宣称音频渲染、通用歌手校准或自动听感优化。

## 12. 立即下一步

不安装任何新语言运行时。按序：

1. **P0**（沿用 A §6）：synthetic corpus + 不变量测试 + 真机 fixture 清单。
2. **P0.5-A**：写只读换算比对工具，在真机上跑一次，出报告。
   这是唯一需要人驱动 SynthV 的前置项，且只读、零风险。
3. **P0.5-B**：冻结 `hostVibrato` 契约。纯离线，可与 P0.5-A 并行。
4. 读 `bake-computed-pitch.js` 的 RDP 与 `computed-pitch-compare.js` 的
   颤音检测，确定复用边界，再动 P1。
5. P1/P2 离线门禁通过后接 planner；直到 P4 才决定拟合后端是否需要第二候选。

这条顺序保证：即使拟合与闭环研究最终失败，项目仍会得到一个可发布、
可解释、事务安全的前向技法规划能力——这一点与 A 方案 §19 的判断一致，
本计划只是把两项悬空的前置补上。

## 13. 未解决问题清单

以下问题本轮无法回答，需真机或后续决策。逐条记录以免被遗忘。

| 编号 | 问题 | 何时可答 |
|---|---|---|
| Q1 | SynthV 是否支持 tempo ramp？Node 侧阶跃假设是否产生系统性偏差？ | P0.5-A |
| Q2 | `PitchControlCurve` 的 "override" 是否也 override `pitchDelta`？ | P6 场景 15 |
| Q3 | 宿主生成的 computed pitch 是否包含 fine fluctuation 分量？ | P6，需高密度采样 |
| Q4 | 单轮 processing 收敛的 p95 是多少？3 轮闭环在合理预算内可行吗？ | P6 |
| Q5 | 宿主自然颤音被 `vibratoEnv = 0` 压平后，是否真的完全消失（而非仅缩放）？ | P6，需 `hostVibrato: suppress` 场景 |
| Q6 | 非等距 `PitchControlCurve` 控制点的宿主内部插值是什么？ | P6，`getValueAt` 密集采样可测 |
| Q7 | Node 拟合后端能否满足 clean recovery 95% 与 p95 100 ms？ | P4 |
