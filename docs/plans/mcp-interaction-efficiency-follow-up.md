# SVCopilot MCP 交互效率后续优化实施计划

## 0. 文档信息

| 字段 | 内容 |
| --- | --- |
| 状态 | 已完成 |
| 立项日期 | 2026-08-04 |
| 完成日期 | 2026-08-04 |
| 基线版本 | SVCopilot `0.10.0`，提交 `13b6a64` |
| 实施范围 | 效率基准、operation schema 缓存、用户可读术语、Artifact 短翻页 |
| 实施顺序 | E1 基准 -> E2 schema 缓存 -> E3 术语 -> E4 Artifact |
| 安全边界 | 不改变宿主写入、事务、回滚、Undo、Context 或 PlanRef 语义 |

本计划承接已完成迁移的
[MCP 双向交互效率优化实施计划](./mcp-interaction-efficiency.md)，只处理实测后确认仍有收益的四项后续工作。
旧计划继续作为历史决策记录，不在本次实施中改写其基线和阶段结论。

## 1. 立项依据

### 1.1 当前证据

基线脚本对同一 surface 使用了两个互相冲突的口径：

- `tools/measure-surface-bytes.mjs` 测得模型实际看到的 8-tool facade 为 5,008 bytes；
- `tools/benchmark-mcp-efficiency.mjs` 把 43 个内部 handler 的 114,131 bytes 标为 `ListTools`；
- 旧 benchmark 的 MCP calls、resource reads、wall time 等执行指标恒为零，不能表示一次交互轨迹。

operation schema 已经按需读取，但 catalog 没有稳定内容标识。客户端重连后无法判断哪些 schema
发生变化，只能重新读取或依赖客户端私有启发式缓存。

Artifact 当前页面 cursor 长约 259--262 字符。对仓库证据中的 63--110 KiB Artifact，改用
`artifactId + offset` 后，翻页参数预计减少 86% 以上，完整 JSON-RPC 请求预计减少 60% 以上。

`tempo_step`、`H2`、`H3a`、`T03` 等机器码或证据编号会出现在报告、能力说明和错误消息中，
其中部分没有同行解释。profile 状态汇总还漏掉了合法状态 `partially_observed`。

### 1.2 非目标

- 不增加新的宿主调用或 Lua bridge operation；
- 不改变任何 planner、mutation 或 live preflight 的业务语义；
- 不把 schema 缓存状态保存到服务端或用户工程；
- 不移除现有 Artifact resource URI；
- 不翻译或改名稳定协议码，例如 `partial`、`rollback_failed`、`outcome_unknown`。

## 2. E1：统一效率基准

### 2.1 目标契约

唯一 benchmark report 必须区分以下层次：

| 层次 | 定义 |
| --- | --- |
| `servedMcp` | 实际 facade `tools/list`、catalog 和 describe 响应 |
| `operationSchemas` | 内部 handler inventory，不冒充 `tools/list` |
| `fixturePayloads` | 固定匿名 fixture 和代表性响应 |
| `workflowTrace` | 一次可复现离线发现轨迹的 calls、resource reads、bytes 和 wall time |
| `host` | 可选 live acceptance 指标；离线报告明确标为未采集 |

`tools/measure-surface-bytes.mjs` 改为调用同一 runner 的人类可读投影，避免第二套计算逻辑。
新增 `npm run bench:mcp`，默认不改写受跟踪 fixture；显式参数才允许刷新 baseline。

### 2.2 验收

- `servedMcp.toolCount === 8`，并与真实 facade tool 数一致；
- `operationSchemas.handlerCount` 从内部 inventory 派生；
- 离线 trace 至少执行 catalog 和 describe，执行指标不得伪装为 host 实测；
- 相同输入和固定时间产生逐字段稳定报告；
- benchmark 测试不修改仓库 fixture；
- 现有 12 KiB tools/list 和 16 KiB describe 门禁继续通过。

## 3. E2：operation schema 缓存

### 3.1 目标契约

- 每个 operation 使用 `sha256_` 前缀的完整 SHA-256 `schemaHash`；
- hash 针对服务实际返回的 minified `inputSchema` UTF-8 字节计算，由客户端视为不透明值；
- `svcopilot://operations` 的每个 operation 都包含 `schemaHash`，根对象包含 `catalogHash`；
- `sv_describe` 与 `svcopilot://schemas/{tool}` 返回同一个 `schemaHash`；
- operation schema 在同一 server session 内不可变；重连后客户端先读 catalog，只重取 hash 变化项。

hash 不加入 8 个 facade tool 的 `tools/list` 元数据，避免永久增加所有会话的启动成本。

### 3.2 验收

- 同一 schema 的 catalog、describe 和 schema resource hash 相等；
- schema 任一字节变化都会改变 hash；
- operation 排序变化不会改变单项 schemaHash；
- catalogHash 对完整 catalog 内容敏感且结果稳定；
- catalog 仍小于 16 KiB；
- 未识别 operation 的错误行为不变。

## 4. E3：机器码与可读术语双层表达

### 4.1 目标契约

建立单一术语注册表。稳定 code 继续用于 schema、证据和程序分支，可读层提供：

```json
{
  "code": "tempo_step",
  "title": "Single tempo change",
  "description": "Exactly one BPM change inside the measured range."
}
```

对大数组不重复内联 title；报告在顶层携带一次 `terms` 字典，条目只引用 code。能力 gate 和错误
消息使用领域事实解释原因，`H2/H3/T03` 只保留为独立 evidence reference，不再充当唯一解释。

### 4.2 首批覆盖

- 时间轴 scenario：`constant`、`tempo_step`、`dense_tempo`；
- host semantic status：`confirmed`、`contradicted`、`partially_observed`、`unknown`、
  `not_observable`；
- pitch capability gate 的稳定 `reasonCode` 和 explanation；
- 振音 host semantic 错误中的领域解释与 evidence reference。

### 4.3 验收

- 合法 profile status 全部被汇总，`partially_observed` 计数正确；
- 对外能力结果不再把 `H3a_unknown_and_H3b_partially_observed` 作为唯一 reason；
- 振音错误无需知道 `H2` 也能理解，并仍可追溯原证据；
- 时间轴报告可把 `tempo_step` 解释为范围内恰好一次 BPM 变化；
- 新增词条不会突破 compact response 字节门禁。

## 5. E4：短参数 Artifact 翻页

### 5.1 目标契约

在现有 `sv_artifact` facade 下增加 `read` operation：

```json
{ "artifactId": "a_...", "offset": 8192 }
```

`offset` 省略时为 0。服务端选择能保证最终 MCP envelope 不超过 16 KiB 的页大小，响应返回：

```json
{
  "data": "...",
  "nextOffset": 16384,
  "done": false
}
```

末页额外返回 `contentHash`。响应不回显 artifactId 或当前 offset。Artifact 仍然不可变、仅限当前
session、受 lease 和 quota 管理；offset 必须是安全整数、在范围内并位于 UTF-8 code point 边界。

### 5.2 兼容策略

- 现有 `svcopilot://artifacts/.../pages/{cursor}` 保留至少一个兼容阶段；
- 新 artifact reference 把短 read operation 作为首选 handoff，旧 URI 保留为 compatibility 字段；
- release 行为、签名 cursor 和 resource read 测试继续保留；
- capabilities 同时公布首选 read operation 与旧 resource templates。

### 5.3 验收

- ASCII、多字节字符和需要 JSON 转义的数据可逐页无损重组；
- 每个非末页都推进 offset，最终序列化响应不超过 16 KiB；
- 非 code point 边界、负数、越界、过期和跨 session 访问均在读正文前失败；
- 末页 hash 与 artifact reference 一致；
- 新旧分页路径重组结果相同；
- surface IO policy、catalog、schema、root envelope 和 MCP projection 全部覆盖 `read`。

## 6. 实施与提交切分

1. `Establish follow-up MCP efficiency plan`
2. `Unify MCP efficiency benchmark measurements`
3. `Add cache identities to operation schemas`
4. `Explain host semantics with stable terminology`
5. `Read artifacts through short offset pages`
6. `Complete interaction efficiency acceptance`

每个提交必须通过相关聚焦测试和 `git diff --check`。最终提交前运行 `npm test`、
`npm run smoke:mcp` 和 `npm run bench:mcp`。本计划不改 Lua bridge，因此不要求重启 SynthV；若实现
过程中发现必须改变 bridge，则停止本计划并单独立项。

## 7. Definition of Done

- benchmark 只有一个权威计算路径，并准确区分实际 facade 与内部 handler inventory；
- operation schema 可用稳定 hash 跨会话复用；
- 用户和模型不需要理解内部证据编号即可判断能力限制；
- Artifact 首选读取调用只生成短 `artifactId + offset` 参数；
- 原 resource URI 客户端继续工作；
- 四项均有 schema、服务行为、失败路径、响应预算和 MCP 投影测试；
- 完整测试、MCP smoke、效率基准和 diff check 通过；
- 工作区不包含凭据、机器路径、真实歌词或本地元数据。

## 8. 完成证据

### 8.1 实施提交

| 阶段 | 提交 |
| --- | --- |
| 立项 | `51213d0 Establish follow-up MCP efficiency plan` |
| E1 效率基准 | `56ba7b3 Unify MCP efficiency benchmark measurements` |
| E2 schema 缓存 | `6a40334 Add cache identities to operation schemas` |
| E3 可读术语 | `cbb925e Explain host semantics with stable terminology` |
| E4 Artifact 短翻页 | `e337dc2 Read artifacts through short offset pages` |

### 8.2 最终实测

由 `test/fixtures/efficiency/baseline.json` 记录：

| 指标 | 最终值 |
| --- | ---: |
| 实际 facade `tools/list` | 8 tools / 5,015 bytes |
| 内部 handler inventory | 44 handlers / 114,784 bytes |
| facade 相对内部 inventory 缩减 | 95.6% |
| operation catalog | 44 operations / 11,787 bytes |
| 固定离线 discovery trace 模型可见总量 | 31,746 bytes |

Artifact 以相同 8 KiB 页面边界比较旧 resource cursor 和新 offset tool call：

| Artifact bytes | 页数 | 业务参数缩减 | 含 facade 参数缩减 | 完整 JSON-RPC 缩减 |
| ---: | ---: | ---: | ---: | ---: |
| 63,356 | 8 | 87.1% | 78.3% | 60.3% |
| 109,975 | 14 | 87.4% | 78.8% | 61.3% |
| 188,236 | 23 | 87.4% | 79.0% | 61.7% |

### 8.3 验证结果

- `npm test`：856/856 passed；
- `npm run smoke:mcp`：passed，8-tool facade、schema discovery、新 Artifact 短读和兼容 resource
  均通过真实 stdio MCP client；
- `npm run bench:mcp -- --quiet`：passed；
- `git diff --check`：passed；
- 未修改 Lua bridge，不需要 SynthV bridge 重启或 live-host 写入验收。
