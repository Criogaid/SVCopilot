// 实机 API 表面 vs 官方文档 manifest 的差异比对（纯函数，无 I/O）。
//
// 为什么需要它：api-docs/api-manifest.json 完全由官方 HTML 解析而来，从未与真实宿主
// 比对过。文档漏写的方法在 host-session 的 validateApiCall 里只会得到一条 advisory，
// 然后失去参数校验与返回句柄类型推断（inferReturnedHandleType 依赖 manifest），
// handleTypes 从此断链。也就是说「文档没写」不是少一个方法可用，而是那条调用链上的
// 类型信息整体消失。
//
// 采集侧在宿主 Lua 里用 pairs() 枚举（见 staging/SVApiSurfaceProbe.lua）：SV API 对象是
// 带 __ptr__/metatable 的普通 Lua 表，方法即键，因此可直接枚举——而桥的 index/call
// 都是单键查找，必须预先知道名字，天生发现不了文档之外的东西。
//
// 本模块只做归一化与比对，不读文件、不连宿主，因此可以在 npm test 里离线跑。

export const API_SURFACE_EVIDENCE_KIND = "svcopilot-api-surface-evidence";
export const API_SURFACE_SCHEMA_VERSION = "1.0.0";
export const API_SURFACE_CAPTURE_SCHEMA_VERSION = "1.1.0";
export const API_SURFACE_CAPTURE_KIND = "svcopilot-api-surface-capture";

export const API_SURFACE_RESULT_CODES = Object.freeze({
  confirmed: "API_SURFACE_PARITY_CONFIRMED",
  diverged: "API_SURFACE_PARITY_DIVERGED",
});

// 采集来源：三类目标合起来才算一次完整枚举。SV:create() 出来的空对象与工程里的活实例
// 可能暴露不同成员，所以两者都要，且必须能在证据里区分开。
const SURFACE_ORIGINS = Object.freeze(["root", "created", "live_instance"]);
const MEMBER_KINDS = Object.freeze(["function", "value"]);
const MEMBER_SCOPES = Object.freeze(["own", "inherited"]);

const CAPTURE_SCHEMA_VERSIONS = Object.freeze([
  API_SURFACE_SCHEMA_VERSION,
  API_SURFACE_CAPTURE_SCHEMA_VERSION,
]);
const CAPTURE_KEYS = [
  "kind",
  "schemaVersion",
  "capturedAt",
  "host",
  "probe",
  "classes",
  "semanticProbes",
];
const HOST_KEYS = ["product", "version", "platform", "versionNumber"];
const PROBE_KEYS = ["name", "version", "readOnly", "trialCalls", "valueShapes"];
const CLASS_KEYS = ["name", "origin", "available", "reason", "members"];
const MEMBER_KEYS = ["name", "kind", "scope", "luaType", "trial"];
// 采集侧记录的真实 Lua 类型。留着它是因为第一版探针只认 "function"，把宿主的原生
// 绑定全判成了 value；有了这一栏，分类错误可以直接从证据里读出来。
const LUA_TYPES = Object.freeze([
  "function", "userdata", "table", "string", "number", "boolean", "nil", "thread",
]);
const TRIAL_KEYS = ["status", "returnedType", "errorKind", "shape"];
const SHAPE_KEYS = [
  "type",
  "kind",
  "length",
  "sampledItems",
  "elements",
  "fieldCount",
  "fields",
  "truncated",
  "reason",
  "recursive",
];
const SHAPE_FIELD_KEYS = ["name", "keyType", "shape"];
const SEMANTIC_PROBES_KEYS = ["enabled", "valuePolicy", "limits", "scan", "methods"];
const SEMANTIC_LIMIT_KEYS = [
  "maxDepth",
  "maxFields",
  "maxArrayItems",
  "maxNodes",
  "maxTracks",
  "maxVocalGroups",
];
const SEMANTIC_SCAN_KEYS = ["tracksVisited", "vocalGroupsVisited", "truncated"];
const SEMANTIC_METHOD_KEYS = [
  "className",
  "method",
  "attempted",
  "succeeded",
  "failed",
  "distinctShapes",
  "shapes",
];
const SEMANTIC_OBSERVED_SHAPE_KEYS = ["observedInstances", "shape"];

const TRIAL_STATUSES = Object.freeze(["ok", "failed", "skipped"]);

// 证据文件将来可能被折进 host profile，而 profile 的脱敏门禁禁止工程内容泄漏。
// 类名与方法名是标识符，安全；路径、URL、乐句数据不安全。这里提前守住同一条线，
// 避免"先写进证据、later 折进 profile 时才发现过不了"。
const FORBIDDEN_KEY_NAMES = Object.freeze(["values", "points", "notes", "lyrics", "phonemes"]);
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function normalizeApiSurfaceCapture(raw) {
  const capture = requireRecord(raw, "capture");
  assertKnownKeys(capture, CAPTURE_KEYS, "capture");
  if (capture.kind !== API_SURFACE_CAPTURE_KIND) {
    throw surfaceError(`capture.kind must be ${API_SURFACE_CAPTURE_KIND}`);
  }
  if (!CAPTURE_SCHEMA_VERSIONS.includes(capture.schemaVersion)) {
    throw surfaceError(
      `capture.schemaVersion must be one of ${CAPTURE_SCHEMA_VERSIONS.join(", ")}`
    );
  }
  requireIsoTimestamp(capture.capturedAt, "capture.capturedAt");

  const host = requireRecord(capture.host, "capture.host");
  assertKnownKeys(host, HOST_KEYS, "capture.host");
  const normalizedHost = {
    product: requireNonEmptyString(host.product, "capture.host.product"),
    version: requireNonEmptyString(host.version, "capture.host.version"),
    platform: requireNonEmptyString(host.platform, "capture.host.platform"),
  };
  if (host.versionNumber !== undefined) {
    normalizedHost.versionNumber = requireSafeInteger(host.versionNumber, "capture.host.versionNumber");
  }

  const probe = requireRecord(capture.probe, "capture.probe");
  assertKnownKeys(probe, PROBE_KEYS, "capture.probe");
  if (probe.readOnly !== true) {
    // 只接受能自证只读的采集。一份可能写过工程的枚举结果不配当证据。
    throw surfaceError("capture.probe.readOnly must be true");
  }
  const normalizedProbe = {
    name: requireNonEmptyString(probe.name, "capture.probe.name"),
    version: requireNonEmptyString(probe.version, "capture.probe.version"),
    readOnly: true,
    trialCalls: requireBoolean(probe.trialCalls, "capture.probe.trialCalls"),
  };
  if (probe.valueShapes !== undefined) {
    normalizedProbe.valueShapes = requireBoolean(
      probe.valueShapes,
      "capture.probe.valueShapes"
    );
  }
  if (
    capture.schemaVersion === API_SURFACE_SCHEMA_VERSION &&
    probe.valueShapes !== undefined
  ) {
    throw surfaceError("capture.probe.valueShapes requires capture schema 1.1.0");
  }
  if (
    capture.schemaVersion === API_SURFACE_CAPTURE_SCHEMA_VERSION &&
    normalizedProbe.valueShapes !== true
  ) {
    throw surfaceError("capture.probe.valueShapes must be true for capture schema 1.1.0");
  }

  const classes = requireArray(capture.classes, "capture.classes");
  if (classes.length === 0) throw surfaceError("capture.classes must not be empty");
  const normalizedClasses = classes.map((entry, index) =>
    normalizeCapturedClass(entry, `capture.classes[${index}]`, normalizedProbe.trialCalls)
  );
  assertUniqueBy(
    normalizedClasses,
    (entry) => `${entry.origin}:${entry.name}`,
    "capture.classes"
  );
  if (
    capture.schemaVersion === API_SURFACE_SCHEMA_VERSION &&
    normalizedClasses.some((entry) =>
      entry.members?.some((member) => member.trial?.shape !== undefined)
    )
  ) {
    throw surfaceError("capture trial shapes require capture schema 1.1.0");
  }

  let semanticProbes;
  if (capture.semanticProbes !== undefined) {
    if (capture.schemaVersion !== API_SURFACE_CAPTURE_SCHEMA_VERSION) {
      throw surfaceError("capture.semanticProbes requires capture schema 1.1.0");
    }
    semanticProbes = normalizeSemanticProbes(
      capture.semanticProbes,
      "capture.semanticProbes"
    );
  } else if (capture.schemaVersion === API_SURFACE_CAPTURE_SCHEMA_VERSION) {
    throw surfaceError("capture.semanticProbes is required for capture schema 1.1.0");
  }

  return deepFreeze({
    kind: API_SURFACE_CAPTURE_KIND,
    schemaVersion: capture.schemaVersion,
    capturedAt: capture.capturedAt,
    host: normalizedHost,
    probe: normalizedProbe,
    // 排序让同一宿主的两次采集可以逐字节比对：枚举顺序在 Lua 里是哈希序，不稳定。
    classes: sortByName(normalizedClasses),
    ...(semanticProbes ? { semanticProbes } : {}),
  });
}

function normalizeCapturedClass(raw, label, trialCallsEnabled) {
  const entry = requireRecord(raw, label);
  assertKnownKeys(entry, CLASS_KEYS, label);
  const name = requireIdentifier(entry.name, `${label}.name`);
  if (!SURFACE_ORIGINS.includes(entry.origin)) {
    throw surfaceError(`${label}.origin must be one of ${SURFACE_ORIGINS.join(", ")}`);
  }
  const available = requireBoolean(entry.available, `${label}.available`);

  if (!available) {
    // 拿不到实例时必须说明原因，否则「没枚举到」与「宿主真的没有」无法区分。
    const reason = requireCode(entry.reason, `${label}.reason`);
    if (entry.members !== undefined) {
      const members = requireArray(entry.members, `${label}.members`);
      if (members.length > 0) {
        throw surfaceError(`${label}.members must be empty when available is false`);
      }
    }
    return { name, origin: entry.origin, available: false, reason, members: [] };
  }

  if (entry.reason !== undefined) {
    throw surfaceError(`${label}.reason is only allowed when available is false`);
  }
  const members = requireArray(entry.members, `${label}.members`);
  const normalizedMembers = members.map((member, index) =>
    normalizeCapturedMember(member, `${label}.members[${index}]`, trialCallsEnabled)
  );
  assertUniqueBy(normalizedMembers, (member) => member.name, `${label}.members`);
  return {
    name,
    origin: entry.origin,
    available: true,
    members: sortByName(normalizedMembers),
  };
}

function normalizeCapturedMember(raw, label, trialCallsEnabled) {
  const member = requireRecord(raw, label);
  assertKnownKeys(member, MEMBER_KEYS, label);
  const name = requireIdentifier(member.name, `${label}.name`);
  if (!MEMBER_KINDS.includes(member.kind)) {
    throw surfaceError(`${label}.kind must be one of ${MEMBER_KINDS.join(", ")}`);
  }
  if (!MEMBER_SCOPES.includes(member.scope)) {
    throw surfaceError(`${label}.scope must be one of ${MEMBER_SCOPES.join(", ")}`);
  }
  const normalized = { name, kind: member.kind, scope: member.scope };
  if (member.luaType !== undefined) {
    if (!LUA_TYPES.includes(member.luaType)) {
      throw surfaceError(`${label}.luaType must be one of ${LUA_TYPES.join(", ")}`);
    }
    normalized.luaType = member.luaType;
  }
  if (member.trial === undefined) return normalized;
  if (!trialCallsEnabled) {
    throw surfaceError(`${label}.trial requires capture.probe.trialCalls to be true`);
  }
  normalized.trial = normalizeTrial(member.trial, `${label}.trial`);
  return normalized;
}

function normalizeTrial(raw, label) {
  const trial = requireRecord(raw, label);
  assertKnownKeys(trial, TRIAL_KEYS, label);
  if (!TRIAL_STATUSES.includes(trial.status)) {
    throw surfaceError(`${label}.status must be one of ${TRIAL_STATUSES.join(", ")}`);
  }
  const normalized = { status: trial.status };
  if (trial.status === "ok") {
    normalized.returnedType = requireCode(trial.returnedType, `${label}.returnedType`);
    if (trial.errorKind !== undefined) {
      throw surfaceError(`${label}.errorKind is only allowed when status is failed`);
    }
    if (trial.shape !== undefined) {
      normalized.shape = normalizeValueShape(trial.shape, `${label}.shape`);
      if (normalized.shape.type !== normalized.returnedType) {
        throw surfaceError(`${label}.shape.type must match returnedType`);
      }
    }
    return normalized;
  }
  if (trial.returnedType !== undefined) {
    throw surfaceError(`${label}.returnedType is only allowed when status is ok`);
  }
  if (trial.status === "failed") {
    // 只保留错误的类别码，绝不保留宿主错误原文：那可能带上工程路径或乐句内容。
    normalized.errorKind = requireCode(trial.errorKind, `${label}.errorKind`);
  } else if (trial.errorKind !== undefined) {
    throw surfaceError(`${label}.errorKind is only allowed when status is failed`);
  }
  if (trial.shape !== undefined) {
    throw surfaceError(`${label}.shape is only allowed when status is ok`);
  }
  return normalized;
}

function normalizeValueShape(raw, label, depth = 0) {
  if (depth > 8) throw surfaceError(`${label} exceeds the supported nesting depth`);
  const shape = requireRecord(raw, label);
  assertKnownKeys(shape, SHAPE_KEYS, label);
  const type = requireNonEmptyString(shape.type, `${label}.type`);
  if (![...LUA_TYPES, "object"].includes(type)) {
    throw surfaceError(`${label}.type must be a Lua type or object`);
  }
  const normalized = { type };
  if (shape.truncated !== undefined) {
    normalized.truncated = requireBoolean(shape.truncated, `${label}.truncated`);
  }
  if (shape.reason !== undefined) {
    normalized.reason = requireCode(shape.reason, `${label}.reason`);
    if (normalized.truncated !== true) {
      throw surfaceError(`${label}.reason requires truncated:true`);
    }
  }
  if (shape.recursive !== undefined) {
    normalized.recursive = requireBoolean(shape.recursive, `${label}.recursive`);
  }

  if (type !== "table") {
    for (const key of [
      "kind",
      "length",
      "sampledItems",
      "elements",
      "fieldCount",
      "fields",
      "recursive",
    ]) {
      if (shape[key] !== undefined) {
        throw surfaceError(`${label}.${key} is only allowed for table shapes`);
      }
    }
    return normalized;
  }
  if (normalized.recursive === true) {
    if (shape.kind !== undefined || shape.fields !== undefined || shape.elements !== undefined) {
      throw surfaceError(`${label} recursive table shape must not contain children`);
    }
    return normalized;
  }
  if (shape.kind === undefined) {
    if (normalized.truncated !== true) {
      throw surfaceError(`${label}.kind is required for a non-truncated table shape`);
    }
    return normalized;
  }
  if (!["array", "map"].includes(shape.kind)) {
    throw surfaceError(`${label}.kind must be array or map`);
  }
  normalized.kind = shape.kind;
  if (shape.kind === "array") {
    normalized.length = requireNonNegativeInteger(shape.length, `${label}.length`);
    normalized.sampledItems = requireNonNegativeInteger(
      shape.sampledItems,
      `${label}.sampledItems`
    );
    const elements = requireArray(shape.elements, `${label}.elements`);
    if (elements.length !== normalized.sampledItems || normalized.sampledItems > normalized.length) {
      throw surfaceError(`${label}.elements must match sampledItems and not exceed length`);
    }
    normalized.elements = elements.map((entry, index) =>
      normalizeValueShape(entry, `${label}.elements[${index}]`, depth + 1)
    );
    for (const key of ["fieldCount", "fields"]) {
      if (shape[key] !== undefined) {
        throw surfaceError(`${label}.${key} is not allowed for array shapes`);
      }
    }
    return normalized;
  }

  normalized.fieldCount = requireNonNegativeInteger(shape.fieldCount, `${label}.fieldCount`);
  const fields = requireArray(shape.fields, `${label}.fields`);
  if (fields.length > normalized.fieldCount) {
    throw surfaceError(`${label}.fields must not exceed fieldCount`);
  }
  normalized.fields = fields.map((rawField, index) => {
    const fieldLabel = `${label}.fields[${index}]`;
    const field = requireRecord(rawField, fieldLabel);
    assertKnownKeys(field, SHAPE_FIELD_KEYS, fieldLabel);
    return {
      name: requireNonEmptyString(field.name, `${fieldLabel}.name`),
      keyType: requireNonEmptyString(field.keyType, `${fieldLabel}.keyType`),
      shape: normalizeValueShape(field.shape, `${fieldLabel}.shape`, depth + 1),
    };
  });
  assertUniqueBy(normalized.fields, (field) => `${field.keyType}:${field.name}`, `${label}.fields`);
  for (const key of ["length", "sampledItems", "elements"]) {
    if (shape[key] !== undefined) {
      throw surfaceError(`${label}.${key} is not allowed for map shapes`);
    }
  }
  return normalized;
}

function normalizeSemanticProbes(raw, label) {
  const probes = requireRecord(raw, label);
  assertKnownKeys(probes, SEMANTIC_PROBES_KEYS, label);
  if (requireBoolean(probes.enabled, `${label}.enabled`) !== true) {
    throw surfaceError(`${label}.enabled must be true`);
  }
  if (probes.valuePolicy !== "shape_only_no_scalar_values") {
    throw surfaceError(`${label}.valuePolicy must be shape_only_no_scalar_values`);
  }
  const limits = requireRecord(probes.limits, `${label}.limits`);
  assertKnownKeys(limits, SEMANTIC_LIMIT_KEYS, `${label}.limits`);
  const normalizedLimits = Object.fromEntries(
    SEMANTIC_LIMIT_KEYS.map((key) => [
      key,
      requirePositiveInteger(limits[key], `${label}.limits.${key}`),
    ])
  );
  const scan = requireRecord(probes.scan, `${label}.scan`);
  assertKnownKeys(scan, SEMANTIC_SCAN_KEYS, `${label}.scan`);
  const normalizedScan = {
    tracksVisited: requireNonNegativeInteger(scan.tracksVisited, `${label}.scan.tracksVisited`),
    vocalGroupsVisited: requireNonNegativeInteger(
      scan.vocalGroupsVisited,
      `${label}.scan.vocalGroupsVisited`
    ),
    truncated: requireBoolean(scan.truncated, `${label}.scan.truncated`),
  };
  const methods = requireArray(probes.methods, `${label}.methods`).map((rawMethod, index) => {
    const methodLabel = `${label}.methods[${index}]`;
    const method = requireRecord(rawMethod, methodLabel);
    assertKnownKeys(method, SEMANTIC_METHOD_KEYS, methodLabel);
    const attempted = requireNonNegativeInteger(method.attempted, `${methodLabel}.attempted`);
    const succeeded = requireNonNegativeInteger(method.succeeded, `${methodLabel}.succeeded`);
    const failed = requireNonNegativeInteger(method.failed, `${methodLabel}.failed`);
    if (succeeded + failed !== attempted) {
      throw surfaceError(`${methodLabel} succeeded + failed must equal attempted`);
    }
    const shapes = requireArray(method.shapes, `${methodLabel}.shapes`).map((rawShape, shapeIndex) => {
      const shapeLabel = `${methodLabel}.shapes[${shapeIndex}]`;
      const observed = requireRecord(rawShape, shapeLabel);
      assertKnownKeys(observed, SEMANTIC_OBSERVED_SHAPE_KEYS, shapeLabel);
      return {
        observedInstances: requirePositiveInteger(
          observed.observedInstances,
          `${shapeLabel}.observedInstances`
        ),
        shape: normalizeValueShape(observed.shape, `${shapeLabel}.shape`),
      };
    });
    const distinctShapes = requireNonNegativeInteger(
      method.distinctShapes,
      `${methodLabel}.distinctShapes`
    );
    if (distinctShapes !== shapes.length) {
      throw surfaceError(`${methodLabel}.distinctShapes must equal shapes.length`);
    }
    const observedTotal = shapes.reduce((sum, entry) => sum + entry.observedInstances, 0);
    if (observedTotal !== succeeded) {
      throw surfaceError(`${methodLabel} observedInstances must sum to succeeded`);
    }
    return {
      className: requireIdentifier(method.className, `${methodLabel}.className`),
      method: requireIdentifier(method.method, `${methodLabel}.method`),
      attempted,
      succeeded,
      failed,
      distinctShapes,
      shapes,
    };
  });
  assertUniqueBy(methods, (method) => `${method.className}.${method.method}`, `${label}.methods`);
  return {
    enabled: true,
    valuePolicy: probes.valuePolicy,
    limits: normalizedLimits,
    scan: normalizedScan,
    methods: methods.sort((left, right) => {
      const leftKey = `${left.className}.${left.method}`;
      const rightKey = `${right.className}.${right.method}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    }),
  };
}

/**
 * 把一次实机采集与官方文档 manifest 逐类逐成员比对。
 *
 * 三分类的语义刻意不对称：
 *   undocumented —— 实机有、文档无。最有价值，它直接说明哪些调用会丢失校验与类型推断。
 *   missing      —— 文档有、实机无。说明 manifest 对这个宿主版本过时（或该类在此版本不可实例化）。
 *   matched      —— 只计数。逐条列出会让证据文件膨胀到没人看。
 */
export function diffApiSurface(capture, manifest) {
  const normalizedCapture =
    capture?.kind === API_SURFACE_CAPTURE_KIND && Object.isFrozen(capture)
      ? capture
      : normalizeApiSurfaceCapture(capture);
  const documented = indexManifestMethods(manifest);

  const undocumented = [];
  const missing = [];
  let matchedCount = 0;
  const unavailable = [];

  // 同一个类可能被多个 origin 枚举到（SV:create 的空对象 + 工程里的活实例）。
  // 先按类名合并可观测成员，再与文档比对：只要任一 origin 见过，就算实机存在。
  const observed = new Map();
  for (const entry of normalizedCapture.classes) {
    if (!entry.available) {
      unavailable.push({ name: entry.name, origin: entry.origin, reason: entry.reason });
      continue;
    }
    let bucket = observed.get(entry.name);
    if (!bucket) {
      bucket = { origins: new Set(), members: new Map() };
      observed.set(entry.name, bucket);
    }
    bucket.origins.add(entry.origin);
    for (const member of entry.members) {
      if (!bucket.members.has(member.name)) bucket.members.set(member.name, member);
    }
  }

  for (const [className, bucket] of [...observed.entries()].sort(compareStrings)) {
    const documentedMembers = documented.get(className) ?? null;
    for (const [memberName, member] of [...bucket.members.entries()].sort(compareStrings)) {
      if (documentedMembers?.has(memberName)) {
        matchedCount += 1;
        continue;
      }
      undocumented.push({
        className,
        member: memberName,
        kind: member.kind,
        scope: member.scope,
        origins: [...bucket.origins].sort(),
        // 类整个不在文档里，与类在文档里但少这个方法，是两种不同的过时方式。
        classDocumented: documentedMembers !== null,
        // 完整 shape 只进入本地报告的 semanticProbes；可提交差异明细继续只保留
        // 状态与顶层返回类型，避免动态 voice mode 等键名进入 evidence。
        ...(member.trial ? { trial: trialEvidence(member.trial) } : {}),
      });
    }
  }

  for (const [className, documentedMembers] of [...documented.entries()].sort(compareStrings)) {
    const bucket = observed.get(className);
    if (!bucket) {
      // 没能实例化的类不能算"实机缺失"——那只是本次采集没覆盖到。
      if (!unavailable.some((entry) => entry.name === className)) {
        missing.push({ className, member: null, reason: "CLASS_NOT_OBSERVED" });
      }
      continue;
    }
    for (const memberName of [...documentedMembers].sort()) {
      if (!bucket.members.has(memberName)) {
        missing.push({ className, member: memberName, reason: "MEMBER_NOT_OBSERVED" });
      }
    }
  }

  return deepFreeze({
    captureSchemaVersion: normalizedCapture.schemaVersion,
    host: normalizedCapture.host,
    capturedAt: normalizedCapture.capturedAt,
    probe: normalizedCapture.probe,
    ...(normalizedCapture.semanticProbes
      ? { semanticProbes: normalizedCapture.semanticProbes }
      : {}),
    manifestGeneratedAt: readManifestGeneratedAt(manifest),
    undocumented,
    missing,
    unavailable,
    matchedCount,
    captureHealth: assessCaptureHealth(normalizedCapture),
  });
}

/**
 * 采集自身的健康度。第一版探针把全部 527 个成员判成 value 且零试调，输出看起来
 * 却和正常结果没有区别——那种失败必须能被自动看出来，而不是靠人盯着 JSON 发现。
 */
function assessCaptureHealth(capture) {
  let memberCount = 0;
  let callableCount = 0;
  let trialCount = 0;
  let successfulTrialCount = 0;
  let valueShapeCount = 0;
  const luaTypes = new Set();
  for (const entry of capture.classes) {
    for (const member of entry.members) {
      memberCount += 1;
      if (member.kind === "function") callableCount += 1;
      if (member.trial) {
        trialCount += 1;
        if (member.trial.status === "ok") {
          successfulTrialCount += 1;
          if (member.trial.shape) valueShapeCount += 1;
        }
      }
      if (member.luaType) luaTypes.add(member.luaType);
    }
  }
  const warnings = [];
  if (memberCount > 0 && callableCount === 0) {
    // 一个真实宿主不可能一个可调用成员都没有。
    warnings.push("NO_CALLABLE_MEMBER_CLASSIFIED");
  }
  if (capture.probe.trialCalls && callableCount > 0 && trialCount === 0) {
    warnings.push("TRIAL_CALLS_ENABLED_BUT_NONE_RAN");
  }
  if (capture.probe.valueShapes === true && valueShapeCount !== successfulTrialCount) {
    warnings.push("VALUE_SHAPE_MISSING_FOR_SUCCESSFUL_TRIAL");
  }
  const semanticMethods = capture.semanticProbes?.methods ?? [];
  const semanticAttempts = semanticMethods.reduce((sum, method) => sum + method.attempted, 0);
  const semanticSuccesses = semanticMethods.reduce((sum, method) => sum + method.succeeded, 0);
  if (capture.semanticProbes && semanticAttempts === 0) {
    warnings.push("SEMANTIC_PROBES_NOT_EXERCISED");
  } else if (semanticAttempts > 0 && semanticSuccesses === 0) {
    warnings.push("SEMANTIC_PROBES_ALL_FAILED");
  }
  return {
    memberCount,
    callableCount,
    trialCount,
    successfulTrialCount,
    valueShapeCount,
    semanticAttempts,
    semanticSuccesses,
    observedLuaTypes: [...luaTypes].sort(),
    warnings,
  };
}

function trialEvidence(trial) {
  if (trial.status === "ok") {
    return { status: "ok", returnedType: trial.returnedType };
  }
  if (trial.status === "failed") {
    return { status: "failed", errorKind: trial.errorKind };
  }
  return { status: "skipped" };
}

export function summarizeApiSurface(diff) {
  const undocumentedCount = diff.undocumented.length;
  const missingCount = diff.missing.length;
  const diverged = undocumentedCount > 0 || missingCount > 0;
  return deepFreeze({
    resultCode: diverged
      ? API_SURFACE_RESULT_CODES.diverged
      : API_SURFACE_RESULT_CODES.confirmed,
    matchedCount: diff.matchedCount,
    undocumentedCount,
    missingCount,
    unavailableCount: diff.unavailable.length,
    // 按类聚合，让"某个类整体不在文档里"一眼可见，而不用数几十条明细。
    undocumentedClasses: [...new Set(diff.undocumented.map((item) => item.className))].sort(),
    missingClasses: [...new Set(diff.missing.map((item) => item.className))].sort(),
    // 采集健康度必须跟结论一起呈现：一份"全是 value、零试调"的采集也能算出漂亮的
    // 差异数字，但那些数字不可信。
    captureWarnings: diff.captureHealth.warnings,
  });
}

/**
 * 生成可提交的证据文件。conclusion 沿用 T04-h2 的 {semantic,status,value,reason} 形状，
 * 声明它将来会支持哪个语义，但本身不写入 host profile——改 profile 会连带
 * evidenceSha256 与 T20 发布证据一起重算。
 */
export function buildApiSurfaceEvidence({ diff, summary, maxDetailItems = 256 }) {
  if (!Number.isSafeInteger(maxDetailItems) || maxDetailItems < 1) {
    throw surfaceError("maxDetailItems must be a positive safe integer");
  }
  const undocumented = diff.undocumented.slice(0, maxDetailItems);
  const missing = diff.missing.slice(0, maxDetailItems);
  const evidence = {
    kind: API_SURFACE_EVIDENCE_KIND,
    schemaVersion: API_SURFACE_SCHEMA_VERSION,
    capturedAt: diff.capturedAt,
    host: diff.host,
    probe: diff.probe,
    manifestGeneratedAt: diff.manifestGeneratedAt,
    summary,
    captureHealth: diff.captureHealth,
    undocumented,
    missing,
    unavailable: diff.unavailable,
    truncated: {
      undocumented: diff.undocumented.length > undocumented.length,
      missing: diff.missing.length > missing.length,
      maxDetailItems,
    },
    conclusion: buildConclusion(summary),
  };
  assertEvidenceIsSanitized(evidence);
  return deepFreeze(evidence);
}

function buildConclusion(summary) {
  if (summary.resultCode === API_SURFACE_RESULT_CODES.confirmed) {
    return {
      semantic: "api.surfaceParity",
      status: "confirmed",
      value: { parity: "documented_matches_runtime" },
      reason:
        "Every runtime member observed on this host is present in the parsed official manifest, and every documented member of an observed class was observed.",
    };
  }
  return {
    semantic: "api.surfaceParity",
    status: "contradicted",
    value: {
      parity: "documented_diverges_from_runtime",
      undocumentedCount: summary.undocumentedCount,
      missingCount: summary.missingCount,
    },
    reason:
      "The runtime scripting surface and the parsed official manifest disagree; undocumented members lose argument validation and returned-handle typing, and documented-but-unobserved members indicate a stale manifest for this host version.",
  };
}

// 脱敏门禁：证据里只应出现标识符与短码。一旦出现路径分隔符或工程内容键名，
// 说明采集侧漏了原始信息，此时宁可拒绝生成证据。
export function assertEvidenceIsSanitized(value, label = "evidence") {
  if (value === null || typeof value === "number" || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (value.includes("\\") || value.includes("//")) {
      throw surfaceError(`${label} must not contain a path-like string`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertEvidenceIsSanitized(item, `${label}[${index}]`));
    return;
  }
  if (typeof value !== "object") throw surfaceError(`${label} has an unsupported type`);
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_KEY_NAMES.includes(key)) {
      throw surfaceError(`${label}.${key} is a project-content field and must not appear in evidence`);
    }
    assertEvidenceIsSanitized(nested, `${label}.${key}`);
  }
}

function indexManifestMethods(manifest) {
  const classes = requireRecord(manifest, "manifest").classes;
  const index = new Map();
  const record = requireRecord(classes, "manifest.classes");
  for (const [className, entry] of Object.entries(record)) {
    const names = new Set();
    for (const key of Object.keys(entry?.methods ?? {})) names.add(key);
    for (const key of Object.keys(entry?.members ?? {})) names.add(key);
    index.set(className, names);
  }
  return index;
}

function readManifestGeneratedAt(manifest) {
  const value = manifest?.generatedAt;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function sortByName(items) {
  return [...items].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

function compareStrings(left, right) {
  return left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0;
}

function assertUniqueBy(items, keyOf, label) {
  const seen = new Set();
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) throw surfaceError(`${label} contains duplicate entry: ${key}`);
    seen.add(key);
  }
}

function assertKnownKeys(value, allowed, label) {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) throw surfaceError(`${label} contains unknown field: ${unknown.join(", ")}`);
}

function requireRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw surfaceError(`${label} must be an object`);
  }
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) throw surfaceError(`${label} must be an array`);
  return value;
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw surfaceError(`${label} must be a non-empty string`);
  }
  return value;
}

function requireIdentifier(value, label) {
  requireNonEmptyString(value, label);
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw surfaceError(`${label} must be a bare identifier`);
  }
  return value;
}

function requireCode(value, label) {
  requireNonEmptyString(value, label);
  if (!/^[A-Za-z0-9_]+$/.test(value)) {
    throw surfaceError(`${label} must be an underscore/alphanumeric code`);
  }
  return value;
}

function requireBoolean(value, label) {
  if (typeof value !== "boolean") throw surfaceError(`${label} must be a boolean`);
  return value;
}

function requireSafeInteger(value, label) {
  if (!Number.isSafeInteger(value)) throw surfaceError(`${label} must be a safe integer`);
  return value;
}

function requireNonNegativeInteger(value, label) {
  requireSafeInteger(value, label);
  if (value < 0) throw surfaceError(`${label} must be a non-negative safe integer`);
  return value;
}

function requirePositiveInteger(value, label) {
  requireSafeInteger(value, label);
  if (value < 1) throw surfaceError(`${label} must be a positive safe integer`);
  return value;
}

function requireIsoTimestamp(value, label) {
  requireNonEmptyString(value, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw surfaceError(`${label} must be an ISO-8601 timestamp`);
  }
  return value;
}

function surfaceError(message) {
  const error = new Error(message);
  error.code = "INVALID_API_SURFACE_EVIDENCE";
  return error;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
