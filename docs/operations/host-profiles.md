# SV Live Probe 宿主 Profile 工作流

## 目的

离线 fake host 适合验证事务、故障注入和确定性算法，但不能自行证明 Synthesizer V 的实际
宿主语义。Host Profile 把二者连接起来：

```text
SV Live Probe（只读）/ 可恢复 live acceptance
  -> 内存中去身份化与严格校验
  -> 版本化 Host Profile
  -> fake host 语义 adapter
  -> 完全离线的 contract tests
```

Profile 只描述宿主行为证据，不复制工程。音符、曲线、歌词和故障注入仍由各测试场景显式
提供。

## 采集

前提：`scripts/SVLiveProbe` 守护进程和 SynthV 内的 Lua 脚本已启动。

从 `server/` 执行：

```powershell
npm run host-profile:capture
```

默认把候选写到：

```text
%LOCALAPPDATA%\SVCopilot\host-profiles\candidates\
```

默认不修改仓库。显式生成候选文件：

```powershell
npm run host-profile:capture -- `
  --output ..\server\host-profiles\candidate.json
```

与已有 profile 比较：

```powershell
npm run host-profile:capture -- `
  --baseline ..\server\host-profiles\synthv-2.2.1-win32-v2.json
```

已有输出不会被覆盖；必须显式传 `--force`。`npm test` 只读取已提交 fixture，不启动
SynthV，也不重写 profile。`--repeat` 最少为 2，单次全 `null` 观察不能晋升为“稳定”事实。

## 证据契约

每项语义只有五种状态：

| 状态 | 含义 |
| --- | --- |
| `confirmed` | 当前 host selector 下有对应证据，可以驱动严格模拟 |
| `partially_observed` | 已确认部分映射或边界，但不足以启用完整能力 |
| `contradicted` | 不同证据相互冲突，禁止选一个覆盖另一个 |
| `unknown` | 已观察但无法区分候选语义 |
| `not_observable` | 当前只读套件原则上无法证明，需要可恢复写测 |

`unknown`、`not_observable` 和 `contradicted` 禁止携带推测值；`partially_observed` 只能携带
证据实际覆盖的部分结果。profile 严格拒绝未知字段、
项目路径、track/group 名称、target UUID、歌词、音素以及原始数组。每条 evidence 还必须
声明它支持的 semantic key；confirmed 值必须满足该 key 的值域、来源和证据等级，并通过
内容 SHA-256 校验。

当前 `synthv-2.2.1-win32-v2` 汇总只读和可恢复写测证据，确认：

- `SV.QUARTER = 705600000`。
- `NoteGroupReference` 的 onset/end 不能由 `timeOffset + 首尾音符` 推导；reference 可有独立
  裁剪或留白。
- pending computed pitch 以请求长度的全 `null` 数组表示。
- 600 个 constant（无 BPM 变化）/ tempo-step（范围内恰好一次 BPM 变化）/
  dense-tempo（范围内至少两次 BPM 变化）样本的 Node/宿主秒轴最大偏差为
  `1.4210854715202004e-14` 秒，因此不需要 T03 批量换算 opcode。
- Automation 没有公开 interpolation setter；当前宿主的 PitchControl `getValueAt` 证据为
  13 样本 piecewise-linear。
- 宿主 `vibratoEnv` 与显式 `pitchDelta` 叠加；显式颤音事务会把目标范围内的
  `vibratoEnv` 置零以避免双重振音。

它仍未确认 computed-pitch 坐标和 `pitchDelta`/PitchControl 共存优先级；绝对 MIDI 到
group-local PitchControl 的变换只有 `partially_observed`。这些状态会让相应能力关闭失败，
不能用 simulator 默认值补齐。

## Fake Host 接入

普通测试保持原样：

```js
const model = createPitchHostModel({ controls });
```

需要检查宿主证据覆盖时：

```js
const model = createPitchHostModel({
  hostProfile,
  evidencePolicy: "require-confirmed",
  controls,
});
```

`require-confirmed` 在代码实际触及未确认语义时抛
`UNCONFIRMED_HOST_SEMANTIC`。宽松模式仍允许确定性 simulator fallback，但
`model.semanticCoverage()` 会明确标为 `simulator_default`，不能宣称是真机行为。
profile diff 同时比较 host selector、producer、evidence、constants 和 semantics，常量漂移
不会再被“语义未变”掩盖。

工程观测不会自动成为默认场景。比如当前 all-null computed pitch 必须通过
`computedPitchScenarioFromProfile(profile)` 显式选用；普通 fake host 仍可构造 ready、partial、
all-null 等独立测试场景。

## API 表面比对（api-surface）

上面那套 profile 验证的是宿主**语义**（H2 颤音交互、TimeAxis 精度等），不验证**API 表面本身**。
`api-docs/api-manifest.json` 完全由官方 HTML 文档解析而来，从未与实机比对过，因此有一个独立盲区：

- 文档漏写的方法在 `host-session.js` 的 `validateApiCall` 里只得到一条 advisory（不致命），
  但会**失去参数校验与返回句柄类型推断**（`inferReturnedHandleType` 依赖 manifest），
  于是 `handleTypes` 断链，后续调用连目标类型都认不出来。
- 反过来，manifest 里有而实机没有的方法，说明文档对该宿主版本已过时。

枚举必须在宿主的 Lua 里进行：SV API 对象是普通 Lua 表，成员即键，`pairs()` 可直接枚举
（实机 2.2.1 上 527 个成员全部 `scope=own`，metatable 链没有额外贡献）；而 SVCopilot 桥只有
`index`/`call`，两者都是单键查找，必须预先知道名字，天生发现不了文档之外的东西。因此这一步
用独立探针，**不经过桥、不改桥**。

**成员值是 `userdata`，不是 Lua `function`**（实机：`userdata` 522 / `string` 4 / `number` 1）。
第一版探针按 `type(v) == "function"` 判断可调用性，结果把全部 527 个成员判成 `value`，试调门禁
一次都没触发——而输出看起来和正常结果毫无区别。因此现在：可调用性以「是否 callable」为准，
每个成员另记 `luaType` 留证，并由 `captureHealth` 在「零 callable」或「启用试调却零执行」时
直接报 `NO_CALLABLE_MEMBER_CLASSIFIED` / `TRIAL_CALLS_ENABLED_BUT_NONE_RAN`。
**读结果前先看 `captureHealth.warnings`：非空则这次 diff 不可信。**

### 采集（在 SynthV 内）

1. 打开一个**可丢弃**工程（探针只读，但仍建议如此）。
2. `Scripts > SV Copilot > SV Api Surface Probe`。
3. 弹框会给出写入路径，默认：

```text
%LOCALAPPDATA%\SVCopilot\api-surface\api-surface-<version>-<platform>-<ts>.json
```

探针只调用 `get*`/`is*`/`has*`，零参试调前还要过一层 denylist（排除对话框、剪贴板、播放控制）；
`SV:create()` 出来的对象是临时的，绝不加入工程。它不写工程、不建 Undo、不碰 selection。

### 比对（在仓库内）

```powershell
cd server
npm run api-surface:diff -- --input "<上面那个文件>"
```

输出两份：

- `tools/out/api-surface-<ts>.json` 与 `api-surface-latest.json` —— 完整明细，已 gitignore。
- 加 `--evidence` 时另写一份精简、脱敏、**可提交**的证据到
  `docs/operations/evidence/api-surface-synthv-<version>-<platform>.json`，含 `conclusion` 块。
  已存在的文件不加 `--force` 不覆盖。

### 怎么读结果

| 字段 | 含义 | 该怎么办 |
| --- | --- | --- |
| `undocumented` | 实机有、文档无 | **最值得看**。`classDocumented:false` 表示整个类都不在文档里；`true` 表示类在但少这个方法。可考虑补 manifest 或开能力闸门。 |
| `missing` | 文档有、实机未观测 | 若 `CLASS_NOT_OBSERVED`，通常只是本次没覆盖到；若 `MEMBER_NOT_OBSERVED`，说明 manifest 对该版本过时。 |
| `unavailable` | 探针拿不到实例 | **不算差异**。`CREATE_FAILED` 只说明该类不能凭空 `SV:create()`，需要活工程里的实例。 |

`resultCode` 为 `API_SURFACE_PARITY_CONFIRMED` 或 `API_SURFACE_PARITY_DIVERGED`。差异存在不算
工具失败——那正是要找的东西，退出码仍为 0。

证据文件目前**不写入** `server/host-profiles/`：改 profile 会连带 `evidenceSha256` 与 T20 发布
证据一起重算，而 profile 的值域校验也装不下几百个方法名。`conclusion` 只声明它将来会支持
`api.surfaceParity` 这个语义，等确实拿到值得解锁的发现再走晋升流程。

### 2.2.1 / win32 首轮结果

已归档于
[`api-surface-synthv-2.2.1-win32.json`](evidence/api-surface-synthv-2.2.1-win32.json)：
`matched=326`、`undocumented=13`、`missing=15`、采集健康无警告。

实机有、文档无的 13 项中值得跟进的：

| 成员 | 观测 | 为什么重要 |
| --- | --- | --- |
| `PitchControlPoint.isTemporary` | 试调 → `boolean` | H3a/H3b 把「同 anchor 排序与临时态不可观测」列为闸门原因；这个字段可读，可能正是缺失的观测点。**但只证明字段存在，不证明语义**，仍需专项 H3 探针验证 add/clone/remove 前后的变化。 |
| `PitchControlPoint.type` / `PitchControlCurve.type` / `TrackMixer.type` | `luaType=string` | 是**类型标签常量**，不是方法。宿主自带运行时类型判别，可用于缓解未登记方法导致的 `handleTypes` 断链。 |
| `NoteGroup.getScale` / `setScale` | `getScale` 试调 → `table` | 我们现在用 Krumhansl-Schmuckler **推断**调性；宿主可能直接提供。 |
| `TrackMixer.getFxParams` / `setFxParams` | `getFxParams` 试调 → `table` | 效果器参数，此前完全在视野外。 |
| `SV.scaleTypes` / `scaleNotes` | 需参数，未试调 | 宿主自带音阶目录，对照我们自维护的 14 类。 |
| `MainEditorView.setCurrentGroup` / `setCurrentTrack` | 写方法，未试调 | 编辑器导航。 |

另一条硬证据：官方文档写 `SV.pitch2freq`（小写 f），**实机只有 `pitch2Freq`**（大写 F），
`freq2Pitch` 两边一致。我们从未调用过它，因此没有实际故障；但照文档拼写会通过
pre-validation 而被宿主拒绝。这属于「manifest 对 2.2.1 已过时」。

`missing` 里的 15 项多为未实例化的抽象基类（`NestedObject`、`ScriptableNestedObject`、
`SelectionStateBase`、`GroupSelection`、`RetakeList`）与继承而来的 `getIndexInParent`——
本轮采集没覆盖到，不代表宿主没有。`Automation (created) CREATE_FAILED` 说明 manifest 把它
列为 creatable 但 `SV:create("Automation")` 实际失败，需要参数或只能从 NoteGroup 取。

## 证据边界

profile 中仍为 `unknown` 或 `not_observable` 的字段包括 PitchControl 同 anchor 次序、add/clone/
remove 返回与附着语义、numeric storage、Automation 边界包含性、tempo ramp、computed-pitch
重算延迟/稳定性，以及多候选单 Undo。新增证据必须来自只读探针或显式 opt-in 的可恢复 fixture，
并经过补偿、读回和去标识；不能把 `SVLiveProbe` 的 `readOnly:true` 偷换成临时写入。

完整状态和 evidence ID 以
[`synthv-2.2.1-win32-v2.json`](../../server/host-profiles/synthv-2.2.1-win32-v2.json)
为准。T18 的事务、Undo、回滚与资源清理属于发布验收证据，不会把 profile 中未直接观测的语义
自动晋升为 `confirmed`。
