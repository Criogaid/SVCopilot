# P1-C PitchControl 调音写面实施 GOAL

> 本文是可直接交给长期 GOAL 执行的任务契约，不是新的产品路线图。
> 产品优先级、能力边界和里程碑仍以
> [music-workflow-roadmap.md](music-workflow-roadmap.md)
> 为唯一事实源。本文只细化其中 M3/P1-C，并记录与 P1-B、手动音高规划、computed-pitch
> bake 和和声规划的受控衔接。完成后应更新主计划并将本文归档。

## 1. GOAL 元数据

| 字段 | 值 |
| --- | --- |
| 类型 | 长期实施 GOAL / 阶段验收清单 |
| 状态 | `ready`，写入发布受真实 SynthV 宿主门禁约束 |
| 主目标 | 交付可快照、可规划、可 dry-run、可原子提交、可读回验证、可补偿回滚的 PitchControl 高层能力 |
| 权威上位文档 | `music-workflow-roadmap.md` 的 P0-A、P1-B、P1-C 与 M3 |
| 实施基线 | SVCopilot `8c8c66a` |
| 目标宿主 | Synthesizer V Studio Pro 2.1+；发布证据以当前 2.2.1 实机为准 |
| 外部研究样本 | `Hrauroras/SV2-Script`，研究提交 `f0ba9509d490007ef5956864366e5f73ad308bc9` |
| 外部代码许可 | MIT；默认采用 clean-room 重写，不引入运行时依赖 |
| 日期 | 2026-07-27 |

## 2. 可直接用于 GOAL 的目标陈述

在不突破 Synthesizer V 官方脚本 API、现有 SVCopilot 事务诚实性和 shared-target
安全边界的前提下，实现 P1-C PitchControl 高层快照与事务编辑；先用 SV Live Probe
取得真实宿主对 Point/Curve 创建、插入排序、clone、修改、删除、scriptData 和坐标语义的
机器可读证据，再交付严格 schema、范围快照、原子 patch、纯规划器、可选 computed-pitch
bake 以及显式调用者批准的调式和声扩展。所有写入必须支持 dry-run、no-change、一个 Undo、
journal、读回验证和逆序补偿；任何证据不足、上下文陈旧、共享 target 未确认、单位混用或
computed pitch 全 null 的情况都必须在写入前失败。只有离线回归、MCP smoke、Lua dispatcher
测试和真实宿主验收全部通过，文档与 capabilities 同步，且工程状态恢复后，才可将 GOAL
标记为完成。

## 3. 最终用户价值

完成后，MCP 使用者应能在不操作 raw handle 的情况下：

1. 在 `sv_snapshot_range` 中读取指定 occurrence 的 PitchControlPoint 和
   PitchControlCurve，看到明确的类型、单位、本地坐标、绝对坐标、所有权和分页信息。
2. 用一个 `sv_patch_pitch_controls` 请求安全地新增、修改、删除或替换多个 PitchControl，
   并获得可审阅 diff、实际效果、Undo 数量、读回证据和失败恢复结果。
3. 用纯规划器把“起音上滑、句尾下坠、转音、颤音”等音乐意图转换成统一 `apply` 信封，
   再选择 dry-run 或 commit；规划器本身不触碰宿主。
4. 在 computed pitch 覆盖充足时，显式地把宿主计算结果 bake 为 PitchControlCurve；
   覆盖不足或全 null 时保证零写入。
5. 在调用者明确提供并批准调式/音阶时生成比当前自然大小调三度/六度更丰富的和声计划，
   同时保留现有 Krumhansl-Schmuckler 分析器的歧义表达。

## 4. 范围

### 4.1 必须完成

- P0-A 中与 PitchControl 直接相关的真实宿主语义验收。
- `sv_snapshot_range include:["pitchControls"]`。
- `sv_patch_pitch_controls` 的 Point/Curve 新增、修改、删除、no-change、dry-run、commit
  和 rollback。
- strict MCP input schema、可拆分 schema resource、capabilities 预算和工作流指南。
- context、occurrence、UUID/fingerprint、shared-target、一个 Undo、journal、read-back
  和补偿回滚。
- 非零 occurrence `timeOffsetBlick`/`pitchOffsetSemitone` 的坐标与读回验证。
- 假宿主故障注入回归与真实宿主正常路径验收。

### 4.2 事务内核完成后才允许继续

- 手动音高变化纯规划器。
- computed-pitch bake。
- 显式音阶与广义音程和声扩展。
- 与 P1-B 连续 Automation 变换共用的事务基础设施提取。

这些能力不能延迟 P1-C 基础读写的验收，也不能在基础事务未通过真机门禁时扩大写面。

### 4.3 明确不做

- 不复制 `SV2-Script` 的 SidePanel UI、WidgetValue 状态管理或宿主内交互界面。
- 不把外部脚本作为包、子模块或运行时依赖。
- 不用 UI 自动化填补官方 API 缺口。
- 不实现音频渲染、机器听感评价、Singer/声库枚举或宿主 Undo 调用。
- 不把 computed pitch 全 null 解释为零音高、已完成或可 bake 数据。
- 不用外部脚本的朴素音阶成员计数替换现有 K-S 调性分析。
- 不自动删除、覆盖或重写不属于 SVCopilot 的 PitchControl。
- 不在同一 NoteGroup 内直接复制和声音符而制造重叠；继续使用独立 target occurrence。
- 不顺带实现完整 P1-B `resample_transform`，除非为共享事务接口所需；P1-B 仍按主计划单独验收。

## 5. 不可破坏的约束

### 5.1 事务诚实性

1. 所有 mutation 前完成参数、schema、上下文、目标身份、shared-target、预算和单位预检。
2. dry-run 和 no-change 不调用宿主写 API，不创建 Undo。
3. 正式提交最多创建一个用户可见 Undo。
4. 第一次宿主写之前建立完整 journal；不能重建的对象必须保留 clone。
5. 每一步写入后都以宿主读回为准，不信任 setter/remove 的返回值。
6. 失败时逆序补偿并再次读回；无法证明恢复时返回 `rollback_failed`/`outcome_unknown`，
   不得伪报 `unchanged`。
7. 一旦写入已读回验证为成功，后续 processing observation 失败只能降级为
   `processing_observation_failed` 警告，不能把已验证提交重分类为可重试失败。
8. 响应必须明确区分 `effects`、`outcome`、`undo`、`rollback`、`verification` 和
   `timings`。

### 5.2 身份和并发

1. 写接口必须接受 `contextId + occurrenceId`，并支持 range context。
2. mutation 前重新读取目标组 UUID 和内容 fingerprint；不匹配返回冲突，零写入。
3. 一个 target group 被多个 reference 复用时，必须列出全部 occurrence 影响面并要求显式确认。
4. PitchControl 没有宿主 UUID：
   - SVCopilot 新建对象写入 namespaced scriptData ID；
   - 外部/无标签对象使用 context-scoped `controlId`，由捕获索引和完整内容 fingerprint 派生；
   - commit 时重新解析，零匹配或多匹配均失败，不能“取第一个”。
5. 添加或删除导致宿主重新排序后，不再复用旧索引；后续步骤必须通过 journal identity
   或重新解析后的 fingerprint 定位。

### 5.3 所有权

1. SVCopilot 自有标记使用稳定命名空间，例如：

   ```text
   svcopilot.owner = "svcopilot"
   svcopilot.controlId = "<opaque-id>"
   svcopilot.generator = "<planner-name>"
   svcopilot.schemaVersion = "<version>"
   ```

2. `mm_Flag`、`pfb_v1` 等外部标记只作为来源提示，不代表 SVCopilot 所有权。
3. 默认删除/范围替换只操作本次请求明确定位的对象或 SVCopilot 自有对象。
4. 触碰无标签或外部所有对象必须逐对象显式指定、携带 expected fingerprint，并在 review
   中突出显示。
5. 不调用 `clearScriptData()`；clone/重建和 rollback 必须保留其他脚本的 scriptData。

### 5.4 单位与坐标

下列量不能共用无标签数值字段：

| 数据 | 单位 | 坐标 |
| --- | --- | --- |
| PitchControlPoint pitch | semitone | 相对 NoteGroup pitch offset |
| PitchControlCurve anchor pitch | semitone | 相对 NoteGroup pitch offset |
| PitchControlCurve point value | semitone | 相对 curve anchor pitch |
| `pitchDelta` Automation | cents | group-local time |
| Note detune | cents | note 属性 |
| PitchControl position | integer BLICK | group-local |
| occurrence absolute position | integer BLICK | `timeOffsetBlick + local` |
| occurrence absolute pitch | semitone | `pitchOffsetSemitone + group-relative pitch` |

任何 API 响应和错误证据都必须重复单位；不得要求客户端凭字段名猜测。

### 5.5 资源和性能

1. 运行量由对象数、曲线点数和采样预算决定，不能随 BLICK 数值跨度线性增长。
2. 范围快照先执行预算，再序列化；超出响应预算时使用现有 detail pointer/cursor，从缓存分页，
   不重新读取宿主。
3. 任何 hard limit 必须同时出现在 schema、capabilities、错误证据和测试中。
4. 大数组不得在 `observed`、`result`、`exports` 中重复三份；compact 响应只返回摘要和 pointer。
5. 不把 MCP SDK/dispatcher 不可观测等待错误计入 `operationMs`；timings 沿用当前明确的可观测边界。

### 5.6 仓库保护

- 不删除、清空、迁移或批量改写 `.serena/`、`.codegraph/`、`.codex/`。
- 不清理、重建或擅自修改 `.gitignore`。
- 不回滚用户已有变更，不提交无关格式化或生成时间戳噪声。
- 外部仓库只放临时目录；不得复制其 `.git`、缓存或构建产物进 SVCopilot。

## 6. 证据来源与外部研究样本

证据优先级从高到低：

1. 当前真实宿主的可重复读回证据；
2. 仓库内带 SHA-256 的 `api-docs/api-manifest.json` 和官方页面镜像；
3. Dreamtonics 在线 Scripting Manual：
   - [PitchControlPoint](https://resource.dreamtonics.com/scripting/PitchControlPoint.html)
   - [PitchControlCurve](https://resource.dreamtonics.com/scripting/PitchControlCurve.html)
   - [NoteGroup](https://resource.dreamtonics.com/scripting/NoteGroup.html)
   - [SV.getComputedPitchForGroup](https://resource.dreamtonics.com/scripting/SV.html#getComputedPitchForGroup)
4. 外部开源脚本的实践样本；
5. 推断或设计偏好。

低优先级来源不能覆盖高优先级证据。官方文档没有写死的排序、attached mutation、clone、
scriptData 和 float 行为必须进入 Phase 0 测量，不能根据外部脚本“能跑”直接定为契约。

参考仓库：[Hrauroras/SV2-Script](https://github.com/Hrauroras/SV2-Script)

| 来源 | 可以借鉴 | 禁止直接继承 |
| --- | --- | --- |
| `ManualMode.js` | transition、attack/release、vibrato 的参数模型；用 TimeAxis 把秒/Hz 转为 BLICK；相邻音符边界思路 | SidePanel UI；模式切换批量删除；任意改写重叠对象；未限幅三次插值 |
| `PitchFixBrush.js` | computed pitch -> PitchControlCurve 的数据流；创建/插入/清理的 API 顺序；所有权标签意识 | 删除范围内所有 PitchControl/pitchDelta；固定 BLICK 步进；不检查 null 覆盖率；无回滚 |
| `Harmony.js` | 14 类音阶目录；广义 2/3/4/5/6/7 度、方向与八度的表达 | 朴素自动调性检测；把最高分当事实；同组复制和声；主观“避免不和谐”规则 |

实施政策：

1. 默认只提取行为与数学需求，由执行者重新设计接口和实现。
2. 如果复制了具有表达性的代码或大量常量，必须保留 MIT 许可证与版权通知，并在
   `THIRD_PARTY_NOTICES` 或等效文件记录来源。
3. 不复制来源不清晰的 `ManualMode` 大段实现；优先用公式、测试向量和独立命名 clean-room 重写。
4. 外部脚本没有测试、事务、shared-target 或 read-back，它只能作为 API 使用样本，不能作为正确性证据。

## 7. 目标架构

```text
sv_snapshot_range(include: pitchControls)
  -> Snapshot/Context Store
  -> PitchControl normalizer + identity/fingerprint
  -> budget/detail pointer

pure planner
  -> review + apply { tool, arguments }
  -> sv_patch_pitch_controls(dryRun: true)
  -> sv_patch_pitch_controls(dryRun: false)
  -> transaction journal
  -> one Undo
  -> host mutation
  -> read-back verification
  -> reverse compensation on failure
  -> optional processing observation
```

设计原则：

- 读模型、规划器和写事务分层；规划器不能持有 host handle。
- 优先复用现有 range context、SnapshotStore、严格 schema、ExecutionCoordinator、
  shared-target、fingerprint、Undo、journal、read-back、response envelope 和 timings 模式。
- 如果 PitchControl 与 Automation 需要共用基础设施，提取最小共享 transaction kernel；
  不让批量接口通过循环调用单对象 MCP 工具来伪装事务。
- Lua dispatcher 只增加官方 API 所需的通用可验证调用能力，不加入面向测试的生产后门。

## 8. 规范化读模型

### 8.1 Snapshot 示例

```json
{
  "occurrenceId": "ctx_x:t:6:r:1",
  "targetGroupUuid": "uuid",
  "timeOffsetBlick": 2822400000,
  "pitchOffsetSemitone": 0,
  "pitchControls": [
    {
      "controlId": "pc_ctx_x_0",
      "kind": "point",
      "indexInGroup": 0,
      "position": {
        "groupLocalBlick": 705600000,
        "occurrenceAbsoluteBlick": 3528000000
      },
      "pitch": {
        "groupRelativeSemitone": 60,
        "occurrenceAbsoluteSemitone": 60
      },
      "ownership": {
        "owner": "external_or_unknown",
        "scriptDataKeys": ["mm_Flag"]
      },
      "fingerprint": "sha256:..."
    },
    {
      "controlId": "pc_owned_...",
      "kind": "curve",
      "indexInGroup": 1,
      "anchor": {
        "groupLocalBlick": 1411200000,
        "occurrenceAbsoluteBlick": 4233600000,
        "groupRelativeSemitone": 64,
        "occurrenceAbsoluteSemitone": 64
      },
      "points": [
        {
          "timeFromAnchorBlick": -1000,
          "pitchFromAnchorSemitone": -0.2
        },
        {
          "timeFromAnchorBlick": 1000,
          "pitchFromAnchorSemitone": 0.3
        }
      ],
      "ownership": {
        "owner": "svcopilot",
        "generator": "manual_pitch_gesture"
      },
      "fingerprint": "sha256:..."
    }
  ]
}
```

### 8.2 Fingerprint 最低内容

- discriminator；
- 捕获时 `indexInGroup`，只作提示而非永久身份；
- position、pitch；
- Curve 的完整有序 points；
- 所有权命名空间中的值；
- 目标 group UUID；
- 对象数量和相邻对象摘要，用于识别排序变化。

外部 scriptData 的任意值不必暴露给客户端，但 clone/rollback 必须保存；对外至少返回安全的 key
列表和识别出的 owner。

## 9. 写接口草案

### 9.1 `sv_patch_pitch_controls`

```json
{
  "contextId": "ctx_x",
  "occurrenceId": "ctx_x:t:6:r:1",
  "target": {
    "expectedGroupUuid": "uuid",
    "expectedPitchControlFingerprint": "sha256:...",
    "confirmSharedTarget": true
  },
  "operations": [
    {
      "op": "add",
      "control": {
        "kind": "point",
        "positionBlick": 705600000,
        "pitchSemitone": 60
      }
    },
    {
      "op": "update",
      "controlId": "pc_owned_...",
      "expectedFingerprint": "sha256:...",
      "set": {
        "anchorPositionBlick": 1411200000,
        "anchorPitchSemitone": 64,
        "points": [
          {
            "timeFromAnchorBlick": -1000,
            "pitchFromAnchorSemitone": -0.1
          },
          {
            "timeFromAnchorBlick": 1000,
            "pitchFromAnchorSemitone": 0.2
          }
        ]
      }
    },
    {
      "op": "delete",
      "controlId": "pc_ctx_x_0",
      "expectedFingerprint": "sha256:..."
    }
  ],
  "atomic": true,
  "dryRun": true,
  "responseMode": "compact"
}
```

Schema 要求：

- 顶层、operation union 和所有嵌套对象均 `additionalProperties:false`。
- `op` 和 `kind` 使用 discriminator；错误只报告已选分支。
- 所有时间是安全整数，所有 pitch 是有限数。
- Curve points 按相对时间严格递增；重复时间、NaN/Infinity、空 Curve、超预算均在宿主调用前拒绝。
- 同一请求不能重复定位同一 control；解析后再次执行唯一性检查。
- 第一版 `atomic` 固定为 `true`；不支持的 false 必须拒绝，不能静默忽略。
- `responseMode` 复用 compact/standard/verbose 契约。

### 9.2 统一响应

至少返回：

```json
{
  "ok": true,
  "status": "succeeded",
  "effects": "verified",
  "outcome": "changed",
  "target": {
    "targetGroupUuid": "uuid",
    "affectedOccurrences": ["ctx_x:t:6:r:1"]
  },
  "changes": {
    "planned": 3,
    "actuallyChanged": 3,
    "added": 1,
    "updated": 1,
    "deleted": 1
  },
  "undo": {
    "recordCreated": true,
    "expectedUserUndoSteps": 1
  },
  "verification": {
    "attempted": true,
    "passed": true,
    "basis": "host_read_back"
  },
  "rollback": {
    "attempted": false
  },
  "timings": {
    "serviceTotalMs": 0,
    "preflightReadMs": 0,
    "operationMs": 0,
    "verificationMs": 0
  }
}
```

no-change 必须返回 `actuallyChanged:0`、`recordCreated:false`、`hostWrites:0`。

## 10. 分阶段实施

每一阶段都必须先完成测试和验收门，再开始下一阶段。不得在最后一次性把所有 checklist
改为完成。

### Phase 0：真实宿主语义基线

目标：在扩大生产写面前，证明官方文档没有覆盖的实际行为。

任务：

- [ ] 准备独立、可恢复的小型 PitchControl fixture，包含非零 occurrence time/pitch offset。
- [ ] 用 SV Live Probe 创建 Point，设置 position/pitch，加入 NoteGroup，逐字段读回。
- [ ] 用 SV Live Probe 创建 Curve，设置 anchor/points，加入 NoteGroup，逐字段和 `getValueAt`
      读回。
- [ ] 验证 `addPitchControl` 的排序规则和相同 anchor 的稳定性/不稳定性。
- [ ] 验证 attached 对象能否安全原位 set；若宿主行为不稳定，确定 clone -> replace 策略。
- [ ] 验证 Point/Curve `clone()` 是否深拷贝 points 和 scriptData，且 clone 未附着。
- [ ] 验证 `removePitchControl(index)` 后对象、索引和 parent 的状态。
- [ ] 验证 scriptData 对 string/number/boolean/JSON-like 值的 round-trip 和 clone 行为。
- [ ] 验证带 timeOffset/pitchOffset occurrence 的本地/绝对坐标公式。
- [ ] 验证同 target 多 reference 的修改在所有 occurrence 中可见。
- [ ] 把 fixture 恢复到测试前状态，记录 Undo 数量和恢复读回。
- [ ] 生成脱敏机器可读 JSON，包含 hostVersion、interfaceVersion、fixture hash、时间戳、
      请求、观测值和结论。

阶段门：

- Point/Curve 创建、加入、排序、clone、remove 和 scriptData 必须都有明确结论。
- 任何结论不确定时，生产写接口保持不可用；只读快照可以继续。
- 不为通过测试向正式 dispatcher 加任意故障注入。

### Phase 1：只读快照与身份模型

目标：先让用户看得见、分页可控、坐标无歧义。

任务：

- [ ] 定义 Point/Curve strict schema 和规范化函数。
- [ ] 扩展 range snapshot `include:["pitchControls"]`。
- [ ] 生成 context-scoped controlId、fingerprint 和 ownership 摘要。
- [ ] 同时返回 group-local 与 occurrence-absolute 时间/音高。
- [ ] 接入现有 budgets/detail pointer；后续页必须从缓存展开。
- [ ] 给 capabilities 公布 per-control、per-curve-point、per-snapshot 和响应预算。
- [ ] 对宿主返回的非数组 table envelope 做规范化，禁止 `$sv` 等内部键泄漏为业务数据。
- [ ] 给空组、无 PitchControl、多个相同对象、非零 offset 和 shared target 补回归。

阶段门：

- 只读功能可以独立发布预览，但必须标记写入能力是否仍受 host gate 阻塞。
- cursor 页面 `operationMs` 应接近零，且测试证明未重新读取宿主。

### Phase 2：原子 `sv_patch_pitch_controls`

目标：交付 P1-C 的安全写入基础原语。

任务：

- [ ] 实现 add/update/delete 的完整预检与 normalized plan。
- [ ] 在执行前重新验证 context、UUID、group fingerprint、control fingerprint 和 shared target。
- [ ] 实现自有 scriptData ID；外部对象保持原所有权数据。
- [ ] 建立完整 journal；对象 clone 或可重建状态必须在第一次写前完成。
- [ ] 只在实际变化前创建一个 Undo。
- [ ] 执行后重新枚举并按 fingerprint/owned ID 读回，不依赖旧索引。
- [ ] float 采用与现有 Automation 相同级别的绝对+相对 epsilon；BLICK 和点数量精确比较。
- [ ] 任一步失败时逆序补偿并验证恢复。
- [ ] processing observation 只作为提交后附加信息。
- [ ] 提供 compact/standard/verbose；大 points 只在 verbose 或 pointer 中出现。
- [ ] 注册完整 MCP tool schema 和按工具可读取的 schema resource。
- [ ] MCP description 中提供最小可运行的 snapshot -> dry-run -> commit 示例。

阶段门：

- 假宿主覆盖每个 commit 边界的失败和 rollback。
- 真实宿主 add/update/delete 各至少一次成功，并恢复 fixture。
- no-change、dry-run 均为零 Undo、零 host write。
- shared-target 未确认时零写入。

### Phase 3：手动音高变化纯规划器

目标：把音乐意图转换成可审阅的 PitchControl patch，不直接写宿主。

建议工具名：`sv_plan_pitch_gesture`。

第一版支持：

- note transition：offset、width、depth、direction；
- attack/release：起止位置、深度、曲线形状；
- vibrato：start、fade-in、fade-out、frequency、depth、phase；
- 邻接音符约束和可选 boundary guard；
- 以秒或音符比例表达意图，经 TimeAxis 转换为整数 BLICK。

任务：

- [ ] 设计与现有规划器一致的 `review + apply { tool, arguments }` 信封。
- [ ] 规划器只依赖 range context 数据，不读取或写入 raw handle。
- [ ] 每个生成对象带 SVCopilot ownership/generator 标签。
- [ ] 定义 depth、frequency、phase、时间参数的合理范围和显式 clamp warning。
- [ ] 使用有界、不超调的确定性插值；不要沿用名称与实现不符的“monotonic cubic”。
- [ ] 处理短音、相邻重叠、休止、共享 target、非零 offset 和跨多音符的音高变化。
- [ ] planner 输出必须通过真实 `sv_patch_pitch_controls` served schema。

阶段门：

- Golden tests 覆盖 transition、attack、release、vibrato、极短音符和边界。
- 相同输入产生字节稳定的 normalized plan。
- planner 测试证明零宿主写入；apply 仍必须显式 dry-run/commit。

### Phase 4：computed-pitch 安全 bake

目标：在有效数据存在时，把宿主计算音高显式固化为 Curve，同时保证跨数据面的恢复。

建议工具名：`sv_bake_computed_pitch`。

前置条件：

- computed pitch 请求的 start/interval/count 必须从 snapshot sampling 明确继承或由请求显式给出；
- 只接受有限数值覆盖达到阈值的数据；
- all-null、空数组、处理中、覆盖不足或采样身份不匹配均零写入；
- 请求必须明确 bake 范围和策略。

策略至少区分：

- `preserve_existing`：只在无冲突区域新增自有 Curve；
- `replace_owned`：只替换 SVCopilot 自有 Curve；
- `replace_explicit`：调用者逐对象确认可替换对象；
- 不提供“删除范围内所有对象”的默认模式。

任务：

- [ ] 把 absolute MIDI computed pitch 转成 group-relative curve anchor + point offsets。
- [ ] 采用明确的帧/点预算和确定性简化，不使用固定 BLICK 间隔遍历巨大范围。
- [ ] 保留端点、有效区间边界和局部极值；报告最大拟合误差与 coverage。
- [ ] 明确处理原有 `pitchDelta`：默认保留；若显式清除，PitchControl 与 Automation 必须进入
      同一个跨类型 journal/Undo/rollback。
- [ ] commit 后独立重采样/读回验证，不把原输入当作证据。
- [ ] 输出 `sourceSampling`、`finiteFrames`、`nullFrames`、`coverage`、`fitError` 和修改范围。

阶段门：

- all-null fixture 明确返回 `INSUFFICIENT_COMPUTED_PITCH` 或现有等价错误，零写入、零 Undo。
- 有效 fixture 的 bake、读回和恢复在真机通过。
- 第二数据面写失败的故障注入证明第一数据面会补偿恢复。
- 不宣称该工具能够解决宿主一直返回全 null 的问题。

### Phase 5：显式批准的音阶与和声扩展

目标：利用外部样本的音阶/音程表达扩展现有和声 planner，而不降低分析诚实性。

任务：

- [ ] 把音阶目录做成明确 enum/catalog：七种调式、harmonic/melodic minor、major/minor
      pentatonic、blues、whole-tone、chromatic。
- [ ] 支持广义 2/3/4/5/6/7 度、unison、above/below 和 octave displacement。
- [ ] 第一版只接受调用者明确提供并批准的 tonic/scale；不自动选择扩展音阶。
- [ ] 现有 K-S analyzer 保持不变；分析歧义仍返回多候选和 evidence scope。
- [ ] planner 继续写入独立 target occurrence，复用 unified apply envelope 和 restructure 工具。
- [ ] 调外音、和声音域、交叉声部和重复位置返回 review warning，不用主观“好听/不和谐”断言。

阶段门：

- 每类 scale 有 pitch-class golden fixture。
- direction/octave/degree 有属性测试。
- 呼吸音符不进入和声统计。
- planner 输出通过 served schema，且不直接修改工程。

### Phase 6：发布收口

任务：

- [ ] 更新 interfaceVersion/schemaVersion/server version。
- [ ] 更新 capabilities、README 工具表、`docs/architecture.md`、workflow guide 和 HANDOFF。
- [ ] 更新主计划 P0-A/P1-C/M3 状态；未完成能力继续标为 host-gated/deferred。
- [ ] 为 snapshot、patch、planner、bake 分别提供小型 schema resource，避免单资源截断。
- [ ] 记录外部参考与许可证决策。
- [ ] 运行全量 Node 测试、MCP smoke、Lua dispatcher 测试和 api-docs drift 检查。
- [ ] 执行真实宿主 acceptance checklist，恢复工程并记录最终状态。
- [ ] 确认工作树只包含本 GOAL 范围内的有意改动。
- [ ] 完成后将本文移入 `docs/archive/YYYY-MM/`，主计划继续作为唯一未来路线图。

## 11. 测试矩阵

### 11.1 离线单元与属性测试

| 区域 | 必测场景 |
| --- | --- |
| Schema | 未知字段、错误 discriminator、NaN/Inf、非整数 BLICK、空 Curve、重复 point time、超预算 |
| Normalization | Point/Curve、typed-v2 table envelope、空数组、scriptData keys、float32 |
| 坐标 | 零/非零 timeOffset、零/非零 pitchOffset、local -> absolute -> local round-trip |
| Identity | owned ID、unowned fingerprint、重复相同对象、排序变化、陈旧 index、零/多匹配 |
| Snapshot | 空组、单组、多 occurrence、shared target、budget、cursor、cached detail |
| Planner | 确定性、边界、短音、相邻音、单位、clamp warning、served schema 一致性 |
| Bake | finite/all-null/partial-null、coverage threshold、简化误差、预算、pitchDelta 策略 |
| Harmony | 14 类 scale、degree/direction/octave、歧义、调外音、呼吸排除 |

### 11.2 假宿主事务测试

每个写阶段至少注入一次失败：

1. preflight read；
2. clone/journal capture；
3. 第一个 remove；
4. 第一个 add；
5. 中间 operation；
6. Undo 创建前后；
7. read-back；
8. rollback remove；
9. rollback restore；
10. post-commit processing observation。

每项断言：

- 实际宿主调用序列；
- Undo 数量；
- 最终对象全集与 scriptData；
- `effects/outcome/rollback/verification`；
- 是否允许客户端重试；
- 是否遗留 handle。

### 11.3 真实宿主验收

| 场景 | 必须记录 |
| --- | --- |
| Point add/update/delete | 排序前后、字段读回、Undo、UI 可见性、最终恢复 |
| Curve add/update/delete | anchor、points、`getValueAt`、clone、Undo、最终恢复 |
| 相同 anchor | 宿主排序和 identity 解析 |
| 非零 offsets | local/absolute time 和 pitch |
| shared target | 两个 occurrence 的同步可见结果和确认门 |
| scriptData | 新建、clone、删除补偿后的保留情况 |
| float | 请求值、宿主读回值、delta、epsilon |
| computed bake | sampling、coverage、拟合误差、读回、清理 |
| processing failure | 写入仍是 verified，附加 warning |

验收脚本只操作固定 disposable fixture；每轮前后都读取完整 fingerprint。无法恢复时立即停止后续写测。

## 12. 错误与重试语义

优先复用现有错误码；只有无法准确表达时才新增。至少覆盖以下语义：

| 条件 | 结果 | 可否原样重试 |
| --- | --- | --- |
| schema/单位/预算错误 | `effects:none`、`outcome:unchanged` | 否，先改请求 |
| context 过期/目标 fingerprint 变化 | stale/conflict、零写入 | 否，重新 snapshot 和规划 |
| shared target 未确认 | 零写入并返回影响 occurrence | 否，人工/调用者确认后新请求 |
| control 零匹配或多匹配 | unknown/ambiguous、零写入 | 否，重新 snapshot |
| commit 失败且补偿验证成功 | `rolled_back` | 不能盲重试；先刷新上下文 |
| commit 失败且无法证明补偿 | `outcome_unknown` | 绝对不能自动重试 |
| commit 验证成功、processing 失败 | `effects:verified` + warning | 不重试写入 |
| computed pitch 覆盖不足 | 零写入、附 coverage evidence | 可等待/重新采样，不可直接 bake |

错误证据不能只给文字；必须包含 relevant observed、expected、delta、对象/operation 索引和 phase。

## 13. 性能与预算验收

具体数值先由 Phase 0/1 benchmark 校准，但以下性质是硬性要求：

1. 相同对象数和点数下，把范围扩大 1000 倍不能使运行时间近似扩大 1000 倍。
2. snapshot detail cursor 页面不重新调用宿主。
3. dry-run 不构建无关 NoteGroup detached clone；只读取 PitchControl 事务所需状态。
4. batch 必须在一次 coordinator operation 中完成，不能通过四次外层 MCP 循环实现。
5. 每个响应返回：
   - `serviceTotalMs`
   - `preflightReadMs`
   - `planningMs`
   - `operationMs`
   - `verificationMs`
   - `rollbackMs`（若发生）
   - dispatcher queue 不可观测时明确为 `null`
6. 固定 fixture 预热后至少运行 20 次，报告 median/p95；不得把一次最好结果写入发布说明。
7. 超预算必须发生在 Undo 和第一次写之前。

## 14. 交付物

- PitchControl 真实宿主证据 JSON 和简短结论。
- snapshot 读模型、identity/fingerprint、budget/cursor 实现。
- `sv_patch_pitch_controls` 服务、严格 schema、MCP 注册和资源。
- Point/Curve 正常路径、边界、故障注入和 rollback 测试。
- 可选 `sv_plan_pitch_gesture` 及 golden fixtures。
- 可选 `sv_bake_computed_pitch` 及有效/全 null fixture。
- 可选显式 scale/interval 和声扩展。
- 更新后的 capabilities、README、architecture、workflow guide、HANDOFF 和主计划状态。
- 许可证/来源记录。
- 全量验证日志与恢复后的宿主工程 fingerprint。

## 15. Definition of Done

只有同时满足以下条件，GOAL 才算完成：

- [ ] Phase 0--2 全部完成，真实宿主证据可复现。
- [ ] Point/Curve add/update/delete/no-change/dry-run/rollback 全覆盖。
- [ ] 单位、local/absolute 坐标、nonzero offsets 均有回归。
- [ ] shared target、stale context、重复 control 和外部 ownership 均安全失败。
- [ ] 正式提交最多一个 Undo，no-change/dry-run 为零 Undo。
- [ ] 每个 commit 阶段的故障注入都证明最终状态或诚实报告未知。
- [ ] post-commit processing 失败不会诱导重复写入。
- [ ] schema 自描述完整，未知字段严格拒绝，按工具 resource 可独立解析。
- [ ] full Node suite、MCP smoke、Lua dispatcher 和 api-docs drift 全绿。
- [ ] host acceptance 正常路径全绿，测试工程恢复并记录最终 fingerprint。
- [ ] 所有对外文档和 version/capabilities 同步。
- [ ] 外部来源与 MIT 义务处理完毕。
- [ ] `.serena/`、`.codegraph/`、`.codex/` 和 `.gitignore` 未被清理或擅改。
- [ ] 主计划状态更新；本文归档，不形成第二份长期路线图。

Phase 3--5 属于条件扩展：若执行期间因宿主证据或预算决定延期，必须在主计划中逐项标为
`deferred`/`host-gated` 并保留证据。不能为了宣称 GOAL 完成而把未实现项写成已完成。若本次
GOAL 的明确目标包含这些条件扩展，则相应阶段 checklist 也必须全部完成后才可结束。

## 16. 必须停止并上报的条件

出现以下任一情况时，不得自行放宽契约：

- 真实宿主的 clone/remove/scriptData 行为无法支持可靠 journal 或补偿。
- 同一 target 的多个 occurrence 无法在 mutation 前完整识别。
- 宿主实际坐标语义与官方文档或 manifest 冲突。
- rollback 后无法证明对象全集、顺序、points 和 scriptData 恢复。
- 需要删除未知所有权对象才能让正常路径工作。
- computed pitch 持续全 null，而 bake 是当前阶段唯一前进路径。
- 只能靠 UI 自动化或私有 API 才能实现需求。
- 需要破坏当前已发布的事务诚实性、raw escape hatch 或上下文契约。

上报必须包含：最小复现、宿主版本、fixture fingerprint、预期/实际、调用序列、恢复状态和可选设计分支。

## 17. 每轮 GOAL 进度报告格式

```markdown
## 本轮结果

- 当前阶段：
- 完成项：
- 新证据：
- 测试：
- 真机状态：
- 工程是否已恢复：

## 未完成

- 下一项：
- 阻塞：
- 风险：

## 工作区

- HEAD：
- 已修改文件：
- 未提交原因：
```

进度报告必须区分“离线测试通过”“MCP 协议通过”“真实宿主验证通过”，不能用前两者替代第三者。
