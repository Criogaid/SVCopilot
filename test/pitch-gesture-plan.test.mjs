import assert from "node:assert/strict";
import test from "node:test";

import { ArtifactStore } from "../server/src/artifact-store.js";
import { ParameterCurveService, normalizeCurveInput } from "../server/src/parameter-curve.js";
import { PitchGesturePlanService } from "../server/src/pitch-gesture-plan.js";
import { SnapshotStore } from "../server/src/snapshot.js";
import { createPitchHostModel } from "./helpers/pitch-host.mjs";

const Q = 705_600_000;

const DEFAULT_NOTES = Object.freeze([
  { onset: 0, duration: Q, pitch: 60, lyrics: "a" },
  { onset: Q, duration: Q, pitch: 62, lyrics: "i" },
  { onset: 2 * Q, duration: 4 * Q, pitch: 64, lyrics: "u" },
]);

function confirmedVibratoProfile() {
  return {
    profileHash: "profile_confirmed_vibrato",
    semantics: {
      "vibrato.hostEnvelopeWithExplicitPitchDelta": {
        status: "confirmed",
        value: {
          hostEnvelope: "baseline_scale",
          explicitPitchDelta: { vibratoEnv: { mode: "replace", value: 0 } },
        },
      },
    },
  };
}

function automation(parameter, points = []) {
  const definition = parameter === "vibratoEnv"
    ? { typeName: "vibratoEnv", range: [0, 2], defaultValue: 1 }
    : { typeName: "pitchDelta", range: [-1200, 1200], defaultValue: 0 };
  return {
    requestedParameter: parameter,
    resolvedParameter: parameter,
    definition,
    interpolationMethod: "linear",
    supportPoints: [],
    points: points.map(([localBlick, value]) => ({ localBlick, value })),
  };
}

function noteFingerprint(note, index) {
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

function createFixture({
  notes = DEFAULT_NOTES,
  includeVibratoEnv = true,
  hostProfile = null,
  pitchDeltaPoints = [],
} = {}) {
  const model = createPitchHostModel({ notes, automationPoints: pitchDeltaPoints });
  const store = new SnapshotStore({ now: () => 1000 });
  const artifactStore = new ArtifactStore({ now: () => 1000 });
  const fingerprints = notes.map(noteFingerprint);
  const stored = store.create({
    epoch: 1,
    scope: { kind: "range" },
    observedAt: new Date(1000).toISOString(),
    context: {
      kind: "range",
      quarterBlick: Q,
      tempoMarks: [{ positionBlick: 0, positionSeconds: 0, bpm: 120 }],
      automationCaptured: true,
      automationByOccurrence: {
        0: [
          automation("pitchDelta", pitchDeltaPoints),
          ...(includeVibratoEnv ? [automation("vibratoEnv")] : []),
        ],
      },
      occurrences: [
        {
          occurrence: 0,
          trackIndex: 0,
          groupIndex: 0,
          targetGroupUuid: model.uuid,
          timeOffsetBlick: 0,
          sharedTargetOccurrences: [],
          groupNoteCount: fingerprints.length,
          noteFingerprints: fingerprints,
        },
      ],
    },
  });
  const sessionId = "sess_pitch_gesture";
  const planner = new PitchGesturePlanService({
    store,
    artifactStore,
    sessionId,
    now: () => 1000,
    hostProfile,
  });
  const patch = new ParameterCurveService(
    { withExclusive: (task) => task(model.host) },
    { artifactStore, sessionId, now: () => 1000 },
  );
  const sealed = (plan) => artifactStore.resolve({
    artifactId: plan.apply.arguments.planRef,
    expectedKind: "plan",
    sessionId,
  }).payload;
  return { model, store, stored, planner, patch, sealed };
}

function transition(from = 0, to = 1) {
  return {
    type: "transition",
    from,
    to,
    width: { seconds: 0.2 },
    curve: { family: "linear" },
  };
}

test("transition seals a compact ParameterCurve PlanRef and commits through the verified transaction", async () => {
  const { model, stored, planner, patch, sealed } = createFixture();
  const plan = await planner.plan({
    contextId: stored.contextId,
    occurrence: 0,
    gestures: [transition()],
  });

  assert.equal(plan.status, "planned");
  assert.equal(plan.effects, "none");
  assert.match(plan.planId, /^plan_[A-Fa-f0-9]{16}$/);
  assert.equal(plan.review.requiresHumanAudition, true);
  assert.equal(plan.apply.tool, "sv_patch_parameter_curves");
  assert.deepEqual(Object.keys(plan.apply.arguments).sort(), ["action", "planRef"]);
  assert.equal(Object.hasOwn(plan, "curves"), false);

  const payload = sealed(plan);
  assert.equal(payload.targetTool, "sv_patch_parameter_curves");
  assert.equal(payload.mutationRequest.curves.length, 1);
  const curve = normalizeCurveInput(payload.mutationRequest.curves[0]);
  assert.equal(curve.parameter, "pitchDelta");
  assert.equal(curve.mode, "replace");
  assert.ok(curve.hostInterpolation);
  assert.ok(curve.points.length >= 2);

  const dryRun = await patch.patchCurves(plan.apply.arguments);
  assert.equal(dryRun.status, "dry_run");
  assert.equal(model.undoCount, 0);
  assert.equal(model.automationPoints.length, 0);

  const committed = await patch.patchCurves({ ...plan.apply.arguments, action: "commit" });
  assert.equal(committed.status, "succeeded");
  assert.equal(committed.effects, "verified");
  assert.equal(committed.undo.expectedUserUndoSteps, 1);
  assert.ok(model.automationPoints.length >= 2);
});

test("transition rejects the old surface and invalid same-note selection", async () => {
  const { stored, planner } = createFixture();
  await assert.rejects(
    planner.plan({
      contextId: stored.contextId,
      occurrence: 0,
      gestures: [{ type: "attack", note: 0 }],
    }),
    (error) => error.code === "INVALID_ARGUMENTS",
  );
  await assert.rejects(
    planner.plan({
      contextId: stored.contextId,
      occurrence: 0,
      gestures: [transition(0, 0)],
    }),
    (error) => error.code === "INVALID_ARGUMENTS",
  );
});

test("transient compiles its first-peak model and rejects an undamped non-taper tail", async () => {
  const { stored, planner, sealed } = createFixture();
  const plan = await planner.plan({
    contextId: stored.contextId,
    occurrence: 0,
    gestures: [
      {
        type: "transient",
        note: 1,
        intent: "overshoot",
        peakSemitone: 0.2,
        peakTimeSeconds: 0.05,
        spanSeconds: 0.24,
        tailPolicy: "continuous_taper",
      },
    ],
  });
  assert.equal(plan.status, "planned");
  assert.equal(sealed(plan).pitchTechniques.ir.techniques[0].model.family, "first_peak_transient");

  await assert.rejects(
    planner.plan({
      contextId: stored.contextId,
      occurrence: 0,
      gestures: [
        {
          type: "transient",
          note: 1,
          intent: "preparation",
          peakSemitone: -0.15,
          peakTimeSeconds: 0.05,
          spanSeconds: 0.2,
          dampingRatio: 0,
        },
      ],
    }),
    (error) => error.code === "UNDAMPED_TAIL_REQUIRES_TAPER",
  );
});

test("both vibrato discriminators compile only after confirmed H2 evidence", async () => {
  const { stored, planner: blockedPlanner } = createFixture();
  const explicit = {
    type: "vibrato",
    source: "explicit_pitch_delta",
    note: 2,
    startRatio: 0.1,
    endRatio: 0.7,
    rateHz: 5,
    depthSemitone: 0.2,
    fadeInSeconds: 0.1,
    fadeOutSeconds: 0.1,
  };
  await assert.rejects(
    blockedPlanner.plan({ contextId: stored.contextId, occurrence: 0, gestures: [explicit] }),
    (error) => error.code === "HOST_SEMANTIC_UNCONFIRMED",
  );

  const fixture = createFixture({ hostProfile: confirmedVibratoProfile() });
  const explicitPlan = await fixture.planner.plan({
    contextId: fixture.stored.contextId,
    occurrence: 0,
    gestures: [explicit],
  });
  const explicitParameters = fixture.sealed(explicitPlan).mutationRequest.curves
    .map((curve) => curve.parameter)
    .sort();
  assert.deepEqual(explicitParameters, ["pitchDelta", "vibratoEnv"]);
  const irModel = fixture.sealed(explicitPlan).pitchTechniques.ir.techniques[0].model;
  assert.equal(irModel.endRateHz, 5);
  assert.equal(irModel.endDepthSemitone, 0.2);

  const hostPlan = await fixture.planner.plan({
    contextId: fixture.stored.contextId,
    occurrence: 0,
    gestures: [{ type: "vibrato", source: "host_envelope", note: 2, envelopeScale: 0.5 }],
  });
  assert.deepEqual(
    fixture.sealed(hostPlan).mutationRequest.curves.map((curve) => curve.parameter),
    ["vibratoEnv"],
  );
});

test("vibrato relationships and missing vibratoEnv capture fail before any plan exists", async () => {
  const badRatio = createFixture({ hostProfile: confirmedVibratoProfile() });
  await assert.rejects(
    badRatio.planner.plan({
      contextId: badRatio.stored.contextId,
      occurrence: 0,
      gestures: [{ type: "vibrato", source: "host_envelope", note: 2, startRatio: 0.8, endRatio: 0.8 }],
    }),
    (error) => error.code === "INVALID_ARGUMENTS",
  );

  const missingCapture = createFixture({
    hostProfile: confirmedVibratoProfile(),
    includeVibratoEnv: false,
  });
  await assert.rejects(
    missingCapture.planner.plan({
      contextId: missingCapture.stored.contextId,
      occurrence: 0,
      gestures: [{ type: "vibrato", source: "host_envelope", note: 2, envelopeScale: 0.5 }],
    }),
    (error) => {
      assert.equal(error.code, "CAPTURE_EVIDENCE_REQUIRED");
      assert.deepEqual(error.details.remediation.automationParameters, ["pitchDelta", "vibratoEnv"]);
      return true;
    },
  );
});

test("breath targets become a zero-write no_change plan", async () => {
  const fixture = createFixture({
    notes: [{ onset: 0, duration: Q, pitch: 60, lyrics: "br" }],
  });
  const plan = await fixture.planner.plan({
    contextId: fixture.stored.contextId,
    occurrence: 0,
    gestures: [{
      type: "transient",
      note: 0,
      intent: "overshoot",
      peakSemitone: 0.2,
      peakTimeSeconds: 0.04,
      spanSeconds: 0.2,
    }],
  });
  assert.equal(plan.status, "no_change");
  assert.equal(plan.apply, null);
  assert.equal(plan.data.curves, 0);
  assert.equal(plan.warnings[0].code, "NON_MELODIC_SPECIAL_EVENT_SKIPPED");
});

test("identical pitch requests produce the same sealed mutation payload", async () => {
  const fixture = createFixture();
  const request = {
    contextId: fixture.stored.contextId,
    occurrence: 0,
    gestures: [transition()],
  };
  const first = await fixture.planner.plan(request);
  const second = await fixture.planner.plan(request);
  assert.equal(
    JSON.stringify(fixture.sealed(first).mutationRequest),
    JSON.stringify(fixture.sealed(second).mutationRequest),
  );
});
