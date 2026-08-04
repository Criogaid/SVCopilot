# SVCopilot 外部能力借鉴实施计划

## 0. 文档信息

- 状态：**整份计划未完成，无里程碑达到发布条件。** 已实施：Phase 1、Phase 2、Phase 7A
  （均离线验证通过，各自的发布条件仍未满足）。未开始：Phase 3–6、7B（`capability-blocked`）、
  Phase 8（`deferred`）。Phase 0 仅只读部分完成。逐 Phase 状态见 §0.1，DoD 台账见 §0.2。
- 日期：2026-07-30
- 当前基线分支：`feat/mcp-interaction-efficiency`
- 起始基线提交：`b1d08cc`
- Phase 1 完成提交：`8ceb242`
- Phase 2 完成提交：`e69f2d1`
- Phase 7A 完成提交：`23cb603`
- 研究样本：[zhoupengjie/synthv-agent-bridge](https://github.com/zhoupengjie/synthv-agent-bridge)，提交 `c6d1569a`
- 调查报告：[external-bridge-comparison.md](external-bridge-comparison.md)
- 文档性质：可直接用于后续 GOAL 执行的主实施计划

### 0.1 实施进度

整份计划**未完成**。§13 Definition of Done 要求 Phase 0–8 的必须项全部完成，或明确标注
`deferred`/`capability-blocked`。下表给出每个 Phase 的实施状态与阻塞资源；
§0.2 是逐条 DoD 台账。**当前没有任何里程碑（M1/M2/M3）达到发布条件。**

阻塞资源只有三种，且都不是我能自己提供的：

- `host-gate`：需要在真实 Synthesizer V 2.2.1 里对一次性 fixture 执行会改变宿主状态的写测。
- `live-perf`：需要真实宿主上的固定 373-note Group 做性能测量。测量脚本与门禁判定已就绪
  （`npm run bench:live-bulk`，见 §0.3），缺的只是有人在 SynthV 2.2.1 前面跑一次。
- `independent-llm`：需要一个未读本仓库文档的独立模型会话；自评不算证据。

| Phase | 状态 | 阻塞 | 证据 |
|---|---|---|---|
| Phase 0 | 部分完成（只读能力协商已冻结；Retake/NoteGroup clone/时间轴/音素 merge-replace/`loadfile()` 等写语义未采集） | `host-gate` | `test/fixtures/host-profiles/synthv-2.2.1-win32-readonly-v1.json` |
| Phase 1 | 已实施，离线通过；**发布条件未满足**（测量脚手架已就绪，缺真机数据） | `live-perf` | `1ab451e`、`f63191b`、`dea3fda`、`74996c2`、`8ceb242`；脚手架 `9b8639b` |
| Phase 2 | 已实施，离线通过；**发布条件未满足** | `independent-llm` | `e69f2d1`，`compact-facade.test.mjs` 17/17，`tools/list` 4,551 B |
| Phase 3（Retake） | 未开始 — `capability-blocked` | `host-gate` | — |
| Phase 4（NoteGroup library/reference） | 未开始 — `capability-blocked` | `host-gate` | — |
| Phase 5（时间轴） | 未开始 — `capability-blocked` | `host-gate` | — |
| Phase 6（音素 / Track·Mixer） | 未开始 — `capability-blocked` | `host-gate` | — |
| Phase 7A（只读 Doctor） | 已实施，离线通过 | — | `23cb603`，`doctor.test.mjs` 15/15 |
| Phase 7B（hot reload） | 未开始 — `capability-blocked` | `host-gate`（`loadfile()` 与脚本生命周期） | — |
| Phase 8（SidePanel 审核） | 未开始 — `deferred` | 无外部阻塞；按 §12 里程碑排在 M3，核心能力稳定前不实施 | — |

Phase 3–7B 标为 `capability-blocked` 而非 `deferred`：它们不是被优先级推后，而是被 §7
Phase 0 的门禁明确禁止——「未确认的写入语义不得进入 Phase 3–6 的正式 commit 路径」。
Phase 8 标为 `deferred`：它没有能力阻塞，只是里程碑顺序在后。

### 0.2 Definition of Done 台账

对 §13 的 13 项逐条核对。**7 项未满足**，因此整份计划的 DoD 未达成。

| # | DoD 项 | 状态 |
|---:|---|---|
| 1 | 所有 Phase 必须项完成，或标注 deferred/capability-blocked | **满足**（标注见 §0.1；实施本身未完成） |
| 2 | 无文件 IPC 核心回退 | 满足（`transport.js` 仅作历史参考，未被 `index.js` 导入） |
| 3 | 新增能力全部 0-based 高层契约 | 满足（native index 只存在于桥内部） |
| 4 | bulk read 在真实 373-note Group 有可重复性能证据 | **未满足** — `live-perf`；测量脚手架已就绪（§0.3），缺真机数据 |
| 5 | compact-v2 metadata 达标并完成独立 LLM 测试 | **部分** — 字节达标（4,551 B < 10 KiB），LLM 测试未做（`independent-llm`） |
| 6 | Retake 不虚构 active/untracked identity | **未满足** — Phase 3 未开始 |
| 7 | isolated Group clone 经实机证明不影响 source | **未满足** — Phase 4 未开始 |
| 8 | time-axis 写入具有 fingerprint、单 Undo 和回读 | **未满足** — Phase 5 未开始 |
| 9 | 逐音素属性使用现有补偿事务 | **未满足** — Phase 6A 未开始 |
| 10 | 所有写入失败路径具有明确 effects/outcome/retry 语义 | 对**已实施**的写工具满足；未实施的 Phase 3–6 写工具不适用 |
| 11 | 全量测试、MCP smoke、Lua tests 和 Live Probe checklist 通过 | **部分** — 前三项通过（622/622、smoke、42/42×2）；Live Probe checklist 未完成（`host-gate`） |
| 12 | README consumer 文档只描述已发布能力 | 满足（compact-v2 与 Doctor 均在 `docs/`/`HANDOFF.md` 标注实验性与未测项，未写入 README 作为已发布能力） |
| 13 | 外部代码复用满足 Apache-2.0 notices | 满足（未复制外部代码，仅借鉴设计；无需更新 `THIRD_PARTY_NOTICES.md`） |

Phase 2 离线证据：

- `tools/list` minified：`full` 131,255 B → `compact-v2` 4,551 B（7 个工具），门禁 10 KiB。
- operation schema 与 direct tool schema 为同一对象引用（引用相等断言）。
- facade 与 direct 两条路径在同一业务失败上 `structuredContent` 深度相等。
- 内层未知字段仍被 direct tool 严格 schema 拒绝；跨组调用报 `UNKNOWN_OPERATION`。
- `full` profile 工具清单与 schema 无变化；facade 工具不泄漏进 `full`。

Phase 2 未完成项（唯一）：

- §7 Phase 2 的「LLM 可用性验收」：需要一个未读仓库文档的独立模型只凭 MCP 自描述完成
  那 10 项任务并与 direct profile 对照。**不能自评**，因此默认 profile 保持 `full`。

Phase 1 离线证据：

- `npm test` 590/590（新增 `note-fingerprint-reader` 12 项、`bulk-note-reads-benchmark` 2 项、
  relay 能力协商 2 项、diagnostics 2 项、note-patch 批量 2 项）。
- Lua dispatcher 42/42，对 loaded 与 staging 两个脚本各跑通。
- 真实 Windows named pipe E2E 覆盖批量 op、0-based 转换、stale UUID、越界索引与拒绝后锁步存活。
- `npm run smoke:mcp` 通过。
- 离线基准（**模拟宿主，非真机**）host call：A 22→15，B 82→27，C 82→27，D 2012→414；
  dry-run 两条路径均 0 setter、0 Undo。

Phase 1 未完成项（唯一）：

- 真机性能验收。计划要求固定 373-note Group、预热后每组 20 次、记录 wall/service 的
  p50/p95。当前只有模拟宿主对照，**不得据此宣称 Phase 1 发布条件已满足**。

测量脚手架已就绪（`9b8639b`），但**脚手架不是证据**：

- `tools/bench-live-bulk-reads.mjs`（`npm run bench:live-bulk`）：定位 ≥373 音符的 group、
  预热 3 次、每场景 20 次、A/B/C/D 四场景各跑 legacy 与 bulk 两臂，输出
  `evidenceScope: "live_host"` 的可归档报告。legacy 对照臂是**同一宿主**上在 lease 上屏蔽
  bulk 能力，而不是改 relay——改 relay 会让桥端也走另一条路，那就不是同一个对照。
  全程 `dryRun`，每次运行后断言 `status: "dry_run"` 与 `effects: "none"`，否则中止。
- `test/live-bulk-perf-gates.test.mjs`（13 项，进 `npm test`）：门禁判定是纯函数，离线覆盖
  每条门禁的通过与失败两侧。因为那份报告将是 Phase 1 唯一的发布证据，而我无法自己跑真机：
  判定逻辑有 bug 而产出的 PASS 比没有报告更危险，它会让"发布条件已满足"有了看似客观的出处。
  已覆盖的假 PASS 场景：空报告或缺场景、86→84 的边际下降、p50 改善但 p95 回归、
  两臂都静默回退到逐 getter（此时"没有回归"只是因为跑的是同一条路）。

运行者需要提供的只有：SynthV 2.2.1 + 一个含 ≥373 音符单一 NoteGroup 的工程 + 已加载当前
`StartSynthVCopilot.lua`。桥未宣告 `read_note_fingerprints_v1` 时脚本直接报错退出，
不产出只有 legacy 一侧的"性能报告"。

## 1. GOAL 目标陈述

在不破坏 SVCopilot 现有 IO PIPE、0-based 高层坐标、Artifact/PlanRef、音乐语义分析和补偿事务的前提下，完成以下升级：

1. 将高频 note/context 读取从多次 PIPE 往返收敛为有界的宿主侧批量读取。
2. 提供实验性紧凑 MCP facade，将默认工具元数据降到可控范围，同时保留现有强类型工具。
3. 补齐 Retake、NoteGroup Library/Reference、时间轴、逐音素属性及 Track/Mixer 的安全高层能力。
4. 增加只读 Doctor 和安全热重载基础。
5. 在核心能力稳定后，提供可选的 SynthV 原生 SidePanel 人类审核流程。

最终结果不是复制 `synthv-agent-bridge`，而是把其高价值设计迁移到 SVCopilot 已验证的架构中。

## 2. 最终用户价值

完成后，Agent 应能：

- 用更少的宿主调用读取和验证大 Group 中的局部音符。
- 在较小的 MCP 工具元数据成本下发现并调用完整工作流。
- 生成、激活和删除自己创建的 Retake。
- 创建 linked 或真正 isolated 的 NoteGroup Reference。
- 安全编辑速度和拍号。
- 类型化编辑音素集、音节时值和逐音素属性。
- 管理轨道名称、颜色、混音器及 Render Panel 状态。
- 从 Doctor 输出快速定位 Node/Lua/PIPE/API 版本错配。
- 可选地在 SynthV 原生 SidePanel 中审核并确认计划。

## 3. 不可破坏的约束

### 3.1 传输

- 保留 Windows IO PIPE。
- 不引入文件 IPC 作为核心命令通道。
- 保留 typed-v2、aggregate allocation budget、深度限制和 64 KiB frame 保护。
- 新批量原语必须进行能力协商；旧 Lua bridge 不得收到未知 opcode 后进入不确定状态。

### 3.2 索引与坐标

- 高层 API 继续使用 0-based index。
- Native Lua index 只存在于 bridge 内部。
- BLICK、秒、bar/beat、group-local 和 absolute 坐标必须继续显式标注。
- 不允许因为参考项目使用 1-based 而改变现有契约。

### 3.3 写入诚实性

- 预检失败：`effects:"none"`，0 Undo。
- 写入成功：必须有宿主回读验证。
- 可补偿失败：必须报告 `rolled_back` 或 `rollback_failed`。
- 宿主断开/超时：必须报告 `outcome_unknown`，不得自动重试。
- processing observation 失败不得污染已经验证成功的 mutation。
- 不以“用户可以手动 Undo”为理由移除现有自动补偿。

### 3.4 Context、Plan 和 Artifact

- Context 只保存定位和并发保护所需数据。
- Plan capsule 只保存实际依赖的 fingerprint。
- Artifact 必须继续分页、hash 校验和幂等释放。
- host epoch 变化必须使全部 handle、context 和 host-bound plan 失效。
- 新 Guard/Ref 设计应复用现有 stores，不建立功能重叠的第二套缓存。

### 3.5 音乐语义

- `br`、`+`、`-`、`'` 等特殊歌词继续使用共享分类和 continuation state。
- 合法空音素不得被重新标记为 processing pending。
- Retake、音素属性和 UI 操作不得绕过现有特殊歌词与 context guard。
- 模型不能把宿主不可观察信息包装成推断事实。

### 3.6 仓库保护

- 不删除或清理 `.serena`、`.codegraph`、`.codex`。
- 不改写或清理用户的 `.gitignore`。
- `docs/`、`api-docs/` 和本地 HANDOFF 资料继续留在本地，不主动加入 Git。
- 不删除用户未跟踪文件。
- 暂存和提交必须使用显式文件路径。

## 4. 明确不做

- 不迁移到文件 IPC。
- 不把外部 8,000 行 Lua 执行器整体复制进项目。
- 不将高层索引改为 1-based。
- 不用一个开放的 `Array<unknown>` 通用 batch 替代严格协议。
- 不在当前计划中实现音频渲染；官方 API 仍无可靠 audio bytes/offline render primitive。
- 不声称能够读取已安装 singer catalog 或当前 singer identity。
- 不默认开放剪贴板写入和阻塞式宿主对话框。
- 不实现缺少补偿与回读的任意跨域事务。
- 不用 UI 自动化模拟 Undo、渲染、Singer 选择或 Voice Panel 操作。

## 5. 当前基线

### 5.1 已有能力

- 41 个 MCP 工具。
- `full/core/music/raw` 工具 profile。
- 官方 API catalog 和 raw dispatcher。
- Range Snapshot、Artifact、PlanRef、Dense Codec。
- Note/Phrase/Curve/PitchControl 域事务。
- Computed Pitch 比较与 bake。
- 音乐分析、和声、量化、歌词对齐和音高表情规划。
- Audition auto-stop、恢复和 A/B compare。
- Live Probe、fake host profile 和 Lua dispatcher 测试。

### 5.2 元数据基线

计划起草时的基线（`b1d08cc`，41 个工具），保留作为对照：

| Profile | 工具数 | Minified bytes |
|---|---:|---:|
| `full` | 41 | 130,735 |
| `core` | 14 | 35,350 |
| `music` | 34 | 124,075 |
| `raw` | 8 | 7,088 |

Phase 2 + Phase 7A 之后的实测（`23cb603`，42 个工具——新增 `sv_doctor`）：

| Profile | 工具数 | Minified bytes |
|---|---:|---:|
| `full` | 42 | 131,255 |
| `core` | 15 | 35,870 |
| `music` | 35 | 124,595 |
| `raw` | 9 | 7,608 |
| `compact-v2` | 7 | 4,551 |

### 5.3 Note Patch 实机基线

373-note Group，7 个分散 scoped patch，dry-run：

- wall：183 ms
- `serviceTotalMs`：177 ms
- host calls：86
- `fingerprintVerificationMs`：122 ms
- 每个目标音符：1 次 `getNote`、8 次 fingerprint getter、1 次 `$free`

该基线是 Phase 1 的主要性能对照。

## 6. 目标架构

```text
LLM / MCP Client
       |
       | direct tools 或 compact facade
       v
MCP schema + strict operation router
       |
       v
现有 domain services / planners / transaction kernels
       |
       | HostSession + capability-negotiated internal op
       v
IO PIPE transport
       |
       v
Lua bridge
  - generic root/call/index/free
  - bounded bulk read primitives
  - no artistic planning
       |
       v
SynthV public scripting API
```

核心规则：

- Facade 不实现业务逻辑。
- Service 不直接了解 MCP facade。
- Lua bulk op 只执行机械读取或已完整规划的有界批处理。
- 音乐意图、事务计划和错误语义仍由 Node domain service 所有。

## 7. 分阶段实施

### Phase 0：证据与协议冻结

#### 目标

在改协议前收集真实宿主语义，并冻结新增 internal op 和高层服务的边界。

#### 工作项

1. 新增本计划对应的 host acceptance checklist。
2. 用 Live Probe 采集：
   - `RetakeList.generateTake/setActiveTake/deleteTake/getNumTakes`；
   - `Project.addNoteGroup/removeNoteGroup` 的返回值；
   - `NoteGroup.clone()` 的 UUID 和隔离语义；
   - `NoteGroupReference.clone()` 的 target 共享语义；
   - tempo/meter mark 的增删与边界；
   - Note attributes 中 phoneset、syllable 和 phoneme array 的 merge/replace；
   - Track clone 对 non-main Group 的共享行为；
   - Lua `loadfile()` 与脚本生命周期。
3. 将去标识化证据加入 host profile fixture。
4. 为每个宿主语义标记：
   - `confirmed`
   - `version-dependent`
   - `unobservable`
   - `unsupported`
5. 记录外部 Apache-2.0 来源；若后续复制代码，更新 `THIRD_PARTY_NOTICES.md`。

#### 门禁

- 未确认的写入语义不得进入 Phase 3–6 的正式 commit 路径。
- Phase 1 的只读 bulk op 可在 Retake 等写入语义尚未确认时先实施。

#### 交付物

- Live Probe HANDOFF。
- 更新后的 fake host profile。
- Internal op ADR。
- capability matrix。

### Phase 1：有界宿主批量读取

#### 目标

减少 `sv_patch_notes`、`sv_restructure_notes` 和 context preflight 的 PIPE 往返，不改变公开 MCP 契约。

#### Internal op v1

建议名称：

```text
read_note_fingerprints_v1
```

请求：

```json
{
  "op": "read_note_fingerprints_v1",
  "trackIndex": 0,
  "groupReferenceIndex": 0,
  "expectedGroupUuid": "...",
  "noteIndicesInGroup": [0, 62, 124],
  "fields": [
    "indexInGroup",
    "onsetBlick",
    "durationBlick",
    "pitch",
    "lyrics",
    "phonemesOverride",
    "languageOverride",
    "detuneCents"
  ],
  "resultFormat": "typed-v2"
}
```

响应：

```json
{
  "groupUuid": "...",
  "noteCount": 373,
  "items": [
    {
      "noteIndexInGroup": 0,
      "fingerprint": {
        "indexInGroup": 0,
        "onsetBlick": 0,
        "durationBlick": 352800000,
        "pitch": 60,
        "lyrics": "你",
        "phonemesOverride": "",
        "languageOverride": "mandarin",
        "detuneCents": 0
      }
    }
  ]
}
```

#### Lua 约束

- 最多 200 个 note index。
- index 必须唯一、0-based 入参，Lua 内部转换为 native index。
- fields 必须来自固定 allowlist。
- 整批先校验 Group UUID 和 index 范围。
- 任一 note 读取失败则整批失败。
- 不返回 handle。
- 不注册长期 Lua 对象。
- 不产生 Undo。
- 不调用 setter。
- 预估响应超出 frame budget 时，在读取前返回结构化 `FRAME_TOO_LARGE`。

#### Node 侧工作

1. `HostSession` 增加 capability negotiation。
2. transport 支持 internal op，但不暴露到 `sv_call`。
3. 新增 `readNoteFingerprints()` adapter：
   - 新 bridge 走 bulk；
   - 旧 bridge 走现有逐调用路径；
   - 两条路径输出同一 normalized model。
4. 接入：
   - range `resolveContextTarget`
   - `sv_patch_notes`
   - `sv_restructure_notes`
   - `sv_edit_phrase` 非结构预检
5. diagnostics 增加：
   - `bulkHostCalls`
   - `bulkNotes`
   - `bulkFields`
   - `fallbackUsed`
   - 不记录歌词或音素内容

#### 测试

- Lua dispatcher 单元测试。
- Windows PIPE E2E。
- 1/7/200 note。
- 重复 index。
- 越界 index。
- stale Group UUID。
- getter 中途抛错。
- 64 KiB 边界。
- typed-v2 特殊数值。
- epoch/reconnect。
- 新旧 bridge fallback。
- bulk 与 legacy 输出深度相等。

#### 实机验收

固定 373-note Group，预热后每组 20 次：

- A：1 scoped patch。
- B：前 7 个。
- C：7 个分散。
- D：200 个 dry-run。

记录：

- wall p50/p95；
- service p50/p95；
- host-call count；
- bulk op count；
- read bytes/result bytes；
- setter/Undo count。

不预先承诺绝对毫秒目标。发布要求：

- B 的 host-call count 显著低于 86；
- p50 和 p95 均不得回归；
- dry-run 继续 0 setter、0 Undo；
- stale/expected mismatch 行为不变。

#### 推荐提交

1. Lua internal op + harness。
2. Node adapter + fallback。
3. note/context services migration。
4. diagnostics + benchmark。

### Phase 2：实验性 Compact MCP Facade

#### 目标

在不删除现有工具的前提下，将实验性 MCP profile 的默认 metadata 控制在 10 KiB 内。

#### 建议工具

```text
sv_status
sv_describe_operation
sv_read
sv_plan
sv_edit
sv_delete
sv_audition
sv_artifact
```

实施偏差：`sv_delete` 未创建。当前 41 个工具里没有独立的删除工具——
`sv_restructure_notes` 的 delete 是混合 patch 的一种 op，`sv_release_artifact` 释放的是
本进程 artifact 而不触及工程。为一个空 enum 造工具只增加元数据不增加能力，
等 Phase 4 出现 `sv_delete_note_group` 等真正的删除工具时再加。

#### 路由原则

- 每个 facade tool 只接受 `operation`、严格 envelope 和有界 payload。
- Operation catalog 由现有工具 schema 自动生成，不能维护第二份手写 schema。
- `sv_describe_operation` 返回单个或少量 operation schema。
- 每个 operation 映射到现有 handler/service。
- 不允许 facade 绕过：
  - `planRef`
  - context guard
  - shared-target confirmation
  - dry-run
  - responseMode
  - Artifact projection
- delete operation 只能进入 `sv_delete`。
- raw dispatcher 不进入 compact profile；需要时使用现有 `raw` profile。

#### 建议模块

```text
server/src/operation-catalog.js
server/src/compact-facade.js
server/src/operation-schema-resource.js
test/compact-facade.test.mjs
```

#### Profile 策略

- `full/core/music/raw` 保留。
- 新增 `compact-v2`。
- 默认 profile 是否切换，由独立 LLM usability test 决定。
- 开发阶段不承诺兼容旧 facade 名称，但 direct tools 行为不能被意外改变。

#### 测试

- catalog 中每个 operation 恰好映射一个现有 handler。
- schema 与 direct tool schema 同源。
- 未知 operation 在 handler 入口前失败。
- nested unknown fields 失败。
- destructive operation 不能走 read/edit。
- direct 与 facade 结果 canonical JSON 等价。
- Artifact/PlanRef URI 不变化。
- `tools/list` minified bytes `< 10 KiB`。

#### LLM 可用性验收

使用一个未读取仓库文档的独立模型，只提供 MCP 自描述，完成：

1. range snapshot；
2. note dry-run；
3. phrase edit；
4. parameter batch；
5. pitch gesture plan/apply；
6. lyric alignment；
7. audition start/stop；
8. artifact page/release；
9. expected mismatch 恢复；
10. shared-target confirmation。

记录：

- 首次 schema 成功率；
- 额外 describe 调用数；
- 错误重试数；
- 输入/输出 token；
- direct profile 对照。

#### 推荐提交

1. catalog/schema generation。
2. facade/router。
3. compact-v2 profile。
4. usability fixtures 与报告。

### Phase 3：Retake 高层能力

#### 目标

提供诚实、受保护、可追踪的 Retake 生命周期。

#### 工具草案

```text
sv_get_note_retakes
sv_patch_note_retakes
```

`sv_patch_note_retakes.action`：

- `generate`
- `activate`
- `delete`

#### 身份模型

- target：`contextId + occurrenceId + noteId/noteIndexInGroup`
- guard：note fingerprint + group UUID
- Bridge 只追踪自己生成的 Take ID
- namespaced script data：`svcopilot.retakes.v1`

#### 契约

- `getNumTakes` 只表示数量。
- 不返回伪造的全部 Take ID。
- 不返回伪造的 active Take ID。
- `activate` 只允许 default `0` 或 tracked ID。
- `delete` 只允许 tracked 且非 default ID。
- generate 的 duration/pitch/timbre 开关至少一个为 true。

#### 事务

- 每个 mutation 一个 Undo。
- 写前验证 note fingerprint。
- generate 后验证 take count 增加和 returned ID 被记录。
- delete 后验证 take count 减少和 tracked ID 被移除。
- active Take 不可读时，`activate` 的 verification 必须明确为 `host_acknowledged_unobservable`，不得伪装成 read-back verified。
- host timeout 返回 `outcome_unknown`。

#### Snapshot

`sv_snapshot_range include:["retakes"]` 返回：

- `takeCount`
- `trackedTakeIds`
- `activeTakeId:"unobservable"`
- `identityCoverage:"bridge_tracked_only"`

#### 实机验收

- generate duration-only/pitch-only/timbre-only/all。
- activate default/tracked/untracked。
- delete tracked/default/untracked。
- bridge reload 后 tracked IDs 恢复。
- note delete/clone 后 script data 行为。
- Undo 行为。

### Phase 4：NoteGroup Library 与 Reference

#### 目标

补齐可复用 Group 和 linked/isolated occurrence 的安全管理，并解决 clone 共享 target 的长期缺口。

#### 工具草案

```text
sv_list_note_groups
sv_create_note_group
sv_clone_note_group
sv_patch_group_reference
sv_delete_note_group
sv_delete_group_reference
```

#### 模式

- `linked`：新 Reference 指向原 target。
- `isolated`：`NoteGroup.clone()`，加入 library，再创建 Reference。
- `main`：主 Group 特殊身份，不作为普通 library group 删除。

#### 事务与身份

- library group fingerprint。
- reference fingerprint。
- track fingerprint。
- target Group UUID。
- shared occurrence list。
- create/clone/delete 后重读 Project library 和 Track。

#### 删除门禁

- 删除 NoteGroup 前必须返回引用数量。
- 有引用时要求 `confirmDeleteReferencedGroup:true`。
- 删除最后 Track、main Group 或不受支持对象必须拒绝。
- 结构变更后旧 project/range contexts 失效。

#### Isolated clone 验收

- source/clone UUID 不同。
- source/clone note fingerprints 初始一致。
- 修改 clone 后 source 不变。
- voice、timeOffset、pitchOffset、mute、timeRange 回读一致。
- linked clone 必须报告共享 target 和所有 occurrence。

#### 与 Track Clone 的关系

完成 isolated Group clone 后，重构 `sv_clone_track_from_template`：

- `cloneMode:"linked"|"isolated"`
- 默认不虚构隔离。
- isolated 模式逐一克隆 non-main Group target。
- 任何 Group 无法隔离时整次预检失败或补偿，不生成半隔离轨道。

### Phase 5：时间轴安全事务

#### 目标

提供 tempo/meter map 的 dry-run、冲突保护、单 Undo 和回读验证。

#### 工具草案

```text
sv_get_time_axis
sv_patch_time_axis
```

#### Patch

- tempo：add/update/delete。
- meter：add/update/delete。
- 使用调用方 0-based measure。
- 支持 musical/seconds/BLICK read-only conversion。
- 不允许同一请求产生重复位置。

#### Fingerprint

至少包含：

- 所有 tempo marks；
- 所有 meter marks；
- host/project epoch；
- canonical ordering。

#### 失效规则

成功 mutation 后失效：

- range context；
- musical anchor plan；
- computed pitch sampling context；
- audition range plan；
- harmony/quantize plan。

不绑定时间轴的 raw handles 仍按 epoch 生命周期处理。

#### 实机验收

- tempo/meter 各自 add/update/delete。
- occupied-position replace。
- bar/beat/BLICK roundtrip。
- stale fingerprint 0 写入。
- host silently ignores mutation 时 postcondition failure。
- rollback 恢复完整 map。

### Phase 6：类型化音素与 Track/Mixer

#### 6A：类型化音素属性

扩展现有 `sv_patch_notes` 和 `sv_edit_phrase`，不建立独立事务内核。

新增 schema：

- `phonesetOverride`
- `evenSyllableDuration`
- `phonemeAttributes`
- per-phoneme expected/set

要求：

- read-merge-write-full；
- 支持 merge/replace 两类宿主行为；
- 全字段回读；
- float32 tolerance；
- 合法空值与删除语义明确；
- 写后可选等待 computedAttributes。

#### 6B：Track/Mixer

工具草案：

```text
sv_create_track
sv_patch_track
sv_patch_mixer
sv_delete_track
```

字段：

- name
- displayColor
- render/bounced flag
- gainDecibel
- pan
- mute
- solo

要求：

- track fingerprint；
- displayColor 支持明确的 RGB/ARGB 规范化；
- audition 的临时 solo 状态与永久 mixer mutation 不得共用恢复记录；
- no-op 0 Undo；
- delete 前确认非最后 Track。

### Phase 7：Doctor 与安全热重载

#### 目标

减少版本错配、staging/loaded Lua 不一致和旧进程误判。

#### Doctor

新增只读命令或工具：

```text
npm run doctor
sv_status
```

实施偏差：工具名为 `sv_doctor`，不是 `sv_status`——后者已被 compact facade 的分组占用。
CLI 与 MCP 工具共用 `server/src/doctor.js` 的同一个 `collectDoctorReport`，不维护两套结论。

已实施的检查（其余项见下方"未实施"）：

- Node version；
- MCP server version；
- loaded/staging Lua interface version；
- Lua file hash；
- PIPE paths；
- current connection epoch；
- API manifest version；
- tool profile；
- artifact/context counts；
- Live Probe 状态（已提交 host profile 的语义状态计数）；
- 已协商 internal op（连上却无 op 时报 warning，因为批量读取会静默回退）。

未实施：

- 「常见配置路径」扫描。需要先定义哪些路径算"常见"，且扫描用户目录与 Doctor 的
  只读/不回显边界需要单独设计；当前只报告本服务器实际使用的 pipe 与脚本路径。

Doctor 的诚实性边界（有测试守住）：只读、不连接宿主（proxy 断言不触碰宿主调用入口）、
宿主未连接时 `hostVersion` 为 `null` 而非猜测值、脚本缺失报 `not_found` 并列出查找路径、
loaded/staging 哈希不同不判错（接口标记一致时报 `differs_in_text_only` 并指明只有
`dispatcher_test.lua` 能证明 dispatcher 行为一致）、不回显脚本内容或环境变量值、
退出码只受 error 级 finding 影响。

#### Hot Reload

**未实施。** 只有 Phase 0 确认 `loadfile()` 与脚本生命周期可行后才实施；
取得那份证据前不动这一项。计划步骤：

1. 验证 staging script。
2. 请求旧 bridge load 新脚本。
3. Node 等待旧连接断开并完成新桥的 v2 握手。
4. epoch +1。
5. 清空 handles、contexts、plans 和 host-bound artifacts。
6. 返回 reload evidence。

失败时：

- 不重启 SynthV。
- 不覆盖旧脚本的运行状态。
- 返回手动 Rescan/Restart 指引。

### Phase 8：可选 SidePanel 审核

#### 目标

为不熟悉 MCP 的用户提供 SynthV 内部预览和确认入口。

#### 状态机

```text
queued
  -> claimed
  -> awaiting_confirmation
  -> applying
  -> succeeded | failed | stale | dismissed | cancelled
```

#### 安全边界

- SidePanel 不直接调用工程 setter。
- Preview payload 只保存在 Node。
- Panel 只显示脱敏摘要。
- Apply 命令只包含 `planId + decision`。
- Node 重新校验 plan、context 和 epoch 后调用现有 service。
- 一次只允许一个 pending preview。
- applying 后 Cancel 不得谎称取消宿主写入。
- SidePanel 不调用 AI API，不打开网络端口。

#### 传输

优先顺序：

1. 独立 control pipe；
2. 如果 SynthV SidePanel 生命周期无法稳定持有 pipe，再评估最小文件 sideband；
3. 即使使用 sideband，也不得替代核心 IO PIPE。

#### 发布前测试

- Apply/Dismiss/Cancel。
- stale preview。
- Node/MCP 断线。
- SynthV restart。
- applying 中用户取消。
- history 脱敏。
- text overflow 和多语言 UI。

## 8. 横向测试矩阵

| 层 | 必测内容 |
|---|---|
| Pure unit | schema、normalization、fingerprint、projection、router |
| Fake host | merge/replace、ignored setter、float32、host lies、rollback |
| Lua harness | internal op、typed-v2、frame/depth/allocation、reload |
| PIPE E2E | real Lua dispatcher over Windows named pipe |
| MCP smoke | tools/list、resource、schema、handler route |
| Live Probe | 所有新增官方 API 宿主语义和性能 |
| LLM black-box | 只凭 MCP 自描述完成典型任务 |
| Regression | 全量 Node tests、MCP smoke、api-docs 无漂移 |

所有新增写工具必须包含：

- happy path；
- dry-run；
- no-change；
- stale context；
- expected mismatch；
- shared target；
- setter throws；
- read-back mismatch；
- rollback throws；
- host timeout；
- epoch changes；
- response budget。

## 9. 错误与重试语义

统一使用现有错误族，并按需增加：

```text
UNSUPPORTED_HOST_CAPABILITY
UNKNOWN_OPERATION
UNKNOWN_RETAKE_ID
STALE_RETAKE
STALE_LIBRARY_GROUP
STALE_GROUP_REFERENCE
STALE_TIME_AXIS
SELECTION_MISMATCH
HOST_UI_PERMISSION_REQUIRED
BRIDGE_RELOAD_FAILED
```

重试规则：

- `INVALID_ARGUMENTS`：修改请求，不重试原请求。
- `STALE_*`：重新读取、重新规划。
- `UNKNOWN_CONTEXT`：重新 snapshot。
- `HOST_TIMEOUT` / `DETACHED`：先读取实际状态，禁止盲目重试写入。
- `rolled_back`：可在重新读取后重试。
- `rollback_failed`：停止并交给用户检查。
- `processing_observation_failed`：写入已验证，不得重试 mutation。

## 10. 性能与预算

### MCP metadata

- `compact-v2 tools/list < 10 KiB`。
- operation schema 单次默认只返回 1 个。
- schema resource 超过 16 KiB 时必须分页或按 operation 拆分。

### PIPE

- 单 frame 继续受 64 KiB 限制。
- bulk op 必须在读取前估算上限。
- 大数组使用 typed-v2/dense 规范，不返回重复 handle。

### Artifact

- 默认页 8 KiB。
- canonical `resourceUri` 对大 Artifact 不返回不可解析的完整正文。
- 继续统计 issued/firstRead/pageReads/bytesReturned/releasedWithoutRead。

### Benchmark

每个关键场景预热后运行 20 次，报告：

- median；
- p95；
- wall；
- service；
- coordinator queue；
- host method count；
- transport bytes。

禁止仅用一次最快结果宣称性能完成。

## 11. 推荐提交切分

每个提交只处理一个可验证边界：

1. `Add host-profile evidence for borrowed SynthV capabilities`
2. `Add bounded note-fingerprint bulk read opcode`
3. `Route scoped note preflight through bulk reads`
4. `Add compact workflow operation catalog`
5. `Expose experimental compact-v2 MCP facade`
6. `Add guarded Retake lifecycle`
7. `Add NoteGroup library and reference transactions`
8. `Add verified time-axis patching`
9. `Type phoneme-level note attributes`
10. `Add guarded track and mixer editing`
11. `Add read-only installation doctor`
12. `Add epoch-safe bridge hot reload`
13. `Add optional native review SidePanel`

每个提交前：

- targeted tests；
- full `npm test`；
- `npm run smoke:mcp`；
- Lua dispatcher tests；
- `git diff --check`；
- `api-docs` 无时间戳漂移；
- 显式检查暂存区。

## 12. 里程碑

**当前没有任何里程碑达到发布条件。** 逐条状态见下；总体台账在 §0.2。

### M1：Performance RC

包含：

- Phase 0；
- Phase 1；
- Phase 2 实验性 profile。

发布条件：

- bulk 实机性能通过 — **未满足**（`live-perf`；`npm run bench:live-bulk` 已可一键测量并判定）；
- direct tools 无回归 — 满足（`npm test` 622/622，`full` profile 清单与 schema 无意外变化）；
- compact facade LLM usability 有结果 — **未满足**（`independent-llm`）；
- 不要求 Retake 等新写能力 — 不适用。

### M2：Official API Coverage RC

包含：

- Phase 3；
- Phase 4；
- Phase 5；
- Phase 6。

发布条件（四个 Phase 均未开始，因此三条全部**未满足**）：

- 所有新增写语义经 Live Probe — **未满足**（`host-gate`）；
- host profile 已更新 — **未满足**（当前 profile 只含只读语义）；
- clone isolation、Retake honesty、time-axis invalidation 通过 — **未满足**。

### M3：Operations and Review RC

包含：

- Phase 7；
- Phase 8。

发布条件：

- doctor 可定位版本错配 — 满足（`23cb603`：PROTO_VERSION 与声明 opcode 漂移各有 finding，
  loaded/staging 分别判定）；
- reload 不保留 stale context — **未满足**（Phase 7B 未实施，`host-gate`）；
- SidePanel 不能绕过 Node/service/PIPE 执行链 — **未满足**（Phase 8 未实施，`deferred`）。

## 13. Definition of Done

整份计划完成需要同时满足：

1. 所有 Phase 的必须项完成，或明确标注 deferred/capability-blocked。
2. 无文件 IPC 核心回退。
3. 新增能力全部使用 0-based 高层契约。
4. bulk read 在真实 373-note Group 中有可重复性能证据。
5. compact-v2 metadata 达标并完成独立 LLM 测试。
6. Retake 不虚构 active/untracked identity。
7. isolated Group clone 经实机证明不影响 source。
8. time-axis 写入具有 fingerprint、单 Undo 和回读。
9. 逐音素属性使用现有补偿事务。
10. 所有写入失败路径具有明确 effects/outcome/retry 语义。
11. 全量测试、MCP smoke、Lua tests 和 Live Probe checklist 通过。
12. README consumer 文档只描述已发布能力，不提前宣传计划项。
13. 外部代码复用满足 Apache-2.0 notices。

## 14. 必须停止并上报的条件

遇到以下任一情况，不得自行弱化契约继续：

- bulk op 无法在 64 KiB 内给出可靠上限；
- Lua batch 中途失败只能返回可能错位的部分结果；
- Retake active state无法观察，却需求要求“已验证激活”；
- NoteGroup clone 在目标宿主无法形成隔离 UUID；
- time-axis setter 的边界/返回值无法用 Live Probe 确认；
- Note attributes 无法同时兼容 merge/replace 宿主；
- hot reload 无法可靠完成新握手并递增 epoch；
- SidePanel API 迫使 UI 直接执行 mutation；
- generic transaction 不能建立补偿日志；
- 需要删除 `.serena`、`.codegraph`、`.codex`、本地 docs 或修改用户 `.gitignore` 才能继续；
- 发现与当前工作区重叠且无法安全合并的用户改动。

## 15. 每轮 GOAL 进度格式

```markdown
## 本轮目标

## 已完成

## 证据
- Targeted tests:
- Full tests:
- MCP smoke:
- Lua:
- Live Probe:
- Performance:

## 契约变化

## 工作区
- Branch:
- Commit:
- Tracked changes:
- Preserved local files:

## 未完成

## 阻塞或风险

## 下一轮唯一目标
```

每轮只允许一个主要实施目标。不得在同一轮顺手混入另一个 Phase 的写能力。
