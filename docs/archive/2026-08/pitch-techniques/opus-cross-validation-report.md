# 可解释音高技法方案交叉验证报告

## 0. 文档信息

- 交叉验证对象 A：`docs/INTERPRETABLE_PITCH_TECHNIQUE_FEASIBILITY_REPORT.md` +
  `docs/INTERPRETABLE_PITCH_TECHNIQUE_IMPLEMENTATION_PLAN.md`（以下称 **A 方案**）
- 交叉验证对象 B：`docs/DEEP_RESEARCH_FEASIBILITY_ASSESSMENT.md` +
  `docs/DEEP_RESEARCH_EXECUTION_PLAN.md`（以下称 **B 方案**）
- 共同上游：`docs/deep-research-report.md`
- 验证基线：SVCopilot `0c91ebf`（2026-08-02），60 个测试文件，41 个 operation / 7 个 facade + `sv_describe`
- 验证手段：仓库内 SHA-256 跟踪的官方文档镜像（`api-docs/api-manifest.json`）、源码直读、
  GitHub API 校验 commit/许可证、EXA 检索原始论文与 SDK 发布记录
- 本文档**不修改**上述四份原文档中的任何一个字

## 1. 交叉验证结论

两份方案独立得出了**同一个核心判断**：上游研究报告的数学方向成立，但其"新建 Python MCP 管线"
的落地形态必须否决，改为在现有 Node 服务内以纯函数扩展。这一致性不是抄袭——两者的证据路径
不同（A 方案走 surface 归属与模块边界，B 方案走宿主 API 能力边界与既有实现重叠），
结论重合本身构成较强的可信度证据。

但两者**都不完整**，且各自含有可证伪的错误：

| 维度 | A 方案 | B 方案 |
|---|---|---|
| 官方 API 事实核验 | 发现 1 项 B 方案遗漏的硬约束 | 发现 3 项 A 方案遗漏的硬约束 |
| 与仓库现状的对齐 | 3 处与实际代码/门禁不符 | 1 处过度自信 |
| 开源溯源严谨度 | 更强（7 个 SHA 全部可解析） | 较弱（只核验许可证，未固定 SHA） |
| 阶段门禁可证伪性 | 更强（数值阈值明确） | 较弱（部分定性表述） |
| 后端选型决策 | 过程更正确，成本被低估 | 默认更正确，论证被简化 |
| 共同盲区 | 2 项（见 §5） | 同 |

**合并判定**：立项可行。应以 A 方案的阶段结构与门禁数值为骨架，
用 B 方案的宿主能力边界修正其范围，并补上两者共同遗漏的 2 项 Phase 0 前置验证。

## 2. 两份方案一致且经核验为真的部分

以下每条都在本轮独立核验过，不是简单转述。

| 主张 | 核验来源 | 判定 |
|---|---|---|
| `Project` 无 revision getter；`project_revision` 是上游报告虚构的字段 | manifest `Project` 方法全集：`addNoteGroup … newUndoRecord … setScriptData`，无任何 revision/version 成员 | **成立**，两者均正确否决 |
| 官方无脚本侧"立即 Undo"，只有 `newUndoRecord()` 建立用户 Ctrl+Z 边界 | manifest `Project.newUndoRecord` 描述原文 | **成立** |
| AVA 原式中 `A` 与 `M` 不可同时辨识 | `A·exp(−G(t−M)) = exp(logA+GM−Gt)`，只有 `logA+GM` 可观测 | **成立**，重参数化是必要修正而非优化 |
| `getComputedPitchForGroup` 绑定 `NoteGroupReference`、返回浮点 MIDI、无音高处为 `null`、未完成返回空数组 | manifest 原文逐字确认（`supportedSince 2.1.1`） | **成立** |
| 颤音生成应用时变正弦，而非强行套无阻尼二阶 | Saitou 2004/2007 原文确认 `ζ=0` 分支即 `(k/ω)sin(ωt)`，恒定幅度无包络 | **成立**，两者的工程判断一致 |
| 时间换算必须逐绝对秒映射，不能把 duration 当 absolute | 变速工程下 `B(t₀+Δt)−B(t₀) ≠ B(Δt)` | **成立** |
| 听感结论必须 `human_only` | 官方无音频渲染原语；`Track.setBounced()` 只改 Render Panel 标记 | **成立** |
| 两个写面叠加行为未知，不应默认同时写 | 官方 `PitchControlCurve` 描述只说 "overrides the generated pitch"，未定义与 `pitchDelta` 的合成语义 | **成立**，属真机 Phase 0 项 |
| MCP Python SDK v2.0.0 于 2026-07-28 发布，v1 转维护模式 | GitHub release 页确认，MIT | **成立**，但两者都正确指出这不构成采用理由 |
| Saitou 二阶模型参数以 rad/ms 表述 | 2004 ISCA 表 1：overshoot `Ω=0.0348 rad/ms, ζ=0.5422, K=0.0348`；preparation `0.0292/0.6681/0.0292`；vibrato `0.0345/0/0.0018` | **成立**，秒域实现需 ×1000 |

## 3. A 方案发现而 B 方案遗漏的硬约束

### 3.1 `NoteGroupReference.clone()` 不复制目标 NoteGroup（A 方案 §5.5）

**核验通过，且比 A 方案表述的更强。** manifest 原文：

- `NoteGroupReference.clone()` — "Note: since NoteGroupReference does not take ownership of
  the target NoteGroup, this **does not copy the target NoteGroup**."
- `NoteGroupReference.setTarget()` — "Note that **once set, the target can't be changed**."

两条合起来意味着：想让 B occurrence 独立承载一次技法实验，唯一路径是
`NoteGroup.clone()`（深拷贝）→ `Project.addNoteGroup` → 新建 reference 并在
**首次** `setTarget` 时绑定。既有 reference 无法重定向。

B 方案完全未提及此约束，而其 R3 闭环校准阶段隐含"在受控副本上迭代"的可能性——
该路径的成本被系统性低估。A 方案 §5.5 的"第一阶段应拒绝或要求显式确认 shared-target 写入，
不把自动 clone 作为已解决能力"是正确处置。

**采纳 A 方案。**

### 3.2 开源依赖的 commit 级溯源（A 方案 §8）

A 方案固定了 7 个 SHA。本轮逐个用 GitHub API 校验：

| 项目 | A 方案 pin | 解析 | 许可证核验 | 备注 |
|---|---|---|---|---|
| skx300/ava | `77e4dfe` | 200 | Apache-2.0 ✓ | 仓库 2022-04-23 后无推送，pin 稳定 |
| hataori-p/real-voice | `172259a` | 200 | MIT ✓ | 2023-07-05 后无推送 |
| Turbo49/SVScripts | `8825fbe` | 200 | MIT ✓ | 2026-07-28 推送，活跃 |
| tiagolbc/vibratoscope | `a7a8d3b` | 200 | MIT ✓ | 2026-07-21 推送，活跃 |
| SoulMelody/LibreSVIP | `983a595` | 200 | MIT ✓ | **2026-08-02 推送**，同日仍在变动 |
| openutau/OpenUtau | `29e0e16` | 200 | MIT ✓ | `stakira/OpenUtau` 已 301 重定向到此组织 |
| MCP Python SDK | `v2.0.0` | — | MIT ✓ | 2026-07-28 |

同时抽查 A 方案引用的具体文件在该 SHA 下确实存在：
`ava@77e4dfe` 的 `Logistic_Modeling-package/createGeneralLogistic6Fit.m`、
`HMM-package/ViterbiAlgHMM.m`、`HMM-package/portamentoDetc.m`、`FDM-package/` 均 200；
`OpenUtau@29e0e16` 的 `OpenUtau.Core/Ustx/UNote.cs`、`OpenUtau.Core/Render/RenderPhrase.cs` 均 200。

**A 方案在此项上严格优于 B 方案**（后者只核验许可证）。

一处需要收紧：这 7 个 pin 均为写作时的 HEAD，而非"经审阅的提交"。对 SVScripts、
VibratoScope、LibreSVIP 三个活跃仓库，pin HEAD 与不 pin 的实际区别，取决于是否在该 SHA
真的抓取并存档了 LICENSE/NOTICE。建议改为"审阅并存档时的 SHA"，并在
`THIRD_PARTY_NOTICES.md` 记录抓取日期。

### 3.3 Saitou 论文不是可 vendor 的开源实现（A 方案 §8 末段）

A 方案指出 JAIST 保存稿标注 CC BY-NC-ND 4.0，引用 Elsevier 正式出版物，
因此"可以独立实现论文描述的数学方法，但不应复制论文文本、图表"。

这是 B 方案完全没有覆盖的许可证维度。数学公式本身不受版权保护，但论文的表述、
图表、参数表的**编排**受保护。考虑到本仓库既有 `THIRD_PARTY_NOTICES.md` 的
clean-room 政策（对 Hrauroras/SV2-Script 已执行过一次），A 方案的处置与仓库既有
政策自然衔接。**采纳。**

## 4. B 方案发现而 A 方案遗漏的硬约束

### 4.1 宿主自带颤音面：`vibratoEnv` 与 `dF0Vbr*`（B 方案 §3.6）

**核验通过，且这是 A 方案 TechniqueIR 设计的一个实质缺口。**

manifest 确认两个独立的宿主颤音面：

- `Automation.getDefinition` 表内 `"Vibrato Envelope" / "vibratoEnv" / range 0,2 / 默认 1`
- `Note.getAttributes` 含 `dF0Vbr`、`dF0VbrMod`、`fF0Vbr`、`pF0Vbr`、
  `tF0VbrLeft`、`tF0VbrRight`、`tF0VbrStart`

而本仓库 `server/src/expression-plan.js` **已经在写 `vibratoEnv`**
（`spoken_rap_transition` 意图会播种 `vibratoEnv 0.2` 压平宿主颤音），
并已在 schema 里把 `surface` 限定为 `pitchDelta | vibratoEnv`
（`expression-gestures.js:262`）。

A 方案的 TechniqueIR `targetSurface` 枚举只有 `pitchDelta | pitchControlCurve`，
且组合器只处理"同写面相加"。这意味着：

> 一个 TechniqueIR 颤音写入 `pitchDelta`，而同一音符上宿主的自然颤音（受 `vibratoEnv`
> 与 `dF0Vbr*` 控制）仍然生效 → **双重颤音**。组合器看不到它，因为它不在 IR 的写面集合里。

更棘手的是，宿主自然颤音的**存在与深度通过官方 API 不可观测**
（`expression-plan.js:459` 已如实标注这一点）。所以这不是"读出来再相减"能解决的，
只能通过以下之一处置：

1. TechniqueIR 颤音默认同时在 `vibratoEnv` 上写 0（压平宿主颤音），把颤音权威收归 IR；
2. 或者拒绝在未确认 `vibratoEnv` 状态的音符上写 IR 颤音，返回显式 review 要求。

A 方案 §4.3 的 `targetSurface` 枚举必须扩展为三值，或者 IR 必须携带一个
`hostVibratoPolicy` 字段。**这是 A 方案实施前必须补的契约，不是可选优化。**

### 4.2 `Automation` 只能读插值方法，不能设（B 方案 §3.2）

**核验通过。** manifest `Automation` 方法全集：

```
add, clearScriptData, clone, get, getAllPoints, getDefinition, getIndexInParent,
getInterpolationMethod, getLinear, getParent, getPoints, getScriptData,
getScriptDataKeys, getType, hasScriptData, isMemoryManaged, remove, removeAll,
removeScriptData, setScriptData, simplify
```

有 `getInterpolationMethod`，**没有** `setInterpolationMethod`。

A 方案在两处触及但都不够硬：其可行性报告 §4 表格说"Automation 插值模式会影响误差保证"，
其实施计划 §8.3 说"读取/声明 Automation interpolation"——措辞正确（读，不是设），
但都没有说出后果：`epsilonCents` 的误差保证**不是本项目能选定的**，
它是宿主状态的函数。若用户在 UI 里把某条曲线的插值改成 Cubic，
同一份 PlanRef 的实际最大误差就变了，而 PlanRef 的 capsule 里没有记录插值方法。

A 方案 §8.6 的退出标准"两个写面在 synthetic corpus 上均满足声明误差"因此是
**在离线假设下成立、在真机上未定义**的。修正方式：capsule 必须封存
commit 时读到的 `interpolationMethod`，live preflight 比对不一致则拒绝，
且误差报告必须声明它是在哪个插值语义下成立的。

### 4.3 闭环校准的测量信号是 computed pitch，不是 F0（B 方案 §3.4）

A 方案 P5 定义了 `SAMPLING_RATE_TOO_LOW` 错误码，说明它意识到采样率问题。
但两份方案都没有明确说出一个结构性后果：

Saitou 模型的四个分量中，**fine fluctuation（>10 Hz 的不规则抖动）在 computed pitch
上原理上不可靠观测**。仓库的 computed-pitch 采样间隔由调用方给定
（`musical-range.js:966` `intervalBlick = ceil((end−start)/frames)`），
而帧预算上限 20,000 帧/快照、2,000 帧/组。要在一个 2 秒的音符上采到 >10 Hz 分量的形状，
需要远高于典型规划采样率的密度，且宿主生成的 computed pitch 是否**包含**
fine fluctuation 本身未经真机确认。

后果：分解流水线的 residual 里必然有一部分**不是"未解释的技法"，而是"不可观测的分量"**。
A 方案 §7.4 第 9 步"把无法解释的残差作为 residual evidence"方向正确，
但必须进一步区分 `residual_unmodeled` 与 `residual_below_observability`——
否则模型会把采样不足当成"还有技法没找到"，并继续堆技法。

## 5. 两份方案共同的盲区

以下两项在四份文档中均未出现，是本轮交叉验证的独立发现。

### 5.1 仓库的秒↔BLICK 换算是 Node 侧自建实现，与宿主 `TimeAxis` 的一致性未经验证

两份方案都把"用 TimeAxis 换算"当作已解决的基础设施。实际代码是：

- `server/src/musical-time.js:130 secondsAtBlick()` 与 `:144 blickAtSeconds()`
  从**快照捕获的 tempoMarks** 做分段线性积分：
  `positionSeconds + ((blick − positionBlick) / quarterBlick) × (60 / bpm)`
- 全仓库唯一调用宿主 `getSecondsFromBlick` 的地方是 `server/src/audition.js:66-67`
  （试听区间换算），**规划路径一次都没调用宿主 TimeAxis**

也就是说，`sv_plan_pitch_gesture` 的颤音 Hz 精度，取决于 Node 侧这个分段线性模型
与 SynthV 内部 `TimeAxis` 的**逐点一致性**——而这从未在真机上比对过。

这正好命中两份方案共同担心的失效模式。A 方案 §8.6 要求"tempo-change case 的颤音 Hz
误差低于 0.5%"、§12.3 要求"变速场景颤音 rate 偏差 ≤ 1%"；B 方案要求逐绝对秒映射。
但两者都在**未验证的换算内核**上设置误差门禁。若宿主支持 tempo 渐变（ramp）而
Node 侧按阶跃处理，或双方对 tempo mark 边界的取整规则不同，
0.5% 的门禁在真机上可能系统性不达标，而调试会指向错误的方向（怀疑模型，而非换算）。

**必须新增的 Phase 0 项**（只读，成本极低）：取一段含 tempo change 的工程，
对同一批 BLICK 同时调用宿主 `TimeAxis.getSecondsFromBlick` 与 Node
`secondsAtBlick`，报告最大偏差与偏差分布；反向同理。这是所有 Hz 门禁的前置条件。

### 5.2 闭环校准的 60 秒独占锁与传输不变量冲突

A 方案 §13.1 要求校准"全过程持有 ExecutionCoordinator 独占权"，
§13.3 门禁给出"p95 在 60 秒外层上限内留至少 10 秒安全余量"。

对照传输层实测约束（`server/src/transport-pipe.js`、`staging/StartSynthVCopilotPipe.lua`）：

- 单次宿主调用超时 **10 s**（`timeoutMs = 10000`）
- **一次只能有一个 in-flight command**
- 桥的空闲轮询间隔 `IDLE_MS = 20`
- 严格 lockstep：Lua 写一帧后阻塞读一帧，Relay 必须立即回包

后果有两个，均未被任何一份方案提及：

1. **算术可行性**：3 轮候选写入，每轮含写入 + processing 等待 + computed-pitch 读回。
   单个宿主调用上限 10 s，而 processing 等待本身是多次轮询。60 s 总预算下 3 轮完整
   写-测-判循环是**紧张但可能**的——前提是每轮的 processing 收敛时间远小于 10 s，
   而这恰好是未经真机测量的量。A 方案的 60 s 数字缺少支撑测量。
2. **独占锁的外部代价**：持锁 60 s 期间，MCP 客户端的任何其他调用都在
   ExecutionCoordinator 队列里排队，而队列上限是 64。同时 SynthV UI 线程在
   20 ms 轮询循环里空转约 3000 次。这不是崩溃级问题，但"一次调用锁死整个 MCP
   面 60 秒"是需要显式声明的产品行为，不能只作为内部实现细节。

**处置建议**：把闭环校准的外层预算从"60 s"改为"由真机测得的单轮 processing 收敛
p95 推导"，并在 operation 描述里明确声明独占时长与期间其他调用的行为。

## 6. A 方案与仓库现状不符之处

以下三项是 A 方案实施计划与本仓库实际代码/门禁的冲突，逐条经源码核验。

### 6.1 响应预算 4 KiB 与仓库门禁 16 KiB 不符

A 方案 §16 规定：planner 普通响应 ≤ 4 KiB、analysis ≤ 4 KiB、error ≤ 2 KiB。

仓库实际值（`server/src/response-budget.js`）：

```
COMPACT_MAX_BYTES = 16 * 1024
ERROR_MAX_BYTES   =  8 * 1024
REQUEST_MAX_BYTES = 16 * 1024
```

且这三个常量被 `surface-io-policy.js` 同源导入，正是为了防止"文档写一个数、
代码判另一个数"。A 方案把预算收紧了 4 倍而未说明这是**新增的更严门禁**。

两种可能都需要澄清：若是有意收紧，必须说明理由并同步修改 `response-budget.js`
（否则审计门禁与业务判据仍是 16 KiB，4 KiB 只是文档里的一句空话）；
若是笔误，应对齐现有值。**倾向于对齐现有 16 KiB**，因为 planner 响应要携带
summary + apply envelope + warnings + review，既有 `expression-plan.js` 的
`INLINE_PLAN_DETAIL_MAX_BYTES` 逻辑已经在 16 KiB 硬信封内做二级降级。

### 6.2 planner 请求里放 `execution: {atomic, undoLabel}` 违背其自身原则

A 方案 §9.1 的请求示例包含：

```json
"execution": {"atomic": true, "undoLabel": "SV Copilot pitch techniques"}
```

核验：`sv_plan_pitch_gesture` 与 `sv_plan_expression` 的 inputSchema **都不接受**
`atomic` / `undoLabel` / `execution` / `dryRun`。这些字段只存在于 mutation 工具
（`sv_patch_parameter_curves` 等，`index.js:562` `undoLabel`）。

这与 A 方案自己的实施原则 #4"生成与执行分离——planner 只产出 PlanRef；
写入继续走现有 mutation kernel"直接矛盾。执行语义属于 apply 侧，
放进 plan 请求会产生两个问题：planner 无从校验它（planner 不碰宿主），
而 capsule 封存一份"计划时声明的执行意图"又会与 commit 时的实际参数产生第二真相。

**应删除该字段**，让 `apply.arguments` 里的 `action: dry_run | commit`
继续作为唯一执行入口。

### 6.3 用 `sv_audition_compare` 做技法 A/B 的路径不通

A 方案 §14.2 规定"使用现有 `sv_audition_compare`，采用 blinded、随机顺序的 A/B"。

核验 `sv_audition_compare` 的实际契约（`index.js` 描述原文）：

> "Organize a non-blocking human A/B audition of two **EXISTING** versions over the same
> range — different **track solo configurations** … This tool **NEVER applies a temporary
> musical edit for variant B**: the official API has no Undo call, so there is no general
> recovery token after a successful commit, and an un-undoable 'audition-only write'
> would be dishonest."

其 schema 的 variant 只接受 `soloTrackIndices`。这意味着要 A/B
"TechniqueIR 版本 vs 基线版本"，必须**先把两个版本各自永久提交到两条不同轨道**。
即：A/B 前必须产生两次不可撤销的工程写入，且需要一条克隆轨——而克隆轨又撞上
§3.1 的 `setTarget` 一次性约束与 Singer 身份不透明问题（主计划已列
"克隆且保留隐藏 Singer：无法保证"）。

B 方案把感知 A/B 判为"应从范围中移除"（其 Tier 4），核验后**这个判断更准确**。
A 方案 §14.2 不是"复用现有工具"，而是"需要一条尚不存在的、且被能力边界阻塞的
双轨制备流程"。

**处置**：P8 的人工 A/B 应降级为"人类在自己的工程里用 Undo 手动对比 commit 前后"
的操作指南，而不是一个自动化 A/B 服务。这不削弱 P3/P5/P6 的可发布性。

## 7. B 方案过度自信之处

### 7.1 "直接用 Node，不做后端 benchmark"论证不足

B 方案推荐纯 Node 单进程实现拟合内核，理由是引入第二运行时会破坏单一
`npm test` 门禁、`surface-io-policy` 覆盖门禁与 doctor 诊断链。这些代价是真实的。

但 A 方案 §10 的做法在**过程上更正确**：先定义语言无关的 worker 协议
（`protocolVersion / operation / samples / bounds / loss / limits / seed`
→ `solver / termination / parameters / metrics / identifiability`），
再用同一 corpus 让候选竞争。这样后端选择是被证据决定的，且**协议一旦定死，
换实现不改 MCP 契约**。

B 方案缺少的正是这个抽象层：它直接把 Levenberg-Marquardt 写进 Node，
若后续发现 box constraints + Huber loss 的数值健壮性不足，
迁移成本会落在已经被 planner 依赖的接口上。

**采纳 A 方案的 adapter 契约。**

但 A 方案 §10.3 的门禁清单同时低估了自身成本：要求每个候选做
"Windows/macOS 安装流程有自动测试"、"license 可发行且 NOTICE 完整"、
"p95 20-technique phrase fit ≤ 1500 ms"。三个候选 × 两个平台的打包与安装自动化，
其工作量很可能超过拟合内核本身。

**合并处置**：采纳 adapter 契约（架构收益大、成本低），但把 benchmark 降级为
**单候选门禁 + 预声明的失败触发条件**：先只实现 Node 后端并跑完门禁；
仅当 Node 明确未达标（记录具体不达标项）时，才启动第二候选评估。
这保留了 A 方案的可替换性，去掉了三路平台化竞标的前置成本。

## 8. 数值与门禁的合并取值

A 方案的门禁数值普遍比 B 方案可证伪，予以采纳；标注冲突处的裁定。

| 门禁项 | A 方案 | B 方案 | 合并取值 | 理由 |
|---|---|---|---|---|
| planner 普通响应 | ≤ 4 KiB | 未定 | **≤ 16 KiB** | 对齐 `response-budget.js`，见 §6.1 |
| error 响应 | ≤ 2 KiB | 未定 | **≤ 8 KiB** | 同上 |
| clean synthetic 参数恢复 | 95% case 在容差内 | 未定 | **采纳 A** | 可证伪 |
| noisy recovery | median curve RMSE ≤ 5 cents | 未定 | **采纳 A** | 可证伪 |
| 单 transition fit p95 | ≤ 100 ms | 未定 | **采纳 A** | 可证伪 |
| 20-technique phrase fit p95 | ≤ 1500 ms | 未定 | **采纳 A** | 可证伪 |
| forward parity | ≤ 1e-9 cents | 未定 | **采纳 A** | 可证伪 |
| 变速颤音 Hz 误差（离线） | ≤ 0.5% | 未定 | **采纳 A，但前置 §5.1** | 换算内核未验证前该门禁无意义 |
| 变速颤音 Hz 误差（真机） | ≤ 1% | 未定 | **采纳 A，但前置 §5.1** | 同上 |
| 闭环 median objective 改善 | ≥ 30% | 未定 | **采纳 A** | 可证伪 |
| 闭环最大候选写入 | 3 次 | 未定 | **采纳 A** | 与 Undo 诚实性相容 |
| 闭环外层预算 | 60 s | 未定 | **改为真机 p95 推导** | 见 §5.2，60 s 缺少测量支撑 |
| 单 technique dense samples | ≤ 2000 | 未定 | **采纳 A** | 与既有 `curvePointsPerControl: 2000` 一致 |
| 单 Plan compiled points | ≤ 4000 | 未定 | **采纳 A** | 与 `controlsPerSnapshot: 4000` 同量级 |

## 9. 两份方案的范围判定合并

| 子系统 | A 方案 | B 方案 | 合并判定 |
|---|---|---|---|
| TechniqueIR + 单位系统 | 高 | Tier 1 | **立即可行**，但 `targetSurface` 必须含 `vibratoEnv` 或 `hostVibratoPolicy`（§4.1） |
| 二阶瞬态前向模型 | 高 | Tier 1 | **立即可行** |
| Richards 前向模型 | 高 | Tier 1 | **立即可行** |
| 时变颤音前向模型 | 高 | Tier 1 | **立即可行** |
| 确定性组合器 | 高 | Tier 1 | **立即可行** |
| 编译到 `pitchDelta` | 高 | Tier 1 | **可行**，误差保证须绑定 commit 时读到的插值方法（§4.2） |
| 编译到 `PitchControlCurve` | 高 | Tier 1 | **可行**，跨面共存返回 review 而非自动清除 |
| 曲线压缩（垂直误差 RDP） | 高 | 已实现需改造 | **可行**，现有 `bake-computed-pitch.js` 的 RDP 用的是**垂直距离**（`perpendicularDistance` 实为按时间归一后的音高偏差），A 方案 §8.5 的改造要求部分已满足，应先读代码再动 |
| 参数拟合（逆问题） | 中高 | Tier 2 | **可行**，采纳 A 的 adapter 契约 + B 的 Node-first 默认（§7.1） |
| 自动分解/检测 | 中 | Tier 2/3 | **可行但需先区分 residual 类别**（§4.3） |
| 宿主闭环校准 | 中，条件阶段 | Tier 3，质疑价值 | **条件可行**，外层预算须实测推导（§5.2） |
| 秒↔BLICK 换算一致性 | 假定已解决 | 假定已解决 | **两者共同盲区，必须前置验证**（§5.1） |
| 感知 A/B 服务 | P8 复用 audition_compare | Tier 4 移除 | **采纳 B**：路径被能力边界阻塞（§6.3），降级为人工操作指南 |
| 自动听感优化 | 低/能力阻塞 | Tier 4 | **移除** |
| 通用歌手模型 | 低/研究项 | 未覆盖 | **移除**（Singer 身份不可观测） |

## 10. 交叉验证发现的问题清单

按必须处置的优先级排列。

| 编号 | 问题 | 来源 | 严重度 | 处置 |
|---|---|---|---|---|
| X1 | 秒↔BLICK 换算内核与宿主 TimeAxis 一致性未验证，所有 Hz 门禁悬空 | 共同盲区 §5.1 | **阻塞** | 新增 Phase 0 只读比对 |
| X2 | TechniqueIR 未覆盖宿主自带颤音面，存在双重颤音 | B→A §4.1 | **阻塞** | IR 契约扩展 `targetSurface` / `hostVibratoPolicy` |
| X3 | `Automation` 插值方法不可设，误差保证是宿主状态的函数 | B→A §4.2 | 高 | capsule 封存插值方法 + live preflight 比对 |
| X4 | `sv_audition_compare` 无法 A/B 计划与基线，P8 路径不通 | 核验 §6.3 | 高 | 感知 A/B 降级为人工指南 |
| X5 | planner 请求含 `execution.atomic`，违背 plan/execute 分离 | 核验 §6.2 | 中 | 删除该字段 |
| X6 | 响应预算 4 KiB 与仓库 16 KiB 门禁冲突 | 核验 §6.1 | 中 | 对齐 16 KiB，或同步改 `response-budget.js` |
| X7 | 闭环 60 s 外层预算缺测量支撑；独占锁外部代价未声明 | 共同盲区 §5.2 | 中 | 改为真机 p95 推导 + 显式声明独占行为 |
| X8 | residual 未区分"未建模"与"低于可观测性" | B→A §4.3 | 中 | 分解输出增加两类 residual |
| X9 | 三候选 × 双平台 benchmark 成本可能超过内核本身 | 核验 §7.1 | 中 | 降级为 Node-first + 预声明失败触发 |
| X10 | 开源 pin 为写作时 HEAD 而非审阅时 SHA；三个仓库仍活跃 | 核验 §3.2 | 低 | 改为审阅存档 SHA + 记录抓取日期 |
| X11 | `NoteGroupReference.setTarget` 一次性，隔离实验成本被低估 | A→B §3.1 | 低（已被 A 正确处置） | 保持 A 方案的显式确认策略 |

## 11. 最终交叉判定

**两份方案的合并结论比任何一份单独成立。**

- **方向**：两者独立收敛于"在既有 Node 事务平台上做可解释音高模型扩展"，
  且否决"新建 Python MCP 管线"。此结论经官方 API 与源码双重核验，成立。
- **骨架**：采纳 A 方案的 P0–P8 阶段结构与数值门禁——它比 B 方案更可证伪，
  且 adapter 契约的架构收益是实质的。
- **范围修正**：用 B 方案的宿主能力边界削去 A 方案的两处越界（感知 A/B 服务、
  未覆盖宿主颤音面的 IR），并接受 B 方案对闭环价值的质疑作为 P7 的止损依据。
- **新增前置**：X1（换算一致性）必须先于任何 Hz 门禁；X2（颤音面）必须先于 IR v1 冻结。
  两项都是只读或纯契约工作，成本低，但不做则后续门禁全部悬空。

首个可发布增量仍是 A 方案 §18.1 定义的 MVP（TechniqueIR v1 + 三个前向模型 +
组合器 + 双写面编译器 + `plan_pitch_techniques`），
在补齐 X1/X2/X5/X6 后即可进入实施。

## 12. 核验来源

官方 API（仓库内 SHA-256 跟踪镜像 `api-docs/api-manifest.json`，
生成自 <https://resource.dreamtonics.com/scripting/>）：

- `SV.getComputedPitchForGroup`、`SV.setTimeout`、`SV.create`
- `Automation.getDefinition` / `getInterpolationMethod` / `simplify`（无 setter）
- `PitchControlCurve.setPoints` / `getValueAt` / `setPitch` / `setPosition`
- `NoteGroup.addPitchControl` / `getPitchControl` / `getNumPitchControls`
- `NoteGroupReference.clone` / `setTarget` / `getTimeOffset` / `getPitchOffset` / `getVoice`
- `Note.getAttributes`（`dF0Vbr*` 系列）
- `Project` 方法全集（无 revision，仅 `newUndoRecord`）
- `TimeAxis.getBlickFromSeconds` / `getSecondsFromBlick`

源码（`0c91ebf`）：

- `server/src/musical-time.js:130,144` — Node 侧自建秒↔BLICK 换算
- `server/src/audition.js:66-67` — 全仓库唯一的宿主 TimeAxis 调用
- `server/src/response-budget.js:12,18,21` — 16/8/16 KiB 预算
- `server/src/expression-plan.js:63,438,459,730` — `vibratoEnv` 既有写入路径
- `server/src/expression-gestures.js:262` — `surface` 枚举 `pitchDelta | vibratoEnv`
- `server/src/bake-computed-pitch.js:271,289` — 既有 RDP 与垂直误差实现
- `server/src/pitch-control.js:20-33` — 单位纪律与点数上限
- `server/src/transport-pipe.js:29-35` — 10 s 超时、64 队列、64 KiB 帧
- `staging/StartSynthVCopilotPipe.lua:6,571` — `IDLE_MS = 20`、lockstep 循环
- `server/src/operation-catalog.js` — facade 路由与 operation 名派生规则
- `server/src/index.js` — `sv_audition_compare` 契约、planner schema

外部（本轮核验）：

- Saitou et al., ICAD 2002 / Speech Prosody 2004 / WASPAA 2007 — 二阶模型与 rad/ms 参数表
- Yang, *AVA* (ISMIR 2016) 与 QMUL 博士论文 — FDM 颤音、HMM+GMM portamento、logistic 模型
- MCP Python SDK v2.0.0 release notes（2026-07-28）
- GitHub API：7 个依赖仓库的 commit 解析、许可证与推送时间
