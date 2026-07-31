// status × effects × isError 冻结矩阵的回归（计划 §4.5 / §10.2.1）。
//
// 这个文件要挡住的不是"少写了一个 status 字符串"，而是「实现悄悄发明一个契约表达
// 不了的结论」。因此断言分两类：
//   1. 矩阵本身的完整性与相容规则（哪些组合合法、谁绝不可重放）；
//   2. 服务内部 status 必须显式登记投影，未登记时编码阶段就抛错——而不是安静地把
//      一个模型无法归类的字符串送到根 status 上。
import assert from "node:assert/strict";
import test from "node:test";

import { encodeToolResult } from "../server/src/mcp-result-encoder.js";
import {
  RESULT_STATUSES,
  RESULT_STATUS_MATRIX,
  assertStatusEnvelope,
  fillCanonicalEffects,
  forbidsAutomaticRetry,
  isErrorStatus,
  projectStatusEnvelope,
} from "../server/src/result-status.js";

test("the matrix is exactly the ten statuses the plan freezes", () => {
  assert.deepEqual([...RESULT_STATUSES].sort(), [
    "conflict",
    "dry_run",
    "failed",
    "no_change",
    "outcome_unknown",
    "partial",
    "planned",
    "rollback_failed",
    "rolled_back",
    "succeeded",
  ]);
  // partial 与 rollback_failed 是重点：它们在实现里真实存在，契约表达不了它们时
  // 实现就只能撒谎。
  assert.equal(isErrorStatus("partial"), true);
  assert.equal(isErrorStatus("rollback_failed"), true);
});

test("isError follows whether the requested operation completed", () => {
  for (const status of ["succeeded", "no_change", "planned", "dry_run"]) {
    assert.equal(isErrorStatus(status), false, `${status} completed`);
  }
  for (const status of [
    "conflict",
    "failed",
    "rolled_back",
    "rollback_failed",
    "partial",
    "outcome_unknown",
  ]) {
    assert.equal(isErrorStatus(status), true, `${status} did not complete`);
  }
  // conflict 与 rolled_back 也是 isError：isError 不影响 structuredContent 的传输，
  // 两种取值下客户端拿到的数据完全一样，所以该字段应当如实反映"没做成"。
  assert.equal(isErrorStatus("conflict"), true);
  assert.equal(isErrorStatus("rolled_back"), true);
});

test("only statuses that left nothing behind may be replayed automatically", () => {
  // 硬规则：effects:"none" 才允许原样重放。
  for (const [status, effects] of [
    ["partial", "may_remain"],
    ["rollback_failed", "may_remain"],
    ["outcome_unknown", "unknown"],
  ]) {
    assert.equal(forbidsAutomaticRetry(status), true, `${status} must never be replayed`);
    assert.throws(
      () => assertStatusEnvelope({ status, effects, retryable: true }),
      /must not be marked retryable/
    );
  }
  // rolled_back 补偿成功，但正确动作是重新快照再规划，不是重放同一 payload。
  assert.throws(
    () => assertStatusEnvelope({ status: "rolled_back", effects: "reverted", retryable: true }),
    /must not be marked retryable/
  );
  // conflict 允许"重新快照后再试"，但仍要求 effects:none。
  assert.doesNotThrow(() =>
    assertStatusEnvelope({ status: "conflict", effects: "none", retryable: true })
  );
});

test("effects must be one the status actually allows", () => {
  assert.doesNotThrow(() => assertStatusEnvelope({ status: "succeeded", effects: "verified" }));
  assert.throws(
    () => assertStatusEnvelope({ status: "succeeded", effects: "may_remain" }),
    /cannot pair with effects/
  );
  // rollback_failed 的两种 effects 都合法：只有服务自己知道是"可能有残留"还是
  // "无法观测"，因此两者都必须能表达。
  for (const effects of ["may_remain", "unknown"]) {
    assert.doesNotThrow(() => assertStatusEnvelope({ status: "rollback_failed", effects }));
  }
  assert.throws(() => assertStatusEnvelope({ status: "not_a_status" }), /not in the frozen matrix/);
});

test("effects is required whenever the status does not imply it", () => {
  // 这四个由 status 唯一确定，线上可省略（§10.2.1）。
  for (const status of ["succeeded", "no_change", "planned", "dry_run"]) {
    assert.doesNotThrow(() => assertStatusEnvelope({ status }));
  }
  // 其余六个必须显式说明宿主里还剩什么。
  for (const status of ["conflict", "failed", "rolled_back", "partial", "outcome_unknown"]) {
    assert.doesNotThrow(
      () => assertStatusEnvelope(fillCanonicalEffects({ status })),
      `${status} should be fillable`
    );
  }
  // rollback_failed 有两个候选，不能替服务挑一个——那就是编造证据。
  assert.deepEqual(fillCanonicalEffects({ status: "rollback_failed" }), {
    status: "rollback_failed",
  });
  assert.throws(
    () => assertStatusEnvelope({ status: "rollback_failed" }),
    /must carry effects/
  );
});

test("audition state-machine values project onto the matrix and survive in data.state", () => {
  // audition 的 playing/restored/... 是状态机取值，不是「操作是否完成」。
  for (const state of ["playing", "stopped", "stopped_by_user", "restored", "partially_restored"]) {
    const encoded = encodeToolResult({ status: state, data: { id: "u_x" } });
    assert.equal(encoded.structuredContent.status, "succeeded");
    assert.equal(encoded.structuredContent.effects, "verified");
    assert.equal(encoded.isError, undefined);
    // 取值不丢：它移到 data.state，那才是它的归属（§10.7 的 data 示例）。
    assert.equal(encoded.structuredContent.data.state, state);
  }
  // 恢复没能读回证明：mixer solo / 播放头可能仍是 audition 设置的值 -> partial。
  const failed = encodeToolResult({ status: "restore_failed", data: { id: "u_x" } });
  assert.equal(failed.structuredContent.status, "partial");
  assert.equal(failed.structuredContent.effects, "may_remain");
  assert.equal(failed.isError, true);
  assert.equal(failed.structuredContent.data.state, "restore_failed");
});

test("a service that already set data.state keeps its own value", () => {
  // 投影不得覆盖服务自己给出的状态机取值。
  const encoded = encodeToolResult({
    status: "restored",
    data: { id: "u_x", state: "stopped_by_user" },
  });
  assert.equal(encoded.structuredContent.data.state, "stopped_by_user");
});

test("processing timeouts become a retryable failure with zero effects", () => {
  // 等待超时是零写入，因此原样重放（再等一轮）是唯一允许 retryable 的情形。
  for (const status of [
    "processing_pending",
    "stability_pending",
    "phoneme_coverage_unsatisfied",
  ]) {
    const encoded = encodeToolResult({ status, data: { kind: "phonemes" } });
    assert.equal(encoded.structuredContent.status, "failed");
    assert.equal(encoded.structuredContent.effects, "none");
    assert.equal(encoded.structuredContent.retryable, true);
    assert.equal(encoded.isError, true);
    assert.equal(encoded.structuredContent.data.state, status);
  }
});

test("a verified write with a failed phoneme observation stays succeeded", () => {
  // 这是最危险的一格：把它标成失败会让模型重放一个已经成功的 mutation。
  const encoded = encodeToolResult({
    status: "processing_observation_failed",
    effects: "verified",
    data: { changed: 7 },
  });
  assert.equal(encoded.structuredContent.status, "succeeded");
  assert.equal(encoded.structuredContent.effects, "verified");
  assert.equal(encoded.isError, undefined);
  assert.equal(encoded.structuredContent.data.state, "processing_observation_failed");
});

test("an unregistered status fails loudly instead of reaching the model", () => {
  // 关键保护：新服务发明一个 status 时必须在 result-status.js 登记，
  // 否则模型会收到一个无法归类的根 status。
  assert.throws(
    () => projectStatusEnvelope({ status: "brand_new_conclusion" }),
    /neither in the frozen matrix nor registered for projection/
  );
  assert.throws(
    () => encodeToolResult({ status: "brand_new_conclusion" }),
    /neither in the frozen matrix nor registered for projection/
  );
});

test("every matrix entry is internally consistent", () => {
  for (const [status, entry] of Object.entries(RESULT_STATUS_MATRIX)) {
    assert.ok(entry.effects.length >= 1, `${status} needs at least one effects value`);
    assert.equal(typeof entry.isError, "boolean");
    assert.ok(["never", "recapture", "by_code", "forbidden"].includes(entry.retry));
    // 成功类结论绝不可能"可能有残留"。
    if (!entry.isError) {
      assert.ok(
        entry.effects.every((effects) => ["verified", "none"].includes(effects)),
        `${status} is a success but claims ${entry.effects.join("/")}`
      );
    }
    // 只有 effects 恒为 none 的 status 才允许自动重放。
    if (entry.retry === "recapture" || entry.retry === "by_code") {
      assert.deepEqual(entry.effects, ["none"], `${status} may not be retryable with side effects`);
    }
  }
});
