import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  compileHostBehaviorProfile,
  computedPitchScenarioFromProfile,
  diffHostBehaviorProfiles,
  hostBehaviorProfileEvidenceSha256,
  summarizeHostSemanticStatuses,
  validateHostBehaviorProfile,
} from "../tools/lib/host-behavior-profile.mjs";
import { blickAtSeconds, secondsAtBlick } from "../server/src/musical-time.js";
import {
  createTimeAxisProbePlan,
  evaluateTimeAxisProbe,
} from "../tools/lib/time-axis-evidence.mjs";
import { createPitchHostModel } from "./helpers/pitch-host.mjs";

const FIXTURE_URL = new URL(
  "./fixtures/host-profiles/synthv-2.2.1-win32-v2.json",
  import.meta.url
);
const T04_EVIDENCE_URL = new URL(
  "../docs/pitch-techniques/evidence/T04-host-pitch-live.json",
  import.meta.url
);
const T04_H2_EVIDENCE_URL = new URL(
  "../docs/pitch-techniques/evidence/T04-h2-vibrato-finite-live.json",
  import.meta.url
);

function timeAxisReport(scenario, tempoMarks, shiftSeconds = 0) {
  const plan = createTimeAxisProbePlan({
    scenario,
    quarterBlick: 1000,
    durationBlick: 240000,
    tempoMarks,
  });
  return evaluateTimeAxisProbe({
    scenario,
    quarterBlick: plan.quarterBlick,
    durationBlick: plan.durationBlick,
    tempoMarks: plan.tempoMarks,
    samples: plan.positions.map((blick) => {
      const hostSeconds = secondsAtBlick(plan.tempoMarks, plan.quarterBlick, blick) + shiftSeconds;
      return {
        blick,
        hostSeconds,
        hostBlickFromSeconds: blickAtSeconds(plan.tempoMarks, plan.quarterBlick, hostSeconds),
      };
    }),
  });
}

function completeTimeAxisReports(shiftSeconds = 0) {
  return [
    timeAxisReport("constant", [{ positionBlick: 0, positionSeconds: 0, bpm: 120 }], shiftSeconds),
    timeAxisReport("tempo_step", [
      { positionBlick: 0, positionSeconds: 0, bpm: 120 },
      { positionBlick: 120000, positionSeconds: 60, bpm: 90 },
    ], shiftSeconds),
    timeAxisReport("dense_tempo", [
      { positionBlick: 0, positionSeconds: 0, bpm: 120 },
      { positionBlick: 60000, positionSeconds: 30, bpm: 100 },
      { positionBlick: 120000, positionSeconds: 66, bpm: 140 },
    ], shiftSeconds),
  ];
}

function syntheticProbeEvidence() {
  const sensitiveUuid = "secret-target-uuid";
  return {
    hostEnvelope: {
      ok: true,
      result: {
        protocolVersion: 1,
        readOnly: true,
        quarterBlick: 705600000,
        projectFileName: "C:\\Private\\Secret Song.svp",
        hostInfo: {
          osType: "Windows",
          hostName: "Synthesizer V Studio 2 Pro",
          hostVersion: "2.2.1",
          hostVersionNumber: 131585,
        },
      },
    },
    groupsEnvelope: {
      ok: true,
      result: {
        groups: [
          {
            trackIndex: 6,
            trackName: "Private Lead",
            groupIndex: 1,
            groupName: "Secret Verse",
            targetGroupUuid: sensitiveUuid,
            noteCount: 2,
            referenceOnsetBlick: 90,
            referenceEndBlick: 500,
            timeOffsetBlick: 100,
            pitchOffset: 0,
            targetFirstNoteOnsetBlick: 0,
            targetLastNoteEndBlick: 400,
          },
          {
            trackIndex: 7,
            trackName: "Private Double",
            groupIndex: 0,
            groupName: "Secret Verse",
            targetGroupUuid: sensitiveUuid,
            noteCount: 2,
            referenceOnsetBlick: 200,
            referenceEndBlick: 600,
            timeOffsetBlick: 200,
            pitchOffset: 0,
            targetFirstNoteOnsetBlick: 0,
            targetLastNoteEndBlick: 400,
          },
        ],
      },
    },
    pitchEnvelope: {
      ok: true,
      repeat: 2,
      observations: [
        pitchObservation(1000, 0),
        pitchObservation(1000, 0),
      ],
    },
  };
}

function pitchObservation(officialStart, legacyStart) {
  return {
    ok: true,
    result: {
      startsAreEqual: officialStart === legacyStart,
      officialAbsolute: allNullPitch(officialStart),
      legacySubtractOffset: allNullPitch(legacyStart),
    },
  };
}

function allNullPitch(startBlick) {
  return {
    startBlick,
    intervalBlick: 100,
    requestedFrames: 160,
    rawLuaLength: 0,
    rawKeyCount: 0,
    rawNumericKeyCount: 0,
    highestNumericKey: 0,
    numericCount: 0,
    nullCount: 160,
    firstNumericIndex: null,
    lastNumericIndex: null,
    min: null,
    max: null,
  };
}

async function loadFixture() {
  return validateHostBehaviorProfile(JSON.parse(await readFile(FIXTURE_URL, "utf8")));
}

async function loadT04Evidence() {
  return JSON.parse(await readFile(T04_EVIDENCE_URL, "utf8"));
}

async function loadT04H2Evidence() {
  return JSON.parse(await readFile(T04_H2_EVIDENCE_URL, "utf8"));
}

test("read-only probe evidence compiles into a strict de-identified profile", () => {
  const profile = compileHostBehaviorProfile({
    ...syntheticProbeEvidence(),
    capturedAt: "2026-07-28T00:00:00.000Z",
  });
  assert.equal(profile.constants.quarterBlick, 705600000);
  assert.equal(
    profile.semantics["occurrence.referenceBoundsIndependentOfNoteBounds"].status,
    "confirmed"
  );
  assert.equal(profile.semantics["computedPitch.coordinateSpace"].status, "unknown");
  assert.equal(profile.semantics["computedPitch.pendingRepresentation"].value, "requested_length_null_array");
  assert.equal(profile.semantics["pitchControl.clone.deepPoints"].status, "not_observable");
  assert.equal(profile.semantics["timeAxis.nodeParityMaxDeviationSeconds"].status, "unknown");
  assert.equal(
    profile.semantics["automation.interpolationSetterAvailability"].value,
    "unavailable"
  );

  const serialized = JSON.stringify(profile);
  for (const secret of [
    "Secret Song",
    "Private Lead",
    "Private Double",
    "Secret Verse",
    "secret-target-uuid",
    "projectFileName",
    "trackName",
    "groupName",
    "targetGroupUuid",
  ]) {
    assert.equal(serialized.includes(secret), false, `profile leaked ${secret}`);
  }
});

test("v2 profile binds full replayable TimeAxis evidence to a terminal H1 fact", () => {
  const profile = compileHostBehaviorProfile({
    ...syntheticProbeEvidence(),
    timeAxisReports: completeTimeAxisReports(),
    capturedAt: "2026-08-03T00:00:00.000Z",
  });
  const parity = profile.semantics["timeAxis.nodeParityMaxDeviationSeconds"];
  assert.equal(parity.status, "confirmed");
  assert.equal(parity.value, 0);
  assert.deepEqual(parity.evidenceIds, ["EV-TIME-AXIS-H1-1"]);
  assert.equal(profile.semantics["timeAxis.tempoRampSupported"].status, "unknown");
  const evidence = profile.evidence.find((item) => item.id === "EV-TIME-AXIS-H1-1");
  assert.equal(evidence.timeAxis.coverage.completeRequiredScenarios, true);
  assert.equal(evidence.timeAxis.t03Disposition, "not_required");
});

test("v2 profiles preserve unknown, partial, confirmed, and contradicted H1 states", async () => {
  const unobserved = compileHostBehaviorProfile({
    ...syntheticProbeEvidence(),
    capturedAt: "2026-08-03T00:00:00.000Z",
  });
  const partial = compileHostBehaviorProfile({
    ...syntheticProbeEvidence(),
    timeAxisReports: [
      timeAxisReport("constant", [{ positionBlick: 0, positionSeconds: 0, bpm: 120 }]),
    ],
    capturedAt: "2026-08-03T00:00:00.000Z",
  });
  const confirmed = compileHostBehaviorProfile({
    ...syntheticProbeEvidence(),
    timeAxisReports: completeTimeAxisReports(),
    capturedAt: "2026-08-03T00:00:00.000Z",
  });
  const contradicted = compileHostBehaviorProfile({
    ...syntheticProbeEvidence(),
    timeAxisReports: completeTimeAxisReports(1e-4),
    capturedAt: "2026-08-03T00:00:00.000Z",
  });
  const key = "timeAxis.nodeParityMaxDeviationSeconds";
  assert.equal(unobserved.semantics[key].status, "unknown");
  assert.equal(partial.semantics[key].status, "partially_observed");
  assert.equal(confirmed.semantics[key].status, "confirmed");
  assert.equal(contradicted.semantics[key].status, "contradicted");
});

test("profile compilation rejects probe evidence that is not explicitly read-only", () => {
  const evidence = syntheticProbeEvidence();
  evidence.hostEnvelope.result.readOnly = false;
  assert.throws(
    () => compileHostBehaviorProfile(evidence),
    (error) =>
      error.code === "INVALID_HOST_PROFILE" &&
      /must declare readOnly:true/.test(error.message)
  );
});

test("profile validation rejects unknown fields and optimistic values on unknown facts", async () => {
  const profile = structuredClone(await loadFixture());
  profile.semantics["pitchControl.ordering"].value = "position_then_insertion";
  assert.throws(
    () => validateHostBehaviorProfile(profile),
    (error) => error.code === "INVALID_HOST_PROFILE" && /forbidden unless observed/.test(error.message)
  );

  const extra = structuredClone(await loadFixture());
  extra.projectFileName = "C:\\Private\\song.svp";
  assert.throws(
    () => validateHostBehaviorProfile(extra),
    (error) => error.code === "INVALID_HOST_PROFILE"
  );
});

test("profile validation rejects semantic edits that retain a stale evidence digest", async () => {
  const profile = structuredClone(await loadFixture());
  profile.semantics["occurrence.referenceBoundsIndependentOfNoteBounds"].value = false;
  assert.throws(
    () => validateHostBehaviorProfile(profile),
    (error) =>
      error.code === "INVALID_HOST_PROFILE" &&
      /does not match the profile evidence/.test(error.message)
  );
});

test("profile evidence digest helper matches a validated fixture", async () => {
  const profile = await loadFixture();
  assert.equal(hostBehaviorProfileEvidenceSha256(profile), profile.evidenceSha256);
});

test("T04 confirms only the finite-frame H2 host gate", async () => {
  const [profile, evidence, h2Evidence] = await Promise.all([
    loadFixture(),
    loadT04Evidence(),
    loadT04H2Evidence(),
  ]);
  assert.equal(evidence.kind, "svcopilot-host-pitch-evidence");
  assert.equal(evidence.fixture.sourceGroupMutated, false);
  assert.equal(evidence.fixture.recovery.fullRangeContentTokenMatched, true);
  assert.equal(evidence.fixture.handles.exportedReleaseSucceeded, 13);
  assert.equal(evidence.fixture.handles.storedRawCleanupReleaseSucceeded, 83);
  assert.equal(evidence.results.H2.matrix.length, 6);
  assert.equal(evidence.results.H4.samples.length, 13);
  assert.equal(evidence.results.H4.family, "piecewise_linear");
  assert.equal(
    profile.semantics["pitchControl.getValueAtInterpolationFamily"].status,
    "confirmed"
  );
  assert.equal(
    profile.semantics["pitchSurfaces.absoluteMidiToGroupCurveTransform"].status,
    "partially_observed"
  );
  assert.equal(
    profile.semantics["vibrato.hostEnvelopeWithExplicitPitchDelta"].status,
    "confirmed"
  );
  assert.deepEqual(
    profile.semantics["vibrato.hostEnvelopeWithExplicitPitchDelta"].value,
    h2Evidence.conclusion.value
  );
  assert.equal(h2Evidence.matrix.caseCount, 8);
  assert.equal(h2Evidence.conclusion.semantic, "vibrato.hostEnvelopeWithExplicitPitchDelta");
  assert.equal(profile.semantics["vibrato.hostEnvelopeWithExplicitPitchControl"].status, "unknown");
  assert.equal(profile.semantics["vibrato.noteModulationInteraction"].status, "unknown");
  assert.equal(profile.semantics["computedPitch.recomputeLatency"].status, "unknown");
  assert.equal(profile.semantics["undo.multiCandidateSingleBoundary"].status, "unknown");
});

test("confirmed semantics require evidence and a supported value", async () => {
  const unsupported = structuredClone(await loadFixture());
  unsupported.semantics["occurrence.referenceBoundsIndependentOfNoteBounds"].value =
    "sometimes";
  assert.throws(
    () => validateHostBehaviorProfile(unsupported),
    (error) =>
      error.code === "INVALID_HOST_PROFILE" &&
      /value is not supported/.test(error.message)
  );

  const unsupportedEvidence = structuredClone(await loadFixture());
  unsupportedEvidence.semantics[
    "occurrence.referenceBoundsIndependentOfNoteBounds"
  ].evidenceIds = [];
  assert.throws(
    () => validateHostBehaviorProfile(unsupportedEvidence),
    (error) =>
      error.code === "INVALID_HOST_PROFILE" &&
      /evidenceIds must not be empty/.test(error.message)
  );
});

test("confirmed semantics reject evidence collected for another semantic", async () => {
  const profile = structuredClone(await loadFixture());
  profile.semantics["pitchControl.numericStorage"] = {
    status: "confirmed",
    value: "float32",
    evidenceIds: ["EV-COMPUTED-PITCH-1"],
  };
  assert.throws(
    () => validateHostBehaviorProfile(profile),
    (error) =>
      error.code === "INVALID_HOST_PROFILE" &&
      /evidence for another semantic/.test(error.message)
  );
});

test("a single all-null observation remains unknown instead of being called stable", () => {
  const evidence = syntheticProbeEvidence();
  evidence.pitchEnvelope.observations = evidence.pitchEnvelope.observations.slice(0, 1);
  const profile = compileHostBehaviorProfile({
    ...evidence,
    capturedAt: "2026-07-28T00:00:00.000Z",
  });
  assert.equal(
    profile.semantics["computedPitch.pendingRepresentation"].status,
    "unknown"
  );
  assert.equal(profile.evidence[1].sampleCount, 1);
});

test("profile privacy validation rejects slash-based paths on every platform", async () => {
  for (const leakedPath of [
    "/Users/alice/Secret Song.svp",
    "/home/alice/secret.svp",
    "C:/Users/Alice/Secret Song.svp",
  ]) {
    const profile = structuredClone(await loadFixture());
    profile.hostSelector.product = leakedPath;
    assert.throws(
      () => validateHostBehaviorProfile(profile),
      (error) =>
        error.code === "INVALID_HOST_PROFILE" &&
        /path separator/.test(error.message)
    );
  }
});

test("the live profile corrects reference geometry without turning the current project into a default", async () => {
  const profile = await loadFixture();
  const quarter = profile.constants.quarterBlick;
  const model = createPitchHostModel({
    hostProfile: profile,
    evidencePolicy: "allow-simulator-default",
    timeOffsetBlick: 4 * quarter,
    referenceOnsetBlick: 3 * quarter,
    referenceEndBlick: 9 * quarter,
    notes: [{ onset: 0, duration: quarter, pitch: 60, lyrics: "a" }],
  });

  assert.equal(
    await model.host.call({ handle: model.handles.reference, method: "getOnset", args: [] }),
    3 * quarter
  );
  assert.equal(
    await model.host.call({ handle: model.handles.reference, method: "getEnd", args: [] }),
    9 * quarter
  );
  assert.equal(model.quarterBlick, 705600000);
  assert.equal(model.semanticCoverage().length, 0);
});

test("a recorded all-null result is opt-in scenario data, never the fake host default", async () => {
  const profile = await loadFixture();
  const scenario = computedPitchScenarioFromProfile(profile);
  const modeled = createPitchHostModel({
    hostProfile: profile,
    computedPitchValues: scenario.computedPitchValues,
  });
  const observed = await modeled.host.call({
    handle: modeled.handles.sv,
    method: "getComputedPitchForGroup",
    args: [modeled.handles.reference, 0, 1, scenario.frames],
  });
  assert.equal(observed.length, scenario.frames);
  assert.ok(observed.every((value) => value === null));

  const defaultModel = createPitchHostModel({ hostProfile: profile });
  const defaultObserved = await defaultModel.host.call({
    handle: defaultModel.handles.sv,
    method: "getComputedPitchForGroup",
    args: [defaultModel.handles.reference, 0, 1, 4],
  });
  assert.deepEqual(defaultObserved, [60, 60.01, 60.02, 60.03]);
});

test("strict evidence policy stops tests from relying on unmeasured PitchControl semantics", async () => {
  const profile = await loadFixture();
  const model = createPitchHostModel({
    hostProfile: profile,
    evidencePolicy: "require-confirmed",
  });

  await assert.rejects(
    model.host.call({ method: "create", args: ["PitchControlPoint"] }),
    (error) =>
      error.code === "UNCONFIRMED_HOST_SEMANTIC" &&
      error.semanticKey === "pitchControl.numericStorage"
  );
  assert.deepEqual(model.semanticCoverage(), [
    {
      key: "pitchControl.numericStorage",
      source: "unconfirmed",
      status: "not_observable",
    },
  ]);
});

test("strict evidence policy also covers computed-pitch coordinates and reference bounds", async () => {
  const profile = await loadFixture();
  const defaultModel = createPitchHostModel({
    hostProfile: profile,
    evidencePolicy: "require-confirmed",
  });
  await assert.rejects(
    defaultModel.host.call({
      handle: defaultModel.handles.sv,
      method: "getComputedPitchForGroup",
      args: [defaultModel.handles.reference, 0, 1, 4],
    }),
    (error) =>
      error.code === "UNCONFIRMED_HOST_SEMANTIC" &&
      error.semanticKey === "computedPitch.coordinateSpace"
  );
  await assert.rejects(
    defaultModel.host.call({
      handle: defaultModel.handles.reference,
      method: "getOnset",
      args: [],
    }),
    (error) =>
      error.code === "HOST_SCENARIO_REQUIRED" &&
      error.scenarioField === "referenceOnsetBlick"
  );

  const pending = computedPitchScenarioFromProfile(profile);
  const pendingModel = createPitchHostModel({
    hostProfile: profile,
    evidencePolicy: "require-confirmed",
    computedPitchValues: pending.computedPitchValues,
  });
  const observed = await pendingModel.host.call({
    handle: pendingModel.handles.sv,
    method: "getComputedPitchForGroup",
    args: [pendingModel.handles.reference, 0, 1, pending.frames],
  });
  assert.ok(observed.every((value) => value === null));
  assert.deepEqual(pendingModel.semanticCoverage(), [
    {
      key: "computedPitch.pendingRepresentation",
      source: "live_profile",
      status: "confirmed",
    },
  ]);
  assert.doesNotThrow(() => pendingModel.assertNoUnconfirmedSemantics());
});

test("profile diff reports constant drift that changes the fake-host model", () => {
  const baselineEvidence = syntheticProbeEvidence();
  const baseline = compileHostBehaviorProfile({
    ...baselineEvidence,
    capturedAt: "2026-07-28T00:00:00.000Z",
  });
  const candidateEvidence = syntheticProbeEvidence();
  candidateEvidence.hostEnvelope.result.quarterBlick += 1;
  const candidate = compileHostBehaviorProfile({
    ...candidateEvidence,
    capturedAt: "2026-07-28T00:00:00.000Z",
  });
  const diff = diffHostBehaviorProfiles(baseline, candidate);
  assert.equal(diff.changed, true);
  assert.deepEqual(diff.constantChanges, [
    {
      key: "quarterBlick",
      before: 705600000,
      after: 705600001,
    },
  ]);
});

test("profile diff reports semantic drift without last-write-wins promotion", async () => {
  const baseline = compileHostBehaviorProfile({
    ...syntheticProbeEvidence(),
    capturedAt: "2026-07-28T00:00:00.000Z",
  });
  const evidence = syntheticProbeEvidence();
  evidence.pitchEnvelope.observations = evidence.pitchEnvelope.observations.map((item) => ({
    ...item,
    result: {
      ...item.result,
      officialAbsolute: {
        ...item.result.officialAbsolute,
        rawLuaLength: 160,
        rawKeyCount: 160,
        rawNumericKeyCount: 160,
        highestNumericKey: 160,
        numericCount: 160,
        nullCount: 0,
        firstNumericIndex: 0,
        lastNumericIndex: 159,
        min: 59,
        max: 65,
      },
    },
  }));
  const candidate = compileHostBehaviorProfile({
    ...evidence,
    capturedAt: "2026-07-28T00:00:00.000Z",
  });
  const diff = diffHostBehaviorProfiles(baseline, candidate);
  assert.equal(diff.compatibleHost, true);
  assert.equal(diff.changed, true);
  assert.deepEqual(
    diff.semanticChanges.map((item) => item.key),
    ["computedPitch.coordinateSpace", "computedPitch.pendingRepresentation"]
  );
});

test("semantic status summary counts partially observed facts", async () => {
  const profile = validateHostBehaviorProfile(JSON.parse(await readFile(FIXTURE_URL, "utf8")));
  const counts = summarizeHostSemanticStatuses(profile);
  assert.ok(counts.partially_observed > 0);
  assert.equal(
    Object.values(counts).reduce((sum, count) => sum + count, 0),
    Object.keys(profile.semantics).length,
  );
});
