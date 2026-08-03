import { contentHash } from "../canonical-json.js";
import { richardsTransition } from "./richards.js";

export const FIT_WORKER_PROTOCOL_VERSION = 1;
export const FIT_RICHARDS_SEGMENT_OPERATION = "fit_richards_segment";
export const FIT_WORKER_NODE_ENGINE = Object.freeze({
  name: "node-bounded-richards",
  version: "1",
});
export const FIT_RICHARDS_PARAMETER_NAMES = Object.freeze([
  "fromCents",
  "toCents",
  "inflectionSeconds",
  "growthPerSecond",
  "asymmetryB",
]);
export const FIT_WORKER_LIMITS = Object.freeze({
  maximumSamples: 2_000,
  minimumFiniteSamples: 11,
  maximumIterations: 200,
  maximumStarts: 16,
  maximumTimeoutMs: 1_000,
});
export const FIT_IDENTIFIABILITY_MAX_NORMALIZED_SPREAD = 0.1;

const REQUEST_KEYS = [
  "protocolVersion",
  "requestId",
  "operation",
  "samples",
  "initial",
  "bounds",
  "loss",
  "limits",
  "seed",
];
const SAMPLE_KEYS = ["timeSeconds", "cents", "mask"];
const INITIAL_KEYS = [
  "fromSeconds",
  "toSeconds",
  ...FIT_RICHARDS_PARAMETER_NAMES,
];
const LOSS_KEYS = ["kind", "scaleCents"];
const LIMIT_KEYS = ["maxIterations", "maxStarts", "timeoutMs"];
const RESULT_KEYS = [
  "protocolVersion",
  "requestId",
  "operation",
  "engine",
  "termination",
  "parameters",
  "metrics",
  "warnings",
];
const METRIC_KEYS = ["rmseCents", "maxAbsCents", "iterations", "multiStartSpread"];
const TERMINATIONS = new Set(["converged", "iteration_limit", "timeout", "rejected"]);

export function normalizeFitWorkerRequest(input) {
  assertRecord(input, "$", "INVALID_FIT_WORKER_REQUEST");
  assertExactKeys(input, REQUEST_KEYS, "$", "INVALID_FIT_WORKER_REQUEST");
  if (input.protocolVersion !== FIT_WORKER_PROTOCOL_VERSION) {
    throw codedError(
      "FIT_WORKER_PROTOCOL_VERSION_UNSUPPORTED",
      "unsupported FitWorker protocol version",
      { actual: input.protocolVersion, expected: FIT_WORKER_PROTOCOL_VERSION },
    );
  }
  if (typeof input.requestId !== "string" || !/^fit_[A-Za-z0-9_-]+$/.test(input.requestId)) {
    throw codedError("INVALID_FIT_WORKER_REQUEST", "requestId must be a fit_ identifier", {
      path: "$/requestId",
    });
  }
  if (input.operation !== FIT_RICHARDS_SEGMENT_OPERATION) {
    throw codedError("INVALID_FIT_WORKER_REQUEST", "operation is unsupported", {
      path: "$/operation",
      actual: input.operation,
      expected: FIT_RICHARDS_SEGMENT_OPERATION,
    });
  }
  const initial = normalizeInitial(input.initial);
  const bounds = normalizeBounds(input.bounds, initial);
  const samples = normalizeSamples(input.samples, initial);
  const loss = normalizeLoss(input.loss);
  const limits = normalizeLimits(input.limits);
  if (!Number.isSafeInteger(input.seed) || input.seed < 0) {
    throw codedError("INVALID_FIT_WORKER_REQUEST", "seed must be a non-negative safe integer", {
      path: "$/seed",
    });
  }
  return deepFreeze({
    protocolVersion: FIT_WORKER_PROTOCOL_VERSION,
    requestId: input.requestId,
    operation: FIT_RICHARDS_SEGMENT_OPERATION,
    samples,
    initial,
    bounds,
    loss,
    limits,
    seed: input.seed,
  });
}

export function fitRichardsSegment(input, { now = () => performance.now() } = {}) {
  const request = normalizeFitWorkerRequest(input);
  const finiteIndexes = request.samples.mask
    .map((isFiniteSample, index) => (isFiniteSample ? index : null))
    .filter((index) => index !== null);
  if (finiteIndexes.length < FIT_WORKER_LIMITS.minimumFiniteSamples) {
    return terminalResult(request, "rejected", "INSUFFICIENT_FINITE_SAMPLES");
  }
  const startedAt = now();
  const deadline = startedAt + request.limits.timeoutMs;
  const state = createFitState(request, finiteIndexes);
  const starts = createStarts(state, request.limits.maxStarts, request.seed);
  const candidates = [];
  for (const start of starts) {
    if (now() >= deadline) return terminalResult(request, "timeout", "FIT_TIMEOUT");
    const candidate = optimizeStart(state, start, request.limits.maxIterations, now, deadline);
    if (candidate.timeout) return terminalResult(request, "timeout", "FIT_TIMEOUT");
    if (candidate.objective !== Infinity) candidates.push(candidate);
  }
  if (candidates.length === 0) {
    return terminalResult(request, "rejected", "FIT_NUMERIC_FAILURE");
  }
  candidates.sort((left, right) => left.objective - right.objective);
  const best = candidates[0];
  const termination = best.converged ? "converged" : "iteration_limit";
  const metrics = metricsFor(state, best.normalized, best.iterations, multiStartSpread(best, candidates));
  return deepFreeze({
    protocolVersion: FIT_WORKER_PROTOCOL_VERSION,
    requestId: request.requestId,
    operation: request.operation,
    engine: FIT_WORKER_NODE_ENGINE,
    termination,
    parameters: parametersFor(state, best.normalized),
    metrics,
    warnings: termination === "converged" ? [] : [{ code: "FIT_DID_NOT_CONVERGE" }],
  });
}

export function revalidateFitWorkerResult(input, result) {
  const request = normalizeFitWorkerRequest(input);
  const normalizedResult = normalizeFitWorkerResult(request, result);
  if (normalizedResult.termination === "rejected" || normalizedResult.termination === "timeout") {
    return deepFreeze({
      accepted: false,
      result: normalizedResult,
      resultHash: contentHash(normalizedResult),
      identifiability: "not_assessed",
    });
  }
  const finiteIndexes = request.samples.mask
    .map((isFiniteSample, index) => (isFiniteSample ? index : null))
    .filter((index) => index !== null);
  const state = createFitState(request, finiteIndexes);
  const normalized = normalizedParameters(state, normalizedResult.parameters);
  const canonicalMetrics = metricsFor(
    state,
    normalized,
    normalizedResult.metrics.iterations,
    normalizedResult.metrics.multiStartSpread,
  );
  assertMetricMatches(
    normalizedResult.metrics.rmseCents,
    canonicalMetrics.rmseCents,
    "$/metrics/rmseCents",
  );
  assertMetricMatches(
    normalizedResult.metrics.maxAbsCents,
    canonicalMetrics.maxAbsCents,
    "$/metrics/maxAbsCents",
  );
  const canonicalResult = deepFreeze({
    ...normalizedResult,
    parameters: parametersFor(state, normalized),
    metrics: canonicalMetrics,
  });
  if (normalizedResult.termination !== "converged") {
    return deepFreeze({
      accepted: false,
      result: canonicalResult,
      resultHash: contentHash(canonicalResult),
      identifiability: "not_assessed",
    });
  }
  return deepFreeze({
    accepted: canonicalMetrics.multiStartSpread <= FIT_IDENTIFIABILITY_MAX_NORMALIZED_SPREAD,
    result: canonicalResult,
    resultHash: contentHash(canonicalResult),
    identifiability: canonicalMetrics.multiStartSpread <= FIT_IDENTIFIABILITY_MAX_NORMALIZED_SPREAD
      ? "identified"
      : "not_identifiable",
  });
}

export function fitWorkerResultHash(result) {
  return contentHash(result);
}

function normalizeInitial(value) {
  assertRecord(value, "$/initial", "INVALID_FIT_WORKER_REQUEST");
  assertExactKeys(value, INITIAL_KEYS, "$/initial", "INVALID_FIT_WORKER_REQUEST");
  const initial = {};
  for (const name of INITIAL_KEYS) initial[name] = finiteNumber(value[name], `$/initial/${name}`);
  if (initial.toSeconds <= initial.fromSeconds) {
    throw codedError("INVALID_FIT_WORKER_REQUEST", "toSeconds must be after fromSeconds", {
      path: "$/initial/toSeconds",
    });
  }
  if (
    initial.inflectionSeconds < initial.fromSeconds
    || initial.inflectionSeconds > initial.toSeconds
  ) {
    throw codedError("INVALID_FIT_WORKER_REQUEST", "inflectionSeconds must be inside the fit span", {
      path: "$/initial/inflectionSeconds",
    });
  }
  if (initial.growthPerSecond <= 0 || initial.asymmetryB <= 0) {
    throw codedError("INVALID_FIT_WORKER_REQUEST", "Richards shape parameters must be positive", {
      path: "$/initial",
    });
  }
  return deepFreeze(initial);
}

function normalizeBounds(value, initial) {
  assertRecord(value, "$/bounds", "INVALID_FIT_WORKER_REQUEST");
  assertExactKeys(value, FIT_RICHARDS_PARAMETER_NAMES, "$/bounds", "INVALID_FIT_WORKER_REQUEST");
  const bounds = {};
  for (const name of FIT_RICHARDS_PARAMETER_NAMES) {
    const current = value[name];
    assertRecord(current, `$/bounds/${name}`, "INVALID_FIT_WORKER_REQUEST");
    assertExactKeys(
      current,
      ["minimum", "maximum"],
      `$/bounds/${name}`,
      "INVALID_FIT_WORKER_REQUEST",
    );
    const minimum = finiteNumber(current.minimum, `$/bounds/${name}/minimum`);
    const maximum = finiteNumber(current.maximum, `$/bounds/${name}/maximum`);
    if (maximum <= minimum) {
      throw codedError("INVALID_FIT_WORKER_REQUEST", "parameter bounds must have positive width", {
        path: `$/bounds/${name}`,
      });
    }
    if ((name === "growthPerSecond" || name === "asymmetryB") && minimum <= 0) {
      throw codedError("INVALID_FIT_WORKER_REQUEST", "Richards shape bounds must be positive", {
        path: `$/bounds/${name}/minimum`,
      });
    }
    if (name === "inflectionSeconds") {
      if (minimum < initial.fromSeconds || maximum > initial.toSeconds) {
        throw codedError("INVALID_FIT_WORKER_REQUEST", "inflection bounds must stay inside the fit span", {
          path: `$/bounds/${name}`,
        });
      }
    }
    if (initial[name] < minimum || initial[name] > maximum) {
      throw codedError("INVALID_FIT_WORKER_REQUEST", "initial parameter must be inside bounds", {
        path: `$/initial/${name}`,
      });
    }
    bounds[name] = { minimum, maximum };
  }
  return deepFreeze(bounds);
}

function normalizeSamples(value, initial) {
  assertRecord(value, "$/samples", "INVALID_FIT_WORKER_REQUEST");
  assertExactKeys(value, SAMPLE_KEYS, "$/samples", "INVALID_FIT_WORKER_REQUEST");
  if (
    !Array.isArray(value.timeSeconds)
    || !Array.isArray(value.cents)
    || !Array.isArray(value.mask)
    || value.timeSeconds.length === 0
    || value.timeSeconds.length !== value.cents.length
    || value.timeSeconds.length !== value.mask.length
  ) {
    throw codedError("INVALID_FIT_WORKER_REQUEST", "sample arrays must be non-empty and aligned", {
      path: "$/samples",
    });
  }
  if (value.timeSeconds.length > FIT_WORKER_LIMITS.maximumSamples) {
    throw codedError("FIT_SAMPLE_BUDGET_EXCEEDED", "fit sample budget exceeded", {
      maximum: FIT_WORKER_LIMITS.maximumSamples,
      actual: value.timeSeconds.length,
    });
  }
  const timeSeconds = [];
  const cents = [];
  const mask = [];
  let previous = -Infinity;
  for (let index = 0; index < value.timeSeconds.length; index += 1) {
    const timeSecondsValue = finiteNumber(value.timeSeconds[index], `$/samples/timeSeconds/${index}`);
    if (timeSecondsValue <= previous) {
      throw codedError("INVALID_FIT_WORKER_REQUEST", "sample times must be strictly increasing", {
        path: `$/samples/timeSeconds/${index}`,
      });
    }
    if (timeSecondsValue < initial.fromSeconds || timeSecondsValue > initial.toSeconds) {
      throw codedError("INVALID_FIT_WORKER_REQUEST", "sample time is outside the fit span", {
        path: `$/samples/timeSeconds/${index}`,
      });
    }
    if (typeof value.mask[index] !== "boolean") {
      throw codedError("INVALID_FIT_WORKER_REQUEST", "sample mask must be boolean", {
        path: `$/samples/mask/${index}`,
      });
    }
    const isFiniteSample = value.mask[index];
    const centsValue = value.cents[index];
    if (isFiniteSample && !Number.isFinite(centsValue)) {
      throw codedError("INVALID_FIT_WORKER_REQUEST", "finite sample cents must be finite", {
        path: `$/samples/cents/${index}`,
      });
    }
    if (!isFiniteSample && centsValue !== null) {
      throw codedError("INVALID_FIT_WORKER_REQUEST", "masked sample cents must be null", {
        path: `$/samples/cents/${index}`,
      });
    }
    previous = timeSecondsValue;
    timeSeconds.push(normalizeNegativeZero(timeSecondsValue));
    cents.push(isFiniteSample ? normalizeNegativeZero(centsValue) : null);
    mask.push(isFiniteSample);
  }
  return deepFreeze({ timeSeconds, cents, mask });
}

function normalizeLoss(value) {
  assertRecord(value, "$/loss", "INVALID_FIT_WORKER_REQUEST");
  assertExactKeys(value, LOSS_KEYS, "$/loss", "INVALID_FIT_WORKER_REQUEST");
  if (value.kind !== "huber") {
    throw codedError("INVALID_FIT_WORKER_REQUEST", "loss.kind must be huber", {
      path: "$/loss/kind",
    });
  }
  const scaleCents = finiteNumber(value.scaleCents, "$/loss/scaleCents");
  if (scaleCents <= 0) {
    throw codedError("INVALID_FIT_WORKER_REQUEST", "Huber scale must be positive", {
      path: "$/loss/scaleCents",
    });
  }
  return deepFreeze({ kind: "huber", scaleCents });
}

function normalizeLimits(value) {
  assertRecord(value, "$/limits", "INVALID_FIT_WORKER_REQUEST");
  assertExactKeys(value, LIMIT_KEYS, "$/limits", "INVALID_FIT_WORKER_REQUEST");
  const limits = {};
  for (const [name, maximum] of [
    ["maxIterations", FIT_WORKER_LIMITS.maximumIterations],
    ["maxStarts", FIT_WORKER_LIMITS.maximumStarts],
    ["timeoutMs", FIT_WORKER_LIMITS.maximumTimeoutMs],
  ]) {
    const current = value[name];
    if (!Number.isSafeInteger(current) || current < 1 || current > maximum) {
      throw codedError("INVALID_FIT_WORKER_REQUEST", `${name} is outside the supported range`, {
        path: `$/limits/${name}`,
        maximum,
      });
    }
    limits[name] = current;
  }
  return deepFreeze(limits);
}

function createFitState(request, finiteIndexes) {
  return {
    request,
    finiteIndexes,
    lower: FIT_RICHARDS_PARAMETER_NAMES.map((name) => request.bounds[name].minimum),
    upper: FIT_RICHARDS_PARAMETER_NAMES.map((name) => request.bounds[name].maximum),
  };
}

function createStarts(state, maxStarts, seed) {
  const starts = [normalizedParameters(state, state.request.initial)];
  const random = seededRandom(seed);
  for (let index = 1; index < maxStarts; index += 1) {
    starts.push(FIT_RICHARDS_PARAMETER_NAMES.map(() => 0.1 + random() * 0.8));
  }
  return starts;
}

function optimizeStart(state, start, maximumIterations, now, deadline) {
  let normalized = [...start];
  let objective = objectiveFor(state, normalized);
  let lambda = 0.01;
  for (let iteration = 1; iteration <= maximumIterations; iteration += 1) {
    if (now() >= deadline) return { timeout: true };
    const base = predictionsFor(state, normalized);
    if (!base) return { normalized, objective: Infinity, iterations: iteration, converged: false };
    const jacobian = jacobianFor(state, normalized, base);
    const delta = solveNormalEquations(state, base, jacobian, lambda);
    if (!delta) {
      lambda = Math.min(lambda * 10, 1e12);
      continue;
    }
    const candidate = normalized.map((value, index) => clampUnit(value + delta[index]));
    const candidateObjective = objectiveFor(state, candidate);
    if (candidateObjective < objective) {
      normalized = candidate;
      objective = candidateObjective;
      lambda = Math.max(lambda / 10, 1e-12);
      if (Math.max(...delta.map((value) => Math.abs(value))) < 1e-7) {
        return { normalized, objective, iterations: iteration, converged: true };
      }
      continue;
    }
    lambda = Math.min(lambda * 10, 1e12);
  }
  return { normalized, objective, iterations: maximumIterations, converged: false };
}

function predictionsFor(state, normalized) {
  const parameters = parametersFor(state, normalized);
  const values = [];
  try {
    for (const index of state.finiteIndexes) {
      const value = richardsTransition(
        state.request.samples.timeSeconds[index],
        parameters.fromSeconds,
        parameters.toSeconds,
        parameters.fromCents,
        parameters.toCents,
        parameters.inflectionSeconds,
        parameters.growthPerSecond,
        parameters.asymmetryB,
      );
      if (!Number.isFinite(value)) return null;
      values.push(value);
    }
  } catch {
    return null;
  }
  return values;
}

function objectiveFor(state, normalized) {
  const predictions = predictionsFor(state, normalized);
  if (!predictions) return Infinity;
  let total = 0;
  for (let index = 0; index < predictions.length; index += 1) {
    const sampleIndex = state.finiteIndexes[index];
    const residual = predictions[index] - state.request.samples.cents[sampleIndex];
    total += huberLoss(residual, state.request.loss.scaleCents);
  }
  return total / predictions.length;
}

function jacobianFor(state, normalized, base) {
  const jacobian = Array.from(
    { length: FIT_RICHARDS_PARAMETER_NAMES.length },
    () => Array(base.length).fill(0),
  );
  for (let parameterIndex = 0; parameterIndex < FIT_RICHARDS_PARAMETER_NAMES.length; parameterIndex += 1) {
    const step = 1e-5;
    const positive = [...normalized];
    const negative = [...normalized];
    positive[parameterIndex] = clampUnit(positive[parameterIndex] + step);
    negative[parameterIndex] = clampUnit(negative[parameterIndex] - step);
    const denominator = positive[parameterIndex] - negative[parameterIndex];
    if (denominator === 0) continue;
    const positiveValues = predictionsFor(state, positive);
    const negativeValues = predictionsFor(state, negative);
    if (!positiveValues || !negativeValues) continue;
    for (let sampleIndex = 0; sampleIndex < base.length; sampleIndex += 1) {
      jacobian[parameterIndex][sampleIndex] = (
        positiveValues[sampleIndex] - negativeValues[sampleIndex]
      ) / denominator;
    }
  }
  return jacobian;
}

function solveNormalEquations(state, predictions, jacobian, lambda) {
  const count = FIT_RICHARDS_PARAMETER_NAMES.length;
  const matrix = Array.from({ length: count }, () => Array(count).fill(0));
  const vector = Array(count).fill(0);
  for (let sampleIndex = 0; sampleIndex < predictions.length; sampleIndex += 1) {
    const sourceIndex = state.finiteIndexes[sampleIndex];
    const residual = predictions[sampleIndex] - state.request.samples.cents[sourceIndex];
    const weight = Math.min(1, state.request.loss.scaleCents / Math.max(Math.abs(residual), Number.EPSILON));
    for (let row = 0; row < count; row += 1) {
      vector[row] -= jacobian[row][sampleIndex] * weight * residual;
      for (let column = 0; column < count; column += 1) {
        matrix[row][column] += jacobian[row][sampleIndex] * weight * jacobian[column][sampleIndex];
      }
    }
  }
  for (let index = 0; index < count; index += 1) matrix[index][index] += lambda;
  return solveLinearSystem(matrix, vector);
}

function solveLinearSystem(matrix, vector) {
  const size = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    if (Math.abs(augmented[pivot][column]) < 1e-14) return null;
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    for (let index = column; index <= size; index += 1) augmented[column][index] /= divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let index = column; index <= size; index += 1) {
        augmented[row][index] -= factor * augmented[column][index];
      }
    }
  }
  const solution = augmented.map((row) => row[size]);
  return solution.every(Number.isFinite) ? solution : null;
}

function parametersFor(state, normalized) {
  const parameters = {
    fromSeconds: state.request.initial.fromSeconds,
    toSeconds: state.request.initial.toSeconds,
  };
  for (const [index, name] of FIT_RICHARDS_PARAMETER_NAMES.entries()) {
    parameters[name] = normalizeNegativeZero(
      state.lower[index] + normalized[index] * (state.upper[index] - state.lower[index]),
    );
  }
  return deepFreeze(parameters);
}

function normalizedParameters(state, parameters) {
  const normalized = [];
  for (const [index, name] of FIT_RICHARDS_PARAMETER_NAMES.entries()) {
    const value = parameters[name];
    const minimum = state.lower[index];
    const maximum = state.upper[index];
    if (!Number.isFinite(value) || value < minimum || value > maximum) {
      throw codedError("FIT_WORKER_RESULT_MISMATCH", "worker parameter is outside request bounds", {
        path: `$/parameters/${name}`,
      });
    }
    normalized.push((value - minimum) / (maximum - minimum));
  }
  return normalized;
}

function metricsFor(state, normalized, iterations, multiStartSpread) {
  const predictions = predictionsFor(state, normalized);
  if (!predictions) {
    throw codedError("FIT_WORKER_RESULT_MISMATCH", "canonical Richards prediction is not finite");
  }
  let squaredTotal = 0;
  let maximumAbsolute = 0;
  for (let index = 0; index < predictions.length; index += 1) {
    const sourceIndex = state.finiteIndexes[index];
    const residual = predictions[index] - state.request.samples.cents[sourceIndex];
    squaredTotal += residual * residual;
    maximumAbsolute = Math.max(maximumAbsolute, Math.abs(residual));
  }
  return deepFreeze({
    rmseCents: normalizeNegativeZero(Math.sqrt(squaredTotal / predictions.length)),
    maxAbsCents: normalizeNegativeZero(maximumAbsolute),
    iterations,
    multiStartSpread: normalizeNegativeZero(multiStartSpread),
  });
}

function multiStartSpread(best, candidates) {
  const comparable = candidates.filter((candidate) => (
    candidate.objective <= best.objective + Math.max(1e-9, best.objective * 0.01)
  ));
  let spread = 0;
  for (const candidate of comparable) {
    for (let index = 0; index < candidate.normalized.length; index += 1) {
      spread = Math.max(spread, Math.abs(candidate.normalized[index] - best.normalized[index]));
    }
  }
  return spread;
}

function normalizeFitWorkerResult(request, value) {
  assertRecord(value, "$", "INVALID_FIT_WORKER_RESULT");
  assertExactKeys(value, RESULT_KEYS, "$", "INVALID_FIT_WORKER_RESULT");
  if (
    value.protocolVersion !== FIT_WORKER_PROTOCOL_VERSION
    || value.requestId !== request.requestId
    || value.operation !== request.operation
  ) {
    throw codedError("FIT_WORKER_RESULT_MISMATCH", "worker result does not match its request");
  }
  assertRecord(value.engine, "$/engine", "INVALID_FIT_WORKER_RESULT");
  assertExactKeys(value.engine, ["name", "version"], "$/engine", "INVALID_FIT_WORKER_RESULT");
  if (
    typeof value.engine.name !== "string"
    || !value.engine.name
    || typeof value.engine.version !== "string"
    || !value.engine.version
  ) {
    throw codedError("INVALID_FIT_WORKER_RESULT", "engine identity must be non-empty strings", {
      path: "$/engine",
    });
  }
  if (!TERMINATIONS.has(value.termination)) {
    throw codedError("INVALID_FIT_WORKER_RESULT", "worker termination is unsupported", {
      path: "$/termination",
    });
  }
  if (!Array.isArray(value.warnings) || value.warnings.some((warning) => (
    !warning
    || typeof warning !== "object"
    || Array.isArray(warning)
    || typeof warning.code !== "string"
    || Object.keys(warning).length !== 1
    || !Object.hasOwn(warning, "code")
  ))) {
    throw codedError("INVALID_FIT_WORKER_RESULT", "warnings must contain code records", {
      path: "$/warnings",
    });
  }
  const warnings = value.warnings.map((warning) => ({ code: warning.code }));
  if (value.termination === "rejected" || value.termination === "timeout") {
    if (value.parameters !== null) {
      throw codedError("INVALID_FIT_WORKER_RESULT", "terminal non-converged result must omit parameters", {
        path: "$/parameters",
      });
    }
    const metrics = normalizeTerminalMetrics(value.metrics);
    return deepFreeze({
      protocolVersion: FIT_WORKER_PROTOCOL_VERSION,
      requestId: request.requestId,
      operation: request.operation,
      engine: { name: value.engine.name, version: value.engine.version },
      termination: value.termination,
      parameters: null,
      metrics,
      warnings,
    });
  }
  const parameters = normalizeResultParameters(request, value.parameters);
  const metrics = normalizeMetrics(value.metrics);
  if (metrics.iterations > request.limits.maxIterations) {
    throw codedError("FIT_WORKER_RESULT_MISMATCH", "worker exceeded the requested iteration limit", {
      path: "$/metrics/iterations",
    });
  }
  return deepFreeze({
    protocolVersion: FIT_WORKER_PROTOCOL_VERSION,
    requestId: request.requestId,
    operation: request.operation,
    engine: { name: value.engine.name, version: value.engine.version },
    termination: value.termination,
    parameters,
    metrics,
    warnings,
  });
}

function normalizeResultParameters(request, value) {
  assertRecord(value, "$/parameters", "INVALID_FIT_WORKER_RESULT");
  assertExactKeys(value, INITIAL_KEYS, "$/parameters", "INVALID_FIT_WORKER_RESULT");
  const parameters = {};
  for (const name of INITIAL_KEYS) {
    parameters[name] = finiteNumber(
      value[name],
      `$/parameters/${name}`,
      "INVALID_FIT_WORKER_RESULT",
    );
  }
  if (
    parameters.fromSeconds !== request.initial.fromSeconds
    || parameters.toSeconds !== request.initial.toSeconds
  ) {
    throw codedError("FIT_WORKER_RESULT_MISMATCH", "worker changed the fixed fit span", {
      path: "$/parameters",
    });
  }
  if (
    parameters.inflectionSeconds < parameters.fromSeconds
    || parameters.inflectionSeconds > parameters.toSeconds
    || parameters.growthPerSecond <= 0
    || parameters.asymmetryB <= 0
  ) {
    throw codedError("FIT_WORKER_RESULT_MISMATCH", "worker returned invalid Richards parameters", {
      path: "$/parameters",
    });
  }
  return deepFreeze(parameters);
}

function normalizeMetrics(value) {
  assertRecord(value, "$/metrics", "INVALID_FIT_WORKER_RESULT");
  assertExactKeys(value, METRIC_KEYS, "$/metrics", "INVALID_FIT_WORKER_RESULT");
  const rmseCents = finiteNumber(value.rmseCents, "$/metrics/rmseCents", "INVALID_FIT_WORKER_RESULT");
  const maxAbsCents = finiteNumber(
    value.maxAbsCents,
    "$/metrics/maxAbsCents",
    "INVALID_FIT_WORKER_RESULT",
  );
  if (!Number.isSafeInteger(value.iterations) || value.iterations < 1) {
    throw codedError("INVALID_FIT_WORKER_RESULT", "iterations must be a positive safe integer", {
      path: "$/metrics/iterations",
    });
  }
  const multiStartSpread = finiteNumber(
    value.multiStartSpread,
    "$/metrics/multiStartSpread",
    "INVALID_FIT_WORKER_RESULT",
  );
  if (rmseCents < 0 || maxAbsCents < 0 || multiStartSpread < 0) {
    throw codedError("INVALID_FIT_WORKER_RESULT", "fit metrics must be non-negative", {
      path: "$/metrics",
    });
  }
  return deepFreeze({
    rmseCents,
    maxAbsCents,
    iterations: value.iterations,
    multiStartSpread,
  });
}

function normalizeTerminalMetrics(value) {
  assertRecord(value, "$/metrics", "INVALID_FIT_WORKER_RESULT");
  assertExactKeys(value, METRIC_KEYS, "$/metrics", "INVALID_FIT_WORKER_RESULT");
  if (
    value.rmseCents !== null
    || value.maxAbsCents !== null
    || value.multiStartSpread !== null
    || !Number.isSafeInteger(value.iterations)
    || value.iterations < 0
  ) {
    throw codedError("INVALID_FIT_WORKER_RESULT", "terminal metrics must be null with a non-negative iteration count", {
      path: "$/metrics",
    });
  }
  return deepFreeze({
    rmseCents: null,
    maxAbsCents: null,
    iterations: value.iterations,
    multiStartSpread: null,
  });
}

function terminalResult(request, termination, warningCode) {
  return deepFreeze({
    protocolVersion: FIT_WORKER_PROTOCOL_VERSION,
    requestId: request.requestId,
    operation: request.operation,
    engine: FIT_WORKER_NODE_ENGINE,
    termination,
    parameters: null,
    metrics: {
      rmseCents: null,
      maxAbsCents: null,
      iterations: 0,
      multiStartSpread: null,
    },
    warnings: [{ code: warningCode }],
  });
}

function assertMetricMatches(actual, expected, path) {
  const tolerance = Math.max(1e-9, Math.abs(expected) * 1e-9);
  if (Math.abs(actual - expected) <= tolerance) return;
  throw codedError("FIT_WORKER_RESULT_MISMATCH", "worker metric does not match canonical recomputation", {
    path,
    actual,
    expected,
    tolerance,
  });
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1_664_525, state) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function huberLoss(value, scale) {
  const magnitude = Math.abs(value);
  return magnitude <= scale ? 0.5 * value * value : scale * (magnitude - 0.5 * scale);
}

function clampUnit(value) {
  return Math.max(0, Math.min(1, value));
}

function finiteNumber(value, path, code = "INVALID_FIT_WORKER_REQUEST") {
  if (Number.isFinite(value)) return normalizeNegativeZero(value);
  throw codedError(code, "value must be finite", { path });
}

function normalizeNegativeZero(value) {
  return Object.is(value, -0) ? 0 : value;
}

function assertRecord(value, path, code) {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return;
  throw codedError(code, "value must be an object", { path });
}

function assertExactKeys(value, keys, path, code) {
  const actual = Object.keys(value);
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  const unknown = actual.filter((key) => !keys.includes(key));
  if (missing.length === 0 && unknown.length === 0) return;
  throw codedError(code, "object fields do not match the protocol", { path, missing, unknown });
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function codedError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}
