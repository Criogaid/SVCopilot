# SV2 可解释音高技法系统可行性研究报告

## 1. 文档信息

- 评估对象：`docs/deep-research-report.md`
- 评估基线：SVCopilot `0c91ebf`（2026-08-02）
- 评估范围：数学模型、SV2 宿主能力、现有 MCP 架构、事务安全、开源复用、运行时选型与研究验证
- 结论等级：**有条件可行，建议分阶段实施**

## 2. 执行结论

研究报告的核心方向成立：把 LLM 的音乐意图转换为可审阅的技法参数，再编译为 SV2 音高控制，最后用 computed pitch 做客观反馈，比让模型直接堆控制点更稳定、可解释，也更容易测试。

但不能按原报告原样落地。SVCopilot 已经拥有成熟的 Node MCP 服务、Lua 宿主桥、PlanRef、Artifact、补偿事务、两种音高写面和 computed-pitch 分析。重新建立一套 Python MCP 服务和十余个顶层工具会复制现有职责、破坏统一事务边界，并增加安装与协议成本。

推荐方案是：

1. 保留 Node.js 作为唯一 MCP 门面和事务权威。
2. 先在 Node 内实现纯函数的 `TechniqueIR`、前向模型、组合器和编译器。
3. 复用现有 `sv_plan`、PlanRef、`sv_edit`、Artifact 和 computed-pitch 工具链。
4. 只有非线性拟合经基准证明纯 Node 不足时，才引入可替换的计算 worker；worker 可以是 Rust、Python、WASM 或其他满足门禁的实现，不是第二个 MCP 服务。
5. 自动技法识别、宿主闭环优化和听感评价分开交付，不能把“数学曲线拟合成功”表述为“更好听”。

按这一修订，**前向技法生成与安全编译为高可行性；参数拟合为中高可行性；宿主闭环校准为中等可行性；任意音频的自动技法识别和全自动听感优化仍属于研究项目**。

## 3. 当前项目已经具备的基础

| 能力 | 当前状态 | 代码证据 | 对新方案的意义 |
|---|---|---|---|
| MCP 单一门面与领域路由 | 已具备 | `server/src/operation-catalog.js`、`server/src/index.js` | 新能力应作为现有 facade operation，而非新建 MCP 服务 |
| 范围 Context 与 occurrence 身份 | 已具备 | `server/src/musical-range.js`、`server/src/scope-source.js` | TechniqueIR 可以使用 `contextId + occurrence + note index`，无需长 ID |
| 绝对秒与 BLICK 换算 | 已具备 | `server/src/musical-time.js` | 可正确处理变速工程，不需要固定 BPM 假设 |
| 启音、收音、滑音、颤音等规划 | 部分具备 | `server/src/expression-plan.js`、`server/src/pitch-gesture-plan.js` | 已有业务入口，但曲线族仍以 power/smoothstep/sinusoid 为主 |
| `pitchDelta` Automation 事务 | 已具备 | `server/src/parameter-curve.js` | 可作为相对音高偏差的编译目标 |
| `PitchControlCurve` 事务 | 已具备 | `server/src/pitch-control-patch.js` | 可作为覆盖生成音高的编译目标 |
| computed pitch 捕获与等待 | 已具备 | `server/src/musical-range.js`、`server/src/processing.js` | 可用于客观反馈，但必须保留 null/coverage 语义 |
| computed pitch 分析 | 已具备 | `server/src/computed-pitch-compare.js` | 已有中心音高、颤音、过渡、异常段等指标 |
| computed pitch 固化与简化 | 已具备 | `server/src/bake-computed-pitch.js` | 已有 RDP、坐标换算、覆盖率和误差报告 |
| PlanRef、Artifact 与防重放 | 已具备 | `server/src/plan-reference.js`、`server/src/plan-ledger.js`、`server/src/artifact-store.js` | 大型曲线和执行载荷无需回传给 LLM |
| 写前预检、读回验证、补偿 | 已具备 | `server/src/chunked-mutation.js` 及各 mutation service | 新编译结果可进入现有安全写入内核 |
| 听感闭环 | 受限 | `server/src/audition.js`、`server/src/audition-compare.js` | 只能标记 `human_only`，宿主 API 不提供音频渲染给模型 |

因此，本项目缺少的不是“怎么控制 SV2”，而是以下研究层：

- 统一、可版本化的技法中间表示；
- Saitou 二阶瞬态与可识别 Richards/广义 logistic 模型；
- 颤音、基线、过渡和瞬态的分解/拟合；
- 从 TechniqueIR 到现有两个写面的误差受控编译；
- 有界、可恢复、可度量的宿主反馈校准；
- 可复现实验数据和真实宿主验收集。

## 4. 分项可行性矩阵

| 子系统 | 可行性 | 主要依据 | 关键限制 |
|---|---|---|---|
| TechniqueIR 与单位系统 | 高 | 纯数据建模；现有 schema/Artifact/PlanRef 可直接承载 | 必须区分 seconds、BLICK、cents、semitones 与写面 |
| 二阶瞬态前向模型 | 高 | 公式明确，可对欠阻尼/临界/过阻尼分支做解析测试 | 参数相关性强，前向生成易、反推难 |
| Richards/logistic 过渡前向模型 | 高 | AVA 公式和代码公开；可重参数化为显式拐点 | 不能同时自由拟合原式的 `A` 和 `M` |
| 时变正弦颤音模型 | 高 | 现有 planner 已有秒域正弦和 envelope 基础 | 需要定义 phase、drift、fade 的唯一语义 |
| 多技法组合 | 高 | 可用确定性加法/覆盖规则实现 | 重叠技法必须有冲突和裁剪规则，不能依赖数组顺序偶然决定 |
| 编译到 `pitchDelta` | 高 | 官方单位和值域明确，现有批量事务成熟 | Automation 插值模式会影响误差保证 |
| 编译到 `PitchControlCurve` | 高 | 官方支持连续覆盖曲线，现有读写和 fingerprint 已完成 | 该写面覆盖生成音高，和 `pitchDelta` 叠加时可能双重作用 |
| 曲线压缩 | 高 | 当前 RDP 已落地 | 误差必须在宿主实际插值/采样网格上复核 |
| computed-pitch 指标评价 | 高 | 官方 API 与现有 compare 服务已验证 | null、未处理、无声区必须保持不同语义 |
| 受控参数拟合 | 中高 | 低维模型可用多起点有界最小二乘 | 初值、混合技法、低采样率和不可识别性会影响恢复 |
| 自动分解/检测 | 中 | AVA 提供 HMM 和先去颤音再拟合的参考流程 | 商业歌声、混合技法、断音和 SV2 特有生成行为需要新数据集 |
| 宿主迭代反馈控制 | 中 | 可以在单次高层 operation 内写入、采样、接受或补偿 | 宿主异步、无程序化 Undo；崩溃/断连时可能只能报 `outcome_unknown` |
| 自动听感优化 | 低/能力阻塞 | 官方脚本 API 可播放但不向 MCP 提供渲染音频 | 没有音频就无法客观判断咬字、音色或“是否更自然” |
| 通用歌手模型 | 低/研究项 | singer 身份和声库信息仍不可完整观察 | 只能按可观察 voice profile、宿主版本和夹具做局部校准 |

## 5. 对原研究报告的关键修订

### 5.1 Python 是候选实现，不是架构前提

报告中的 NumPy/SciPy 代码适合作为数值参考。官方 MCP Python SDK `v2.0.0` 也确已在 2026-07-28 发布，但这只能证明 Python 可以实现 MCP，不能证明本项目应该再运行一个 Python MCP 服务。

当前项目的 Node 服务已经承担：schema、surface、Context、Artifact、PlanRef、ledger、协调器、宿主错误分类和补偿事务。把这些再做一遍会产生两个事实来源。

推荐语言策略：

| 层 | 默认实现 | 何时允许替换 |
|---|---|---|
| TechniqueIR、前向模型、组合、采样、压缩 | Node.js 纯函数 | 只有基准或数值稳定性不达标时 |
| 有界非线性拟合 | 先做统一 worker 接口和基准 | Node、Rust、Python/WASM 按门禁选胜者 |
| MCP、事务、Artifact、宿主协调 | 继续 Node.js | 不拆分 |
| 宿主对象访问 | 继续 Lua bridge | 仅增加经过实测证明必要的有界 bulk read |

候选计算后端的取舍：

- Node：部署最简单，适合前向模型；现成 LM 包可用，但对 robust loss、边界和病态问题的成熟度需自行验证。
- Rust 原生/WASM：单二进制、类型和性能较好；需要构建、签名和跨平台发布链，部分 LM 实现不自带 robust loss/box constraints。
- Python + SciPy：`least_squares` 原生提供 bounds 与 robust loss，最适合快速研究；代价是 Python 环境、进程生命周期和依赖分发。

最终选择必须由同一 synthetic corpus 的恢复率、p95 时延、失败诊断、安装成功率和包体积决定，不能由报告示例语言决定。

### 5.2 不新增十余个顶层 MCP 工具

原报告列出的 snapshot、generate、fit、decompose、compile、apply、poll、evaluate、restore、log 等签名表达了职责，但不适合直接成为新 surface。

推荐映射：

| 研究职责 | SVCopilot 归属 |
|---|---|
| 生成/拟合 TechniqueIR | `sv_plan` 新 operation |
| 读取 computed pitch/分析结果 | 现有 `sv_read` operation |
| 大型 IR、采样和 fit evidence | Artifact |
| 编译结果 | planner 封存的 PlanRef |
| 写入 | 现有 `sv_edit` mutation operation |
| 试听 | 现有 `sv_audition`，保持 `human_only` |
| 实验诊断 | opt-in diagnostics / Artifact，不默认进入 LLM 主响应 |

### 5.3 不使用不存在的 `project_revision`

SV2 官方 `Project` API 没有 revision getter。目标身份应继续使用当前已经验证的组合：

```json
{
  "contextId": "ctx_...",
  "occurrence": 0,
  "targetGroupUuid": "...",
  "expectedTimeOffsetBlick": 0,
  "referencedFingerprints": ["..."]
}
```

PlanRef capsule 保存最小依赖，commit 时再做 live target、UUID、指纹和 shared-target 校验。不能为满足论文式 API 外观而编造版本号。

### 5.4 不提供任意时点的 `restore_transaction(transaction_id)`

官方 `newUndoRecord()` 只建立用户 Ctrl+Z/Ctrl+Y 边界，没有脚本侧“立即 Undo”。成功提交后如果用户继续编辑，再用旧 snapshot 恢复会覆盖新工作。

可安全支持的是：

- 同一请求内、第一次写前完成 journal；
- 写入失败时逆序补偿并读回验证；
- 有界实验 operation 在持有协调器期间试写、测量、接受或恢复；
- 断连/超时无法证明结果时返回 `outcome_unknown`，禁止盲目重试。

长期可重放的恢复 token 不在可承诺范围内。

### 5.5 shared NoteGroup 不能靠 clone reference 自动隔离

官方文档明确：`NoteGroupReference.clone()` 不复制目标 `NoteGroup`。隔离必须深拷贝目标 group、加入 project library、建立/重定向 reference，并验证 voice、offset、scriptData 和共享关系。当前方案第一阶段应拒绝或要求显式确认 shared-target 写入，不把“自动 clone”作为已解决能力。

### 5.6 computed pitch “稳定”是策略，不是宿主保证

官方说明 computed-pitch API 可能在处理未完成时返回空数组，并按 `NoteGroupReference` 计算。连续两次相同结果可以作为工程稳定性证据，但不等于宿主提供版本一致性保证。

轮询结果必须同时报告：

- 请求帧数、返回帧数和 finite/null 数；
- coverage；
- 连续相同观测次数和 hash；
- timeout、宿主版本与 occurrence；
- “ready”“insufficient data”“stability not established”的区别。

## 6. 推荐的领域模型

TechniqueIR 只表达音乐与数学语义，不携带宿主 handle，也不直接携带大数组。示意契约如下：

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
      "anchor": {"fromNote": 12, "toNote": 13},
      "model": {
        "family": "richards_identifiable",
        "inflectionSeconds": 4.82,
        "steepnessPerSecond": 18.0,
        "asymmetry": 1.2
      }
    },
    {
      "id": "tech_1",
      "kind": "vibrato",
      "anchor": {"note": 13},
      "model": {
        "family": "time_varying_sinusoid",
        "rateHz": 5.4,
        "depthCents": 34,
        "phaseRadians": 0.0,
        "fadeInSeconds": 0.18,
        "fadeOutSeconds": 0.12
      }
    }
  ],
  "composition": {"rule": "sum_then_clamp", "maxAbsCents": 200}
}
```

必要约束：

1. 模型时间统一用绝对 seconds；编译时逐采样点经 TimeAxis 映射到 BLICK。
2. IR 音高统一用相对 score 的 cents；编译器负责转为 Automation cents 或 PitchControl semitones。
3. 锚点使用 occurrence 内 note index，不重复长 note ID。
4. 每个模型族有独立版本；改公式或默认值必须改变 model version。
5. `composition` 明确重叠规则、clamp 与优先级；不得依赖输入遍历顺序。
6. 大型 IR 和采样结果进入 Artifact；普通 planner 响应只返回摘要、警告、PlanRef 和人工复核要求。

## 7. 数学与数值判断

### 7.1 二阶模型

Saitou 模型适合 overshoot、preparation 和衰减瞬态的前向生成。实现必须针对欠阻尼、临界阻尼和过阻尼分支分别计算，避免在阻尼比接近 1 时直接使用数值不稳定的统一公式。

参数反推不应一开始同时拟合所有自由度。建议先用峰值时间、首峰幅度和衰减比构造初值，再进行有界局部优化，并输出条件数/多起点分歧作为 identifiability evidence。

### 7.2 Richards/广义 logistic

AVA 原式中 `A * exp(-G * (t - M))` 可改写为 `(A * exp(GM)) * exp(-Gt)`，因此 `A` 与 `M` 同时自由时不可单独识别。原报告提出改为显式 inflection time 是必要修正，不是可选优化。

第一版只需要拟合端点、拐点、steepness 和 asymmetry；端点优先来自相邻 score notes 或稳态窗口，避免全部参数一起漂移。

### 7.3 颤音

实用生成模型应采用带时间变化 envelope、rate 和 center drift 的正弦，而不是强行把所有颤音都解释为无阻尼二阶系统。现有 `expression-plan.js` 已证明秒域相位采样可以工作；新模型需要补齐统一 phase、fade、drift 和拟合 evidence。

### 7.4 分解顺序

推荐的受控分解顺序与 AVA 的经验一致：

1. 清洗 null/离群点并保留缺失 mask；
2. 转为相对 score cents；
3. 估计缓慢 baseline；
4. 检测并暂时移除颤音；
5. 在音符边界附近找单调 transition；
6. 拟合 logistic；
7. 在剩余局部峰/谷上拟合二阶瞬态；
8. 做一次有限的联合 refinement；
9. 把无法解释的残差作为 residual evidence，而非继续堆技法。

这一路径对“已知 score + SV2 computed pitch”的受控场景可行；对任意音频仍需独立 F0 提取、对齐和数据集，不应混入首发范围。

## 8. 开源复用判断

核验日期为 2026-08-02。真正复用前仍需固定 commit、保存 LICENSE/NOTICE，并做逐文件来源记录。

| 项目 | 核验版本 | 许可证 | 建议 |
|---|---|---|---|
| AVA | `77e4dfe` | Apache-2.0 | 适合参考/移植 HMM 状态逻辑和 logistic 参数化；MATLAB GUI、YIN 二进制和数据子目录需逐项查来源 |
| real-voice | `172259a` | MIT | 适合验证 SV 工作流与真实音高文件处理，不作为数学内核 |
| SVScripts | `8825fbe` | MIT | 适合核对 PitchControl 创建方式；其固定 duration 换算不能直接沿用到变速工程 |
| OpenUtau | `29e0e16` | MIT | 适合参考编辑器中的颤音参数和曲线数据结构，不复制完整编辑器架构 |
| LibreSVIP | `983a595` | MIT | 适合参考 time synchronization、SynthV pitch simulation、sigmoid transition 和格式转换；不建议引入整个项目模型层 |
| VibratoScope | `a7a8d3b` | MIT | 适合参考 cycle metrics 和离群点处理；需在合成 drift/rate modulation 上重新验证 |
| MCP Python SDK | `v2.0.0` | MIT | 仅在最终选择 Python worker 且确需 MCP 时有价值；当前建议 worker 不说 MCP |

Saitou 论文是研究依据，不是可直接 vendor 的开源实现。JAIST 保存的作者稿标注 CC BY-NC-ND 4.0，并引用 Elsevier 正式出版物。项目可以独立实现论文描述的数学方法，但不应复制论文文本、图表或把其材料当作宽松许可代码。

## 9. 推荐运行时架构

```text
LLM
  -> existing sv_plan facade
     -> TechniqueIR validator
     -> deterministic forward models / composer
     -> compiler (seconds -> BLICK, cents -> target surface)
     -> existing Artifact + PlanRef
  -> existing sv_edit facade
     -> live preflight + shared-target guard
     -> existing parameter/pitch-control transaction kernel
     -> computed-pitch observation/evaluation
     -> verified success, verified compensation, or outcome_unknown

Optional fitting worker (only if selected by benchmark)
  <-> bounded versioned JSON messages
  <-> no host handles, no MCP surface, no write authority
```

worker 必须满足：

- 启动时 capability/version handshake；
- 只收纯数据，不收宿主 handle、pipe 名或任意文件路径；
- request/response 大小、迭代数、CPU 时间和并发数有上限；
- crash/timeout 只使拟合失败，不影响 Node/Lua bridge；
- 同一输入、同一版本、同一 seed 产生确定结果；
- 结果带 solver、版本、termination reason、cost、bounds、initialization 和 warnings；
- 可以在不改 MCP 契约的前提下替换语言实现。

## 10. 主要风险与控制

| 风险 | 影响 | 控制措施 |
|---|---|---|
| 技法参数不可识别 | 拟合看似成功但参数无意义 | 重参数化、固定端点、多起点、置信/分歧 evidence、拒绝病态结果 |
| 多技法混合 | 错把 vibrato 当 transition 或瞬态 | 分阶段分解、候选窗口、残差上限、允许 `unexplained` |
| computed pitch 异步或全 null | 反馈失真 | coverage/stability 门禁、超时不写或补偿、保留 null |
| 变速下时间换算错误 | 频率和时长漂移 | 逐绝对秒采样后调用 TimeAxis，不把 duration 直接当 absolute time |
| 两种写面双重作用 | 音高过度修正 | IR 明确 target surface；默认不同时修改；冲突时要求确认 |
| shared target side effect | 其他 occurrence 被同时改动 | 复用 project-wide shared-target 扫描和确认 |
| 闭环试写后崩溃 | 状态无法证明 | 单请求 journal、严格迭代预算、断连返回 `outcome_unknown`、禁止自动重试 |
| 输出曲线过大 | LLM token 和传输膨胀 | Artifact、dense encoding、摘要响应、点数和误差双门禁 |
| 宿主版本差异 | 同一参数产生不同结果 | host profile、版本化 fixture、每版实机门禁 |
| 许可证污染 | 无法发布 | 固定 SHA、逐文件 provenance、独立实现优先、保留 NOTICE |
| “拟合好”等于“好听”的误导 | 产品承诺失真 | 所有听感结论保持 `human_only`，数值指标与主观评价分开 |

## 11. Go / No-Go 决策

### 11.1 建议立即进入实施的范围

- TechniqueIR v1；
- Richards、二阶瞬态、时变颤音的前向模型；
- 确定性组合与约束；
- 编译到现有 `pitchDelta` 和 `PitchControlCurve` PlanRef；
- synthetic recovery 与数值稳定测试；
- computed-pitch 目标误差评价；
- 只读的拟合原型与后端选型 benchmark。

### 11.2 满足门禁后再进入的范围

- 自动 transition/overshoot/preparation/vibrato 分解；
- 单请求内的有限轮闭环校准；
- 按可观察 host profile 的局部校准模型；
- 真实宿主 A/B 数据集与统计报告。

### 11.3 当前明确不承诺

- 自动渲染音频并由 LLM 判断听感；
- 对任意商业录音可靠识别所有唱法；
- 跨歌手、声库和宿主版本通用的固定参数；
- 成功提交后任意时点可安全恢复的 transaction token；
- 自动 clone shared NoteGroup 即可保证隔离；
- 数学拟合成功等同于音乐质量提升。

## 12. 最终判断

**建议立项，但按“已有安全执行平台上的研究型音高模型扩展”立项，而不是“新建 Python MCP 管线”。**

首个可发布增量应是可解释、可审阅、可 dry-run 的前向技法规划，并通过现有 PlanRef 和事务核落地。拟合与闭环放在其后；自动听感优化继续标记为能力阻塞。这样既保留研究报告最有价值的数学内容，也不会牺牲 SVCopilot 已经建立的身份、事务、传输和诚实性契约。

## 13. 主要来源

- [Synthesizer V Studio 2 Scripting Manual](https://resource.dreamtonics.com/scripting/)
- [SV.getComputedPitchForGroup](https://resource.dreamtonics.com/scripting/SV.html)
- [TimeAxis](https://resource.dreamtonics.com/scripting/TimeAxis.html)
- [Automation](https://resource.dreamtonics.com/scripting/Automation.html)
- [PitchControlCurve](https://resource.dreamtonics.com/scripting/PitchControlCurve.html)
- [Project.newUndoRecord](https://resource.dreamtonics.com/scripting/Project.html)
- [NoteGroupReference clone/target semantics](https://resource.dreamtonics.com/scripting/NoteGroupReference.html)
- [Saitou et al., Development of an F0 control model based on F0 dynamic characteristics for singing-voice synthesis](https://doi.org/10.1016/j.specom.2005.01.010)
- [JAIST author manuscript record](https://dspace.jaist.ac.jp/dspace/handle/10119/18075?locale=en)
- [AVA project description](https://luweiyang.com/research/ava-project/)
- [AVA source repository](https://github.com/skx300/ava)
- [LibreSVIP](https://github.com/SoulMelody/LibreSVIP)
- [OpenUtau](https://github.com/openutau/OpenUtau)
- [VibratoScope](https://github.com/tiagolbc/vibratoscope)
- [real-voice](https://github.com/hataori-p/real-voice)
- [SVScripts](https://github.com/Turbo49/SVScripts)
- [SciPy bounded robust least squares](https://docs.scipy.org/doc/scipy/reference/generated/scipy.optimize.least_squares.html)
- [Rust argmin](https://docs.rs/argmin/latest/argmin/)
- [Rust levenberg-marquardt](https://docs.rs/levenberg-marquardt/latest/levenberg_marquardt/)
- [MCP Python SDK v2](https://github.com/modelcontextprotocol/python-sdk/releases/tag/v2.0.0)
