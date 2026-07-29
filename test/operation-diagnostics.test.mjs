import assert from "node:assert/strict";
import test from "node:test";

import { createOperationDiagnostics } from "../server/src/operation-diagnostics.js";

test("operation diagnostics separate queue, phases, and host method aggregates", async () => {
  let clock = 0;
  const diagnostics = createOperationDiagnostics({ enabled: true, now: () => clock });
  clock = 2;
  diagnostics.markValidationComplete();
  diagnostics.markCoordinatorRequested();
  clock = 5;
  diagnostics.markCoordinatorAcquired();

  const host = diagnostics.instrumentHost({
    roots: async () => ({}),
    call: async () => {
      clock += 7;
      return "secret-result";
    },
    index: async () => null,
    free: async () => {},
    ping: async () => true,
    status: () => ({}),
    epoch: () => 1,
    handleType: () => "Note",
  });
  await diagnostics.measure("targetResolutionMs", async () => {
    clock += 4;
  });
  await host.call({
    handle: { __handle__: 1 },
    method: "getLyrics",
    args: ["secret-argument"],
  });
  clock += 1;

  const result = diagnostics.finish();
  assert.equal(result.timings.validationMs, 2);
  assert.equal(result.timings.coordinatorQueueMs, 3);
  assert.equal(result.timings.targetResolutionMs, 4);
  assert.equal(result.timings.serviceTotalMs, 17);
  assert.deepEqual(result.hostCalls.byMethod, {
    getLyrics: { count: 1, failed: 0, totalMs: 7 },
  });
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("operation diagnostics are allocation-free when disabled", () => {
  assert.equal(createOperationDiagnostics({ enabled: false }), null);
});

test("bulk read counters appear only when a resolver reported them", async () => {
  const withoutBulk = createOperationDiagnostics({ enabled: true, now: () => 0 });
  assert.equal("bulkReads" in withoutBulk.finish(), false);

  const diagnostics = createOperationDiagnostics({ enabled: true, now: () => 0 });
  diagnostics.recordBulkStats({
    bulkHostCalls: 2,
    bulkNotes: 200,
    bulkFields: 8,
    fallbackUsed: false,
    fallbackReason: null,
  });
  const result = diagnostics.finish();
  assert.deepEqual(result.bulkReads, {
    bulkHostCalls: 2,
    bulkNotes: 200,
    bulkFields: 8,
    fallbackUsed: false,
    fallbackReason: null,
  });
});

test("instrumented hosts keep capability negotiation and count bulk ops by opcode", async () => {
  let clock = 0;
  const diagnostics = createOperationDiagnostics({ enabled: true, now: () => clock });
  diagnostics.markCoordinatorAcquired();
  const host = diagnostics.instrumentHost({
    roots: async () => ({}),
    call: async () => null,
    index: async () => null,
    free: async () => {},
    ping: async () => true,
    status: () => ({}),
    epoch: () => 1,
    handleType: () => null,
    supportsOp: (op) => op === "read_note_fingerprints_v1",
    bulk: async () => {
      clock += 3;
      return { items: [], secretLyrics: "秘密" };
    },
  });

  // 诊断包装层丢掉 supportsOp 就会让批量路径在 diagnostics:true 下静默退化。
  assert.equal(host.supportsOp("read_note_fingerprints_v1"), true);
  assert.equal(host.supportsOp("other_op"), false);
  await host.bulk({ op: "read_note_fingerprints_v1" });

  const result = diagnostics.finish();
  assert.deepEqual(result.hostCalls.byMethod, {
    "$bulk:read_note_fingerprints_v1": { count: 1, failed: 0, totalMs: 3 },
  });
  assert.equal(JSON.stringify(result).includes("秘密"), false);
});
