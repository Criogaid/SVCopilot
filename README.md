# SV Copilot — Synthesizer V 的实时 MCP 控制桥

SV Copilot 让 MCP 客户端通过 Synthesizer V Studio 2 官方 `SV` Lua API 实时读取和编辑工程。当前默认传输已经是 **Windows IO PIPE（named pipe）**；命令、响应和停止信号均不再经过轮询文件。

```text
MCP client
  └─ stdio ─ Node MCP server
       └─ Windows IO PIPE / NDJSON ─ SynthV Lua bridge
            └─ SV:setTimeout ─ official SV API
```

## 当前状态

- 默认数据通道：两根单向 named pipe。
- 控制通道：第三根单向 named pipe，用于 Scripts 菜单中的 Stop 命令。
- 协议：NDJSON、版本握手、严格一写一读、单命令 in-flight。`result` 帧的回包推迟一个事件循环 tick，使顺序调用的下一条命令直接搭在回包上，不再每步等待桥的 20 ms 空闲轮询；每帧仍恰好一个回复。
- 执行模型：所有原始调用与高层工作流共享一个 FIFO 协调器；一个工作流执行期间不会被其他 MCP 调用插入。
- 结果编码：默认保留旧格式；高层读取可请求 `typed-v2`，无损区分空数组、稀疏数组、map、`nil`、特殊数字和 handle。
- 已验证：Node 模块与 Relay 测试、真实 Lua 5.4 + Windows named pipe dispatcher，以及完整 MCP 客户端高层编辑闭环。
- 待验证：在 SynthV 2.2.1 宿主中长时间运行、自动试听停止的 p95、跨类型乐句事务的真实宿主故障注入，以及 Relay hang 情况。

旧版 [server/src/transport.js](server/src/transport.js) 和 [test/raw_client.py](test/raw_client.py) 仅作为 file IPC 历史参考；`src/index.js` 不再导入或启用它们。

## 目录布局

SynthV 会递归扫描 `scripts/` 下的 `.lua` 和 `.js`，因此 Node 文件和测试必须留在 `SVCopilot/` 外部目录中。

```text
Synthesizer V Studio 2/
  scripts/SynthVCopilotResearch/copilot/sv-scripts/
    StartSynthVCopilot.lua       # 当前 IO PIPE 桥
    StopSynthVCopilot.lua        # 通过 control pipe 停止
  SVCopilot/
    server/src/index.js          # MCP stdio 入口
    server/src/transport-pipe.js # PipeRelay
    test/                        # Relay、Lua dispatcher、端到端测试
    docs/architecture.md
```

## 前置条件

- Windows
- Node.js 18 或更高版本
- Synthesizer V Studio 2

## 安装与启动

安装 Node 依赖：

```powershell
cd "C:\Users\Kripto\AppData\Roaming\Dreamtonics\Synthesizer V Studio 2\SVCopilot\server"
npm install
```

MCP 客户端配置示例：

```json
{
  "mcpServers": {
    "sv-copilot": {
      "command": "node",
      "args": [
        "C:\\Users\\Kripto\\AppData\\Roaming\\Dreamtonics\\Synthesizer V Studio 2\\SVCopilot\\server\\src\\index.js"
      ]
    }
  }
}
```

使用顺序：

1. 先让 MCP 客户端启动 Node server，使 named pipe 进入 listening 状态。
2. 在 SynthV 中执行 **Scripts → Rescan**。
3. 运行 **SV Copilot → Start SV Copilot**。
4. 停止时运行 **SV Copilot → Stop SV Copilot**，或退出 Node server。

两端默认使用 session `default`。需要隔离多个会话时，在启动 Node 和 SynthV 进程前为两者设置相同的 `SV_COPILOT_SESSION`；值只能包含 1–64 个 ASCII 字母、数字、点、下划线或连字符。

## MCP 工具

| 工具 | 用途 |
|---|---|
| `sv_ping` | 检查 Relay、Lua 桥和宿主循环是否连通 |
| `sv_root` | 获取 project、timeAxis、mainEditor、arrangement、playback 等根对象 handle |
| `sv_call` | 调用全局 `SV` 或任意 handle 对象上的方法 |
| `sv_index` | 读取字段或常量，例如 `SV.QUARTER` |
| `sv_free` | 释放不再使用的 handle |
| `sv_search_api` | 搜索本地解析的官方 API（类、方法、重载、参数、版本与文档锚点） |
| `sv_describe` | 获取一个类或指定方法的完整官方 API 元数据 |
| `sv_snapshot` | 将选择区、工程或指定组读取为统一的 0-based 数据，并签发短期 `contextId` |
| `sv_run` | 在一个不可插队的执行单元中运行有序 call/index 步骤、局部引用和断言；未返回的临时句柄自动释放，`retainResult`/`exports` 返回的句柄转移给调用方 |
| `sv_wait_for_processing` | 只读轮询音素、计算属性或计算音高；直接接受 group/selection context 或 range context + occurrenceId，单 occurrence 可自动选择；computedPitch 会继承 range snapshot 已捕获的采样参数，否则需显式给出 startBlick/intervalBlick/frames；超时返回最后一次观测而非伪造成功 |
| `sv_set_lyrics` | 对选择区或快照上下文设置歌词，可选音素/语言，执行冲突检查、撤销边界和逐项读回 |
| `sv_patch_notes` | 按快照 noteId 对现有音符做字段级 patch，支持 expected 前置条件、dryRun plannedDiff、Undo 边界、读回验证和已验证补偿回滚；接受 group/selection snapshot context 和 range context（range noteId 自带 occurrence，共享 target 需显式确认） |
| `sv_snapshot_range` | 一次读取可编辑范围上下文：相交音符/occurrence 身份、voice、Automation、computed pitch、attributes、processing、tempo/meter、mixer；严格拒绝未知字段；按数据类型预算分页，cursor 续读不重访宿主；`sinceToken` 命中时用 `detailCursor` 取得新 context 身份 |
| `sv_restructure_notes` | 结构操作：insert / delete（clone 备份）/ split（延音第二半）/ merge（连续音符），按调用顺序执行、活动 index 解析、Undo 边界与已验证补偿回滚；同样接受 range context（insert-only 的多 occurrence range 需给 occurrenceId） |
| `sv_get_parameter_curve` | 在必填 blick 范围内读取经官方/动态 vocal mode 白名单验证的 group 参数曲线：requested/resolved 名称、definition、插值方式、local/absolute 双坐标、统计和续读游标 |
| `sv_get_voice_profile` | 读取轨道各 group 的可观测 voice 参数与 vocalMode 名称；singer 身份/声库目录/分配关系明确报告 unobservable |
| `sv_clone_track_from_template` | Track.clone + addTrack 克隆轨道（如和声轨），Undo 边界 + 读回验证；官方 Reference clone 不复制目标 NoteGroup，因此响应会报告共享 target，不能把它当作独立编辑沙箱；隐藏 singer/database 状态报告 `host_opaque` |
| `sv_start_audition` / `sv_get_audition` / `sv_stop_audition` / `sv_restore_audition` | 非阻塞试听状态机：可选 `autoStop`，区分 timer/queue/overrun，恢复原 playback status、playhead 和未被用户改动的 solo；recovery payload 可跨 server 崩溃使用。MCP 听不到声音，感知判断属于人 |
| `sv_patch_parameter_curve` | 用 BLICK、音乐位置、范围边界、note 或相邻音符 gap 锚点 replace/add/scale 参数控制点；参数白名单、宿主 typeName 复核、Undo、读回验证和已验证补偿 |
| `sv_patch_parameter_curves` | 在同一 group 上预检并批量写入 1--16 条曲线：范围上下文/共享 target 前置条件、一次 Undo、逐曲线读回、跨曲线补偿、三档响应和统一 timings |
| `sv_edit_phrase` | 在一个 Undo 中组合 note patch、歌词/语言、结构操作、多曲线和可观测 voice patch；音符/结构使用 detached clone，curve/voice-only 使用轻量 live preflight，失败时按 journal 恢复并读回验证 |
| `sv_compare_computed_pitch` | 对 `sv_snapshot_range` 已存的 computed pitch 做客观演唱分析（纯内存只读，不访问宿主）：`compare_to_target` 报告逐音符稳态段 `centerErrorCent`、逐帧诊断、去趋势自相关颤音 rate/depth/regularity、转换 overshoot/arrival/settling 与异常区段；`compare_contexts` 在同一采样栅格上按乐谱位置逐帧对比调前/调后（after−before），并给出 §13.8 风格半音差值统计——Hz 类指标按各侧自己的 tempo 图换算帧率；逐音符对按乐谱位置匹配，结构编辑后无法与未变 before 音符配对的标 `unmatched` 并省略 delta（`PER_NOTE_UNMATCHED`），不做误导性跨音符对比；matched/unmatched 与 count 同为全量计数，明细截断只影响 items。`anomalySegments.items` 默认按 `startBlick` 乐谱时间序返回并显式声明 `sortBy`（`anomalySortBy:"severity"` 才按峰值降序），`top` 恒为最严重段——时间序截断不吞掉最严重证据；有效帧覆盖率低于 `analysis.lowCoverageWarnRatio`（默认 0.5）时发 `LOW_COMPUTED_PITCH_COVERAGE`，低样本统计不冒充可靠结论。null 帧保留不进统计；帧率对颤音的适配度分级 ok/borderline/too_coarse 而不是硬拒；全部阈值为未经真机校准的工程默认值，听感判断仍属人类 |
| `sv_plan_expression` | dry-run 表情规划器（纯内存只读，不写宿主）：显式手势（scoop/fall/portamento/vibrato/hairpin，quarter 音乐时间参数）与小词表意图（jpop、controlled_belt/soft_airy/light_rasp、cool_anger/tender、段落）编译为单位显式（cents/dB/x/±1，writeSurface=automation）的可审阅计划，同参数重叠手势求和、基线守卫、约束 clamp 与点数预算；section/emotion 单独出现时播种逐乐句基线动态/音色弧线（低置信启发式）而不再 EMPTY_PLAN；`intent.preset`（jpop_cool/jpop_belt/controlled_anger/intimate_whisper/spoken_rap_transition）是可审阅的常量展开——展开字段/约束默认值逐项回显在 `presetExpansion`，用户显式 intent 字段覆盖 preset 同名值（`PRESET_FIELD_OVERRIDDEN`）、显式 constraints 永远优先，spoken_rap_transition 额外在长音上播种 vibratoEnv 压平手势，绝非黑箱按钮；产出可直接提交 `sv_patch_parameter_curves` 的 applyRequests（同参数多簇时按序分成 K 次调用并如实报告 K 个 Undo），target 携带手势锚点音符的 `expectedNotes` 完整指纹与快照时 `expectedTimeOffsetBlick`——apply 预检逐条复核，音符被改动或整个 reference 被 setTimeOffset 移动均判 STALE_CONTEXT，而非在错误位置写曲线。意图派生手势绝不锚定 "br" 呼吸音符（无可唱音高；其时值照常分隔乐句，显式点名 br 的手势不受限，警告 `BREATH_NOTES_SKIPPED_BY_INTENT`）。replace 覆盖区间内既有点且规划器不读宿主（review 显式声明）；natural vibrato 不可观测；意图映射为启发式；是否更好听 human_only |
| `sv_align_lyrics` | 无副作用咬字规划器（纯内存只读）：混排歌词分词并铺排到音符——日语假名确定性 mora 切分（拗音并前拍、促音/拨音/长音各占一拍）、英语元音簇音节启发式（词 + "+" 续拍，~85-90% 文献准确率）、中/粤一字一音节、汉字读音不可知按 1 音符标 needs_review、"br" 显式换气；单元/音符数不匹配如实报告不自作主张。产出带 `expected.lyrics` 前置条件的单个 `sv_patch_notes` patchRequest；变更超过单次 200 patch 上限时返回前 200 + `continuation` 工作流（警告 `PLAN_EXCEEDS_PATCH_CAP`）：提交成功会使 contextId 失效且 noteId 内嵌 contextId，后续批次无法预生成——commit → 重拍 `sv_snapshot_range` → 用相同参数重跑本工具，已应用音符自动 no-change，循环收敛到 no_change；显式 occurrenceId/startNoteId 仅在短期 continuation 身份记录证明 target UUID 相同且音符结构未漂移时重锚定（`STALE_SELECTOR_REANCHORED`），伪造、过期或漂移 selector 均拒绝；不承诺与宿主 G2P 一致，"+"/"-"/"br" 为宿主约定 |
| `sv_analyze_phrase` | 只读乐理分析（纯内存）：时值加权音级直方图 × 24 个 Krumhansl-Kessler profile 的皮尔逊相关返回**排序**调性候选与次名差距（关系大小调/长属音歧义如实暴露，不隐藏）；音级与外音标记（升号拼写、自然小调，附各模式共有的 summary 直方图）；休止阈值乐句切分（climax/ambitus/休止）；音域/音程/节奏统计。"br" 呼吸音符（宿主约定）带名义 pitch 但无可唱音高：完全排除在调性/音级/乐句/统计之外，单独以 `breathEvents`（`nominalPitch`）返回，`noteCount` 只数旋律音符，全呼吸片段报 `NO_MELODIC_NOTES`。responseMode 实际生效：compact 只给汇总不展开逐音符，standard 大列表截断 100 条并警告，verbose 全量。全部 derived/heuristic，绝不冒充宿主事实 |
| `sv_style_profile` | 工程级风格统计聚合（纯内存只读）：对 1--8 个 range context 逐 target 报告旋律音符（br 单独计数）的音域/音程直方图/节奏/休止、乐句长度分布、languageOverride 分布、Automation **控制点**统计（点数/min/max/mean/非默认占比/逐乐句 min-max——不是宿主插值后的可闻曲线）与可观测 vocalModeParams 键名（singer 身份仍 unobservable）；聚合层合并样本重算中位数（不平均中位数）、音程直方图求和（不跨 target 边界拼音程），并按调用方自供的 `label` 分组并排（verse/chorus 等段落标签绝不由服务推断——`sectionLabels:"caller_provided_not_inferred"`）。context 未 include automation/voiceParameters 的 target 对应剖面如实报 `not_captured` + 警告，不拿 0 冒充实测 |
| `sv_validate_lyrics_prosody` | 咬字/韵律校验器（纯内存只读，只报告不生成 patch——修复动作指向 sv_patch_notes/sv_align_lyrics/sv_restructure_notes）：breath（br 带 language/phonemes override 或异常长换气）、japaneseMora（单音符多 mora、孤立小假名，确定性规则）、englishSyllables（元音簇音节数 vs 其后 "+" 续拍数，~85-90% 启发式）、languageConsistency（字符类别与 languageOverride 冲突、续拍残留 override）、stressAlignment（首音节重读近似 vs 拍强——无词典，只发 info 级 `confidence:"low"`，绝不报 error）、phonemeCoverage（旋律词音符的空音素；br/"-"/"+" 的空音素合法，无 processing 数据时如实 `not_captured`）。issues 带 kind/severity/confidence/suggestion，按严重度+乐谱时间排序，standard 截断 100 并警告 |
| `sv_quantize_notes` | 无副作用量化规划器（纯内存只读）：onset 吸附到以小节边界为原点的网格（`1/4`…`1/32` 与 `1/8T`/`1/16T` 三连音，拍号变化处重锚），`strength` 线性插值、`swing` 奇数格后移（三连音网格拒绝 swing）、可选时值量化。确定性且不重排：同格碰撞的后音保留原位（`QUANTIZE_COLLISION`），量化引入的重叠撤销该 onset 变更（`OVERLAP_AFTER_QUANTIZE`，`quantizeDurations:true` 时改为收短前音）；**不提供 humanize**（随机微时移与确定性规划器契约冲突）；"br" 换气照常量化。产出带 expected onset/duration 前置条件的 `sv_patch_notes` patchRequest；>200 patch 走与 sv_align_lyrics 相同的 continuation 收敛工作流（commit → 重拍快照 → 同参重跑，显式 occurrenceId 仅在短期身份记录证明同一 target UUID 时重锚定） |
| `sv_generate_harmony` | 调内和声规划器（纯内存只读，不创建轨道/组——先用 `sv_clone_track_from_template` 等准备目标组并重拍快照，使源与目标共享同一 range context）：旋律源音符（br 跳过）按自然音阶级映射三度/六度上下方，显式 key 或 K-S 检测（margin 过薄警告 `KEY_AMBIGUOUS` 并给出次名候选）；整数 occurrence pitch offset 会进入实际发声音高上的调性/register/声部交叉计算，写入请求与 `harmonyPitch` 使用目标本地 MIDI，`harmonySoundingPitch` 回显实际发声坐标；非整数 offset 因下游只接受整数 MIDI 音高而明确返回 `UNSUPPORTED_PITCH_OFFSET`；调外源音按最近调内音半音差近似并标 needsReview；register 越界先八度位移再跳过，位移导致声部交叉则 `VOICE_CROSSING_AVOIDED` 跳过；lyricsMode copy/sustain。目标既有 onset、时值、本地音高和歌词均一致的音符才视为 already_applied（收敛基础），同跨度不同内容列入 `TARGET_NOTE_CONFLICT` **绝不覆盖**。产出目标本地坐标的 `sv_restructure_notes` insert 请求；>64 操作走 continuation 收敛工作流。和声好不好听 human_only |

MCP 资源还提供：

- `svapi://manifest`：完整官方 API 清单。
- `svapi://class/{class}`：按精确类名读取，例如 `svapi://class/Note`。
- `svcopilot://capabilities`：当前连接 epoch、接口版本、限制和已知能力缺口。
- `svcopilot://guide/music-workflows`：面向 LLM 的工作流指南目录——全局规则（身份、context 生命周期、写入安全、证据分级、人类门、能力阻塞、错误分类）加 8 个 recipe 摘要。
- `svcopilot://guide/music-workflows/{recipe}`：单个 recipe 全文，含每步工具、最小请求模板、必要 `include` 字段、可接受与不可重试状态、共享 target 与 Undo 影响、人类门和 capability-blocked 分支。可用 recipe：`inspect_project`、`analyze_vocal_phrase`、`align_and_commit_lyrics`、`plan_and_commit_expression`、`quantize_notes`、`generate_harmony`、`verify_after_edit`、`audition_for_human`。
- `svcopilot://schemas/music-workflow`：组合音乐工具的轻量 schema 索引。
- `svcopilot://schemas/{tool}`：单个组合工具实际使用的紧凑输入 schema，例如 `svcopilot://schemas/sv_edit_phrase`；按工具拆分以避开客户端的大 resource 截断。

完整性来自通用 dispatcher：SynthV 对象会被登记为整数 handle，普通 JSON 数据直接内联。调用方可以沿对象 handle 遍历官方 API，而无需为每个方法新增 MCP 工具。`sv_root` 返回的根 handle 和已推断返回类型会被记录；对这些已知类型，`sv_call` 会在发往 SynthV 前校验方法、重载参数、handle 类型和官方文档中的最低版本要求。类型尚未知的 handle 仍交由宿主 dispatcher 执行，以保留通用遍历能力。

`sv_call.args` 和 `sv_run.steps[].args` 接受任意 JSON 值，并保留 number/string/boolean/object/array/null 类型。官方 API 要求数字索引时必须传 `[1]`，不能传 `["1"]`；handle 参数传 `{"__handle__": N, "__epoch__": E}`。

高层接口不替代原始 dispatcher，而是在它上面补充可验证语义：

- `sv_snapshot` 返回稳定字段、0-based 索引、显式单位和分页信息；`contextId` 只保存定位信息与指纹，不持久保存 Lua handle。project 快照每页最多消耗 16 个 `traversalItems`：有音符的 vocal group 按音符消耗，空组、乐器组和空轨也各消耗一项。`page.count` 是遍历预算消耗，`page.returned` 分别给出本页实际返回的 tracks/groups/notes 数量。调用方必须沿 `page.nextCursor` 读取到 `data.snapshotComplete: true`。**一条 track 可能跨页出现**（每页只带它的一部分 group/note）：跨页分片的 track 带显式 `fragment: true` 与 `continuedFromPreviousPage`/`continuesOnNextPage` 标记，调用方必须按 `track.index` 合并分片，不能把单页的 `groups` 当作该轨全集。页中途宿主报错时游标不推进，同一 cursor 重试会从本页页首完整重读。selection 的 processing 只统计选中音符；空选区返回 `expectedNotes: 0` 和 `state: "not_applicable"`。
- 索引约定：高层音乐工具一律使用 0-based canonical 索引；`sv_call`/`sv_run` 原始 dispatcher 保留宿主原生索引（SynthV 的 Lua API 为 1-based）。两套索引所指对象因此相差 1——`Project.getTrack(7)` 对应高层 `trackIndex 6`。错误消息同时标注两者（`trackIndex N (native index N+1)`）；混用两层接口时以此为换算基准。
- `sv_set_lyrics` 在写入前重新定位目标并比较指纹，只写真正变化的字段；返回 `processedNotes`、`actuallyChangedNotes`，并在 verification evidence 中逐项给出请求过的歌词、音素和语言读回值。
- `sv_patch_notes` 以 `sv_snapshot` 返回的 `data.notes[].id` 定位音符，支持 `expected` 逐字段前置条件与 `dryRun` 预演。`atomic:true`（默认）表示已验证补偿而非 ACID：失败时逆序恢复日志旧值并读回确认，status 区分 `rolled_back`、`rollback_failed`、`partial` 和 `outcome_unknown`。attributes 遵循官方 `setAttributes` 部分更新契约：只发送调用方提供的 key，但用完整读前/读后状态验证未触碰字段仍被保留；typed-v2 的 NaN/Inf 默认值只在回滚时通过协议信封无损送回。新增 key 无法由官方部分更新接口删除时，补偿会如实返回 `rollback_failed`。`expected.attributes` 仍是部分匹配；detune 与 attributes 浮点读回带相对容差。
- `sv_patch_notes` 与 `sv_restructure_notes` 也直接接受 `sv_snapshot_range` 的 range context：range noteId（`ctx:t:X:r:Y:n:Z`）自带 occurrence，一次请求内的所有 noteId 必须属于同一 occurrence；无 noteId 的 insert-only 请求在多 vocal occurrence 时返回带 `candidateOccurrences` 的 `AMBIGUOUS_CONTEXT`，需显式 `occurrenceId`。range context 的写入沿用 sv_edit_phrase 的共享 target 契约：commit 前扫描整个工程，多 occurrence 需 `allowSharedTargetMutation:true`（dry-run 推迟扫描并给出警告）。工具与 context 的完整兼容矩阵见 `svcopilot://capabilities` 的 `contextCompatibility`。
- `sv_snapshot_range` 在一个独占读取窗口内签发 occurrenceId、noteId、fingerprint 和可编辑 `contextId`。与范围半开区间相交的长音都会返回，即使 onset 位于范围起点之前。Automation 点也返回音乐坐标；独立数据预算溢出时返回 cursor，cursor 只分页已捕获的纯 JSON。全局最多采集 2,000 个音符、20,000 个 Automation 点和 20,000 个 computed-pitch 帧；单 group 每次 computed-pitch 请求最多 2,000 帧。`sinceToken` 仍需完整宿主读取与 hash；命中时返回新 `contextId`、`contextExpiresAt` 和 `page.detailCursor`，调用 cursor 可从内存取得匹配的新 occurrenceId/noteId，不再次读取宿主。
- `sv_wait_for_processing` 可直接复用 range context：显式 `occurrenceId` 优先；仅有一个 vocal occurrence 时可省略；多个候选返回带 `candidateOccurrences` 的 `AMBIGUOUS_CONTEXT`。只读预检校验 target UUID 并读取 live note count，不再逐 note 读取指纹。computed-pitch 的 `frames` 与 `minimumObservedFrames` 均限制在 1..2000，超限请求不会进入宿主。
- 参数曲线工具兼容原有 local/absolute BLICK，并支持精确小数/有理数拍点（含每小节最后一拍内的小数位，如 4/4 的 beat 4.5）、范围边界、note 相对位置和相邻 note gap。语义输入会复核 meter map、目标 UUID、note fingerprint；`expectedGroupUuid` 在读取（`sv_get_parameter_curve`）与写入端语义一致——不匹配即拒绝；同一 target 被多个 reference 复用时，mutation 必须显式确认。计划点与现有点完全一致且无 simplify 的"数学空操作"返回 `no_change`，不开启 Undo 边界、不触碰宿主。
- `sv_edit_phrase` 不调用 `NoteGroupReference.setTarget`：官方 API 规定已设置的 target 不可更改。音符或结构编辑在 detached clone 上完成预检；curve/voice-only 不 clone 整组，使用各自的 live journal preflight。共享 NoteGroup mutation 在 commit 时扫描整个工程并要求确认；voice 是 occurrence reference 状态，不受共享 target 确认约束。noteId 在任何 mutation 前一次性绑定到 handle；无实际 diff 返回 `no_change` 且不创建 Undo。`initialNoteCount`/`finalNoteCount` 始终表示完整 target group，`countScope` 为 `target_group`；verification phase 区分 `live_preflight`、`detached_preflight` 与 `commit_readback`。
- `sv_run` 支持 `#/roots/...`、`#/inputs/...`、`#/steps/<id>/result` 局部引用，最多 128 步，失败即停。只读断言步骤可用 `verifiesStep` 关联前面的 mutation，关联成功后不会产生 `UNVERIFIED_WRITE`。
- 每次 bridge 重连都会增加 epoch。带旧 `__epoch__` 的 handle 会在 Node 侧被拒绝；桥重连过之后，不带 `__epoch__` 的裸整数/裸对象 handle 同样被拒绝（无法证明来自当前连接），必须通过 `sv_root`/`sv_call` 重新解析并回传完整 handle 对象。

写工作流不是数据库事务。`before-and-after` 会调用两次 `project:newUndoRecord`，目标是让一次逻辑编辑通常形成一个用户撤销步骤；支持 atomic 的高层工具使用 journal 补偿并读回验证，仍可能如实返回 `rollback_failed` 或 `outcome_unknown`。原始 `sv_run` 不承诺通用自动回滚。

`sv_run` 的后续步骤必须使用完整 JSON Pointer 引用：

```json
{
  "mode": "read",
  "steps": [
    {"id":"track","op":"call","target":{"$ref":"#/roots/project"},"method":"getTrack","args":[1]},
    {"id":"name","op":"call","target":{"$ref":"#/steps/track/result"},"method":"getName","retainResult":true}
  ]
}
```

`$track`、`$track.result` 和 `{"$ref":"track"}` 都不是有效语法。

步骤结果默认只在本次 workflow 内可供后续 `$ref` 使用，不进入响应；其中新产生且未导出的 handle 会在结束时自动释放。`retainResult:true` 会把该步骤结果放进 `steps[].result`，`exports` 会把命名结果放进顶层 `exports`；两者中可达的 handle 均转移给调用方，必须在使用完毕后调用 `sv_free`。每次响应的 `handleOwnership` 会列出 `returnedHandles`、自动释放数量和清理失败句柄；旧的 `return` 字段已删除并会被 schema 拒绝。

`coverageAtLeast` 的报告会同时返回 `observedCoverage` 和 `requiredCoverage`。超过 32 项的断言观测只返回形状、数量、覆盖和数值范围摘要；一个 step result 同时设置 `retainResult:true` 和直接 export 时，step 使用 `resultRef` 指向 exports，不重复内联大数组。

音素处理完成度和内容覆盖率是两个独立维度。typed-v2 envelope 的实际观测项未齐时为 `pending`；实际观测项齐全时即为 `ready`，`-`、`+` 等延音产生的合法空字符串不会降低处理状态。`phonemeCoverage` 单独报告非空数、空值数、空值索引与缺项索引。`requireNonEmpty` 和 `requireNonEmptyPhonemes` 默认关闭；显式启用后，它们只增加全非空质量条件，超时返回 `phoneme_coverage_unsatisfied`，但 `data.state` 仍保持 `ready`。

原始 dispatcher 保留宿主返回值，因此 `unselectNote` 等 mutation 即使实际生效也可能返回 `false`。不要把宿主布尔值当作后置条件；使用 `verifiesStep` 读回状态或高层工具。稳定错误会分类为 `UNKNOWN_METHOD`、`UNKNOWN_FIELD`、`UNKNOWN_HANDLE`、`INDEX_OUT_OF_RANGE`、`HOST_TIMEOUT` 等，而不是统一的 `INTERNAL_ERROR`。

### 推荐的歌词编辑闭环

1. `sv_snapshot { "scope": { "kind": "selection" } }`，检查 `status`、音符数量和歌词。
2. 保存返回的 `contextId`，调用 `sv_set_lyrics`，歌词数组长度必须与上下文音符数完全一致。
3. 检查 `effects: "verified"`、`verification.passed: true`、`processedNotes` 和 `actuallyChangedNotes`；如等待计算结果，还要检查 `data.processing.state`。
4. 需要继续编辑时重新快照。成功写入后旧 `contextId` 会失效。

### 推荐的乐句调音闭环

1. 用一次 `sv_snapshot_range` 读取 notes、voiceParameters、automation、computedPitch、attributes 和 processing。
2. 用 `sv_edit_phrase {dryRun:true}` 或 `sv_patch_parameter_curves {dryRun:true}` 检查解析后的音乐锚点与完整 diff。
3. 用一次对应 commit 完成一个 Undo，并检查内建 read-back verification。
4. 需要计算结果时调用一次 `sv_wait_for_processing`。
5. 用 `sv_start_audition {autoStop:true}` 启动非阻塞定长试听，随后按需用 `sv_get_audition` 取得终态；人类负责听感判断。

## Smoke test

连接后依次调用：

1. `sv_ping`，应返回 `"pong"`。
2. `sv_root`，保存返回的 project handle。
3. `sv_call { "handle": <project>, "method": "getFileName" }`。
4. `sv_call { "handle": <project>, "method": "getNumTracks" }`。
5. `sv_index { "field": "QUARTER" }`，Synthesizer V Studio 2 官方值为 `705600000`。

对象 handle 也能作为参数传回。请始终回传服务器返回的完整 handle 对象（含 `__epoch__`）——
桥一旦重连过，不带 `__epoch__` 的裸整数/裸对象 handle 无法证明来自当前连接，会被
`STALE_HANDLE` 拒绝（新桥会把低位 id 重新分配给别的对象，放行等于静默操作错对象）：

```text
sv_call { "method": "create", "args": ["Note"] }
  → { "__handle__": 8, "__type__": "Note", "__epoch__": 1 }

sv_call {
  "handle": { "__handle__": 7, "__epoch__": 1 },
  "method": "addNote",
  "args": [{ "__handle__": 8, "__epoch__": 1 }]
}
```

## 测试

在 `server/` 中运行完整自动化测试：

```powershell
npm test
```

运行一个完整的模拟 MCP 客户端：

```powershell
npm run smoke:mcp
```

该命令会依次启动 stdio MCP server、独立 Lua bridge 和客户端，并实际调用
`listTools`、文档/能力资源、原始工具、`sv_run`、选择区快照、歌词写入、处理等待、二次快照与 Stop 脚本。

它包含：

- Relay 握手、错误帧回包、串行队列和 control pipe 测试。
- 使用真实 Lua 解释器连接真实 Windows named pipe 的端到端测试。

纯 Lua dispatcher 回归测试：

```powershell
lua ..\test\dispatcher_test.lua `
  "..\..\scripts\SynthVCopilotResearch\copilot\sv-scripts\StartSynthVCopilot.lua"
```

预期：`18 passed, 0 failed`。

## 安全与约束

- SynthV 的 pipe 读取是阻塞的。Relay 必须为桥发送的每一帧立即回复 `command`、`noop`、`shutdown` 或 `error`；实现和测试都维护这一不变量。
- Relay 崩溃会使 Lua 读到 EOF 并退出；Relay 仍存活但停止响应时，SynthV UI 仍可能冻结。这是 stock Lua named pipe 无超时读取的固有限制。
- 当前队列最多 64 个调用，单帧最多 64 KiB，单调用默认超时 10 秒。
- handle 带连接 epoch，只适合短期使用；工程结构变化后也应重新读取，不要长期缓存。
- 快照是同一独占读取窗口内的 best-effort 视图，不是 SynthV 提供的原子工程快照。
- 官方 API 完全没有枚举已安装声库、可用 singer、当前 singer 身份或 singer 分配关系的方法；当前只能读取/写入公开的 voice 参数，能力资源会显式报告该缺口。
- 原始 dispatcher 暂无运行时反射或通用自动回滚；高层编辑工具提供各自的 dry-run、前置条件和已验证补偿。清单预检来自下载的官方文档而非宿主反射，类型未知 handle 的调用仍需调用方谨慎确认。

更完整的协议与故障模型见 [docs/architecture.md](docs/architecture.md)。当前实现、验证和工作区状态见
[HANDOFF.md](HANDOFF.md)；唯一有效的后续路线图与宿主验收计划见
[docs/MCP_MUSIC_WORKFLOW_MASTER_PLAN.md](docs/MCP_MUSIC_WORKFLOW_MASTER_PLAN.md)。

## 项目文档

| 文档 | 用途 |
| --- | --- |
| [HANDOFF.md](HANDOFF.md) | 当前接口、验证、工作区和最近下一步 |
| [音乐工作流主计划](docs/MCP_MUSIC_WORKFLOW_MASTER_PLAN.md) | 唯一未来路线图、宿主可行性和验收标准 |
| [IO PIPE 架构](docs/architecture.md) | 协议、并发、生命周期和失败模型 |
| [2026-07 归档](docs/archive/2026-07/README.md) | 已完成的 PRD、审查、研究和黑盒历史 |

## 官方 API 文档镜像

在 `server/` 中运行以下命令，可抓取 Dreamtonics 官方英文 Scripting Manual 的
HTML 页面和静态资源，并生成带来源和 SHA-256 的清单：

```powershell
npm run download:sv-api
```

镜像输出在 `api-docs/official/`。API Manifest、MCP 文档资源和调用预检都以这份可追踪的镜像为输入。

解析本地镜像：

```powershell
npm run parse:sv-api
```

它会生成 `api-docs/api-manifest.json` 与 `api-docs/api-inventory.json`，其中保留类、继承、
成员、方法重载、参数、返回类型、版本提示、回调参数及原始文档锚点。
