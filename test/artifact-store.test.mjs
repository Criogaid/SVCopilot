import assert from "node:assert";
import {
  ArtifactStore,
  DEFAULT_ARTIFACT_PAGE_BYTES,
  MAX_ARTIFACT_DIRECT_READ_BYTES,
  artifactReference,
  artifactResourceView,
} from "../server/src/artifact-store.js";
import { readArtifactOffsetPage } from "../server/src/artifact-read.js";
import { encodeToolResult, measureToolEnvelope } from "../server/src/mcp-result-encoder.js";
import { COMPACT_MAX_BYTES } from "../server/src/response-budget.js";

const sessionId = "sess_001";

// 基本 seal 与 descriptor 字段。
{
  const store = new ArtifactStore();
  const artifact = store.seal({
    kind: "range-detail",
    schemaVersion: "1",
    sessionId,
    sourceEpoch: 1,
    payload: { notes: [{ id: "n1" }, { id: "n2" }] },
  });
  assert.ok(artifact.id.startsWith("a_"));
  assert.strictEqual(artifact.kind, "range-detail");
  assert.strictEqual(artifact.schemaVersion, "1");
  assert.strictEqual(artifact.sessionId, sessionId);
  assert.strictEqual(artifact.sourceEpoch, 1);
  assert.ok(artifact.contentHash.startsWith("sha256_"));
  assert.ok(artifact.createdAt);
  assert.ok(artifact.expiresAt);
  assert.strictEqual(artifact.totalBytes > 0, true);
  const reference = artifactReference(artifact);
  assert.strictEqual(reference.kind, "range-detail");
  assert.strictEqual(reference.schemaVersion, "1");
  assert.strictEqual(reference.expiresAt, artifact.expiresAt);
  assert.strictEqual(reference.totalBytes, artifact.totalBytes);
  assert.deepStrictEqual(reference.read, {
    tool: "sv_artifact",
    arguments: {
      operation: "read",
      arguments: { artifactId: artifact.id },
    },
  });
  assert.match(reference.resourceUri, /^svcopilot:\/\/artifacts\//);
  assert.strictEqual(
    reference.firstPageUri,
    `${reference.resourceUri}/pages/start?byteBudget=${DEFAULT_ARTIFACT_PAGE_BYTES}`
  );
  assert.strictEqual(reference.pagingRequired, false);
  assert.deepStrictEqual(artifactResourceView(artifact).payload, artifact.payload);
}

// 大 artifact 的直接 resource 只返回 descriptor，正文必须分页读取。
{
  const store = new ArtifactStore();
  const artifact = store.seal({
    kind: "range-detail",
    schemaVersion: "1",
    sessionId,
    payload: { text: "x".repeat(MAX_ARTIFACT_DIRECT_READ_BYTES) },
  });
  const view = artifactResourceView(artifact);
  assert.strictEqual(view.pagingRequired, true);
  assert.strictEqual(view.payload, undefined);
  assert.strictEqual(view.access.mode, "paged");
  assert.strictEqual(view.access.directReadMaxBytes, MAX_ARTIFACT_DIRECT_READ_BYTES);
  assert.deepStrictEqual(view.access.preferred, view.read);
  assert.strictEqual(view.access.compatibility.firstPageUri, view.firstPageUri);
}

// resolve 正确返回 artifact。
{
  const store = new ArtifactStore();
  const artifact = store.seal({ kind: "range-detail", schemaVersion: "1", sessionId, payload: { x: 1 } });
  const resolved = store.resolve({ artifactId: artifact.id, sessionId });
  assert.strictEqual(resolved.id, artifact.id);
  assert.deepStrictEqual(resolved.payload, { x: 1 });
}

// resolve 校验 kind 和 contentHash。
{
  const store = new ArtifactStore();
  const artifact = store.seal({ kind: "range-detail", schemaVersion: "1", sessionId, payload: { x: 1 } });
  assert.throws(
    () => store.resolve({ artifactId: artifact.id, expectedKind: "wrong", sessionId }),
    /ARTIFACT_KIND_MISMATCH/
  );
  assert.throws(
    () =>
      store.resolve({
        artifactId: artifact.id,
        expectedContentHash: "sha256_0000000000000000000000000000000000000000000000000000000000000000",
        sessionId,
      }),
    /ARTIFACT_HASH_MISMATCH/
  );
}

// session 隔离。
{
  const store = new ArtifactStore();
  const artifact = store.seal({ kind: "x", schemaVersion: "1", sessionId, payload: {} });
  assert.throws(() => store.resolve({ artifactId: artifact.id, sessionId: "other" }), /ARTIFACT_SESSION_MISMATCH/);
  assert.throws(
    () => store.readOffsetPage({ artifactId: artifact.id, sessionId: "other" }),
    /ARTIFACT_SESSION_MISMATCH/
  );
}

// TTL 过期与未知 artifact 使用不同错误码。
{
  let now = 0;
  const store = new ArtifactStore({ now: () => now });
  const artifact = store.seal({
    kind: "x",
    schemaVersion: "1",
    sessionId,
    payload: { data: "x" },
    leaseMs: 1000,
  });
  now = 1001;
  assert.throws(
    () => store.readOffsetPage({ artifactId: artifact.id, sessionId }),
    /ARTIFACT_EXPIRED/
  );
  assert.throws(() => store.resolve({ artifactId: artifact.id, sessionId }), /ARTIFACT_EXPIRED/);
  assert.throws(() => store.resolve({ artifactId: "a_unknown", sessionId }), /ARTIFACT_NOT_FOUND/);
}

// release 后 resolve 失败。
{
  const store = new ArtifactStore();
  const artifact = store.seal({ kind: "x", schemaVersion: "1", sessionId, payload: {} });
  assert.strictEqual(store.release({ artifactId: artifact.id, sessionId }), true);
  assert.throws(() => store.resolve({ artifactId: artifact.id, sessionId }), /ARTIFACT_NOT_FOUND/);
}

// capacity 限制：超过 maxTotalBytes 拒绝。
{
  const store = new ArtifactStore({ quotas: { maxTotalBytes: 1, maxArtifactBytes: 1_000_000 } });
  assert.throws(
    () => store.seal({ kind: "x", schemaVersion: "1", sessionId, payload: { data: "too large" } }),
    /ARTIFACT_CAPACITY_EXCEEDED/
  );
}

// payload 不可变：seal 后修改不应影响内部对象。
{
  const store = new ArtifactStore();
  const payload = { nested: { value: 1 } };
  const artifact = store.seal({ kind: "x", schemaVersion: "1", sessionId, payload });
  payload.nested.value = 2;
  assert.strictEqual(artifact.payload.nested.value, 1);
  assert.strictEqual(Object.isFrozen(artifact.payload), true);
  assert.strictEqual(Object.isFrozen(artifact.payload.nested), true);
}

// 达到 entry 上限时拒绝新写入，不得静默淘汰仍在租期内的 artifact。
{
  const store = new ArtifactStore({ quotas: { maxEntries: 1 } });
  const first = store.seal({ kind: "x", schemaVersion: "1", sessionId, payload: { first: true } });
  assert.throws(
    () => store.seal({ kind: "x", schemaVersion: "1", sessionId, payload: { second: true } }),
    /ARTIFACT_CAPACITY_EXCEEDED/
  );
  assert.strictEqual(store.resolve({ artifactId: first.id, sessionId }).id, first.id);
}

// readPage 按 UTF-8 字节切片，opaque cursor 可连续重组且不能篡改。
{
  const store = new ArtifactStore({ cursorSecret: Buffer.alloc(32, 7) });
  const payload = { text: "甲乙丙丁", items: [1, 2, 3] };
  const artifact = store.seal({ kind: "x", schemaVersion: "1", sessionId, payload });
  const fragments = [];
  let cursor = "start";
  do {
    const { page } = store.readPage({
      artifactId: artifact.id,
      expectedContentHash: artifact.contentHash,
      sessionId,
      cursor,
      byteBudget: 7,
    });
    fragments.push(page.data);
    assert.strictEqual(Buffer.byteLength(page.data, "utf8"), page.bytesReturned);
    cursor = page.cursor;
  } while (cursor !== null);
  assert.deepStrictEqual(JSON.parse(fragments.join("")), payload);

  const firstPage = store.readPage({
    artifactId: artifact.id,
    expectedContentHash: artifact.contentHash,
    sessionId,
    byteBudget: 7,
  }).page;
  // 篡改必须发生在**首字符**上。base64url 的末字符只承载有效位的高 2 位（32 字节
  // 签名编码成 43 字符），因此 A<->B 这种末字符互换在约 1/16 的签名上解码出完全相同
  // 的字节——曾让这条断言以那个概率随机通过。先证明字节真的变了，再断言被拒绝，
  // 否则"没抛错"到底是校验漏了还是根本没改动就无从分辨。
  const [body, signature] = firstPage.cursor.split(".");
  const tamperedSignature = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
  assert.notDeepStrictEqual(
    Buffer.from(tamperedSignature, "base64url"),
    Buffer.from(signature, "base64url"),
    "the tampered signature must actually decode to different bytes"
  );
  assert.throws(
    () =>
      store.readPage({
        artifactId: artifact.id,
        expectedContentHash: artifact.contentHash,
        sessionId,
        cursor: `${body}.${tamperedSignature}`,
        byteBudget: 7,
      }),
    /ARTIFACT_CURSOR_INVALID/
  );
}

// 短 offset 页在多字节正文上连续推进，末页才返回完整性 hash。
{
  const store = new ArtifactStore();
  const payload = { text: "甲乙丙丁".repeat(5000), items: [1, 2, 3] };
  const artifact = store.seal({ kind: "detail", schemaVersion: "1", sessionId, payload });
  const fragments = [];
  let offset = 0;
  let finalHash = null;
  do {
    const result = readArtifactOffsetPage({ artifactStore: store, sessionId, artifactId: artifact.id, offset });
    const envelopeBytes = measureToolEnvelope(encodeToolResult(result)).envelopeUtf8Bytes;
    assert.ok(envelopeBytes <= COMPACT_MAX_BYTES, `offset page exceeded ${COMPACT_MAX_BYTES} bytes`);
    fragments.push(result.data.text);
    if (result.data.done) {
      assert.strictEqual(result.data.nextOffset, undefined);
      finalHash = result.data.contentHash;
      break;
    }
    assert.ok(result.data.nextOffset > offset);
    assert.strictEqual(result.data.contentHash, undefined);
    offset = result.data.nextOffset;
  } while (true);
  assert.deepStrictEqual(JSON.parse(fragments.join("")), payload);
  assert.strictEqual(finalHash, artifact.contentHash);
}

// JSON 转义密集正文按最终 MCP envelope 收缩，而不是假设原始 16 KiB 一定装得下。
{
  const store = new ArtifactStore();
  const payload = { text: "\u0000\"\\".repeat(12000) };
  const artifact = store.seal({ kind: "detail", schemaVersion: "1", sessionId, payload });
  const result = readArtifactOffsetPage({ artifactStore: store, sessionId, artifactId: artifact.id });
  const envelopeBytes = measureToolEnvelope(encodeToolResult(result)).envelopeUtf8Bytes;
  assert.ok(envelopeBytes <= COMPACT_MAX_BYTES);
  assert.ok(Buffer.byteLength(result.data.text, "utf8") < 16 * 1024);
  assert.equal(result.data.done, false);
}

// offset 必须在范围内且位于 UTF-8 code point 边界；sealed plan 仍只能按 PlanRef 执行。
{
  const store = new ArtifactStore();
  const artifact = store.seal({ kind: "detail", schemaVersion: "1", sessionId, payload: { text: "甲" } });
  assert.throws(
    () => store.readOffsetPage({ artifactId: artifact.id, sessionId, offset: 10 }),
    /ARTIFACT_OFFSET_NOT_UTF8_BOUNDARY/
  );
  assert.throws(
    () => store.readOffsetPage({ artifactId: artifact.id, sessionId, offset: artifact.totalBytes }),
    /ARTIFACT_OFFSET_OUT_OF_BOUNDS/
  );
  assert.throws(
    () => store.readOffsetPage({ artifactId: artifact.id, sessionId, offset: -1 }),
    /INVALID_ARGUMENTS/
  );
  const plan = store.seal({ kind: "plan", schemaVersion: "1", sessionId, payload: { mutation: true } });
  assert.throws(
    () => readArtifactOffsetPage({ artifactStore: store, sessionId, artifactId: plan.id }),
    /ARTIFACT_NOT_READABLE/
  );
}

// 新旧翻页只改变传输信封，重组后的规范 JSON 必须完全一致。
{
  const store = new ArtifactStore({ cursorSecret: Buffer.alloc(32, 9) });
  const payload = { text: "兼容".repeat(9000), values: [1, 2, 3] };
  const artifact = store.seal({ kind: "detail", schemaVersion: "1", sessionId, payload });
  const legacy = [];
  let cursor = "start";
  do {
    const { page } = store.readPage({
      artifactId: artifact.id,
      expectedContentHash: artifact.contentHash,
      sessionId,
      cursor,
      byteBudget: 8192,
    });
    legacy.push(page.data);
    cursor = page.cursor;
  } while (cursor !== null);

  const short = [];
  let offset = 0;
  do {
    const result = readArtifactOffsetPage({ artifactStore: store, sessionId, artifactId: artifact.id, offset });
    short.push(result.data.text);
    if (result.data.done) break;
    offset = result.data.nextOffset;
  } while (true);
  assert.strictEqual(short.join(""), legacy.join(""));
}

// 分页不得为每一页重新序列化整个 payload。以前每页都 JSON.stringify(payload)，
// 读完一个 artifact 是 O(页数 × 体积)：8 MiB 上限下约 17 s 的阻塞 CPU。
// 这里同时把关正确性（字节完全一致）与复杂度（序列化次数不随页数增长）。
{
  const store = new ArtifactStore();
  const payload = { rows: Array.from({ length: 4000 }, (_, index) => ({ index, value: index * 1.5, label: `row-${index}` })) };
  const artifact = store.seal({ kind: "detail", schemaVersion: "1", sessionId, payload });
  assert.ok(artifact.totalBytes > 64 * 1024, "fixture must span many pages");

  // seal 已经算好字节；翻页只切片，不再调用 JSON.stringify。
  const originalStringify = JSON.stringify;
  let stringifyCalls = 0;
  JSON.stringify = function countingStringify(...args) {
    stringifyCalls += 1;
    return originalStringify.apply(this, args);
  };
  let fragments = [];
  let pages = 0;
  try {
    let offset = 0;
    do {
      const result = store.readOffsetPage({ artifactId: artifact.id, sessionId, offset });
      pages += 1;
      fragments.push(result.page.text);
      if (result.page.done) break;
      offset = result.page.nextOffset;
    } while (true);
  } finally {
    JSON.stringify = originalStringify;
  }

  assert.ok(pages > 4, `fixture must page more than once, got ${pages}`);
  assert.deepStrictEqual(JSON.parse(fragments.join("")), payload, "paged bytes must rebuild the payload exactly");
  assert.strictEqual(
    stringifyCalls,
    0,
    `paging must reuse the payload serialized at seal time; observed ${stringifyCalls} JSON.stringify calls across ${pages} pages`
  );

  // 游标翻页同样复用缓存。它仍会为每个 cursor token 序列化一个几十字节的小对象，
  // 因此这里只禁止「整个 payload 规模的序列化」，而不是禁止一切 JSON.stringify。
  const payloadTextBytes = artifact.totalBytes;
  let cursorPages = 0;
  let payloadSizedSerializations = 0;
  JSON.stringify = function countingStringify(...args) {
    const output = originalStringify.apply(this, args);
    if (typeof output === "string" && output.length >= payloadTextBytes) {
      payloadSizedSerializations += 1;
    }
    return output;
  };
  try {
    let cursor = "start";
    do {
      const { page } = store.readPage({
        artifactId: artifact.id,
        expectedContentHash: artifact.contentHash,
        sessionId,
        cursor,
        byteBudget: 8192,
      });
      cursorPages += 1;
      cursor = page.cursor;
    } while (cursor !== null);
  } finally {
    JSON.stringify = originalStringify;
  }
  assert.ok(cursorPages > 4, `cursor paging fixture must span pages, got ${cursorPages}`);
  assert.strictEqual(
    payloadSizedSerializations,
    0,
    `cursor paging must reuse the sealed bytes; observed ${payloadSizedSerializations} full-payload serializations across ${cursorPages} pages`
  );

  // 缓存与 entry 同生命周期：释放后不得继续占住这份字节。
  assert.strictEqual(store.payloadBytes.has(artifact.id), true);
  store.release({ artifactId: artifact.id, sessionId });
  assert.strictEqual(store.payloadBytes.has(artifact.id), false);
  assert.strictEqual(store.totalBytes, 0);
}

console.log("artifact-store.test.mjs passed");
