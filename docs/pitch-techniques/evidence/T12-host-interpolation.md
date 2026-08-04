# T12 宿主插值后置验证

采集日期：`2026-08-03`

## 实现

`server/src/pitch-techniques/host-interpolation.js` 定义了版本化、冻结的内部
`hostInterpolation` postcondition。它封存逐参数 interpolation evidence、baseline 样本
fingerprint、必保锚点、至少一个自适应中点和 `maxFitErrorCent`。baseline 与自适应中点均不能为空；
中点的期望值来自编译器封存的宿主证据，事务不以 Linear 公式自行重算。

`parameter-curve.js` 在 dry-run、数学 no-op 和真正写入前都重新读取
`Automation.getInterpolationMethod()` 与 baseline `Automation.get()` 样本。方法或 fingerprint
漂移分别以 `INTERPOLATION_CHANGED` / `CURVE_BASELINE_CHANGED` 零写入拒绝。写后先保留既有
控制点 read-back，再用 `Automation.get()` 在 mandatory anchors 与 adaptive midpoints 比较封存的
最终 cent 值；超差以 `POSTCONDITION_FAILED` 进入既有 journal/rollback 状态机。断连或超时维持
`outcome_unknown`，不会自动重试。

真实宿主还显示 `Automation.remove(from, to)` 的上界是右开区间。公共请求仍使用闭区间，事务在
remove 与 rollback 时将右端点转换为 `to + 1`，避免 replace 在右端留下控制点。

## 实机证据

当前连接的 Synthesizer V Studio 2 实例中，临时 quiet `pitchDelta` 区间的
`Automation.getInterpolationMethod()` 返回 `linear`。向该区间临时写入两个端点后，独立 raw
`Automation.get()` 在左端、中点、右端依次读到 `-6`、`0`、`6` cent，证明读取的是宿主实际的
线性插值，而不是 fake-host 或本地线性函数。

同一探针的 dry-run 没有 setter 或 Undo；commit 通过通用控制点 read-back 和宿主插值采样，产生
两个 Undo boundary call、一个用户 Undo 步。清理时先观察到原始右端点未被 `remove(from, to)` 删除，
随后用包含右侧 BLICK 的临时范围完成删除，并再次读取确认该临时区间为零控制点。记录未包含工程名、
group UUID、歌词、BLICK 坐标或本机路径。

## 故障注入与验证

| 情形 | 断言 |
|---|---|
| baseline / interpolation method 漂移 | 首个 setter 前失败，`effects:"none"`，零 Undo |
| 宿主忽略 remove/add | 控制点 postcondition 失败且已验证 rollback |
| 中点插值超差 | `POSTCONDITION_FAILED`，保留 `adaptive_midpoint` 误差证据并 rollback |
| rollback setter 失败 | 状态为 `rollback_failed`，不伪造恢复成功 |
| 写后断连 | `outcome_unknown`，不尝试 rollback 或重试 |
| 非线性封存样本 | 事务只使用封存期望值，未把中点重算为 Linear |
| 右端点 replace | fake host 采用右开 remove，断言宿主调用为 `[from, to + 1]` |

| 命令 | 结果 |
|---|---|
| `node --test ../test/parameter-curve.test.mjs` | 57 passed |
| `npm test` | 865 passed in 35.219 s |
| `git diff --check` | clean |

## 范围

T12 没有新增公开 MCP schema、planner operation 或 PlanRef 生产路径。`hostInterpolation` 仍是
sealed 内部 mutation 字段；T13 将在公开 `plan_pitch_gesture` 迁移中成对生成并注入它。此证据不声称
computed pitch、PitchControl、H2/H3/H5--H8 或完整 MVP RC 已通过。
