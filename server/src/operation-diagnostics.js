export function createOperationDiagnostics({ enabled, now = () => Date.now() } = {}) {
  if (!enabled) return null;

  const serviceStartedAt = now();
  let coordinatorRequestedAt = null;
  let coordinatorAcquiredAt = null;
  const timings = {
    dispatcherQueueMs: null,
    validationMs: 0,
    coordinatorQueueMs: 0,
    contextRestoreMs: 0,
    targetResolutionMs: 0,
    fingerprintVerificationMs: 0,
    preflightReadMs: 0,
    planningMs: 0,
    writeMs: 0,
    verificationMs: 0,
    rollbackMs: 0,
    processingMs: 0,
    operationMs: 0,
    serviceTotalMs: 0,
  };
  const hostCalls = new Map();
  // 批量读取计数由解析层上报：只记录数量与回退原因，绝不记录歌词或音素内容。
  let bulk = null;

  function measureSync(name, action) {
    const startedAt = now();
    try {
      return action();
    } finally {
      timings[name] = (timings[name] ?? 0) + elapsed(startedAt, now());
    }
  }

  async function measure(name, action) {
    const startedAt = now();
    try {
      return await action();
    } finally {
      timings[name] = (timings[name] ?? 0) + elapsed(startedAt, now());
    }
  }

  async function recordHostCall(key, action) {
    const startedAt = now();
    let failed = false;
    try {
      return await action();
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      const durationMs = elapsed(startedAt, now());
      const entry = hostCalls.get(key) ?? { count: 0, failed: 0, totalMs: 0 };
      entry.count += 1;
      entry.totalMs += durationMs;
      if (failed) entry.failed += 1;
      hostCalls.set(key, entry);
    }
  }

  return {
    measure,
    measureSync,
    recordBulkStats(stats) {
      if (!stats) return;
      bulk = {
        bulkHostCalls: stats.bulkHostCalls,
        bulkNotes: stats.bulkNotes,
        bulkFields: stats.bulkFields,
        fallbackUsed: stats.fallbackUsed,
        fallbackReason: stats.fallbackReason,
      };
    },
    markValidationComplete() {
      timings.validationMs = elapsed(serviceStartedAt, now());
    },
    markCoordinatorRequested() {
      if (coordinatorRequestedAt === null) coordinatorRequestedAt = now();
    },
    markCoordinatorAcquired() {
      if (coordinatorRequestedAt === null) this.markCoordinatorRequested();
      coordinatorAcquiredAt = now();
      timings.coordinatorQueueMs = elapsed(coordinatorRequestedAt, coordinatorAcquiredAt);
    },
    instrumentHost(host) {
      return Object.freeze({
        roots: () => recordHostCall("$roots", () => host.roots()),
        call: (request) =>
          recordHostCall(
            typeof request?.method === "string" ? request.method : "$call",
            () => host.call(request)
          ),
        index: (request) =>
          recordHostCall(
            typeof request?.field === "string" ? `$index:${request.field}` : "$index",
            () => host.index(request)
          ),
        free: (handle) => recordHostCall("$free", () => host.free(handle)),
        ping: () => recordHostCall("$ping", () => host.ping()),
        // internal op 按 opcode 单独计数，便于与逐 getter 的 host-call 数直接对照。
        supportsOp: (op) => host.supportsOp?.(op) === true,
        bulk: (command) =>
          recordHostCall(
            typeof command?.op === "string" ? `$bulk:${command.op}` : "$bulk",
            () => host.bulk(command)
          ),
        status: () => host.status(),
        epoch: () => host.epoch(),
        handleType: (handle) => host.handleType(handle),
      });
    },
    finish() {
      const finishedAt = now();
      timings.operationMs =
        coordinatorAcquiredAt === null ? 0 : elapsed(coordinatorAcquiredAt, finishedAt);
      timings.serviceTotalMs = elapsed(serviceStartedAt, finishedAt);
      const byMethod = Object.fromEntries(
        [...hostCalls.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([method, entry]) => [method, { ...entry }])
      );
      return {
        timings: { ...timings },
        hostCalls: {
          total: [...hostCalls.values()].reduce((sum, entry) => sum + entry.count, 0),
          totalMs: [...hostCalls.values()].reduce((sum, entry) => sum + entry.totalMs, 0),
          byMethod,
        },
        ...(bulk ? { bulkReads: { ...bulk } } : {}),
      };
    },
  };
}

export async function measureDiagnosticPhase(diagnostics, name, action) {
  return diagnostics ? diagnostics.measure(name, action) : action();
}

function elapsed(startedAt, finishedAt) {
  return Math.max(0, finishedAt - startedAt);
}
