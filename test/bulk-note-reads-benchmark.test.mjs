// Phase 1 发布门禁的回归测试：把批量读取的 host-call 收敛和 dry-run 安全性
// 固定成断言，而不是只靠一次手工基准。
//
// 注意：模拟宿主只能证明调用次数与契约行为；计划要求的 wall/service p50/p95
// 仍必须来自 373-note 实机 Group。
import assert from "node:assert/strict";
import test from "node:test";

import { runBulkBenchmark } from "./bench-bulk-note-reads.mjs";
import { createBenchFixture } from "./helpers/bulk-bench-host.mjs";

test("bulk reads cut scoped preflight host calls without changing the plan", async () => {
  const report = await runBulkBenchmark({ iterations: 2, warmup: 1 });
  assert.equal(report.fixture.noteCount, 373);
  // 报告必须自己声明证据强度，避免离线数字被当成真机验收。
  assert.equal(report.evidenceScope, "offline_simulated_host");
  assert.deepEqual(
    report.scenarios.map((scenario) => scenario.id),
    ["A", "B", "C", "D"]
  );

  for (const scenario of report.scenarios) {
    // 契约不变：同一请求在新旧桥上得到同样的计划与状态。
    assert.equal(scenario.bulk.status, scenario.legacy.status, scenario.id);
    assert.equal(scenario.bulk.status, "dry_run", scenario.id);
    assert.equal(scenario.bulk.effects, "none", scenario.id);
    assert.equal(
      scenario.bulk.plannedChangedNotes,
      scenario.legacy.plannedChangedNotes,
      scenario.id
    );

    // dry-run 继续 0 setter、0 Undo —— 两条路径都必须成立。
    for (const mode of ["legacy", "bulk"]) {
      assert.equal(scenario[mode].setterCalls, 0, `${scenario.id}/${mode} setters`);
      assert.equal(scenario[mode].undoRecords, 0, `${scenario.id}/${mode} undo`);
    }

    // 批量路径不再逐字段 getter；host-call 数必须严格下降。
    assert.equal(scenario.bulk.getterCalls, 0, scenario.id);
    assert.ok(scenario.bulk.hostCalls < scenario.legacy.hostCalls, scenario.id);
    assert.ok(scenario.bulk.bulkOps >= 1, scenario.id);
    assert.equal(scenario.bulk.bulkReads.fallbackUsed, false, scenario.id);
    assert.equal(scenario.legacy.bulkReads.fallbackUsed, true, scenario.id);
  }

  // 计划的发布要求：B（前 7 个）的 host-call 数显著低于 86 的实机基线。
  const b = report.scenarios.find((scenario) => scenario.id === "B");
  assert.ok(b.bulk.hostCalls < 86 / 2, `B host calls ${b.bulk.hostCalls} must be well under 86`);
  assert.equal(b.bulk.bulkOps, 1);

  // 分散目标不应比连续目标更贵：批量按索引集合读取，不按区间扫描。
  const c = report.scenarios.find((scenario) => scenario.id === "C");
  assert.equal(c.bulk.hostCalls, b.bulk.hostCalls);
  assert.equal(c.bulk.bulkOps, 1);

  // 200 个目标必须被切成有界块，而不是一次超帧。
  const d = report.scenarios.find((scenario) => scenario.id === "D");
  assert.ok(d.bulk.bulkOps >= 2, "200 notes must be chunked");
  assert.equal(d.bulk.bulkReads.bulkNotes, 200);
});

test("a 373-note group resolves scoped targets without reading every note", async () => {
  const fixture = createBenchFixture({ noteCount: 373, bulk: true });
  const result = await fixture.service.patchNotes({
    contextId: fixture.contextId,
    occurrence: 0,
    patches: [
      { note: 0, set: { lyrics: "x" } },
      { note: 372, set: { lyrics: "y" } },
    ],
    dryRun: true,
    waitFor: "none",
    diagnostics: true,
  });

  assert.equal(result.status, "dry_run");
  assert.equal(result.diagnostics.bulkReads.bulkNotes, 2);
  assert.equal(result.diagnostics.bulkReads.bulkHostCalls, 1);
  // 作用域读取必须与 Group 规模无关：373 个音符里只碰 2 个。
  assert.ok(result.diagnostics.hostCalls.total < 40, `${result.diagnostics.hostCalls.total}`);
  assert.equal(fixture.counters.setterCalls, 0);
  assert.equal(fixture.counters.undoRecords, 0);
});
