import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const evidencePath = path.resolve(
  testDirectory,
  "..",
  "docs",
  "pitch-techniques",
  "evidence",
  "T18-live-host-rc.json",
);

test("T18 live RC evidence records only completed scenarios and preserves its gates", () => {
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));

  assert.equal(evidence.kind, "svcopilot-live-host-rc");
  assert.equal(evidence.status, "passed");
  assert.equal(evidence.runtimeHostProfile.status, "matched");
  assert.equal(evidence.runtimeHostProfile.profileId, "synthv-2.2.1-win32-v2");
  assert.equal(evidence.fixture.rawProjectDataWithheld, true);
  assert.equal(evidence.fixture.originalContentTokenRestored, true);
  assert.equal(evidence.fixture.intermediateArtifactLeasesReleased, true);
  assert.deepEqual(evidence.completedMvpScenarioIds, [
    "mvp-01-richards-constant-tempo",
    "mvp-02-tempo-change-transition-vibrato",
    "mvp-03-overshoot-preparation",
    "mvp-04-host-envelope-vibrato",
    "mvp-05-explicit-pitch-delta-vibrato",
    "mvp-06-overlap-composition-permutation",
    "mvp-07-pitch-delta-surface",
    "mvp-08-shared-target-two-occurrences",
    "mvp-09-short-and-long-groups",
    "mvp-10-computed-pitch-coverage-matrix",
    "mvp-11-stale-context-and-reconnect",
    "mvp-13-interpolation-failure-and-rollback",
    "mvp-14-null-gap-correction",
  ]);
  assert.deepEqual(evidence.notApplicableMvpScenarioIds, ["mvp-12-worker-timeout-or-crash"]);
  assert.deepEqual(evidence.pendingMvpScenarioIds, []);
  assert.equal(evidence.p2b.status, "not_started");
  assert.equal(evidence.scenarios.length, 14);

  const richardsScenario = evidence.scenarios.find(
    (candidate) => candidate.id === "mvp-01-richards-constant-tempo",
  );
  assert.equal(richardsScenario.status, "passed");
  assert.equal(richardsScenario.fixUnderTest.commit, "2ac7187");
  assert.equal(richardsScenario.workflow.dryRun.setterCalls, 0);
  assert.equal(richardsScenario.workflow.dryRun.undoBoundaryCalls, 0);
  assert.equal(richardsScenario.workflow.commit.expectedUserUndoSteps, 1);
  assert.equal(richardsScenario.workflow.cleanup.restorationTokenMatched, true);
  assert.equal(richardsScenario.artifactLeaseCleanup.sessionArtifactEntriesAfterCleanup, 0);
  assert.equal(evidence.pendingMvpScenarioIds.includes(richardsScenario.id), false);

  const tempoChangeScenario = evidence.scenarios.find(
    (candidate) => candidate.id === "mvp-02-tempo-change-transition-vibrato",
  );
  assert.equal(tempoChangeScenario.status, "passed");
  assert.equal(tempoChangeScenario.workflow.dryRun.setterCalls, 0);
  assert.equal(tempoChangeScenario.workflow.dryRun.undoBoundaryCalls, 0);
  assert.equal(tempoChangeScenario.workflow.commit.expectedUserUndoSteps, 1);
  assert.equal(tempoChangeScenario.workflow.compare.crossedTempoChange, true);
  assert.ok(
    tempoChangeScenario.workflow.compare.relativeRateError
      <= tempoChangeScenario.workflow.compare.liveRateGate,
  );
  assert.equal(tempoChangeScenario.workflow.compare.liveRateGatePassed, true);
  assert.equal(tempoChangeScenario.workflow.cleanup.originalProjectContentTokenMatched, true);
  assert.equal(tempoChangeScenario.resourceCleanup.sessionArtifactEntriesAfterCleanup, 0);
  assert.equal(evidence.pendingMvpScenarioIds.includes(tempoChangeScenario.id), false);

  const transientScenario = evidence.scenarios.find(
    (candidate) => candidate.id === "mvp-03-overshoot-preparation",
  );
  assert.equal(transientScenario.status, "passed");
  assert.deepEqual(
    transientScenario.workflow.plan.techniques.map((technique) => technique.dampingRatio),
    [0.5422, 0.6681],
  );
  assert.equal(transientScenario.workflow.dryRun.setterCalls, 0);
  assert.equal(transientScenario.workflow.commit.expectedUserUndoSteps, 1);
  assert.equal(transientScenario.workflow.compare.requestedDirectionObserved, true);
  assert.equal(transientScenario.workflow.cleanup.restorationTokenMatched, true);
  assert.equal(transientScenario.artifactLeaseCleanup.sessionArtifactEntriesAfterCleanup, 0);
  assert.equal(evidence.pendingMvpScenarioIds.includes(transientScenario.id), false);

  const scenario = evidence.scenarios.find(
    (candidate) => candidate.id === "mvp-04-host-envelope-vibrato",
  );
  assert.equal(scenario.id, "mvp-04-host-envelope-vibrato");
  assert.equal(scenario.status, "passed");
  assert.equal(scenario.workflow.dryRun.setterCalls, 0);
  assert.equal(scenario.workflow.dryRun.undoBoundaryCalls, 0);
  assert.equal(scenario.workflow.commit.expectedUserUndoSteps, 1);
  assert.equal(scenario.workflow.commit.undoBoundaryCalls, 2);
  assert.equal(scenario.workflow.cleanup.restorationTokenMatched, true);
  assert.equal(scenario.humanAudition.status, "pending_human");
  const explicitScenario = evidence.scenarios.find(
    (candidate) => candidate.id === "mvp-05-explicit-pitch-delta-vibrato",
  );
  assert.equal(explicitScenario.id, "mvp-05-explicit-pitch-delta-vibrato");
  assert.equal(explicitScenario.status, "passed");
  assert.equal(explicitScenario.workflow.dryRun.setterCalls, 0);
  assert.equal(explicitScenario.workflow.cleanup.restorationTokenMatched, true);
  assert.equal(explicitScenario.artifactLeaseCleanup.status, "succeeded");
  assert.equal(explicitScenario.artifactLeaseCleanup.sessionArtifactEntriesAfterCleanup, 0);
  assert.equal(evidence.pendingMvpScenarioIds.includes(explicitScenario.id), false);
  const overlapScenario = evidence.scenarios.find(
    (candidate) => candidate.id === "mvp-06-overlap-composition-permutation",
  );
  assert.equal(overlapScenario.status, "passed");
  assert.equal(overlapScenario.workflow.plan.techniqueCount, 3);
  assert.equal(overlapScenario.workflow.plan.canonicalPermutation.planIdMatched, true);
  assert.equal(overlapScenario.workflow.plan.canonicalPermutation.curveCountMatched, true);
  assert.equal(overlapScenario.workflow.plan.canonicalPermutation.pointCountMatched, true);
  assert.equal(overlapScenario.workflow.dryRun.setterCalls, 0);
  assert.equal(overlapScenario.workflow.dryRun.undoBoundaryCalls, 0);
  assert.equal(overlapScenario.workflow.commit.expectedUserUndoSteps, 1);
  assert.equal(overlapScenario.workflow.cleanup.restorationTokenMatched, true);
  assert.equal(overlapScenario.artifactLeaseCleanup.sessionArtifactEntriesAfterCleanup, 0);
  assert.equal(evidence.pendingMvpScenarioIds.includes(overlapScenario.id), false);
  const pitchDeltaSurfaceScenario = evidence.scenarios.find(
    (candidate) => candidate.id === "mvp-07-pitch-delta-surface",
  );
  assert.equal(pitchDeltaSurfaceScenario.status, "passed");
  assert.deepEqual(pitchDeltaSurfaceScenario.workflow.plan.resolvedParameters, ["pitchDelta"]);
  assert.equal(pitchDeltaSurfaceScenario.workflow.plan.pitchControlMutationPlanned, false);
  assert.equal(pitchDeltaSurfaceScenario.workflow.dryRun.setterCalls, 0);
  assert.equal(pitchDeltaSurfaceScenario.workflow.commit.expectedUserUndoSteps, 1);
  assert.equal(pitchDeltaSurfaceScenario.workflow.readbackSurface.onlyPitchDeltaChanged, true);
  assert.equal(pitchDeltaSurfaceScenario.workflow.readbackSurface.pitchControlCurvesBefore, 0);
  assert.equal(pitchDeltaSurfaceScenario.workflow.readbackSurface.pitchControlCurvesAfter, 0);
  assert.equal(pitchDeltaSurfaceScenario.workflow.cleanup.restorationTokenMatched, true);
  assert.equal(
    pitchDeltaSurfaceScenario.artifactLeaseCleanup.sessionArtifactEntriesAfterCleanup,
    0,
  );
  assert.equal(evidence.pendingMvpScenarioIds.includes(pitchDeltaSurfaceScenario.id), false);
  const sharedTargetScenario = evidence.scenarios.find(
    (candidate) => candidate.id === "mvp-08-shared-target-two-occurrences",
  );
  assert.equal(sharedTargetScenario.status, "passed");
  assert.equal(sharedTargetScenario.fixtureSetup.sharedOccurrenceCount, 2);
  assert.deepEqual(sharedTargetScenario.workflow.snapshot.sharedTargetOccurrences, [0, 1]);
  assert.equal(sharedTargetScenario.workflow.plan.requiresSharedTargetConfirmation, true);
  assert.equal(sharedTargetScenario.workflow.dryRun.setterCalls, 0);
  assert.equal(sharedTargetScenario.workflow.unconfirmedCommit.effects, "none");
  assert.equal(
    sharedTargetScenario.workflow.unconfirmedCommit.errorCode,
    "SHARED_TARGET_REQUIRES_CONFIRMATION",
  );
  assert.equal(sharedTargetScenario.workflow.confirmedCommit.expectedUserUndoSteps, 1);
  assert.deepEqual(sharedTargetScenario.workflow.sharedReadback.targetRangePointsByOccurrence, [
    34,
    34,
  ]);
  assert.equal(sharedTargetScenario.workflow.cleanup.sharedFixtureTokenRestored, true);
  assert.equal(sharedTargetScenario.workflow.cleanup.originalProjectTokenRestored, true);
  assert.equal(sharedTargetScenario.resourceCleanup.knownHandleCountAfterCleanup, 0);
  assert.equal(sharedTargetScenario.resourceCleanup.sessionArtifactEntriesAfterCleanup, 0);
  assert.equal(evidence.pendingMvpScenarioIds.includes(sharedTargetScenario.id), false);
  const groupSizeScenario = evidence.scenarios.find(
    (candidate) => candidate.id === "mvp-09-short-and-long-groups",
  );
  assert.equal(groupSizeScenario.status, "passed");
  assert.equal(groupSizeScenario.fixtureSetup.shortGroup.testNoteCount, 12);
  assert.equal(groupSizeScenario.fixtureSetup.longGroup.testNoteCount, 373);
  assert.equal(groupSizeScenario.compactSurface.withinTarget, true);
  assert.ok(groupSizeScenario.compactSurface.shortGroupStructuredResponseBytes <= 8192);
  assert.ok(groupSizeScenario.compactSurface.longGroupStructuredResponseBytes <= 8192);
  assert.equal(groupSizeScenario.compactSurface.denseDetailPagingRequired, true);
  assert.equal(groupSizeScenario.shortGroupWorkflow.dryRun.setterCalls, 0);
  assert.equal(groupSizeScenario.shortGroupWorkflow.commit.expectedUserUndoSteps, 1);
  assert.equal(groupSizeScenario.shortGroupWorkflow.cleanup.editableFieldsRestored, true);
  assert.equal(
    groupSizeScenario.shortGroupWorkflow.cleanup.differenceLimitedToDerivedComputedPitch,
    true,
  );
  assert.equal(groupSizeScenario.longGroupWorkflow.snapshot.groupNoteCount, 373);
  assert.equal(groupSizeScenario.longGroupWorkflow.dryRun.setterCalls, 0);
  assert.equal(groupSizeScenario.longGroupWorkflow.commit.expectedUserUndoSteps, 1);
  assert.equal(groupSizeScenario.longGroupWorkflow.wait.status, "processing_timeout");
  assert.equal(
    groupSizeScenario.longGroupWorkflow.wait.forwardedToScenario,
    "mvp-10-computed-pitch-coverage-matrix",
  );
  assert.equal(groupSizeScenario.longGroupWorkflow.cleanup.editableContentTokenMatched, true);
  assert.equal(groupSizeScenario.longGroupWorkflow.cleanup.restoredNoteCount, 198);
  assert.equal(groupSizeScenario.resourceCleanup.knownHandleCountAfterCleanup, 0);
  assert.equal(groupSizeScenario.resourceCleanup.sessionArtifactEntriesAfterCleanup, 0);
  assert.equal(evidence.pendingMvpScenarioIds.includes(groupSizeScenario.id), false);
  const coverageScenario = evidence.scenarios.find(
    (candidate) => candidate.id === "mvp-10-computed-pitch-coverage-matrix",
  );
  assert.equal(coverageScenario.status, "passed");
  assert.equal(coverageScenario.hostMutation, false);
  assert.equal(coverageScenario.setterCalls, 0);
  assert.equal(coverageScenario.undoBoundaryCalls, 0);
  assert.deepEqual(
    coverageScenario.cases.map((coverageCase) => coverageCase.coverageClass),
    ["full", "partial", "all_null"],
  );
  const [fullCoverage, partialCoverage, allNullCoverage] = coverageScenario.cases;
  assert.equal(fullCoverage.compare.status, "succeeded");
  assert.equal(fullCoverage.compare.coverage, 1);
  assert.deepEqual(fullCoverage.compare.warningCodes, []);
  assert.equal(partialCoverage.compare.status, "succeeded");
  assert.ok(partialCoverage.compare.coverage < partialCoverage.compare.lowCoverageThreshold);
  assert.ok(partialCoverage.compare.warningCodes.includes("LOW_COMPUTED_PITCH_COVERAGE"));
  assert.equal(allNullCoverage.compare.status, "failed");
  assert.equal(allNullCoverage.compare.errorCode, "INSUFFICIENT_COMPUTED_PITCH");
  assert.equal(allNullCoverage.compare.reportedAsZeroError, false);
  assert.equal(coverageScenario.resourceCleanup.sessionArtifactEntriesAfterCleanup, 0);
  assert.equal(evidence.pendingMvpScenarioIds.includes(coverageScenario.id), false);
  const rollbackScenario = evidence.scenarios.find(
    (candidate) => candidate.id === "mvp-13-interpolation-failure-and-rollback",
  );
  assert.equal(rollbackScenario.status, "passed");
  assert.deepEqual(rollbackScenario.fixture.parameters, ["pitchDelta", "vibratoEnv"]);
  assert.ok(
    rollbackScenario.fixture.injectedDrift.absoluteError
      > rollbackScenario.fixture.injectedDrift.maxAllowedError,
  );
  assert.equal(rollbackScenario.workflow.dryRun.setterCalls, 0);
  assert.equal(rollbackScenario.workflow.dryRun.undoBoundaryCalls, 0);
  assert.equal(rollbackScenario.workflow.commit.status, "rolled_back");
  assert.equal(rollbackScenario.workflow.commit.effects, "reverted");
  assert.equal(rollbackScenario.workflow.commit.errorCode, "POSTCONDITION_FAILED");
  assert.equal(rollbackScenario.workflow.commit.expectedUserUndoSteps, 1);
  assert.equal(rollbackScenario.workflow.commit.automaticRollback, true);
  assert.deepEqual(rollbackScenario.workflow.rollback.reverseParameterOrder, [
    "vibratoEnv",
    "pitchDelta",
  ]);
  assert.equal(rollbackScenario.workflow.rollback.verified, true);
  assert.equal(rollbackScenario.workflow.cleanup.contentTokenMatched, true);
  assert.equal(rollbackScenario.resourceCleanup.scenarioArtifactLeasesRemaining, 0);
  assert.equal(evidence.pendingMvpScenarioIds.includes(rollbackScenario.id), false);
  const nullGapScenario = evidence.scenarios.find(
    (candidate) => candidate.id === "mvp-14-null-gap-correction",
  );
  assert.equal(nullGapScenario.status, "passed");
  assert.equal(nullGapScenario.fixUnderTest.commit, "48c723e");
  assert.equal(nullGapScenario.workflow.dryRun.setterCalls, 0);
  assert.equal(nullGapScenario.workflow.dryRun.undoBoundaryCalls, 0);
  assert.equal(nullGapScenario.workflow.commit.expectedUserUndoSteps, 1);
  assert.equal(nullGapScenario.workflow.compare.nullFramesBefore, 21);
  assert.equal(nullGapScenario.workflow.compare.nullFramesAfter, 21);
  assert.equal(nullGapScenario.workflow.compare.nullGapPreserved, true);
  assert.equal(nullGapScenario.workflow.compare.oppositeDirectionsObserved, true);
  assert.equal(nullGapScenario.workflow.compare.crossGapCouplingObserved, false);
  assert.equal(nullGapScenario.workflow.cleanup.contentTokenMatched, true);
  assert.equal(nullGapScenario.resourceCleanup.sessionArtifactEntriesAfterCleanup, 0);
  assert.equal(evidence.pendingMvpScenarioIds.includes(nullGapScenario.id), false);
  const reconnectScenario = evidence.scenarios.find(
    (candidate) => candidate.id === "mvp-11-stale-context-and-reconnect",
  );
  assert.equal(reconnectScenario.status, "passed");
  assert.equal(
    reconnectScenario.workflow.sameConnectionStaleBaseline.failureCode,
    "CURVE_BASELINE_CHANGED",
  );
  assert.equal(reconnectScenario.workflow.sameConnectionStaleBaseline.failureEffects, "none");
  assert.equal(reconnectScenario.workflow.sameConnectionStaleBaseline.hostWriteMs, 0);
  assert.equal(reconnectScenario.workflow.sameConnectionStaleBaseline.undoRecords, 0);
  assert.equal(reconnectScenario.workflow.crossReconnect.sourceEpoch, 1);
  assert.equal(reconnectScenario.workflow.crossReconnect.observedEpoch, 2);
  assert.equal(reconnectScenario.workflow.crossReconnect.failureCode, "STALE_CONTEXT");
  assert.equal(reconnectScenario.workflow.crossReconnect.failureEffects, "none");
  assert.equal(reconnectScenario.workflow.crossReconnect.hostWriteMs, 0);
  assert.equal(reconnectScenario.workflow.crossReconnect.undoRecords, 0);
  assert.equal(reconnectScenario.workflow.cleanup.contentTokenMatchedAfterReconnect, true);
  assert.equal(reconnectScenario.regressionsValidated.automationEndpointClamp.plannedValue, 0.25);
  assert.equal(
    reconnectScenario.regressionsValidated.reconnectHandleCleanup.verificationAfterRestart
      .knownHandleCountAfterArtifactRelease,
    0,
  );
  assert.equal(reconnectScenario.resourceCleanup.sessionArtifactEntriesAfterCleanup, 0);
  assert.equal(reconnectScenario.resourceCleanup.knownHandleCountAfterCleanup, 0);
  assert.equal(evidence.pendingMvpScenarioIds.includes(reconnectScenario.id), false);
  const notApplicableScenario = evidence.scenarios.find(
    (candidate) => candidate.id === "mvp-12-worker-timeout-or-crash",
  );
  assert.equal(notApplicableScenario.id, "mvp-12-worker-timeout-or-crash");
  assert.equal(notApplicableScenario.status, "not_applicable");
  assert.equal(notApplicableScenario.hostMutation, false);
  assert.equal(JSON.stringify(evidence).includes("contextId"), false);
  assert.equal(JSON.stringify(evidence).includes("groupUuid"), false);
});
