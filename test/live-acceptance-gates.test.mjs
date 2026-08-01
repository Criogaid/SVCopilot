import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTOMATED_STEP_IDS,
  FACADES,
  applyGates,
  report,
} from "../tools/live-acceptance-walkthrough.mjs";

// §15 走查脚本的门禁判定必须离线可测——理由与 live-bulk-perf-gates 完全相同：
// 那份报告是验收的唯一书面证据，而判定逻辑本身有 bug 时，一份写着 PASS 的报告
// 比没有报告更危险。它会让"验收已通过"这句话有了看似客观的出处。
//
// 这些测试不连接宿主，也不产生验收证据。它们只证明：真机数据一旦到手，判定是对的。

function resetReport() {
  report.steps.length = 0;
  report.humanGates.length = 0;
  report.gates.length = 0;
  report.notes.length = 0;
  report.ok = false;
  delete report.acceptanceComplete;
  delete report.acceptanceNote;
}

function completeRun({ failStep = null, skipStep = null } = {}) {
  resetReport();
  for (const id of AUTOMATED_STEP_IDS) {
    const passed = id === skipStep ? null : id !== failStep;
    report.steps.push({ id, label: `step ${id}`, passed });
  }
  report.humanGates.push({ id: "H-UNDO", question: "?", answer: "pending_human" });
}

function gateById(id) {
  return report.gates.find((gate) => gate.id === id);
}

test("the automated step list covers every §15 step a script can decide", () => {
  // §15 有 19 步。16/17/18 是时间与配额观察，只能人工执行，因此不在自动列表里；
  // 4 与 20+ 不存在（4 是"记录第 3 步的字节数"，并入 step 3）。
  // 这条断言存在的理由：先前的列表只有 10 个编号，漏掉的步骤在报告里看不出来。
  assert.deepEqual(AUTOMATED_STEP_IDS, [1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 19]);
  assert.equal(AUTOMATED_STEP_IDS.length, 15);
  // 人工步骤必须落在 human gate 上，不能靠"自动列表里没有"来隐式豁免。
  for (const manualOnly of [16, 17, 18]) {
    assert.equal(AUTOMATED_STEP_IDS.includes(manualOnly), false);
  }
});

test("the facade list matches the served surface count", () => {
  // 第 15 步要求"每个 facade"都触发一次有界错误，因此这份清单必须是全量。
  assert.equal(FACADES.length, 8);
  assert.equal(new Set(FACADES).size, 8);
});

test("a complete automated run passes every gate", () => {
  completeRun();
  applyGates();
  assert.equal(gateById("ALL_AUTOMATED_STEPS_RAN").passed, true);
  assert.equal(gateById("ALL_AUTOMATED_STEPS_PASSED").passed, true);
  assert.equal(gateById("NO_SKIPPED_STEPS").passed, true);
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
  completeRun({ failStep: 10 });
  applyGates();
  assert.equal(gateById("ALL_AUTOMATED_STEPS_PASSED").passed, false);
  assert.deepEqual(gateById("ALL_AUTOMATED_STEPS_PASSED").observed, [10]);
  assert.equal(report.ok, false);
});

test("a skipped step fails the run instead of being read as a pass", () => {
  // harmony 缺第二个人声组时 step 8 记 null。那是"没测"，绝不能读成"通过"——
  // 这正是 §15.8 要求四个 planner 全跑的原因。
  completeRun({ skipStep: 8 });
  applyGates();
  assert.equal(gateById("ALL_AUTOMATED_STEPS_PASSED").passed, true);
  assert.equal(gateById("NO_SKIPPED_STEPS").passed, false);
  assert.deepEqual(gateById("NO_SKIPPED_STEPS").observed, [8]);
  assert.equal(report.ok, false);
});

test("an empty run is not a passing run", () => {
  // 脚本在连接失败时也会写报告；那份报告绝不能读成 PASS。
  resetReport();
  applyGates();
  assert.equal(report.ok, false);
  assert.equal(gateById("ALL_AUTOMATED_STEPS_RAN").passed, false);
  assert.equal(gateById("ALL_AUTOMATED_STEPS_PASSED").passed, false);
  assert.equal(gateById("HUMAN_GATES_RECORDED").passed, false);
});

test("automated gates passing still does not mark acceptance complete", () => {
  // 最重要的一条：脚本能自动化的是 §15 的一部分。听感、UI 观察、时间/配额观察
  // 和独立 LLM 会话都不在其中，因此 report.ok 为 true 时 acceptanceComplete
  // 仍必须是 false。否则一次绿色的脚本运行会被当成整章验收通过。
  completeRun();
  applyGates();
  assert.equal(report.ok, true);
  assert.equal(report.acceptanceComplete, false);
  assert.match(report.acceptanceNote, /humanGate/);
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
