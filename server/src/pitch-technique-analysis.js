import { artifactReference } from "./artifact-store.js";
import { contentHash } from "./canonical-json.js";
import {
  COMPARE_ANALYSIS_DEFAULTS,
  detectVibrato,
} from "./computed-pitch-compare.js";
import { getStoredComputedPitch } from "./musical-range.js";
import { secondsAtBlick } from "./musical-time.js";
import { transientFromFirstPeak } from "./pitch-techniques/second-order.js";
import {
  FIT_WORKER_LIMITS,
  fitRichardsSegment,
  revalidateFitWorkerResult,
} from "./pitch-techniques/fit-worker.js";
import { richardsTransition } from "./pitch-techniques/richards.js";
import { buildUniformSecondsGrid } from "./pitch-techniques/time-grid.js";
import { ServiceTiming } from "./service-timing.js";
import { selectOccurrenceByOrdinal } from "./scope-source.js";
import {
  analyzeVocalEventSequence,
  summarizeExcludedVocalEvents,
} from "./vocal-event-semantics.js";
import { unknownContextError } from "./snapshot.js";

export const PITCH_TECHNIQUE_ANALYSIS_VERSION = 1;

export const PITCH_TECHNIQUE_ANALYSIS_DEFAULTS = Object.freeze({
  maxCandidates: 12,
  maximumCandidates: 32,
  minimumCoverage: 0.7,
  minimumFiniteFrames: 11,
  maxBoundaryWindows: 32,
  transition: Object.freeze({
    maxHalfWindowSeconds: 0.25,
    minimumWindowSeconds: 0.08,
    minimumScoreStepCents: 25,
    minimumObservedMoveCents: 20,
    maximumEndpointMismatchCents: 120,
    minimumRmseImprovementCents: 2,
    minimumRmseImprovementRatio: 0.1,
  }),
  transient: Object.freeze({
    maxSpanSeconds: 0.5,
    minimumPeakCents: 10,
    minimumRmseImprovementCents: 2,
    minimumRmseImprovementRatio: 0.15,
    dampingRatios: Object.freeze([0.5422, 0.6681]),
    maximumPeakSemitone: 1.5,
    maximumPeakTimeCandidates: 16,
  }),
  vibrato: Object.freeze({
    ...COMPARE_ANALYSIS_DEFAULTS.vibrato,
    minimumDepthCents: 5,
  }),
});

const PROVENANCE = Object.freeze({
  input: "captured_computed_pitch_only",
  hostAccess: "none_pure_in_memory_over_snapshot_store",
  timeAxis: "uniform_seconds_linear_within_finite_run",
  scoreReference: "note_pitch_plus_detune_plus_occurrence_pitch_offset",
  vibrato: "detrended_autocorrelation_then_linear_sine_projection",
  transition: "score_informed_adjacent_window_bounded_richards_fit",
  transient: "bounded_first_peak_second_order_grid_fit",
  jointRefinement: "bounded_nonoverlap_model_evaluation",
  fitWorker: "node_bounded_richards_v1_revalidated",
  confidence: "heuristic_score_not_probability",
  perception: "human_only",
});

const CANDIDATE_KIND_ORDER = new Map([
  ["transition", 0],
  ["transient", 1],
  ["vibrato", 2],
]);
const TIME_EPSILON_SECONDS = 1e-9;

/**
 * 从已捕获的 computed pitch 中分解可解释的音高技法。
 *
 * 此服务只读取 SnapshotStore，并强制把 dense 轨迹和 solver 证据封存到 Artifact。
 */
export class PitchTechniqueAnalysisService {
  constructor({
    store,
    artifactStore,
    sessionId,
    now = () => Date.now(),
    fitRichards = fitRichardsSegment,
    revalidateFit = revalidateFitWorkerResult,
  } = {}) {
    if (!store) {
      throw new Error("PitchTechniqueAnalysisService requires the shared SnapshotStore");
    }
    if (!artifactStore || !sessionId) {
      throw new Error(
        "PitchTechniqueAnalysisService requires ArtifactStore and sessionId for dense evidence"
      );
    }
    if (typeof fitRichards !== "function" || typeof revalidateFit !== "function") {
      throw new Error("PitchTechniqueAnalysisService requires FitWorker functions");
    }
    this.store = store;
    this.artifactStore = artifactStore;
    this.sessionId = sessionId;
    this.now = now;
    this.fitRichards = fitRichards;
    this.revalidateFit = revalidateFit;
  }

  async analyze(request = {}) {
    const timer = new ServiceTiming({
      now: this.now,
      phaseNames: ["loadMs", "gridMs", "fitMs", "artifactMs"],
    });
    const input = normalizeRequest(request);
    // 这是纯内存读：显式登记协调器请求但永远不获取宿主锁，timing 因而可证明零宿主控制。
    timer.requestCoordinator();
    const warnings = [];
    const loaded = await timer.measure("loadMs", async () =>
      resolveAnalysisSource(this.store, input)
    );

    let canonical;
    if (loaded.melodicNotes.length === 0) {
      canonical = noMelodicCanonical(loaded);
    } else {
      const grid = await timer.measure("gridMs", async () => buildGrid(loaded));
      canonical = await timer.measure("fitMs", async () =>
        analyzeGrid({
          loaded,
          grid,
          fitRichards: this.fitRichards,
          revalidateFit: this.revalidateFit,
          warnings,
        })
      );
    }

    const analysisHash = contentHash(canonical);
    const artifact = await timer.measure("artifactMs", async () =>
      this.artifactStore.seal({
        kind: "pitch-technique-analysis",
        schemaVersion: String(PITCH_TECHNIQUE_ANALYSIS_VERSION),
        sessionId: this.sessionId,
        sourceEpoch: loaded.stored.epoch,
        payload: {
          schemaVersion: PITCH_TECHNIQUE_ANALYSIS_VERSION,
          analysisHash,
          source: publicSource(loaded),
          // 只登记真正影响分析的请求字段。maxCandidates 纯粹是紧凑响应的投影宽度，
          // 写进封存证据会让同一份分析因请求不同而产生不同的 artifact 字节与 hash。
          // occurrence 可缺省，必须整键省略而不是写入 undefined（canonical JSON 拒绝它）。
          request: {
            contextId: input.contextId,
            ...(input.occurrence === undefined ? {} : { occurrence: input.occurrence }),
          },
          ...canonical,
        },
      })
    );
    const artifactRef = artifactReference(artifact);
    const compact = compactAnalysis(canonical, input.maxCandidates);

    return {
      status: "succeeded",
      data: {
        contextId: loaded.stored.contextId,
        occurrence: publicOccurrence(loaded.occurrence, loaded.occurrenceOrdinal),
        analysisHash,
        inputNoteCount: loaded.inputNoteCount,
        melodicNoteCount: loaded.melodicNotes.length,
        excludedEvents: loaded.excludedEvents,
        sampling: compact.sampling,
        summary: compact.summary,
        candidates: compact.candidates,
        rejected: compact.rejected,
        artifactRef,
        provenance: PROVENANCE,
      },
      ...(warnings.length > 0 ? { warnings } : {}),
      timing: timer.finish(),
    };
  }
}

// ---------- Context 与采样证据 ----------

function normalizeRequest(request) {
  if (!isRecord(request)) {
    throw codedError("INVALID_ARGUMENTS", "request must be an object");
  }
  assertKnownKeys(request, ["contextId", "occurrence", "maxCandidates"], "request");
  if (typeof request.contextId !== "string" || request.contextId.length === 0) {
    throw codedError("INVALID_ARGUMENTS", "contextId must be a non-empty string");
  }
  if (
    request.occurrence !== undefined &&
    (!Number.isSafeInteger(request.occurrence) || request.occurrence < 0)
  ) {
    throw codedError(
      "INVALID_ARGUMENTS",
      "occurrence must be a non-negative safe integer when provided"
    );
  }
  const maxCandidates = checkedInteger(
    request.maxCandidates,
    1,
    PITCH_TECHNIQUE_ANALYSIS_DEFAULTS.maximumCandidates,
    PITCH_TECHNIQUE_ANALYSIS_DEFAULTS.maxCandidates,
    "maxCandidates"
  );
  return {
    contextId: request.contextId,
    ...(request.occurrence === undefined ? {} : { occurrence: request.occurrence }),
    maxCandidates,
  };
}

function resolveAnalysisSource(store, input) {
  const stored = store.get(input.contextId);
  if (!stored) throw unknownContextError(store, input.contextId);
  if (stored.context?.kind !== "range") {
    throw codedError(
      "INVALID_CONTEXT",
      'sv_analyze_pitch_techniques needs a range context from sv_snapshot_range with include ["notes","computedPitch"]'
    );
  }
  const computedPitchByOccurrence = stored.context.computedPitchByOccurrence;
  if (!computedPitchByOccurrence) {
    throw captureRequiredError("COMPUTED_PITCH_NOT_CAPTURED");
  }
  const { occurrence, ordinal } = selectOccurrenceByOrdinal(
    stored.context.occurrences,
    input.occurrence,
    {
      eligible: (item) =>
        Array.isArray(item.noteFingerprints) &&
        item.noteFingerprints.length > 0 &&
        Object.hasOwn(computedPitchByOccurrence, item.occurrence),
      noneCode: "COMPUTED_PITCH_NOT_CAPTURED",
      noneMessage:
        'no occurrence has both notes and computed pitch; re-run sv_snapshot_range with include ["notes","computedPitch"]',
      ambiguousMessage:
        "range context has multiple usable occurrences; pass one occurrence ordinal",
      ineligibleCode: "COMPUTED_PITCH_NOT_CAPTURED",
      ineligibleMessage:
        'occurrence is missing notes or computed pitch; re-run sv_snapshot_range with include ["notes","computedPitch"]',
    }
  );
  const series = getStoredComputedPitch(stored, ordinal);
  if (!series) throw captureRequiredError("COMPUTED_PITCH_NOT_CAPTURED");
  assertComputedPitchProvenance(series);
  if (!Number.isSafeInteger(stored.context.quarterBlick) || stored.context.quarterBlick <= 0) {
    throw codedError("INVALID_CONTEXT", "context is missing a usable SV.QUARTER timebase");
  }
  if (!Array.isArray(stored.context.tempoMarks)) {
    throw codedError("INVALID_CONTEXT", "context is missing captured tempo marks");
  }
  const noteData = buildNotes(occurrence, stored.context);
  const sequence = analyzeVocalEventSequence(noteData.notes);
  const melodicNotes = sequence.events
    .filter((event) => event.melodicEligible)
    .map((event) => event.note);
  return {
    stored,
    occurrence,
    occurrenceOrdinal: ordinal,
    series,
    inputNoteCount: noteData.notes.length,
    melodicNotes,
    excludedEvents: summarizeExcludedVocalEvents(sequence.events),
    semanticIssues: sequence.issues,
  };
}

function assertComputedPitchProvenance(series) {
  const evidence = series?.evidence;
  const values = series?.values;
  if (
    !Number.isSafeInteger(series?.startBlick) ||
    series.startBlick < 0 ||
    !Number.isSafeInteger(series?.intervalBlick) ||
    series.intervalBlick < 1 ||
    !Number.isSafeInteger(series?.frames) ||
    series.frames < 1 ||
    !Array.isArray(values) ||
    values.length !== series.frames ||
    !isRecord(evidence) ||
    !Number.isSafeInteger(evidence.requestedFrames) ||
    !Number.isSafeInteger(evidence.observedFrames) ||
    !Array.isArray(evidence.nullFrameIndices)
  ) {
    throw insufficientEvidenceError("sampling_provenance_incomplete", {
      required: ["startBlick", "intervalBlick", "frames", "values", "evidence"],
    });
  }
  const finiteFrames = values.filter(Number.isFinite).length;
  const nullFrameIndices = values.flatMap((value, index) => (
    Number.isFinite(value) ? [] : [index]
  ));
  if (
    evidence.requestedFrames !== series.frames ||
    evidence.observedFrames !== finiteFrames ||
    !sameIntegerArray(evidence.nullFrameIndices, nullFrameIndices)
  ) {
    throw insufficientEvidenceError("sampling_provenance_incomplete", {
      expected: {
        requestedFrames: series.frames,
        observedFrames: finiteFrames,
        nullFrameIndices,
      },
      observed: evidence,
    });
  }
}

function buildNotes(occurrence, context) {
  const timeOffsetBlick = occurrence.timeOffsetBlick ?? 0;
  const pitchOffsetSemitone = occurrence.pitchOffsetSemitone ?? 0;
  if (!Number.isSafeInteger(timeOffsetBlick) || !Number.isFinite(pitchOffsetSemitone)) {
    throw codedError("INVALID_CONTEXT", "occurrence is missing usable time or pitch offsets");
  }
  const notes = (occurrence.noteFingerprints ?? [])
    .map((fingerprint) => {
      const detuneCents = fingerprint.detuneCents ?? 0;
      const absOnsetBlick = timeOffsetBlick + fingerprint.onsetBlick;
      const absEndBlick = absOnsetBlick + fingerprint.durationBlick;
      if (
        !Number.isSafeInteger(fingerprint.indexInGroup) ||
        !Number.isSafeInteger(absOnsetBlick) ||
        !Number.isSafeInteger(absEndBlick) ||
        absEndBlick <= absOnsetBlick ||
        !Number.isFinite(fingerprint.pitch) ||
        !Number.isFinite(detuneCents)
      ) {
        throw codedError("INVALID_CONTEXT", "note fingerprints are incomplete for pitch-technique analysis");
      }
      return {
        indexInGroup: fingerprint.indexInGroup,
        lyrics: fingerprint.lyrics ?? "",
        absOnsetBlick,
        absEndBlick,
        onsetSeconds: secondsAtBlick(
          context.tempoMarks,
          context.quarterBlick,
          absOnsetBlick
        ),
        endSeconds: secondsAtBlick(
          context.tempoMarks,
          context.quarterBlick,
          absEndBlick
        ),
        targetSemitone: fingerprint.pitch + detuneCents / 100 + pitchOffsetSemitone,
      };
    })
    .sort((left, right) => left.absOnsetBlick - right.absOnsetBlick);
  return { notes };
}

function buildGrid(loaded) {
  const grid = buildUniformSecondsGrid({
    startBlick: loaded.series.startBlick,
    intervalBlick: loaded.series.intervalBlick,
    values: loaded.series.values,
    tempoMarks: loaded.stored.context.tempoMarks,
    quarterBlick: loaded.stored.context.quarterBlick,
  });
  if (grid.status !== "ready") {
    throw insufficientEvidenceError("seconds_axis_unavailable", {
      timeGridReason: grid.reason,
      source: grid.source,
    });
  }
  return grid;
}

function noMelodicCanonical(loaded) {
  return {
    analysisStatus: "no_technique_candidate",
    reasonCode: "NO_TECHNIQUE_CANDIDATE",
    sampling: {
      status: "not_applicable_no_melodic_notes",
      source: {
        frames: loaded.series.frames,
        finiteFrames: loaded.series.values.filter(Number.isFinite).length,
      },
    },
    summary: {
      candidateCount: 0,
      candidateWindows: { considered: 0, total: 0, truncated: false },
    },
    candidates: [],
    rejected: [],
    dense: null,
    solver: [],
  };
}

// ---------- 前向分解 ----------

// 刻意不接收 request/input：分析范围完全由乐句证据与固定的 maxBoundaryWindows 决定。
// 少一个参数就少一条把投影宽度重新泄漏回分析的路径。
async function analyzeGrid({
  loaded,
  grid,
  fitRichards,
  revalidateFit,
  warnings,
}) {
  const baseline = buildScoreBaseline(grid, loaded.melodicNotes);
  const finiteFrames = baseline.frameNoteIndexes.filter((noteIndex, index) => (
    noteIndex !== null && Number.isFinite(grid.values[index])
  )).length;
  const coverage = baseline.eligibleFrameCount > 0
    ? finiteFrames / baseline.eligibleFrameCount
    : 0;
  if (finiteFrames === 0) {
    throw insufficientEvidenceError("all_frames_null_or_processing_pending", {
      eligibleFrameCount: baseline.eligibleFrameCount,
      finiteFrameCount: finiteFrames,
      remedy: waitForProcessingRemedy(loaded),
    });
  }
  if (
    finiteFrames < PITCH_TECHNIQUE_ANALYSIS_DEFAULTS.minimumFiniteFrames ||
    coverage < PITCH_TECHNIQUE_ANALYSIS_DEFAULTS.minimumCoverage
  ) {
    throw insufficientEvidenceError("low_coverage_or_fragmented", {
      eligibleFrameCount: baseline.eligibleFrameCount,
      finiteFrameCount: finiteFrames,
      coverage,
      minimumCoverage: PITCH_TECHNIQUE_ANALYSIS_DEFAULTS.minimumCoverage,
      minimumFiniteFrames: PITCH_TECHNIQUE_ANALYSIS_DEFAULTS.minimumFiniteFrames,
      remedy: waitForProcessingRemedy(loaded),
    });
  }
  const minimumVibratoSampleRate =
    PITCH_TECHNIQUE_ANALYSIS_DEFAULTS.vibrato.hzRange[1] * 2;
  if (grid.sampleRateHz < minimumVibratoSampleRate) {
    const error = codedError(
      "SAMPLING_RATE_TOO_LOW",
      "computed-pitch sampling is too coarse for the mandatory vibrato-flattening stage"
    );
    error.details = {
      sampleRateHz: grid.sampleRateHz,
      minimumSampleRateHz: minimumVibratoSampleRate,
      remedy: recaptureRemedy(),
    };
    throw error;
  }

  const observedCents = grid.values.map((value) => (
    Number.isFinite(value) ? value * 100 : null
  ));
  const rejected = [];
  const solver = [];
  const vibrato = analyzeVibratoCandidates({
    grid,
    baseline,
    notes: loaded.melodicNotes,
    observedCents,
    rejected,
  });
  const flattenedCents = observedCents.map((value, index) => (
    Number.isFinite(value) ? value - vibrato.contributions[index] : null
  ));

  // 分析范围与 maxCandidates 解耦：maxCandidates 只裁剪紧凑响应的投影条数，绝不改变
  // 实际检查了多少个音符边界。否则调用方为省字节调小它，会静默缩小音乐覆盖范围，
  // 而封存 Artifact 里也同样缺少这些技法——那是"读少了"伪装成"没有技法"。
  const boundaryLimit = PITCH_TECHNIQUE_ANALYSIS_DEFAULTS.maxBoundaryWindows;
  const transitionResult = await analyzeTransitionCandidates({
    notes: loaded.melodicNotes,
    grid,
    baseline,
    flattenedCents,
    boundaryLimit,
    fitRichards,
    revalidateFit,
    rejected,
    solver,
  });
  const selectedTransitions = appendNonOverlappingStructuralCandidates(
    [],
    transitionResult.accepted,
    rejected
  );
  const transitionContributions = contributionsForCandidates(
    grid.frames,
    selectedTransitions
  );
  const residualAfterTransitions = observedCents.map((value, index) => {
    if (!Number.isFinite(value) || baseline.scoreCents[index] === null) return null;
    return value
      - vibrato.contributions[index]
      - baseline.scoreCents[index]
      - transitionContributions[index];
  });

  const transientResult = analyzeTransientCandidates({
    notes: loaded.melodicNotes,
    grid,
    baseline,
    residualCents: residualAfterTransitions,
    boundaryLimit,
    rejected,
  });
  const selectedStructural = appendNonOverlappingStructuralCandidates(
    selectedTransitions,
    transientResult.accepted,
    rejected
  );
  const selectedTransitionIds = new Set(
    selectedStructural.filter((candidate) => candidate.kind === "transition").map((candidate) => candidate.id)
  );
  const finalTransitions = selectedTransitions.filter((candidate) => selectedTransitionIds.has(candidate.id));
  const finalTransients = selectedStructural.filter((candidate) => candidate.kind === "transient");
  const finalTransitionContributions = contributionsForCandidates(grid.frames, finalTransitions);
  const transientContributions = contributionsForCandidates(grid.frames, finalTransients);
  const allCandidates = [
    ...finalTransitions,
    ...finalTransients,
    ...vibrato.accepted,
  ].sort(compareCandidates);
  const reconstruction = buildReconstruction({
    baseline,
    vibratoContributions: vibrato.contributions,
    transitionContributions: finalTransitionContributions,
    transientContributions,
    observedCents,
  });
  const candidateWindows = {
    considered: Math.max(
      transitionResult.consideredBoundaries,
      transientResult.consideredBoundaries
    ),
    total: Math.max(
      transitionResult.totalBoundaries,
      transientResult.totalBoundaries
    ),
    truncated:
      transitionResult.truncatedBoundaries ||
      transientResult.truncatedBoundaries,
  };
  if (candidateWindows.truncated) {
    warnings.push({
      code: "CANDIDATE_WINDOWS_TRUNCATED",
      message:
        "analysis examined a bounded prefix of adjacent note boundaries; narrow the snapshot range for exhaustive phrase coverage.",
    });
  }

  return {
    analysisStatus:
      allCandidates.length > 0 ? "candidates_found" : "no_technique_candidate",
    ...(allCandidates.length === 0 ? { reasonCode: "NO_TECHNIQUE_CANDIDATE" } : {}),
    sampling: publicSampling(grid, baseline, finiteFrames, coverage),
    // canonical 分析不含任何投影字段：candidateCount 与 candidateWindows 描述真实
    // 分析范围，因此 analysisHash 只随乐句证据变化，不随 maxCandidates 变化。
    summary: {
      candidateCount: allCandidates.length,
      candidateWindows,
      jointModel: summarizeJointModel(reconstruction),
    },
    candidates: allCandidates,
    rejected,
    dense: {
      timeSeconds: [...grid.timeSeconds],
      blicks: grid.blicks.map((blick) => Math.round(blick)),
      observedCents,
      scoreCents: baseline.scoreCents,
      vibratoFlattenedCents: flattenedCents,
      reconstructedCents: reconstruction.values,
      residualCents: reconstruction.residualCents,
      validMask: reconstruction.validMask,
    },
    solver,
  };
}

function buildScoreBaseline(grid, notes) {
  const frameNoteIndexes = new Array(grid.frames).fill(null);
  const scoreCents = new Array(grid.frames).fill(null);
  let eligibleFrameCount = 0;
  let cursor = 0;
  for (let index = 0; index < grid.frames; index += 1) {
    const seconds = grid.timeSeconds[index];
    while (
      cursor < notes.length &&
      seconds >= notes[cursor].endSeconds - TIME_EPSILON_SECONDS
    ) {
      cursor += 1;
    }
    const note = notes[cursor];
    if (
      !note ||
      seconds < note.onsetSeconds - TIME_EPSILON_SECONDS ||
      seconds >= note.endSeconds - TIME_EPSILON_SECONDS
    ) {
      continue;
    }
    frameNoteIndexes[index] = cursor;
    scoreCents[index] = note.targetSemitone * 100;
    eligibleFrameCount += 1;
  }
  return { frameNoteIndexes, scoreCents, eligibleFrameCount };
}

function analyzeVibratoCandidates({ grid, baseline, notes, observedCents, rejected }) {
  const contributions = new Array(grid.frames).fill(0);
  const accepted = [];
  const noteIndexes = new Map();
  for (const [frameIndex, noteIndex] of baseline.frameNoteIndexes.entries()) {
    if (noteIndex === null) continue;
    if (!noteIndexes.has(noteIndex)) noteIndexes.set(noteIndex, []);
    noteIndexes.get(noteIndex).push(frameIndex);
  }
  for (const [noteIndex, indexes] of noteIndexes.entries()) {
    const note = notes[noteIndex];
    const run = longestFiniteFrameRun(indexes, observedCents, baseline.scoreCents);
    if (run.length === 0) {
      rejected.push(rejection("vibrato", "INSUFFICIENT_COMPUTED_PITCH", {
        note: note.indexInGroup,
        reason: "no_finite_run",
      }));
      continue;
    }
    const residual = run.map((index) => observedCents[index] - baseline.scoreCents[index]);
    const detection = detectVibrato(
      residual,
      grid.sampleRateHz,
      PITCH_TECHNIQUE_ANALYSIS_DEFAULTS.vibrato
    );
    if (detection.status !== "ok") {
      rejected.push(rejection("vibrato", "NO_TECHNIQUE_CANDIDATE", {
        note: note.indexInGroup,
        reason: detection.status,
      }));
      continue;
    }
    const sine = fitLinearSine(
      run.map((index) => grid.timeSeconds[index]),
      residual,
      detection.rateHz
    );
    if (!sine || sine.depthCents < PITCH_TECHNIQUE_ANALYSIS_DEFAULTS.vibrato.minimumDepthCents) {
      rejected.push(rejection("vibrato", "MODEL_NOT_IDENTIFIABLE", {
        note: note.indexInGroup,
        reason: sine ? "depth_below_threshold" : "sine_projection_singular",
      }));
      continue;
    }
    const vibratoCandidate = candidate({
      id: "vibrato:" + note.indexInGroup,
      kind: "vibrato",
      anchors: { note: note.indexInGroup },
      span: {
        fromSeconds: grid.timeSeconds[run[0]],
        toSeconds: grid.timeSeconds[run.at(-1)],
      },
      parameters: {
        rateHz: detection.rateHz,
        depthSemitone: sine.depthCents / 100,
        phaseRad: sine.phaseRad,
        centerCents: sine.centerCents,
        centerDriftCentsPerSecond: sine.slopeCentsPerSecond,
      },
      confidence: {
        score: detection.confidence.score,
        kind: "heuristic_score",
        calibrated: false,
      },
      evidence: {
        finiteFrames: run.length,
        rateHz: detection.rateHz,
        depthCents: sine.depthCents,
        regularity: detection.regularity,
        projectionRmseCents: sine.rmseCents,
      },
      contribution: run.map((index, localIndex) => ({
        index,
        cents: sine.oscillationCents[localIndex],
      })),
    });
    for (const point of vibratoCandidate.contribution) contributions[point.index] += point.cents;
    accepted.push(vibratoCandidate);
  }
  return { accepted, contributions };
}

async function analyzeTransitionCandidates({
  notes,
  grid,
  baseline,
  flattenedCents,
  boundaryLimit,
  fitRichards,
  revalidateFit,
  rejected,
  solver,
}) {
  const accepted = [];
  const totalBoundaries = Math.max(0, notes.length - 1);
  let consideredBoundaries = 0;
  for (let index = 0; index < totalBoundaries && consideredBoundaries < boundaryLimit; index += 1) {
    const from = notes[index];
    const to = notes[index + 1];
    if (from.absEndBlick !== to.absOnsetBlick) {
      rejected.push(rejection("transition", "TRANSITION_NOT_ADJACENT", {
        fromNote: from.indexInGroup,
        toNote: to.indexInGroup,
      }));
      continue;
    }
    consideredBoundaries += 1;
    const scoreStepCents = (to.targetSemitone - from.targetSemitone) * 100;
    if (Math.abs(scoreStepCents) < PITCH_TECHNIQUE_ANALYSIS_DEFAULTS.transition.minimumScoreStepCents) {
      rejected.push(rejection("transition", "NO_TECHNIQUE_CANDIDATE", {
        fromNote: from.indexInGroup,
        toNote: to.indexInGroup,
        reason: "score_step_too_small",
      }));
      continue;
    }
    const halfWindowSeconds = Math.min(
      PITCH_TECHNIQUE_ANALYSIS_DEFAULTS.transition.maxHalfWindowSeconds,
      to.onsetSeconds - from.onsetSeconds,
      to.endSeconds - to.onsetSeconds
    );
    const fromSeconds = to.onsetSeconds - halfWindowSeconds;
    const toSeconds = to.onsetSeconds + halfWindowSeconds;
    if (
      !Number.isFinite(fromSeconds) ||
      !Number.isFinite(toSeconds) ||
      toSeconds - fromSeconds < PITCH_TECHNIQUE_ANALYSIS_DEFAULTS.transition.minimumWindowSeconds ||
      toSeconds - fromSeconds < grid.sampleIntervalSeconds * 2
    ) {
      rejected.push(rejection("transition", "SAMPLING_RATE_TOO_LOW", {
        fromNote: from.indexInGroup,
        toNote: to.indexInGroup,
        reason: "transition_window_shorter_than_sampling_resolution",
      }));
      continue;
    }
    const sampleIndexes = frameIndexesInSpan(grid, fromSeconds, toSeconds);
    const samples = sampleIndexes.map((frameIndex) => ({
      frameIndex,
      timeSeconds: grid.timeSeconds[frameIndex],
      cents: flattenedCents[frameIndex],
    }));
    const finite = samples.filter((item) => Number.isFinite(item.cents));
    if (finite.length < PITCH_TECHNIQUE_ANALYSIS_DEFAULTS.minimumFiniteFrames) {
      rejected.push(rejection("transition", "INSUFFICIENT_COMPUTED_PITCH", {
        fromNote: from.indexInGroup,
        toNote: to.indexInGroup,
        finiteFrames: finite.length,
      }));
      continue;
    }
    const endpoint = endpointEvidence(samples, fromSeconds, toSeconds);
    const direction = Math.sign(scoreStepCents);
    if (
      !endpoint ||
      direction * (endpoint.toCents - endpoint.fromCents) <
        PITCH_TECHNIQUE_ANALYSIS_DEFAULTS.transition.minimumObservedMoveCents ||
      Math.abs(endpoint.fromCents - from.targetSemitone * 100) >
        PITCH_TECHNIQUE_ANALYSIS_DEFAULTS.transition.maximumEndpointMismatchCents ||
      Math.abs(endpoint.toCents - to.targetSemitone * 100) >
        PITCH_TECHNIQUE_ANALYSIS_DEFAULTS.transition.maximumEndpointMismatchCents
    ) {
      rejected.push(rejection("transition", "MODEL_NOT_IDENTIFIABLE", {
        fromNote: from.indexInGroup,
        toNote: to.indexInGroup,
        reason: "endpoint_mismatch",
        endpoint,
      }));
      continue;
    }
    const request = buildRichardsRequest({
      from,
      to,
      fromSeconds,
      toSeconds,
      samples,
      endpoint,
    });
    let rawResult;
    let verified;
    try {
      rawResult = await fitRichards(request);
      verified = revalidateFit(request, rawResult);
    } catch (error) {
      const code = error?.code === "FIT_TIMEOUT" ? "FIT_TIMEOUT" : "FIT_WORKER_UNAVAILABLE";
      rejected.push(rejection("transition", code, {
        fromNote: from.indexInGroup,
        toNote: to.indexInGroup,
        message: error?.message ?? "FitWorker invocation failed",
      }));
      solver.push({ request, result: null, failure: { code, message: error?.message ?? null } });
      continue;
    }
    solver.push({
      request,
      result: rawResult,
      resultHash: verified?.resultHash ?? null,
      accepted: verified?.accepted ?? false,
      identifiability: verified?.identifiability ?? "not_assessed",
    });
    if (!verified?.accepted || !verified.result?.parameters) {
      rejected.push(rejection("transition", fitRejectionCode(rawResult, verified), {
        fromNote: from.indexInGroup,
        toNote: to.indexInGroup,
        termination: rawResult?.termination ?? null,
        identifiability: verified?.identifiability ?? null,
      }));
      continue;
    }
    const linear = fitLinear(samples);
    const rmseImprovementCents = linear.rmseCents - verified.result.metrics.rmseCents;
    const rmseImprovementRatio = linear.rmseCents > 0
      ? rmseImprovementCents / linear.rmseCents
      : 0;
    if (
      rmseImprovementCents <
        PITCH_TECHNIQUE_ANALYSIS_DEFAULTS.transition.minimumRmseImprovementCents ||
      rmseImprovementRatio <
        PITCH_TECHNIQUE_ANALYSIS_DEFAULTS.transition.minimumRmseImprovementRatio
    ) {
      rejected.push(rejection("transition", "MODEL_NOT_IDENTIFIABLE", {
        fromNote: from.indexInGroup,
        toNote: to.indexInGroup,
        reason: "richards_not_better_than_linear",
        linearRmseCents: linear.rmseCents,
        richardsRmseCents: verified.result.metrics.rmseCents,
      }));
      continue;
    }
    const parameters = verified.result.parameters;
    const contribution = sampleIndexes.map((frameIndex) => ({
      index: frameIndex,
      cents:
        richardsTransition(
          grid.timeSeconds[frameIndex],
          parameters.fromSeconds,
          parameters.toSeconds,
          parameters.fromCents,
          parameters.toCents,
          parameters.inflectionSeconds,
          parameters.growthPerSecond,
          parameters.asymmetryB
        ) - baseline.scoreCents[frameIndex],
    }));
    const durationSeconds = parameters.toSeconds - parameters.fromSeconds;
    accepted.push(candidate({
      id: "transition:" + from.indexInGroup + ":" + to.indexInGroup,
      kind: "transition",
      anchors: { fromNote: from.indexInGroup, toNote: to.indexInGroup },
      span: {
        fromSeconds: parameters.fromSeconds,
        boundarySeconds: to.onsetSeconds,
        toSeconds: parameters.toSeconds,
      },
      parameters: {
        fromCents: parameters.fromCents,
        toCents: parameters.toCents,
        inflectionSeconds: parameters.inflectionSeconds,
        sharpness: parameters.growthPerSecond * durationSeconds,
        asymmetryLogB: Math.log(parameters.asymmetryB),
      },
      confidence: {
        score: transitionConfidence({
          coverage: finite.length / samples.length,
          rmseImprovementRatio,
          rmseCents: verified.result.metrics.rmseCents,
          endpoint,
          from,
          to,
        }),
        kind: "heuristic_score",
        calibrated: false,
      },
      evidence: {
        finiteFrames: finite.length,
        frameCount: samples.length,
        coverage: finite.length / samples.length,
        richardsRmseCents: verified.result.metrics.rmseCents,
        linearRmseCents: linear.rmseCents,
        rmseImprovementCents,
        multiStartSpread: verified.result.metrics.multiStartSpread,
      },
      contribution,
    }));
  }
  return {
    accepted,
    consideredBoundaries,
    totalBoundaries,
    truncatedBoundaries: consideredBoundaries < totalBoundaries,
  };
}

function analyzeTransientCandidates({
  notes,
  grid,
  baseline,
  residualCents,
  boundaryLimit,
  rejected,
}) {
  const accepted = [];
  const totalBoundaries = Math.max(0, notes.length - 1);
  let consideredBoundaries = 0;
  for (let index = 0; index < totalBoundaries && consideredBoundaries < boundaryLimit; index += 1) {
    const from = notes[index];
    const to = notes[index + 1];
    if (from.absEndBlick !== to.absOnsetBlick) continue;
    consideredBoundaries += 1;
    const direction = Math.sign(to.targetSemitone - from.targetSemitone);
    if (direction === 0) continue;
    const overshoot = fitTransientCandidate({
      id: "transient:overshoot:" + to.indexInGroup,
      subtype: "overshoot",
      anchors: { note: to.indexInGroup, boundaryFromNote: from.indexInGroup },
      direction,
      onsetSeconds: to.onsetSeconds,
      endSeconds: to.endSeconds,
      grid,
      residualCents,
    });
    if (overshoot.candidate) accepted.push(overshoot.candidate);
    else rejected.push(overshoot.rejected);

    const preparation = fitTransientCandidate({
      id: "transient:preparation:" + to.indexInGroup,
      subtype: "preparation",
      anchors: { note: to.indexInGroup, boundaryFromNote: from.indexInGroup },
      direction: -direction,
      onsetSeconds: Math.max(from.onsetSeconds, to.onsetSeconds - PITCH_TECHNIQUE_ANALYSIS_DEFAULTS.transient.maxSpanSeconds),
      endSeconds: to.onsetSeconds,
      grid,
      residualCents,
    });
    if (preparation.candidate) accepted.push(preparation.candidate);
    else rejected.push(preparation.rejected);
  }
  return {
    accepted,
    consideredBoundaries,
    totalBoundaries,
    truncatedBoundaries: consideredBoundaries < totalBoundaries,
  };
}

function fitTransientCandidate({
  id,
  subtype,
  anchors,
  direction,
  onsetSeconds,
  endSeconds,
  grid,
  residualCents,
}) {
  const spanSeconds = Math.min(
    PITCH_TECHNIQUE_ANALYSIS_DEFAULTS.transient.maxSpanSeconds,
    endSeconds - onsetSeconds
  );
  if (
    !Number.isFinite(spanSeconds) ||
    spanSeconds < grid.sampleIntervalSeconds * 2 ||
    spanSeconds <= 0.005
  ) {
    return {
      candidate: null,
      rejected: rejection("transient", "SAMPLING_RATE_TOO_LOW", {
        subtype,
        ...anchors,
        reason: "transient_window_shorter_than_sampling_resolution",
      }),
    };
  }
  const sampleIndexes = frameIndexesInSpan(grid, onsetSeconds, onsetSeconds + spanSeconds);
  const samples = sampleIndexes
    .filter((index) => Number.isFinite(residualCents[index]))
    .map((index) => ({
      index,
      seconds: grid.timeSeconds[index],
      cents: residualCents[index],
    }));
  if (samples.length < PITCH_TECHNIQUE_ANALYSIS_DEFAULTS.minimumFiniteFrames) {
    return {
      candidate: null,
      rejected: rejection("transient", "INSUFFICIENT_COMPUTED_PITCH", {
        subtype,
        ...anchors,
        finiteFrames: samples.length,
      }),
    };
  }
  const directionalPeak = directionalPeakSample(samples, direction);
  if (
    !directionalPeak ||
    direction * directionalPeak.cents <
      PITCH_TECHNIQUE_ANALYSIS_DEFAULTS.transient.minimumPeakCents
  ) {
    return {
      candidate: null,
      rejected: rejection("transient", "NO_TECHNIQUE_CANDIDATE", {
        subtype,
        ...anchors,
        reason: "no_directional_peak",
      }),
    };
  }
  const peakTimes = transientPeakTimes(samples, onsetSeconds, spanSeconds, directionalPeak.seconds);
  let best = null;
  for (const dampingRatio of PITCH_TECHNIQUE_ANALYSIS_DEFAULTS.transient.dampingRatios) {
    for (const peakTimeSeconds of peakTimes) {
      let model;
      try {
        model = transientFromFirstPeak({
          peakSemitone: 1,
          peakTimeSeconds,
          dampingRatio,
          onsetSeconds,
          spanSeconds,
          tailPolicy: "continuous_taper",
          sampleIntervalSeconds: grid.sampleIntervalSeconds,
          maxFitErrorCent: 1,
        });
      } catch {
        continue;
      }
      const basis = samples.map((sample) => model.valueAt(sample.seconds) * 100);
      const denominator = basis.reduce((sum, value) => sum + value * value, 0);
      if (!(denominator > Number.EPSILON)) continue;
      const peakSemitone = samples.reduce(
        (sum, sample, sampleIndex) => sum + sample.cents * basis[sampleIndex],
        0
      ) / denominator;
      if (
        direction * peakSemitone <= 0 ||
        Math.abs(peakSemitone) >
          PITCH_TECHNIQUE_ANALYSIS_DEFAULTS.transient.maximumPeakSemitone
      ) {
        continue;
      }
      const predicted = basis.map((value) => value * peakSemitone);
      const rmseCents = rmse(
        samples.map((sample) => sample.cents),
        predicted
      );
      if (!best || rmseCents < best.rmseCents) {
        best = {
          model,
          dampingRatio,
          peakTimeSeconds,
          peakSemitone,
          rmseCents,
          predicted,
        };
      }
    }
  }
  if (!best) {
    return {
      candidate: null,
      rejected: rejection("transient", "MODEL_NOT_IDENTIFIABLE", {
        subtype,
        ...anchors,
        reason: "bounded_second_order_fit_failed",
      }),
    };
  }
  const zeroRmseCents = Math.sqrt(
    samples.reduce((sum, sample) => sum + sample.cents * sample.cents, 0) / samples.length
  );
  const rmseImprovementCents = zeroRmseCents - best.rmseCents;
  const rmseImprovementRatio = zeroRmseCents > 0
    ? rmseImprovementCents / zeroRmseCents
    : 0;
  if (
    rmseImprovementCents <
      PITCH_TECHNIQUE_ANALYSIS_DEFAULTS.transient.minimumRmseImprovementCents ||
    rmseImprovementRatio <
      PITCH_TECHNIQUE_ANALYSIS_DEFAULTS.transient.minimumRmseImprovementRatio
  ) {
    return {
      candidate: null,
      rejected: rejection("transient", "MODEL_NOT_IDENTIFIABLE", {
        subtype,
        ...anchors,
        reason: "second_order_not_better_than_baseline",
        zeroRmseCents,
        modelRmseCents: best.rmseCents,
      }),
    };
  }
  const contribution = sampleIndexes.map((index) => ({
    index,
    cents: best.model.valueAt(grid.timeSeconds[index]) * 100 * best.peakSemitone,
  }));
  return {
    candidate: candidate({
      id,
      kind: "transient",
      subtype,
      anchors,
      span: {
        fromSeconds: onsetSeconds,
        toSeconds: onsetSeconds + spanSeconds,
      },
      parameters: {
        peakSemitone: best.peakSemitone,
        peakTimeSeconds: best.peakTimeSeconds,
        dampingRatio: best.dampingRatio,
        onsetSeconds,
        spanSeconds,
        tailPolicy: "continuous_taper",
      },
      confidence: {
        score: clamp01(
          0.5 * rmseImprovementRatio +
          0.25 * Math.min(1, Math.abs(best.peakSemitone) * 100 / 50) +
          0.25 * Math.min(1, samples.length / 32)
        ),
        kind: "heuristic_score",
        calibrated: false,
      },
      evidence: {
        finiteFrames: samples.length,
        zeroRmseCents,
        secondOrderRmseCents: best.rmseCents,
        rmseImprovementCents,
        peakCents: best.peakSemitone * 100,
      },
      contribution,
    }),
    rejected: null,
  };
}

function appendNonOverlappingStructuralCandidates(existing, candidates, rejected) {
  const selected = [...existing];
  const ranked = [...candidates].sort((left, right) => (
    right.confidence.score - left.confidence.score || compareCandidates(left, right)
  ));
  for (const current of ranked) {
    const overlap = selected.find((accepted) => spansOverlap(current.span, accepted.span));
    if (overlap) {
      rejected.push(rejection(current.kind, "OVERLAPPING_TECHNIQUES", {
        candidate: current.id,
        overlaps: overlap.id,
        reason: "nonlinear_structural_models_are_not_jointly_identifiable",
      }));
      continue;
    }
    selected.push(current);
  }
  return selected.sort(compareCandidates);
}

function contributionsForCandidates(frameCount, candidates) {
  const values = new Array(frameCount).fill(0);
  for (const item of candidates) {
    for (const point of item.contribution) values[point.index] += point.cents;
  }
  return values;
}

function buildReconstruction({
  baseline,
  vibratoContributions,
  transitionContributions,
  transientContributions,
  observedCents,
}) {
  const values = new Array(observedCents.length).fill(null);
  const residualCents = new Array(observedCents.length).fill(null);
  const validMask = new Array(observedCents.length).fill(false);
  for (let index = 0; index < observedCents.length; index += 1) {
    if (baseline.scoreCents[index] === null) continue;
    const predicted =
      baseline.scoreCents[index] +
      vibratoContributions[index] +
      transitionContributions[index] +
      transientContributions[index];
    values[index] = predicted;
    if (Number.isFinite(observedCents[index])) {
      residualCents[index] = observedCents[index] - predicted;
      validMask[index] = true;
    }
  }
  return { values, residualCents, validMask };
}

function summarizeJointModel(reconstruction) {
  const residual = reconstruction.residualCents.filter(Number.isFinite);
  return {
    finiteFrames: residual.length,
    residualRmseCents: residual.length > 0
      ? Math.sqrt(residual.reduce((sum, value) => sum + value * value, 0) / residual.length)
      : null,
  };
}

// ---------- 数值拟合辅助 ----------

function buildRichardsRequest({ from, to, fromSeconds, toSeconds, samples, endpoint }) {
  const durationSeconds = toSeconds - fromSeconds;
  const downsampled = downsampleFitSamples(samples);
  const identity = {
    from: from.indexInGroup,
    to: to.indexInGroup,
    fromSeconds,
    toSeconds,
    samples: downsampled.map((sample) => [sample.timeSeconds, sample.cents]),
  };
  const hash = contentHash(identity).slice("sha256_".length);
  return {
    protocolVersion: 1,
    requestId: "fit_" + hash.slice(0, 24),
    operation: "fit_richards_segment",
    samples: {
      timeSeconds: downsampled.map((sample) => sample.timeSeconds),
      cents: downsampled.map((sample) => (
        Number.isFinite(sample.cents) ? sample.cents : null
      )),
      mask: downsampled.map((sample) => Number.isFinite(sample.cents)),
    },
    initial: {
      fromSeconds,
      toSeconds,
      fromCents: endpoint.fromCents,
      toCents: endpoint.toCents,
      inflectionSeconds: (fromSeconds + toSeconds) / 2,
      growthPerSecond: 6 / durationSeconds,
      asymmetryB: 1,
    },
    bounds: {
      fromCents: {
        minimum: from.targetSemitone * 100 - PITCH_TECHNIQUE_ANALYSIS_DEFAULTS.transition.maximumEndpointMismatchCents,
        maximum: from.targetSemitone * 100 + PITCH_TECHNIQUE_ANALYSIS_DEFAULTS.transition.maximumEndpointMismatchCents,
      },
      toCents: {
        minimum: to.targetSemitone * 100 - PITCH_TECHNIQUE_ANALYSIS_DEFAULTS.transition.maximumEndpointMismatchCents,
        maximum: to.targetSemitone * 100 + PITCH_TECHNIQUE_ANALYSIS_DEFAULTS.transition.maximumEndpointMismatchCents,
      },
      inflectionSeconds: {
        minimum: fromSeconds + durationSeconds * 0.05,
        maximum: toSeconds - durationSeconds * 0.05,
      },
      growthPerSecond: {
        minimum: 1 / durationSeconds,
        maximum: 40 / durationSeconds,
      },
      asymmetryB: {
        minimum: Math.exp(-3),
        maximum: Math.exp(3),
      },
    },
    loss: { kind: "huber", scaleCents: 8 },
    limits: { maxIterations: 200, maxStarts: 16, timeoutMs: 1_000 },
    seed: seedFromHash(hash),
  };
}

function downsampleFitSamples(samples) {
  if (samples.length <= FIT_WORKER_LIMITS.maximumSamples) return samples;
  const result = [];
  for (let index = 0; index < FIT_WORKER_LIMITS.maximumSamples; index += 1) {
    const sourceIndex = Math.round(
      index * (samples.length - 1) / (FIT_WORKER_LIMITS.maximumSamples - 1)
    );
    result.push(samples[sourceIndex]);
  }
  return result;
}

function endpointEvidence(samples, fromSeconds, toSeconds) {
  const durationSeconds = toSeconds - fromSeconds;
  const edgeSeconds = Math.max(durationSeconds * 0.2, 1e-6);
  const head = samples
    .filter((sample) => (
      Number.isFinite(sample.cents) &&
      sample.timeSeconds <= fromSeconds + edgeSeconds + TIME_EPSILON_SECONDS
    ))
    .map((sample) => sample.cents);
  const tail = samples
    .filter((sample) => (
      Number.isFinite(sample.cents) &&
      sample.timeSeconds >= toSeconds - edgeSeconds - TIME_EPSILON_SECONDS
    ))
    .map((sample) => sample.cents);
  if (head.length === 0 || tail.length === 0) return null;
  return {
    fromCents: median(head),
    toCents: median(tail),
    headFrames: head.length,
    tailFrames: tail.length,
  };
}

function fitLinear(samples) {
  const finite = samples.filter((sample) => Number.isFinite(sample.cents));
  const fromSeconds = finite[0].timeSeconds;
  const toSeconds = finite.at(-1).timeSeconds;
  const durationSeconds = Math.max(Number.EPSILON, toSeconds - fromSeconds);
  const unit = finite.map((sample) => (sample.timeSeconds - fromSeconds) / durationSeconds);
  const values = finite.map((sample) => sample.cents);
  const meanUnit = unit.reduce((sum, value) => sum + value, 0) / unit.length;
  const meanValue = values.reduce((sum, value) => sum + value, 0) / values.length;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < unit.length; index += 1) {
    numerator += (unit[index] - meanUnit) * (values[index] - meanValue);
    denominator += (unit[index] - meanUnit) ** 2;
  }
  const slope = denominator > Number.EPSILON ? numerator / denominator : 0;
  const intercept = meanValue - slope * meanUnit;
  return {
    interceptCents: intercept,
    slopeCents: slope,
    rmseCents: rmse(values, unit.map((value) => intercept + slope * value)),
  };
}

function fitLinearSine(timeSeconds, cents, rateHz) {
  if (timeSeconds.length !== cents.length || timeSeconds.length < 4) return null;
  const origin = timeSeconds[0];
  const centered = timeSeconds.map((value) => value - origin);
  const omega = 2 * Math.PI * rateHz;
  const matrix = Array.from({ length: 4 }, () => Array(4).fill(0));
  const vector = Array(4).fill(0);
  for (let index = 0; index < cents.length; index += 1) {
    const row = [
      1,
      centered[index],
      Math.sin(omega * centered[index]),
      Math.cos(omega * centered[index]),
    ];
    for (let left = 0; left < row.length; left += 1) {
      vector[left] += row[left] * cents[index];
      for (let right = 0; right < row.length; right += 1) {
        matrix[left][right] += row[left] * row[right];
      }
    }
  }
  const solution = solveLinearSystem(matrix, vector);
  if (!solution) return null;
  const [centerCents, slopeCentsPerSecond, sineCoefficient, cosineCoefficient] = solution;
  const oscillationCents = centered.map((seconds) => (
    sineCoefficient * Math.sin(omega * seconds) +
    cosineCoefficient * Math.cos(omega * seconds)
  ));
  const predicted = centered.map((seconds, index) => (
    centerCents + slopeCentsPerSecond * seconds + oscillationCents[index]
  ));
  return {
    centerCents,
    slopeCentsPerSecond,
    depthCents: Math.hypot(sineCoefficient, cosineCoefficient),
    phaseRad: Math.atan2(cosineCoefficient, sineCoefficient),
    oscillationCents,
    rmseCents: rmse(cents, predicted),
  };
}

function solveLinearSystem(matrix, vector) {
  const size = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) {
        pivot = row;
      }
    }
    if (Math.abs(augmented[pivot][column]) < 1e-12) return null;
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    for (let index = column; index <= size; index += 1) {
      augmented[column][index] /= divisor;
    }
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let index = column; index <= size; index += 1) {
        augmented[row][index] -= factor * augmented[column][index];
      }
    }
  }
  const solution = augmented.map((row) => row[size]);
  return solution.every(Number.isFinite) ? solution : null;
}

function transientPeakTimes(samples, onsetSeconds, spanSeconds, observedPeakSeconds) {
  const latestPeakSeconds = Math.min(spanSeconds * 0.75, 0.5);
  const candidates = [
    observedPeakSeconds - onsetSeconds,
    ...samples.map((sample) => sample.seconds - onsetSeconds),
  ]
    .filter((value) => value >= 0.005 && value <= latestPeakSeconds)
    .sort((left, right) => left - right);
  const unique = [];
  for (const value of candidates) {
    if (unique.length === 0 || Math.abs(value - unique.at(-1)) > 1e-9) unique.push(value);
  }
  if (unique.length <= PITCH_TECHNIQUE_ANALYSIS_DEFAULTS.transient.maximumPeakTimeCandidates) {
    return unique;
  }
  const selected = [];
  const maximum = PITCH_TECHNIQUE_ANALYSIS_DEFAULTS.transient.maximumPeakTimeCandidates;
  for (let index = 0; index < maximum; index += 1) {
    selected.push(unique[Math.round(index * (unique.length - 1) / (maximum - 1))]);
  }
  return selected;
}

function directionalPeakSample(samples, direction) {
  let best = null;
  for (const sample of samples) {
    if (!best || direction * sample.cents > direction * best.cents) best = sample;
  }
  return best;
}

function transitionConfidence({ coverage, rmseImprovementRatio, rmseCents, endpoint, from, to }) {
  const endpointError = (
    Math.abs(endpoint.fromCents - from.targetSemitone * 100) +
    Math.abs(endpoint.toCents - to.targetSemitone * 100)
  ) / 2;
  return clamp01(
    0.4 * coverage +
    0.35 * clamp01(rmseImprovementRatio) +
    0.15 * clamp01(1 - rmseCents / 30) +
    0.1 * clamp01(1 - endpointError / 120)
  );
}

function fitRejectionCode(rawResult, verified) {
  if (rawResult?.termination === "timeout") return "FIT_TIMEOUT";
  if (rawResult?.termination === "iteration_limit") return "FIT_DID_NOT_CONVERGE";
  if (rawResult?.termination === "rejected") return "MODEL_NOT_IDENTIFIABLE";
  if (verified?.identifiability === "not_identifiable") return "MODEL_NOT_IDENTIFIABLE";
  return "FIT_DID_NOT_CONVERGE";
}

function seedFromHash(hash) {
  let value = 0;
  for (let index = 0; index < hash.length; index += 1) {
    value = (value * 33 + hash.charCodeAt(index)) >>> 0;
  }
  return value;
}

// ---------- 投影与通用辅助 ----------

// maxCandidates 只在这里生效：它裁剪紧凑响应，不参与 canonical 分析或 analysisHash。
// candidateCount / candidateWindows 始终报告完整的分析范围，因此"响应里少了几条"
// 与"这段乐句没有技法"在语义上不会混淆。
function compactAnalysis(canonical, maxCandidates) {
  const candidates = canonical.candidates.slice(0, maxCandidates).map(publicCandidate);
  const rejectedSummary = summarizeRejected(canonical.rejected);
  return {
    sampling: canonical.sampling,
    summary: {
      ...canonical.summary,
      candidateCount: canonical.candidates.length,
      returnedCandidateCount: candidates.length,
      candidatesTruncated: canonical.candidates.length > candidates.length,
      requestMaxCandidates: maxCandidates,
      analysisStatus: canonical.analysisStatus,
      ...(canonical.reasonCode ? { reasonCode: canonical.reasonCode } : {}),
    },
    candidates: {
      count: canonical.candidates.length,
      returned: candidates.length,
      truncated: canonical.candidates.length > candidates.length,
      items: candidates,
    },
    rejected: rejectedSummary,
  };
}

function publicCandidate(item) {
  return {
    id: item.id,
    kind: item.kind,
    ...(item.subtype ? { subtype: item.subtype } : {}),
    anchors: item.anchors,
    span: item.span,
    parameters: item.parameters,
    confidence: item.confidence,
    evidence: item.evidence,
  };
}

function candidate(value) {
  return value;
}

function rejection(kind, code, details) {
  return { kind, code, details };
}

function summarizeRejected(rejected) {
  const byCode = Object.create(null);
  for (const item of rejected) byCode[item.code] = (byCode[item.code] ?? 0) + 1;
  return {
    count: rejected.length,
    byCode,
    // 详细 rejected candidate 与 solver trace 都在 Artifact，主响应只留有界代表项。
    items: rejected.slice(0, 12),
    truncated: rejected.length > 12,
  };
}

function publicSampling(grid, baseline, finiteFrames, coverage) {
  return {
    timeGrid: grid.timeGrid,
    frameCount: grid.frames,
    sampleRateHz: grid.sampleRateHz,
    sampleIntervalSeconds: grid.sampleIntervalSeconds,
    eligibleFrameCount: baseline.eligibleFrameCount,
    finiteFrameCount: finiteFrames,
    coverage,
    source: grid.source,
    resampling: grid.resampling,
  };
}

function publicSource(loaded) {
  return {
    contextId: loaded.stored.contextId,
    occurrence: publicOccurrence(loaded.occurrence, loaded.occurrenceOrdinal),
    observedAt: loaded.stored.observedAt,
    snapshotToken: loaded.stored.snapshotToken ?? null,
  };
}

function publicOccurrence(occurrence, ordinal) {
  return {
    occurrence: ordinal,
    trackIndex: occurrence.trackIndex,
    groupIndex: occurrence.groupIndex,
    targetGroupUuid: occurrence.targetGroupUuid,
    pitchOffsetSemitone: occurrence.pitchOffsetSemitone ?? 0,
  };
}

function frameIndexesInSpan(grid, fromSeconds, toSeconds) {
  const indexes = [];
  for (let index = 0; index < grid.frames; index += 1) {
    const seconds = grid.timeSeconds[index];
    if (seconds < fromSeconds - TIME_EPSILON_SECONDS) continue;
    if (seconds > toSeconds + TIME_EPSILON_SECONDS) break;
    indexes.push(index);
  }
  return indexes;
}

function longestFiniteFrameRun(indexes, observedCents, scoreCents) {
  let best = [];
  let current = [];
  let previous = null;
  for (const index of indexes) {
    if (
      previous !== null &&
      index !== previous + 1
    ) {
      current = [];
    }
    if (Number.isFinite(observedCents[index]) && Number.isFinite(scoreCents[index])) {
      current.push(index);
      if (current.length > best.length) best = current;
    } else {
      current = [];
    }
    previous = index;
  }
  return best;
}

function spansOverlap(left, right) {
  return (
    left.fromSeconds < right.toSeconds - TIME_EPSILON_SECONDS &&
    right.fromSeconds < left.toSeconds - TIME_EPSILON_SECONDS
  );
}

function compareCandidates(left, right) {
  return (
    left.span.fromSeconds - right.span.fromSeconds ||
    (CANDIDATE_KIND_ORDER.get(left.kind) ?? 99) -
      (CANDIDATE_KIND_ORDER.get(right.kind) ?? 99) ||
    left.id.localeCompare(right.id)
  );
}

function rmse(actual, predicted) {
  if (actual.length === 0 || actual.length !== predicted.length) return Infinity;
  return Math.sqrt(
    actual.reduce((sum, value, index) => sum + (value - predicted[index]) ** 2, 0) /
      actual.length
  );
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function sameIntegerArray(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => Number.isSafeInteger(value) && value === right[index])
  );
}

function waitForProcessingRemedy(loaded) {
  return {
    tool: "sv_wait_for_processing",
    arguments: {
      contextId: loaded.stored.contextId,
      occurrence: loaded.occurrenceOrdinal,
      kind: "computedPitch",
    },
  };
}

function recaptureRemedy() {
  return {
    tool: "sv_snapshot_range",
    arguments: {
      include: ["notes", "computedPitch"],
      computedPitchSampling: { frames: 320 },
    },
  };
}

function captureRequiredError(code) {
  const error = codedError(
    code,
    'computed pitch and note fingerprints must be captured with include ["notes","computedPitch"]'
  );
  error.details = { remedy: recaptureRemedy() };
  return error;
}

function insufficientEvidenceError(reason, details = {}) {
  const error = codedError(
    "INSUFFICIENT_COMPUTED_PITCH",
    "captured computed pitch does not meet the evidence threshold for technique decomposition"
  );
  error.details = {
    reason,
    ...details,
    ...(details.remedy ? {} : { remedy: recaptureRemedy() }),
  };
  return error;
}

function assertKnownKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw codedError("INVALID_ARGUMENTS", label + " contains unknown fields", { unknown });
  }
}

function checkedInteger(value, minimum, maximum, fallback, label) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw codedError(
      "INVALID_ARGUMENTS",
      label + " must be an integer between " + minimum + " and " + maximum
    );
  }
  return value;
}

function codedError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
