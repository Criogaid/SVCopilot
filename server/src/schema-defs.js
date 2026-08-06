import { isRecord } from "./value-shape.js";
// inputSchema 的 $defs 去重。
//
// 曲线/音符/范围类工具的 schema 里，同一个共享片段（CURVE_RANGE_SCHEMA、
// NOTE_ANCHOR_SCHEMA 等）会在一份 schema 内展开多次——它们本来就是同一个 JS 常量，
// 只是 JSON 序列化时被复制了 N 份。提到该 schema 自己的 $defs 后按 $ref 引用，
// 语义完全不变，但 sv_describe 的响应显著变小。
//
// 三条硬约束：
//   1. 只按对象身份（同一个 JS 引用）去重，不按结构相等。两个恰好同形但语义不同的
//      片段合并后，未来任何一处改动都会静默污染另一处。
//   2. 只提取处在「schema 位置」的节点。`properties` / `$defs` 是 schema 的映射表，
//      `default` / `const` / `examples` 里是字面数据——把它们换成 $ref 会产出无效
//      schema（Ajv 直接拒绝编译）或把 $ref 当成用户数据。位置由遍历路径判定，
//      不靠"看起来像 schema"的启发式。
//   3. $defs 放在每份 schema 自己的根上，因此 `#/$defs/x` 在这份 schema 内部即可解析。
//      放到 describe 响应根能省更多字节，但那样单独取出 inputSchema 交给 Ajv 就无法
//      解析 $ref——而"把 inputSchema 直接编译"正是调用方最自然的用法。

// 低于此字节数的片段不值得提取：一个 $ref 本身约 20 字节。
const MIN_SHARED_BYTES = 120;

// 值是单个 schema 的关键字（additionalProperties/items 也可能是 boolean 或数组）。
const SCHEMA_KEYS = new Set([
  "additionalProperties",
  "contains",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);
// 值是 schema 数组的关键字。
const SCHEMA_LIST_KEYS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
// 值是「名字 -> schema」映射表的关键字。映射表本身不是 schema。
const SCHEMA_MAP_KEYS = new Set([
  "$defs",
  "definitions",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);

/**
 * 把一份 schema 内部重复出现的共享子树提取到它自己的 $defs。
 * 没有可提取的片段时原样返回同一个对象（不做无意义的拷贝）。
 *
 * @param {object} schema
 * @returns {object}
 */
export function dedupeSchema(schema) {
  if (!isRecord(schema)) return schema;

  const counts = new Map();
  countSchemaPositions(schema, counts);
  // 出现多次、够大、且不是根本身的 schema 节点才提取。
  const shared = [...counts.entries()]
    .filter(([node, count]) => count > 1 && node !== schema && byteLength(node) >= MIN_SHARED_BYTES)
    .map(([node]) => node);
  if (shared.length === 0) return schema;

  // 名字按首次出现顺序稳定分配，保证同一份 schema 每次产出逐字节相同的结果。
  const names = new Map();
  for (const node of shared) names.set(node, `s${names.size}`);

  const $defs = {};
  for (const [node, name] of names) {
    // $defs 条目自身是 schema 根：它内部的共享片段继续按 $ref 引用（支持嵌套共享），
    // 但不能把条目自己换成指向自己的 $ref。
    $defs[name] = rewriteSchema(node, names, true);
  }
  return { ...rewriteSchema(schema, names, true), $defs };
}

// 只在 schema 位置计数。非 schema 位置（default/const/enum 等）整棵跳过，
// 因为那里的对象是数据而不是约束。
function countSchemaPositions(node, counts) {
  if (!isRecord(node)) return;
  counts.set(node, (counts.get(node) ?? 0) + 1);
  for (const [key, value] of Object.entries(node)) {
    if (SCHEMA_KEYS.has(key)) {
      // items 的元组写法是 schema 数组；additionalProperties 可能是 boolean。
      if (Array.isArray(value)) for (const item of value) countSchemaPositions(item, counts);
      else countSchemaPositions(value, counts);
    } else if (SCHEMA_LIST_KEYS.has(key) && Array.isArray(value)) {
      for (const item of value) countSchemaPositions(item, counts);
    } else if (SCHEMA_MAP_KEYS.has(key) && isRecord(value)) {
      for (const entry of Object.values(value)) countSchemaPositions(entry, counts);
    }
  }
}

function rewriteSchema(node, names, isRoot = false) {
  if (!isRecord(node)) return node;
  if (!isRoot && names.has(node)) return { $ref: `#/$defs/${names.get(node)}` };
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (SCHEMA_KEYS.has(key)) {
      out[key] = Array.isArray(value)
        ? value.map((item) => rewriteSchema(item, names))
        : rewriteSchema(value, names);
    } else if (SCHEMA_LIST_KEYS.has(key) && Array.isArray(value)) {
      out[key] = value.map((item) => rewriteSchema(item, names));
    } else if (SCHEMA_MAP_KEYS.has(key) && isRecord(value)) {
      out[key] = Object.fromEntries(
        Object.entries(value).map(([name, entry]) => [name, rewriteSchema(entry, names)])
      );
    } else {
      // 非 schema 位置原样保留：这里可能是 default/const/enum 等字面数据。
      out[key] = value;
    }
  }
  return out;
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
