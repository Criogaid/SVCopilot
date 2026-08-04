# 深度研究交叉验证报告

## 0. 文档信息

- 评估日期：2026-08-02
- 仓库基线：`0c91ebf`（SV Copilot `0.9.0`）
- 评估性质：独立交叉验证，不替代也不修改任何输入文档
- 结论对象：可解释音高技法、曲线编译、computed pitch 分析、开环/闭环校准与逆向拟合

本报告交叉核对以下五份输入：

| 输入 | SHA-256 | 字节数 |
|---|---|---:|
| `deep-research-report.md` | `92a3076386ed4779d614587d045e753e00716ae6b98f735d3d4a0722396704f4` | 70,512 |
| `DEEP_RESEARCH_FEASIBILITY_ASSESSMENT.md` | `2b0f715ccff5970fd94cea380387b7e149f7257898d843db2dbb26534660fe76` | 21,135 |
| `DEEP_RESEARCH_EXECUTION_PLAN.md` | `97b85379fff9300e69e68e2272383d21c7890ae23c99c01194377c502b338bb2` | 19,960 |
| `INTERPRETABLE_PITCH_TECHNIQUE_FEASIBILITY_REPORT.md` | `523a6324cc9a68649338bdd993988d383b3ee3c1d90f523e228b51111001ceda` | 21,806 |
| `INTERPRETABLE_PITCH_TECHNIQUE_IMPLEMENTATION_PLAN.md` | `ac15aa066633fb5c099f15bae1afe898a270cb83ee3f845af9a6ae0abfb4a607` | 26,224 |

## 1. 执行结论

**项目有条件可行，而且最有价值的第一批能力可以直接建立在当前 SVCopilot 上。**

两套评估的共同方向是对的：不新建第二个 MCP，不让 LLM 直接堆密集音高点，不依赖不存在的
`project_revision` 或脚本侧 Undo API；复用现有 Context、PlanRef、Artifact、事务、读回验证、
computed pitch 和试听状态机。

交叉验证后，建议采用以下裁决：

1. **Node 继续是唯一 MCP、宿主连接和写事务权威。**
2. **实现语言不预先锁定。** 前向模型和简单带状线性求解器适合直接写在 Node；非线性拟合后端由
   Node、Rust、Python/SciPy、WASM 或其他候选通过统一 benchmark 决定。外部 worker 不是第二个 MCP，
   也不得持有宿主句柄或写权限。
3. **先扩展现有 `plan_pitch_gesture`，不新增重复的 `plan_pitch_techniques`。** TechniqueIR 是内部
   可版本化中间表示，不必等同于新的公开工具。
4. **先做前向模型、宿主语义探针和开环校正。** 逆向拟合随后进入；闭环校准最后且条件启用。
5. **Opus5 发现的三项宿主风险必须纳入发布门禁：**固定 BLICK 采样在变速处不是等秒采样、
   `vibratoEnv`/`dF0VbrMod` 可能与显式正弦重复作用、`pitchDelta` 与 `PitchControlCurve` 的组合语义未知。
6. **Opus5 对 Undo 的结论过强。** K 次内部候选写入不必然等于 K 个用户 Undo；现有事务已经在两次
   `newUndoRecord()` 边界之间执行多次写入。单 operation、单 Undo 的有界闭环在架构上可行，但必须由
   真机与故障注入证明，不能先承诺。
7. **两份计划中的 Richards 与二阶瞬态契约都要修正。** 有限区间 Richards 必须归一化才能严格命中
   两端；“首峰时间 + 首峰幅度”参数化只适用于欠阻尼，不能与临界/过阻尼分支混成一个公开契约。

## 2. 验证方法与证据等级

本次没有把另一份报告当作证据本身，而是按以下顺序裁决：

1. 当前仓库代码、测试与生成的 API manifest；
2. 本地镜像和在线官方 Synthesizer V Studio 2 Scripting Manual；
3. Saitou 作者稿、AVA 论文与源代码、SciPy 官方文档等一手来源；
4. 可直接代数证明或数值反例；
5. 仍无法由文档/静态代码确认的宿主行为，明确标为 `host-gated`。

| 等级 | 含义 |
|---|---|
| `confirmed` | 官方契约、当前代码或可重复数学推导直接证明 |
| `supported` | 有论文/实现和工程证据支持，但仍需项目数据定标 |
| `host-gated` | 只能通过可恢复的真实宿主实验确认 |
| `benchmark-gated` | 能实现，但技术选型必须由同环境基准决定 |
| `capability-blocked` | 当前官方宿主面或产品范围不提供所需输入/输出 |
| `rejected` | 与当前代码、数学或产品约束矛盾 |

## 3. 当前基线的事实校正

### 3.1 公开工具与 API 数量

当前 `operation-catalog.js` 机械统计为：

- 41 个 routed operations；
- 7 个业务 facade 分类：`status/read/plan/edit/audition/artifact/raw`；
- 另有独立 schema discovery 工具 `sv_describe`；
- 因此 compact surface 是 8 个公开工具名，而不是“42 operations / 7 facade tools”。

`api-docs/api-manifest.json` 当前摘要为：

- 23 classes；
- 370 method names；
- 371 method overloads。

Opus5 的“23 类、370 方法”若指 method names 是正确的；其 surface 数量已与当前代码漂移。

### 3.2 已有能力不是空白项目

下列能力已存在并通过当前测试/历史真机验收：

- 范围 Context、occurrence ordinal、note index 与 fingerprint；
- 秒/BLICK 的分段绝对时间换算；
- `pitchDelta` Automation 和 `PitchControlCurve` 两种写面；
- PlanRef、Artifact、TTL 恢复、防重放 ledger；
- 一个用户 Undo 的批量曲线与 pitch-control 事务；
- 写前冲突检查、journal、读回、补偿和不确定结果分类；
- computed pitch 捕获、稳定轮询、覆盖率、中心音高/过渡/颤音指标；
- 现有 transition/attack/release/vibrato 前向规划；
- 人类试听编排，但没有机器可读音频。

因此“首版完成 60–70%”只能作为粗略描述，不能作为验收指标。更准确的说法是：**执行平台基本
完备，研究模型层、宿主组合语义和拟合层未完成。**

## 4. 共同结论：两套评估都正确的部分

| 主题 | 交叉结论 | 证据等级 |
|---|---|---|
| 原报告是 greenfield Python 方案 | 与当前成熟 Node MCP 重叠，不能原样照搬 | `confirmed` |
| `project_revision` | 官方 API 不存在 | `confirmed` |
| 程序化 Undo | 只有 `newUndoRecord()` 分组边界，没有 `undo()` | `confirmed` |
| arbitrary restore token | 成功提交后不能安全提供长期恢复令牌 | `confirmed` |
| shared NoteGroup | `NoteGroupReference.clone()` 不复制 target NoteGroup | `confirmed` |
| computed pitch | 可用但异步，可为空数组或含 null，稳定性需工程判据 | `confirmed` |
| Saitou 二阶模型 | 适合 overshoot/preparation 等衰减瞬态 | `supported` |
| AVA/Richards | 适合非对称转换，原 `A+M` 同时自由不可识别 | `confirmed` |
| 稠密曲线 | 应隐藏在 PlanRef/Artifact，不进入普通 LLM 响应 | `confirmed` |
| 音频闭环 | 官方 scripting API 不向 MCP 提供渲染音频 | `capability-blocked` |
| 人类试听 | 可以编排播放/恢复，但不能冒充机器听感评价 | `confirmed` |

## 5. Opus5 评估新增且应采纳的内容

### 5.1 固定 BLICK 采样不是等秒采样

官方 `getComputedPitchForGroup(groupReference, blickStart, blickInterval, numFrames)` 明确以固定
`blickInterval` 采样。当前 `computed-pitch-compare.js` 的 `frameRateAt()` 只在某个 BLICK 位置把单个
间隔换算成局部秒长；整条序列仍不是均匀秒网格。

这对中心音高统计影响较小，但对 Hz 域颤音率、自相关、滤波和跨 tempo change 的拟合有系统性影响。
因此：

- 原始 BLICK 样本必须保留；
- Hz 域算法前必须生成显式秒时间戳；
- 只有在目标等秒网格上重采样后，才可使用固定采样率算法；
- null gap 不得跨越插值；
- provenance 必须声明原始网格和分析网格。

判定：`confirmed`，属于第一阶段修复。

### 5.2 `vibratoEnv` 与 `dF0VbrMod` 是不能忽略的宿主面

官方 manifest 确认：

- `Automation` 有 `vibratoEnv`，范围 0–2，默认 1；
- `Note.getAttributes()` 有 `dF0VbrMod`。

当前 `pitch-gesture-plan.js` 的 vibrato 会生成显式正弦 PitchControl。该正弦是否与宿主原生颤音相加、
覆盖或被缩放，官方文档没有给出完整组合语义。因此“双重颤音”是**高可信风险**，但不是已由官方文档
证明的具体叠加公式。

判定：字段存在为 `confirmed`；组合关系为 `host-gated`。任何新的显式颤音发布必须先完成真机矩阵。

### 5.3 两种音高写面的相互作用未知

官方说 `PitchControlCurve` 覆盖生成音高，但没有说明覆盖区间内 `pitchDelta` 是否仍参与最终结果。
当前 `bake-computed-pitch.js` 也明确拒绝在同一操作中清除 `pitchDelta`，因为跨类型 journal/Undo/rollback
尚未实现。

判定：`host-gated`。在证据出现前，两个 surface 不能被描述为可以任意并列叠加的等价目标。

### 5.4 宿主实际插值必须进入误差后置条件

官方 Automation 只提供 `getInterpolationMethod()`，没有 setter；`get()` 使用当前宿主插值，
`getLinear()` 强制线性。`PitchControlCurve.getValueAt()` 返回自身插值值。

当前 `parameter-curve.js` 已经：

- 捕获 `getInterpolationMethod()`；
- 在 simplify 路径用 `Automation.get()` 采样；
- 失败时触发 postcondition 和补偿。

因此正确扩展不是增加旁路“检查工具”，而是让编译事务在声明的验证网格上调用宿主实际读值；误差超限
必须 rollback，而不是成功加 warning。PitchControl 同理可用 `getValueAt()`。

判定：`confirmed`，可直接复用现有事务骨架。

### 5.5 活工程 computed pitch 是闭环硬前提

官方 computed pitch 以 `NoteGroupReference` 为输入，同一 target 在不同 reference/tempo/vocal mode 下可
产生不同结果。离体对象不能代表最终宿主生成路径。

判定：`confirmed`。离体模型可做 dry-run、journal 或合成测试；真实反馈必须短暂作用于活 occurrence。

## 6. Opus5 计划需要修正的部分

### 6.1 不应硬锁 JavaScript

“Node 是唯一 MCP/事务权威”不等于“所有数值算法必须用 JavaScript”。

简单的五对角 SPD 开环求解器适合直接在 Node 实现；低维前向闭式模型也没有引入 worker 的必要。
但带 bounds、robust loss、多起点和超时隔离的非线性拟合，其实现质量、部署成本和性能必须实测。
SciPy 官方 `least_squares` 已原生支持 bounds 与 robust loss；Rust/WASM 和 Node 也有各自优势。

判定：JS 硬锁 `rejected`；统一 adapter + benchmark 为 `accepted`。

### 6.2 Richards 公式不严格命中有限区间端点

Opus5 A1 给出的 raw progress：

```text
r(t) = exp(-logaddexp(0, log(B) - G(t - tR)) / B)
```

是以 0/1 为渐近线的 Richards 曲线，不会在有限 `t=0` 和 `t=T` 自动等于 0/1。以
`B=1, sharpness=6, inflectionRatio=0.5` 为例：

```text
r(0) = 0.04742587317756678
r(T) = 0.9525741268224334
```

所以它与“端点严格命中”退出条件矛盾。正确的 finite-segment 编译形式是：

```text
q(t) = rawRichards(t)
u(t) = (q(t) - q(0)) / (q(T) - q(0))
y(t) = y0 + (y1 - y0) * u(t)
```

该仿射归一化严格命中端点，并保留 raw 曲线的拐点位置。需要把分析用的 asymptotic Richards 与编译用的
`richards_segment_normalized` 分成两个明确模型名，避免拟合参数和有限段参数混淆。

判定：Opus5 A1 原契约 `rejected`，归一化版本 `accepted`。

### 6.3 二阶瞬态 schema 与分支要求自相矛盾

Opus5 A2 请求将 `dampingRatio` 限定为 `[0,1)`，却又要求临界和过阻尼分支可达，并称为“四个分支”但
实际只列出欠阻尼、临界、过阻尼三个阻尼区间。

更关键的是：

```text
omega = acos(zeta) / (tPeak * sqrt(1-zeta^2))
```

只对 `0 <= zeta < 1` 的首个振荡峰有效。临界/过阻尼响应没有同样定义的“首个振荡峰”，不能复用该
参数化。

正确拆分：

- 通用内部 `secondOrderImpulse(naturalHz, dampingRatio, gain)`：覆盖欠/临界/过阻尼三个区间；
- 音乐化 `transientFromFirstPeak(peakSemitone, peakTimeSeconds, dampingRatio)`：明确只允许欠阻尼；
- 若未来需要临界/过阻尼音乐技法，另用 `naturalHz + gain + settling` 类参数，而不是假装有首峰。

判定：原统一 schema `rejected`，拆分契约 `accepted`。

### 6.4 “尾部必须在音符边界前小于 1 cent”不应是全局硬规则

overshoot、preparation 或跨音符转换可以合法跨越 note boundary。强制在边界前衰减会排除一部分真实
技法；直接截断又会产生不连续。

统一约束应是：

- span 必须显式；
- 默认将超出声明 span 的尾部视为约束错误；
- 调用方可选择经验证的连续 taper；
- 跨 note boundary 必须由 anchor/span 明确表达；
- epsilon 按目标 surface 和编译误差预算设置，不硬编码 1 cent。

### 6.5 K 轮闭环不必然等于 K 个 Undo

官方定义：一次 `newUndoRecord()` 后的所有编辑会作为一组被撤销/重做。当前曲线事务与 PitchControl
事务均采用“开边界 -> 多次写/验证/必要时补偿 -> 关边界”，并对外报告一个用户 Undo。

因此若 K 次候选都在**同一个高层 operation、同一个独占 coordinator、同一 journal 和同一对 Undo
边界**内完成，理论上可以只形成一个用户 Undo。真正风险是：

- computed pitch 异步等待让事务持锁时间变长；
- bridge disconnect/host timeout 后状态可能不可证明；
- 宿主是否在长时间异步处理期间维持预期 Undo grouping 需真机确认；
- 失败时必须恢复到原始或最后接受状态并读回。

判定：Opus5 的“K 或 2K 是硬约束”`rejected`；单 Undo 闭环为 `host-gated`。在门禁前仍以开环为主。

### 6.6 computed pitch 仍值得使用鲁棒损失

computed pitch 比从音频提取的 F0 更干净，但仍可能含 null、突变、低采样率、宿主模型伪影、过渡重叠
和旧结果。不能因此删除 robust loss、异常诊断或多起点稳定性检查。

判定：“无需 MAD/F0 tracker”可接受；“鲁棒性要求显著消失”`rejected`。

### 6.7 score-informed window 不严格优于 HMM

音符边界是很强的先验，适合首版缩小候选窗口；但真实 portamento 可能提前、滞后或跨边界，边界先验
不是严格 oracle。合理顺序是：

1. score-informed 候选窗口；
2. 导数/持续时间/方向规则；
3. 在 host corpus 上评估漏检；
4. 只有证据显示不足时再加入 HMM 或混合分段。

判定：“先不移植 HMM”`accepted`；“有乐谱时严格更好”`rejected`。

### 6.8 clean-room 不等于永远禁止外部运行时

`THIRD_PARTY_NOTICES.md` 记录当前发布没有复制第三方源代码，并对 SV2-Script 采用 clean-room 重写。
它没有自动证明任何未来依赖都被永久禁止。另一方面，引入外部运行时确实会增加安装、诊断、许可和
供应链成本。

判定：默认独立实现、禁止未经决策复制代码；任何 worker 必须经许可证与部署门禁。不能用政策口号代替
benchmark，也不能未经 NOTICE/许可审计直接 vendor。

## 7. 先前可行性报告与计划需要修正的部分

### 7.1 遗漏了原生颤音组合门禁

先前报告识别了两种 pitch surface 的叠加风险，但没有把 `vibratoEnv`/`dF0VbrMod` 提升为颤音发布的
硬门禁。这是 Opus5 最重要的补充，应进入统一计划的 Phase 0。

### 7.2 新增 `plan_pitch_techniques` 没有必要

现有 `plan_pitch_gesture` 已经承担可解释 pitch gesture 的职责。再建一个近义 planner 会扩大 schema、
guide、测试和 LLM 发现成本。统一计划改为扩展现有 operation；TechniqueIR 保持内部模型和 Artifact
格式。

### 7.3 二阶模型内部契约与公开首峰契约应拆开

先前计划要求通用 response 覆盖三个阻尼区间，这是正确的数值库要求；但把同一组首峰测试套在三个
区间上不严谨。统一计划按 §6.3 拆分。

### 7.4 编译保真应在写事务中成为强后置条件

先前计划提出读取 interpolation 和宿主验收，但没有足够明确地区分：

- planner 侧只能基于捕获的插值方法预测；
- commit 后必须用 `Automation.get()`/`PitchControlCurve.getValueAt()` 采样；
- 超 epsilon 是事务失败并补偿，不是“低置信度成功”。

### 7.5 单 Undo 闭环是候选能力，不是既成事实

先前计划的状态机方向正确，但应增加独立宿主门禁：验证长事务、多轮 processing、第二轮失败、断连与
最终 Ctrl+Z 行为。门禁失败时闭环不发布，开环不受影响。

## 8. 统一能力判定矩阵

| 能力 | 判定 | 首发优先级 | 关键条件 |
|---|---|---:|---|
| endpoint-normalized Richards 前向模型 | `confirmed feasible` | P0 | 稳定计算、属性测试 |
| 欠阻尼首峰 transient | `confirmed feasible` | P0 | 独立峰值上限、显式 span |
| 通用三阻尼区间二阶响应 | `confirmed feasible` | P0 内部库 | 不直接作为同一音乐 schema |
| TechniqueIR | `confirmed feasible` | P0 | 内部版本化，不复制公开 surface |
| 宿主插值后置验证 | `confirmed feasible` | P0 | 进入现有事务/rollback |
| computed pitch 等秒重采样 | `confirmed feasible` | P0 | 保留 null mask、禁止跨 gap 插值 |
| 原生/显式颤音策略 | `host-gated` | P0 gate | 6 组合以上真机矩阵 |
| 两种 pitch surface 组合 | `host-gated` | P0 gate | 可恢复写实验 |
| 单步开环 correction | `confirmed feasible` | P1 | 五对角 SPD、一次正常 apply |
| Richards/transient/vibrato 拟合 | `benchmark-gated` | P2 | 统一 adapter、合成恢复门禁 |
| score-informed 技法分解 | `supported` | P2 | host corpus 的 precision/recall |
| HMM 分段 | `evidence-gated` | 后续 | heuristic 漏检证据 |
| 多轮单 Undo 闭环 | `host-gated` | P3 | 长事务、故障与 Ctrl+Z 验证 |
| 任意录音 F0 分析 | `capability-blocked` | 不进入当前范围 | 需另加音频输入产品面 |
| 自动听感评分 | `capability-blocked` | 不进入当前范围 | 当前只有 human-only audition |
| 程序化渲染 A/B | `capability-blocked` | 不进入当前范围 | `setBounced()` 只是导出选择标记 |

## 9. 最终架构裁决

```text
LLM
  |
  | compact semantic request
  v
Existing Node MCP facade
  |
  +-- Context / occurrence / note ordinal
  +-- TechniqueIR + forward models
  +-- planner / compiler / open-loop solver
  +-- PlanRef / Artifact / ledger
  +-- single transaction authority
  |
  +---- optional FitWorker adapter
  |       - any benchmark-winning language
  |       - pure numeric input/output
  |       - no MCP server
  |       - no host handles or writes
  |
  v
Existing PIPE bridge -> loaded SynthV Lua host script
```

不可违反的所有权边界：

- Node 生成 canonical TechniqueIR 和 plan hash；
- worker 只返回拟合候选和诊断，Node 重新验证 bounds、forward parity 和预算；
- 只有 Node transaction service 能调用 setter/`newUndoRecord()`；
- 任何 dense samples、multi-start 轨迹和曲线 evidence 进入 Artifact；
- LLM 普通响应只见参数、摘要、warnings 和 apply envelope。

## 10. Go / No-Go 裁决

### 10.1 立即 Go

- 扩展 host behavior profile 和可恢复真机探针；
- endpoint-normalized Richards；
- 欠阻尼 first-peak transient 与通用内部二阶模型；
- computed pitch 等秒重采样；
- 宿主实际插值的事务后置验证；
- TechniqueIR 内部化并扩展现有 `plan_pitch_gesture`；
- 单步开环 pitch correction；
- synthetic corpus 与拟合 adapter benchmark。

### 10.2 条件 Go

- 非线性拟合公开 operation：只有 benchmark、synthetic recovery 和 host corpus 达标后；
- 显式颤音：只有原生颤音组合关系确认后；
- PitchControl + Automation 跨面组合：只有统一事务和真机回滚通过后；
- 闭环校准：只有单 operation/单 Undo/故障恢复门禁全通过后。

### 10.3 当前 No-Go

- 第二个 MCP 服务；
- 以 Python、JavaScript、Rust 或任何语言作为未经 benchmark 的预设答案；
- `project_revision`；
- 成功提交后的通用 `restore_transaction`；
- 程序化 Undo；
- 自动音频听感评价；
- 未确认宿主语义时自动叠加两种 pitch surface 或两种 vibrato source。

## 11. 主要证据来源

- [Synthesizer V Studio Scripting Manual: SV](https://resource.dreamtonics.com/scripting/SV.html)
- [Synthesizer V Studio Scripting Manual: Project](https://resource.dreamtonics.com/scripting/Project.html)
- [Synthesizer V Studio Scripting Manual: Automation](https://resource.dreamtonics.com/scripting/Automation.html)
- [Synthesizer V Studio Scripting Manual: PitchControlCurve](https://resource.dreamtonics.com/scripting/PitchControlCurve.html)
- [Synthesizer V Studio Scripting Manual: NoteGroupReference](https://resource.dreamtonics.com/scripting/NoteGroupReference.html)
- [Saitou et al., Development of an F0 Control Model Based on F0 Dynamic Characteristics for Singing-Voice Synthesis](https://dspace.jaist.ac.jp/dspace/bitstream/10119/18075/1/specom-final_Saitou2005.pdf)
- [AVA paper, ISMIR 2016](https://archives.ismir.net/ismir2016/paper/000314.pdf)
- [AVA source repository](https://github.com/skx300/ava)
- [AVA generalized logistic implementation](https://github.com/skx300/ava/blob/master/Logistic_Modeling-package/createGeneralLogistic6Fit.m)
- [SciPy bounded robust least squares](https://docs.scipy.org/doc/scipy/reference/generated/scipy.optimize.least_squares.html)

## 12. 结论

两套评估不是互斥方案。Opus5 更强的是发现宿主组合语义、时间采样和原生颤音风险；先前方案更强的是
适配现有架构、保持数值后端开放，以及把闭环放进单事务状态机。交叉验证后的正确路线是：

**先把宿主不确定性变成可版本化证据，再扩展现有 planner 的可解释前向模型；随后交付单步开环校正，
最后用 benchmark 决定拟合后端。闭环不是默认路线，也不是 K 个 Undo 的必然路线，而是一项必须证明
“单 operation、单 Undo、可恢复”后才开放的条件能力。**
