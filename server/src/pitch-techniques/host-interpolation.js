import { contentHash } from "../canonical-json.js";

export const HOST_INTERPOLATION_POSTCONDITION_VERSION = 1;
export const HOST_INTERPOLATION_MAX_BASELINE_SAMPLES = 256;
export const HOST_INTERPOLATION_MAX_MANDATORY_SAMPLES = 256;
export const HOST_INTERPOLATION_MAX_ADAPTIVE_MIDPOINTS = 128;
export const HOST_INTERPOLATION_MAX_TOTAL_SAMPLES =
  HOST_INTERPOLATION_MAX_MANDATORY_SAMPLES + HOST_INTERPOLATION_MAX_ADAPTIVE_MIDPOINTS;

const BASELINE_FINGERPRINT_QUANTUM_CENT = 0.001;
const INTERPOLATION_METHODS = new Set(["linear", "cosine", "cubic"]);
const SUPPORTED_PARAMETERS = new Set(["pitchDelta", "vibratoEnv"]);

export function buildHostInterpolationPostcondition({
  interpolationEvidence,
  baselineSamples,
  mandatorySamples,
  adaptiveMidpoints,
  maxFitErrorCent = 1,
}) {
  const normalizedEvidence = normalizeInterpolationEvidence(interpolationEvidence);
  const normalizedBaselineSamples = normalizeSamples(
    baselineSamples,
    "baseline.samples",
    HOST_INTERPOLATION_MAX_BASELINE_SAMPLES,
    { minimum: 1 }
  );
  const fingerprint = createHostInterpolationBaselineFingerprint({
    interpolationEvidence: normalizedEvidence,
    samples: normalizedBaselineSamples,
  });
  return normalizeHostInterpolationPostcondition({
    schemaVersion: HOST_INTERPOLATION_POSTCONDITION_VERSION,
    kind: "host_interpolation",
    interpolationEvidence: normalizedEvidence,
    baseline: {
      samples: normalizedBaselineSamples,
      fingerprint,
    },
    final: {
      mandatorySamples,
      adaptiveMidpoints,
    },
    maxFitErrorCent,
  });
}

export function normalizeHostInterpolationPostcondition(value) {
  assertRecord(value, "hostInterpolation");
  assertKnownKeys(
    value,
    ["schemaVersion", "kind", "interpolationEvidence", "baseline", "final", "maxFitErrorCent"],
    "hostInterpolation"
  );
  if (value.schemaVersion !== HOST_INTERPOLATION_POSTCONDITION_VERSION) {
    throw codedError(
      "INVALID_ARGUMENTS",
      `hostInterpolation.schemaVersion must be ${HOST_INTERPOLATION_POSTCONDITION_VERSION}`
    );
  }
  if (value.kind !== "host_interpolation") {
    throw codedError("INVALID_ARGUMENTS", "hostInterpolation.kind must be host_interpolation");
  }
  const interpolationEvidence = normalizeInterpolationEvidence(value.interpolationEvidence);
  const baseline = normalizeBaseline(value.baseline, interpolationEvidence);
  const final = normalizeFinalSamples(value.final);
  const maxFitErrorCent = normalizeMaxFitErrorCent(value.maxFitErrorCent);
  return deepFreeze({
    schemaVersion: HOST_INTERPOLATION_POSTCONDITION_VERSION,
    kind: "host_interpolation",
    interpolationEvidence,
    baseline,
    final,
    maxFitErrorCent,
  });
}

export function createHostInterpolationBaselineFingerprint({ interpolationEvidence, samples }) {
  const evidence = normalizeInterpolationEvidence(interpolationEvidence);
  const normalizedSamples = normalizeSamples(
    samples,
    "baseline.samples",
    HOST_INTERPOLATION_MAX_BASELINE_SAMPLES,
    { minimum: 1 }
  );
  return contentHash({
    schemaVersion: HOST_INTERPOLATION_POSTCONDITION_VERSION,
    resolvedParameter: evidence.resolvedParameter,
    interpolationMethod: evidence.method,
    samples: normalizedSamples.map((sample) => ({
      blick: sample.blick,
      value: quantizeFingerprintValue(sample.value),
    })),
  });
}

export function assertHostInterpolationPostconditionFitsCurve(postcondition, {
  parameter,
  range,
}) {
  if (postcondition === null) return;
  if (postcondition.interpolationEvidence.resolvedParameter !== parameter) {
    throw codedError(
      "INTERPOLATION_PARAMETER_MISMATCH",
      `hostInterpolation evidence targets ${postcondition.interpolationEvidence.resolvedParameter}, not ${parameter}`
    );
  }
  if (!SUPPORTED_PARAMETERS.has(parameter)) {
    throw codedError(
      "INTERPOLATION_PARAMETER_MISMATCH",
      "host interpolation postconditions currently support pitchDelta or vibratoEnv only"
    );
  }
  for (const sample of [
    ...postcondition.final.mandatorySamples,
    ...postcondition.final.adaptiveMidpoints,
  ]) {
    if (sample.blick < range.fromLocal || sample.blick > range.toLocal) {
      throw codedError(
        "INTERPOLATION_SAMPLE_OUT_OF_RANGE",
        `hostInterpolation sample at BLICK ${sample.blick} lies outside the curve range`
      );
    }
  }
}

export function assertHostInterpolationPostconditionMatchesPlanned(postcondition, planned) {
  if (postcondition === null) return;
  const plannedByBlick = new Map(planned.map((point) => [point.blick, point.value]));
  for (const sample of postcondition.final.mandatorySamples) {
    const plannedValue = plannedByBlick.get(sample.blick);
    if (plannedValue === undefined || !sameCentValue(plannedValue, sample.value)) {
      throw codedError(
        "INTERPOLATION_EXPECTED_VALUE_MISMATCH",
        `hostInterpolation mandatory sample at BLICK ${sample.blick} does not match the final replace point`
      );
    }
  }
  // 期望值由编译器按封存宿主证据生成；事务不能擅自按 Linear 重算。
  for (const sample of postcondition.final.adaptiveMidpoints) {
    const leftValue = plannedByBlick.get(sample.leftBlick);
    const rightValue = plannedByBlick.get(sample.rightBlick);
    if (leftValue === undefined || rightValue === undefined) {
      throw codedError(
        "INTERPOLATION_EXPECTED_VALUE_MISMATCH",
        "hostInterpolation adaptive midpoint must be bracketed by final replace points"
      );
    }
  }
}

export async function preflightHostInterpolationPostcondition({
  postcondition,
  readInterpolationMethod,
  readValue,
}) {
  if (postcondition === null) return null;
  const observedMethod = normalizeInterpolationMethod(await readInterpolationMethod());
  const expectedMethod = postcondition.interpolationEvidence.method;
  if (observedMethod !== expectedMethod) {
    throw codedError(
      "INTERPOLATION_CHANGED",
      `Automation interpolation changed from ${expectedMethod} to ${observedMethod}`,
      {
        expectedMethod,
        observedMethod,
        parameter: postcondition.interpolationEvidence.resolvedParameter,
      }
    );
  }
  const observedSamples = [];
  for (const sample of postcondition.baseline.samples) {
    const value = await readFiniteValue(readValue, sample.blick, "baseline");
    observedSamples.push({ blick: sample.blick, value });
  }
  const observedFingerprint = createHostInterpolationBaselineFingerprint({
    interpolationEvidence: postcondition.interpolationEvidence,
    samples: observedSamples,
  });
  if (observedFingerprint !== postcondition.baseline.fingerprint) {
    throw codedError(
      "CURVE_BASELINE_CHANGED",
      "Automation baseline samples changed after the plan was captured",
      {
        expectedFingerprint: postcondition.baseline.fingerprint,
        observedFingerprint,
        sampleCount: observedSamples.length,
        parameter: postcondition.interpolationEvidence.resolvedParameter,
      }
    );
  }
  return {
    attempted: true,
    passed: true,
    interpolationMethod: observedMethod,
    baselineFingerprint: observedFingerprint,
    baselineSampleCount: observedSamples.length,
  };
}

export async function verifyHostInterpolationPostcondition({ postcondition, readValue }) {
  if (postcondition === null) return null;
  let maxAbsErrorCent = 0;
  let firstMismatch = null;
  const samples = [
    ...postcondition.final.mandatorySamples.map((sample) => ({ ...sample, source: "mandatory" })),
    ...postcondition.final.adaptiveMidpoints.map((sample) => ({ ...sample, source: "adaptive_midpoint" })),
  ];
  for (const sample of samples) {
    const observed = await readFiniteValue(readValue, sample.blick, "final");
    const signedErrorCent = observed - sample.value;
    const absoluteErrorCent = Math.abs(signedErrorCent);
    maxAbsErrorCent = Math.max(maxAbsErrorCent, absoluteErrorCent);
    if (firstMismatch === null && absoluteErrorCent > postcondition.maxFitErrorCent) {
      firstMismatch = {
        source: sample.source,
        blick: sample.blick,
        expected: sample.value,
        observed,
        signedErrorCent,
        absoluteErrorCent,
      };
    }
  }
  return {
    attempted: true,
    passed: firstMismatch === null,
    interpolationMethod: postcondition.interpolationEvidence.method,
    maxFitErrorCent: postcondition.maxFitErrorCent,
    maxAbsErrorCent,
    mandatorySampleCount: postcondition.final.mandatorySamples.length,
    adaptiveMidpointCount: postcondition.final.adaptiveMidpoints.length,
    sampleCount: samples.length,
    ...(firstMismatch ? { firstMismatch } : {}),
  };
}

function normalizeInterpolationEvidence(value) {
  assertRecord(value, "hostInterpolation.interpolationEvidence");
  assertKnownKeys(
    value,
    ["method", "source", "capturedAtContextId", "resolvedParameter"],
    "hostInterpolation.interpolationEvidence"
  );
  if (value.source !== "host_getInterpolationMethod") {
    throw codedError(
      "INVALID_ARGUMENTS",
      "hostInterpolation.interpolationEvidence.source must be host_getInterpolationMethod"
    );
  }
  if (typeof value.capturedAtContextId !== "string" || value.capturedAtContextId.length === 0) {
    throw codedError(
      "INVALID_ARGUMENTS",
      "hostInterpolation.interpolationEvidence.capturedAtContextId must be a non-empty string"
    );
  }
  if (typeof value.resolvedParameter !== "string" || value.resolvedParameter.length === 0) {
    throw codedError(
      "INVALID_ARGUMENTS",
      "hostInterpolation.interpolationEvidence.resolvedParameter must be a non-empty string"
    );
  }
  return {
    method: normalizeInterpolationMethod(value.method),
    source: "host_getInterpolationMethod",
    capturedAtContextId: value.capturedAtContextId,
    resolvedParameter: value.resolvedParameter,
  };
}

function normalizeBaseline(value, interpolationEvidence) {
  assertRecord(value, "hostInterpolation.baseline");
  assertKnownKeys(value, ["samples", "fingerprint"], "hostInterpolation.baseline");
  const samples = normalizeSamples(
    value.samples,
    "hostInterpolation.baseline.samples",
    HOST_INTERPOLATION_MAX_BASELINE_SAMPLES,
    { minimum: 1 }
  );
  const expectedFingerprint = createHostInterpolationBaselineFingerprint({
    interpolationEvidence,
    samples,
  });
  if (value.fingerprint !== expectedFingerprint) {
    throw codedError(
      "INVALID_ARGUMENTS",
      "hostInterpolation.baseline.fingerprint does not match its sealed samples"
    );
  }
  return { samples, fingerprint: expectedFingerprint };
}

function normalizeFinalSamples(value) {
  assertRecord(value, "hostInterpolation.final");
  assertKnownKeys(value, ["mandatorySamples", "adaptiveMidpoints"], "hostInterpolation.final");
  const mandatorySamples = normalizeSamples(
    value.mandatorySamples,
    "hostInterpolation.final.mandatorySamples",
    HOST_INTERPOLATION_MAX_MANDATORY_SAMPLES,
    { minimum: 2 }
  );
  if (!Array.isArray(value.adaptiveMidpoints)) {
    throw codedError(
      "INVALID_ARGUMENTS",
      "hostInterpolation.final.adaptiveMidpoints must be an array"
    );
  }
  if (value.adaptiveMidpoints.length === 0) {
    throw codedError(
      "INVALID_ARGUMENTS",
      "hostInterpolation.final.adaptiveMidpoints must contain at least one sample"
    );
  }
  if (value.adaptiveMidpoints.length > HOST_INTERPOLATION_MAX_ADAPTIVE_MIDPOINTS) {
    throw codedError(
      "INVALID_ARGUMENTS",
      `hostInterpolation.final.adaptiveMidpoints must contain at most ${HOST_INTERPOLATION_MAX_ADAPTIVE_MIDPOINTS} samples`
    );
  }
  const adaptiveMidpoints = value.adaptiveMidpoints.map((sample, index) => {
    assertRecord(sample, `hostInterpolation.final.adaptiveMidpoints[${index}]`);
    assertKnownKeys(
      sample,
      ["blick", "value", "leftBlick", "rightBlick"],
      `hostInterpolation.final.adaptiveMidpoints[${index}]`
    );
    const blick = normalizeBlick(sample.blick, `hostInterpolation.final.adaptiveMidpoints[${index}].blick`);
    const valueAtBlick = normalizeValue(
      sample.value,
      `hostInterpolation.final.adaptiveMidpoints[${index}].value`
    );
    const leftBlick = normalizeBlick(
      sample.leftBlick,
      `hostInterpolation.final.adaptiveMidpoints[${index}].leftBlick`
    );
    const rightBlick = normalizeBlick(
      sample.rightBlick,
      `hostInterpolation.final.adaptiveMidpoints[${index}].rightBlick`
    );
    const midpoint = leftBlick + Math.floor((rightBlick - leftBlick) / 2);
    if (leftBlick >= blick || blick >= rightBlick || blick !== midpoint) {
      throw codedError(
        "INVALID_ARGUMENTS",
        "hostInterpolation adaptive samples must sit at an integer midpoint"
      );
    }
    return { blick, value: valueAtBlick, leftBlick, rightBlick };
  });
  assertSamplesStrictlyIncreasing(adaptiveMidpoints, "hostInterpolation.final.adaptiveMidpoints");
  const finalBlicks = new Set(mandatorySamples.map((sample) => sample.blick));
  for (const sample of adaptiveMidpoints) {
    if (finalBlicks.has(sample.blick)) {
      throw codedError(
        "INVALID_ARGUMENTS",
        "hostInterpolation final samples must not repeat a BLICK"
      );
    }
    finalBlicks.add(sample.blick);
  }
  if (mandatorySamples.length + adaptiveMidpoints.length > HOST_INTERPOLATION_MAX_TOTAL_SAMPLES) {
    throw codedError(
      "INVALID_ARGUMENTS",
      `hostInterpolation final samples must contain at most ${HOST_INTERPOLATION_MAX_TOTAL_SAMPLES} items`
    );
  }
  return { mandatorySamples, adaptiveMidpoints };
}

function normalizeSamples(value, label, maximum, { minimum = 0 } = {}) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw codedError(
      "INVALID_ARGUMENTS",
      `${label} must contain between ${minimum} and ${maximum} samples`
    );
  }
  const samples = value.map((sample, index) => {
    assertRecord(sample, `${label}[${index}]`);
    assertKnownKeys(sample, ["blick", "value"], `${label}[${index}]`);
    return {
      blick: normalizeBlick(sample.blick, `${label}[${index}].blick`),
      value: normalizeValue(sample.value, `${label}[${index}].value`),
    };
  });
  assertSamplesStrictlyIncreasing(samples, label);
  return samples;
}

function assertSamplesStrictlyIncreasing(samples, label) {
  for (let index = 1; index < samples.length; index += 1) {
    if (samples[index].blick <= samples[index - 1].blick) {
      throw codedError("INVALID_ARGUMENTS", `${label} BLICK values must strictly increase`);
    }
  }
}

function normalizeBlick(value, label) {
  if (!Number.isSafeInteger(value)) {
    throw codedError("INVALID_ARGUMENTS", `${label} must be a safe integer`);
  }
  return value;
}

function normalizeValue(value, label) {
  if (!Number.isFinite(value)) {
    throw codedError("INVALID_ARGUMENTS", `${label} must be finite`);
  }
  return value;
}

function normalizeMaxFitErrorCent(value) {
  if (!Number.isFinite(value) || value < 0.000001 || value > 20) {
    throw codedError(
      "INVALID_ARGUMENTS",
      "hostInterpolation.maxFitErrorCent must be between 0.000001 and 20"
    );
  }
  return value;
}

function normalizeInterpolationMethod(value) {
  const method = typeof value === "string" ? value.toLowerCase() : null;
  if (!INTERPOLATION_METHODS.has(method)) {
    throw codedError(
      "UNSUPPORTED_INTERPOLATION",
      "Automation interpolation method must be linear, cosine, or cubic"
    );
  }
  return method;
}

async function readFiniteValue(readValue, blick, phase) {
  const value = await readValue(blick);
  if (!Number.isFinite(value)) {
    throw codedError(
      "HOST_DATA_INVALID",
      `Automation.get returned a non-finite ${phase} value at BLICK ${blick}`
    );
  }
  return value;
}

function quantizeFingerprintValue(value) {
  const quantized = Math.round(value / BASELINE_FINGERPRINT_QUANTUM_CENT)
    * BASELINE_FINGERPRINT_QUANTUM_CENT;
  return quantized === 0 ? 0 : quantized;
}

function sameCentValue(left, right) {
  return Math.abs(left - right) <= 0.000001;
}

function assertRecord(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw codedError("INVALID_ARGUMENTS", `${label} must be an object`);
  }
}

function assertKnownKeys(value, allowed, label) {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw codedError("INVALID_ARGUMENTS", `${label} contains unknown field: ${unknown.join(", ")}`);
  }
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function codedError(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}
