local bridgePath = assert(arg[1], "pass StartSynthVCopilot.lua as arg 1")

local scheduled = nil
local finished = false
local boxContent = nil

local function makeObject(methods)
  methods.__ptr__ = "native"
  return methods
end

local project = makeObject({
  getFileName = function() return "PipeProject" end,
  getNumTracks = function() return 3 end,
  getTimeAxis = function() return makeObject({}) end,
  getStruct = function() return { bpm = 160, position = 0 } end,
})

SV = {
  QUARTER = 705600,
  setTimeout = function(_, _delay, callback) scheduled = callback end,
  finish = function() finished = true end,
  showMessageBox = function() end,
  getHostInfo = function() return { hostVersion = "2.0.0", hostVersionNumber = 0x020000 } end,
  getProject = function() return project end,
  getMainEditor = function() return makeObject({}) end,
  getArrangement = function() return makeObject({}) end,
  getPlayback = function() return makeObject({}) end,
  create = function(_, objectType)
    return makeObject({ getType = function() return objectType end })
  end,
  boxSet = function(_, value) boxContent = value end,
  boxGet = function() return boxContent end,
}

dofile(bridgePath)
main()

-- 测试宿主用同步循环模拟 SynthV 的 setTimeout 调度；管道读会自然控制节奏。
while not finished do
  assert(scheduled, "bridge stopped scheduling ticks")
  local callback = scheduled
  scheduled = nil
  callback()
end
