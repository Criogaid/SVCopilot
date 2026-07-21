--[[
  IO PIPE 桥的参考副本。当前实际脚本已经位于 scripts/.../sv-scripts/
  StartSynthVCopilot.lua；本文件不在 SynthV 扫描目录中。
]]

IDLE_MS = 20
PROTO_VERSION = 1

local SESSION = os.getenv("SV_COPILOT_SESSION")
if not SESSION or SESSION == "" then SESSION = "default" end
-- RelayProbe-style escaping: \\\\.\\pipe\\ -> \\.\pipe\
local PIPE_TO_SV   = "\\\\.\\pipe\\SVCopilot-" .. SESSION .. "-to-sv"    -- Relay -> SV (we read)
local PIPE_FROM_SV = "\\\\.\\pipe\\SVCopilot-" .. SESSION .. "-from-sv"  -- SV -> Relay (we write)

-- ===================================================================== --
-- JSON (pure Lua) -- identical to StartSynthVCopilot.lua
-- ===================================================================== --
local json = {}
local function kind_of(obj)
  if type(obj) ~= 'table' then return type(obj) end
  local i = 1
  for _ in pairs(obj) do
    if obj[i] ~= nil then i = i + 1 else return 'table' end
  end
  if i == 1 then return 'table' else return 'array' end
end
local function escape_str(s)
  local in_char  = {'\\', '"', '/', '\b', '\f', '\n', '\r', '\t'}
  local out_char = {'\\', '"', '/',  'b',  'f',  'n',  'r',  't'}
  for i, c in ipairs(in_char) do s = s:gsub(c, '\\' .. out_char[i]) end
  return s
end
local function skip_delim(str, pos, delim, err_if_missing)
  pos = pos + #str:match('^%s*', pos)
  if str:sub(pos, pos) ~= delim then
    if err_if_missing then error('Expected ' .. delim .. ' near position ' .. pos) end
    return pos, false
  end
  return pos + 1, true
end
local function parse_str_val(str, pos, val)
  val = val or ''
  if pos > #str then error('End of input found while parsing string.') end
  local c = str:sub(pos, pos)
  if c == '"'  then return val, pos + 1 end
  if c ~= '\\' then return parse_str_val(str, pos + 1, val .. c) end
  local esc_map = {b = '\b', f = '\f', n = '\n', r = '\r', t = '\t'}
  local nextc = str:sub(pos + 1, pos + 1)
  if not nextc then error('End of input found while parsing string.') end
  return parse_str_val(str, pos + 2, val .. (esc_map[nextc] or nextc))
end
local function parse_num_val(str, pos)
  local num_str = str:match('^-?%d+%.?%d*[eE]?[+-]?%d*', pos)
  local val = tonumber(num_str)
  if not val then error('Error parsing number at position ' .. pos .. '.') end
  return val, pos + #num_str
end
function json.stringify(obj, as_key)
  local s = {}
  local kind = kind_of(obj)
  if kind == 'array' then
    if as_key then error('Can\'t encode array as key.') end
    s[#s + 1] = '['
    for i, val in ipairs(obj) do
      if i > 1 then s[#s + 1] = ',' end
      s[#s + 1] = json.stringify(val)
    end
    s[#s + 1] = ']'
  elseif kind == 'table' then
    if as_key then error('Can\'t encode table as key.') end
    s[#s + 1] = '{'
    local first = true
    for k, v in pairs(obj) do
      if not first then s[#s + 1] = ',' end
      first = false
      s[#s + 1] = json.stringify(k, true)
      s[#s + 1] = ':'
      s[#s + 1] = json.stringify(v)
    end
    s[#s + 1] = '}'
  elseif kind == 'string' then
    return '"' .. escape_str(obj) .. '"'
  elseif kind == 'number' then
    if as_key then return '"' .. tostring(obj) .. '"' end
    if math.type and math.type(obj) == 'integer' then return tostring(obj) end
    return string.format('%.17g', obj)
  elseif kind == 'boolean' then
    return tostring(obj)
  elseif kind == 'nil' then
    return 'null'
  else
    error('Unjsonifiable type: ' .. kind .. '.')
  end
  return table.concat(s)
end
json.null = {}
function json.parse(str, pos, end_delim)
  pos = pos or 1
  if pos > #str then error('Reached unexpected end of input.') end
  pos = pos + #str:match('^%s*', pos)
  local first = str:sub(pos, pos)
  if first == '{' then
    local obj, key, delim_found = {}, true, true
    pos = pos + 1
    while true do
      key, pos = json.parse(str, pos, '}')
      if key == nil then return obj, pos end
      if not delim_found then error('Comma missing between object items.') end
      pos = skip_delim(str, pos, ':', true)
      obj[key], pos = json.parse(str, pos)
      pos, delim_found = skip_delim(str, pos, ',')
    end
  elseif first == '[' then
    local arr, val, delim_found = {}, true, true
    pos = pos + 1
    while true do
      val, pos = json.parse(str, pos, ']')
      if val == nil then return arr, pos end
      if not delim_found then error('Comma missing between array items.') end
      arr[#arr + 1] = val
      pos, delim_found = skip_delim(str, pos, ',')
    end
  elseif first == '"' then
    return parse_str_val(str, pos + 1)
  elseif first == '-' or first:match('%d') then
    return parse_num_val(str, pos)
  elseif first == end_delim then
    return nil, pos + 1
  else
    local literals = {['true'] = true, ['false'] = false, ['null'] = json.null}
    for lit_str, lit_val in pairs(literals) do
      local lit_end = pos + #lit_str - 1
      if str:sub(pos, lit_end) == lit_str then return lit_val, lit_end + 1 end
    end
    error('Invalid json syntax starting at position ' .. pos .. ': ' .. str:sub(pos, pos + 10))
  end
end

-- ===================================================================== --
-- Handle registry + marshaling -- identical to StartSynthVCopilot.lua
-- ===================================================================== --
local handles = {}
local nextId = 1
local function register(obj)
  local id = nextId
  nextId = nextId + 1
  handles[id] = obj
  return id
end

local function marshal(v)
  local t = type(v)
  if v == nil then
    return nil
  elseif t == 'number' or t == 'string' or t == 'boolean' then
    return v
  elseif t == 'userdata' then
    return { __handle__ = register(v), __type__ = tostring(v) }
  elseif t == 'function' then
    return { __handle__ = register(v), __type__ = 'function' }
  elseif t == 'table' then
    -- SV API objects are tables with a __ptr__ / metatable: opaque handle, do
    -- NOT recurse. Plain data tables ({bpm=..,position=..}) recurse to inline.
    if getmetatable(v) ~= nil or rawget(v, '__ptr__') ~= nil then
      return { __handle__ = register(v), __type__ = 'object' }
    end
    local out = {}
    local n = 0
    for i, e in ipairs(v) do out[i] = marshal(e); n = i end
    for k, e in pairs(v) do
      if not (type(k) == 'number' and k >= 1 and k <= n and k == math.floor(k)) then
        out[k] = marshal(e)
      end
    end
    return out
  else
    return { __unmarshalable__ = t }
  end
end

local function unmarshal(v)
  local t = type(v)
  if v == json.null then
    return nil
  elseif t == 'table' then
    if v.__handle__ ~= nil then
      return handles[v.__handle__]
    end
    local out = {}
    for k, e in pairs(v) do out[k] = unmarshal(e) end
    return out
  elseif t == 'number' then
    if math.type and math.type(v) == 'float' and math.floor(v) == v then
      return math.tointeger(v) or v
    end
    return v
  else
    return v
  end
end

-- ===================================================================== --
-- Dispatch -- identical to StartSynthVCopilot.lua
-- ===================================================================== --
local function resolveTarget(handleId)
  if handleId == nil or handleId == json.null then return SV end
  local o = handles[handleId]
  if o == nil then error('unknown handle: ' .. tostring(handleId)) end
  return o
end

local function roots()
  local out = {}
  local function try(name, fn)
    local ok, obj = pcall(fn)
    if ok and obj ~= nil then out[name] = marshal(obj) end
  end
  out.sv = { __handle__ = register(SV), __type__ = 'SV' }
  try('project',    function() return SV:getProject() end)
  try('timeAxis',   function() return SV:getProject():getTimeAxis() end)
  try('mainEditor', function() return SV:getMainEditor() end)
  try('arrangement',function() return SV:getArrangement() end)
  try('playback',   function() return SV:getPlayback() end)
  return out
end

local function dispatch(cmd)
  local op = cmd.op
  if op == 'ping' then
    return 'pong'
  elseif op == 'root' then
    return roots()
  elseif op == 'free' then
    if cmd.handle ~= nil then handles[cmd.handle] = nil end
    return true
  elseif op == 'index' then
    local obj = resolveTarget(cmd.handle)
    return marshal(obj[cmd.field])
  elseif op == 'call' then
    local obj = resolveTarget(cmd.handle)
    local member = obj[cmd.method]
    if member == nil then
      error('no such method: ' .. tostring(cmd.method))
    end
    local raw = cmd.args or {}
    local n = #raw
    local args = {}
    for i = 1, n do args[i] = unmarshal(raw[i]) end
    local results = { member(obj, table.unpack(args, 1, n)) }
    if #results <= 1 then
      return marshal(results[1])
    end
    local multi = {}
    for i = 1, #results do multi[i] = marshal(results[i]) end
    return multi
  else
    error('unknown op: ' .. tostring(op))
  end
end

-- ===================================================================== --
-- Pipe transport (the only part that differs from the file-IPC bridge)
-- ===================================================================== --
local inPipe, outPipe
local pending = nil
local finished = false

local function pipeWrite(str)
  outPipe:write(str .. "\n")
  outPipe:flush()
end

local function closePipes()
  if inPipe then pcall(function() inPipe:close() end); inPipe = nil end
  if outPipe then pcall(function() outPipe:close() end); outPipe = nil end
end

local function finish(msg, showMessage)
  if finished then return end
  finished = true
  closePipes()
  if showMessage then SV:showMessageBox("SV Copilot (pipe)", tostring(msg)) end
  SV:finish()
end

local function parseFrame(line)
  local ok, frame = pcall(json.parse, line)
  if not ok or type(frame) ~= 'table' then
    return nil, "invalid JSON frame"
  end
  return frame
end

local function tick()
  -- 先写后读是协议不变量；Relay 必须为每一帧立即返回 command、noop 或 shutdown。
  if not pcall(pipeWrite, pending or '{"type":"poll"}') then finish("pipe write failed", true); return end
  pending = nil
  local line = inPipe:read("*l")
  if line == nil then finish("Relay disconnected (EOF)", true); return end
  local reply, parseError = parseFrame(line)
  if not reply then finish(parseError, true); return end

  local nextDelay = IDLE_MS
  if reply.type == 'command' and reply.id ~= nil then
    local dok, dres = pcall(dispatch, reply)
    local resp = { type = 'result', id = reply.id, ok = dok }
    if dok then
      if dres ~= nil then resp.result = dres end
    else
      resp.error = tostring(dres)
    end
    pending = json.stringify(resp)
    nextDelay = 0
  elseif reply.type == 'shutdown' then
    finish("Relay requested shutdown", false)
    return
  elseif reply.type == 'error' then
    finish("Relay protocol error: " .. tostring(reply.code), true)
    return
  elseif reply.type ~= 'noop' then
    finish("unexpected Relay frame: " .. tostring(reply.type), true)
    return
  end
  SV:setTimeout(nextDelay, tick)
end

function getClientInfo()
  return {
    name = "Start SV Copilot (pipe)",
    category = "SV Copilot",
    author = "SV Copilot skeleton",
    versionNumber = 1,
    minEditorVersion = 65537,
  }
end

function main()
  -- The Relay must be listening first.
  local err
  inPipe, err = io.open(PIPE_TO_SV, "rb")
  if not inPipe then finish("cannot open (start the Relay first):\n" .. PIPE_TO_SV .. "\n" .. tostring(err), true); return end
  outPipe, err = io.open(PIPE_FROM_SV, "wb")
  if not outPipe then finish("cannot open:\n" .. PIPE_FROM_SV .. "\n" .. tostring(err), true); return end
  outPipe:setvbuf("no")

  -- handshake
  local hello = json.stringify({ type = 'hello', role = 'sv', proto = PROTO_VERSION })
  if not pcall(pipeWrite, hello) then finish("hello write failed", true); return end
  local helloLine = inPipe:read("*l")
  if helloLine == nil then finish("no hello from Relay (EOF)", true); return end
  local response, parseError = parseFrame(helloLine)
  if not response then finish(parseError, true); return end
  if response.type ~= 'hello' or response.proto ~= PROTO_VERSION or response.session ~= SESSION then
    finish("Relay handshake mismatch", true)
    return
  end

  SV:setTimeout(0, tick)
end
