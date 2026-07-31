-- 开发入口的离线验收：用真实 Lua 解释器加载 DevSVCopilotFileBridge.lua，
-- 让它去加载真实桥，然后通过文件 IPC 发命令。
--
-- 这个 harness 只提供 SV 宿主的替身（与 pipe_bridge_harness.lua 同一手法），
-- 不替换任何被测代码：dispatcher 来自真实桥，传输来自开发入口。
--
-- 用法: lua dev_file_bridge_harness.lua <DevSVCopilotFileBridge.lua> <dir>

local devScript = assert(arg[1], "pass DevSVCopilotFileBridge.lua as arg 1")
local dir = assert(arg[2], "pass the dev dir as arg 2")

local scheduled = nil
local finished = false
local messages = {}

local function makeObject(methods)
  methods.__ptr__ = "native"
  return methods
end

local notes = {}
for index = 1, 3 do
  local state = {
    onset = (index - 1) * 705600000,
    duration = 705600000,
    pitch = 60 + index,
    lyrics = "n" .. index,
  }
  notes[index] = makeObject({
    getType = function() return "Note" end,
    getIndexInParent = function() return index end,
    getOnset = function() return state.onset end,
    getDuration = function() return state.duration end,
    getPitch = function() return state.pitch end,
    getLyrics = function() return state.lyrics end,
    getPhonemes = function() return "" end,
    getLanguageOverride = function() return "" end,
    getDetune = function() return 0 end,
  })
end

local group = makeObject({
  getType = function() return "NoteGroup" end,
  getName = function() return "DevGroup" end,
  getUUID = function() return "dev-uuid" end,
  getNumNotes = function() return #notes end,
  getNote = function(_, i) return notes[i] end,
})

local project = makeObject({
  getType = function() return "Project" end,
  getFileName = function() return "DevProject" end,
  getNumTracks = function() return 1 end,
})

SV = {
  QUARTER = 705600000,
  setTimeout = function(_, _delay, callback) scheduled = callback end,
  finish = function() finished = true end,
  showMessageBox = function(_, _title, text) messages[#messages + 1] = tostring(text) end,
  getHostInfo = function() return { hostVersion = "2.2.1", hostVersionNumber = 0x020201 } end,
  getProject = function() return project end,
  getMainEditor = function() return makeObject({}) end,
  getArrangement = function() return makeObject({}) end,
  getPlayback = function() return makeObject({}) end,
  create = function() return makeObject({}) end,
}

-- 让开发脚本用我们指定的目录与桥路径。
-- 桥路径只在调用方没给的时候才兜底：失败路径的测试要能指向一个不存在的桥，
-- 若这里无条件覆盖，那种测试就永远测不到 loadfile 失败。
local realGetenv = os.getenv
local bridgePath = realGetenv("SV_COPILOT_BRIDGE_PATH")
if not bridgePath or bridgePath == "" then
  bridgePath = devScript:gsub("DevSVCopilotFileBridge%.lua$", "StartSynthVCopilot.lua")
end
os.getenv = function(name)
  if name == "SV_COPILOT_DEV_DIR" then return dir end
  if name == "SV_COPILOT_BRIDGE_PATH" then return bridgePath end
  return realGetenv(name)
end

-- 模拟 SV2 的加载方式。
--
-- SV2 不用 loadfile 加载脚本，而是读出正文再 load(源码)。差别是可观测的：
-- 此时 debug.getinfo().source 是**整段正文**而不是 "@路径"。真实故障就出在这里
-- ——朴素的路径推导从源码里切出一段假目录，把 16KB 正文当路径喂给 loadfile。
-- dofile 会给出 "@路径"，因此用 dofile 的 harness 永远测不到这个故障。
local function loadLikeSV2(scriptPath)
  local handle = assert(io.open(scriptPath, "rb"))
  local source = handle:read("*a")
  handle:close()
  local chunk = assert(load(source))
  chunk()
end

if os.getenv("SV_COPILOT_TEST_LOAD_AS_SOURCE") == "1" then
  loadLikeSV2(devScript)
else
  dofile(devScript)
end
main()

-- 驱动 tick 循环：真实 SV 靠 setTimeout 调度，这里同步跑。
local ticks = 0
while not finished and ticks < 4000 do
  if not scheduled then break end
  local callback = scheduled
  scheduled = nil
  callback()
  ticks = ticks + 1
end

print("ticks=" .. ticks .. " finished=" .. tostring(finished))
for _, message in ipairs(messages) do print("MSGBOX: " .. message) end
