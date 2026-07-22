local bridgePath = assert(arg[1], "pass StartSynthVCopilot.lua as arg 1")
local QUARTER = 705600000

local scheduled = nil
local finished = false
local boxContent = nil

local function makeObject(methods)
  methods.__ptr__ = "native"
  return methods
end

-- notes 是可变模型：makeNote 创建独立 state，group 里的顺序按 onset 保持排序。
local notes = {}

local function noteIndexOf(noteObject)
  for index, candidate in ipairs(notes) do
    if candidate == noteObject then return index end
  end
  return nil
end

local function sortNotes()
  table.sort(notes, function(a, c) return a.__state__.onset < c.__state__.onset end)
end

local makeNote
makeNote = function(state)
  local note
  note = makeObject({
    getType = function() return "Note" end,
    getIndexInParent = function() return noteIndexOf(note) end,
    getOnset = function() return state.onset end,
    getDuration = function() return state.duration end,
    getPitch = function() return state.pitch end,
    getLyrics = function() return state.lyrics end,
    getPhonemes = function() return state.phonemes end,
    getLanguageOverride = function() return state.language end,
    getDetune = function() return state.detune end,
    getAttributes = function()
      local copy = {}
      for key, value in pairs(state.attributes) do copy[key] = value end
      return copy
    end,
    clone = function()
      local attributes = {}
      for key, value in pairs(state.attributes) do attributes[key] = value end
      return makeNote({
        onset = state.onset, duration = state.duration, pitch = state.pitch,
        lyrics = state.lyrics, phonemes = state.phonemes, language = state.language,
        detune = state.detune, attributes = attributes,
      })
    end,
    setLyrics = function(_, value) state.lyrics = value end,
    setPhonemes = function(_, value) state.phonemes = value end,
    setLanguageOverride = function(_, value) state.language = value end,
    setPitch = function(_, value) state.pitch = value end,
    setOnset = function(_, value) state.onset = value; sortNotes() end,
    setDuration = function(_, value) state.duration = value end,
    setDetune = function(_, value) state.detune = value end,
    setAttributes = function(_, value)
      for key, item in pairs(value) do state.attributes[key] = item end
    end,
    setTimeRange = function(_, onset, duration)
      state.onset = onset
      state.duration = duration
      sortNotes()
    end,
  })
  note.__state__ = state
  return note
end

for _, state in ipairs({
  { onset = 0, duration = QUARTER, pitch = 60, lyrics = "a", phonemes = "", language = "", detune = 0, attributes = { tF0Offset = 0 } },
  { onset = QUARTER, duration = QUARTER, pitch = 62, lyrics = "i", phonemes = "", language = "", detune = 0, attributes = { tF0Offset = 0 } },
}) do
  notes[#notes + 1] = makeNote(state)
end

local automationPoints = { { 0, 0.0 }, { QUARTER, 0.5 } }
local automation = makeObject({
  getDefinition = function()
    return { displayName = "Loudness", typeName = "loudness", range = { -24, 24 }, defaultValue = 0 }
  end,
  getType = function() return "loudness" end,
  getInterpolationMethod = function() return "Linear" end,
  getAllPoints = function()
    local out = {}
    for index, point in ipairs(automationPoints) do out[index] = { point[1], point[2] } end
    return out
  end,
  getPoints = function(_, from, to)
    local out = {}
    for _, point in ipairs(automationPoints) do
      if point[1] >= from and point[1] <= to then out[#out + 1] = { point[1], point[2] } end
    end
    return out
  end,
  get = function(_, b)
    for _, point in ipairs(automationPoints) do
      if point[1] == b then return point[2] end
    end
    return 0
  end,
  add = function(_, b, v)
    for _, point in ipairs(automationPoints) do
      if point[1] == b then point[2] = v; return true end
    end
    automationPoints[#automationPoints + 1] = { b, v }
    table.sort(automationPoints, function(a, c) return a[1] < c[1] end)
    return true
  end,
  remove = function(_, from, to)
    local kept, removed = {}, false
    for _, point in ipairs(automationPoints) do
      if point[1] < from or point[1] > to then kept[#kept + 1] = point else removed = true end
    end
    automationPoints = kept
    return removed
  end,
  simplify = function() return false end,
})
local group = makeObject({
  getName = function() return "Pipe Group" end,
  getUUID = function() return "pipe-group-1" end,
  getNumNotes = function() return #notes end,
  getNote = function(_, index) return notes[index] end,
  addNote = function(_, note)
    notes[#notes + 1] = note
    table.sort(notes, function(a, c) return a.__state__.onset < c.__state__.onset end)
    for index, candidate in ipairs(notes) do
      if candidate == note then return index end
    end
    return #notes
  end,
  removeNote = function(_, index) table.remove(notes, index) end,
  getParameter = function(_, parameterType)
    if string.lower(parameterType) == "loudness" then return automation end
    return nil
  end,
})
local groupReference = makeObject({
  getIndexInParent = function() return 1 end,
  getTarget = function() return group end,
  isInstrumental = function() return false end,
  isMain = function() return true end,
  getOnset = function() return 0 end,
  getEnd = function() return 4 * 4 * QUARTER end,
  getTimeOffset = function() return 0 end,
  getPitchOffset = function() return 0 end,
  getVoice = function() return { paramTension = 0, paramBreathiness = 0 } end,
})
local mixerState = { gain = 0, pan = 0, muted = false, solo = false }
local mixer = makeObject({
  getGainDecibel = function() return mixerState.gain end,
  getPan = function() return mixerState.pan end,
  isMuted = function() return mixerState.muted end,
  isSolo = function() return mixerState.solo end,
  setGainDecibel = function(_, value) mixerState.gain = value end,
  setPan = function(_, value) mixerState.pan = value end,
  setMuted = function(_, value) mixerState.muted = value end,
  setSolo = function(_, value) mixerState.solo = value end,
})
local playbackState = { playhead = 2.5, status = "stopped" }
local playback = makeObject({
  getPlayhead = function() return playbackState.playhead end,
  getStatus = function() return playbackState.status end,
  seek = function(_, t) playbackState.playhead = t end,
  play = function() playbackState.status = "playing" end,
  loop = function() playbackState.status = "looping" end,
  pause = function() playbackState.status = "stopped" end,
  stop = function() playbackState.status = "stopped" end,
})
local timeAxis = makeObject({
  getSecondsFromBlick = function(_, b) return b / QUARTER * 0.5 end,
  getBlickFromSeconds = function(_, t) return math.floor(t * 2 * QUARTER + 0.5) end,
  getAllMeasureMarks = function()
    return { { position = 0, positionBlick = 0, numerator = 4, denominator = 4 } }
  end,
  getAllTempoMarks = function()
    return { { position = 0, positionSeconds = 0, bpm = 120 } }
  end,
})
local makeTrack
makeTrack = function(name)
  local trackState = { name = name }
  local trackObject
  trackObject = makeObject({
    getIndexInParent = function() return 1 end,
    getName = function() return trackState.name end,
    setName = function(_, value) trackState.name = value end,
    getNumGroups = function() return 1 end,
    getGroupReference = function(_, index) if index == 1 then return groupReference end end,
    getMixer = function() return mixer end,
    clone = function() return makeTrack(trackState.name) end,
  })
  return trackObject
end
local tracks = { makeTrack("Pipe Vocal"), makeTrack("Pipe Vocal"), makeTrack("Pipe Vocal") }
local track = tracks[1]
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
  getNumTracks = function() return #tracks end,
  getTrack = function(_, index) return tracks[index] end,
  addTrack = function(_, newTrack)
    tracks[#tracks + 1] = newTrack
    return #tracks
  end,
  getTimeAxis = function() return timeAxis end,
  getStruct = function() return { bpm = 160, position = 0 } end,
  getEmpty = function() return {} end,
  getSparse = function() return { [2] = 62.5, [4] = 64 } end,
  newUndoRecord = function() undoCount = undoCount + 1; return undoCount end,
})

SV = {
  QUARTER = QUARTER,
  setTimeout = function(_, _delay, callback) scheduled = callback end,
  finish = function() finished = true end,
  showMessageBox = function() end,
  getHostInfo = function() return { hostVersion = "2.0.0", hostVersionNumber = 0x020000 } end,
  getProject = function() return project end,
  getMainEditor = function() return mainEditor end,
  getArrangement = function() return makeObject({}) end,
  getPlayback = function() return playback end,
  create = function(_, objectType)
    if objectType == "Note" then
      return makeNote({ onset = 0, duration = QUARTER, pitch = 60, lyrics = "la", phonemes = "", language = "", detune = 0, attributes = {} })
    end
    return makeObject({ getType = function() return objectType end })
  end,
  boxSet = function(_, value) boxContent = value end,
  boxGet = function() return boxContent end,
  getPhonemesForGroup = function()
    local values = {}
    for index, note in ipairs(notes) do
      local lyrics = note.__state__.lyrics
      if lyrics ~= "" and lyrics ~= "-" then values[index] = lyrics .. "-phoneme" else values[index] = "" end
    end
    return values
  end,
  getComputedAttributesForGroup = function()
    local values = {}
    for index, note in ipairs(notes) do values[index] = { phonemes = { note.__state__.lyrics } } end
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
