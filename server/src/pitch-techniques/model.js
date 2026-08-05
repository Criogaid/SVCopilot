// 音高技法的集中闭式模型：Richards/二阶瞬态/时变颤音、canonical IR 量化与开环修正
// 的唯一定义处。它是运行时代码，被 planner、compiler 与分析器直接引用；
// docs/pitch-techniques/reference/model.mjs 只是再导出本文件，不持有第二份实现。
import { contentHash } from "../canonical-json.js";

export const TRANSIENT_TAPER_RATIO = 0.25;
export const PITCH_DELTA_LIMIT_CENT = 1200;
export const CANONICAL_PHASE_LIMIT_RAD = 6.283185307179;

const NUMERIC_FIELD_OWNERS = new Set([
  "compiler",
  "correction",
  "expression_gesture",
  "identity",
  "paper_model",
  "pitch_gesture",
  "sampling",
]);

const NUMERIC_FIELD_GROUPS = Object.freeze([
  {
    fields: [
      "anchorIndex", "from", "fromNote", "indexInGroup", "note", "noteIndex",
      "occurrence", "priority", "to", "toNote",
    ],
    unit: "index",
    quantum: 1,
    domain: "safe_integer",
    owners: ["identity", "compiler"],
  },
  {
    fields: ["schemaVersion"],
    unit: "version",
    quantum: 1,
    domain: "safe_integer",
    owners: ["compiler"],
  },
  {
    fields: [
      "durationBlick", "endBlick", "fromBlick", "intervalBlick", "onsetBlick",
      "startBlick", "timeOffsetBlick", "toBlick",
    ],
    unit: "blick",
    quantum: 1,
    domain: "safe_integer",
    owners: ["identity", "compiler"],
  },
  {
    fields: [
      "maxTotalPoints", "minimumRunFrames", "pointsPerQuarter", "vibratoPointsPerCycle",
    ],
    unit: "count",
    quantum: 1,
    domain: "safe_integer",
    owners: ["sampling", "correction", "pitch_gesture"],
  },
  {
    fields: [
      "durationSeconds", "endSeconds", "fadeInSeconds", "fadeOutSeconds", "fromSeconds",
      "inflectionSeconds", "midpointSeconds", "onsetSeconds",
      "peakTimeSeconds", "sampleIntervalSeconds", "seconds", "spanSeconds", "startSeconds",
      "toSeconds",
    ],
    unit: "second",
    quantum: 1e-9,
    domain: "finite",
    owners: ["paper_model", "pitch_gesture", "sampling"],
  },
  {
    fields: ["fadeOutQuarter", "lengthQuarter", "onsetDelayQuarter", "rampQuarter"],
    unit: "quarter_note",
    quantum: 1e-12,
    domain: "finite",
    owners: ["expression_gesture"],
  },
  {
    fields: [
      "depthCents", "maxAbsCents", "maxAbsCorrectionCent", "maxFitErrorCent", "pitchDelta",
    ],
    unit: "cent",
    quantum: 1e-6,
    domain: "finite",
    owners: ["pitch_gesture", "correction", "expression_gesture"],
  },
  {
    fields: [
      "anchorSemitone", "centerDriftSemitone", "depthSemitone", "endDepthSemitone",
      "lowerPitch", "maxAbsPeakSemitone", "maxTailSemitone", "peakSemitone", "upperPitch",
    ],
    unit: "semitone",
    quantum: 1e-6,
    domain: "finite",
    owners: ["paper_model", "pitch_gesture", "compiler"],
  },
  {
    fields: ["maxTailSlopeSemitonePerSecond"],
    unit: "semitone_per_second",
    quantum: 1e-6,
    domain: "finite",
    owners: ["paper_model", "compiler"],
  },
  {
    fields: [
      "endRateHz", "rateEndHz", "rateHz", "rateStartHz",
    ],
    unit: "hertz",
    quantum: 1e-9,
    domain: "finite",
    owners: ["pitch_gesture"],
  },
  {
    fields: ["naturalAngularFrequencyRadPerSecond"],
    unit: "radian_per_second",
    quantum: 1e-9,
    domain: "finite",
    owners: ["paper_model"],
  },
  {
    fields: ["growthPerSecond"],
    unit: "per_second",
    quantum: 1e-9,
    domain: "finite",
    owners: ["paper_model"],
  },
  {
    fields: ["numeratorRatePerSecond"],
    unit: "response_unit_per_second",
    quantum: 1e-9,
    domain: "finite",
    owners: ["paper_model"],
  },
  {
    fields: ["phaseRad"],
    unit: "radian",
    quantum: 1e-12,
    domain: "finite",
    owners: ["paper_model", "pitch_gesture"],
  },
  {
    fields: [
      "A", "B", "asymmetryB", "asymmetryLogB", "dampingRatio", "endRatio",
      "envelopeScale", "inflectionRatio", "level", "minimumCoverage", "peakPosition",
      "ratio", "scale", "shapePower", "sharpness", "startRatio",
      "taperRatio",
    ],
    unit: "unitless",
    quantum: 1e-12,
    domain: "finite",
    owners: ["paper_model", "pitch_gesture", "correction", "expression_gesture"],
  },
  {
    fields: ["amount", "loudness"],
    unit: "parameter_value",
    quantum: 1e-6,
    domain: "finite",
    owners: ["expression_gesture"],
  },
  {
    fields: ["breathiness", "gender", "tension", "voicing"],
    unit: "parameter_value",
    quantum: 1e-12,
    domain: "finite",
    owners: ["expression_gesture"],
  },
  {
    fields: ["magnitudeMu", "smoothnessLambda"],
    unit: "regularization_weight",
    quantum: 1e-12,
    domain: "finite",
    owners: ["correction"],
  },
]);

function buildTechniqueIrNumericFieldSchema(groups) {
  const schema = Object.create(null);
  for (const group of groups) {
    if (!Array.isArray(group.fields) || group.fields.length === 0) {
      throw new RangeError("numeric field group must declare at least one field");
    }
    if (typeof group.unit !== "string" || group.unit.length === 0) {
      throw new RangeError("numeric field group must declare a unit");
    }
    if (!Number.isFinite(group.quantum) || group.quantum <= 0) {
      throw new RangeError("numeric field quantum must be finite and positive");
    }
    if (!["finite", "safe_integer"].includes(group.domain)) {
      throw new RangeError(`unsupported numeric field domain: ${group.domain}`);
    }
    if (!Array.isArray(group.owners) || group.owners.length === 0) {
      throw new RangeError("numeric field group must declare at least one owner");
    }
    for (const owner of group.owners) {
      if (!NUMERIC_FIELD_OWNERS.has(owner)) {
        throw new RangeError(`unknown numeric field owner: ${owner}`);
      }
    }
    for (const field of group.fields) {
      if (typeof field !== "string" || field.length === 0) {
        throw new RangeError("numeric semantic field name must be a non-empty string");
      }
      if (Object.hasOwn(schema, field)) {
        throw new RangeError(`numeric semantic field is registered twice: ${field}`);
      }
      schema[field] = Object.freeze({
        unit: group.unit,
        quantum: group.quantum,
        domain: group.domain,
        owners: Object.freeze([...group.owners]),
      });
    }
  }
  return Object.freeze(schema);
}

export const TECHNIQUE_IR_NUMERIC_FIELD_SCHEMA = buildTechniqueIrNumericFieldSchema(
  NUMERIC_FIELD_GROUPS,
);

export const SEMANTIC_NUMERIC_QUANTA = Object.freeze(Object.fromEntries(
  Object.entries(TECHNIQUE_IR_NUMERIC_FIELD_SCHEMA)
    .map(([field, rule]) => [field, rule.quantum]),
));

function requireFinite(name, value) {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
  return value;
}

function requirePositive(name, value) {
  requireFinite(name, value);
  if (value <= 0) throw new RangeError(`${name} must be > 0`);
  return value;
}

function codedRangeError(code, message, details) {
  const error = new RangeError(message);
  error.code = code;
  error.details = details;
  return error;
}

function finiteLerp(start, end, ratio, name) {
  if (ratio <= 0) return start;
  if (ratio >= 1) return end;
  // 凸组合避免先计算 end-start，端点异号且接近 MAX_VALUE 时不会溢出。
  const value = (1 - ratio) * start + ratio * end;
  if (Number.isFinite(value)) return value;
  const error = new RangeError(`${name} exceeds the finite numeric domain`);
  error.code = "INTERPOLATION_OVERFLOW";
  throw error;
}

function logAddExpZero(value) {
  return Math.max(0, value) + Math.log1p(Math.exp(-Math.abs(value)));
}

export function avaGeneralizedLogistic(timeSeconds, parameters) {
  const {
    lowerPitch,
    upperPitch,
    A,
    B,
    growthPerSecond,
    midpointSeconds,
  } = parameters;
  requireFinite("timeSeconds", timeSeconds);
  requireFinite("lowerPitch", lowerPitch);
  requireFinite("upperPitch", upperPitch);
  requirePositive("A", A);
  requirePositive("B", B);
  requirePositive("growthPerSecond", growthPerSecond);
  requireFinite("midpointSeconds", midpointSeconds);

  const logInnerTerm = Math.log(A) - growthPerSecond * (timeSeconds - midpointSeconds);
  const unit = Math.exp(-logAddExpZero(logInnerTerm) / B);
  return finiteLerp(lowerPitch, upperPitch, unit, "AVA pitch interpolation");
}

export function avaInflectionSeconds(parameters) {
  const { A, B, growthPerSecond, midpointSeconds } = parameters;
  requirePositive("A", A);
  requirePositive("B", B);
  requirePositive("growthPerSecond", growthPerSecond);
  requireFinite("midpointSeconds", midpointSeconds);
  const inflectionSeconds = midpointSeconds
    - (Math.log(B) - Math.log(A)) / growthPerSecond;
  if (Number.isFinite(inflectionSeconds)) return inflectionSeconds;
  const error = new RangeError("AVA inflection exceeds the finite numeric domain");
  error.code = "RICHARDS_INFLECTION_OVERFLOW";
  throw error;
}

export function avaRichardsUnitAtInflection(timeSeconds, parameters) {
  const { inflectionSeconds, growthPerSecond, asymmetryB } = parameters;
  requireFinite("timeSeconds", timeSeconds);
  requireFinite("inflectionSeconds", inflectionSeconds);
  requirePositive("growthPerSecond", growthPerSecond);
  requirePositive("asymmetryB", asymmetryB);

  const logInnerTerm = Math.log(asymmetryB)
    - growthPerSecond * (timeSeconds - inflectionSeconds);
  return Math.exp(-logAddExpZero(logInnerTerm) / asymmetryB);
}

export function normalizedRichardsSegment(timeSeconds, parameters) {
  const { spanSeconds } = parameters;
  requireFinite("timeSeconds", timeSeconds);
  requirePositive("spanSeconds", spanSeconds);
  if (timeSeconds < 0 || timeSeconds > spanSeconds) {
    throw new RangeError("timeSeconds must be inside the finite segment");
  }

  const q0 = avaRichardsUnitAtInflection(0, parameters);
  const q1 = avaRichardsUnitAtInflection(spanSeconds, parameters);
  const denominator = q1 - q0;
  if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-15) {
    const error = new RangeError("normalized Richards segment is numerically degenerate");
    error.code = "RICHARDS_DEGENERATE_SEGMENT";
    throw error;
  }
  const qt = avaRichardsUnitAtInflection(timeSeconds, parameters);
  return (qt - q0) / denominator;
}

export function normalizedRichardsTransition(timeSeconds, fromPitch, toPitch, parameters) {
  requireFinite("fromPitch", fromPitch);
  requireFinite("toPitch", toPitch);
  const unit = normalizedRichardsSegment(timeSeconds, parameters);
  return finiteLerp(
    fromPitch,
    toPitch,
    unit,
    "normalized Richards pitch interpolation",
  );
}

function validateTransitionNote(note, label) {
  if (!note || typeof note !== "object") throw new TypeError(`${label} must be an object`);
  if (!Number.isSafeInteger(note.indexInGroup) || note.indexInGroup < 0) {
    throw new TypeError(`${label}.indexInGroup must be a non-negative safe integer`);
  }
  if (!Number.isSafeInteger(note.onsetBlick) || note.onsetBlick < 0) {
    throw new TypeError(`${label}.onsetBlick must be a non-negative safe integer`);
  }
  if (!Number.isSafeInteger(note.durationBlick) || note.durationBlick <= 0) {
    throw new TypeError(`${label}.durationBlick must be a positive safe integer`);
  }
  requireFinite(`${label}.onsetSeconds`, note.onsetSeconds);
  requireFinite(`${label}.endSeconds`, note.endSeconds);
  requireFinite(`${label}.pitchSemitone`, note.pitchSemitone);
  if (note.endSeconds <= note.onsetSeconds) {
    throw new RangeError(`${label}.endSeconds must be after onsetSeconds`);
  }
}

function transitionUnitAt(localSeconds, widthSeconds, curve) {
  if (curve.family === "linear") return localSeconds / widthSeconds;
  if (curve.family !== "richards") {
    throw codedRangeError(
      "INVALID_ARGUMENTS",
      `unsupported transition curve family: ${String(curve.family)}`,
      { parameter: "curve.family", value: curve.family },
    );
  }
  const inflectionRatio = curve.inflectionRatio ?? 0.5;
  const sharpness = curve.sharpness ?? 6;
  const asymmetryLogB = curve.asymmetryLogB ?? 0;
  requireFinite("curve.inflectionRatio", inflectionRatio);
  requireFinite("curve.sharpness", sharpness);
  requireFinite("curve.asymmetryLogB", asymmetryLogB);
  if (inflectionRatio < 0.05 || inflectionRatio > 0.95) {
    throw new RangeError("curve.inflectionRatio must be in [0.05, 0.95]");
  }
  if (sharpness < 1 || sharpness > 40) {
    throw new RangeError("curve.sharpness must be in [1, 40]");
  }
  if (asymmetryLogB < -3 || asymmetryLogB > 3) {
    throw new RangeError("curve.asymmetryLogB must be in [-3, 3]");
  }
  return normalizedRichardsSegment(localSeconds, {
    spanSeconds: widthSeconds,
    inflectionSeconds: inflectionRatio * widthSeconds,
    growthPerSecond: sharpness / widthSeconds,
    asymmetryB: Math.exp(asymmetryLogB),
  });
}

export function compilePitchDeltaTransition(input) {
  const {
    fromNote,
    toNote,
    widthSeconds,
    curve,
    maxAbsPitchDeltaCent = PITCH_DELTA_LIMIT_CENT,
  } = input;
  validateTransitionNote(fromNote, "fromNote");
  validateTransitionNote(toNote, "toNote");
  requirePositive("widthSeconds", widthSeconds);
  requirePositive("maxAbsPitchDeltaCent", maxAbsPitchDeltaCent);
  if (!curve || typeof curve !== "object") throw new TypeError("curve must be an object");

  const fromEndBlick = fromNote.onsetBlick + fromNote.durationBlick;
  if (!Number.isSafeInteger(fromEndBlick)) {
    const error = new RangeError("derived fromNote end BLICK exceeds the safe-integer domain");
    error.code = "INVALID_INTEGER_SEMANTIC_FIELD";
    error.details = {
      field: "endBlick",
      path: "$/fromNote/endBlick",
      value: fromEndBlick,
    };
    throw error;
  }
  if (
    toNote.indexInGroup !== fromNote.indexInGroup + 1
    || toNote.onsetBlick !== fromEndBlick
  ) {
    throw codedRangeError(
      "TRANSITION_NOT_ADJACENT",
      "transition requires consecutive notes with no BLICK gap or overlap",
      {
        fromNote: fromNote.indexInGroup,
        toNote: toNote.indexInGroup,
        fromEndBlick,
        toOnsetBlick: toNote.onsetBlick,
      },
    );
  }
  const boundarySkewSeconds = Math.abs(fromNote.endSeconds - toNote.onsetSeconds);
  if (boundarySkewSeconds > 1e-9) {
    throw codedRangeError(
      "TRANSITION_TIME_MAPPING_INCONSISTENT",
      "adjacent notes map their shared BLICK boundary to different seconds",
      {
        fromEndSeconds: fromNote.endSeconds,
        toOnsetSeconds: toNote.onsetSeconds,
        boundarySkewSeconds,
        toleranceSeconds: 1e-9,
      },
    );
  }
  if (fromNote.pitchSemitone === toNote.pitchSemitone) {
    throw codedRangeError(
      "TRANSITION_EQUAL_PITCH",
      "transition between equal score pitches has no effect",
      { pitchSemitone: fromNote.pitchSemitone },
    );
  }

  const boundarySeconds = toNote.onsetSeconds;
  const halfWidthSeconds = widthSeconds / 2;
  const fromSeconds = boundarySeconds - halfWidthSeconds;
  const toSeconds = boundarySeconds + halfWidthSeconds;
  const availableBeforeSeconds = boundarySeconds - fromNote.onsetSeconds;
  const availableAfterSeconds = toNote.endSeconds - boundarySeconds;
  if (
    fromSeconds < fromNote.onsetSeconds
    || toSeconds > toNote.endSeconds
  ) {
    throw codedRangeError(
      "TRANSITION_WIDTH_EXCEEDS_ADJACENT_NOTES",
      "transition width must fit symmetrically inside both adjacent notes",
      {
        requestedWidthSeconds: widthSeconds,
        requiredPerSideSeconds: halfWidthSeconds,
        availableBeforeSeconds,
        availableAfterSeconds,
      },
    );
  }

  const desiredPitchAt = (timeSeconds) => {
    requireFinite("timeSeconds", timeSeconds);
    const endpointTolerance = Math.max(1e-15, widthSeconds * Number.EPSILON * 8);
    if (
      timeSeconds < fromSeconds - endpointTolerance
      || timeSeconds > toSeconds + endpointTolerance
    ) {
      throw new RangeError("timeSeconds must be inside the transition span");
    }
    const boundedTimeSeconds = Math.max(fromSeconds, Math.min(toSeconds, timeSeconds));
    const localSeconds = Math.max(
      0,
      Math.min(widthSeconds, boundedTimeSeconds - fromSeconds),
    );
    const unit = transitionUnitAt(localSeconds, widthSeconds, curve);
    return finiteLerp(
      fromNote.pitchSemitone,
      toNote.pitchSemitone,
      unit,
      "transition desired pitch",
    );
  };
  const boundaryPitchSemitone = desiredPitchAt(boundarySeconds);
  const beforeBoundaryContributionCent = 100
    * (boundaryPitchSemitone - fromNote.pitchSemitone);
  const atBoundaryContributionCent = 100
    * (boundaryPitchSemitone - toNote.pitchSemitone);
  const requiredAbsPitchDeltaCent = Math.max(
    Math.abs(beforeBoundaryContributionCent),
    Math.abs(atBoundaryContributionCent),
  );
  if (requiredAbsPitchDeltaCent > maxAbsPitchDeltaCent) {
    throw codedRangeError(
      "TRANSITION_EXCEEDS_PITCH_DELTA_RANGE",
      "transition cannot preserve pitch continuity within the pitchDelta range",
      {
        intervalSemitone: toNote.pitchSemitone - fromNote.pitchSemitone,
        requiredAbsPitchDeltaCent,
        maxAbsPitchDeltaCent,
      },
    );
  }

  return {
    fromSeconds,
    boundarySeconds,
    toSeconds,
    widthSeconds,
    scoreStepSemitone: toNote.pitchSemitone - fromNote.pitchSemitone,
    beforeBoundaryContributionCent,
    atBoundaryContributionCent,
    requiredAbsPitchDeltaCent,
    mandatoryAnchors: [
      { timeSeconds: fromSeconds, boundarySide: "at" },
      { timeSeconds: boundarySeconds, boundarySide: "before" },
      { timeSeconds: boundarySeconds, boundarySide: "at" },
      { timeSeconds: toSeconds, boundarySide: "at" },
    ],
    desiredPitchAt,
    contributionCentAt(timeSeconds, boundarySide = "auto") {
      const desiredPitchSemitone = desiredPitchAt(timeSeconds);
      const useFromScore = timeSeconds < boundarySeconds
        || (timeSeconds === boundarySeconds && boundarySide === "before");
      const scorePitchSemitone = useFromScore
        ? fromNote.pitchSemitone
        : toNote.pitchSemitone;
      return 100 * (desiredPitchSemitone - scorePitchSemitone);
    },
  };
}

export function projectTransitionMandatoryBlickAnchors(input) {
  const { spanFromBlick, boundaryBlick, spanToBlick } = input;
  for (const [field, value] of Object.entries({ spanFromBlick, boundaryBlick, spanToBlick })) {
    if (!Number.isSafeInteger(value)) {
      const error = new TypeError(`${field} must be a safe integer`);
      error.code = "INVALID_INTEGER_SEMANTIC_FIELD";
      error.details = { field, path: `$/` + field, value };
      throw error;
    }
  }
  if (
    spanFromBlick > boundaryBlick - 2
    || spanToBlick < boundaryBlick + 1
  ) {
    throw codedRangeError(
      "TRANSITION_TIME_RESOLUTION_TOO_COARSE",
      "transition needs distinct start, boundary-before, boundary, and end BLICK anchors",
      { spanFromBlick, boundaryBlick, spanToBlick },
    );
  }
  return [
    { role: "start", blick: spanFromBlick },
    { role: "boundary_before", blick: boundaryBlick - 1 },
    { role: "boundary_at", blick: boundaryBlick },
    { role: "end", blick: spanToBlick },
  ];
}

function validateSecondOrder(parameters) {
  const {
    naturalAngularFrequencyRadPerSecond,
    dampingRatio,
    numeratorRatePerSecond,
    onsetSeconds = 0,
  } = parameters;
  requirePositive(
    "naturalAngularFrequencyRadPerSecond",
    naturalAngularFrequencyRadPerSecond,
  );
  requireFinite("dampingRatio", dampingRatio);
  if (dampingRatio < 0) throw new RangeError("dampingRatio must be >= 0");
  requireFinite("numeratorRatePerSecond", numeratorRatePerSecond);
  requireFinite("onsetSeconds", onsetSeconds);
}

function sinc(value) {
  const squared = value * value;
  if (Math.abs(value) < 1e-4) return 1 - squared / 6 + squared * squared / 120;
  return Math.sin(value) / value;
}

function overdampedRoot(dampingRatio) {
  if (dampingRatio < 2) {
    return Math.sqrt((dampingRatio - 1) * (dampingRatio + 1));
  }
  const inverse = 1 / dampingRatio;
  return dampingRatio * Math.sqrt((1 - inverse) * (1 + inverse));
}

const LOG_MAX_VALUE = Math.log(Number.MAX_VALUE);
const LOG_MIN_VALUE = Math.log(Number.MIN_VALUE);

function positiveValueFromLog(logValue) {
  if (logValue > LOG_MAX_VALUE) return Infinity;
  if (logValue < LOG_MIN_VALUE) return 0;
  return Math.exp(logValue);
}

function signedValueFromLog(signSource, logMagnitude) {
  if (signSource === 0 || logMagnitude < LOG_MIN_VALUE) return 0;
  if (logMagnitude > LOG_MAX_VALUE) {
    return Math.sign(signSource) * Infinity;
  }
  return Math.sign(signSource) * Math.exp(logMagnitude);
}

function signedProductWithDecay(values, decayMagnitude) {
  if (decayMagnitude === Infinity || values.some((value) => value === 0)) return 0;
  let direct = 1;
  let sign = 1;
  let logMagnitude = -decayMagnitude;
  for (const value of values) {
    direct *= value;
    sign *= Math.sign(value);
    logMagnitude += Math.log(Math.abs(value));
  }
  const directWithDecay = direct * Math.exp(-decayMagnitude);
  if (Number.isFinite(directWithDecay) && directWithDecay !== 0) {
    return directWithDecay;
  }
  return signedValueFromLog(sign, logMagnitude);
}

function representableOscillatoryPhase(logPhase) {
  const phase = positiveValueFromLog(logPhase);
  if (phase !== Infinity) return phase;
  const error = new RangeError("oscillatory phase exceeds the finite numeric domain");
  error.code = "OSCILLATORY_PHASE_OVERFLOW";
  throw error;
}

function overdampedScaleProducts(omega, dampingRatio, root, localSeconds) {
  // ζ-r = 1/(ζ+r)，该写法不会在有限大 ζ 下先把 ζ+r 加成 Infinity。
  const inverseRateSum = (1 / dampingRatio) / (1 + root / dampingRatio);
  const logTime = Math.log(localSeconds);
  const slowLog = Math.log(omega) + Math.log(inverseRateSum) + logTime;
  const gapLog = Math.log(2) + Math.log(omega) + Math.log(root) + logTime;
  return {
    inverseRateSum,
    slow: positiveValueFromLog(slowLog),
    gap: positiveValueFromLog(gapLog),
    gapLog,
  };
}

function overdampedImpulseValue(numerator, localSeconds, factors) {
  if (numerator === 0 || factors.slow === Infinity) return 0;
  const decay = Math.exp(-factors.slow);
  const shape = factors.gap === 0
    ? 1
    : -Math.expm1(-factors.gap) / factors.gap;
  const direct = numerator * localSeconds * decay * shape;
  if (Number.isFinite(direct) && direct !== 0) return direct;

  let logShape;
  if (factors.gap === 0) {
    logShape = 0;
  } else if (factors.gap === Infinity) {
    logShape = -factors.gapLog;
  } else {
    logShape = Math.log(-Math.expm1(-factors.gap)) - factors.gapLog;
  }
  return signedValueFromLog(
    numerator,
    Math.log(Math.abs(numerator)) + Math.log(localSeconds) - factors.slow + logShape,
  );
}

export function secondOrderImpulse(timeSeconds, parameters) {
  validateSecondOrder(parameters);
  requireFinite("timeSeconds", timeSeconds);
  const localSeconds = timeSeconds - (parameters.onsetSeconds ?? 0);
  requireFinite("localSeconds", localSeconds);
  if (localSeconds < 0) return 0;
  if (localSeconds === 0) return 0;

  const omega = parameters.naturalAngularFrequencyRadPerSecond;
  const zeta = parameters.dampingRatio;
  const numerator = parameters.numeratorRatePerSecond;
  if (numerator === 0) return 0;
  const logScaledTime = Math.log(omega) + Math.log(localSeconds);

  if (zeta === 1) {
    const scaledTime = positiveValueFromLog(logScaledTime);
    return signedProductWithDecay([numerator, localSeconds], scaledTime);
  }
  if (zeta < 1) {
    const root = Math.sqrt((1 - zeta) * (1 + zeta));
    if (zeta === 0) {
      const phase = representableOscillatoryPhase(logScaledTime + Math.log(root));
      const sine = Math.sin(phase);
      if (sine === 0) return 0;
      const direct = numerator / omega * sine;
      if (Number.isFinite(direct) && direct !== 0) return direct;
      return signedValueFromLog(
        numerator * sine,
        Math.log(Math.abs(numerator)) - Math.log(omega) + Math.log(Math.abs(sine)),
      );
    }
    const damping = positiveValueFromLog(logScaledTime + Math.log(zeta));
    if (damping === Infinity) return 0;
    const phase = representableOscillatoryPhase(logScaledTime + Math.log(root));
    // sinc 形式在 ζ→1 时避免 sin(x)/x 的消去误差。
    return signedProductWithDecay(
      [numerator, localSeconds, sinc(phase)],
      damping,
    );
  }

  const root = overdampedRoot(zeta);
  const factors = overdampedScaleProducts(omega, zeta, root, localSeconds);
  // 与论文双指数闭式代数等价；expm1 形式同时稳定 ζ→1 与极大 ζ。
  return overdampedImpulseValue(numerator, localSeconds, factors);
}

export function secondOrderImpulseDerivative(timeSeconds, parameters) {
  validateSecondOrder(parameters);
  requireFinite("timeSeconds", timeSeconds);
  const localSeconds = timeSeconds - (parameters.onsetSeconds ?? 0);
  requireFinite("localSeconds", localSeconds);
  if (localSeconds < 0) return 0;

  const omega = parameters.naturalAngularFrequencyRadPerSecond;
  const zeta = parameters.dampingRatio;
  const numerator = parameters.numeratorRatePerSecond;
  if (localSeconds === 0) return numerator;
  if (numerator === 0) return 0;
  const logScaledTime = Math.log(omega) + Math.log(localSeconds);

  if (zeta === 1) {
    const scaledTime = positiveValueFromLog(logScaledTime);
    if (scaledTime === Infinity) return 0;
    return signedProductWithDecay([numerator, 1 - scaledTime], scaledTime);
  }
  if (zeta < 1) {
    const root = Math.sqrt((1 - zeta) * (1 + zeta));
    if (zeta === 0) {
      const phase = representableOscillatoryPhase(logScaledTime + Math.log(root));
      return numerator * Math.cos(phase);
    }
    const damping = positiveValueFromLog(logScaledTime + Math.log(zeta));
    if (damping === Infinity) return 0;
    const phase = representableOscillatoryPhase(logScaledTime + Math.log(root));
    const derivativeShape = Math.cos(phase) - damping * sinc(phase);
    return signedProductWithDecay([numerator, derivativeShape], damping);
  }

  const root = overdampedRoot(zeta);
  const factors = overdampedScaleProducts(omega, zeta, root, localSeconds);
  if (factors.slow === Infinity) return 0;
  const oneMinusFastDecay = -Math.expm1(-factors.gap);
  const derivativeShape = factors.gap <= 1
    ? 1 + 0.5 * (zeta / root + 1) * Math.expm1(-factors.gap)
    : Math.exp(-factors.gap)
      - factors.inverseRateSum / (2 * root) * oneMinusFastDecay;
  return signedProductWithDecay([numerator, derivativeShape], factors.slow);
}

export function firstPeakAngularFactor(dampingRatio) {
  requireFinite("dampingRatio", dampingRatio);
  if (dampingRatio < 0) throw new RangeError("dampingRatio must be >= 0");
  if (dampingRatio === 1) return 1;
  if (dampingRatio < 1) {
    const root = Math.sqrt((1 - dampingRatio) * (1 + dampingRatio));
    return Math.atan2(root, dampingRatio) / root;
  }
  const root = overdampedRoot(dampingRatio);
  return Math.acosh(dampingRatio) / root;
}

function cubicSmoothstepToZero(localRatio) {
  const s = localRatio;
  if (s <= 0) return 1;
  if (s >= 1) return 0;
  return 1 - 3 * s ** 2 + 2 * s ** 3;
}

export function compileFirstPeakTransient(parameters) {
  const {
    peakSemitone,
    peakTimeSeconds,
    dampingRatio,
    onsetSeconds = 0,
    spanSeconds,
    tailPolicy = "reject",
    maxFitErrorCent = 1,
    sampleIntervalSeconds = 0.01,
  } = parameters;
  requireFinite("peakSemitone", peakSemitone);
  requirePositive("peakTimeSeconds", peakTimeSeconds);
  requireFinite("dampingRatio", dampingRatio);
  requireFinite("onsetSeconds", onsetSeconds);
  if (dampingRatio < 0) throw new RangeError("dampingRatio must be >= 0");
  if (dampingRatio > 1) {
    const error = new RangeError(
      "dampingRatio is outside the v1 public transient range [0, 1]",
    );
    error.code = "DAMPING_RATIO_OUT_OF_V1_RANGE";
    error.details = { dampingRatio, minimum: 0, maximum: 1 };
    throw error;
  }
  requirePositive("spanSeconds", spanSeconds);
  requirePositive("maxFitErrorCent", maxFitErrorCent);
  requirePositive("sampleIntervalSeconds", sampleIntervalSeconds);
  if (peakTimeSeconds >= spanSeconds) {
    throw new RangeError("peakTimeSeconds must be before spanSeconds");
  }
  if (tailPolicy !== "reject" && tailPolicy !== "continuous_taper") {
    throw new RangeError("unknown tailPolicy");
  }
  if (dampingRatio === 0 && tailPolicy === "reject") {
    const error = new RangeError("undamped transients require continuous_taper");
    error.code = "UNDAMPED_TAIL_REQUIRES_TAPER";
    error.details = { dampingRatio, tailPolicy };
    throw error;
  }
  if (
    tailPolicy === "continuous_taper"
    && peakTimeSeconds > spanSeconds * (1 - TRANSIENT_TAPER_RATIO)
  ) {
    const error = new RangeError("continuous taper would alter the requested first peak");
    error.code = "TAPER_OVERLAPS_PEAK";
    error.details = {
      peakTimeSeconds,
      taperStartSeconds: spanSeconds * (1 - TRANSIENT_TAPER_RATIO),
      spanSeconds,
      taperRatio: TRANSIENT_TAPER_RATIO,
    };
    throw error;
  }

  const omega = firstPeakAngularFactor(dampingRatio) / peakTimeSeconds;
  const unitParameters = {
    naturalAngularFrequencyRadPerSecond: omega,
    dampingRatio,
    numeratorRatePerSecond: 1,
  };
  const unitPeak = secondOrderImpulse(peakTimeSeconds, unitParameters);
  const modelParameters = {
    ...unitParameters,
    numeratorRatePerSecond: peakSemitone / unitPeak,
  };

  const rawAtSpan = secondOrderImpulse(spanSeconds, modelParameters);
  const rawSlopeAtSpan = secondOrderImpulseDerivative(spanSeconds, modelParameters);
  const maxTailSemitone = maxFitErrorCent / 100;
  const maxTailSlopeSemitonePerSecond = maxTailSemitone / sampleIntervalSeconds;
  if (
    tailPolicy === "reject"
    && (
      Math.abs(rawAtSpan) > maxTailSemitone
      || Math.abs(rawSlopeAtSpan) > maxTailSlopeSemitonePerSecond
    )
  ) {
    const error = new RangeError("second-order tail has not settled inside spanSeconds");
    error.code = "TAIL_NOT_SETTLED";
    error.details = {
      spanSeconds,
      observedTailSemitone: rawAtSpan,
      observedTailSlopeSemitonePerSecond: rawSlopeAtSpan,
      maxTailSemitone,
      maxTailSlopeSemitonePerSecond,
    };
    throw error;
  }

  const taperDuration = spanSeconds * TRANSIENT_TAPER_RATIO;
  const taperStart = spanSeconds - taperDuration;

  function valueAt(timeSeconds) {
    requireFinite("timeSeconds", timeSeconds);
    const localSeconds = timeSeconds - onsetSeconds;
    if (localSeconds < 0 || localSeconds > spanSeconds) return 0;
    if (tailPolicy === "continuous_taper" && localSeconds === spanSeconds) return 0;
    if (tailPolicy !== "continuous_taper" || localSeconds < taperStart) {
      return secondOrderImpulse(localSeconds, modelParameters);
    }
    const localRatio = (localSeconds - taperStart) / taperDuration;
    // 乘法窗位于 [0,1]，不会制造比原响应更大的新峰。
    return secondOrderImpulse(localSeconds, modelParameters)
      * cubicSmoothstepToZero(localRatio);
  }

  return {
    modelParameters,
    onsetSeconds,
    peakTimeSeconds,
    spanSeconds,
    tailPolicy,
    tailLimits: {
      maxTailSemitone,
      maxTailSlopeSemitonePerSecond,
      maxFitErrorCent,
      sampleIntervalSeconds,
    },
    taper: tailPolicy === "continuous_taper"
      ? {
          family: "multiplicative_cubic_smoothstep_c1",
          ratio: TRANSIENT_TAPER_RATIO,
          startSeconds: onsetSeconds + taperStart,
        }
      : null,
    valueAt,
  };
}

function raisedCosineRamp(unit) {
  if (unit <= 0) return 0;
  if (unit >= 1) return 1;
  return 0.5 - 0.5 * Math.cos(Math.PI * unit);
}

export function integratedLinearFrequencyPhase(localSeconds, parameters) {
  const { durationSeconds, rateStartHz, rateEndHz, phaseRad = 0 } = parameters;
  requirePositive("durationSeconds", durationSeconds);
  requirePositive("rateStartHz", rateStartHz);
  requirePositive("rateEndHz", rateEndHz);
  requireFinite("phaseRad", phaseRad);
  requireFinite("localSeconds", localSeconds);
  const clamped = Math.min(durationSeconds, Math.max(0, localSeconds));
  const elapsedRatio = clamped / durationSeconds;
  const averageRateHz = finiteLerp(
    rateStartHz,
    rateEndHz,
    elapsedRatio / 2,
    "integrated vibrato rate",
  );
  const cycles = averageRateHz * clamped;
  const phase = phaseRad + 2 * Math.PI * cycles;
  if (Number.isFinite(phase)) return phase;
  const error = new RangeError("oscillatory phase exceeds the finite numeric domain");
  error.code = "OSCILLATORY_PHASE_OVERFLOW";
  throw error;
}

function normalizedFadeDurations(durationSeconds, fadeInSeconds, fadeOutSeconds) {
  if (fadeInSeconds <= durationSeconds - fadeOutSeconds) {
    return { fadeInSeconds, fadeOutSeconds };
  }

  // 用较小值/较大值的比率分配总时长，避免 fadeIn+fadeOut 先溢出。
  const fadeInIsSmaller = fadeInSeconds <= fadeOutSeconds;
  const smaller = fadeInIsSmaller ? fadeInSeconds : fadeOutSeconds;
  const larger = fadeInIsSmaller ? fadeOutSeconds : fadeInSeconds;
  const ratio = smaller / larger;
  const smallerDuration = durationSeconds * (ratio / (1 + ratio));
  const largerDuration = durationSeconds / (1 + ratio);
  if (!(smallerDuration > 0) || !(largerDuration > 0)) {
    const error = new RangeError("normalized vibrato fade is below numeric resolution");
    error.code = "VIBRATO_FADE_RESOLUTION_OVERFLOW";
    throw error;
  }
  return fadeInIsSmaller
    ? { fadeInSeconds: smallerDuration, fadeOutSeconds: largerDuration }
    : { fadeInSeconds: largerDuration, fadeOutSeconds: smallerDuration };
}

export function timeVaryingVibrato(timeSeconds, parameters) {
  const {
    startSeconds,
    endSeconds,
    rateStartHz,
    rateEndHz,
    depthStartSemitone,
    depthEndSemitone,
    centerStartSemitone = 0,
    centerEndSemitone = 0,
    phaseRad = 0,
    fadeInSeconds = 0.3,
    fadeOutSeconds = 0.2,
  } = parameters;
  requireFinite("timeSeconds", timeSeconds);
  requireFinite("startSeconds", startSeconds);
  requireFinite("endSeconds", endSeconds);
  if (endSeconds <= startSeconds) throw new RangeError("endSeconds must be after startSeconds");
  requirePositive("rateStartHz", rateStartHz);
  requirePositive("rateEndHz", rateEndHz);
  requireFinite("depthStartSemitone", depthStartSemitone);
  requireFinite("depthEndSemitone", depthEndSemitone);
  requireFinite("centerStartSemitone", centerStartSemitone);
  requireFinite("centerEndSemitone", centerEndSemitone);
  requirePositive("fadeInSeconds", fadeInSeconds);
  requirePositive("fadeOutSeconds", fadeOutSeconds);
  if (timeSeconds < startSeconds || timeSeconds > endSeconds) return 0;

  const durationSeconds = endSeconds - startSeconds;
  if (!Number.isFinite(durationSeconds)) {
    const error = new RangeError("vibrato span exceeds the finite numeric domain");
    error.code = "VIBRATO_SPAN_OVERFLOW";
    throw error;
  }
  const localSeconds = timeSeconds - startSeconds;
  const ratio = localSeconds / durationSeconds;
  if (localSeconds === 0 || localSeconds === durationSeconds) return 0;
  const normalizedFades = normalizedFadeDurations(
    durationSeconds,
    fadeInSeconds,
    fadeOutSeconds,
  );
  const depth = finiteLerp(
    depthStartSemitone,
    depthEndSemitone,
    ratio,
    "vibrato depth interpolation",
  );
  const center = finiteLerp(
    centerStartSemitone,
    centerEndSemitone,
    ratio,
    "vibrato center interpolation",
  );
  const fadeIn = raisedCosineRamp(localSeconds / normalizedFades.fadeInSeconds);
  const fadeOut = raisedCosineRamp(
    (durationSeconds - localSeconds) / normalizedFades.fadeOutSeconds,
  );
  const phase = integratedLinearFrequencyPhase(localSeconds, {
    durationSeconds,
    rateStartHz,
    rateEndHz,
    phaseRad,
  });
  const envelope = fadeIn * fadeOut;
  const value = envelope * center + envelope * depth * Math.sin(phase);
  if (Number.isFinite(value)) return value;
  const error = new RangeError("vibrato output exceeds the finite numeric domain");
  error.code = "VIBRATO_OUTPUT_OVERFLOW";
  throw error;
}

export function buildCorrectionTargetCent(baselineComputedMidi, contributionCent) {
  if (baselineComputedMidi.length !== contributionCent.length) {
    throw new RangeError("baseline and contribution lengths differ");
  }
  return baselineComputedMidi.map((midi, index) => {
    if (!Number.isFinite(midi) || !Number.isFinite(contributionCent[index])) return null;
    const targetCent = midi * 100 + contributionCent[index];
    return Number.isFinite(targetCent) ? targetCent : null;
  });
}

export function splitFiniteRuns(mask, minimumRunFrames = 1) {
  if (!Number.isSafeInteger(minimumRunFrames) || minimumRunFrames < 1) {
    throw new RangeError("minimumRunFrames must be a positive safe integer");
  }
  const runs = [];
  let start = null;
  for (let index = 0; index <= mask.length; index++) {
    if (index < mask.length && mask[index]) {
      if (start === null) start = index;
      continue;
    }
    if (start !== null && index - start >= minimumRunFrames) {
      runs.push({ start, endExclusive: index });
    }
    start = null;
  }
  return runs;
}

function buildSecondDifferencePenalty(length) {
  const penalty = Array.from({ length }, () => Array(length).fill(0));
  for (let row = 0; row + 2 < length; row++) {
    const indices = [row, row + 1, row + 2];
    const coefficients = [1, -2, 1];
    for (let left = 0; left < 3; left++) {
      for (let right = 0; right < 3; right++) {
        penalty[indices[left]][indices[right]] += coefficients[left] * coefficients[right];
      }
    }
  }
  return penalty;
}

function choleskySolve(matrix, vector) {
  const length = vector.length;
  const lower = Array.from({ length }, () => Array(length).fill(0));
  for (let row = 0; row < length; row++) {
    for (let column = 0; column <= row; column++) {
      let value = matrix[row][column];
      for (let inner = 0; inner < column; inner++) {
        value -= lower[row][inner] * lower[column][inner];
      }
      if (!Number.isFinite(value)) {
        const error = new RangeError("correction normal equation exceeds numeric range");
        error.code = "CORRECTION_NUMERIC_OVERFLOW";
        throw error;
      }
      if (row === column) {
        if (!(value > 0)) {
          const error = new RangeError("normal equation is not positive definite");
          error.code = "SOLVER_NOT_POSITIVE_DEFINITE";
          throw error;
        }
        lower[row][column] = Math.sqrt(value);
      } else {
        lower[row][column] = value / lower[column][column];
      }
    }
  }

  const intermediate = Array(length).fill(0);
  for (let row = 0; row < length; row++) {
    let value = vector[row];
    for (let column = 0; column < row; column++) {
      value -= lower[row][column] * intermediate[column];
    }
    intermediate[row] = value / lower[row][row];
    if (!Number.isFinite(intermediate[row])) {
      const error = new RangeError("correction forward solve exceeds numeric range");
      error.code = "CORRECTION_NUMERIC_OVERFLOW";
      throw error;
    }
  }

  const solution = Array(length).fill(0);
  for (let row = length - 1; row >= 0; row--) {
    let value = intermediate[row];
    for (let column = row + 1; column < length; column++) {
      value -= lower[column][row] * solution[column];
    }
    solution[row] = value / lower[row][row];
    if (!Number.isFinite(solution[row])) {
      const error = new RangeError("correction backward solve exceeds numeric range");
      error.code = "CORRECTION_NUMERIC_OVERFLOW";
      throw error;
    }
  }
  return solution;
}

function solveCorrectionRun(currentControlCent, errorCent, parameters) {
  const { smoothnessLambda, magnitudeMu, dataWeight } = parameters;
  const length = currentControlCent.length;
  // 稠密矩阵只作为小规模 oracle；生产实现应使用五对角 O(n) 求解器。
  const penalty = buildSecondDifferencePenalty(length);
  const matrix = Array.from({ length }, (_, row) => (
    Array.from({ length }, (_, column) => (
      smoothnessLambda * penalty[row][column]
      + (row === column ? dataWeight + magnitudeMu : 0)
    ))
  ));
  const vector = Array.from({ length }, (_, row) => {
    let penaltyOnCurrent = 0;
    for (let column = 0; column < length; column++) {
      penaltyOnCurrent += penalty[row][column] * currentControlCent[column];
    }
    return dataWeight * errorCent[row] - smoothnessLambda * penaltyOnCurrent;
  });
  try {
    return choleskySolve(matrix, vector);
  } catch (error) {
    if (error?.code === "SOLVER_NOT_POSITIVE_DEFINITE") {
      error.details = {
        smoothnessLambda,
        magnitudeMu,
        dataWeight,
        finiteFrames: length,
      };
    }
    throw error;
  }
}

const CORRECTION_PARAMETER_FIELDS = new Set([
  "dataWeight",
  "magnitudeMu",
  "maxAbsCorrectionCent",
  "minimumCoverage",
  "minimumRunFrames",
  "smoothnessLambda",
]);

export function solveOpenLoopCorrection(input, parameters = {}) {
  const {
    targetAbsoluteCent,
    observedComputedMidi,
    currentPitchDeltaCent,
  } = input;
  if (
    targetAbsoluteCent.length !== observedComputedMidi.length
    || targetAbsoluteCent.length !== currentPitchDeltaCent.length
  ) {
    throw new RangeError("correction arrays must have equal lengths");
  }

  for (const parameter of Object.keys(parameters)) {
    if (!CORRECTION_PARAMETER_FIELDS.has(parameter)) {
      const error = new TypeError(`unknown correction parameter: ${parameter}`);
      error.code = "INVALID_ARGUMENTS";
      error.details = { parameter };
      throw error;
    }
  }

  const options = {
    smoothnessLambda: parameters.smoothnessLambda ?? 1,
    magnitudeMu: parameters.magnitudeMu ?? 0.01,
    dataWeight: parameters.dataWeight ?? 1,
    minimumCoverage: parameters.minimumCoverage ?? 0.8,
    minimumRunFrames: parameters.minimumRunFrames ?? 3,
    maxAbsCorrectionCent: parameters.maxAbsCorrectionCent ?? 50,
  };
  requireFinite("smoothnessLambda", options.smoothnessLambda);
  requirePositive("magnitudeMu", options.magnitudeMu);
  requirePositive("dataWeight", options.dataWeight);
  requireFinite("minimumCoverage", options.minimumCoverage);
  if (options.smoothnessLambda < 0) throw new RangeError("smoothnessLambda must be >= 0");
  if (!Number.isSafeInteger(options.minimumRunFrames) || options.minimumRunFrames < 1) {
    throw new RangeError("minimumRunFrames must be a positive safe integer");
  }
  if (options.minimumCoverage < 0 || options.minimumCoverage > 1) {
    throw new RangeError("minimumCoverage must be inside [0, 1]");
  }
  requirePositive("maxAbsCorrectionCent", options.maxAbsCorrectionCent);

  const mask = targetAbsoluteCent.map((target, index) => {
    const observedCent = observedComputedMidi[index] * 100;
    const errorCent = target - observedCent;
    return Number.isFinite(target)
      && Number.isFinite(observedComputedMidi[index])
      && Number.isFinite(currentPitchDeltaCent[index])
      && Number.isFinite(observedCent)
      && Number.isFinite(errorCent);
  });
  const finiteCount = mask.filter(Boolean).length;
  const coverage = mask.length === 0 ? 0 : finiteCount / mask.length;
  const requiredFiniteCount = Math.max(
    3,
    Math.ceil(options.minimumCoverage * mask.length),
  );
  if (finiteCount < requiredFiniteCount) {
    const error = new RangeError("computed pitch coverage is below minimumCoverage");
    error.code = "INSUFFICIENT_COMPUTED_PITCH";
    error.details = {
      reason: "FINITE_FRAME_REQUIREMENT_NOT_MET",
      observedCoverage: coverage,
      requiredCoverage: options.minimumCoverage,
      observedFiniteFrames: finiteCount,
      requiredFiniteFrames: requiredFiniteCount,
    };
    throw error;
  }

  const allFiniteRuns = splitFiniteRuns(mask, 1);
  const runs = allFiniteRuns.filter(
    (run) => run.endExclusive - run.start >= options.minimumRunFrames,
  );
  const skippedRuns = allFiniteRuns.filter(
    (run) => run.endExclusive - run.start < options.minimumRunFrames,
  );
  if (runs.length === 0) {
    const error = new RangeError("all finite runs are shorter than minimumRunFrames");
    error.code = "INSUFFICIENT_COMPUTED_PITCH";
    error.details = {
      reason: "NO_ELIGIBLE_FINITE_RUN",
      observedCoverage: coverage,
      requiredCoverage: options.minimumCoverage,
      minimumRunFrames: options.minimumRunFrames,
      skippedRuns,
    };
    throw error;
  }
  const correctionCent = Array(mask.length).fill(null);
  for (const run of runs) {
    const current = currentPitchDeltaCent.slice(run.start, run.endExclusive);
    const error = targetAbsoluteCent
      .slice(run.start, run.endExclusive)
      .map((target, localIndex) => (
        target - observedComputedMidi[run.start + localIndex] * 100
      ));
    const solved = solveCorrectionRun(current, error, options);
    for (let localIndex = 0; localIndex < solved.length; localIndex++) {
      correctionCent[run.start + localIndex] = Math.max(
        -options.maxAbsCorrectionCent,
        Math.min(options.maxAbsCorrectionCent, solved[localIndex]),
      );
    }
  }

  return { coverage, finiteCount, runs, skippedRuns, correctionCent };
}

function numericRuleForKey(key, path, value) {
  if (Object.hasOwn(TECHNIQUE_IR_NUMERIC_FIELD_SCHEMA, key)) {
    return TECHNIQUE_IR_NUMERIC_FIELD_SCHEMA[key];
  }
  const error = new RangeError(`numeric semantic field ${path} is not registered`);
  error.code = "UNQUANTIZED_SEMANTIC_FIELD";
  error.details = { field: key, path, value };
  throw error;
}

function quantizeNumber(value, quantum) {
  const decimalPlaces = Math.max(0, Math.round(-Math.log10(quantum)));
  const scaled = value / quantum;
  const rounded = Number.isFinite(scaled) ? Math.round(scaled) * quantum : value;
  const quantized = Number(rounded.toFixed(decimalPlaces));
  return Object.is(quantized, -0) ? 0 : quantized;
}

function escapeJsonPointerSegment(value) {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function normalizeSemanticValue(value, key = "", path = "$", quantizationTrace = []) {
  if (Array.isArray(value)) {
    return value.map((item, index) => normalizeSemanticValue(
      item,
      key,
      `${path}/${index}`,
      quantizationTrace,
    ));
  }
  if (value && typeof value === "object") {
    const output = {};
    for (const childKey of Object.keys(value).sort()) {
      if (
        path === "$"
        && ["id", "requestIndex", "canonicalKey", "priority"].includes(childKey)
      ) continue;
      output[childKey] = normalizeSemanticValue(
        value[childKey],
        childKey,
        `${path}/${escapeJsonPointerSegment(childKey)}`,
        quantizationTrace,
      );
    }
    return output;
  }
  if (typeof value === "number") {
    requireFinite(path, value);
    const rule = numericRuleForKey(key, path, value);
    if (rule.domain === "safe_integer" && !Number.isSafeInteger(value)) {
      const error = new TypeError(`numeric semantic field ${path} must be a safe integer`);
      error.code = "INVALID_INTEGER_SEMANTIC_FIELD";
      error.details = { field: key, path, value };
      throw error;
    }
    const normalized = rule.domain === "safe_integer"
      ? (Object.is(value, -0) ? 0 : value)
      : quantizeNumber(value, rule.quantum);
    quantizationTrace.push({
      path,
      field: key,
      input: value,
      output: normalized,
      quantum: rule.quantum,
      unit: rule.unit,
      domain: rule.domain,
    });
    return normalized;
  }
  return value;
}

function canonicalValueAt(semantic, field) {
  for (const container of [semantic, semantic.model, semantic.span]) {
    if (container && typeof container === "object" && Object.hasOwn(container, field)) {
      return container[field];
    }
  }
  return undefined;
}

function assertCanonicalOrder(semantic, leftField, rightField) {
  const left = canonicalValueAt(semantic, leftField);
  const right = canonicalValueAt(semantic, rightField);
  if (left === undefined || right === undefined || left < right) return;
  throw codedRangeError(
    "CANONICAL_RELATION_INVALID",
    `${leftField} must remain less than ${rightField} after canonical quantization`,
    {
      relation: `${leftField}<${rightField}`,
      left: { field: leftField, value: left },
      right: { field: rightField, value: right },
    },
  );
}

function validateCanonicalTechnique(semantic) {
  assertCanonicalOrder(semantic, "startRatio", "endRatio");
  assertCanonicalOrder(semantic, "fromSeconds", "toSeconds");
  assertCanonicalOrder(semantic, "startSeconds", "endSeconds");
  assertCanonicalOrder(semantic, "peakTimeSeconds", "spanSeconds");

  const phaseRad = canonicalValueAt(semantic, "phaseRad");
  if (
    phaseRad !== undefined
    && (phaseRad < -CANONICAL_PHASE_LIMIT_RAD || phaseRad > CANONICAL_PHASE_LIMIT_RAD)
  ) {
    throw codedRangeError(
      "CANONICAL_VALUE_OUT_OF_RANGE",
      "phaseRad is outside the canonical phase range",
      {
        field: "phaseRad",
        value: phaseRad,
        minimum: -CANONICAL_PHASE_LIMIT_RAD,
        maximum: CANONICAL_PHASE_LIMIT_RAD,
      },
    );
  }

  const dampingRatio = canonicalValueAt(semantic, "dampingRatio");
  const tailPolicy = semantic.tailPolicy ?? semantic.model?.tailPolicy;
  const kind = semantic.kind ?? semantic.type;
  if (
    kind === "transient"
    && dampingRatio === 0
    && tailPolicy !== "continuous_taper"
  ) {
    throw codedRangeError(
      "UNDAMPED_TAIL_REQUIRES_TAPER",
      "an undamped canonical transient requires tailPolicy continuous_taper",
      { dampingRatio, tailPolicy: tailPolicy ?? "reject" },
    );
  }
}

export function canonicalizeTechniques(techniques) {
  // 先量化语义 IR，再计算哈希，避免“同 key、不同执行值”。
  const normalized = techniques.map((technique) => {
    const priority = technique.priority ?? 0;
    if (!Number.isSafeInteger(priority)) {
      const error = new TypeError("priority must be a safe integer");
      error.code = "INVALID_INTEGER_SEMANTIC_FIELD";
      error.details = { field: "priority", path: "$/priority", value: priority };
      throw error;
    }
    const quantizationTrace = [];
    const semantic = normalizeSemanticValue(technique, "", "$", quantizationTrace);
    validateCanonicalTechnique(semantic);
    const canonicalKey = contentHash(semantic);
    const source = {};
    if (Object.hasOwn(technique, "id")) source.id = technique.id;
    if (Object.hasOwn(technique, "requestIndex")) source.requestIndex = technique.requestIndex;
    return { priority, canonicalKey, semantic, source, quantizationTrace };
  });
  normalized.sort((left, right) => (
    left.priority - right.priority || left.canonicalKey.localeCompare(right.canonicalKey)
  ));
  for (let index = 1; index < normalized.length; index++) {
    const previous = normalized[index - 1];
    const current = normalized[index];
    if (
      previous.priority === current.priority
      && previous.canonicalKey === current.canonicalKey
    ) {
      const error = new RangeError("techniques collide after canonical quantization");
      error.code = "DUPLICATE_TECHNIQUE";
      error.details = {
        priority: current.priority,
        canonicalKey: current.canonicalKey,
        left: {
          source: previous.source,
          quantization: previous.quantizationTrace,
        },
        right: {
          source: current.source,
          quantization: current.quantizationTrace,
        },
      };
      throw error;
    }
  }
  return normalized.map(({ priority, canonicalKey, semantic }, index) => ({
    id: `tech_${index}`,
    priority,
    canonicalKey,
    semantic,
  }));
}
