import assert from "node:assert/strict";
import test from "node:test";

import { ArtifactStore } from "../server/src/artifact-store.js";
import { RangeSnapshotService } from "../server/src/musical-range.js";
import { PitchControlPatchService } from "../server/src/pitch-control-patch.js";
import { PitchGesturePlanService } from "../server/src/pitch-gesture-plan.js";
import { SnapshotService, SnapshotStore } from "../server/src/snapshot.js";
import { createPitchHostModel } from "./helpers/pitch-host.mjs";

const Q = 705600000;

// 三个相邻音符 + 一个长音：n0[0,Q] n1[Q,2Q] 相邻；n2[2Q,6Q] 长 sustain（供 vibrato）。
const NOTES = [
  { onset: 0, duration: Q, pitch: 60, lyrics: "a" },
  { onset: Q, duration: Q, pitch: 62, lyrics: "i" },
  { onset: 2 * Q, duration: 4 * Q, pitch: 64, lyrics: "u" },
];

function createFixture(options = {}) {
  const model = createPitchHostModel({ notes: NOTES, ...options });
  const session = { withExclusive: (task) => task(model.host) };
  const store = new SnapshotStore({ now: () => 1000 });
  const artifactStore = new ArtifactStore({ now: () => 1000 });
  const sessionId = "sess_test";
  const snapshots = new RangeSnapshotService(session, { now: () => 1000, store, artifactStore, sessionId });
  const snapshotService = new SnapshotService(session, { store, now: () => 1000 });
  const planService = new PitchGesturePlanService({ store, now: () => 1000, artifactStore, sessionId });
  // 既有形状断言显式走 inline；planRef 专项用例自行传 usePlanRef:true。
  const planner = {
    plan: (request) => planService.plan({ usePlanRef: false, ...request }),
  };
  const patch = new PitchControlPatchService(session, snapshotService, {
    sleepFn: async () => {},
    now: () => 1000,
    idGenerator: () => "pc_new_1",
    artifactStore,
    sessionId,
  });
  return { model, snapshots, planner, patch, store, artifactStore };
}

async function snapshotNotes(snapshots) {
  return snapshots.snapshot({
    scope: { kind: "range", from: { bar: 1 }, to: { bar: 20 } },
    include: ["notes", "tempoMap", "meterMap"],
  });
}

// 身份就是组内 index（§3.1）；保留 helper 让测试改动最小、意图仍可读。
const nid = (_snapshot, index) => index;

test("a full gesture set compiles to bounded group-local add curves with a unified apply envelope", async () => {
  const { snapshots, planner } = createFixture();
  const snapshot = await snapshotNotes(snapshots);
  const result = await planner.plan({
    contextId: snapshot.contextId,
    gestures: [
      { type: "attack", note: nid(snapshot, 0), depthSemitone: 0.3, direction: "up" },
      { type: "transition", from: nid(snapshot, 0), to: nid(snapshot, 1), width: { quarters: 0.5 } },
      { type: "release", note: nid(snapshot, 2), depthSemitone: 0.4, direction: "down" },
      { type: "vibrato", note: nid(snapshot, 2), depthSemitone: 0.3, rateHz: 5.5, startSeconds: 0.3 },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "planned");
  assert.equal(result.effects, "none");
  assert.equal(result.apply.tool, "sv_patch_pitch_controls");
  assert.equal(result.summary.expectedUserUndoSteps, 1);
  const ops = result.apply.arguments.operations;
  assert.equal(ops.length, 4);
  for (const op of ops) {
    assert.equal(op.op, "add");
    assert.equal(op.control.kind, "curve");
    assert.equal(op.control.generator, "sv_plan_pitch_gesture");
    // 有界不超调：所有点相对 anchor 的偏移都在 constraints 上限内。
    for (const point of op.control.points) {
      assert.ok(Math.abs(point.pitchFromAnchorSemitone) <= 2 + 1e-9);
      assert.ok(Number.isSafeInteger(point.timeFromAnchorBlick));
    }
    // anchor 相对时间严格递增。
    for (let index = 1; index < op.control.points.length; index += 1) {
      assert.ok(op.control.points[index].timeFromAnchorBlick > op.control.points[index - 1].timeFromAnchorBlick);
    }
  }
  // 单位纪律：anchor 音高是 group-relative semitone（取音符目标音）。
  const attack = result.gestures.find((g) => g.type === "attack");
  assert.equal(attack.anchor.groupRelativeSemitone, 60);
  // apply.arguments 携带 expectedNotes/expectedTimeOffsetBlick 漂移守卫。
  assert.ok(Array.isArray(result.apply.arguments.target.expectedNotes));
  assert.equal(result.apply.arguments.target.expectedTimeOffsetBlick, 0);
});

test("planner output is schema-valid and plannable against the live host (dry-run, zero writes)", async () => {
  const { model, snapshots, planner, patch } = createFixture();
  const snapshot = await snapshotNotes(snapshots);
  const plan = await planner.plan({
    contextId: snapshot.contextId,
    gestures: [
      { type: "transition", from: nid(snapshot, 0), to: nid(snapshot, 1), width: { quarters: 0.5 } },
      { type: "release", note: nid(snapshot, 2), depthSemitone: 0.4 },
    ],
  });
  // apply.arguments 逐字（含 dryRun:true）喂给真实事务核：应 dry_run 且零写、零 Undo。
  const dryRun = await patch.patch(plan.apply.arguments);
  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.status, "dry_run");
  assert.equal(model.undoCount, 0);
  assert.equal(model.controls.length, 0);
  // 再去掉 dryRun 提交：应成功且读回验证通过，生成自有 curve。
  const commit = await patch.patch({ ...plan.apply.arguments, dryRun: false });
  assert.equal(commit.ok, true);
  assert.equal(commit.status, "succeeded");
  assert.equal(commit.effects, "verified");
  assert.equal(commit.undo.expectedUserUndoSteps, 1);
  const state = model.controlsSnapshot();
  assert.equal(state.length, 2);
  assert.ok(state.every((c) => c.scriptData["svcopilot.owner"] === "svcopilot"));
});

test("identical input produces a byte-stable plan id and apply arguments", async () => {
  const { snapshots, planner } = createFixture();
  const snapshot = await snapshotNotes(snapshots);
  const request = {
    contextId: snapshot.contextId,
    gestures: [
      { type: "attack", note: nid(snapshot, 0), depthSemitone: 0.3 },
      { type: "vibrato", note: nid(snapshot, 2), rateHz: 5, depthSemitone: 0.25 },
    ],
  };
  const first = await planner.plan(request);
  const second = await planner.plan(request);
  assert.equal(first.planId, second.planId);
  assert.equal(JSON.stringify(first.apply.arguments), JSON.stringify(second.apply.arguments));
});

test("transition follows the source and target pitches without overshooting", async () => {
  const { snapshots, planner } = createFixture();
  const snapshot = await snapshotNotes(snapshots);
  const result = await planner.plan({
    contextId: snapshot.contextId,
    gestures: [
      { type: "transition", from: nid(snapshot, 0), to: nid(snapshot, 1), width: { quarters: 1 } },
    ],
  });
  const control = result.apply.arguments.operations[0].control;
  const points = control.points;
  // 音程 +2 半音、anchor 位于目标音 62：相对值必须从 -2 到 0，
  // 展开后的绝对音高才是 60 -> 62，而不是错误的 61 -> 63。
  assert.ok(Math.abs(control.anchorPitchSemitone + points[0].pitchFromAnchorSemitone - 60) < 1e-9);
  assert.ok(Math.abs(control.anchorPitchSemitone + points.at(-1).pitchFromAnchorSemitone - 62) < 1e-9);
  let previous = -Infinity;
  for (const point of points) {
    assert.ok(point.pitchFromAnchorSemitone >= -2 - 1e-9);
    assert.ok(point.pitchFromAnchorSemitone <= 1e-9);
    assert.ok(point.pitchFromAnchorSemitone >= previous - 1e-9);
    previous = point.pitchFromAnchorSemitone;
  }
});

test("vibrato stays within depth and reports its sampling", async () => {
  const { snapshots, planner } = createFixture();
  const snapshot = await snapshotNotes(snapshots);
  const result = await planner.plan({
    contextId: snapshot.contextId,
    gestures: [{ type: "vibrato", note: nid(snapshot, 2), depthSemitone: 0.3, rateHz: 5 }],
  });
  const points = result.apply.arguments.operations[0].control.points;
  assert.ok(points.length > 4);
  for (const point of points) {
    assert.ok(Math.abs(point.pitchFromAnchorSemitone) <= 0.3 + 1e-9);
  }
});

test("transition between non-adjacent notes is rejected", async () => {
  const { snapshots, planner } = createFixture();
  const snapshot = await snapshotNotes(snapshots);
  await assert.rejects(
    planner.plan({
      contextId: snapshot.contextId,
      gestures: [{ type: "transition", from: nid(snapshot, 0), to: nid(snapshot, 2) }],
    }),
    (error) => error.code === "TRANSITION_NOT_ADJACENT"
  );
});

test("vibrato on a too-short note is rejected", async () => {
  const { snapshots, planner } = createFixture();
  const snapshot = await snapshotNotes(snapshots);
  await assert.rejects(
    planner.plan({
      contextId: snapshot.contextId,
      gestures: [{ type: "vibrato", note: nid(snapshot, 0), rateHz: 5 }],
    }),
    (error) => error.code === "CONSTRAINT_VIOLATION"
  );
});

test("seconds-based durations convert through the tempo map", async () => {
  const { snapshots, planner } = createFixture();
  const snapshot = await snapshotNotes(snapshots);
  const result = await planner.plan({
    contextId: snapshot.contextId,
    gestures: [
      { type: "attack", note: nid(snapshot, 0), depthSemitone: 0.3, length: { seconds: 0.25 } },
    ],
  });
  // 120bpm 下 0.25s = 0.5 quarter = Q/2。
  const op = result.apply.arguments.operations[0].control;
  const span = Math.max(...op.points.map((p) => p.timeFromAnchorBlick));
  assert.ok(span > 0 && span <= Q / 2 + 1);
});

test("depth clamping to constraints is reported as a warning", async () => {
  const { snapshots, planner } = createFixture();
  const snapshot = await snapshotNotes(snapshots);
  const result = await planner.plan({
    contextId: snapshot.contextId,
    constraints: { maxAbsDepthSemitone: 0.5 },
    gestures: [{ type: "attack", note: nid(snapshot, 0), depthSemitone: 2 }],
  });
  assert.ok(result.warnings.some((w) => w.code === "CONSTRAINT_CLAMPED"));
  const points = result.apply.arguments.operations[0].control.points;
  for (const point of points) assert.ok(Math.abs(point.pitchFromAnchorSemitone) <= 0.5 + 1e-9);
});

test("breath targets default to warn-and-skip with a zero-write no-change plan", async () => {
  const { snapshots, planner } = createFixture({
    notes: [{ onset: 0, duration: Q, pitch: 59, lyrics: "br" }],
  });
  const snapshot = await snapshotNotes(snapshots);
  const result = await planner.plan({
    contextId: snapshot.contextId,
    gestures: [{ type: "attack", note: nid(snapshot, 0), depthSemitone: 0.3 }],
  });

  assert.equal(result.status, "no_change");
  assert.equal(result.apply, null);
  assert.deepEqual(result.applyRequests, []);
  assert.equal(result.summary.requestedGestureCount, 1);
  assert.equal(result.summary.gestureCount, 0);
  assert.equal(result.summary.skippedGestureCount, 1);
  assert.equal(result.summary.operationCount, 0);
  assert.equal(result.summary.applyCallCount, 0);
  assert.equal(result.summary.expectedUserUndoSteps, 0);
  assert.equal(result.summary.excludedEvents.byRole.breath_event, 1);
  const warning = result.warnings.find(
    (item) => item.code === "NON_MELODIC_SPECIAL_EVENT_SKIPPED"
  );
  assert.equal(warning.noteIndex, 0);
  assert.equal(warning.semanticRole, "breath_event");
  assert.equal(warning.evidence, "official_documented_special_lyric_br");
});

test("breath targets require explicit include, while low-level dry-run remains available", async () => {
  const { model, snapshots, planner, patch } = createFixture({
    notes: [{ onset: 0, duration: Q, pitch: 59, lyrics: "br" }],
  });
  const snapshot = await snapshotNotes(snapshots);
  const result = await planner.plan({
    contextId: snapshot.contextId,
    specialEventPolicy: "include",
    gestures: [{ type: "attack", note: nid(snapshot, 0), depthSemitone: 0.3 }],
  });

  assert.equal(result.status, "planned");
  assert.equal(result.gestures[0].anchor.groupRelativeSemitone, 59);
  assert.equal(result.summary.skippedGestureCount, 0);
  const dryRun = await patch.patch(result.apply.arguments);
  assert.equal(dryRun.status, "dry_run");
  assert.equal(model.undoCount, 0);
  assert.equal(model.controls.length, 0);
});

test("near-miss breath spelling stays melodic but carries the shared semantic warning", async () => {
  const { snapshots, planner } = createFixture({
    notes: [{ onset: 0, duration: Q, pitch: 59, lyrics: "BR" }],
  });
  const snapshot = await snapshotNotes(snapshots);
  const result = await planner.plan({
    contextId: snapshot.contextId,
    gestures: [{ type: "attack", note: nid(snapshot, 0), depthSemitone: 0.3 }],
  });

  assert.equal(result.status, "planned");
  assert.equal(result.summary.skippedGestureCount, 0);
  assert.equal(result.summary.excludedEvents.count, 0);
  assert.ok(
    result.warnings.some(
      (warning) =>
        warning.code === "SUSPICIOUS_SPECIAL_LYRIC_VARIANT" &&
        warning.notes.some((note) => note.indexInGroup === 0)
    )
  );
});

test("special-event error policy rejects the whole pitch plan before compilation", async () => {
  const { snapshots, planner } = createFixture({
    notes: [
      { onset: 0, duration: Q, pitch: 60, lyrics: "a" },
      { onset: Q, duration: Q, pitch: 59, lyrics: "br" },
    ],
  });
  const snapshot = await snapshotNotes(snapshots);
  await assert.rejects(
    planner.plan({
      contextId: snapshot.contextId,
      specialEventPolicy: "error",
      gestures: [
        { type: "attack", note: nid(snapshot, 0) },
        { type: "release", note: nid(snapshot, 1) },
      ],
    }),
    (error) => {
      assert.equal(error.code, "NON_MELODIC_SPECIAL_EVENT_TARGETED");
      assert.equal(error.details.noteIndex, 1);
      assert.equal(error.details.semanticRole, "breath_event");
      return true;
    }
  );
});

test("release auto direction never infers melody from a following breath event", async () => {
  const { snapshots, planner } = createFixture({
    notes: [
      { onset: 0, duration: Q, pitch: 60, lyrics: "a" },
      { onset: Q, duration: Q, pitch: 72, lyrics: "br" },
    ],
  });
  const snapshot = await snapshotNotes(snapshots);
  const result = await planner.plan({
    contextId: snapshot.contextId,
    gestures: [{ type: "release", note: nid(snapshot, 0), direction: "auto" }],
  });
  assert.equal(result.gestures[0].params.direction, "down");
});

test("the planner never touches the host", async () => {
  const { model, snapshots, planner } = createFixture();
  const snapshot = await snapshotNotes(snapshots);
  const callsBefore = model.hostCalls.length;
  await planner.plan({
    contextId: snapshot.contextId,
    gestures: [{ type: "attack", note: nid(snapshot, 0), depthSemitone: 0.3 }],
  });
  assert.equal(model.hostCalls.length, callsBefore);
  assert.equal(model.undoCount, 0);
  assert.equal(model.controls.length, 0);
});

test("planRef path: planner returns short planRef and executor resolves it", async () => {
  const { snapshots, planner, patch, model } = createFixture();
  const snapshot = await snapshotNotes(snapshots);
  const plan = await planner.plan({
    contextId: snapshot.contextId,
    gestures: [{ type: "attack", note: nid(snapshot, 0), depthSemitone: 0.3 }],
    usePlanRef: true,
  });
  assert.equal(plan.status, "planned");
  assert.ok(plan.apply.arguments.planRef, "apply.arguments should carry planRef");
  assert.strictEqual(plan.apply.arguments.action, "dry_run");
  assert.ok(!plan.apply.arguments.operations, "operations should not be inline when planRef is used");

  // dry-run via planRef
  const dryRun = await patch.patch({
    planRef: plan.apply.arguments.planRef,
    action: "dry_run",
  });
  assert.equal(dryRun.status, "dry_run");
  assert.equal(dryRun.effects, "none");
  assert.equal(model.undoCount, 0);

  // commit via planRef
  const commit = await patch.patch({
    planRef: plan.apply.arguments.planRef,
    action: "commit",
  });
  assert.equal(commit.status, "succeeded");
  assert.equal(model.controls.length, 1);
});
