# 可解释音高技法系统最终执行计划

## 0. 文档信息

- 定稿日期：2026-08-03（**v2.8**，在 v2.7 上闭合 transition 坐标映射、量化后二次校验与 MCP 错误证据）

**v2 修订摘要**（相对 v1）：

| # | 修订 | 位置 |
|---|---|---|
| 1 | 内部 IR 增加 `referenceFrame`；两个写面不共用坐标；P2 MVP 只交付 `pitchDelta` | F5a、§9 |
| 2 | `overlapPolicy` 改 `explicit_priority_then_canonical_key` | F5b、§9.6 |
| 3 | 二阶模型统一用 `naturalAngularFrequencyRadPerSecond`，消除 `2π` 缺口 | F2、F2b、§8.2 |
| 4 | 增加 `requiredInclude` 与 `CAPTURE_EVIDENCE_REQUIRED` | F5c、§9.2 |
| 5 | 过阻尼首峰改为**产品范围选择**，非数学不可行 | F2 |
| 6 | 开环求解器 `μ` 硬下限 + 秩前置条件 | §10.1a |
| 7 | H1 失败的生产方案改为批量 opcode | §7.1a |

**v2.1 修订摘要**（相对 v2）：

| # | 修订 | 位置 |
|---|---|---|
| 8 | canonical key **移除 `id`**，改为语义内容稳定哈希；`tech_N` 排序后分配 | F5b |
| 9 | `D₂` 按 finite run **分块求解**，不跨 null gap | §10.1b |
| 10 | 补齐 `plan_pitch_correction` 完整请求/响应契约与字段语义 | §10.1c |
| 11 | **planner 语义所有权裁定**：技法归 `plan_pitch_gesture`，`plan_expression` 退出音高 | §9.0 |
| 12 | `interpolationEvidence` 改为逐参数实测数据；`automationParameters` 须含 `vibratoEnv` | F5c、§9.2 |
| 13 | 2π 失败案例方向修正（÷2π = `0.0054306 s`；×2π = `0.2143933 s`） | F2b、§8.2 |
| 14 | 新增 F9 数值边界表；`onsetSeconds` 明确为 note-relative；P6 场景拆 MVP/P2b | F9、§13.1、§13.3 |

**v2.2 修订摘要**（相对 v2.1）：

| # | 修订 | 位置 |
|---|---|---|
| 15 | 秒域换算同时缩放 `Ω` 与分子参数 `K`，否则振幅缩小 1000 倍；分子改名 `numeratorRatePerSecond` | F2、F2b、§8.2 |
| 16 | P2 固定为 additive contribution；封存基线 fingerprint，预合成 final curve 后用 replace 写入 | F5、§9.2–§9.4 |
| 17 | 公开 gesture 契约收敛为 transition/transient/vibrato 三分支；移除无意义 surface/referenceFrame 请求字段 | F9、§9.2 |
| 18 | P3 统一到 absolute-cent 参考系，使用已提交的 `sourcePlanRef` 恢复基线与目标 | §10.1–§10.1c |
| 19 | H3 拆为“共存关系”与“坐标变换”两个独立门禁；前者不再误解锁 P2b | §7.2、P2b |
| 20 | canonical IR 自身先量化再哈希；量化碰撞结构化拒绝 | F5b |
| 21 | P7 增加候选耗尽终态并关闭 Undo 边界 | §14.2–§14.3 |

**v2.3 修订摘要**（相对 v2.2）：

| # | 修订 | 位置 |
|---|---|---|
| 22 | 明确“保持论文时域响应”的 `K×1000` 与秒域单位面积 Dirac 传递函数换算不是同一语义 | F2b |
| 23 | 二阶临界邻域改用 `sinc`/`expm1` 等价稳定式；`onsetSeconds` 纳入可执行 oracle | F2、§8.2 |
| 24 | 直接 Hermite 截尾改为不放大原响应的乘法 C1 smoothstep，并增加全阻尼扫参 | F3 |
| 25 | transient 默认阻尼按 overshoot/preparation 分支声明；P3 删除冗余 anchor 开关 | F9、§9.2、§10.1c |
| 26 | P3 明确 `W` 的数值含义，避免把对角权重重复平方 | §10.1 |

**v2.4 修订摘要**（相对 v2.3）：

| # | 修订 | 位置 |
|---|---|---|
| 27 | canonical 数值量化改为精确字段注册表；未知字段默认 `UNQUANTIZED_SEMANTIC_FIELD`，禁止子串猜测与原值放行 | F5b |
| 28 | `ζ=0` 与 `tailPolicy:"reject"` 改为 schema 级互斥，不再依赖运行到尾部检查后才失败 | F3、F9、§9.2 |
| 29 | 公开 versioned taper ratio `0.25`，但不增加 LLM 请求字段 | F3、F9 |

**v2.5 修订摘要**（相对 v2.4）：

| # | 修订 | 位置 |
|---|---|---|
| 30 | identity、ordinal、count 与 BLICK 字段改为 `safe_integer` domain，禁止用 quantum=1 静默取整 | F5b、§8.2 |
| 31 | 显式颤音的 fade 改为严格正数；默认值仍为 `0.3 s / 0.2 s`，确保任意相位下 span 两端连续 | F3b、F9、§9.2 |
| 32 | AVA 拐点改用 log-difference；过阻尼闭式改用缩放根式与稳定速率，覆盖全部有限非负阻尼输入 | F1、F2、§8.2 |
| 33 | `TECHNIQUE_IR_NUMERIC_FIELD_SCHEMA` 成为数值字段单一数据源；碰撞错误公开 input/output/quantum 证据 | F5b、§16.1 |

**v2.6 修订摘要**（相对 v2.5）：

| # | 修订 | 位置 |
|---|---|---|
| 34 | correction oracle 与公开契约统一使用 `magnitudeMu`，未知旧字段立即拒绝 | §10.1a、§10.1c |
| 35 | canonical TechniqueIR anchor 统一为 `fromNote` / `toNote`，并以文档实例做契约测试 | F5、F5b |
| 36 | 数值字段 schema 分离 Hz、rad/s、普通每秒速率与响应单位/秒 | F2b、F5b |
| 37 | 二阶闭式以慢极点和对数缩放消除有限输入下的中间溢出；无法表示的无阻尼相位结构化拒绝 | F2、§8.2 |
| 38 | 公开 schema 的 `$ref` 数值叶子纳入注册表覆盖审计 | F5b、§16.1 |
| 39 | 删除未被当前契约消费的无单位数值别名，闭合注册表只保留真实语义字段 | F5b、§8.3 |
| 40 | reference oracle 删除自写 canonical JSON/hash，直接复用仓库 `contentHash` 单一实现 | F5b、§16.1 |
| 41 | 补齐 1200 组 Richards 属性测试、10,000 点 p95 门禁与三技法全排列 canonical 回归 | §8.2、§8.3、F5b |
| 42 | `ζ>1` 的公开首峰拒绝补齐 v1 产品范围结构化错误，不暗示内部数学模型不可计算 | F2、§8.2 |
| 43 | 权威数值表覆盖完整文档 TechniqueIR，包括 `schemaVersion` 与 `maxAbsCents` | F5、F5b、§16.1 |

**v2.7 修订摘要**（相对 v2.6）：

| # | 修订 | 位置 |
|---|---|---|
| 44 | AVA 最终插值改用稳定凸组合；时变颤音对 span/fade/phase/output 极值给出有限结果或结构化拒绝 | F1、F3b、§8.2 |
| 45 | correction 将派生非有限 cent 视为无效证据，校验 `minimumRunFrames`，正规方程溢出返回 `CORRECTION_NUMERIC_OVERFLOW` | §10.1、§10.1a |
| 46 | 所有严格正数 schema 下限不低于 canonical quantum；公开 ordinal 声明安全整数上界 | F5b、F9、§9.2、§10.1c |
| 47 | 禁止在 `oneOf` 上用写入式默认值验证；改为纯验证、discriminator 选支、分支默认物化、二次验证 | F9、§9.2、§16.1 |
| 48 | 补齐上/下行 Richards 输出、对称性、固定频率颤音过零点与零输入恒等式回归 | §8.2、§16.1 |
| 49 | F3 在 reject 阈值旁公开 `TAIL_NOT_SETTLED`，使调用方可区分尾部未收敛与 taper 覆盖首峰 | F3、§16.1 |

**v2.8 修订摘要**（相对 v2.7）：

| # | 修订 | 位置 |
|---|---|---|
| 50 | 固定 transition 的邻接、对称 span、score-step→`pitchDelta` 公式、短音符与大音程拒绝策略 | F1b、F9、§9.3 |
| 51 | canonical 数值量化后重新验证所选 IR 分支及跨字段关系；相位范围与 `1e-12` lattice 对齐 | F5b、F9、§16.1 |
| 52 | canonical 错误证据统一进入 `error.details`，并以真实 MCP encoder 验证最终机器信封 | F5b、§16.6 |

- 实施基线：`0c91ebf`（SV Copilot `0.9.0`，41 routed operations / 8 公开工具名）
- 可行性依据：[feasibility.md](feasibility.md)（v2.8）
- 文档性质：**终版**。取代四份候选计划的执行顺序与契约，不修改任何候选文档
- 实施风格：纵向闭环、严格 schema、成对迁移、无兼容层

计划编号约定：`H*` = 宿主未知量（见可行性报告 §4），`F*` = 终版契约裁定。

## 1. 目标与首个里程碑

在现有 SVCopilot 上补齐可解释音高技法的**研究模型层**、**宿主组合语义证据**和**拟合层**，
使 LLM 能用音乐参数表达非对称滑音、overshoot/preparation、颤音，
确定性编译到 SV2 的音高写面（**MVP 为 `pitchDelta`**，
`PitchControlCurve` 待 H3a/H3b/H4 证据后作为第二增量），
并在宿主实际插值与 computed pitch 上验证。

首个可发布里程碑不是"自动调音"，而是：

```text
snapshot → semantic pitch plan → review/dry-run → one verified commit
        → wait/compare → optional one-step correction plan
```

## 2. 已冻结的架构决策

### 2.1 唯一写入权威

现有 Node MCP 服务继续独占：MCP schema 与 facade routing、Context/occurrence/note identity、
canonical TechniqueIR、PlanRef/Artifact/ledger、ExecutionCoordinator、
host handle/setter/Undo 边界/journal/verify/rollback。

任何外部计算 worker **不得**：启动第二个 MCP、连接 PIPE/Lua bridge、持有 host handle、
直接写项目、生成最终可提交 plan hash。

### 2.2 实现语言不预设

| 子系统 | 初始策略 | 依据 |
|---|---|---|
| TechniqueIR / 前向模型 / 编译器 | Node | 与现有 planner/transaction 紧耦合；闭式计算规模小 |
| 五对角开环求解器 | Node | O(n) 带状 Cholesky 可独立验证，无需进程边界 |
| 有界鲁棒非线性拟合 | **P4 benchmark 决定** | 算法质量、性能、部署、许可都需证据 |
| 宿主写入与回滚 | 仅 Node | 单一事务权威 |

clean-room 政策记录的是"当前发布未复制第三方代码"，**不构成对未来运行时的永久禁令**
（可行性报告 §2.5）。语言由门禁选出，不由政策口号决定。

### 2.3 公开 surface：扩展而非新建

不新增近义 planner。TechniqueIR 是**内部** canonical 结构，不是需要 LLM 手写的公开大对象。

| Facade | Operation | 状态 |
|---|---|---|
| `sv_plan` | `plan_pitch_gesture` | **扩展**（新 shape/transient family） |
| `sv_plan` | `plan_pitch_correction` | 新增（P3，单步开环） |
| `sv_read` | `compare_computed_pitch` | 复用 + 等秒网格迁移 |
| `sv_read` | `analyze_pitch_techniques` | 条件新增（P5，取决于 P4 选型） |
| `sv_edit` | `patch_parameter_curves` / `patch_pitch_controls` | 复用（执行 PlanRef） |
| `sv_edit` | `calibrate_pitch` | 条件新增（P7，门禁失败则不注册） |
| `sv_artifact` | 复用 | IR / dense samples / fit evidence |

新增 operation 时必须同批在 `operation-catalog.js` 的 `FACADE_BY_TOOL` 登记
（未登记则 server 启动即抛错），且工具名须满足 `sv_` 前缀派生规则。

### 2.4 成对迁移，无兼容包袱

schema 变更时同一批提交：schema → normalize/handler → planner output/apply envelope
→ operation description → workflow guide/resource → unit/contract/MCP smoke tests。
同一语义只保留一个 canonical 字段；不留 deprecated alias、双响应形状或隐式 fallback。

## 3. 明确非目标

不接受任意录音做通用 F0 tracking；不自动判断"听起来更好"；不伪造程序化渲染；
不提供成功提交后的通用 restore token；不依赖 `project_revision`；
不自动混用两个 pitch surface；宿主语义未确认时不同时使用原生颤音与显式正弦；
不复制 AVA/VibratoScope/Saitou 的表达性代码；
不为研究原型牺牲现有 Artifact/token/事务/错误诚实性契约；
不建自动化 blinded A/B 服务（可行性报告 §2.7）。

## 4. 终版核心契约

### 4.1 F1 — 有限区间 Richards（**取代 Opus A1**）

提供两个**不同命名**的函数，禁止共用一个名字：

```text
rawRichards(t, inflectionSeconds, steepnessPerSecond, B)     // 渐近，分析/拟合用
richardsSegment(t, fromSeconds, toSeconds, …)                // 归一，编译用
```

AVA 论文原式必须原样实现为：

```text
P(t) = L + (U-L) / (1 + A·exp(-G(t-M)))^(1/B)
t_R  = M - ln(B/A)/G
```

内部以 `t_R` 替代不可辨识的 `A/M` 时，只做代数重参数化：由
`A·exp(-G(t_R-M))=B` 得
`q(t)=(1+B·exp(-G(t-t_R)))^(-1/B)`。这仍是 AVA 原式的同一函数族。
下面的 finite-segment 仿射归一化才是**本项目工程派生**，不得写成 AVA 论文结论。

编译形式：

```text
q  = rawRichards(t)
q0 = rawRichards(fromSeconds)
q1 = rawRichards(toSeconds)
u  = (q − q0) / (q1 − q0)
y  = y0 + (y1 − y0) · u
```

约束：

- `B = exp(asymmetryLogB)`（保证正）；`steepnessPerSecond = sharpness / durationSeconds`；
- `|q1 − q0|` 低于阈值时以 `RICHARDS_DEGENERATE_SEGMENT` **结构化拒绝**（退化区间）；
- 上行/下行均**严格**命中端点（`u(from)=0`、`u(to)=1`，非容差内）；
- `u` 在数值容差内保持 `[0,1]`；
- 用 `logaddexp` 稳定分支，极端参数不得 NaN/Inf；
- 最终 `y0→y1` 用凸组合实现，禁止先算 `y1-y0` 后在异号极值端点溢出；
- raw 拐点或最终插值超出 double 可表示范围时分别返回
  `RICHARDS_INFLECTION_OVERFLOW` / `INTERPOLATION_OVERFLOW`；
- model family 名分别为 `richards_asymptotic` 与 `richards_segment_normalized`。

**为何不能用原 A1 公式**：`B=1, sharpness=6, ratio=0.5` 时 `r(0)=0.0474`、`r(T)=0.9526`，
与"端点严格命中"退出条件自相矛盾。提高 sharpness 只能压小误差且会使曲线退化为阶跃。

### 4.1b F1b — transition 到 `pitchDelta` 的唯一坐标映射

AVA/Richards 只定义连续绝对音高轨迹；下面是本项目把该轨迹编译到 SV2
`pitchDelta` Automation 的**工程映射**，不得归因于论文。

设相邻音符的目标音高为 `L`、`U`（semitone），后音 onset 为边界 `b`，
请求总宽度为 `T=width.seconds`。transition 的秒域 span 固定为以边界为中心：

```text
a = b - T/2
z = b + T/2
u(t) = linear(t-a, T) 或 normalizedRichardsSegment(t-a, T, curve)
P(t) = (1-u(t))L + u(t)U
S(t) = L, t < b
       U, t >= b
C(t) = 100·(P(t)-S(t))             // pitchDelta contribution, cents
```

`P(t)` 是连续的期望绝对音高，`S(t)` 是乐谱自身在边界处发生的阶跃，`C(t)` 才是
写入 `pitchDelta` 的贡献。于是端点严格为零，且边界两侧满足：

```text
C(b+) - C(b-) = -100·(U-L)
L + C(b-)/100 = U + C(b+)/100 = P(b)
```

这条跳变不是缺陷，而是抵消乐谱音高阶跃、保持感知绝对音高连续的必要条件。
禁止把连续的 `P(t)` 直接当成 `pitchDelta`，也禁止对 `C(t)` 做幅度 clamp；后者会
破坏上述等式并制造边界音高跳变。

前置与失败策略固定如下：

1. `to = from+1`，并以整数 BLICK 严格验证 `to.onset = from.onset+from.duration`；
   gap、overlap 或跳过中间音符均返回 `TRANSITION_NOT_ADJACENT`。
   同一 BLICK 边界经 H1 映射得到的前音 end/后音 onset 秒值差不得超过 `1e-9 s`；
   超出时返回 `TRANSITION_TIME_MAPPING_INCONSISTENT`，不能把时间轴缺陷误报为 rest。
2. `L=U` 是数学空操作：底层 oracle 以内部 `TRANSITION_EQUAL_PITCH` 信号停止编译，
   公开 planner 必须捕获并省略该 technique；若全部 technique 均被省略，返回
   `status:"no_change"`、`apply:null`、零 Artifact/Undo，不得把内部信号投影成 MCP 失败。
3. `a` 必须不早于前音 onset，`z` 必须不晚于后音 end。短音符不缩短、不偏移 span，
   返回 `TRANSITION_WIDTH_EXCEEDS_ADJACENT_NOTES` 并报告两侧可用秒数。
4. 秒→BLICK 后，必须分别保留 `a`、边界前极限、边界点、`z` 四类 mandatory anchor；
   边界前极限映射为严格小于边界的最大可表示整数 BLICK，边界点映射为后音 onset。
   设整数边界为 `B`，必须满足 `aBlick≤B-2` 且 `zBlick≥B+1`，使 start 与
   boundary-before、boundary-at 与 end 各自可区分；否则返回
   `TRANSITION_TIME_RESOLUTION_TOO_COARSE`。不得把两个边界极限合并成一个控制点。
5. `max(|C(b-)|,|C(b+)|)` 超出 `pitchDelta` 参数定义 `[-1200,1200] cent` 时返回
   `TRANSITION_EXCEEDS_PITCH_DELTA_RANGE`；大音程不得静默 clamp。与 captured baseline
   预合成后若最终值越界，使用同一错误族并在 details 区分 `contribution` / `final` 阶段。
6. Richards 与 linear 都执行同一坐标映射；curve family 只决定 `u(t)`，不能各自发明
   邻接、span 或边界语义。

可运行 oracle 为 `compilePitchDeltaTransition()` 与
`projectTransitionMandatoryBlickAnchors()`；测试覆盖上/下行、linear/Richards、
gap、时间映射偏差、等音高、短音符、大音程、BLICK 分辨率和边界阶跃抵消。
oracle 的 BLICK 投影消费的是
H1 映射结果，不自行猜测秒↔BLICK；实际换算仍受 H1 门禁约束。

### 4.2 F2 — 二阶瞬态拆分（**取代 Opus A2**）

内部通用模型（**单位：角频率，不是 Hz**，见 F2b）：

```ts
secondOrderImpulse({
  timeSeconds, onsetSeconds,
  naturalAngularFrequencyRadPerSecond,   // 论文 Ω × 1000
  dampingRatio,
  numeratorRatePerSecond                 // 论文 K × 1000
})
```

覆盖论文 Eq.(2) 在本项目非负阻尼域的四个 case：`ζ>1` 过阻尼（两衰减指数之差，避免 sinh 溢出）；
`0<ζ<1` 欠阻尼正弦；`ζ=1` 精确临界闭式；`ζ=0` 无损振荡
（论文用于 vibrato；实现上是欠阻尼的边界特例，但须保证 `ζ=0` 不触发 `0/0`）。

公开音乐参数化：

```ts
transientFromFirstPeak({
  peakSemitone, peakTimeSeconds,
  dampingRatio,   // v1 范围：0 ≤ ζ ≤ 1（范围选择，非数学限制）
  onsetSeconds, spanSeconds,
  tailPolicy      // "reject" | "continuous_taper"
})
```

峰位闭式按区间选择，三段在 `ζ=1` 处连续衔接：

```
ω_n·t_peak = arccos(ζ) / √(1−ζ²)     0 ≤ ζ < 1
           = 1                        ζ = 1        （精确：τ = 1/ω）
           = acosh(ζ) / √(ζ²−1)       ζ > 1
```

数值验证（本轮复算）：`ζ=0.999 → 1.000333`、`ζ=1 → 1`、`ζ=1.0001 → 0.999967`。
过阻尼冲激**非振荡但单峰**，`(peak, t_peak, ζ)` 数学上可覆盖 `ζ>1`。

**v1 限定 `0 ≤ ζ ≤ 1` 是产品范围选择**：overshoot/preparation 是振荡回弹技法，
过阻尼首峰虽可算但无回弹、音乐意义弱。`ζ>1` 返回结构化拒绝，
错误码为 `DAMPING_RATIO_OUT_OF_V1_RANGE`，消息须写明"v1 范围外"，
**不得暗示无法计算**。
后续需要时扩展同一 family 的 `ζ>1` 分支，无需新建 family。

实现上 `ζ=1` 走精确临界闭式；邻近两侧分别用 `sinc` 与 `expm1` 的代数等价式，
避免近等量相减及 `arccos(1)/√0 = 0/0`。不得用过宽 epsilon 把真实的
欠阻尼/过阻尼输入静默改成临界模型。
有限输入的中间乘积不得泄漏 `NaN`：有阻尼且指数已确定下溢时返回数学极限 0；
无阻尼振荡若 `ωt` 超出可表示相位范围，返回 `OSCILLATORY_PHASE_OVERFLOW`，
不得把 `sin(Infinity)` 当作数值结果。

### 4.2b F2b — 角频率与分子参数的单位纪律（v2.2 修正）

论文 `H(s) = K/(s² + 2ζΩs + Ω²)` 中 `Ω` 是**角频率**，而论文给出的
时域冲激响应振幅含 `K/Ω`。本项目参数的定义是保持论文画出的时域响应：
`h_seconds(t) = h_milliseconds(1000t)`。在这个定义下，`Ω` 与时域响应分子参数
都必须**同时乘 1000**；只缩放 `Ω` 会把 `K/Ω`、因而整个响应振幅缩小 1000 倍。

这里必须区分 Dirac 冲激的单位：若把传递函数本身改写为“由秒域单位面积
`δ_seconds(t)` 驱动”，单纯代换拉普拉斯变量会给分子系数 `10^6·K`；但与论文
同一个物理激励对应的秒域冲激面积同时缩为 `1/1000`，最终时域响应仍只留下
`1000·K`。公开实现不暴露这种依赖冲激归一化的 `gain`，只暴露定义明确的
`numeratorRatePerSecond`，并以上面的时域恒等式作为换算 oracle。

论文的三个参数组在秒域应写成：

| 技法 | 论文 `(Ω, ζ, K)`（毫秒域） | 保持时域响应的秒域 `(ω, ζ, k_response)` |
|---|---|---|
| overshoot | `(0.0348, 0.5422, 0.0348)` | `(34.8, 0.5422, 34.8)` |
| preparation | `(0.0292, 0.6681, 0.0292)` | `(29.2, 0.6681, 29.2)` |
| vibrato | `(0.0345, 0, 0.0018)` | `(34.5, 0, 1.8)` |

这里 `ω` 的字段名是 `naturalAngularFrequencyRadPerSecond`，`k_response` 的字段名是
`numeratorRatePerSecond`。禁止使用无单位的 `gain`：它会掩盖分子参数也随时间单位变化。

独立幅度校验来自论文自身：无损分支的峰值是 `K/Ω`，故
`0.0018/0.0345 = 1.8/34.5 = 0.0521739`，与论文报告约 `5.2%` 一致。
若只把 `Ω` 变成 `34.5` 而仍传 `K=0.0018`，结果会错误地变成 `0.0052%`。

`34.8 / 5.539 = 2π`。把 `34.8` 传给名为 `naturalHz` 的字段会使所有峰值时间
偏 `2π ≈ 6.28` 倍（65 ms 的 overshoot 变成 10 ms 或 409 ms），
且若测试用同样错误的单位则不会暴露。

**裁定**：二阶模型一律用 `naturalAngularFrequencyRadPerSecond` 与
`numeratorRatePerSecond`，二者都承载 `论文值 × 1000`；**不引入 Hz 字段或无单位 gain**。
`H(s)` 与四个 case 的闭式都以角频率表述，引入 Hz 只是在每个调用点插入一次
`2π` 出错机会。

颤音的 `rateHz` **保持 Hz**：它是可感知的振动次数/秒，是自然参数域，
且 `pitch-gesture-plan.js` 与 `expression-plan.js` 已在用。两者字段名不同，
不会混淆。符合仓库既有的"单位进字段名"纪律。

必须有两个互相独立的回归：

1. 以 `naturalAngularFrequencyRadPerSecond = 34.8`、`ζ = 0.5422` 生成的响应，
   其首峰时间应为

```
t_peak = arccos(0.5422) / (34.8 · √(1 − 0.5422²)) = 0.0341217 s
```

两种误用各自的错误值（v2.1 修正：v2 把两者搞混了）：

| 误用 | 实际代入 `ω_n` | `t_peak` | 相对正确值 |
|---|---|---|---|
| 字段叫 `naturalHz`、传入 34.8、实现做 `ω=2πf` | `218.65 rad/s` | `0.0054306 s` | **÷ 2π** |
| 先把 34.8 换成 5.5386 Hz，又直接当 rad/s 用 | `5.5386 rad/s` | `0.2143933 s` | **× 2π** |

2. 以论文 vibrato 参数的秒域值 `ω=34.5, k=1.8, ζ=0` 生成的响应，
   周期必须是 `2π/34.5 = 0.1821213 s`，峰值必须是 `1.8/34.5 = 0.0521739`。

两个方向的 `2π` 误差和 `K` 漏乘 1000 的振幅误差都远超合理容差，回归必然抓到。
测试应同时钉住正确值与误用值，以防实现与测试复制同一个错误。

规范性可运行示例位于
`reference/model.mjs`，独立测试位于 `reference/model.test.mjs`。
论文原式函数与工程派生函数
使用不同名字，测试直接覆盖 AVA 原式、Saitou 四分支、ODE 残差、峰值/周期与单位换算。

### 4.3 F3 — span 与尾部策略（**取代 Opus "边界前 <1 cent"**）

- `span` 必须显式声明；
- 超出声明 span 的尾部默认视为**约束错误**；
- 调用方可选经验证的 `continuous_taper`（值与一阶差分连续性均须达标）；
- 跨音符边界必须由 anchor/span 明确表达，不靠硬截断；
- epsilon 按目标 surface 的编译误差预算设定，**不硬编码 1 cent**。

`continuous_taper` 的唯一实现是 span 最后 25% 上的乘法 C1 smoothstep 窗：
它保留二阶原响应 `h(t)`，只用范围 `[0,1]` 的窗口衰减到零：

```text
s = (t-taperStart)/taperDuration
w(s) = 1-3s²+2s³
y(t) = h(t)·w(s)
```

因为 `w(0)=1,w'(0)=0,w(1)=0,w'(1)=0`，这保证起点与原响应 C1 连续、
终点值和斜率均为零；又因 `0≤w≤1`，不会像“从起点值/斜率直接 Hermite 到零”
那样在合法的 `ζ=0` 输入上制造大于请求首峰的新峰。25% 是内部 model-version
常量，不增加公开 JSON 字段。
若 `peakTimeSeconds > 0.75·spanSeconds`，taper 会改动请求首峰，必须返回
`TAPER_OVERLAPS_PEAK` 并要求扩大 span，不能先 taper 再谎报首峰已命中。
`reject` 则同时检查 span 终点的绝对值与斜率阈值。唯一推导式为
`maxTailSemitone=maxFitErrorCent/100`、
`maxTailSlopeSemitonePerSecond=maxTailSemitone/sampleIntervalSeconds`；
两者连同采样间隔写入 IR，不能另设隐藏常量，也不能只检查“非零”。
任一 reject 阈值不满足时返回 `TAIL_NOT_SETTLED`；调用方应扩大 span 或显式改用
`continuous_taper`。这与 `TAPER_OVERLAPS_PEAK` 不同：后者表示 taper 本身会覆盖
已请求的首峰位置，必须调整 peak/span 关系。

理由：overshoot/preparation/跨音符转换可以合法跨越音符边界。

### 4.3b F3b — 时变颤音是显式工程扩展

Saitou 的 no-loss 二阶分支证明固定振荡模型；论文没有定义 rate/depth drift 或 fade。
本项目的时变颤音使用以下独立、明确命名的工程模型，不把它归因于论文：

```text
τ = t-start,  T = end-start,  r = τ/T
f(τ) = f₀ + (f₁-f₀)r
φ(τ) = φ₀ + 2π·(f₀τ + 0.5·(f₁-f₀)τ²/T)
d(τ) = d₀ + (d₁-d₀)r
c(τ) = c₀ + (c₁-c₀)r
y(τ) = fadeIn(τ)·fadeOut(τ)·(c(τ) + d(τ)·sin(φ(τ)))
```

fade 使用 raised cosine `R(x)=0.5-0.5cos(πx)`（`x` clamp 到 `[0,1]`）。
`explicit_pitch_delta` 的 `fadeInSeconds` 与 `fadeOutSeconds` 都必须严格大于 0；
默认分别为 `0.3 s` 与 `0.2 s`。零 fade 会在非零初相位或非零 center 下制造边界跳变，
因此本版本不提供隐式 hard-edge 语义；若将来确有需要，必须新增显式 discriminator。
若 `fadeInSeconds+fadeOutSeconds>T`，两者按共同因子
`T/(fadeInSeconds+fadeOutSeconds)` 缩短，禁止依赖实现顺序。
实现以“小值/大值”的比率计算同一归一结果，不能先把两个有限大 fade 相加成
`Infinity`。有限端点相减得不到有限 span 时返回 `VIBRATO_SPAN_OVERFLOW`；
归一后较短 fade 低于浮点分辨率时返回 `VIBRATO_FADE_RESOLUTION_OVERFLOW`；
无法表示的积分相位返回 `OSCILLATORY_PHASE_OVERFLOW`，不得把 `sin(Infinity)`
或 `0·NaN` 作为输出；最终值仍超出范围时返回 `VIBRATO_OUTPUT_OVERFLOW`。
整个 center+sinusoid 共用 fade，确保 center drift 不在 span 边界跳变。
相位必须积分瞬时频率；`2π·f(t)·t` 在 rate drift 时是错误公式。

### 4.4 F4 — 等秒分析网格

原始 capsule 继续保存 `{startBlick, intervalBlick, values, tempoMarks}`。分析前生成：

```json
{
  "timeGrid": "uniform_seconds",
  "sampleRateHz": 100,
  "timeSeconds": [0.0, 0.01, 0.02],
  "values": [60.0, null, 60.1],
  "mask": [true, false, true],
  "resampling": {
    "method": "linear_within_finite_run",
    "maxGapSeconds": 0.03,
    "crossedTempoChange": true
  }
}
```

规则：每个原始 frame 先经 tempo map 映射为绝对秒；**只在连续 finite run 内插值**；
不跨 null gap / 无声段 / processing gap；Hz 域算法只接收 uniform-seconds 数据；
cents 中心统计可用原始 frame，但 provenance 必须区分。

**必须与 P0.5 的 H1 结果一起看**：若 Node 换算与宿主有偏差，重采样会把一个错误的
秒轴"精确地"均匀化，误差反而更难发现。因此 H1 是本项的前置。

现状缺口：`computed-pitch-compare.js:1026 frameRateAt()` 只在单个 BLICK 位置算标量
局部帧率，整条序列仍非均匀秒网格；`fs` 被当作整窗采样率用于自相关与 Hz 换算。

### 4.5 F5 — TechniqueIR v1（内部）

```json
{
  "schemaVersion": 1,
  "modelVersion": "pitch-techniques-v1",
  "scope": { "contextId": "ctx_…", "occurrence": 0, "expectedTargetGroupUuid": "…" },
  "timeDomain": "seconds",
  "referenceFrame": "pitch_delta_contribution_cents",
  "techniques": [
    {
      "id": "tech_0",
      "kind": "portamento",
      "anchors": { "fromNote": 4, "toNote": 5 },
      "priority": 0,
      "model": {
        "family": "richards_segment_normalized",
        "inflectionRatio": 0.58,
        "sharpness": 8,
        "asymmetryLogB": 0.3
      },
      "span": { "fromSeconds": 2.0, "toSeconds": 2.24 }
    }
  ],
  "composition": {
    "rule": "sum_then_clamp",
    "maxAbsCents": 200,
    "overlapPolicy": "explicit_priority_then_canonical_key"
  },
  "target": {
    "surface": "pitchDelta",
    "compositionMode": "baseline_plus_contribution",
    "mutationMode": "replace",
    "referenceFrame": "pitch_delta_contribution_cents",
    "requiredInclude": {
      "include": ["notes", "automation"],
      "automationParameters": ["pitchDelta"]
    },
    "baselineGuard": {
      "pitchDeltaFingerprint": "sha256:…"
    },
    "interpolationEvidence": {
      "pitchDelta": {
        "method": "cubic",
        "source": "host_getInterpolationMethod",
        "capturedAtContextId": "ctx_…",
        "resolvedParameter": "pitchDelta"
      }
    },
    "hostProfileHash": "sha256:…"
  }
}
```

不变量：occurrence 用 Context ordinal；note anchor 用 `indexInGroup` 数字；
不存长 `noteId`；不保存整组 fingerprints，只存实际 anchor/guard；
秒 span 唯一（不并存冲突 BLICK span）；每个 model family 独立版本；
技法数/span/采样点/幅度均有硬预算。

#### F5a — `referenceFrame` 必须显式，两个写面不共用一套坐标（v2 新增）

原 v1 用单一 `pitchUnit: "cents_relative_to_score"` 同时编译两个写面。
这是错的：两个写面的**语义与坐标系都不同**。

| | `pitchDelta` Automation | `PitchControlCurve` |
|---|---|---|
| 语义 | 相对生成音高的**偏差** | **覆盖**该区间的生成音高 |
| 单位 | cents | semitone |
| 坐标基准 | 生成曲线（隐式） | anchor（group-relative），点相对 anchor |
| 值域 | `[−1200, 1200]` | 无文档上限，受 anchor 约束 |

一条"相对 score 的 cents 曲线"要落到 `PitchControlCurve` 上，必须先加回
**绝对目标**与宿主 curve 坐标之间的变换。原 H3 只询问两写面能否共存，
无法回答这个变换；v2.2 将其拆成 H3a（共存/优先级）与 H3b（坐标变换）。
H3a 通过不代表 H3b 通过，因此不能假装存在一个通用变换。

**裁定**：

```
referenceFrame: "pitch_delta_contribution_cents"  → 仅可按 baseline+contribution 编译到 pitchDelta
                "absolute_group_pitch_semitone"    → 仅可编译到 pitchControlCurve
```

`referenceFrame` 与 `target.surface` 的组合是**封闭白名单**，
不匹配即 `REFERENCE_FRAME_SURFACE_MISMATCH` 结构化拒绝。
禁止在两个 frame 之间做隐式转换。

这里的 `referenceFrame`、`target.surface`、`compositionMode` 和 `mutationMode`
只存在于 sealed Plan Artifact 内部 IR，由服务端推导并校验；它们**不是公开 planner
请求字段**。公开 schema 见 §9.2，调用方只声明音乐意图，不能覆盖这些编译决策。

**P2 MVP 只交付 `pitchDelta` 一个音高坐标写面**（`pitch_delta_contribution_cents`）。
`vibratoEnv` 是宿主颤音的辅助包络 Automation，不是第二个音高坐标写面；
触及时仍与 `pitchDelta` 在同一事务中读基线、写入和回滚。
planner 生成的是要叠加的技法贡献，不是最终 Automation 值；
现有曲线仍是宿主真相，必须由快照捕获并用 fingerprint 防陈旧。
这避免 planner 默默覆盖用户已有 pitchDelta，也避免把低层 mutation 的
`replace/add/scale` 选择负担转嫁给 LLM。需要破坏性替换时，调用方应显式使用低层曲线工具，
不属于该音乐语义 planner。

现有 `parameter-curve.js:678-686` 的 `add/scale` 只对范围内**已有控制点**应用一个
标量 amount，不能表示随时间变化的新 contribution；空 `vibratoEnv` 上 scale 更会成为 no-op。
因此编译器必须先按宿主实际插值采样 baseline，将 contribution 加到 baseline（或把 envelope
乘到 baseline），生成保持边界的**最终控制点**，再调用低层 `mode:"replace"`。
这里 replace 是事务的物理写法，不改变 planner 的 additive 音乐语义。
`absolute_group_pitch_semitone` → `PitchControlCurve` 推迟到 H3b 给出
绝对 MIDI/score/occurrence offset 到 group-relative curve 的可逆变换、
H3a 给出双写面优先级、H4 给出插值证据之后，作为 P2 的第二个增量。
这样 MVP 不依赖任何未回答的宿主未知量。

#### F5b — composition 顺序：canonical key，不用 request order（v2 修正）

原 v1 同时写了 `overlapPolicy: "explicit_priority_then_request_order"`
与退出门禁"technique 输入顺序置换不改变 canonical output hash"。
**两者不可兼得**：若 request order 参与语义，置换输入就必然改变结果。

**裁定**：改为 `explicit_priority_then_canonical_key`。

1. 先按显式 `priority`（整数，小者先）排序；
2. 同 `priority` 时按 **canonical key** 排序（定义见下）；
3. `sum_then_clamp` 对**可交换**的叠加（纯加法）本身顺序无关，
   canonical key 只用于确定 clamp 与冲突检测的**遍历次序**，使其可复现；
4. 若两个技法 `priority` 相同、span 重叠，**且**其中至少一个声明为
   `exclusive`（非可交换叠加），则**结构化拒绝** `PLAN_CONFLICT`，
   要求调用方显式给出 priority —— 不靠隐式次序猜测意图。

现有 `expression-plan.js:989` 已有同类先例（absolute 表现手法不得与
同参数其他手法重叠），应对齐该错误族而非另造。

#### canonical key 不得包含 `id`（v2.1 修正）

v2 把 canonical key 写成
`(spanFromSeconds, spanToSeconds, kind, id)`，这**破坏了排列不变性**。

原因：`id` 是按请求位置生成的。现有 planner 就是这么做的 ——
`pitch-gesture-plan.js:201`：

```js
const gestureId = `g${requestIndex}-${gesture.type}`;
```

`requestIndex` 直接来自输入顺序。因此换序 → `id` 改变 → canonical key 改变
→ 排序改变 → hash 改变。这条 key 让退出门禁重新变得不可满足。

**修正后的定义**：canonical key 是**规范化语义内容的稳定哈希**，
不含任何位置派生量：

```text
canonicalKey = contentHash(canonicalJson({
  kind,                    // "portamento" | "transient" | "vibrato" | …
  span:    { fromSeconds, toSeconds },
  anchors: { … },          // note indexInGroup，已解析为数字
  model:   { family, …全部模型参数… }
}))
```

规则：

- 使用仓库既有的 `canonical-json.js` 的 `contentHash`
  （键序稳定、数值规范化），**不自己写序列化**；
- **`id` 不参与**；
- 连续浮点参数先按声明精度量化（时间到 `1e-9 s`、cents/semitone 到 `1e-6`、
  rate 到 `1e-9`、ratio/phase/无量纲 shape 与 scale 到 `1e-12`）；
  **量化后的值就是 canonical IR 中保存的值**，
  不能只量化 hash 输入而保留原始浮点，否则两个相同 key 仍可能对应两份不同 IR；
- 量化完成后、计算 hash 之前，必须对**已选中的 canonical IR 分支重新执行 schema
  与跨字段关系校验**。至少复验 `startRatio<endRatio`、`fromSeconds<toSeconds`、
  `peakTimeSeconds<spanSeconds`、数值上下界，以及量化后 `dampingRatio=0` 的尾部互斥。
  量化把两个有序值压到同一 lattice 点时返回 `CANONICAL_RELATION_INVALID`；
  量化后越界返回 `CANONICAL_VALUE_OUT_OF_RANGE`；不得先 hash 再让编译器以普通
  `INVALID_ARGUMENTS` 偶然失败；
- identity、ordinal、count 与 BLICK 字段使用 `safe_integer` domain：必须通过
  `Number.isSafeInteger`，不得以 quantum=1 调用 `Math.round`。失败返回
  `INVALID_INTEGER_SEMANTIC_FIELD`，`error.details` 含字段、JSON Pointer 与原值；
- `TECHNIQUE_IR_NUMERIC_FIELD_SCHEMA` 是唯一权威数据源，每个精确字段只声明一次
  `{unit, quantum, domain, owners}`；`SEMANTIC_NUMERIC_QUANTA` 等投影只能从它派生，
  不得手工维护第二份量化表。实现启动时拒绝重复字段、未知 owner、无 owner、
  非正 quantum 与未知 domain；
- 连续值量化策略使用闭合字段 schema，不用
  `includes("rate")`、`includes("second")` 之类子串猜测；这既防止 `level`、
  `shapePower`、`tension` 漏量化，也防止 `separateFlag`、`accurateSeconds`
  被误伤。遇到未登记数值字段必须在计算 hash 前返回
  `UNQUANTIZED_SEMANTIC_FIELD`，`error.details` 含字段名、JSON Pointer 和原值；
  禁止原值放行。现有 MCP 边界把 `error.details` 展开到
  `structuredContent.error.{field,path,value}`，契约测试必须通过真实
  `encodeToolError()` 验证，不能只检查内部 Error 对象；
- 当前 expression 的 tuple/grouping 先展开成命名字段再进入 canonicalizer；
  不能让同一个裸数组位置在不同 gesture 中暗含不同单位。公开 planner schema 的
  每个 numeric leaf 必须在权威字段 schema 中存在；每个内部字段必须有至少一个 owner；
- 排序用 `(priority, canonicalKey)` 字典序；
- **`tech_N` 编号在排序完成后才分配** —— 它是输出标识，不是排序输入。
  这样 canonical IR 里的 `tech_0` 恒指"排序后第一个"，与提交顺序无关。

**完全相同的两个技法**（语义内容逐字节相同、priority 相同）canonical key 相同，
构成真正的重复请求 → `DUPLICATE_TECHNIQUE` 结构化拒绝
（而不是静默叠加两次，那会让幅度翻倍且无法从响应里看出来）。
两个请求若在量化后碰撞，也按同一错误拒绝；`details.left/right` 必须分别返回
source identity 与逐字段 `{path,field,input,output,quantum,unit,domain}`，
让客户端无需解析错误文本即可定位碰撞；
不得再用 request order 打破平局。

**必须有的回归**（review 明确要求的用例）：同 `kind`、同 `span`、
**不同参数**的两个技法，其全部排列都必须产出逐字节相同的 canonical IR 与
plan hash。这个用例专门覆盖"key 退化到只比较 kind+span 就分不出先后"的实现错误。

这样"输入顺序置换 → canonical hash 不变"成为**可满足且可测试**的门禁。

#### F5c — `interpolationEvidence` 的捕获前置条件（v2 新增）

原 v1 声明 `interpolationEvidence` 是必需字段，但没有说它从哪来。
核验后这是一个真实的契约空洞：

- `interpolationMethod` 只在 `readAutomationSnapshot` 中捕获
  （`parameter-curve.js:41-69`，字段见 `:62`）；
- 该函数只在 `include.has("automation")` 时被调用
  （`musical-range.js:361-374`）；
- 而 range snapshot 的**默认 include 是 `["notes","tempoMap","meterMap"]`**
  （`musical-range.js:1140`）——**不含 automation**；
- planner 是纯内存只读、不访问宿主，因此拿不到未被捕获的值。

即：按 v1 文档实现，planner 会要求一个它无法获得的字段。

**裁定**：IR 的 `target` 增加 `requiredInclude`，并按 surface 定义：

| `target.surface` | `include` | `automationParameters` | 证据字段 |
|---|---|---|---|
| `pitchDelta`（无 vibrato） | `["notes","automation"]` | `["pitchDelta"]` | pitchDelta 的 fingerprint + `interpolationEvidence` |
| `pitchDelta`（含 vibrato） | `["notes","automation"]` | `["pitchDelta","vibratoEnv"]` | 两参数 fingerprint + 逐参数 `interpolationEvidence` |
| `pitchControlCurve` | `["notes","pitchControls"]` | —— | `curveInterpolationEvidence`（H4 profile 的 `getValueAtInterpolationFamily`） |

两者是**不同的 discriminated schema**，不共用字段名 ——
`Automation` 的插值方法是实例状态（可读、随 UI 变），
而 `PitchControlCurve` 的插值族是宿主实现常量（只能靠 H4 密集采样反推）。
把两者塞进一个 `interpolationEvidence` 会让"该证据是否会随实例变化"变得不可判定。

**只有请求含 vibrato 时，`vibratoEnv` 才必须在 `automationParameters` 里显式列出**：
range snapshot 的默认参数集是
`["pitchDelta","tension","loudness","breathiness"]`
（`musical-range.js:60` `DEFAULT_AUTOMATION_PARAMETERS`）—— **不含 `vibratoEnv`**。
P2 的颤音 source gate（§9.5）需要读它来判断是否会双重颤音，
`source:"explicit_pitch_delta"` 分支还可能按 H2 结论写它。
不显式请求就会拿到"未捕获"，进而把"没捕获"误当成"宿主颤音不存在"。
不含 vibrato 的 transition/transient 请求不读取或返回 `vibratoEnv`，避免无意义宿主调用和 capsule 膨胀。

**`interpolationEvidence` 必须是逐参数的实测数据，不是占位符（v2.1 修正）**：
v2 写成字符串 `"captured_host_method"`，那只是一个标签，无法验证。
每个被写入的参数各有自己的 `Automation` 实例，各有自己的
`getInterpolationMethod()` 返回值 —— `pitchDelta` 可能是 `Cubic`
而 `vibratoEnv` 也可能是 `Cubic` 或其他实例值，不能硬编码。字段必须携带：

| 子字段 | 含义 |
|---|---|
| `method` | canonical `"linear"｜"cosine"｜"cubic"`；只做大小写归一，不改变方法 |
| `source` | `"host_getInterpolationMethod"`，固定值，声明这是观测而非假定 |
| `capturedAtContextId` | 捕获该值的 context，使证据可追溯到具体快照 |
| `resolvedParameter` | 宿主解析后的 typeName（别名情形下与请求名不同） |

外加 `target.hostProfileHash`：绑定 P0.5 profile 版本，
使"该 method 在此宿主版本下的插值语义"可复现。

缺失时返回 `CAPTURE_EVIDENCE_REQUIRED`，错误消息必须给出**可直接执行的补救**
（完整的 `sv_snapshot_range` 参数，含 `automationParameters`）：

```json
{
  "include": ["notes", "automation"],
  "automationParameters": ["pitchDelta", "vibratoEnv"]
}
```

同时：P2 的请求示例、workflow guide recipe 与 `sv_describe` 描述都必须
写明这个 include 前置（`workflow-guide.test.mjs` 会用真实 served schema
校验 guide 里的每个示例请求，因此漏写会被测试抓到）。

**commit 时必须重新读取并比对**（v1 已有此要求，此处保留）：
`Automation` 无 interpolation setter，误差保证是宿主状态的函数。
capsule 封存快照时**每个参数**的 `getInterpolationMethod()`，commit 前重新读取；
任一参数不一致则 `INTERPOLATION_CHANGED` 零写入拒绝 —— 因为按旧插值语义算出的
`maxFitErrorCent` 对新语义不成立。错误详情须指明是哪个参数漂移、从什么变成什么。

### 4.6 F6 — 响应预算（对齐仓库门禁）

| 项 | 终版取值 | 来源 |
|---|---|---|
| compact 主响应硬上限 | 16 KiB | `response-budget.js:12` |
| compact 主响应**目标** | ≤ 8 KiB | 本计划收紧 |
| error envelope | 8 KiB | `response-budget.js:18` |
| request（facade 信封 + arguments） | 16 KiB | `response-budget.js:21` |
| TechniqueIR inline | ≤ 8 KiB，否则 Artifact | 本计划 |
| 单 technique dense samples | ≤ 2000 | 本计划 |
| 单请求 techniques | ≤ 32 | 16 KiB request envelope 反推；更大意图应拆成多个独立音乐范围 |
| 单 Plan compiled points | ≤ 4000 | 本计划 |

不得在计划文档里另设与 `response-budget.js` 冲突的数字——该模块被
`surface-io-policy.js` 同源导入正是为了防止"文档写一个值、代码判另一个值"。

### 4.7 F7 — planner 请求不含执行语义

`plan_*` 请求**不接受** `execution`、`atomic`、`undoLabel`、`dryRun`。
现有两个 planner 的 inputSchema 均不接受此类字段；`undoLabel` 只存在于 mutation 工具。
执行语义属 apply 侧，放进 plan 请求违背 plan/execute 分离。

### 4.8 F8 — FitWorker v1 协议（语言无关）

```json
{
  "protocolVersion": 1,
  "requestId": "fit_…",
  "operation": "fit_richards_segment",
  "samples": { "timeSeconds": [], "cents": [], "mask": [] },
  "initial": {}, "bounds": {},
  "loss": { "kind": "huber", "scaleCents": 8 },
  "limits": { "maxIterations": 200, "maxStarts": 16, "timeoutMs": 1000 },
  "seed": 1
}
```

响应含 `engine{name,version}`、`termination`、`parameters`、
`metrics{rmseCents,maxAbsCents,iterations,multiStartSpread}`、`warnings`。

Node 收到后**必须重新**：校验 schema/bounds/finite → 用 canonical Node 前向模型复算曲线
→ 复算 metrics → 判定 identifiability → 生成最终 Artifact/hash。
worker 的数字**永不**直接进入 plan。

**robust loss 不得删除**：computed pitch 比音频 F0 干净（可去掉 MAD 离群过滤与
音高跟踪器容错），但 null、突变、低采样率、宿主模型伪影、过渡重叠、旧结果依然存在。

### 4.9 F9 — 数值边界与默认值（v2.1 新增）

v2 只在示例里出现这些参数，没有范围、默认值与互斥规则 ——
那等于把语义留给实现者发明。以下是**权威取值**，
schema 必须逐条落实（全部 `additionalProperties:false`）。

#### Richards transition

| 字段 | 类型 | 范围 | 默认 | 说明 |
|---|---|---|---|---|
| `inflectionRatio` | number | `[0.05, 0.95]` | `0.5` | 拐点在 span 内的相对位置。两端各留 0.05 是因为 `q1−q0` 在极端比值下趋零，触发退化拒绝 |
| `sharpness` | number | `[1, 40]` | `6` | 无量纲；`steepnessPerSecond = sharpness / durationSeconds`。下限 1 以下曲线近似直线（应改用 `linear`）；上限 40 时端点误差已达 `2e-9`，再高即退化为阶跃 |
| `asymmetryLogB` | number | `[-3, 3]` | `0` | `B = exp(asymmetryLogB)` ∈ `[0.0498, 20.09]`，覆盖 AVA 论文报告的形状范围；`0` 为对称普通 logistic |
| `width.seconds` | number | `[1e-9, 2]` | 必填 | span 时长；下限等于时间量化步长，避免合法正数在 canonical IR 中变成 0。上限 2 s：更长的音高移动是乐句级走向，不是 transition 技法 |

公开请求的 `curve.family` 只允许 `"linear"` 或 `"richards"`；
`"richards"` 在 normalize 后唯一映射为内部
`"richards_segment_normalized"`。`"richards_segment"` 不作为 alias 保留，
避免公开名与内部 model family 漂移。

#### 二阶瞬态

| 字段 | 类型 | 范围 | 默认 | 说明 |
|---|---|---|---|---|
| `peakSemitone` | number | `[-1.5, 1.5]`\* | 必填 | 带符号，符号即方向（论文的 polarity）。\*受 `constraints.maxAbsPeakSemitone` 进一步收紧 |
| `peakTimeSeconds` | number | `[0.005, 0.5]` | 必填 | **相对 `onsetSeconds`** 的首峰延迟。下限 5 ms 低于任何可编辑粒度；上限 0.5 s 之外已非"瞬态" |
| `dampingRatio` | number | `[0, 1]` | 按 intent：overshoot `0.5422`，preparation `0.6681` | 分别采用论文两类技法的拟合值；`>1` 按范围拒绝（F2） |
| `onsetSeconds` | number | `[-0.5, 0.5]` | `0` | **note-relative offset**，不是绝对时间（见下） |
| `spanSeconds` | number | `[1e-9, 2]` | 必填 | 自 `onsetSeconds` 起算的作用区间；实际还必须晚于 `peakTimeSeconds` |
| `tailPolicy` | enum | `"reject" \| "continuous_taper"` | `"reject"` | 尾部超出 span 的处置（F3） |
| （内部）`taperRatio` | versioned constant | 固定 `0.25` | `0.25` | 非请求字段；决定 taper 从 `0.75·span` 开始，并在 IR/detail evidence 中公开 |

`ζ=0` 是无损振荡，任何有限 span 都不可能满足 `reject` 的收敛条件。因此
`dampingRatio:0` 时调用方必须**显式**给出 `tailPolicy:"continuous_taper"`；
省略或给出 `reject` 都在 schema 阶段拒绝。不得静默替调用方切换策略。

**`onsetSeconds` 语义裁定**：它是**相对锚定音符 onset 的偏移**（秒），
不是绝对工程时间。理由有两条 ——
`preparation` 技法按定义发生在音符边界**之前**（论文："a deflection in the
direction opposite to a note change observed just before the note change"），
故必须允许负值；而绝对时间会使同一 IR 在音符移动后失效，
与本项目"锚定 fingerprint 而非绝对坐标"的既有纪律冲突。
字段名保留 `onsetSeconds` 但 schema description 必须写明
"relative to the anchored note's onset; negative = before the note"。

#### 颤音

| 字段 | 类型 | 范围 | 默认 | 说明 |
|---|---|---|---|---|
| `startRatio` / `endRatio` | number | `[0,1]` 且 `startRatio < endRatio` | `0` / `1` | note-relative 作用区间；移动音符后语义仍稳定 |
| `rateHz` / `endRateHz` | number | `[0.5, 12]` | `5.5` / `rateHz` | 频率线性漂移；相位按 `∫f(t)dt` 积分，禁止用终点 rate 直接乘时间 |
| `depthSemitone` / `endDepthSemitone` | number | `[0.01, 2]` | `0.3` / `depthSemitone` | 深度线性漂移；不再保留 schema 24 semitone 再靠约束 clamp 的双重真相 |
| `centerDriftSemitone` | number | `[-1,1]` | `0` | 中心从 0 线性漂移到该值 |
| `phaseRad` | number | `[-6.283185307179, 6.283185307179]` | `0` | 初相位，radians；这是 `1e-12` canonical lattice 内不越过 `±2π` 的对称边界，距 `2π` 小于一个 quantum |
| `fadeInSeconds` / `fadeOutSeconds` | number | `[1e-9, 1]` | `0.3` / `0.2` | 零值拒绝；下限等于时间量化步长；之和超过 span 时按确定规则归一（F3b） |

#### `plan_pitch_correction`（配合 §10.1c）

| 字段 | 范围 | 默认 |
|---|---|---|
| `smoothnessLambda` | `[0, 100]` | `0.4` |
| `magnitudeMu` | `[1e-6, 100]` | `0.01` |
| `maxAbsCorrectionCent` | `[1e-6, 1200]` | `50` |
| `minimumCoverage` | `[0, 1]` | `0.8` |
| `minimumRunFrames` | 整数 `[1, 1000]` | `3` |

`magnitudeMu` 的下限是 `1e-6` 而非 `exclusiveMinimum: 0` ——
后者允许 `1e-300`，形式上满足却仍数值奇异（§10.1a）。

#### 互斥与共存规则

1. `width.seconds` 与任何 BLICK 形式的 span **互斥**：IR 只保留秒 span（F5）。
   同时给出两者即 `CONFLICTING_SPAN_UNITS`。
2. `transition` 不接受 `peakSemitone` / `dampingRatio`；
   `transient` 不接受 `inflectionRatio` / `sharpness` / `asymmetryLogB`。
   由 discriminated union 在 schema 层强制，不靠运行时检查。
3. vibrato 的 `source` 是分支 discriminator：`host_envelope` 只接受
   `envelopeScale`，`explicit_pitch_delta` 只接受时变颤音参数。没有顶层
   `vibratoSource`，也没有 `auto` fallback；H2 未确认时显式分支于 preflight 零写入拒绝。
4. 所有**静态**默认值必须写进 schema 的 `default` 而非仅在 handler 里补；按 discriminator
   变化的静态默认值用 Draft 2020-12 `if/then` 声明 ——
   `sv_describe` 服务的 schema 是模型唯一的参数来源。引用同一请求字段的关系默认值
   （`endRateHz=rateHz`、`endDepthSemitone=depthSemitone`）无法用标准 JSON Schema
   `default` 表达，必须在 description 与 normalize 契约中同时声明。
   注意 `schema-defs.js` 不会把 `default` 字面量提取成 `$ref`，
   因此这样写不会破坏 `$defs` 抽取。
5. `dampingRatio:0` 与默认 `tailPolicy:"reject"` 结构性互斥；schema 用 `if/then`
   要求显式 `continuous_taper`，handler 仍以 `UNDAMPED_TAIL_REQUIRES_TAPER`
   做第二道守卫。固定 `taperRatio:0.25` 进入 sealed IR/evidence，不进入请求。

## 5. 阶段总览

| 阶段 | 交付物 | 可独立发布 | 阻塞来源 |
|---|---|---|---|
| **P0** | 基线 + synthetic corpus | 否 | 无 |
| **P0.5** | **H1 换算一致性 + host profile v2（H2–H8）** | 否 | **阻塞 P2/P3/P5/P7 的门禁** |
| P1 | 数学模型库 + 等秒网格 | 内部库 | P0 corpus |
| P2 | planner 扩展 + `pitchDelta` 编译 + 插值后置验证 | **前向 MVP** | P1 + H1/H2 |
| P2b | `PitchControlCurve` 编译 | 第二增量 | H3a 共存 + H3b 坐标变换 + H4 |
| P3 | 单步开环 correction | 是 | P1/P2 + H1 |
| P4 | FitWorker benchmark 与选型 | 研究交付 | P0 corpus |
| P5 | 只读技法分析 | 预览版 | P4 选型 + H1/H8 |
| P6 | 全链路真机 RC | RC | P2/P3/P5 |
| P7 | 单 Undo 有界闭环 | 条件发布 | H5/H7 专项门禁 |
| P8 | 评估、文档、正式发布 | 正式版 | 所有目标阶段 |

P0.5 是本计划相对四份候选计划的**结构性新增**。H1 在所有前序文档中都不存在，
却是全部 Hz 门禁的前置条件。

## 6. P0：冻结基线与 synthetic corpus

### 6.1 基线记录（写入独立验收记录，不硬编码进业务代码）

commit、Node/Lua protocol 版本、host version；**41 routed operations / 8 公开工具名**；
`npm test` / MCP smoke / Lua dispatcher 结果；12-note 与 373-note 性能与 token 基线；
current host profile hash。

顺手校正 `CLAUDE.md` 的两处漂移（"42 internal tools" → 41；
"`MAX_DESCRIBE_OPERATIONS` is 2" → 16，实值见 `compact-facade.js:21`）。

### 6.2 Synthetic corpus 覆盖

上行/下行端点归一 Richards；`B=1` 与强非对称边界；欠/临界/过阻尼通用响应；
欠阻尼 first-peak transient（含 `ζ=1` 极限）；4/5.5/7/9 Hz 颤音；
depth/rate/center drift；**tempo change 前后等秒频率**；null gap / 全 null / 低 coverage；
overlap（portamento + transient + vibrato）；退化区间 / 采样过粗 / 极端参数；
固定 seed 的噪声与对抗 case。

每 case 保存 input、dense truth、mask、invariants、tolerance、seed。
**不保存任何用户工程内容或真实歌词。**

### 6.3 P0 退出门禁

`npm test` + MCP smoke + Lua dispatcher 全绿；corpus canonical hash 可重复；
所有单位/阈值/seed 显式；`api-docs/*.json` 无漂移。

## 7. P0.5：宿主证据（新增前置阶段）

### 7.1 H1 — 秒↔BLICK 换算一致性（**最高优先，只读**）

问题：`musical-time.js:130 secondsAtBlick()` / `:144 blickAtSeconds()` 用快照
tempoMarks 做**分段线性积分**，全仓库唯一调用宿主 `getSecondsFromBlick` 的位置是
`audition.js:66-67`。所有颤音 Hz 保证都依赖这个此前未完整比对的换算内核；
§7.1b 的恒速 45 点结果只是部分证据。

实验（纯只读，无写入）：

1. 构造三种 tempo 场景：恒定；单点阶跃变速；多点密集变速（若 UI 支持 ramp 则加一组）；
2. 在每个场景取 ≥200 个 BLICK 位置（含 tempo mark 前后各 ±1 blick 与 mark 正上方）；
3. 逐点调宿主 `TimeAxis.getSecondsFromBlick` / `getBlickFromSeconds`
   —— **这是一次性的离线探针（≥200 次往返，可接受），不是生产路径**；
4. 与 Node 侧同点结果比对，记录 max/p95/median 绝对偏差（秒与 blick 双向）；
5. 往返测试：`blick → seconds → blick` 的整数舍入误差分布。

门禁：

- max 偏差 ≤ 1e-6 s → Node 换算可信，Hz 门禁按原值（离线 0.5% / 真机 1%）；
- 偏差集中在 tempo mark 边界 → 修正 `musical-time.js` 的边界取整规则后重测；
- 偏差随距离累积或存在 ramp → 走 §7.1a 的批量方案，**不是逐点调用**；
- 记入 host profile v2 字段 `timeAxis.nodeParityMaxDeviationSeconds`
  与 `timeAxis.tempoRampSupported`。

**在 H1 结论产出前，不设定也不引用任何 Hz 类门禁数值。**

#### 7.1b 2026-08-03 DEV file bridge 只读证据（部分通过，不解锁 H1）

当前实际工程只有一个 tempo mark（120 BPM）。通过 DEV SV Copilot file bridge 对
45 个位置采样，包含 0、1、`QUARTER±1`、工程末端和全程等距点：

```json
{
  "tempoMarks": [{ "position": 0, "positionSeconds": 0, "bpm": 120 }],
  "durationBlick": 197215200000,
  "sampleCount": 45,
  "maxSecondsError": 0,
  "maxRoundTripBlickError": 1
}
```

这确认了**当前恒速夹具**上 Node 分段公式与宿主一致，也确认整数 BLICK 往返需要允许
最多 1 BLICK 的舍入差。它没有覆盖 tempo mark 边界、阶跃变速或密集变速，故 H1 仍为
`partially_observed`，不能把 Hz 门禁标为全局 confirmed。

同一只读探针在 373-note target 上得到：`pitchDelta` definition
`[-1200,1200] / default 0`、`vibratoEnv` definition `[0,2] / default 1`，
两者该实例的 `getInterpolationMethod()` 原始返回均为 `"cubic"`。
这是 Context 实例证据，不是宿主全局常量；它直接否定在示例里把 `vibratoEnv`
硬编码为 `Linear` 的做法。

#### 7.1c 2026-08-04 完整 H1 实机证据（终态）

在 SynthV 2.2.1、bridge protocol 2 上，三个可回放 Artifact 各以 200 个位置执行
`TimeAxis.getSecondsFromBlick` / `getBlickFromSeconds`，并包含每个 tempo mark 的
`-1/0/+1`。用户授权的临时 fixture 准备与恢复不属于探针；三份 Artifact 的采样工作流均为
`mode: "read"`，零 setter、零显式 Undo boundary。

- [恒速](evidence/T02-time-axis-constant-live-v2.json)
- [单点阶跃](evidence/T02-time-axis-tempo-step-live.json)
- [多点密集变速](evidence/T02-time-axis-dense-tempo-live.json)

聚合 600 点后，Node 秒值最大偏差为 `1.4210854715202004e-14 s`，小于 `1e-6 s`；宿主
BLICK 往返最大偏差为 `1`。H1 因此为 `confirmed`，`timeAxis.nodeParityMaxDeviationSeconds`
写入 profile v2 的 confirmed fact，T03 裁定 `not_required`，生产时间映射保持 Node 分段换算。
未观测到 tempo ramp，`timeAxis.tempoRampSupported` 保持 `unknown`。

#### 7.1a H1 失败时的生产方案：批量 opcode，不是逐点调用（v2 修正）

原 v1 把"改为逐点调宿主"写作 fallback。这不满足传输现实：

- PIPE 是严格 lockstep，**同时只有一个 in-flight 命令**（`transport-pipe.js`）；
- 桥空闲轮询 `IDLE_MS = 20`（`StartSynthVCopilotPipe.lua:6`）；
- 单次调用超时 10 s；
- 而一条颤音密集曲线可达 **10,000 个采样点**（F6 预算：单 technique ≤ 2000，
  单 Plan compiled points ≤ 4000，加上分析侧重采样网格）。

10,000 次串行往返在这个传输上不是"额外成本"，而是不可用。

**裁定**：H1 失败时按以下优先级处置，逐点调用**不在选项内**。

| 优先级 | 方案 | 说明 |
|---|---|---|
| 1 | **修正 Node 换算模型** | 若偏差源于边界取整或 tempo mark 语义误解，改 `musical-time.js` 并用同一探针重测至通过。这是最优解 —— 零传输成本 |
| 2 | **新增批量 opcode `time_axis_map_v1`** | 一帧传入一批 BLICK（或秒），Lua 侧循环调 `TimeAxis` 后一次性返回。沿用 Phase 1 `read_note_fingerprints_v1` 的既有模式：固定字段 allowlist、批量上限、握手 `ops` 能力声明、不返回 handle、不调 setter、不产生 Undo、写帧前复核 `FRAME_TOO_LARGE` |
| 3 | **锚点批量 + 本地插值** | 仅在 mandatory anchors 与 tempo mark 处调宿主（数十点），区间内用本地模型插值，并对每个区间给出可证明的误差上界。仅当方案 2 的帧预算不足时采用 |

批量上限必须由 64 KiB/帧反推：每点是一个 float（typed-v2 编码后约 20 字节），
故单帧约 2,000–3,000 点，10,000 点需 4–5 帧 —— 相比 10,000 次往返是
三个数量级的改善。

方案 2 若被选用，须在 P0.5 阶段就完成（它是 P1 时间网格的前置），
且 Lua 侧改动要同时落到已加载脚本与 `staging/` 参考副本，并跑
`dispatcher_test.lua` 双向回归。

### 7.2 host behavior profile v2 字段

在 `tools/lib/host-behavior-profile.mjs` 增加版本化 semantics：

```text
timeAxis.nodeParityMaxDeviationSeconds        (H1)
timeAxis.tempoRampSupported                   (H1)
automation.interpolationSetterAvailability     (已知 unavailable，记录以防未来版本变化)
automation.boundaryInclusion
pitchControl.getValueAtInterpolationFamily     (H4)
pitchSurfaces.pitchDeltaWithPitchControl       (H3a)
pitchSurfaces.absoluteMidiToGroupCurveTransform (H3b)
vibrato.hostEnvelopeWithExplicitPitchDelta     (H2)
vibrato.hostEnvelopeWithExplicitPitchControl   (H2)
vibrato.noteModulationInteraction              (H2, dF0VbrMod)
computedPitch.recomputeLatency                 (H5)
computedPitch.stabilityAfterWrite              (H5)
computedPitch.staleNonEmptyAfterWrite          (H6)
computedPitch.fineFluctuationPresent           (H8)
undo.multiCandidateSingleBoundary              (H7)
```

证据来源必须分级：`official_doc` / `live_read_only` / `live_reversible_write` /
`human_observed_undo`。任何 `confirmed` 绑定 evidence ID；不确定保持
`unknown` / `not_observable`。

具体 Automation 实例的 `getInterpolationMethod()` 结果属 **Context/plan evidence**，
不写成全局 profile 常量；profile 只记录 API 能力与经证明不随实例变化的语义。

### 7.3 可恢复写实验流程

所有写实验只在**隔离临时轨 / 临时 group** 上执行：

1. 基线快照 + hash；
2. 建立明确 Undo 边界；
3. **单变量**写入；
4. 等待 computed pitch 稳定（记录 attempts / 延迟 / contentHash 序列）；
5. 读取曲线（`Automation.get()` / `getValueAt()`）与 computed pitch；
6. 恢复或删除临时对象；
7. 验证原工程 hash / handles / pending executions / Artifacts 全部干净；
8. H7 需人工观察一次 Ctrl+Z 的撤销范围。

H2 矩阵最小组合（6 组）：
{`vibratoEnv` 默认 1、压平 0.2、放大 1.8} × {无显式正弦、有显式正弦}，
另加 `dF0VbrMod` 非零一组。

H3 必须拆成两份证据，不允许用一份实验同时宣称两项都成立：

- **H3a 共存/优先级**：固定 score 与 occurrence，分别测试仅 pitchDelta、仅
  PitchControl、两者同时存在，比较 computed pitch，确认覆盖区间内是相加、忽略还是覆盖；
- **H3b 坐标变换**：在三个已知绝对 MIDI 目标与至少两个 occurrence timeOffset 上写最小
  PitchControl fixture，读回 `getValueAt()` 与 computed pitch，推导并往返验证
  `absolute MIDI ↔ group-relative anchor/point` 变换。H3a 通过不能替代 H3b。

### 7.4 P0.5 退出门禁

所有 profile 字段要么 `confirmed`（绑 evidence ID）要么诚实 `unknown`；
原 fixture 内容与 hash 恢复；无泄漏 Artifact/handle/pending execution；
宿主不支持或全 null 时不伪造结论；
**H2/H3a/H3b 仍 unknown 时，对应 schema 组合必须在 preflight 零写入拒绝。**

## 8. P1：数学模型与秒域测量核心

### 8.1 模块

```text
server/src/pitch-techniques/ir.js
server/src/pitch-techniques/richards.js        (F1: raw + segment)
server/src/pitch-techniques/second-order.js    (F2: impulse + firstPeak)
server/src/pitch-techniques/vibrato.js
server/src/pitch-techniques/time-grid.js       (F4)
server/src/pitch-techniques/compose.js
```

纯函数：不得 import store、session、Artifact、host adapter 或读环境变量。
相同输入逐字节确定。

### 8.2 数值测试

**Richards（F1）**：有限区间端点误差 ≤ 1e-12；上/下行单调；
**raw 拐点在归一化后不移动**（对 `B ∈ {0.35,1,3}` 验证）；`asymmetryLogB=0` 对称；
1000+ 属性随机 case 无 NaN/Inf；极小 `|q1−q0|` 结构化拒绝；
`A/B` 为相反方向的有限极值时，拐点用 `log(B)-log(A)` 计算且保持有限。

**二阶（F2）**：论文 Eq.(2) 四个 case 各与高精度参考一致（含 `ζ=0` 无损振荡
不触发 `0/0`）；`onsetSeconds` 在四分支均为精确时间平移；`ζ→1` 左右连续且
与临界闭式吻合（含 `1±1e-12` 响应回归，`ω·t_peak → 1`，
本轮已验证 `ζ=0.999→1.000333`、`ζ=1.0001→0.999967`）；
`ζ>1` 经首峰接口调用时按**范围**拒绝且错误消息不称"无法计算"；
onset 前严格为 0；首峰幅度/时间在采样误差内恢复；
`continuous_taper` 的值与一阶差分连续性达标，且 `ζ∈[0,1]` 扫参中
全 span 的绝对值不超过请求首峰。通用内部闭式还要覆盖
`ζ∈{1e155, Number.MAX_VALUE}`，响应、导数与首峰因子不得 NaN/Inf。

**角频率单位（F2b）**：一条独立回归钉住论文值 ——
`naturalAngularFrequencyRadPerSecond = 34.8`（= `0.0348 rad/ms × 1000`）、
`ζ = 0.5422` 时首峰时间应为
`arccos(0.5422)/(34.8·√(1−0.5422²)) = 0.0341217 s`。
同时钉住误用值：若字段被当成 Hz 且实现做 `ω=2πf`，得 `0.0054306 s`（÷2π）；
若先换算成 5.5386 Hz 又当 rad/s 用，得 `0.2143933 s`（×2π）。
另用论文 vibrato 参数钉住 `ω=34.5 rad/s`、`k=1.8 s⁻¹`、`ζ=0`：
周期 `0.1821213 s`、峰值 `0.0521739`。若漏掉 `K × 1000`，峰值会错误缩小 1000 倍。
模型模块内不得出现 `naturalHz` 或无单位 `gain` 字段。

`reference/model.test.mjs` 是这组公式的可执行 oracle：
除逐分支闭式外，还用随机参数的微分方程残差、`ζ→1` 连续性、首峰精确命中和
C1 taper 检查交叉验证，不能只复制生产函数再断言自身输出。

**颤音**：内部模型在零 depth **且零 center drift** 时恒为零（公开显式颤音 schema 仍要求 `depthSemitone≥0.01`）；固定 rate 的过零间隔正确；零 fade 在 schema 与模型层均拒绝；
**秒域频率在 tempo change 前后不变**（依赖 H1）；envelope 起止连续；
同输入 canonical hash 相同。

**时间网格（F4）**：constant tempo 与原结果一致；tempo change 跨越时秒间隔恒定；
不跨 null gap；`BLICK→seconds→BLICK` 往返在整数舍入预算内。

### 8.3 P1 退出门禁

模型库零宿主依赖（测试断言不 import host 成员）；corpus 全绿；
property tests 固定 seed 且失败可复现；输出单位显式（字段名带 `Cents`/`Semitone`/`Seconds`/`Hz`/`Blick`）；
无新运行时依赖；Node 单线程生成 10,000 samples 的 p95 ≤ 20 ms（或记录经批准的新阈值）。

## 9. P2：planner 扩展、`pitchDelta` 编译与插值后置验证

**范围裁定（v2）**：P2 MVP **只交付 `pitchDelta` 一个音高坐标写面**（见 F5a）；
按 H2 处理的 `vibratoEnv` 仅是辅助包络参数，不改变这一定义。
`PitchControlCurve` 编译作为 P2b 增量，需先分别完成 H3a（覆盖区间内
`pitchDelta` 是否参与）与 H3b（绝对 MIDI/score/occurrence offset 到
group-relative curve 的坐标变换）—— 一条 contribution cents 曲线不能仅凭 H3a
等价落到绝对半音坐标的覆盖曲线上。

### 9.0 语义所有权裁定（v2.1 新增，阻塞 §9.1 起的全部工作）

v2 把 `plan_pitch_gesture` 移到 `pitchDelta`，与现有 `plan_expression` **正面冲突**：

| | `plan_expression` | `plan_pitch_gesture`（现状） |
|---|---|---|
| gesture 类型 | `scoop`、`fall`、`portamento`、`vibrato`、`hairpin` | `transition`、`attack`、`release`、`vibrato` |
| 写面 | `automation`（`pitchDelta` / `vibratoEnv` / loudness / tension / …） | `pitchControl` |
| 现有归属 | **已在 `pitchDelta` 上生成 scoop/fall/portamento/vibrato** | PitchControl 专属 |

即：`scoop`≈`attack`、`fall`≈`release`、`portamento`≈`transition`、
两边都有 `vibrato`。若 P2 让 `plan_pitch_gesture` 也写 `pitchDelta`，
同一业务语义会有两个公开 planner —— 直接违背本计划 §2.3
"不新增近义 planner"原则，且模型无法判断该用哪个。

**裁定：技法归 `plan_pitch_gesture`，`plan_expression` 退出音高技法。**

选择理由：TechniqueIR 的价值正是把 scoop/fall/portamento/vibrato 统一到
**可解释、可拟合、可逆向**的数学模型（Richards / 二阶 / 时变正弦）之下。
把它塞进 `plan_expression` 的启发式词表会让两套参数体系并存；
反过来让 `plan_pitch_gesture` 只做 PitchControl，则 MVP 又落回未验证的 H3a/H3b/H4。

具体分工：

| 归属 | 内容 |
|---|---|
| `plan_pitch_gesture` | 全部音高技法；公开三类为 transition、transient（overshoot/preparation）、vibrato。MVP 固定编译 Automation，P2b 另行成对扩 schema |
| `plan_expression` | 仅非音高表现：`hairpin`（loudness/tension/breathiness/gender/voicing 弧线）、intent 词表派生的**非音高**基线弧线 |

迁移动作（属破坏性变更，按 §2.4 成对执行，不留 alias）：

1. 从 `plan_expression` 的 `GESTURE_TYPES` 移除 `scoop`、`fall`、`portamento`、`vibrato`；
2. 其 intent 词表中派生音高手法的条目（如 `spoken_rap_transition` 播种
   `vibratoEnv` 压平，`expression-plan.js:730,741`）改为**发出指引**：
   返回 warning 指向 `plan_pitch_gesture`，不再自行生成音高 operation；
3. `hairpin` 的 `pitchDelta` 选项移除 —— hairpin 是渐强渐弱，
   落在 `pitchDelta` 上语义可疑（`expression-gestures.js` 的
   `HAIRPIN_PARAMETER_ORDER` 首项即 `pitchDelta`，应删除该项）；
4. workflow guide 的相关 recipe 同批改写；
5. `plan_expression` 的 operation description 明确声明它不再处理音高。

**不可接受的替代方案**：让两者都能写 `pitchDelta` 并"靠文档提示模型选一个"。
那等于把歧义转嫁给模型，且两套实现会各自漂移。

若评审认为该迁移代价过大，唯一的备选是**把 P2 MVP 改回 PitchControl 写面**，
但那要求 H3a/H3b/H4 先完成，MVP 因此依赖真机证据 —— 这是一个真实的取舍，
必须显式选择，不能两条都留。

### 9.1 成对迁移清单（同一批提交）

`pitch-gesture-plan.js` 的 normalize/instantiate/compile；`index.js` direct schema；
compact facade 自动路由（`FACADE_BY_TOOL` 已登记则无需改动）；`sv_describe` operation schema；
workflow guide/resource（其每个示例请求都被 `workflow-guide.test.mjs` 按真实 served schema 校验）；
PlanRef capsule；planner / plan-apply-schema / MCP smoke tests。

### 9.2 请求契约（扩展 `plan_pitch_gesture`）

前置：Context 必须捕获 `notes` 与实际会触及的 Automation。纯 transition/transient 只需
`pitchDelta`；任一 vibrato 分支再要求 `vibratoEnv`。缺失时返回
`CAPTURE_EVIDENCE_REQUIRED`，details 给出可直接执行的最小补救参数，不固定要求无关字段。

权威 arguments schema 如下。它是 served schema 的源设计，不是宽松示意；实现时可通过仓库
`$defs` 抽取缩短传输，但展开后的约束必须等价：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "svcopilot://schemas/plan_pitch_gesture/arguments",
  "type": "object",
  "additionalProperties": false,
  "required": ["contextId", "occurrence", "gestures"],
  "properties": {
    "contextId": { "type": "string", "minLength": 1 },
    "occurrence": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
    "gestures": {
      "type": "array",
      "minItems": 1,
      "maxItems": 32,
      "items": {
        "oneOf": [
          { "$ref": "#/$defs/transition" },
          { "$ref": "#/$defs/transient" },
          { "$ref": "#/$defs/explicitVibrato" },
          { "$ref": "#/$defs/hostVibrato" }
        ]
      }
    },
    "retainCorrectionTarget": { "type": "boolean", "default": false },
    "constraints": { "$ref": "#/$defs/constraints" }
  },
  "$defs": {
    "priority": { "type": "integer", "minimum": -100, "maximum": 100, "default": 0 },
    "ratio": { "type": "number", "minimum": 0, "maximum": 1 },
    "width": {
      "type": "object",
      "additionalProperties": false,
      "required": ["seconds"],
      "properties": { "seconds": { "type": "number", "minimum": 0.000000001, "maximum": 2 } }
    },
    "linearCurve": {
      "type": "object",
      "additionalProperties": false,
      "required": ["family"],
      "properties": { "family": { "const": "linear" } }
    },
    "richardsCurve": {
      "type": "object",
      "additionalProperties": false,
      "required": ["family"],
      "properties": {
        "family": { "const": "richards" },
        "inflectionRatio": { "type": "number", "minimum": 0.05, "maximum": 0.95, "default": 0.5 },
        "sharpness": { "type": "number", "minimum": 1, "maximum": 40, "default": 6 },
        "asymmetryLogB": { "type": "number", "minimum": -3, "maximum": 3, "default": 0 }
      }
    },
    "transition": {
      "type": "object",
      "additionalProperties": false,
      "required": ["type", "from", "to", "width", "curve"],
      "properties": {
        "type": { "const": "transition" },
        "from": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
        "to": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
        "priority": { "$ref": "#/$defs/priority" },
        "width": { "$ref": "#/$defs/width" },
        "curve": { "oneOf": [{ "$ref": "#/$defs/linearCurve" }, { "$ref": "#/$defs/richardsCurve" }] }
      }
    },
    "transient": {
      "type": "object",
      "additionalProperties": false,
      "required": ["type", "note", "intent", "peakSemitone", "peakTimeSeconds", "spanSeconds"],
      "allOf": [
        {
          "if": { "properties": { "intent": { "const": "overshoot" } }, "required": ["intent"] },
          "then": { "properties": { "dampingRatio": { "default": 0.5422 } } }
        },
        {
          "if": { "properties": { "intent": { "const": "preparation" } }, "required": ["intent"] },
          "then": { "properties": { "dampingRatio": { "default": 0.6681 } } }
        },
        {
          "if": { "properties": { "dampingRatio": { "const": 0 } }, "required": ["dampingRatio"] },
          "then": {
            "required": ["tailPolicy"],
            "properties": { "tailPolicy": { "const": "continuous_taper" } }
          }
        }
      ],
      "properties": {
        "type": { "const": "transient" },
        "note": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
        "intent": { "enum": ["overshoot", "preparation"] },
        "priority": { "$ref": "#/$defs/priority" },
        "peakSemitone": { "type": "number", "minimum": -1.5, "maximum": 1.5 },
        "peakTimeSeconds": { "type": "number", "minimum": 0.005, "maximum": 0.5 },
        "dampingRatio": { "type": "number", "minimum": 0, "maximum": 1 },
        "onsetSeconds": { "type": "number", "minimum": -0.5, "maximum": 0.5, "default": 0 },
        "spanSeconds": { "type": "number", "minimum": 0.000000001, "maximum": 2 },
        "tailPolicy": { "enum": ["reject", "continuous_taper"], "default": "reject" }
      }
    },
    "explicitVibrato": {
      "type": "object",
      "additionalProperties": false,
      "required": ["type", "source", "note"],
      "properties": {
        "type": { "const": "vibrato" },
        "source": { "const": "explicit_pitch_delta" },
        "note": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
        "priority": { "$ref": "#/$defs/priority" },
        "startRatio": { "$ref": "#/$defs/ratio", "default": 0 },
        "endRatio": { "$ref": "#/$defs/ratio", "default": 1 },
        "rateHz": { "type": "number", "minimum": 0.5, "maximum": 12, "default": 5.5 },
        "endRateHz": { "type": "number", "minimum": 0.5, "maximum": 12, "description": "Defaults to rateHz after discriminator selection." },
        "depthSemitone": { "type": "number", "minimum": 0.01, "maximum": 2, "default": 0.3 },
        "endDepthSemitone": { "type": "number", "minimum": 0.01, "maximum": 2, "description": "Defaults to depthSemitone after discriminator selection." },
        "centerDriftSemitone": { "type": "number", "minimum": -1, "maximum": 1, "default": 0 },
        "phaseRad": { "type": "number", "minimum": -6.283185307179, "maximum": 6.283185307179, "default": 0 },
        "fadeInSeconds": { "type": "number", "minimum": 0.000000001, "maximum": 1, "default": 0.3 },
        "fadeOutSeconds": { "type": "number", "minimum": 0.000000001, "maximum": 1, "default": 0.2 }
      }
    },
    "hostVibrato": {
      "type": "object",
      "additionalProperties": false,
      "required": ["type", "source", "note"],
      "properties": {
        "type": { "const": "vibrato" },
        "source": { "const": "host_envelope" },
        "note": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
        "priority": { "$ref": "#/$defs/priority" },
        "startRatio": { "$ref": "#/$defs/ratio", "default": 0 },
        "endRatio": { "$ref": "#/$defs/ratio", "default": 1 },
        "envelopeScale": { "type": "number", "minimum": 0, "maximum": 2, "default": 1 }
      }
    },
    "constraints": {
      "type": "object",
      "additionalProperties": false,
      "default": {},
      "properties": {
        "maxAbsPeakSemitone": { "type": "number", "minimum": 0.000001, "maximum": 1.5, "default": 1.5 },
        "maxTotalPoints": { "type": "integer", "minimum": 2, "maximum": 4000, "default": 1200 },
        "maxFitErrorCent": { "type": "number", "minimum": 0.000001, "maximum": 20, "default": 1 }
      }
    }
  }
}
```

handler 还要校验 `from != to`、`startRatio < endRatio`、fade 总长与实际 span，
落实 transient 的 intent 条件默认和 `ζ=0` 尾部互斥守卫，并将缺省的
`endRateHz/endDepthSemitone` 解析为各自起始值。
JSON Schema 的 `default` 是 annotation，不是验证时写入指令。实现必须先用
`useDefaults:false` 等等价纯验证路径确认唯一 discriminator 分支，保持原请求逐字节不变；
随后只从该分支物化静态默认值，再应用上面的两个关系默认值并做二次验证。
完成 anchor 解析和 canonical 量化后还要对**量化后的所选分支**做第三次验证；
这次验证覆盖同一 schema 与跨字段关系，防止两个原本合法但相距不足一个 quantum 的
值在 IR 中坍缩为非法等值。只有第三次验证通过才能计算 canonical key。
禁止对整个 `oneOf` 使用 AJV `useDefaults:true`：AJV 会执行失败分支的默认写入，
把 transient/显式颤音/宿主颤音字段互相污染。
公开 family `richards` 只映射内部 `richards_segment_normalized`；没有 alias。
**无 `execution`、`surface`、`referenceFrame` 或 `mode` 字段**（F7）：MVP 的目标与写法唯一，
重复让 LLM 声明只会产生冲突和 token 开销。
`priority` 可省略（默认 0）；同 priority 的重叠按 canonical key 排序，
若涉及 exclusive 技法则 `PLAN_CONFLICT`（F5b）。

最小调用示例：

```json
{
  "operation": "plan_pitch_gesture",
  "arguments": {
    "contextId": "ctx_…",
    "occurrence": 0,
    "gestures": [
      {
        "type": "transition",
        "from": 4,
        "to": 5,
        "width": { "seconds": 0.24 },
        "curve": { "family": "richards", "inflectionRatio": 0.58, "sharpness": 8 }
      },
      {
        "type": "transient",
        "note": 5,
        "intent": "overshoot",
        "peakSemitone": 0.28,
        "peakTimeSeconds": 0.065,
        "spanSeconds": 0.28,
        "tailPolicy": "continuous_taper"
      }
    ],
    "retainCorrectionTarget": true
  }
}
```

普通响应只含：`status:"planned"`、`effects:"none"`、
gesture/curve/point 计数、固定的 `composition:"baseline_plus_contribution"`、
`correctionTargetRetained`、warnings、`requiresHumanAudition:true`、
`apply:{tool, arguments:{planRef, action:"dry_run"}, expiresAt}`、可选 `detailRef`。
**不返回完整 points、完整 fingerprints 或 inline mutation。**

compact 响应示例：

```json
{
  "ok": true,
  "status": "planned",
  "effects": "none",
  "data": {
    "techniques": 2,
    "curves": 1,
    "points": 74,
    "composition": "baseline_plus_contribution",
    "correctionTargetRetained": true,
    "requiresHumanAudition": true
  },
  "apply": {
    "tool": "sv_patch_parameter_curves",
    "arguments": { "planRef": "a_…", "action": "dry_run" },
    "expiresAt": "2026-08-03T12:05:00.000Z"
  },
  "warnings": []
}
```
数学上无变化时沿用仓库统一契约：`status:"no_change"`、`apply:null`、零 Artifact/Undo；
不得返回 `planned` 加空 apply。

`retainCorrectionTarget:true` 只允许纯 additive pitchDelta 计划，并要求 Context 同时捕获
computed pitch 与采样参数。它把“写入前 computed pitch + 技法贡献”以 compact dense table
封存在同一个 Plan Artifact 内，普通响应不增加另一条长引用。计划若触及 `vibratoEnv`，
则返回 `CORRECTION_TARGET_UNAVAILABLE`：在 H2 未给出确定变换前，不能假装
`baseline + pitchDelta contribution` 仍是完整可听目标。

### 9.3 编译步骤

```text
strict request
  → resolve occurrence / note anchors
  → validate exact transition adjacency and symmetric width fit
  → load captured Automation baseline + fingerprint + interpolation evidence
  → build canonical TechniqueIR
  → revalidate the quantized IR branch and cross-field relations
  → compose dense seconds-domain contribution with C(t)=100·(P(t)-S(t))
  → enforce amplitude / span / point budgets
  → map mandatory seconds anchors to integer BLICK
  → simplify while preserving mandatory anchors
  → predict final = captured baseline ⊕ contribution using captured interpolation method
  → precompose final curves; compile each as mode:replace
  → seal one PlanRef apply envelope
```

这里 `⊕` 由每个分支唯一决定：pitchDelta 是加法，host vibrato envelope 是乘法；
二者最终都预合成为 replace points。planner 不接受 caller-supplied mode。
Plan capsule 只封存受影响范围的 baseline points、
短 fingerprint、最终预测摘要和执行所需 compiled points，不复制整组 Automation 或 Context。
baseline support 不能机械裁到 range：Linear/Cosine 至少保留左右最近控制点，Cubic 至少
保留左右各两个控制点，因为范围外邻点会影响范围内插值。fingerprint 覆盖同一 support window；
未知 interpolation method 直接 `UNSUPPORTED_INTERPOLATION`，不能退回 Linear 猜测。

**mandatory anchors** 至少包括：technique start/end；音符边界；
Richards 拐点；transient 首峰；taper 边界；vibrato fade 边界与局部极值；
overlap policy 产生的切换点。
transition 的音符边界必须保留两个单侧极限：边界前最后一个整数 BLICK 与边界自身；
这是抵消 score step 的必要条件，不能被 RDP、去重或同时间点合并逻辑删除。

现状缺口：`bake-computed-pitch.js` 的 RDP 仅保留首末点。
误差度量本身无需改造——`perpendicularDistance`（`bake-computed-pitch.js:319`）
已是按时间插值后取音高绝对差的**垂直误差**，只是函数名误导，
应改名为 `verticalError` 并补强制锚点。

### 9.4 宿主插值后置验证（**F 级要求**）

Automation commit：

1. 在首个 setter 前重新读取受影响范围的 baseline fingerprint 与逐参数 interpolation method；
2. 任一 baseline 已漂移 → `CURVE_BASELINE_CHANGED`，零写入，不以当前值重新规划；
3. 在一个现有 curve transaction 内执行已封存的 final `replace` operation；
4. 在 mandatory anchors + adaptive midpoints 调 **`Automation.get()`**（宿主实际插值）；
5. 与封存的**最终值**比较：add 分支为 `capturedBaseline + contribution`，
   scale 分支为 `capturedBaseline × envelopeScale`；不得拿最终值与 contribution 本身比较；
6. 误差超 `maxFitErrorCent` → `POSTCONDITION_FAILED`，进入现有 rollback 并验证恢复。

PlanLedger 继续阻止同一 PlanRef 重放。它与 baseline fingerprint 是两个独立保护：
ledger 防同一计划再次执行，fingerprint 防别的写入在 plan 与 commit 之间改变基线。

PitchControl commit（P2 第二增量，需 H3a/H3b/H4）：写入后用
**`PitchControlCurve.getValueAt()`** 在同一网格采样，超 epsilon → rollback。
其误差基准是 H4 的 `getValueAtInterpolationFamily`，
与 Automation 的实例级 `interpolationMethod` 是不同证据（F5c）。

**不得**用 `getLinear()` 代替实际插值验证（只能作诊断对照）。
**不得**把超限降级为"低置信度成功 + warning"——那会让模型以为写入达标。

现有骨架已就绪：`parameter-curve.js:1326` 捕获 `getInterpolationMethod()`，
`:1440` 用 `Automation.get()` 采样，失败触发 postcondition 与补偿。
本阶段是扩展该路径，不是新建旁路检查工具。

### 9.5 颤音 source gate（依赖 H2）

| gesture `source` | 编译 | 开放条件 |
|---|---|---|
| `host_envelope` | 读取 baseline 后计算 `baseline×envelopeScale`，以 final `replace` 写入 | profile 已确认 envelope 的观测语义；只改变包络，不宣称控制 rate/depth |
| `explicit_pitch_delta` | 读取 baseline 后计算 `baseline+sinusoid`，以 final `replace` 写入；H2 要求时同 batch 处理 `vibratoEnv` | H2 明确 envelope 与显式正弦的组合关系及安全抑制值 |

没有 `auto`：在两种实现会产生不同音乐结果时，由服务端暗选 source 不可复现。
也不开放 `explicit_pitch_control`：它属于 P2b，必须等 H3a/H3b 与跨写面统一事务均通过。
不允许"可能双重颤音但先写了再说"。
注意 `expression-plan.js` **已在写 `vibratoEnv`**（`spoken_rap_transition` 意图
播种 0.2 压平，见 `:730,741`），因此双颤音风险在现有代码里已经存在，
不是新引入的——H2 结论应同时回溯检查该路径。

### 9.6 P2 退出门禁

dry-run 零 setter / 零 Undo；commit 最多**一个用户 Undo**；
端点/首峰/拐点与误差后置条件通过；失败补偿后原曲线逐点或采样一致；
unknown host combination 在 preflight 零写入拒绝；
缺 `include:["automation"]` 时返回 `CAPTURE_EVIDENCE_REQUIRED` 而非崩溃或猜测；
`referenceFrame` 与 `surface` 不匹配时结构化拒绝；
**technique 输入顺序置换不改变 canonical output hash**（由 F5b 的 canonical key
保证，该门禁现在可满足）；
12-note 与 373-note 主响应符合 compact budget（目标 8 KiB / 硬上限 16 KiB）；
dense detail 仅在 Artifact、可分页、可释放。

## 10. P3：单步开环 pitch correction

### 10.1 数学

P3 的所有音高量先统一到**绝对 cent**，禁止把 contribution cents 与绝对 MIDI 直接相减：

```text
targetAbsoluteCent[i]   = 100 · baselineComputedMidi[i] + plannedContributionCent[i]
observedAbsoluteCent[i] = 100 · observedComputedMidi[i]
e[i]                    = targetAbsoluteCent[i] − observedAbsoluteCent[i]
u[i]                    = observedContext 中当前 pitchDelta Automation（cent）
```

`baselineComputedMidi` 与 `plannedContributionCent` 来自 P2 已密封的 source PlanRef；
只有 `retainCorrectionTarget:true` 的纯 additive pitchDelta 计划才保存前者。
任一输入为 null/non-finite 时该 frame 的 mask 为 false，target 也保持 null。

然后求：

```text
argmin_δ  ‖W^{1/2}(δ − e)‖²  +  λ‖D₂(u + δ)‖²  +  μ‖δ‖²
```

法方程为：

```text
(W + λ·D₂ᵀD₂ + μ·I) δ = W·e − λ·D₂ᵀD₂·u
```

P3 首版在每个 finite frame 上固定 `Wᵢᵢ=1`，null frame 不进入任何 run；
公开 JSON 不传逐帧权重数组。若后续由宿主提供可信的逐帧置信度，`Wᵢᵢ`
就是该**对角权重本身**，法方程中不得再次平方。密集权重只能从已密封 Artifact
恢复，不能内联到 LLM 请求。参考 oracle 的非单位权重回归专门钉住这一点。

系数矩阵对称、带宽 2（五对角）。实现**专用五对角 Cholesky**，O(n) 时间与内存。
不引入稀疏矩阵库，不用通用求解器。

该线性系统给出的是**无 box 约束**的唯一极小值。随后应用
`maxAbsCorrectionCent` 的逐点 clamp 属安全投影，不得宣称仍是原二次目标的
精确受约束最优解；`predictedRmseCent`、目标值和改善判定必须用投影后的 `δ`
重新计算。投影后不改善则 `no_change`，不能因为投影前曾改善就出计划。

`reference/model.mjs` 有意使用独立的 dense Cholesky 构造完整
`D₂ᵀD₂`，作为小规模测试 oracle；它不是生产实现，也不满足 2000-frame 性能目标。
生产五对角解必须在随机 `n=1…2000` 上与该 oracle/法方程残差交叉验证，不能让
“被测算法”和“参考算法”共享同一套带状索引代码。

#### 10.1a 正定性不是无条件的（v2 修正）

原 v1 写"对称正定"，未加限定条件。这不成立：

- `D₂` 的零空间是 `{常数, 线性}`，对 `n ≥ 3` 维数为 2；
- null frame 使 `W` 的对应对角元为 **0**；
- 因此当 `μ = 0` 时，若 `W` 的非零支撑不足以约束住 `D₂` 零空间中的
  线性分量，矩阵**奇异**；
- 极端情形：全部 frame 为 null（`W = 0`）、`λ > 0`、`μ = 0`
  → 零空间维数 2 → **确定奇异**。

**裁定**：两条同时执行。

1. **`μ` 有硬下限**：schema 约束 `μ ≥ 1e-6`（`exclusiveMinimum: 0` 不够 ——
   浮点下 `1e-300` 满足它却仍数值奇异）。`μ > 0` 时
   `W + λD₂ᵀD₂ + μI ⪰ μI ≻ 0`，正定性无条件成立。
2. **可机械检查的秩前置条件**：即使 `μ > 0` 保证了可解，
   全 null 或极低 coverage 的"解"没有证据支撑。因此在求解**之前**检查
   `有效帧数 ≥ max(3, ⌈minimumCoverage · n⌉)`，不满足则
   `INSUFFICIENT_COMPUTED_PITCH` 零计划返回 —— 与 F4 的 null 纪律一致：
   null 不是零误差。

Cholesky 分解期间若仍遇到非正主元（浮点边界），
必须报 `SOLVER_NOT_POSITIVE_DEFINITE` 并附 `λ/μ/有效帧数`，
**不得**回退到伪逆或最小范数解 —— 那会静默产出一个无法解释的修正曲线。
若输入本身有限、但 `100·MIDI`、正规方程系数或前后代入在 double 范围内溢出，
派生 target/error 先按无效证据计入 coverage；进入求解后才发生的溢出返回
`CORRECTION_NUMERIC_OVERFLOW`，不得让 `NaN` 进入 clamp、Artifact 或 JSON。

#### 10.1b `D₂` 不得跨越 null gap（v2.1 新增）

上面的 `W`、`D₂` 写法有一个未言明的错误：**把 null frame 的权重设为 0
并不能阻止二阶差分把间隙两侧耦合起来。**

`D₂` 的第 `i` 行 stencil 是 `(u_{i}, u_{i+1}, u_{i+2})`。若 `u_{i+1}` 是 null，
该行仍然存在，仍然对 `u_i` 与 `u_{i+2}` 施加平滑约束 —— 于是间隙左侧的修正
会被强行"接"到右侧，跨过一段本无观测的区域。`W_{i+1}=0` 只是让该点的
**数据项**消失，不影响**正则项**。

这与 F4 的"只在连续 finite run 内插值、不跨 null gap"直接矛盾：
F4 在重采样层禁止跨越，求解层却又通过 `D₂` 跨了回去。

**裁定**：按连续 finite run **分块求解**。

1. 用 mask 把序列切成若干最大连续 finite run `R₁ … R_k`
   （与 F4 的 run 定义共用同一个函数，不得各切各的）；
2. 每个 run 独立构造 `W_j`、`D₂^{(j)}`、`I_j` 并独立求解 —— run 之间
   **没有任何耦合项**；
3. run 长度 `< 3` 时 `D₂^{(j)}` 为空矩阵，退化为 `(W_j + μI_j)δ_j = W_j e_j`，
   仍然可解（`μ>0`）；
4. run 长度 `< minimumRunFrames`（默认 3）的碎片**不产出修正**，
   计入 `skippedRuns` 并在响应里报告 —— 不静默当作 0；
5. 各 run 的解拼回全序列，null 区间保持"无修正点"，
   **不插值、不外推、不写点**。

等价的实现方式是保留全局矩阵但**删除 stencil 触及 null 的全部 `D₂` 行**，
两者数学等价；分块实现更容易断言 run 之间零耦合，推荐分块。

**必须有的回归**：构造一个左右两段 finite、中间 null 的序列，
左段误差为 `+50 cent`、右段为 `−50 cent`。正确实现下两段各自独立修正；
若 `D₂` 跨越间隙，两段解会互相拉扯并在间隙附近产生可观测的偏移 ——
该测试专门钉死这一点。

### 10.1c `plan_pitch_correction` 完整契约（v2.2 重写）

v2 只给了参数名，没给契约。补齐如下。

请求：

```json
{
  "operation": "plan_pitch_correction",
  "arguments": {
    "sourcePlanRef": "a_committedPitchPlan",
    "observedContextId": "ctx_after",
    "evidence": { "minimumCoverage": 0.8, "minimumRunFrames": 3 },
    "regularization": {
      "smoothnessLambda": 0.4,
      "magnitudeMu": 0.01,
      "maxAbsCorrectionCent": 50
    }
  }
}
```

权威 arguments schema：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "svcopilot://schemas/plan_pitch_correction/arguments",
  "type": "object",
  "additionalProperties": false,
  "required": ["sourcePlanRef", "observedContextId"],
  "properties": {
    "sourcePlanRef": { "type": "string", "pattern": "^a_[A-Za-z0-9_-]+$" },
    "observedContextId": { "type": "string", "minLength": 1 },
    "evidence": {
      "type": "object",
      "additionalProperties": false,
      "default": {},
      "properties": {
        "minimumCoverage": { "type": "number", "minimum": 0, "maximum": 1, "default": 0.8 },
        "minimumRunFrames": { "type": "integer", "minimum": 1, "maximum": 1000, "default": 3 }
      }
    },
    "regularization": {
      "type": "object",
      "additionalProperties": false,
      "default": {},
      "properties": {
        "smoothnessLambda": { "type": "number", "minimum": 0, "maximum": 100, "default": 0.4 },
        "magnitudeMu": { "type": "number", "minimum": 0.000001, "maximum": 100, "default": 0.01 },
        "maxAbsCorrectionCent": { "type": "number", "minimum": 0.000001, "maximum": 1200, "default": 50 }
      }
    }
  }
}
```

字段语义（全部 `additionalProperties:false`）：

| 字段 | 含义 | 范围 / 默认 |
|---|---|---|
| `sourcePlanRef` | 已成功 commit、且 `retainCorrectionTarget:true` 的 P2 PlanRef；只读恢复 baseline/贡献/目标身份 | 必填 |
| `observedContextId` | **写入后**重新 snapshot 的 context，须含 computedPitch、`pitchDelta` Automation 与兼容采样网格 | 必填 |
| `evidence.minimumCoverage` | 有效帧占比下限，低于则零计划 | `[0,1]`，默认 `0.8` |
| `evidence.minimumRunFrames` | run 短于此值不产出修正 | 整数 `[1,1000]`，默认 `3` |
| `smoothnessLambda` | `λ`，二阶差分惩罚 | `[0,100]`，默认 `0.4` |
| `magnitudeMu` | `μ`，幅度阻尼；**硬下限见 10.1a** | `[1e-6,100]`，默认 `0.01` |
| `maxAbsCorrectionCent` | 单点修正幅度上限，超出即 clamp 并计入 `clampedPoints` | `[1e-6, 1200]`，默认 `50`；下限等于 cent 量化步长 |

`sourcePlanRef` 必须由 read-only resolver 打开。它可以读取 ledger 状态为 `committed`
的 target capsule，但**不得**再次进入 apply/live preflight；原计划的重放保护保持不变。
若计划未提交、未保留 target、已释放/过期、触及 `vibratoEnv`，分别返回
`PLAN_NOT_COMMITTED`、`CORRECTION_TARGET_NOT_RETAINED`、正常 Artifact 错误、
`CORRECTION_TARGET_UNAVAILABLE`，全部零写入。

Plan capsule 已封存 occurrence target UUID/timeOffset 与采样网格；handler 用这些守卫在
`observedContextId` 中自动匹配目标。请求不再重复 occurrence。零个匹配返回
`PLAN_TARGET_MISMATCH`，多个匹配返回 `AMBIGUOUS_PLAN_TARGET` 并给候选 ordinal。

**`u`（当前控制曲线）不由请求传入**：它从 `observedContextId` 的
`include:["automation"]` 捕获中读取，与 `observed` 同源。
让调用方传 `u` 会引入第二真相 —— 调用方以为的曲线与宿主实际曲线可能已经不同。

**采样坐标**：全部沿用 target Artifact 记录的 uniform-seconds 网格（F4）。
若 `observedContextId` 的 computed-pitch 采样网格与之不一致，
先按 F4 重采样到 target 网格；无法对齐（如覆盖范围不相交）则
`SAMPLING_GRID_MISALIGNED` 零计划。

响应（普通体）：

```json
{
  "ok": true,
  "status": "planned",
  "effects": "none",
  "data": {
    "iterationBasis": "single_open_loop_step",
    "runs": { "solved": 3, "skipped": 1 },
    "frames": { "total": 900, "finite": 764, "coverage": 0.849 },
    "objective": { "beforeRmseCent": 18.4, "predictedRmseCent": 4.1 },
    "correction": { "points": 96, "maxAbsCent": 31.2, "clampedPoints": 0 }
  },
  "apply": {
    "tool": "sv_patch_parameter_curves",
    "arguments": { "planRef": "a_…", "action": "dry_run" }
  },
  "warnings": []
}
```

`predictedRmseCent` 是**模型预测**，不是观测 —— 字段名与 provenance 必须
如此声明。真实改善只能由 commit 后重新 snapshot + `compare_computed_pitch` 得出。

终态沿用仓库统一契约：

- 无改善或修正全部低于写入阈值 → `status:"no_change"`, `apply:null`；
- coverage 不足或全部 finite run 过短 → `status:"insufficient_evidence"`, `apply:null`，
  evidence 返回 observed/required coverage 与 skipped run 摘要；
- 只有存在可执行修正时才是 `status:"planned"` + sealed apply。

普通响应不内联 target、observed、u、δ 或逐 frame residual；这些 dense 数据只进入
新 correction Plan Artifact/detail Artifact。请求只增加一个短 `sourcePlanRef`，不会把
P2 为 token 效率做的 compact/Artifact 优化倒退。

### 10.2 业务规则

null frame 权重 0；coverage 低于门限则拒绝出计划；
source PlanRef 已封存的 mandatory anchor **时间采样点**在输出曲线简化与宿主
后置验证中始终保留，不由 LLM 开关控制；这不等于给求解器添加 `δᵢ=eᵢ` 的
硬约束，若未来需要该语义必须另立受约束模型版本；
correction 有绝对幅度、斜率与总点数上限；只修一个声明 surface。绝对幅度由
请求的 `maxAbsCorrectionCent` 收紧；斜率上限由 P0 synthetic/host corpus 定标后
写入 versioned server policy，响应报告实际采用的 `maxSlopeCentPerSecond`，不让
LLM 内联任意阈值；超斜率返回 `CORRECTION_SLOPE_LIMIT` 零计划，不靠额外平滑
悄悄改变目标；总点数沿用 F6 的 4000 硬上限；
planner 只读、**不进入 ExecutionCoordinator**；
输出 normal PlanRef（commit 仍由现有 mutation 完成）；
每次 plan 明确 `iterationBasis:"single_open_loop_step"`。

### 10.3 P3 退出门禁

`n = 1…2000` 与稠密高精度参考解一致；**`μ` 下限生效，λ/μ 极值不奇异**；
全 null 与低 coverage 在求解前被秩前置条件拒绝（不产出"解"）；
null mask 不被当零误差；恒等宿主 + 已知偏移时一步 RMSE 改善达预注册门限；
无改善时返回 no-plan / insufficient evidence（不是错误）；
一次正常 plan + dry-run + commit = 一个 Undo；
correction 前后指标可独立重算；**不依赖闭环状态机即可发布。**

## 11. P4：FitWorker benchmark 与选型

### 11.1 候选

Node 自研或成熟库；Rust 原生 helper 或 WASM；Python 3.10+ + SciPy `least_squares`
（原生支持 bounds 与 robust loss）；其他满足协议与部署门禁的实现。
可因许可证、无人维护或无法自动分发早期淘汰，但**必须留下证据**。

### 11.2 同环境门禁（同 corpus / 同 seed / 同硬件 / 预热后 ≥20 次）

| 指标 | 门禁 |
|---|---|
| canonical forward parity | 与 Node model 最大偏差 ≤ 1e-9 cents，或有批准的浮点解释 |
| clean recovery | ≥95% case 在预注册参数容差内 |
| noisy / null recovery | curve RMSE、参数误差、拒绝率同时达标 |
| degenerate input | 100% 结构化拒绝，不 hang、不 NaN |
| deterministic replay | 同 seed canonical result hash 相同 |
| p95 single fit | 初始目标 ≤ 100 ms |
| p95 phrase fit | 初始目标 ≤ 1500 ms |
| timeout recovery | 超时后下一请求可正常服务 |
| crash isolation | worker crash 不影响 Node 或 host transaction |
| packaging | Windows/macOS 自动安装测试 |
| license | NOTICE 与再分发条件完整 |

阈值可在 P0 基线后修订**一次**，须附测量数据；不得为偏好语言倒推放宽。

### 11.3 选型规则

Node 达标 → 选 Node（不增加运行时）；
Node 不达标而 Rust/WASM 达标 → 选部署成本更低者；
SciPy 明显胜出 → 可选或捆绑 worker，并在 doctor/capabilities 报告状态；
**全部不达标 → 不公开逆向拟合，P5 停止；前向与开环照常发布。**

## 12. P5：只读技法分析

### 12.1 流程

```text
captured computed pitch
  → seconds timestamps (依赖 H1)
  → uniform-seconds resampling (F4)
  → score-relative cents + null mask
  → baseline
  → vibrato candidate + flatten
  → score-informed transition windows
  → Richards fit
  → transient candidate / fit
  → bounded joint refinement
  → explained / residual metrics
```

### 12.2 分段策略

首版用：音符边界先验 + lead/lag window + 一阶导数方向 +
minimum duration/cents movement + vibrato-flattened contour + confidence/rejected reason。

**不预先移植 AVA HMM。** 但也不宣称 score-informed 严格更优——音符边界是强先验
而非 oracle，真实 portamento 可提前、滞后或跨边界。
只有 host corpus 显示漏检或边界偏差超门限，才评估三态 HMM 或混合模型。

### 12.3 拒绝判据（命中即 `insufficient_evidence`，不输出貌似精确的参数）

endpoint mismatch；inflection 超出可接受 span；有效过渡短于采样分辨率；
退化区间/幅度；robust fit 不优于线性或简单平滑 baseline；
multi-start 成本接近但参数分散；low coverage / null 碎片化；
overlapping techniques 无法区分；host sampling provenance 不完整。

### 12.4 错误码

`COMPUTED_PITCH_NOT_CAPTURED`、`INSUFFICIENT_COMPUTED_PITCH`、`SAMPLING_RATE_TOO_LOW`、
`NO_TECHNIQUE_CANDIDATE`（成功的空分析，非内部错误）、`MODEL_NOT_IDENTIFIABLE`、
`FIT_DID_NOT_CONVERGE`、`FIT_WORKER_UNAVAILABLE`、`FIT_TIMEOUT`。

新增 status 必须经 `result-status.js` 的 10-status 矩阵映射
（未注册的 status 在编码边界抛错，而非到达模型）。

### 12.5 P5 退出门禁

synthetic detection 与 recovery 达预注册指标；真实 host corpus **单独报告**
（不与 synthetic 混算）；全 null / pending / 合法无声区不混淆；
分析零 setter / 零 Undo（proxy 断言）；
compact 响应不内联 dense samples 或 multi-start；solver/model/version/seed 可复现。

## 13. P6：真实宿主 RC 验收

### 13.1 场景（每个执行 snapshot → plan → dry-run → isolated commit → wait → compare → cleanup）

**MVP 验收（P2/P3 必过，构成 RC 门禁）**：

1. constant-tempo Richards 上/下行；
2. tempo-change 跨越 transition/vibrato；
3. overshoot/preparation（欠阻尼首峰）；
4. host-envelope vibrato（gesture `source:"host_envelope"`）；
5. explicit vibrato on `pitchDelta`（需 H2 已确认）；
6. overlap composition（含 canonical key 排列不变性的真机复核）；
7. `pitchDelta` 写面；
8. shared target 两 occurrence；
9. 12-note 与 373-note；
10. full / partial / all-null computed pitch；
11. stale Context 与 host reconnect；
12. worker timeout / crash（若 P4 选中外部 worker）；
13. interpolation postcondition failure + rollback（含逐参数漂移）；
14. **null gap 分块修正**（§10.1b：左右两段异号误差，验证不跨间隙耦合）。

**P2b 条件验收（仅当 H3a/H3b/H4 通过、P2b 启动后执行；不阻塞 MVP RC）**：

15. `PitchControlCurve` 写面；
16. 两 surface 共存或拒绝（H3a 决定 warning/硬拒绝；H3b 证明坐标读回）。

场景 15–16 未执行时，RC 报告必须显式标注"P2b 未启动"，
**不得**留空或标为通过 —— 与最终完成定义（§19）一致。

### 13.2 记录指标

requested dense vs compiled；compiled vs host interpolated；host interpolated vs computed pitch；
seconds/BLICK 往返；simplify 前后点数；coverage / stable polls / recompute latency；
host calls / PIPE bytes / service 与 wall time；MCP serialized bytes；Artifact bytes/pages；
**Undo boundary calls 与用户 Undo steps 分别记录**；rollback evidence；
human audition 记录（明确标 `human_only`）。

### 13.3 P6 退出门禁

**RC 门禁 = MVP 场景 1–14 全过**（场景 15–16 属 P2b，不在 RC 门禁内）：

宿主插值误差 ≤ caller epsilon；tempo change 下 vibrato rate 偏差达
**H1 结论产出后设定的**门禁；所有正常 commit 一个 Undo；
shared target 未确认时零写入；postcondition failure 恢复原值；
null gap 两侧修正互不耦合（场景 14）；
timeout/disconnect 诚实区分 `rolled_back` / `outcome_unknown`；
fixture、临时轨、handles、pending executions、Artifacts 全部清理。

**P2b 独立门禁**（启动后才适用）：场景 15–16 通过，
且 `PitchControlCurve` 的 `getValueAt()` 后置误差 ≤ caller epsilon。
P2b 未启动不影响 RC 判定。

## 14. P7：单 Undo 有界闭环（条件阶段）

### 14.1 发布前提（全部满足才实施）

P3 开环在真实 corpus 上方向正确；P0.5/P6 得到可用的 recompute latency 与 stability（H5）；
**真机确认多次内部写仍能被一个 Ctrl+Z 撤销（H7）**；
worker/bridge 超时路径能恢复或诚实 unknown；用户交互延迟在预算内。

任何一项失败 → P7 保持 `not-shipped`，**不降级成 K 个用户 Undo 的产品行为**。

### 14.2 状态机

```text
captured → journaled → undo_boundary_open → candidate_applied → observing
  → candidate_verified
       → accepted  → undo_boundary_closed
       → rejected  → restoring_previous → restored
            → next_candidate
            → exhausted → undo_boundary_closed → no_change
       → uncertain → outcome_unknown
```

### 14.3 硬规则

**iteration 内禁止调用 `newUndoRecord()`**（这是单 Undo 成立的全部依据：
一对边界之间的任意多次写入 = 一个用户 Undo，现有
`parameter-curve.js:407 → runChunkedMutation → :1587` 已是此模式）；
最多 3 个 candidate；第一个 setter 前 journal 完整；
每次拒绝必须恢复并读回；最终只有 accepted state 留在宿主；
最后一个 candidate 被拒绝后必须进入 `exhausted`，确认 original hash 已恢复，
关闭 Undo 边界并返回 `status:"no_change"`；不得停在 `restored` 等待不存在的下一候选，
也不得把“全部不合格”报告成失败或 accepted；
setter 后 timeout/disconnect 无法证明状态时返回 `outcome_unknown`；
不返回可在之后调用的 restore token；Context 在写入后立即失效
（按 `context-invalidation.js` 的 **writeAttempted** 而非 status 判定）。

### 14.4 预算算术（须由 H5 实测校准）

外层预算 60 s 无测量支撑。约束链：单 host call 超时 10 s
（`transport-pipe.js:29-35`）、单 in-flight 命令、bridge idle 20 ms
（`StartSynthVCopilotPipe.lua:6`）。
3 轮 × (写 + 后置验证 + processing 等待 + 可能的恢复) 必须由
H5 的单轮 processing p95 反推可行轮数，而非先定 60 s 再塞。
若算术不成立，降为 2 轮或只保留 P3 开环。

### 14.5 故障注入

第一候选写失败；第一候选 postcondition 失败；第一次 processing timeout；
第二候选写失败；restore 中途失败；close boundary 失败；
bridge disconnect after setter；worker crash before/after candidate；final read-back mismatch。
另加“全部 3 个 candidate 均被拒绝”用例：setter/restore 顺序正确、原始 hash 一致、
边界恰好关闭一次、终态 `no_change`。H7 必须记录这种净零变化事务在宿主 Undo 历史中
是否仍占一个用户步骤；在真机证据前只报告观测值，不承诺零 Undo。

### 14.6 P7 退出门禁

每种可恢复失败的最终 hash 与原始一致；不可证明失败均为 `outcome_unknown`；
**一次 Ctrl+Z 恢复 operation 前状态**（人工观察）；
`expectedUserUndoSteps:1` 与人工观察一致；median objective 改善达预注册门限；
任一 case 不得恶化超过预注册值而仍报 accepted；
p95 wall time / host calls / PIPE bytes 在预算内。

## 15. P8：评估、文档与发布

### 15.1 可复现 Artifact

model/solver/compiler/host profile 版本；canonical request/IR/plan hashes；
raw 与 uniform-seconds 采样元数据；fitted parameters/bounds/initials/seed；
dense target / compiled / host readback / residual 曲线；
rejected candidates 与原因；performance/transport/Undo/rollback evidence。
**普通响应不返回这些大对象。**

### 15.2 人类试听

复用现有 `sv_start_audition` / `sv_audition_compare`：自动定位、solo、播放、
auto-stop、恢复。结果只声明 `perception:"human_only"`；
preference 可写入外部研究日志或 Artifact；
**不把"播放成功"解释为"技法更自然"。**

不建自动化 blinded A/B 服务：该工具 variant schema 只接受 `soloTrackIndices`，
且明确 "NEVER applies a temporary musical edit for variant B"；
"计划 vs 基线"需先各自永久提交到两条轨，而克隆轨撞上 `setTarget` 一次性约束
与 Singer 身份不透明。人工 A/B 用外部流程组织。

### 15.3 发布文档

面向使用者只解释：可表达哪些音乐技法；哪些 operation 只规划、哪些会写入；
如何 dry-run/commit；一个 Undo 的范围；computed pitch 与人类试听的区别；
host capability 与 unknown 的含义。开发证据留专项文档，不塞进 consumer README。

必含：capability 列表；model/solver 版本；支持与不支持的技法；单位与写面说明；
host acceptance matrix；benchmark；许可证/NOTICE ledger；已知限制；
恢复与 `outcome_unknown` 操作指南。

## 16. 横向质量门禁

### 16.1 Schema

顶层与嵌套对象全部 `additionalProperties:false`；
discriminated union 按 discriminator 只验证对应分支；单位写进字段名；
unknown parameter 不 fallback；identity 用 ordinal/index 而非长 ID；
schema/handler/description/guide/tests 同批提交；
新 operation 必须在 `FACADE_BY_TOOL` 登记（否则 server 启动抛错）。

### 16.2 响应与 token

compact 主响应目标 ≤ 8 KiB（硬上限 16 KiB，见 F6）；
不重复 contextId/occurrence 前缀；per-technique/per-curve evidence 默认聚合；
dense samples 与 solver trace 走 Artifact；
Artifact 超安全阈值只给分页入口；
`detailRef` 记录 issued/read/pageReads/bytes/releasedWithoutRead。

### 16.3 事务

dry-run 零 setter / 零 Undo；no-change 零 setter / 零 Undo；
commit 一个用户 Undo；journal 在首个 setter 前完成；
verification 用独立宿主读取（不信 setter 返回值）；rollback 逆序且读回；
timeout 后不把未知状态报告为 unchanged；
新增 status 经 `result-status.js` 矩阵映射。

### 16.4 性能

每阶段记录：validation / context / target / preflight / compile / write / verify /
processing / rollback；dispatcher 与 coordinator queue 可观测性；
host method count 与 totalMs；PIPE bytes；MCP serialized bytes；
Artifact bytes/pages；12-note 与 373-note 的 median 与 p95。

### 16.5 测试层

```text
unit math → property/invariant → synthetic recovery → schema/contract
  → planner/apply envelope → transaction/fault injection → MCP smoke
  → Lua dispatcher → live reversible host acceptance → human audition record
```

新增 `*.test.mjs` 必须加入 `server/package.json` 的 `scripts.test`
（该字段是显式文件列表，不是 glob）。

### 16.6 固定终审矩阵

从 v2.8 起，文档或实现只有同时通过下列五维矩阵才可称为“实施权威”；后续 review
不得因已知维度漏测而临时增加标准。新增业务需求或新宿主证据可扩展矩阵，但必须显式
升版本并说明新增维度。

| 维度 | 必须闭合的映射 | 机械证据 | 未实施阶段的诚实状态 |
|---|---|---|---|
| 公开业务语义 | request → defaults → resolved anchors → canonical IR → seconds curve → BLICK/final points → apply | 每个 discriminator 至少一个完整正例；transition 另含上下行、gap/overlap、时间映射偏差、等音高 no-change、rest、短音符、大音程与 BLICK 分辨率 | P2 前标 `design-verified`，不得称 host-verified |
| 数值闭包 | 公开 bounds/relations → quantized IR → 同一 bounds/relations | 所有 public numeric min/max 的 lattice 保持测试；sub-quantum 关系坍缩与 `ζ→0` 分支测试 | 纯离线，可在 P1 完成 |
| 错误边界 | 内部 Error → service `error.details` → MCP `structuredContent.error` | 每个新增错误族至少一个真实 encoder 投影测试，禁止只断言 message | 纯离线，可在 schema 提交闭合 |
| 数学与证据来源 | 论文原式 / 工程派生 / 宿主假设三者分离 | 论文方程数值 oracle；工程映射不冒充论文；宿主未知量只引用 profile/evidence | H* 未完成保持 `host-gated` |
| 运行质量 | schema / property / transaction / token / MCP / Lua / host | 依 §16.5 分层；dry-run/Undo/rollback/预算按实际阶段执行；跳过项必须写原因 | 未实现 transaction/host 层不得用离线绿灯替代 |

本地参考门禁固定为：`reference/model.test.mjs`（数学、工程模型、性质）与
`reference/contract.test.mjs`（公开 schema、量化闭包、MCP 错误投影、文档契约）。
生产实现落地后再把同一断言迁入 `server/package.json` 的显式测试列表，并追加事务、
MCP smoke、Lua 与可恢复真机验收；不是重写另一套标准。

## 17. 提交序列

按可回滚纵向切片，每个 commit 单一目的、提交前全绿：

1. `Record P0 baseline and synthetic technique corpus`
2. `Add TimeAxis parity probe and host profile v2 schema`（H1 前置）
3. `Add batched time_axis_map_v1 bridge op`（**仅当 H1 判定需要**，见 §7.1a；
   须同时改已加载脚本与 `staging/` 副本并跑 `dispatcher_test.lua`）
4. `Capture reversible host evidence for vibrato and pitch surfaces`（H2–H8）
5. `Implement raw and endpoint-normalized Richards models`（F1）
6. `Split second-order impulse from first-peak parameterization`（F2 + F2b 角频率）
7. `Implement time-varying vibrato model`
8. `Add uniform-seconds analysis grid and migrate computed-pitch compare`（F4）
9. `Introduce versioned TechniqueIR normalization`（F5 + referenceFrame + canonical key）
10. `Compose and constrain technique curves deterministically`（F5b）
11. `Compile TechniqueIR to the pitchDelta surface`（**MVP 单音高坐标写面**，F5a）
12. `Verify compiled curves against host interpolation in the transaction`（§9.4）
13. `Extend plan_pitch_gesture with technique families`（成对迁移，含 `requiredInclude`）
14. `Compile TechniqueIR to PitchControlCurve`（**仅当 H3a/H3b/H4 全部给出证据**）
15. `Add single-step open-loop pitch correction`（含 `μ` 下限与秩前置条件）
16. `Benchmark replaceable nonlinear-fit backends`
17. `Add read-only pitch-technique decomposition`（取决于 16 的结论）
18. `Validate the full chain on the live host`
19. `Add bounded closed-loop calibration only if safety gates pass`
20. `Publish evaluation and dependency provenance`

每个 commit：不产生 `api-docs` 或 fixture 时间戳噪声；
不夹带 `.serena` / `.codegraph` / `.codex` 或无关 `.gitignore` 变更；契约变化同批更新
对应的已跟踪 `docs/`；
schema 变更时公开链路同批闭环；不用兼容 alias 暂留旧错误契约。

**不在提交序列内**：`CLAUDE.md` 的计数校正（"42 internal tools" → 41、
`MAX_DESCRIBE_OPERATIONS` 2 → 16）。它是本地维护的仓库指引，
属本地维护动作，不作为本计划的交付项。

## 18. 需求追踪矩阵

| 需求 | 阶段 | 验收证据 |
|---|---|---|
| 秒↔BLICK 换算可信 | **P0.5** | H1 逐点探针比对 + profile 字段（生产路径见 §7.1a） |
| Saitou overshoot/preparation | P1/P2 | 解析/属性测试（四 case）+ host readback |
| 二阶单位无 2π/1000 缺口 | P1 | `Ω=34.8 rad/s, ζ=0.5422 → t_peak=0.0341217 s`；vibrato `k/ω=1.8/34.5=5.217%` |
| canonical key 排列不变 | P1/P2 | 同 kind/同 span/不同参数的全排列 → 同一 plan hash |
| 修正不跨 null gap | P3 | 异号两段 + 中间 null 的分块回归（§10.1b） |
| planner 语义唯一所有者 | P2 | `plan_expression` 不再产出音高 operation |
| 非对称 Richards transition | P1/P2 | 端点严格命中 + 拐点不移动 + 宿主插值 |
| transition score-step 映射 | P1/P2 | 上下行绝对音高连续；边界 contribution 跳变严格抵消 score step；rest/短音符/越界大音程拒绝 |
| 秒域颤音跨 tempo | P1/P2/P6 | uniform-seconds + rate error（门禁待 H1） |
| 防双重颤音 | P0.5/P2 | H2 profile + 拒绝不安全组合 |
| 单一 IR 不跨写面误编译 | P2 | `referenceFrame` × `surface` 白名单 + 不匹配拒绝 |
| 插值证据可获得 | P2 | `requiredInclude` + `CAPTURE_EVIDENCE_REQUIRED` |
| 合成顺序无关 | P2 | canonical key + 输入置换 hash 不变 |
| canonical IR 量化后仍合法 | P1/P2 | 所有公开 min/max 保持 + 关系坍缩/`ζ→0` 二次校验 + MCP 错误证据投影 |
| 双 pitch surface 诚实性 | P0.5/P2b | H3a 共存 profile + H3b 坐标变换 + transaction guard |
| 曲线压缩误差 | P2 | `Automation.get()` / `getValueAt()` 后置条件 |
| 单步反馈 | P3 | synthetic + 一次 apply/Undo + `μ` 下限/秩前置 |
| 逆向参数恢复 | P4/P5 | benchmark + synthetic 与 host corpus 分列 |
| 单 Undo 闭环 | P7 | 故障注入 + 一次 Ctrl+Z（H7） |
| 可复现研究 | P0/P8 | canonical hashes + Artifact |
| LLM token 效率 | 全阶段 | serialized bytes + Artifact metrics |

## 19. 最终完成定义

**前向技法 MVP（P2）**：Richards/transient/vibrato 通过数值门禁
（含 F2b 角频率回归）；现有 planner 能生成一个 sealed PlanRef；
dry-run 零副作用；commit 一个 Undo；**宿主实际插值误差达标**；
unsafe vibrato 组合与 `referenceFrame`×`surface` 不匹配在 preflight 拒绝；
缺 `include:["automation"]` 返回可执行的 `CAPTURE_EVIDENCE_REQUIRED`；
输入顺序置换 canonical hash 不变；compact 响应与 Artifact 分页达标。
**MVP 的音高坐标写面只含 `pitchDelta`；事务按需联动 `vibratoEnv` 辅助包络；
不含 `PitchControlCurve` 不算未完成。**

**分析与开环（P3+P5）**：computed pitch 等秒分析正确；
FitWorker benchmark 有记录且选型可解释；analysis 对低证据诚实拒绝；
one-step correction 可独立验证改善；所有只读 operation 零 setter/Undo。

**闭环（P7）**：不是 K 个外部 commit 的编排，而是单 operation / 单 coordinator /
单 journal / 单对 Undo 边界；所有失败点经故障注入；一次 Ctrl+Z 恢复原始状态；
断连时不谎报恢复；真实 host corpus 的收益与成本达预注册门限。

若闭环门禁失败，项目仍可凭**前向规划 + 宿主保真 + 只读分析 + 单步开环**
作为完整可发布能力。**不得为勾选路线图而降低 Undo 或恢复契约。**

## 20. 立即下一步

按此顺序，不先安装任何新语言运行时：

1. **补齐 H1 换算一致性只读比对** —— 最高优先。现有 45 点恒速证据仅为
   `partially_observed`；还需含 tempo mark 边界、阶跃变速和密集变速的
   一次性 ≥200 次探针往返。它阻塞所有 Hz 门禁的取值，且无需可恢复写脚手架。
   若判定需要批量 opcode，则 `time_axis_map_v1` 也在 P0.5 内完成（§7.1a）；
2. 建立 synthetic corpus 与模型 tolerance（可与 1 并行，纯离线）；
3. 扩展 host profile v2 schema，所有未知事实先保持 `unknown`；
4. 用隔离临时轨完成 H2（双颤音 6 组）、H3a（双写面共存/优先级）、
   H3b（绝对 MIDI/score/occurrence offset 到 group-relative curve 的往返变换）、
   H4（PitchControl 插值族）、
   H5/H6（重算延迟与旧非空结果）、H8（fine fluctuation）实验；
5. 并行实现 F1 端点归一 Richards 与 F2 拆分后的二阶模型（纯离线，不依赖 3–4）；
   F2 必须一开始就用 `naturalAngularFrequencyRadPerSecond`，
   不要先写 `naturalHz` 再改 —— 改名会漏掉测试里的同一错误；
6. 证据与模型都通过后，再迁移 `plan_pitch_gesture` 的公开 schema
   （只开 `pitchDelta` 一个音高坐标写面；`vibratoEnv` 仍按 H2 gate）。

这条顺序确保不会先写出一个数学上漂亮、但在宿主中会双重颤音、
违反插值误差、把 rad/s 当 Hz、或建立在未验证秒轴上的 planner。
