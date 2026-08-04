# SVCopilot MCP 双向交互效率优化实施计划

## 0. 文档信息

| 字段 | 内容 |
| --- | --- |
| 状态 | 已完成迁移的历史实施记录（rev 3） |
| 日期 | 2026-07-30 |
| 基线版本 | SVCopilot `0.9.0` |
| 实施原则 | 高速迭代，不保留未发布契约的兼容层 |
| 首要目标 | 同时降低 LLM→MCP 请求、MCP→LLM 响应和其它运行边界的重复载荷 |
| 排序原则 | 已实测收益 ÷ 改动风险；便宜且独立的收益不排在最难的重构之后 |
| 不可削弱 | SV2 目标定位、音乐语义、live preflight、事务、验证、回滚和 Undo 语义 |

本文是独立实施计划。旧 Token/Artifact PRD 只作为历史材料，不构成本计划的兼容约束。

> 本文记录 `0.9.0` 基线上的迁移目标、当时的目标态与实施顺序。当前公开行为以
> [架构说明](../architecture.md)、MCP 自描述、实现和测试为准；正文中保留的未来时态、阶段门槛
> 与 Definition of Done 用于解释迁移决策，不构成 `0.10.0` 的并行接口契约或未完成路线图。

rev 2 的改动依据是对当前 `0.9.0` 代码的直接测量（见第 1.5 节），不是估算。凡本文出现具体
数值门槛，必须标明它是「实测值」「由 fixture 派生」还是「待测」；不允许再出现手写常量冒充
精确算术。

本文第 3、4、9、10 章定义改造完成后唯一允许的外部形状。同一对象在本文中只允许出现一种字段
命名与嵌套；任何两处不一致都按第 10 章为准，并视为本文缺陷而非实现自由度。

`docs/` 现已纳入版本控制，用于保存人工可读契约；机器可执行的 `SurfaceIoPolicy`、schema
门禁和匿名化 fixture 仍必须位于源码或测试目录，不能只靠文档声明。`.serena`、`.codegraph`
和 `.codex` 继续是本地工具状态，不属于项目文档。

## 1. 问题与证据

### 1.1 当前优化只覆盖了半条链路

当前实现已经显著压缩 MCP 向 LLM 返回的数据：

- compact tool facade 减少 `tools/list`；
- `responseMode:"compact"` 减少主响应；
- Artifact 把大型明细移出主路径；
- PlanRef 避免模型回传完整执行计划；
- Dense Codec 压缩曲线点阵。

但 LLM 向 MCP 发送的 Planner 请求仍会重复生成大量长身份和字段名。实际
`sv_plan_expression` 请求在一个 373 音符的 occurrence 上包含：

- 数十次完整 `noteId`；
- 同一 `contextId + occurrenceId` 前缀重复出现在每个 Note 引用中；
- 同一乐句范围为 loudness、tension、breathiness 分别重复；
- 多个 vibrato 重复完全相同的参数；
- 失败重试时再次生成完整请求。

工具调用参数属于模型输出，因此消耗 output tokens；进入对话历史后还会继续消耗后续
input tokens。JSON/HTTP/MCP 不会自动按重复字符串去重。

### 1.2 Artifact 分页也重复身份

当前每个 Artifact 页面 URI 同时包含：

- artifact UUID；
- SHA-256；
- Base64URL cursor；
- cursor 内再次编码 artifact UUID、SHA-256、view 和 offset；
- HMAC；
- `byteBudget`。

例如连续页面实际只改变 offset，但模型需要反复生成大段相同 URI。8 KiB 默认页会让
188 KiB Artifact 产生约 23 次同类请求。

### 1.3 Context TTL 放大失败成本

当前 Snapshot Context 默认约 5 分钟。实际流程在读取大型 Artifact、分析并生成大型
Planner 请求后触发：

```json
{
  "code": "UNKNOWN_CONTEXT",
  "message": "contextId not found or expired; re-run sv_snapshot_range"
}
```

失败发生在模型已经支付完整请求 output tokens 之后。随后重新快照、重新分析和重新生成
请求，会把成本进一步放大。

### 1.4 必须覆盖的全部方向

本计划不把"请求变短"等同于"系统完成优化"。所有模型可见和运行时边界都必须纳入：

| 方向 | 当前主要载荷 | 目标 |
| --- | --- | --- |
| MCP metadata → LLM | tools/list、description、inputSchema | 单一 facade，按需描述 operation |
| LLM → MCP | tool name、operation、arguments、Resource URI | 短身份、grouped input、短 Artifact read |
| MCP → LLM | success、error、warning、diff、evidence | compact-first、短身份、detail 按需 |
| LLM → MCP → LLM | 失败重试、重复 schema/detail 读取 | 明确下一步、幂等引用、避免重建大请求 |
| Node MCP → Lua bridge | 高频 getter/setter、typed-v2 frame | 有界 bulk op，只按实测增加 |
| Lua bridge → Node MCP | 大数组、handle、错误 | typed-v2、有界 frame、批量纯数据 |
| 服务内部 | Context、Artifact、Plan capsule | 完整身份仅留内部，不重复序列化 |

任何只优化其中一个方向、却把相同数据转移到另一个方向的方案，都不算完成。

### 1.5 实测基线（`0.9.0`，`tools/measure-surface-bytes.mjs`）

以下数值由脚本对当前代码直接测得，不是估算。它们决定第 12 章的实施顺序。

| 指标 | 实测值 | 说明 |
| --- | ---: | --- |
| direct `tools/list` minified bytes | 129,242 | 42 个 direct tool |
| catalog operation 数 | 37 | 42 − 5 个未登记 facade 的 raw dispatcher |
| 全部 operation `inputSchema` 合计 | 87,903 | 与 `tools/list` 高度重叠 |
| 最大单个 `inputSchema` | 10,610 | `patch_parameter_curves` |
| 次大 | 10,469 | `edit_phrase` |
| 第三 | 8,888 | `patch_parameter_curve`（单数，是复数的严格子集） |
| 最大 4 个 schema 合计 + 信封 | 37,378 | 超 16 KiB 门禁 2.3 倍 |
| 16 KiB 内最多容纳（按最大优先） | **1 个 operation** | 「一次 describe 4 个」当前不可行 |
| `content[0].text` 对 `structuredContent` 的重复 | **精确 2 倍** | `mcp-result-encoder.js` 把完整 payload 写入两处 |

三条由此得到的结论，直接改变了实施顺序：

1. **响应重复是最便宜的大头。** 每个 tool result 的 wire bytes 精确是 payload 的两倍，改动
   集中在 `server/src/mcp-result-encoder.js` 一个文件。它必须是第一个提交，而不是排在
   identity 重构之后。
2. **schema 体积本身没有消失，只是换了付款时机。** 把 129 KB 的 `tools/list` 收敛成 8 个
   facade 是真实收益，但 87,903 bytes 的 schema 底盘原样搬到了 `sv_describe`。一个用到
   6–8 个 operation 的工作流会重新付 20–40 KB。因此本计划新增「schema `$defs` 去重」目标
   （第 2.1 节第 18 条），否则 surface 收敛只是把成本挪了位置。
3. **`sv_raw` 不是可选装饰。** 5 个 raw dispatcher 当前被 compact facade 显式排除
   （`operation-catalog.js` 的 `excluded`）。没有 `sv_raw`，从 42-tool 全量 surface 迁到
   8-tool surface 时它们无处可去。递归 `$h` codec 可以砍（见第 2.2 节），`sv_raw` facade
   本身不能砍。

### 1.6 profile 与 facade 是两层，不是同一个东西

本文多处同时提到「删除 profile」和「保留 facade」，二者必须区分：

- **profile** 是*选择机制*：`SV_COPILOT_TOOL_PROFILE` 环境变量 + `server/src/tool-profile.js`
  的 `Map<名字, 工具名数组>`，决定 `tools/list` 返回哪一组工具。当前注册了 `full`(42)、
  `core`(15)、`music`(35)、`raw`(9)、`compact-v2`(8)。
- **facade** 是*被选中的那组工具本身*：`server/src/compact-facade.js` 生成的
  `sv_read` / `sv_plan` / … 加 schema discovery 工具，每个接 `{operation, arguments}` 后
  路由回原 handler。

当前接线是不对称的：`compact-v2` 走 `compactFacade.tools`（全新构造的对象），其余四个走
`filterToolsByProfile(...)`（从 `TOOLS` 里筛子集）。`registerToolProfile(COMPACT_PROFILE, …)`
只是为了让 `isToolEnabled` 能查到名字，实际列表并不经过 filter 路径——compact-v2 是硬塞进
profile 框架的特例，不是它的第 5 个正常成员。

本计划删除的是**整个 profile 选择层**（四个 profile、环境变量、`tool-profile.js` 文件、以及
`compact-v2` 这个名字）；保留并转正的是 **facade 产出的工具**。落地表现为
`index.js` 中的三元表达式塌缩成一行赋值。

## 2. 目标与非目标

### 2.1 目标

1. 所有 range-scoped MCP 输入只传一次 `contextId`。
2. occurrence 使用 Context 内的 0-based ordinal，不再传完整 `occurrenceId`。
3. Note 使用 NoteGroup 内的 0-based index，不再传完整 `noteId`。
4. 同范围多参数 expression 合并为一个语义对象。
5. 同类型且共享参数的 Note gesture 支持批量表达。
6. Planner normalization 将紧凑输入一次性展开为现有内部规范模型。
7. Planner 输出、目标、Automation 点和 warning 与当前业务语义一致。
8. Artifact 分页改为短参数工具调用，不再让模型复制长 Resource URI。
9. 默认页面候选预算提高到 16 KiB，但按最终序列化响应动态收缩，完整读取时在 16 KiB 门禁内减少调用数。
10. Snapshot Context 默认 TTL 提高到 30 分钟，mutation 成功后仍立即失效。
11. MCP 只保留一个默认 facade，不再维护多套 profile。
12. 保留一个 raw facade 作为官方 SV2 API escape hatch。
13. 所有 operation 必须声明请求、响应、身份和 detail 策略。
14. 所有普通错误必须有体积上限，不能回显整个请求或完整大型 evidence。
15. tools/list、describe、tool call、tool result 和 Artifact read 分别建立 bytes/token 基线。
16. Node↔Lua 只在真实 host-call 数据证明必要时增加 bulk op，不用 MCP token 优化冒充宿主优化。
17. SnapshotStore 与 ArtifactStore 都有显式字节配额，TTL 延长不得换来无界驻留内存。
18. 压低 schema 体积**底盘**，而不只是改变付款时机：共享片段提到 `sv_describe` 响应根的
    `$defs`，各 operation 用 `$ref` 指向；删除严格子集型 operation。目标是让「一次描述
    4 个 operation」真正落在 16 KiB 内（当前实测最坏 37,378 bytes）。
19. 每个量化门槛都必须可追溯到实测值或 fixture 派生值；不允许手写常量。

### 2.2 非目标

- 不改变 Synthesizer V Studio 2 官方 API 行为。
- 不降低 fingerprint 或 target UUID 校验。
- 不用 Note index 代替 live preflight。
- 不改变一个逻辑 mutation 对应一个 Undo 的边界。
- 不引入二进制 MCP 协议。
- 不为旧 `noteId`、旧 cursor、旧 profile 或 inline plan 保留兼容期。
- 不要求模型读取完整 Artifact 才能完成普通音乐工作流。
- **首版不实现 Raw 的递归 `$h` codec。** 直接身份槽位使用 `[handle, epoch]` tuple（简单、
  有效、已足够覆盖 root/call/index/free）。递归标签要处理 32 层深度、prototype pollution、
  `$h` 与普通宿主数据的歧义、tuple 槽位区分，属于最高实现风险换最低 token 收益——`sv_raw`
  是调用频率最低的 escape hatch。等真实出现 `getSelectedNotes()` 这类对象数组回送需求，
  再作为独立提案加入。
- **首版不实现 Artifact offset 分页替换。** 见第 4.1 节的重新评估。

### 2.3 全接口覆盖规则

建立唯一的 `SurfaceIoPolicy` 注册表。它不是第二套路由，只记录 operation、resource 和 bridge
边界的传输形状：

```js
{
  kind: "operation",
  operation: "plan_expression",
  requestShape: "range-scoped-grouped",
  responseShape: "summary-plan-ref",
  identityShape: "context-ordinal-note-index",
  detailShape: "artifact-optional",
  hostTraffic: "none"
}
```

允许的策略分类：

| 分类 | 适用接口 |
| --- | --- |
| `scalar-inline` | ping、doctor、轻量状态 |
| `bounded-inline` | API 搜索、描述、轻量读取 |
| `range-scoped` | snapshot 后的分析、等待和定位 |
| `range-scoped-grouped` | expression、pitch gesture、quantize、harmony |
| `mutation-plan-ref` | curves、notes、pitch controls、phrase edit |
| `artifact-summary` | snapshot、analysis、large diff |
| `raw-dispatch` | root/call/index/free/run |
| `editor-state` | selection、audition |

强制规则：

1. 每个 facade operation 必须且只能登记一次。
2. 新增 operation 未登记时服务器测试失败。
3. request schema 中出现长身份字段、开放大型对象或无界数组时测试失败。
4. response fixture 超预算且没有 Artifact/summary 策略时测试失败。
5. error fixture 回显原始大型请求时测试失败。
6. raw-dispatch 允许任意官方 API 参数，但 handle 继续使用短整数，不复制 Context 身份。
7. 每个静态 resource 和 resource template 也必须登记 request/response budget。
8. 每个 negotiated bridge opcode 必须登记 frame、item、field 和 allocation 上限。
9. registry 只用于审计和门禁，业务 handler 不读取它来决定语义。

## 3. 核心契约

### 3.1 Context-scoped identity

新的外部引用只在一个不可变 Snapshot Context 内有意义：

```json
{
  "contextId": "c_N7GgW3hQyWmVxA",
  "occurrence": 0
}
```

规则：

1. `occurrence` 是 `context.occurrences` 的 0-based ordinal，索引空间恒定为完整数组，不受
   "是否捕获到 Note"影响。
2. Context 只有一个 occurrence 时允许省略 `occurrence`。存在多个时省略即 `AMBIGUOUS_CONTEXT`，
   错误证据只返回候选 ordinal 数组。
3. 显式 ordinal 落在完整数组内但该 occurrence 未捕获 Note 时返回 `OCCURRENCE_NOT_CAPTURED`，
   不得退化成 Note 越界。
4. Snapshot 摘要必须返回 `occurrence`、`track`、`groupReference`、`groupNoteCount` 和
   `capturedNotes`（字段名与第 8.1 / 10.4 节示例一致；旧 rev 的
   `trackIndex`/`groupReferenceIndex` 拼写作废）。`targetGroupUuid` 只保留在 Context、Plan capsule 和按需 audit Artifact 内，
   不进入普通 compact 响应。
5. Context 内 occurrence 顺序不可变。
6. Context 不可用时统一返回 `UNKNOWN_CONTEXT`，并在 `error.reason` 中给出
   `unknown` / `expired` / `epoch_changed` / `invalidated_by_mutation` / `evicted_by_quota`
   （五项，与第 10.13 节一致）。不存在第二个 Context 失效错误码，ordinal 也绝不解析到新
   Context。要区分这五个 reason，SnapshotStore 必须保留**有界 tombstone**：登记 reason 与
   去内容化的 capture descriptor，带独立 TTL 和条数/字节配额。伪造的 Context ID 只能返回
   `reason:"unknown"`，不得声称可恢复。
7. mutation 仍按 Context 内保存的 target descriptor 和 fingerprint 检查实时宿主。
8. Context ID 使用 96-bit Base64URL 随机值，不再使用 UUID 文本。
9. LRU 只淘汰**非活跃** Context，因此 store 需要 pin / 引用计数：planner 解析 Context 期间
   另一个 snapshot 请求不得将其淘汰。
10. `bytes` 记账是**逻辑驻留字节**（canonical payload UTF-8 bytes + 固定索引开销），不是
    V8 heap 实测值。doctor 字段命名须体现这一点（如 `accountedBytes`），共享 fingerprint
    对象按对象身份只计一次。

### 3.2 Note reference

所有外部 Note 引用统一为 NoteGroup 内的 0-based index：

```json
{
  "note": 121
}
```

范围引用使用：

```json
{
  "from": 0,
  "to": 62
}
```

规则：

1. `note`、`from`、`to`、`notes[]` 都表示 `indexInGroup`，不是 range 返回位置。
2. schema 只接受非负 safe integer；`from <= to`。
3. 服务端根据已选 occurrence 建立 `indexInGroup -> fingerprint` Map。该 Map 可以是稀疏的，
   因为 range 可以只捕获乐句内的 Note；但 `include` 含 `notes` 时必须额外完成一次有界的
   group Note count 读取，供 `groupNoteCount` 与错误分类使用。
4. index 超过 `groupNoteCount - 1` 返回 `NOTE_INDEX_OUT_OF_RANGE`，证据给出 `max`。
5. index 合法但不在本 Context 捕获集合内返回 `NOTE_NOT_IN_CONTEXT`，证据只给出该 Context
   已捕获区间的有界摘要（最多 8 段 `[from,to]`），不枚举全部合法 index。两者不合并，
   因为前者靠重试不可能成功，后者需要重新捕获更宽的范围。
6. 同一请求不允许跨 occurrence。
7. compact 响应和错误证据返回 index，不返回完整内部 ID。

内部 Note 身份不再拼装字符串。normalization seam 直接传递 Context 内被冻结的 fingerprint
对象引用；`internalNoteId` 之类的并行长身份体系不引入，也不保留。

### 3.3 结构性编辑的 index 解析基准

`restructure_notes`、`generate_harmony` 的 apply、以及任何一次请求内包含 insert/delete/split/merge
的 operation，都必须遵守同一条规则：

1. 请求中出现的每个 index 一律相对 Context 快照解析，绝不相对同一请求内的中间状态。
2. `before: N` 表示"插入到快照 index N 之前"；`before` 等于 `groupNoteCount` 表示追加到末尾。
3. 服务端负责推导实际执行顺序与内部重编号；调用方永远不需要预测 index 漂移。
4. 同一请求内两个 op 不得指向同一 snapshot index（`split` + 对同一 Note 的 `delete` 属于冲突），
   违反时返回 `CONFLICTING_OPERATIONS`，证据只给出首个冲突 index 和冲突计数。
5. `merge` 的 `from`/`to` 区间必须在快照中连续，且不得与其它 op 区间相交。
6. 响应中的 diff 与 verification 证据同时给出 `note`（快照 index）和 `resultNote`
   （提交后的新 index），后者仅在提交路径出现。

### 3.4 Expression request

新 `plan_expression` 请求：

```json
{
  "contextId": "c_N7GgW3hQyWmVxA",
  "occurrence": 0,
  "defaults": {
    "vibrato": {
      "surface": "pitchDelta",
      "rateHz": 5.2,
      "onsetDelayQuarter": 0.22,
      "rampQuarter": 0.18,
      "fadeOutQuarter": 0.14
    },
    "scoop": {"lengthQuarter": 0.16, "shapePower": 2},
    "fall": {"lengthQuarter": 0.22, "shapePower": 2}
  },
  "gestures": [
    {
      "type": "hairpin",
      "from": 0,
      "to": 62,
      "peak": 0.72,
      "amounts": {"loudness": 1.2, "tension": 0.08, "breathiness": 0.12}
    },
    {"type": "vibrato", "notes": [62, 121, 178, 237, 296], "depthCents": 15},
    {"type": "vibrato", "notes": [314, 336], "depthCents": 18},
    {"type": "scoop", "targets": [[87, 22], [203, 24], [274, 18], [302, 28]]},
    {"type": "fall", "targets": [[157, 22], [273, 26], [372, 32]]}
  ],
  "constraints": {
    "maxAbsPitchDeltaCents": 80,
    "maxAbsLoudnessDeltaDb": 4.5,
    "maxAbsTensionDelta": 0.45,
    "maxAbsBreathinessDelta": 0.25,
    "maxTotalPoints": 1200,
    "avoidExcessiveVibrato": true
  },
  "sampling": {"pointsPerQuarter": 4, "vibratoPointsPerCycle": 8}
}
```

类型语义：

- `hairpin.amounts` 使用显式白名单字段和各自单位；
- `vibrato.notes` 共享同一组参数；
- `scoop.targets` 和 `fall.targets` 固定为 `[noteIndexInGroup, depthCents]`；
- `defaults` 只允许对应 gesture 类型已声明的可选字段；
- gesture 自身字段覆盖 defaults；
- 展开顺序固定为请求顺序、Note 顺序和参数白名单顺序；
- 展开后进入现有 constraints、sampling、merge 和 point-budget 逻辑。

不使用 Dense Codec 表达异构 gesture。首版采用小型、业务明确的 grouped schema，避免建立
第二个通用 DSL。

### 3.5 Planner normalization seam

新增一个小而稳定的纯数据 Module：

```js
resolveRangeScope({snapshotStore, contextId, occurrence})
  -> {stored, occurrence, noteByIndex, groupNoteCount}

resolveNoteIndex({scope, index, path}) -> frozen fingerprint reference

expandExpressionGestures({gestures, defaults, scope}) -> CanonicalExpressionGesture[]
```

职责：

1. 统一 Context/Occurrence/Note index 校验，统一产出第 10.13 节的错误形状。
2. 将外部紧凑引用解析为 Context 内被冻结的 fingerprint 对象引用。
3. 展开 grouped gesture。
4. 不访问宿主，不持有 handle，不执行 mutation。

`expression-plan.js`、`pitch-gesture-plan.js`、`lyric-align.js`、`quantize-plan.js`、
`harmony-plan.js` 和 range-scoped mutation 复用该 Module，并改为消费 fingerprint 引用。
`noteId` 字符串解析逻辑全部删除，不保留"内部仍拼一份"的过渡形态。

### 3.6 执行选项归属

PlanRef 执行请求只接受 `{planRef, action, confirmations}`。所有影响写入行为的选项
（`atomic`、`waitFor`、`timeoutMs`、`pollIntervalMs`、`undoLabel`）在 **planner 请求**中声明，
由 planner 校验后一并封存进 Plan Artifact：

```json
{
  "contextId": "c_N7GgW3hQyWmVxA",
  "gestures": [],
  "execution": {"atomic": true, "waitFor": "phonemes", "timeoutMs": 10000, "undoLabel": "expression"}
}
```

规则：

1. `execution` 的可用字段由目标 operation 决定，planner 在规划期就必须拒绝目标不支持的字段。
2. apply 阶段不得覆盖 `execution`，因此不存在"经 PlanRef 执行导致 `waitFor` 静默丢失"的路径。
3. `confirmations` 是唯一允许在 apply 阶段提供的运行期输入，因为共享目标确认必须在看到
   dry-run 结果之后才有意义。当前只有 `allowSharedTargetMutation` 一项。
4. `responseMode` 从所有外部 schema 删除；响应形状由第 4.4 节统一规定，不再由调用方选择。

## 4. Artifact 访问与响应信封重构

### 4.1 Artifact 分页：重新评估后降级

**首版不实现 offset 分页替换 cursor。** 理由是本文自己的门禁（第 14 章）写着「普通 compact
工作流 Artifact detail reads = 0」。如果正常路径确实不读 Artifact，那么整套分页改造优化的是
一条按设计应该为空的路径，却要付出最高的实现风险。

保留现状：`_encodeCursor` / `_decodeCursor`、HMAC cursor、Resource page template 继续存在，
不在本轮删除。它们不阻塞任何其它目标。

**本轮仍要做的 Artifact 相关改动**（属于正确性，不是分页优化）：

- Artifact ID 缩短为 `a_` + 96-bit Base64URL 随机值；
- `detail` / `apply` 引用携带各自的 `expiresAt`；
- PlanRef 改为裸 artifactId 字符串，目标校验完全在服务端完成。

等独立 LLM 验收产出「模型实际翻了几页」的数据后，再决定 offset 分页是否值得做。届时门禁
数字必须从真实 fixture 反推——旧 rev 手写的「12 页 / 13 页」在算术上不成立：`byteBudget`
上限 16384 与 `structuredContent` 上限 16384 相同，而 `text` 是 JSON 字符串，payload 里每个
引号都要转义，所以单页可用原始 bytes 必然显著小于 16384。

### 4.2 统一 Artifact facade

请求：

```json
{
  "operation": "read",
  "arguments": {"artifact": "a_Ld3o9v4Gm2Qx", "offset": 0}
}
```

中间页响应 `data`：

```json
{"nextOffset": 12288, "totalBytes": 188236, "text": "{\"notes\":["}
```

末页响应 `data`：

```json
{"nextOffset": null, "totalBytes": 188236, "contentHash": "sha256_9f31c0", "text": "]}"}
```

规则：

1. `offset` 默认 0，必须为非负 safe integer、不超过 `totalBytes`，并落在 UTF-8 码点边界。
2. `byteBudget` 可选，默认 16384，允许范围 8192 至 16384；它是原始片段的候选上限，不是返回长度承诺。
3. 响应不回显 `artifact`、`offset`、`byteBudget` 和 `bytesReturned`：调用方刚刚发送过前三项，
   第四项可由 `text` 推出。
4. `encoding` 恒为 `json-utf8-fragment`，只在 workflow guide 中声明一次，不进入每页响应。
5. `nextOffset:null` 表示完成；不额外返回 `complete` 布尔。
6. `contentHash` 只在末页返回，用于校验跨页重组结果。中间页不返回它。
7. 服务端用最终 `structuredContent` 的 minified UTF-8 bytes 计量 envelope；若候选片段会令响应
   超过 16 KiB，则向前收缩到同时满足响应门禁和 UTF-8 页尾边界的位置。
8. 因转义开销，实际片段可以明显小于 `byteBudget`；调用方只能沿用返回的 `nextOffset`，不能自行
   计算下一页。
9. `offset < totalBytes` 时每页必须至少推进一个完整码点；空片段基础 envelope 若已超过门禁，
   属于启动时 IO policy 配置错误，不能在运行时返回相同 `nextOffset`。
10. Artifact ID 改为 `a_` + 96-bit Base64URL 随机值。96-bit entropy 在进程内配额下足够抵抗枚举；
   ID 比较只用于查表，不建立任何"知道 ID 即跨实例授权"语义。
11. `release` 幂等：首次返回 `{"released": true}`，重复返回 `{"released": false}`，都不是错误。
12. 普通 Agent 不应为了确认计数而读取 detail。

### 4.3 PlanRef 简化

Planner 成功结果的 `apply` 是唯一交接形状：

```json
{
  "apply": {
    "operation": "patch_parameter_curves",
    "planRef": "a_Ld3o9v4Gm2Qx",
    "expiresAt": "2026-07-30T18:30:00.000Z"
  }
}
```

调用方逐字提交：

```json
{
  "operation": "patch_parameter_curves",
  "arguments": {"planRef": "a_Ld3o9v4Gm2Qx", "action": "dry_run"}
}
```

删除：

- `usePlanRef:false`；
- inline apply payload；
- `applyRequests` / `patchRequest` / `restructureRequest` 旧别名；
- PlanRef 中的 `resourceUri`、`firstPageUri`、`kind`、`targetOperation` 和每次回传的 `contentHash`；
- 执行请求中的 `dryRun` 布尔（只保留 `action`）。

`planRef` 是裸 artifactId 字符串。目标校验完全在服务端完成：ArtifactStore 按 artifactId、
实例归属、`kind === "plan"` 和 sealed `targetOperation` 解析，任何不匹配返回
`PLAN_TARGET_MISMATCH`。调用方无法通过 planRef 覆盖 sealed mutation、target、fingerprint
或 `execution` 选项。

Plan Artifact 自带足以恢复 live preflight 的有界 context capsule（target descriptor、
被引用的 fingerprints、shared-target occurrences）。因此原 Context 过期不影响已封存的计划，
执行器不再需要向 SnapshotStore 回写恢复快照：`snapshotStore.restore()` 与
`buildPlanContextSnapshot` 的写回路径一并删除，capsule 只从 artifact payload 单向读取。

执行器仍必须重新执行 target resolution、fingerprint preflight、shared-target 检查和读回验证。
PlanRef 永远不是跳过 live preflight 的凭据。

#### 4.3.1 Plan 执行 ledger（防重放）

Plan Artifact 不可变，因此**执行状态必须放在独立的、有配额的 ledger 中**，不修改 artifact
本身。没有 ledger 时同一个 `planRef` 可以被无限次 commit，而某些 mutation 会因此重复生效：
`mode:"add"` 的曲线补丁在 Note fingerprint 未变化时能再次通过 live preflight，从而重复叠加
Automation。

状态机：

```text
sealed → dry_run_seen → committing → committed | rolled_back | uncertain
```

规则：

1. `dry_run` 可重复执行，不推进终态。
2. 未经过 `dry_run` 的 `commit` 被拒绝（`PLAN_DRY_RUN_REQUIRED`）。这使第 5.3 节
   「PlanRef 只能 dry-run 后再 commit」成为服务端强制约束，而不是文档建议。
3. 任何 commit 写入尝试之后，同一 PlanRef 不得再次 commit（`PLAN_ALREADY_EXECUTED`）。
4. `uncertain`（对应 `outcome_unknown`）永久封禁该 PlanRef 的重放。
5. `rolled_back` 后也要求重新规划，不允许重放同一 payload——与第 4.5 节 `retryable` 语义一致。
6. ledger 与 Artifact 同租期、同实例隔离、同配额回收；不引入无界增长。

#### 4.3.2 统一 ScopeSource（capsule 与 Snapshot 的共同入口）

当前所有 mutation handler 直接从 SnapshotStore 读 Context；PlanRef 靠
`snapshotStore.restore()` 把 capsule 写回 store，再让原 handler 按普通 Context 执行。删除写回
路径是正确的，但**仅新增一个 `capsule` 参数不足以落地**——mutation 内部的 target resolution、
fingerprint lookup、shared-target 检查全都要能消费 capsule。

因此在迁移任何 planner/apply 配对**之前**，先定义统一内部接口：

```js
resolveMutationScope({
  source: {kind: "snapshot", stored} | {kind: "plan_capsule", capsule},
  occurrence,
})  // -> ResolvedRangeScope
```

planner 与 mutation 之后只消费同一个 `ResolvedRangeScope`，不再存在「一条路径读 store、
另一条读 capsule」的分叉。

capsule 内容按 operation 声明最小但完整的集合（`CAPSULE_REQUIREMENTS_BY_OPERATION`），
不能笼统只存「被引用的 Note fingerprints」。不同 operation 还可能需要：insert anchor 两侧
邻居 fingerprint、merge 区间内全部 Note、`groupNoteCount`、Automation 当前状态或前置条件、
`mode:"add"` 的防重复依据、voice parameters、GroupReference time offset、shared-target
occurrence 清单、pitch-control anchor/gap 邻接关系。

### 4.4 MCP 到 LLM 的统一响应纪律

统一信封（第 10.2 节给出完整定义）：

1. `structuredContent` 是唯一完整的 compact 结果。
2. `content[0].text` 只返回不超过 512 bytes 的单行状态摘要，不再复制完整对象。
   **当前实测每个 tool result 的 wire bytes 精确是 payload 的两倍**（`mcp-result-encoder.js`
   把完整 `JSON.stringify` 同时写入 `content[0].text` 和 `structuredContent`），因此这一条是
   全计划最便宜的收益，改动集中在一个文件。
3. 删除 `ok` 布尔：`status` 已经完全决定成败，MCP 传输层的 `isError` 决定客户端分支。
4. `warnings` 为空时整个字段省略，不返回 `[]`。
5. `timing` 只在请求 `diagnostics:true` 时返回；默认省略。
6. `detail` 不存在时整个字段省略，不返回 `detailRef:null`。
7. 响应不回显调用方刚刚发送的输入（contextId、occurrence、artifactId、offset、parameter 等），
   **除非该字段在 `SurfaceIoPolicy` 的 `allowedEchoes` 中显式登记为必要业务证据**。已知的
   合法回显见第 10.2 节；门禁按登记表校验，不做无上下文的全局字段相等比较。
8. compact success envelope 上限 16 KiB。
9. error envelope 上限 8 KiB。`encodeMcpError` 必须按 `errorMaxBytes` 校验，不得回落到
   success 的 16 KiB 预算。
10. 超预算的 items、diff、frames、candidate、evidence 和 rollback journal 进入 Artifact。
11. compact 输出中的 occurrence 和 Note 身份只使用 ordinal/index。
12. error 不回显完整 request、Plan、schema 或长 ID。
13. warning 同码合并并返回 `code`、`count`、首个位置和可选 `detail`。
14. 删除 `responseMode`：不再存在 `standard`/`verbose` 分支，完整 audit 只通过 Artifact 读取。
15. 所有结果 minified；`SV_COPILOT_DEBUG_PRETTY`、`SV_COPILOT_TEXT_FALLBACK` 与全部 pretty/
    完整 text 分支从正式 surface 删除。当前未发布版本只支持读取 `structuredContent` 的客户端。

### 4.5 status × effects × isError 完整矩阵

本节是唯一权威的结果状态集合。旧 rev 的八状态列表遗漏了 `partial` 和 `rollback_failed`——
它们在当前实现中真实存在（`note-structure.js`、`note-patch.js`、`parameter-curve.js`、
`pitch-control-patch.js`、`phrase-edit.js`、`chunked-mutation.js`），且是第 0 章「不可削弱」
明令保留的事务结论。契约若无法表达它们，实现就只能撒谎。

| status | effects | isError | 自动重试 | 含义 |
| --- | --- | ---: | ---: | --- |
| `succeeded` | `verified` | — | 否 | 写入完成并通过读回验证 |
| `no_change` | `none` | — | 否 | 同值写入，零 setter |
| `planned` | `none` | — | 否 | Planner 产出 PlanRef |
| `dry_run` | `none` | — | 否 | 零 setter、零 Undo |
| `conflict` | `none` | **true** | 重新快照后可 | live fingerprint 与 Context 不符，零写入 |
| `failed` | `none` | **true** | 按错误码 | 未开始写入即失败 |
| `rolled_back` | `reverted` | **true** | **否** | 补偿已读回验证成功 |
| `rollback_failed` | `may_remain` / `unknown` | **true** | **绝不** | 补偿未能证明恢复 |
| `partial` | `may_remain` | **true** | **绝不** | 非原子路径中途失败，部分写入残留 |
| `outcome_unknown` | `unknown` | **true** | **绝不** | 无法观测宿主最终状态 |

`isError` 的判据是「调用方要求的操作是否完成」，不是「是否需要人工恐慌」。旧 rev 给出的理由
——「`conflict` 与 `rolled_back` 是业务结论而非协议错误，客户端需要读到完整证据」——**不成立**：
`isError` 不影响 `structuredContent` 的传输，两种取值下客户端拿到的数据完全一样。因此该字段
应当如实反映「没做成」。

`retryable` 只表示**客户端可以原样自动重放同一请求**，不表示「人可以重新规划后再试」。
因此 `rolled_back` **不带** `retryable`：补偿成功后的正确动作是重新快照、重新规划，而不是
重放同一 payload。旧 rev 在 `rolled_back` 上标注 `retryable:true` 与紧随其后的硬规则
「`effects:"none"` 才允许自动重试」直接矛盾，本 rev 删除该标注。

processing 观察失败**不是**独立顶层 status：写入已验证成功时，顶层保持 `succeeded` /
`verified`，观察失败降级为嵌套 `processing:{status:"observation_failed"}` 加一条 warning
（见第 10.6 节）。当前代码里的顶层 `status:"processing_observation_failed"` 需要在迁移中
改为该形状。

### 4.6 Context 失效的触发条件

旧 rev 只写「mutation 成功后失效」，这是不安全的窄条件。正确规则是：

> **只要发生过宿主写入尝试，就不能继续信任相关 Context。**

因此 `partial`、`rollback_failed`、`outcome_unknown`、连接丢失、以及只完成部分 setter 的
故障路径都必须失效。即使 rollback 已读回验证成功，也应失效并要求重新捕获——宿主可能存在
未被 journal 覆盖的派生状态。

当前 `NoteStructureService.restructureNotes` 已在 `finally` 中按 `writeAttempted` 删除
Context，这一安全语义**不得在迁移中回退**。

失效策略按 operation 登记，不使用笼统的「mutation success」规则：

| 类别 | 失效范围 |
| --- | --- |
| dry-run / planner / 纯读取 | 不失效 |
| `no_change` 且零 setter | 不失效 |
| 任何 setter 已执行或 Undo 边界已开启 | 失效所有指向该 target 的 Context |
| `set_selection`、audition | 不按音乐 mutation 失效（editor state） |
| `clone_track` | 失效受工程结构变化影响的 Context，不只是单个 NoteGroup |

## 5. MCP Surface 收敛

### 5.1 只保留一个 profile

按第 1.6 节的区分：删除的是 **profile 选择层**，转正的是 **facade 产出的工具**。

删除：

- `full`、`core`、`music`、`raw` 四个 profile 注册；
- `compact-v2` 这个名称（facade 不再是「一种 profile」，而是唯一 surface）；
- `SV_COPILOT_TOOL_PROFILE` 环境变量；
- `server/src/tool-profile.js` 整个文件及其 import；
- `index.js` 中 `enabledTools` 的三元分支（塌缩为单一赋值）；
- `isToolEnabled(toolProfileName, …)` 调用，改为 facade 自身的成员检查；
- doctor / capabilities 中的 `toolProfile`、`compactActive`、`profile` 字段；
- 测试中的 profile 分支。

保留：`server/src/compact-facade.js` 及其产出的工具，以及
`server/src/operation-catalog.js` 的路由标签门禁（新增工具未登记时服务器启动即失败）。

默认工具共 8 个：

```text
sv_status
sv_read
sv_plan
sv_edit
sv_audition
sv_artifact
sv_raw
sv_describe
```

`sv_raw` 路由当前 `sv_root`、`sv_call`、`sv_index`、`sv_free` 和 `sv_run`，确保高层工具尚未
覆盖的官方 SV2 API 仍可访问。

`sv_describe` 是唯一不套 `{operation, arguments}` 信封的工具，它直接接受
`{"operations": [...]}`。原 `sv_describe_operation` 名称与原 `sv_describe`（官方 API 类描述，
现为 `sv_status` 的 `describe_api` operation）一并让位于此名，避免出现
`sv_describe_operation` 这种 21 字节且每次工具选择都要读一遍的工具名。

所有 operation 继续复用同一业务 schema、validator 和 handler，不复制第二套契约。

`tools/list` 中的 facade 只公开浅层调度 schema。以下是 `sv_read` 的完整形状；其它 facade 仅替换
`operation.enum`：

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["operation"],
  "properties": {
    "operation": {
      "type": "string",
      "enum": [
        "snapshot",
        "snapshot_range",
        "wait_processing",
        "get_parameter_curve",
        "get_voice_profile",
        "compare_computed_pitch",
        "analyze_phrase",
        "analyze_vocal_context",
        "style_profile",
        "check_prosody"
      ]
    },
    "arguments": {"type": "object", "additionalProperties": true},
    "diagnostics": {"type": "boolean"}
  }
}
```

`arguments` 是“所有公开对象 `additionalProperties:false`”的唯一 MCP 调度层例外。它不表示业务参数
开放：服务端选定 `operation` 后，必须立即用 OperationCatalog 中对应的严格 schema 做第二阶段校验，
该业务 schema 仍要求 `additionalProperties:false`。这样 `tools/list` 不复制每个 operation 的业务 schema，
而 `sv_describe` 仍能按需返回同一个机器契约。

### 5.2 Operation 命名

operation 名由工具名去掉 `sv_` 前缀机械派生的规则保留，但下列例外因为语义在 facade 分组中
已经明确而进一步缩短，删除冗余动词/后缀：

| 旧工具名 | operation |
| --- | --- |
| `sv_snapshot_range` | `snapshot_range` |
| `sv_wait_for_processing` | `wait_processing` |
| `sv_validate_lyrics_prosody` | `check_prosody` |
| `sv_clone_track_from_template` | `clone_track` |
| `sv_start_audition` / `sv_get_audition` / `sv_stop_audition` / `sv_restore_audition` | `start` / `get` / `stop` / `restore` |
| `sv_audition_compare` / `sv_get_audition_compare` / `sv_stop_audition_compare` | `compare` / `get_compare` / `stop_compare` |
| `sv_search_api` / `sv_describe` | `search_api` / `describe_api` |

`sv_audition` 分组内不再重复 `audition` 一词。其余 operation 保持机械派生名。

### 5.3 Tool description

`sv_describe` 对 range-scoped operation 必须明确：

- `occurrence` 是 Context 内 ordinal；
- `note/from/to/notes` 是 NoteGroup 的 0-based index；
- 结构性编辑的 index 一律相对快照解析；
- Planner 自动展开 grouped gesture；
- 写入选项在 planner 请求的 `execution` 中声明；
- 普通成功路径不读取 Artifact detail；
- PlanRef 只能 dry-run 后再由调用方明确 commit。

### 5.4 Schema 与指南读取

`sv_describe`：

- **一次最多描述 2 个 operation**（旧 rev 为 4）。实测最大 4 个 schema 合计 37,378 bytes，
  超 16 KiB 门禁 2.3 倍；按最大优先只装得下 1 个。在 `$defs` 去重落地并实测通过之前，
  上限为 2；去重后如实测支持，可提回 4。
- 响应根携带 `$defs`，各 operation 的 `inputSchema` 用 `$ref` 指向共享片段（见第 5.5 节）；
- 返回稳定 `schemaVersion` 和每项 `schemaHash`；
- 同一 MCP 实例内相同 operation 的 schemaHash 不变；
- 响应明确提示模型在当前会话复用已读 schema；
- schema 错误只返回 JSON Pointer、规则和简短修复建议，不返回完整 schema；
- workflow guide 只返回步骤和 operation 名，不复制 inputSchema。

独立 LLM 验收必须统计 schema/guide 的重复读取次数。相同 schema 在一次工作流中读取超过一次，
除非先前内容已被客户端截断，否则判为效率失败。该项属于独立 LLM 验收，不进入离线
`npm test` 矩阵。

### 5.5 Schema 体积去重

实测 37 个 operation 的 `inputSchema` 合计 87,903 bytes，其中大量是同一批片段的重复内联：

- `patch_parameter_curves` (10,610)、`patch_parameter_curve` (8,888)、
  `patch_pitch_controls` (6,955)、`get_parameter_curve` (5,960) 各自内联展开同一套
  `CURVE_POINTS_INPUT_SCHEMA` + `DENSE_TABLE_SCHEMA` + `CURVE_POSITION_SCHEMA`；
- `edit_phrase` (10,469) 内联了 `patch_notes` + `patch_parameter_curves` +
  `restructure_notes` 的子 schema。

措施：

1. **共享片段提取到 `$defs`。** `sv_describe` 响应根携带一份 `$defs`，各 operation 用
   `$ref` 引用。这只改变*我们自己的 discovery 契约*，不改变 `tools/list`（facade 的浅层
   schema 本就不含业务 schema），因此不依赖客户端解析 `$ref` 的能力。
2. **删除 `patch_parameter_curve`（单数）。** 它是 `patch_parameter_curves` 的严格子集
   —— `curves` 数组长度为 1 即等价 —— 却占全部 schema 的 **10.1%**，并且让模型每次都要判断
   「该调哪个」。删除后 operation 总数由 43 变为 42。
3. **operation 总数不得硬编码。** 从 `OperationCatalog` 派生，doctor、
   `svcopilot://operations`、第 10.14 节表格与覆盖门禁全部引用同一来源。旧 rev 把 43 写死在
   八处，任何一次合并/新增都要手工同步八个位置。

验收：`$defs` 去重后重测最大 2 个与最大 4 个 operation 的 describe 响应大小，写入第 14 章
门禁表（由 fixture 派生，不手写）。

## 6. Context 生命周期

修改 SnapshotStore：

- 默认 TTL：5 分钟改为 30 分钟；
- 最大 TTL：60 分钟；
- 响应返回 `expiresAt`；
- mutation 成功后立即失效相关 Context；
- bridge epoch 变化后立即失效；
- 新增 `maxEntries` 之外的字节配额：单 Context 上限与总驻留上限，超限时按 LRU 淘汰最旧的
  非活跃 Context 并在 doctor 中报告淘汰计数；
- Planner 只读使用不延长 TTL；
- mutation 始终基于 live fingerprint，而不是信任 Context 年龄。

TTL 从 5 分钟提高到 30 分钟意味着 64 个 373-note Context 可以长期共存，因此字节配额与
TTL 延长必须同一提交落地，并纳入第 14 章门禁。

不增加 keepalive 工具。长工作流不应为了维持 Context 产生额外 MCP 调用。

## 7. Node 与 Lua 边界

该边界不消耗 LLM token，但会决定一次高层调用需要多少 wall time 和 PIPE frame，因此必须单独测量。

规则：

1. 继续使用 typed-v2 和 64 KiB 有界 frame。
2. 已存在的 `read_note_fingerprints_v1` 保留。
3. 任何 N 个对象 × M 个 getter 的读路径必须进入 host-call inventory。
4. 在**同一读取阶段内**，同一对象同一 getter 不得重复调用。写后读回验证属于独立阶段，
   本规则不适用于它——验证必须重新读取宿主真实状态。
5. 新 bulk read 只能返回纯数据，不能返回 handle。
6. bulk read 必须有 item、field、frame 和 allocation 上限。
7. mutation 不因为 token 优化自动改成 bulk write。
8. bulk write 只有在事务、journal、验证和故障注入完成后才能引入。
9. diagnostics 只返回方法计数和耗时，不返回歌词、音素或用户内容。
10. MCP 请求 bytes、MCP 响应 bytes、PIPE bytes 和 host calls 分开报告。

每个高流量 operation 至少选择一个真实宿主场景，确认优化没有把 MCP 成本转移为更多 PIPE 往返。

## 8. 端到端目标示例

本节描述实施后的唯一正式契约，不是兼容示例。示例中的 ID、时间、歌词和统计数值均为占位；
最终 pointCount 等业务数值由 Phase 0 golden 和现有编译内核决定，不能把示例常量写成实现断言。
本文所有示例歌词一律使用占位字符，不得写入真实工程内容。

### 8.1 捕获范围

LLM → MCP：

```json
{
  "tool": "sv_read",
  "arguments": {
    "operation": "snapshot_range",
    "arguments": {
      "scope": {"kind": "range", "from": {"bar": 1}, "to": {"bar": 80}},
      "include": ["notes", "tempoMap", "meterMap"]
    }
  }
}
```

MCP → LLM `structuredContent`：

```json
{
  "status": "succeeded",
  "data": {
    "contextId": "c_N7GgW3hQyWmVxA",
    "expiresAt": "2026-07-30T18:30:00.000Z",
    "occurrences": [
      {
        "occurrence": 0,
        "track": 0,
        "groupReference": 0,
        "groupNoteCount": 373,
        "capturedNotes": 373
      }
    ],
    "detail": {
      "artifact": "a_Ld3o9v4Gm2Qx",
      "expiresAt": "2026-07-30T18:30:00.000Z",
      "totalBytes": 188236
    }
  }
}
```

主响应不包含 373 个 Note 对象，也不包含 occurrenceId/noteId。单 occurrence 时 `summary`
被省略，因为它只会重复 `occurrences[0]` 的计数。

### 8.2 生成表现计划

LLM → MCP：

```json
{
  "tool": "sv_plan",
  "arguments": {
    "operation": "plan_expression",
    "arguments": {
      "contextId": "c_N7GgW3hQyWmVxA",
      "defaults": {
        "vibrato": {
          "surface": "pitchDelta",
          "rateHz": 5.2,
          "onsetDelayQuarter": 0.22,
          "rampQuarter": 0.18,
          "fadeOutQuarter": 0.14
        }
      },
      "gestures": [
        {
          "type": "hairpin",
          "from": 0,
          "to": 62,
          "peak": 0.72,
          "amounts": {"loudness": 1.2, "tension": 0.08, "breathiness": 0.12}
        },
        {"type": "vibrato", "notes": [62, 121, 178, 237, 296], "depthCents": 15}
      ],
      "constraints": {"maxTotalPoints": 1200},
      "execution": {"atomic": true}
    }
  }
}
```

MCP → LLM `structuredContent`：

```json
{
  "status": "planned",
  "data": {
    "inputGroups": 2,
    "expandedGestures": 8,
    "parameters": ["loudness", "tension", "breathiness", "pitchDelta"],
    "totalPoints": 164,
    "apply": {
      "operation": "patch_parameter_curves",
      "planRef": "a_F8x2Qm4pV7Ks",
      "expiresAt": "2026-07-30T18:30:00.000Z"
    }
  }
}
```

Planner 不返回完整 curve points、fingerprints 或 inline mutation。`occurrence` 被省略是因为
该 Context 只有一个 occurrence。

### 8.3 执行 dry-run

LLM → MCP：

```json
{
  "tool": "sv_edit",
  "arguments": {
    "operation": "patch_parameter_curves",
    "arguments": {"planRef": "a_F8x2Qm4pV7Ks", "action": "dry_run"}
  }
}
```

MCP → LLM `structuredContent`：

```json
{
  "status": "dry_run",
  "effects": "none",
  "data": {"curves": 4, "points": 164, "occurrence": 0}
}
```

`verification`、`rollback`、`undo` 在 dry-run 路径全部省略：`status:"dry_run"` +
`effects:"none"` 已经蕴含"未尝试验证、未回滚、零 Undo 记录"。完整 planned diff 只在调用方
明确需要时进入 Artifact。

### 8.4 有界错误

越界输入：

```json
{
  "tool": "sv_plan",
  "arguments": {
    "operation": "plan_expression",
    "arguments": {
      "contextId": "c_N7GgW3hQyWmVxA",
      "gestures": [{"type": "vibrato", "notes": [999], "depthCents": 15}]
    }
  }
}
```

错误响应：

```json
{
  "status": "failed",
  "effects": "none",
  "error": {
    "code": "NOTE_INDEX_OUT_OF_RANGE",
    "path": "/gestures/0/notes/0",
    "got": 999,
    "max": 372
  }
}
```

合法但未捕获：

```json
{
  "status": "failed",
  "effects": "none",
  "error": {
    "code": "NOTE_NOT_IN_CONTEXT",
    "path": "/gestures/0/notes/0",
    "got": 200,
    "captured": [[0, 62], [121, 180]]
  }
}
```

错误不回显 Context 内容、完整请求或全部合法 Note 清单；`message` 在 code 已自解释时省略。

### 8.5 按需读取 Artifact

LLM → MCP：

```json
{
  "tool": "sv_artifact",
  "arguments": {"operation": "read", "arguments": {"artifact": "a_Ld3o9v4Gm2Qx", "offset": 0}}
}
```

MCP → LLM `structuredContent`：

```json
{
  "status": "succeeded",
  "data": {"nextOffset": 12288, "totalBytes": 188236, "text": "{\"notes\":["}
}
```

下一次调用只沿用响应给出的 `nextOffset`，不再生成长 URI、hash 或签名 cursor。调用方不能假设
每页固定前进 16384 bytes，因为服务端还要为 JSON 转义和响应信封预留预算。

### 8.6 Raw escape hatch

尚未被高层工具覆盖的官方 API：

```json
{
  "tool": "sv_raw",
  "arguments": {
    "operation": "call",
    "arguments": {"handle": [17, 3], "method": "getName"}
  }
}
```

Raw 的直接身份槽位（`handle`、`target`、`handles[]`）固定使用二元 tuple `[handle, epoch]`，
比 `{"handle":17,"epoch":3}` 少 22 字节，且在 `free` 的批量场景下差距成倍放大。任意嵌套值
（`args`、`result`、`steps`、`exports`）中的宿主对象使用递归标签：

```json
{"$h": [17, 3], "type": "Note"}
```

输入嵌套 handle 时 `type` 省略；输出时由服务端提供。`$h` 对象严格
`additionalProperties:false`，只能包含 `$h` 和可选 `type`。普通数组即使恰好有 2 或 3 项也保持
普通数组，不按 handle 解码。`$h` 是 Raw codec 保留键；递归值最大 32 层，并继续受 typed-v2
64 KiB frame 与各 operation 的 item 上限约束。超限在宿主调用前返回 `RAW_VALUE_LIMIT_EXCEEDED`。
`args` 为空时省略。任何跨 bridge epoch 的 handle 返回 `STALE_HANDLE`。raw 不接受 Context
短索引冒充宿主 handle。

### 8.7 Node 到 Lua 的内部批量读取

该 frame 不进入 LLM 上下文：

```json
{
  "id": 1043,
  "proto": 2,
  "op": "read_note_fingerprints_v1",
  "target": [21, 3],
  "expectedGroupUuid": "host-opaque-uuid",
  "indices": [0, 62, 121, 178, 237, 296],
  "fields": ["index", "onset", "duration", "pitch", "lyrics", "phonemes", "language", "detune"]
}
```

一次 bulk frame 代替每个 Note 的多次 getter，返回纯数据，不返回 handle。

## 9. 关键实现伪代码

本节展示建议实现结构。伪代码省略日志和错误包装，但不省略身份、边界和事务检查。

### 9.1 创建短 Context 和稳定 ordinal

```js
function createShortId(prefix) {
  // 96-bit 随机值；不把时间、用户内容或宿主身份编码进 ID。
  return `${prefix}_${randomBytes(12).toString("base64url")}`;
}

class SnapshotStore {
  create(snapshot) {
    const contextId = createShortId("c");
    const expiresAtMs = now() + this.ttlMs;

    // ordinal 恒定索引完整数组；未捕获 Note 的 occurrence 同样占位。
    const occurrences = snapshot.occurrences.map((item, occurrence) =>
      freeze({
        ...item,
        occurrence,
        groupNoteCount: item.groupNoteCount,
        capturedNotes: item.noteFingerprints.length,
        // fingerprint 保持冻结对象；不再派生任何长字符串身份。
        noteFingerprints: item.noteFingerprints.map(freeze),
      })
    );

    const stored = freeze({
      contextId,
      expiresAtMs,
      epoch: snapshot.epoch,
      bytes: estimateRetainedBytes(occurrences),
      context: {...snapshot, occurrences},
    });

    this._admit(stored);   // 字节配额 + LRU 淘汰
    return stored;
  }
}
```

Context ID 只在当前 MCP 实例内有效；bridge epoch 变化、mutation 成功、TTL 到期或字节配额
淘汰时删除，四种情况统一表现为 `UNKNOWN_CONTEXT` 加不同 `reason`。

### 9.2 统一解析 Context、occurrence 和 Note index

```js
function resolveRangeScope(store, request) {
  const stored = store.get(request.contextId);
  if (!stored) {
    throw error("UNKNOWN_CONTEXT", {reason: store.reasonFor(request.contextId)});
  }
  if (stored.epoch !== currentBridgeEpoch()) {
    store.invalidate(stored.contextId, "epoch_changed");
    throw error("UNKNOWN_CONTEXT", {reason: "epoch_changed"});
  }
  if (stored.context.kind !== "range") {
    throw error("INVALID_CONTEXT", {reason: "operation requires a range context"});
  }

  const all = stored.context.occurrences;
  let occurrence;

  if (request.occurrence !== undefined) {
    // ordinal 索引完整数组，与"是否捕获"无关。
    occurrence = all[request.occurrence];
    if (!occurrence) {
      throw error("OCCURRENCE_INDEX_OUT_OF_RANGE", {
        got: request.occurrence,
        max: all.length - 1,
      });
    }
  } else if (all.length === 1) {
    occurrence = all[0];
  } else {
    throw error("AMBIGUOUS_CONTEXT", {
      // 全部 ordinal，不按 capturedNotes 过滤：过滤后若全为空捕获会返回空数组，
      // 模型将拿不到任何下一步。§3.1 规则 2 要求返回候选 ordinal 数组。
      candidates: all.map((item) => item.occurrence),
    });
  }

  // 空捕获检查统一放在 occurrence 选定之后。
  // 旧 rev 只在显式 ordinal 分支检查，单 occurrence 省略路径会漏过，
  // 导致后续 resolveNoteIndex 返回 NOTE_NOT_IN_CONTEXT——正是 §3.1 规则 3 禁止的降级。
  if (occurrence.capturedNotes === 0) {
    throw error("OCCURRENCE_NOT_CAPTURED", {got: occurrence.occurrence});
  }

  const noteByIndex = new Map(
    occurrence.noteFingerprints.map((note) => [note.indexInGroup, note])
  );

  return {stored, occurrence, noteByIndex, groupNoteCount: occurrence.groupNoteCount};
}

function resolveNoteIndex(scope, index, path) {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw error("INVALID_ARGUMENTS", {path, rule: "non-negative integer"});
  }
  if (index >= scope.groupNoteCount) {
    // 该 index 在 NoteGroup 中根本不存在；重试同一请求永远不会成功。
    throw error("NOTE_INDEX_OUT_OF_RANGE", {path, got: index, max: scope.groupNoteCount - 1});
  }

  const note = scope.noteByIndex.get(index);
  if (!note) {
    // index 合法但本次 range 没捕获它；需要重新捕获更宽范围，与越界是不同的补救动作。
    throw error("NOTE_NOT_IN_CONTEXT", {
      path,
      got: index,
      captured: summarizeIndexRuns(scope.noteByIndex.keys(), {maxRuns: 8}),
    });
  }

  return note;   // 冻结的 fingerprint 引用，不是字符串 ID
}
```

`captured` 必须是有界的区间摘要（最多 8 段），不能把数百个合法 index 全部回显到错误响应。

### 9.3 展开 grouped expression

```js
const HAIRPIN_PARAMETER_ORDER = [
  "pitchDelta", "loudness", "tension", "breathiness", "voicing", "gender",
];

const DEFAULT_FIELDS_BY_TYPE = {
  vibrato: new Set(["surface", "rateHz", "onsetDelayQuarter", "rampQuarter", "fadeOutQuarter"]),
  scoop: new Set(["lengthQuarter", "shapePower"]),
  fall: new Set(["lengthQuarter", "shapePower"]),
};

function normalizeDefaults(rawDefaults) {
  assertRecordOrUndefined(rawDefaults, "/defaults");
  const result = {};

  for (const [type, values] of Object.entries(rawDefaults ?? {})) {
    const allowed = DEFAULT_FIELDS_BY_TYPE[type];
    if (!allowed) {
      throw error("INVALID_ARGUMENTS", {path: `/defaults/${type}`, rule: "known gesture type"});
    }
    assertKnownKeys(values, allowed, `/defaults/${type}`);
    result[type] = validateTypeSpecificFields(type, values);
  }

  return result;
}

function expandExpressionGestures({rawGestures, defaults, scope}) {
  const expanded = [];

  for (const [requestIndex, gesture] of rawGestures.entries()) {
    const path = `/gestures/${requestIndex}`;

    switch (gesture.type) {
      case "hairpin": {
        assertKnownKeys(gesture, ["type", "from", "to", "peak", "amounts"], path);
        const fromNote = resolveNoteIndex(scope, gesture.from, `${path}/from`);
        const toNote = resolveNoteIndex(scope, gesture.to, `${path}/to`);
        if (gesture.from > gesture.to) {
          throw error("INVALID_ARGUMENTS", {path: `${path}/to`, rule: "to >= from"});
        }
        const amounts = validateHairpinAmounts(gesture.amounts, `${path}/amounts`);

        for (const parameter of HAIRPIN_PARAMETER_ORDER) {
          if (!Object.hasOwn(amounts, parameter)) continue;
          expanded.push({
            // Canonical gesture 持有 fingerprint 引用，不再持有字符串 ID。
            type: "hairpin",
            fromNote,
            toNote,
            parameter,
            amount: amounts[parameter],
            peakPosition: gesture.peak,
            source: {requestIndex, parameter},
          });
        }
        break;
      }

      case "vibrato": {
        const common = mergeAllowlisted(defaults.vibrato, omit(gesture, ["type", "notes"]));
        for (const [notePosition, noteIndex] of gesture.notes.entries()) {
          expanded.push({
            type: "vibrato",
            note: resolveNoteIndex(scope, noteIndex, `${path}/notes/${notePosition}`),
            ...validateVibrato(common, path),
            source: {requestIndex, notePosition},
          });
        }
        break;
      }

      case "scoop":
      case "fall": {
        const common = mergeAllowlisted(
          defaults[gesture.type],
          omit(gesture, ["type", "targets"])
        );

        for (const [targetPosition, tuple] of gesture.targets.entries()) {
          assertTuple(tuple, 2, `${path}/targets/${targetPosition}`);
          const [noteIndex, depthCents] = tuple;
          expanded.push({
            type: gesture.type,
            note: resolveNoteIndex(scope, noteIndex, `${path}/targets/${targetPosition}/0`),
            depthCents: validateDepth(depthCents),
            ...validateScoopOrFall(gesture.type, common, path),
            source: {requestIndex, targetPosition},
          });
        }
        break;
      }

      default:
        throw error("INVALID_ARGUMENTS", {path: `${path}/type`, rule: "supported gesture type"});
    }
  }

  return expanded;
}
```

展开只做纯数据转换。现有 `instantiateHairpin`、`instantiateVibrato`、`instantiateScoop`、
`instantiateFall`、constraints 和 compiler 继续处理 Canonical gesture，唯一改动是它们从
fingerprint 引用而不是字符串 ID 取值。

### 9.4 结构性编辑的快照基准解析

排序规则不能只靠「按最大 snapshot index 降序」——**`insert` 没有 `snapshotTargets`**
（它不消费现有 Note），空数组上 `maxIndex()` 无定义，两个 `insert before 30` 的相对顺序
因而未定义。必须编译出显式的执行计划：

```js
function planRestructure(scope, operations) {
  const claimed = new Map();   // snapshot index -> requestIndex

  // 第一遍：全部 index 相对快照解析，并检测同一 Note 被两个 op 争用。
  const resolved = operations.map((op, requestIndex) => {
    const path = `/operations/${requestIndex}`;
    const consumed = snapshotIndicesConsumedBy(op, scope, path);  // split/delete/merge 的目标区间
    for (const index of consumed) {
      if (claimed.has(index)) {
        throw error("CONFLICTING_OPERATIONS", {
          path,
          note: index,
          conflicts: countConflicts(claimed, operations),
        });
      }
      claimed.set(index, requestIndex);
    }
    return {
      ...op,
      requestIndex,
      consumed,
      // insert 的排序键：(before, requestIndex)。consumed 为空的 op 靠 anchor 定位。
      anchor: op.op === "insert" ? op.before : maxIndex(consumed),
    };
  });

  // 第二遍：服务端推导执行顺序。规则有二，缺一不可：
  //   (a) 按 anchor 降序执行，使每一步都不影响尚未处理的低位 snapshot index；
  //   (b) anchor 相同时按 requestIndex **降序** 执行。
  //       反转是必要的：同一 before 上的多个 insert 若按请求顺序施加，
  //       后插入的会排到先插入的前面，最终顺序与请求顺序相反。
  return resolved
    .slice()
    .sort((a, b) => b.anchor - a.anchor || b.requestIndex - a.requestIndex)
    .map((op) => toHostOperation(op, scope));
}
```

补充规则：

1. `insert` 的 `before: N` 恒指「快照 index N 之前」，`before === groupNoteCount` 表示追加。
2. 同一 `before` 上的多个 `insert` 合法，最终顺序等于请求顺序（由上面的降序施加保证）。
3. `insert` 与其 anchor 相邻的 `delete`/`merge` 不冲突（前者不消费 Note），但 preflight 仍须
   验证 `value.onsetBlick` 在**快照邻居**之间解析到 `before`；不一致或同 onset 次序含糊时返回
   `INVALID_INSERT_POSITION`，零写入。
4. 提交后响应同时给出 `note`（快照 index）与 `resultNote`（新 index），由服务端从执行日志推导。

该模块必须有性质测试（随机生成 op 组合，与纯内存模型的预期最终序列比对），不能只靠几个
固定用例。

### 9.5 Planner 主流程

```js
class ExpressionPlanService {
  async plan(request) {
    const input = validateExpressionSchema(request);
    const scope = resolveRangeScope(snapshotStore, input);
    const defaults = normalizeDefaults(input.defaults);
    const canonicalGestures = expandExpressionGestures({
      rawGestures: input.gestures,
      defaults,
      scope,
    });

    const selection = selectGesturesForVocalEventPolicy(
      canonicalGestures,
      scope,
      input.constraints
    );

    const instantiated = selection.included.map((gesture) =>
      instantiateExistingCanonicalGesture(gesture, scope, input)
    );

    const compiled = compileExistingOperations(
      instantiated,
      scope,
      input.constraints,
      input.sampling
    );

    if (compiled.operations.length === 0) {
      // no_change 不封存 Plan Artifact。
      return {status: "no_change", data: {inputGroups: input.gestures.length, totalPoints: 0}};
    }

    const planArtifact = sealPlanArtifact({
      targetOperation: "patch_parameter_curves",
      capsule: buildContextCapsule(scope, selection),      // target + 被引用 fingerprints + shared targets
      execution: validateExecutionOptions(input.execution, "patch_parameter_curves"),
      mutationRequest: compiled.request,
    });

    return projectPlanSummary({
      inputGroups: input.gestures.length,
      expandedGestures: canonicalGestures.length,
      compiled,
      planRef: planArtifact.id,
      expiresAt: planArtifact.expiresAt,
    });
  }
}
```

关键点：

- Planner 不访问宿主；
- 只封存实际引用的 fingerprints；
- 写入选项在规划期校验并封存，apply 阶段不可覆盖；
- output 不包含完整 mutation；
- 业务编译内核不因传输格式重写。

### 9.6 PlanRef 封存与执行

```js
function sealPlanArtifact(plan) {
  return artifactStore.seal({
    kind: "plan",
    payload: freeze({
      targetOperation: plan.targetOperation,
      capsule: plan.capsule,
      execution: plan.execution,
      mutationRequest: plan.mutationRequest,
    }),
    leaseMs: 30 * MINUTE,
  });
}

async function executePlanRef({operation, planRef, action, confirmations}) {
  if (!["dry_run", "commit"].includes(action)) {
    throw error("INVALID_ARGUMENTS", {path: "/action", rule: "dry_run | commit"});
  }
  // artifactId、实例归属、kind 和 sealed targetOperation 全部在 store 内校验。
  const artifact = artifactStore.resolve({
    artifactId: planRef,
    expectedKind: "plan",
    expectedTargetOperation: operation,
  });

  const request = {
    ...deepClone(artifact.payload.mutationRequest),
    ...artifact.payload.execution,          // 封存的写入选项，调用方无法覆盖
    action,
    confirmations: validateRuntimeConfirmations(confirmations),
  };

  // capsule 只读；不向 SnapshotStore 回写恢复快照。
  return dispatchCanonicalMutation(operation, request, {
    capsule: artifact.payload.capsule,
    requireLivePreflight: true,
  });
}
```

调用方不能通过 PlanRef 覆盖 sealed mutation、target、fingerprint 或 execution 选项。

### 9.7 Artifact 短 offset 读取

```js
class ArtifactStore {
  constructor({ownerInstanceId, quotas, ioPolicy}) {
    this.ownerInstanceId = ownerInstanceId;
    this.quotas = quotas;
    this.ioPolicy = ioPolicy;
  }

  seal({kind, payload, leaseMs}) {
    const id = createShortId("a");
    const canonicalText = JSON.stringify(canonicalClone(payload));

    const artifact = freeze({
      id,
      kind,
      targetOperation: payload.targetOperation,     // 仅 kind==="plan" 时存在
      payload,
      canonicalBytes: Buffer.from(canonicalText, "utf8"),
      contentHash: sha256(canonicalText),
      expiresAtMs: now() + Math.min(leaseMs, this.quotas.maxLeaseMs),
      ownerInstanceId: this.ownerInstanceId,
    });

    enforceArtifactQuotas(artifact);
    this.entries.set(id, artifact);
    return artifact;
  }

  readSlice({artifactId, offset = 0, byteBudget = 16384}) {
    const artifact = requireOwnedActiveArtifact(artifactId);
    const total = artifact.canonicalBytes.length;
    assertSafeIntegerInRange(offset, 0, total, "/offset");
    assertSafeIntegerInRange(byteBudget, 8192, 16384, "/byteBudget");
    assertUtf8CodePointBoundary(artifact.canonicalBytes, offset, "ARTIFACT_OFFSET_INVALID");

    const candidateEnd = findPreviousUtf8Boundary(
      artifact.canonicalBytes,
      Math.min(offset + byteBudget, total)
    );
    // 按最终 structuredContent 计量，避免 JSON 字符串转义突破响应门禁。
    const end = fitArtifactSliceToEnvelope({
      artifact,
      offset,
      candidateEnd,
      maxBytes: this.ioPolicy.compactMaxBytes,
    });
    const done = end >= total;

    return {
      nextOffset: done ? null : end,
      totalBytes: total,
      // contentHash 只在末页返回，用于校验跨页重组。
      ...(done ? {contentHash: artifact.contentHash} : {}),
      text: artifact.canonicalBytes.subarray(offset, end).toString("utf8"),
    };
  }
}
```

offset 可由调用方选择，因为 Artifact 不可变且读取没有副作用。越界或 UTF-8 页首错误只返回明确
错误，不需要签名。`fitArtifactSliceToEnvelope()` 必须调用正式 compact projector 和
`JSON.stringify()` 计量完整 `structuredContent`，不能只测 `text`；非末页必须返回
`end > offset`。

### 9.8 单一 facade 路由

```js
const FACADES = {
  sv_status: ["ping", "doctor", "search_api", "describe_api"],
  sv_read: READ_OPERATIONS,
  sv_plan: PLAN_OPERATIONS,
  sv_edit: EDIT_OPERATIONS,
  sv_audition: AUDITION_OPERATIONS,
  sv_artifact: ["read", "release"],
  sv_raw: ["root", "call", "index", "free", "run"],
};

function listTools() {
  // 7 个 {operation, arguments} facade + sv_describe（直接接受 operations 数组）。
  return [...buildShallowFacadeSchemas(FACADES), DESCRIBE_TOOL];
}

async function callFacade({tool, operation, arguments: args = {}, diagnostics = false}) {
  const registered = operationCatalog.get(operation);

  if (!registered || registered.facade !== tool) {
    throw error("UNKNOWN_OPERATION", {tool, operation});
  }

  validateFacadeDiagnostics(diagnostics);
  // 浅层 facade 只负责调度；业务参数始终用 OperationCatalog 的唯一严格 schema 校验。
  validate(registered.inputSchema, args);
  return registered.handler(args, {
    observation: {collectDiagnostics: diagnostics === true},
  });
}
```

Direct operation 仍是内部组织单位，但不再单独出现在 `tools/list`。

### 9.9 MCP 结果编码与有界错误

```js
const ERROR_STATUSES = new Set([
  "failed", "conflict", "rolled_back", "rollback_failed", "partial", "outcome_unknown",
]);

function encodeMcpResult(domainResult, policy) {
  // 省略空 warnings、空 detail、默认 timing、以及未登记为 allowedEchoes 的输入回显。
  const structured = projectToCompact(domainResult, policy);
  // 失败信封用 errorMaxBytes(8 KiB)，成功用 compactMaxBytes(16 KiB)。
  const isError = ERROR_STATUSES.has(structured.status);
  enforceUtf8Budget(
    JSON.stringify(structured),
    isError ? policy.errorMaxBytes : policy.compactMaxBytes
  );
  const text = summarizeLine(structured);   // 单行，<=512 bytes

  return {
    content: [{type: "text", text}],
    structuredContent: structured,
    ...(isError ? {isError: true} : {}),
  };
}

function summarizeLine(structured) {
  // 例：succeeded c_N7GgW3hQyWmVxA
  //     failed NOTE_INDEX_OUT_OF_RANGE /gestures/0/notes/0
  //     planned apply=patch_parameter_curves a_F8x2Qm4pV7Ks
  return truncateUtf8(buildStatusLine(structured), 512);
}

function encodeMcpError(errorValue, policy) {
  const bounded = {
    status: errorValue.status ?? "failed",
    effects: errorValue.effects ?? "none",
    error: {
      code: errorValue.code,
      ...(errorValue.path ? {path: errorValue.path} : {}),
      ...(errorValue.rule ? {rule: errorValue.rule} : {}),
      ...boundedEvidence(errorValue),          // got/max/captured/count 等标量或有界摘要
      // message 只在 code 无法自解释时出现，且截断到 200 bytes。
      ...(needsMessage(errorValue) ? {message: truncateUtf8(errorValue.message, 200)} : {}),
    },
    ...(errorValue.retryable ? {retryable: true} : {}),
    ...(errorValue.next ? {next: errorValue.next} : {}),
  };

  if (wouldExceedUtf8(bounded, policy.errorMaxBytes)) {
    // sealErrorDetail 自身可能因配额失败；此时必须降级为最小 bounded error，
    // 不允许在格式化原错误的过程中抛出新错误。
    try {
      bounded.error.detail = sealErrorDetail(errorValue);
    } catch {
      bounded.error.truncated = true;
    }
    removeLargeEvidence(bounded);
  }

  return encodeMcpResult(bounded, policy);
}
```

禁止把原始 request、完整 schema、数百个合法候选或 rollback journal 直接塞入普通 error。
`retryable:false` 是默认值，因此只在为 true 时出现。

### 9.10 Surface 覆盖门禁

```js
// policy key 统一带 kind 前缀，避免 operation/resource/bridge 同名互相吞掉。
//   operation:plan_expression   tool:sv_plan
//   resource:svcopilot://operations   bridge:read_note_fingerprints_v1
test("every exposed surface has exactly one IO policy", () => {
  const expected = [
    ...operationCatalog.names().map((n) => `operation:${n}`),
    ...facadeToolNames().map((n) => `tool:${n}`),          // 含 sv_describe 的 tool-level policy
    ...resourceCatalog.names().map((n) => `resource:${n}`),
    ...bridgeOpcodeCatalog.names().map((n) => `bridge:${n}`),
  ];

  // Set 比较会吞掉重复登记，必须同时校验计数恰好为 1。
  const counts = new Map();
  for (const item of surfaceIoPolicies) {
    counts.set(item.key, (counts.get(item.key) ?? 0) + 1);
  }
  for (const key of expected) {
    assert.equal(counts.get(key), 1, `${key} must be registered exactly once`);
  }
  assert.deepEqual([...counts.keys()].sort(), [...expected].sort());
});

test("external schemas do not expose removed long identities", () => {
  const banned = [
    "noteId", "fromNoteId", "toNoteId", "occurrenceId",
    "resourceUri", "firstPageUri", "usePlanRef", "dryRun", "responseMode",
  ];
  for (const operation of operationCatalog.values()) {
    const names = recursivelyCollectPropertyNames(operation.inputSchema);
    for (const field of banned) {
      assert.equal(names.has(field), false, `${operation.name}.${field}`);
    }
  }
});

test("every fixture stays inside its bidirectional budget", () => {
  for (const fixture of allSurfaceFixtures()) {
    const result = fixture.invoke();
    const budget = isErrorResult(result)
      ? fixture.policy.errorMaxBytes
      : fixture.policy.compactMaxBytes;
    assert.ok(utf8Bytes(fixture.request) <= fixture.policy.requestMaxBytes);
    assert.ok(utf8Bytes(result.content[0].text) <= 512);
    assert.ok(utf8Bytes(JSON.stringify(result.structuredContent)) <= budget);
    assert.equal(fullPayloadDuplicationBytes(result), 0);
    // echo 按 policy 登记的白名单校验，不做全局字段相等比较——
    // invalidatedContexts / audition id / conflict evidence 都是必要业务证据。
    assert.deepEqual(
      unregisteredEchoes(fixture.request, result.structuredContent, fixture.policy.allowedEchoes),
      []
    );
  }
});
```

### 9.11 Context 失效与 live preflight

```js
async function commitMutation(operation, request, {capsule}) {
  return executionCoordinator.withExclusive(async (host) => {
    let writeAttempted = false;
    const scope = resolveMutationScope({source: {kind: "plan_capsule", capsule}});
    try {
      const liveTarget = await resolveLiveTarget(host, scope.target);
      await verifyTargetUuid(liveTarget, scope.target.targetGroupUuid);
      await verifyReferencedFingerprints(liveTarget, scope.fingerprints);
      await verifySharedTargetConfirmation(host, liveTarget, request.confirmations);

      const journal = await prepareFullJournal(host, request);
      writeAttempted = true;                       // 在第一个 setter 之前置位
      const result = await applyInsideOneUndoBoundary(host, request, journal);
      // 读回验证属于独立阶段，允许重读第 7 章第 4 条约束的同一 getter。
      await verifyReadBack(host, request);
      return result;
    } finally {
      // §4.6：只要发生过写入尝试就失效，不区分成功/partial/rollback_failed/outcome_unknown。
      // 旧 rev 只在成功路径失效，会让失败后的 Context 继续被信任。
      if (writeAttempted) {
        snapshotStore.invalidateContextsForTarget(
          scope.target.targetGroupUuid,
          "invalidated_by_mutation"
        );
      }
    }
  });
}
```

Context TTL 从 5 分钟提高到 30 分钟只减少无谓重捕获，不授权跳过任何实时校验。
失效发生在 `finally` 中，与当前 `NoteStructureService.restructureNotes` 的 `writeAttempted`
语义一致——该语义不得在迁移中回退。

## 10. 全部外部 JSON 契约

依照本文开头的权威顺序，本章与第 3、4、9 章共同定义唯一外部契约。字段名、嵌套、默认省略、
错误/结果信封或编码细节出现不一致时，以本章的完整 JSON 形状为准；第 2–9 章已经确定的
定位、音乐语义、live preflight、事务、验证、回滚和 Undo 仍必须完整保留，不能以传输效率为由删掉。
实现时从同一份 `OperationCatalog` 生成 JSON Schema、`sv_describe` 响应和 golden fixtures，
禁止再维护第二套手写 schema。

约定：

1. 下列对象默认 `additionalProperties:false`；唯一例外是 facade `inputSchema` 的调度容器
   `arguments`，它在 MCP 层允许任意属性，进入 handler 前再由 operation 严格 schema 关闭。
2. 未展示的字段不代表"可以任意追加"，而是禁止。
3. `contextId`、`artifact`、`planRef` 和 audition/comparison ID 都是短 Base64URL ID。
4. range-scoped operation 只接受 `occurrence` ordinal 和 NoteGroup 0-based index。
5. `action` 只允许 `dry_run` 或 `commit`；`dryRun` 布尔不存在。
6. 普通成功结果只有 compact 摘要；完整明细只能通过 `detail.artifact` 读取。
7. 所有数组必须在具体 schema 中声明 `maxItems`，所有字符串和数字声明长度或范围。
8. 默认值等于省略：`occurrence:0`（单 occurrence）、`atomic:true`、`retryable:false`、
   空 `warnings`、空 `args`、`byteBudget:16384` 一律不出现在线上 JSON。
9. 响应不回显调用方本次发送的输入值。

### 10.1 工具与 operation 总表

默认 `tools/list` 恰好 8 个工具，覆盖当前 41 个 operation：

| 工具 | operation 数 | operation |
| --- | ---: | --- |
| `sv_status` | 4 | `ping`、`doctor`、`search_api`、`describe_api` |
| `sv_read` | 10 | `snapshot`、`snapshot_range`、`wait_processing`、`get_parameter_curve`、`get_voice_profile`、`compare_computed_pitch`、`analyze_phrase`、`analyze_vocal_context`、`style_profile`、`check_prosody` |
| `sv_plan` | 5 | `plan_expression`、`plan_pitch_gesture`、`align_lyrics`、`quantize_notes`、`generate_harmony` |
| `sv_edit` | 9 | `set_lyrics`、`patch_notes`、`restructure_notes`、`patch_parameter_curves`、`patch_pitch_controls`、`bake_computed_pitch`、`edit_phrase`、`set_selection`、`clone_track` |
| `sv_audition` | 7 | `start`、`get`、`stop`、`restore`、`compare`、`get_compare`、`stop_compare` |
| `sv_artifact` | 1 | `release`（内容读取使用 MCP resource） |
| `sv_raw` | 5 | `root`、`call`、`index`、`free`、`run` |
| `sv_describe` | — | 不使用 operation 信封 |

数量来源：迁移前 42 个 direct tool，其中 5 个 raw dispatcher 未进入旧 compact facade，
catalog 当时为 37 个。统一 surface 收回 5 个 raw operation 后为 42，再删除单数
`patch_parameter_curve` 得 41。Artifact 内容继续由 MCP resource 读取，只把 `release`
作为 operation，因此不凭空增加 `artifact.read`。

**该数字不得硬编码。** doctor 的 `operations` 字段、`svcopilot://operations`、第 10.14 节
表格行数与覆盖门禁全部从 `OperationCatalog` 派生。旧 rev 把 43 写死在八处，任何一次
增删都要手工同步八个位置——这本身就是应当从单一来源派生的证据。

### 10.2 MCP tool call 与 tool result 信封

#### 10.2.1 根信封的完整字段集

规则 2 把「未展示的字段」定义为「禁止」，因此根级字段必须在**一处**枚举完毕。以下是全集，
任何未列出的根级字段都是契约违规：

| 字段 | 出现条件 |
| --- | --- |
| `status` | 恒存在。取值见第 4.5 节矩阵（10 个） |
| `effects` | 除 `succeeded`/`no_change`/`planned`/`dry_run` 之外恒存在；见 4.5 矩阵 |
| `data` | 业务结果存在时 |
| `error` | 失败类 status |
| `warnings` | 非空时 |
| `timing` | `diagnostics === true` 时 |
| `retryable` | 仅为 `true` 时（默认 false 省略） |
| `next` | 存在可执行下一步时 |
| `verification` | 曾尝试读回验证时（出现即 attempted） |
| `rollback` | 曾尝试补偿时（出现即 attempted） |
| `undo` | 曾开启 Undo 边界时 |
| `processing` | 请求了 `waitFor` 且已观察时 |
| `recovery` | `outcome_unknown` 时 |
| `invalidatedContexts` | 本次调用失效了 Context 时 |
| `evidence` | conflict 类失败的有界证据 |

`detail` **不是**根级字段。它只出现在两处，层级固定：

- `data.detail` —— 业务明细超预算时（snapshot、analysis、diff 等）；
- `error.detail` —— 错误证据超预算时。

7 个 facade 工具统一使用：

```json
{
  "operation": "snapshot_range",
  "arguments": {
    "scope": {"kind": "range", "tracks": [6], "from": {"bar": 1}, "to": {"bar": 9}},
    "include": ["notes"]
  }
}
```

Facade 信封只允许 `operation`、`arguments` 和可选 `diagnostics`。`arguments` 缺省为 `{}`，
但进入 handler 前必须用该 operation 的唯一业务 schema 再校验一次。`diagnostics` 属于 facade
观测选项，不进入业务 arguments、Plan Artifact 或 mutation oneOf；它只能增加 timing/host-call
证据，不能改变业务结果。`tools/list` 使用第 5.1 节定义的浅层 facade schema；不得把 operation
业务 schema 内联为庞大 `oneOf`，也不得跳过第二阶段校验。

路由实现与第 9.8 节一致：

```js
async function callFacade({tool, operation, arguments: args = {}, diagnostics = false}) {
  const registered = operationCatalog.get(operation);
  if (!registered || registered.facade !== tool) {
    throw error("UNKNOWN_OPERATION", {tool, operation});
  }

  validateFacadeDiagnostics(diagnostics);
  validate(registered.inputSchema, args);
  const observation = {collectDiagnostics: diagnostics === true};
  return registered.handler(args, {observation});
}
```

`observation` 是 dispatcher context，不得 spread 到 `args`，也不得进入 Plan capsule。

`sv_describe` 不套第二层 operation：

```json
{"operations": ["snapshot_range", "plan_expression"]}
```

MCP 传输结果（成功）：

```json
{
  "content": [{"type": "text", "text": "succeeded c_N7GgW3hQyWmVxA"}],
  "structuredContent": {
    "status": "succeeded",
    "data": {}
  }
}
```

MCP 传输结果（失败）：

```json
{
  "content": [{"type": "text", "text": "failed NOTE_INDEX_OUT_OF_RANGE /gestures/0/notes/0"}],
  "structuredContent": {
    "status": "failed",
    "effects": "none",
    "error": {"code": "NOTE_INDEX_OUT_OF_RANGE", "path": "/gestures/0/notes/0", "got": 999, "max": 372}
  },
  "isError": true
}
```

规则：

- `content[0].text` 是单行状态摘要，不超过 512 UTF-8 bytes，格式为
  `<status> <关键引用>`；不是 JSON。
- `structuredContent` 是唯一完整机器结果，不能在 `content` 再序列化一遍。
- `status` 取值与 `isError` 判据见第 4.5 节的完整矩阵（10 个 status，含 `partial` 与
  `rollback_failed`）。不存在 `ok` 布尔。
- 根信封允许的字段集见第 10.2.1 节；`detail` 只出现在 `data.detail` 或 `error.detail`。
- `warnings` 为空时省略；非空时每项为 `{code, count, first?, detail?}`。
- `timing` 只在 facade 外层 `diagnostics === true` 时返回，形状为
  `{totalMs, phases?, hostCalls?}`。
- `data` 超预算时只保留摘要和 `data.detail`。

#### 10.2.2 登记的合法回显（`allowedEchoes`）

第 4.4 节规则 7 禁止回显输入，但以下三类是**必要业务证据**，在 `SurfaceIoPolicy` 中按
operation 显式登记，门禁不将其判为违规：

| 字段 | operation | 为何必要 |
| --- | --- | --- |
| `invalidatedContexts[]` | 全部 mutation | 告知模型哪些 Context 已不可用；即使等于请求的 `contextId` 也必须返回 |
| `data.id` | audition `get`/`stop`/`restore`/`get_compare`/`stop_compare` | 幂等状态机的身份确认；多 audition 并发时不可省略 |
| `evidence.occurrence` / `evidence.note` | conflict 类失败 | 定位冲突位置；多 occurrence 请求下等于输入值但仍必需 |

任何新增回显必须先登记，否则门禁失败。禁止把 `allowedEchoes` 当成豁免口——登记项需要在
policy 中写明理由。

通用 Artifact 引用（用于 `detail`）：

```json
{
  "artifact": "a_Wq8Jw5R2PH0xgQ",
  "expiresAt": "2026-07-30T18:30:00.000Z",
  "totalBytes": 188236
}
```

`kind` 由产出它的 operation 唯一决定，因此不重复；`expiresAt` 必须保留。Artifact 的创建时间
可能晚于 Context，Plan Artifact 还必须允许源 Context 过期后继续 live preflight，doctor 的聚合
计数不能替代单项租期。线上 Artifact descriptor 必须严格使用上述三个字段。

通用 PlanRef（用于 `apply`）：

```json
{
  "operation": "patch_parameter_curves",
  "planRef": "a_vX0p6Gm4Rz2nDA",
  "expiresAt": "2026-07-30T18:30:00.000Z"
}
```

`planRef` 是裸 ID 字符串；`kind` 与 `targetOperation` 由服务端封存，不在线上重复。
Artifact 的内部归属键统一为 `ownerInstanceId`，由 ArtifactStore 实例持有并在 `seal`/`resolve`
内部校验；调用方不能提供或覆盖该值。

### 10.3 `sv_status`

请求：

```json
[
  {"operation": "ping"},
  {"operation": "doctor"},
  {"operation": "search_api", "arguments": {"query": "Automation getAllPoints", "limit": 8}},
  {"operation": "describe_api", "arguments": {"class": "Automation"}}
]
```

对应 `data`：

```json
[
  {"pong": true},
  {
    "interfaceVersion": "1.0.0",
    "host": "attached",
    "proto": {"expected": 2, "observed": 2},
    "operations": 42,
    "contexts": {"count": 2, "bytes": 4218904},
    "artifacts": {"count": 3, "bytes": 291044}
  },
  {"matches": [{"class": "Automation", "member": "getAllPoints", "kind": "method"}]},
  {
    "class": "Automation",
    "extends": ["NestedObject"],
    "methods": ["getAllPoints", "add", "remove", "removeAll"]
  }
]
```

`search_api` 结果未截断时省略 `truncated`。API 描述超过 16 KiB 时返回 `detail`，不内联整个
manifest。`doctor` 的 `contexts`/`artifacts` 字节计数是第 6 章配额的可观测面。

### 10.4 `sv_read`

请求契约：

```json
[
  {
    "operation": "snapshot",
    "arguments": {
      "scope": {"kind": "group", "track": 6, "group": 1},
      "include": ["notes", "processing"]
    }
  },
  {
    "operation": "snapshot_range",
    "arguments": {
      "scope": {"kind": "range", "tracks": [6, 9], "from": {"bar": 17}, "to": {"bar": 25}},
      "include": ["notes", "tempoMap", "meterMap", "automation", "attributes", "computedPitch"],
      "budgets": {"notes": 128, "automationPoints": 512, "computedPitchFrames": 2000}
    }
  },
  {
    "operation": "wait_processing",
    "arguments": {"contextId": "c_N7GgW3hQyWmVxA", "kind": "phonemes", "timeoutMs": 10000}
  },
  {
    "operation": "get_parameter_curve",
    "arguments": {"contextId": "c_N7GgW3hQyWmVxA", "parameter": "tension", "from": 0, "to": 62}
  },
  {"operation": "get_voice_profile", "arguments": {"contextId": "c_N7GgW3hQyWmVxA"}},
  {
    "operation": "compare_computed_pitch",
    "arguments": {
      "contextId": "c_N7GgW3hQyWmVxA",
      "from": 0,
      "to": 62,
      "reference": "note_centers",
      "minimumCoverage": 0.9
    }
  },
  {
    "operation": "analyze_phrase",
    "arguments": {
      "contextId": "c_N7GgW3hQyWmVxA",
      "from": 0,
      "to": 62,
      "include": ["rhythm", "range", "breaths", "continuations"]
    }
  },
  {
    "operation": "analyze_vocal_context",
    "arguments": {
      "contextId": "c_N7GgW3hQyWmVxA",
      "from": 0,
      "to": 62,
      "include": ["phrase", "style", "prosody", "pitch"]
    }
  },
  {"operation": "style_profile", "arguments": {"contextId": "c_N7GgW3hQyWmVxA"}},
  {
    "operation": "check_prosody",
    "arguments": {"contextId": "c_N7GgW3hQyWmVxA", "from": 0, "to": 62, "language": "mandarin"}
  }
]
```

`noteRange: {from, to}` 的嵌套层被删除：所有 range-scoped operation 直接使用顶层 `from`/`to`，
与 §3.2 的 Note 引用形状一致。省略两者表示整个 occurrence 捕获范围。独立
`wait_processing` 不接受 `pollIntervalMs`，由服务端按 `timeoutMs` 自适应；Planner 的
`execution.pollIntervalMs` 仍按第 3.6 节封存并交给目标 mutation。

Snapshot 成功 `data`：

```json
{
  "contextId": "c_N7GgW3hQyWmVxA",
  "expiresAt": "2026-07-30T18:30:00.000Z",
  "occurrences": [
    {
      "occurrence": 0,
      "track": 6,
      "groupReference": 1,
      "groupNoteCount": 373,
      "capturedNotes": 373
    }
  ],
  "detail": {
    "artifact": "a_Wq8Jw5R2PH0xgQ",
    "expiresAt": "2026-07-30T18:30:00.000Z",
    "totalBytes": 188236
  }
}
```

occurrence 多于一个时追加 `totals: {tracks, occurrences, notes}`；只有一个时省略，因为它
只会重复 `occurrences[0]`。

Processing 成功 `data`：

```json
{"kind": "phonemes", "state": "ready", "expected": 23, "computed": 23, "nonEmpty": 17}
```

`emptyItems` 由 `computed - nonEmpty` 推出，不单独返回。

分析类结果统一为：

```json
{
  "summary": {},
  "sections": {
    "rhythm": {},
    "style": {"status": "unavailable", "reason": "insufficient_evidence"}
  }
}
```

section 在成功时直接内联其数据，不再包一层 `{"status":"succeeded","data":{}}`——`status` 只在
非 `succeeded` 时出现，此时 `reason` 必填。未请求的 section 不出现；请求后无法计算的 section
必须显式报告，不能伪装为成功空对象。

### 10.5 `sv_plan`

请求契约：

```json
[
  {
    "operation": "plan_expression",
    "arguments": {
      "contextId": "c_N7GgW3hQyWmVxA",
      "defaults": {
        "vibrato": {
          "surface": "pitchDelta",
          "rateHz": 5.2,
          "onsetDelayQuarter": 0.22,
          "rampQuarter": 0.18,
          "fadeOutQuarter": 0.14
        }
      },
      "gestures": [
        {"type": "hairpin", "from": 0, "to": 62, "peak": 0.72, "amounts": {"loudness": 1.2, "tension": 0.08}},
        {"type": "vibrato", "notes": [121, 178, 237], "depthCents": 15}
      ],
      "constraints": {"maxAbsPitchDeltaCents": 80, "maxTotalPoints": 1200},
      "execution": {"atomic": true}
    }
  },
  {
    "operation": "plan_pitch_gesture",
    "arguments": {
      "contextId": "c_N7GgW3hQyWmVxA",
      "gestures": [
        {"type": "attack", "note": 87, "depthCents": 22},
        {"type": "release", "note": 157, "depthCents": 26}
      ],
      "specialLyrics": "warn_and_skip",
      "execution": {"atomic": true}
    }
  },
  {
    "operation": "align_lyrics",
    "arguments": {
      "contextId": "c_N7GgW3hQyWmVxA",
      "from": 0,
      "to": 62,
      "lyrics": "占位歌词",
      "language": "mandarin",
      "setLanguageOverride": true,
      "execution": {"atomic": true, "waitFor": "phonemes", "timeoutMs": 10000}
    }
  },
  {
    "operation": "quantize_notes",
    "arguments": {
      "contextId": "c_N7GgW3hQyWmVxA",
      "notes": [0, 1, 2, 3, 4],
      "grid": [1, 4],
      "strength": 1,
      "preserveDuration": true,
      "execution": {"atomic": true}
    }
  },
  {
    "operation": "generate_harmony",
    "arguments": {
      "contextId": "c_N7GgW3hQyWmVxA",
      "from": 0,
      "to": 62,
      "intervals": [3, 7],
      "range": [48, 76],
      "voiceLeading": "nearest",
      "execution": {"atomic": true}
    }
  }
]
```

紧凑 tuple 规则：

- `grid:[numerator,denominator]` 代替 `grid.quarter.{numerator,denominator}`；两项均为正整数，
  denominator 最大 64。
- Harmony `range:[minMidi,maxMidi]` 代替 `{minMidi,maxMidi}`；固定两项且 `min <= max`。
- tuple 只用于同一 operation 内字段意义唯一、长度固定且位置不会混淆的数值对；异构对象、
  可选字段和公开 descriptor 继续使用命名对象。
- `execution` 完整遵循第 3.6 节：目标 operation 支持时可包含 `atomic`、`waitFor`、
  `timeoutMs`、`pollIntervalMs` 和 `undoLabel`，并随 PlanRef 封存。

所有 Planner 成功 `data`：

```json
{
  "summary": {"input": 5, "operations": 4, "points": 96, "humanReview": false},
  "apply": {
    "operation": "patch_parameter_curves",
    "planRef": "a_vX0p6Gm4Rz2nDA",
    "expiresAt": "2026-07-30T18:30:00.000Z"
  }
}
```

约束：

- Planner 只返回 `apply.operation + apply.planRef + apply.expiresAt`，不返回 inline mutation。
- `status:"no_change"` 时不创建 Plan Artifact，且 `data` 不出现 `apply`。
- 特殊歌词、孤立 continuation、链间隙或含糊对齐必须在 warnings 中体现，不能静默规划。
- Planner 与目标 mutation 的 schema 迁移必须在同一提交完成，任何阶段都不能生成目标 handler
  无法接受的 apply。

### 10.6 `sv_edit`

直接请求契约：

```json
[
  {
    "operation": "set_lyrics",
    "arguments": {
      "contextId": "c_N7GgW3hQyWmVxA",
      "items": [{"note": 7, "expected": "甲", "lyrics": "乙"}],
      "action": "dry_run",
      "atomic": true,
      "waitFor": "phonemes"
    }
  },
  {
    "operation": "patch_notes",
    "arguments": {
      "contextId": "c_N7GgW3hQyWmVxA",
      "patches": [{"note": 7, "expected": {"lyrics": "甲", "pitch": 64}, "set": {"lyrics": "乙", "detuneCents": -4.5}}],
      "action": "dry_run",
      "atomic": true
    }
  },
  {
    "operation": "restructure_notes",
    "arguments": {
      "contextId": "c_N7GgW3hQyWmVxA",
      "operations": [
        {"op": "split", "note": 12, "atRatio": 0.5, "secondLyrics": "-"},
        {"op": "merge", "from": 20, "to": 22, "lyricsJoin": "first"},
        {"op": "insert", "before": 30, "value": {"onsetBlick": 1000, "durationBlick": 500, "pitch": 64, "lyrics": "占"}},
        {"op": "delete", "notes": [40]}
      ],
      "action": "dry_run",
      "atomic": true
    }
  },
  {
    "operation": "patch_parameter_curves",
    "arguments": {
      "contextId": "c_N7GgW3hQyWmVxA",
      "coordinate": "range_quarter",
      "from": 0,
      "to": 62,
      "curves": [
        {"parameter": "tension", "mode": "replace", "points": {"codec": "dense-table-v1", "columns": ["quarter", "value"], "rows": [[0, 0.2], [2, 0.3]]}},
        {"parameter": "loudness", "mode": "add", "points": {"codec": "dense-table-v1", "columns": ["quarter", "value"], "rows": [[0, 0], [2, 1.2]]}}
      ],
      "action": "dry_run",
      "atomic": true
    }
  },
  {
    "operation": "patch_pitch_controls",
    "arguments": {
      "contextId": "c_N7GgW3hQyWmVxA",
      "operations": [{"op": "add", "control": {"kind": "curve", "surface": "pitchDelta", "anchor": 12, "points": {"codec": "dense-table-v1", "columns": ["quarter", "cents"], "rows": [[0, 0], [0.25, 18], [0.5, 0]]}}}],
      "action": "dry_run",
      "atomic": true
    }
  },
  {
    "operation": "bake_computed_pitch",
    "arguments": {
      "contextId": "c_N7GgW3hQyWmVxA",
      "from": 0,
      "to": 62,
      "surface": "pitchDelta",
      "minimumCoverage": 0.9,
      "simplifyToleranceCents": 1.5,
      "action": "dry_run"
    }
  },
  {
    "operation": "edit_phrase",
    "arguments": {
      "contextId": "c_N7GgW3hQyWmVxA",
      "notes": [{"note": 7, "expected": {"lyrics": "甲"}, "set": {"lyrics": "乙"}}],
      "voice": {"paramTension": 0.1},
      "action": "dry_run",
      "atomic": true
    }
  },
  {"operation": "set_selection", "arguments": {"contextId": "c_N7GgW3hQyWmVxA", "mode": "replace", "notes": [0, 3, 7]}},
  {
    "operation": "clone_track",
    "arguments": {
      "templateTrack": 6,
      "insertAt": 7,
      "name": "Backing Vocal Copy",
      "copy": ["groups", "mixer", "voice"],
      "requireIsolatedTargets": true,
      "action": "dry_run"
    }
  }
]
```

紧凑规则：

- `patch_parameter_curves` 的多个 curve 共用同一 `from`/`to` 时提升到请求顶层；个别 curve
  需要不同范围时可在自身覆盖。
- `insert.note` 改为 `insert.value`，避免同一对象里 `note` 有时是 index、有时是新 Note 对象。
- `insert.before` 是快照 index 上的目标位置，`value.onsetBlick` 是 NoteGroup-local BLICK。
  preflight 必须验证该 onset 在快照邻居之间确实解析到 `before`；不一致或同 onset 次序含糊时返回
  `INVALID_INSERT_POSITION`，零写入。提交后再通过 `resultNote` 验证宿主最终顺序。
- `patch_pitch_controls.control.anchorNote` 统一为 `anchor`。
- `edit_phrase.notePatches` / `voicePatch` 缩短为 `notes` / `voice`；空 `structure` / `curves`
  不发送。
- `atomic:true` 是默认值，调用方可以省略；为明确展示事务语义，示例保留。

Automation 坐标规则：

- `coordinate:"range_quarter"` 时 `from`/`to` 是包含端点的 Note index；quarter 以 `from` Note 的
  local onset 为 0，range 结束于 `to` Note 的 local onset + duration。
- `coordinate:"group_blick"` 使用 NoteGroup-local integer BLICK，dense columns 为
  `["blick","value"]`，不要求 `from`/`to`。
- `coordinate:"project_blick"` 使用工程 absolute integer BLICK；执行前使用 live
  GroupReference time offset 换算并校验。
- Note/gap semantic position 保留现有能力，但身份改为短 index：

```json
[
  {"at": {"note": 12, "position": "end", "offsetQuarter": [1, 8]}, "value": 0.2},
  {"at": {"gap": [12, 13], "position": 0.5}, "value": 0.1}
]
```

- range-quarter dense table、BLICK dense table和 semantic positions 使用严格 `oneOf`；不得混合
  坐标系。Note fingerprint、gap 邻接、time offset 和重复解析位置继续执行 live preflight。

PlanRef 执行对所有 mutation 统一为：

```json
{
  "operation": "patch_parameter_curves",
  "arguments": {"planRef": "a_vX0p6Gm4Rz2nDA", "action": "dry_run"}
}
```

Direct 请求与 PlanRef 请求用 `oneOf` 严格区分：出现 `planRef` 时只允许 `planRef`、`action`、
`confirmations`；不存在 planRef 时才允许直接 mutation 字段。两种形状不得混合。

Dry-run `structuredContent`：

```json
{
  "status": "dry_run",
  "effects": "none",
  "data": {
    "changes": 7,
    "byKind": {"notes": 7},
    "diff": [{"note": 7, "field": "lyrics", "from": "甲", "to": "乙"}]
  }
}
```

`diff` 超预算时替换为 `detail`，不同时返回前缀和完整 Artifact，避免重复。

Commit 成功：

```json
{
  "status": "succeeded",
  "effects": "verified",
  "data": {"changed": 7, "byKind": {"notes": 7}},
  "verification": {"passed": true},
  "undo": {"records": 1, "userSteps": 1},
  "invalidatedContexts": ["c_N7GgW3hQyWmVxA"]
}
```

同值写入：

```json
{"status": "no_change", "effects": "none", "data": {"changed": 0}}
```

`no_change` 不返回 `verification`、`rollback` 或 `undo`：零写入意味着这些字段都为默认未尝试/零。

写入已验证成功但 processing 观察失败：

```json
{
  "status": "succeeded",
  "effects": "verified",
  "data": {"changed": 1},
  "verification": {"passed": true},
  "processing": {"status": "observation_failed"},
  "warnings": [{"code": "PROCESSING_OBSERVATION_FAILED", "count": 1}]
}
```

该结果不得提示重试 mutation；code 的 operation description 固定说明"write verified; do not retry"，
不在每次响应重复 message。

### 10.7 `sv_audition`

请求契约：

```json
[
  {
    "operation": "start",
    "arguments": {"contextId": "c_N7GgW3hQyWmVxA", "from": 0, "to": 62, "tracks": [6], "loop": false, "autoStop": true, "restore": true}
  },
  {"operation": "get", "arguments": {"id": "u_J7wq9K2eP4sLxA"}},
  {"operation": "stop", "arguments": {"id": "u_J7wq9K2eP4sLxA", "restore": true}},
  {"operation": "restore", "arguments": {"id": "u_J7wq9K2eP4sLxA"}},
  {
    "operation": "compare",
    "arguments": {"range": [3, 9], "a": {"tracks": [6]}, "b": {"tracks": [7]}, "gapMs": 500, "restore": true}
  },
  {"operation": "get_compare", "arguments": {"id": "ab_8jT1mQ4xZ6cV2A"}},
  {"operation": "stop_compare", "arguments": {"id": "ab_8jT1mQ4xZ6cV2A", "restore": true}}
]
```

`id` 在各 operation 内含义唯一，因此不重复 `auditionId`/`comparisonId`。compare 的
`range:[fromSeconds,toSeconds]` 是固定二元秒数 tuple。

状态 `data`：

```json
{
  "id": "u_J7wq9K2eP4sLxA",
  "state": "playing",
  "phase": "a",
  "range": [3, 9],
  "loop": false,
  "endPolicy": "auto_stop",
  "perception": "human_only",
  "recovery": true
}
```

停止或恢复必须幂等：

```json
{"id": "u_J7wq9K2eP4sLxA", "state": "restored", "restored": true, "alreadyTerminal": false}
```

重复 stop 返回 `alreadyTerminal:true`，不得再次执行宿主恢复。恢复证据超预算时返回 `detail`。

### 10.8 `sv_artifact`

请求：

```json
[
  {"operation": "read", "arguments": {"artifact": "a_Wq8Jw5R2PH0xgQ", "offset": 0}},
  {"operation": "release", "arguments": {"artifact": "a_Wq8Jw5R2PH0xgQ"}}
]
```

中间页 `data`：

```json
{"nextOffset": 12288, "totalBytes": 188236, "text": "{\"notes\":["}
```

末页 `data`：

```json
{"nextOffset": null, "totalBytes": 188236, "contentHash": "sha256_9f31c0", "text": "]}"}
```

规则：

- `offset` 默认 0，必须是非负 safe integer、不得超过 `totalBytes`，并且必须落在 UTF-8 码点
  边界；落在 continuation byte 时返回 `ARTIFACT_OFFSET_INVALID`，不能用替换字符继续。
- `byteBudget` 默认 16384，允许 8192–16384，是原始片段候选上限。
- 页尾必须同时满足 UTF-8 边界和最终 minified `structuredContent <= 16 KiB`；JSON 字符串转义
  导致超预算时继续向前收缩，因此实际返回可以少于 8192 bytes。
- `nextOffset` 是下一次调用唯一需要沿用的分页状态；末页 `contentHash` 校验完整重组结果。

核心页首与候选页尾计算为：

```js
assertSafeIntegerInRange(offset, 0, total, "/offset");
assertUtf8CodePointBoundary(artifact.canonicalBytes, offset, "ARTIFACT_OFFSET_INVALID");
const candidateEnd = findPreviousUtf8Boundary(
  artifact.canonicalBytes,
  Math.min(offset + byteBudget, total)
);
const end = fitArtifactSliceToEnvelope({
  artifact,
  offset,
  candidateEnd,
  maxBytes: artifactReadPolicy.compactMaxBytes,
});
```

释放 `data`：

```json
{"released": true}
```

请求中的 `artifact`、`offset` 不在结果中回显。重复释放返回 `{"released":false}`，不报错。

### 10.9 `sv_raw`

Raw 只保留官方 SV2 API escape hatch，不接受 Context identity：

```json
[
  {"operation": "root", "arguments": {"name": "project"}},
  {"operation": "call", "arguments": {"handle": [7, 3], "method": "getTrack", "args": [1]}},
  {"operation": "index", "arguments": {"handle": [12, 3], "field": "name"}},
  {"operation": "free", "arguments": {"handles": [[7, 3], [12, 3]]}},
  {
    "operation": "run",
    "arguments": {
      "steps": [
        {"id": "track", "op": "call", "target": "$project", "method": "getTrack", "args": [1]},
        {"id": "name", "op": "call", "target": {"$ref": "#/steps/track/result"}, "method": "getName", "assert": {"type": "string"}}
      ],
      "exports": {"trackName": {"$ref": "#/steps/name/result"}}
    }
  }
]
```

Raw 顶层返回 handle 的 `data`：

```json
{"handle": [12, 3], "type": "Track", "retained": 1}
```

Raw 返回普通业务值的 `data`：

```json
{"result": [{"$h": [21, 3], "type": "Note"}, {"$h": [22, 3], "type": "Note"}]}
```

直接身份槽位的 `[handle,epoch]` 输入与输出都恰好为 2 项；可选 `type` 使用同级字段承载，
不能追加成 tuple 第三项。顶层返回对象严格二选一：单个宿主 handle 使用 `handle`，其它官方 API
值使用 `result`。`result`、`args`、`steps` 和 `exports` 中的嵌套宿主对象递归编码为
`{"$h":[handle,epoch],"type":"..."}`；普通二元或三元数组保持普通数组。`$h` 是保留键，
递归值最大 32 层，并受 64 KiB typed-v2 frame 和 operation item 上限约束；超限返回
`RAW_VALUE_LIMIT_EXCEEDED`，不调用宿主。

递归 handle 标签的唯一 schema：

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["$h"],
  "properties": {
    "$h": {
      "type": "array",
      "prefixItems": [
        {"type": "integer", "minimum": 1},
        {"type": "integer", "minimum": 0}
      ],
      "minItems": 2,
      "maxItems": 2
    },
    "type": {"type": "string", "minLength": 1, "maxLength": 64}
  }
}
```

`args:[]`、`retain:false` 是默认值，省略。只有显式 `retain:true` 的最终返回 handle 进入调用者
所有权；其它中间 handle 在 operation 结束时自动释放。任何跨 bridge epoch 的 handle 返回
`STALE_HANDLE`。

### 10.10 `sv_describe`

请求：

```json
{"operations": ["patch_notes", "plan_expression"]}
```

`structuredContent`：

```json
{
  "status": "succeeded",
  "data": {
    "schemaVersion": "1.0.0",
    "operations": [
      {
        "operation": "patch_notes",
        "tool": "sv_edit",
        "schemaHash": "sha256_6dcce1",
        "inputSchema": {
          "type": "object",
          "additionalProperties": false,
          "required": ["contextId", "patches", "action"],
          "properties": {}
        }
      },
      {
        "operation": "plan_expression",
        "tool": "sv_plan",
        "schemaHash": "sha256_149aca",
        "inputSchema": {
          "type": "object",
          "additionalProperties": false,
          "required": ["contextId", "gestures"],
          "properties": {}
        }
      }
    ],
    "reuse": true
  }
}
```

上例中的 `properties:{}` 仅为本文缩写；真实响应返回 OperationCatalog 持有的完整唯一 schema。
若四个 schema 合计超过 16 KiB，每项改为
`{"operation":"...","tool":"...","schemaHash":"...","schema":{"artifact":"...","expiresAt":"...","totalBytes":...}}`，
不得截断 JSON。`facade` 字段不再返回，因为 `tool` 已完整表达同一信息；旧 direct tool 名不返回。

### 10.11 静态 MCP Resource

Artifact 不再通过 Resource URI 读取。正式 surface 只保留短、稳定、只读的静态 Resource：

```json
[
  {
    "uri": "svcopilot://operations",
    "mimeType": "application/json",
    "payload": {
      "schemaVersion": "1.0.0",
      "tools": {
        "sv_status": ["ping", "doctor", "search_api", "describe_api"],
        "sv_read": [
          "snapshot",
          "snapshot_range",
          "wait_processing",
          "get_parameter_curve",
          "get_voice_profile",
          "compare_computed_pitch",
          "analyze_phrase",
          "analyze_vocal_context",
          "style_profile",
          "check_prosody"
        ],
        "sv_plan": [
          "plan_expression",
          "plan_pitch_gesture",
          "align_lyrics",
          "quantize_notes",
          "generate_harmony"
        ],
        "sv_edit": [
          "set_lyrics",
          "patch_notes",
          "restructure_notes",
          "patch_parameter_curves",
          "patch_pitch_controls",
          "bake_computed_pitch",
          "edit_phrase",
          "set_selection",
          "clone_track"
        ],
        "sv_audition": ["start", "get", "stop", "restore", "compare", "get_compare", "stop_compare"],
        "sv_artifact": ["read", "release"],
        "sv_raw": ["root", "call", "index", "free", "run"]
      },
      "describe": "sv_describe"
    }
  },
  {
    "uri": "svcopilot://guide/music-workflows",
    "mimeType": "application/json",
    "payload": {
      "schemaVersion": "1.0.0",
      "recipes": [
        {"id": "analyze-plan-dry-run-commit", "operations": ["snapshot_range", "analyze_vocal_context", "plan_expression", "patch_parameter_curves"]}
      ]
    }
  }
]
```

Resource 主体不得复制 operation 的完整 inputSchema；需要 schema 时调用 `sv_describe`。
所有静态 Resource 各自小于 16 KiB。

### 10.12 Node 与 Lua 的 JSON frame

单调用：

```json
{"id": 1042, "proto": 2, "op": "call", "target": [12, 3], "method": "getLyrics", "args": []}
```

成功响应：

```json
{"id": 1042, "ok": true, "result": "占"}
```

有界 bulk read：

```json
{
  "id": 1043,
  "proto": 2,
  "op": "read_note_fingerprints_v1",
  "target": [21, 3],
  "indices": [0, 62, 124, 186, 248, 310, 372],
  "fields": ["index", "onset", "duration", "pitch", "lyrics", "phonemes", "language", "detune"]
}
```

```json
{
  "id": 1043,
  "ok": true,
  "result": {
    "columns": ["index", "onset", "duration", "pitch", "lyrics", "phonemes", "language", "detune"],
    "rows": [[0, 1000000, 500000, 72, "甲", "", "mandarin", 0], [62, 2000000, 500000, 67, "乙", "", "mandarin", 0]]
  }
}
```

Bridge 错误：

```json
{"id": 1043, "ok": false, "error": {"code": "STALE_HANDLE"}}
```

Bridge frame 不返回 MCP Context、Artifact 或 PlanRef；这些只属于 Node 进程。Bridge 的 `ok`
布尔保留，因为它是内部 lockstep 协议的一部分，不进入模型上下文，且不能与 MCP 的 `status`
混用。Bridge 错误 message 只在 code 无法自解释时出现。

### 10.13 通用失败契约

参数错误：

```json
{
  "status": "failed",
  "effects": "none",
  "error": {"code": "INVALID_ARGUMENTS", "path": "/gestures/2/from", "rule": "non-negative integer"}
}
```

Context 不可用：

```json
{
  "status": "failed",
  "effects": "none",
  "error": {"code": "UNKNOWN_CONTEXT", "reason": "expired"},
  "retryable": true,
  "next": {"tool": "sv_read", "operation": "snapshot_range"}
}
```

`reason` 允许 `unknown`、`expired`、`epoch_changed`、`invalidated_by_mutation`、
`evicted_by_quota`。不存在 `STALE_CONTEXT`。

实时冲突：

```json
{
  "status": "conflict",
  "effects": "none",
  "error": {"code": "FINGERPRINT_CONFLICT"},
  "retryable": true,
  "evidence": {"occurrence": 0, "note": 7, "fields": ["lyrics"]}
}
```

成功补偿：

```json
{
  "status": "rolled_back",
  "effects": "reverted",
  "error": {"code": "POSTCONDITION_FAILED"},
  "verification": {"passed": false},
  "rollback": {"passed": true},
  "undo": {"records": 1}
}
```

补偿未能证明恢复：

```json
{
  "status": "rollback_failed",
  "effects": "may_remain",
  "error": {"code": "POSTCONDITION_FAILED"},
  "verification": {"passed": false},
  "rollback": {"passed": false},
  "undo": {"records": 1},
  "recovery": {"required": true, "next": {"tool": "sv_read", "operation": "snapshot_range"}}
}
```

非原子路径中途失败：

```json
{
  "status": "partial",
  "effects": "may_remain",
  "error": {"code": "HOST_CALL_FAILED"},
  "data": {"changed": 3},
  "recovery": {"required": true, "next": {"tool": "sv_read", "operation": "snapshot_range"}}
}
```

结果未知：

```json
{
  "status": "outcome_unknown",
  "effects": "unknown",
  "error": {"code": "HOST_CONNECTION_LOST"},
  "verification": {"passed": false},
  "rollback": {"passed": false},
  "recovery": {"required": true, "next": {"tool": "sv_read", "operation": "snapshot_range"}}
}
```

错误契约硬规则：

1. `effects:"none"` 才允许自动重试。`reverted` / `may_remain` / `unknown` 都不允许。
2. `rolled_back` 表示补偿已读回验证成功，但**不带** `retryable`：正确动作是重新快照、重新
   规划，不是重放同一 payload。旧 rev 在此标注 `retryable:true` 与本条规则 1 矛盾。
3. `partial`、`rollback_failed`、`outcome_unknown` 永不可自动重试；三者的 `isError` 均为
   `true`（见第 4.5 节矩阵）。
4. 已验证写入后的 processing 失败不能改写成 `outcome_unknown`，也不作为顶层 status；
   降级为 `processing:{status:"observation_failed"}` 加 warning。
5. error 不回显原请求、完整 schema、完整 fingerprint 或宿主堆栈。
6. 多项失败只内联首项和计数，其余进入 `error.detail`。
7. code 足以自解释时省略 `message`；必须出现时最大 200 UTF-8 bytes。
8. `verification` / `rollback` 一旦出现就表示 `attempted:true`，因此删除重复的 `attempted` 字段。
9. `retryable` 的语义只有一种：**客户端可以原样自动重放同一请求**。它不表示「人可以重新
   规划后再试」——后者由 `recovery.next` 表达。

### 10.14 Operation 到契约族的完整映射

| Tool | Operation | 请求契约 | 成功契约 | Detail 策略 |
| --- | --- | --- | --- | --- |
| `sv_status` | `ping` | scalar | scalar | none |
| `sv_status` | `doctor` | bounded | status summary | diagnostics opt-in |
| `sv_status` | `search_api` | query | bounded matches | Artifact |
| `sv_status` | `describe_api` | class/member | bounded API description | Artifact |
| `sv_read` | `snapshot` | host scope | Context summary | Artifact |
| `sv_read` | `snapshot_range` | musical range | Context summary | Artifact |
| `sv_read` | `wait_processing` | Context occurrence | processing evidence | Artifact for values |
| `sv_read` | `get_parameter_curve` | Context occurrence + range | point summary | Artifact |
| `sv_read` | `get_voice_profile` | Context occurrence | bounded profile | Artifact |
| `sv_read` | `compare_computed_pitch` | Context occurrence + range | coverage summary | Artifact |
| `sv_read` | `analyze_phrase` | Context occurrence + range | section summary | Artifact |
| `sv_read` | `analyze_vocal_context` | Context occurrence + range | section summary | Artifact |
| `sv_read` | `style_profile` | Context occurrence + range | section summary | Artifact |
| `sv_read` | `check_prosody` | Context occurrence + range | finding summary | Artifact |
| `sv_plan` | `plan_expression` | grouped gestures + execution | PlanRef | Artifact |
| `sv_plan` | `plan_pitch_gesture` | indexed gestures + execution | PlanRef | Artifact |
| `sv_plan` | `align_lyrics` | indexed range + lyrics + execution | PlanRef | Artifact |
| `sv_plan` | `quantize_notes` | indexed notes + grid + execution | PlanRef | Artifact |
| `sv_plan` | `generate_harmony` | indexed range + policy + execution | PlanRef | Artifact |
| `sv_edit` | `set_lyrics` | indexed items/PlanRef | mutation result | Artifact |
| `sv_edit` | `patch_notes` | indexed patches/PlanRef | mutation result | Artifact |
| `sv_edit` | `restructure_notes` | snapshot-indexed operations/PlanRef | mutation result | Artifact |
| `sv_edit` | `patch_parameter_curves` | grouped curves/PlanRef | mutation result | Artifact |
| `sv_edit` | `patch_pitch_controls` | indexed controls/PlanRef | mutation result | Artifact |
| `sv_edit` | `bake_computed_pitch` | range/PlanRef | mutation result | Artifact |
| `sv_edit` | `edit_phrase` | grouped phrase transaction/PlanRef | mutation result | Artifact |
| `sv_edit` | `set_selection` | indexed editor state | editor-state result | none |
| `sv_edit` | `clone_track` | track indices | mutation result | Artifact |
| `sv_audition` | `start` | range + tracks | audition state | none |
| `sv_audition` | `get` | short ID | audition state | none |
| `sv_audition` | `stop` | short ID | terminal state | recovery Artifact only |
| `sv_audition` | `restore` | short ID | terminal state | recovery Artifact only |
| `sv_audition` | `compare` | range + A/B | comparison state | none |
| `sv_audition` | `get_compare` | short ID | comparison state | none |
| `sv_audition` | `stop_compare` | short ID | terminal state | recovery Artifact only |
| `sv_artifact` | `read` | short ID + offset | bounded fragment | paged |
| `sv_artifact` | `release` | short ID | release state | none |
| `sv_raw` | `root` | root name | value/handle | none |
| `sv_raw` | `call` | handle + method + args | value/handle | Artifact if large |
| `sv_raw` | `index` | handle + field | value/handle | Artifact if large |
| `sv_raw` | `free` | handles | release counts | none |
| `sv_raw` | `run` | bounded step graph | exports | Artifact if large |

该表的行数即 operation 总数，是覆盖门禁输入，但**不写死为常量**：`OperationCatalog`、
`SurfaceIoPolicy`、doctor operation count 和此表任意一方缺少或多出 operation，测试必须失败。`sv_describe` 是工具级 schema discovery，
不计入 operation 总数，但必须单独登记 tool-level IO policy。

## 11. 删除与迁移清单

实施完成后删除以下外部契约和代码路径：

1. MCP 输入 schema 中的 `noteId`、`fromNoteId`、`toNoteId`。
2. range-scoped MCP 输入中的完整 `occurrenceId`。
3. Planner 中从 `noteId` 字符串推导 occurrence 的逻辑。
4. `internalNoteId` 以及 Canonical gesture 中的字符串 Note identity。
5. Planner 的 `referencedNoteIds` 收集，改为收集 fingerprint 对象引用。
6. compact 响应和普通错误中的完整 Note ID。
7. `usePlanRef:false`、inline apply、`applyRequests`、`patchRequest`、`restructureRequest`。
8. PlanRef object、调用方提供的 `contentHash`、`resourceUri`、`firstPageUri`。
9. ~~Artifact Resource page URI、HMAC cursor、`_encodeCursor` / `_decodeCursor` 与相关
   template~~ —— **本轮不删**，见第 4.1 节 / C2：offset 分页降级为待数据评估。
10. ~~`ARTIFACT_PAGE_BUDGET_TOO_SMALL` 错误分支~~ —— 同上，随 cursor 一并保留。
11. `contextSnapshot` 写回、`snapshotStore.restore()` 与 `buildPlanContextSnapshot()`；context capsule
    改为 Plan Artifact 内部只读数据（C1）。
12. `dryRun`、`responseMode`、`standard`、`verbose`、pretty 输出、`SV_COPILOT_DEBUG_PRETTY`
    和 `SV_COPILOT_TEXT_FALLBACK`。
13. profile 选择层：四个 profile 注册、`compact-v2` 名称、`server/src/tool-profile.js`、
    `SV_COPILOT_TOOL_PROFILE`、`enabledTools` 三元分支、`isToolEnabled` 调用、
    doctor/capabilities 的 `toolProfile`/`compactActive`/`profile` 字段（A3）。
    保留 `compact-facade.js` 与 `operation-catalog.js`（第 1.6 节）。
14. direct tool 在 `tools/list` 中的暴露；direct operation 只保留为内部组织单位。
15. 只为旧 schema 存在的测试、文档和示例。
16. 旧 raw handle object `{"handle":N,"__epoch__":E}` / `{"handle":N,"epoch":E}` 外部形状，
    统一改为 `[N,E]`；返回 handle 放在 `data.handle`，普通值放在 `data.result`，两者不得同时存在。
    递归 `$h` 标签**首版不实现**（第 2.2 节 / C3）；Node 内部若继续使用其它对象，
    不得泄漏到 MCP surface。
17. 空 `warnings`、空 `detail`、默认 `timing`、`retryable:false`、`attempted:true/false` 等
    可由其它字段完全推导的响应字段。
18. `patch_parameter_curve`（单数）operation 及其独立 schema —— 它是 `patch_parameter_curves`
    的严格子集，占全部 schema 的 10.1%（A4）。
19. `ok` 布尔与 `content` 中的完整 payload 复制（A1）。
20. 顶层 `status:"processing_observation_failed"`，改为嵌套 `processing.status`（第 4.5 节）。

内部 target descriptor、fingerprint、host UUID 与 epoch 信息继续保留，但只存在于
Snapshot/Artifact/事务实现内部，不能再次泄漏到普通 MCP surface。

## 12. 分阶段实施（按实测收益/风险排序）

第 1.5 节测量揭示三条改变实施顺序的事实：响应重复是最便宜的大头，schema 体积本身没有消失，
`sv_raw` 不可砍。因此本计划**不再按契约层级组织**（旧 Phase 1-7 identity → planner →
artifact → response → facade → TTL），改为**按已测收益÷改动风险**排序：

- **A 段（独立小收益）**：已实测、改动集中、无依赖、不碰 identity。单项失败不阻塞其它。
- **B 段（契约闭合 + identity 重构）**：不可拆的主战场，最难，但必须在 C 之前。
- **C 段（正确性修复 + 按需优化）**：capsule/ScopeSource 保留（正确性），offset 分页降级或砍掉。

### Phase 0：固定真实基线与机器契约（不变）

1. 人工契约进入已跟踪的 `docs/`；可执行的 `SurfaceIoPolicy`、生成式 schema 门禁和匿名化
   固定 fixture 同时进入源码或测试目录，作为自动测试的可追溯基线。
2. 生成完整 surface inventory：
   - 42 个迁移前 direct operation；
   - 现有 facade、resource 和 resource template；
   - 每个 inputSchema 的 bytes、无界数组、身份字段和重复对象；
   - 每个固定 fixture 的 request、success、error、detail bytes；
   - `content` 与 `structuredContent` 的重复 bytes；
   - 每个高流量 operation 的 host-call 方法分布；
   - 当前未被测试覆盖的 operation 明细。
3. 新增匿名化 fixture，复现 373-note expression 请求：
   - 7 个乐句范围；
   - loudness/tension/breathiness hairpin；
   - 7 个 vibrato；
   - 4 个 scoop；
   - 3 个 fall；
   - 相同 constraints 和 sampling。
4. 记录：
   - 请求 UTF-8 bytes；
   - 明确 tokenizer 名称与版本后的 token 数；不可用时标记 unavailable；
   - 长 ID bytes；
   - 重复 key bytes；
   - MCP 调用数；
   - Planner service time；
   - 生成 operation/point 数；
   - warning 和 apply target；
   - Context 从创建到 Planner 调用的年龄；
   - SnapshotStore / ArtifactStore retained bytes。
5. 产出完整 `SurfaceIoPolicy`（含 `allowedEchoes` 与 kind 前缀 key）。任何 operation、
   resource、tool-level discovery 或 negotiated bridge op 缺项都不能进入 B 段。
6. 把 `tools/measure-surface-bytes.mjs` 固化为受跟踪脚本，第 14 章所有 bytes 门槛由它派生，
   不手写常量。

A 段不依赖 Phase 0 的全部产出——A1/A2 可与 Phase 0 并行。

---

## A 段：独立小收益（可并行，各自单独验证）

四项彼此独立，各自有可测收益，**不涉及 identity、事务或 schema 语义**。

### A1：消除 content/structuredContent 重复

- **收益（实测）**：每个 tool result 的 wire bytes 从 payload×2 降到 payload+≤512B，约砍半。
- **改动面**：`server/src/mcp-result-encoder.js` 单文件 + 其测试。
- **内容**：`content[0].text` 改为 512-byte 单行状态摘要（`<status> <关键引用>`）；
  按第 4.5 节矩阵设定 `isError`；删除 `ok` 布尔与 pretty/text-fallback 分支。
- **前置**：无。**这是第一个提交。**
- **验收**：`fullPayloadDuplicationBytes(result) === 0`；每个 facade 的 success/error fixture
  的 `content[0].text ≤ 512`。
- **注意**：多少字节真正进入模型上下文取决于客户端转发哪一路，因此第 15 章的客户端
  `structuredContent` 验收必须在此处（而非计划末尾）先做一次。

### A2：Context TTL 5→30 分钟 + 字节配额

- **收益**：消除「读大 Artifact → 分析 → 生成大请求 → `UNKNOWN_CONTEXT`」整轮重做（第 1.3 节）。
- **改动面**：`server/src/snapshot.js`。
- **内容**：默认 TTL 30 分钟、最大 60 分钟；单 Context / 总逻辑字节配额；LRU 只淘汰非活跃
  Context（需 pin/引用计数）；有界 tombstone 支撑五种 `reason`；doctor 报告
  count/accountedBytes/evictions。
- **前置**：无。配额与 TTL 必须**同一提交**落地。
- **验收**：第 13.7 节全部用例；64 个 373-note Context 不超过配置门禁。

### A3：删除 profile 选择层，facade 转正

- **收益（实测）**：`tools/list` 129,242 → 目标 <12 KiB。
- **改动面**：删 `tool-profile.js`；`index.js` 的 `enabledTools`、`isToolEnabled`、
  doctor/capabilities 字段；测试的 profile 分支。见第 5.1 节清单。
- **内容**：主要是删除。同时新增 `sv_raw` facade 收回 5 个 raw dispatcher（tuple handle
  `[N,E]`，**不含**递归 `$h` codec）。
- **前置**：无。
- **验收**：`tools/list` 恰好 8 个工具且 minified <12 KiB；OperationCatalog 的 41 个
  operation 全部可达；
  跨 facade 调用返回 `UNKNOWN_OPERATION` 而非静默转发。

### A4：Schema `$defs` 去重 + 删除单数 curve operation

- **收益（实测底盘）**：87,903 bytes schema 合计；单数 `patch_parameter_curve` 独占 10.1%。
- **改动面**：`operation-catalog.js`、`sv_describe` 响应构造、`index.js` 的 schema 常量组织。
- **内容**：见第 5.5 节。共享片段提到 `$defs`；删除 `patch_parameter_curve`；
  operation 总数改为从 Catalog 派生。
- **前置**：A3（facade 转正后 describe 才是唯一 discovery 路径）。
- **验收**：重测最大 2 个 / 最大 4 个 operation 的 describe 响应；写入第 14 章（fixture 派生）。

---

## B 段：契约闭合与 identity 重构

### B1：冻结协议内核（无直接收益，是 B2 的前置）

1. 冻结第 4.5 节 status × effects × isError 矩阵，含 `partial` / `rollback_failed`。
2. 冻结第 10.2.1 节根信封字段全集与 `detail` 的两处固定层级。
3. 实现第 9.10 节覆盖门禁：kind 前缀 key、恰好一次计数、`allowedEchoes` 白名单。
4. 明确 facade 是否声明 `outputSchema`（见第 13.4 节新增项）。
5. 定义第 4.3.1 节 Plan 执行 ledger 状态机。
6. 定义第 4.3.2 节 `resolveMutationScope` 统一接口与
   `CAPSULE_REQUIREMENTS_BY_OPERATION`。
7. 定义第 9.4 节结构编辑的 anchor 排序与冲突矩阵。
8. 定义第 4.6 节按 operation 的 Context 失效策略。

**B1 不改变任何外部行为**，但它决定 B2 的每一次迁移是否需要返工。

### B2：identity 重构与 planner/apply 配对迁移

1. 新增纯数据 scoped-reference Module（§3.5、§9.2，含空捕获检查统一位置）。
2. SnapshotStore 改短随机 Context ID，返回稳定 ordinal、`groupNoteCount`、`capturedNotes`、
   `indexInGroup`。
3. Canonical gesture 改持 fingerprint 引用，删除内部字符串 Note ID。
4. 实现 grouped expression schema（`defaults`、多参数 hairpin、vibrato batch、scoop/fall tuple）。
5. 按 planner→apply 配对迁移，**每对同一提交**：
   - `plan_expression` + `patch_parameter_curves`
   - `quantize_notes` + `patch_notes`
   - `plan_pitch_gesture` + `patch_pitch_controls`
   - `align_lyrics` + `set_lyrics`
   - `generate_harmony` + `restructure_notes`（须先落地 §9.4）
   - `bake_computed_pitch` + `patch_parameter_curves`
   - `edit_phrase` 及其内部 curve/note/structure target
   - processing / analysis / voice / selection / audition 的 identity
   - `clone_track` 与新 Context 工作流
6. 每迁一对立即删除旧字段，不保留 dual schema。
7. Automation 迁移保留 local/project BLICK、range-relative quarter、Note/gap semantic
   position 三类能力；只替换身份，不缩减坐标语义。

---

## C 段：正确性修复与按需优化

### C1：capsule + ScopeSource（正确性，保留）

1. 实现 `resolveMutationScope`，planner 与 mutation 消费同一 `ResolvedRangeScope`。
2. 按 `CAPSULE_REQUIREMENTS_BY_OPERATION` 封存最小完整 capsule。
3. 删除 `snapshotStore.restore()` 写回路径与 `buildPlanContextSnapshot()`。
4. 实现 Plan 执行 ledger（防重放）。
5. PlanRef 改裸 artifactId 字符串；Artifact ID 缩短；`detail`/`apply` 携带各自 `expiresAt`。

这一段属于**正确性修复**（消除写回污染、防止 `mode:"add"` 重复叠加），不是性能优化，因此保留。

### C2：Artifact offset 分页（降级，待数据）

见第 4.1 节。**首版不做。** 等独立 LLM 验收产出「模型实际翻了几页」的数据后再评估；届时
门禁数字从真实 fixture 反推。

### C3：Raw 递归 `$h` codec（砍掉首版）

见第 2.2 节非目标。tuple handle 保留，递归标签等真实需求出现再作为独立提案。

### C4：实机与独立 LLM 验收

1. 完成离线全量测试。
2. SV Live Probe 验证业务等价（第 15 章）。
3. 独立 LLM 只通过 MCP 完成真实工作流。

## 13. 测试矩阵

### 13.1 Identity 与结构性编辑

- 单 occurrence 自动选择；
- 多 occurrence 使用完整数组 ordinal；
- ordinal 越界；
- ordinal 存在但未捕获 Note，返回 `OCCURRENCE_NOT_CAPTURED`；
- **单 occurrence 且省略 `occurrence` 时空捕获，同样返回 `OCCURRENCE_NOT_CAPTURED`**
  （§9.2 的空捕获检查在 occurrence 选定之后统一执行，不得降级为 `NOTE_NOT_IN_CONTEXT`）；
- 全部 occurrence 均为空捕获时 `AMBIGUOUS_CONTEXT.candidates` 仍返回全部 ordinal，不为空数组；
- Note index 0、末项和越界；
- 合法 index 未被 Context 捕获，返回 `NOTE_NOT_IN_CONTEXT`；
- 稀疏捕获的 `captured` 摘要最多 8 段；
- range 只捕获部分 Note 时仍按 `indexInGroup` 定位；
- Context 过期、epoch 变化、mutation invalidation、配额淘汰；
- live Note 被移动、改词或删除；
- shared target；
- 不允许跨 occurrence Note；
- restructure 同批 insert/delete/split/merge 全部相对快照 index；
- 高 index 到低 index 执行后的 result index 正确；
- 同一 snapshot Note 被两个 op 争用；
- merge 区间与其它操作重叠；
- `before === groupNoteCount` 追加；
- 同一 `before` 上多个 `insert`，最终顺序等于请求顺序（§9.4 的 requestIndex 降序施加）；
- `insert` 与相邻 `delete`/`merge` 共存时不误判冲突；
- 随机 op 组合的性质测试：与纯内存模型的预期最终序列 + result-index 映射比对；
- insert 的 `before` 与 `value.onsetBlick` 一致；
- insert onset 无法解析到 `before` 或与邻居同 onset 时零写入拒绝；
- harmony 产生的 insert 不使后续 anchor 漂移。

### 13.2 Gesture expansion

- grouped 与当前 Canonical gesture golden 在音乐语义上深相等；
- Canonical gesture 不包含任何 `*NoteId` 字符串字段；
- 多参数 hairpin 的单位、顺序和 point 数一致；
- defaults 覆盖；
- vibrato batch；
- scoop/fall tuple；
- 重复 Note；
- 冲突参数；
- special lyric `br`、`+`、`-` 的跳过策略不回归；
- constraints 和 maxTotalPoints 在展开后执行；
- warning、evidenceScope 和 perception 不变。

### 13.3 Artifact 与 PlanRef

- offset 0、中间、末页、空 Artifact 和越界；
- UTF-8 多字节边界；
- offset 落在 UTF-8 continuation byte 时返回 `ARTIFACT_OFFSET_INVALID`；
- `byteBudget:16384` 在高转义片段上自动缩短，最终 envelope 不超过 16 KiB；
- 非末页动态收缩后仍至少推进一个完整码点，不会返回相同 `nextOffset`；
- 动态页长完整重组并用末页 contentHash 校验；
- Artifact 实例隔离；
- TTL、容量和释放；
- 错误 artifactId；
- read/release 幂等语义；
- 读取不访问宿主；
- 普通工作流不读 detail；
- planRef kind、owner instance 和 target operation 不匹配；
- 外部请求不能提供或覆盖 `ownerInstanceId`；
- Plan Context 过期后 capsule 仍能执行 live preflight，且不回写 SnapshotStore；
- planner `execution` 的 `atomic` / `waitFor` / `timeoutMs` / `pollIntervalMs` / `undoLabel`
  经 PlanRef 生效；
- apply 阶段尝试覆盖封存 execution 被 schema 拒绝；
- no_change 不创建 Plan Artifact；
- 未经 dry-run 的 commit 被拒（`PLAN_DRY_RUN_REQUIRED`）；
- 同一 planRef 二次 commit 被拒（`PLAN_ALREADY_EXECUTED`），含 `mode:"add"` 曲线不重复叠加；
- `outcome_unknown` 后该 planRef 永久封禁重放；
- `rolled_back` 后不允许重放同一 planRef；
- ledger 与 Artifact 同租期/同实例隔离/同配额回收；
- 每个 detail/PlanRef 都返回自己的 `expiresAt`，不从 Context 或 doctor 聚合值推断；

### 13.4 Schema

- 除 facade 调度容器 `arguments` 外，所有对象 `additionalProperties:false`；
- `tools/list` 的 facade schema 不内联 operation 业务 schema，第二阶段仍严格拒绝未知字段；
- 所有数组有 `maxItems`；
- index 必须是非负 safe integer；
- tuple 长度和列语义严格；
- `from <= to`、`minMidi <= maxMidi`；
- Automation `range_quarter`、`group_blick`、`project_blick` 与 semantic position 使用严格
  `oneOf`，坐标原点和 time offset 换算有 golden fixture；
- `noteId`、`occurrenceId`、`resourceUri`、`firstPageUri`、`contentHash`、`cursor`、
  `usePlanRef`、`dryRun`、`responseMode` 被明确拒绝；
- direct mutation 与 planRef mutation 的 oneOf 不允许混合；
- facade 外层 `diagnostics` 只接受 boolean，业务 arguments 中的同名字段被拒绝；
- diagnostics 开关不改变去除 timing 后的业务结果；
- schema 与 runtime normalization 对同一输入结论一致；
- facade operation 与内部 handler schema 使用同一对象；
- `sv_describe` 返回的 schemaHash 稳定；
- facade 的 `outputSchema` 决策明确：要么不声明，要么声明覆盖第 4.5 节全部 status 与
  第 10.2.1 节全部根字段的严格 schema。**禁止**保留
  `{type:"object", additionalProperties:true}` 这种既无验证价值、又让 MCP 规范
  「服务器 MUST 提供符合该 schema 的 structuredContent」变成空约束的形式；
- `$defs` 去重后每个 operation 的 `$ref` 可解析，且 describe 响应自包含。

### 13.5 事务安全

- Planner 永远不写宿主；
- PlanRef dry-run 零 setter、零 Undo；
- commit 前 target UUID 与 live fingerprint 校验；
- stale target 零写入；
- grouped 输入与展开后的 Undo 数一致；
- rollback 和 `outcome_unknown` 分类不变；
- 写后验证允许在独立读取阶段重读 getter；
- processing 观察失败不改写已验证 mutation 状态，降级为 `processing.status`；
- `partial` 与 `rollback_failed` 可被契约表达，且 `isError === true`；
- `rolled_back` 不带 `retryable`；
- **任何写入尝试后 Context 均被失效**（succeeded / partial / rollback_failed /
  outcome_unknown 全覆盖），dry-run 与 no_change 不失效；
- `set_selection` / audition 不按音乐 mutation 失效；
- `clone_track` 失效受工程结构变化影响的 Context。

### 13.6 全 MCP Surface

离线测试：

- 每个 operation（数量从 OperationCatalog 派生）、每个 resource、8 个工具和 negotiated bridge op 都有 `SurfaceIoPolicy`，且恰好登记一次；
- tools/list 只有 8 个工具；
- `svcopilot://operations` 与 OperationCatalog 深相等（数量不硬编码）；
- `sv_describe` schemaHash 稳定；
- scalar、read、plan、edit、audition、artifact、raw 各有 success/error fixture；
- `content` 不复制完整 `structuredContent`；
- 默认模式 compact success 不超过 16 KiB；
- error 不超过 8 KiB；
- 超预算字段可从 Artifact 恢复；
- 请求和响应均不出现被禁止的完整外部身份；
- Artifact/PlanRef 引用含逐项 `expiresAt`；
- response 不回显 request 中的非服务端生成值；
- 空/default 字段被省略；
- 新增 operation 未登记时测试失败；
- policy key 带 kind 前缀且每项恰好登记一次（重复登记必须失败）；
- `allowedEchoes` 未登记的回显字段判为违规，已登记的三类不误报；

客户端能力验收（**A1 完成后立即执行，不推迟到计划末尾**）：

- 目标 MCP 客户端确实把 `structuredContent` 交给模型，而不是只转发 `content[].text`；
- 记录最低客户端版本要求；不支持该能力的客户端明确列为超出范围。

独立 LLM 验收：

- 相同 schema 在一次工作流中不重复读取；
- workflow guide 不被无理由重复读取；
- 普通 compact 工作流不读取无关 detail；
- 模型自然使用 grouped schema、ordinal/index 和 PlanRef。

### 13.7 Context 配额

- 默认 30 分钟、最大 60 分钟；
- 单 Context 字节上限；
- 总 retained bytes 上限；
- LRU 淘汰只淘汰非活跃 Context；
- 淘汰 tombstone 返回 `UNKNOWN_CONTEXT.reason === "evicted_by_quota"`；
- doctor 的 count/bytes/evictions 与 store 状态一致；
- 64 个 373-note Context 不超过设定内存门禁；
- mutation invalidation 立即释放 retained bytes；
- byte 估算不因共享 fingerprint 对象重复计费。

### 13.8 Node 与 Lua

- negotiated op 与 staging/loaded bridge 一致；
- bulk 与 fallback 业务结果相同；
- 同一读取阶段内同一 getter 不重复；
- 写后验证在独立阶段真实重读；
- bulk item/field/frame/allocation 上限；
- malformed typed-v2；
- detach/timeout；
- diagnostics 不包含用户音乐内容；
- 每类高流量 operation 的 MCP bytes、PIPE calls 和 host calls 分开记录；
- tuple handle 与内部 handle object 双向 codec；
- Raw 返回中的 `handle` 与 `result` 严格二选一，普通二元/三元数组不会被误判为 handle；
- Raw 的 `args`、`result`、`steps`、`exports` 中嵌套 handle 使用递归 `$h`，对象数组可回送调用；
- Raw 递归值超过 32 层、64 KiB frame 或 operation item 上限时零宿主调用拒绝；
- stale epoch handle 被拒绝。

## 14. 量化门禁

基于 Phase 0 的同一固定 fixture。**所有数值门槛必须由 fixture 实测派生或标注为待测，不再手写常量。**

| 指标 | 门槛 |
| --- | ---: |
| SurfaceIoPolicy 覆盖 | OperationCatalog.size + 8 tools + resources + bridge ops = 100%，新增项未登记即失败 |
| 默认 tools/list | 8 个工具，minified <12 KiB（实测 129,242 → 目标） |
| 单次 `sv_describe` | 小于 16 KiB；当前实测最大 2 个可能超出，待 A4 `$defs` 去重后重测 |
| grouped expression 请求 UTF-8 bytes | 小于旧请求的 35% |
| 其它高流量 operation 请求 | 不得比基线增加 10% 以上 |
| 完整 Note/Occurrence ID 在普通请求中的出现次数 | 0 |
| Canonical gesture 中字符串 Note ID 字段 | 0 |
| grouped 与基线 Canonical operation 的音乐语义 | 深相等 |
| generated points、warnings、constraints 结果 | 完全一致 |
| Planner service median | 不高于基线 1.10 倍 |
| compact success envelope | 不超过 16 KiB |
| error envelope | 不超过 8 KiB |
| `content[0].text` 对 `structuredContent` 的重复 bytes | 0（实测当前为精确 2 倍） |
| response 对 request 的非登记回显 bytes | 0（按 `allowedEchoes` 白名单校验） |
| Artifact 分页 | **首版不实施**，待独立 LLM 验收产出实际翻页数据后评估 |
| 普通 compact 工作流 Artifact detail reads | 0 |
| 相同 schema/guide 的无理由重复读取 | 0（独立 LLM 验收） |
| 固定端到端工作流模型可见总 bytes | 小于基线的 50% |
| 已有 bulk 路径 host calls | 不高于基线 |
| 同一读取阶段重复 getter | 0 |
| SnapshotStore accountedBytes | 不超过配置总额，doctor 报告与实值一致 |
| 10 分钟独立 LLM 工作流 Context expiry | 0 |
| 35 分钟过期工作流 | 有界 `UNKNOWN_CONTEXT` + 可执行 `next`，不生成旧式长请求 |
| dry-run 宿主 setter / Undo | 0 / 0 |
| 文档/fixture 中真实用户音乐内容 | 0 |

**删除项**：旧 rev 的 12/13 页 Artifact 门禁在算术上不成立（`byteBudget` 与 `structuredContent`
上限均为 16384，JSON 转义必然使可用原始 bytes 显著小于 16384），且 C2 已将 offset 分页降级为
待数据评估。

## 15. 实机验收

使用当前 373-note 实际工程，只执行 read、planner、dry-run 和无副作用状态调用；保存证据时必须
去标识，不记录歌词、音素、工程名或可还原的逐 Note 内容：

1. `sv_status` 验证 doctor、ping、8-tool surface 和 operation catalog（数量与 Catalog 一致）。
2. `sv_read(snapshot_range)` 捕获 notes-only Context。
3. 使用 ordinal 和 Note index 生成 grouped expression。
4. 记录请求 bytes、模型可见调用文本和 wall time。
5. Planner 返回短 PlanRef，并确认 execution 选项已封存。
6. `sv_edit(patch_parameter_curves, action:"dry_run")`。
7. 核对 parameter、range、pointCount、warnings、setter count 和 Undo。
8. 分别执行 lyrics、pitch gesture、quantize 和 harmony 的只读 planner。
9. 分别执行 Note、curve、pitch-control 和 phrase-edit dry-run。
10. 构造含 insert/delete/split/merge 的 dry-run，验证所有 index 相对同一快照解析。
11. 执行 analyze/wait/get-audition 等只读路径。
12. 使用 `sv_raw` 完成一次 root/read/free tuple-handle 逃生路径，并用 `getSelectedNotes()` 验证
    对象数组的递归 `$h` 编码、回送调用和释放。
13. 使用 Artifact facade 读取一个 ASCII Artifact 和一个含多字节字符 Artifact 的全部页面，
    以末页 hash 重组校验。
14. 再执行正常 compact 工作流，确认 Agent 不主动读取 detail。
15. 触发每个 facade 的一个 bounded error，确认不回显大型输入。
16. 让 Context 闲置超过旧 5 分钟但少于 30 分钟，再执行 planner，确认不重新快照。
17. 让测试 Context 过期，确认返回 `UNKNOWN_CONTEXT.reason` 和短 `next`，不重建旧式长请求。
18. 使用低配额测试配置触发 LRU 淘汰，确认 doctor count/bytes/evictions。
19. 重新读取工程，确认歌词、音符、曲线、选择和播放状态未改变。

独立 LLM 只能获得 MCP 自描述。若它仍生成完整 Note ID、逐参数重复 hairpin、读取全部无关
Artifact、重复读取同一 schema，验收失败，不能用"接口已经支持短格式"替代真实可用性证据。

独立 LLM 使用的 MCP 客户端必须读取 `structuredContent`；不支持该能力的客户端不属于本次未发布
surface 的目标范围。

## 16. 提交切分

按第 12 章的 A/B/C 段排序。A 段各项彼此独立，可并行或任意顺序提交。

**A 段**

1. `Stop duplicating payloads across content and structuredContent`（A1）
2. `Extend context lifetime with byte quotas and LRU eviction`（A2）
3. `Collapse tool profiles into one facade surface`（A3，含 `sv_raw` tuple handle）
4. `Deduplicate operation schemas behind describe $defs`（A4，含删除单数 curve operation）

**Phase 0 / B 段**

5. `Track generated IO policies and anonymous efficiency fixtures`
6. `Inventory bidirectional MCP and bridge payload costs`
7. `Freeze result status matrix and root envelope field set`（B1）
8. `Enforce IO policies for every exposed surface`（B1）
9. `Replace string note identities with scoped fingerprint references`（B2）
10. `Group repeated expression gestures before planning`（B2）
11. `Migrate expression and curve execution as one contract`（B2）
12. `Resolve structure edits against snapshot indices`（B2）
13. `Migrate each remaining planner with its mutation target`（B2）

**C 段**

14. `Unify mutation scope across snapshots and plan capsules`（C1）
15. `Seal execution capsules with a replay-guarding ledger`（C1）
16. `Complete live-host and independent-LLM acceptance`（C4）

每个提交必须：

- 只包含一个可验证迁移阶段；
- planner 与其 apply target 在同一提交迁移；
- 删除同阶段旧路径，不保留 dual schema；
- `npm test` 和 MCP smoke 通过；
- 改动 Lua dispatcher 时，实际加载脚本与 `staging/StartSynthVCopilotPipe.lua` 功能一致，并运行
  `dispatcher_test.lua`；
- `git diff --check` 通过；
- 不修改 `.serena`、`.codegraph` 或 `.codex`；
- 文档契约发生变化时同批更新 `docs/`，不夹带本地工具状态；
- 不提交真实用户音乐内容或完整真实工具调用 payload。

## 17. Definition of Done

- 机器可执行的 IO policy、schema 门禁、匿名化固定 fixture 与本文均进入版本控制；
- 默认 MCP surface 只有 8 个工具；
- 全部 operation 可通过 facade 到达，数量从 OperationCatalog 派生而非硬编码；
- `svcopilot://operations` 与 OperationCatalog 完全一致；
- facade 在 `tools/list` 只公开浅层调度 schema，OperationCatalog 第二阶段严格校验全部业务参数；
- 每个 operation、tool、resource 和高流量 bridge 路径都有明确 IO 策略与基线；
- Context 和 Artifact 均使用短随机 ID；
- 外部 range-scoped 请求不再包含完整 occurrenceId/noteId；
- Canonical gesture 不再包含字符串 Note ID；
- occurrence ordinal 恒定索引完整 Context occurrence 数组；
- Note 越界与合法但未捕获使用两个明确错误码；
- 结构性编辑的全部 index 相对快照解析，批内 index 漂移不影响目标；
- insert 的 snapshot `before`、local onset 和提交后 `resultNote` 三者一致；
- Automation 身份缩短后仍完整保留 local/project BLICK、range-relative quarter 和
  Note/gap semantic position；
- expression 支持多参数范围和同参数 Note batch；
- Planner 封存 execution 选项并只返回短 PlanRef；
- Plan Context 过期后只读 capsule 仍执行完整 live preflight，不回写 SnapshotStore；
- Artifact 页面使用短 offset 工具调用，末页 hash 可验证完整重组；
- Artifact offset 不得落在 UTF-8 continuation byte，每个引用携带自身 `expiresAt`；
- Artifact 页按最终序列化 envelope 动态收缩，任何非末页都推进且不超过 16 KiB；
- success、error、warning 和 diff 均遵守统一 response budget；
- `content` 不再复制完整 `structuredContent`，不存在完整 text fallback，response 不回显 request；
- Raw 直接身份使用 tuple，任意嵌套宿主对象使用有界递归 `$h` codec；
- 默认/空字段被省略，完整 audit 只通过 Artifact 读取；
- 新增接口若未声明双向传输策略，测试立即失败；
- SnapshotStore 的 30 分钟 TTL 同时受单项/总字节配额和 LRU 约束；
- 30 分钟内的正常工作流不因 Context TTL 重做快照；
- 当前 SV2 实机 dry-run 业务结果与迁移前一致；
- mutation 的 live preflight、验证、回滚和 Undo 语义无回归；
- 独立 LLM 在不读取源码和旧文档的情况下自然使用紧凑契约；
- 仓库中的文档、fixture 和 diagnostics 不包含真实用户音乐内容；
- `content[0].text` 不再复制 payload，wire bytes 不再是 payload 的两倍；
- 结果状态集合可表达 `partial` 与 `rollback_failed`，`isError` 按「操作是否完成」判定；
- 根信封字段全集与 `detail` 层级在第 10.2.1 节一处枚举完毕；
- 任何写入尝试后相关 Context 均被失效，不只是成功路径；
- 同一 PlanRef 不可重复 commit，未 dry-run 的 commit 被服务端拒绝；
- planner 与 mutation 消费同一 `ResolvedMutationScope`，不存在 store/capsule 双路径；
- operation 总数从 `OperationCatalog` 派生，全文无硬编码常量；
- 每个量化门槛可追溯到实测值或 fixture 派生值。
