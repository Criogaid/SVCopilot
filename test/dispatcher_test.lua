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

-- 批量读取夹具：200 个音符 + 一个 vocal reference 和一个 instrumental reference。
-- getIndexInParent 返回宿主的 native 1-based 索引，桥必须自己减 1。
local bulkNotes = {}
local bulkFail = { lyricsAtIndex = nil }
for i = 1, 200 do
  local state = {
    onset = (i - 1) * 705600000,
    duration = 705600000,
    pitch = 60 + (i % 12),
    lyrics = "a" .. i,
  }
  bulkNotes[i] = makeObj({
    getIndexInParent    = function() return i end,
    getOnset            = function() return state.onset end,
    getDuration         = function() return state.duration end,
    getPitch            = function() return state.pitch end,
    getLyrics           = function()
      if bulkFail.lyricsAtIndex == i then error("host getter exploded") end
      return state.lyrics
    end,
    -- 合法空音素与未设置的语言覆盖：nil 必须以 typed-v2 信封无损回传。
    getPhonemes         = function() return "" end,
    getLanguageOverride = function() return nil end,
    getDetune           = function() return i == 3 and 0 / 0 or 0 end,
  })
end

local bulkTarget = makeObj({
  getUUID     = function() return "group-uuid-1" end,
  getNumNotes = function() return #bulkNotes end,
  getNote     = function(_, index) return bulkNotes[index] end,
})
local vocalReference = makeObj({
  isInstrumental = function() return false end,
  getTarget      = function() return bulkTarget end,
})
local instrumentalReference = makeObj({
  isInstrumental = function() return true end,
})
local bulkTrack = makeObj({
  getNumGroups       = function() return 2 end,
  getGroupReference  = function(_, index)
    if index == 1 then return vocalReference end
    if index == 2 then return instrumentalReference end
    return nil
  end,
})

local project = makeObj({
  getFileName  = function() return "TestProj" end,
  getNumTracks = function() return 3 end,
  getTrack     = function(_, index) return index == 1 and bulkTrack or nil end,
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
  isNan        = function(_, v) return type(v) == 'number' and v ~= v end,
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

-- typed-v2 特殊数字入站必须反解为 Lua number，供 attributes 默认值回滚复用。
r = step('{"id":19,"op":"call","method":"isNan","args":[{"$sv":"number","value":"nan"}]}')
check("typed-v2 NaN envelope unmarshals back to a Lua number",
  r:find('"result":true', 1, true) ~= nil, r)

-- ===================================================================== --
-- read_note_fingerprints_v1：有界批量读取
-- ===================================================================== --
local FIELDS = '["indexInGroup","onsetBlick","durationBlick","pitch","lyrics",'
  .. '"phonemesOverride","languageOverride","detuneCents"]'
local function bulkCmd(id, body)
  return '{"id":' .. id .. ',"op":"read_note_fingerprints_v1",' .. body .. '}'
end

r = step(bulkCmd(20, '"trackIndex":0,"groupReferenceIndex":0,"noteIndicesInGroup":[0],"fields":["pitch"]'))
check("bulk single note returns group uuid, note count and one item",
  r:find('"ok":true', 1, true) and r:find('"groupUuid":"group%-uuid%-1"')
    and r:find('"noteCount":200', 1, true) and r:find('"noteIndexInGroup":0', 1, true)
    and r:find('"pitch":61', 1, true), r)

r = step(bulkCmd(21, '"trackIndex":0,"groupReferenceIndex":0,"noteIndicesInGroup":[0,62,124],"fields":' .. FIELDS))
check("bulk converts native index to 0-based and keeps requested order",
  r:find('"indexInGroup":0', 1, true) and r:find('"indexInGroup":62', 1, true)
    and r:find('"indexInGroup":124', 1, true)
    and r:find('"noteIndexInGroup":0', 1, true) < r:find('"noteIndexInGroup":124', 1, true), r)

check("bulk never returns a handle", r:find('"__handle__"', 1, true) == nil, r)

r = step(bulkCmd(22, '"trackIndex":0,"groupReferenceIndex":0,"noteIndicesInGroup":[0],"fields":["languageOverride","phonemesOverride"]'))
check("nil language override becomes a typed-v2 nil envelope, empty phonemes stay a string",
  r:find('"languageOverride":{"$sv":"nil"}', 1, true) and r:find('"phonemesOverride":""', 1, true), r)

r = step(bulkCmd(23, '"trackIndex":0,"groupReferenceIndex":0,"noteIndicesInGroup":[2],"fields":["detuneCents"]'))
-- Lua 的 table 迭代顺序不稳定，信封的键序不能写死；逐键断言。
check("special numbers use the typed-v2 envelope instead of invalid JSON",
  r:find('"detuneCents":{', 1, true) and r:find('"$sv":"number"', 1, true)
    and r:find('"value":"nan"', 1, true) and not r:find(':nan', 1, true), r)

local many = {}
for i = 0, 199 do many[#many + 1] = i end
r = step(bulkCmd(24, '"trackIndex":0,"groupReferenceIndex":0,"noteIndicesInGroup":['
  .. table.concat(many, ",") .. '],"fields":["pitch"]'))
check("200 notes stay within the frame budget in one op",
  r:find('"ok":true', 1, true) and r:find('"noteIndexInGroup":199', 1, true)
    and #r <= 64 * 1024, r)

many[#many + 1] = 200
r = step(bulkCmd(25, '"trackIndex":0,"groupReferenceIndex":0,"noteIndicesInGroup":['
  .. table.concat(many, ",") .. '],"fields":["pitch"]'))
check("201 notes are rejected by the bulk cap",
  r:find('"ok":false', 1, true) and r:find("exceeds 200 entries", 1, true), r)

-- 读取前的结构化 FRAME_TOO_LARGE：200 音符 × 8 字段的估算必须超预算而不是读完再撞帧上限。
r = step(bulkCmd(26, '"trackIndex":0,"groupReferenceIndex":0,"noteIndicesInGroup":['
  .. table.concat(many, ",", 1, 200) .. '],"fields":' .. FIELDS .. '}'):gsub("}}$", "}"))
check("oversized estimate returns FRAME_TOO_LARGE before reading",
  r:find('"ok":false', 1, true) and r:find("FRAME_TOO_LARGE", 1, true), r)

r = step(bulkCmd(27, '"trackIndex":0,"groupReferenceIndex":0,"noteIndicesInGroup":[0,0],"fields":["pitch"]'))
check("duplicate note index is rejected",
  r:find('"ok":false', 1, true) and r:find("duplicate note index", 1, true), r)

r = step(bulkCmd(28, '"trackIndex":0,"groupReferenceIndex":0,"noteIndicesInGroup":[200],"fields":["pitch"]'))
check("out-of-range note index is rejected with the observed note count",
  r:find('"ok":false', 1, true) and r:find("note index out of range: 200", 1, true)
    and r:find("noteCount 200", 1, true), r)

r = step(bulkCmd(29, '"trackIndex":0,"groupReferenceIndex":0,"expectedGroupUuid":"stale-uuid",'
  .. '"noteIndicesInGroup":[0],"fields":["pitch"]'))
check("stale expectedGroupUuid fails the whole batch",
  r:find('"ok":false', 1, true) and r:find("STALE_GROUP_UUID", 1, true), r)

r = step(bulkCmd(30, '"trackIndex":0,"groupReferenceIndex":0,"expectedGroupUuid":"group-uuid-1",'
  .. '"noteIndicesInGroup":[0],"fields":["pitch"]'))
check("matching expectedGroupUuid passes", r:find('"ok":true', 1, true) ~= nil, r)

r = step(bulkCmd(31, '"trackIndex":0,"groupReferenceIndex":0,"noteIndicesInGroup":[0],"fields":["getNote"]'))
check("fields outside the allowlist are rejected",
  r:find('"ok":false', 1, true) and r:find("unsupported fingerprint field", 1, true), r)

r = step(bulkCmd(32, '"trackIndex":0,"groupReferenceIndex":0,"noteIndicesInGroup":[0],"fields":[]'))
check("empty fields array is rejected",
  r:find('"ok":false', 1, true) and r:find("non%-empty array"), r)

r = step(bulkCmd(33, '"trackIndex":0,"groupReferenceIndex":1,"noteIndicesInGroup":[0],"fields":["pitch"]'))
check("instrumental reference is rejected before any note read",
  r:find('"ok":false', 1, true) and r:find("instrumental", 1, true), r)

r = step(bulkCmd(34, '"trackIndex":9,"groupReferenceIndex":0,"noteIndicesInGroup":[0],"fields":["pitch"]'))
check("out-of-range trackIndex is rejected",
  r:find('"ok":false', 1, true) and r:find("trackIndex out of range", 1, true), r)

r = step(bulkCmd(35, '"trackIndex":0,"groupReferenceIndex":9,"noteIndicesInGroup":[0],"fields":["pitch"]'))
check("out-of-range groupReferenceIndex is rejected",
  r:find('"ok":false', 1, true) and r:find("groupReferenceIndex out of range", 1, true), r)

r = step(bulkCmd(36, '"trackIndex":0,"groupReferenceIndex":0,"noteIndicesInGroup":[-1],"fields":["pitch"]'))
check("negative note index is rejected",
  r:find('"ok":false', 1, true) and r:find("non%-negative integer"), r)

r = step(bulkCmd(37, '"trackIndex":0,"groupReferenceIndex":0,"noteIndicesInGroup":[0],'
  .. '"fields":["pitch","pitch"]'))
check("duplicate field is rejected",
  r:find('"ok":false', 1, true) and r:find("duplicate field", 1, true), r)

r = step(bulkCmd(38, '"trackIndex":0,"groupReferenceIndex":0,"noteIndicesInGroup":[0],'
  .. '"fields":["pitch"],"resultFormat":"legacy"'))
check("legacy resultFormat is rejected; bulk is typed-v2 only",
  r:find('"ok":false', 1, true) and r:find("only supports resultFormat typed%-v2"), r)

-- 批中途 getter 抛错必须整批失败，绝不返回可能错位的部分结果。
bulkFail.lyricsAtIndex = 63
r = step(bulkCmd(39, '"trackIndex":0,"groupReferenceIndex":0,"noteIndicesInGroup":[0,62,124],'
  .. '"fields":["lyrics"]'))
check("a getter throwing mid-batch fails the whole batch",
  r:find('"ok":false', 1, true) and r:find("host getter exploded", 1, true)
    and not r:find('"items"', 1, true), r)
bulkFail.lyricsAtIndex = nil

r = step('{"id":40,"op":"read_note_fingerprints_v2","trackIndex":0}')
check("unknown opcode still fails cleanly instead of hanging",
  r:find('"ok":false', 1, true) and r:find("unknown op", 1, true), r)

-- 能力协商：握手必须宣告 opcode，旧 Relay 忽略该字段即可。
local helloFrame = outgoing[1]
check("hello advertises the bulk opcode for capability negotiation",
  helloFrame and helloFrame:find('"ops"', 1, true)
    and helloFrame:find("read_note_fingerprints_v1", 1, true)
    and helloFrame:find('"proto":1', 1, true), helloFrame)

print(string.format("\n%d passed, %d failed", passed, failed))
os.exit(failed == 0 and 0 or 1)
