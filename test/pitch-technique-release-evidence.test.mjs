import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { releaseProvenanceHashes } from "./helpers/pitch-technique-release-specimen.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

function readJson(relativePath) {
  return JSON.parse(readFileSync(`${ROOT}${relativePath}`, "utf8"));
}

function readText(relativePath) {
  return readFileSync(`${ROOT}${relativePath}`, "utf8");
}

function fileSha256(relativePath) {
  return `sha256:${createHash("sha256").update(readFileSync(`${ROOT}${relativePath}`)).digest("hex")}`;
}

test("T20 release evidence is reproducible, scoped, and capability-honest", () => {
  const release = readJson("docs/pitch-techniques/evidence/T20-release-evidence.json");
  const benchmark = readJson("docs/pitch-techniques/evidence/T16-fit-worker-benchmark.json");
  const live = readJson("docs/pitch-techniques/evidence/T18-live-host-rc.json");
  const profile = readJson("test/fixtures/host-profiles/synthv-2.2.1-win32-v2.json");
  const packageJson = readJson("server/package.json");
  const packageLock = readJson("server/package-lock.json");

  assert.equal(release.status, "passed");
  assert.equal(release.interfaceVersion, "0.10.0");
  assert.equal(packageJson.version, release.interfaceVersion);
  assert.equal(packageLock.version, release.interfaceVersion);
  assert.equal(packageLock.packages[""].version, release.interfaceVersion);
  assert.match(readText("server/src/index.js"), /const INTERFACE_VERSION = "0\.10\.0";/);

  assert.deepEqual(release.canonicalHashes, {
    specimen: "synthetic_two_note_richards_transition",
    ...releaseProvenanceHashes(),
  });
  assert.equal(
    release.reproducibleArtifacts.fitWorkerBenchmark.fileSha256,
    fileSha256("docs/pitch-techniques/evidence/T16-fit-worker-benchmark.json"),
  );
  assert.equal(
    release.reproducibleArtifacts.liveHostAcceptance.fileSha256,
    fileSha256("docs/pitch-techniques/evidence/T18-live-host-rc.json"),
  );
  assert.equal(
    release.reproducibleArtifacts.hostProfile.fileSha256,
    fileSha256("test/fixtures/host-profiles/synthv-2.2.1-win32-v2.json"),
  );
  assert.equal(
    release.dependencyProvenance.packageLockSha256,
    fileSha256("server/package-lock.json"),
  );

  assert.equal(benchmark.selection.status, "selected");
  assert.equal(benchmark.selection.selectedCandidateId, "node-bounded-richards");
  assert.equal(
    benchmark.artifact.contentHash,
    release.reproducibleArtifacts.fitWorkerBenchmark.artifactContentHash,
  );
  assert.equal(live.status, "passed");
  assert.equal(live.scenarios.length, 14);
  assert.deepEqual(live.pendingMvpScenarioIds, []);
  assert.equal(profile.profileId, release.versions.hostProfile.profileId);
  assert.equal(profile.evidenceSha256, release.versions.hostProfile.evidenceSha256);

  assert.deepEqual(release.releaseScope.conditionalTasks, {
    T03: "not_required_h1_parity_passed",
    T14: "not_enabled_h3a_unknown_h3b_partially_observed",
    T19: "not_enabled_safety_gates_not_enabled",
  });
  assert.equal(release.capabilityGates.PitchControlCurve.status, "disabled");
  assert.equal(release.capabilityGates.boundedClosedLoop.status, "disabled");
  assert.equal(release.humanAudition.perception, "human_only");
  assert.equal(release.humanAudition.automatedQualityClaim, false);
  assert.match(readText("docs/pitch-techniques/tasks/T20-release-evidence.md"), /状态：`done`/);
  assert.match(readText("docs/pitch-techniques/tasks/T03-time-axis-bulk-op.md"), /状态：`conditional`/);
  assert.match(readText("docs/pitch-techniques/tasks/T14-pitch-control-compiler.md"), /状态：`conditional`/);
  assert.match(readText("docs/pitch-techniques/tasks/T19-bounded-closed-loop.md"), /状态：`conditional`/);
  assert.equal(release.validation.liveHost.artifactEntriesAfterCleanup, 0);
  assert.equal(release.validation.liveHost.knownHandleCountAfterCleanup, 0);
  assert.equal(release.validation.liveHost.pendingExecutionsAfterCleanup, 0);

  const lockDependencies = packageLock.packages;
  for (const dependency of release.dependencyProvenance.directRuntimeDependencies) {
    const locked = lockDependencies[`node_modules/${dependency.name}`];
    assert.equal(locked.version, dependency.version);
    assert.equal(locked.license, dependency.license);
  }

  const readme = readText("README.md");
  assert.match(readme, /pitch-techniques-v1/);
  assert.match(readme, /node-bounded-richards\/1/);
  assert.match(readme, /dry_run/);
  assert.match(readme, /commit/);
  assert.match(readme, /一个用户 Undo/);
  assert.match(readme, /PitchControlCurve/);
  assert.match(readme, /outcome_unknown/);
  const notices = readText("THIRD_PARTY_NOTICES.md");
  assert.match(notices, /@modelcontextprotocol\/sdk/);
  assert.match(notices, /ajv/);
  assert.doesNotMatch(notices, /不包含任何第三方[\s\S]*运行时依赖/);

  const serialized = JSON.stringify(release);
  assert.doesNotMatch(serialized, /[A-Z]:\\|AppData|Kripto|contextId|groupUuid|artifactId|lyrics/i);
});
