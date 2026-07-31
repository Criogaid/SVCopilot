// Plan 执行 ledger 的回归（计划 §4.3.1）。
//
// 这个 ledger 存在的唯一理由是：重放一个已提交的 planRef 对某些 mutation 不是幂等的。
// 因此测试的重点不是"状态机能不能走通"，而是**每一条禁止重放的规则都真的拦得住**，
// 以及"允许重试"的那一格（零写入失败）没有被顺手一起封禁。
import assert from "node:assert/strict";
import test from "node:test";

import { PLAN_LEDGER_STATES, PlanExecutionLedger } from "../server/src/plan-ledger.js";

function ledger(start = 1000) {
  const state = { now: start };
  const instance = new PlanExecutionLedger({ now: () => state.now, ttlMs: 60_000 });
  return { instance, advance: (ms) => (state.now += ms) };
}

function codeOf(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    return error.code;
  }
}

test("the state machine is exactly the plan's six states", () => {
  assert.deepEqual([...PLAN_LEDGER_STATES], [
    "sealed",
    "dry_run_seen",
    "committing",
    "committed",
    "rolled_back",
    "uncertain",
  ]);
});

test("a sealed plan cannot be committed without a dry run first", () => {
  // §4.3.1 规则 2：把「先 dry-run 再 commit」从文档建议变成服务端强制约束。
  const { instance } = ledger();
  instance.register("a_plan1");
  assert.equal(codeOf(() => instance.beginCommit("a_plan1")), "PLAN_DRY_RUN_REQUIRED");
  assert.equal(instance.get("a_plan1").state, "sealed");
});

test("dry runs repeat freely and never advance to a terminal state", () => {
  // dry-run 零 setter、零 Undo，反复审阅同一个计划是正常用法。
  const { instance } = ledger();
  instance.register("a_plan2");
  for (let i = 0; i < 5; i += 1) instance.noteDryRun("a_plan2");
  const entry = instance.get("a_plan2");
  assert.equal(entry.state, "dry_run_seen");
  assert.equal(entry.dryRunCount, 5);
  assert.equal(entry.commitAttempts, 0);
});

test("a committed plan can never be committed again", () => {
  // 这是整个 ledger 的存在理由：mode:"add" 的曲线补丁在 fingerprint 未变时能再次
  // 通过 live preflight，于是把同一段 Automation 又叠加一遍。preflight 看不出问题，
  // 因为工程状态确实符合计划的前提——只有"已经执行过"这个事实能拦住它。
  const { instance } = ledger();
  instance.register("a_plan3");
  instance.noteDryRun("a_plan3");
  instance.beginCommit("a_plan3");
  instance.settle("a_plan3", "succeeded");
  assert.equal(instance.get("a_plan3").state, "committed");

  assert.equal(codeOf(() => instance.beginCommit("a_plan3")), "PLAN_ALREADY_EXECUTED");
  // 连 dry-run 都要拒绝：让调用方"预览"一个已生效的计划会暗示它还能提交。
  assert.equal(codeOf(() => instance.noteDryRun("a_plan3")), "PLAN_ALREADY_EXECUTED");
});

test("no_change also closes the plan", () => {
  // 同值写入零 setter，但计划已经"用过"了：它的前提是当时观测到的状态。
  const { instance } = ledger();
  instance.register("a_plan4");
  instance.noteDryRun("a_plan4");
  instance.beginCommit("a_plan4");
  instance.settle("a_plan4", "no_change");
  assert.equal(instance.get("a_plan4").state, "committed");
  assert.equal(codeOf(() => instance.beginCommit("a_plan4")), "PLAN_ALREADY_EXECUTED");
});

test("rolled_back requires re-planning rather than replaying the same payload", () => {
  // 补偿已读回验证成功，宿主回到原状——但 §4.5 规定正确动作是重新快照再规划。
  // 允许重放会把"补偿成功"读成"可以再试一次"。
  const { instance } = ledger();
  instance.register("a_plan5");
  instance.noteDryRun("a_plan5");
  instance.beginCommit("a_plan5");
  instance.settle("a_plan5", "rolled_back");
  assert.equal(instance.get("a_plan5").state, "rolled_back");
  assert.equal(codeOf(() => instance.beginCommit("a_plan5")), "PLAN_ALREADY_EXECUTED");
});

test("every unprovable outcome permanently bans the replay", () => {
  // rollback_failed / partial / outcome_unknown 都无法证明宿主的最终状态。
  // 重放会在一个未知状态之上再写一次——这正是 §4.5 标注"绝不自动重试"的三格。
  for (const status of ["rollback_failed", "partial", "outcome_unknown"]) {
    const { instance } = ledger();
    instance.register("a_x");
    instance.noteDryRun("a_x");
    instance.beginCommit("a_x");
    instance.settle("a_x", status);
    assert.equal(instance.get("a_x").state, "uncertain", `${status} must land on uncertain`);
    assert.equal(
      codeOf(() => instance.beginCommit("a_x")),
      "PLAN_ALREADY_EXECUTED",
      `${status} must ban replay`
    );
  }
});

test("a zero-write failure keeps the plan usable", () => {
  // failed/conflict 表示还没开始写就失败了（effects:"none"）。计划本身仍然成立，
  // 修正外部条件后可以再提交——把这一格也封禁会强迫模型无谓地重新规划。
  for (const status of ["failed", "conflict"]) {
    const { instance } = ledger();
    instance.register("a_y");
    instance.noteDryRun("a_y");
    instance.beginCommit("a_y");
    instance.settle("a_y", status);
    assert.equal(instance.get("a_y").state, "dry_run_seen", `${status} must not be terminal`);
    assert.doesNotThrow(() => instance.beginCommit("a_y"), `${status} must stay committable`);
  }
});

test("an in-flight commit blocks further commits until it settles", () => {
  // committing 是必需的中间态：宿主调用可能在返回前超时，那时既不能说已提交、
  // 也不能说未提交。并发的第二个 commit 必须被拒。
  const { instance } = ledger();
  instance.register("a_plan6");
  instance.noteDryRun("a_plan6");
  instance.beginCommit("a_plan6");
  assert.equal(instance.get("a_plan6").state, "committing");
  assert.equal(codeOf(() => instance.beginCommit("a_plan6")), "PLAN_ALREADY_EXECUTED");
});

test("a commit that never settles stays blocked rather than becoming replayable", () => {
  // 进程崩溃或 settle 漏调时，条目永久停在 committing。这是刻意的失败方向：
  // 宁可要求重新规划，也不在未知状态上重放写入。
  const { instance } = ledger();
  instance.register("a_plan7");
  instance.noteDryRun("a_plan7");
  instance.beginCommit("a_plan7");
  // 没有 settle。
  assert.equal(codeOf(() => instance.beginCommit("a_plan7")), "PLAN_ALREADY_EXECUTED");
  assert.equal(codeOf(() => instance.noteDryRun("a_plan7")), null, "dry-run 仍可用于查看计划");
});

test("settle rejects statuses that are not write conclusions", () => {
  const { instance } = ledger();
  instance.register("a_plan8");
  instance.noteDryRun("a_plan8");
  instance.beginCommit("a_plan8");
  // planned/dry_run 是规划期结论，不能用来结算一次写入。
  assert.equal(codeOf(() => instance.settle("a_plan8", "planned")), "INVALID_ARGUMENTS");
  assert.equal(codeOf(() => instance.settle("a_plan8", "dry_run")), "INVALID_ARGUMENTS");
});

test("an unknown or expired planRef cannot be committed", () => {
  // 找不到条目与"artifact 已过期"是同一个结论：无法证明这个计划没被执行过。
  const { instance, advance } = ledger();
  assert.equal(codeOf(() => instance.beginCommit("a_never")), "UNKNOWN_PLAN_REF");

  instance.register("a_plan9");
  instance.noteDryRun("a_plan9");
  advance(60_001);
  assert.equal(codeOf(() => instance.beginCommit("a_plan9")), "UNKNOWN_PLAN_REF");
});

test("a plan from another server instance is refused", () => {
  const { instance } = ledger();
  instance.register("a_plan10", { ownerInstanceId: "sess_a" });
  assert.equal(
    codeOf(() => instance.beginCommit("a_plan10", { ownerInstanceId: "sess_b" })),
    "PLAN_TARGET_MISMATCH"
  );
  assert.doesNotThrow(() => instance.noteDryRun("a_plan10", { ownerInstanceId: "sess_a" }));
});

test("registering the same planRef twice is an implementation bug", () => {
  // artifactId 是 96-bit 随机值；碰撞意味着调用方在复用 ID，而那会让两个计划
  // 共享一份执行状态。
  const { instance } = ledger();
  instance.register("a_plan11");
  assert.equal(codeOf(() => instance.register("a_plan11")), "PLAN_ALREADY_REGISTERED");
});

test("the ledger stays bounded and reports its state distribution", () => {
  const instance = new PlanExecutionLedger({ now: () => 1000, maxEntries: 4 });
  for (let i = 0; i < 20; i += 1) instance.register(`a_bulk${i}`);
  const stats = instance.stats();
  assert.ok(stats.entries <= 4, `ledger must stay bounded; got ${stats.entries}`);
  assert.equal(stats.maxEntries, 4);
  // 最新登记的必须还在：淘汰从最旧开始。
  assert.ok(instance.get("a_bulk19"));
  assert.equal(stats.byState.sealed, stats.entries);
});
