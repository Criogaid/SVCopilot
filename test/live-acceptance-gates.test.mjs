import assert from "node:assert/strict";
import test from "node:test";

import { applyGates, report } from "../tools/live-acceptance-walkthrough.mjs";

// §15 走查脚本的门禁判定必须离线可测——理由与 live-bulk-perf-gates 完全相同：
// 那份报告是验收的唯一书面证据，而判定逻辑本身有 bug 时，一份写着 PASS 的报告
// 比没有报告更危险。它会让"验收已通过"这句话有了看似客观的出处。
//
// 这些测试不连接宿主，也不产生验收证据。它们只证明：真机数据一旦到手，判定是对的。

const AUTOMATED_STEP_IDS = [1, 2, 3, 5, 6, 8, 9, 10, 15, 19];

function resetReport() {
  report.steps.length = 0;
  report.humanGates.length = 0;
  report.gates.length = 0;
  report.notes.length = 0;
  report.ok = false;
  delete report.acceptanceComplete;
  delete report.acceptanceNote;
}

function completeRun({ failStep = null } = {}) {
  resetReport();
  for (const id of AUTOMATED_STEP_IDS) {
    report.steps.push({ id, label: `step ${id}`, passed: id !== failStep });
  }
  report.humanGates.push({ id: "H1", question: "?", answer: "pending_human" });
}

function gateById(id) {
  return report.gates.find((gate) => gate.id === id);
}

test("a complete automated run passes every gate", () => {
  completeRun();
  applyGates();
  assert.equal(gateById("ALL_AUTOMATED_STEPS_RAN").passed, true);
  assert.equal(gateById("ALL_AUTOMATED_STEPS_PASSED").passed, true);
  assert.equal(gateById("HUMAN_GATES_RECORDED").passed, true);
  assert.equal(report.ok, true);
});

test("a missing step can never report PASS", () => {
  // 少跑一步的报告不是验收证据。这条门禁存在的唯一理由就是让"部分执行"无法
  // 伪装成"通过"。
  completeRun();
  report.steps.pop();
  applyGates();
  assert.equal(gateById("ALL_AUTOMATED_STEPS_RAN").passed, false);
  assert.deepEqual(gateById("ALL_AUTOMATED_STEPS_RAN").observed, [19]);
  assert.equal(report.ok, false);
});

test("one failing step fails the whole run and names itself", () => {
  completeRun({ failStep: 6 });
  applyGates();
  assert.equal(gateById("ALL_AUTOMATED_STEPS_PASSED").passed, false);
  assert.deepEqual(gateById("ALL_AUTOMATED_STEPS_PASSED").observed, [6]);
  assert.equal(report.ok, false);
});

test("an empty run is not a passing run", () => {
  // 脚本在连接失败时也会写报告；那份报告绝不能读成 PASS。
  resetReport();
  applyGates();
  assert.equal(report.ok, false);
  assert.equal(gateById("ALL_AUTOMATED_STEPS_RAN").passed, false);
  assert.equal(gateById("HUMAN_GATES_RECORDED").passed, false);
});

test("automated gates passing still does not mark acceptance complete", () => {
  // 最重要的一条：脚本能自动化的是 §15 的一部分。听感、UI 观察和独立 LLM 会话
  // 都不在其中，因此 report.ok 为 true 时 acceptanceComplete 仍必须是 false。
  // 否则一次绿色的脚本运行会被当成整章验收通过。
  completeRun();
  applyGates();
  assert.equal(report.ok, true);
  assert.equal(report.acceptanceComplete, false);
  assert.match(report.acceptanceNote, /humanGates/);
  assert.match(report.acceptanceNote, /independent-LLM/);
});

test("human gates are listed rather than silently assumed answered", () => {
  completeRun();
  applyGates();
  for (const gate of report.humanGates) {
    assert.equal(gate.answer, "pending_human");
    assert.equal(typeof gate.question, "string");
    assert.ok(gate.question.length > 0);
  }
});
