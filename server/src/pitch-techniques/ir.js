import {
  canonicalizeTechniques as canonicalizeReferenceTechniques,
  PITCH_DELTA_LIMIT_CENT,
  SEMANTIC_NUMERIC_QUANTA as referenceSemanticNumericQuanta,
  TECHNIQUE_IR_NUMERIC_FIELD_SCHEMA as referenceTechniqueIrNumericFieldSchema,
} from "./model.js";

export const TECHNIQUE_IR_SCHEMA_VERSION = 1;
export const TECHNIQUE_IR_MODEL_VERSION = "pitch-techniques-v1";
export const TECHNIQUE_IR_TIME_DOMAIN = "seconds";
export const PITCH_DELTA_REFERENCE_FRAME = "pitch_delta_contribution_cents";
export const TECHNIQUE_IR_MAX_TECHNIQUES = 32;
export const TECHNIQUE_IR_NUMERIC_FIELD_SCHEMA = referenceTechniqueIrNumericFieldSchema;
export const SEMANTIC_NUMERIC_QUANTA = referenceSemanticNumericQuanta;

const PITCH_DELTA_TARGET = Object.freeze({
  surface: "pitchDelta",
  compositionMode: "baseline_plus_contribution",
  mutationMode: "replace",
});

const CAPTURE_INCLUDE = Object.freeze(["notes", "automation"]);
const CAPTURE_EVIDENCE_FIELDS = Object.freeze([
  "method",
  "source",
  "capturedAtContextId",
  "resolvedParameter",
]);
const INTERPOLATION_METHODS = new Set(["linear", "cosine", "cubic"]);
const TECHNIQUE_KINDS = new Set(["portamento", "transient", "vibrato"]);
const NORMALIZED_TECHNIQUE_IRS = new WeakSet();

export function canonicalizeTechniques(techniques) {
  return canonicalizeReferenceTechniques(techniques);
}

export function normalizeTechniqueIr(candidate) {
  assertRecord(candidate, "$");
  assertKnownKeys(candidate, [
    "schemaVersion",
    "modelVersion",
    "scope",
    "timeDomain",
    "referenceFrame",
    "techniques",
    "composition",
    "target",
  ], "$");

  const schemaVersion = normalizeRegisteredNumber(
    "schemaVersion",
    candidate.schemaVersion,
    "$/schemaVersion",
  );
  if (schemaVersion !== TECHNIQUE_IR_SCHEMA_VERSION) {
    throw codedError("INVALID_ARGUMENTS", "schemaVersion must be 1", {
      path: "$/schemaVersion",
      value: schemaVersion,
    });
  }
  assertExactString(candidate.modelVersion, TECHNIQUE_IR_MODEL_VERSION, "$/modelVersion");
  assertExactString(candidate.timeDomain, TECHNIQUE_IR_TIME_DOMAIN, "$/timeDomain");
  assertExactString(
    candidate.referenceFrame,
    PITCH_DELTA_REFERENCE_FRAME,
    "$/referenceFrame",
    "REFERENCE_FRAME_SURFACE_MISMATCH",
  );

  const scope = normalizeScope(candidate.scope);
  const techniques = normalizeTechniques(candidate.techniques);
  const composition = normalizeComposition(candidate.composition);
  const target = normalizeTarget(candidate.target, scope, techniques);

  const normalized = deepFreeze({
    schemaVersion,
    modelVersion: TECHNIQUE_IR_MODEL_VERSION,
    scope,
    timeDomain: TECHNIQUE_IR_TIME_DOMAIN,
    referenceFrame: PITCH_DELTA_REFERENCE_FRAME,
    techniques,
    composition,
    target,
  });
  NORMALIZED_TECHNIQUE_IRS.add(normalized);
  return normalized;
}

export function assertNormalizedTechniqueIr(value) {
  if (NORMALIZED_TECHNIQUE_IRS.has(value)) return value;
  throw codedError("UNNORMALIZED_TECHNIQUE_IR", "TechniqueIR must come from normalizeTechniqueIr", {
    path: "$/ir",
  });
}

function normalizeScope(scope) {
  assertRecord(scope, "$/scope");
  assertKnownKeys(scope, ["contextId", "occurrence", "expectedTargetGroupUuid"], "$/scope");
  assertNonEmptyString(scope.contextId, "$/scope/contextId");
  assertNonEmptyString(scope.expectedTargetGroupUuid, "$/scope/expectedTargetGroupUuid");
  const occurrence = normalizeRegisteredNumber(
    "occurrence",
    scope.occurrence,
    "$/scope/occurrence",
  );
  if (occurrence < 0) {
    throw canonicalRangeError("occurrence", occurrence, 0, Number.MAX_SAFE_INTEGER);
  }
  return {
    contextId: scope.contextId,
    occurrence,
    expectedTargetGroupUuid: scope.expectedTargetGroupUuid,
  };
}

function normalizeTechniques(techniques) {
  if (!Array.isArray(techniques) || techniques.length === 0) {
    throw codedError("INVALID_ARGUMENTS", "techniques must be a non-empty array", {
      path: "$/techniques",
    });
  }
  if (techniques.length > TECHNIQUE_IR_MAX_TECHNIQUES) {
    throw codedError("INVALID_ARGUMENTS", `at most ${TECHNIQUE_IR_MAX_TECHNIQUES} techniques`, {
      path: "$/techniques",
      maximum: TECHNIQUE_IR_MAX_TECHNIQUES,
    });
  }
  techniques.forEach(assertTechniqueShape);
  const canonicalInput = techniques.map((technique) => ({
    ...technique,
    exclusive: technique.exclusive ?? false,
  }));
  return canonicalizeReferenceTechniques(canonicalInput).map((technique) => ({
    id: technique.id,
    priority: technique.priority,
    canonicalKey: technique.canonicalKey,
    ...technique.semantic,
  }));
}

function assertTechniqueShape(technique, index) {
  const path = `$/techniques/${index}`;
  assertRecord(technique, path);
  assertKnownKeys(
    technique,
    ["id", "requestIndex", "kind", "anchors", "priority", "exclusive", "model", "span"],
    path,
  );
  if (Object.hasOwn(technique, "id")) assertNonEmptyString(technique.id, `${path}/id`);
  if (Object.hasOwn(technique, "requestIndex")) {
    assertSafeInteger(technique.requestIndex, `${path}/requestIndex`, "requestIndex");
  }
  if (Object.hasOwn(technique, "exclusive") && typeof technique.exclusive !== "boolean") {
    throw codedError("INVALID_ARGUMENTS", "exclusive must be a boolean", {
      path: `${path}/exclusive`,
    });
  }
  if (typeof technique.kind !== "string" || !TECHNIQUE_KINDS.has(technique.kind)) {
    throw codedError("INVALID_ARGUMENTS", "kind must name a supported technique", {
      path: `${path}/kind`,
      rule: "portamento, transient, or vibrato",
    });
  }
  assertRecord(technique.anchors, `${path}/anchors`);
  const anchorFields = technique.kind === "portamento" ? ["fromNote", "toNote"] : ["note"];
  assertKnownKeys(technique.anchors, anchorFields, `${path}/anchors`);
  for (const field of anchorFields) {
    if (!Object.hasOwn(technique.anchors, field)) {
      throw codedError("INVALID_ARGUMENTS", "anchor is required", {
        path: `${path}/anchors/${field}`,
      });
    }
  }
  assertRecord(technique.model, `${path}/model`);
  assertNonEmptyString(technique.model.family, `${path}/model/family`);
  assertRecord(technique.span, `${path}/span`);
  assertKnownKeys(technique.span, ["fromSeconds", "toSeconds"], `${path}/span`);
  for (const field of ["fromSeconds", "toSeconds"]) {
    if (!Object.hasOwn(technique.span, field)) {
      throw codedError("INVALID_ARGUMENTS", "span endpoint is required", {
        path: `${path}/span/${field}`,
      });
    }
  }
}

function normalizeComposition(composition) {
  assertRecord(composition, "$/composition");
  assertKnownKeys(composition, ["rule", "maxAbsCents", "overlapPolicy"], "$/composition");
  assertExactString(composition.rule, "sum_then_clamp", "$/composition/rule");
  assertExactString(
    composition.overlapPolicy,
    "explicit_priority_then_canonical_key",
    "$/composition/overlapPolicy",
  );
  const maxAbsCents = normalizeRegisteredNumber(
    "maxAbsCents",
    composition.maxAbsCents,
    "$/composition/maxAbsCents",
  );
  if (maxAbsCents < 0 || maxAbsCents > PITCH_DELTA_LIMIT_CENT) {
    throw canonicalRangeError("maxAbsCents", maxAbsCents, 0, PITCH_DELTA_LIMIT_CENT);
  }
  return {
    rule: "sum_then_clamp",
    maxAbsCents,
    overlapPolicy: "explicit_priority_then_canonical_key",
  };
}

function normalizeTarget(target, scope, techniques) {
  assertRecord(target, "$/target");
  assertKnownKeys(target, [
    "surface",
    "compositionMode",
    "mutationMode",
    "referenceFrame",
    "requiredInclude",
    "baselineGuard",
    "interpolationEvidence",
    "hostProfileHash",
  ], "$/target");
  const actual = {
    surface: target.surface,
    compositionMode: target.compositionMode,
    mutationMode: target.mutationMode,
    referenceFrame: target.referenceFrame,
  };
  if (
    actual.surface !== PITCH_DELTA_TARGET.surface
    || actual.compositionMode !== PITCH_DELTA_TARGET.compositionMode
    || actual.mutationMode !== PITCH_DELTA_TARGET.mutationMode
    || actual.referenceFrame !== PITCH_DELTA_REFERENCE_FRAME
  ) {
    throw codedError(
      "REFERENCE_FRAME_SURFACE_MISMATCH",
      "TechniqueIR referenceFrame and target surface must use the pitchDelta contribution mapping",
      {
        actual,
        expected: {
          ...PITCH_DELTA_TARGET,
          referenceFrame: PITCH_DELTA_REFERENCE_FRAME,
        },
      },
    );
  }

  const automationParameters = techniques.some((technique) => technique.kind === "vibrato")
    ? ["pitchDelta", "vibratoEnv"]
    : ["pitchDelta"];
  const remediation = {
    include: [...CAPTURE_INCLUDE],
    automationParameters,
  };
  const missing = [];
  if (!isRecord(target.requiredInclude)) missing.push("requiredInclude");
  if (!isRecord(target.baselineGuard)) missing.push("baselineGuard");
  if (!isRecord(target.interpolationEvidence)) missing.push("interpolationEvidence");
  if (typeof target.hostProfileHash !== "string" || target.hostProfileHash.length === 0) {
    missing.push("hostProfileHash");
  }
  if (missing.length > 0) throw captureEvidenceRequired(remediation, missing);

  assertKnownKeys(target.requiredInclude, ["include", "automationParameters"], "$/target/requiredInclude");
  assertKnownKeys(
    target.baselineGuard,
    automationParameters.map((parameter) => `${parameter}Fingerprint`),
    "$/target/baselineGuard",
  );
  assertKnownKeys(
    target.interpolationEvidence,
    automationParameters,
    "$/target/interpolationEvidence",
  );
  if (
    !hasExactStringArray(target.requiredInclude.include, CAPTURE_INCLUDE)
    || !hasExactStringArray(target.requiredInclude.automationParameters, automationParameters)
  ) {
    missing.push("requiredInclude");
  }

  const baselineGuard = {};
  const interpolationEvidence = {};
  for (const parameter of automationParameters) {
    const fingerprintField = `${parameter}Fingerprint`;
    const fingerprint = target.baselineGuard[fingerprintField];
    if (typeof fingerprint !== "string" || fingerprint.length === 0) {
      missing.push(`baselineGuard.${fingerprintField}`);
    } else {
      baselineGuard[fingerprintField] = fingerprint;
    }

    const evidence = target.interpolationEvidence[parameter];
    if (!isRecord(evidence)) {
      missing.push(`interpolationEvidence.${parameter}`);
      continue;
    }
    assertKnownKeys(evidence, CAPTURE_EVIDENCE_FIELDS, `$/target/interpolationEvidence/${parameter}`);
    const method = typeof evidence.method === "string" ? evidence.method.toLowerCase() : null;
    if (!INTERPOLATION_METHODS.has(method)) {
      missing.push(`interpolationEvidence.${parameter}.method`);
    }
    if (evidence.source !== "host_getInterpolationMethod") {
      missing.push(`interpolationEvidence.${parameter}.source`);
    }
    if (evidence.capturedAtContextId !== scope.contextId) {
      missing.push(`interpolationEvidence.${parameter}.capturedAtContextId`);
    }
    if (evidence.resolvedParameter !== parameter) {
      missing.push(`interpolationEvidence.${parameter}.resolvedParameter`);
    }
    if (
      INTERPOLATION_METHODS.has(method)
      && evidence.source === "host_getInterpolationMethod"
      && evidence.capturedAtContextId === scope.contextId
      && evidence.resolvedParameter === parameter
    ) {
      interpolationEvidence[parameter] = {
        method,
        source: "host_getInterpolationMethod",
        capturedAtContextId: scope.contextId,
        resolvedParameter: parameter,
      };
    }
  }
  if (missing.length > 0) throw captureEvidenceRequired(remediation, missing);

  return {
    surface: PITCH_DELTA_TARGET.surface,
    compositionMode: PITCH_DELTA_TARGET.compositionMode,
    mutationMode: PITCH_DELTA_TARGET.mutationMode,
    referenceFrame: PITCH_DELTA_REFERENCE_FRAME,
    requiredInclude: remediation,
    baselineGuard,
    interpolationEvidence,
    hostProfileHash: target.hostProfileHash,
  };
}

function normalizeRegisteredNumber(field, value, path) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw codedError("INVALID_ARGUMENTS", "value must be a finite number", { path });
  }
  try {
    const [canonical] = canonicalizeReferenceTechniques([{
      kind: "technique_ir_root",
      [field]: value,
    }]);
    return canonical.semantic[field];
  } catch (error) {
    if (error?.details?.field === field && typeof error.code === "string") {
      throw codedError(error.code, error.message, { ...error.details, path });
    }
    throw error;
  }
}

function assertSafeInteger(value, path, field) {
  if (Number.isSafeInteger(value)) return;
  throw codedError("INVALID_INTEGER_SEMANTIC_FIELD", "value must be a safe integer", {
    field,
    path,
    value,
  });
}

function canonicalRangeError(field, value, minimum, maximum) {
  return codedError("CANONICAL_VALUE_OUT_OF_RANGE", `${field} is outside the canonical range`, {
    field,
    value,
    minimum,
    maximum,
  });
}

function captureEvidenceRequired(remediation, missing) {
  return codedError(
    "CAPTURE_EVIDENCE_REQUIRED",
    `Capture a range snapshot with sv_snapshot_range arguments ${JSON.stringify(remediation)}.`,
    { remediation, missing: [...new Set(missing)] },
  );
}

function assertExactString(value, expected, path, code = "INVALID_ARGUMENTS") {
  if (value === expected) return;
  throw codedError(code, `value must be ${expected}`, { path, value, expected });
}

function assertNonEmptyString(value, path) {
  if (typeof value === "string" && value.length > 0) return;
  throw codedError("INVALID_ARGUMENTS", "value must be a non-empty string", { path });
}

function assertKnownKeys(value, allowed, path) {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length === 0) return;
  throw codedError("INVALID_ARGUMENTS", `unknown field: ${unknown.join(", ")}`, {
    path,
    rule: `one of ${[...allowedSet].join(", ")}`,
  });
}

function assertRecord(value, path) {
  if (isRecord(value)) return;
  throw codedError("INVALID_ARGUMENTS", "value must be an object", { path });
}

function hasExactStringArray(value, expected) {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((entry, index) => entry === expected[index]);
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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
