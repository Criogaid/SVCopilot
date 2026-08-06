// 规范化 JSON：稳定 key 顺序、标量规范化、拒绝非 JSON 值，提供统一 content hash。
import { createHash } from "node:crypto";
import { isPlainRecord } from "./value-shape.js";

const MAX_STRING_LENGTH = 1_000_000_000;

function assertSerializable(value, path = "") {
  if (value === undefined) {
    throw new TypeError(`Cannot canonicalize undefined at ${path || "root"}`);
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new RangeError(`Non-finite number at ${path || "root"}: ${value}`);
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new RangeError(`Unsafe integer at ${path || "root"}: ${value}`);
    }
    return;
  }
  if (typeof value === "bigint") {
    throw new TypeError(`Cannot canonicalize bigint at ${path || "root"}`);
  }
  if (typeof value === "function") {
    throw new TypeError(`Cannot canonicalize function at ${path || "root"}`);
  }
  if (typeof value === "symbol") {
    throw new TypeError(`Cannot canonicalize symbol at ${path || "root"}`);
  }
  if (typeof value !== "object") {
    throw new TypeError(`Cannot canonicalize ${typeof value} at ${path || "root"}`);
  }
  if (!Array.isArray(value) && !isPlainRecord(value)) {
    throw new TypeError(
      `Cannot canonicalize ${value?.constructor?.name ?? "non-plain object"} at ${path || "root"}`
    );
  }
  if (
    !Array.isArray(value) &&
    (Object.hasOwn(value, "__handle__") || (value.$sv === "handle" && Object.hasOwn(value, "id")))
  ) {
    throw new TypeError(`Cannot canonicalize host handle at ${path || "root"}`);
  }
  if (!Array.isArray(value) && Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(`Cannot canonicalize symbol-keyed property at ${path || "root"}`);
  }
}

function canonicalizeInternal(value, path, seen) {
  assertSerializable(value, path);

  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    // JSON.stringify 对安全整数范围内的整数保持精确；对浮点使用 shortest representation。
    if (Number.isInteger(value) && Number.isSafeInteger(value)) {
      return String(value);
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    if (value.length > MAX_STRING_LENGTH) {
      throw new RangeError(`String too long at ${path || "root"}: ${value.length}`);
    }
    return JSON.stringify(value);
  }

  if (seen.has(value)) {
    throw new TypeError(`Circular reference detected at ${path || "root"}`);
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError(`Cannot canonicalize sparse array slot at ${path}[${index}]`);
        }
      }
      const parts = value.map((item, index) => canonicalizeInternal(item, `${path}[${index}]`, seen));
      return `[${parts.join(",")}]`;
    }

    // Plain object.
    const keys = Object.keys(value).sort();
    const parts = keys.map((key) => {
      const childPath = path ? `${path}.${key}` : key;
      return `${JSON.stringify(key)}:${canonicalizeInternal(value[key], childPath, seen)}`;
    });
    return `{${parts.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

/**
 * 将任意 JSON 可序列化值转换为规范化字符串。
 * 特点：
 * - 对象 key 按 Unicode 升序排列；
 * - 数组顺序保持不变；
 * - 安全整数以无小数点形式输出；
 * - 拒绝 undefined、function、Symbol、bigint、循环引用、非有限数值；
 * - 输出不含多余空白，可直接用于 hash 或持久化比较。
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalize(value) {
  return canonicalizeInternal(value, "", new Set());
}

/**
 * 计算规范化 JSON 的 SHA-256 content hash，返回 "sha256_..." 格式。
 * 该 hash 与具体 JSON 空白无关，只与值结构有关。
 *
 * @param {unknown} value
 * @returns {string}
 */
function sha256Hex(value) {
  const text = canonicalize(value);
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function contentHash(value) {
  return `sha256_${sha256Hex(value)}`;
}

/**
 * 返回规范化 JSON 的 SHA-256 hex 字符串（不含前缀）。
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalHashHex(value) {
  return sha256Hex(value);
}

/**
 * 与 JSON.parse(canonicalize(value)) 等价，但显式暴露出来便于测试。
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function canonicalClone(value) {
  return JSON.parse(canonicalize(value));
}
