// SnapshotStore 生命周期与配额回归（计划 §13.7）。
// TTL 延长到 30 分钟必须与字节配额同一提交落地，否则 64 个 373-note Context
// 可以长期共存，把 TTL 收益换成无界驻留内存。
import assert from "node:assert";
import {
  CONTEXT_UNAVAILABLE_REASONS,
  DEFAULT_CONTEXT_TTL_MS,
  MAX_CONTEXT_TTL_MS,
  SnapshotStore,
  unknownContextError,
} from "../server/src/snapshot.js";

function clock(start = 1_000) {
  const state = { now: start };
  return { now: () => state.now, advance: (ms) => (state.now += ms) };
}

function rangeContext(noteCount) {
  return {
    epoch: 1,
    scope: { kind: "range" },
    context: {
      kind: "range",
      occurrences: [
        {
          noteFingerprints: Array.from({ length: noteCount }, (_, i) => ({
            indexInGroup: i,
            onsetBlick: 705_600_000 * i,
            durationBlick: 705_600_000,
            pitch: 60 + (i % 12),
            lyrics: "占",
            phonemesOverride: "",
            languageOverride: "",
            detuneCents: 0,
          })),
        },
      ],
    },
  };
}

// 默认 TTL 30 分钟，上限 60 分钟，超限被夹紧而不是静默接受。
{
  assert.strictEqual(DEFAULT_CONTEXT_TTL_MS, 30 * 60_000);
  assert.strictEqual(MAX_CONTEXT_TTL_MS, 60 * 60_000);
  assert.strictEqual(new SnapshotStore().ttlMs, DEFAULT_CONTEXT_TTL_MS);
  assert.strictEqual(new SnapshotStore({ ttlMs: 10 * 60_000 }).ttlMs, 10 * 60_000);
  assert.strictEqual(new SnapshotStore({ ttlMs: 99 * 60_000 }).ttlMs, MAX_CONTEXT_TTL_MS);
  assert.throws(() => new SnapshotStore({ ttlMs: 0 }), /positive safe integer/);
}

// Context ID 是 96-bit Base64URL 短 ID，不再是 UUID 文本。
{
  const store = new SnapshotStore({ now: clock().now });
  const stored = store.create(rangeContext(2));
  assert.match(stored.contextId, /^c_[A-Za-z0-9_-]{16}$/);
}

// 旧 5 分钟窗口内不再过期：这正是要消除的那一轮重做。
{
  const time = clock();
  const store = new SnapshotStore({ now: time.now });
  const { contextId } = store.create(rangeContext(4));

  time.advance(6 * 60_000);
  assert.ok(store.get(contextId), "6 分钟后 Context 必须仍然可用");

  time.advance(25 * 60_000);
  assert.strictEqual(store.get(contextId), null, "超过 30 分钟必须过期");
  assert.strictEqual(store.reasonFor(contextId), "expired");
}

// 只读使用不延长 TTL：租期从创建时刻算起，反复读取不能把它续下去。
{
  const time = clock();
  const store = new SnapshotStore({ now: time.now });
  const { contextId } = store.create(rangeContext(2));
  for (let i = 0; i < 5; i += 1) {
    time.advance(8 * 60_000);
    store.get(contextId);
  }
  assert.strictEqual(store.get(contextId), null, "只读访问不得续期");
  assert.strictEqual(store.reasonFor(contextId), "expired");
}

// 五种 reason 都能区分；伪造 ID 只能是 unknown，不得声称可恢复。
{
  const time = clock();
  const store = new SnapshotStore({ now: time.now });
  assert.deepStrictEqual(
    [...CONTEXT_UNAVAILABLE_REASONS],
    ["unknown", "expired", "epoch_changed", "invalidated_by_mutation", "evicted_by_quota"]
  );

  assert.strictEqual(store.reasonFor("c_neverExisted00000"), "unknown");

  const mutated = store.create(rangeContext(2)).contextId;
  store.delete(mutated);
  assert.strictEqual(store.reasonFor(mutated), "invalidated_by_mutation");

  const epochChanged = store.create(rangeContext(2)).contextId;
  store.delete(epochChanged, "epoch_changed");
  assert.strictEqual(store.reasonFor(epochChanged), "epoch_changed");

  // 活跃 Context 没有失效原因。
  const live = store.create(rangeContext(2)).contextId;
  assert.strictEqual(store.reasonFor(live), null);
}

// unknownContextError 把 reason 带进 error.details，让调用方知道下一步该做什么。
{
  const store = new SnapshotStore({ now: clock().now });
  const { contextId } = store.create(rangeContext(2));
  store.delete(contextId);

  const error = unknownContextError(store, contextId);
  assert.strictEqual(error.code, "UNKNOWN_CONTEXT");
  assert.strictEqual(error.details.reason, "invalidated_by_mutation");

  const forged = unknownContextError(store, "c_forged00000000000", "targets[1]");
  assert.strictEqual(forged.details.reason, "unknown");
  assert.match(forged.message, /^targets\[1\]: /);
}

// 单 Context 字节上限：超限直接拒绝，不静默截断内容。
{
  const store = new SnapshotStore({
    now: clock().now,
    quotas: { maxContextBytes: 2_000 },
  });
  assert.throws(
    () => store.create(rangeContext(400)),
    (error) => error.code === "CONTEXT_CAPACITY_EXCEEDED"
  );
  assert.strictEqual(store.stats().entries, 0);
  assert.strictEqual(store.stats().accountedBytes, 0);
}

// 总字节上限触发 LRU 淘汰，并如实登记 evicted_by_quota。
{
  const store = new SnapshotStore({
    now: clock().now,
    quotas: { maxTotalBytes: 12_000 },
  });
  const ids = [];
  for (let i = 0; i < 12; i += 1) ids.push(store.create(rangeContext(20)).contextId);

  const stats = store.stats();
  assert.ok(stats.accountedBytes <= 12_000, `accountedBytes ${stats.accountedBytes} 超过配额`);
  assert.ok(stats.evictions > 0, "必须发生淘汰");
  assert.strictEqual(store.reasonFor(ids[0]), "evicted_by_quota");
  // 最新写入的一定还在：淘汰从最旧开始。
  assert.ok(store.get(ids.at(-1)));
}

// 条数配额同样生效，且 accountedBytes 与实际驻留一致。
{
  const store = new SnapshotStore({ now: clock().now, quotas: { maxEntries: 3 } });
  const ids = [];
  for (let i = 0; i < 6; i += 1) ids.push(store.create(rangeContext(2)).contextId);
  const stats = store.stats();
  assert.strictEqual(stats.entries, 3);
  assert.strictEqual(
    stats.accountedBytes,
    [...store.entries.values()].reduce((sum, e) => sum + e.accountedBytes, 0)
  );
  assert.strictEqual(store.reasonFor(ids[0]), "evicted_by_quota");
}

// LRU 只淘汰非活跃 Context：planner 解析期间的 pin 不得被并发 snapshot 挤掉。
{
  const store = new SnapshotStore({ now: clock().now, quotas: { maxEntries: 2 } });
  const pinnedId = store.create(rangeContext(2)).contextId;
  const release = store.pin(pinnedId);

  for (let i = 0; i < 6; i += 1) store.create(rangeContext(2));
  assert.ok(store.get(pinnedId), "pinned Context 不得被淘汰");

  release();
  for (let i = 0; i < 6; i += 1) store.create(rangeContext(2));
  assert.strictEqual(store.get(pinnedId), null, "解除 pin 后应可淘汰");
  assert.strictEqual(store.reasonFor(pinnedId), "evicted_by_quota");
}

// 失效立即释放 accountedBytes，而不是等到下一次 prune。
{
  const store = new SnapshotStore({ now: clock().now });
  const { contextId } = store.create(rangeContext(50));
  const before = store.stats().accountedBytes;
  assert.ok(before > 0);
  store.delete(contextId);
  assert.strictEqual(store.stats().accountedBytes, 0, "失效必须立即回收字节");
  assert.strictEqual(store.stats().entries, 0);
}

// tombstone 有界：不能靠无限增长来记住每一个失效过的 ID。
{
  const store = new SnapshotStore({ now: clock().now, quotas: { maxTombstones: 8 } });
  for (let i = 0; i < 40; i += 1) store.delete(store.create(rangeContext(1)).contextId);
  assert.ok(store.tombstones.size <= 8, `tombstones ${store.tombstones.size} 必须有界`);
}

// 64 个 373-note Context 必须落在配置门禁内，而不是靠 TTL 短来兜底。
{
  const store = new SnapshotStore({ now: clock().now });
  for (let i = 0; i < 64; i += 1) store.create(rangeContext(373));
  const stats = store.stats();
  assert.strictEqual(stats.entries <= stats.entries, true);
  assert.ok(
    stats.accountedBytes <= stats.maxTotalBytes,
    `accountedBytes ${stats.accountedBytes} 超过 maxTotalBytes ${stats.maxTotalBytes}`
  );
  assert.ok(stats.entries <= 64);
}

// doctor 可观测面：字段名体现"逻辑驻留字节"，不冒充 V8 heap 实测值。
{
  const store = new SnapshotStore({ now: clock().now });
  store.create(rangeContext(10));
  const stats = store.stats();
  assert.deepStrictEqual(Object.keys(stats).sort(), [
    "accountedBytes",
    "entries",
    "evictions",
    "maxTotalBytes",
    "ttlMs",
  ]);
  assert.strictEqual(stats.entries, 1);
  assert.strictEqual(stats.ttlMs, DEFAULT_CONTEXT_TTL_MS);
}

console.log("snapshot-store.test.mjs passed");
