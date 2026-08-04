# synthv-agent-bridge 对照调查报告

日期：2026-07-29

## 1. 调查范围

本报告对照以下两个代码快照：

- SVCopilot：`feat/mcp-interaction-efficiency`，提交 `b1d08cc`
- [zhoupengjie/synthv-agent-bridge](https://github.com/zhoupengjie/synthv-agent-bridge)：提交 [`c6d1569a`](https://github.com/zhoupengjie/synthv-agent-bridge/tree/c6d1569a64407034e1d74d52d1adff52b9a9fd88)，版本 `0.1.5`

调查方法：

1. 将目标仓库浅克隆到系统临时目录，没有写入 SVCopilot 工作区。
2. 阅读 README、架构、协议、路线图、TypeScript MCP 层、Lua 执行器和测试。
3. 运行目标仓库的 `npm ci && npm test`，结果为 `64/64` 通过。
4. 使用 Codegraph、Serena 和源码搜索核对 SVCopilot 当前 41 个工具、服务边界和官方 API 清单。
5. 对 SVCopilot 的 MCP 工具元数据进行本地序列化测量。

证据限制：

- `synthv-agent-bridge` 的 64 个测试主要验证 TypeScript、协议、源码契约和模拟 IPC，不等于真实 SynthV 宿主验收。
- 本报告没有把对方 README 中的能力声明自动视为已完成实机验证。
- SVCopilot 已有 Node 全量测试、MCP smoke 和近期 Live Probe 实机数据，双方证据强度并不对称。

## 2. 结论

`synthv-agent-bridge` 不适合替换 SVCopilot，但值得作为“官方 API 高层覆盖”和“MCP 紧凑入口”的参考实现。

SVCopilot 当前更强的部分：

- IO PIPE 实时传输，而不是轮询文件 IPC。
- 音乐语义分析、歌词语义、风格分析、和声规划、量化、音高表情规划。
- Range Snapshot、Artifact 分页、PlanRef、Dense Codec 和响应预算。
- 写入后的回读验证、自动补偿、`outcome_unknown` 语义。
- Computed Pitch 比较与烘焙。
- 自动停止试听、状态恢复和 A/B 试听。
- 官方 API 搜索和 `sv_call`/`sv_run` 原始逃生通道。

`synthv-agent-bridge` 明显更强的部分：

- Retake 的生成、激活、删除和 Bridge 跟踪。
- 可复用 NoteGroup 库及 Group Reference 的完整 CRUD。
- 时间轴、轨道、混音器、编辑器视口、坐标、吸附、剪贴板和对话框的高层接口。
- 类型化的音素集、音节时值和逐音素属性编辑。
- 原生 SynthV 侧边栏审核流程。
- Doctor、安装器和热重载。
- 用 8 个 MCP 工具按需承载约 68 个 operation，默认工具元数据小于 6 KB。
- 在 Lua 宿主侧完成投影、范围扫描、机械批处理和单 Undo 事务，减少跨进程往返。

最值得借鉴的不是文件 IPC，而是：

1. **按需 operation catalog，缩小 MCP 默认工具表面。**
2. **在现有 IO PIPE Lua bridge 中增加有界的批量读取原语。**
3. **补齐 Retake、NoteGroup 库/引用、时间轴和逐音素属性的安全高层接口。**
4. **将原生侧边栏作为可选的人类审核层，而不是新的执行通道。**

## 3. 架构对照

| 维度 | SVCopilot | synthv-agent-bridge | 判断 |
|---|---|---|---|
| Node ↔ SynthV 传输 | Windows IO PIPE、typed-v2、epoch handle | 关联 JSON 文件、10/25 ms 轮询 | 保留 SVCopilot |
| MCP 默认表面 | 41 个工具；另有 `core/music/raw/full` profile | 8 个域工具 + `sv_describe` 按需 operation schema | 对方更省元数据 |
| 高层 operation 数 | 约 35 个音乐/工作流工具 + raw API | 约 68 个 curated operation | 对方官方 API 覆盖更广 |
| 原始 API 逃生通道 | `sv_root/sv_call/sv_index/sv_run` | 无等价的通用公开 dispatcher | SVCopilot 更完整 |
| 大结果传输 | Artifact、8 KiB 分页、hash、释放、Dense Codec | 紧凑投影、Dense rows、Guard Token | SVCopilot 更成熟 |
| 乐理与音乐分析 | 丰富 | 主要是有限诊断和确定性 preset | SVCopilot 显著更强 |
| 写入安全 | 多个域内补偿事务和回读验证 | 完整预检 + 单 Undo；部分执行异常要求用户 Undo | SVCopilot 更强 |
| 通用跨操作事务 | `sv_run` 和 `sv_edit_phrase`，但不是任意 operation rollback | 最多 32 个独立步骤，可保存会话内反向步骤 | 对方更通用，但恢复较弱 |
| 宿主侧批处理 | 通用单调用 dispatcher 为主 | 大量 Lua 专用 action，一次扫描/一次批处理 | 对方更少往返 |
| 人类审核 UI | MCP 工作流和 SynthV 原生 UI | 可选 SidePanel 预览/Apply/Dismiss | 对方有独特价值 |
| 运维 | Start/Stop、smoke、Live Probe、host profile | installer、doctor、hot reload、heartbeat/session reset | 对方更完整 |

## 4. MCP 工具元数据

本地对 SVCopilot `TOOLS` 的 minified JSON 实测：

| Profile | 工具数 | 元数据字节数 |
|---|---:|---:|
| `full` | 41 | 130,735 |
| `core` | 14 | 35,350 |
| `music` | 34 | 124,075 |
| `raw` | 8 | 7,088 |

对方测试锁定：

- 默认只暴露 `sv_status`、`sv_describe`、`sv_read`、`sv_edit`、`sv_delete`、`sv_transaction`、`sv_ui`、`sv_sidebar`
- `tools/list` 的 JSON 长度小于 6,000
- 具体 operation schema 最多按需读取 16 个

参考：

- [README_CN：MCP v2 工具](https://github.com/zhoupengjie/synthv-agent-bridge/blob/c6d1569a64407034e1d74d52d1adff52b9a9fd88/README_CN.md#L266-L304)
- [v2 metadata budget 测试](https://github.com/zhoupengjie/synthv-agent-bridge/blob/c6d1569a64407034e1d74d52d1adff52b9a9fd88/tests/server.test.ts#L60-L87)
- SVCopilot：`server/src/index.js`
- SVCopilot：`server/src/tool-profile.js`

### 建议

不要立即删除现有 41 个强类型工具。先增加一个实验性 `compact-v2` profile：

- `sv_status`
- `sv_describe_workflow`
- `sv_read`
- `sv_plan`
- `sv_edit`
- `sv_delete`
- `sv_audition`
- `sv_artifact`

现有高层服务仍是唯一实现，compact facade 只负责：

- operation 路由；
- 按需 schema；
- 统一错误信封；
- 统一 Artifact/PlanRef；
- 将 operation payload 交给现有 service。

这样可以比较：

- 41 个直接工具的可发现性；
- 8 个域工具的元数据成本；
- 仅凭 MCP 自描述时，独立 LLM 的首次成功率和错误率。

在独立 LLM usability test 通过之前，不应把 router 设为唯一默认表面。对方方案节省元数据，但会把 schema 发现变成额外调用，并增加猜错 operation payload 的风险。

## 5. 我们缺少或高层封装不足的能力

### 5.1 Retake 生命周期

对方提供：

- `get_note_retakes`
- `generate_note_retake`
- `activate_note_retake`
- `delete_note_retake`

实现策略：

- 调用官方 `Note.getRetakes()` / `RetakeList.generateTake()`。
- 将 Bridge 自己生成的 Take ID 写入该 `RetakeList` 的 namespaced script data。
- 只允许激活默认 Take 或 Bridge 已跟踪 Take。
- 只允许删除 Bridge 已跟踪的非默认 Take。
- 明确承认官方 API 不能枚举 Take ID，也不能读取当前活动 Take ID。

参考：

- [Lua Retake 实现](https://github.com/zhoupengjie/synthv-agent-bridge/blob/c6d1569a64407034e1d74d52d1adff52b9a9fd88/synthv/SynthVAgentBridge.lua#L6585-L6679)
- SVCopilot 官方 API mirror：`api-docs/api-manifest.json` 中的 `RetakeList`
- SVCopilot 当前 `sv_snapshot_range` 仍将 `retakes` 标为 unsupported。

建议：**P1 实现。**

可设计：

- `sv_get_note_retakes`
- `sv_generate_note_retakes`
- `sv_activate_note_retake`
- `sv_delete_note_retake`

或者使用一个 `sv_patch_retakes` 事务工具承载后三者。

安全要求：

- note fingerprint / range context guard；
- 生成、激活、删除各自一个 Undo；
- 不虚构 activeTakeId；
- 返回 `trackedTakeIds` 和 `untrackedTakeCount`，不能把 `getNumTakes` 当成可枚举 ID；
- Bridge 重启后仍可从 namespaced script data 恢复自己生成的 ID；
- Live Probe 验证 `generateTake`、`setActiveTake`、`deleteTake` 的真实 Undo 和返回语义。

### 5.2 NoteGroup 库和 Group Reference CRUD

对方提供：

- `list_note_groups`
- `create_note_group`
- `clone_note_group`
- `delete_note_group`
- `add_group_reference`
- `clone_group_reference`
- `delete_group_reference`

其中 `clone_group_reference(linked:false)` 会：

1. `sourceGroup:clone()`；
2. 将新 Group 加入 Project library；
3. 创建指向新 Group 的 Reference；
4. 复制 time/pitch offset、mute、voice 和 time range。

参考：

- [NoteGroup 与 Group Reference 实现](https://github.com/zhoupengjie/synthv-agent-bridge/blob/c6d1569a64407034e1d74d52d1adff52b9a9fd88/synthv/SynthVAgentBridge.lua#L3522-L3693)

SVCopilot 当前可以遍历 Reference，也有 `sv_clone_track_from_template`，但已知克隆轨道可能继续共享 NoteGroup，并明确返回：

```json
{"isIsolatedEditableTarget":false}
```

建议：**P1 实现，优先于继续增强 track clone。**

新增高层服务应明确区分：

- `linked`：共享 target，编辑会影响所有 occurrence；
- `isolated`：克隆 NoteGroup，UUID 必须变化，编辑不得影响来源；
- `mainGroup`：宿主特殊对象，不应伪装成 library group。

核心验收：

- isolated clone 的目标 UUID 与源 UUID 不同；
- 修改 isolated clone 后源 Group fingerprint 不变；
- linked clone 明确返回全部共享 occurrence；
- 删除 library group 前报告引用数量并要求显式确认；
- 所有结构写入都回读 Project/library/track 状态。

### 5.3 时间轴的安全高层写入

对方提供：

- `get_time_axis`
- `convert_time`
- `set_time_axis`

它为 tempo/meter map 生成 fingerprint，并在写入后验证宿主保留了请求标记。

SVCopilot 已在 Range Snapshot 中读取 tempo/meter map，并能把 bar/beat 转换为 BLICK，但没有高层时间轴事务。调用方只能走 raw API。

建议：**P1 实现。**

设计为 `sv_patch_time_axis`：

- 使用 snapshot token + tempo/meter fingerprint；
- 支持 add/update/delete；
- dry-run；
- 单 Undo；
- 写后读取完整受影响区间；
- 冲突返回 `STALE_TIME_AXIS`；
- tempo/meter 修改会使旧 musical anchor context 全部失效。

### 5.4 类型化逐音素属性

对方将以下字段做成明确 schema：

- `phonesetOverride`
- `evenSyllableDuration`
- `phonemeAttributes[]`
- 每个 phoneme 的 `duration`、`position`、`activity`、`strength` 等受支持属性

其底层仍通过 Note attributes 读合并写入，但调用者不需要猜内部对象结构。

SVCopilot 的 `sv_patch_notes.attributes` 和 `sv_edit_phrase` 在底层具备通用属性写入能力，但缺少面向发音工作的稳定类型化契约。

建议：**P1 实现为现有工具的 schema 扩展，不必再造平行执行器。**

可以增加：

```json
{
  "phonemePatch": {
    "phonesetOverride": "...",
    "evenSyllableDuration": true,
    "phonemes": [
      {"index": 0, "expected": {"duration": 0.12}, "set": {"duration": 0.15}}
    ]
  }
}
```

继续复用 `sv_patch_notes` / `sv_edit_phrase` 的事务、回读和补偿内核。

### 5.5 Track、Mixer 和 Render Panel 高层操作

对方提供：

- add/update/clone/delete track；
- name、displayColor、bounced；
- gain、pan、mute、solo；
- source track fingerprint；
- clone 后的转调、音域约束和可选清空。

SVCopilot 已有试听期间 mixer 保存/恢复和模板轨克隆，但没有完整的日常 Track/Mixer 管理接口。

建议：**P2。**

优先实现：

1. `sv_patch_track`：name/color/render inclusion；
2. `sv_patch_mixer`：gain/pan/mute/solo；
3. `sv_create_track` / `sv_delete_track`；
4. 独立 Group clone 完成后，再提供真正隔离的 `sv_clone_track`。

对方的 `Track:clone()` 也不能保证所有非 main Group 自动隔离。它只在随后需要清空/移调而发现仍共享 target 时拒绝继续，因此不应照搬“deep clone”宣传语。

### 5.6 Editor View、吸附、坐标、剪贴板和对话框

对方提供：

- `get_editor_view` / `set_editor_view`
- `snap_position`
- `convert_editor_coordinates`
- `host_clipboard`
- `show_dialog`

这些官方 API 也可由 SVCopilot raw dispatcher 调用，但没有稳定高层契约。

建议分级：

- View/coordinate/snap：**P2，可安全加入 `sv_ui` 类高层接口。**
- Clipboard：**P3，必须 opt-in，默认只写调用方明确提供的文本。**
- Dialog：**P3，默认禁用或要求 `allowHostUi:true`，防止 Agent 阻塞脚本线程或打扰用户。**

不应让模型通过剪贴板或对话框绕过 MCP 的结构化输入输出。

### 5.7 原生 SidePanel 审核

对方 SidePanel 支持：

- 显示 Bridge/MCP heartbeat；
- 汇总当前 selection；
- 用户输入请求并复制 handoff；
- 展示结构化 preview、风险和 before/after；
- Apply/Dismiss/Cancel；
- 最多 20 条脱敏历史；
- 诊断和恢复指引。

参考：

- [SidePanel 文档](https://github.com/zhoupengjie/synthv-agent-bridge/blob/c6d1569a64407034e1d74d52d1adff52b9a9fd88/docs/sidebar.md)

建议：**P2 可选产品层。**

可借鉴其状态机和安全边界：

```text
queued -> claimed -> awaiting_confirmation -> applying -> terminal
```

但不要复制其文件 sideband。SVCopilot 可选择：

- SidePanel 只读本地 preview 文件，Apply 命令仍进入现有 Node/PIPE coordinator；或
- 使用一条独立、严格有界的 control pipe。

SidePanel 不应成为第二个工程写入器，也不能直接信任 UI 回传的 mutation payload；它只能回传 planId + decision。

### 5.8 Doctor、Installer 和 Hot Reload

对方提供：

- `npm run install:synthv`
- `npm run doctor`
- installer manifest；
- heartbeat/version 检查；
- Lua `loadfile()` 热重载；
- session token 变化后清空 Context/Guard。

SVCopilot 已有 Start/Stop、MCP smoke、Live Probe 和 host profile，但安装、版本错配诊断及无损热重载仍可改善。

建议：**P2。**

优先实现只读 doctor：

- staging 与 loaded Lua hash/version；
- Node/Lua interface version；
- pipe 是否存在；
- MCP profile；
- SynthV heartbeat/epoch；
- manifest/API 版本；
- 常见配置路径。

热重载必须先用 Live Probe 验证 SynthV `loadfile()` 生命周期，且重载后立即：

- epoch +1；
- 清空 handle、snapshot context、plan capsule 和 Artifact 中的 host-bound引用；
- 返回 `SYNTHV_SESSION_CHANGED`；
- 不自动重启 SynthV，避免未保存工程丢失。

## 6. 最值得借鉴的性能设计

### 6.1 将投影和批量读取下沉到 Lua，但保留 IO PIPE

对方的 `get_phrase_context` 在 Lua 中：

- 一次定位 Group；
- 一次扫描音符；
- 复用同一批音符生成多个 range；
- 只计算 requested include；
- 在宿主侧生成紧凑音符和 automation summary；
- 只把最终结果跨 IPC 返回。

这正对应 SVCopilot 当前剩余的固定成本。最近 Live Probe 数据显示，7 个分散 note 的 dry-run 已从 6.8 秒降到 177 ms，但仍有：

- 86 次 host call；
- `fingerprintVerificationMs = 122 ms`；
- 每个音符 1 次 `getNote` + 8 个 fingerprint getter + `$free`。

建议：**P0 实现有界的内部批量读原语，而不是通用任意 batch。**

示例内部协议：

```json
{
  "op": "$readNoteFingerprints",
  "target": {
    "trackIndex": 0,
    "groupReferenceIndex": 0,
    "expectedGroupUuid": "..."
  },
  "noteIndicesInGroup": [0, 62, 124, 186, 248, 310, 372],
  "fields": [
    "indexInGroup",
    "onsetBlick",
    "durationBlick",
    "pitch",
    "lyrics",
    "phonemesOverride",
    "languageOverride",
    "detuneCents"
  ]
}
```

约束：

- 仅内部使用，不直接暴露给 MCP；
- 一次最多 200 个 note；
- field allowlist；
- Lua 在一个请求中定位并读取；
- 返回顺序必须与请求索引绑定；
- 任一目标缺失时整批失败，不返回位置错配的部分结果；
- 受 64 KiB frame 限制，超限前结构化拒绝；
- diagnostics 报告 `bulkCalls`、`noteCount`、`fieldCount` 和宿主阶段，不记录歌词等内容。

验收：

- 7-note dry-run 的语义结果与现有逐调用路径逐字节等价；
- dry-run 无 setter、无 Undo；
- stale fingerprint 仍在写前失败；
- fault injection 覆盖中间 getter 抛错；
- Live Probe 中 host call 数从 86 显著下降；
- 以 20 次预热后基准确定 p50/p95，不预设不可信的绝对阈值。

### 6.2 Guard Token 的可借鉴部分

对方把完整 fingerprint 存在 Node 内存中，只给模型短 token；token 同 target binding 绑定，session 改变时失效。

SVCopilot 已有 contextId、noteId、PlanRef capsule 和 Artifact，因此不需要复制一套平行 Guard Store。可借鉴的是：

- 在一个 Context 内提供短的 `noteRef`/`guardRef`；
- mutation 输入允许 `occurrenceId + noteIndexInGroup`；
- Plan capsule 只保存被触及的 fingerprint；
- session/epoch 变化统一失效。

本轮 scoped note reference 已经沿这个方向完成。下一步应优先减少宿主往返，而不是继续压缩已经很短的请求。

## 7. 不建议照搬的部分

### 7.1 文件 IPC

对方明确承认文件 IPC 较慢，采用它是为了可移植、可检查和易恢复。SVCopilot 已有经过实机验证的 IO PIPE，不应倒退。

参考：

- [Architecture：Why file IPC](https://github.com/zhoupengjie/synthv-agent-bridge/blob/c6d1569a64407034e1d74d52d1adff52b9a9fd88/docs/architecture.md#L24-L56)

### 7.2 1-based 高层索引

对方为了贴合 Lua 使用 1-based。SVCopilot 高层工具已经统一 0-based，并明确区分 caller/native index。改变会制造兼容和推理错误。

### 7.3 无补偿的通用大事务

对方 `apply_transaction` 会先预检最多 32 步并用一个 Undo 执行，但执行期意外失败后可能留下部分更改，要求用户手动 Undo。保存的 rollback steps 也只在当前 Bridge 进程内有效。

SVCopilot 不应为了“通用”牺牲：

- verified compensation；
- `rolled_back` / `rollback_failed` / `outcome_unknown`；
- 写后回读；
- 域内不变量。

可以借鉴通用 transaction 的 request/result reference，但只有能提供补偿日志和回读验证的 operation 才允许加入。

### 7.4 单体 Lua 执行器

对方 Lua 文件超过 8,000 行，所有 action、验证、序列化和事务集中在一个文件。它减少往返，但维护、测试和差异审计成本较高。

SVCopilot 应保持：

- Node 侧独立 service；
- Lua 侧小型 transport/runtime；
- 只把高收益、机械、宿主亲和的批量 primitive 下沉；
- fake host 与 Live Probe profile 继续作为宿主语义证据。

### 7.5 未经实机验证的“深克隆”和宿主语义

目标仓库测试全部通过，但没有在本次调查中连接真实 SynthV。Track clone、Retake、Unison、time-axis 边界和 UI navigation 仍需用我们的 Live Probe 验证，不能因为其代码存在就视为官方语义已确认。

## 8. SVCopilot 已有且不应被稀释的优势

外部项目没有等价实现的主要能力：

- `sv_analyze_vocal_context`
- `sv_analyze_phrase`
- `sv_style_profile`
- `sv_validate_lyrics_prosody`
- `sv_generate_harmony` 的旋律证据、调式与候选和弦
- `sv_quantize_notes`
- `sv_plan_expression`
- `sv_plan_pitch_gesture`
- `sv_compare_computed_pitch`
- `sv_bake_computed_pitch`
- `sv_audition_compare`
- Range musical coordinates、occurrence identity、note-relative anchor
- Artifact paging/hash/release
- PlanRef 跨 context TTL 的最小 capsule
- Dense Codec 写入
- 处理状态对合法空音素的正确建模
- 特殊歌词 `br/+/-/'` 的共享语义
- 写后 processing observation 失败不污染已验证写入结果

因此路线应是“补齐高层 API 覆盖 + 压缩工具入口 + 减少 PIPE 往返”，而不是把现有音乐工作流改造成对方的低层 operation catalog。

## 9. 建议实施顺序

### P0：交互与宿主往返效率

1. 增加实验性 `compact-v2` MCP profile 和按需 workflow operation schema。
2. 测量 41-tool、core 和 compact-v2 的实际 tools/list 字节与模型 token。
3. 增加内部 `$readNoteFingerprints` 批量原语。
4. 将 `sv_patch_notes`、`sv_restructure_notes` 和 range context live preflight 接入批量原语。
5. 用 Live Probe 重跑 1/7/200 note 的 A/B/C 基准。

### P1：真正缺失的音乐工程能力

1. Retake 生命周期。
2. NoteGroup library / linked-reference / isolated-reference。
3. `sv_patch_time_axis`。
4. 类型化 phoneme/phoneset/syllable patch。
5. Track/Mixer 高层读写。

### P2：产品体验和运维

1. 只读 doctor 和安装版本核对。
2. 安全热重载和统一 epoch 失效。
3. Editor view/snap/coordinate。
4. 可选 SidePanel 审核。
5. Clipboard/dialog opt-in。

## 10. 发布门槛

### Compact MCP surface

- 默认元数据目标先设为 `< 10 KiB`，再根据独立 LLM 测试调整。
- 只凭 MCP 自描述完成至少 10 个典型工作流。
- 与直接工具相比，首次调用成功率不能显著下降。
- 拼错 operation 或嵌套字段必须在宿主调用前失败。

### Bulk host primitive

- 与逐调用路径结果等价。
- 1、7、200 notes 覆盖。
- 64 KiB 边界覆盖。
- 中途 getter 失败不产生错位或部分可信结果。
- epoch、handle 和 `$free` 生命周期无泄漏。

### Retake

- generate/activate/delete 在真实宿主通过。
- default take 不能删除。
- untracked take 不能激活或删除。
- Bridge 重载后 tracked IDs 可恢复。
- 不声明可读取 active take。

### Isolated Group clone

- UUID 改变。
- source fingerprint 不变。
- cloned reference 的 voice/time/pitch/range 回读一致。
- shared/isolated 在响应中不可混淆。

### Time axis

- tempo/meter add/update/delete 实机通过。
- musical coordinate roundtrip 通过。
- stale map 0 写入。
- 旧 range context 在 tempo/meter 写入后失效。

## 11. 许可证

目标仓库使用 Apache-2.0。可以借鉴设计，也可以在满足许可证的前提下移植代码，但如果复制具体实现，应：

- 保留适用的版权和许可证声明；
- 在 `THIRD_PARTY_NOTICES.md` 中记录来源、提交和修改；
- 不把其 README 声明当成我们自己的实机验证证据。

本报告只进行了设计与实现对照，没有复制目标仓库代码进入 SVCopilot。

## 12. 主要证据索引

外部项目：

- [README_CN 功能表](https://github.com/zhoupengjie/synthv-agent-bridge/blob/c6d1569a64407034e1d74d52d1adff52b9a9fd88/README_CN.md#L42-L54)
- [README_CN operation catalog](https://github.com/zhoupengjie/synthv-agent-bridge/blob/c6d1569a64407034e1d74d52d1adff52b9a9fd88/README_CN.md#L301-L375)
- [Compact MCP boundary](https://github.com/zhoupengjie/synthv-agent-bridge/blob/c6d1569a64407034e1d74d52d1adff52b9a9fd88/docs/architecture.md#L58-L124)
- [Transaction layer](https://github.com/zhoupengjie/synthv-agent-bridge/blob/c6d1569a64407034e1d74d52d1adff52b9a9fd88/docs/architecture.md#L139-L184)
- [Protocol 与 Guard Token](https://github.com/zhoupengjie/synthv-agent-bridge/blob/c6d1569a64407034e1d74d52d1adff52b9a9fd88/docs/protocol.md#L58-L100)
- [Roadmap](https://github.com/zhoupengjie/synthv-agent-bridge/blob/c6d1569a64407034e1d74d52d1adff52b9a9fd88/docs/roadmap.md)

SVCopilot：

- `server/src/index.js`
- `server/src/tool-profile.js`
- `server/src/musical-range.js`
- `server/src/note-patch.js`
- `server/src/phrase-edit.js`
- `server/src/pitch-control-patch.js`
- `server/src/artifact-store.js`
- `server/src/plan-reference.js`
- `server/src/audition.js`
- `server/src/audition-compare.js`
- `api-docs/api-manifest.json`
