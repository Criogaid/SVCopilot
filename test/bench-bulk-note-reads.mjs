// Phase 1 有界批量读取的离线基准。
//
// 用途：给 host-call 数与契约行为提供可重复的离线对照，覆盖计划中的 A/B/C/D 四组场景。
// 边界：这是模拟宿主。它不产出真机毫秒数，也不能替代 SynthV 实机验收——
// 计划要求的 wall/service p50/p95 必须来自 373-note 实机 Group。
import { pathToFileURL } from "node:url";

import { createBenchFixture } from "./helpers/bulk-bench-host.mjs";

const NOTE_COUNT = 373;

const SCENARIOS = [
  { id: "A", label: "1 scoped patch", indices: [0] },
  { id: "B", label: "first 7", indices: [0, 1, 2, 3, 4, 5, 6] },
  { id: "C", label: "7 scattered", indices: [0, 62, 124, 186, 248, 310, 372] },
  {
    id: "D",
    label: "200 dry-run",
    indices: Array.from({ length: 200 }, (_, index) => index),
  },
];

async function runScenario({ indices }, { bulk }) {
  const fixture = createBenchFixture({ noteCount: NOTE_COUNT, bulk });
  const startedAt = process.hrtime.bigint();
  const result = await fixture.service.patchNotes({
    contextId: fixture.contextId,
    occurrenceId: fixture.occurrenceId,
    patches: indices.map((index) => ({ note: index, set: { lyrics: `b${index}` } })),
    dryRun: true,
    waitFor: "none",
    diagnostics: true,
  });
  const wallMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

  return {
    wallMs,
    serviceTotalMs: result.diagnostics.timings.serviceTotalMs,
    hostCalls: result.diagnostics.hostCalls.total,
    bulkOps: fixture.counters.bulkOps,
    getterCalls: fixture.counters.getterCalls,
    setterCalls: fixture.counters.setterCalls,
    undoRecords: fixture.counters.undoRecords,
    status: result.status,
    effects: result.effects,
    plannedChangedNotes: result.data.plannedChangedNotes,
    bulkReads: result.diagnostics.bulkReads,
  };
}

export async function runBulkBenchmark({ iterations = 20, warmup = 3 } = {}) {
  const scenarios = [];
  for (const scenario of SCENARIOS) {
    const modes = {};
    for (const mode of ["legacy", "bulk"]) {
      const bulk = mode === "bulk";
      for (let i = 0; i < warmup; i += 1) await runScenario(scenario, { bulk });
      const runs = [];
      for (let i = 0; i < iterations; i += 1) runs.push(await runScenario(scenario, { bulk }));
      const last = runs.at(-1);
      modes[mode] = {
        // host-call / setter / Undo 计数在同一场景下是确定值；毫秒数取分位。
        hostCalls: last.hostCalls,
        bulkOps: last.bulkOps,
        getterCalls: last.getterCalls,
        setterCalls: last.setterCalls,
        undoRecords: last.undoRecords,
        status: last.status,
        effects: last.effects,
        plannedChangedNotes: last.plannedChangedNotes,
        bulkReads: last.bulkReads,
        wallMs: percentiles(runs.map((run) => run.wallMs)),
        serviceTotalMs: percentiles(runs.map((run) => run.serviceTotalMs)),
      };
    }
    scenarios.push({
      id: scenario.id,
      label: scenario.label,
      noteCount: scenario.indices.length,
      ...modes,
      hostCallReduction: modes.legacy.hostCalls - modes.bulk.hostCalls,
    });
  }

  return {
    fixture: { noteCount: NOTE_COUNT, kind: "simulated_host" },
    evidenceScope: "offline_simulated_host",
    iterations,
    warmup,
    scenarios,
  };
}

function percentiles(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
  };
}

function quantile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return round(sorted[Math.max(0, index)]);
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

// 直接运行时打印报告；被 import 时不得有副作用（process.argv[1] 可能不存在）。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runBulkBenchmark();
  console.log(JSON.stringify(report, null, 2));
}
