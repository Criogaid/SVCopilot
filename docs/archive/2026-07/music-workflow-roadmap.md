# SV Copilot 音乐工作流主计划

## 1. 文档定位

- 状态：Active
- 基线日期：2026-07-26
- 当前接口：v0.9.0，40 个 MCP 工具
- 当前提交基线：`3bbeae7 Ship v0.9 pitch-control workflow and harden transactions`
- 目标：让 LLM 能够安全地分析、规划、编辑、验证并组织人类试听，而不是只会拼装底层 Synthesizer V API 调用。

本文是未来音乐工作流开发的唯一计划来源。历史需求、审查和研究材料已移入
[`README.md`](README.md)，其中的待办不再自动构成当前路线图。

状态词含义：

| 状态 | 含义 |
| --- | --- |
| `done` | 当前代码和自动化证据已经覆盖 |
| `ready` | 官方 API 支持，设计边界明确，可以排期实现 |
| `experiment` | API 可调用，但存在不可观测状态或宿主语义待实测 |
| `host-gate` | 代码路径已有，仍需 SynthV 真机数据或故障实验才能放行 |
| `capability-blocked` | 官方脚本 API 没有必要原语 |
| `not-planned` | 技术上不诚实、收益不足或已有能力覆盖，不进入路线图 |

## 2. 当前项目状况

### 2.1 已完成的基础设施

| 领域 | 当前能力 | 状态 |
| --- | --- | --- |
| 传输 | Windows named pipe、NDJSON、版本握手、严格一写一读、64 KiB 帧限制 | `done` |
| 并发 | 所有 raw 与高层工作流共享 FIFO `ExecutionCoordinator`，单命令 in-flight | `done` |
| 数据编码 | typed-v2 保留空/稀疏数组、map、nil、特殊数字和带 epoch handle | `done` |
| 句柄安全 | 重连 epoch、无 epoch handle 在重连后拒绝、显式释放和工作流自动清理 | `done` |
| API 覆盖 | 本地官方文档镜像、manifest、搜索/描述、raw escape hatch 和 advisory preflight | `done` |
| 上下文 | selection/group/project/range snapshot、TTL、UUID、occurrenceId、noteId、fingerprint | `done` |
| 大数据 | 分类型预算、cursor 纯内存续读、compact/standard/verbose、响应体上限 | `done` |
| 写入诚实性 | dry-run、冲突预检、Undo 边界、读回验证、补偿 journal、明确 outcome | `done` |
| 宿主校准 | SV Live Probe 只读采集、脱敏 Host Profile、fake-host 严格证据模式 | `done`（只读事实） |

### 2.2 已完成的音乐工作流

| 工作流 | 工具 | 状态与边界 |
| --- | --- | --- |
| 乐句读取 | `sv_snapshot`、`sv_snapshot_range` | 音符、声线、Automation、attributes、processing、computed pitch、tempo/meter、mixer |
| 处理等待 | `sv_wait_for_processing` | 音素/属性/音高；合法空音素不冒充 pending；range sampling 可继承 |
| 音符编辑 | `sv_patch_notes`、`sv_restructure_notes` | 字段 patch 与 insert/delete/split/merge，支持 range context |
| 跨类型事务 | `sv_edit_phrase` | note/lyrics/structure/curves/voice，一个 Undo，已验证补偿而非 ACID |
| 曲线读写 | `sv_get_parameter_curve`、`sv_patch_parameter_curve(s)` | 白名单、语义锚点、多曲线事务、float32 容差、数学 no-op |
| 客观音高分析 | `sv_compare_computed_pitch` | 音准中心、覆盖率、颤音、转换、异常区段和 before/after |
| 演唱表现规划 | `sv_plan_expression` | scoop/fall/portamento/vibrato/hairpin、意图/preset、单位显式、只生成计划 |
| 歌词与韵律 | `sv_align_lyrics`、`sv_validate_lyrics_prosody` | 多语种启发式对齐、mora/音节/换气/覆盖检查，不伪造独立 G2P |
| 乐句与风格 | `sv_analyze_phrase`、`sv_style_profile` | 调性候选、音级、乐句、音域、节奏、Automation 控制点和 caller label；可选和声语境（强拍角色、和弦候选、终止式、张力解决），全部 `melody_only`，音高使用 occurrence offset 后的实际发声坐标 |
| 节奏规划 | `sv_quantize_notes` | 确定性网格、strength、swing、三连音和重叠保护 |
| 和声规划 | `sv_generate_harmony` | 调内三/六度、音域/交叉保护、occurrence pitch offset、目标冲突 |
| 组合诊断 | `sv_analyze_vocal_context` | 一次调用组合乐句/韵律/风格/computed pitch，分区状态互不吞噬，零宿主调用 |
| 人类试听 | `sv_start/get/stop/restore_audition` | 非阻塞 auto-stop、状态恢复；MCP 不声称听见声音 |
| A/B 比较 | `sv_audition_compare` 等 | 编排既有版本顺序播放，复用 audition 内核；恢复失败即终止，不做临时编辑 |
| 声线观察 | `sv_get_voice_profile` | 可观察 voice 参数/vocal mode；Singer 身份仍不可观察 |
| 模板克隆 | `sv_clone_track_from_template` | 如实报告 target NoteGroup 共享，不宣称独立副本 |
| 编辑器选择 | `sv_set_selection` | 以读回判定 changed，不信宿主 boolean；context 目标复核当前编辑组 UUID；不建 Undo |

当前工作树为 518/518 Node tests，MCP smoke 覆盖 40 个工具、工作流指南资源和真实
Windows pipe + 独立 Lua bridge。它证明代码与协议路径，不等价于所有 SynthV 2.2.1 宿主语义均已校准。

### 2.3 已提交的修复与已发布的指南

`8be9e7f` 已把此前工作区中的四项修复和文档收敛提交：

1. 量化重叠修复改为稳定迭代，避免相邻 onset 回退后重新制造重叠。
2. 和声规划纳入源/目标 occurrence pitch offset，并把歌词纳入 already-applied 精确匹配。
3. `style-profile.js` target 去重键改用 NUL 分隔，lockfile 版本同步为 0.8.0。
4. `sv_wait_for_processing` 可继承 range snapshot 捕获的 computed-pitch sampling。

其后依次完成 P0-B 工作流指南资源（`server/src/workflow-guide.js`）、P0-D 统一规划器 apply
信封（`server/src/plan-envelope.js`）、P0-C 一次性声乐上下文分析
（`server/src/vocal-context.js`）、P1-A 和声语境分析（`server/src/harmonic-context.js`）
、P1-E 高层 selection（`server/src/selection.js`）和 P1-D A/B 试听编排
（`server/src/audition-compare.js`）；本轮 review 修复与回归测试使自动化基线升至 438/438。

## 3. 宿主能力边界

判断依据是仓库内 SHA-256 跟踪的官方脚本文档镜像、当前 manifest，以及 Dreamtonics
在线 Scripting Manual。新增能力必须先落入下表，不能用 UI 自动化冒充官方 API。

| 能力 | 可行性 | 设计结论 |
| --- | --- | --- |
| Note/Group/Track/Project 读写 | 可行 | 继续复用 context、fingerprint、Undo 和 read-back 内核 |
| Automation 连续值读取 | 可行 | `Automation.get()` 按宿主插值返回；可实现连续曲线变换 |
| PitchControlPoint/Curve | 可行，2.1+ | 可创建、增删、读写；单位是半音，不得与 pitchDelta 的 cents 混用 |
| Playback/loop/seek/stop | 可行 | 只能组织人类试听；状态机必须恢复 playhead 和 mixer |
| Computed pitch/attributes/phonemes | 可行但异步 | 空数组或全 null 可能持续；必须报告覆盖率和 processing 状态 |
| Retake 生成/激活/删除 | 部分可行，2.1.1+ | `generateTake()` 返回 ID；API 不能列出 ID，也不能读取当前 active ID |
| Voice 参数/vocal modes | 部分可行 | 可读写可观察参数；Singer/数据库身份不可见 |
| 独立克隆 NoteGroup | 可行 | `NoteGroup.clone()` 是深拷贝；`NoteGroupReference.clone()` 不复制 target |
| 克隆且保留隐藏 Singer | 无法保证 | Track clone 的隐藏身份不透明，独立 target 与 Singer 继承不能同时承诺 |
| 音频 render/export/字节 | `capability-blocked` | `Track.setBounced()` 只改 Render Panel 标记，不启动渲染 |
| Singer/声库枚举与分配 | `capability-blocked` | 官方目录没有 Singer/voicebank/database API |
| Project revision/event stream | `capability-blocked` | 无 revision 或变更事件；token 只能在重读后比较内容 |
| 调用 Undo/ACID 事务 | `capability-blocked` | 只有 `newUndoRecord()`；回滚继续采用补偿写 + 读回 |
| 机器听感评价 | `capability-blocked` | MCP 没有音频输入；所有“更好听”判断保持 `human_only` |

## 4. 面向 LLM 的目标工作流

LLM 的默认入口应是“范围上下文 -> 分析 -> 可审阅计划 -> dry-run -> commit -> 客观验证 ->
人类试听”，而不是 raw handle 调用。

```text
capabilities / workflow guide
  -> sv_snapshot_range
  -> composite analysis
  -> semantic planner
  -> hardened editor dry-run
  -> hardened editor commit
  -> wait + computed-pitch compare
  -> human-only audition
```

目标调用预算：

| 场景 | 目标调用数 | 说明 |
| --- | ---: | --- |
| 读取并诊断一个乐句 | 2 | range snapshot + `sv_analyze_vocal_context` |
| 规划并提交一次演唱表现编辑 | 4--6 | snapshot、analysis/plan、dry-run、commit、可选 wait/compare |
| 填词与韵律修正 | 3--5 | snapshot、align/validate、dry-run/commit、可选 wait |
| 生成和声 | 3--5 | snapshot、analysis/harmony plan、dry-run/commit |
| 人类 A/B 试听既有版本 | 1--3 | start compare、可选 get、stop/自动完成 |

LLM 决策原则：

1. 首选高层工具，只有高层明确不支持时才落到 `sv_run` 或 raw。
2. 所有写入先检查 `review`、shared-target 影响和 dry-run diff。
3. `effects:"verified"` 后不得因 processing observation 失败自动重试写入。
4. `STALE_CONTEXT` 必须重新 snapshot 和重新规划，不复用旧 noteId/occurrenceId。
5. computed pitch 全 null 是“不足以分析”，不是零误差，也不是宿主故障的充分证据。
6. 主观听感必须交给人；模型只报告结构、曲线和 computed-pitch 可观测证据。

## 5. 唯一路线图

### P0-A：真机验收与发布证据

状态：`host-gate`

目的：把“模拟宿主正确”提升为“真实 SynthV 2.2.1 行为经过可重复测量”，先校准当前能力再扩展写面。

实施内容：

1. 固定一个小型验收工程，包含：
   - 普通英文/日文音符、`+`/`-` 延音和 `br`；
   - 至少一个共享 target occurrence；
   - Linear/Cosine/Cubic Automation；
   - 可产生有效 computed pitch 的稳定人声段；
   - 非零 timeOffset/pitchOffset；
   - loop region 和两个可独奏轨道。
2. 建立 on-host acceptance runner，只通过现有 MCP 调用，不向生产 dispatcher 加调试后门。
3. 校准并记录：
   - `setAttributes` 合并/替换和 float32 行为；
   - Automation `getPoints/remove/get` 的端点语义；
   - `seek`/`getPlayhead` 实际量化误差和 looping 恢复；
   - `Project.addTrack` 返回约定；
   - computed pitch 从 empty/all-null 到有效帧的状态序列；
   - shared target 编辑的实际影响面。
4. 同一固定工程预热后各运行 20 次：
   - range snapshot；
   - 四曲线 dry-run/commit；
   - auto-stop audition；
   - processing wait。
5. 故障覆盖：
   - Node 模拟层继续覆盖每个 commit 阶段；
   - 真机只做安全可恢复的 detach/timeout/ignored-write 实验；
   - 不为测试向正式 MCP 暴露任意故障注入能力。

已完成的只读基础：

- 独立 `SVLiveProbe` 通道可由 `tools/capture-live-host-profile.mjs` 重复采集。
- profile 在写盘前去除工程路径、名称、UUID、歌词、音素、音符和原始曲线，只保留版本与聚合证据。
- 2.2.1/win32 基线确认 reference bounds 可独立于音符边界，以及全-null computed-pitch
  返回形态；有限帧缺失使坐标语义继续保持 `unknown`。
- fake host 可选择 `require-confirmed`，触及未确认语义立即失败；普通故障测试仍可使用
  `simulator_default`，但不能把它称为真机证据。

验收标准：

- 每项生成机器可读 JSON 证据，包含 hostVersion、fixture hash、接口版本和时间戳。
- computed-pitch 成功路径至少一次取得有限数值帧；若固定 fixture 仍全 null，结论标记宿主阻塞，
  不据此放宽分析器。
- 空闲协调器下 audition overrun p95 目标不超过 200 ms；未达到时保留实测值和调度分解。
- 四曲线 batch 的 median/p95 与独立调用对照，先以实测建立基线，不预设不可信比例。
- README、capabilities 和发布说明只引用已取得的宿主证据。

### P0-B：LLM 工作流指南资源

状态：`done`（2026-07-26 实现，`server/src/workflow-guide.js`）

新增资源：`svcopilot://guide/music-workflows` 与 `svcopilot://guide/music-workflows/{recipe}`

目的：让只看到 MCP 自描述的模型知道“先捕获什么、调用哪个规划器、怎样提交、什么错误能重试”，
避免靠 README 或对话记忆猜测 32 个工具的组合方式。

实现结果：

- 目录页返回 `guideVersion`、`interfaceVersion`、默认工作流、按需求选工具表、全局规则和 8 个
  recipe 摘要；单 recipe 页返回完整 steps。目录页 10.3 KiB，最大单 recipe 4.8 KiB，
  全部读完约 39 KiB，均远低于 60 KiB 上限。
- 全局规则覆盖身份与 0-based 约定、context 生命周期（音符/结构/歌词/phrase 写入删除 contextId，
  曲线写入不删除）、写入安全（dry-run、shared target、compensation 非 ACID、
  `outcome_unknown` 不得盲重试、`effects:"verified"` 后不因观测失败重写）、证据分级、
  人类门和 capability-blocked 分支，并给出可重新捕获/可改请求/需人类决定/不得自动重试/
  并非错误五类错误码。
- `interfaces.guide` 在 capabilities 中回指指南，只读 capabilities 的模型也能发现它。
- 接口版本收敛为 `INTERFACE_VERSION` 单一常量，供 server info、capabilities 和两类资源共用。

已完成 recipes：

- `inspect_project`
- `analyze_vocal_phrase`
- `align_and_commit_lyrics`
- `plan_and_commit_expression`
- `quantize_notes`
- `generate_harmony`
- `verify_after_edit`
- `audition_for_human`

每个 step 列出：

- 工具名与最小 request 模板；
- `sv_snapshot_range.include` 的必要字段；
- 可接受状态和不可重试状态；
- context 失效后的重新捕获规则；
- shared target 与 Undo 影响；
- 主观判断的人类门；
- capability-blocked 分支。

验收标准与结果：

- resource 小于 60 KiB，并按 recipe ID 提供单项读取方式 —— 已满足（见上述实测体积）。
- 所有示例请求通过实际 JSON Schema —— `test/workflow-guide.test.mjs` 用真实服务器
  `tools/list` 返回的 inputSchema 逐条校验 39 个示例请求；另有断言禁止出现
  `sv_render`/`sv_export`/`sv_list_singers`/`sv_undo` 等不存在的工具名。
- 用 10 个不提供外部文档的 LLM 任务做工具选择测试 —— 仍待执行，属于 §8.5 LLM 可用性清单，
  与 P0-A 真机验收一并安排。

### P0-C：一次性声乐上下文分析

状态：`done`（2026-07-26 实现，`server/src/vocal-context.js`）

工具：`sv_analyze_vocal_context`

目的：把现有多个纯内存分析器组合为一次调用，使 LLM 在一个响应中获得乐句、韵律、风格和
computed-pitch 证据。它不新增算法权威，只减少调用和遗漏。

实现结果：

1. 只读 `SnapshotStore`：不访问宿主、不进 `ExecutionCoordinator`，宿主调用数恒为 0。
2. 直接复用四个既有 service（phrase-analysis / lyric-prosody / style-profile /
   computed-pitch-compare），没有复制任何调性、韵律或 computed-pitch 算法；
   每个 section 的 `authority` 与 `provenance.sectionAuthority` 声明结论归属。
3. 各 section 独立返回 `succeeded` / `not_captured` / `insufficient_evidence` / `failed`
   并附 `remedy`。仅请求级问题（未知/无效 context、未知或歧义 occurrence、参数错误）
   整体失败——否则模型会误以为"分析跑过了只是没结果"。
4. 一个 section 数据不足不吞掉其余结果；`summary.evidence` 区分
   `all_requested_sections_analyzed` / `partial_evidence` / `no_section_produced_evidence`，
   最后一种绝不能被读成"没有问题"。
5. `topFindings` 合并韵律 issue（heuristic）与 computed-pitch 异常区段
   （`confidence:"observed_measurement"`，是偏差测量而非"唱错了"的判决），
   保留原始 `noteIds`/`startBlick`，按严重度再按乐谱时间排序；`nextSteps` 给出具体后续
   工具与参数：未捕获 computed pitch 时给出可直接执行的 `sv_snapshot_range` recapture，
   已捕获但证据不足时才使用 `sv_wait_for_processing`。不输出机器听感评分。
6. compact 默认只给摘要、最高优先问题和下一步；明细通过每个 section 的
   `details.tool` + `details.arguments` 重跑该分析器获得——这些分析器可无代价重跑，
   因此不引入 cursor 存储（也就没有 TTL 与 `EXPIRED_CURSOR` 失败模式）。
7. 超出 `budgets.bytes` 时只丢逐项列表并警告 `RESPONSE_BUDGET_APPLIED`，
   摘要、`topFindings` 和 `nextSteps` 始终保留。

验收标准与结果：

- range snapshot 后只需一次调用得到全部请求分析 —— 已满足（指南 `analyze_vocal_phrase`
  的必做步骤已收敛为"捕获 + 一次组合分析"，逐分析器调用降级为可选钻取）。
- 第二次调用的宿主调用数严格为 0 —— 已满足（服务无 host session，测试断言
  `coordinatorQueueMs`/`operationMs` 恒为 0）。
- 相同 context/request 输出确定性一致 —— 已满足（测试逐字节比较两次调用）。
- 缺 automation、processing 或 computedPitch 时返回局部状态，不制造 0 值 —— 已满足
  （测试断言不可用 section 不发布 summary，且响应中不出现伪造的 0 覆盖率/0 误差）。
- 响应在预算内，并能直接驱动 `sv_plan_expression`、`sv_align_lyrics` 或无修改结论 ——
  已满足（`nextSteps` 分别指向处理等待、歌词对齐、演唱表现规划或人类试听）。

### P0-D：统一规划器交接信封

状态：`done`（2026-07-26 实现，`server/src/plan-envelope.js`）

目的：此前 expression、lyrics、quantize、harmony 分别返回 `applyRequests`、`patchRequest`
和 `restructureRequest`，LLM 能用但要记住四种协议。现已统一为：

```json
{
  "planId": "plan_...",
  "apply": {
    "tool": "sv_patch_parameter_curves",
    "arguments": {},
    "atomicity": "verified_compensation",
    "expectedUserUndoSteps": 1,
    "preconditions": [],
    "planIsNotAPreflightToken": "..."
  },
  "continuation": null,
  "review": {},
  "provenance": {}
}
```

实现结果：

1. 已统一 envelope，未增加通用 `sv_apply_plan`（按原计划推迟到可用性测试证明仍需路由为止）。
2. `apply.arguments` 逐字通过目标工具 schema —— `test/plan-apply-schema.test.mjs` 用真实
   服务器 schema 对四个规划器跑同一段泛型消费代码。
3. `apply.planIsNotAPreflightToken` 显式声明 plan 不是跳过 live preflight 的凭据；
   `apply.preconditions` 只描述规划时的前提，仍由目标工具对活宿主重新校验。
4. 多轮 continuation 语义不变：commit → re-snapshot → 同参重跑，不预生成失效 noteId。
5. `sv_plan_expression` 的非相邻表现手法簇需要 K 次顺序调用，因此 `apply.callCount` /
   `apply.additionalCalls` 按序列出，`apply.expectedUserUndoSteps` 如实等于 K，
   并用 `apply.sequencing` 声明它们是独立事务——后一次失败不回滚前一次已提交的写入。
6. `apply` 为 `null` 表示 no_change，不是错误。
7. lyrics/quantize 规划阶段也开始如实报告 `requiresSharedTargetConfirmation`，
   不再等到提交时才暴露共享 target。

兼容：`applyRequests` / `patchRequest` / `restructureRequest` 保留一个接口版本，
内容与 `apply` 完全一致并标注 deprecated，下一个接口版本移除。

验收标准与结果：

- 四个规划器具有同一顶层 `apply/review/continuation` 结构 —— 已满足。
- 通用测试可读取 `apply.tool` 并用对应 schema 验证 `apply.arguments` —— 已满足。
- 文档资源不再要求模型解析错误消息或工具专属字段来决定下一步 ——
  `svcopilot://guide/music-workflows` 的 `globalRules.planHandoff` 直接给出规则。

### P1-A：和声语境、强拍与终止式分析

状态：`done`（2026-07-26 实现，`server/src/harmonic-context.js`）

扩展工具：`sv_analyze_phrase`

新增 include（全部 opt-in，默认 `include` 仍为基础四项）：

- `metricalRoles`
- `chordCandidates`
- `cadence`
- `tensionResolution`

实现结果：

1. 只有单旋律时不能确定真实和弦：`provenance.harmonicContext.evidenceScope` 与每个
   section、每个 chord window 都声明 `"melody_only"`，并附
   `evidenceScopeNote` 明确"候选是与旋律相容的音集，不是对真实伴奏的观测"。
2. 按小节（默认）或 `harmonicWindow:"half_bar"` 聚合 pitch class，权重为
   窗内时值 × 节拍权重（downbeat 1 / strong 0.7 / weak 0.4 / offbeat 0.2）；
   跨窗音符按重叠时值分摊。所有调性、音域、音程与张力计算均使用
   `pitch + occurrence.pitchOffsetSemitone` 的实际发声 MIDI，provenance 显式声明该坐标。
3. 候选包含 12 种 triad/seventh 模板 × 12 根音，返回 root、quality、symbol、score、
   `coveredWeightRatio`、`nonChordWeightRatio`、`chordTonesPresent`、
   **`chordTonesAbsent`**（旋律根本没触及、纯属推测的和弦音）、`nonChordTones`
   和 `runnerUpGap`；未被触及的和弦音会折减分数，避免七和弦仅因音多而胜出。
4. cadence 只依据调性候选、句末与倒数第二音级、节拍位置和（若有）和弦窗口做启发式排序，
   每条候选带 `rationale`，并标 `confidenceKind:"heuristic_ranking_not_probability"`；
   自行做乐句切分，因此 compact 模式下仍可用。只有 downbeat/strong 会形成强拍证据，
   普通 weak beat 即使恰好落在整数拍也不会被标成强拍。
5. `tensionResolution` 的每个事件同时给出 `fromNoteId`/`toNoteId`、前后音级、
   `motionSemitone` 与方向，覆盖导音解决/未解决、调外音解决/未解决和悬留式下行；
   悬留判定显式说明"是否为真正的挂留取决于不可观测的伴奏"。
6. 缺 meterMarks 时 `metricalRoles`/`chordCandidates` 如实报 `not_captured`，
   绝不假设 4/4；不依赖小节线的 `tensionResolution` 仍照常工作。
7. `maxChordCandidates`/`maxCadenceCandidates` 的下限均为 2，schema 层面杜绝
   "把最高分写成唯一事实"。

未做（明确推迟，不在本次范围）：

- `sv_generate_harmony` 接受 caller-approved chord plan。它是写面契约变更而非分析扩展，
  需要单独设计 chord plan 的输入 schema、与既有调内三/六度映射的优先级，以及与
  `TARGET_NOTE_CONFLICT` 的交互。默认调内三/六度行为保持不变。

验收标准与结果：

- Golden fixtures 覆盖明确终止、旋律歧义、调外音、弱起、弱拍边界、非零 occurrence
  pitch offset 和无调性片段 —— 已满足（`test/harmonic-context.test.mjs` 17 项）。
- 歧义案例至少返回两个候选，不把最高分写成唯一事实 —— 已满足（单音级窗口断言
  `candidates.length >= 2` 且 `ambiguous:true`，并发 `CHORD_CANDIDATES_AMBIGUOUS`）。
- 呼吸音符继续不进入 pitch-class/harmony 统计 —— 已满足（专项测试断言 br 的名义音高
  不进直方图、不获得节拍角色、不参与张力事件）。

### P1-B：宿主插值曲线的连续变换

状态：`ready`，实施前受 P0-A Automation 端点实验约束

扩展工具：`sv_patch_parameter_curve(s)`

建议模式：`resample_transform`

它解决的不是“改控制点”，而是“对 `Automation.get()` 所代表的宿主插值连续曲线做 add/scale/
compress/shape，再拟合回控制点”。

实现要求：

1. 读取 `getInterpolationMethod()`，按范围和预算调用 `Automation.get()` 采样；不得用
   `getLinear()` 假装 Cosine/Cubic。
2. 变换单位遵循 parameter definition：
   - pitchDelta：cents
   - loudness：dB
   - tension/breathiness/gender：归一化值
   - vocalMode：0--150
3. `scale` 默认围绕 parameter default/baseline 缩放，而不是围绕 0；请求必须回显 pivot。
4. 拟合采用确定性简化，保留端点与局部极值，限制最大样本和最大输出点数。
5. dry-run 返回原曲线/目标曲线采样摘要、最大拟合误差和计划点，不写宿主。
6. commit 后在同一网格读回，要求：
   - `maxAbsError <= tolerance`
   - 关键端点和极值在独立更密采样网格上不超限
7. 回滚恢复原始完整点集，并再次采样验证。

验收标准：

- Linear/Cosine/Cubic 固定夹具均有 golden test。
- 对非线性插值，变换结果与“只改原控制点”存在的差异被测试明确覆盖。
- 运行量由采样数/点数决定，不随 BLICK 数值跨度线性增长。
- 超预算在任何 Undo 或写入前失败。

### P1-C：PitchControl 高层快照与事务编辑

状态：`implemented-offline, host-gated`（2026-07-27 实现，GOAL：`pitch-control-goal.md`），需要 SynthV 2.1+

实现能力（离线回归全绿，宿主语义验收待真机）：

- `sv_snapshot_range include:["pitchControls"]`（`server/src/pitch-control.js` + `musical-range.js`）。
- `sv_patch_pitch_controls`（`server/src/pitch-control-patch.js`）。
- `sv_plan_pitch_gesture`（`server/src/pitch-gesture-plan.js`，Phase 3 条件扩展已实现）。
- `sv_bake_computed_pitch`（`server/src/bake-computed-pitch.js`，Phase 4 条件扩展已实现，preserve/replace_owned/replace_explicit）。
- `sv_generate_harmony` 广义 interval + 14 音阶目录扩展（`server/src/harmony-plan.js`，Phase 5 条件扩展已实现）。

契约要求（已全部满足并经离线测试）：

1. Point 和 Curve 使用明确 discriminator（宿主只报 `type:"object"`，探测 `getPoints` 判别）。
2. 所有 pitch 值单位为 semitone，时间为 group-local BLICK，同时回显 occurrence absolute BLICK。
3. Curve 控制点的 value 是相对 curve anchor pitch 的 semitone。
4. 写入走 shared-target 确认、UUID/fingerprint、一个 Undo、journal 和 read-back。
5. 新对象由 `SV.create("PitchControlPoint"|"PitchControlCurve")` 构造，写完字段后再加入 NoteGroup。
6. 修改/删除前保存完整 clone 或可重建状态；失败时逆序恢复（update 走原位 set）。
7. computed-pitch 等待只作提交后观测，不改变已验证写入 outcome。

验收标准：

- [x] Point/Curve 的 add/update/delete/no-change/dry-run/rollback 均有测试（`test/pitch-control-patch.test.mjs` 假宿主逐 commit 边界故障注入）。
- [x] cents、semitone、note detune 三种单位不能通过同一无标签字段混入（字段名带单位后缀，schema 层拒绝）。
- [x] 非零 occurrence timeOffset/pitchOffset 的坐标回归通过（`test/pitch-control.test.mjs`）。
- [ ] **真实宿主确认对象插入、排序、clone 和 remove 语义后才发布**（`host-gated`）：已交付
  `tools/pitch-control-probe.mjs` 探针（Point/Curve 创建/排序/原位 set/clone/remove/scriptData/坐标/浮点），
  只读 Host Profile 已把这些项目明确标为 `not_observable`；待一次性 fixture 上可恢复写测取得证据。
  取得证据前，PitchControl 写面按"离线事务核已验证、宿主写语义待真机校准"对待。

条件扩展状态（GOAL §15）：

- Phase 3（音高变化规划器）、Phase 5（和声扩展）：已实现并测试。
- Phase 4（computed-pitch bake）：已实现 preserve/replace_owned/replace_explicit；`pitchDeltaHandling:"clear"`
  需跨类型（PitchControl + Automation）事务，本版显式拒绝（`PITCH_DELTA_CLEAR_UNSUPPORTED`），标 `deferred`。

### P1-D：既有版本的人类 A/B 试听编排

状态：`done`（2026-07-27 实现，`server/src/audition-compare.js`）

工具：`sv_audition_compare`、`sv_get_audition_compare`、`sv_stop_audition_compare`

第一版只比较已经存在的两个版本（不同 track solo 配置）。它不临时提交音乐编辑，
因此不会制造无法撤销的"试听用写入"。

实现结果：

1. **不复制播放恢复内核**：每个 variant 都通过既有 `AuditionService.start/stop` 执行，
   启动读回校验、auto-stop 计时、"用户改过就不覆盖"的 mixer 恢复和 recovery payload
   全部原样复用；本模块只负责编排顺序与状态机。
2. A/B 共用同一 playhead、范围与 mixer 基线——这由"A 完整停止并恢复后 B 才开始"保证，
   而不是靠假设。A 恢复失败会以 `restore_failed` 终止，绝不在脏基线上启动 B。
   测试断言两个 variant 的 solo 集合不重叠且 playhead 回到起点。
3. 非阻塞返回 `comparisonId`；后台 variant 切换、auto-stop 与显式 `stop` 共享同一个
   transition/restore Promise，避免重复恢复或把进行中的恢复误报为成功；`get`/`stop`
   幂等（终态被记忆并原样重放）。
4. 用户自行修改过的 mixer/playback 字段不覆盖——沿用当前 audition 的同一规则。
5. 输出 `perception:"human_only"` 与 `humanGate`，只给播放顺序和恢复证据；
   测试断言响应中不出现 sounded/better/winner 之类措辞。
6. "应用临时计划 -> B -> 自动还原"**明确不做**：官方无 Undo 调用，成功提交后不存在
   通用恢复 token。`provenance.temporaryEditsForVariantB` 如实声明这一点；要比较编辑，
   先把编辑提交到复制轨，再 A/B 两条轨。
7. 任一 variant 的同步抛错或结构化启动失败都收敛为可复用的失败终态，不产生未处理的后台
   Promise rejection；`autoRestore` 固定为 `true`，调用方不能破坏比较所需的共同基线。

状态机：

```text
prepared -> playing_a -> gap -> playing_b -> restoring -> restored
                                 \-> stop_requested -> restoring
```

验收标准与结果：

- 正常、人工 stop、并发 stop、宿主异常、进程恢复 payload 全覆盖 —— 已满足
  （`test/audition-compare.test.mjs` 18 项；首个/后续 variant 启动抛错、结构化失败、
  恢复失败与 stop/切换竞争均有专项回归）。
- A/B 切换不产生项目内容 Undo —— 已满足（断言从未调用 `newUndoRecord`，
  且 `provenance.projectContentUndo` 声明只触碰 mixer 与 playhead）。
- 最终 playhead、playback status 和未被用户改变的 mixer 状态恢复 —— 已满足
  （恢复证据来自底层 audition 的读回，不是编排层的断言）。

### P1-E：高层 Selection 操作

状态：`done`（2026-07-26 实现，`server/src/selection.js`）

工具：`sv_set_selection`

原因：真实宿主的 `unselectNote()` 已观察到"状态改变但返回 false"，raw 层必须透传，
但 LLM 需要可信的高层结果。

实现结果：

- 输入接受 `clear`/`select`/`add`/`remove` 四种操作；目标可用 snapshot/range context
  的 noteId（range noteId 可再用 occurrenceId 收窄），或直接用宿主当前编辑组的
  `indexInGroup`（无快照时可用）。
- 使用 context noteId 时，服务会在任何 mutation 前读取当前编辑 target 的 UUID，并与
  context occurrence/group UUID 比较；不一致返回 `CURRENT_GROUP_MISMATCH` 及
  expected/observed UUID，避免相同 `indexInGroup` 落到另一个编辑组。
- 操作前后各读一次 selection，`changed` **完全由读回差异判定**；宿主原始布尔值保留在
  `hostResults` 中作为对照，两者矛盾时发 `HOST_RETURN_DISAGREES_WITH_READBACK`
  并明确声明"以读回为准"。
- `provenance.changedBasis` 固定为
  `read_back_before_after_comparison_not_host_boolean`。
- selection 是 UI 状态：`undo.recordCreated:false`，且绝不调用 `newUndoRecord()`。
- 快照之后组变短时报 `NOTE_INDEX_OUT_OF_RANGE`，绝不悄悄选中另一个音符。

测试：`test/selection.test.mjs` 13 项。模型宿主**默认复现真实宿主的说谎行为**
（所有选择相关调用恒返回 false），因此一旦服务改用宿主 boolean 判定 changed，
测试会立刻失败；另有诚实宿主对照组验证不误报矛盾警告。

## 6. 实验性与低优先级能力

### E1：受限 Retake 管理

状态：`experiment`

可安全承诺：

- `sv_generate_retake`：针对 noteId 调用 `generateTake(duration,pitch,timbre)` 并返回新 ID。
- 可选激活刚生成的 ID。
- 删除工具只接受本次服务明确生成并记录的 ID，或调用方显式确认的已知 ID。

不可承诺：

- 列出所有 take ID；
- 读取当前 active take；
- 在不知道原 active ID 时自动恢复；
- 仅凭 `getNumTakes()` 推导 ID 连续；
- 验证 `setActiveTake()` 后到底激活了哪个 ID。

因此写入结果必须使用 `host_acknowledged_unverifiable`，不能伪装为 `effects:"verified"`。只有真机
实验表明存在稳定的间接证据时，才提升为正式高层工具。

### E2：独立音乐数据复制

状态：`experiment`

可以用 `NoteGroup.clone()` + `Project.addNoteGroup()` + 新 `NoteGroupReference` 创建独立数据，
但这不能保证复制隐藏 Singer/database 身份。若实现，工具名称和响应必须强调：

- `musicDataIsolation:"verified"`
- `singerIdentity:"unobservable"`
- `singerAssignmentPreserved:"unknown"`

不得把它包装为“完整声线轨克隆”。

### E3：确定性律动模板

状态：`experiment`

现有 quantize 已支持 swing。未来若增加 humanize，应使用显式 seed 或固定 groove template，
返回每个偏移和边界 clamp；不接受不可复现的随机写入。优先级低于和声分析与连续曲线变换。

## 7. 明确不进入当前路线图

| 项目 | 决策 |
| --- | --- |
| `sv_apply_vibrato` 独立工具 | `not-planned`：`sv_plan_expression` 的 vibrato 表现手法已覆盖；先改善指南与 schema |
| `sv_shape_dynamics` 独立工具 | `not-planned`：hairpin/section arc 已覆盖 |
| `preserveMoraTiming` planner 开关 | `not-planned`：expression planner 不改音符/歌词，结构天然不变 |
| 自动 `snap pitchDelta to scale` | `not-planned`：会破坏颤音/滑音等有意连续偏移；调性用于分析和约束提示 |
| planToken 跳过 live preflight | `not-planned`：宿主没有 revision，短期 token 不能发现 UI 修改 |
| UI 自动化 render/Singer 枚举 | `not-planned`：脆弱且越过官方 API 能力边界 |
| 假事件订阅 | `not-planned`：轮询不是宿主事件；需要时由客户端显式 snapshot/token 比较 |
| 机器听感评分 | `capability-blocked`：没有音频输入，保持人类试听 |
| 通用 ACID/成功后任意 rollback | `capability-blocked`：官方无事务和 Undo 调用 |

## 8. 横向发布要求

每项新能力必须同时满足：

### 8.1 契约

- 完整 MCP input schema，所有对象 `additionalProperties:false`。
- 对较大组合 schema 提供 `svcopilot://schemas/{tool}`。
- 0-based canonical index、单位、local/absolute 坐标和 occurrence 身份明确。
- `observed`、`derived`、`heuristic`、`human_only` 不混用。
- no-change、dry-run、verified、rolled-back、partial、outcome-unknown 语义统一。

### 8.2 安全

- 任何 mutation 在宿主写入前完成形状、数值、目标、shared-target 和预算校验。
- 不吞掉宿主 timeout/detach 的不确定性。
- verified write 后的非关键观测失败只给 warning。
- 不增加 Lua/Node/shell 任意执行面。
- 长期发布前单独评估 pipe endpoint 身份认证、安全 bootstrap、Windows pipe ACL 和 Relay helper 隔离；
  这些是部署加固，不得混进音乐语义工具实现。

### 8.3 性能

- 纯内存分析不得访问宿主或等待协调器。
- 宿主调用量与实际 item/sample 数相关，不与 BLICK 数值大小相关。
- compact 默认响应不超过 60 KiB。
- 所有大列表有 budget/cursor/truncation 语义。
- timings 区分 coordinator wait、host read、planning、write、verification 和 restore；SDK handler 前等待保持
  `unobservable`，不伪造 0。

### 8.4 测试

- 数学/纯逻辑 golden tests。
- 服务级 fake-host 成功、no-op、stale、float32、timeout、detach、rollback 和 rollback-failed。
- MCP schema/resource/smoke。
- 对依赖 SynthV 语义的功能执行 P0-A 真机验收。
- `npm test` 不得改写 `api-docs/*.json`。

### 8.5 LLM 可用性

发布前用只提供 MCP 自描述的模型完成至少以下任务：

1. 找出一个双语乐句的调性、换气、咬字和 computed-pitch 证据。
2. 规划并 dry-run 一次 J-pop 演唱表现修改，不手算 BLICK。
3. 在 shared target 上拒绝未确认写入。
4. 正确处理 stale context，重新拍快照而非重试旧请求。
5. 对全 null computed pitch 返回“不足以分析”，不宣称音准完美。
6. 生成并提交调内和声，冲突时不覆盖目标。
7. 组织人类试听，不宣称模型听见声音。
8. 面对 Singer/render 请求时解释官方能力阻塞并给出可行替代步骤。

## 9. 里程碑

| 里程碑 | 内容 | 完成标志 |
| --- | --- | --- |
| M0 文档收敛 | 本文、精简 Handoff、历史归档 | 只有本文承载未来路线图 |
| M1 发布证据 | P0-A 真机验收 + ~~P0-B 指南~~ | P0-B 与 P0-A 只读基线已完成；仍缺可恢复写测与 LLM 可用性实测 |
| M2 分析闭环 | ~~P0-C~~ + ~~P0-D~~ + ~~P1-A~~ | 已完成 |
| M3 调音写面 | P1-B + P1-C | P1-C 已实现（离线，host-gated 待真机）；P1-B 待 P0-A。连续 Automation 变换和 PitchControl 安全事务 |
| M4 人类比较 | ~~P1-D~~ + ~~P1-E~~ | 已完成 |
| M5 实验能力 | E1/E2/E3 按证据选做 | 仅发布能够诚实描述和验证的子集 |

下一步默认顺序：

1. ~~提交当前已验证修复与文档整理。~~ 已完成（`8be9e7f`）。
2. ~~实现 P0-B 工作流指南。~~ 已完成（`svcopilot://guide/music-workflows`）。
3. ~~实现 P1-C PitchControl 读模型与事务写面（含音高变化规划器、computed-pitch bake、和声扩展）。~~
   已实现并经离线回归（提交基线 504 项）；只读 Host Profile 校准层已建立。
4. 执行 P0-A 可恢复写测（先跑 PitchControl 探针，再校准 P0-A 其余项），优先取得有效 computed-pitch
   成功样本；同时用只读 MCP 自描述的模型跑 §8.5 的 LLM 可用性任务，验证指南是否真的改变了工具选择。
5. 剩余路线图项全部依赖真机：P0-A 真机验收、P1-B 连续曲线变换（受 P0-A Automation
   端点实测约束）、P1-C 的 PitchControl 真机语义确认（插入/排序/clone/remove/scriptData）。
   在取得宿主证据前不宜宣称真机验收通过。
6. 进入 P1-A/P1-B；PitchControl 跨数据面 bake（`pitchDeltaHandling:"clear"`）与 A/B 编排按真机结果评估。

## 10. 维护规则

1. 新需求先更新本文的可行性和优先级，不再新建并列“计划书”。
2. 审查报告、研究 prompt、阶段 PRD 和黑盒记录完成后移入 `docs/archive/YYYY-MM/`。
3. `HANDOFF.md` 只记录当前实现、工作区、验证和最近下一步，不积累版本编年史。
4. `README.md` 面向使用者，`docs/architecture.md` 面向协议与失败模型，本文面向产品路线。
5. 每次接口版本升级同步：
   - server version；
   - capabilities/interfaceVersion；
   - schemaVersion；
   - README 工具表；
   - Handoff 当前状态；
   - 本文完成状态。
