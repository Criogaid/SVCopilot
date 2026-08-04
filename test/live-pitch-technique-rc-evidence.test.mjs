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
    "mvp-04-host-envelope-vibrato",
    "mvp-05-explicit-pitch-delta-vibrato",
  ]);
  assert.deepEqual(evidence.notApplicableMvpScenarioIds, ["mvp-12-worker-timeout-or-crash"]);
  assert.equal(evidence.pendingMvpScenarioIds.length, 11);
  assert.equal(evidence.p2b.status, "not_started");
  assert.equal(evidence.scenarios.length, 3);

  const scenario = evidence.scenarios[0];
  assert.equal(scenario.id, "mvp-04-host-envelope-vibrato");
  assert.equal(scenario.status, "passed");
  assert.equal(scenario.workflow.dryRun.setterCalls, 0);
  assert.equal(scenario.workflow.dryRun.undoBoundaryCalls, 0);
  assert.equal(scenario.workflow.commit.expectedUserUndoSteps, 1);
  assert.equal(scenario.workflow.commit.undoBoundaryCalls, 2);
  assert.equal(scenario.workflow.cleanup.restorationTokenMatched, true);
  assert.equal(scenario.humanAudition.status, "pending_human");
  const explicitScenario = evidence.scenarios[1];
  assert.equal(explicitScenario.id, "mvp-05-explicit-pitch-delta-vibrato");
  assert.equal(explicitScenario.status, "passed");
  assert.equal(explicitScenario.workflow.dryRun.setterCalls, 0);
  assert.equal(explicitScenario.workflow.cleanup.restorationTokenMatched, true);
  assert.equal(explicitScenario.artifactLeaseCleanup.status, "succeeded");
  assert.equal(explicitScenario.artifactLeaseCleanup.sessionArtifactEntriesAfterCleanup, 0);
  assert.equal(evidence.pendingMvpScenarioIds.includes(explicitScenario.id), false);
  const notApplicableScenario = evidence.scenarios[2];
  assert.equal(notApplicableScenario.id, "mvp-12-worker-timeout-or-crash");
  assert.equal(notApplicableScenario.status, "not_applicable");
  assert.equal(notApplicableScenario.hostMutation, false);
  assert.equal(JSON.stringify(evidence).includes("contextId"), false);
  assert.equal(JSON.stringify(evidence).includes("groupUuid"), false);
});
