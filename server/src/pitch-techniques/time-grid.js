import { blickAtSeconds, secondsAtBlick } from "../musical-time.js";

const MAX_UNIFORM_SECONDS_FRAMES = 20_000;
const TIME_EPSILON_SECONDS = 1e-9;

export function buildUniformSecondsGrid(input) {
  const source = normalizeSource(input);
  if (source.values.length === 0) return unavailableGrid(source, "source_empty");

  const sourceSeconds = source.values.map((_, index) =>
    secondsAtBlick(
      source.tempoMarks,
      source.quarterBlick,
      source.startBlick + index * source.intervalBlick
    )
  );
  if (
    sourceSeconds.some((seconds) => !Number.isFinite(seconds)) ||
    sourceSeconds.some((seconds, index) => index > 0 && seconds <= sourceSeconds[index - 1])
  ) {
    return unavailableGrid(source, "tempo_mapping_unavailable");
  }
  if (sourceSeconds.length < 2) return unavailableGrid(source, "source_single_frame");

  const inferredIntervalSeconds = sourceSeconds[1] - sourceSeconds[0];
  const sampleIntervalSeconds = source.sampleIntervalSeconds ?? inferredIntervalSeconds;
  if (!Number.isFinite(sampleIntervalSeconds) || sampleIntervalSeconds <= 0) {
    return unavailableGrid(source, "sample_interval_unavailable");
  }
  const maxGapSeconds = source.maxGapSeconds ?? sampleIntervalSeconds * 3;
  if (!Number.isFinite(maxGapSeconds) || maxGapSeconds <= 0) {
    return unavailableGrid(source, "max_gap_unavailable");
  }

  const startSeconds = sourceSeconds[0];
  const endSeconds = sourceSeconds[sourceSeconds.length - 1];
  const frames = Math.floor(
    (endSeconds - startSeconds) / sampleIntervalSeconds + TIME_EPSILON_SECONDS
  ) + 1;
  if (!Number.isSafeInteger(frames) || frames < 1 || frames > MAX_UNIFORM_SECONDS_FRAMES) {
    return unavailableGrid(source, "uniform_grid_limit_exceeded", {
      requestedFrames: frames,
      maximumFrames: MAX_UNIFORM_SECONDS_FRAMES,
    });
  }

  const timeSeconds = Array.from(
    { length: frames },
    (_, index) => startSeconds + index * sampleIntervalSeconds
  );
  const blicks = timeSeconds.map((seconds) =>
    blickAtSeconds(source.tempoMarks, source.quarterBlick, seconds)
  );
  if (blicks.some((blick) => !Number.isFinite(blick))) {
    return unavailableGrid(source, "tempo_mapping_unavailable");
  }
  const values = resampleFiniteRuns({
    sourceSeconds,
    sourceValues: source.values,
    startSeconds,
    sampleIntervalSeconds,
    frames,
    maxGapSeconds,
  });
  const mask = values.map(Number.isFinite);

  return freezeGrid({
    status: "ready",
    timeGrid: "uniform_seconds",
    frames,
    sampleRateHz: 1 / sampleIntervalSeconds,
    sampleIntervalSeconds,
    timeSeconds,
    blicks,
    values,
    mask,
    source: {
      startBlick: source.startBlick,
      intervalBlick: source.intervalBlick,
      frames: source.values.length,
      finiteFrames: source.values.filter(Number.isFinite).length,
    },
    resampling: {
      method: "linear_within_finite_run",
      maxGapSeconds,
      crossedTempoChange: crossesTempoChange(source.tempoMarks, source),
    },
  });
}

export function compareUniformSecondsGridAxes(left, right) {
  if (left?.status !== "ready" || right?.status !== "ready") {
    return {
      compatible: false,
      reason: "time_grid_unavailable",
      before: left?.reason ?? null,
      after: right?.reason ?? null,
    };
  }
  if (left.frames !== right.frames) {
    return { compatible: false, reason: "frame_count_differs" };
  }
  if (!sameSeconds(left.sampleIntervalSeconds, right.sampleIntervalSeconds)) {
    return { compatible: false, reason: "sample_interval_differs" };
  }
  for (let index = 0; index < left.timeSeconds.length; index += 1) {
    if (!sameSeconds(left.timeSeconds[index], right.timeSeconds[index])) {
      return { compatible: false, reason: "time_axis_differs", frameIndex: index };
    }
  }
  return { compatible: true };
}

function normalizeSource(input) {
  if (!isRecord(input)) throw gridError("INVALID_TIME_GRID_INPUT", "input must be an object");
  assertKnownKeys(
    input,
    [
      "startBlick",
      "intervalBlick",
      "values",
      "tempoMarks",
      "quarterBlick",
      "sampleIntervalSeconds",
      "maxGapSeconds",
    ],
    "input"
  );
  if (!Number.isSafeInteger(input.startBlick) || input.startBlick < 0) {
    throw gridError("INVALID_TIME_GRID_INPUT", "startBlick must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(input.intervalBlick) || input.intervalBlick < 1) {
    throw gridError("INVALID_TIME_GRID_INPUT", "intervalBlick must be a positive safe integer");
  }
  if (!Array.isArray(input.values)) {
    throw gridError("INVALID_TIME_GRID_INPUT", "values must be an array");
  }
  if (!Array.isArray(input.tempoMarks)) {
    throw gridError("INVALID_TIME_GRID_INPUT", "tempoMarks must be an array");
  }
  if (!Number.isFinite(input.quarterBlick) || input.quarterBlick <= 0) {
    throw gridError("INVALID_TIME_GRID_INPUT", "quarterBlick must be positive");
  }
  for (const field of ["sampleIntervalSeconds", "maxGapSeconds"]) {
    if (input[field] !== undefined && (!Number.isFinite(input[field]) || input[field] <= 0)) {
      throw gridError("INVALID_TIME_GRID_INPUT", `${field} must be a positive finite number`);
    }
  }
  return {
    startBlick: input.startBlick,
    intervalBlick: input.intervalBlick,
    values: input.values.map((value) => (Number.isFinite(value) ? value : null)),
    tempoMarks: input.tempoMarks,
    quarterBlick: input.quarterBlick,
    ...(input.sampleIntervalSeconds === undefined
      ? {}
      : { sampleIntervalSeconds: input.sampleIntervalSeconds }),
    ...(input.maxGapSeconds === undefined ? {} : { maxGapSeconds: input.maxGapSeconds }),
  };
}

function resampleFiniteRuns({
  sourceSeconds,
  sourceValues,
  startSeconds,
  sampleIntervalSeconds,
  frames,
  maxGapSeconds,
}) {
  const values = new Array(frames).fill(null);
  let runStart = 0;
  while (runStart < sourceValues.length) {
    if (!Number.isFinite(sourceValues[runStart])) {
      runStart += 1;
      continue;
    }
    let runEnd = runStart;
    while (
      runEnd + 1 < sourceValues.length &&
      Number.isFinite(sourceValues[runEnd + 1]) &&
      sourceSeconds[runEnd + 1] - sourceSeconds[runEnd] <= maxGapSeconds + TIME_EPSILON_SECONDS
    ) {
      runEnd += 1;
    }
    fillFiniteRun({
      values,
      sourceSeconds,
      sourceValues,
      runStart,
      runEnd,
      startSeconds,
      sampleIntervalSeconds,
    });
    // null 或超过 maxGapSeconds 的相邻帧会开始新 run，绝不跨越插值。
    runStart = runEnd + 1;
  }
  return values;
}

function fillFiniteRun({
  values,
  sourceSeconds,
  sourceValues,
  runStart,
  runEnd,
  startSeconds,
  sampleIntervalSeconds,
}) {
  const firstGridIndex = Math.max(
    0,
    Math.ceil((sourceSeconds[runStart] - startSeconds) / sampleIntervalSeconds - TIME_EPSILON_SECONDS)
  );
  const lastGridIndex = Math.min(
    values.length - 1,
    Math.floor((sourceSeconds[runEnd] - startSeconds) / sampleIntervalSeconds + TIME_EPSILON_SECONDS)
  );
  let sourceIndex = runStart;
  for (let gridIndex = firstGridIndex; gridIndex <= lastGridIndex; gridIndex += 1) {
    const seconds = startSeconds + gridIndex * sampleIntervalSeconds;
    while (
      sourceIndex < runEnd &&
      sourceSeconds[sourceIndex + 1] < seconds - TIME_EPSILON_SECONDS
    ) {
      sourceIndex += 1;
    }
    if (sameSeconds(seconds, sourceSeconds[sourceIndex])) {
      values[gridIndex] = sourceValues[sourceIndex];
      continue;
    }
    if (sourceIndex >= runEnd || !sameSeconds(seconds, sourceSeconds[runEnd])) {
      const leftSeconds = sourceSeconds[sourceIndex];
      const rightSeconds = sourceSeconds[sourceIndex + 1];
      if (
        rightSeconds === undefined ||
        seconds < leftSeconds - TIME_EPSILON_SECONDS ||
        seconds > rightSeconds + TIME_EPSILON_SECONDS
      ) continue;
      const ratio = Math.min(
        1,
        Math.max(0, (seconds - leftSeconds) / (rightSeconds - leftSeconds))
      );
      values[gridIndex] = sourceValues[sourceIndex] + ratio * (
        sourceValues[sourceIndex + 1] - sourceValues[sourceIndex]
      );
      continue;
    }
    values[gridIndex] = sourceValues[runEnd];
  }
}

function crossesTempoChange(tempoMarks, source) {
  const endBlick = source.startBlick + (source.values.length - 1) * source.intervalBlick;
  return tempoMarks.some(
    (mark) =>
      Number.isFinite(mark?.positionBlick) &&
      mark.positionBlick > source.startBlick &&
      mark.positionBlick <= endBlick
  );
}

function unavailableGrid(source, reason, details = {}) {
  return Object.freeze({
    status: "unavailable",
    reason,
    source: Object.freeze({
      startBlick: source.startBlick,
      intervalBlick: source.intervalBlick,
      frames: source.values.length,
      finiteFrames: source.values.filter(Number.isFinite).length,
    }),
    ...details,
  });
}

function freezeGrid(grid) {
  return Object.freeze({
    ...grid,
    timeSeconds: Object.freeze(grid.timeSeconds),
    blicks: Object.freeze(grid.blicks),
    values: Object.freeze(grid.values),
    mask: Object.freeze(grid.mask),
    source: Object.freeze(grid.source),
    resampling: Object.freeze(grid.resampling),
  });
}

function sameSeconds(left, right) {
  return Math.abs(left - right) <= TIME_EPSILON_SECONDS;
}

function assertKnownKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw gridError("INVALID_TIME_GRID_INPUT", `${label} has unknown fields`, { unknown });
  }
}

function gridError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
