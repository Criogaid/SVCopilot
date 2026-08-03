import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ArtifactStore } from "../server/src/artifact-store.js";
import {
  FIT_BENCHMARK_DEFAULTS,
  createFitBenchmarkCases,
  createNodeFitCandidate,
  runFitBenchmark,
  sealFitBenchmarkArtifact,
} from "../tools/lib/fit-worker-benchmark.mjs";
import {
  FIT_WORKER_LIMITS,
  fitRichardsSegment,
  fitWorkerResultHash,
  normalizeFitWorkerRequest,
  revalidateFitWorkerResult,
} from "../server/src/pitch-techniques/fit-worker.js";
import { richardsTransition } from "../server/src/pitch-techniques/richards.js";

const cases = createFitBenchmarkCases();

test("FitWorker stays pure and seals a strict v1 request", () => {
  const sourcePath = fileURLToPath(
    new URL("../server/src/pitch-techniques/fit-worker.js", import.meta.url),
  );
  const source = readFileSync(sourcePath, "utf8");
  assert.doesNotMatch(source, /artifact-store|host-|mcp|process\.env|session|store/i);
  const normalized = normalizeFitWorkerRequest(cases.clean[0].request);
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(normalized.samples.timeSeconds.length, 121);
  const unknown = structuredClone(cases.clean[0].request);
  unknown.unexpected = true;
  assert.throws(
    () => normalizeFitWorkerRequest(unknown),
    (error) => error.code === "INVALID_FIT_WORKER_REQUEST"
      && error.details.unknown.includes("unexpected"),
  );
  const tooManySamples = structuredClone(cases.clean[0].request);
  tooManySamples.samples.timeSeconds = Array.from(
    { length: FIT_WORKER_LIMITS.maximumSamples + 1 },
    (_, index) => index / 1000,
  );
  tooManySamples.samples.cents = tooManySamples.samples.timeSeconds.map(() => 0);
  tooManySamples.samples.mask = tooManySamples.samples.timeSeconds.map(() => true);
  assert.throws(
    () => normalizeFitWorkerRequest(tooManySamples),
    (error) => error.code === "FIT_SAMPLE_BUDGET_EXCEEDED",
  );
});

test("Node FitWorker recovers both clean corpus Richards cases and hashes deterministically", () => {
  for (const current of cases.clean) {
    const first = fitRichardsSegment(current.request);
    const second = fitRichardsSegment(current.request);
    const verified = revalidateFitWorkerResult(current.request, first);
    assert.equal(first.termination, "converged", current.id);
    assert.equal(verified.accepted, true, current.id);
    assert.equal(fitWorkerResultHash(first), fitWorkerResultHash(second), current.id);
    assert.ok(truthRmse(current, verified.result.parameters) <= 1e-9, current.id);
    assert.ok(maximumForwardDeviation(current, verified.result.parameters) <= 1e-9, current.id);
    assert.ok(maximumParameterError(current, verified.result.parameters) <= 1e-9, current.id);
  }
});

test("Node FitWorker preserves null evidence, rejects degenerate inputs, and recovers after timeout", () => {
  for (const current of cases.noisy) {
    const result = fitRichardsSegment(current.request);
    const verified = revalidateFitWorkerResult(current.request, result);
    assert.equal(result.termination, "converged", current.id);
    assert.equal(verified.accepted, true, current.id);
    assert.ok(truthRmse(current, verified.result.parameters) <= 2, current.id);
  }
  for (const current of cases.degenerate) {
    const result = fitRichardsSegment(current.request);
    const verified = revalidateFitWorkerResult(current.request, result);
    assert.equal(result.termination, "rejected", current.id);
    assert.equal(result.parameters, null, current.id);
    assert.equal(result.metrics.rmseCents, null, current.id);
    assert.equal(verified.accepted, false, current.id);
  }
  let tick = 0;
  const timedOut = fitRichardsSegment({
    ...cases.clean[0].request,
    requestId: "fit_timeout_probe",
    limits: { ...cases.clean[0].request.limits, timeoutMs: 1 },
  }, {
    now: () => {
      tick += 2;
      return tick;
    },
  });
  assert.equal(timedOut.termination, "timeout");
  assert.equal(fitRichardsSegment(cases.clean[0].request).termination, "converged");
});

test("Node revalidation rejects altered metrics and keeps iteration-limited candidates non-actionable", () => {
  const result = fitRichardsSegment(cases.clean[0].request);
  const altered = structuredClone(result);
  altered.metrics.rmseCents += 1;
  assert.throws(
    () => revalidateFitWorkerResult(cases.clean[0].request, altered),
    (error) => error.code === "FIT_WORKER_RESULT_MISMATCH"
      && error.details.path === "$/metrics/rmseCents",
  );
  const limited = structuredClone(result);
  limited.termination = "iteration_limit";
  limited.warnings = [{ code: "FIT_DID_NOT_CONVERGE" }];
  const revalidated = revalidateFitWorkerResult(cases.clean[0].request, limited);
  assert.equal(revalidated.accepted, false);
  assert.equal(revalidated.result.termination, "iteration_limit");
  const outOfBounds = structuredClone(limited);
  outOfBounds.parameters.fromCents = cases.clean[0].request.bounds.fromCents.maximum + 1;
  assert.throws(
    () => revalidateFitWorkerResult(cases.clean[0].request, outOfBounds),
    (error) => error.code === "FIT_WORKER_RESULT_MISMATCH"
      && error.details.path === "$/parameters/fromCents",
  );
});

test("benchmark records common protocol evidence and seals an Artifact payload", async () => {
  assert.equal(FIT_BENCHMARK_DEFAULTS.warmupRuns, 20);
  const report = await runFitBenchmark({
    candidates: [createNodeFitCandidate()],
    warmupRuns: 2,
    measuredRuns: 3,
    phraseFits: 2,
  });
  assert.equal(report.selection.selectedCandidateId, "node-bounded-richards");
  assert.equal(report.candidates[0].gates.eligible, true);
  assert.equal(report.candidates[0].quality.cleanRecoveryRate, 1);
  assert.equal(report.candidates[0].quality.noisyRecoveryRate, 1);
  assert.equal(report.candidates[0].dependencyFootprint.addedRuntimePackages, 0);
  assert.equal(report.candidates[0].dependencyFootprint.addedRuntimeBytes, 0);
  assert.ok(report.candidates[0].quality.clean.every((current) => (
    current.canonicalForwardMaxDeviationCents <= 1e-9
  )));
  const artifactStore = new ArtifactStore({ now: () => 1_000 });
  const artifact = sealFitBenchmarkArtifact({ artifactStore, report, sessionId: "fit-test" });
  assert.equal(artifact.kind, "fit-worker-benchmark");
  assert.deepEqual(artifact.payload, report);
  assert.ok(artifact.totalBytes > 0);
});

function truthRmse(current, parameters) {
  let squaredTotal = 0;
  let count = 0;
  for (let index = 0; index < current.truthValues.length; index += 1) {
    if (!current.request.samples.mask[index]) continue;
    const predicted = richardsTransition(
      current.request.samples.timeSeconds[index],
      parameters.fromSeconds,
      parameters.toSeconds,
      parameters.fromCents,
      parameters.toCents,
      parameters.inflectionSeconds,
      parameters.growthPerSecond,
      parameters.asymmetryB,
    );
    const residual = predicted - current.truthValues[index];
    squaredTotal += residual * residual;
    count += 1;
  }
  return Math.sqrt(squaredTotal / count);
}

function maximumForwardDeviation(current, parameters) {
  let maximum = 0;
  for (let index = 0; index < current.truthValues.length; index += 1) {
    const predicted = richardsTransition(
      current.request.samples.timeSeconds[index],
      parameters.fromSeconds,
      parameters.toSeconds,
      parameters.fromCents,
      parameters.toCents,
      parameters.inflectionSeconds,
      parameters.growthPerSecond,
      parameters.asymmetryB,
    );
    maximum = Math.max(maximum, Math.abs(predicted - current.truthValues[index]));
  }
  return maximum;
}

function maximumParameterError(current, parameters) {
  let maximum = 0;
  for (const name of [
    "fromCents",
    "toCents",
    "inflectionSeconds",
    "growthPerSecond",
    "asymmetryB",
  ]) {
    const bounds = current.request.bounds[name];
    maximum = Math.max(
      maximum,
      Math.abs(parameters[name] - current.truth[name]) / (bounds.maximum - bounds.minimum),
    );
  }
  return maximum;
}
