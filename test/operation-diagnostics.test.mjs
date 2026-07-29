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
