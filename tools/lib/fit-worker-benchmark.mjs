import { performance } from "node:perf_hooks";

import {
  FIT_RICHARDS_PARAMETER_NAMES,
  FIT_WORKER_NODE_ENGINE,
  fitRichardsSegment,
  fitWorkerResultHash,
  revalidateFitWorkerResult,
} from "../../server/src/pitch-techniques/fit-worker.js";
import { richardsTransition } from "../../server/src/pitch-techniques/richards.js";
import { loadPitchTechniqueCorpus } from "../../test/helpers/pitch-technique-corpus.mjs";

export const FIT_BENCHMARK_SCHEMA_VERSION = 1;
export const FIT_BENCHMARK_DEFAULTS = Object.freeze({
  warmupRuns: 20,
  measuredRuns: 20,
  phraseFits: 12,
});
export const FIT_BENCHMARK_GATES = Object.freeze({
  minimumCleanRecoveryRate: 0.95,
  maximumCleanTruthRmseCents: 1e-6,
  maximumCleanNormalizedParameterError: 1e-4,
  minimumNoisyRecoveryRate: 0.95,
  maximumNoisyTruthRmseCents: 2,
  maximumNoisyNormalizedParameterError: 0.05,
  maximumSingleFitP95Ms: 100,
  maximumPhraseFitP95Ms: 1_500,
});

export function createNodeFitCandidate() {
  return Object.freeze({
    id: FIT_WORKER_NODE_ENGINE.name,
    engine: FIT_WORKER_NODE_ENGINE,
    packaging: Object.freeze({
      eligible: true,
      status: "existing_node_runtime",
      addedRuntimeDependencies: 0,
      windowsMacosInstall: "inherits_existing_node_package",
    }),
    dependencyFootprint: Object.freeze({
      addedRuntimePackages: 0,
      addedRuntimeBytes: 0,
      status: "no_new_runtime_dependency",
    }),
    license: Object.freeze({
      eligible: true,
      status: "no_new_third_party_dependency",
    }),
    crashIsolation: Object.freeze({
      eligible: true,
      status: "not_applicable_in_process",
    }),
    async fit(request) {
      return fitRichardsSegment(request);
    },
    async verifyTimeoutRecovery(request) {
      let tick = 0;
      const timedOutRequest = {
        ...request,
        requestId: `${request.requestId}_timeout`,
        limits: { ...request.limits, timeoutMs: 1 },
      };
      const timedOut = fitRichardsSegment(timedOutRequest, {
        now: () => {
          tick += 2;
          return tick;
        },
      });
      const recovered = fitRichardsSegment({
        ...request,
        requestId: `${request.requestId}_recovered`,
      });
      return {
        eligible: timedOut.termination === "timeout" && recovered.termination === "converged",
        timedOutTermination: timedOut.termination,
        recoveredTermination: recovered.termination,
      };
    },
  });
}

export function createFitBenchmarkCases() {
  const loaded = loadPitchTechniqueCorpus();
  const richardsCases = loaded.corpus.cases.filter((current) => (
    current.family === "richards_segment" && !current.expectedError
  ));
  const clean = richardsCases.map((current) => createRichardsCase(current, "clean"));
  const noisy = richardsCases.map((current) => createRichardsCase(current, "noisy_null"));
  const degenerate = clean.map((current) => ({
    id: `${current.id}-all-null`,
    category: "degenerate",
    request: {
      ...current.request,
      requestId: `${current.request.requestId}_all_null`,
      samples: {
        timeSeconds: current.request.samples.timeSeconds,
        cents: current.request.samples.timeSeconds.map(() => null),
        mask: current.request.samples.timeSeconds.map(() => false),
      },
    },
    truth: current.truth,
  }));
  return deepFreeze({
    corpusHash: loaded.hash,
    clean,
    noisy,
    degenerate,
  });
}

export async function runFitBenchmark({
  candidates,
  warmupRuns = FIT_BENCHMARK_DEFAULTS.warmupRuns,
  measuredRuns = FIT_BENCHMARK_DEFAULTS.measuredRuns,
  phraseFits = FIT_BENCHMARK_DEFAULTS.phraseFits,
  now = () => performance.now(),
} = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new TypeError("at least one FitWorker candidate is required");
  }
  assertPositiveSafeInteger(warmupRuns, "warmupRuns");
  assertPositiveSafeInteger(measuredRuns, "measuredRuns");
  assertPositiveSafeInteger(phraseFits, "phraseFits");
  const cases = createFitBenchmarkCases();
  const reports = [];
  for (const candidate of candidates) {
    reports.push(await benchmarkCandidate({
      candidate,
      cases,
      warmupRuns,
      measuredRuns,
      phraseFits,
      now,
    }));
  }
  const selection = selectCandidate(reports);
  return deepFreeze({
    kind: "svcopilot-fit-worker-benchmark",
    schemaVersion: FIT_BENCHMARK_SCHEMA_VERSION,
    protocolVersion: 1,
    corpus: {
      hash: cases.corpusHash,
      cleanCaseIds: cases.clean.map((current) => current.id),
      noisyCaseIds: cases.noisy.map((current) => current.id),
      degenerateCaseIds: cases.degenerate.map((current) => current.id),
    },
    configuration: {
      warmupRuns,
      measuredRuns,
      phraseFits,
      gates: FIT_BENCHMARK_GATES,
    },
    candidates: reports,
    selection,
  });
}

export function sealFitBenchmarkArtifact({ artifactStore, report, sessionId = "fit-benchmark", sourceEpoch = 0 }) {
  if (!artifactStore || typeof artifactStore.seal !== "function") {
    throw new TypeError("artifactStore must provide seal");
  }
  return artifactStore.seal({
    kind: "fit-worker-benchmark",
    schemaVersion: "1",
    sessionId,
    sourceEpoch,
    payload: report,
  });
}

function createRichardsCase(current, category) {
  const source = current.input;
  const fromCents = source.lowerPitch * 100;
  const toCents = source.upperPitch * 100;
  const sampleCount = category === "clean" ? 121 : 181;
  const timeSeconds = Array.from(
    { length: sampleCount },
    (_, index) => source.spanSeconds * index / (sampleCount - 1),
  );
  const truth = {
    fromSeconds: 0,
    toSeconds: source.spanSeconds,
    fromCents,
    toCents,
    inflectionSeconds: source.inflectionSeconds,
    growthPerSecond: source.growthPerSecond,
    asymmetryB: source.asymmetryB,
  };
  const mask = timeSeconds.map((_, index) => (
    category === "clean" || index === 0 || index === sampleCount - 1 || index % 13 !== 0
  ));
  const cents = timeSeconds.map((time, index) => {
    if (!mask[index]) return null;
    const exact = predictRichards(time, truth);
    return category === "clean" ? exact : exact + 1.5 * Math.sin((index + current.seed) * 0.71);
  });
  const interval = toCents - fromCents;
  const request = {
    protocolVersion: 1,
    requestId: `fit_${current.id.replace(/[^A-Za-z0-9_]/g, "_")}_${category}`,
    operation: "fit_richards_segment",
    samples: { timeSeconds, cents, mask },
    initial: {
      fromSeconds: 0,
      toSeconds: source.spanSeconds,
      fromCents: fromCents + interval * 0.15,
      toCents: toCents - interval * 0.15,
      inflectionSeconds: source.spanSeconds * 0.5,
      growthPerSecond: 20,
      asymmetryB: 4,
    },
    bounds: {
      fromCents: { minimum: fromCents - 300, maximum: fromCents + 300 },
      toCents: { minimum: toCents - 300, maximum: toCents + 300 },
      inflectionSeconds: { minimum: 0, maximum: source.spanSeconds },
      growthPerSecond: { minimum: 1, maximum: 40 },
      asymmetryB: { minimum: Math.exp(-3), maximum: Math.exp(3) },
    },
    loss: { kind: "huber", scaleCents: 8 },
    limits: { maxIterations: 80, maxStarts: 4, timeoutMs: 1_000 },
    seed: current.seed,
  };
  return deepFreeze({
    id: `${current.id}-${category}`,
    category,
    request,
    truth,
    truthValues: timeSeconds.map((time) => predictRichards(time, truth)),
  });
}

async function benchmarkCandidate({ candidate, cases, warmupRuns, measuredRuns, phraseFits, now }) {
  assertCandidate(candidate);
  try {
    const clean = await evaluateFits(candidate, cases.clean);
    const noisy = await evaluateFits(candidate, cases.noisy);
    const degenerate = await evaluateFits(candidate, cases.degenerate);
    for (let run = 0; run < warmupRuns; run += 1) await candidate.fit(cases.clean[0].request);
    const singleDurations = [];
    for (let run = 0; run < measuredRuns; run += 1) {
      const startedAt = now();
      await candidate.fit(cases.clean[run % cases.clean.length].request);
      singleDurations.push(now() - startedAt);
    }
    const phraseDurations = [];
    for (let run = 0; run < measuredRuns; run += 1) {
      const startedAt = now();
      for (let index = 0; index < phraseFits; index += 1) {
        await candidate.fit(cases.clean[index % cases.clean.length].request);
      }
      phraseDurations.push(now() - startedAt);
    }
    const replayOne = await candidate.fit(cases.clean[0].request);
    const replayTwo = await candidate.fit(cases.clean[0].request);
    const timeoutRecovery = typeof candidate.verifyTimeoutRecovery === "function"
      ? await candidate.verifyTimeoutRecovery(cases.clean[0].request)
      : { eligible: false, status: "not_provided" };
    const report = {
      id: candidate.id,
      engine: candidate.engine,
      packaging: candidate.packaging,
      dependencyFootprint: candidate.dependencyFootprint,
      license: candidate.license,
      crashIsolation: candidate.crashIsolation,
      quality: {
        clean,
        noisy,
        degenerate,
        cleanRecoveryRate: recoveryRate(clean),
        noisyRecoveryRate: recoveryRate(noisy),
        degenerateRejectionRate: degenerate.filter((current) => current.termination === "rejected").length
          / degenerate.length,
      },
      determinism: {
        firstHash: fitWorkerResultHash(replayOne),
        secondHash: fitWorkerResultHash(replayTwo),
        eligible: fitWorkerResultHash(replayOne) === fitWorkerResultHash(replayTwo),
      },
      timeoutRecovery,
      performance: {
        startupCostMs: typeof candidate.getStartupCostMs === "function"
          ? candidate.getStartupCostMs()
          : 0,
        singleFit: summarizeDurations(singleDurations),
        phraseFit: summarizeDurations(phraseDurations),
      },
    };
    return deepFreeze({ ...report, gates: evaluateGates(report) });
  } finally {
    if (typeof candidate.dispose === "function") await candidate.dispose();
  }
}

async function evaluateFits(candidate, cases) {
  const results = [];
  for (const current of cases) results.push(await evaluateFit(candidate, current));
  return results;
}

async function evaluateFit(candidate, current) {
  try {
    const response = await candidate.fit(current.request);
    const validated = revalidateFitWorkerResult(current.request, response);
    if (response.termination !== "converged") {
      return deepFreeze({
        id: current.id,
        termination: response.termination,
        accepted: false,
        truthRmseCents: null,
        canonicalForwardMaxDeviationCents: null,
        normalizedParameterError: null,
      });
    }
    const truthRmseCents = truthRmse(current, validated.result.parameters);
    const canonicalForwardMaxDeviationCents = maximumForwardDeviation(
      current,
      validated.result.parameters,
    );
    const parameterError = maximumNormalizedParameterError(current, validated.result.parameters);
    const gates = current.category === "clean"
      ? {
        maximumTruthRmseCents: FIT_BENCHMARK_GATES.maximumCleanTruthRmseCents,
        maximumNormalizedParameterError: FIT_BENCHMARK_GATES.maximumCleanNormalizedParameterError,
      }
      : {
        maximumTruthRmseCents: FIT_BENCHMARK_GATES.maximumNoisyTruthRmseCents,
        maximumNormalizedParameterError: FIT_BENCHMARK_GATES.maximumNoisyNormalizedParameterError,
      };
    return deepFreeze({
      id: current.id,
      termination: response.termination,
      accepted: validated.accepted
        && truthRmseCents <= gates.maximumTruthRmseCents
        && parameterError <= gates.maximumNormalizedParameterError,
      truthRmseCents,
      canonicalForwardMaxDeviationCents,
      normalizedParameterError: parameterError,
    });
  } catch (error) {
    return deepFreeze({
      id: current.id,
      termination: "error",
      accepted: false,
      errorCode: error.code ?? error.name,
      truthRmseCents: null,
      canonicalForwardMaxDeviationCents: null,
      normalizedParameterError: null,
    });
  }
}

function truthRmse(current, parameters) {
  let total = 0;
  let count = 0;
  for (let index = 0; index < current.truthValues.length; index += 1) {
    if (!current.request.samples.mask[index]) continue;
    const residual = predictRichards(current.request.samples.timeSeconds[index], parameters)
      - current.truthValues[index];
    total += residual * residual;
    count += 1;
  }
  return Math.sqrt(total / count);
}

function maximumForwardDeviation(current, parameters) {
  let maximum = 0;
  for (let index = 0; index < current.truthValues.length; index += 1) {
    maximum = Math.max(
      maximum,
      Math.abs(
        predictRichards(current.request.samples.timeSeconds[index], parameters)
          - current.truthValues[index],
      ),
    );
  }
  return maximum;
}

function maximumNormalizedParameterError(current, parameters) {
  let maximum = 0;
  for (const name of FIT_RICHARDS_PARAMETER_NAMES) {
    const range = current.request.bounds[name];
    maximum = Math.max(
      maximum,
      Math.abs(parameters[name] - current.truth[name]) / (range.maximum - range.minimum),
    );
  }
  return maximum;
}

function recoveryRate(results) {
  return results.filter((current) => current.accepted).length / results.length;
}

function evaluateGates(report) {
  const gates = {
    canonicalForwardParity: report.quality.clean.every((current) => (
      current.canonicalForwardMaxDeviationCents !== null
        && current.canonicalForwardMaxDeviationCents <= 1e-9
    )),
    cleanRecovery: report.quality.cleanRecoveryRate >= FIT_BENCHMARK_GATES.minimumCleanRecoveryRate,
    noisyNullRecovery: report.quality.noisyRecoveryRate >= FIT_BENCHMARK_GATES.minimumNoisyRecoveryRate,
    degenerateRejection: report.quality.degenerateRejectionRate === 1,
    deterministicReplay: report.determinism.eligible,
    singleFitP95: report.performance.singleFit.p95Ms <= FIT_BENCHMARK_GATES.maximumSingleFitP95Ms,
    phraseFitP95: report.performance.phraseFit.p95Ms <= FIT_BENCHMARK_GATES.maximumPhraseFitP95Ms,
    timeoutRecovery: report.timeoutRecovery.eligible === true,
    crashIsolation: report.crashIsolation.eligible === true,
    packaging: report.packaging.eligible === true,
    license: report.license.eligible === true,
  };
  return deepFreeze({
    ...gates,
    eligible: Object.values(gates).every(Boolean),
  });
}

function selectCandidate(reports) {
  const selected = reports.find((current) => current.id === FIT_WORKER_NODE_ENGINE.name && current.gates.eligible)
    ?? reports.find((current) => current.gates.eligible)
    ?? null;
  return deepFreeze({
    status: selected ? "selected" : "blocked",
    selectedCandidateId: selected?.id ?? null,
    reason: selected?.id === FIT_WORKER_NODE_ENGINE.name
      ? "Node meets every fixed P4 gate without adding a runtime dependency"
      : selected
        ? "the first eligible non-Node candidate met every fixed P4 gate"
        : "no candidate met every fixed P4 gate",
  });
}

function predictRichards(timeSeconds, parameters) {
  return richardsTransition(
    timeSeconds,
    parameters.fromSeconds,
    parameters.toSeconds,
    parameters.fromCents,
    parameters.toCents,
    parameters.inflectionSeconds,
    parameters.growthPerSecond,
    parameters.asymmetryB,
  );
}

function summarizeDurations(durations) {
  const ordered = [...durations].sort((left, right) => left - right);
  return {
    runs: ordered.length,
    medianMs: ordered[Math.floor(ordered.length / 2)],
    p95Ms: ordered[Math.ceil(ordered.length * 0.95) - 1],
  };
}

function assertCandidate(candidate) {
  if (
    !candidate
    || typeof candidate !== "object"
    || typeof candidate.id !== "string"
    || !candidate.id
    || typeof candidate.fit !== "function"
  ) {
    throw new TypeError("FitWorker candidate must expose id and fit");
  }
  for (const field of ["engine", "packaging", "dependencyFootprint", "license", "crashIsolation"]) {
    if (!candidate[field] || typeof candidate[field] !== "object") {
      throw new TypeError(`FitWorker candidate must expose ${field}`);
    }
  }
}

function assertPositiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be positive`);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
