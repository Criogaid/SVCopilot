import assert from "node:assert/strict";
import test from "node:test";

import {
  ITERATIONS,
  PLANNED_BASELINE,
  REQUIRED_NOTES,
  WARMUP,
  evaluateGates,
  percentiles,
  spread,
} from "../tools/bench-live-bulk-reads.mjs";

// 真机性能门禁的判定逻辑必须离线可测。
//
// 理由：那份报告是 Phase 1 唯一的发布证据，而我无法自己跑真机。如果判定逻辑本身有 bug，
// 一份写着 PASS 的报告比没有报告更危险——它会让"发布条件已满足"这句话有了看似客观的
// 出处。所以判定是纯函数，这里用构造的 scenario 覆盖每条门禁的通过与失败两侧。
//
// 这些测试不连接宿主，也不产生真机证据。它们只证明：真机数据一旦到手，判定是对的。

function arm({
  hostCalls = 27,
  wallP50 = 100,
  wallP95 = 120,
  serviceP50 = 95,
  serviceP95 = 115,
  status = "dry_run",
  effects = "none",
  bulkReads = { bulkHostCalls: 2, bulkNotes: 7, bulkFields: 8, fallbackUsed: false, fallbackReason: null },
} = {}) {
  return {
    hostCalls,
    status,
    effects,
    bulkReads,
    wallMs: { p50: wallP50, p95: wallP95, samples: ITERATIONS },
    serviceTotalMs: { p50: serviceP50, p95: serviceP95, samples: ITERATIONS },
    fingerprintVerificationMs: { p50: 10, p95: 12, samples: ITERATIONS },
  };
}

// 一份"理应通过"的完整报告：四个场景，bulk 更快且 host-call 大幅下降。
function passingScenarios(overrides = {}) {
  return ["A", "B", "C", "D"].map((id) => ({
    id,
    label: id,
    targetNotes: 7,
    legacy: arm({ hostCalls: 86, wallP50: 180, wallP95: 210, serviceP50: 175, serviceP95: 205, bulkReads: null }),
    bulk: arm(),
    hostCallReduction: 59,
    ...(overrides[id] ?? {}),
  }));
}

function gate(result, id) {
  const found = result.gates.find((entry) => entry.id === id);
  assert.ok(found, `gate ${id} must exist`);
  return found;
}

test("the plan's fixed acceptance parameters are not weakened", () => {
  // 可调的门禁不是门禁。这些数字来自计划 §7 Phase 1 与 §5.3，不该被"临时放宽"。
  assert.equal(REQUIRED_NOTES, 373);
  assert.equal(ITERATIONS, 20);
  assert.equal(WARMUP, 3);
  assert.equal(PLANNED_BASELINE.hostCalls, 86);
  assert.equal(PLANNED_BASELINE.wallMs, 183);
  assert.equal(PLANNED_BASELINE.serviceTotalMs, 177);
});

test("a clean four-scenario run passes every gate", () => {
  const result = evaluateGates(passingScenarios());
  const failed = result.gates.filter((entry) => !entry.passed).map((entry) => entry.id);
  assert.deepEqual(failed, []);
  assert.equal(result.ok, true);
});

test("an empty run never passes", () => {
  // 最重要的一条：没有数据不等于通过。
  const result = evaluateGates([]);
  assert.equal(result.ok, false);
  assert.equal(gate(result, "ALL_SCENARIOS_MEASURED").passed, false);
  assert.equal(gate(result, "DRY_RUN_HAS_NO_EFFECTS").passed, false);
  assert.equal(gate(result, "BULK_PATH_EXERCISED").passed, false);
  assert.equal(gate(result, "B_HOST_CALLS_BELOW_BASELINE").passed, false);
});

test("a partial run never passes even if every measured scenario is good", () => {
  const partial = passingScenarios().filter((scenario) => scenario.id !== "D");
  const result = evaluateGates(partial);
  assert.equal(gate(result, "ALL_SCENARIOS_MEASURED").passed, false);
  assert.equal(result.ok, false);
});

test("host-call reduction must be substantial, not marginal", () => {
  // 86 → 84 是噪声，不是计划里的"显著低于"。
  const marginal = passingScenarios({ B: { bulk: arm({ hostCalls: 84 }) } });
  assert.equal(gate(evaluateGates(marginal), "B_HOST_CALLS_BELOW_BASELINE").passed, false);
  // 70% 阈值边界：60 通过，61 不通过。
  assert.equal(
    gate(evaluateGates(passingScenarios({ B: { bulk: arm({ hostCalls: 60 }) } })), "B_HOST_CALLS_BELOW_BASELINE").passed,
    true
  );
  assert.equal(
    gate(evaluateGates(passingScenarios({ B: { bulk: arm({ hostCalls: 61 }) } })), "B_HOST_CALLS_BELOW_BASELINE").passed,
    false
  );
});

test("a p95 regression fails even when p50 improves", () => {
  // 只看中位数会漏掉尾延迟恶化，而尾延迟正是 UI 冻结的来源。
  const regressed = passingScenarios({
    C: {
      legacy: arm({ hostCalls: 86, wallP50: 180, wallP95: 200, bulkReads: null }),
      bulk: arm({ wallP50: 90, wallP95: 300 }),
    },
  });
  const result = evaluateGates(regressed);
  assert.equal(gate(result, "NO_REGRESSION_C_wallMs_p50").passed, true);
  assert.equal(gate(result, "NO_REGRESSION_C_wallMs_p95").passed, false);
  assert.equal(result.ok, false);
});

test("a service-time regression is caught independently of wall time", () => {
  const regressed = passingScenarios({
    A: {
      legacy: arm({ hostCalls: 86, serviceP50: 100, serviceP95: 110, bulkReads: null }),
      bulk: arm({ serviceP50: 140, serviceP95: 150 }),
    },
  });
  const result = evaluateGates(regressed);
  assert.equal(gate(result, "NO_REGRESSION_A_serviceTotalMs_p50").passed, false);
  assert.equal(result.ok, false);
});

test("the 5% noise band tolerates jitter but not a real slowdown", () => {
  const withinBand = passingScenarios({
    A: { legacy: arm({ hostCalls: 86, wallP50: 100, bulkReads: null }), bulk: arm({ wallP50: 105 }) },
  });
  assert.equal(gate(evaluateGates(withinBand), "NO_REGRESSION_A_wallMs_p50").passed, true);
  const outsideBand = passingScenarios({
    A: { legacy: arm({ hostCalls: 86, wallP50: 100, bulkReads: null }), bulk: arm({ wallP50: 106 }) },
  });
  assert.equal(gate(evaluateGates(outsideBand), "NO_REGRESSION_A_wallMs_p50").passed, false);
});

test("a silent fallback to per-getter reads fails the run", () => {
  // 这是最隐蔽的假 PASS：两侧都走 legacy 路径，于是"没有回归"，
  // 但报告实际上没有测到批量读取。
  const fellBack = passingScenarios({
    B: {
      bulk: arm({
        bulkReads: { bulkHostCalls: 0, bulkNotes: 0, bulkFields: 0, fallbackUsed: true, fallbackReason: "HOST_CAPABILITY_ABSENT" },
      }),
    },
  });
  const result = evaluateGates(fellBack);
  assert.equal(gate(result, "BULK_PATH_EXERCISED").passed, false);
  assert.equal(result.ok, false);
});

test("zero bulk host calls fails even when fallbackUsed is false", () => {
  const noBulkCalls = passingScenarios({
    C: {
      bulk: arm({
        bulkReads: { bulkHostCalls: 0, bulkNotes: 0, bulkFields: 0, fallbackUsed: false, fallbackReason: null },
      }),
    },
  });
  assert.equal(gate(evaluateGates(noBulkCalls), "BULK_PATH_EXERCISED").passed, false);
});

test("anything other than a clean dry run fails", () => {
  for (const mutated of [
    { status: "succeeded", effects: "none" },
    { status: "dry_run", effects: "wrote" },
  ]) {
    const scenarios = passingScenarios({ A: { bulk: arm(mutated) } });
    const result = evaluateGates(scenarios);
    assert.equal(
      gate(result, "DRY_RUN_HAS_NO_EFFECTS").passed,
      false,
      `status=${mutated.status} effects=${mutated.effects} must fail the read-only gate`
    );
    assert.equal(result.ok, false);
  }
});

test("percentiles report sample counts and handle an empty series", () => {
  const values = Array.from({ length: 20 }, (_, index) => index + 1);
  const result = percentiles(values);
  assert.equal(result.samples, 20);
  assert.equal(result.p50, 10);
  assert.equal(result.p95, 19);
  // 空序列返回 null，而不是 0：0 ms 会被读成"快得惊人"。
  assert.deepEqual(percentiles([]), { p50: null, p95: null, samples: 0 });
});

test("scattered indices span the whole group and stay in range", () => {
  const indices = spread(373, 7);
  assert.equal(indices.length, 7);
  assert.equal(indices[0], 0);
  assert.ok(indices.at(-1) <= 372);
  assert.ok(indices.at(-1) >= 370, "the last index must be near the end of the group");
  assert.deepEqual([...new Set(indices)], indices, "indices must be unique");
  for (const index of indices) assert.ok(index >= 0 && index < 373);
});
