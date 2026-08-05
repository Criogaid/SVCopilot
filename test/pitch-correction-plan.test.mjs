import assert from "node:assert/strict";
import test from "node:test";

import { ArtifactStore } from "../server/src/artifact-store.js";
import { decodeDense, encodeDense } from "../server/src/dense-codec.js";
import { ParameterCurveService } from "../server/src/parameter-curve.js";
import { PlanExecutionLedger } from "../server/src/plan-ledger.js";
import {
  PitchCorrectionPlanService,
  solveBandedOpenLoopCorrection,
} from "../server/src/pitch-correction-plan.js";
import { SnapshotStore } from "../server/src/snapshot.js";
import { solveOpenLoopCorrection } from "../server/src/pitch-techniques/model.js";
import { createPitchHostModel } from "./helpers/pitch-host.mjs";

const Q = 705_600_000;
const SESSION_ID = "sess_pitch_correction";
const PITCH_PROVENANCE = Object.freeze({
  writeSurface: "pitchDelta",
  composition: "baseline_plus_contribution",
});

const TARGET_PROFILE = Object.freeze({
  schemaVersion: "1",
  kind: "pitch-technique-correction-target",
  maxRows: 4000,
  columns: Object.freeze([
    Object.freeze({ name: "frame", type: "integer", encoding: "delta" }),
    Object.freeze({
      name: "targetCent",
      unit: "cent",
      type: "number",
      encoding: "qint",
      scale: 1e-6,
      maxError: 5e-7,
    }),
  ]),
});

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function assertClose(actual, expected, tolerance = 1e-8) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
}

function makeSolverInput(length, random) {
  const observed = Array.from({ length }, (_, index) => 60 + index * 0.002 + random() * 0.01);
  const current = Array.from({ length }, () => -20 + random() * 40);
  const error = Array.from({ length }, () => -25 + random() * 50);
  return {
    targetAbsoluteCent: observed.map((midi, index) => midi * 100 + error[index]),
    observedComputedMidi: observed,
    currentPitchDeltaCent: current,
  };
}

test("five-diagonal correction solver agrees with the independent dense oracle through 2000 frames", () => {
  const random = seededRandom(0xc011_ec71);
  for (const length of [3, 4, 17, 127, 2000]) {
    const input = makeSolverInput(length, random);
    const options = {
      smoothnessLambda: random() * 10,
      magnitudeMu: 0.000001 + random(),
      dataWeight: 0.2 + random() * 4,
      minimumCoverage: 1,
      minimumRunFrames: 1,
      maxAbsCorrectionCent: 1e6,
    };
    const actual = solveBandedOpenLoopCorrection(input, options);
    const expected = solveOpenLoopCorrection(input, options);
    assert.deepEqual(actual.runs, expected.runs);
    for (let index = 0; index < length; index += 1) {
      assertClose(actual.correctionCent[index], expected.correctionCent[index], 2e-8);
    }
  }
});

test("solver rejects under-ranked inputs and enforces the public magnitudeMu floor", () => {
  const random = seededRandom(0x51a11e);
  for (const length of [1, 2]) {
    assert.throws(
      () => solveBandedOpenLoopCorrection(makeSolverInput(length, random), {
        minimumCoverage: 0,
        minimumRunFrames: 1,
        magnitudeMu: 0.000001,
      }),
      (error) => error.code === "INSUFFICIENT_COMPUTED_PITCH",
    );
  }
  assert.throws(
    () => solveBandedOpenLoopCorrection(makeSolverInput(3, random), {
      minimumCoverage: 1,
      minimumRunFrames: 1,
      magnitudeMu: 0.0000001,
    }),
    (error) => error.code === "INVALID_ARGUMENTS",
  );
});

test("solver remains finite at regularization extremes and fails numeric overflow explicitly", () => {
  const random = seededRandom(0xe71e0e);
  for (const [smoothnessLambda, magnitudeMu] of [[0, 0.000001], [100, 100]]) {
    const result = solveBandedOpenLoopCorrection(makeSolverInput(31, random), {
      smoothnessLambda,
      magnitudeMu,
      minimumCoverage: 1,
      minimumRunFrames: 1,
      maxAbsCorrectionCent: 1e6,
    });
    assert.ok(result.correctionCent.every(Number.isFinite));
  }
  assert.throws(
    () => solveBandedOpenLoopCorrection({
      targetAbsoluteCent: [6000, 6000, 6000],
      observedComputedMidi: [60, 60, 60],
      currentPitchDeltaCent: [Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE],
    }, {
      smoothnessLambda: 1,
      magnitudeMu: 0.000001,
      minimumCoverage: 1,
      minimumRunFrames: 1,
    }),
    (error) => error.code === "CORRECTION_NUMERIC_OVERFLOW",
  );
});

test("five-diagonal correction never couples finite runs across a null gap", () => {
  const input = {
    targetAbsoluteCent: [6000, 6010, 6020, null, 6100, 6110, 6120],
    observedComputedMidi: [59.9, 60, 60.1, null, 60.9, 61, 61.1],
    currentPitchDeltaCent: [0, 0, 0, null, 0, 0, 0],
  };
  const options = {
    smoothnessLambda: 8,
    magnitudeMu: 0.1,
    minimumCoverage: 0.8,
    minimumRunFrames: 3,
    maxAbsCorrectionCent: 200,
  };
  const first = solveBandedOpenLoopCorrection(input, options);
  const changedRight = solveBandedOpenLoopCorrection({
    ...input,
    targetAbsoluteCent: [6000, 6010, 6020, null, 6200, 6230, 6260],
  }, options);
  assert.deepEqual(first.runs, [
    { start: 0, endExclusive: 3 },
    { start: 4, endExclusive: 7 },
  ]);
  for (let index = 0; index < 3; index += 1) {
    assertClose(first.correctionCent[index], changedRight.correctionCent[index], 1e-10);
  }
  assert.equal(first.correctionCent[3], null);
});

function automation(points = []) {
  return {
    requestedParameter: "pitchDelta",
    resolvedParameter: "pitchDelta",
    definition: { typeName: "pitchDelta", range: [-1200, 1200], defaultValue: 0 },
    interpolationMethod: "linear",
    supportPoints: [],
    points: points.map(([localBlick, value]) => ({ localBlick, value })),
  };
}

function fingerprint(note, index) {
  return {
    indexInGroup: index,
    onsetBlick: note.onset,
    durationBlick: note.duration,
    pitch: note.pitch,
    lyrics: note.lyrics,
    phonemesOverride: "",
    languageOverride: "",
    detuneCents: 0,
  };
}

function sourceTarget(values) {
  return {
    schemaVersion: 2,
    encoding: "dense-table-v1",
    finiteFrames: values.filter(Number.isFinite).length,
    points: encodeDense(
      values.flatMap((targetCent, frame) => (
        Number.isFinite(targetCent) ? [{ frame, targetCent }] : []
      )),
      TARGET_PROFILE,
    ),
    grid: {
      timeGrid: "uniform_seconds",
      startSeconds: 0,
      sampleIntervalSeconds: 0.01,
      frames: values.length,
    },
  };
}

function markCommitted(artifactStore, artifactId) {
  const ledger = artifactStore.planLedger;
  ledger.noteDryRun(artifactId, { ownerInstanceId: SESSION_ID });
  ledger.beginCommit(artifactId, { ownerInstanceId: SESSION_ID });
  ledger.settle(artifactId, "succeeded", { ownerInstanceId: SESSION_ID });
}

function createFixture({
  sourceState = "committed",
  targetValues,
  observedValues,
  sourceRetainsTarget = true,
  sourceCurves = [{ parameter: "pitchDelta", mode: "replace" }],
  sourceProvenance = PITCH_PROVENANCE,
  sourceTargetGroupUuid = null,
  observedTargetGroupUuid = null,
} = {}) {
  const notes = [{ onset: 0, duration: Q, pitch: 60, lyrics: "a" }];
  const model = createPitchHostModel({ notes });
  const store = new SnapshotStore({ now: () => 1000 });
  const ledger = new PlanExecutionLedger({ now: () => 1000 });
  const artifactStore = new ArtifactStore({ now: () => 1000, planLedger: ledger });
  const noteFingerprints = notes.map(fingerprint);
  const sourceGroupUuid = sourceTargetGroupUuid ?? model.uuid;
  const observedGroupUuid = observedTargetGroupUuid ?? model.uuid;
  const stored = store.create({
    epoch: 1,
    scope: { kind: "range" },
    observedAt: new Date(1000).toISOString(),
    context: {
      kind: "range",
      quarterBlick: Q,
      tempoMarks: [{ positionBlick: 0, positionSeconds: 0, bpm: 60 }],
      automationCaptured: true,
      automationByOccurrence: { 0: [automation()] },
      computedPitchByOccurrence: {
        0: {
          startBlick: 0,
          intervalBlick: Q / 100,
          frames: observedValues.length,
          values: observedValues,
          evidence: {
            requestedFrames: observedValues.length,
            observedFrames: observedValues.filter(Number.isFinite).length,
            nullFrameIndices: observedValues.flatMap((value, index) => (
              Number.isFinite(value) ? [] : [index]
            )),
          },
        },
      },
      occurrences: [{
        occurrence: 0,
        trackIndex: 0,
        groupIndex: 0,
        targetGroupUuid: observedGroupUuid,
        timeOffsetBlick: 0,
        sharedTargetOccurrences: [],
        groupNoteCount: noteFingerprints.length,
        noteFingerprints,
      }],
    },
  });
  const source = artifactStore.seal({
    kind: "plan",
    schemaVersion: "1",
    sessionId: SESSION_ID,
    sourceEpoch: 1,
    payload: {
      targetTool: "sv_patch_parameter_curves",
      mutationRequest: {
        target: { expectedNotes: noteFingerprints },
        curves: sourceCurves,
      },
      capsule: {
        epoch: 1,
        context: {
          kind: "range",
          occurrences: [{
            occurrence: 0,
            targetGroupUuid: sourceGroupUuid,
            timeOffsetBlick: 0,
            sharedTargetOccurrences: [],
            groupNoteCount: noteFingerprints.length,
            noteFingerprints,
          }],
        },
      },
      pitchTechniques: {
        provenance: sourceProvenance,
        ...(sourceRetainsTarget ? { correctionTarget: sourceTarget(targetValues) } : {}),
      },
    },
  });
  if (sourceState === "committed") markCommitted(artifactStore, source.id);
  const service = new PitchCorrectionPlanService({ store, artifactStore, sessionId: SESSION_ID });
  const patch = new ParameterCurveService(
    { withExclusive: (task) => task(model.host) },
    { artifactStore, sessionId: SESSION_ID, now: () => 1000 },
  );
  return { model, stored, source, service, patch, artifactStore };
}

test("committed source plan produces a sealed one-step correction that dry-runs and commits in one Undo", async () => {
  const observedValues = [59.9, 59.9, 59.9, 59.9, 59.9];
  const targetValues = [6000, 6000, 6000, 6000, 6000];
  const { model, stored, source, service, patch, artifactStore } = createFixture({ targetValues, observedValues });
  const plan = await service.plan({
    sourcePlanRef: source.id,
    observedContextId: stored.contextId,
    evidence: { minimumCoverage: 1, minimumRunFrames: 3 },
    regularization: { smoothnessLambda: 0.4, magnitudeMu: 0.01, maxAbsCorrectionCent: 50 },
  });

  assert.equal(plan.status, "planned");
  assert.equal(plan.effects, "none");
  assert.equal(plan.data.iterationBasis, "single_open_loop_step");
  assert.ok(plan.data.objective.predictedRmseCent < plan.data.objective.beforeRmseCent * 0.05);
  assert.deepEqual(Object.keys(plan.apply.arguments).sort(), ["action", "planRef"]);
  assert.equal(model.undoCount, 0);
  assert.equal(model.automationPoints.length, 0);
  assert.equal(Object.hasOwn(plan.data, "dense"), false);

  const artifact = artifactStore.resolve({
    artifactId: plan.apply.arguments.planRef,
    expectedKind: "plan",
    sessionId: SESSION_ID,
  });
  assert.equal(artifact.payload.pitchCorrection.iterationBasis, "single_open_loop_step");
  assert.equal(artifact.payload.pitchCorrection.policy.maxTotalPoints, 4000);
  assert.equal(
    decodeDense(artifact.payload.pitchCorrection.dense.correctionCent).length,
    observedValues.length,
  );

  const dryRun = await patch.patchCurves(plan.apply.arguments);
  assert.equal(dryRun.status, "dry_run");
  assert.equal(model.undoCount, 0);

  const committed = await patch.patchCurves({ ...plan.apply.arguments, action: "commit" });
  assert.equal(committed.status, "succeeded");
  assert.equal(committed.undo.expectedUserUndoSteps, 1);
  assert.equal(model.undoCount, 2);
});

test("correction rejects an uncommitted source plan before creating a target plan", async () => {
  const { stored, source, service } = createFixture({
    sourceState: "sealed",
    targetValues: [6000, 6000, 6000],
    observedValues: [59.9, 59.9, 59.9],
  });
  await assert.rejects(
    service.plan({ sourcePlanRef: source.id, observedContextId: stored.contextId }),
    (error) => error.code === "PLAN_NOT_COMMITTED",
  );
});

test("low coverage returns a zero-write insufficient_evidence result", async () => {
  const { stored, source, service } = createFixture({
    targetValues: [6000, null, null, null],
    observedValues: [59.9, null, null, null],
  });
  const result = await service.plan({ sourcePlanRef: source.id, observedContextId: stored.contextId });
  assert.equal(result.status, "insufficient_evidence");
  assert.equal(result.effects, "none");
  assert.equal(result.apply, null);
  assert.equal(result.data.evidence.code, "INSUFFICIENT_COMPUTED_PITCH");
});

test("short finite runs return insufficient_evidence without creating a PlanRef", async () => {
  const { stored, source, service } = createFixture({
    targetValues: [6000, null, 6000, null, 6000],
    observedValues: [60, null, 60, null, 60],
  });
  const result = await service.plan({
    sourcePlanRef: source.id,
    observedContextId: stored.contextId,
    evidence: { minimumCoverage: 0, minimumRunFrames: 3 },
  });
  assert.equal(result.status, "insufficient_evidence");
  assert.equal(result.apply, null);
  assert.equal(result.data.evidence.reason, "NO_ELIGIBLE_FINITE_RUN");
  assert.equal(result.data.runs.skipped, 3);
});

test("zero projected correction returns no_change without a PlanRef", async () => {
  const { stored, source, service } = createFixture({
    targetValues: [6000, 6000, 6000],
    observedValues: [60, 60, 60],
  });
  const result = await service.plan({ sourcePlanRef: source.id, observedContextId: stored.contextId });
  assert.equal(result.status, "no_change");
  assert.equal(result.effects, "none");
  assert.equal(result.apply, null);
  assert.equal(result.data.correction.points, 0);
});

test("source and observed guards reject missing retention, non-additive plans, identity drift, and bad sampling provenance", async () => {
  const values = [6000, 6000, 6000];
  const observed = [59.9, 59.9, 59.9];
  const absent = createFixture({ targetValues: values, observedValues: observed, sourceRetainsTarget: false });
  await assert.rejects(
    absent.service.plan({ sourcePlanRef: absent.source.id, observedContextId: absent.stored.contextId }),
    (error) => error.code === "CORRECTION_TARGET_NOT_RETAINED",
  );

  const vibrato = createFixture({
    targetValues: values,
    observedValues: observed,
    sourceCurves: [{ parameter: "vibratoEnv", mode: "replace" }],
  });
  await assert.rejects(
    vibrato.service.plan({ sourcePlanRef: vibrato.source.id, observedContextId: vibrato.stored.contextId }),
    (error) => error.code === "CORRECTION_TARGET_UNAVAILABLE",
  );

  const mismatch = createFixture({
    targetValues: values,
    observedValues: observed,
    sourceTargetGroupUuid: "uuid_source_only",
  });
  await assert.rejects(
    mismatch.service.plan({ sourcePlanRef: mismatch.source.id, observedContextId: mismatch.stored.contextId }),
    (error) => error.code === "PLAN_TARGET_MISMATCH",
  );

  const ambiguous = createFixture({ targetValues: values, observedValues: observed });
  ambiguous.stored.context.occurrences.push({
    ...ambiguous.stored.context.occurrences[0],
    occurrence: 1,
  });
  await assert.rejects(
    ambiguous.service.plan({ sourcePlanRef: ambiguous.source.id, observedContextId: ambiguous.stored.contextId }),
    (error) => error.code === "AMBIGUOUS_PLAN_TARGET"
      && error.details.candidateOrdinals.join(",") === "0,1",
  );

  const badEvidence = createFixture({ targetValues: values, observedValues: observed });
  badEvidence.stored.context.computedPitchByOccurrence[0].evidence.observedFrames = 0;
  await assert.rejects(
    badEvidence.service.plan({ sourcePlanRef: badEvidence.source.id, observedContextId: badEvidence.stored.contextId }),
    (error) => error.code === "COMPUTED_PITCH_NOT_CAPTURED",
  );
});

test("slope policy rejects a projected curve before it becomes a PlanRef", async () => {
  const { stored, source, service } = createFixture({
    targetValues: [5950, 6050, 5950],
    observedValues: [60, 60, 60],
  });
  await assert.rejects(
    service.plan({
      sourcePlanRef: source.id,
      observedContextId: stored.contextId,
      evidence: { minimumCoverage: 1, minimumRunFrames: 3 },
      regularization: { smoothnessLambda: 0, magnitudeMu: 0.01, maxAbsCorrectionCent: 50 },
    }),
    (error) => error.code === "CORRECTION_SLOPE_LIMIT"
      && error.details.policyVersion === "pitch-correction-policy-v1",
  );
});

test("large correction plans keep dense evidence out of the public response", async () => {
  const frames = 2000;
  const { stored, source, service, artifactStore } = createFixture({
    targetValues: Array(frames).fill(6000),
    observedValues: Array(frames).fill(59.9),
  });
  const plan = await service.plan({
    sourcePlanRef: source.id,
    observedContextId: stored.contextId,
    evidence: { minimumCoverage: 1, minimumRunFrames: 3 },
  });
  assert.equal(plan.status, "planned");
  assert.ok(Buffer.byteLength(JSON.stringify(plan), "utf8") < 16 * 1024);
  const artifact = artifactStore.resolve({
    artifactId: plan.apply.arguments.planRef,
    expectedKind: "plan",
    sessionId: SESSION_ID,
  });
  assert.equal(
    decodeDense(artifact.payload.pitchCorrection.dense.targetAbsoluteCent).length,
    frames,
  );
});
