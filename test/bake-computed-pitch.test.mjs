import assert from "node:assert/strict";
import test from "node:test";

import { BakeComputedPitchService } from "../server/src/bake-computed-pitch.js";
import { RangeSnapshotService } from "../server/src/musical-range.js";
import { PitchControlPatchService } from "../server/src/pitch-control-patch.js";
import { SnapshotService, SnapshotStore } from "../server/src/snapshot.js";
import { createPitchHostModel } from "./helpers/pitch-host.mjs";

const Q = 705600000;
const FRAMES = 160;

const NOTES = [
  { onset: 0, duration: Q, pitch: 60, lyrics: "a" },
  { onset: Q, duration: Q, pitch: 62, lyrics: "i" },
  { onset: 2 * Q, duration: 4 * Q, pitch: 64, lyrics: "u" },
];

// 平滑起伏的 computed pitch 轮廓：RDP 应把它简化成少量点（端点 + 峰谷）。
function smoothContour(frames, base = 60, amplitude = 4) {
  return Array.from({ length: frames }, (_, index) => base + amplitude * Math.sin((Math.PI * index) / (frames - 1)));
}

function createFixture(options = {}) {
  const model = createPitchHostModel({ notes: NOTES, ...options });
  const session = { withExclusive: (task) => task(model.host), getStatus: () => ({ epoch: 1 }) };
  const store = new SnapshotStore({ now: () => 1000 });
  const snapshots = new RangeSnapshotService(session, { now: () => 1000, store });
  const snapshotService = new SnapshotService(session, { store, now: () => 1000 });
  const patch = new PitchControlPatchService(session, snapshotService, {
    sleepFn: async () => {},
    now: () => 1000,
    idGenerator: () => "pc_baked_1",
  });
  const bake = new BakeComputedPitchService(session, snapshotService, patch, {
    now: () => 1000,
    sleepFn: async () => {},
  });
  return { model, snapshots, patch, bake, store };
}

async function snapshotAll(snapshots, options = {}) {
  return snapshots.snapshot({
    scope: { kind: "range", from: { bar: 1 }, to: { bar: 20 } },
    include: ["notes", "computedPitch", "pitchControls"],
    computedPitchSampling: { frames: FRAMES },
    ...options,
  });
}

test("a valid computed pitch bakes into one owned curve with coverage and fit evidence", async () => {
  const { model, snapshots, bake } = createFixture({ computedPitchValues: smoothContour(FRAMES) });
  const snapshot = await snapshotAll(snapshots);
  const result = await bake.bake({
    action: "commit",
    contextId: snapshot.contextId,
    occurrence: 0,
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "succeeded");
  assert.equal(result.effects, "verified");
  assert.equal(result.coverage, 1);
  assert.equal(result.finiteFrames, FRAMES);
  assert.equal(result.nullFrames, 0);
  assert.ok(result.fitError.maxSemitone <= result.fitError.toleranceSemitone + 1e-9);
  assert.equal(result.strategy, "preserve_existing");
  assert.equal(result.pitchDeltaHandling, "preserve");
  assert.equal(result.undo.expectedUserUndoSteps, 1);
  assert.equal(result.verification.passed, true);
  assert.equal(result.occurrence.occurrence, 0);
  // RDP 把 160 帧简化成少量点，且 anchor 取首个有效帧。
  assert.ok(result.bakedCurve.pointCount < FRAMES);
  assert.ok(result.bakedCurve.pointCount >= 2);
  const state = model.controlsSnapshot();
  assert.equal(state.length, 1);
  assert.equal(state[0].kind, "curve");
  assert.equal(state[0].scriptData["svcopilot.owner"], "svcopilot");
  assert.equal(state[0].scriptData["svcopilot.generator"], "sv_bake_computed_pitch");
  // anchor 音高 = 首帧 group-relative（pitchOffset=0 → 等于 computed 值）。
  assert.equal(state[0].pitch, 60);
  assert.equal(state[0].points[0][0], 0);
  assert.equal(state[0].points[0][1], 0);
});

test("nonzero pitch offset converts absolute computed pitch to group-relative", async () => {
  const { snapshots, bake } = createFixture({
    pitchOffsetSemitone: 3,
    computedPitchValues: smoothContour(FRAMES, 65),
  });
  const snapshot = await snapshotAll(snapshots);
  const result = await bake.bake({
    action: "commit",
    contextId: snapshot.contextId,
    occurrence: 0,
  });
  assert.equal(result.ok, true);
  // anchor 音高 = 首帧绝对 MIDI - pitchOffset = 65 - 3 = 62。
  assert.equal(result.bakedCurve.anchorPitchSemitone, 62);
});

test("all-null computed pitch writes nothing and reports INSUFFICIENT_COMPUTED_PITCH", async () => {
  const { model, snapshots, bake } = createFixture({
    computedPitchValues: new Array(FRAMES).fill(null),
  });
  const snapshot = await snapshotAll(snapshots);
  await assert.rejects(
    bake.bake({
      action: "commit", contextId: snapshot.contextId, occurrence: 0 }),
    (error) => {
      assert.equal(error.code, "INSUFFICIENT_COMPUTED_PITCH");
      assert.equal(error.details.finiteFrames, 0);
      return true;
    }
  );
  assert.equal(model.controls.length, 0);
  assert.equal(model.undoCount, 0);
});

test("coverage below the threshold writes nothing", async () => {
  const partial = Array.from({ length: FRAMES }, (_, index) => (index < FRAMES / 2 ? 60 : null));
  const { model, snapshots, bake } = createFixture({ computedPitchValues: partial });
  const snapshot = await snapshotAll(snapshots);
  await assert.rejects(
    bake.bake({
      action: "commit", contextId: snapshot.contextId, occurrence: 0 }),
    (error) => error.code === "INSUFFICIENT_COMPUTED_PITCH"
  );
  assert.equal(model.controls.length, 0);
  assert.equal(model.undoCount, 0);
});

test("dry-run reports the planned curve and coverage with zero writes", async () => {
  const { model, snapshots, bake } = createFixture({ computedPitchValues: smoothContour(FRAMES) });
  const snapshot = await snapshotAll(snapshots);
  const result = await bake.bake({
    contextId: snapshot.contextId,
    occurrence: 0,
    action: "dry_run",
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "dry_run");
  assert.equal(result.effects, "none");
  assert.equal(result.coverage, 1);
  assert.ok(result.bakedCurve.pointCount >= 2);
  assert.ok(result.plannedOperations.some((op) => op.op === "add"));
  assert.equal(model.controls.length, 0);
  assert.equal(model.undoCount, 0);
});

test("a point budget cannot silently relax the requested fit tolerance", async () => {
  const alternating = Array.from({ length: FRAMES }, (_, index) => 60 + (index % 2));
  const { model, snapshots, bake } = createFixture({ computedPitchValues: alternating });
  const snapshot = await snapshotAll(snapshots);

  await assert.rejects(
    bake.bake({
      contextId: snapshot.contextId,
      occurrence: 0,
      action: "dry_run",
      toleranceSemitone: 0.001,
      maxPoints: 8,
    }),
    (error) => {
      assert.equal(error.code, "BAKE_POINT_BUDGET_EXCEEDED");
      assert.equal(error.details.maxPoints, 8);
      assert.equal(error.details.toleranceSemitone, 0.001);
      assert.ok(error.details.requiredPoints > 8);
      return true;
    }
  );
  assert.equal(model.controls.length, 0);
  assert.equal(model.undoCount, 0);
});

test("replace_owned deletes the previous owned curve in range and adds the new one", async () => {
  const existingOwned = {
    kind: "curve",
    position: Q,
    pitch: 60,
    points: [[0, 0], [Q, 0.5]],
    scriptData: {
      "svcopilot.owner": "svcopilot",
      "svcopilot.controlId": "pc_old_bake",
      "svcopilot.generator": "sv_bake_computed_pitch",
      "svcopilot.schemaVersion": "1",
    },
  };
  const { model, snapshots, bake } = createFixture({
    computedPitchValues: smoothContour(FRAMES),
    controls: [existingOwned],
  });
  const snapshot = await snapshotAll(snapshots);
  const result = await bake.bake({
    action: "commit",
    contextId: snapshot.contextId,
    occurrence: 0,
    strategy: "replace_owned",
  });
  assert.equal(result.ok, true);
  const state = model.controlsSnapshot();
  // 旧自有 curve 被删除，新增一条新 bake curve。
  assert.equal(state.length, 1);
  assert.equal(state[0].scriptData["svcopilot.controlId"], "pc_baked_1");
  assert.ok(!state.some((c) => c.scriptData["svcopilot.controlId"] === "pc_old_bake"));
  assert.equal(result.undo.expectedUserUndoSteps, 1);
});

test("replace_owned preserves external controls while replacing owned ones", async () => {
  const external = { kind: "point", position: Q, pitch: 60, scriptData: { mm_Flag: "keep" } };
  const owned = {
    kind: "point",
    position: 2 * Q,
    pitch: 62,
    scriptData: { "svcopilot.owner": "svcopilot", "svcopilot.controlId": "pc_mine" },
  };
  const { model, snapshots, bake } = createFixture({
    computedPitchValues: smoothContour(FRAMES),
    controls: [external, owned],
  });
  const snapshot = await snapshotAll(snapshots);
  const result = await bake.bake({
    action: "commit",
    contextId: snapshot.contextId,
    occurrence: 0,
    strategy: "replace_owned",
  });
  assert.equal(result.ok, true);
  const state = model.controlsSnapshot();
  // 外部对象保留，自有对象被替换。
  assert.ok(state.some((c) => c.scriptData["mm_Flag"] === "keep"));
  assert.ok(!state.some((c) => c.scriptData["svcopilot.controlId"] === "pc_mine"));
});

test("replace_explicit deletes only the caller-confirmed control", async () => {
  const keep = { kind: "point", position: Q, pitch: 60, scriptData: { mm_Flag: "keep" } };
  const drop = { kind: "point", position: 2 * Q, pitch: 62, scriptData: { mm_Flag: "drop" } };
  const { model, snapshots, bake } = createFixture({
    computedPitchValues: smoothContour(FRAMES),
    controls: [keep, drop],
  });
  const snapshot = await snapshotAll(snapshots);
  const dropControl = snapshot.data.pitchControls.find((c) => c.ownership.scriptDataKeys.includes("mm_Flag") && c.pitch?.groupRelativeSemitone === 62);
  const result = await bake.bake({
    action: "commit",
    contextId: snapshot.contextId,
    occurrence: 0,
    strategy: "replace_explicit",
    explicitTargets: [{ controlId: dropControl.controlId, expectedFingerprint: dropControl.fingerprint }],
  });
  assert.equal(result.ok, true);
  const state = model.controlsSnapshot();
  assert.ok(state.some((c) => c.scriptData["mm_Flag"] === "keep"));
  assert.ok(!state.some((c) => c.scriptData["mm_Flag"] === "drop"));
});

test("pitchDeltaHandling clear is rejected explicitly, not silently ignored", async () => {
  const { snapshots, bake } = createFixture({ computedPitchValues: smoothContour(FRAMES) });
  const snapshot = await snapshotAll(snapshots);
  await assert.rejects(
    bake.bake({
      action: "commit",
      contextId: snapshot.contextId,
      occurrence: 0,
      pitchDeltaHandling: "clear",
    }),
    (error) => error.code === "PITCH_DELTA_CLEAR_UNSUPPORTED"
  );
});

test("missing computed pitch capture fails with COMPUTED_PITCH_NOT_CAPTURED", async () => {
  const { snapshots, bake } = createFixture({ computedPitchValues: smoothContour(FRAMES) });
  const snapshot = await snapshots.snapshot({
    scope: { kind: "range", from: { bar: 1 }, to: { bar: 20 } },
    include: ["notes"],
  });
  await assert.rejects(
    bake.bake({
      action: "commit", contextId: snapshot.contextId, occurrence: 0 }),
    (error) => error.code === "COMPUTED_PITCH_NOT_CAPTURED"
  );
});
