import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { canonicalize, contentHash } from "../server/src/canonical-json.js";
import {
  compileFirstPeakTransient,
  normalizedRichardsTransition,
  secondOrderImpulse,
  solveOpenLoopCorrection,
  timeVaryingVibrato,
} from "../server/src/pitch-techniques/model.js";

const FIXTURE_URL = new URL(
  "../test/fixtures/pitch-techniques/synthetic-corpus.v1.json",
  import.meta.url,
);
const CORPUS_SEED = 0x5049_5443;

function secondsGrid(startSeconds, endSeconds, sampleCount) {
  return Array.from({ length: sampleCount }, (_, index) => (
    startSeconds + (endSeconds - startSeconds) * index / (sampleCount - 1)
  ));
}

function timeSeriesCase({
  id,
  family,
  input,
  sampleSeconds,
  valueAt,
  unit,
  invariants,
  tolerance,
  seed,
}) {
  return {
    id,
    family,
    input,
    sampleSeconds,
    denseTruth: {
      unit,
      values: sampleSeconds.map(valueAt),
    },
    mask: sampleSeconds.map(() => true),
    invariants,
    tolerance,
    seed,
  };
}

function rejectedCase({ id, family, input, code, invariants, seed }) {
  return {
    id,
    family,
    input,
    sampleSeconds: [],
    denseTruth: { unit: "none", values: [] },
    mask: [],
    invariants,
    tolerance: { absolute: 0 },
    seed,
    expectedError: { code },
  };
}

function buildRichardsCases() {
  const upward = {
    spanSeconds: 0.8,
    inflectionSeconds: 0.4,
    growthPerSecond: 10,
    asymmetryB: 1,
    lowerPitch: 60,
    upperPitch: 67,
  };
  const downward = {
    spanSeconds: 0.9,
    inflectionSeconds: 0.27,
    growthPerSecond: 13.5,
    asymmetryB: Math.exp(1.2),
    lowerPitch: 72,
    upperPitch: 61,
  };
  return [
    timeSeriesCase({
      id: "richards-upward-symmetric",
      family: "richards_segment",
      input: upward,
      sampleSeconds: secondsGrid(0, upward.spanSeconds, 17),
      valueAt: (seconds) => normalizedRichardsTransition(
        seconds,
        upward.lowerPitch,
        upward.upperPitch,
        upward,
      ),
      unit: "semitone",
      invariants: ["strict_endpoints", "monotonic_upward", "midpoint_symmetry"],
      tolerance: { absolute: 1e-12 },
      seed: CORPUS_SEED + 1,
    }),
    timeSeriesCase({
      id: "richards-downward-strong-asymmetry",
      family: "richards_segment",
      input: downward,
      sampleSeconds: secondsGrid(0, downward.spanSeconds, 19),
      valueAt: (seconds) => normalizedRichardsTransition(
        seconds,
        downward.lowerPitch,
        downward.upperPitch,
        downward,
      ),
      unit: "semitone",
      invariants: ["strict_endpoints", "monotonic_downward", "asymmetric_inflection"],
      tolerance: { absolute: 1e-12 },
      seed: CORPUS_SEED + 2,
    }),
    rejectedCase({
      id: "richards-degenerate-segment",
      family: "richards_segment",
      input: {
        spanSeconds: 1,
        inflectionSeconds: 0.5,
        growthPerSecond: Number.MIN_VALUE,
        asymmetryB: 1,
      },
      code: "RICHARDS_DEGENERATE_SEGMENT",
      invariants: ["rejects_numerically_degenerate_segment"],
      seed: CORPUS_SEED + 3,
    }),
    rejectedCase({
      id: "richards-inflection-overflow",
      family: "richards_asymptotic",
      input: {
        A: Number.MAX_SAFE_INTEGER,
        B: Number.MIN_VALUE,
        growthPerSecond: Number.MIN_VALUE,
        midpointSeconds: 0,
      },
      code: "RICHARDS_INFLECTION_OVERFLOW",
      invariants: ["rejects_unrepresentable_inflection"],
      seed: CORPUS_SEED + 4,
    }),
  ];
}

function buildTransientCases() {
  const underdamped = {
    peakSemitone: 0.35,
    peakTimeSeconds: 0.04,
    dampingRatio: 0.5422,
    onsetSeconds: 0.01,
    spanSeconds: 0.32,
    tailPolicy: "continuous_taper",
    maxFitErrorCent: 1,
    sampleIntervalSeconds: 0.005,
  };
  const critical = {
    peakSemitone: -0.28,
    peakTimeSeconds: 0.05,
    dampingRatio: 1,
    onsetSeconds: 0,
    spanSeconds: 0.4,
    tailPolicy: "reject",
    maxFitErrorCent: 1,
    sampleIntervalSeconds: 0.005,
  };
  const undamped = {
    peakSemitone: 0.22,
    peakTimeSeconds: 0.06,
    dampingRatio: 0,
    onsetSeconds: 0,
    spanSeconds: 0.4,
    tailPolicy: "continuous_taper",
    maxFitErrorCent: 1,
    sampleIntervalSeconds: 0.005,
  };
  const genericOverdamped = {
    naturalAngularFrequencyRadPerSecond: 34.8,
    dampingRatio: 1.4,
    numeratorRatePerSecond: 22,
    onsetSeconds: 0.02,
  };
  const compiledUnderdamped = compileFirstPeakTransient(underdamped);
  const compiledCritical = compileFirstPeakTransient(critical);
  const compiledUndamped = compileFirstPeakTransient(undamped);
  return [
    timeSeriesCase({
      id: "transient-underdamped-first-peak",
      family: "first_peak_transient",
      input: underdamped,
      sampleSeconds: secondsGrid(underdamped.onsetSeconds, underdamped.onsetSeconds + underdamped.spanSeconds, 17),
      valueAt: (seconds) => compiledUnderdamped.valueAt(seconds),
      unit: "semitone",
      invariants: ["first_peak_matches", "continuous_taper", "finite_response"],
      tolerance: { absolute: 1e-12 },
      seed: CORPUS_SEED + 10,
    }),
    timeSeriesCase({
      id: "transient-critical-first-peak",
      family: "first_peak_transient",
      input: critical,
      sampleSeconds: secondsGrid(critical.onsetSeconds, critical.onsetSeconds + critical.spanSeconds, 17),
      valueAt: (seconds) => compiledCritical.valueAt(seconds),
      unit: "semitone",
      invariants: ["critical_damping", "first_peak_matches", "tail_settled"],
      tolerance: { absolute: 1e-12 },
      seed: CORPUS_SEED + 11,
    }),
    timeSeriesCase({
      id: "transient-undamped-continuous-taper",
      family: "first_peak_transient",
      input: undamped,
      sampleSeconds: secondsGrid(undamped.onsetSeconds, undamped.onsetSeconds + undamped.spanSeconds, 17),
      valueAt: (seconds) => compiledUndamped.valueAt(seconds),
      unit: "semitone",
      invariants: ["undamped_requires_taper", "peak_preserved", "span_endpoint_zero"],
      tolerance: { absolute: 1e-12 },
      seed: CORPUS_SEED + 12,
    }),
    timeSeriesCase({
      id: "transient-generic-overdamped-response",
      family: "second_order_impulse",
      input: genericOverdamped,
      sampleSeconds: secondsGrid(0, 0.4, 17),
      valueAt: (seconds) => secondOrderImpulse(seconds, genericOverdamped),
      unit: "response_unit",
      invariants: ["overdamped_finite", "single_peak", "onset_zero"],
      tolerance: { absolute: 1e-12 },
      seed: CORPUS_SEED + 13,
    }),
    rejectedCase({
      id: "transient-unsettled-tail",
      family: "first_peak_transient",
      input: {
        peakSemitone: 0.3,
        peakTimeSeconds: 0.05,
        dampingRatio: 0.2,
        spanSeconds: 0.1,
        tailPolicy: "reject",
        maxFitErrorCent: 1,
        sampleIntervalSeconds: 0.005,
      },
      code: "TAIL_NOT_SETTLED",
      invariants: ["rejects_unsettled_tail"],
      seed: CORPUS_SEED + 14,
    }),
  ];
}

function buildVibratoCases() {
  const cases = [
    ["vibrato-fixed-4hz", 4, 4, 0.2, 0.2, 0, 0, 0],
    ["vibrato-fixed-5_5hz", 5.5, 5.5, 0.25, 0.25, 0, 0, 0],
    ["vibrato-fixed-7hz-center-drift", 7, 7, 0.18, 0.18, -0.04, 0.06, 0.3],
    ["vibrato-swept-9hz-to-4hz", 9, 4, 0.3, 0.1, 0.03, -0.02, -0.4],
  ];
  return cases.map(([
    id,
    rateStartHz,
    rateEndHz,
    depthStartSemitone,
    depthEndSemitone,
    centerStartSemitone,
    centerEndSemitone,
    phaseRad,
  ], index) => {
    const input = {
      startSeconds: 0,
      endSeconds: 1.5,
      rateStartHz,
      rateEndHz,
      depthStartSemitone,
      depthEndSemitone,
      centerStartSemitone,
      centerEndSemitone,
      phaseRad,
      fadeInSeconds: index === 3 ? 0.2 : 0.1,
      fadeOutSeconds: index === 3 ? 0.3 : 0.1,
    };
    return timeSeriesCase({
      id,
      family: "time_varying_vibrato",
      input,
      sampleSeconds: secondsGrid(input.startSeconds, input.endSeconds, 31),
      valueAt: (seconds) => timeVaryingVibrato(seconds, input),
      unit: "semitone",
      invariants: ["span_endpoints_zero", "finite_phase", "bounded_by_envelope"],
      tolerance: { absolute: 1e-12 },
      seed: CORPUS_SEED + 20 + index,
    });
  });
}

function buildAnalysisCases() {
  const correctionInput = {
    targetAbsoluteCent: [6000, 6005, 6010, null, null, 6020, 6025, 6030, 6035, 6040],
    observedComputedMidi: [59.9, 59.93, 59.95, null, null, 60.15, 60.17, 60.2, 60.22, 60.24],
    currentPitchDeltaCent: [0, 2, 4, null, null, -4, -2, 0, 2, 4],
  };
  const correctionOptions = {
    smoothnessLambda: 0.4,
    magnitudeMu: 0.01,
    minimumCoverage: 0.7,
    minimumRunFrames: 3,
    maxAbsCorrectionCent: 50,
  };
  const correction = solveOpenLoopCorrection(correctionInput, correctionOptions);
  const overlapInput = {
    portamentoSemitone: [0, 0.08, 0.2, 0.34, 0.4, 0.4, 0.4, 0.4, 0.4],
    transientSemitone: [0.18, 0.12, 0.04, -0.03, -0.05, -0.03, -0.01, 0, 0],
    vibratoSemitone: [0, 0.05, -0.04, 0.03, -0.05, 0.04, -0.03, 0.02, 0],
  };
  return [
    {
      id: "tempo-change-uniform-seconds-frequency",
      family: "uniform_seconds_grid",
      input: {
        tempoMarks: [
          { positionBlick: 0, bpm: 120 },
          { positionBlick: 1_411_200_000, bpm: 90 },
        ],
        sampleIntervalSeconds: 0.05,
        targetRateHz: 7,
      },
      sampleSeconds: secondsGrid(0, 0.8, 17),
      denseTruth: { unit: "hertz", values: Array(17).fill(7) },
      mask: Array(17).fill(true),
      invariants: ["uniform_seconds_grid", "rate_independent_of_tempo_step"],
      tolerance: { absolute: 0.035 },
      seed: CORPUS_SEED + 30,
    },
    {
      id: "open-loop-correction-null-gap",
      family: "open_loop_correction",
      input: { ...correctionInput, options: correctionOptions },
      sampleSeconds: secondsGrid(0, 0.09, correction.correctionCent.length),
      denseTruth: { unit: "cent", values: correction.correctionCent },
      mask: correction.correctionCent.map((value) => value !== null),
      invariants: ["finite_runs_are_independent", "null_gap_preserved", "bounded_correction"],
      tolerance: { absolute: 1e-9 },
      seed: CORPUS_SEED + 31,
    },
    rejectedCase({
      id: "open-loop-correction-all-null",
      family: "open_loop_correction",
      input: {
        targetAbsoluteCent: [null, null, null, null],
        observedComputedMidi: [null, null, null, null],
        currentPitchDeltaCent: [null, null, null, null],
      },
      code: "INSUFFICIENT_COMPUTED_PITCH",
      invariants: ["rejects_all_null_coverage"],
      seed: CORPUS_SEED + 32,
    }),
    rejectedCase({
      id: "open-loop-correction-low-coverage",
      family: "open_loop_correction",
      input: {
        targetAbsoluteCent: [6000, null, null, null],
        observedComputedMidi: [60, null, null, null],
        currentPitchDeltaCent: [0, null, null, null],
        options: { minimumCoverage: 0.75 },
      },
      code: "INSUFFICIENT_COMPUTED_PITCH",
      invariants: ["rejects_low_coverage"],
      seed: CORPUS_SEED + 33,
    }),
    {
      id: "composition-portamento-transient-vibrato-overlap",
      family: "technique_composition",
      input: overlapInput,
      sampleSeconds: secondsGrid(0, 0.4, overlapInput.portamentoSemitone.length),
      denseTruth: {
        unit: "semitone",
        values: overlapInput.portamentoSemitone.map((value, index) => (
          value + overlapInput.transientSemitone[index] + overlapInput.vibratoSemitone[index]
        )),
      },
      mask: Array(overlapInput.portamentoSemitone.length).fill(true),
      invariants: ["additive_overlap", "all_contributions_retained"],
      tolerance: { absolute: 1e-12 },
      seed: CORPUS_SEED + 34,
    },
    rejectedCase({
      id: "transition-time-resolution-too-coarse",
      family: "pitch_delta_transition",
      input: { spanFromBlick: 999, boundaryBlick: 1000, spanToBlick: 1200 },
      code: "TRANSITION_TIME_RESOLUTION_TOO_COARSE",
      invariants: ["rejects_merged_boundary_anchors"],
      seed: CORPUS_SEED + 35,
    }),
    timeSeriesCase({
      id: "vibrato-large-representable-phase",
      family: "time_varying_vibrato",
      input: {
        startSeconds: 0,
        endSeconds: Number.MAX_SAFE_INTEGER,
        rateStartHz: 9,
        rateEndHz: 9,
        depthStartSemitone: 0.2,
        depthEndSemitone: 0.2,
        phaseRad: 0,
        fadeInSeconds: 0.1,
        fadeOutSeconds: 0.1,
      },
      sampleSeconds: secondsGrid(0, Number.MAX_SAFE_INTEGER, 17),
      valueAt: (seconds) => timeVaryingVibrato(seconds, {
        startSeconds: 0,
        endSeconds: Number.MAX_SAFE_INTEGER,
        rateStartHz: 9,
        rateEndHz: 9,
        depthStartSemitone: 0.2,
        depthEndSemitone: 0.2,
        phaseRad: 0,
        fadeInSeconds: 0.1,
        fadeOutSeconds: 0.1,
      }),
      unit: "semitone",
      invariants: ["large_phase_is_finite", "span_endpoints_zero"],
      tolerance: { absolute: 1e-12 },
      seed: CORPUS_SEED + 36,
    }),
  ];
}

export function createSyntheticPitchTechniqueCorpus() {
  return {
    kind: "svcopilot-pitch-techniques-synthetic-corpus",
    schemaVersion: 1,
    truthSource: "docs/pitch-techniques/reference/model.mjs",
    seed: CORPUS_SEED,
    cases: [
      ...buildRichardsCases(),
      ...buildTransientCases(),
      ...buildVibratoCases(),
      ...buildAnalysisCases(),
    ],
  };
}

export function syntheticPitchTechniqueCorpusHash() {
  return contentHash(createSyntheticPitchTechniqueCorpus());
}

if (process.argv.includes("--write")) {
  writeFileSync(fileURLToPath(FIXTURE_URL), `${canonicalize(createSyntheticPitchTechniqueCorpus())}\n`, "utf8");
  process.stdout.write(`${syntheticPitchTechniqueCorpusHash()}\n`);
}
