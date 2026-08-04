# SV Copilot 文档

本目录只保留当前可执行契约、稳定领域知识、操作规程和有明确溯源价值的历史材料。
消费者使用说明以仓库根目录的 `README.md` 为准；这里面向维护者与验收人员。

## 当前权威

| 文档 | 用途 |
|---|---|
| [architecture.md](architecture.md) | 当前运行架构、协议边界和安全约束 |
| [pitch-techniques/feasibility.md](pitch-techniques/feasibility.md) | 可解释音高技法的可行性裁定与证据 |
| [pitch-techniques/implementation-plan.md](pitch-techniques/implementation-plan.md) | 可解释音高技法的实施权威契约 |
| [pitch-techniques/reference/](pitch-techniques/reference/) | 数学 oracle、契约测试和数值门禁 |
| [pitch-techniques/tasks/](pitch-techniques/tasks/) | 引用权威计划的短任务包与依赖顺序 |
| [pitch-techniques/evidence/T20-release-evidence.md](pitch-techniques/evidence/T20-release-evidence.md) | `0.10.0` 音高技法发布范围、宿主矩阵与验证结果 |

## 实施记录

| 文档 | 用途 |
|---|---|
| [plans/mcp-interaction-efficiency.md](plans/mcp-interaction-efficiency.md) | `0.9.0` MCP 双向交互效率迁移的设计目标、实施顺序与验收记录 |

实施记录解释当前设计如何形成，但不覆盖当前 schema、实现、测试或上表列出的权威文档。

## 专题与操作

| 文档 | 用途 |
|---|---|
| [domain/special-lyrics.md](domain/special-lyrics.md) | `+`、`-`、`br` 与喉塞音的统一语义 |
| [operations/host-profiles.md](operations/host-profiles.md) | 用 SV Live Probe 校准离线 fake host |
| [acceptance/independent-llm.md](acceptance/independent-llm.md) | 只依赖 MCP 自描述的独立模型验收规程 |

## 归档规则

[archive/](archive/) 中的材料只用于追溯决策，不定义当前行为。当前文档与归档冲突时，
以当前文档、公开 schema、实现和测试为准。归档不接受功能性更新，只允许修复链接或补充
“已归档”说明。

以下内容不进入文档库：一次性交接记录、临时验收输出、真实工程歌词/音符数据、同一文档的
`Copy`/`.bak`、以及已经被终版完整吸收的中间 PRD 或评审副本。
独立模型和 live acceptance 的临时报告写入被忽略的 `tools/out/`，只把脱敏后的发布结论转入
版本化 evidence 文档。
