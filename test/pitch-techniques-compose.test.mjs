import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { normalizeTechniqueIr } from "../server/src/pitch-techniques/ir.js";
import { encodeToolError } from "../server/src/mcp-result-encoder.js";
import {
  composeTechniqueContributions,
  TECHNIQUE_COMPOSITION_MAX_SAMPLES,
} from "../server/src/pitch-techniques/compose.js";

function portamento({ id, requestIndex, priority = 0, sharpness, exclusive = false }) {
  return {
    id,
    requestIndex,
    kind: "portamento",
    anchors: { fromNote: 4, toNote: 5 },
    priority,
    exclusive,
    model: {
      family: "richards_segment_normalized",
      inflectionRatio: 0.5,
      sharpness,
      asymmetryLogB: 0,
    },
    span: { fromSeconds: 0, toSeconds: 1 },
  };
}

function normalizedIr(techniques, maxAbsCents = 200) {
  return normalizeTechniqueIr({
    schemaVersion: 1,
    modelVersion: "pitch-techniques-v1",
    scope: {
      contextId: "ctx_compose_1",
      occurrence: 0,
      expectedTargetGroupUuid: "group_compose_1",
    },
    timeDomain: "seconds",
    referenceFrame: "pitch_delta_contribution_cents",
    techniques,
    composition: {
      rule: "sum_then_clamp",
      maxAbsCents,
      overlapPolicy: "explicit_priority_then_canonical_key",
    },
    target: {
      surface: "pitchDelta",
      compositionMode: "baseline_plus_contribution",
      mutationMode: "replace",
      referenceFrame: "pitch_delta_contribution_cents",
      requiredInclude: {
        include: ["notes", "automation"],
        automationParameters: ["pitchDelta"],
      },
      baselineGuard: { pitchDeltaFingerprint: "sha256:pitchDelta" },
      interpolationEvidence: {
        pitchDelta: {
          method: "cubic",
          source: "host_getInterpolationMethod",
          capturedAtContextId: "ctx_compose_1",
          resolvedParameter: "pitchDelta",
        },
      },
      hostProfileHash: "sha256:profile",
    },
  });
}

function techniqueValues(ir, valuesForSharpness, { reverse = false } = {}) {
  const entries = ir.techniques.map((technique) => ({
    canonicalKey: technique.canonicalKey,
    values: valuesForSharpness.get(technique.model.sharpness),
  }));
  return reverse ? entries.reverse() : entries;
}

function compose(ir, values, options = {}) {
  return composeTechniqueContributions({
    ir,
    seconds: options.seconds ?? [0, 0.5, 1],
    finiteMask: options.finiteMask,
    techniqueValues: values,
    baselineCents: options.baselineCents,
  });
}

test("composition stays pure and refuses a frozen object that bypassed T09 normalization", () => {
  const sourcePath = fileURLToPath(
    new URL("../server/src/pitch-techniques/compose.js", import.meta.url),
  );
  const source = readFileSync(sourcePath, "utf8");
  assert.doesNotMatch(source, /artifact-store|host-|mcp|process\.env|session|store/i);
  const ir = normalizedIr([portamento({ id: "a", requestIndex: 0, sharpness: 4 })]);
  const values = techniqueValues(ir, new Map([[4, [1, 2, 3]]]));
  const result = compose(ir, values);
  assert.equal(result.summary.sampleCount, 3);
  assert.equal(Object.isFrozen(result), true);
  assert.throws(
    () => compose(Object.freeze(structuredClone(ir)), values),
    (error) => error.code === "UNNORMALIZED_TECHNIQUE_IR",
  );
});

test("composition order and hash are invariant to input and vector permutation", () => {
  const source = [
    portamento({ id: "a", requestIndex: 0, sharpness: 4 }),
    portamento({ id: "b", requestIndex: 1, sharpness: 7 }),
    portamento({ id: "c", requestIndex: 2, sharpness: 10 }),
  ];
  const valuesForSharpness = new Map([
    [4, [1, 2, 3]],
    [7, [10, 20, 30]],
    [10, [-1, -2, -3]],
  ]);
  const firstIr = normalizedIr(source);
  const secondIr = normalizedIr([...source].reverse());
  const first = compose(firstIr, techniqueValues(firstIr, valuesForSharpness));
  const second = compose(secondIr, techniqueValues(secondIr, valuesForSharpness, { reverse: true }));
  assert.deepEqual(second, first);
  assert.deepEqual(first.techniqueOrder.map((technique) => technique.id), ["tech_0", "tech_1", "tech_2"]);
  assert.deepEqual(first.contributionCents, [10, 20, 30]);
});

test("sum_then_clamp aggregates contribution evidence before checking final pitchDelta", () => {
  const ir = normalizedIr([
    portamento({ id: "a", requestIndex: 0, sharpness: 4 }),
    portamento({ id: "b", requestIndex: 1, sharpness: 7 }),
  ]);
  const values = techniqueValues(ir, new Map([
    [4, [150, -150, 20]],
    [7, [100, -100, -5]],
  ]));
  const result = compose(ir, values, { baselineCents: [900, -900, 0] });
  assert.deepEqual(result.contributionCents, [200, -200, 15]);
  assert.deepEqual(result.finalPitchDeltaCents, [1100, -1100, 15]);
  assert.deepEqual(result.warnings, [{
    code: "CONTRIBUTION_CLAMPED",
    stage: "contribution",
    count: 2,
    maximumAbsRawContributionCents: 250,
    maxAbsCents: 200,
  }]);
  let finalError;
  try {
    compose(ir, values, { baselineCents: [1001, 0, 0] });
  } catch (error) {
    finalError = error;
  }
  assert.equal(finalError.code, "PITCH_DELTA_RANGE_EXCEEDED");
  assert.equal(finalError.details.stage, "final");
  assert.equal(finalError.details.index, 0);
  assert.equal(finalError.details.contributionCents, 200);
  const encoded = encodeToolError(finalError.code, finalError.message, finalError.details);
  assert.equal(encoded.structuredContent.error.code, "PITCH_DELTA_RANGE_EXCEEDED");
  assert.equal(encoded.structuredContent.error.stage, "final");
});

test("null gaps neither interpolate nor accept contribution or baseline values", () => {
  const ir = normalizedIr([
    portamento({ id: "a", requestIndex: 0, sharpness: 4 }),
    portamento({ id: "b", requestIndex: 1, sharpness: 7 }),
  ]);
  const values = techniqueValues(ir, new Map([
    [4, [1, null, 2, null]],
    [7, [3, null, null, null]],
  ]));
  const result = compose(ir, values, {
    seconds: [0, 1, 2, 3],
    finiteMask: [true, false, true, true],
    baselineCents: [10, null, 20, 30],
  });
  assert.deepEqual(result.contributionCents, [4, null, 2, 0]);
  assert.deepEqual(result.finalPitchDeltaCents, [14, null, 22, 30]);
  assert.equal(result.summary.nullSampleCount, 1);

  const leaking = techniqueValues(ir, new Map([
    [4, [1, 2, 2, null]],
    [7, [3, null, null, null]],
  ]));
  assert.throws(
    () => compose(ir, leaking, {
      seconds: [0, 1, 2, 3],
      finiteMask: [true, false, true, true],
    }),
    (error) => error.code === "CONTRIBUTION_OUTSIDE_FINITE_RUN"
      && error.details.stage === "contribution"
      && error.details.index === 1,
  );
});

test("equal-priority exclusive overlap is a PLAN_CONFLICT independent of input order", () => {
  const ir = normalizedIr([
    portamento({ id: "exclusive", requestIndex: 0, sharpness: 4, exclusive: true }),
    portamento({ id: "peer", requestIndex: 1, sharpness: 7 }),
  ]);
  assert.throws(
    () => composeTechniqueContributions({
      ir,
      seconds: [0, 1],
      techniqueValues: [],
    }),
    (error) => error.code === "PLAN_CONFLICT"
      && error.details.priority === 0
      && error.details.left.canonicalKey !== error.details.right.canonicalKey,
  );
});

test("composition rejects mismatched vectors and the dense sample budget", () => {
  const ir = normalizedIr([portamento({ id: "a", requestIndex: 0, sharpness: 4 })]);
  assert.throws(
    () => composeTechniqueContributions({
      ir,
      seconds: [0, 1],
      techniqueValues: [],
    }),
    (error) => error.code === "TECHNIQUE_CONTRIBUTION_MISMATCH",
  );
  assert.throws(
    () => composeTechniqueContributions({
      ir,
      seconds: Array.from({ length: TECHNIQUE_COMPOSITION_MAX_SAMPLES + 1 }, (_, index) => index),
      techniqueValues: [],
    }),
    (error) => error.code === "COMPOSITION_POINT_BUDGET_EXCEEDED"
      && error.details.maximum === TECHNIQUE_COMPOSITION_MAX_SAMPLES,
  );
});

test("10000 samples across 32 techniques stays within the deterministic composition budget", () => {
  const techniques = Array.from(
    { length: 32 },
    (_, index) => portamento({
      id: `technique-${index}`,
      requestIndex: index,
      sharpness: index + 1,
    }),
  );
  const ir = normalizedIr(techniques);
  const seconds = Array.from({ length: TECHNIQUE_COMPOSITION_MAX_SAMPLES }, (_, index) => index / 1000);
  const values = techniqueValues(
    ir,
    new Map(ir.techniques.map((technique) => [
      technique.model.sharpness,
      Array(TECHNIQUE_COMPOSITION_MAX_SAMPLES).fill(0.01),
    ])),
    { reverse: true },
  );
  composeTechniqueContributions({ ir, seconds, techniqueValues: values });
  const durations = [];
  for (let run = 0; run < 20; run += 1) {
    const startedAt = performance.now();
    const result = composeTechniqueContributions({ ir, seconds, techniqueValues: values });
    durations.push(performance.now() - startedAt);
    assert.ok(Math.abs(result.contributionCents.at(-1) - 0.32) <= 1e-12);
  }
  durations.sort((left, right) => left - right);
  const p95 = durations[Math.ceil(durations.length * 0.95) - 1];
  assert.ok(p95 <= 50, `composition 10000-sample p95 exceeded 50 ms: ${p95}`);
});
