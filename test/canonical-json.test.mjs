import assert from "node:assert";
import { canonicalize, contentHash, canonicalClone } from "../server/src/canonical-json.js";

// key 稳定排序：不同插入顺序应产生相同 canonical string。
{
  const a = { b: 1, a: 2 };
  const b = { a: 2, b: 1 };
  assert.strictEqual(canonicalize(a), canonicalize(b));
  assert.strictEqual(canonicalize(a), '{"a":2,"b":1}');
}

// 数组顺序保持不变。
{
  assert.strictEqual(canonicalize([3, 2, 1]), "[3,2,1]");
}

// 安全整数保持无小数点。
{
  assert.strictEqual(canonicalize(42), "42");
  assert.strictEqual(canonicalize(-0), "0"); // -0 在 JSON 规范中等于 0
}

// 嵌套对象与数组。
{
  const value = { z: [{ c: 1, a: 2 }], a: { b: "x", a: 1 } };
  const expected = '{"a":{"a":1,"b":"x"},"z":[{"a":2,"c":1}]}';
  assert.strictEqual(canonicalize(value), expected);
}

// 非 JSON 值、会丢失语义的对象和值必须被拒绝。
{
  assert.throws(() => canonicalize(undefined), /Cannot canonicalize undefined/);
  assert.throws(() => canonicalize({ a: 1, b: undefined }), /Cannot canonicalize undefined/);
  assert.throws(() => canonicalize(() => {}), /Cannot canonicalize function/);
  assert.throws(() => canonicalize(Symbol("x")), /Cannot canonicalize symbol/);
  assert.throws(() => canonicalize(123n), /Cannot canonicalize bigint/);
  assert.throws(() => canonicalize(Infinity), /Non-finite number/);
  assert.throws(() => canonicalize(NaN), /Non-finite number/);
  assert.throws(() => canonicalize(Number.MAX_SAFE_INTEGER + 1), /Unsafe integer/);
  assert.throws(() => canonicalize(new Date()), /Cannot canonicalize Date/);
  assert.throws(() => canonicalize(new Map()), /Cannot canonicalize Map/);
  assert.throws(() => canonicalize({ __handle__: 1, __epoch__: 2 }), /host handle/);
  assert.throws(() => canonicalize({ $sv: "handle", id: 1 }), /host handle/);
  assert.throws(() => canonicalize(new Array(1)), /sparse array slot/);
  assert.throws(() => canonicalize({ [Symbol("x")]: 1 }), /symbol-keyed property/);
}

// 循环引用被拒绝。
{
  const a = { x: 1 };
  a.self = a;
  assert.throws(() => canonicalize(a), /Circular reference/);
}

// Unicode 字符串保持可比较。
{
  assert.strictEqual(canonicalize("中文"), '"中文"');
}

// contentHash 格式与一致性。
{
  const h1 = contentHash({ b: 1, a: 2 });
  const h2 = contentHash({ a: 2, b: 1 });
  assert.ok(h1.startsWith("sha256_"));
  assert.strictEqual(h1, h2);
  assert.strictEqual(h1.length, "sha256_".length + 64);
  assert.notStrictEqual(contentHash("null"), contentHash(null));
}

// canonicalClone 深相等。
{
  const value = { b: [1, 2], a: { c: "x" } };
  const cloned = canonicalClone(value);
  assert.deepStrictEqual(cloned, { a: { c: "x" }, b: [1, 2] });
}

console.log("canonical-json.test.mjs passed");
