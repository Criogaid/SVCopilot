import { contentHash } from "../canonical-json.js";
import { PITCH_DELTA_LIMIT_CENT } from "./model.js";
import { assertNormalizedTechniqueIr } from "./ir.js";
import { codedError } from "../coded-error.js";

export const TECHNIQUE_COMPOSITION_MAX_SAMPLES = 10_000;

export function composeTechniqueContributions(input) {
  assertRecord(input, "$");
  assertKnownKeys(
    input,
    ["ir", "seconds", "finiteMask", "techniqueValues", "baselineCents"],
    "$",
  );
  const ir = assertNormalizedTechniqueIr(input.ir);
  const seconds = normalizeSeconds(input.seconds);
  const finiteMask = normalizeFiniteMask(input.finiteMask, seconds.length);
  const techniqueOrder = orderedTechniques(ir.techniques);
  assertNoExclusiveOverlap(techniqueOrder);
  const valuesByCanonicalKey = normalizeTechniqueValues(
    input.techniqueValues,
    techniqueOrder,
    seconds.length,
  );
  const baselineCents = normalizeBaseline(input.baselineCents, seconds.length);
  const output = composeSamples({
    ir,
    seconds,
    finiteMask,
    techniqueOrder,
    valuesByCanonicalKey,
    baselineCents,
  });
  const result = {
    techniqueOrder: output.techniqueOrder,
    seconds,
    finiteMask,
    contributionCents: output.contributionCents,
    warnings: output.warnings,
    summary: output.summary,
  };
  if (output.finalPitchDeltaCents) result.finalPitchDeltaCents = output.finalPitchDeltaCents;
  return deepFreeze({
    ...result,
    compositionHash: contentHash(result),
  });
}

function normalizeSeconds(seconds) {
  if (!Array.isArray(seconds) || seconds.length === 0) {
    throw codedError("INVALID_ARGUMENTS", "seconds must be a non-empty array", {
      path: "$/seconds",
    });
  }
  if (seconds.length > TECHNIQUE_COMPOSITION_MAX_SAMPLES) {
    throw codedError("COMPOSITION_POINT_BUDGET_EXCEEDED", "composition sample budget exceeded", {
      path: "$/seconds",
      maximum: TECHNIQUE_COMPOSITION_MAX_SAMPLES,
      actual: seconds.length,
    });
  }
  let previous = -Infinity;
  return seconds.map((secondsValue, index) => {
    if (!Number.isFinite(secondsValue)) {
      throw codedError("INVALID_ARGUMENTS", "seconds must contain finite values", {
        path: `$/seconds/${index}`,
      });
    }
    if (secondsValue <= previous) {
      throw codedError("INVALID_ARGUMENTS", "seconds must be strictly increasing", {
        path: `$/seconds/${index}`,
        previous,
        value: secondsValue,
      });
    }
    previous = secondsValue;
    return Object.is(secondsValue, -0) ? 0 : secondsValue;
  });
}

function normalizeFiniteMask(value, length) {
  if (value === undefined) return Array(length).fill(true);
  if (!Array.isArray(value) || value.length !== length || value.some((entry) => typeof entry !== "boolean")) {
    throw codedError("INVALID_ARGUMENTS", "finiteMask must be a boolean array aligned with seconds", {
      path: "$/finiteMask",
    });
  }
  return [...value];
}

function orderedTechniques(techniques) {
  return [...techniques]
    .sort((left, right) => left.priority - right.priority || compareCanonicalKeys(
      left.canonicalKey,
      right.canonicalKey,
    ))
    .map((technique) => ({
      id: technique.id,
      priority: technique.priority,
      canonicalKey: technique.canonicalKey,
      exclusive: technique.exclusive === true,
      span: technique.span,
    }));
}

function compareCanonicalKeys(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function assertNoExclusiveOverlap(techniques) {
  for (let leftIndex = 0; leftIndex < techniques.length; leftIndex += 1) {
    const left = techniques[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < techniques.length; rightIndex += 1) {
      const right = techniques[rightIndex];
      if (left.priority !== right.priority) continue;
      if (!left.exclusive && !right.exclusive) continue;
      if (!spansOverlap(left.span, right.span)) continue;
      throw codedError("PLAN_CONFLICT", "equal-priority exclusive techniques overlap", {
        priority: left.priority,
        left: techniqueReference(left),
        right: techniqueReference(right),
      });
    }
  }
}

function spansOverlap(left, right) {
  return Math.max(left.fromSeconds, right.fromSeconds) < Math.min(left.toSeconds, right.toSeconds);
}

function techniqueReference(technique) {
  return {
    id: technique.id,
    canonicalKey: technique.canonicalKey,
    span: technique.span,
  };
}

function normalizeTechniqueValues(value, techniques, length) {
  if (!Array.isArray(value) || value.length !== techniques.length) {
    throw codedError("TECHNIQUE_CONTRIBUTION_MISMATCH", "one contribution vector is required per technique", {
      expected: techniques.length,
      actual: Array.isArray(value) ? value.length : null,
    });
  }
  const expectedKeys = new Set(techniques.map((technique) => technique.canonicalKey));
  const valuesByCanonicalKey = new Map();
  for (const [index, entry] of value.entries()) {
    const path = `$/techniqueValues/${index}`;
    assertRecord(entry, path);
    assertKnownKeys(entry, ["canonicalKey", "values"], path);
    if (typeof entry.canonicalKey !== "string" || !expectedKeys.has(entry.canonicalKey)) {
      throw codedError("TECHNIQUE_CONTRIBUTION_MISMATCH", "contribution references an unknown technique", {
        path: `${path}/canonicalKey`,
        canonicalKey: entry.canonicalKey,
      });
    }
    if (valuesByCanonicalKey.has(entry.canonicalKey)) {
      throw codedError("TECHNIQUE_CONTRIBUTION_MISMATCH", "contribution repeats a technique", {
        path: `${path}/canonicalKey`,
        canonicalKey: entry.canonicalKey,
      });
    }
    if (!Array.isArray(entry.values) || entry.values.length !== length) {
      throw codedError("TECHNIQUE_CONTRIBUTION_MISMATCH", "contribution values must align with seconds", {
        path: `${path}/values`,
        expected: length,
        actual: Array.isArray(entry.values) ? entry.values.length : null,
      });
    }
    const normalizedValues = entry.values.map((sample, sampleIndex) => {
      if (sample === null) return null;
      if (Number.isFinite(sample)) return Object.is(sample, -0) ? 0 : sample;
      throw codedError("INVALID_ARGUMENTS", "contribution values must be finite numbers or null", {
        path: `${path}/values/${sampleIndex}`,
      });
    });
    valuesByCanonicalKey.set(entry.canonicalKey, normalizedValues);
  }
  if (valuesByCanonicalKey.size !== expectedKeys.size) {
    const missing = [...expectedKeys].filter((canonicalKey) => !valuesByCanonicalKey.has(canonicalKey));
    throw codedError("TECHNIQUE_CONTRIBUTION_MISMATCH", "contribution is missing a technique", {
      missing,
    });
  }
  return valuesByCanonicalKey;
}

function normalizeBaseline(value, length) {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length !== length) {
    throw codedError("INVALID_ARGUMENTS", "baselineCents must align with seconds", {
      path: "$/baselineCents",
      expected: length,
      actual: Array.isArray(value) ? value.length : null,
    });
  }
  return value.map((sample, index) => {
    if (sample === null || Number.isFinite(sample)) return Object.is(sample, -0) ? 0 : sample;
    throw codedError("INVALID_ARGUMENTS", "baselineCents must contain finite numbers or null", {
      path: `$/baselineCents/${index}`,
    });
  });
}

function composeSamples({
  ir,
  seconds,
  finiteMask,
  techniqueOrder,
  valuesByCanonicalKey,
  baselineCents,
}) {
  const contributionCents = Array(seconds.length);
  const finalPitchDeltaCents = baselineCents ? Array(seconds.length) : null;
  let finiteSampleCount = 0;
  let clampedSampleCount = 0;
  let maximumAbsRawContributionCents = 0;
  for (let index = 0; index < seconds.length; index += 1) {
    if (!finiteMask[index]) {
      assertGapValuesAreNull({ index, seconds, techniqueOrder, valuesByCanonicalKey, baselineCents });
      contributionCents[index] = null;
      if (finalPitchDeltaCents) finalPitchDeltaCents[index] = null;
      continue;
    }
    finiteSampleCount += 1;
    let rawContributionCents = 0;
    for (const technique of techniqueOrder) {
      const value = valuesByCanonicalKey.get(technique.canonicalKey)[index];
      if (value === null) continue;
      rawContributionCents += value;
      if (!Number.isFinite(rawContributionCents)) {
        throw codedError("COMPOSITION_NUMERIC_OVERFLOW", "contribution sum is not finite", {
          stage: "contribution",
          index,
          seconds: seconds[index],
          canonicalKey: technique.canonicalKey,
        });
      }
    }
    const contribution = clampContribution(rawContributionCents, ir.composition.maxAbsCents);
    contributionCents[index] = contribution;
    maximumAbsRawContributionCents = Math.max(
      maximumAbsRawContributionCents,
      Math.abs(rawContributionCents),
    );
    if (contribution !== rawContributionCents) clampedSampleCount += 1;
    if (!finalPitchDeltaCents) continue;
    const baseline = baselineCents[index];
    if (baseline === null) {
      throw codedError("BASELINE_FINITE_SAMPLE_REQUIRED", "baseline is null inside a finite run", {
        stage: "final",
        index,
        seconds: seconds[index],
      });
    }
    const finalValue = baseline + contribution;
    if (!Number.isFinite(finalValue) || Math.abs(finalValue) > PITCH_DELTA_LIMIT_CENT) {
      throw codedError("PITCH_DELTA_RANGE_EXCEEDED", "final pitchDelta exceeds the supported range", {
        stage: "final",
        index,
        seconds: seconds[index],
        baselineCents: baseline,
        contributionCents: contribution,
        finalPitchDeltaCents: finalValue,
        maximumAbsCents: PITCH_DELTA_LIMIT_CENT,
      });
    }
    finalPitchDeltaCents[index] = Object.is(finalValue, -0) ? 0 : finalValue;
  }
  const warnings = clampedSampleCount === 0 ? [] : [{
    code: "CONTRIBUTION_CLAMPED",
    stage: "contribution",
    count: clampedSampleCount,
    maximumAbsRawContributionCents,
    maxAbsCents: ir.composition.maxAbsCents,
  }];
  return {
    techniqueOrder: techniqueOrder.map(({ exclusive: _exclusive, ...technique }) => technique),
    contributionCents,
    finalPitchDeltaCents,
    warnings,
    summary: {
      sampleCount: seconds.length,
      finiteSampleCount,
      nullSampleCount: seconds.length - finiteSampleCount,
      techniqueCount: techniqueOrder.length,
      clampedSampleCount,
      maximumAbsRawContributionCents,
      maxAbsContributionCents: ir.composition.maxAbsCents,
    },
  };
}

function assertGapValuesAreNull({ index, seconds, techniqueOrder, valuesByCanonicalKey, baselineCents }) {
  for (const technique of techniqueOrder) {
    const value = valuesByCanonicalKey.get(technique.canonicalKey)[index];
    if (value !== null) {
      throw codedError("CONTRIBUTION_OUTSIDE_FINITE_RUN", "contribution must be null inside a gap", {
        stage: "contribution",
        index,
        seconds: seconds[index],
        canonicalKey: technique.canonicalKey,
      });
    }
  }
  if (baselineCents && baselineCents[index] !== null) {
    throw codedError("BASELINE_OUTSIDE_FINITE_RUN", "baseline must be null inside a gap", {
      stage: "final",
      index,
      seconds: seconds[index],
    });
  }
}

function clampContribution(value, maximum) {
  const clamped = Math.max(-maximum, Math.min(maximum, value));
  return Object.is(clamped, -0) ? 0 : clamped;
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
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return;
  throw codedError("INVALID_ARGUMENTS", "value must be an object", { path });
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
