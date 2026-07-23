--[[
  离线回归测试：用内存 pipe 模拟 Relay 的锁步回复，驱动真实 Lua 桥的握手、
  dispatcher、marshal/unmarshal、handle 往返和错误路径。

  运行：lua dispatcher_test.lua <path-to-StartSynthVCopilot.lua>
]]

local bridgePath = assert(arg[1], "pass the path to StartSynthVCopilot.lua as arg 1")

-- opaque object standing in for a SynthV API object. Real SV objects are Lua
-- tables carrying a `__ptr__` (native pointer) plus method keys, which the
-- dispatcher marshals to a single handle. Plain data tables (no __ptr__, no
-- metatable) recurse to inline JSON instead.
local function makeObj(methods)
  methods.__ptr__ = "native"
  return methods
end

local scheduled = nil
local boxContent = nil
local incoming = {}
local outgoing = {}

local fakeIn = {}
function fakeIn:read(_mode) return table.remove(incoming, 1) end
function fakeIn:close() end

local fakeOut = {}
function fakeOut:write(value) outgoing[#outgoing + 1] = value; return true end
function fakeOut:flush() return true end
function fakeOut:setvbuf(_mode) return true end
function fakeOut:close() end

-- main() 会同步等待 hello，因此在调用前放入 Relay 的握手响应。
local session = os.getenv("SV_COPILOT_SESSION")
if not session or session == "" then session = "default" end
incoming[#incoming + 1] = '{"type":"hello","proto":1,"session":"' .. session .. '"}'

local realOpen = io.open
io.open = function(path, mode)
  if path:find("SVCopilot%-", 1, false) then
    if mode == "rb" then return fakeIn end
    if mode == "wb" then return fakeOut end
  end
  return realOpen(path, mode)
end

local project = makeObj({
  getFileName  = function() return "TestProj" end,
  getNumTracks = function() return 3 end,
  getTimeAxis  = function() return makeObj({}) end,
  getStruct    = function() return { bpm = 160, position = 0 } end,   -- plain data, must inline
  getEmpty     = function() return {} end,
  getSparse    = function() return { [2] = 62.5, [4] = 64 } end,
  getCtl       = function() return "a\1b\31c\nd" end,                 -- 控制字符必须转义成合法 JSON
  getNan       = function() return 0 / 0 end,                          -- legacy 路径 NaN 必须降级 null
})

SV = {
  QUARTER = 705600000,
  setTimeout   = function(_, _ms, fn) scheduled = fn end,
  finish       = function() end,
  showMessageBox = function() end,
  getProject   = function() return project end,
  getMainEditor= function() return makeObj({}) end,
  getArrangement = function() return makeObj({}) end,
  getPlayback  = function() return makeObj({ getStatus = function() return "stopped" end }) end,
  create       = function(_, typ) return makeObj({ getType = function() return typ end }) end,
  boxSet       = function(_, v) boxContent = v end,
  boxGet       = function() return boxContent end,
}

dofile(bridgePath)
main()

local function step(cmdJson)
  incoming[#incoming + 1] = cmdJson:gsub("^{", '{"type":"command",', 1)
  assert(scheduled, "no scheduled tick")
  scheduled()
  incoming[#incoming + 1] = '{"type":"noop"}'
  assert(scheduled, "no result tick scheduled")
  scheduled()
  return outgoing[#outgoing]
end

local passed, failed = 0, 0
local function check(name, cond, extra)
  if cond then passed = passed + 1; print("PASS  " .. name)
  else failed = failed + 1; print("FAIL  " .. name .. "\n      resp=" .. tostring(extra)) end
end

local r
r = step('{"id":1,"op":"ping"}')
check("ping -> pong", r:find('"result":"pong"', 1, true) and r:find('"ok":true', 1, true), r)

r = step('{"id":2,"op":"root"}')
local projH = r:match('"project"%s*:%s*{[^}]-"__handle__":%s*(%d+)')
check("root returns a project handle", projH ~= nil, r)

r = step('{"id":3,"op":"call","handle":' .. (projH or 0) .. ',"method":"getFileName"}')
check("project:getFileName == TestProj", r:find('"result":"TestProj"', 1, true) ~= nil, r)

r = step('{"id":4,"op":"call","handle":' .. (projH or 0) .. ',"method":"getNumTracks"}')
check("project:getNumTracks == 3", r:find('"result":3', 1, true) ~= nil, r)

r = step('{"id":5,"op":"index","field":"QUARTER"}')
check("SV.QUARTER == 705600000", r:find('"result":705600000', 1, true) ~= nil, r)

-- handle round-trip: create -> pass handle as arg -> retrieve -> call method on it
r = step('{"id":6,"op":"call","method":"create","args":["Note"]}')
local noteH = r:match('"__handle__":%s*(%d+)')
check("SV:create('Note') returns a handle", noteH ~= nil, r)

r = step('{"id":7,"op":"call","method":"boxSet","args":[{"__handle__":' .. (noteH or 0) .. '}]}')
check("boxSet(handle-arg) ok", r:find('"ok":true', 1, true) ~= nil, r)

r = step('{"id":8,"op":"call","method":"boxGet"}')
local backH = r:match('"__handle__":%s*(%d+)')
check("boxGet returns a handle", backH ~= nil, r)

r = step('{"id":9,"op":"call","handle":' .. (backH or 0) .. ',"method":"getType"}')
check("round-tripped object is the same Note (getType=='Note')", r:find('"result":"Note"', 1, true) ~= nil, r)

r = step('{"id":10,"op":"call","handle":' .. (projH or 0) .. ',"method":"noSuchMethod"}')
check("unknown method -> ok:false + error", r:find('"ok":false', 1, true) and r:find("no such method", 1, true), r)

r = step('{"id":11,"op":"call","handle":' .. (projH or 0) .. ',"method":"getStruct"}')
check("plain-data table recurses inline (no handle)",
  r:find('"bpm":160', 1, true) and not r:find('"__handle__"', 1, true), r)

r = step('{"id":12,"op":"call","handle":' .. (projH or 0) .. ',"method":"getEmpty","resultFormat":"typed-v2","resultShape":"array","resultLength":0}')
check("typed empty array keeps its shape",
  r:find('"$sv":"array"', 1, true) and r:find('"length":0', 1, true), r)

r = step('{"id":13,"op":"call","handle":' .. (projH or 0) .. ',"method":"getSparse","resultFormat":"typed-v2","resultShape":"array","resultLength":4}')
check("typed sparse array keeps length and indexes",
  r:find('"$sv":"sparse%-array"') and r:find('"length":4', 1, true), r)

r = step('{"id":14,"op":"index","field":"MISSING"}')
check("unknown field -> ok:false + error",
  r:find('"ok":false', 1, true) and r:find("no such field", 1, true), r)

-- 控制字符出站转义：<0x20（除具名转义）必须写成 \u00XX，帧才是合法 JSON。
r = step('{"id":15,"op":"call","handle":' .. (projH or 0) .. ',"method":"getCtl"}')
check("control characters escape to \\u00XX and named \\n survives",
  r:find('\\u0001', 1, true) and r:find('\\u001f', 1, true) and r:find('a\\u0001b', 1, true)
    and r:find('c\\nd', 1, true), r)

-- 入站 \uXXXX 解码：Node 对 <0x20 只发 \u00XX；BMP 与代理对都要能还原。
r = step('{"id":16,"op":"call","method":"boxSet","args":["A\\u0001\\u3042\\ud83c\\udfb5"]}')
check("boxSet(\\u escapes) ok", r:find('"ok":true', 1, true) ~= nil, r)
r = step('{"id":17,"op":"call","method":"boxGet"}')
check("\\u escapes round-trip (control char re-escaped, UTF-8 preserved)",
  r:find('A\\u0001\u{3042}\u{1F3B5}', 1, true) ~= nil, r)

-- legacy 数字路径的 NaN 不再产出非法 JSON（typed-v2 有 $sv:number 无损承载）。
r = step('{"id":18,"op":"call","handle":' .. (projH or 0) .. ',"method":"getNan"}')
check("legacy NaN degrades to null instead of invalid JSON",
  r:find('"result":null', 1, true) and not r:find('nan', 1, true), r)

print(string.format("\n%d passed, %d failed", passed, failed))
os.exit(failed == 0 and 0 or 1)
