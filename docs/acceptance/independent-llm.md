# §15 独立 LLM 验收：会话规程

[交互效率实施记录](../plans/mcp-interaction-efficiency.md) C4 与 §13.6 要求
"独立 LLM 只通过 MCP 自描述完成真实工作流"。这份文档是**执行规程**，不是验收结论：
结论只能由一次真实会话产出。

## 为什么需要一份规程

§15 最后一段写着：若模型仍生成完整 Note ID、逐参数重复 hairpin、读取全部无关 Artifact、
重复读取同一 schema，验收失败，且**不能用"接口已经支持短格式"替代真实可用性证据**。

这句话的分量在于：本轮所有离线门禁测的都是"接口允许什么"。一个模型完全可以在
schema 允许短格式的前提下，仍然写出冗长请求——因为它没读 schema，或读了没理解，
或工具描述把它引向了别处。那种失败在 npm test 里是不可见的。

## 前置条件

- SynthV Studio 2.2.1 运行中，工程含 ≥373 音符的单一 NoteGroup；
- SV Copilot 桥已从 Scripts 菜单加载；
- MCP 客户端**必须**把 `structuredContent` 交给模型。只转发 `content[].text` 的客户端
  不在本轮 surface 的目标范围（§13.6）——它看不到机器结果，任何结论都不成立；
- 会话使用的模型此前没有见过本仓库的代码或计划文档。这一条是"独立"的全部含义：
  它必须只依赖 MCP 自描述。

## 会话任务

给模型一个音乐目标，不给任何接口提示。建议任务（覆盖 grouped schema、ordinal/index
与 PlanRef 三条路径）：

> 这个工程第一条人声轨的副歌听起来太平。请在不修改任何音符的前提下，
> 给它加上渐强与几处颤音，先给我 dry-run 的计划让我审阅。

不要说"用 sv_plan_expression"，不要说"note 用 index"。模型该自己从 `sv_describe`
和 workflow guide 里找到路径——找不到本身就是验收结果。

## 必须记录的观测量

每一项都是可数的，不接受"看起来还行"：

| 观测量 | 通过条件 | 记录方式 |
| --- | --- | --- |
| 请求中完整 Note ID 出现次数 | 0 | 逐条请求 grep `:n:` |
| 同一参数重复的 hairpin 条数 | 0（应使用 `amounts` 映射） | 数 gestures 数组 |
| 同一 schema 重复读取次数 | ≤1（除非客户端截断过内容） | 数 `sv_describe` 调用 |
| workflow guide 重复读取次数 | ≤1 | 数 resource 读取 |
| 无关 Artifact detail 读取次数 | 0 | 数 artifact 页面读取 |
| 10 分钟工作流内 Context 过期 | 0 | 记录 `UNKNOWN_CONTEXT` 次数 |
| 模型是否自然使用 ordinal/index | 是 | 记录首次请求的身份写法 |
| 模型是否提交 PlanRef 而非内联 | 是 | 记录 apply 提交形状 |

## 35 分钟过期路径

会话结束前额外做一次：让一个 Context 闲置超过 30 分钟 TTL，再让模型继续工作。
通过条件是它收到有界的 `UNKNOWN_CONTEXT.reason` 加可执行的 `next`，然后**重新快照**，
而不是凭记忆重建一个旧式长请求。这条单独列出，因为它是唯一能验证"过期路径不会
把模型推回旧写法"的观测。

## 去标识

报告只记录计数、字节数、状态码与门禁结论。歌词、音素、工程名、UUID 和逐 Note 内容
一律不写盘（§15 硬要求）。引用模型输出时，把音乐内容替换为占位符。

## 结论写在哪里

一次会话的结论写进 `tools/out/independent-llm-<date>.md`，与
`tools/out/live-acceptance-*.json`（§15 自动化部分）并列归档。两者都齐备时，
C4 才算完成。

`tools/out/` 是被 `.gitignore` 排除的本地临时目录。不得直接提交其中的原始会话；只有满足上节
去标识要求的汇总结论才能转入版本化 evidence 文档。

本文件不保存某一次会话的结论。当前离线门禁与 `npm run acceptance:live` 走查脚本已就绪；
每次发布候选仍须由未接触源码和本计划的模型重新执行，并把去标识结果写入 `tools/out/`。
