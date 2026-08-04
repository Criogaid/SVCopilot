# 深度研究报告可行性评估

评估对象：[source-research.md](source-research.md)
评估基线：SV Copilot v0.9.0（42 operations / 7 facade tools），`api-docs/api-manifest.json`
（23 类、370 方法，SHA-256 跟踪的官方 Scripting Manual 镜像）
评估日期：2026-08-02

---

## 1. 总体结论

研究报告的**数学内核与工程纪律是可靠的**，但它是按 greenfield Python 项目写的，
与本仓库的实际状态存在系统性错配。逐条核对后：

| 维度 | 判定 |
| --- | --- |
| 官方 API 事实声明 | **全部可核实为真**（1 处例外，见 §3.1） |
| 数学模型与参数 | **可核实为真**，Saitou 参数、AVA 可识别性问题、Richards 重参数化均正确 |
| 外部开源与许可证声明 | **可核实为真**（AVA、VibratoScope、MCP Python SDK v2.0.0 均已验证） |
| 「首个版本」范围 | **约 60–70% 已在本仓库实现**，且是 Node 而非 Python |
| 真正的新增价值 | 二阶瞬态模型、广义 logistic、闭环校准、逆向拟合 —— 4 项确有能力缺口 |
| 被低估的可行性障碍 | **6 项**，其中 1 项是硬约束（§3.3 闭环必须写活工程） |
| 与本项目既有契约的冲突 | **3 项**（Undo 预算、无第三方 vendored 代码、无音频面） |

**总判定：有条件可行。** 建议不按报告的路线图执行，而按本文 §5 的四层分级：
Tier 1 立即可做且不引入新运行时；Tier 2 需要真机 Phase 0 证据与显式预算决策；
Tier 3 昂贵但可行；Tier 4 是 `capability-blocked`，应从范围中移除而不是"延后研究"。

---

## 2. 已核实为真的部分

### 2.1 官方 API 声明

逐条对照 `api-docs/api-manifest.json`（下表全部命中，签名与描述一致）：

| 报告声明 | 核实结果 |
| --- | --- |
| `SV.getComputedPitchForGroup(groupReference, blickStart, blickInterval, numFrames)` | ✅ 签名完全一致，`supportedSince: 2.1.1` |
| 返回浮点 MIDI 半音；无音高处为 `null` | ✅ 原文 "an array of number (or null where no pitch data is available)" |
| 计算未完成时返回**空数组** | ✅ 原文 "If pitch computation hasn't completed for the group, this function returns an empty array" |
| `blickStart` 是加上 `NoteGroupReference#getTimeOffset` 后的绝对位置 | ✅ 官方 Note 段落逐字确认 |
| 同一 `NoteGroup` 经不同 reference 可算出不同音高（tempo / vocal mode 不同） | ✅ 官方逐字确认 |
| `pitchDelta` 范围 `[-1200, 1200]` cents | ✅ `Automation.getDefinition` 表格确认 |
| Automation 插值为 Linear / Cosine / modified Catmull-Rom | ✅ `getInterpolationMethod` 确认 |
| `PitchControlCurve` anchor position 相对 group 时间、anchor pitch 为半音 | ✅ 确认 |
| `setPoints` 取 `[相对 anchor 的 blick, 相对 anchor 的半音]` | ✅ 确认 |
| `PitchControlCurve` 覆盖（override）区间内生成音高 | ✅ 类描述逐字确认 |
| `Project.newUndoRecord()` 存在，且脚本开始时自动创建一条 | ✅ 确认 |
| 官方**没有**编程式 "execute undo now" | ✅ `Project.undo` / `getUndoStackSize` 在 manifest 中不存在 |
| `SV.setTimeout` 非抢占式 | ✅ 原文 "not a preemptive callback" |
| `TimeAxis.getBlickFromSeconds/getSecondsFromBlick` 是**绝对坐标**映射 | ✅ 签名 `(t)` / `(b)` 为单点转换，报告对"不是时长转换"的警告成立 |

### 2.2 数学与文献

- **Saitou 二阶模型**：传递函数 `H(s) = k/(s² + 2ζωs + ω²)`、四种阻尼分支的冲激响应、
  以及最优参数表（overshoot `Ω=0.0348 rad/ms, ζ=0.5422, K=0.0348`；
  vibrato `0.0345, 0, 0.0018`；preparation `0.0292, 0.6681, 0.0292`）与
  Saitou 等 2004 / WASPAA 2007 原文**逐值一致**。报告指出参数单位是 rad/**ms**、
  改用秒需乘 1000 —— 正确且是极易踩的坑。
- **vibrato 4–7 Hz、fine fluctuation >10 Hz、preparation 定义** —— 与原文一致。
- **AVA**：FDM 做颤音、三态 HMM + Viterbi 做 portamento、检测前先 flatten 颤音、
  最小时长 0.09 s、六参数 logistic 拟合 —— 与 ISMIR 2016 论文及 Yang 博士论文一致。
- **可识别性问题**：`A·e^{-G(t-M)} = e^{log A + GM - Gt}`，仅 `log A + GM` 可观测，
  故自由的 `A` 与 `M` 冗余 —— **数学上完全正确**，这是报告最有价值的单点贡献。
  固定 `A=B` 使 `M=t_R` 的 Richards 形式是等价重参数化，不改变曲线族。
- **线性插值误差界 `Mh²/8`** 与由此得到的 `h ≤ √(8ε/M)` —— 正确。

### 2.3 开源与许可证

| 项目 | 核实结果 |
| --- | --- |
| AVA (`skx300/ava`) | ✅ 存在，MATLAB，报告所列包目录名与论文模块一致 |
| VibratoScope (`tiagolbc/vibratoscope`) | ✅ MIT，已有 JOSS 论文，Python |
| MCP Python SDK v2.0.0 | ✅ **2026-07-28 发布**，对应 2026-07-28 规范，MIT，v1→v2 破坏性变更成立，"必须钉死精确版本"的建议正确 |

---

## 3. 报告的错误、遗漏与被低估的障碍

### 3.1 事实性错误：`project_revision` 不存在

报告的 `SV2GroupReferenceId` 包含 `project_revision: str`。**官方没有任何 revision 或
变更事件 API** —— manifest 中无此方法，主计划已把 "Project revision/event stream" 列为
`capability-blocked`。

后果：报告的"durable target identity"第一个字段就无法填充。必须替换为本仓库已实现的
方案：内容 fingerprint + 读回校验（`note-fingerprint-reader.js`、
`pitch-control.js` 的 `computeControlFingerprint`）。报告在风险表里写"planToken 不能
跳过 live preflight"的同类结论，但在数据结构里又假设了 revision，前后不一致。

### 3.2 Automation 的插值方法**只能读不能设**

`Automation` 的方法全集里有 `getInterpolationMethod()`，**没有 `setInterpolationMethod`**。

报告的曲线编译流程写着"compile with **explicit interpolation**"（显式指定插值），
这一步不可执行。插值模式是宿主/用户控制的状态，实现只能**读取并适配**：
若当前为 `Cubic`（modified Catmull-Rom），则报告的 vertical-RDP 所保证的
"线性重建误差 ≤ ε" 完全不成立，必须换成对实际插值结果的采样验证。

**这把一个"可选的额外验证"升级为强制步骤。**

### 3.3 硬约束：闭环校准**必须**写入活工程，无法在离体克隆上测量

报告的事务流程建议"失败就恢复快照"，并把闭环迭代当作可自由重试的过程。但：

- `SV.getComputedPitchForGroup` 要求传入 `NoteGroupReference`，且组必须属于
  **当前打开的工程**（`getPhonemesForGroup` 的官方措辞同理："The group must be part of
  the currently open project"）。
- 本仓库 `sv_edit_phrase` 的离体 clone 预检明确"不在工程树中"，因此**离体克隆无法测量
  computed pitch**。

结论：任何"写 → 测 → 修正"的闭环，每一轮都必须真实写入用户工程。这带来两个连锁问题：

1. **Undo 预算爆炸。** 本项目硬契约是"一次 commit 至多一个用户可见 Undo"。
   K 轮迭代 = K 个 Undo 记录（或"恢复 + 重写"= 2K 个）。用户要按 Ctrl+Z 十几次才能
   退出一次校准。`expectedUserUndoSteps` 必须诚实上报这个数字，而它很丑。
2. **中途失败留下半成品。** 迭代 k 成功、迭代 k+1 失败时，工程处于一个"比初始好但不是
   目标"的中间状态。这是合法的 `partial`，但必须在 schema 上表达清楚。

报告完全没有触及这一点。可选缓解：把迭代放到音域外的 scratch track —— 但插入 track 会
按 `context-invalidation.js` 触发**全量 context 失效**（`clone_track` 是唯一的全量失效
操作，因为它改变了每个已记录 `trackIndex` 的含义），代价同样明确。

### 3.4 拟合的输入信号不是 F0，而是 computed pitch —— 这既是限制也是简化

报告的分解流水线（输入清洗、voiced mask、MAD 滤波、Huber `f_scale` 5–15 cents）是为
**从音频提取的 F0** 设计的。本项目**没有音频面**：

- `Track.setBounced()` 只改 Render Panel 标记，不启动渲染（主计划 `capability-blocked`）。
- 官方无 render / export / 音频字节 API。
- MCP 没有音频输入。

后果分两面：

- **限制**："自动发现任意商业录音中的技法"不是"later research track"，而是在本架构下
  **`capability-blocked`**，除非引入完全独立的带外音频管线。报告把它归为"延后"，
  低估了性质。
- **简化（正面）**：唯一可拟合的信号是 `getComputedPitchForGroup`，它比提取 F0**干净得多**
  —— 没有音高跟踪器错误、没有八度跳变、无声段就是宿主自己的 `null`、采样网格由我们指定。
  报告近一半的鲁棒性机械（MAD 离群过滤、置信权重、为 F0 质量调的 Huber 尺度）对这个信号
  是过度设计。**应据此收缩范围，而不是照搬。**

### 3.5 测量网格是音乐时间，不是物理时间

`getComputedPitchForGroup` 只支持**等 BLICK 间隔**采样（`blickStart, blickInterval, numFrames`）。
在有 tempo 变化时，等 BLICK 间隔**不是**等秒间隔。

报告反复强调"内部一律用秒"（正确），却没注意**测量端被强制在 BLICK 域**。任何 Hz 域的
拟合（颤音速率、二阶自然频率）都必须先把每帧映射回秒再重采样，否则跨 tempo 变化的
颤音速率估计会系统性偏移。本仓库 `sv_compare_computed_pitch` 已经把"帧率对颤音是否够用"
分级为 ok/borderline/too_coarse，但没有处理非均匀秒间隔这一层。

### 3.6 遗漏了宿主自带的颤音面：`vibratoEnv` 与 `dF0VbrMod`

`Automation.getDefinition` 中存在 `"Vibrato Envelope" / "vibratoEnv"`，范围 `0–2`，
默认 `1`；`Note.getAttributes` 中存在 `dF0VbrMod`（pitch - vibrato modulation）。

**SV2 自己会生成颤音。** 报告的颤音方案是写一条密集正弦到 `pitchDelta` 或
`PitchControlCurve`，完全无视宿主原生颤音，直接后果是**双重颤音**（写入的正弦叠加在
宿主生成的颤音上）。

正确做法有两条，报告一条都没提：

- 用 `vibratoEnv` **缩放**宿主颤音（几个自动化点即可，成本远低于密集正弦）；
- 若要完全接管，必须先把 `vibratoEnv` 压到 0 —— 这是跨数据面操作，本仓库
  `sv_bake_computed_pitch` 已经因为同类原因显式拒绝了 `pitchDelta` 清除
  （`PITCH_DELTA_CLEAR_UNSUPPORTED`）。

这是报告在音乐正确性上最严重的单点遗漏。

### 3.7 `pitchDelta` 与 `PitchControlCurve` 的**交互**未知，二者可能不是平行选项

报告把两者列为并列的 application mode。但官方只说 `PitchControlCurve`
"overrides the generated pitch"，**没说**它是否也覆盖 `pitchDelta` 的相对偏移。
两种可能（curve 覆盖后 pitchDelta 仍叠加 / pitchDelta 一并被覆盖）导致完全不同的
编译策略，且决定两个 mode 能否共存。

这是一个必须在 Phase 0 真机确认的实验，报告只在风险表里写"interaction with default
transition and existing automation"，未识别为阻塞性未知量。

### 3.8 感知 A/B 无法程序化产出刺激材料

报告的 A/B 设计要求"保持 note/lyrics/voice/mix/loudness/rendered context 恒定"并随机化
呈现顺序。但**无法程序化导出音频**（§3.4）。因此：

- 刺激材料必须由人手动导出，条件间的一致性只能靠人工纪律保证；
- 报告的 18 个 MCP 工具里，感知层唯一可实现的是 `record_preference_trial`（记录日志）；
- 混合效应 logistic 模型 + 预注册功效分析是研究方法负担，在本仓库没有任何工程落点
  （无被试招募、无音频产出、无播放控制以外的呈现层）。

应把感知层从"系统的一层"降级为"人类主导的外部流程 + MCP 只负责不可篡改的试次日志"。

### 3.9 依赖策略冲突

本仓库 `THIRD_PARTY_NOTICES.md` 记录的是 **clean-room 政策**：即使对 MIT 许可的
SV2 脚本也只取"行为与数学需求参考"，不复制任何代码或常量。运行时是 Node.js。

报告的复用矩阵要求：AVA（MATLAB）、VibratoScope（Python）、LibreSVIP（Python）、
scipy `least_squares` + Huber loss、`scipy.sparse.linalg.spsolve`。

这意味着二选一：

- **加 Python 侧车**：对一个分发给终端用户的 SynthV 插件，等于新增第二运行时、
  第二套打包/进程/传输问题，且 doctor 诊断面要跟着扩。
- **在 JS 中重实现**：带边界约束的 Levenberg-Marquardt + Huber 损失 + 稀疏正则化求解，
  是一个真实的数值子系统，不是几百行。

报告完全没有为这个选择计价。**这是 Tier 3 成本的主要来源。**

### 3.10 传输成本未建模

传输是严格 lockstep：单向命名管道、`IDLE_MS = 20` 轮询、同时仅一个在途命令、
10 s 调用超时、64 KiB/帧、队列 64。

每轮闭环 = 写补丁（N 次宿主调用）+ 等待处理（轮询，间隔 100 ms 级）+ 读 computed pitch。
主计划的调用预算目标是"规划并提交一次演唱表现编辑 = 4–6 次调用"。**一个 10 轮闭环把这个
预算模型打破一个数量级**，且每轮都在写用户工程（§3.3）。

报告给了步长调度与停止条件，但从未估计迭代的墙钟成本或调用预算。必须先定迭代上限，
再谈收敛性。

---

## 4. 与仓库现状的重叠：报告"首个版本"已实现的部分

报告建议的首发范围是"前向生成、SV2 编译、computed-pitch 轮询、正则化反馈校正、
可复现日志、合成参数恢复测试"。除**反馈校正**与**参数恢复**外，其余均已存在：

| 报告设计 | 仓库现状 | 备注 |
| --- | --- | --- |
| `get_phrase_snapshot` | `sv_snapshot_range include:["notes","pitchControls","computedPitch","automation"]` | 已有分页、预算、cursor、fingerprint |
| `seconds_to_blick` / `blick_to_seconds` | `musical-time.js` `blickAtSeconds` / `secondsAtBlick` | **已按 tempo mark 分段做绝对映射**，正是报告要求的形式，且已避开它警告的 `ManualPitch.lua` 时长转换 bug |
| `generate_vibrato` | `sv_plan_pitch_gesture` type `vibrato` | 已有 rate/depth/phase/fadeIn/fadeOut、秒域采样、`vibratoPointsPerCycle` 默认 8 |
| `generate_logistic_transition`（部分） | `sv_plan_pitch_gesture` type `transition`/`attack`/`release` | 形状仅 linear/smoothstep/cosine，**无 logistic、无 inflection ratio、无非对称** |
| `compose_techniques` | `expression-gestures.js` + planner 的 merge/point-budget | 已有确定性展开顺序与点预算 |
| `compile_curve_for_sv2` + `rdp_vertical` | `bake-computed-pitch.js` `rdpSimplify` | **已是 vertical-error 变体**（`perpendicularDistance` 实际算的是同一时间坐标上的垂直差，函数名有误导性但数学正确），且有 `maxFitError` 上报 |
| `preview_pitch_patch` / `apply_pitch_patch` | `sv_patch_pitch_controls`（`dryRun` + commit） | 已有 journal + 读回 + 逆序补偿 + shared-target 确认 |
| `restore_transaction` | 同上的补偿回滚 | 已实现"宁可诚实报 `rollback_failed` 也不假称恢复" |
| `sample_computed_pitch` + 轮询 | `sv_wait_for_processing kind:"computedPitch"` | **已实现报告建议的"非空 + 连续稳定"双条件**（`stablePolls` + `contentHash`） |
| `analyze_vibrato` / `evaluate_pitch_result` | `sv_compare_computed_pitch` | 已有 detrended-autocorrelation 颤音率/深度/规律性、transition overshoot/arrival/settling、anomaly segments、cents 域中心误差 |
| "密集数组走 resource / artifact ID" | `artifact-store.js` + `planRef` | 已实现，含租期与配额 |
| "所有参数名带单位后缀" | 全仓库既有纪律（`depthSemitone` / `rateHz` / `localBlick` / `detuneCents`） | 已是硬约束 |
| "快照优于依赖人按 Undo" | 已是实现policy | 报告结论与仓库一致 |

**能力缺口只有 4 项**（这才是报告的真正增量）：

1. **Saitou 二阶瞬态**：`pitch-gesture-plan.js` 的 attack/release 明确写着
   "有界不超调（bounded no-overshoot）"。而 overshoot 恰恰是 Saitou 证明的关键感知成分。
   **当前无法表达超调。**
2. **广义 logistic / Richards 转换**：无非对称、无可控 inflection point，
   しゃくり（scoop 的可控拐点形态）不可表达。
3. **闭环反馈校准**：能测（`sv_compare_computed_pitch`）但从不把误差回灌成修正补丁。
   这是最大的架构增量。
4. **逆向拟合**：仓库零拟合器 —— 无 least-squares、无 Huber、无多起点。这是最大的新子系统。

---

## 5. 分级可行性判定

### Tier 1 — 立即可行，不引入新运行时，高价值

| 项 | 依据 |
| --- | --- |
| 在 `sv_plan_pitch_gesture` 增加 Richards（广义 logistic）形状 | 纯前向生成，闭式解，`logaddexp` 稳定化在 JS 中是几十行 |
| 增加 Saitou 二阶瞬态形状（overshoot / preparation） | 冲激响应是闭式解，四个阻尼分支；用报告的 `(t₀, A_peak, t_peak, ζ, s)` 外部参数化，不暴露 `(k, ω, ζ)` |
| 用 `PitchControlCurve.getValueAt()` 验证压缩误差 | **报告未发现的现成验证句柄**：可直接采样曲线自身的插值结果，无需先等 computed pitch |
| 用 `Automation.get()` / `getLinear()` 验证 pitchDelta 压缩误差 | 同上；且 `get()` 走宿主实际插值，能暴露 §3.2 的 Cubic 问题 |
| 测量网格的秒域重采样（§3.5） | 纯计算，落在 `computed-pitch-compare.js` |
| `vibratoEnv` / `dF0VbrMod` 交互调查与显式声明（§3.6） | 只读 + 文档；不做就有双重颤音风险 |

### Tier 2 — 可行，但需真机 Phase 0 证据 + 显式预算决策

| 项 | 阻塞条件 |
| --- | --- |
| `pitchDelta` × `PitchControlCurve` 交互语义（§3.7） | 真机可恢复写实验；结果决定两个 mode 能否共存 |
| 闭环校准 | 必须先定：迭代上限、Undo 预算（诚实上报 K 或 2K）、中间失败的 `partial` 语义、scratch-track 方案是否值得全量 context 失效（§3.3） |
| `PitchControlCurve` 实际插值行为 | 官方无 `getInterpolationMethod`；只能靠 `getValueAt` 密集采样反推 |

### Tier 3 — 可行但昂贵，需先做架构决策

| 项 | 成本来源 |
| --- | --- |
| 逆向拟合（logistic / 二阶 / 颤音参数恢复） | 需带边界的非线性最小二乘 + Huber。**决策点**：JS 自研 vs Python 侧车（§3.9） |
| 正则化反馈控制器（`D₂` 二阶差分 + 稀疏解） | 同上；`spsolve` 在 JS 中需自研（带状矩阵，可用 Thomas 算法，比通用稀疏求解简单得多） |
| 合成参数恢复基准 | 依赖上面两项；本身是纯计算，易做 |

**建议**：因为唯一可拟合信号是 computed pitch 而非提取 F0（§3.4），鲁棒性需求大幅降低，
**推荐 JS 自研 + 收缩范围**，不引入 Python 侧车。具体地，`least_squares` 的
`loss="huber", x_scale="jac"` 可用"带边界的 Levenberg-Marquardt + IRLS 权重"替代，
配合报告已给出的确定性多起点网格（γ∈{3,6,10,16} × B∈{0.35,0.6,1,1.7,3}）。

### Tier 4 — `capability-blocked`，应从范围中移除

| 项 | 原因 |
| --- | --- |
| 从任意录音自动发现技法 | 无音频输入面（§3.4）。不是"延后"，是架构外 |
| 程序化产出 A/B 刺激材料 | 无 render / export（§3.8） |
| 机器听感评分 | 主计划既有 `capability-blocked` 条目；报告本身也承认"MCP 不能听" |
| 依赖 `project_revision` 的身份模型 | 无此 API（§3.1）；替换为既有 fingerprint 方案 |

---

## 6. 需要用户决策的两个岔路

1. **闭环校准的 Undo 语义**（阻塞 Tier 2）
   - (a) 每轮一个 Undo，诚实上报 `expectedUserUndoSteps: K`
   - (b) 每轮"恢复 + 重写"，`2K`，但任意中断都回到干净初态
   - (c) scratch track 迭代 + 最终一次性写回，代价是全量 context 失效
   - (d) 不做闭环，只做"测量 + 建议下一次补丁"的开环（模型自己决定是否再来一轮）

   > (d) 与本项目既有的"planner → dry-run → commit → verify"节奏完全一致，
   > 且不破坏 Undo 契约与调用预算。**推荐从 (d) 起步**，把闭环留到有真机证据之后。

2. **数值子系统的落点**（阻塞 Tier 3）
   - (a) JS 自研（推荐，见 §5 Tier 3）
   - (b) Python 侧车（获得 scipy 生态，代价是第二运行时 + 分发/诊断复杂度）

---

## 7. 判定汇总

报告作为**数学与文献综述**质量很高，可直接作为实现规格；作为**本项目的路线图**则需要
三处结构性改写：删掉已实现的 60–70%、删掉 `capability-blocked` 的音频/感知/revision 部分、
补上它遗漏的 `vibratoEnv` 双重颤音风险与"闭环必须写活工程"的硬约束。

具体分阶段方案见 [opus-implementation-plan.md](opus-implementation-plan.md)。
