import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { decodeDense } from "../server/src/dense-codec.js";
import { normalizeCurveInput } from "../server/src/parameter-curve.js";
import {
  compilePitchDeltaMutationPlan,
  compilePitchDeltaTransition,
  PITCH_DELTA_MAX_COMPILED_POINTS,
} from "../server/src/pitch-techniques/pitch-delta-compiler.js";
import { composeTechniqueContributions } from "../server/src/pitch-techniques/compose.js";
import { normalizeTechniqueIr } from "../server/src/pitch-techniques/ir.js";

const DEFAULT_QUARTER_BLICK = 1_000;
const DEFAULT_OFFSET_BLICK = 2_000;

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function target() {
  return {
    surface: "pitchDelta",
    compositionMode: "baseline_plus_contribution",
    mutationMode: "replace",
    referenceFrame: "pitch_delta_contribution_cents",
    requiredInclude: {
      include: ["notes", "automation"],
      automationParameters: ["pitchDelta"],
    },
    baselineGuard: { pitchDeltaFingerprint: "sha256:pitch-delta" },
    interpolationEvidence: {
      pitchDelta: {
        method: "cubic",
        source: "host_getInterpolationMethod",
        capturedAtContextId: "ctx_pitch_delta",
        resolvedParameter: "pitchDelta",
      },
    },
    hostProfileHash: "sha256:profile",
  };
}

function transitionIr({ model, span }) {
  return normalizeTechniqueIr({
    schemaVersion: 1,
    modelVersion: "pitch-techniques-v1",
    scope: {
      contextId: "ctx_pitch_delta",
      occurrence: 0,
      expectedTargetGroupUuid: "group_pitch_delta",
    },
    timeDomain: "seconds",
    referenceFrame: "pitch_delta_contribution_cents",
    techniques: [{
      id: "transition",
      requestIndex: 0,
      kind: "portamento",
      anchors: { fromNote: 0, toNote: 1 },
      priority: 0,
      exclusive: false,
      model,
      span,
    }],
    composition: {
      rule: "sum_then_clamp",
      maxAbsCents: 1_200,
      overlapPolicy: "explicit_priority_then_canonical_key",
    },
    target: target(),
  });
}

function genericIr(span) {
  return normalizeTechniqueIr({
    schemaVersion: 1,
    modelVersion: "pitch-techniques-v1",
    scope: {
      contextId: "ctx_pitch_delta",
      occurrence: 0,
      expectedTargetGroupUuid: "group_pitch_delta",
    },
    timeDomain: "seconds",
    referenceFrame: "pitch_delta_contribution_cents",
    techniques: [{
      id: "transient",
      requestIndex: 0,
      kind: "transient",
      anchors: { note: 0 },
      priority: 0,
      exclusive: false,
      model: { family: "first_peak_transient" },
      span,
    }],
    composition: {
      rule: "sum_then_clamp",
      maxAbsCents: 1_200,
      overlapPolicy: "explicit_priority_then_canonical_key",
    },
    target: target(),
  });
}

function compositionFor(
  ir,
  seconds,
  values,
  finiteMask = seconds.map(() => true),
  baselineCents = undefined,
) {
  return composeTechniqueContributions({
    ir,
    seconds,
    finiteMask,
    techniqueValues: [{ canonicalKey: ir.techniques[0].canonicalKey, values }],
    ...(baselineCents === undefined ? {} : { baselineCents }),
  });
}

function spanAnchors(ir, span, startContributionCents, endContributionCents, baselineCents = 0) {
  return [
    {
      canonicalKey: ir.techniques[0].canonicalKey,
      role: "start",
      timeSeconds: span.fromSeconds,
      contributionCents: startContributionCents,
      baselineCents,
    },
    {
      canonicalKey: ir.techniques[0].canonicalKey,
      role: "end",
      timeSeconds: span.toSeconds,
      contributionCents: endContributionCents,
      baselineCents,
    },
  ];
}

function transitionFixture({
  fromPitch = 60,
  toPitch = 62,
  widthSeconds = 0.4,
  model = { family: "linear" },
  quarterBlick = DEFAULT_QUARTER_BLICK,
  occurrenceTimeOffsetBlick = DEFAULT_OFFSET_BLICK,
  fromOnsetBlick = 0,
  durationBlick = DEFAULT_QUARTER_BLICK,
  toOnsetBlick = durationBlick,
  toDurationBlick = durationBlick,
  baselineCents = 10,
  includeCompositionBaseline = true,
} = {}) {
  const notes = [
    {
      indexInGroup: 0,
      onsetBlick: fromOnsetBlick,
      durationBlick,
      pitchSemitone: fromPitch,
    },
    {
      indexInGroup: 1,
      onsetBlick: toOnsetBlick,
      durationBlick: toDurationBlick,
      pitchSemitone: toPitch,
    },
  ];
  const tempoMarks = [{ positionBlick: 0, positionSeconds: 0, bpm: 60 }];
  const boundarySeconds = (occurrenceTimeOffsetBlick + toOnsetBlick) / quarterBlick;
  const span = {
    fromSeconds: boundarySeconds - widthSeconds / 2,
    toSeconds: boundarySeconds + widthSeconds / 2,
  };
  const ir = transitionIr({ model, span });
  const transition = compilePitchDeltaTransition({
    fromNote: {
      ...notes[0],
      onsetSeconds: (occurrenceTimeOffsetBlick + notes[0].onsetBlick) / quarterBlick,
      endSeconds: (occurrenceTimeOffsetBlick + notes[0].onsetBlick + notes[0].durationBlick) / quarterBlick,
    },
    toNote: {
      ...notes[1],
      onsetSeconds: boundarySeconds,
      endSeconds: (occurrenceTimeOffsetBlick + toOnsetBlick + toDurationBlick) / quarterBlick,
    },
    widthSeconds,
    curve: model.family === "linear"
      ? { family: "linear" }
      : {
        family: "richards",
        inflectionRatio: model.inflectionRatio,
        sharpness: model.sharpness,
        asymmetryLogB: model.asymmetryLogB,
      },
  });
  const seconds = [
    transition.fromSeconds,
    transition.fromSeconds + widthSeconds / 4,
    transition.boundarySeconds,
    transition.toSeconds - widthSeconds / 4,
    transition.toSeconds,
  ];
  const baseline = seconds.map(() => baselineCents);
  const composition = compositionFor(
    ir,
    seconds,
    seconds.map((secondsValue) => transition.contributionCentAt(secondsValue)),
    undefined,
    includeCompositionBaseline ? baseline : undefined,
  );
  const mandatoryAnchors = [
    {
      canonicalKey: ir.techniques[0].canonicalKey,
      role: "start",
      timeSeconds: transition.fromSeconds,
      contributionCents: transition.contributionCentAt(transition.fromSeconds),
      baselineCents,
    },
    {
      canonicalKey: ir.techniques[0].canonicalKey,
      role: "boundary_before",
      timeSeconds: transition.boundarySeconds,
      contributionCents: transition.contributionCentAt(transition.boundarySeconds, "before"),
      baselineCents,
    },
    {
      canonicalKey: ir.techniques[0].canonicalKey,
      role: "boundary_at",
      timeSeconds: transition.boundarySeconds,
      contributionCents: transition.contributionCentAt(transition.boundarySeconds, "at"),
      baselineCents,
    },
    {
      canonicalKey: ir.techniques[0].canonicalKey,
      role: "end",
      timeSeconds: transition.toSeconds,
      contributionCents: transition.contributionCentAt(transition.toSeconds),
      baselineCents,
    },
  ];
  if (model.family === "richards_segment_normalized") {
    const inflectionSeconds = transition.fromSeconds + widthSeconds * model.inflectionRatio;
    mandatoryAnchors.push({
      canonicalKey: ir.techniques[0].canonicalKey,
      role: "inflection",
      timeSeconds: inflectionSeconds,
      contributionCents: transition.contributionCentAt(inflectionSeconds),
      baselineCents,
    });
  }
  const evidence = deepFreeze({
    notes,
    occurrenceTimeOffsetBlick,
    tempoMarks,
    quarterBlick,
    baselineCents: baseline,
    mandatoryAnchors,
  });
  return { ir, composition, evidence };
}

function decodedPoints(curve) {
  return decodeDense(curve.points);
}

function pointAt(points, blick) {
  const point = points.find((entry) => entry.blick === blick);
  assert.ok(point, `missing point at BLICK ${blick}`);
  return point.value;
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

test("pitchDelta compiler emits one dry-run replace request with distinct score-boundary sides", () => {
  const fixture = transitionFixture();
  const result = compilePitchDeltaMutationPlan(fixture);
  assert.equal(result.surface, "pitchDelta");
  assert.equal(result.mutationMode, "replace");
  assert.equal(result.mutation.action, "dry_run");
  assert.equal(result.mutation.atomic, true);
  assert.equal(result.postcondition.status, "pending_t12_host_interpolation");
  assert.equal(result.postcondition.requiredRead, "Automation.get");
  assert.equal(result.mutation.curves.length, 1);
  assert.equal(result.summary.pointCount, 6);
  assert.equal(result.summary.overriddenDensePointCount, 0);
  assert.equal(Object.isFrozen(result), true);

  const [curve] = result.mutation.curves;
  assert.deepEqual(normalizeCurveInput(curve), {
    parameter: "pitchDelta",
    mode: "replace",
    range: { kind: "blick", fromBlick: 800, toBlick: 1_200, coordinate: "local" },
    points: [
      { kind: "blick", blick: 800, value: 10 },
      { kind: "blick", blick: 900, value: 60 },
      { kind: "blick", blick: 999, value: 110 },
      { kind: "blick", blick: 1_000, value: -90 },
      { kind: "blick", blick: 1_100, value: -40 },
      { kind: "blick", blick: 1_200, value: 10 },
    ],
    amount: null,
    simplifyThreshold: undefined,
  });
  const points = decodedPoints(curve);
  const contributionBefore = pointAt(points, 999) - 10;
  const contributionAt = pointAt(points, 1_000) - 10;
  assert.equal(60 + contributionBefore / 100, 62 + contributionAt / 100);
  assert.equal(contributionAt - contributionBefore, -200);
});

test("pitchDelta compiler preserves F1b continuity for seeded upward/downward linear and Richards transitions", () => {
  const random = seededRandom(0x5032_544c);
  for (let trial = 0; trial < 160; trial += 1) {
    const fromPitch = 48 + random() * 24;
    const interval = (random() < 0.5 ? -1 : 1) * (0.1 + random() * 10.5);
    const widthSeconds = 0.05 + random() * 0.8;
    const model = trial % 2 === 0
      ? { family: "linear" }
      : {
        family: "richards_segment_normalized",
        inflectionRatio: 0.05 + random() * 0.9,
        sharpness: 1 + random() * 39,
        asymmetryLogB: -3 + random() * 6,
      };
    const fixture = transitionFixture({
      fromPitch,
      toPitch: fromPitch + interval,
      widthSeconds,
      model,
    });
    const result = compilePitchDeltaMutationPlan(fixture);
    const points = decodedPoints(result.mutation.curves[0]);
    const beforeContribution = pointAt(points, 999) - 10;
    const atContribution = pointAt(points, 1_000) - 10;
    assert.ok(Math.abs((fromPitch + beforeContribution / 100) - (fromPitch + interval + atContribution / 100)) <= 1e-8);
    assert.ok(Math.abs((atContribution - beforeContribution) + 100 * interval) <= 1e-6);
  }
});

test("pitchDelta compiler keeps frozen evidence and mutation bytes stable across evidence ordering", () => {
  const fixture = transitionFixture({
    model: {
      family: "richards_segment_normalized",
      inflectionRatio: 0.58,
      sharpness: 8,
      asymmetryLogB: 0.3,
    },
  });
  const reorderedEvidence = deepFreeze({
    ...fixture.evidence,
    notes: [...fixture.evidence.notes].reverse(),
    mandatoryAnchors: [...fixture.evidence.mandatoryAnchors].reverse(),
  });
  const first = compilePitchDeltaMutationPlan(fixture);
  const second = compilePitchDeltaMutationPlan({
    ir: fixture.ir,
    composition: fixture.composition,
    evidence: reorderedEvidence,
  });
  assert.equal(first.planHash, second.planHash);
  assert.equal(JSON.stringify(first.mutation), JSON.stringify(second.mutation));
  assert.equal(first.summary.serializedMutationBytes, second.summary.serializedMutationBytes);

  const mutable = structuredClone(fixture.evidence);
  assert.throws(
    () => compilePitchDeltaMutationPlan({
      ir: fixture.ir,
      composition: fixture.composition,
      evidence: mutable,
    }),
    (error) => error.code === "FROZEN_EVIDENCE_REQUIRED",
  );
});

test("pitchDelta compiler rejects rest, overlap, equal pitch, short notes, large intervals, and coarse BLICKs", () => {
  const base = transitionFixture();
  const cases = [
    {
      code: "TRANSITION_NOT_ADJACENT",
      mutate(evidence) {
        evidence.notes[1].onsetBlick = 1_001;
      },
    },
    {
      code: "TRANSITION_NOT_ADJACENT",
      mutate(evidence) {
        evidence.notes[1].onsetBlick = 999;
      },
    },
    {
      code: "TRANSITION_EQUAL_PITCH",
      mutate(evidence) {
        evidence.notes[1].pitchSemitone = 60;
      },
    },
    {
      code: "TRANSITION_WIDTH_EXCEEDS_ADJACENT_NOTES",
      mutate(evidence) {
        evidence.notes = [
          { indexInGroup: 0, onsetBlick: 0, durationBlick: 100, pitchSemitone: 60 },
          { indexInGroup: 1, onsetBlick: 100, durationBlick: 100, pitchSemitone: 62 },
        ];
      },
    },
    {
      code: "TRANSITION_EXCEEDS_PITCH_DELTA_RANGE",
      mutate(evidence) {
        evidence.notes[1].pitchSemitone = 90;
      },
    },
  ];
  for (const current of cases) {
    const evidence = structuredClone(base.evidence);
    current.mutate(evidence);
    assert.throws(
      () => compilePitchDeltaMutationPlan({
        ir: base.ir,
        composition: base.composition,
        evidence: deepFreeze(evidence),
      }),
      (error) => error.code === current.code,
    );
  }

  const coarse = transitionFixture({
    widthSeconds: 1,
    quarterBlick: 1,
    occurrenceTimeOffsetBlick: 0,
    durationBlick: 1,
    toOnsetBlick: 1,
    toDurationBlick: 1,
  });
  assert.throws(
    () => compilePitchDeltaMutationPlan(coarse),
    (error) => error.code === "TRANSITION_TIME_RESOLUTION_TOO_COARSE",
  );
});

test("pitchDelta compiler rejects invalid mandatory anchors and final baseline range overflow", () => {
  const richards = transitionFixture({
    model: {
      family: "richards_segment_normalized",
      inflectionRatio: 0.58,
      sharpness: 8,
      asymmetryLogB: 0.3,
    },
  });
  const missingInflection = structuredClone(richards.evidence);
  missingInflection.mandatoryAnchors = missingInflection.mandatoryAnchors.filter(
    (anchor) => anchor.role !== "inflection",
  );
  assert.throws(
    () => compilePitchDeltaMutationPlan({
      ir: richards.ir,
      composition: richards.composition,
      evidence: deepFreeze(missingInflection),
    }),
    (error) => error.code === "MANDATORY_ANCHOR_REQUIRED" && error.details.role === "inflection",
  );

  const invalidJump = structuredClone(richards.evidence);
  invalidJump.mandatoryAnchors.find((anchor) => anchor.role === "boundary_at").contributionCents += 1;
  assert.throws(
    () => compilePitchDeltaMutationPlan({
      ir: richards.ir,
      composition: richards.composition,
      evidence: deepFreeze(invalidJump),
    }),
    (error) => error.code === "TRANSITION_SCORE_STEP_NOT_CANCELLED",
  );

  const overflow = transitionFixture({
    baselineCents: 1_200,
    includeCompositionBaseline: false,
  });
  assert.throws(
    () => compilePitchDeltaMutationPlan(overflow),
    (error) => error.code === "TRANSITION_EXCEEDS_PITCH_DELTA_RANGE"
      && error.details.stage === "final"
      && error.details.maximumAbsCents === 1_200,
  );
});

test("pitchDelta compiler preserves null gaps as separate replace curves and bounds a 373-note plan", () => {
  const gapIr = genericIr({ fromSeconds: 0, toSeconds: 4 });
  const gapComposition = compositionFor(
    gapIr,
    [0, 1, 2, 3, 4],
    [1, 1, null, 1, 1],
    [true, true, false, true, true],
  );
  const gapEvidence = deepFreeze({
    notes: [{ indexInGroup: 0, onsetBlick: 0, durationBlick: 5_000, pitchSemitone: 60 }],
    occurrenceTimeOffsetBlick: 0,
    tempoMarks: [{ positionBlick: 0, positionSeconds: 0, bpm: 60 }],
    quarterBlick: 1_000,
    baselineCents: [0, 0, null, 0, 0],
    mandatoryAnchors: spanAnchors(gapIr, { fromSeconds: 0, toSeconds: 4 }, 1, 1),
  });
  const missingGapStart = structuredClone(gapEvidence);
  missingGapStart.mandatoryAnchors = missingGapStart.mandatoryAnchors.filter(
    (anchor) => anchor.role !== "start",
  );
  assert.throws(
    () => compilePitchDeltaMutationPlan({
      ir: gapIr,
      composition: gapComposition,
      evidence: deepFreeze(missingGapStart),
    }),
    (error) => error.code === "MANDATORY_ANCHOR_REQUIRED" && error.details.role === "start",
  );
  const gapResult = compilePitchDeltaMutationPlan({
    ir: gapIr,
    composition: gapComposition,
    evidence: gapEvidence,
  });
  assert.equal(gapResult.mutation.curves.length, 2);
  assert.deepEqual(gapResult.mutation.curves.map((curve) => curve.range), [
    { fromBlick: 0, toBlick: 1_000, coordinate: "local" },
    { fromBlick: 3_000, toBlick: 4_000, coordinate: "local" },
  ]);

  const noteCount = 373;
  const samples = noteCount * 4;
  const seconds = Array.from({ length: samples }, (_, index) => index / 4);
  const benchmarkSpan = { fromSeconds: 0, toSeconds: seconds.at(-1) };
  const benchmarkIr = genericIr(benchmarkSpan);
  const benchmarkComposition = compositionFor(
    benchmarkIr,
    seconds,
    seconds.map(() => 1e-6),
  );
  const benchmarkEvidence = deepFreeze({
    notes: Array.from({ length: noteCount }, (_, index) => ({
      indexInGroup: index,
      onsetBlick: index * 1_000,
      durationBlick: 1_000,
      pitchSemitone: 60 + index % 12,
    })),
    occurrenceTimeOffsetBlick: 0,
    tempoMarks: [{ positionBlick: 0, positionSeconds: 0, bpm: 60 }],
    quarterBlick: 1_000,
    baselineCents: seconds.map(() => 0),
    mandatoryAnchors: spanAnchors(benchmarkIr, benchmarkSpan, 1e-6, 1e-6),
  });
  const benchmark = compilePitchDeltaMutationPlan({
    ir: benchmarkIr,
    composition: benchmarkComposition,
    evidence: benchmarkEvidence,
  });
  assert.equal(benchmark.summary.pointCount, samples);
  assert.ok(benchmark.summary.pointCount <= PITCH_DELTA_MAX_COMPILED_POINTS);
  assert.equal(benchmark.mutation.curves.length, 1);
  assert.equal(benchmark.mutation.action, "dry_run");
  assert.ok(benchmark.summary.serializedMutationBytes <= 16 * 1024);
  assert.equal(
    benchmark.summary.serializedMutationBytes,
    Buffer.byteLength(JSON.stringify(benchmark.mutation), "utf8"),
  );
});

test("pitchDelta compiler remains a pure T11 layer", () => {
  const sourcePath = fileURLToPath(
    new URL("../server/src/pitch-techniques/pitch-delta-compiler.js", import.meta.url),
  );
  const source = readFileSync(sourcePath, "utf8");
  assert.doesNotMatch(source, /from\s+["'][^"']*(?:artifact-store|snapshot|host-|session)[^"']*["']/i);
  assert.doesNotMatch(source, /process\.env/);
});
