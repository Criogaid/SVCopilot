# SV Copilot 架构

> 当前基线：SV Copilot 0.10.0，传输协议 v2。operation 数量从 `OperationCatalog` 派生，
> 不作为手写协议常量。

## 1. 系统边界

SV Copilot 通过 Synthesizer V Studio 2 官方 Lua scripting API 工作，不注入 DLL，
不访问宿主私有内部接口，也不把 UI 自动化当成 API。

```text
MCP client
  <-> stdio
Node MCP server + PipeRelay
  <-> NDJSON / Windows named pipes
SynthV Lua bridge
  <-> official SV scripting API
```

Node 负责 MCP、schema、Context、Artifact、PlanRef、并发协调、事务编排和结果验证。
Lua bridge 只负责把有界命令分派到官方宿主对象，并把结果编码回 Node。

## 2. 传输

生产传输只使用两个固定的单向 PIPE：

```text
\\.\pipe\SVCopilot-to-sv
\\.\pipe\SVCopilot-from-sv
```

Relay 是 PIPE server。Lua 在宿主 UI 线程协作运行，`read("*l")` 没有超时，因此协议必须严格
锁步：Lua 写出一帧后读取且只读取一个回复；Relay 对每一帧都立即返回 `command`、`noop`
或 `error`。遗漏回复会冻结宿主 UI。

握手使用协议 v2。Lua 声明可选批量 opcode，Node 只使用双方协商成功的能力；桥重连会提升
epoch，旧 epoch handle 必须拒绝。安装面没有 session namespace 或 control pipe。

`server/src/transport.js` 和 `test/raw_client.py` 是旧 file-IPC 参考实现，不被生产入口导入。
开发用 SV Live Probe/file bridge 是独立调试通道，不能替代生产 PIPE 契约。

## 3. MCP 表面

公开表面固定为八个工具：

| 工具 | 职责 |
|---|---|
| `sv_status` | ping、doctor 与官方 API 文档查询 |
| `sv_read` | 快照、分析和只读查询 |
| `sv_plan` | 无副作用音乐规划 |
| `sv_edit` | 显式 dry-run/commit 写入 |
| `sv_audition` | 人工试听与 A/B 状态机 |
| `sv_artifact` | Artifact 短 offset 读取、释放和生命周期管理 |
| `sv_raw` | 官方 SV API 的底层逃生口 |
| `sv_describe` | 按需返回 operation 的完整 schema 与契约 |

`server/src/operation-catalog.js` 是 operation 到 facade 的唯一映射。Facade 只负责路由，
业务参数仍使用同一个 Ajv schema 和 handler；不存在 full/compact 双 profile，也不存在 direct
tool 兼容入口。`svcopilot://operations` 提供可发现目录。
目录中的每个 operation 携带稳定 `schemaHash`，根对象携带 `catalogHash`；`sv_describe` 与
`svcopilot://schemas/{tool}` 返回同一 schema identity。客户端重连后先读目录，只重新获取 hash
变化或本地尚未缓存的 schema。hash 是服务端针对实际 minified schema 字节生成的不透明缓存键，
客户端不应依赖对象属性顺序自行重算。
`svcopilot://capabilities` 独立发布连接状态、限制、可用能力和 capability-gated 分支，不通过
`sv_status` operation 重复同一份数据。
稳定机器码不会因文案调整而改名；`svcopilot://terminology` 按需提供对应的短标题和领域解释。
能力 gate 使用 `reasonCode + explanation`，内部证据编号只放在 `evidence` 中，不再充当唯一原因。

## 4. 读取模型

`sv_snapshot_range` 建立短期 Context。Context 保存捕获时的 occurrence、Note fingerprint、
时间轴和请求 include；后续 planner 与 mutation 使用 ordinal/index，不向模型反复暴露带
Context UUID 的长 Note ID。

大载荷进入 ArtifactStore。普通响应只返回摘要和短引用；`artifactRef.read` 给出可直接提交的
`sv_artifact(read)` 调用，后续页面只传 `artifactId + nextOffset`。服务按最终 MCP envelope 动态
收缩正文，末页返回 content hash。旧的 hash-bound resource/cursor URI 作为兼容路径保留。
PlanRef 是密封的可执行 Artifact 身份，不能作为 detail 读取，也不能成为跳过 live preflight 的凭证。

## 5. 写入与恢复

所有高层 mutation 遵循同一顺序：

```text
schema validation
  -> resolve snapshot/capsule scope
  -> live target and fingerprint preflight
  -> capture rollback journal
  -> open one host Undo boundary
  -> write
  -> independent read-back verification
  -> close Undo boundary
```

这不是数据库 ACID。若 setter 后宿主断连或超时，服务只能返回 `outcome_unknown`，不得自动重试。
能够证明回滚完成时返回 `rolled_back`；回滚无法证明时返回 `rollback_failed`。任何写入尝试都会
使相关 Context 失效，即使最终状态不是 `succeeded`。

Plan ledger 阻止同一 PlanRef 重复 commit。数学空操作和 dry-run 不写宿主、不创建 Undo。

## 6. 句柄与 raw API

宿主对象通过带 epoch 的 handle 表示。临时 handle 由 workflow 自动释放；显式返回给调用方的
handle 必须由调用方通过 raw `free` 释放。递归 typed-v2 codec 区分数组、映射、稀疏值、
特殊数字和 handle，并受深度、条目数及帧大小限制。

Raw API 保留官方 API 覆盖能力，但无法预先知道任意 setter 的写入范围，因此写调用会保守地
使 Context 失效。

## 7. 音乐语义层

快照、歌词、音符结构、Automation、PitchControl、voice 参数、computed pitch、和声、量化、
表现规划和试听都建立在同一 Context/Plan/transaction 边界上。纯分析器不得访问宿主，也不得
把启发式推断写成观测事实。

试听只声明 `perception:"human_only"`。官方 API 当前不能让 MCP 听见渲染结果；Singer/database
身份也不可完整观察。相关能力必须如实标记为 `unobservable` 或 `capability-blocked`。

## 8. 宿主证据与离线模型

Host Profile 汇总 SV Live Probe 的只读证据和显式 opt-in 的可恢复验收证据，并在入库前去标识。
只有 `confirmed` 证据能驱动严格 fake host；`partially_observed`、`unknown`、`contradicted` 和
`not_observable` 不能被 simulator 默认值冒充。具体流程见
[operations/host-profiles.md](operations/host-profiles.md)。

## 9. 关键代码位置

| 路径 | 职责 |
|---|---|
| `server/src/index.js` | MCP 入口、schema 和 dispatch |
| `server/src/transport-pipe.js` | PIPE Relay 与握手 |
| `server/src/host-session.js` | epoch、handle 和宿主会话 |
| `server/src/execution-coordinator.js` | 全局 FIFO 执行协调 |
| `server/src/operation-catalog.js` | facade operation 目录 |
| `server/src/snapshot.js` | Snapshot 服务、Context 生命周期与配额 |
| `server/src/artifact-store.js` | Artifact、分页和 hash |
| `server/src/plan-ledger.js` | PlanRef 单次 commit 状态机 |
| `server/src/scope-source.js` | Snapshot 与 capsule 的统一 mutation scope |
| `server/src/mcp-result-encoder.js` | MCP 结果与错误边界 |
| `staging/StartSynthVCopilotPipe.lua` | 仓库内 Lua bridge 参考副本 |

## 10. 验证

从 `server/` 运行：

```powershell
npm test
npm run smoke:mcp
npm run doctor
```

涉及 Lua dispatcher 时，还必须分别验证实际加载脚本和 staging 副本。需要实机语义证据时，
使用 Host Profile 或可恢复的 live acceptance，不以离线测试替代宿主结论。
