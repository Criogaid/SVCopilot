local bridgePath = assert(arg[1], "pass StartSynthVCopilot.lua as arg 1")

local scheduled = nil
local finished = false
local boxContent = nil

local function makeObject(methods)
  methods.__ptr__ = "native"
  return methods
end

local noteState = {
  { onset = 0, duration = 705600, pitch = 60, lyrics = "a", phonemes = "", language = "", detune = 0 },
  { onset = 705600, duration = 705600, pitch = 62, lyrics = "i", phonemes = "", language = "", detune = 0 },
}
local notes = {}
for index, state in ipairs(noteState) do
  notes[index] = makeObject({
    getIndexInParent = function() return index end,
    getOnset = function() return state.onset end,
    getDuration = function() return state.duration end,
    getPitch = function() return state.pitch end,
    getLyrics = function() return state.lyrics end,
    getPhonemes = function() return state.phonemes end,
    getLanguageOverride = function() return state.language end,
    getDetune = function() return state.detune end,
    setLyrics = function(_, value) state.lyrics = value end,
    setPhonemes = function(_, value) state.phonemes = value end,
    setLanguageOverride = function(_, value) state.language = value end,
  })
end

local group = makeObject({
  getName = function() return "Pipe Group" end,
  getUUID = function() return "pipe-group-1" end,
  getNumNotes = function() return #notes end,
  getNote = function(_, index) return notes[index] end,
})
local groupReference = makeObject({
  getIndexInParent = function() return 1 end,
  getTarget = function() return group end,
  isInstrumental = function() return false end,
  isMain = function() return true end,
  getOnset = function() return 0 end,
  getTimeOffset = function() return 0 end,
  getPitchOffset = function() return 0 end,
  getVoice = function() return { paramTension = 0, paramBreathiness = 0 } end,
})
local track = makeObject({
  getIndexInParent = function() return 1 end,
  getName = function() return "Pipe Vocal" end,
  getNumGroups = function() return 1 end,
  getGroupReference = function(_, index) if index == 1 then return groupReference end end,
})
local selection = makeObject({
  getSelectedNotes = function() return notes end,
})
local mainEditor = makeObject({
  getCurrentTrack = function() return track end,
  getCurrentGroup = function() return groupReference end,
  getSelection = function() return selection end,
})
local undoCount = 0
local project = makeObject({
  getFileName = function() return "PipeProject" end,
  getNumTracks = function() return 3 end,
  getTrack = function(_, index) if index >= 1 and index <= 3 then return track end end,
  getTimeAxis = function() return makeObject({}) end,
  getStruct = function() return { bpm = 160, position = 0 } end,
  getEmpty = function() return {} end,
  getSparse = function() return { [2] = 62.5, [4] = 64 } end,
  newUndoRecord = function() undoCount = undoCount + 1; return undoCount end,
})

SV = {
  QUARTER = 705600,
  setTimeout = function(_, _delay, callback) scheduled = callback end,
  finish = function() finished = true end,
  showMessageBox = function() end,
  getHostInfo = function() return { hostVersion = "2.0.0", hostVersionNumber = 0x020000 } end,
  getProject = function() return project end,
  getMainEditor = function() return mainEditor end,
  getArrangement = function() return makeObject({}) end,
  getPlayback = function() return makeObject({}) end,
  create = function(_, objectType)
    return makeObject({ getType = function() return objectType end })
  end,
  boxSet = function(_, value) boxContent = value end,
  boxGet = function() return boxContent end,
  getPhonemesForGroup = function()
    local values = {}
    for index, state in ipairs(noteState) do values[index] = state.lyrics .. "-phoneme" end
    return values
  end,
  getComputedAttributesForGroup = function()
    local values = {}
    for index, state in ipairs(noteState) do values[index] = { phonemes = { state.lyrics } } end
    return values
  end,
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
