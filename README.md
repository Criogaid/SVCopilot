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
- 协议：NDJSON、版本握手、严格一写一读、单命令 in-flight。
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
| `sv_run` | 在一个不可插队的执行单元中运行有序 call/index 步骤、局部引用、断言与句柄清理 |
| `sv_wait_for_processing` | 只读轮询音素、计算属性或计算音高；直接接受 group/selection context 或 range context + occurrenceId，单 occurrence 可自动选择，超时返回最后一次观测而非伪造成功 |
| `sv_set_lyrics` | 对选择区或快照上下文设置歌词，可选音素/语言，执行冲突检查、撤销边界和逐项读回 |
| `sv_patch_notes` | 按快照 noteId 对现有音符做字段级 patch，支持 expected 前置条件、dryRun plannedDiff、Undo 边界、读回验证和已验证补偿回滚 |
| `sv_snapshot_range` | 一次读取可编辑范围上下文：相交音符/occurrence 身份、voice、Automation、computed pitch、attributes、processing、tempo/meter、mixer；严格拒绝未知字段；按数据类型预算分页，cursor 续读不重访宿主；`sinceToken` 命中时用 `detailCursor` 取得新 context 身份 |
| `sv_restructure_notes` | 结构操作：insert / delete（clone 备份）/ split（延音第二半）/ merge（连续音符），按调用顺序执行、活动 index 解析、Undo 边界与已验证补偿回滚 |
| `sv_get_parameter_curve` | 在必填 blick 范围内读取经官方/动态 vocal mode 白名单验证的 group 参数曲线：requested/resolved 名称、definition、插值方式、local/absolute 双坐标、统计和续读游标 |
| `sv_get_voice_profile` | 读取轨道各 group 的可观测 voice 参数与 vocalMode 名称；singer 身份/声库目录/分配关系明确报告 unobservable |
| `sv_clone_track_from_template` | Track.clone + addTrack 克隆轨道（如和声轨），Undo 边界 + 读回验证；隐藏 singer 状态是否保留报告 `host_opaque` |
| `sv_start_audition` / `sv_get_audition` / `sv_stop_audition` / `sv_restore_audition` | 非阻塞试听状态机：可选 `autoStop`，区分 timer/queue/overrun，恢复原 playback status、playhead 和未被用户改动的 solo；recovery payload 可跨 server 崩溃使用。MCP 听不到声音，感知判断属于人 |
| `sv_patch_parameter_curve` | 用 BLICK、音乐位置、范围边界、note 或相邻音符 gap 锚点 replace/add/scale 参数控制点；参数白名单、宿主 typeName 复核、Undo、读回验证和已验证补偿 |
| `sv_patch_parameter_curves` | 在同一 group 上预检并批量写入 1--16 条曲线：范围上下文/共享 target 前置条件、一次 Undo、逐曲线读回、跨曲线补偿、三档响应和统一 timings |
| `sv_edit_phrase` | 在一个 Undo 中组合 note patch、歌词/语言、结构操作、多曲线和可观测 voice patch；音符/结构使用 detached clone，curve/voice-only 使用轻量 live preflight，失败时按 journal 恢复并读回验证 |

MCP 资源还提供：

- `svapi://manifest`：完整官方 API 清单。
- `svapi://class/{class}`：按精确类名读取，例如 `svapi://class/Note`。
- `svcopilot://capabilities`：当前连接 epoch、接口版本、限制和已知能力缺口。
- `svcopilot://schemas/music-workflow`：组合音乐工具的轻量 schema 索引。
- `svcopilot://schemas/{tool}`：单个组合工具实际使用的紧凑输入 schema，例如 `svcopilot://schemas/sv_edit_phrase`；按工具拆分以避开客户端的大 resource 截断。

完整性来自通用 dispatcher：SynthV 对象会被登记为整数 handle，普通 JSON 数据直接内联。调用方可以沿对象 handle 遍历官方 API，而无需为每个方法新增 MCP 工具。`sv_root` 返回的根 handle 和已推断返回类型会被记录；对这些已知类型，`sv_call` 会在发往 SynthV 前校验方法、重载参数、handle 类型和官方文档中的最低版本要求。类型尚未知的 handle 仍交由宿主 dispatcher 执行，以保留通用遍历能力。

`sv_call.args` 和 `sv_run.steps[].args` 接受任意 JSON 值，并保留 number/string/boolean/object/array/null 类型。官方 API 要求数字索引时必须传 `[1]`，不能传 `["1"]`；handle 参数传 `{"__handle__": N, "__epoch__": E}`。

高层接口不替代原始 dispatcher，而是在它上面补充可验证语义：

- `sv_snapshot` 返回稳定字段、0-based 索引、显式单位和分页信息；`contextId` 只保存定位信息与指纹，不持久保存 Lua handle。project 快照每页最多消耗 16 个 `traversalItems`：有音符的 vocal group 按音符消耗，空组、乐器组和空轨也各消耗一项。`page.count` 是遍历预算消耗，`page.returned` 分别给出本页实际返回的 tracks/groups/notes 数量。调用方必须沿 `page.nextCursor` 读取到 `data.snapshotComplete: true`。selection 的 processing 只统计选中音符；空选区返回 `expectedNotes: 0` 和 `state: "not_applicable"`。
- `sv_set_lyrics` 在写入前重新定位目标并比较指纹，只写真正变化的字段；返回 `processedNotes`、`actuallyChangedNotes`，并在 verification evidence 中逐项给出请求过的歌词、音素和语言读回值。
- `sv_patch_notes` 以 `sv_snapshot` 返回的 `data.notes[].id` 定位音符，支持 `expected` 逐字段前置条件与 `dryRun` 预演。`atomic:true`（默认）表示已验证补偿而非 ACID：失败时逆序恢复日志旧值并读回确认，status 区分 `rolled_back`、`rollback_failed`、`partial` 和 `outcome_unknown`。attributes 是部分写，只设置并验证请求过的 key。
- `sv_snapshot_range` 在一个独占读取窗口内签发 occurrenceId、noteId、fingerprint 和可编辑 `contextId`。与范围半开区间相交的长音都会返回，即使 onset 位于范围起点之前。Automation 点也返回音乐坐标；独立数据预算溢出时返回 cursor，cursor 只分页已捕获的纯 JSON。全局最多采集 2,000 个音符、20,000 个 Automation 点和 20,000 个 computed-pitch 帧；单 group 每次 computed-pitch 请求最多 2,000 帧。`sinceToken` 仍需完整宿主读取与 hash；命中时返回新 `contextId`、`contextExpiresAt` 和 `page.detailCursor`，调用 cursor 可从内存取得匹配的新 occurrenceId/noteId，不再次读取宿主。
- `sv_wait_for_processing` 可直接复用 range context：显式 `occurrenceId` 优先；仅有一个 vocal occurrence 时可省略；多个候选返回带 `candidateOccurrences` 的 `AMBIGUOUS_CONTEXT`。只读预检校验 target UUID 并读取 live note count，不再逐 note 读取指纹。
- 参数曲线工具兼容原有 local/absolute BLICK，并支持精确小数/有理数拍点、范围边界、note 相对位置和相邻 note gap。语义输入会复核 meter map、目标 UUID、note fingerprint；同一 target 被多个 reference 复用时，mutation 必须显式确认。
- `sv_edit_phrase` 不调用 `NoteGroupReference.setTarget`：官方 API 规定已设置的 target 不可更改。音符或结构编辑在 detached clone 上完成预检；curve/voice-only 不 clone 整组，使用各自的 live journal preflight。共享 NoteGroup mutation 在 commit 时扫描整个工程并要求确认；voice 是 occurrence reference 状态，不受共享 target 确认约束。noteId 在任何 mutation 前一次性绑定到 handle；无实际 diff 返回 `no_change` 且不创建 Undo。`initialNoteCount`/`finalNoteCount` 始终表示完整 target group，`countScope` 为 `target_group`；verification phase 区分 `live_preflight`、`detached_preflight` 与 `commit_readback`。
- `sv_run` 支持 `#/roots/...`、`#/inputs/...`、`#/steps/<id>/result` 局部引用，最多 128 步，失败即停。只读断言步骤可用 `verifiesStep` 关联前面的 mutation，关联成功后不会产生 `UNVERIFIED_WRITE`。
- 每次 bridge 重连都会增加 epoch。带旧 `__epoch__` 的 handle 会在 Node 侧被拒绝，不能跨重连复用。

写工作流不是数据库事务。`before-and-after` 会调用两次 `project:newUndoRecord`，目标是让一次逻辑编辑通常形成一个用户撤销步骤；支持 atomic 的高层工具使用 journal 补偿并读回验证，仍可能如实返回 `rollback_failed` 或 `outcome_unknown`。原始 `sv_run` 不承诺通用自动回滚。

`sv_run` 的后续步骤必须使用完整 JSON Pointer 引用：

```json
{
  "mode": "read",
  "steps": [
    {"id":"track","op":"call","target":{"$ref":"#/roots/project"},"method":"getTrack","args":[1]},
    {"id":"name","op":"call","target":{"$ref":"#/steps/track/result"},"method":"getName","return":true}
  ]
}
```

`$track`、`$track.result` 和 `{"$ref":"track"}` 都不是有效语法。

`coverageAtLeast` 的报告会同时返回 `observedCoverage` 和 `requiredCoverage`。超过 32 项的断言观测只返回形状、数量、覆盖和数值范围摘要；一个 step result 同时设置 `return:true` 和直接 export 时，step 使用 `resultRef` 指向 exports，不重复内联大数组。

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

对象 handle 也能作为参数传回：

```text
sv_call { "method": "create", "args": ["Note"] }
  → { "__handle__": 8, ... }

sv_call {
  "handle": 7,
  "method": "addNote",
  "args": [{ "__handle__": 8 }]
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

预期：`14 passed, 0 failed`。

## 安全与约束

- SynthV 的 pipe 读取是阻塞的。Relay 必须为桥发送的每一帧立即回复 `command`、`noop`、`shutdown` 或 `error`；实现和测试都维护这一不变量。
- Relay 崩溃会使 Lua 读到 EOF 并退出；Relay 仍存活但停止响应时，SynthV UI 仍可能冻结。这是 stock Lua named pipe 无超时读取的固有限制。
- 当前队列最多 64 个调用，单帧最多 64 KiB，单调用默认超时 10 秒。
- handle 带连接 epoch，只适合短期使用；工程结构变化后也应重新读取，不要长期缓存。
- 快照是同一独占读取窗口内的 best-effort 视图，不是 SynthV 提供的原子工程快照。
- 官方 API 完全没有枚举已安装声库、可用 singer、当前 singer 身份或 singer 分配关系的方法；当前只能读取/写入公开的 voice 参数，能力资源会显式报告该缺口。
- 原始 dispatcher 暂无运行时反射或通用自动回滚；高层编辑工具提供各自的 dry-run、前置条件和已验证补偿。清单预检来自下载的官方文档而非宿主反射，类型未知 handle 的调用仍需调用方谨慎确认。

更完整的协议、故障模型和宿主验证清单见 [docs/architecture.md](docs/architecture.md)。

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
