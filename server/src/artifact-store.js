// 不可变 Artifact 存储：服务端大结果/大计划的只读容器，与短期可编辑 Context 生命周期隔离。
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { canonicalClone, contentHash } from "./canonical-json.js";

export const DEFAULT_ARTIFACT_PAGE_BYTES = 8 * 1024;
export const MIN_ARTIFACT_PAGE_BYTES = 8 * 1024;
export const MAX_ARTIFACT_PAGE_BYTES = 16 * 1024;
export const MAX_ARTIFACT_DIRECT_READ_BYTES = 16 * 1024;

// 默认配额，R0 后可调整。
export const DEFAULT_ARTIFACT_QUOTAS = Object.freeze({
  defaultLeaseMs: 30 * 60 * 1000,
  maxLeaseMs: 60 * 60 * 1000,
  maxEntries: 128,
  maxArtifactBytes: 8 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
});

export function artifactReference(artifact) {
  const baseUri = `svcopilot://artifacts/${encodeURIComponent(artifact.id)}/${encodeURIComponent(
    artifact.contentHash
  )}`;
  return Object.freeze({
    artifactId: artifact.id,
    contentHash: artifact.contentHash,
    kind: artifact.kind,
    schemaVersion: artifact.schemaVersion,
    resourceUri: baseUri,
    firstPageUri: `${baseUri}/pages/start?byteBudget=${DEFAULT_ARTIFACT_PAGE_BYTES}`,
    expiresAt: artifact.expiresAt,
    totalBytes: artifact.totalBytes,
    pagingRequired: artifact.totalBytes > MAX_ARTIFACT_DIRECT_READ_BYTES,
  });
}

export function artifactResourceView(artifact) {
  const reference = artifactReference(artifact);
  const descriptor = {
    ...reference,
    createdAt: artifact.createdAt,
    remainingLeaseSeconds: artifact.remainingLeaseSeconds,
  };
  if (reference.pagingRequired) {
    return {
      ...descriptor,
      access: {
        mode: "paged",
        reason: "artifact_exceeds_safe_direct_read_limit",
        directReadMaxBytes: MAX_ARTIFACT_DIRECT_READ_BYTES,
        firstPageUri: reference.firstPageUri,
      },
    };
  }
  return { ...descriptor, access: { mode: "inline" }, payload: artifact.payload };
}

export class ArtifactStore {
  constructor({
    now = () => Date.now(),
    quotas = {},
    cursorSecret = randomBytes(32),
    // 计划执行 ledger（可选）。在这里注入而不是让 5 个 planner 各自登记：
    // seal 是"计划开始存在"的唯一时刻，登记放在别处就会漏掉某条封存路径，
    // 而漏登记的 planRef 在 commit 时会被 UNKNOWN_PLAN_REF 拒绝——一个只在
    // 特定 planner 上出现的假故障。
    planLedger = null,
  } = {}) {
    this.now = now;
    this.quotas = { ...DEFAULT_ARTIFACT_QUOTAS, ...quotas };
    validateQuotas(this.quotas);
    if (!Buffer.isBuffer(cursorSecret) || cursorSecret.length < 16) {
      throw new TypeError("cursorSecret must be a Buffer of at least 16 bytes");
    }
    this.cursorSecret = Buffer.from(cursorSecret);
    this.planLedger = planLedger;
    this.entries = new Map();
    this.expiredIds = new Map();
    this.totalBytes = 0;
  }

  seal({
    kind,
    schemaVersion = "1",
    sessionId,
    sourceEpoch,
    payload,
    leaseMs = this.quotas.defaultLeaseMs,
    metadata = {},
  }) {
    if (typeof kind !== "string" || !kind) {
      throw codedError("INVALID_ARGUMENTS", "artifact.kind must be a non-empty string");
    }
    if (typeof schemaVersion !== "string" || !schemaVersion) {
      throw codedError("INVALID_ARGUMENTS", "artifact.schemaVersion must be a non-empty string");
    }
    if (typeof sessionId !== "string" || !sessionId) {
      throw codedError("INVALID_ARGUMENTS", "artifact.sessionId must be a non-empty string");
    }
    if (payload === undefined) {
      throw codedError("INVALID_ARGUMENTS", "artifact.payload must be defined");
    }

    if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
      throw codedError("INVALID_ARGUMENTS", "artifact.leaseMs must be a positive safe integer");
    }
    const clampedLeaseMs = Math.min(leaseMs, this.quotas.maxLeaseMs);
    const createdAt = this.now();
    const expiresAt = createdAt + clampedLeaseMs;
    const id = `a_${randomUUID()}`;

    const immutablePayload = deepFreeze(canonicalClone(payload));
    const payloadText = JSON.stringify(immutablePayload);
    const bytes = Buffer.byteLength(payloadText, "utf8");

    if (bytes > this.quotas.maxArtifactBytes) {
      throw codedError(
        "ARTIFACT_CAPACITY_EXCEEDED",
        `artifact payload ${bytes} bytes exceeds max ${this.quotas.maxArtifactBytes}`
      );
    }

    this._prune();

    if (this.totalBytes + bytes > this.quotas.maxTotalBytes) {
      throw codedError(
        "ARTIFACT_CAPACITY_EXCEEDED",
        `total artifact bytes would exceed ${this.quotas.maxTotalBytes}`
      );
    }

    if (this.entries.size >= this.quotas.maxEntries) {
      throw codedError(
        "ARTIFACT_CAPACITY_EXCEEDED",
        `active artifact count would exceed ${this.quotas.maxEntries}; release an artifact or wait for expiry`
      );
    }

    const artifact = deepFreeze({
      id,
      kind,
      schemaVersion,
      contentHash: contentHash(immutablePayload),
      sessionId,
      sourceEpoch,
      payload: immutablePayload,
      metadata: canonicalClone(metadata),
      createdAt: new Date(createdAt).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
      remainingLeaseSeconds: Math.max(0, Math.floor((expiresAt - createdAt) / 1000)),
      entryCount: 1,
      totalBytes: bytes,
    });

    this.entries.set(id, artifact);
    this.totalBytes += bytes;
    // 只有 plan 需要执行态：其余 artifact（analysis/detail）是纯只读证据，重复读取
    // 没有副作用，登记它们只会浪费 ledger 配额。
    if (kind === "plan" && this.planLedger) {
      this.planLedger.register(id, { ownerInstanceId: sessionId ?? null });
    }

    return artifact;
  }

  resolve({ artifactId, expectedKind, expectedContentHash, sessionId }) {
    const artifact = this._getActive(artifactId, sessionId);

    if (expectedKind !== undefined && artifact.kind !== expectedKind) {
      throw codedError("ARTIFACT_KIND_MISMATCH", `expected kind ${expectedKind}, got ${artifact.kind}`);
    }
    if (expectedContentHash !== undefined && artifact.contentHash !== expectedContentHash) {
      throw codedError(
        "ARTIFACT_HASH_MISMATCH",
        `expected contentHash ${expectedContentHash}, got ${artifact.contentHash}`
      );
    }

    return artifact;
  }

  readPage({
    artifactId,
    expectedContentHash,
    sessionId,
    cursor = "start",
    view = "canonical-json",
    byteBudget = DEFAULT_ARTIFACT_PAGE_BYTES,
  }) {
    if (!Number.isSafeInteger(byteBudget) || byteBudget < 4 || byteBudget > 1024 * 1024) {
      throw codedError(
        "INVALID_ARGUMENTS",
        "artifact byteBudget must be an integer between 4 and 1048576"
      );
    }
    const artifact = this.resolve({
      artifactId,
      expectedContentHash,
      sessionId,
    });
    const payloadBytes = Buffer.from(JSON.stringify(artifact.payload), "utf8");
    const totalBytes = payloadBytes.length;
    const offset =
      cursor === "start"
        ? 0
        : this._decodeCursor(cursor, {
            artifactId,
            contentHash: artifact.contentHash,
            view,
          });
    if (offset < 0 || offset >= totalBytes) {
      throw codedError("ARTIFACT_CURSOR_OUT_OF_BOUNDS", "artifact cursor out of bounds");
    }

    let nextOffset = Math.min(offset + byteBudget, totalBytes);
    if (nextOffset < totalBytes) {
      while (nextOffset > offset && isUtf8ContinuationByte(payloadBytes[nextOffset])) {
        nextOffset -= 1;
      }
      if (nextOffset === offset) {
        throw codedError(
          "ARTIFACT_PAGE_BUDGET_TOO_SMALL",
          "artifact byteBudget cannot fit the next UTF-8 code point"
        );
      }
    }
    const chunk = payloadBytes.subarray(offset, nextOffset).toString("utf8");
    const hasMore = nextOffset < totalBytes;

    return {
      artifact,
      page: {
        data: chunk,
        encoding: "json-utf8-fragment",
        contentHash: artifact.contentHash,
        cursor: hasMore
          ? this._encodeCursor({
              artifactId,
              contentHash: artifact.contentHash,
              view,
              offset: nextOffset,
            })
          : null,
        hasMore,
        bytesReturned: nextOffset - offset,
        totalBytes,
      },
    };
  }

  release({ artifactId, sessionId }) {
    const artifact = this.entries.get(artifactId);
    if (!artifact) return false;
    if (artifact.sessionId !== sessionId) {
      throw codedError("ARTIFACT_SESSION_MISMATCH", "artifact belongs to a different session");
    }
    this._delete(artifactId);
    return true;
  }

  _getActive(artifactId, sessionId) {
    const artifact = this.entries.get(artifactId);
    if (!artifact) {
      if (this.expiredIds.has(artifactId)) {
        throw codedError("ARTIFACT_EXPIRED", `artifact expired: ${artifactId}`);
      }
      throw codedError("ARTIFACT_NOT_FOUND", `artifact not found: ${artifactId}`);
    }
    if (new Date(artifact.expiresAt).getTime() <= this.now()) {
      this._expire(artifactId);
      throw codedError("ARTIFACT_EXPIRED", `artifact expired: ${artifactId}`);
    }
    if (artifact.sessionId !== sessionId) {
      throw codedError("ARTIFACT_SESSION_MISMATCH", "artifact belongs to a different session");
    }
    return artifact;
  }

  _prune() {
    const now = this.now();
    for (const [id, artifact] of this.entries) {
      if (new Date(artifact.expiresAt).getTime() <= now) {
        this._expire(id);
      }
    }
    const tombstoneCutoff = now - this.quotas.maxLeaseMs;
    for (const [id, expiredAt] of this.expiredIds) {
      if (expiredAt <= tombstoneCutoff) this.expiredIds.delete(id);
    }
  }

  _delete(id) {
    const artifact = this.entries.get(id);
    if (!artifact) return false;
    this.totalBytes -= artifact.totalBytes;
    this.entries.delete(id);
    return true;
  }

  _expire(id) {
    if (!this._delete(id)) return false;
    this.expiredIds.set(id, this.now());
    while (this.expiredIds.size > this.quotas.maxEntries * 2) {
      this.expiredIds.delete(this.expiredIds.keys().next().value);
    }
    return true;
  }

  _encodeCursor(payload) {
    const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = createHmac("sha256", this.cursorSecret).update(body).digest("base64url");
    return `${body}.${signature}`;
  }

  _decodeCursor(cursor, expected) {
    if (typeof cursor !== "string" || !cursor.includes(".")) {
      throw codedError("ARTIFACT_CURSOR_INVALID", "artifact cursor is malformed");
    }
    const [body, signature, ...extra] = cursor.split(".");
    if (!body || !signature || extra.length > 0) {
      throw codedError("ARTIFACT_CURSOR_INVALID", "artifact cursor is malformed");
    }
    const expectedSignature = createHmac("sha256", this.cursorSecret).update(body).digest();
    let providedSignature;
    try {
      providedSignature = Buffer.from(signature, "base64url");
    } catch {
      throw codedError("ARTIFACT_CURSOR_INVALID", "artifact cursor signature is malformed");
    }
    if (
      providedSignature.length !== expectedSignature.length ||
      !timingSafeEqual(providedSignature, expectedSignature)
    ) {
      throw codedError("ARTIFACT_CURSOR_INVALID", "artifact cursor signature is invalid");
    }
    let decoded;
    try {
      decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      throw codedError("ARTIFACT_CURSOR_INVALID", "artifact cursor payload is malformed");
    }
    if (
      decoded?.artifactId !== expected.artifactId ||
      decoded?.contentHash !== expected.contentHash ||
      decoded?.view !== expected.view ||
      !Number.isSafeInteger(decoded?.offset)
    ) {
      throw codedError("ARTIFACT_CURSOR_INVALID", "artifact cursor does not match this view");
    }
    return decoded.offset;
  }
}

function validateQuotas(quotas) {
  for (const [name, value] of Object.entries(quotas)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`artifact quota ${name} must be a positive safe integer`);
    }
  }
  if (quotas.defaultLeaseMs > quotas.maxLeaseMs) {
    throw new TypeError("artifact defaultLeaseMs cannot exceed maxLeaseMs");
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function isUtf8ContinuationByte(value) {
  return (value & 0xc0) === 0x80;
}

function codedError(code, message) {
  const error = new Error(`[${code}] ${message}`);
  error.code = code;
  return error;
}
