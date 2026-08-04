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
  --output ..\test\fixtures\host-profiles\candidate.json
```

与已有 profile 比较：

```powershell
npm run host-profile:capture -- `
  --baseline ..\test\fixtures\host-profiles\synthv-2.2.1-win32-v2.json
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
- 600 个 constant / tempo-step / dense-tempo 样本的 Node/宿主秒轴最大偏差为
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

## 证据边界

profile 中仍为 `unknown` 或 `not_observable` 的字段包括 PitchControl 同 anchor 次序、add/clone/
remove 返回与附着语义、numeric storage、Automation 边界包含性、tempo ramp、computed-pitch
重算延迟/稳定性，以及多候选单 Undo。新增证据必须来自只读探针或显式 opt-in 的可恢复 fixture，
并经过补偿、读回和去标识；不能把 `SVLiveProbe` 的 `readOnly:true` 偷换成临时写入。

完整状态和 evidence ID 以
[`synthv-2.2.1-win32-v2.json`](../../test/fixtures/host-profiles/synthv-2.2.1-win32-v2.json)
为准。T18 的事务、Undo、回滚与资源清理属于发布验收证据，不会把 profile 中未直接观测的语义
自动晋升为 `confirmed`。
