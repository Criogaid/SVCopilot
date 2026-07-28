# SV Copilot

SV Copilot 让支持 MCP 的 AI 助手直接读取和编辑 Synthesizer V Studio 2 工程。
它通过 SynthV 官方 Lua API 工作，适合歌词处理、音符编辑、参数调校、演唱分析和试听确认。

## 主要能力

- 读取工程、轨道、音符、歌词、声线参数、参数曲线和计算音高。
- 按小节、拍号、轨道或乐句范围获取音乐语义快照。
- 局部修改歌词、音素、音高、时值、语言、演唱属性和 Automation 曲线。
- 插入、删除、拆分、合并音符，并支持整段乐句事务。
- 分析音域、节奏、调性倾向、呼吸、歌词韵律、音高偏差和演唱风格。
- 规划量化、和声、歌词对齐、表情处理、音高过渡、颤音和其他音高控制。
- 控制指定范围试听，并进行 A/B 试听编排。
- 通过底层调用入口访问 SynthV 已公开但尚未封装的官方 API。

高层写入工具支持 dry-run、陈旧上下文检测、目标身份校验、单次 Undo、回读验证和失败补偿。

## 使用条件

- Windows
- Synthesizer V Studio 2
- Node.js 18 或更高版本
- 支持 MCP 的客户端

## 安装

在 PowerShell 中运行：

```powershell
$svBase = Join-Path $env:APPDATA "Dreamtonics\Synthesizer V Studio 2"
$repo = Join-Path $svBase "SVCopilot"
$scriptDir = Join-Path $svBase "scripts\SV Copilot"

git clone https://github.com/Criogaid/SVCopilot.git $repo
New-Item -ItemType Directory -Path $scriptDir -Force | Out-Null
Copy-Item (Join-Path $repo "staging\StartSynthVCopilotPipe.lua") `
  (Join-Path $scriptDir "StartSynthVCopilot.lua") -Force

Set-Location (Join-Path $repo "server")
npm install
```

将 MCP 客户端配置为启动 `server/src/index.js`：

```json
{
  "mcpServers": {
    "sv-copilot": {
      "command": "node",
      "args": [
        "C:\\Users\\<用户名>\\AppData\\Roaming\\Dreamtonics\\Synthesizer V Studio 2\\SVCopilot\\server\\src\\index.js"
      ]
    }
  }
}
```

## 启动

1. 先启动 MCP 客户端，让 SV Copilot server 建立通信管道。
2. 在 SynthV 中执行 **Scripts → Rescan**。
3. 执行 **Scripts → SV Copilot → Start SV Copilot (pipe)**。
4. 让 MCP 客户端调用 `sv_ping`；返回 `pong` 即连接成功。

关闭 MCP 客户端或 server 后，SynthV 端的桥接脚本会随通信连接结束。

## 推荐工作流

1. 用范围快照读取目标乐句和上下文。
2. 先让分析或规划工具给出证据、警告和 dry-run 方案。
3. 确认目标身份与预期差异后再提交。
4. 等待音素或计算音高处理完成。
5. 重新读取结果，并由人完成最终试听判断。

## 安全提示

- 正式编辑前请保存工程或建立副本。
- 优先使用高层事务工具；底层调用不会自动提供通用回滚。
- 不要自动重试 `outcome_unknown`、`partial` 或恢复失败的写入。
- 同一 NoteGroup 被多个引用共享时，修改可能同时影响多个位置；工具会要求显式确认。
- AI 无法从试听控制本身听见声音，最终音色、咬字和情绪判断仍需要人耳确认。

## 已知限制

SynthV 当前公开 API 不提供已安装声库枚举、可用 Singer 枚举、Singer 身份查询或音频渲染接口。
SV Copilot 会明确报告这些能力不可观察，不会通过 UI 自动化伪装成官方能力。
