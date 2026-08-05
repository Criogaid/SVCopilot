import {
  avaInflectionSeconds,
  avaRichardsUnitAtInflection,
  normalizedRichardsSegment,
  normalizedRichardsTransition,
} from "./model.js";

export const RICHARDS_MODEL_FAMILY = Object.freeze({
  asymptotic: "richards_asymptotic",
  segment: "richards_segment_normalized",
});

function segmentParameters(
  fromSeconds,
  toSeconds,
  inflectionSeconds,
  steepnessPerSecond,
  asymmetryB,
) {
  return {
    spanSeconds: toSeconds - fromSeconds,
    inflectionSeconds: inflectionSeconds - fromSeconds,
    growthPerSecond: steepnessPerSecond,
    asymmetryB,
  };
}

export function richardsInflectionSeconds(
  asymmetryA,
  asymmetryB,
  steepnessPerSecond,
  midpointSeconds,
) {
  return avaInflectionSeconds({
    A: asymmetryA,
    B: asymmetryB,
    growthPerSecond: steepnessPerSecond,
    midpointSeconds,
  });
}

export function rawRichards(
  timeSeconds,
  inflectionSeconds,
  steepnessPerSecond,
  asymmetryB,
) {
  return avaRichardsUnitAtInflection(timeSeconds, {
    inflectionSeconds,
    growthPerSecond: steepnessPerSecond,
    asymmetryB,
  });
}

export function richardsSegment(
  timeSeconds,
  fromSeconds,
  toSeconds,
  inflectionSeconds,
  steepnessPerSecond,
  asymmetryB,
) {
  return normalizedRichardsSegment(
    timeSeconds - fromSeconds,
    segmentParameters(
      fromSeconds,
      toSeconds,
      inflectionSeconds,
      steepnessPerSecond,
      asymmetryB,
    ),
  );
}

export function richardsTransition(
  timeSeconds,
  fromSeconds,
  toSeconds,
  fromValue,
  toValue,
  inflectionSeconds,
  steepnessPerSecond,
  asymmetryB,
) {
  return normalizedRichardsTransition(
    timeSeconds - fromSeconds,
    fromValue,
    toValue,
    segmentParameters(
      fromSeconds,
      toSeconds,
      inflectionSeconds,
      steepnessPerSecond,
      asymmetryB,
    ),
  );
}
