import {
  compileFirstPeakTransient,
  normalizedRichardsTransition,
  timeVaryingVibrato,
} from "./model.mjs";

export const ANALYSIS_REFERENCE_VERSION = 1;
export const ANALYSIS_REFERENCE_TIMEBASE = Object.freeze({
  bpm: 120,
  quarterBlick: 705600000,
  sampleRateHz: 80,
});

const DURATION_SECONDS = 2;

export function secondsToBlick(seconds) {
  return Math.round(
    seconds * ANALYSIS_REFERENCE_TIMEBASE.quarterBlick * ANALYSIS_REFERENCE_TIMEBASE.bpm / 60
  );
}

export function createTechniqueAnalysisReferenceCases() {
  const transition = {
    fromSeconds: 0.75,
    toSeconds: 1.25,
    inflectionSeconds: 1.025,
    growthPerSecond: 14,
    asymmetryB: 1.7,
  };
  const transitionValues = framesFor((seconds) => {
    if (seconds <= transition.fromSeconds) return 60;
    if (seconds >= transition.toSeconds) return 62;
    return normalizedRichardsTransition(seconds - transition.fromSeconds, 60, 62, {
      spanSeconds: transition.toSeconds - transition.fromSeconds,
      inflectionSeconds: transition.inflectionSeconds - transition.fromSeconds,
      growthPerSecond: transition.growthPerSecond,
      asymmetryB: transition.asymmetryB,
    });
  });

  const vibrato = {
    startSeconds: 0.08,
    endSeconds: 1.92,
    rateStartHz: 5.5,
    rateEndHz: 5.5,
    depthStartSemitone: 0.3,
    depthEndSemitone: 0.3,
    phaseRad: 0.37,
    fadeInSeconds: 0.08,
    fadeOutSeconds: 0.08,
  };
  const vibratoValues = framesFor((seconds) => (
    60 + timeVaryingVibrato(seconds, vibrato)
  ));

  const transient = {
    peakSemitone: 0.35,
    peakTimeSeconds: 0.0625,
    dampingRatio: 0.5422,
    onsetSeconds: 1,
    spanSeconds: 0.5,
    tailPolicy: "continuous_taper",
    sampleIntervalSeconds: 1 / ANALYSIS_REFERENCE_TIMEBASE.sampleRateHz,
  };
  const transientModel = compileFirstPeakTransient(transient);
  const transientValues = framesFor((seconds) => (
    (seconds < 1 ? 60 : 60.1) + transientModel.valueAt(seconds)
  ));

  const mixedTransition = {
    fromSeconds: 0.55,
    toSeconds: 1.05,
    inflectionSeconds: 0.825,
    growthPerSecond: 14,
    asymmetryB: 1.7,
  };
  const mixedVibrato = {
    startSeconds: 0.85,
    endSeconds: 2.95,
    rateStartHz: 5.5,
    rateEndHz: 5.5,
    depthStartSemitone: 0.22,
    depthEndSemitone: 0.22,
    phaseRad: 0.2,
    fadeInSeconds: 0.05,
    fadeOutSeconds: 0.05,
  };
  const mixedValues = framesFor((seconds) => {
    const base = seconds <= mixedTransition.fromSeconds
      ? 60
      : seconds >= mixedTransition.toSeconds
        ? 62
        : normalizedRichardsTransition(seconds - mixedTransition.fromSeconds, 60, 62, {
          spanSeconds: mixedTransition.toSeconds - mixedTransition.fromSeconds,
          inflectionSeconds: mixedTransition.inflectionSeconds - mixedTransition.fromSeconds,
          growthPerSecond: mixedTransition.growthPerSecond,
          asymmetryB: mixedTransition.asymmetryB,
        });
    return base + timeVaryingVibrato(seconds, mixedVibrato);
  }, 3);

  return Object.freeze([
    freezeCase({
      id: "analysis-richards-transition-v1",
      notes: adjacentNotes(60, 62),
      values: transitionValues,
      expected: { kind: "transition", transition },
    }),
    freezeCase({
      id: "analysis-steady-vibrato-v1",
      notes: [{ indexInGroup: 0, onsetSeconds: 0, durationSeconds: DURATION_SECONDS, pitch: 60 }],
      values: vibratoValues,
      expected: { kind: "vibrato", vibrato },
    }),
    freezeCase({
      id: "analysis-first-peak-transient-v1",
      notes: adjacentNotes(60, 60, { detuneCents: 10 }),
      values: transientValues,
      expected: { kind: "transient", transient },
    }),
    freezeCase({
      id: "analysis-mixed-transition-vibrato-v1",
      notes: [
        { indexInGroup: 0, onsetSeconds: 0, durationSeconds: 0.8, pitch: 60 },
        { indexInGroup: 1, onsetSeconds: 0.8, durationSeconds: 2.2, pitch: 62 },
      ],
      values: mixedValues,
      expected: { kinds: ["transition", "vibrato"], transition: mixedTransition, vibrato: mixedVibrato },
    }),
  ]);
}

function adjacentNotes(firstPitch, secondPitch, secondOptions = {}) {
  return [
    { indexInGroup: 0, onsetSeconds: 0, durationSeconds: 1, pitch: firstPitch },
    { indexInGroup: 1, onsetSeconds: 1, durationSeconds: 1, pitch: secondPitch, ...secondOptions },
  ];
}

function framesFor(valueAt, durationSeconds = DURATION_SECONDS) {
  const frames = durationSeconds * ANALYSIS_REFERENCE_TIMEBASE.sampleRateHz + 1;
  return Array.from({ length: frames }, (_, index) => (
    valueAt(index / ANALYSIS_REFERENCE_TIMEBASE.sampleRateHz)
  ));
}

function freezeCase(current) {
  return Object.freeze({
    ...current,
    notes: Object.freeze(current.notes.map((note) => Object.freeze({ ...note }))),
    values: Object.freeze([...current.values]),
    expected: Object.freeze(structuredClone(current.expected)),
  });
}
