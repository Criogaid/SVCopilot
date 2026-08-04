# 可解释音高技法系统最终可行性报告

## 0. 文档信息

- 定稿日期：2026-08-03（**v2.8**）
- 修订历史：v2 采纳首轮 review 的 7 项；v2.1 采纳次轮 review 的 7 项；
  v2.2 补齐 `K` 的秒域换算、additive baseline 事务、P3 absolute-cent 参考系、
  H3a/H3b 与可执行数值 oracle；v2.3 补正 Dirac/响应参数单位边界、H1 实机状态、
  临界阻尼稳定形式和不放大首峰的 C1 taper；v2.4 收紧 canonical 数值字段注册，
  并把无损瞬态与截尾策略的互斥关系提升为公开契约；v2.5 拒绝整数身份取整、
  收紧显式颤音 fade，并补齐 AVA 极端比率与全有限过阻尼域的稳定计算；
  v2.6 统一 correction 的 `magnitudeMu`、TechniqueIR anchor 与数值单位注册，
  并关闭二阶模型有限输入乘积溢出和 `$ref` 数值字段漏审计；v2.7 关闭 AVA/颤音/
  correction 的派生数值溢出、量化后正数归零、安全 ordinal 与 `oneOf` 默认值污染；
  v2.8 固定 transition 从连续绝对音高到 `pitchDelta` 的 score-step 映射，
  并把 canonical 量化后的 schema/关系复验与 MCP 错误证据纳入终审矩阵
- 仓库基线：`0c91ebf`（SV Copilot `0.9.0`）
- 文档性质：**终版**。综合两轮独立评估与两轮交叉验证后的裁定，取代前序结论中的冲突部分
- 前序输入（**7 组、9 个物理文档**，均未修改）：

| # | 文档 | 轮次 | 作者 |
|---|---|---|---|
| 1 | [`source-research.md`](../archive/2026-08/pitch-techniques/source-research.md) | 上游 | 外部深度研究 |
| 2 | [`opus-feasibility-assessment.md`](../archive/2026-08/pitch-techniques/opus-feasibility-assessment.md) | 第一轮 | Opus |
| 3 | [`opus-implementation-plan.md`](../archive/2026-08/pitch-techniques/opus-implementation-plan.md) | 第一轮 | Opus |
| 4 | [`sol-feasibility-report.md`](../archive/2026-08/pitch-techniques/sol-feasibility-report.md) | 第一轮 | 5.6Sol |
| 5 | [`sol-implementation-plan.md`](../archive/2026-08/pitch-techniques/sol-implementation-plan.md) | 第一轮 | 5.6Sol |
| 6 | [`opus-cross-validation-report.md`](../archive/2026-08/pitch-techniques/opus-cross-validation-report.md) + [`opus-reconciled-plan.md`](../archive/2026-08/pitch-techniques/opus-reconciled-plan.md) | 第二轮 | Opus |
| 7 | [`sol-cross-validation-report.md`](../archive/2026-08/pitch-techniques/sol-cross-validation-report.md) + [`sol-reconciled-plan.md`](../archive/2026-08/pitch-techniques/sol-reconciled-plan.md) | 第二轮 | 5.6Sol |

配套执行计划：[implementation-plan.md](implementation-plan.md)

## 1. 终版结论

**立项可行。** 但立项性质必须准确表述为：

> 在一个**执行平台已基本完备**的 MCP 服务上，补齐缺失的**研究模型层**、
> **宿主组合语义证据**和**拟合层**。

不是"新建 Python 音高管线"，也不是"从 60% 处继续"——后者是第一轮 Opus 评估的用词，
经 5.6Sol 校正后应改为定性表述（见 §3.1）。

四轮评估收敛到的可执行路线：

```text
宿主不确定性 → 可版本化证据
     ↓
可解释前向模型（端点归一 Richards + 欠阻尼首峰瞬态 + 秒域颤音）
     ↓
扩展现有 plan_pitch_gesture（不新建近义 planner）
     ↓
宿主实际插值的事务后置验证（超限即 rollback，不是 warning）
     ↓
单步开环校正
     ↓
benchmark 决定拟合后端 → 只读逆向分析
     ↓
条件启用：单 operation / 单 Undo 的有界闭环
```

## 2. 交叉验证中被推翻的结论（含本方自身）

这是本轮最有价值的部分。以下每条都经数值或代码验证，**不是意见分歧**。

### 2.1 Opus A1 的 Richards 契约被数值推翻 —— 5.6Sol 正确

第一轮 Opus 执行计划 A1 要求"端点严格命中 `y₀`/`y₁`"，并给出：

```
r(t) = exp(-logaddexp(0, log B - G(t - t_R)) / B)
```

5.6Sol 指出这是以 0/1 为**渐近线**的曲线，在有限 `t=0`/`t=T` 不等于 0/1，
并给出反例数值。**本轮独立复算，逐位命中：**

```
B=1, sharpness=6, inflectionRatio=0.5, T=1
  r(0) = 0.04742587317756678   ← 5.6Sol 声称值，完全一致
  r(T) = 0.9525741268224334    ← 完全一致
  校验：1/(1+e³) = 0.04742587317756678
```

提高 sharpness 只能把端点误差压小，不能消除（`sharpness=40` 时仍有 `2.06e-9`，
且此时曲线已退化为近乎阶跃，失去技法意义）。因此 A1 的公式与其自身退出条件
**自相矛盾**。

5.6Sol 的仿射归一化修正：

```
u(t) = (q(t) − q(0)) / (q(T) − q(0)),  q = rawRichards
```

本轮验证其**同时满足两个必要性质**：

- `u(0)=0`、`u(T)=1`（严格命中，非容差内）；
- **拐点位置不移动**：对 `B ∈ {0.35, 1.0, 3.0}`，归一化后最大斜率点数值定位
  均为 `t=0.5000`，与 raw `t_R=0.5` 一致。仿射变换不改变拐点位置，这是必然的，
  但值得记录——它证明归一化没有牺牲参数的音乐可解释性。

**裁定**：A1 原契约 `rejected`；`richards_segment_normalized` `accepted`。
必须提供两个**不同命名**的函数（分析用渐近 Richards、编译用有限段归一 Richards），
不得共用一个名字——拟合参数与有限段参数不可互换。

### 2.2 Opus A2 的首峰参数化被代数推翻 —— 5.6Sol 正确

第一轮 Opus A2 同时要求：`dampingRatio ∈ [0,1)`、覆盖"四个阻尼分支"、
用 `(A_peak, t_peak, ζ)` 作为统一公开参数化。5.6Sol 指出三重问题。本轮复核：

```
ω_n = arccos(ζ) / (t_peak · √(1−ζ²))

  ζ=0      → ω·t_peak = 1.570796  (= π/2) ✓
  ζ=0.7    → 1.113781  ✓
  ζ=0.9999 → 1.000033  ✓
  ζ=1.0    → arccos(1)/√0 = NaN     ← 0/0
  ζ=1.5    → arccos(1.5) = NaN      ← 定义域外
```

三项确认：

1. **该形式的公式对 `ζ>1` 无定义**（`arccos` 定义域为 `[−1,1]`）。
2. **计数错误**：Opus 写"四个分支"却只列欠阻尼/临界/过阻尼三个阻尼区间。
   对照 Saitou 原文，其 Eq.(2) 确实给出**四个**非负阻尼 case：`ζ>1`、`0<ζ<1`、
   `ζ=1`、`ζ=0`。第四个 `ζ=0` 是无损振荡（论文用于 vibrato），
   属欠阻尼的边界特例。所以"四个分支"对应论文分类是成立的，
   但 Opus 只列了三个，自身前后不一致。
3. **schema 自相矛盾**：`[0,1)` 排除了 `ζ=1`，却要求临界分支可达。

**修订（v2）：原报告此处有一处数学错误，本轮已推翻自身表述。**

原文写"过阻尼冲激响应单调无振荡，'首个振荡峰'这个概念本身不存在"。
这是错的。过阻尼冲激响应（论文 Eq.(2a)，`ζ>1`）：

```
h(τ) = k/(2ω√(ζ²−1)) · (e^{(−ζ+√(ζ²−1))ωτ} − e^{(−ζ−√(ζ²−1))ωτ})
```

在 `τ=0` 处为 0，先上升到一个极大值再衰减 —— 它是**非振荡但单峰**，不是单调。
本轮数值复算确认峰位有闭式解：

```
ω·t_peak = acosh(ζ) / √(ζ²−1),   ζ > 1

  ζ=1.2 → 数值 argmax 0.93800 | 解析 0.93825  ✓
  ζ=2.0 → 数值 argmax 0.76000 | 解析 0.76035  ✓
  ζ=5.0 → 数值 argmax 0.46800 | 解析 0.46794  ✓
```

且三个阻尼区间的峰位是**同一个连续族**：

```
  ζ=0.99   (欠) → 1.00334672
  ζ=0.999  (欠) → 1.00033347
  ζ=1      (临) → 1.00000000   （精确：τ=1/ω）
  ζ=1.0001 (过) → 0.99996667
  ζ=1.01   (过) → 0.99667994
```

即 `arccos(ζ)/√(1−ζ²)`（`ζ<1`）、`1`（`ζ=1`）、`acosh(ζ)/√(ζ²−1)`（`ζ>1`）
三段在 `ζ=1` 处连续衔接。因此 `(A_peak, t_peak, ζ)` 参数化**数学上可覆盖全部三个区间**，
只是需要按区间选择对应的闭式。

**裁定（修订后）**：统一 schema 仍 `rejected`（`[0,1)` 与"临界可达"的矛盾成立），
但拆分理由改为**产品范围选择**而非数学不可行：

- 内部 `secondOrderImpulse({naturalAngularFrequencyRadPerSecond, dampingRatio, numeratorRatePerSecond, ...})`
  —— 覆盖论文 Eq.(2) 的四个 case；
- 公开 `transientFromFirstPeak({peakSemitone, peakTimeSeconds, dampingRatio, ...})`
  —— **v1 有意限定 `0 ≤ ζ ≤ 1`**，因为 overshoot/preparation 是振荡回弹技法，
  过阻尼首峰虽可算但音乐意义弱（无回弹，退化为一次缓慢隆起）；
  `ζ>1` 返回结构化拒绝，错误消息须说明这是**范围选择**，不是"无法计算"；
- 若后续需要过阻尼技法，扩展同一 family 的 `ζ>1` 分支即可，无需新建 family。

### 2.2b 二阶模型的 `2π` 与分子单位缺口（v2.2 修正本报告自身）

本报告 §3.2 原写"Saitou 参数以 rad/ms 表述，秒域实现须 ×1000"。
这句话本身没错，但**不足以防止实现错误**，而且与前一版执行计划里名为
`naturalHz` 的字段组合起来会产生 `2π` 倍误差；v2.3 已删除该字段。

论文的传递函数是：

```
H(s) = K / (s² + 2ζΩs + Ω²)
```

其中 `Ω` 是**角频率**（rad/时间），不是频率（Hz）。本项目以
`h_seconds(t)=h_milliseconds(1000t)` 定义时域响应参数；冲激响应振幅含
`K/Ω`，所以 `Ω` 与该响应分子参数必须同时乘 1000，只换 `Ω` 会把振幅
缩小 1000 倍。若改写由秒域单位面积 Dirac 冲激驱动的传递函数，分子系数与
冲激面积还会分别多出 `1000` 与 `1/1000`；执行计划 F2b 已明确区分，
公开实现不暴露这种归一化含糊的 `gain`。

| 技法 | 论文 `(Ω, ζ, K)` | 保持时域响应的秒域 `(ω, ζ, k_response)` |
|---|---|---|
| overshoot | `(0.0348, 0.5422, 0.0348)` | `(34.8, 0.5422, 34.8)` |
| preparation | `(0.0292, 0.6681, 0.0292)` | `(29.2, 0.6681, 29.2)` |
| vibrato | `(0.0345, 0, 0.0018)` | `(34.5, 0, 1.8)` |

无损颤音分支给出独立幅度校验：`K/Ω = 0.0018/0.0345 = 1.8/34.5
= 0.0521739`，与论文报告约 5.2% 一致。只缩放 `Ω` 会错误得到 0.0052%。

`34.8 / 5.539 = 6.2832 = 2π`。若把 `34.8` 传给一个名为 `naturalHz` 的字段，
所有峰值时间与衰减时间常数都会偏 `2π ≈ 6.28` 倍 —— 一个 65 ms 的 overshoot
会变成 10 ms 或 409 ms，而单元测试若同样用错单位则不会发现。

**裁定**：内部模型字段一律命名
`naturalAngularFrequencyRadPerSecond` 与 `numeratorRatePerSecond`，二者都承载
`论文值 × 1000`；**不引入 Hz 字段或无单位 gain**。理由：`H(s)` 与三个阻尼区间
的冲激响应闭式都以角频率表述，引入 Hz 只是在每次调用处插入一次 `2π` 换算机会。

例外：颤音的 `rateHz` 保持 Hz —— 它是可感知的振动次数/秒，是自然参数域，
且现有 `pitch-gesture-plan.js` 与 `expression-plan.js` 已用 `rateHz`。
两者不共用字段名，因此不会混淆。这与仓库既有的"单位进字段名"纪律一致。

可运行 reference implementation 与独立数值测试位于
`reference/model.mjs` 和 `reference/model.test.mjs`。测试不仅复写闭式，还检查
微分方程残差、AVA 拐点、首峰命中、C1 taper、null-run 零耦合与量化碰撞。
AVA 拐点使用 `log(B)-log(A)`，避免两个有限正数先相除而溢出；过阻尼闭式使用
缩放根式与 `-ω/(ζ+√(ζ²-1))` 慢极点，并在对数域组合极值乘积，保证有限参数
不因 `ζ²`、`ωt` 或 `(ζ-1)(ζ+1)` 的中间溢出泄漏 `NaN`；无法解析的无阻尼超大
相位结构化拒绝。AVA 有限段最终输出使用凸组合，时变颤音的重叠 fade 用比率归一；
无法表示的 span/fade/phase/output 均结构化拒绝。identity/BLICK 则不参与浮点量化，
只接受公开 schema 已约束上界的安全整数。

### 2.3 Opus "K 轮闭环 = K 或 2K 个 Undo"被代码推翻 —— 5.6Sol 正确

第一轮 Opus 把"每轮迭代一个用户 Undo"当作硬约束，并据此质疑闭环的产品可行性。
5.6Sol 指出这误读了 `newUndoRecord()` 的分组语义。本轮读码确认：

`server/src/parameter-curve.js`：

```
:407   newUndoRecord()        ← 开边界
:410   runChunkedMutation(…)  ← 多次写入 + 读回 + 必要时逆序补偿
:1587  newUndoRecord()        ← 关边界（closeBoundary）
```

`server/src/pitch-control-patch.js:26` 注释原文：
"正式提交最多一个用户可见 Undo（开边界 + 关边界 = 2 次 `newUndoRecord`）"。

官方 `newUndoRecord()` 描述："all edits following the last undo record will be
undone/redone together"。所以**一对边界之间的任意多次写入 = 一个用户 Undo**，
这正是现有事务已在做的事。

**裁定**：Opus 的"K 或 2K 是硬约束" `rejected`。单 operation / 单 journal /
单对边界内的 K 次候选写入，**架构上可以只形成一个用户 Undo**。

但 `host-gated`，未证明前不承诺。真实风险转移到别处（这是 Opus 关注点中仍然有效的部分）：

- computed pitch 异步等待使事务持锁时间显著变长；
- 宿主是否在长时间异步处理期间维持预期 Undo grouping —— **未经真机确认**；
- setter 之后 bridge disconnect / host timeout，状态可能不可证明；
- 每次拒绝候选都必须恢复并读回。

### 2.4 Opus 的公开 surface 计数错误 —— 5.6Sol 正确，且牵出仓库文档漂移

第一轮 Opus 反复写"42 operations / 7 facade tools"。本轮机械统计：

```
server/src/index.js   `    name: "sv_…"` 条目  = 41
operation-catalog.js  FACADE_BY_TOOL 唯一登记  = 41   （两集合互为子集，零差异）
facade 分组：read 10, edit 9, audition 7, plan 5, raw 5, status 4, artifact 1
公开工具名 = 7 个 facade + sv_describe = 8
```

正确表述：**41 个 routed operation，8 个公开工具名**。

**附带发现（两份交叉验证都未提及）**：`CLAUDE.md` 自身也已漂移——
它写"42 internal tools"（实际 41）与"`MAX_DESCRIBE_OPERATIONS` is 2"
（`compact-facade.js:21` 实际为 `16`）。这不影响本项目立项判断，
但应在下一次触及该文件时顺手校正。**注意 `CLAUDE.md` 是本地维护的仓库指引，
该校正属本地维护动作，不作为本计划的交付提交项**（见执行计划 §17 提交序列不含此项）。

### 2.5 Opus 的三项论证强度不足 —— 5.6Sol 正确

| Opus 原表述 | 裁定 | 修正 |
|---|---|---|
| clean-room 政策 ⇒ 不引入 Python | **论证无效** | 政策记录的是"当前发布未复制第三方代码"，不构成对未来运行时的永久禁令。语言选择应由 benchmark 决定，而非政策口号 |
| "有乐谱时 score-informed 严格优于 HMM" | **过强** | 音符边界是强先验但非 oracle：真实 portamento 可提前、滞后或跨边界。正确表述是"首版先用 score-informed，只有 host corpus 显示漏检才评估 HMM" |
| "computed pitch 比 F0 干净 ⇒ 鲁棒性需求大幅降低" | **半对** | 可以去掉 MAD 离群过滤与音高跟踪器容错；但 null、突变、低采样率、宿主模型伪影、过渡重叠和旧结果依然存在，robust loss / 多起点稳定性检查 **不得删除** |

### 2.6 Opus "尾部须在音符边界前 < 1 cent" —— 5.6Sol 正确

overshoot、preparation 与跨音符转换可以合法跨越音符边界。强制边界前衰减会排除
真实技法；硬截断又产生斜率不连续。正确约束是：**span 显式声明** +
超出 span 的尾部视为约束错误 + 可选的经验证连续 taper + epsilon 按目标 surface
的误差预算设定（而非硬编码 1 cent）。

### 2.7 5.6Sol 第一轮的三项被 Opus 修正（第二轮已接受，此处确认终版）

| 5.6Sol 第一轮 | 裁定 | 依据 |
|---|---|---|
| planner 请求含 `execution:{atomic, undoLabel}` | **删除** | 现有两个 planner 的 inputSchema 均不接受此类字段；`undoLabel` 只存在于 mutation 工具（`index.js:562`）。执行语义属 apply 侧，放进 plan 请求违背其自身"生成与执行分离"原则 |
| 响应预算 planner/analysis ≤ 4 KiB、error ≤ 2 KiB | **对齐 16/8 KiB** | `response-budget.js:12,18,21` 为 16/8/16 KiB，且被 `surface-io-policy.js` 同源导入以防文档与代码漂移。5.6Sol 第二轮自行改为"目标 ≤ 8 KiB"，是介于两者之间的收紧值，可接受 |
| 用 `sv_audition_compare` 做 blinded A/B | **不可行，降级** | 该工具 variant schema 只接受 `soloTrackIndices`，描述明确 "NEVER applies a temporary musical edit for variant B"。A/B "计划 vs 基线"需先把两版各自永久提交到两条轨，而克隆轨撞上 `setTarget` 一次性约束与 Singer 身份不透明 |

### 2.8 5.6Sol 的 RDP 改造要求部分已满足 —— Opus 正确

5.6Sol 第一轮 §8.5 要求"补充 vertical error，而非混合时间与音高的欧氏距离"。
`bake-computed-pitch.js:319` 的 `perpendicularDistance` 实际按时间参数插值后取
**音高绝对差** —— 已是垂直误差。函数名误导，但数学正确。

**裁定**：误差度量无需改造；只需补强制锚点（现仅保留首末点）并改名以免误导下一个读者。

## 3. 事实基线校正

### 3.1 "已完成 60–70%"的表述作废

第一轮 Opus 称"报告建议的首发范围约 60–70% 已实现"。5.6Sol 正确指出这不能作为
验收指标。终版表述：

> **执行平台基本完备**（Context/identity、双写面事务、PlanRef/Artifact/ledger、
> journal+读回+补偿、computed pitch 捕获与稳定轮询、人类试听编排、
> 秒/BLICK 分段换算、现有 transition/attack/release/vibrato 前向规划）。
>
> **未完成**：研究模型层（端点归一 Richards、拆分后的二阶瞬态、统一颤音语义）、
> **宿主组合语义证据**（双颤音、双写面、插值后置、重算延迟）、
> 逆向拟合层、等秒分析网格。

### 3.2 经四轮共同确认的官方事实（`confirmed`）

以下每条均由仓库内 SHA-256 跟踪的 manifest 原文或可重复推导直接证明：

| 事实 | 关键含义 |
|---|---|
| `Project` 无任何 revision/version 成员 | 上游报告的 `project_revision` 是虚构字段。身份只能靠 fingerprint + 读回 |
| 只有 `newUndoRecord()`，无 `undo()` | 无程序化撤销；回滚只能是补偿写 + 读回 |
| `NoteGroupReference.clone()` 不复制 target NoteGroup | 原文明示。隔离必须 `NoteGroup.clone()` 深拷贝 + 入库 + 新建 reference |
| `NoteGroupReference.setTarget()` "once set, the target can't be changed" | 既有 reference 无法重定向，隔离成本高于直觉 |
| `Automation` 有 `getInterpolationMethod`，**无 setter** | 误差保证是宿主状态的函数，不是本项目能选定的常量 |
| `Automation.getDefinition` 含 `"Vibrato Envelope" / vibratoEnv / range 0,2 / 默认 1` | 宿主自带颤音包络面 |
| `Note.getAttributes` 含 `dF0Vbr`、`dF0VbrMod`、`fF0Vbr`、`pF0Vbr`、`tF0VbrLeft/Right/Start` | 第二条宿主颤音面 |
| `PitchControlCurve` "overrides the generated pitch"，但**未定义**与 `pitchDelta` 的合成语义 | 双写面叠加关系是未知量，非保守起见 |
| `getComputedPitchForGroup` 绑定 `NoteGroupReference`，浮点 MIDI，无音高处 `null`，未完成返回**空数组** | 反馈必须作用于活 occurrence；离体对象不代表最终生成路径 |
| `Track.setBounced()` 只改 Render Panel 标记 | 无音频渲染原语 → 机器听感 `capability-blocked` |
| AVA 原式 `A·e^{−G(t−M)} = e^{logA+GM−Gt}`，仅 `logA+GM` 可观测 | `A` 与 `M` 同时自由不可辨识，重参数化是必需 |
| Saitou 参数以毫秒为时间基准（overshoot `Ω=0.0348, ζ=0.5422, K=0.0348`） | 秒域实现必须同时取 `ω=34.8 rad/s`、`k=34.8 s⁻¹`；只换 `Ω` 会让振幅缩小 1000 倍。若把角频率当 Hz，峰值时间再偏 `2π` —— 见 §2.2b |

### 3.3 开源溯源（7 个 pin 本轮全部校验）

5.6Sol 第一轮固定了 commit SHA，本轮用 GitHub API 逐个验证：

| 项目 | pin | 解析 | 许可证 | 最近推送 |
|---|---|---|---|---|
| skx300/ava | `77e4dfe` | 200 | Apache-2.0 | 2022-04-23（稳定） |
| hataori-p/real-voice | `172259a` | 200 | MIT | 2023-07-05（稳定） |
| Turbo49/SVScripts | `8825fbe` | 200 | MIT | 2026-07-28（活跃） |
| tiagolbc/vibratoscope | `a7a8d3b` | 200 | MIT | 2026-07-21（活跃） |
| SoulMelody/LibreSVIP | `983a595` | 200 | MIT | **2026-08-02 当日**（活跃） |
| openutau/OpenUtau | `29e0e16` | 200 | MIT | `stakira/OpenUtau` 已 301 重定向至此 |
| MCP Python SDK | `v2.0.0` | — | MIT | 2026-07-28 |

引用文件在对应 SHA 下抽查存在：`ava@77e4dfe` 的
`Logistic_Modeling-package/createGeneralLogistic6Fit.m`、`HMM-package/ViterbiAlgHMM.m`、
`HMM-package/portamentoDetc.m`、`FDM-package/`；
`OpenUtau@29e0e16` 的 `OpenUtau.Core/Ustx/UNote.cs`、`OpenUtau.Core/Render/RenderPhrase.cs`。

**收紧要求**：这 7 个 pin 均为写作时 HEAD 而非"审阅存档时"。三个活跃仓库
（尤其 LibreSVIP 当日仍在变动）必须改为审阅并抓取 LICENSE/NOTICE 时的 SHA，
并在 `THIRD_PARTY_NOTICES.md` 记录抓取日期。

Saitou 论文按 5.6Sol 判定处置：JAIST 保存稿为 CC BY-NC-ND 4.0，
可独立实现数学方法，不得复制论文文本、图表或参数表编排。

## 4. 仍然开放的宿主未知量

以下必须在可恢复真机实验中变成版本化证据，**在此之前相关 schema 组合必须拒绝**。

| # | 未知量 | 为何阻塞 | 判定 |
|---|---|---|---|
| H1 | Node 自建秒↔BLICK 换算与宿主 `TimeAxis` 的一致性 | 2026-08-04 的 600 点三场景实机证据覆盖恒速、单点阶跃和密集变速，见 §5.2 | `confirmed`；Node 分段换算不再阻塞 Hz 门禁 |
| H2 | `vibratoEnv` / `dF0VbrMod` 与显式正弦的组合关系（相加/覆盖/缩放） | 双重颤音是高可信风险，但叠加公式未经官方证明 | `host-gated`，阻塞任何显式颤音发布 |
| H3a | `PitchControlCurve` 覆盖区间内 `pitchDelta` 是否仍参与结果 | 决定两个写面能否并列，以及跨面处置策略 | `host-gated` |
| H3b | absolute MIDI/score/occurrence offset 与 group-relative PitchControl anchor/point 的坐标变换 | 决定 TechniqueIR 能否正确编译到 PitchControl；H3a 不能回答 | `host-gated` |
| H4 | `PitchControlCurve.getValueAt()` 的内部插值族 | 决定 PitchControl 侧的压缩误差界 | `host-gated`（可用密集采样反推） |
| H5 | 写入后 computed pitch 的重算延迟与稳定判据 | 决定闭环轮数与外层预算是否算术可行 | `host-gated` |
| H6 | 写入后是否曾返回**旧的非空**结果（而非空数组） | 若会，则就绪判据必须是内容哈希而非"非空"（现有实现已用 `contentHash`，此实验是确认其必要性） | `host-gated` |
| H7 | 宿主是否在长时间异步处理期间维持预期 Undo grouping | 决定单 Undo 闭环是否成立 | `host-gated`，需人工观察一次 Ctrl+Z |
| H8 | 宿主生成的 computed pitch 是否包含 fine fluctuation（>10 Hz） | 决定 residual 的解释方式 | `host-gated`，需高密度采样 |

## 5. 唯一存活的单方独有发现：H1

两轮交叉验证中，**只有一项发现未被对方覆盖，且经核验为真**：

> **规划路径从不调用宿主 `TimeAxis`。**

代码事实：

- `server/src/musical-time.js:130 secondsAtBlick()` / `:144 blickAtSeconds()`
  用**快照捕获的 tempoMarks** 做分段线性积分：
  `positionSeconds + ((blick − positionBlick)/quarterBlick) × (60/bpm)`
- 全仓库唯一调用宿主 `getSecondsFromBlick` 的位置是
  `server/src/audition.js:66-67`（试听区间换算）
- `sv_plan_pitch_gesture` 与 `sv_plan_expression` 的颤音都经
  `secondsAtBlick`/`blickAtSeconds` 换算，**一次都没问过宿主**

因此"颤音 Hz 在变速下不漂移"这一保证，实际依赖 Node 侧分段线性模型与
SynthV 内部 `TimeAxis` 的逐点一致性。§5.1 的恒速局部证据已经由 §5.2 的完整变速矩阵
取代，Node 分段换算已获得实机确认。

**与 5.6Sol §5.1 的关系：两者是不同的问题，都真实存在。**

| | 5.6Sol §5.1 | 本报告 H1 |
|---|---|---|
| 问题 | 固定 `blickInterval` 采样在变速处**不是等秒网格** | Node 换算模型与**宿主**换算是否一致 |
| 层次 | 分析侧网格（拿到数据之后） | 换算内核本身（生成与分析都用） |
| 代码证据 | `computed-pitch-compare.js:1026 frameRateAt()` 只在单个 BLICK 位置算**标量**局部帧率，整条序列仍非均匀秒网格 | `musical-time.js:130/144` 从不与宿主比对 |
| 修复 | 逐 frame 映射为绝对秒 + 只在 finite run 内重采样 | 只读探针比对；若判定 Node 模型不可信，走**批量 opcode**（执行计划 §7.1a），**逐点调用不是生产选项** |

两者都必须做。若只做 5.6Sol 的重采样而 H1 有偏差，重采样会把一个错误的秒轴
"精确地"均匀化——误差反而更难发现。

**为何必须前置**：所有 Hz 类门禁（离线 0.5%、真机 1%）都建立在这个未验证的
换算内核上。若宿主支持 tempo ramp 而 Node 侧按阶跃处理，或双方对 tempo mark
边界取整不同，门禁会系统性不达标，**而调试会指向模型而非换算**。

### 5.1 2026-08-03 DEV file bridge 只读结果

当前 120 BPM 恒速工程上，45 个位置（含 `QUARTER±1` 与工程末端）得到
`maxSecondsError=0`、`maxRoundTripBlickError=1`。这把 H1 从“完全未测”推进为
`partially_observed`，但单 tempo mark 不能覆盖阶跃/密集变速，故仍不解锁 Hz 门禁。

同一 373-note target 的实例证据为：`pitchDelta` 与 `vibratoEnv` 的
`getInterpolationMethod()` 均返回 `"cubic"`；definition 分别是
`[-1200,1200], default 0` 与 `[0,2], default 1`。这不是全局常量，
但已证明文档不能预设 `vibratoEnv=Linear`，必须逐实例捕获。

### 5.2 2026-08-04 完整 TimeAxis H1 结果

SynthV 2.2.1、bridge protocol 2 下，恒速、单点阶跃与多点密集变速各完成 200 个位置的
双向 TimeAxis 读探针。每个场景都包含 tempo mark 的 `-1/0/+1`；原始 Artifact 见
[constant](evidence/T02-time-axis-constant-live-v2.json)、
[tempo step](evidence/T02-time-axis-tempo-step-live.json) 与
[dense tempo](evidence/T02-time-axis-dense-tempo-live.json)。

聚合 600 点的 Node 秒值最大偏差为 `1.4210854715202004e-14 s`，宿主 BLICK 往返最大偏差为
`1`。H1 为 `confirmed`，T03 裁定 `not_required`，Node 分段换算可作为生产时间映射；tempo
ramp 未被观测，相关 capability 仍保持 `unknown`。

## 6. 终版能力判定矩阵

| 能力 | 判定 | 首发优先级 | 关键条件 |
|---|---|---|---|
| 端点归一 Richards 前向模型 | `confirmed feasible` | P1 | 端点误差 ≤ 1e-12；拐点归一化后不移动 |
| Richards transition→`pitchDelta` | `confirmed feasible` | P1/P2 | 工程映射 `C(t)=100·(P(t)-S(t))`；边界跳变抵消 score step；等音高公开返回 `no_change`；短音符和越界大音程结构化拒绝 |
| 欠阻尼首峰 transient（`0≤ζ≤1`，v1 范围选择） | `confirmed feasible` | P1 | 独立峰值上限；显式 span + tailPolicy；`ζ=0` 必须显式 continuous taper；`ζ>1` 按范围拒绝（非数学不可行） |
| 通用三区间二阶响应 | `confirmed feasible` | P1（内部库） | 不作为同一公开 schema |
| 秒域时变颤音 | `confirmed feasible` | P1 | 统一 phase/fade/drift 语义；显式分支 fade 必须为正，禁止隐式 hard edge |
| TechniqueIR | `confirmed feasible` | P1 | **内部** canonical，不复制为公开 surface；数值字段 schema 是 unit/domain/quantum/owner 的单一数据源；量化后重跑分支 bounds/relations 才能 hash |
| 等秒分析网格 | `confirmed feasible` | P1 | 保留 null mask；禁止跨 gap 插值 |
| 秒↔BLICK 换算一致性 | `host-gated` | **P0 gate** | H1，阻塞所有 Hz 门禁 |
| 宿主插值事务后置验证 | `confirmed feasible` | P2 | 超 epsilon → rollback，非 warning |
| 编译到 `pitchDelta` | `confirmed feasible` | P2 | additive 语义；预合成 final points 后 replace；capsule 封存 baseline fingerprint/插值并后置验证 |
| 编译到 `PitchControlCurve` | `host-gated` | **P2b 条件** | 需 H3a 共存、H3b 坐标往返、H4 插值；不阻塞 MVP RC |
| 显式颤音发布 | `host-gated` | P2 gate | H2 真机矩阵 |
| 双写面共存 | `host-gated` | P2b gate | H3a；未确认前 preflight 零写入拒绝。MVP 单写面不触及此项 |
| 单步开环 correction | `confirmed feasible` | P3 | 仅针对 retain target 的纯 additive PlanRef；absolute-cent target；五对角 Cholesky O(n)，`μ>0`，按 finite run 分块 |
| 有界鲁棒非线性拟合 | `benchmark-gated` | P4 | 统一 adapter；不预设语言 |
| score-informed 技法分解 | `supported` | P5 | host corpus 的 precision/recall |
| HMM 分段 | `evidence-gated` | 后续 | 仅当 heuristic 显示漏检 |
| 单 Undo 有界闭环 | `host-gated` | P7 条件 | H5+H7 + 全故障注入 |
| 任意录音 F0 分析 | `capability-blocked` | 不进入范围 | 需另加音频输入产品面 |
| 程序化渲染 / 自动听感评分 | `capability-blocked` | 不进入范围 | 官方无渲染原语，MCP 无音频输入 |
| 自动化 blinded A/B 服务 | `capability-blocked` | 不进入范围 | §2.7：需双轨制备 + 被 `setTarget` 阻塞 |
| 通用歌手校准 | `capability-blocked` | 不进入范围 | Singer 身份不可观测 |

P3 的可行性依赖一个明确参考系，而不是抽象的 `target-observed`：
`targetAbsoluteCent = 100×baselineComputedMidi + plannedContributionCent`，
`observedAbsoluteCent = 100×observedComputedMidi`。因此 P2 仅在调用方显式要求且
Context 已捕获 computed pitch 时，把 baseline 与 contribution 封进同一个 PlanRef；
P3 以 `sourcePlanRef + observedContextId` 消费，普通 MCP 请求/响应不搬运 dense target。
触及 `vibratoEnv` 的计划在 H2 未给出确定变换前不提供 correction target。

## 7. 终版架构裁决

```text
LLM
 │  compact semantic request
 ▼
现有 Node MCP facade（8 个公开工具名 / 41 routed operations）
 ├── Context / occurrence ordinal / note index / fingerprint
 ├── TechniqueIR（内部 canonical）+ 前向模型
 ├── composer / surface compiler / 开环五对角求解器
 ├── PlanRef / Artifact / ledger
 └── 唯一事务权威：host handle、setter、Undo 边界、journal、verify、rollback
 │
 ├─── 可选 FitWorker adapter（仅当 benchmark 选中）
 │      · 语言无关纯数值子进程
 │      · 不是第二个 MCP
 │      · 无 host handle、无写权限、不生成最终 plan hash
 ▼
现有 PIPE bridge → loaded SynthV Lua host script
```

不可违反的所有权边界：

1. Node 生成 canonical TechniqueIR 与 plan hash；
2. worker 只返回拟合候选与诊断，Node 必须**重新**校验 bounds、
   用 canonical Node 前向模型复算曲线、复算 metrics、判定 identifiability；
3. 只有 Node transaction service 能调用 setter 与 `newUndoRecord()`；
4. dense samples、multi-start 轨迹、residual 曲线一律进 Artifact；
5. LLM 普通响应只见参数、摘要、warnings 与 apply envelope。

## 8. Go / No-Go 终版裁决

### 8.1 立即 Go

- H1 换算一致性只读比对（**最高优先，阻塞其余 Hz 门禁**）；
- host behavior profile v2 + 可恢复真机探针（H2–H8）；
- 端点归一 Richards；
- 欠阻尼首峰 transient + 内部通用四 case 二阶模型（论文 Eq.(2)）；
- 秒域时变颤音；
- 等秒分析网格（含 null mask 纪律）；
- TechniqueIR 内部化 + 扩展现有 `plan_pitch_gesture`
  （**前置：先执行执行计划 §9.0 的 planner 语义所有权裁定** ——
  `plan_expression` 已在 `pitchDelta` 上生成 scoop/fall/portamento/vibrato，
  不先划清归属就会出现两个近义 planner）；
- 宿主实际插值的事务后置验证（逐参数证据）；
- 单步开环 pitch correction（`μ>0` + 按 finite run 分块）；
- synthetic corpus + FitWorker adapter 契约。

### 8.2 条件 Go

| 能力 | 解锁条件 |
|---|---|
| 显式颤音 | H2 确认组合关系 |
| 双写面共存 | H3a 确认 + 跨面统一事务实现并验收 |
| PitchControl 编译 | H3b 坐标往返 + H4 插值证据 |
| 逆向拟合公开 operation | P4 benchmark + synthetic recovery + host corpus 达标 |
| 单 Undo 闭环 | H5+H7 + 单 operation/单 Undo/故障恢复门禁全通过 |
| HMM 分段 | score-informed 在 host corpus 上显示漏检 |

### 8.3 No-Go

- 第二个 MCP 服务；
- 把任何语言（Python / JavaScript / Rust）作为**未经 benchmark** 的预设答案；
- `project_revision`；
- 成功提交后的通用 `restore_transaction`；
- 程序化 Undo；
- 自动音频听感评价与自动化 blinded A/B 服务；
- 宿主语义未确认时自动叠加两种 pitch surface 或两种 vibrato source；
- 为勾选路线图而降低 Undo 或恢复契约。

## 9. 四轮评估的方法论收获

值得记录，因为它解释了为什么终版结论可信：

1. **两个独立评估收敛于同一方向**（不新建 MCP、复用现有事务、否决虚构字段）
   —— 且证据路径不同（一方走 surface/模块边界，一方走宿主 API 边界），
   收敛本身构成可信度证据。
2. **交叉验证真正推翻了双方各自的具体错误**，而非互相背书。
   最有价值的三项都是**可数值/代数/代码判定**的：Richards 端点（数值反例逐位命中）、
   首峰参数化定义域（`arccos` 定义域）、Undo 分组语义（读现有事务代码）。
   意见分歧不产生进展，可证伪的断言才产生进展。
3. **"论证无效"与"结论错误"必须分开**。Opus 的"不引入 Python"结论可能是对的，
   但用 clean-room 政策去证明它是无效论证；替换为 benchmark 门禁后，
   同一结论获得了可检验的依据。
4. **共同盲区最危险**。H1 在四份文档、两轮交叉验证中都不存在，
   却是所有 Hz 门禁的前置条件。两个评估者查同一份官方文档时，
   会同样地把"已有基础设施"当作已验证。

## 10. 核验来源

**官方 API** —— 仓库内 SHA-256 跟踪镜像 `api-docs/api-manifest.json`
（23 classes / 370 method names / 371 overloads，生成自
<https://resource.dreamtonics.com/scripting/>）：
`SV.getComputedPitchForGroup`、`SV.setTimeout`、`SV.create`、
`Automation.getDefinition`/`getInterpolationMethod`/`get`/`getLinear`/`simplify`、
`PitchControlCurve.setPoints`/`getValueAt`、`NoteGroup.addPitchControl`、
`NoteGroupReference.clone`/`setTarget`/`getTimeOffset`/`getVoice`、
`Note.getAttributes`、`Project`（方法全集）、`TimeAxis`。

**源码**（`0c91ebf`）：
`musical-time.js:130,144`；`audition.js:66-67`；`response-budget.js:12,18,21`；
`expression-plan.js:63,438,459,730,989`；`expression-gestures.js:262`；
`bake-computed-pitch.js:271,289,319`；`parameter-curve.js:41-69,407,1326,1440,1587`；
`pitch-control-patch.js:26,195,923`；`computed-pitch-compare.js:1026`；
`transport-pipe.js:29-35`；`StartSynthVCopilotPipe.lua:6,571`；
`operation-catalog.js`；`compact-facade.js:18,21,25`；`index.js`。

**数值复算**（本轮独立执行）：Richards 有限端点反例与仿射归一化的端点/拐点性质；
极端有限 `A/B` 的 log-difference 拐点；`arccos(ζ)/√(1−ζ²)` 在 `ζ→1`、`ζ=1`、
`ζ>1` 的行为与临界阻尼峰位吻合性；`ζ∈{1e155, Number.MAX_VALUE}` 的过阻尼
响应、导数与首峰因子保持有限。

**一手文献**：Saitou, Unoki, Akagi,
[Speech Prosody 2004](https://sprosig.org/sp2004/PDF/Saitou-Unoki-Akagi.pdf)
（Eq. 2 与参数表）；Yang, Rajab, Chew,
[AVA, ISMIR 2016](https://archives.ismir.net/ismir2016/paper/000314.pdf)
（Eq. 2–3 generalized logistic）；SciPy `least_squares` 文档；
MCP Python SDK v2.0.0 release notes。

**GitHub API**：7 个依赖仓库的 commit 解析、许可证、推送时间与引用文件存在性。
