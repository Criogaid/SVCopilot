export function normalizeMusicalPoint(point, label = "position") {
  if (!isRecord(point)) throw codedError("INVALID_MUSICAL_POSITION", `${label} must be an object`);
  if (!Number.isSafeInteger(point.bar) || point.bar < 1) {
    throw codedError(
      "INVALID_MUSICAL_POSITION",
      `${label}.bar must be an integer >= 1 (bars are 1-based)`
    );
  }
  const beat = normalizeBeat(point.beat ?? 1, `${label}.beat`);
  return {
    bar: point.bar,
    beat: beat.publicValue,
    beatNumerator: beat.numerator,
    beatDenominator: beat.denominator,
  };
}

export function publicMusicalPoint(point) {
  return { bar: point.bar, beat: point.beat };
}

export function musicalToBlick(point, meterMarks, quarterBlick) {
  const hostMeasure = point.bar - 1;
  let active = meterMarks[0];
  for (const mark of meterMarks) {
    if (mark.position <= hostMeasure) active = mark;
    else break;
  }
  if (!active) throw codedError("INVALID_MUSICAL_POSITION", "the project has no measure marks");
  if (
    point.beatNumerator >
    checkedMultiply(active.numerator, point.beatDenominator, "beat range")
  ) {
    throw codedError(
      "INVALID_MUSICAL_POSITION",
      `beat ${formatBeat(point)} is outside the active ${active.numerator}/${active.denominator} measure`
    );
  }

  const wholeBlick = checkedMultiply(quarterBlick, 4, "whole-note timebase");
  const barNumerator = checkedMultiply(active.numerator, wholeBlick, "bar length");
  if (barNumerator % active.denominator !== 0) {
    throw codedError("LOSSY_MUSICAL_POSITION", "the active meter cannot be represented in integer blicks");
  }
  const barLength = barNumerator / active.denominator;
  const beatOffsetNumerator = point.beatNumerator - point.beatDenominator;
  const beatOffsetScale = checkedMultiply(
    point.beatDenominator,
    active.denominator,
    "beat denominator"
  );
  const beatOffsetBlickNumerator = checkedMultiply(
    beatOffsetNumerator,
    wholeBlick,
    "beat offset"
  );
  if (beatOffsetBlickNumerator % beatOffsetScale !== 0) {
    throw codedError(
      "LOSSY_MUSICAL_POSITION",
      `beat ${formatBeat(point)} cannot be represented exactly in integer blicks`
    );
  }
  const segmentBars = hostMeasure - active.position;
  const position =
    active.positionBlick + segmentBars * barLength + beatOffsetBlickNumerator / beatOffsetScale;
  if (!Number.isSafeInteger(position)) {
    throw codedError("MUSICAL_POSITION_OVERFLOW", "musical position exceeds safe integer blick range");
  }
  return position;
}

export function blickToMusical(blick, meterMarks, quarterBlick) {
  let active = meterMarks[0];
  for (const mark of meterMarks) {
    if (mark.positionBlick <= blick) active = mark;
    else break;
  }
  if (!active) throw codedError("INVALID_MUSICAL_POSITION", "the project has no measure marks");
  const wholeBlick = quarterBlick * 4;
  const barLength = (active.numerator * wholeBlick) / active.denominator;
  const beatLength = wholeBlick / active.denominator;
  const offset = blick - active.positionBlick;
  const barInSegment = Math.floor(offset / barLength);
  const withinBar = offset - barInSegment * barLength;
  const beat = Math.floor(withinBar / beatLength);
  return {
    bar: active.position + barInSegment + 1,
    beat: beat + 1,
    tickInBeatBlick: withinBar - beat * beatLength,
    numerator: active.numerator,
    denominator: active.denominator,
  };
}

export function normalizeMeterMarks(raw) {
  const marks = (Array.isArray(raw) ? raw : [])
    .filter(isRecord)
    .map((mark) => ({
      position: mark.position,
      positionBlick: mark.positionBlick,
      numerator: mark.numerator,
      denominator: mark.denominator,
    }))
    .filter(
      (mark) =>
        Number.isSafeInteger(mark.position) &&
        Number.isFinite(mark.positionBlick) &&
        Number.isSafeInteger(mark.numerator) &&
        mark.numerator >= 1 &&
        Number.isSafeInteger(mark.denominator) &&
        mark.denominator >= 1
    )
    .sort((left, right) => left.position - right.position);
  if (marks.length === 0) {
    throw codedError("HOST_DATA_INVALID", "TimeAxis returned no usable measure marks");
  }
  return marks;
}

export function numberToFraction(value, label = "number") {
  if (!Number.isFinite(value)) {
    throw codedError("INVALID_MUSICAL_POSITION", `${label} must be finite`);
  }
  return decimalNumberToFraction(value, label);
}

function normalizeBeat(value, label) {
  if (isRecord(value)) {
    const { numerator, denominator } = value;
    if (
      !Number.isSafeInteger(numerator) ||
      !Number.isSafeInteger(denominator) ||
      numerator < 1 ||
      denominator < 1 ||
      numerator < denominator
    ) {
      throw codedError(
        "INVALID_MUSICAL_POSITION",
        `${label} rational must have safe integer numerator >= denominator >= 1`
      );
    }
    const divisor = greatestCommonDivisor(numerator, denominator);
    return {
      numerator: numerator / divisor,
      denominator: denominator / divisor,
      publicValue: { numerator: numerator / divisor, denominator: denominator / divisor },
    };
  }
  if (!Number.isFinite(value) || value < 1) {
    throw codedError(
      "INVALID_MUSICAL_POSITION",
      `${label} must be a finite number >= 1 or {numerator, denominator}`
    );
  }
  const fraction = numberToFraction(value, label);
  return { ...fraction, publicValue: value };
}

function decimalNumberToFraction(value, label) {
  const text = String(value).toLowerCase();
  const [coefficient, exponentText] = text.split("e");
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  const [whole, fraction = ""] = coefficient.split(".");
  const digits = `${whole}${fraction}`;
  let numerator = Number(digits);
  let denominator = 10 ** fraction.length;
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) {
    throw codedError("INVALID_MUSICAL_POSITION", `${label} has too much decimal precision`);
  }
  if (exponent > 0) numerator *= 10 ** exponent;
  if (exponent < 0) denominator *= 10 ** -exponent;
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) {
    throw codedError("INVALID_MUSICAL_POSITION", `${label} exceeds safe rational precision`);
  }
  const divisor = greatestCommonDivisor(Math.abs(numerator), denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

function greatestCommonDivisor(left, right) {
  let a = left;
  let b = right;
  while (b !== 0) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a || 1;
}

function checkedMultiply(left, right, label) {
  const value = left * right;
  if (!Number.isSafeInteger(value)) {
    throw codedError("MUSICAL_POSITION_OVERFLOW", `${label} exceeds safe integer range`);
  }
  return value;
}

function formatBeat(point) {
  return point.beatDenominator === 1
    ? String(point.beatNumerator)
    : `${point.beatNumerator}/${point.beatDenominator}`;
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
