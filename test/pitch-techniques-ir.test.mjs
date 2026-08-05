import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { canonicalize, contentHash } from "../server/src/canonical-json.js";
import { encodeToolError } from "../server/src/mcp-result-encoder.js";
import {
  canonicalizeTechniques as referenceCanonicalizeTechniques,
  SEMANTIC_NUMERIC_QUANTA as referenceSemanticNumericQuanta,
  TECHNIQUE_IR_NUMERIC_FIELD_SCHEMA as referenceTechniqueIrNumericFieldSchema,
} from "../server/src/pitch-techniques/model.js";
import {
  assertNormalizedTechniqueIr,
  canonicalizeTechniques,
  normalizeTechniqueIr,
  PITCH_DELTA_REFERENCE_FRAME,
  SEMANTIC_NUMERIC_QUANTA,
  TECHNIQUE_IR_MAX_TECHNIQUES,
  TECHNIQUE_IR_NUMERIC_FIELD_SCHEMA,
  TECHNIQUE_IR_MODEL_VERSION,
  TECHNIQUE_IR_SCHEMA_VERSION,
  TECHNIQUE_IR_TIME_DOMAIN,
} from "../server/src/pitch-techniques/ir.js";

function portamento(overrides = {}) {
  return {
    id: "caller-portamento",
    requestIndex: 3,
    kind: "portamento",
    anchors: { fromNote: 4, toNote: 5 },
    priority: 0,
    model: {
      family: "richards_segment_normalized",
      inflectionRatio: 0.5800000000002,
      sharpness: 8,
      asymmetryLogB: 0.3000000000002,
    },
    span: { fromSeconds: 2, toSeconds: 2.24 },
    ...overrides,
  };
}

function vibrato(overrides = {}) {
  return {
    id: "caller-vibrato",
    requestIndex: 4,
    kind: "vibrato",
    anchors: { note: 5 },
    priority: 0,
    model: {
      family: "time_varying_vibrato",
      startRatio: 0,
      endRatio: 1,
      rateHz: 5.5,
      endRateHz: 5.5,
      depthSemitone: 0.3,
      endDepthSemitone: 0.3,
      centerDriftSemitone: 0,
      phaseRad: 0,
      fadeInSeconds: 0.3,
      fadeOutSeconds: 0.2,
    },
    span: { fromSeconds: 2, toSeconds: 3 },
    ...overrides,
  };
}

function target({ vibratoRequired = false } = {}) {
  const automationParameters = vibratoRequired ? ["pitchDelta", "vibratoEnv"] : ["pitchDelta"];
  const baselineGuard = {};
  const interpolationEvidence = {};
  for (const parameter of automationParameters) {
    baselineGuard[`${parameter}Fingerprint`] = `sha256:${parameter}`;
    interpolationEvidence[parameter] = {
      method: parameter === "pitchDelta" ? "CUBIC" : "linear",
      source: "host_getInterpolationMethod",
      capturedAtContextId: "ctx_pitch_1",
      resolvedParameter: parameter,
    };
  }
  return {
    surface: "pitchDelta",
    compositionMode: "baseline_plus_contribution",
    mutationMode: "replace",
    referenceFrame: "pitch_delta_contribution_cents",
    requiredInclude: {
      include: ["notes", "automation"],
      automationParameters,
    },
    baselineGuard,
    interpolationEvidence,
    hostProfileHash: "sha256:profile",
  };
}

function techniqueIr(techniques = [portamento()]) {
  const vibratoRequired = techniques.some((technique) => technique.kind === "vibrato");
  return {
    schemaVersion: 1,
    modelVersion: "pitch-techniques-v1",
    scope: {
      contextId: "ctx_pitch_1",
      occurrence: 0,
      expectedTargetGroupUuid: "group_pitch_1",
    },
    timeDomain: "seconds",
    referenceFrame: "pitch_delta_contribution_cents",
    techniques,
    composition: {
      rule: "sum_then_clamp",
      maxAbsCents: 200.0000000001,
      overlapPolicy: "explicit_priority_then_canonical_key",
    },
    target: target({ vibratoRequired }),
  };
}

test("TechniqueIR production module stays pure and reuses the concentrated numeric registry", () => {
  const sourcePath = fileURLToPath(
    new URL("../server/src/pitch-techniques/ir.js", import.meta.url),
  );
  const source = readFileSync(sourcePath, "utf8");
  // 集中模型现在与 planner 同包（docs/ 不进 npm 包），因此这里断言的是包内相对路径。
  assert.match(source, /from "\.\/model\.js"/);
  assert.doesNotMatch(source, /\.\.\/\.\.\/\.\.\/docs\//);
  assert.doesNotMatch(source, /artifact-store|host-|mcp|process\.env|session|store/i);
  assert.strictEqual(TECHNIQUE_IR_NUMERIC_FIELD_SCHEMA, referenceTechniqueIrNumericFieldSchema);
  assert.strictEqual(SEMANTIC_NUMERIC_QUANTA, referenceSemanticNumericQuanta);
  assert.equal(TECHNIQUE_IR_SCHEMA_VERSION, 1);
  assert.equal(TECHNIQUE_IR_MODEL_VERSION, "pitch-techniques-v1");
  assert.equal(TECHNIQUE_IR_TIME_DOMAIN, "seconds");
  assert.equal(PITCH_DELTA_REFERENCE_FRAME, "pitch_delta_contribution_cents");
  assert.equal(TECHNIQUE_IR_MAX_TECHNIQUES, 32);
});

test("TechniqueIR materializes canonical values and returns a deeply frozen sealed IR", () => {
  const input = techniqueIr();
  const normalized = normalizeTechniqueIr(input);
  assert.equal(normalized.composition.maxAbsCents, 200);
  assert.deepEqual(normalized.techniques[0], {
    id: "tech_0",
    priority: 0,
    canonicalKey: normalized.techniques[0].canonicalKey,
    anchors: { fromNote: 4, toNote: 5 },
    exclusive: false,
    kind: "portamento",
    model: {
      asymmetryLogB: 0.3,
      family: "richards_segment_normalized",
      inflectionRatio: 0.58,
      sharpness: 8,
    },
    span: { fromSeconds: 2, toSeconds: 2.24 },
  });
  assert.match(normalized.techniques[0].canonicalKey, /^sha256_[0-9a-f]{64}$/);
  assert.equal(normalized.target.interpolationEvidence.pitchDelta.method, "cubic");
  assert.equal(input.target.interpolationEvidence.pitchDelta.method, "CUBIC");
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.techniques), true);
  assert.equal(Object.isFrozen(normalized.techniques[0].model), true);
  assert.strictEqual(assertNormalizedTechniqueIr(normalized), normalized);
  assert.throws(
    () => assertNormalizedTechniqueIr(Object.freeze({})),
    (error) => error.code === "UNNORMALIZED_TECHNIQUE_IR",
  );
  assert.throws(() => {
    normalized.techniques[0].model.sharpness = 9;
  }, TypeError);
});

test("same kind and span with distinct parameters is stable across every input permutation", () => {
  const techniques = [
    portamento({ id: "a", requestIndex: 0, model: {
      family: "richards_segment_normalized",
      inflectionRatio: 0.5,
      sharpness: 4,
      asymmetryLogB: 0,
    } }),
    portamento({ id: "b", requestIndex: 1, model: {
      family: "richards_segment_normalized",
      inflectionRatio: 0.5,
      sharpness: 7,
      asymmetryLogB: 0,
    } }),
    portamento({ id: "c", requestIndex: 2, model: {
      family: "richards_segment_normalized",
      inflectionRatio: 0.5,
      sharpness: 10,
      asymmetryLogB: 0,
    } }),
  ];
  const orders = [
    [0, 1, 2], [0, 2, 1], [1, 0, 2],
    [1, 2, 0], [2, 0, 1], [2, 1, 0],
  ];
  const expected = normalizeTechniqueIr(techniqueIr(techniques));
  const expectedCanonical = canonicalize(expected);
  const expectedHash = contentHash(expected);
  for (const order of orders) {
    const actual = normalizeTechniqueIr(techniqueIr(order.map((index) => techniques[index])));
    assert.equal(canonicalize(actual), expectedCanonical);
    assert.equal(contentHash(actual), expectedHash);
  }
});

test("canonicalizer preserves quantization, collision, and machine-readable error evidence", () => {
  assert.deepEqual(
    canonicalizeTechniques([portamento()]),
    referenceCanonicalizeTechniques([portamento()]),
  );
  let caught;
  try {
    normalizeTechniqueIr(techniqueIr([
      portamento({ model: { family: "richards_segment_normalized", unknownNumeric: 0.1 + 0.2 } }),
    ]));
  } catch (error) {
    caught = error;
  }
  assert.equal(caught.code, "UNQUANTIZED_SEMANTIC_FIELD");
  assert.deepEqual(caught.details, {
    field: "unknownNumeric",
    path: "$/model/unknownNumeric",
    value: 0.1 + 0.2,
  });
  const encoded = encodeToolError(caught.code, caught.message, caught.details);
  assert.equal(encoded.isError, true);
  assert.equal(encoded.structuredContent.error.code, "UNQUANTIZED_SEMANTIC_FIELD");
  assert.equal(encoded.structuredContent.error.field, "unknownNumeric");
  assert.equal(encoded.structuredContent.error.path, "$/model/unknownNumeric");
  assert.equal(encoded.structuredContent.error.value, 0.1 + 0.2);

  assert.throws(
    () => normalizeTechniqueIr(techniqueIr([
      portamento({ anchors: { fromNote: 4.5, toNote: 5 } }),
    ])),
    (error) => error.code === "INVALID_INTEGER_SEMANTIC_FIELD"
      && error.details.field === "fromNote"
      && error.details.path === "$/anchors/fromNote",
  );

  const invalidOccurrence = techniqueIr();
  invalidOccurrence.scope.occurrence = 0.5;
  assert.throws(
    () => normalizeTechniqueIr(invalidOccurrence),
    (error) => error.code === "INVALID_INTEGER_SEMANTIC_FIELD"
      && error.details.field === "occurrence"
      && error.details.path === "$/scope/occurrence",
  );
});

test("TechniqueIR keeps the P2 target mapping sealed and rejects unknown fields", () => {
  const wrongFrame = techniqueIr();
  wrongFrame.target.referenceFrame = "absolute_group_pitch_semitone";
  assert.throws(
    () => normalizeTechniqueIr(wrongFrame),
    (error) => error.code === "REFERENCE_FRAME_SURFACE_MISMATCH"
      && error.details.actual.surface === "pitchDelta"
      && error.details.expected.referenceFrame === "pitch_delta_contribution_cents",
  );

  const unknownRoot = techniqueIr();
  unknownRoot.unexpected = true;
  assert.throws(
    () => normalizeTechniqueIr(unknownRoot),
    (error) => error.code === "INVALID_ARGUMENTS" && error.details.path === "$",
  );

  const alias = techniqueIr([{
    ...portamento(),
    type: "transition",
  }]);
  assert.throws(
    () => normalizeTechniqueIr(alias),
    (error) => error.code === "INVALID_ARGUMENTS" && error.details.path === "$/techniques/0",
  );
});

test("missing captured automation evidence gives a direct snapshot remediation", () => {
  const missingEvidence = techniqueIr();
  delete missingEvidence.target.requiredInclude;
  delete missingEvidence.target.baselineGuard;
  delete missingEvidence.target.interpolationEvidence;
  delete missingEvidence.target.hostProfileHash;
  assert.throws(
    () => normalizeTechniqueIr(missingEvidence),
    (error) => error.code === "CAPTURE_EVIDENCE_REQUIRED"
      && error.message.includes("sv_snapshot_range")
      && error.details.remediation.include.join(",") === "notes,automation"
      && error.details.remediation.automationParameters.join(",") === "pitchDelta"
      && error.details.missing.includes("interpolationEvidence"),
  );
});

test("vibrato TechniqueIR requires and normalizes both automation evidence records", () => {
  const missingVibratoEvidence = techniqueIr([portamento(), vibrato()]);
  missingVibratoEvidence.target = target();
  assert.throws(
    () => normalizeTechniqueIr(missingVibratoEvidence),
    (error) => error.code === "CAPTURE_EVIDENCE_REQUIRED"
      && error.details.remediation.automationParameters.join(",") === "pitchDelta,vibratoEnv",
  );

  const input = techniqueIr([portamento(), vibrato()]);
  input.target = target({ vibratoRequired: true });
  const normalized = normalizeTechniqueIr(input);
  assert.deepEqual(
    normalized.target.requiredInclude.automationParameters,
    ["pitchDelta", "vibratoEnv"],
  );
  assert.deepEqual(normalized.target.baselineGuard, {
    pitchDeltaFingerprint: "sha256:pitchDelta",
    vibratoEnvFingerprint: "sha256:vibratoEnv",
  });
  assert.equal(normalized.target.interpolationEvidence.vibratoEnv.method, "linear");
});

test("TechniqueIR rejects over-budget technique lists before canonicalization", () => {
  const techniques = Array.from(
    { length: TECHNIQUE_IR_MAX_TECHNIQUES + 1 },
    (_, index) => portamento({ id: `p${index}`, requestIndex: index }),
  );
  assert.throws(
    () => normalizeTechniqueIr(techniqueIr(techniques)),
    (error) => error.code === "INVALID_ARGUMENTS"
      && error.details.path === "$/techniques"
      && error.details.maximum === TECHNIQUE_IR_MAX_TECHNIQUES,
  );
});
