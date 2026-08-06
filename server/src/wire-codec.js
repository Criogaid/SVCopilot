import { isRecord } from "./value-shape.js";
const MAX_ARRAY_LENGTH = 1_000_000;
// 单帧 ≤ 64 KiB，但 length 声明可把分配放大到远超帧体积：一个帧塞入数百个
// "length:1e6" 的稀疏数组兄弟节点即可让解码分配数 GB。整帧聚合预算封住该放大。
const MAX_TOTAL_ARRAY_ALLOCATION = 1_000_000;
const MAX_DECODE_DEPTH = 256;
const SPECIAL_NUMBER_VALUES = new Set(["nan", "+inf", "-inf"]);
const WIRE_ARRAY_METADATA = Symbol("svWireArrayMetadata");

export function decodeWireValue(value, { epoch = 0 } = {}) {
  const context = { epoch, remainingAllocation: MAX_TOTAL_ARRAY_ALLOCATION, depth: 0 };
  return decodeValue(value, context);
}

function decodeValue(value, context) {
  if (context.depth >= MAX_DECODE_DEPTH) {
    throw new Error(`wire value nesting exceeds ${MAX_DECODE_DEPTH} levels`);
  }
  context.depth += 1;
  try {
    if (Array.isArray(value)) return value.map((item) => decodeValue(item, context));
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
          context.epoch
        );
      case "number":
        return SPECIAL_NUMBER_VALUES.has(value.value)
          ? { $sv: "number", value: value.value }
          : { $sv: "number", value: "invalid" };
      case "array":
      case "sparse-array":
        return decodeArrayEnvelope(value, context);
      case "tuple":
        return {
          $sv: "tuple",
          items: readSequence(value.items).map((item) => decodeValue(item, context)),
        };
      case "map":
        return decodeMapEnvelope(value, context);
      case "table":
        return {
          $sv: "table",
          shape: typeof value.shape === "string" ? value.shape : "unknown",
          entries: readSequence(value.entries).map((entry) => decodeEntry(entry, context)),
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
      decoded[key] = decodeValue(nested, context);
    }
    return stampHandleEpoch(decoded, context.epoch);
  } finally {
    context.depth -= 1;
  }
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

function decodeArrayEnvelope(value, context) {
  const length = normalizeLength(value.length);
  if (length > context.remainingAllocation) {
    throw new Error(
      `wire frame declares more than ${MAX_TOTAL_ARRAY_ALLOCATION} aggregate array slots`
    );
  }
  context.remainingAllocation -= length;
  const output = Array(length).fill(null);
  const observedIndices = new Set();
  for (const rawEntry of readSequence(value.entries)) {
    const [rawIndex, rawValue] = decodeEntry(rawEntry, context);
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

function decodeMapEnvelope(value, context) {
  const entries = readSequence(value.entries).map((entry) => decodeEntry(entry, context));
  if (!entries.every(([key]) => typeof key === "string")) {
    return { $sv: "map", entries };
  }
  const output = Object.create(null);
  for (const [key, nested] of entries) output[key] = nested;
  return output;
}

function decodeEntry(entry, context) {
  const pair = readSequence(entry);
  return [decodeValue(pair[0], context), decodeValue(pair[1], context)];
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
