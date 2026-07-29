import assert from "node:assert";
import { encodeToolResult, encodeToolError, encodeToolErrorEnvelope, measureToolEnvelope } from "../server/src/mcp-result-encoder.js";

// 成功结果：默认 minified。
{
  const result = encodeToolResult({ ok: true, status: "succeeded", data: [1, 2, 3] });
  assert.strictEqual(result.content[0].type, "text");
  assert.strictEqual(result.content[0].text, JSON.stringify({ ok: true, status: "succeeded", data: [1, 2, 3] }));
  assert.strictEqual(result.structuredContent.ok, true);
  assert.strictEqual(result.isError, undefined);
}

// ok:false 结果应标记 isError。
{
  const result = encodeToolResult({ ok: false, status: "failed", error: { code: "X" } });
  assert.strictEqual(result.isError, true);
}

// 非对象值包装成 { result: value }。
{
  const result = encodeToolResult("pong");
  assert.deepStrictEqual(result.structuredContent, { result: "pong" });
  assert.strictEqual(result.content[0].text, '"pong"');
}

// pretty 模式。
{
  const result = encodeToolResult({ ok: true }, { pretty: true });
  assert.ok(result.content[0].text.includes("\n  "));
}

// 错误编码。
{
  const result = encodeToolError("INVALID_ARGUMENTS", "missing field", { field: "x" });
  assert.strictEqual(result.isError, true);
  assert.strictEqual(result.structuredContent.error.code, "INVALID_ARGUMENTS");
  assert.strictEqual(result.structuredContent.error.field, "x");
  assert.ok(result.content[0].text.includes("INVALID_ARGUMENTS"));
}

// 错误 envelope 形式。
{
  const result = encodeToolErrorEnvelope({ code: "X", message: "Y", details: { a: 1 } });
  assert.strictEqual(result.isError, true);
  assert.strictEqual(result.structuredContent.error.code, "X");
  assert.strictEqual(result.structuredContent.error.a, 1);
}

// 测量工具：文本和结构化内容均大于 0。
{
  const result = encodeToolResult({ ok: true, data: "x".repeat(100) });
  const measure = measureToolEnvelope(result);
  assert.ok(measure.textUtf8Bytes > 0);
  assert.ok(measure.structuredUtf8Bytes > 0);
  assert.ok(measure.envelopeUtf8Bytes >= measure.structuredUtf8Bytes);
}

console.log("mcp-result-encoder.test.mjs passed");
