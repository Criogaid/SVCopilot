-- SV Api Surface Probe —— 枚举宿主运行时真实存在的脚本 API 成员与只读返回形状，并写成 JSON。
--
-- 为什么需要它：SVCopilot 的 api-docs/api-manifest.json 完全由官方 HTML 文档解析而来，
-- 从未与实机比对过。文档漏写的方法在 host-session 的 validateApiCall 里只会得到一条
-- advisory，随后失去参数校验与返回句柄类型推断，handleTypes 从此断链。
--
-- 为什么必须在宿主内跑：SV API 对象是带 __ptr__/metatable 的普通 Lua 表，方法即键，
-- 因此 pairs() 可以直接枚举；而 SVCopilot 桥只有 index/call，两者都是单键查找
-- （obj[name]），必须预先知道名字，天生发现不了文档之外的东西。
--
-- 安全边界（这是一个只读探针）：
--   * 绝不调用任何 set* / add* / remove* / clear* / new* —— 见 isProbeSafe。
--   * 零参试调只针对 get*/is*/has* 白名单，且每次 pcall 隔离，失败只记类别码。
--   * SV:create() 出来的对象是临时的，绝不加入工程，函数返回后即丢弃。
--   * 返回值只记录字段名与类型，不记录字符串、数字、歌词、路径或声库名称等实际值。
--   * getVoice/getScale/getFxParams 会跨工程实例聚合 shape，但不记录轨道/音符组身份。
--   * 不写工程、不建 Undo 记录、不碰 selection、不修改播放状态。
--
-- 输出：直接写盘（绕开 SVCopilot 桥的 64 KiB 帧上限），默认落在
--   %LOCALAPPDATA%\SVCopilot\api-surface\api-surface-<version>-<platform>-<ts>.json
-- 随后用 SVCopilot 仓库里的工具比对：
--   cd server && npm run api-surface:diff -- --input <上面那个文件>

local PROBE_NAME = "SVApiSurfaceProbe"
local PROBE_VERSION = "2"
local CAPTURE_KIND = "svcopilot-api-surface-capture"
local SCHEMA_VERSION = "1.1.0"

-- 试调开关。关掉它只枚举名字，一次宿主调用都不发。
local TRIAL_CALLS = true
local VALUE_SHAPES = true

local SHAPE_MAX_DEPTH = 4
local SHAPE_MAX_FIELDS = 64
local SHAPE_MAX_ARRAY_ITEMS = 4
local SHAPE_MAX_NODES = 256
local SEMANTIC_MAX_TRACKS = 128
local SEMANTIC_MAX_GROUPS = 1024

function getClientInfo()
  return {
    name = "SV Api Surface Probe",
    category = "SV Copilot",
    author = "SV Copilot",
    versionNumber = 2,
    minEditorVersion = 65537,
  }
end

-- ===================================================================== --
-- JSON 编码（纯 Lua，只需 stringify）
-- 与 SVLiveProbe.lua 同源：json.array() 用 metatable 标记，好让空数组输出 []
-- 而不是 {}。控制字符不转义成 \uXXXX——枚举结果只含标识符与短码，够用。
-- ===================================================================== --
local json = {}
local JSON_ARRAY_METATABLE = {}

function json.array()
  return setmetatable({}, JSON_ARRAY_METATABLE)
end

local function kindOf(value)
  if type(value) ~= "table" then return type(value) end
  if getmetatable(value) == JSON_ARRAY_METATABLE then return "array" end
  local nextIndex = 1
  for _ in pairs(value) do
    if value[nextIndex] ~= nil then
      nextIndex = nextIndex + 1
    else
      return "table"
    end
  end
  return nextIndex == 1 and "table" or "array"
end

local function escapeString(value)
  local input = { "\\", '"', "\b", "\f", "\n", "\r", "\t" }
  local output = { "\\", '"', "b", "f", "n", "r", "t" }
  for index, character in ipairs(input) do
    value = value:gsub(character, "\\" .. output[index])
  end
  return value
end

function json.stringify(value, asKey)
  local kind = kindOf(value)
  if kind == "nil" then return "null" end
  if kind == "string" then return '"' .. escapeString(value) .. '"' end
  if kind == "number" then
    if asKey then return '"' .. tostring(value) .. '"' end
    if math.type and math.type(value) == "integer" then return tostring(value) end
    return string.format("%.17g", value)
  end
  if kind == "boolean" then return tostring(value) end
  if kind ~= "array" and kind ~= "table" then
    error("cannot encode Lua type " .. kind)
  end
  if asKey then error("JSON object key must be scalar") end

  local parts = {}
  if kind == "array" then
    parts[#parts + 1] = "["
    for index, item in ipairs(value) do
      if index > 1 then parts[#parts + 1] = "," end
      parts[#parts + 1] = json.stringify(item)
    end
    parts[#parts + 1] = "]"
  else
    parts[#parts + 1] = "{"
    local first = true
    -- 键排序：Lua 的 pairs 是哈希序，不排序的话同一宿主两次采集无法逐字节比对。
    local keys = {}
    for key in pairs(value) do keys[#keys + 1] = key end
    table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)
    for _, key in ipairs(keys) do
      if not first then parts[#parts + 1] = "," end
      first = false
      parts[#parts + 1] = json.stringify(key, true)
      parts[#parts + 1] = ":"
      parts[#parts + 1] = json.stringify(value[key])
    end
    parts[#parts + 1] = "}"
  end
  return table.concat(parts)
end

-- ===================================================================== --
-- 只读判定
-- ===================================================================== --

-- 与 server/src/host-session.js 的 isReadOnlyMethod 保持同一条线。
local READ_ONLY_EXACT = {
  T = true, blackKey = true, snap = true,
  t2x = true, v2y = true, x2t = true, y2v = true,
}

local function isReadOnlyName(name)
  if READ_ONLY_EXACT[name] then return true end
  if name:match("^get") or name:match("^is") or name:match("^has") then return true end
  if name:match("^blick") or name:match("^quarter") or name:match("^seconds")
    or name:match("^pitch") or name:match("^freq") then
    return true
  end
  return false
end

-- 试调的额外收紧：即使名字以 get 开头，只要它可能带出对话框、阻塞或改变编辑器状态，
-- 就不碰。这里宁可漏测也不冒险。
local TRIAL_DENYLIST = {
  showMessageBox = true, showCustomDialog = true, showInputBox = true,
  showOkCancelBox = true, showYesNoCancelBox = true,
  openFile = true, saveFile = true, finish = true, setTimeout = true,
  getHostClipboard = true, setHostClipboard = true,
  play = true, pause = true, stop = true, seek = true, loop = true,
}

local function isTrialSafe(name)
  if TRIAL_DENYLIST[name] then return false end
  return isReadOnlyName(name)
end

-- ===================================================================== --
-- 枚举
-- ===================================================================== --

-- 实机核实（2.2.1，第一版探针）：527 个成员全部被判成 value、全部 scope=own，
-- 且零试调触发。scope=own 说明它们确实是 pairs() 从对象表里直接取到的，
-- 但 type(value) 不是 "function"——也就是说宿主用的是别的可调用表示（原生绑定
-- 常见为 userdata 或带 __call 的对象）。
--
-- 结论：可调用性不能靠 type() 的字面值判断，必须问「它能不能被调用」。
-- luaType 会一并记进证据，好让下一次运行直接看到真实类型，而不是继续猜。
local function isCallable(value)
  local valueType = type(value)
  if valueType == "function" then return true end
  if valueType == "userdata" or valueType == "table" then
    local meta = getmetatable(value)
    if type(meta) == "table" and meta.__call ~= nil then return true end
    -- 元表被 __metatable 屏蔽时拿不到 __call；userdata 仍按可调用处理，
    -- 宁可多试一个零参只读方法，也不要让整份枚举退化成"全是 value"。
    if valueType == "userdata" then return true end
  end
  return false
end

local function classifyValue(value)
  if isCallable(value) then return "function" end
  return "value"
end

local function isHostObject(value)
  if type(value) ~= "table" then return false end
  if rawget(value, "__ptr__") ~= nil then return true end
  return getmetatable(value) ~= nil and getmetatable(value) ~= JSON_ARRAY_METATABLE
end

local function sortedShapeKeys(value)
  local keys = {}
  for key in pairs(value) do keys[#keys + 1] = key end
  table.sort(keys, function(a, b)
    local left = type(a) .. ":" .. tostring(a)
    local right = type(b) .. ":" .. tostring(b)
    return left < right
  end)
  return keys
end

-- shape 只描述容器结构与 Lua 类型。四重预算同时限制深度、字段、数组样本和总节点，
-- 避免 getAll* 一类只读方法在大工程中把本地采集文件无限放大。
local function describeValueShape(value, state, depth)
  state = state or { nodes = 0, seen = {} }
  depth = depth or 0
  local valueType = type(value)
  if state.nodes >= SHAPE_MAX_NODES then
    return { type = valueType, truncated = true, reason = "NODE_LIMIT" }
  end
  state.nodes = state.nodes + 1

  if valueType ~= "table" then return { type = valueType } end
  if isHostObject(value) then return { type = "object" } end
  if state.seen[value] then return { type = "table", recursive = true } end
  if depth >= SHAPE_MAX_DEPTH then
    return { type = "table", truncated = true, reason = "DEPTH_LIMIT" }
  end

  state.seen[value] = true
  local valueKind = kindOf(value)
  local shape
  if valueKind == "array" then
    local elements = json.array()
    local length = #value
    local sampled = math.min(length, SHAPE_MAX_ARRAY_ITEMS)
    for index = 1, sampled do
      elements[#elements + 1] = describeValueShape(value[index], state, depth + 1)
    end
    shape = {
      type = "table",
      kind = "array",
      length = length,
      sampledItems = sampled,
      elements = elements,
    }
    if sampled < length then
      shape.truncated = true
      shape.reason = "ARRAY_SAMPLE_LIMIT"
    end
  else
    local keys = sortedShapeKeys(value)
    local fields = json.array()
    local sampled = math.min(#keys, SHAPE_MAX_FIELDS)
    for index = 1, sampled do
      local key = keys[index]
      -- 非字符串 key 只写稳定序号，不把数字、布尔值或对象地址当成字段名泄露出去。
      local fieldName = type(key) == "string" and key or ("item_" .. index)
      fields[#fields + 1] = {
        name = fieldName,
        keyType = type(key),
        shape = describeValueShape(value[key], state, depth + 1),
      }
    end
    shape = {
      type = "table",
      kind = "map",
      fieldCount = #keys,
      fields = fields,
    }
    if sampled < #keys then
      shape.truncated = true
      shape.reason = "FIELD_LIMIT"
    end
  end
  state.seen[value] = nil
  return shape
end

-- 试调一个零参只读方法；实际值一律丢弃，仅保留类型和受预算约束的 shape。
local function trialCall(object, name)
  local ok, result = pcall(function() return object[name](object) end)
  if not ok then
    return { status = "failed", errorKind = "HOST_ERROR" }
  end
  local resultType = type(result)
  if resultType == "table" then
    -- 区分「宿主对象」与「普通数据表」：前者带 metatable 或 __ptr__。
    if getmetatable(result) ~= nil or rawget(result, "__ptr__") ~= nil then
      resultType = "object"
    end
  end
  local trial = { status = "ok", returnedType = resultType }
  if VALUE_SHAPES then trial.shape = describeValueShape(result) end
  return trial
end

-- Lua 元方法不是 API 成员，枚举时必须排除，否则 __index/__gc 之类会被当成
-- 「文档里没有的方法」污染差异结果。
local function isMetamethod(name)
  return name:sub(1, 2) == "__"
end

-- 枚举一个对象的全部成员：pairs 直取的算 own，沿 metatable.__index 链找到的算
-- inherited。两者都要——SV 的对象大多把方法直接挂在表上，但不保证全都如此。
--
-- 注意 pairs() 只能枚举 table。宿主对象若是 userdata，其成员挂在元表的 __index 上，
-- 因此 own 一无所获、全部落到 inherited；两条路径都必须留。
local function enumerateMembers(object, allowTrial)
  local seen = {}
  local members = json.array()

  local function collect(source, scope)
    if type(source) ~= "table" then return end
    for key, value in pairs(source) do
      if type(key) == "string" and not seen[key] and not isMetamethod(key)
        and key:match("^[A-Za-z_][A-Za-z0-9_]*$") then
        seen[key] = true
        local member = {
          name = key,
          kind = classifyValue(value),
          scope = scope,
          -- 记下真实的 Lua 类型：第一版把 527 个成员全判成 value 就是因为只认
          -- "function"。有了它，分类是否正确可以直接从证据里读出来，不用再猜。
          luaType = type(value),
        }
        if allowTrial and member.kind == "function" and isTrialSafe(key) then
          member.trial = trialCall(object, key)
        end
        members[#members + 1] = member
      end
    end
  end

  collect(object, "own")

  -- 沿 __index 链继续找，最多 8 层，避免环。
  local visited = {}
  local current = getmetatable(object)
  local depth = 0
  while type(current) == "table" and depth < 8 and not visited[current] do
    visited[current] = true
    collect(current, "inherited")
    local index = rawget(current, "__index")
    if type(index) == "table" then
      collect(index, "inherited")
      current = getmetatable(index)
    else
      current = getmetatable(current)
    end
    depth = depth + 1
  end

  table.sort(members, function(a, b) return a.name < b.name end)
  return members
end

local function capturedClass(name, origin, object, allowTrial)
  if object == nil then
    return { name = name, origin = origin, available = false, reason = "INSTANCE_UNAVAILABLE" }
  end
  if type(object) ~= "table" then
    return { name = name, origin = origin, available = false, reason = "NOT_A_TABLE" }
  end
  local ok, members = pcall(enumerateMembers, object, allowTrial)
  if not ok then
    return { name = name, origin = origin, available = false, reason = "ENUMERATION_FAILED" }
  end
  return { name = name, origin = origin, available = true, members = members }
end

local function tryGet(callback)
  local ok, value = pcall(callback)
  if not ok then return nil end
  return value
end

-- ===================================================================== --
-- 采集
-- ===================================================================== --

-- 与 api-manifest.json 的 creatableTypes 对齐。
local CREATABLE_TYPES = {
  "Note", "Automation", "PitchControlPoint", "PitchControlCurve",
  "NoteGroup", "NoteGroupReference", "TrackMixer", "Track",
  "TimeAxis", "Project", "WidgetValue",
}

local function collectRoots(classes)
  local project = tryGet(function() return SV:getProject() end)
  local roots = {
    { name = "SV", object = SV },
    { name = "Project", object = project },
    { name = "TimeAxis", object = project and tryGet(function() return project:getTimeAxis() end) },
    { name = "MainEditorView", object = tryGet(function() return SV:getMainEditor() end) },
    { name = "ArrangementView", object = tryGet(function() return SV:getArrangement() end) },
    { name = "PlaybackControl", object = tryGet(function() return SV:getPlayback() end) },
  }
  for _, root in ipairs(roots) do
    classes[#classes + 1] = capturedClass(root.name, "root", root.object, TRIAL_CALLS)
  end
  return project
end

local function collectCreatable(classes)
  for _, typeName in ipairs(CREATABLE_TYPES) do
    -- 临时对象：只用于枚举形状，绝不加入工程，函数返回后即被 GC。
    local instance = tryGet(function() return SV:create(typeName) end)
    if instance == nil then
      classes[#classes + 1] = {
        name = typeName, origin = "created", available = false, reason = "CREATE_FAILED",
      }
    else
      classes[#classes + 1] = capturedClass(typeName, "created", instance, TRIAL_CALLS)
    end
  end
end

-- 活实例可能暴露 SV:create() 空对象上没有的成员，因此单独采一轮。全部只读获取。
local function collectLiveInstances(classes, project)
  local editor = tryGet(function() return SV:getMainEditor() end)
  local track = editor and tryGet(function() return editor:getCurrentTrack() end)
  local groupRef = editor and tryGet(function() return editor:getCurrentGroup() end)
  local group = groupRef and tryGet(function() return groupRef:getTarget() end)
  local note = group and tryGet(function()
    if group:getNumNotes() > 0 then return group:getNote(1) end
    return nil
  end)
  local automation = group and tryGet(function() return group:getParameter("Loudness") end)
  local mixer = track and tryGet(function() return track:getMixer() end)
  local selection = editor and tryGet(function() return editor:getSelection() end)
  local navigation = editor and tryGet(function() return editor:getNavigation() end)
  local arrangementSelection = tryGet(function() return SV:getArrangement():getSelection() end)

  local live = {
    { name = "Track", object = track },
    { name = "NoteGroupReference", object = groupRef },
    { name = "NoteGroup", object = group },
    { name = "Note", object = note },
    { name = "Automation", object = automation },
    { name = "TrackMixer", object = mixer },
    { name = "TrackInnerSelectionState", object = selection },
    { name = "CoordinateSystem", object = navigation },
    { name = "ArrangementSelectionState", object = arrangementSelection },
    { name = "Project", object = project },
  }
  for _, entry in ipairs(live) do
    classes[#classes + 1] = capturedClass(entry.name, "live_instance", entry.object, TRIAL_CALLS)
  end
end

local SEMANTIC_METHODS = {
  { className = "NoteGroupReference", method = "getVoice" },
  { className = "NoteGroup", method = "getScale" },
  { className = "TrackMixer", method = "getFxParams" },
}

local function semanticMethodKey(className, method)
  return className .. "." .. method
end

local function newSemanticBuckets()
  local buckets = {}
  for _, spec in ipairs(SEMANTIC_METHODS) do
    buckets[semanticMethodKey(spec.className, spec.method)] = {
      className = spec.className,
      method = spec.method,
      attempted = 0,
      succeeded = 0,
      failed = 0,
      byShape = {},
    }
  end
  return buckets
end

local function observeSemanticShape(buckets, className, method, object)
  local bucket = buckets[semanticMethodKey(className, method)]
  bucket.attempted = bucket.attempted + 1
  local ok, result = pcall(function() return object[method](object) end)
  if not ok then
    bucket.failed = bucket.failed + 1
    return
  end
  bucket.succeeded = bucket.succeeded + 1
  local shape = describeValueShape(result)
  local fingerprint = json.stringify(shape)
  local observed = bucket.byShape[fingerprint]
  if observed == nil then
    observed = { observedInstances = 0, shape = shape }
    bucket.byShape[fingerprint] = observed
  end
  observed.observedInstances = observed.observedInstances + 1
end

local function finalizeSemanticBuckets(buckets)
  local methods = json.array()
  for _, spec in ipairs(SEMANTIC_METHODS) do
    local bucket = buckets[semanticMethodKey(spec.className, spec.method)]
    local fingerprints = {}
    for fingerprint in pairs(bucket.byShape) do fingerprints[#fingerprints + 1] = fingerprint end
    table.sort(fingerprints)
    local shapes = json.array()
    for _, fingerprint in ipairs(fingerprints) do
      shapes[#shapes + 1] = bucket.byShape[fingerprint]
    end
    methods[#methods + 1] = {
      className = bucket.className,
      method = bucket.method,
      attempted = bucket.attempted,
      succeeded = bucket.succeeded,
      failed = bucket.failed,
      distinctShapes = #shapes,
      shapes = shapes,
    }
  end
  return methods
end

-- 跨工程扫描只聚合 shape 与实例计数；不写出轨道名、group index、UUID 或任何标量值。
local function collectSemanticProbes(project)
  local buckets = newSemanticBuckets()
  local tracksVisited = 0
  local vocalGroupsVisited = 0
  local truncated = false
  if project ~= nil then
    local trackCount = tryGet(function() return project:getNumTracks() end) or 0
    local tracksToVisit = math.min(trackCount, SEMANTIC_MAX_TRACKS)
    if tracksToVisit < trackCount then truncated = true end
    for trackIndex = 1, tracksToVisit do
      local track = tryGet(function() return project:getTrack(trackIndex) end)
      if track ~= nil then
        tracksVisited = tracksVisited + 1
        local mixer = tryGet(function() return track:getMixer() end)
        if mixer ~= nil then
          observeSemanticShape(buckets, "TrackMixer", "getFxParams", mixer)
        end
        local groupCount = tryGet(function() return track:getNumGroups() end) or 0
        for groupIndex = 1, groupCount do
          if vocalGroupsVisited >= SEMANTIC_MAX_GROUPS then
            truncated = true
            break
          end
          local reference = tryGet(function() return track:getGroupReference(groupIndex) end)
          local instrumental = reference and tryGet(function() return reference:isInstrumental() end)
          if reference ~= nil and instrumental == false then
            vocalGroupsVisited = vocalGroupsVisited + 1
            observeSemanticShape(buckets, "NoteGroupReference", "getVoice", reference)
            local group = tryGet(function() return reference:getTarget() end)
            if group ~= nil then observeSemanticShape(buckets, "NoteGroup", "getScale", group) end
          end
        end
        if vocalGroupsVisited >= SEMANTIC_MAX_GROUPS then break end
      end
    end
  end
  return {
    enabled = true,
    valuePolicy = "shape_only_no_scalar_values",
    limits = {
      maxDepth = SHAPE_MAX_DEPTH,
      maxFields = SHAPE_MAX_FIELDS,
      maxArrayItems = SHAPE_MAX_ARRAY_ITEMS,
      maxNodes = SHAPE_MAX_NODES,
      maxTracks = SEMANTIC_MAX_TRACKS,
      maxVocalGroups = SEMANTIC_MAX_GROUPS,
    },
    scan = {
      tracksVisited = tracksVisited,
      vocalGroupsVisited = vocalGroupsVisited,
      truncated = truncated,
    },
    methods = finalizeSemanticBuckets(buckets),
  }
end

-- ===================================================================== --
-- 落盘
-- ===================================================================== --

local function isoTimestamp()
  -- SV 的 Lua 有 os.date/os.time；用 UTC 以便与仓库里其他证据的时间戳格式一致。
  return os.date("!%Y-%m-%dT%H:%M:%SZ")
end

local function platformName()
  local info = tryGet(function() return SV:getHostInfo() end)
  local osType = info and info.osType
  if type(osType) ~= "string" then return "unknown" end
  local lowered = osType:lower()
  if lowered:match("win") then return "win32" end
  if lowered:match("mac") or lowered:match("darwin") then return "darwin" end
  if lowered:match("linux") then return "linux" end
  return "unknown"
end

local function outputDirectory()
  local base = os.getenv("LOCALAPPDATA")
  if base == nil or base == "" then base = os.getenv("TMP") or os.getenv("TEMP") or "." end
  return base .. "\\SVCopilot\\api-surface"
end

local function writeFileAtomic(directory, filePath, text)
  -- Lua 没有 mkdir，SV2 也不带 LuaFileSystem，只能借壳。2>nul 吞掉「已存在」。
  os.execute('mkdir "' .. directory .. '" 2>nul')
  local temporaryPath = filePath .. ".tmp"
  local handle, message = io.open(temporaryPath, "wb")
  if handle == nil then
    return false, "cannot open temporary file: " .. tostring(message)
  end
  handle:write(text)
  handle:close()
  os.remove(filePath)
  local renamed, renameMessage = os.rename(temporaryPath, filePath)
  if not renamed then
    return false, "cannot rename temporary file: " .. tostring(renameMessage)
  end
  return true, nil
end

function main()
  local hostInfo = tryGet(function() return SV:getHostInfo() end) or {}
  local classes = {}
  local project = collectRoots(classes)
  collectCreatable(classes)
  collectLiveInstances(classes, project)
  local semanticProbes = collectSemanticProbes(project)

  -- 采集侧只保证「同一 origin 下类名唯一」；Node 侧会按类名合并多个 origin。
  local ordered = json.array()
  for _, entry in ipairs(classes) do ordered[#ordered + 1] = entry end

  local capture = {
    kind = CAPTURE_KIND,
    schemaVersion = SCHEMA_VERSION,
    capturedAt = isoTimestamp(),
    host = {
      product = type(hostInfo.hostName) == "string" and hostInfo.hostName or "unknown",
      version = type(hostInfo.hostVersion) == "string" and hostInfo.hostVersion or "unknown",
      platform = platformName(),
    },
    probe = {
      name = PROBE_NAME,
      version = PROBE_VERSION,
      readOnly = true,
      trialCalls = TRIAL_CALLS,
      valueShapes = VALUE_SHAPES,
    },
    classes = ordered,
    semanticProbes = semanticProbes,
  }
  if type(hostInfo.hostVersionNumber) == "number" then
    capture.host.versionNumber = math.floor(hostInfo.hostVersionNumber)
  end

  local encoded
  local encodeOk, encodeError = pcall(function()
    encoded = json.stringify(capture)
  end)
  if not encodeOk then
    SV:showMessageBox("SV Api Surface Probe", "编码失败：" .. tostring(encodeError))
    SV:finish()
    return
  end

  local directory = outputDirectory()
  local stamp = os.date("!%Y%m%d-%H%M%S")
  local filePath = directory .. "\\api-surface-" .. capture.host.version
    .. "-" .. capture.host.platform .. "-" .. stamp .. ".json"

  local written, writeError = writeFileAtomic(directory, filePath, encoded)
  if not written then
    SV:showMessageBox("SV Api Surface Probe", "写入失败：" .. tostring(writeError))
    SV:finish()
    return
  end

  local classCount = 0
  local memberCount = 0
  for _, entry in ipairs(ordered) do
    classCount = classCount + 1
    if entry.members ~= nil then memberCount = memberCount + #entry.members end
  end

  -- 这是唯一告知用户文件位置的途径，因此成功路径也弹一次框（与常驻脚本的约定不同：
  -- 那些脚本成功时不弹框，是因为它们不产出需要人接手的文件）。
  SV:showMessageBox(
    "SV Api Surface Probe",
    "只读枚举与 shape 采集完成。\n\n类：" .. classCount .. "\n成员：" .. memberCount
      .. "\nVocal groups：" .. semanticProbes.scan.vocalGroupsVisited
      .. "\n\n已写入：\n" .. filePath
      .. "\n\n下一步（在 SVCopilot 仓库）：\ncd server\nnpm run api-surface:diff -- --input \"" .. filePath .. "\""
  )
  SV:finish()
end
