import assert from "node:assert/strict";
import test from "node:test";

import {
  EXPRESSION_PLAN_DEFAULTS,
  ExpressionPlanService,
} from "../server/src/expression-plan.js";
import { normalizeCurveInput, normalizeTarget } from "../server/src/parameter-curve.js";
import { SnapshotStore } from "../server/src/snapshot.js";
import {
  allSealedPlannerRequests,
  createPlannerService,
} from "./helpers/planner-artifact-fixture.mjs";

const Q = 705_600_000;

function createStore() {
  return new SnapshotStore({ now: () => 1000 });
}

function createStoredContext(store, options = {}) {
  const {
    notes = [
      { onsetBlick: 0, durationBlick: Q, pitch: 60, lyrics: "a" },
      { onsetBlick: Q, durationBlick: Q, pitch: 62, lyrics: "i" },
      { onsetBlick: 2 * Q, durationBlick: Q, pitch: 64, lyrics: "u" },
    ],
    sharedTargetOccurrences = [0],
  } = options;
  const stored = store.create({
    epoch: 1,
    scope: { kind: "range" },
    observedAt: new Date(1000).toISOString(),
    context: {
      kind: "range",
      quarterBlick: Q,
      meterMarks: [{ position: 0, positionBlick: 0, numerator: 4, denominator: 4 }],
      tempoMarks: [{ positionBlick: 0, positionSeconds: 0, bpm: 120 }],
      occurrences: [
        {
          occurrence: 0,
          trackIndex: 0,
          groupIndex: 0,
          targetGroupUuid: "uuid-expression",
          timeOffsetBlick: 0,
          groupNoteCount: notes.length,
          sharedTargetOccurrences,
          noteFingerprints: notes.map((note, index) => ({
            indexInGroup: index,
            onsetBlick: note.onsetBlick,
            durationBlick: note.durationBlick,
            pitch: note.pitch,
            lyrics: note.lyrics ?? `n${index}`,
            phonemesOverride: "",
            languageOverride: "",
            detuneCents: 0,
          })),
        },
      ],
    },
  });
  return stored;
}

function createService(store) {
  return createPlannerService(ExpressionPlanService, { store });
}

function sealedRequest(plan) {
  const [request] = allSealedPlannerRequests(plan);
  return request.arguments;
}

function assertNonPitchRequest(request) {
  assert.equal(request.action, "dry_run");
  assert.equal(request.atomic, true);
  const target = normalizeTarget(request.target);
  assert.equal(target.expectedGroupUuid, "uuid-expression");
  for (const curve of request.curves) {
    const normalized = normalizeCurveInput(curve);
    assert.ok(["loudness", "tension", "breathiness", "voicing", "gender"].includes(normalized.parameter));
    assert.notEqual(normalized.parameter, "pitchDelta");
    assert.notEqual(normalized.parameter, "vibratoEnv");
  }
}

test("explicit hairpin compiles only non-pitch Automation curves into one PlanRef", async () => {
  const store = createStore();
  const stored = createStoredContext(store);
  const plan = await createService(store).plan({
    contextId: stored.contextId,
    occurrence: 0,
    gestures: [
      {
        type: "hairpin",
        from: 0,
        to: 2,
        peak: 0.6,
        amounts: { loudness: 3, tension: 0.12, voicing: -0.1, gender: 0.1 },
      },
    ],
  });

  assert.equal(plan.status, "planned");
  assert.equal(plan.apply.tool, "sv_patch_parameter_curves");
  assert.equal(plan.apply.arguments.action, "dry_run");
  assert.deepEqual(plan.summary.parameters, ["gender", "loudness", "tension", "voicing"]);
  assertNonPitchRequest(sealedRequest(plan));
});

test("expression has no compatibility aliases for migrated pitch techniques", async () => {
  const store = createStore();
  const stored = createStoredContext(store);
  const service = createService(store);
  for (const gesture of [
    { type: "scoop", targets: [[0, 20]] },
    { type: "fall", targets: [[0, 20]] },
    { type: "portamento", transitions: [[0, 1]] },
    { type: "vibrato", notes: [1] },
  ]) {
    await assert.rejects(
      service.plan({ contextId: stored.contextId, occurrence: 0, gestures: [gesture] }),
      (error) => error.code === "INVALID_ARGUMENTS",
    );
  }
});

test("hairpin rejects pitchDelta and removed defaults fields", async () => {
  const store = createStore();
  const stored = createStoredContext(store);
  const service = createService(store);
  await assert.rejects(
    service.plan({
      contextId: stored.contextId,
      occurrence: 0,
      gestures: [{ type: "hairpin", from: 0, to: 1, amounts: { pitchDelta: 20 } }],
    }),
    (error) => error.code === "INVALID_ARGUMENTS",
  );
  await assert.rejects(
    service.plan({
      contextId: stored.contextId,
      occurrence: 0,
      defaults: {},
      gestures: [{ type: "hairpin", from: 0, to: 1, amounts: { loudness: 1 } }],
    }),
    (error) => error.code === "INVALID_ARGUMENTS",
  );
});

test("jpop intent gives pitch-planner guidance without generating a pitch operation", async () => {
  const store = createStore();
  const stored = createStoredContext(store);
  const plan = await createService(store).plan({
    contextId: stored.contextId,
    occurrence: 0,
    intent: { genre: "jpop" },
  });

  assert.equal(plan.status, "no_change");
  assert.equal(plan.apply, null);
  assert.equal(plan.summary.operationCount, 0);
  const warning = plan.warnings.find((item) => item.code === "PITCH_TECHNIQUE_DELEGATED");
  assert.equal(warning.tool, "sv_plan_pitch_gesture");
});

test("controlled_belt keeps color arcs but delegates vibrato", async () => {
  const store = createStore();
  const stored = createStoredContext(store);
  const plan = await createService(store).plan({
    contextId: stored.contextId,
    occurrence: 0,
    intent: { technique: ["controlled_belt"] },
  });

  assert.equal(plan.status, "planned");
  assert.ok(plan.summary.parameters.includes("loudness"));
  assert.ok(plan.summary.parameters.includes("tension"));
  assert.equal(plan.summary.parameters.includes("pitchDelta"), false);
  assert.equal(plan.summary.parameters.includes("vibratoEnv"), false);
  assert.equal(plan.warnings.some((item) => item.code === "PITCH_TECHNIQUE_DELEGATED"), true);
  assertNonPitchRequest(sealedRequest(plan));
});

test("spoken preset returns explicit delegation guidance with zero write", async () => {
  const store = createStore();
  const stored = createStoredContext(store);
  const plan = await createService(store).plan({
    contextId: stored.contextId,
    occurrence: 0,
    intent: { preset: "spoken_rap_transition" },
  });

  assert.equal(plan.status, "no_change");
  assert.equal(plan.summary.operationCount, 0);
  assert.equal(plan.warnings.some((item) => item.code === "PITCH_TECHNIQUE_DELEGATED"), true);
});

test("non-pitch plans remain deterministic and retain shared-target review", async () => {
  const store = createStore();
  const stored = createStoredContext(store, { sharedTargetOccurrences: [0, 3] });
  const service = createService(store);
  const request = {
    contextId: stored.contextId,
    occurrence: 0,
    gestures: [{ type: "hairpin", from: 0, to: 2, amounts: { breathiness: 0.1 } }],
  };
  const first = await service.plan(request);
  const second = await service.plan(request);

  assert.equal(first.planId, second.planId);
  assert.equal(first.review.requiresSharedTargetConfirmation, true);
  assert.equal(first.apply.requiresSharedTargetConfirmation, true);
  assert.deepEqual(EXPRESSION_PLAN_DEFAULTS.constraints, {
    maxAbsLoudnessDeltaDb: 6,
    maxAbsTensionDelta: 0.5,
    maxAbsBreathinessDelta: 0.5,
    maxTotalPoints: 400,
  });
});
