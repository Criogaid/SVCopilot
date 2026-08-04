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
  assert.equal(evidence.status, "in_progress");
  assert.equal(evidence.runtimeHostProfile.status, "matched");
  assert.equal(evidence.runtimeHostProfile.profileId, "synthv-2.2.1-win32-v2");
  assert.equal(evidence.fixture.rawProjectDataWithheld, true);
  assert.equal(evidence.fixture.originalContentTokenRestored, true);
  assert.equal(evidence.fixture.intermediateArtifactLeasesReleased, true);
  assert.deepEqual(evidence.completedMvpScenarioIds, [
    "mvp-01-richards-constant-tempo",
    "mvp-03-overshoot-preparation",
    "mvp-04-host-envelope-vibrato",
    "mvp-05-explicit-pitch-delta-vibrato",
  ]);
  assert.deepEqual(evidence.notApplicableMvpScenarioIds, ["mvp-12-worker-timeout-or-crash"]);
  assert.equal(evidence.pendingMvpScenarioIds.length, 9);
  assert.equal(evidence.p2b.status, "not_started");
  assert.equal(evidence.scenarios.length, 5);

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
  const notApplicableScenario = evidence.scenarios.find(
    (candidate) => candidate.id === "mvp-12-worker-timeout-or-crash",
  );
  assert.equal(notApplicableScenario.id, "mvp-12-worker-timeout-or-crash");
  assert.equal(notApplicableScenario.status, "not_applicable");
  assert.equal(notApplicableScenario.hostMutation, false);
  assert.equal(JSON.stringify(evidence).includes("contextId"), false);
  assert.equal(JSON.stringify(evidence).includes("groupUuid"), false);
});
