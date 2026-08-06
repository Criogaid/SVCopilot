import { canonicalHashHex } from "./canonical-json.js";
import { decodeDense, encodeDense } from "./dense-codec.js";
import { planReference } from "./artifact-store.js";
import { buildPlanArtifact } from "./plan-reference.js";
import { buildApplyEnvelope, planSealError, sealApplyEnvelope } from "./plan-envelope.js";
import { blickAtSeconds } from "./musical-time.js";
import { getStoredComputedPitch } from "./musical-range.js";
import { MAX_CURVE_OPERATIONS_PER_TRANSACTION } from "./parameter-curve.js";
import { unknownContextError } from "./snapshot.js";
import { resolveMutationScope } from "./scope-source.js";
import { PITCH_DELTA_LIMIT_CENT } from "./pitch-techniques/model.js";
import {
  captureRemediation,
  createCapturedAutomationBaseline,
  evaluateAutomationPoints,
  evaluateCapturedAutomation,
} from "./pitch-techniques/automation-baseline.js";
import { buildHostInterpolationPostcondition } from "./pitch-techniques/host-interpolation.js";
import { buildUniformSecondsGrid, splitFiniteRuns } from "./pitch-techniques/time-grid.js";
import { codedError } from "./coded-error.js";
import { isRecord } from "./value-shape.js";

export const PITCH_CORRECTION_DEFAULTS = Object.freeze({
  evidence: Object.freeze({
    minimumCoverage: 0.8,
    minimumRunFrames: 3,
  }),
  regularization: Object.freeze({
    smoothnessLambda: 0.4,
    magnitudeMu: 0.01,
    maxAbsCorrectionCent: 50,
  }),
});

export const PITCH_CORRECTION_POLICY = Object.freeze({
  version: "pitch-correction-policy-v1",
  minimumWriteAbsCent: 0.01,
  maxSlopeCentPerSecond: 1200,
  maxTotalPoints: 4000,
  maxPointsPerCurve: 2000,
  basis: "synthetic_corpus_v1_requires_live_host_calibration",
});

const CORRECTION_TARGET_SCHEMA_VERSION = 2;
const CORRECTION_DENSE_SCHEMA_VERSION = "1";
const MAX_CURVES_PER_PLAN = MAX_CURVE_OPERATIONS_PER_TRANSACTION;
const TIME_EPSILON_SECONDS = 1e-9;
const CENT_QUANTUM = 1e-6;

const CORRECTION_CURVE_PROFILE = Object.freeze({
  schemaVersion: CORRECTION_DENSE_SCHEMA_VERSION,
  kind: "pitch-correction-automation-points",
  maxRows: PITCH_CORRECTION_POLICY.maxPointsPerCurve,
  columns: Object.freeze([
    Object.freeze({ name: "blick", unit: "blick", type: "integer", encoding: "delta" }),
    Object.freeze({
      name: "value",
      unit: "cent",
      type: "number",
      encoding: "qint",
      scale: CENT_QUANTUM,
      maxError: CENT_QUANTUM / 2,
    }),
  ]),
});

export class PitchCorrectionPlanService {
  constructor({ store, artifactStore = null, sessionId = null } = {}) {
    if (!store) throw new Error("PitchCorrectionPlanService requires the shared SnapshotStore");
    this.store = store;
    this.artifactStore = artifactStore;
    this.sessionId = sessionId;
  }

  async plan(request = {}) {
    const input = normalizeRequest(request);
    const source = resolveCorrectionSource({
      artifactStore: this.artifactStore,
      sessionId: this.sessionId,
      sourcePlanRef: input.sourcePlanRef,
    });
    const observed = resolveObservedSource(this.store, input.observedContextId, source);
    const targetTimes = targetTimeAxis(source.target.grid);
    const observedGrid = buildObservedGrid(observed);
    const observedComputedMidi = resampleObservedGrid(observedGrid, targetTimes);
    const localBlicks = targetTimes.map((seconds, index) =>
      localBlickAtSeconds(seconds, observed, index)
    );
    const baseline = loadObservedPitchDeltaBaseline(observed);
    const currentPitchDeltaCent = localBlicks.map((blick) => {
      try {
        const value = evaluateCapturedAutomation(baseline, blick);
        return Number.isFinite(value) ? value : null;
      } catch {
        return null;
      }
    });

    let solved;
    try {
      solved = solveBandedOpenLoopCorrection({
        targetAbsoluteCent: source.target.values,
        observedComputedMidi,
        currentPitchDeltaCent,
      }, {
        ...input.regularization,
        ...input.evidence,
      });
    } catch (error) {
      if (error?.code === "INSUFFICIENT_COMPUTED_PITCH") {
        return insufficientEvidenceResponse(error.details, source.target.grid.frames);
      }
      throw error;
    }

    const objective = correctionObjective({
      targetAbsoluteCent: source.target.values,
      observedComputedMidi,
      correctionCent: solved.correctionCent,
    });
    const correction = correctionSummary(solved.correctionCent);
    if (
      objective.predictedRmseCent >= objective.beforeRmseCent - CENT_QUANTUM
      || correction.maxAbsCent < PITCH_CORRECTION_POLICY.minimumWriteAbsCent
    ) {
      return noChangeResponse({
        solved,
        objective,
        correction,
        totalFrames: source.target.grid.frames,
      });
    }

    assertCorrectionSlope(solved.correctionCent, targetTimes);
    const curves = buildCorrectionCurves({
      solved,
      localBlicks,
      currentPitchDeltaCent,
      baseline,
    });
    const pointCount = curves.reduce((total, curve) => total + curve.pointCount, 0);
    if (pointCount > PITCH_CORRECTION_POLICY.maxTotalPoints) {
      throw codedError(
        "PITCH_DELTA_POINT_BUDGET_EXCEEDED",
        "correction points exceed the hard transaction budget",
        { maximum: PITCH_CORRECTION_POLICY.maxTotalPoints, actual: pointCount },
      );
    }
    if (curves.length > MAX_CURVES_PER_PLAN) {
      throw codedError(
        "CORRECTION_FRAGMENT_LIMIT",
        "finite correction runs exceed the transaction curve-operation budget",
        { maximum: MAX_CURVES_PER_PLAN, actual: curves.length },
      );
    }

    return sealCorrectionPlan({
      input,
      source,
      observed,
      solved,
      targetTimes,
      observedComputedMidi,
      currentPitchDeltaCent,
      objective,
      correction,
      curves,
      artifactStore: this.artifactStore,
      sessionId: this.sessionId,
    });
  }
}

export function solveBandedOpenLoopCorrection(input, parameters = {}) {
  const normalized = normalizeSolverInput(input, parameters);
  const {
    targetAbsoluteCent,
    observedComputedMidi,
    currentPitchDeltaCent,
    options,
  } = normalized;
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
  const requiredFiniteCount = Math.max(3, Math.ceil(options.minimumCoverage * mask.length));
  if (finiteCount < requiredFiniteCount) {
    throw codedError(
      "INSUFFICIENT_COMPUTED_PITCH",
      "computed pitch coverage is below minimumCoverage",
      {
        reason: "FINITE_FRAME_REQUIREMENT_NOT_MET",
        observedCoverage: coverage,
        requiredCoverage: options.minimumCoverage,
        observedFiniteFrames: finiteCount,
        requiredFiniteFrames: requiredFiniteCount,
      },
    );
  }

  const allFiniteRuns = splitFiniteRuns(mask, 1);
  const runs = splitFiniteRuns(mask, options.minimumRunFrames);
  const eligible = new Set(runs.map((run) => `${run.start}:${run.endExclusive}`));
  const skippedRuns = allFiniteRuns.filter((run) => !eligible.has(`${run.start}:${run.endExclusive}`));
  if (runs.length === 0) {
    throw codedError(
      "INSUFFICIENT_COMPUTED_PITCH",
      "all finite runs are shorter than minimumRunFrames",
      {
        reason: "NO_ELIGIBLE_FINITE_RUN",
        observedCoverage: coverage,
        requiredCoverage: options.minimumCoverage,
        minimumRunFrames: options.minimumRunFrames,
        skippedRuns,
      },
    );
  }

  const correctionCent = Array(mask.length).fill(null);
  let clampedPoints = 0;
  for (const run of runs) {
    const current = currentPitchDeltaCent.slice(run.start, run.endExclusive);
    const error = targetAbsoluteCent
      .slice(run.start, run.endExclusive)
      .map((target, localIndex) => (
        target - observedComputedMidi[run.start + localIndex] * 100
      ));
    const raw = solveBandedCorrectionRun(current, error, options);
    for (let localIndex = 0; localIndex < raw.length; localIndex += 1) {
      const projected = clamp(
        raw[localIndex],
        -options.maxAbsCorrectionCent,
        options.maxAbsCorrectionCent,
      );
      if (projected !== raw[localIndex]) clampedPoints += 1;
      correctionCent[run.start + localIndex] = projected;
    }
  }
  return {
    coverage,
    finiteCount,
    runs,
    skippedRuns,
    correctionCent,
    clampedPoints,
  };
}

function normalizeRequest(request) {
  if (!isRecord(request)) throw codedError("INVALID_ARGUMENTS", "request must be an object");
  assertKnownKeys(
    request,
    ["sourcePlanRef", "observedContextId", "evidence", "regularization"],
    "request",
  );
  if (typeof request.sourcePlanRef !== "string" || !/^a_[A-Za-z0-9_-]+$/.test(request.sourcePlanRef)) {
    throw codedError("INVALID_ARGUMENTS", "sourcePlanRef must be a PlanRef artifactId");
  }
  if (typeof request.observedContextId !== "string" || request.observedContextId.length === 0) {
    throw codedError("INVALID_ARGUMENTS", "observedContextId must be a non-empty string");
  }
  const evidence = normalizeEvidence(request.evidence);
  const regularization = normalizeRegularization(request.regularization);
  return {
    sourcePlanRef: request.sourcePlanRef,
    observedContextId: request.observedContextId,
    evidence,
    regularization,
  };
}

function normalizeEvidence(value) {
  if (value === undefined) return { ...PITCH_CORRECTION_DEFAULTS.evidence };
  if (!isRecord(value)) throw codedError("INVALID_ARGUMENTS", "evidence must be an object");
  assertKnownKeys(value, ["minimumCoverage", "minimumRunFrames"], "evidence");
  return {
    minimumCoverage: checkedNumber(
      value.minimumCoverage,
      0,
      1,
      PITCH_CORRECTION_DEFAULTS.evidence.minimumCoverage,
      "evidence.minimumCoverage",
    ),
    minimumRunFrames: checkedInteger(
      value.minimumRunFrames,
      1,
      1000,
      PITCH_CORRECTION_DEFAULTS.evidence.minimumRunFrames,
      "evidence.minimumRunFrames",
    ),
  };
}

function normalizeRegularization(value) {
  if (value === undefined) return { ...PITCH_CORRECTION_DEFAULTS.regularization };
  if (!isRecord(value)) throw codedError("INVALID_ARGUMENTS", "regularization must be an object");
  assertKnownKeys(value, ["smoothnessLambda", "magnitudeMu", "maxAbsCorrectionCent"], "regularization");
  return {
    smoothnessLambda: checkedNumber(
      value.smoothnessLambda,
      0,
      100,
      PITCH_CORRECTION_DEFAULTS.regularization.smoothnessLambda,
      "regularization.smoothnessLambda",
    ),
    magnitudeMu: checkedNumber(
      value.magnitudeMu,
      0.000001,
      100,
      PITCH_CORRECTION_DEFAULTS.regularization.magnitudeMu,
      "regularization.magnitudeMu",
    ),
    maxAbsCorrectionCent: checkedNumber(
      value.maxAbsCorrectionCent,
      0.000001,
      1200,
      PITCH_CORRECTION_DEFAULTS.regularization.maxAbsCorrectionCent,
      "regularization.maxAbsCorrectionCent",
    ),
  };
}

function resolveCorrectionSource({ artifactStore, sessionId, sourcePlanRef }) {
  if (!artifactStore || !sessionId) throw planSealError();
  const artifact = artifactStore.resolve({
    artifactId: sourcePlanRef,
    expectedKind: "plan",
    sessionId,
  });
  const ledger = artifactStore.planLedger?.get(sourcePlanRef);
  if (ledger?.state !== "committed") {
    throw codedError(
      "PLAN_NOT_COMMITTED",
      "sourcePlanRef must be a successfully committed pitch-gesture plan",
      { state: ledger?.state ?? "missing" },
    );
  }
  const payload = artifact.payload;
  const sourceCurves = payload?.mutationRequest?.curves;
  const hasVibratoEnvelope = sourceCurves?.some(
    (curve) => curve?.parameter === "vibratoEnv",
  );
  const correctionTarget = payload?.pitchTechniques?.correctionTarget;
  if (!correctionTarget) {
    if (hasVibratoEnvelope) {
      throw codedError(
        "CORRECTION_TARGET_UNAVAILABLE",
        "the source plan touches vibratoEnv and has no complete additive pitchDelta target",
      );
    }
    throw codedError(
      "CORRECTION_TARGET_NOT_RETAINED",
      "sourcePlanRef was not created with retainCorrectionTarget:true",
    );
  }
  if (payload.targetTool !== "sv_patch_parameter_curves") {
    throw codedError("CORRECTION_TARGET_NOT_RETAINED", "sourcePlanRef is not a pitch Automation plan");
  }
  if (
    !Array.isArray(sourceCurves)
    || sourceCurves.length === 0
    || !sourceCurves.every(
      (curve) => curve?.parameter === "pitchDelta" && curve?.mode === "replace",
    )
    || payload?.pitchTechniques?.provenance?.writeSurface !== "pitchDelta"
    || payload?.pitchTechniques?.provenance?.composition !== "baseline_plus_contribution"
  ) {
    throw codedError(
      "CORRECTION_TARGET_UNAVAILABLE",
      "sourcePlanRef is not a pure additive pitchDelta plan",
    );
  }
  const occurrence = payload.capsule?.context?.occurrences?.[0];
  if (
    !isRecord(occurrence)
    || typeof occurrence.targetGroupUuid !== "string"
    || occurrence.targetGroupUuid.length === 0
    || !Number.isSafeInteger(occurrence.timeOffsetBlick)
  ) {
    throw codedError("CORRECTION_TARGET_UNAVAILABLE", "source plan capsule lacks target identity");
  }
  return {
    artifact,
    payload,
    occurrence,
    expectedNotes: normalizeSourceExpectedNotes(payload.mutationRequest?.target?.expectedNotes),
    target: normalizeCorrectionTarget(correctionTarget),
  };
}

function normalizeSourceExpectedNotes(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw codedError("CORRECTION_TARGET_UNAVAILABLE", "source plan expectedNotes must be an array");
  }
  return value.map((note) => ({ ...note }));
}

function normalizeCorrectionTarget(value) {
  if (!isRecord(value)) {
    throw codedError("CORRECTION_TARGET_UNAVAILABLE", "source correction target is malformed");
  }
  assertKnownKeys(value, ["schemaVersion", "encoding", "points", "finiteFrames", "grid"], "correctionTarget");
  if (value.schemaVersion !== CORRECTION_TARGET_SCHEMA_VERSION || value.encoding !== "dense-table-v1") {
    throw codedError(
      "CORRECTION_TARGET_UNAVAILABLE",
      "source correction target does not retain the required uniform-seconds grid",
    );
  }
  const grid = normalizeTargetGrid(value.grid);
  let rows;
  try {
    rows = decodeDense(value.points);
  } catch (error) {
    throw codedError("CORRECTION_TARGET_UNAVAILABLE", "source correction target points are malformed", {
      cause: error?.message ?? String(error),
    });
  }
  if (
    value.points?.kind !== "pitch-technique-correction-target"
    || !Array.isArray(value.points?.columns)
    || value.points.columns.length !== 2
    || value.points.columns[0]?.name !== "frame"
    || value.points.columns[1]?.name !== "targetCent"
  ) {
    throw codedError("CORRECTION_TARGET_UNAVAILABLE", "source correction target uses an unsupported table profile");
  }
  if (!Number.isSafeInteger(value.finiteFrames) || value.finiteFrames !== rows.length) {
    throw codedError("CORRECTION_TARGET_UNAVAILABLE", "source correction target finite-frame evidence disagrees");
  }
  const values = Array(grid.frames).fill(null);
  let previousFrame = -1;
  for (const row of rows) {
    if (
      !Number.isSafeInteger(row.frame)
      || row.frame < 0
      || row.frame >= grid.frames
      || row.frame <= previousFrame
      || !Number.isFinite(row.targetCent)
    ) {
      throw codedError("CORRECTION_TARGET_UNAVAILABLE", "source correction target rows are invalid");
    }
    values[row.frame] = row.targetCent;
    previousFrame = row.frame;
  }
  if (rows.length === 0) {
    throw codedError("CORRECTION_TARGET_UNAVAILABLE", "source correction target has no finite frames");
  }
  return { grid, values };
}

function normalizeTargetGrid(value) {
  if (!isRecord(value)) {
    throw codedError("CORRECTION_TARGET_UNAVAILABLE", "source correction target has no grid metadata");
  }
  assertKnownKeys(value, ["timeGrid", "startSeconds", "sampleIntervalSeconds", "frames"], "correctionTarget.grid");
  if (
    value.timeGrid !== "uniform_seconds"
    || !Number.isFinite(value.startSeconds)
    || !Number.isFinite(value.sampleIntervalSeconds)
    || value.sampleIntervalSeconds <= 0
    || !Number.isSafeInteger(value.frames)
    || value.frames < 1
    || value.frames > PITCH_CORRECTION_POLICY.maxTotalPoints
    || !Number.isFinite(value.startSeconds + (value.frames - 1) * value.sampleIntervalSeconds)
  ) {
    throw codedError("CORRECTION_TARGET_UNAVAILABLE", "source correction target grid is invalid");
  }
  return {
    timeGrid: "uniform_seconds",
    startSeconds: value.startSeconds,
    sampleIntervalSeconds: value.sampleIntervalSeconds,
    frames: value.frames,
  };
}

function resolveObservedSource(store, contextId, source) {
  const stored = store.get(contextId);
  if (!stored) throw unknownContextError(store, contextId, "observed");
  if (stored.context?.kind !== "range") {
    throw codedError(
      "INVALID_CONTEXT",
      'observedContextId needs a range context captured with include ["notes","automation","computedPitch"]',
    );
  }
  const occurrences = Array.isArray(stored.context.occurrences) ? stored.context.occurrences : [];
  const candidates = occurrences.flatMap((occurrence, ordinal) => (
    occurrence?.targetGroupUuid === source.occurrence.targetGroupUuid
    && occurrence?.timeOffsetBlick === source.occurrence.timeOffsetBlick
      ? [{ occurrence, ordinal }]
      : []
  ));
  if (candidates.length === 0) {
    throw codedError(
      "PLAN_TARGET_MISMATCH",
      "observed context does not contain the target occurrence sealed by sourcePlanRef",
    );
  }
  if (candidates.length > 1) {
    throw codedError(
      "AMBIGUOUS_PLAN_TARGET",
      "observed context contains multiple occurrences that match sourcePlanRef",
      { candidateOrdinals: candidates.map((candidate) => candidate.ordinal) },
    );
  }
  const { ordinal } = candidates[0];
  const scope = resolveMutationScope({ source: { kind: "snapshot", stored }, occurrence: ordinal });
  const series = getStoredComputedPitch(stored, ordinal);
  if (!series) {
    throw codedError(
      "COMPUTED_PITCH_NOT_CAPTURED",
      'observedContextId has no computed pitch for the matched occurrence; re-run sv_snapshot_range with include ["notes","automation","computedPitch"]',
    );
  }
  assertComputedPitchSeries(series);
  if (!Number.isSafeInteger(stored.context.quarterBlick) || stored.context.quarterBlick <= 0) {
    throw codedError("INVALID_CONTEXT", "observed context is missing a usable SV.QUARTER timebase");
  }
  if (!Array.isArray(stored.context.tempoMarks) || stored.context.tempoMarks.length === 0) {
    throw codedError("INVALID_CONTEXT", "observed context is missing a usable tempo map");
  }
  assertExpectedNotesPresent(source.expectedNotes, scope);
  return { stored, scope, occurrence: scope.occurrence, ordinal, series };
}

function assertExpectedNotesPresent(expectedNotes, scope) {
  for (const expected of expectedNotes) {
    if (!Number.isSafeInteger(expected?.indexInGroup) || !scope.noteByIndex.has(expected.indexInGroup)) {
      throw codedError(
        "PLAN_TARGET_MISMATCH",
        "observed context does not contain every source-plan anchor note",
        { indexInGroup: expected?.indexInGroup ?? null },
      );
    }
  }
}

function assertComputedPitchSeries(series) {
  const evidence = series?.evidence;
  const values = series?.values;
  if (
    !Number.isSafeInteger(series?.startBlick)
    || series.startBlick < 0
    || !Number.isSafeInteger(series?.intervalBlick)
    || series.intervalBlick < 1
    || !Number.isSafeInteger(series?.frames)
    || series.frames < 1
    || !Array.isArray(values)
    || values.length !== series.frames
    || !isRecord(evidence)
    || !Number.isSafeInteger(evidence.requestedFrames)
    || !Number.isSafeInteger(evidence.observedFrames)
    || !Array.isArray(evidence.nullFrameIndices)
  ) {
    throw codedError("COMPUTED_PITCH_NOT_CAPTURED", "observed computed-pitch sampling provenance is incomplete");
  }
  const finiteFrames = values.filter(Number.isFinite).length;
  const nullFrameIndices = values.flatMap((value, index) => (
    Number.isFinite(value) ? [] : [index]
  ));
  if (
    evidence.requestedFrames !== series.frames
    || evidence.observedFrames !== finiteFrames
    || !sameIntegerArray(evidence.nullFrameIndices, nullFrameIndices)
  ) {
    throw codedError("COMPUTED_PITCH_NOT_CAPTURED", "observed computed-pitch sampling provenance disagrees");
  }
}

function buildObservedGrid(observed) {
  const grid = buildUniformSecondsGrid({
    startBlick: observed.series.startBlick,
    intervalBlick: observed.series.intervalBlick,
    values: observed.series.values,
    tempoMarks: observed.stored.context.tempoMarks,
    quarterBlick: observed.stored.context.quarterBlick,
  });
  if (grid.status !== "ready") {
    throw codedError(
      "SAMPLING_GRID_MISALIGNED",
      "observed computed-pitch sampling cannot form a uniform-seconds grid",
      { reason: grid.reason },
    );
  }
  return grid;
}

function targetTimeAxis(grid) {
  return Array.from(
    { length: grid.frames },
    (_, index) => grid.startSeconds + index * grid.sampleIntervalSeconds,
  );
}

function resampleObservedGrid(grid, targetTimes) {
  const start = grid.timeSeconds[0];
  const end = grid.timeSeconds.at(-1);
  const targetStart = targetTimes[0];
  const targetEnd = targetTimes.at(-1);
  if (targetEnd < start - TIME_EPSILON_SECONDS || targetStart > end + TIME_EPSILON_SECONDS) {
    throw codedError(
      "SAMPLING_GRID_MISALIGNED",
      "source and observed uniform-seconds grids have no overlapping time coverage",
      {
        source: { startSeconds: targetStart, endSeconds: targetEnd },
        observed: { startSeconds: start, endSeconds: end },
      },
    );
  }
  const values = Array(targetTimes.length).fill(null);
  const runs = splitFiniteRuns(grid.mask, 1);
  for (const run of runs) {
    const runStart = grid.timeSeconds[run.start];
    const runEnd = grid.timeSeconds[run.endExclusive - 1];
    let sourceIndex = run.start;
    for (let targetIndex = 0; targetIndex < targetTimes.length; targetIndex += 1) {
      const seconds = targetTimes[targetIndex];
      if (seconds < runStart - TIME_EPSILON_SECONDS || seconds > runEnd + TIME_EPSILON_SECONDS) {
        continue;
      }
      while (
        sourceIndex + 1 < run.endExclusive
        && grid.timeSeconds[sourceIndex + 1] < seconds - TIME_EPSILON_SECONDS
      ) {
        sourceIndex += 1;
      }
      if (sameSeconds(seconds, grid.timeSeconds[sourceIndex])) {
        values[targetIndex] = grid.values[sourceIndex];
        continue;
      }
      if (sourceIndex + 1 >= run.endExclusive) continue;
      const leftSeconds = grid.timeSeconds[sourceIndex];
      const rightSeconds = grid.timeSeconds[sourceIndex + 1];
      const ratio = (seconds - leftSeconds) / (rightSeconds - leftSeconds);
      const value = grid.values[sourceIndex] + ratio * (grid.values[sourceIndex + 1] - grid.values[sourceIndex]);
      if (Number.isFinite(value)) values[targetIndex] = value;
    }
  }
  return values;
}

function localBlickAtSeconds(seconds, observed, frame) {
  const absoluteBlick = blickAtSeconds(
    observed.stored.context.tempoMarks,
    observed.stored.context.quarterBlick,
    seconds,
  );
  const rounded = Number.isFinite(absoluteBlick) ? Math.round(absoluteBlick) : null;
  const local = rounded === null ? null : rounded - observed.occurrence.timeOffsetBlick;
  if (!Number.isSafeInteger(local)) {
    throw codedError(
      "SAMPLING_GRID_MISALIGNED",
      "target uniform-seconds frame cannot map to an integer local BLICK",
      { frame, seconds, absoluteBlick: absoluteBlick ?? null },
    );
  }
  return local;
}

function loadObservedPitchDeltaBaseline(observed) {
  if (observed.stored.context.automationCaptured !== true) {
    throw codedError("CAPTURE_EVIDENCE_REQUIRED", "captured pitchDelta Automation is required", {
      remediation: captureRemediation(["pitchDelta"]),
    });
  }
  const captured = observed.stored.context.automationByOccurrence?.[observed.ordinal] ?? [];
  const curve = captured.find((item) => item?.resolvedParameter === "pitchDelta");
  if (!curve) {
    throw codedError("CAPTURE_EVIDENCE_REQUIRED", "captured pitchDelta Automation is required", {
      remediation: captureRemediation(["pitchDelta"]),
    });
  }
  return createCapturedAutomationBaseline({
    curve,
    contextId: observed.stored.contextId,
    parameter: "pitchDelta",
  });
}

function normalizeSolverInput(input, parameters) {
  if (!isRecord(input)) throw codedError("INVALID_ARGUMENTS", "solver input must be an object");
  assertKnownKeys(
    input,
    ["targetAbsoluteCent", "observedComputedMidi", "currentPitchDeltaCent"],
    "solver input",
  );
  const targetAbsoluteCent = input.targetAbsoluteCent;
  const observedComputedMidi = input.observedComputedMidi;
  const currentPitchDeltaCent = input.currentPitchDeltaCent;
  if (
    !Array.isArray(targetAbsoluteCent)
    || !Array.isArray(observedComputedMidi)
    || !Array.isArray(currentPitchDeltaCent)
    || targetAbsoluteCent.length !== observedComputedMidi.length
    || targetAbsoluteCent.length !== currentPitchDeltaCent.length
  ) {
    throw codedError("INVALID_ARGUMENTS", "correction arrays must have equal lengths");
  }
  if (!isRecord(parameters)) throw codedError("INVALID_ARGUMENTS", "solver parameters must be an object");
  assertKnownKeys(
    parameters,
    [
      "smoothnessLambda",
      "magnitudeMu",
      "dataWeight",
      "minimumCoverage",
      "minimumRunFrames",
      "maxAbsCorrectionCent",
    ],
    "solver parameters",
  );
  const options = {
    smoothnessLambda: parameters.smoothnessLambda ?? PITCH_CORRECTION_DEFAULTS.regularization.smoothnessLambda,
    magnitudeMu: parameters.magnitudeMu ?? PITCH_CORRECTION_DEFAULTS.regularization.magnitudeMu,
    dataWeight: parameters.dataWeight ?? 1,
    minimumCoverage: parameters.minimumCoverage ?? PITCH_CORRECTION_DEFAULTS.evidence.minimumCoverage,
    minimumRunFrames: parameters.minimumRunFrames ?? PITCH_CORRECTION_DEFAULTS.evidence.minimumRunFrames,
    maxAbsCorrectionCent: parameters.maxAbsCorrectionCent
      ?? PITCH_CORRECTION_DEFAULTS.regularization.maxAbsCorrectionCent,
  };
  requireFinite("smoothnessLambda", options.smoothnessLambda);
  requireAtLeast("magnitudeMu", options.magnitudeMu, 0.000001);
  requirePositive("dataWeight", options.dataWeight);
  requireFinite("minimumCoverage", options.minimumCoverage);
  requirePositive("maxAbsCorrectionCent", options.maxAbsCorrectionCent);
  if (options.smoothnessLambda < 0) {
    throw codedError("INVALID_ARGUMENTS", "smoothnessLambda must be >= 0");
  }
  if (!Number.isSafeInteger(options.minimumRunFrames) || options.minimumRunFrames < 1) {
    throw codedError("INVALID_ARGUMENTS", "minimumRunFrames must be a positive safe integer");
  }
  if (options.minimumCoverage < 0 || options.minimumCoverage > 1) {
    throw codedError("INVALID_ARGUMENTS", "minimumCoverage must be inside [0, 1]");
  }
  return { targetAbsoluteCent, observedComputedMidi, currentPitchDeltaCent, options };
}

function solveBandedCorrectionRun(current, error, options) {
  const length = current.length;
  const main = Array(length).fill(options.dataWeight + options.magnitudeMu);
  const firstUpper = Array(Math.max(0, length - 1)).fill(0);
  const secondUpper = Array(Math.max(0, length - 2)).fill(0);
  const secondDifferenceCurrent = Array(length).fill(0);
  for (let row = 0; row + 2 < length; row += 1) {
    main[row] += options.smoothnessLambda;
    main[row + 1] += options.smoothnessLambda * 4;
    main[row + 2] += options.smoothnessLambda;
    firstUpper[row] -= options.smoothnessLambda * 2;
    firstUpper[row + 1] -= options.smoothnessLambda * 2;
    secondUpper[row] += options.smoothnessLambda;
    const value = current[row] - 2 * current[row + 1] + current[row + 2];
    if (!Number.isFinite(value)) throw correctionOverflow();
    secondDifferenceCurrent[row] += value;
    secondDifferenceCurrent[row + 1] -= value * 2;
    secondDifferenceCurrent[row + 2] += value;
  }
  const rightHand = error.map((value, index) => {
    const result = options.dataWeight * value - options.smoothnessLambda * secondDifferenceCurrent[index];
    if (!Number.isFinite(result)) throw correctionOverflow();
    return result;
  });
  if (
    main.some((value) => !Number.isFinite(value))
    || firstUpper.some((value) => !Number.isFinite(value))
    || secondUpper.some((value) => !Number.isFinite(value))
  ) {
    throw correctionOverflow();
  }
  return solvePentadiagonalCholesky({ main, firstUpper, secondUpper, rightHand, options, length });
}

function solvePentadiagonalCholesky({ main, firstUpper, secondUpper, rightHand, options, length }) {
  const diagonal = Array(length).fill(0);
  const firstLower = Array(length).fill(0);
  const secondLower = Array(length).fill(0);
  for (let index = 0; index < length; index += 1) {
    if (index >= 2) {
      secondLower[index] = secondUpper[index - 2] / diagonal[index - 2];
    }
    if (index >= 1) {
      const shared = index >= 2 ? secondLower[index] * firstLower[index - 1] : 0;
      firstLower[index] = (firstUpper[index - 1] - shared) / diagonal[index - 1];
    }
    const candidate = main[index] - firstLower[index] ** 2 - secondLower[index] ** 2;
    if (!Number.isFinite(candidate)) throw correctionOverflow();
    if (!(candidate > 0)) {
      throw codedError(
        "SOLVER_NOT_POSITIVE_DEFINITE",
        "correction normal equation is not positive definite",
        {
          smoothnessLambda: options.smoothnessLambda,
          magnitudeMu: options.magnitudeMu,
          dataWeight: options.dataWeight,
          finiteFrames: length,
        },
      );
    }
    diagonal[index] = Math.sqrt(candidate);
    if (!Number.isFinite(diagonal[index]) || diagonal[index] === 0) throw correctionOverflow();
  }
  const intermediate = Array(length).fill(0);
  for (let index = 0; index < length; index += 1) {
    const value = (
      rightHand[index]
      - (index >= 1 ? firstLower[index] * intermediate[index - 1] : 0)
      - (index >= 2 ? secondLower[index] * intermediate[index - 2] : 0)
    ) / diagonal[index];
    if (!Number.isFinite(value)) throw correctionOverflow();
    intermediate[index] = value;
  }
  const solution = Array(length).fill(0);
  for (let index = length - 1; index >= 0; index -= 1) {
    const value = (
      intermediate[index]
      - (index + 1 < length ? firstLower[index + 1] * solution[index + 1] : 0)
      - (index + 2 < length ? secondLower[index + 2] * solution[index + 2] : 0)
    ) / diagonal[index];
    if (!Number.isFinite(value)) throw correctionOverflow();
    solution[index] = value;
  }
  return solution;
}

function correctionObjective({ targetAbsoluteCent, observedComputedMidi, correctionCent }) {
  const before = [];
  const after = [];
  for (let index = 0; index < targetAbsoluteCent.length; index += 1) {
    if (!Number.isFinite(targetAbsoluteCent[index]) || !Number.isFinite(observedComputedMidi[index])) continue;
    const error = targetAbsoluteCent[index] - observedComputedMidi[index] * 100;
    if (!Number.isFinite(error)) continue;
    before.push(error);
    const correction = Number.isFinite(correctionCent[index]) ? correctionCent[index] : 0;
    after.push(error - correction);
  }
  return {
    beforeRmseCent: rmse(before),
    predictedRmseCent: rmse(after),
    provenance: "model_prediction_after_projected_correction",
  };
}

function correctionSummary(correctionCent) {
  const finite = correctionCent.filter(Number.isFinite);
  return {
    points: finite.length,
    maxAbsCent: finite.length === 0 ? 0 : Math.max(...finite.map(Math.abs)),
  };
}

function assertCorrectionSlope(correctionCent, timeSeconds) {
  let maximumObserved = 0;
  for (const run of splitFiniteRuns(correctionCent.map(Number.isFinite), 1)) {
    for (let index = run.start + 1; index < run.endExclusive; index += 1) {
      const elapsed = timeSeconds[index] - timeSeconds[index - 1];
      if (!Number.isFinite(elapsed) || elapsed <= 0) {
        throw codedError("SAMPLING_GRID_MISALIGNED", "correction target time grid is not strictly increasing");
      }
      const slope = Math.abs(correctionCent[index] - correctionCent[index - 1]) / elapsed;
      if (!Number.isFinite(slope)) throw correctionOverflow();
      maximumObserved = Math.max(maximumObserved, slope);
    }
  }
  if (maximumObserved > PITCH_CORRECTION_POLICY.maxSlopeCentPerSecond + CENT_QUANTUM) {
    throw codedError(
      "CORRECTION_SLOPE_LIMIT",
      "projected correction exceeds the server slope policy",
      {
        maximumObservedSlopeCentPerSecond: maximumObserved,
        maxSlopeCentPerSecond: PITCH_CORRECTION_POLICY.maxSlopeCentPerSecond,
        policyVersion: PITCH_CORRECTION_POLICY.version,
      },
    );
  }
}

function buildCorrectionCurves({ solved, localBlicks, currentPitchDeltaCent, baseline }) {
  const curves = [];
  for (const run of solved.runs) {
    const points = [];
    for (let index = run.start; index < run.endExclusive; index += 1) {
      const localBlick = localBlicks[index];
      const finalValue = currentPitchDeltaCent[index] + solved.correctionCent[index];
      if (!Number.isSafeInteger(localBlick) || !Number.isFinite(finalValue)) throw correctionOverflow();
      if (Math.abs(finalValue) > PITCH_DELTA_LIMIT_CENT) {
        throw codedError(
          "PITCH_DELTA_RANGE_EXCEEDED",
          "projected pitchDelta exceeds the supported Automation range",
          { index, finalValue, maximumAbsCents: PITCH_DELTA_LIMIT_CENT },
        );
      }
      if (points.length > 0 && localBlick <= points.at(-1).blick) {
        throw codedError(
          "SAMPLING_GRID_MISALIGNED",
          "multiple correction samples collapse to one local BLICK",
          { index, localBlick },
        );
      }
      points.push({ blick: localBlick, value: quantize(finalValue) });
    }
    if (points.length < 2) {
      throw codedError(
        "CORRECTION_TIME_RESOLUTION_TOO_COARSE",
        "an eligible correction run cannot form a non-empty bounded Automation range",
        { start: run.start, endExclusive: run.endExclusive },
      );
    }
    if (points.length > PITCH_CORRECTION_POLICY.maxPointsPerCurve) {
      throw codedError(
        "PITCH_DELTA_CURVE_POINT_BUDGET_EXCEEDED",
        "one correction run exceeds the per-curve point budget",
        { maximum: PITCH_CORRECTION_POLICY.maxPointsPerCurve, actual: points.length },
      );
    }
    const curve = {
      parameter: "pitchDelta",
      mode: "replace",
      range: {
        fromBlick: points[0].blick,
        toBlick: points.at(-1).blick,
        coordinate: "local",
      },
      points: encodeDense(points, CORRECTION_CURVE_PROFILE),
    };
    const hostInterpolation = maybeBuildHostInterpolation(baseline, points);
    curves.push({
      ...(hostInterpolation ? { ...curve, hostInterpolation } : curve),
      pointCount: points.length,
    });
  }
  return curves;
}

function maybeBuildHostInterpolation(baseline, points) {
  const mandatorySamples = samplePoints(points, 256);
  const adaptiveMidpoints = buildAdaptiveMidpoints(baseline, points, mandatorySamples);
  if (mandatorySamples.length < 2 || adaptiveMidpoints.length === 0) return null;
  return buildHostInterpolationPostcondition({
    interpolationEvidence: baseline.interpolationEvidence,
    baselineSamples: mandatorySamples.map((point) => ({
      blick: point.blick,
      value: evaluateCapturedAutomation(baseline, point.blick),
    })),
    mandatorySamples,
    adaptiveMidpoints,
    maxFitErrorCent: 1,
  });
}

function samplePoints(points, maximum) {
  if (points.length <= maximum) return points.map((point) => ({ ...point }));
  const sampled = [];
  for (let index = 0; index < maximum; index += 1) {
    sampled.push({ ...points[Math.round(index * (points.length - 1) / (maximum - 1))] });
  }
  return sampled;
}

function buildAdaptiveMidpoints(baseline, points, mandatorySamples) {
  const mandatoryBlicks = new Set(mandatorySamples.map((sample) => sample.blick));
  const candidates = [];
  for (let index = 1; index < points.length; index += 1) {
    const left = points[index - 1];
    const right = points[index];
    if (right.blick - left.blick < 2) continue;
    const blick = left.blick + Math.floor((right.blick - left.blick) / 2);
    if (mandatoryBlicks.has(blick)) continue;
    candidates.push({
      blick,
      leftBlick: left.blick,
      rightBlick: right.blick,
      value: evaluateAutomationPoints({
        method: baseline.method,
        defaultValue: baseline.defaultValue,
        points,
        blick,
      }),
    });
  }
  candidates.sort((left, right) => (
    (right.rightBlick - right.leftBlick) - (left.rightBlick - left.leftBlick)
    || left.blick - right.blick
  ));
  return candidates
    .slice(0, 128)
    .sort((left, right) => left.blick - right.blick);
}

function sealCorrectionPlan({
  input,
  source,
  observed,
  solved,
  targetTimes,
  observedComputedMidi,
  currentPitchDeltaCent,
  objective,
  correction,
  curves,
  artifactStore,
  sessionId,
}) {
  if (!artifactStore || !sessionId) throw planSealError();
  const curveRequests = curves.map(({ pointCount: _pointCount, ...curve }) => curve);
  const planId = `correction_${canonicalHashHex({
    sourcePlanRef: input.sourcePlanRef,
    observedContextId: input.observedContextId,
    evidence: input.evidence,
    regularization: input.regularization,
    curves: curveRequests,
  }).slice(0, 16)}`;
  const expectedNotes = source.expectedNotes;
  const mutationRequest = {
    target: {
      contextId: observed.stored.contextId,
      occurrence: observed.ordinal,
      expectedGroupUuid: source.occurrence.targetGroupUuid,
      expectedTimeOffsetBlick: source.occurrence.timeOffsetBlick,
      ...(expectedNotes.length > 0 ? { expectedNotes } : {}),
    },
    curves: curveRequests,
    action: "dry_run",
    atomic: true,
    undoLabel: `sv_plan_pitch_correction ${planId}`,
  };
  let artifact;
  try {
    const sealed = buildPlanArtifact({
      targetTool: "sv_patch_parameter_curves",
      mutationRequest,
      targetGroupUuid: source.occurrence.targetGroupUuid,
      occurrence: observed.ordinal,
      expectedTimeOffsetBlick: source.occurrence.timeOffsetBlick,
      fingerprints: expectedNotes.length > 0 ? { expectedNotes } : {},
      capsule: {
        stored: observed.stored,
        occurrence: observed.occurrence,
        ...(expectedNotes.length > 0
          ? { noteIndexes: expectedNotes.map((note) => note.indexInGroup) }
          : {}),
      },
    });
    sealed.payload.pitchCorrection = {
      schemaVersion: 1,
      planId,
      iterationBasis: "single_open_loop_step",
      sourcePlanRef: input.sourcePlanRef,
      sourcePlanContentHash: source.artifact.contentHash,
      targetGrid: source.target.grid,
      evidence: input.evidence,
      regularization: input.regularization,
      policy: PITCH_CORRECTION_POLICY,
      runs: solved.runs,
      skippedRuns: solved.skippedRuns,
      objective,
      correction: { ...correction, clampedPoints: solved.clampedPoints },
      dense: {
        targetAbsoluteCent: encodeFrameSeries(source.target.values, "target-absolute-cent", "cent"),
        observedComputedMidi: encodeFrameSeries(observedComputedMidi, "observed-computed-midi", "midi"),
        currentPitchDeltaCent: encodeFrameSeries(currentPitchDeltaCent, "current-pitch-delta-cent", "cent"),
        correctionCent: encodeFrameSeries(solved.correctionCent, "correction-cent", "cent"),
      },
      targetTimes: encodeFrameSeries(targetTimes, "target-seconds", "second"),
    };
    artifact = artifactStore.seal({
      kind: "plan",
      schemaVersion: "1",
      sessionId,
      sourceEpoch: observed.stored.epoch,
      payload: sealed.payload,
    });
  } catch (error) {
    throw planSealError(error);
  }
  const apply = sealApplyEnvelope(
    buildApplyEnvelope([
      { tool: "sv_patch_parameter_curves", arguments: mutationRequest },
    ], {
      sharedTargetConfirmationRequired: (observed.occurrence.sharedTargetOccurrences ?? []).length > 1,
    }),
    planReference(artifact),
    artifact.expiresAt,
  );
  return {
    ok: true,
    status: "planned",
    effects: "none",
    data: {
      iterationBasis: "single_open_loop_step",
      runs: { solved: solved.runs.length, skipped: solved.skippedRuns.length },
      frames: {
        total: source.target.grid.frames,
        finite: solved.finiteCount,
        coverage: solved.coverage,
      },
      objective,
      correction: {
        points: correction.points,
        maxAbsCent: correction.maxAbsCent,
        clampedPoints: solved.clampedPoints,
        maxSlopeCentPerSecond: PITCH_CORRECTION_POLICY.maxSlopeCentPerSecond,
        policyVersion: PITCH_CORRECTION_POLICY.version,
      },
    },
    apply,
    warnings: [{
      code: "PREDICTED_IMPROVEMENT_ONLY",
      message: "predictedRmseCent is a model prediction; re-snapshot and compare computed pitch after commit to measure observed improvement.",
    }],
  };
}

function encodeFrameSeries(values, kind, unit) {
  const profile = {
    schemaVersion: CORRECTION_DENSE_SCHEMA_VERSION,
    kind: `pitch-correction-${kind}`,
    maxRows: PITCH_CORRECTION_POLICY.maxTotalPoints,
    columns: [
      { name: "frame", type: "integer", encoding: "delta" },
      {
        name: "value",
        unit,
        type: "number",
        encoding: "qint",
        scale: unit === "second" ? 1e-9 : CENT_QUANTUM,
        maxError: unit === "second" ? 5e-10 : CENT_QUANTUM / 2,
      },
    ],
  };
  return encodeDense(
    values.flatMap((value, frame) => (Number.isFinite(value) ? [{ frame, value }] : [])),
    profile,
  );
}

function insufficientEvidenceResponse(details, totalFrames) {
  return {
    ok: true,
    status: "insufficient_evidence",
    effects: "none",
    data: {
      iterationBasis: "single_open_loop_step",
      runs: {
        solved: 0,
        skipped: details?.skippedRuns?.length ?? 0,
      },
      frames: {
        total: totalFrames,
        finite: details?.observedFiniteFrames ?? 0,
        coverage: details?.observedCoverage ?? 0,
      },
      evidence: {
        code: "INSUFFICIENT_COMPUTED_PITCH",
        ...(details ?? {}),
      },
    },
    apply: null,
  };
}

function noChangeResponse({ solved, objective, correction, totalFrames }) {
  return {
    ok: true,
    status: "no_change",
    effects: "none",
    data: {
      iterationBasis: "single_open_loop_step",
      runs: { solved: solved.runs.length, skipped: solved.skippedRuns.length },
      frames: { total: totalFrames, finite: solved.finiteCount, coverage: solved.coverage },
      objective,
      correction: {
        points: 0,
        maxAbsCent: correction.maxAbsCent,
        clampedPoints: solved.clampedPoints,
        minimumWriteAbsCent: PITCH_CORRECTION_POLICY.minimumWriteAbsCent,
      },
    },
    apply: null,
  };
}

function checkedNumber(value, minimum, maximum, fallback, label) {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw codedError("INVALID_ARGUMENTS", `${label} must be a number between ${minimum} and ${maximum}`);
  }
  return value;
}

function checkedInteger(value, minimum, maximum, fallback, label) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw codedError("INVALID_ARGUMENTS", `${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function requireFinite(label, value) {
  if (!Number.isFinite(value)) throw codedError("INVALID_ARGUMENTS", `${label} must be finite`);
}

function requirePositive(label, value) {
  if (!Number.isFinite(value) || value <= 0) {
    throw codedError("INVALID_ARGUMENTS", `${label} must be positive and finite`);
  }
}

function requireAtLeast(label, value, minimum) {
  if (!Number.isFinite(value) || value < minimum) {
    throw codedError("INVALID_ARGUMENTS", `${label} must be finite and >= ${minimum}`);
  }
}

function rmse(values) {
  if (values.length === 0) return Infinity;
  const sum = values.reduce((total, value) => total + value ** 2, 0);
  const result = Math.sqrt(sum / values.length);
  if (!Number.isFinite(result)) throw correctionOverflow();
  return result;
}

function quantize(value) {
  const result = Number((Math.round(value / CENT_QUANTUM) * CENT_QUANTUM).toFixed(6));
  return Object.is(result, -0) ? 0 : result;
}

function sameSeconds(left, right) {
  return Math.abs(left - right) <= TIME_EPSILON_SECONDS;
}

function sameIntegerArray(left, right) {
  return left.length === right.length && left.every((value, index) => (
    Number.isSafeInteger(value) && value === right[index]
  ));
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function correctionOverflow() {
  return codedError("CORRECTION_NUMERIC_OVERFLOW", "correction arithmetic exceeds the finite numeric domain");
}

function assertKnownKeys(value, allowed, label) {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw codedError("INVALID_ARGUMENTS", `${label} contains unknown field: ${unknown.join(", ")}`, { unknown });
  }
}
