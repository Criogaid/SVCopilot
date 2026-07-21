const MAX_ARRAY_LENGTH = 1_000_000;
const SPECIAL_NUMBER_VALUES = new Set(["nan", "+inf", "-inf"]);
const WIRE_ARRAY_METADATA = Symbol("svWireArrayMetadata");

export function decodeWireValue(value, { epoch = 0 } = {}) {
  if (Array.isArray(value)) return value.map((item) => decodeWireValue(item, { epoch }));
  if (!isRecord(value)) return value;

  switch (value.$sv) {
    case "nil":
      return null;
    case "handle":
      return stampHandleEpoch(
        {
          __handle__: value.id,
          ...(typeof value.type === "string" ? { __type__: value.type } : {}),
        },
        epoch
      );
    case "number":
      return SPECIAL_NUMBER_VALUES.has(value.value)
        ? { $sv: "number", value: value.value }
        : { $sv: "number", value: "invalid" };
    case "array":
    case "sparse-array":
      return decodeArrayEnvelope(value, epoch);
    case "tuple":
      return {
        $sv: "tuple",
        items: readSequence(value.items).map((item) => decodeWireValue(item, { epoch })),
      };
    case "map":
      return decodeMapEnvelope(value, epoch);
    case "table":
      return {
        $sv: "table",
        shape: value.shape === "unknown" ? "unknown" : "unknown",
        entries: readSequence(value.entries).map((entry) => decodeEntry(entry, epoch)),
      };
    case "unsupported":
      return {
        $sv: "unsupported",
        luaType: typeof value.luaType === "string" ? value.luaType : "unknown",
      };
    default:
      break;
  }

  const decoded = Object.create(null);
  for (const [key, nested] of Object.entries(value)) {
    decoded[key] = decodeWireValue(nested, { epoch });
  }
  return stampHandleEpoch(decoded, epoch);
}

export function canonicalArray(value, { length } = {}) {
  if (Array.isArray(value)) return resizeArray(value, length);
  if (!isRecord(value)) return [];

  const entries = Object.entries(value).filter(([key]) => /^\d+$/.test(key));
  if (entries.length === 0) return resizeArray([], length);
  const maxLuaIndex = Math.max(...entries.map(([key]) => Number(key)));
  const outputLength = normalizeLength(length ?? maxLuaIndex);
  const output = Array(outputLength).fill(null);
  for (const [key, nested] of entries) {
    const index = Number(key) - 1;
    if (index >= 0 && index < output.length) output[index] = nested;
  }
  return output;
}

export function getWireArrayMetadata(value) {
  return Array.isArray(value) ? value[WIRE_ARRAY_METADATA] ?? null : null;
}

export function stampHandleEpoch(value, epoch) {
  if (!isRecord(value) || !Number.isSafeInteger(value.__handle__)) return value;
  if (Number.isSafeInteger(epoch) && epoch >= 0) value.__epoch__ = epoch;
  return value;
}

export function collectHandleRefs(value, output = new Map()) {
  if (Array.isArray(value)) {
    for (const item of value) collectHandleRefs(item, output);
    return output;
  }
  if (!isRecord(value)) return output;
  if (Number.isSafeInteger(value.__handle__)) {
    output.set(value.__handle__, value);
    return output;
  }
  for (const nested of Object.values(value)) collectHandleRefs(nested, output);
  return output;
}

function decodeArrayEnvelope(value, epoch) {
  const length = normalizeLength(value.length);
  const output = Array(length).fill(null);
  const observedIndices = new Set();
  for (const rawEntry of readSequence(value.entries)) {
    const [rawIndex, rawValue] = decodeEntry(rawEntry, epoch);
    const index = Number(rawIndex);
    if (Number.isSafeInteger(index) && index >= 0 && index < output.length) {
      output[index] = rawValue;
      observedIndices.add(index);
    }
  }
  // lengthHint 会补齐数组形状；真实观测项必须从 envelope entries 单独保留。
  Object.defineProperty(output, WIRE_ARRAY_METADATA, {
    value: Object.freeze({
      declaredLength: length,
      observedItems: observedIndices.size,
      observedIndices: Object.freeze([...observedIndices].sort((left, right) => left - right)),
      sparse: value.$sv === "sparse-array",
    }),
    enumerable: false,
  });
  return output;
}

function decodeMapEnvelope(value, epoch) {
  const entries = readSequence(value.entries).map((entry) => decodeEntry(entry, epoch));
  if (!entries.every(([key]) => typeof key === "string")) {
    return { $sv: "map", entries };
  }
  const output = Object.create(null);
  for (const [key, nested] of entries) output[key] = nested;
  return output;
}

function decodeEntry(entry, epoch) {
  const pair = readSequence(entry);
  return [decodeWireValue(pair[0], { epoch }), decodeWireValue(pair[1], { epoch })];
}

function readSequence(value) {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  return Object.keys(value)
    .filter((key) => /^\d+$/.test(key))
    .sort((left, right) => Number(left) - Number(right))
    .map((key) => value[key]);
}

function resizeArray(value, requestedLength) {
  if (requestedLength === undefined) return [...value];
  const length = normalizeLength(requestedLength);
  const output = Array(length).fill(null);
  for (let index = 0; index < Math.min(length, value.length); index += 1) {
    output[index] = value[index] ?? null;
  }
  return output;
}

function normalizeLength(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_ARRAY_LENGTH) {
    if (value === undefined) return 0;
    throw new Error(`Invalid wire array length: ${String(value)}`);
  }
  return value;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
