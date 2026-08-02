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
// effects 按矩阵给出：rollback_failed 允许 may_remain/unknown 两种，因此不可省略——
// 服务端替它挑一个就是在编造"宿主里还剩什么"的证据。
for (const [status, effects] of [
  ["failed", "none"],
  ["conflict", "none"],
  ["rolled_back", "reverted"],
  ["rollback_failed", "may_remain"],
  ["partial", "may_remain"],
  ["outcome_unknown", "unknown"],
]) {
  const result = encodeToolResult({ ok: false, status, effects, error: { code: "X" } });
  assert.strictEqual(result.isError, true, `${status} 必须是 isError`);
  assert.strictEqual(isErrorStatus(status), true);
}

// 写入已验证、只是 processing 观察失败：投影成 succeeded/verified，绝不置 isError，
// 否则模型会重放一个已经成功的 mutation。状态机取值移入 data.state 不丢失。
{
  const result = encodeToolResult({
    ok: true,
    status: "processing_observation_failed",
    effects: "verified",
    data: { changed: 1 },
  });
  assert.strictEqual(result.isError, undefined);
  assert.strictEqual(result.structuredContent.status, "succeeded");
  assert.strictEqual(result.structuredContent.data.state, "processing_observation_failed");
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

// §11 删除项 17：可由其它字段完全推导的字段必须在 surface 上消失。
// 一次断言四类，因为它们共用同一条判据（「恒等于默认值」），分开写会让某一类
// 悄悄回归时另外三条仍然通过。
{
  const result = encodeToolResult({
    status: "succeeded",
    effects: "verified",
    // 空 warnings 与「没有警告」是同一件事（§10.2.1「非空时」）。
    warnings: [],
    // false 是默认值；只有 true 需要出现。
    retryable: false,
    // 容器出现本身就是 attempted 的证据，键内再写一遍是同义重复。
    verification: { attempted: true, passed: true },
    // attempted:false —— 这一步从未发生，整个容器都是噪声。
    rollback: { attempted: false, verified: null },
    data: { detail: {}, changed: 1 },
  });
  const structured = result.structuredContent;
  assert.deepStrictEqual(Object.keys(structured).sort(), [
    "data",
    "effects",
    "status",
    "verification",
  ]);
  assert.deepStrictEqual(structured.verification, { passed: true });
  assert.deepStrictEqual(structured.data, { changed: 1 }, "空 detail 必须整个消失");
}

// 反例，比省略规则本身更重要：「尝试过且失败」与「从未尝试」是两件事。
// 省略 passed:false 会让一次失败的读回验证看起来像一次没做验证的成功写入。
{
  const structured = encodeToolResult({
    status: "partial",
    effects: "may_remain",
    verification: { attempted: true, passed: false, evidence: { observed: {} } },
    rollback: { attempted: true, verified: false },
    warnings: [{ code: "X", count: 1 }],
  }).structuredContent;
  assert.strictEqual(structured.verification.passed, false);
  assert.strictEqual(structured.rollback.verified, false);
  assert.deepStrictEqual(structured.warnings, [{ code: "X", count: 1 }]);
  assert.deepStrictEqual(structured.data, undefined);
}

// retryable:true 是唯一需要出现的取值，因此不能被省略掉。矩阵只允许它与
// effects:"none" 并存（零写入才谈得上原样重放），所以这里必须单独构造一个
// 零副作用失败，而不是挂在上面那个 partial 上。
{
  const structured = encodeToolResult({
    status: "failed",
    effects: "none",
    retryable: true,
  }).structuredContent;
  assert.strictEqual(structured.retryable, true);
}

// 非空 detail 是可读取的明细引用，必须原样保留。
{
  const structured = encodeToolResult({
    status: "succeeded",
    data: { detail: { artifact: "a_x", totalBytes: 9 } },
  }).structuredContent;
  assert.deepStrictEqual(structured.data.detail, { artifact: "a_x", totalBytes: 9 });
}

// 没有信封的 operation（sv_raw 的 handle 图、官方文档查询）直接透出宿主值：
// 在那些形状上套用根信封的出现条件会删掉宿主自己的字段。
{
  const structured = encodeToolResult({
    handle: [7, 1],
    warnings: [],
    retryable: false,
  }).structuredContent;
  assert.deepStrictEqual(Object.keys(structured).sort(), ["handle", "retryable", "warnings"]);
}

console.log("mcp-result-encoder.test.mjs passed");
