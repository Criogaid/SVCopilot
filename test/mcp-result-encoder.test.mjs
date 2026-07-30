import assert from "node:assert";
import {
  encodeToolResult,
  encodeToolError,
  encodeToolErrorEnvelope,
  fullPayloadDuplicationBytes,
  isErrorStatus,
  measureToolEnvelope,
  summarizeLine,
} from "../server/src/mcp-result-encoder.js";

// 成功结果：content 只有一行摘要，绝不复制完整 payload。
{
  const result = encodeToolResult({ status: "succeeded", contextId: "c_abc", data: [1, 2, 3] });
  assert.strictEqual(result.content[0].type, "text");
  assert.strictEqual(result.content[0].text, "succeeded c_abc");
  assert.strictEqual(result.structuredContent.status, "succeeded");
  assert.strictEqual(result.isError, undefined);
  assert.strictEqual(fullPayloadDuplicationBytes(result), 0);
}

// ok 布尔不进入 MCP surface；status 是唯一成败来源。
{
  const domainResult = { ok: true, status: "succeeded", data: { changed: 1 } };
  const result = encodeToolResult(domainResult);
  assert.strictEqual("ok" in result.structuredContent, false);
  // 不得改写调用方持有的对象。
  assert.strictEqual(domainResult.ok, true);
}

// 失败类 status 必须置 isError，判据是"操作有没有完成"。
for (const status of [
  "failed",
  "conflict",
  "rolled_back",
  "rollback_failed",
  "partial",
  "outcome_unknown",
]) {
  const result = encodeToolResult({ ok: false, status, error: { code: "X" } });
  assert.strictEqual(result.isError, true, `${status} 必须是 isError`);
  assert.strictEqual(isErrorStatus(status), true);
}

// 写入已验证、只是 processing 观察失败：不得标成 isError，否则模型会重试 mutation。
{
  const result = encodeToolResult({
    ok: true,
    status: "processing_observation_failed",
    effects: "verified",
  });
  assert.strictEqual(result.isError, undefined);
  assert.strictEqual(isErrorStatus("processing_observation_failed"), false);
}

// 非对象值包装成 { result: value }。
{
  const result = encodeToolResult("pong");
  assert.deepStrictEqual(result.structuredContent, { result: "pong" });
  assert.strictEqual(result.content[0].text, "succeeded");
}

// 摘要行携带 planner 交接引用。
{
  const text = summarizeLine({
    status: "planned",
    data: { apply: { operation: "patch_parameter_curves", planRef: "a_F8x2Qm4pV7Ks" } },
  });
  assert.strictEqual(text, "planned apply=patch_parameter_curves a_F8x2Qm4pV7Ks");
}

// 摘要行上限 512 bytes，且必须是单行。
{
  const result = encodeToolResult({
    status: "failed",
    error: { code: "X".repeat(900), path: "/a" },
  });
  const text = result.content[0].text;
  assert.ok(Buffer.byteLength(text, "utf8") <= 512, "摘要行不得超过 512 bytes");
  assert.strictEqual(text.includes("\n"), false);
}

// 多字节字符按码点边界截断，不产生替换字符。
{
  const text = summarizeLine({ status: "failed", error: { code: "甲".repeat(400) } });
  assert.ok(Buffer.byteLength(text, "utf8") <= 512);
  assert.strictEqual(text.includes("�"), false);
}

// 错误编码。
{
  const result = encodeToolError("INVALID_ARGUMENTS", "missing field", { path: "/x" });
  assert.strictEqual(result.isError, true);
  assert.strictEqual(result.structuredContent.error.code, "INVALID_ARGUMENTS");
  assert.strictEqual(result.structuredContent.error.path, "/x");
  assert.strictEqual("ok" in result.structuredContent, false);
  assert.strictEqual(result.content[0].text, "failed INVALID_ARGUMENTS /x");
  assert.strictEqual(fullPayloadDuplicationBytes(result), 0);
}

// 错误 envelope 形式。
{
  const result = encodeToolErrorEnvelope({ code: "X", message: "Y", details: { a: 1 } });
  assert.strictEqual(result.isError, true);
  assert.strictEqual(result.structuredContent.error.code, "X");
  assert.strictEqual(result.structuredContent.error.a, 1);
}

// 测量工具：text 现在必须远小于 structuredContent，而不是与之相等。
{
  const result = encodeToolResult({ status: "succeeded", data: "x".repeat(4000) });
  const measure = measureToolEnvelope(result);
  assert.ok(measure.textUtf8Bytes > 0);
  assert.ok(measure.structuredUtf8Bytes > 0);
  assert.ok(measure.envelopeUtf8Bytes >= measure.structuredUtf8Bytes);
  assert.ok(
    measure.textUtf8Bytes <= 512,
    "摘要行不得随 payload 增长"
  );
  assert.ok(
    measure.envelopeUtf8Bytes < measure.structuredUtf8Bytes * 2,
    "wire bytes 不得再是 payload 的两倍"
  );
}

console.log("mcp-result-encoder.test.mjs passed");
