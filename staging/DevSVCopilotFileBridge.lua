--[[
  开发专用入口：以文件 IPC 反转连接方向，让宿主可以先启动。

  为什么需要它
  ------------
  正式路径（StartSynthVCopilotPipe.lua）用两根 Windows named pipe，而 SV2 的 Lua 只能
  用 io.open 当**客户端**连管道——它无法自己监听。因此正式路径天然是「MCP 先起、
  SV2 后连」，顺序反了就只能看到 "Start the MCP server first"。

  文件 IPC 没有连接概念：脚本先加载也没问题，它就在那里轮询。任何工具想调用的时候
  写一个命令文件即可，不想调用了直接走开，双方都不需要通知对方。

  它不是第二个 dispatcher
  -----------------------
  本文件**只替换传输层**。它桩掉 io.open，把桥的两根管道换成文件背书的假句柄，
  然后加载真实桥并调用它的 main()。于是 handle 表、marshal/unmarshal、typed-v2、
  bulk opcode、错误语义全部来自唯一那份实现。复制一份 dispatch 才是真正的危险：
  两份会各自漂移，开发期观察到的行为就不再能说明正式路径的行为。
  test/dispatcher_test.lua 用的是同一手法。

  它绝不影响正式路径
  ------------------
  - 不修改 StartSynthVCopilotPipe.lua，只 loadfile 读它；
  - 不碰 \\.\pipe\SVCopilot-* 管道，因此可与正式桥同时加载；
  - 目录独立（默认 %TEMP%\sv-copilot-dev），与历史 file IPC 的 sv-copilot 也不同名。

  用法
  ----
  1. SV2 里加载本脚本（随时，不需要先起 MCP）。
  2. 外部写 <dir>\command.json（tmp+rename 保证原子），轮询 <dir>\response.json。
     命令形状与桥的 op 完全一致：{"id":1,"op":"ping"}
  3. <dir>\state.json 是心跳，用来判断脚本是否真的在跑。
  4. 停止：发 {"id":N,"op":"__dev_stop__"}，或在 SV2 里停止脚本。

  调用方必须知道的一件事：rename 要重试
  ------------------------------------
  本脚本每 20ms 打开一次 command.json 检查新命令。Windows 上，当目标文件正被打开时
  rename 会失败（EPERM），因此调用方的「tmp → command.json」偶尔会撞上这个窗口。
  这不是错误状态，重试即可——用几毫秒退避重试若干次。轮询式文件 IPC 的代价就在这里，
  换来的是"谁先启动都行"。
]]

local DEV_PROTO = 1
-- 与正式桥的 IDLE_MS 同量级：SV 的 Lua 跑在 UI 线程上，间隔太小会抢 UI 时间。
local DEV_IDLE_MS = 20
-- 心跳每 N 次空转写一次。每 tick 都写会变成每秒 50 次文件写，
-- 而心跳只需要回答"它还活着吗"。
local HEARTBEAT_EVERY_TICKS = 25

-- ===================================================================== --
-- 最小 JSON。
--
-- 不能复用桥里的那份：它是 `local json`，加载后在本文件作用域不可见。
-- 这里只需要处理自己产生和消费的帧（扁平命令对象、短状态对象），因此刻意写小；
-- 音乐数据的编解码全部发生在桥内部，用的是桥自己的 json。
-- ===================================================================== --
local function jsonEscape(text)
  text = text:gsub("[\\\"]", "\\%0")
  text = text:gsub("\n", "\\n"):gsub("\r", "\\r"):gsub("\t", "\\t")
  text = text:gsub("%c", function(c) return string.format("\\u%04x", string.byte(c)) end)
  return text
end

local function jsonStringify(value)
  local kind = type(value)
  if value == nil then return "null" end
  if kind == "boolean" then return tostring(value) end
  if kind == "number" then
    -- 整数不要写成 1.0：桥的 id 比较是数值的，但日志与响应文件是给人看的。
    if value == math.floor(value) and math.abs(value) < 2 ^ 53 then
      return string.format("%d", value)
    end
    return tostring(value)
  end
  if kind == "string" then return '"' .. jsonEscape(value) .. '"' end
  if kind ~= "table" then return "null" end

  -- 判定数组还是对象：连续 1..n 视为数组。
  local count = 0
  for _ in pairs(value) do count = count + 1 end
  local isArray = count > 0
  for index = 1, count do
    if value[index] == nil then
      isArray = false
      break
    end
  end

  local parts = {}
  if isArray then
    for index = 1, count do parts[#parts + 1] = jsonStringify(value[index]) end
    return "[" .. table.concat(parts, ",") .. "]"
  end
  -- 键序稳定：便于人读 diff，也让响应文件逐字节可比。
  local keys = {}
  for key in pairs(value) do keys[#keys + 1] = tostring(key) end
  table.sort(keys)
  for _, key in ipairs(keys) do
    parts[#parts + 1] = '"' .. jsonEscape(key) .. '":' .. jsonStringify(value[key])
  end
  return "{" .. table.concat(parts, ",") .. "}"
end

local parseValue

local function skipSpace(text, pos)
  local _, stop = text:find("^[ \n\r\t]*", pos)
  return stop + 1
end

local function parseString(text, pos)
  local out = {}
  pos = pos + 1
  while true do
    local char = text:sub(pos, pos)
    if char == "" then error("unterminated string") end
    if char == '"' then return table.concat(out), pos + 1 end
    if char == "\\" then
      local escape = text:sub(pos + 1, pos + 1)
      local map = { n = "\n", r = "\r", t = "\t", b = "\b", f = "\f" }
      if escape == "u" then
        local hex = text:sub(pos + 2, pos + 5)
        out[#out + 1] = string.char(tonumber(hex, 16) % 256)
        pos = pos + 6
      else
        out[#out + 1] = map[escape] or escape
        pos = pos + 2
      end
    else
      out[#out + 1] = char
      pos = pos + 1
    end
  end
end

parseValue = function(text, pos)
  pos = skipSpace(text, pos)
  local char = text:sub(pos, pos)
  if char == "{" then
    local object = {}
    pos = skipSpace(text, pos + 1)
    if text:sub(pos, pos) == "}" then return object, pos + 1 end
    while true do
      local key
      key, pos = parseString(text, skipSpace(text, pos))
      pos = skipSpace(text, pos)
      if text:sub(pos, pos) ~= ":" then error("expected :") end
      local value
      value, pos = parseValue(text, pos + 1)
      object[key] = value
      pos = skipSpace(text, pos)
      local delim = text:sub(pos, pos)
      if delim == "}" then return object, pos + 1 end
      if delim ~= "," then error("expected , or }") end
      pos = pos + 1
    end
  end
  if char == "[" then
    local array = {}
    pos = skipSpace(text, pos + 1)
    if text:sub(pos, pos) == "]" then return array, pos + 1 end
    while true do
      local value
      value, pos = parseValue(text, pos)
      array[#array + 1] = value
      pos = skipSpace(text, pos)
      local delim = text:sub(pos, pos)
      if delim == "]" then return array, pos + 1 end
      if delim ~= "," then error("expected , or ]") end
      pos = pos + 1
    end
  end
  if char == '"' then return parseString(text, pos) end
  if text:sub(pos, pos + 3) == "true" then return true, pos + 4 end
  if text:sub(pos, pos + 4) == "false" then return false, pos + 5 end
  if text:sub(pos, pos + 3) == "null" then return nil, pos + 4 end
  local numberText = text:match("^-?%d+%.?%d*[eE]?[-+]?%d*", pos)
  if numberText and numberText ~= "" then
    return tonumber(numberText), pos + #numberText
  end
  error("unexpected character at " .. pos .. ": " .. char)
end

local function jsonParse(text)
  local value = parseValue(text, 1)
  return value
end

-- ===================================================================== --
-- 文件访问
-- ===================================================================== --

local function devDir()
  local override = os.getenv("SV_COPILOT_DEV_DIR")
  if override and override ~= "" then return override end
  local temp = os.getenv("TEMP") or os.getenv("TMP") or "."
  return temp .. "\\sv-copilot-dev"
end

local DIR = devDir()
local COMMAND_FILE = DIR .. "\\command.json"
local RESPONSE_FILE = DIR .. "\\response.json"
local STATE_FILE = DIR .. "\\state.json"

-- io.open 稍后会被桩掉；先留住真实实现供本文件自己读写文件用。
local realOpen = io.open

local BRIDGE_FILENAME = "StartSynthVCopilotPipe.lua"

local function fileReadable(path)
  local handle = realOpen(path, "rb")
  if not handle then return false end
  handle:close()
  return true
end

-- debug.getinfo 在 SV2 里**不给路径**：宿主用 load(源码文本) 加载脚本，因此
-- source 是整段正文而不是 "@路径"。而正文里必然含有 "/"，于是朴素的
-- `source:match("^(.*)[\\/][^\\/]*$")` 会从代码里切出一段假目录，把 16KB 源码
-- 当路径喂给 loadfile——观察到的现象就是一个超长的 usage 弹窗。
--
-- 因此这里只在 source 真的是 "@路径" 时才采信它，其余情况靠候选路径探测。
local function scriptDirFromDebug()
  if type(debug) ~= "table" or type(debug.getinfo) ~= "function" then return nil end
  local ok, info = pcall(debug.getinfo, 1, "S")
  if not ok or type(info) ~= "table" then return nil end
  local source = info.source
  -- 只认 "@" 前缀：那是 Lua 对"从文件加载"的标记。没有它就说明拿到的是正文，
  -- 此时任何 match 出来的东西都不是路径。
  if type(source) ~= "string" or source:sub(1, 1) ~= "@" then return nil end
  return source:sub(2):match("^(.*)[\\/][^\\/]*$")
end

local function resolveBridgePath()
  local override = os.getenv("SV_COPILOT_BRIDGE_PATH")
  if override and override ~= "" then return override end

  local candidates = {}
  -- 换名而不是写死路径：两个脚本始终同目录，改名只需改一处。
  local scriptDir = scriptDirFromDebug()
  if scriptDir then candidates[#candidates + 1] = scriptDir .. "\\" .. BRIDGE_FILENAME end
  -- SV2 的脚本目录：宿主把 scripts/ 递归扫描，因此桥固定在本文件旁边。
  -- APPDATA 是这个安装位置的稳定锚点，与 debug 表是否可用无关。
  local appData = os.getenv("APPDATA")
  if appData and appData ~= "" then
    candidates[#candidates + 1] = appData
      .. "\\Dreamtonics\\Synthesizer V Studio 2\\scripts"
      .. "\\SynthVCopilotResearch\\copilot\\sv-scripts\\"
      .. BRIDGE_FILENAME
  end
  candidates[#candidates + 1] = BRIDGE_FILENAME

  for _, candidate in ipairs(candidates) do
    if fileReadable(candidate) then return candidate end
  end
  -- 一个都不可读：返回第一个候选，让 loadfile 的错误里出现一个**真实路径**。
  -- 返回源码正文会让错误信息本身变成 16KB 噪音，掩盖真正的问题。
  return candidates[1]
end

local function ensureDir()
  -- Lua 标准库没有 mkdir，SV2 也不带 lfs；目录已存在时 mkdir 返回非零，忽略。
  os.execute('mkdir "' .. DIR .. '" 2>nul')
end

local function readFileText(path)
  local handle = realOpen(path, "rb")
  if not handle then return nil end
  local text = handle:read("*a")
  handle:close()
  return text
end

-- 命令文件的读取必须尽快关闭句柄。Windows 上一个打开的目标文件会让写方的
-- rename 失败（EPERM），而写方每次调用都要 rename 一次命令文件——轮询间隔 20ms
-- 时这个窗口足以让开发者随机看到写入失败。readFileText 已经是"读完即关"，
-- 这条注释是为了让后来者不要把它改成长持句柄。

-- 原子写：先写 .tmp 再 rename。读方可能在任意时刻打开文件，
-- 就地覆写会让它读到半个 JSON。
local function writeFileAtomic(path, text)
  local tmp = path .. ".tmp"
  local handle = realOpen(tmp, "wb")
  if not handle then return false end
  handle:write(text)
  handle:close()
  os.remove(path)
  return os.rename(tmp, path)
end

-- ===================================================================== --
-- 假管道：把桥的「一写一读」lockstep 映射到文件上
-- ===================================================================== --
--
-- 桥每个 tick 先 write 一帧（poll 或 result），再 read 恰好一帧回复。因此这里
-- 只需实现这两个方向：
--   write(line) —— result 帧留待落盘；poll/hello 丢弃（它们不携带调用方要的信息）。
--   read("*l")  —— 有新命令就合成 command 帧，否则回 noop。
-- 桥的 tick 循环因此一行不改地继续工作。

-- 桥可能传给 command 的字段。逐个列出而不是整帧转发：命令文件来自开发者手写，
-- 原样转发会把打错的键一起送进 dispatch，而那里的 assertKnownKeys 报错信息
-- 远不如这里直白。
local COMMAND_FIELDS = {
  "op",
  "handle",
  "method",
  "args",
  "field",
  "name",
  "resultFormat",
  "resultShape",
  "resultLength",
  "indices",
  "fields",
  "target",
  "expectedGroupUuid",
  "trackIndex",
  "groupReferenceIndex",
}

local lastSeenCommandId = 0
local handshakeDone = false
local idleTicks = 0
local pendingResponse = nil

local fakeIn = {}
local fakeOut = {}

function fakeOut:write(value)
  local line = tostring(value):gsub("[\r\n]+$", "")
  if line ~= "" and line:find('"type":"result"', 1, true) then
    pendingResponse = line
  end
  return true
end

function fakeOut:flush() return true end
function fakeOut:setvbuf(_mode) return true end
function fakeOut:close() end

function fakeIn:read(_mode)
  -- 第一次读是握手：桥写完 hello 后同步等一帧 hello。
  if not handshakeDone then
    handshakeDone = true
    return '{"type":"hello","proto":2}'
  end

  -- 先落盘上一次的结果，再取新命令。顺序很重要：调用方是「写命令 → 轮询响应」，
  -- 若先取新命令，就可能在响应还没被读走时覆盖它。
  if pendingResponse then
    writeFileAtomic(RESPONSE_FILE, pendingResponse)
    pendingResponse = nil
  end

  local text = readFileText(COMMAND_FILE)
  if text and text ~= "" then
    local ok, frame = pcall(jsonParse, text)
    if ok and type(frame) == "table" and type(frame.id) == "number" then
      -- 只认严格递增的 id：命令文件会一直躺在那里，靠 id 区分"新命令"与"上一条"。
      if frame.id > lastSeenCommandId then
        lastSeenCommandId = frame.id
        idleTicks = 0
        -- 停止请求复用桥已有的 shutdown 分支，不另造一条退出路径。
        if frame.op == "__dev_stop__" then
          writeFileAtomic(
            RESPONSE_FILE,
            jsonStringify({ id = frame.id, ok = true, result = "dev bridge stopping" })
          )
          return '{"type":"shutdown"}'
        end
        local command = { type = "command", id = frame.id }
        for _, key in ipairs(COMMAND_FIELDS) do command[key] = frame[key] end
        return jsonStringify(command)
      end
    elseif not ok then
      -- 命令文件是人写的，坏 JSON 是常态。回一条带 id 的错误比静默忽略有用得多，
      -- 但没有 id 可用时只能忽略——否则会把同一个错误无限写进响应文件。
      writeFileAtomic(
        RESPONSE_FILE,
        jsonStringify({ id = lastSeenCommandId, ok = false, error = "invalid command JSON" })
      )
    end
  end

  idleTicks = idleTicks + 1
  if idleTicks % HEARTBEAT_EVERY_TICKS == 0 then
    writeFileAtomic(
      STATE_FILE,
      jsonStringify({
        state = "listening",
        devProto = DEV_PROTO,
        lastSeenCommandId = lastSeenCommandId,
        heartbeatTick = idleTicks,
      })
    )
  end
  return '{"type":"noop"}'
end

function fakeIn:close() end

-- ===================================================================== --
-- 装配
-- ===================================================================== --

-- SV2 在 main() 之前调用 getClientInfo()，因此这里的定义会被真实使用；
-- 桥加载后会用它自己的同名函数覆盖本函数，但那已经发生在调用之后。
function getClientInfo()
  return {
    -- 名字里写明 DEV：SV2 的脚本菜单里必须一眼能与正式入口区分。
    name = "DEV SV Copilot file bridge",
    category = "SV Copilot",
    author = "SV Copilot dev tooling",
    versionNumber = 1,
    minEditorVersion = 65537,
  }
end

-- 启动失败必须落盘，不能只弹窗。窗口一关，SV2 里就再也看不出脚本为什么没跑起来，
-- 而这个入口的使用者恰恰在进程外——它只能通过 state.json 观察脚本。
-- 停在 "starting" 与"根本没启动"在外部看起来一模一样，这条路径消除那个歧义。
--
-- reason 必须截断：曾经有一次 loadfile 收到的"路径"其实是整段脚本正文，于是失败
-- 原因变成 16KB 噪音，弹窗糊满屏幕、真正的问题反而看不见。诊断信息本身不该
-- 需要被诊断。
local MAX_REASON_CHARS = 400

local function failStart(reason)
  io.open = realOpen
  local text = tostring(reason)
  if #text > MAX_REASON_CHARS then
    text = text:sub(1, MAX_REASON_CHARS) .. "... [truncated " .. (#text - MAX_REASON_CHARS) .. " chars]"
  end
  writeFileAtomic(
    STATE_FILE,
    jsonStringify({ state = "failed", devProto = DEV_PROTO, reason = text })
  )
  SV:showMessageBox("DEV SV Copilot", text)
  SV:finish()
end

function main()
  ensureDir()
  -- 清掉上一轮残留：陈旧的 response 会被新调用方误读成自己那次的结果。
  os.remove(RESPONSE_FILE)
  os.remove(COMMAND_FILE)
  writeFileAtomic(
    STATE_FILE,
    jsonStringify({ state = "starting", devProto = DEV_PROTO, lastSeenCommandId = 0 })
  )

  -- resolveBridgePath 走 debug.getinfo，而 SV2 是否暴露 debug 表并无保证；
  -- 裸调用会在这里抛出并只留下一个 "starting" 状态。
  local located, bridgePath = pcall(resolveBridgePath)
  if not located then
    failStart("Cannot locate the bridge script: " .. tostring(bridgePath))
    return
  end
  local chunk, loadError = loadfile(bridgePath)
  if not chunk then
    -- 没有真实桥就没有 dispatcher 可复用。这里刻意不退化成"自己实现一个"：
    -- 那会造出第二份协议实现，而它一定会与正式路径漂移。
    failStart(
      "Cannot load the real bridge, so there is no dispatcher to reuse:\n"
        .. bridgePath
        .. "\n"
        .. tostring(loadError)
    )
    return
  end

  -- 桩掉 io.open 必须在桥的 main() 打开管道之前，且只截获桥的那两根管道；
  -- 其它文件访问（包括本文件的读写）继续走真实实现。
  io.open = function(path, mode)
    if type(path) == "string" and path:find("SVCopilot%-") then
      if mode == "rb" then return fakeIn end
      if mode == "wb" then return fakeOut end
    end
    return realOpen(path, mode)
  end

  -- 桥把 main 定义为全局函数，加载它会覆盖本文件的 main。因此先记下自己的名字
  -- 再加载，然后显式取出桥的 main——依赖"调用时全局已被替换"能工作，但那是隐式的，
  -- 读代码的人会以为这里在递归调用自己。
  --
  -- chunk() 必须保护：桥在加载期就会碰 SV（顶层常量、getHostInfo 等），SV2 里任何
  -- 一处抛出都会让 main 停在桥的版本、io.open 停在桩上，而外部只看到 "starting"。
  local devMain = main
  local loaded, chunkError = pcall(chunk)
  local bridgeMain = main
  main = devMain
  if not loaded then
    failStart("The bridge failed while loading: " .. tostring(chunkError))
    return
  end

  if type(bridgeMain) ~= "function" then
    failStart("the bridge did not define main()")
    return
  end

  -- IDLE_MS 是桥的全局变量，因此可以按开发节奏覆盖，不必改桥的源码。
  IDLE_MS = DEV_IDLE_MS

  -- 桥的 main() 会握手然后进入自己的 tick 循环；上面的假管道让那个循环读写文件。
  --
  -- 这里同样要保护：桥的 main() 只在**握手同步段**里跑，之后交给 SV:setTimeout。
  -- 也就是说，这个 pcall 覆盖的是握手，不是整个会话——tick 里的错误由桥自己的
  -- finish() 处理，不会回到这里。
  -- 这里不写 "listening"：那是心跳的职责，而心跳带着真实的 lastSeenCommandId。
  -- 在这里补一条只会多出一个写者，并偶尔把计数抹回 0；何况 bridgeMain() 返回
  -- 仅代表握手同步段结束，证明不了循环仍在跑——恰恰是心跳要回答的问题。
  local started, startError = pcall(bridgeMain)
  if not started then
    failStart("The bridge failed during handshake: " .. tostring(startError))
    return
  end
end
