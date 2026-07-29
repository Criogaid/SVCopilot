import assert from "node:assert";
import {
  ArtifactStore,
  DEFAULT_ARTIFACT_PAGE_BYTES,
  MAX_ARTIFACT_DIRECT_READ_BYTES,
  artifactReference,
  artifactResourceView,
} from "../server/src/artifact-store.js";

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
  assert.strictEqual(view.access.firstPageUri, view.firstPageUri);
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
  const tampered = `${firstPage.cursor.slice(0, -1)}${firstPage.cursor.endsWith("A") ? "B" : "A"}`;
  assert.throws(
    () =>
      store.readPage({
        artifactId: artifact.id,
        expectedContentHash: artifact.contentHash,
        sessionId,
        cursor: tampered,
        byteBudget: 7,
      }),
    /ARTIFACT_CURSOR_INVALID/
  );
}

console.log("artifact-store.test.mjs passed");
