import { contentHash } from "../canonical-json.js";

const INTERPOLATION_METHODS = new Set(["linear", "cosine", "cubic"]);
const TIME_EPSILON = 1e-9;

export function createCapturedAutomationBaseline({ curve, contextId, parameter }) {
  if (!isRecord(curve)) {
    throw codedError("CAPTURE_EVIDENCE_REQUIRED", "captured Automation evidence is required", {
      remediation: captureRemediation([parameter]),
    });
  }
  if (typeof contextId !== "string" || contextId.length === 0) {
    throw codedError("INVALID_ARGUMENTS", "contextId must be a non-empty string");
  }
  if (typeof parameter !== "string" || parameter.length === 0) {
    throw codedError("INVALID_ARGUMENTS", "parameter must be a non-empty string");
  }
  if (curve.resolvedParameter !== parameter) {
    throw codedError(
      "CAPTURE_EVIDENCE_REQUIRED",
      `captured Automation does not resolve to ${parameter}`,
      { remediation: captureRemediation([parameter]) },
    );
  }
  const method = normalizeInterpolationMethod(curve.interpolationMethod);
  const definition = normalizeDefinition(curve.definition, parameter);
  const points = normalizePoints([
    ...(Array.isArray(curve.supportPoints) ? curve.supportPoints : []),
    ...(Array.isArray(curve.points) ? curve.points : []),
  ]);
  const interpolationEvidence = Object.freeze({
    method,
    source: "host_getInterpolationMethod",
    capturedAtContextId: contextId,
    resolvedParameter: parameter,
  });
  const baseline = {
    parameter,
    method,
    defaultValue: definition.defaultValue,
    definition,
    points,
    interpolationEvidence,
    fingerprint: contentHash({
      parameter,
      method,
      definition,
      points,
    }),
  };
  return deepFreeze(baseline);
}

export function evaluateCapturedAutomation(baseline, blick) {
  if (!baseline || typeof baseline !== "object") {
    throw codedError("INVALID_ARGUMENTS", "baseline must be a captured Automation baseline");
  }
  return evaluateAutomationPoints({
    method: baseline.method,
    defaultValue: baseline.defaultValue,
    points: baseline.points,
    blick,
  });
}

export function evaluateAutomationPoints({ method, defaultValue, points, blick }) {
  const normalizedMethod = normalizeInterpolationMethod(method);
  if (!Number.isFinite(defaultValue)) {
    throw codedError("HOST_DATA_INVALID", "Automation definition.defaultValue must be finite");
  }
  if (!Number.isSafeInteger(blick)) {
    throw codedError("INVALID_ARGUMENTS", "Automation sample BLICK must be a safe integer");
  }
  const normalizedPoints = normalizePoints(points);
  if (normalizedPoints.length === 0) return defaultValue;
  const exact = normalizedPoints.find((point) => point.blick === blick);
  if (exact) return exact.value;
  const rightIndex = normalizedPoints.findIndex((point) => point.blick > blick);
  if (rightIndex <= 0) return defaultValue;
  if (rightIndex === -1) return defaultValue;
  const left = normalizedPoints[rightIndex - 1];
  const right = normalizedPoints[rightIndex];
  const ratio = (blick - left.blick) / (right.blick - left.blick);
  if (normalizedMethod === "linear") return lerp(left.value, right.value, ratio);
  if (normalizedMethod === "cosine") {
    return lerp(left.value, right.value, (1 - Math.cos(Math.PI * ratio)) / 2);
  }
  return cubicCatmullRom(normalizedPoints, rightIndex, ratio);
}

export function replaceAutomationPoints(baseline, range, replacementPoints) {
  if (!isRecord(range) || !Number.isSafeInteger(range.fromBlick) || !Number.isSafeInteger(range.toBlick)) {
    throw codedError("INVALID_ARGUMENTS", "replacement range must use safe-integer BLICK bounds");
  }
  if (range.toBlick <= range.fromBlick) {
    throw codedError("INVALID_ARGUMENTS", "replacement range must contain at least two BLICK values");
  }
  const replacement = normalizePoints(replacementPoints);
  return normalizePoints([
    ...baseline.points.filter(
      (point) => point.blick < range.fromBlick || point.blick > range.toBlick,
    ),
    ...replacement,
  ]);
}

export function captureRemediation(automationParameters) {
  return {
    include: ["notes", "automation"],
    automationParameters: [...automationParameters],
  };
}

export function normalizeInterpolationMethod(value) {
  const method = typeof value === "string" ? value.toLowerCase() : null;
  if (!INTERPOLATION_METHODS.has(method)) {
    throw codedError(
      "UNSUPPORTED_INTERPOLATION",
      "Automation interpolation method must be linear, cosine, or cubic",
      { interpolationMethod: value ?? null },
    );
  }
  return method;
}

function normalizeDefinition(value, parameter) {
  if (!isRecord(value) || !Number.isFinite(value.defaultValue)) {
    throw codedError(
      "CAPTURE_EVIDENCE_REQUIRED",
      `captured ${parameter} definition with a finite defaultValue is required`,
      { remediation: captureRemediation([parameter]) },
    );
  }
  return {
    typeName: typeof value.typeName === "string" ? value.typeName : parameter,
    ...(Array.isArray(value.range) ? { range: [...value.range] } : {}),
    defaultValue: value.defaultValue,
  };
}

function normalizePoints(value) {
  if (!Array.isArray(value)) {
    throw codedError("INVALID_ARGUMENTS", "Automation points must be an array");
  }
  const byBlick = new Map();
  for (const [index, point] of value.entries()) {
    if (!isRecord(point) || !Number.isSafeInteger(point.localBlick ?? point.blick) || !Number.isFinite(point.value)) {
      throw codedError("HOST_DATA_INVALID", "captured Automation points must have finite values and local BLICK", {
        index,
      });
    }
    const blick = point.localBlick ?? point.blick;
    const previous = byBlick.get(blick);
    if (previous !== undefined && Math.abs(previous - point.value) > TIME_EPSILON) {
      throw codedError("HOST_DATA_INVALID", "captured Automation repeats one BLICK with different values", {
        blick,
      });
    }
    byBlick.set(blick, point.value);
  }
  return [...byBlick.entries()]
    .map(([blick, valueAtBlick]) => ({ blick, value: valueAtBlick }))
    .sort((left, right) => left.blick - right.blick);
}

function cubicCatmullRom(points, rightIndex, ratio) {
  const left = points[rightIndex - 1];
  const right = points[rightIndex];
  // Cubic 的相邻点必须随 snapshot 一并保留；端点退化仅覆盖真实曲线边缘，提交仍由 T12 以宿主 get() 裁定。
  const before = points[rightIndex - 2] ?? left;
  const after = points[rightIndex + 1] ?? right;
  const t = ratio;
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (
    (2 * left.value)
    + (-before.value + right.value) * t
    + (2 * before.value - 5 * left.value + 4 * right.value - after.value) * t2
    + (-before.value + 3 * left.value - 3 * right.value + after.value) * t3
  );
}

function lerp(left, right, ratio) {
  return (1 - ratio) * left + ratio * right;
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function codedError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}
