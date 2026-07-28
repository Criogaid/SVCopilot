import assert from "node:assert/strict";
import test from "node:test";

import { RangeSnapshotService } from "../server/src/musical-range.js";
import { PitchControlPatchService } from "../server/src/pitch-control-patch.js";
import { SnapshotService, SnapshotStore } from "../server/src/snapshot.js";
import { createPitchHostModel } from "./helpers/pitch-host.mjs";

const Q = 705600000;
const BAR = 4 * Q;

function createFixture(options = {}, controlIds = ["pc_new_1", "pc_new_2", "pc_new_3"]) {
  const model = createPitchHostModel(options);
  const session = { withExclusive: (task) => task(model.host) };
  const store = new SnapshotStore({ now: () => 1000 });
  // range 快照与 patch 共享同一 SnapshotStore：contextId 由 range 签发，patch 经
  // SnapshotService.getContext（含 epoch 校验）解析。
  const snapshots = new RangeSnapshotService(session, { now: () => 1000, store });
  const snapshotService = new SnapshotService(session, { store, now: () => 1000 });
  const service = new PitchControlPatchService(session, snapshotService, {
    sleepFn: async () => {},
    now: () => 1000,
    idGenerator: () => controlIds.shift() ?? "pc_extra",
  });
  return { model, snapshots, service };
}

async function snapshotWithControls(service) {
  return service.snapshot({
    scope: { kind: "range", from: { bar: 1 }, to: { bar: 20 } },
    include: ["pitchControls"],
  });
}

const byKind = (snapshot, kind) => snapshot.data.pitchControls.find((c) => c.kind === kind);
const occurrenceId = (snapshot) => `${snapshot.contextId}:t:0:r:0`;

test("dry-run plans add/update/delete with zero host writes and zero Undo", async () => {
  const { model, snapshots, service } = createFixture({
    controls: [
      { kind: "point", position: Q, pitch: 60 },
      { kind: "curve", position: 2 * Q, pitch: 64, points: [[-50, -0.1], [50, 0.1]] },
    ],
  });
  const snapshot = await snapshotWithControls(snapshots);
  const point = byKind(snapshot, "point");
  const curve = byKind(snapshot, "curve");
  const result = await service.patch({
    contextId: snapshot.contextId,
    occurrenceId: occurrenceId(snapshot),
    dryRun: true,
    operations: [
      { op: "add", control: { kind: "point", positionBlick: 3 * Q, pitchSemitone: 65 } },
      { op: "update", controlId: point.controlId, expectedFingerprint: point.fingerprint, set: { pitchSemitone: 61 } },
      { op: "delete", controlId: curve.controlId, expectedFingerprint: curve.fingerprint },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "dry_run");
  assert.equal(result.effects, "none");
  assert.equal(result.undo.boundaryCallsCompleted, 0);
  assert.equal(model.undoCount, 0);
  assert.equal(model.controls.length, 2);
  assert.equal(result.changes.planned, 3);
});

test("add/update/delete commits in one Undo with read-back verification and context invalidation", async () => {
  const { model, snapshots, service } = createFixture({
    controls: [
      { kind: "point", position: Q, pitch: 60 },
      { kind: "curve", position: 2 * Q, pitch: 64, points: [[-50, -0.1], [50, 0.1]] },
    ],
  });
  const snapshot = await snapshotWithControls(snapshots);
  const point = byKind(snapshot, "point");
  const curve = byKind(snapshot, "curve");
  const result = await service.patch({
    contextId: snapshot.contextId,
    occurrenceId: occurrenceId(snapshot),
    operations: [
      { op: "add", control: { kind: "point", positionBlick: 3 * Q, pitchSemitone: 65 } },
      { op: "update", controlId: point.controlId, expectedFingerprint: point.fingerprint, set: { pitchSemitone: 61 } },
      { op: "delete", controlId: curve.controlId, expectedFingerprint: curve.fingerprint },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "succeeded");
  assert.equal(result.effects, "verified");
  assert.deepEqual(result.changes, { planned: 3, actuallyChanged: 3, added: 1, updated: 1, deleted: 1 });
  assert.equal(result.undo.recordCreated, true);
  assert.equal(result.undo.expectedUserUndoSteps, 1);
  assert.equal(model.undoCount, 2);
  assert.equal(result.verification.passed, true);
  assert.equal(result.verification.basis, "host_read_back");

  const state = model.controlsSnapshot();
  assert.equal(state.length, 2);
  const updated = state.find((c) => c.position === Q);
  assert.equal(updated.pitch, 61);
  const added = state.find((c) => c.position === 3 * Q);
  assert.equal(added.pitch, 65);
  assert.equal(added.scriptData["svcopilot.owner"], "svcopilot");
  assert.equal(added.scriptData["svcopilot.controlId"], "pc_new_1");
  assert.equal(added.scriptData["svcopilot.generator"], "sv_patch_pitch_controls");
  assert.ok(!state.some((c) => c.kind === "curve"));
  assert.equal(snapshots.store.get(snapshot.contextId), null);
});

test("a no-op update reports no_change with zero Undo and zero host writes", async () => {
  const { model, snapshots, service } = createFixture({
    controls: [{ kind: "point", position: Q, pitch: 60 }],
  });
  const snapshot = await snapshotWithControls(snapshots);
  const point = byKind(snapshot, "point");
  const result = await service.patch({
    contextId: snapshot.contextId,
    occurrenceId: occurrenceId(snapshot),
    operations: [
      { op: "update", controlId: point.controlId, expectedFingerprint: point.fingerprint, set: { pitchSemitone: 60 } },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "no_change");
  assert.equal(result.effects, "none");
  assert.equal(result.changes.actuallyChanged, 0);
  assert.equal(result.undo.recordCreated, false);
  assert.equal(result.undo.expectedUserUndoSteps, 0);
  assert.equal(model.undoCount, 0);
  assert.equal(model.controls.length, 1);
});

test("operations cannot target a control added earlier in the same request", async () => {
  // fingerprint 才是身份，且它在 preflight（任何写入之前）就解析完成；本请求尚未 add 出来的
  // 对象没有可知的 fingerprint，无法被后续 op 定位——得到诚实的 UNKNOWN_CONTROL，绝不"取第一个"。
  const { model, snapshots, service } = createFixture({ controls: [] });
  const snapshot = await snapshotWithControls(snapshots);
  const result = await service.patch({
    contextId: snapshot.contextId,
    occurrenceId: occurrenceId(snapshot),
    operations: [
      { op: "add", control: { kind: "point", positionBlick: Q, pitchSemitone: 60 } },
      { op: "delete", controlId: "pc_new_1", expectedFingerprint: "sha256:not-yet-known" },
    ],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "UNKNOWN_CONTROL");
  assert.equal(model.controls.length, 0);
  assert.equal(model.undoCount, 0);
});

test("stale expectedFingerprint fails with zero writes", async () => {
  const { model, snapshots, service } = createFixture({
    controls: [{ kind: "point", position: Q, pitch: 60 }],
  });
  const snapshot = await snapshotWithControls(snapshots);
  const result = await service.patch({
    contextId: snapshot.contextId,
    occurrenceId: occurrenceId(snapshot),
    operations: [
      { op: "delete", controlId: `${occurrenceId(snapshot)}:pc:0`, expectedFingerprint: "sha256:stale" },
    ],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "UNKNOWN_CONTROL");
  assert.equal(model.controls.length, 1);
  assert.equal(model.undoCount, 0);
});

test("identical duplicates are reported ambiguous, never first-matched", async () => {
  const { model, snapshots, service } = createFixture({
    controls: [
      { kind: "point", position: Q, pitch: 60 },
      { kind: "point", position: Q, pitch: 60 },
    ],
  });
  const snapshot = await snapshotWithControls(snapshots);
  const point = byKind(snapshot, "point");
  const result = await service.patch({
    contextId: snapshot.contextId,
    occurrenceId: occurrenceId(snapshot),
    operations: [{ op: "delete", controlId: point.controlId, expectedFingerprint: point.fingerprint }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "AMBIGUOUS_CONTROL");
  assert.equal(model.controls.length, 2);
  assert.equal(model.undoCount, 0);
});

test("a changed group fingerprint conflicts before any write", async () => {
  const { model, snapshots, service } = createFixture({
    controls: [{ kind: "point", position: Q, pitch: 60 }],
  });
  const snapshot = await snapshotWithControls(snapshots);
  const point = byKind(snapshot, "point");
  const groupFingerprint = snapshot.data.tracks[0].groups[0].pitchControlGroupFingerprint;
  const ok = await service.patch({
    contextId: snapshot.contextId,
    occurrenceId: occurrenceId(snapshot),
    target: { expectedPitchControlFingerprint: groupFingerprint },
    operations: [{ op: "delete", controlId: point.controlId, expectedFingerprint: point.fingerprint }],
  });
  assert.equal(ok.ok, true);
  assert.equal(model.controls.length, 0);

  const snapshot2 = await snapshotWithControls(snapshots);
  const result = await service.patch({
    contextId: snapshot2.contextId,
    occurrenceId: occurrenceId(snapshot2),
    target: { expectedPitchControlFingerprint: groupFingerprint },
    operations: [{ op: "add", control: { kind: "point", positionBlick: 2 * Q, pitchSemitone: 62 } }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, "conflict");
  assert.equal(result.error.code, "TARGET_CONFLICT");
  assert.equal(model.undoCount, 2);
});

test("a moved group reference fails STALE_CONTEXT via expectedTimeOffsetBlick", async () => {
  const { model, snapshots, service } = createFixture({
    timeOffsetBlick: BAR,
    controls: [{ kind: "point", position: Q, pitch: 60 }],
  });
  const snapshot = await snapshotWithControls(snapshots);
  const point = byKind(snapshot, "point");
  const result = await service.patch({
    contextId: snapshot.contextId,
    occurrenceId: occurrenceId(snapshot),
    target: { expectedTimeOffsetBlick: 2 * BAR },
    operations: [{ op: "delete", controlId: point.controlId, expectedFingerprint: point.fingerprint }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "STALE_CONTEXT");
  assert.equal(model.controls.length, 1);
  assert.equal(model.undoCount, 0);
});

test("shared target requires explicit confirmation before any write", async () => {
  const { model, snapshots, service } = createFixture({
    secondReference: { timeOffsetBlick: 2 * BAR, pitchOffsetSemitone: 0 },
    controls: [{ kind: "point", position: Q, pitch: 60 }],
  });
  const snapshot = await snapshotWithControls(snapshots);
  const point = snapshot.data.pitchControls.find(
    (c) => c.occurrenceId === occurrenceId(snapshot)
  );
  const refused = await service.patch({
    contextId: snapshot.contextId,
    occurrenceId: occurrenceId(snapshot),
    operations: [{ op: "delete", controlId: point.controlId, expectedFingerprint: point.fingerprint }],
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "SHARED_TARGET_REQUIRES_CONFIRMATION");
  assert.equal(model.controls.length, 1);
  assert.equal(model.undoCount, 0);

  const confirmed = await service.patch({
    contextId: snapshot.contextId,
    occurrenceId: occurrenceId(snapshot),
    target: { allowSharedTargetMutation: true },
    operations: [{ op: "delete", controlId: point.controlId, expectedFingerprint: point.fingerprint }],
  });
  assert.equal(confirmed.ok, true);
  assert.equal(model.controls.length, 0);
});

test("atomic rollback restores the full set and scriptData after a mid-delete failure", async () => {
  const { model, snapshots, service } = createFixture({
    controls: [
      { kind: "point", position: Q, pitch: 60, scriptData: { mm_Flag: "keep" } },
      { kind: "curve", position: 2 * Q, pitch: 64, points: [[-50, -0.1], [50, 0.1]] },
    ],
  });
  const snapshot = await snapshotWithControls(snapshots);
  const point = byKind(snapshot, "point");
  // 第一次 removePitchControl（delete op）失败：此时 add 已成功、组已变化。
  model.failures.push({ method: "removePitchControl", remainingSkips: 0, code: "ARGUMENT_MISMATCH" });
  const result = await service.patch({
    contextId: snapshot.contextId,
    occurrenceId: occurrenceId(snapshot),
    operations: [
      { op: "add", control: { kind: "point", positionBlick: 3 * Q, pitchSemitone: 65 } },
      { op: "delete", controlId: point.controlId, expectedFingerprint: point.fingerprint },
    ],
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, "rolled_back");
  assert.equal(result.effects, "reverted");
  assert.equal(result.rollback.attempted, true);
  assert.equal(result.rollback.verified, true);
  const state = model.controlsSnapshot();
  assert.equal(state.length, 2);
  assert.ok(state.some((c) => c.kind === "curve"));
  const restoredPoint = state.find((c) => c.position === Q);
  assert.equal(restoredPoint.scriptData["mm_Flag"], "keep");
  assert.ok(!state.some((c) => c.position === 3 * Q));
  assert.equal(model.undoCount, 2);
});

test("a multi-field update journals its inverse before the first setter", async () => {
  const { model, snapshots, service } = createFixture({
    controls: [{ kind: "point", position: Q, pitch: 60 }],
  });
  const snapshot = await snapshotWithControls(snapshots);
  const point = byKind(snapshot, "point");
  model.failures.push({ method: "setPitch", remainingSkips: 0, code: "ARGUMENT_MISMATCH" });

  const result = await service.patch({
    contextId: snapshot.contextId,
    occurrenceId: occurrenceId(snapshot),
    operations: [
      {
        op: "update",
        controlId: point.controlId,
        expectedFingerprint: point.fingerprint,
        set: { positionBlick: Q + 123, pitchSemitone: 62 },
      },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "rolled_back");
  assert.equal(result.effects, "reverted");
  assert.equal(result.rollback.verified, true);
  assert.deepEqual(
    model.controlsSnapshot().map(({ position, pitch }) => ({ position, pitch })),
    [{ position: Q, pitch: 60 }]
  );
});

test("journal capture failure happens before opening an Undo record", async () => {
  const { model, snapshots, service } = createFixture({
    controls: [{ kind: "point", position: Q, pitch: 60 }],
  });
  const snapshot = await snapshotWithControls(snapshots);
  const point = byKind(snapshot, "point");
  model.failures.push({ method: "clone", remainingSkips: 0, code: "HOST_CALL_FAILED" });

  const result = await service.patch({
    contextId: snapshot.contextId,
    occurrenceId: occurrenceId(snapshot),
    operations: [
      {
        op: "update",
        controlId: point.controlId,
        expectedFingerprint: point.fingerprint,
        set: { pitchSemitone: 62 },
      },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "failed");
  assert.equal(result.effects, "none");
  assert.equal(result.undo.boundaryCallsCompleted, 0);
  assert.equal(model.undoCount, 0);
  assert.equal(model.controlsSnapshot()[0].pitch, 60);
});

test("a silently-ignored setter is caught by read-back and rolled back", async () => {
  const { model, snapshots, service } = createFixture({
    controls: [{ kind: "point", position: Q, pitch: 60 }],
  });
  const snapshot = await snapshotWithControls(snapshots);
  const point = byKind(snapshot, "point");
  model.ignoreSetters.add("setPitch");
  const result = await service.patch({
    contextId: snapshot.contextId,
    occurrenceId: occurrenceId(snapshot),
    operations: [
      { op: "update", controlId: point.controlId, expectedFingerprint: point.fingerprint, set: { pitchSemitone: 62 } },
    ],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "POSTCONDITION_FAILED");
  assert.equal(result.status, "rolled_back");
  assert.equal(result.rollback.verified, true);
  assert.equal(model.controlsSnapshot()[0].pitch, 60);
});

test("a host timeout during write reports outcome_unknown and never auto-retries", async () => {
  const { model, snapshots, service } = createFixture({
    controls: [{ kind: "point", position: Q, pitch: 60 }],
  });
  const snapshot = await snapshotWithControls(snapshots);
  model.failures.push({
    method: "setPitch",
    remainingSkips: 0,
    code: "HOST_TIMEOUT",
    message: "Timeout waiting for SynthV bridge",
  });
  const result = await service.patch({
    contextId: snapshot.contextId,
    occurrenceId: occurrenceId(snapshot),
    operations: [
      { op: "add", control: { kind: "point", positionBlick: 2 * Q, pitchSemitone: 62 } },
    ],
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, "outcome_unknown");
  assert.equal(result.effects, "unknown");
  assert.equal(result.error.outcome, "unknown");
  assert.equal(result.error.retryable, true);
});

test("a curve round-trips its anchor and points through an update", async () => {
  const { model, snapshots, service } = createFixture({
    controls: [{ kind: "curve", position: Q, pitch: 60, points: [[-100, -0.2], [100, 0.3]] }],
  });
  const snapshot = await snapshotWithControls(snapshots);
  const curve = byKind(snapshot, "curve");
  const result = await service.patch({
    contextId: snapshot.contextId,
    occurrenceId: occurrenceId(snapshot),
    operations: [
      {
        op: "update",
        controlId: curve.controlId,
        expectedFingerprint: curve.fingerprint,
        set: {
          anchorPositionBlick: 2 * Q,
          anchorPitchSemitone: 62,
          points: [
            { timeFromAnchorBlick: -200, pitchFromAnchorSemitone: -0.4 },
            { timeFromAnchorBlick: 200, pitchFromAnchorSemitone: 0.5 },
          ],
        },
      },
    ],
  });
  assert.equal(result.ok, true);
  const state = model.controlsSnapshot()[0];
  assert.equal(state.position, 2 * Q);
  assert.equal(state.pitch, 62);
  assert.deepEqual(state.points, [[-200, -0.4], [200, 0.5]]);
});

test("cross-kind update fields are rejected, not silently ignored", async () => {
  const { model, snapshots, service } = createFixture({
    controls: [{ kind: "point", position: Q, pitch: 60 }],
  });
  const snapshot = await snapshotWithControls(snapshots);
  const point = byKind(snapshot, "point");
  const result = await service.patch({
    contextId: snapshot.contextId,
    occurrenceId: occurrenceId(snapshot),
    operations: [
      { op: "update", controlId: point.controlId, expectedFingerprint: point.fingerprint, set: { anchorPitchSemitone: 61 } },
    ],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "INVALID_ARGUMENTS");
  assert.equal(model.controlsSnapshot()[0].pitch, 60);
  assert.equal(model.undoCount, 0);
});

test("atomic:false is rejected explicitly rather than silently ignored", async () => {
  const { snapshots, service } = createFixture({ controls: [] });
  const snapshot = await snapshotWithControls(snapshots);
  const result = await service.patch({
    contextId: snapshot.contextId,
    occurrenceId: occurrenceId(snapshot),
    atomic: false,
    operations: [{ op: "add", control: { kind: "point", positionBlick: Q, pitchSemitone: 60 } }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "INVALID_ARGUMENTS");
});

test("a moved anchored note fails STALE_CONTEXT via expectedNotes before any write", async () => {
  const { model, snapshots, service } = createFixture({
    controls: [{ kind: "point", position: Q, pitch: 60 }],
  });
  const snapshot = await snapshotWithControls(snapshots);
  const point = byKind(snapshot, "point");
  const anchor = model.notes[0].state;
  const expectedNote = {
    noteId: `${occurrenceId(snapshot)}:n:0`,
    indexInGroup: 0,
    onsetBlick: anchor.onset,
    durationBlick: anchor.duration,
    pitch: anchor.pitch,
    lyrics: anchor.lyrics,
    phonemesOverride: anchor.phonemes,
    languageOverride: anchor.language,
    detuneCents: anchor.detune,
  };
  const ok = await service.patch({
    contextId: snapshot.contextId,
    occurrenceId: occurrenceId(snapshot),
    target: { expectedNotes: [expectedNote] },
    operations: [{ op: "delete", controlId: point.controlId, expectedFingerprint: point.fingerprint }],
  });
  assert.equal(ok.ok, true);
  assert.equal(model.controls.length, 0);

  // 音符被移动（pitch 改了）后，同一 expectedNotes 即 STALE_CONTEXT，零写入。
  model.notes[0].state.pitch = 72;
  const snapshot2 = await snapshotWithControls(snapshots);
  const point2 = snapshot2.data.pitchControls.find((c) => c.kind === "point");
  const result = await service.patch({
    contextId: snapshot2.contextId,
    occurrenceId: occurrenceId(snapshot2),
    target: { expectedNotes: [expectedNote] },
    operations: [
      { op: "add", control: { kind: "point", positionBlick: 2 * Q, pitchSemitone: 62 } },
    ],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "STALE_CONTEXT");
  assert.equal(model.undoCount, 2);
});

test("a verified write keeps effects:verified when post-commit processing observation fails", async () => {
  const { model, snapshots, service } = createFixture({
    controls: [],
    computedPitchValues: new Array(160).fill(null),
  });
  const snapshot = await snapshotWithControls(snapshots);
  // 提交与读回验证完成后，computed-pitch 观测失败只降级为 processing 子结果 + warning，
  // 绝不把已验证成功的写入误报为可重试失败（对齐 note-structure 的同类契约）。
  model.failures.push({
    method: "getComputedPitchForGroup",
    remainingSkips: 0,
    code: "HOST_TIMEOUT",
    message: "Timeout waiting for SynthV bridge",
  });
  const result = await service.patch({
    contextId: snapshot.contextId,
    occurrenceId: occurrenceId(snapshot),
    waitFor: "computedPitch",
    operations: [{ op: "add", control: { kind: "point", positionBlick: Q, pitchSemitone: 60 } }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "processing_observation_failed");
  assert.equal(result.effects, "verified");
  assert.equal(result.verification.passed, true);
  assert.ok(result.warnings.some((w) => w.code === "PROCESSING_OBSERVATION_FAILED"));
  assert.equal(model.controls.length, 1);
  assert.equal(model.undoCount, 2);
});

test("reorder during rollback restores the full pre-transaction set", async () => {
  // add 一个会重排的对象后 delete 失败：补偿删除新增后，被删对象经 clone 重加回组，
  // 最终 fingerprint 与事务前一致（含 scriptData），且索引重排不影响恢复正确性。
  const { model, snapshots, service } = createFixture({
    controls: [
      { kind: "point", position: 2 * Q, pitch: 62, scriptData: { note: "x" } },
    ],
  });
  const snapshot = await snapshotWithControls(snapshots);
  const point = byKind(snapshot, "point");
  model.failures.push({ method: "removePitchControl", remainingSkips: 0, code: "ARGUMENT_MISMATCH" });
  const result = await service.patch({
    contextId: snapshot.contextId,
    occurrenceId: occurrenceId(snapshot),
    operations: [
      { op: "add", control: { kind: "point", positionBlick: Q, pitchSemitone: 60 } },
      { op: "delete", controlId: point.controlId, expectedFingerprint: point.fingerprint },
    ],
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, "rolled_back");
  assert.equal(result.rollback.verified, true);
  const state = model.controlsSnapshot();
  assert.equal(state.length, 1);
  assert.equal(state[0].position, 2 * Q);
  assert.equal(state[0].scriptData["note"], "x");
});
