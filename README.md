# SV Copilot — Synthesizer V 的实时 MCP 控制桥

SV Copilot 让 MCP 客户端通过 Synthesizer V Studio 2 官方 `SV` Lua API 实时读取和编辑工程。当前默认传输已经是 **Windows IO PIPE（named pipe）**；命令、响应和停止信号均不再经过轮询文件。

```text
MCP client
  └─ stdio ─ Node MCP server
       └─ Windows IO PIPE / NDJSON ─ SynthV Lua bridge
            └─ SV:setTimeout ─ official SV API
```

## 当前状态

- 默认数据通道：两根单向 named pipe。
- 控制通道：第三根单向 named pipe，用于 Scripts 菜单中的 Stop 命令。
- 协议：NDJSON、版本握手、严格一写一读、单命令 in-flight。
- 已验证：Node Relay 测试，以及真实 Lua 5.4 进程与 Windows named pipe 的端到端 dispatcher 测试。
- 待验证：在 SynthV 2.2.1 宿主中长时间运行、播放期间性能和 Relay hang 情况。

旧版 [server/src/transport.js](server/src/transport.js) 和 [test/raw_client.py](test/raw_client.py) 仅作为 file IPC 历史参考；`src/index.js` 不再导入或启用它们。

## 目录布局

SynthV 会递归扫描 `scripts/` 下的 `.lua` 和 `.js`，因此 Node 文件和测试必须留在 `SVCopilot/` 外部目录中。

```text
Synthesizer V Studio 2/
  scripts/SynthVCopilotResearch/copilot/sv-scripts/
    StartSynthVCopilot.lua       # 当前 IO PIPE 桥
    StopSynthVCopilot.lua        # 通过 control pipe 停止
  SVCopilot/
    server/src/index.js          # MCP stdio 入口
    server/src/transport-pipe.js # PipeRelay
    test/                        # Relay、Lua dispatcher、端到端测试
    docs/architecture.md
```

## 前置条件

- Windows
- Node.js 18 或更高版本
- Synthesizer V Studio 2

## 安装与启动

安装 Node 依赖：

```powershell
cd "C:\Users\Kripto\AppData\Roaming\Dreamtonics\Synthesizer V Studio 2\SVCopilot\server"
npm install
```

MCP 客户端配置示例：

```json
{
  "mcpServers": {
    "sv-copilot": {
      "command": "node",
      "args": [
        "C:\\Users\\Kripto\\AppData\\Roaming\\Dreamtonics\\Synthesizer V Studio 2\\SVCopilot\\server\\src\\index.js"
      ]
    }
  }
}
```

使用顺序：

1. 先让 MCP 客户端启动 Node server，使 named pipe 进入 listening 状态。
2. 在 SynthV 中执行 **Scripts → Rescan**。
3. 运行 **SV Copilot → Start SV Copilot**。
4. 停止时运行 **SV Copilot → Stop SV Copilot**，或退出 Node server。

两端默认使用 session `default`。需要隔离多个会话时，在启动 Node 和 SynthV 进程前为两者设置相同的 `SV_COPILOT_SESSION`；值只能包含 1–64 个 ASCII 字母、数字、点、下划线或连字符。

## MCP 工具

| 工具 | 用途 |
|---|---|
| `sv_ping` | 检查 Relay、Lua 桥和宿主循环是否连通 |
| `sv_root` | 获取 project、timeAxis、mainEditor、arrangement、playback 等根对象 handle |
| `sv_call` | 调用全局 `SV` 或任意 handle 对象上的方法 |
| `sv_index` | 读取字段或常量，例如 `SV.QUARTER` |
| `sv_free` | 释放不再使用的 handle |
| `sv_search_api` | 搜索本地解析的官方 API（类、方法、重载、参数、版本与文档锚点） |
| `sv_describe` | 获取一个类或指定方法的完整官方 API 元数据 |

MCP 资源也提供 `svapi://manifest`（完整清单）和 `svapi://class/{class}`（按精确类名读取，例如 `svapi://class/Note`）。

完整性来自通用 dispatcher：SynthV 对象会被登记为整数 handle，普通 JSON 数据直接内联。调用方可以沿对象 handle 遍历官方 API，而无需为每个方法新增 MCP 工具。`sv_root` 返回的根 handle 和已推断返回类型会被记录；对这些已知类型，`sv_call` 会在发往 SynthV 前校验方法、重载参数、handle 类型和官方文档中的最低版本要求。类型尚未知的 handle 仍交由宿主 dispatcher 执行，以保留通用遍历能力。

## Smoke test

连接后依次调用：

1. `sv_ping`，应返回 `"pong"`。
2. `sv_root`，保存返回的 project handle。
3. `sv_call { "handle": <project>, "method": "getFileName" }`。
4. `sv_call { "handle": <project>, "method": "getNumTracks" }`。
5. `sv_index { "field": "QUARTER" }`，通常返回 `705600`。

对象 handle 也能作为参数传回：

```text
sv_call { "method": "create", "args": ["Note"] }
  → { "__handle__": 8, ... }

sv_call {
  "handle": 7,
  "method": "addNote",
  "args": [{ "__handle__": 8 }]
}
```

## 测试

在 `server/` 中运行完整自动化测试：

```powershell
npm test
```

运行一个完整的模拟 MCP 客户端：

```powershell
npm run smoke:mcp
```

该命令会依次启动 stdio MCP server、独立 Lua bridge 和客户端，并实际调用
`listTools`、文档资源、`sv_search_api`、`sv_describe`、`sv_ping`、`sv_root`、`sv_call`、`sv_index` 与 Stop 脚本。

它包含：

- Relay 握手、错误帧回包、串行队列和 control pipe 测试。
- 使用真实 Lua 解释器连接真实 Windows named pipe 的端到端测试。

纯 Lua dispatcher 回归测试：

```powershell
lua ..\test\dispatcher_test.lua `
  "..\..\scripts\SynthVCopilotResearch\copilot\sv-scripts\StartSynthVCopilot.lua"
```

预期：`11 passed, 0 failed`。

## 安全与约束

- SynthV 的 pipe 读取是阻塞的。Relay 必须为桥发送的每一帧立即回复 `command`、`noop`、`shutdown` 或 `error`；实现和测试都维护这一不变量。
- Relay 崩溃会使 Lua 读到 EOF 并退出；Relay 仍存活但停止响应时，SynthV UI 仍可能冻结。这是 stock Lua named pipe 无超时读取的固有限制。
- 当前队列最多 64 个调用，单帧最多 64 KiB，单调用默认超时 10 秒。
- handle 在工程结构变化后可能失效，应重新调用 `sv_root`，不要长期缓存。
- 暂无运行时反射、dry-run 或原子 undo 分组；清单预检来自下载的官方文档而非宿主反射，类型未知 handle 的调用仍需调用方谨慎确认。

更完整的协议、故障模型和宿主验证清单见 [docs/architecture.md](docs/architecture.md)。

## 官方 API 文档镜像

在 `server/` 中运行以下命令，可抓取 Dreamtonics 官方英文 Scripting Manual 的
HTML 页面和静态资源，并生成带来源和 SHA-256 的清单：

```powershell
npm run download:sv-api
```

镜像输出在 `api-docs/official/`。API Manifest、MCP 文档资源和调用预检都以这份可追踪的镜像为输入。

解析本地镜像：

```powershell
npm run parse:sv-api
```

它会生成 `api-docs/api-manifest.json` 与 `api-docs/api-inventory.json`，其中保留类、继承、
成员、方法重载、参数、返回类型、版本提示、回调参数及原始文档锚点。
