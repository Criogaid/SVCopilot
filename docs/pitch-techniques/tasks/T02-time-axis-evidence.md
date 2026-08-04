# T02 — H1 TimeAxis 证据与 Profile v2

- 状态：`done`
- 权威：[实施计划](../implementation-plan.md) §7.1、§7.2、§17 提交 2
- 依赖：T01 基线记录
- 解锁：T03 裁定、T04、T08

## 目标

用只读实机证据裁定 Node 与 SynthV 的秒/BLICK 换算是否满足全部 Hz 门禁，并扩展 host profile 表达结果。

## 交付边界

- 覆盖恒速、tempo mark 边界、阶跃变速和密集变速，完成权威计划要求的探针规模。
- 记录误差分布、采样范围、宿主/bridge 版本和原始证据 Artifact。
- 扩展 profile schema、捕获工具、fixture 与测试；未知结论保持 `unknown`。
- 只做读取，不调用 setter，不产生 Undo。

## 验收

- profile 可区分通过、失败、部分观测和未观测，不靠 message 文本推断。
- 同一证据重放得到相同裁定；敏感数据和完整脚本源码不进入响应。
- 明确写出 T03 是“需要”还是“不需要”，并给机械依据。

## 完成条件

H1 从 `partially_observed` 变成有证据的终态，T08 可据此使用确定门限。

## 完成记录

2026-08-04 的活动 MCP 会话附着到 SynthV 2.2.1。三个可回放 Artifact 各含 200 个 BLICK
位置，并覆盖每个 tempo mark 的 `-1/0/+1`：

- [constant](../evidence/T02-time-axis-constant-live-v2.json)
- [tempo_step](../evidence/T02-time-axis-tempo-step-live.json)
- [dense_tempo](../evidence/T02-time-axis-dense-tempo-live.json)

聚合结果为 `TIME_AXIS_NODE_PARITY_CONFIRMED`：600 点的 Node 秒值最大误差为
`1.4210854715202004e-14 s`，宿主 BLICK 往返最大误差为 `1`，因此满足 `<= 1e-6 s` 门限。
profile fixture `synthv-2.2.1-win32-v2` 已将
`timeAxis.nodeParityMaxDeviationSeconds` 更新为 `confirmed`。

用户授权在当前临时工程上构造并恢复 tempo fixture；准备和恢复均零显式 Undo boundary，且
最终读回原始单一 tempo map。三份 Artifact 的采样工作流本身均为 `mode: "read"`，零 setter、
零 Undo。完整过程、恢复核对与验证命令见
[T02-live-progress.md](../evidence/T02-live-progress.md)。

T03 的机械裁定为 `not_required`；不得实现 `time_axis_map_v1`。早期离线预检保留在
[T02-preflight.md](../evidence/T02-preflight.md)。
