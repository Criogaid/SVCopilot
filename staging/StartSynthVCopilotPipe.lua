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
  -- 其余控制字符（<0x20 与 0x7f）必须转成 \u00XX，否则写出的帧不是合法 JSON。
  -- 具名转义已在上面替换为两字符序列，此处不会二次命中。
  s = s:gsub('%c', function(c) return string.format('\\u%04x', string.byte(c)) end)
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
-- 迭代 + 分段缓冲：逐字符 val..c 的旧实现对大字符串是 O(n²)，会在 UI 线程上卡顿。
-- 同时补齐 \uXXXX 解码（Node 对 <0x20 控制字符只发 \u00XX 形式），含 UTF-16 代理对。
local function parse_str_val(str, pos)
  local parts = {}
  local esc_map = {b = '\b', f = '\f', n = '\n', r = '\r', t = '\t'}
  local start = pos
  while true do
    if pos > #str then error('End of input found while parsing string.') end
    local c = str:sub(pos, pos)
    if c == '"' then
      parts[#parts + 1] = str:sub(start, pos - 1)
      return table.concat(parts), pos + 1
    elseif c == '\\' then
      parts[#parts + 1] = str:sub(start, pos - 1)
      local nextc = str:sub(pos + 1, pos + 1)
      if nextc == '' then error('End of input found while parsing string.') end
      if nextc == 'u' then
        local hex = str:sub(pos + 2, pos + 5)
        local code = #hex == 4 and tonumber(hex, 16) or nil
        if not code then error('Invalid \\u escape at position ' .. pos) end
        pos = pos + 6
        if code >= 0xD800 and code <= 0xDBFF and str:sub(pos, pos + 1) == '\\u' then
          local low = tonumber(str:sub(pos + 2, pos + 5), 16)
          if low and low >= 0xDC00 and low <= 0xDFFF then
            code = 0x10000 + (code - 0xD800) * 0x400 + (low - 0xDC00)
            pos = pos + 6
          end
        end
        parts[#parts + 1] = utf8.char(code)
      else
        parts[#parts + 1] = esc_map[nextc] or nextc
        pos = pos + 2
      end
      start = pos
    else
      pos = pos + 1
    end
  end
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
    -- legacy 路径的 NaN/Inf 会被 %.17g 写成非法 JSON（nan/inf）；降级为 null。
    -- typed-v2 路径在 marshalTyped 里以 {$sv:"number"} 无损承载，不受影响。
    if obj ~= obj or obj == math.huge or obj == -math.huge then return 'null' end
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

local function marshalTyped(v, shapeHint, lengthHint, seen, depth)
  local t = type(v)
  seen = seen or {}
  depth = depth or 0
  if depth > 32 then
    return { ['$sv'] = 'unsupported', luaType = t, reason = 'maximum depth exceeded' }
  elseif v == nil then
    return { ['$sv'] = 'nil' }
  elseif t == 'number' then
    if v ~= v then return { ['$sv'] = 'number', value = 'nan' } end
    if v == math.huge then return { ['$sv'] = 'number', value = '+inf' } end
    if v == -math.huge then return { ['$sv'] = 'number', value = '-inf' } end
    return v
  elseif t == 'string' or t == 'boolean' then
    return v
  elseif t == 'userdata' or t == 'function' then
    return {
      ['$sv'] = 'handle',
      id = register(v),
      type = t == 'function' and 'function' or tostring(v),
    }
  elseif t ~= 'table' then
    return { ['$sv'] = 'unsupported', luaType = t }
  end

  if getmetatable(v) ~= nil or rawget(v, '__ptr__') ~= nil then
    return { ['$sv'] = 'handle', id = register(v), type = 'object' }
  end
  if seen[v] then
    return { ['$sv'] = 'unsupported', luaType = 'table', reason = 'cycle detected' }
  end
  seen[v] = true

  local count, maxIndex, numericOnly = 0, 0, true
  for k in pairs(v) do
    count = count + 1
    if type(k) == 'number' and k >= 1 and k == math.floor(k) then
      if k > maxIndex then maxIndex = k end
    else
      numericOnly = false
    end
  end

  local result
  if shapeHint == 'array' or (count > 0 and numericOnly) then
    local length = tonumber(lengthHint) or maxIndex
    if length < maxIndex then length = maxIndex end
    local entries = {}
    for k, e in pairs(v) do
      if type(k) == 'number' and k >= 1 and k == math.floor(k) then
        entries[#entries + 1] = { k - 1, marshalTyped(e, nil, nil, seen, depth + 1) }
      end
    end
    table.sort(entries, function(a, b) return a[1] < b[1] end)
    result = {
      ['$sv'] = count == length and 'array' or 'sparse-array',
      length = length,
      entries = entries,
    }
  elseif count == 0 then
    result = { ['$sv'] = 'table', shape = 'unknown', entries = {} }
  else
    local entries = {}
    for k, e in pairs(v) do
      entries[#entries + 1] = {
        marshalTyped(k, nil, nil, seen, depth + 1),
        marshalTyped(e, nil, nil, seen, depth + 1),
      }
    end
    result = { ['$sv'] = 'map', entries = entries }
  end

  seen[v] = nil
  return result
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
    local value = obj[cmd.field]
    if value == nil then error('no such field: ' .. tostring(cmd.field)) end
    return marshal(value)
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
    local results = table.pack(member(obj, table.unpack(args, 1, n)))
    if cmd.resultFormat == 'typed-v2' then
      if results.n <= 1 then
        return marshalTyped(results[1], cmd.resultShape, cmd.resultLength)
      end
      local items = {}
      for i = 1, results.n do items[i] = marshalTyped(results[i]) end
      return { ['$sv'] = 'tuple', items = items }
    elseif results.n <= 1 then
      return marshal(results[1])
    end
    local multi = {}
    for i = 1, results.n do multi[i] = marshal(results[i]) end
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
