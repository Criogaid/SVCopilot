import { getStoredComputedPitch } from "./musical-range.js";
import { secondsAtBlick } from "./musical-time.js";
import { ServiceTiming } from "./service-timing.js";
import { selectOccurrenceByOrdinal } from "./scope-source.js";
import {
  analyzeVocalEventSequence,
  summarizeExcludedVocalEvents,
} from "./vocal-event-semantics.js";
import { unknownContextError } from "./snapshot.js";

// sv_compare_computed_pitch：客观演唱分析（音准 / 颤音 / 转换 / 异常区段）。
//
// 关键契约：
// - 纯内存只读服务。只读取 sv_snapshot_range 已存的 computed-pitch 序列与音符指纹，
//   不进入 ExecutionCoordinator，也绝不访问宿主——"调前"曲线一旦编辑就无法重采样，
//   因此 before/after 都必须来自已存快照。
// - null 帧是一等公民：官方 getComputedPitchForGroup 对无音高处返回 null、处理未完成
//   返回空数组（上游归一化为全 null）。null 不进数值统计，只计入 coverage 证据。
// - 音准与颤音是两个指标族：带颤音的长音以稳态段均值（centerErrorCent）为准；
//   逐帧误差只作诊断，绝不把健康颤音误报成跑调。
// - anomalySegments 默认按 startBlick 时间顺序返回并显式声明 sortBy；
//   sortBy:"severity" 才按峰值降序。无论排序方式，top 恒为最严重段，截断不吞掉它。
// - 低覆盖率必须显式警告：有效帧占比低于 lowCoverageWarnRatio（默认 0.5）时发
//   LOW_COMPUTED_PITCH_COVERAGE，避免把低样本统计误当成可靠结论。
// - 颤音只能从 computed pitch 测量：Note 属性里的 dF0Vbr/fF0Vbr 等是官方标注的
//   version-1-only 字段，v2 工程不可移植，本服务不读取。
// - 所有阈值默认值是工程启发，未经真实宿主校准（HANDOFF §8.10）；响应里如实标注。
export const COMPARE_ANALYSIS_DEFAULTS = Object.freeze({
  minValidFramesPerNote: 8,
  edgeExclusionRatio: 0.15,
  centerMinFrames: 4,
  lowCoverageWarnRatio: 0.5,
  vibrato: Object.freeze({
    minWindowFrames: 24,
    hzRange: Object.freeze([3.5, 8.5]),
    minPeakCorrelation: 0.35,
  }),
  transition: Object.freeze({
    arrivalBandCent: 20,
    settleBandCent: 12,
    holdFrames: 3,
    windowMs: 300,
  }),
  anomalyThresholdCent: 50,
});
const MAX_ANOMALY_SEGMENTS = 10;
const MAX_PER_NOTE_ITEMS = 200;
const SEMITONE_DELTA_THRESHOLDS = Object.freeze(["0.01", "0.05", "0.10"]);
const ANOMALY_SORT_MODES = Object.freeze(["startBlick", "severity"]);

const PROVENANCE = Object.freeze({
  pitchSource: "computedPitch",
  pitchBasis: "observed",
  specialLyrics: "official_v2_manual_enter_notes",
  derivedMetrics: Object.freeze(["summary", "center", "vibrato", "transitions", "anomalySegments"]),
  thresholdBasis: "engineering_heuristic_requires_host_calibration",
  noteVibratoAttributes: "not_used_version1_only_fields",
  perception: "human_only",
});

export class ComputedPitchCompareService {
  constructor({ store, now = () => Date.now() } = {}) {
    if (!store) throw new Error("ComputedPitchCompareService requires the shared SnapshotStore");
    this.store = store;
    this.now = now;
  }

  async compare(request = {}) {
    const timer = new ServiceTiming({
      now: this.now,
      phaseNames: ["loadMs", "statsMs", "detectMs"],
    });
    const input = normalizeCompareRequest(request);
    // 纯内存服务：不进入协调器；coordinatorQueueMs/operationMs 恒为 0，如实报告。
    timer.requestCoordinator();
    const warnings = [];
    const loaded = await timer.measure("loadMs", async () =>
      input.mode === "compare_to_target"
        ? loadTargetSource(this.store, input)
        : loadContextsSources(this.store, input, warnings)
    );
    const result =
      input.mode === "compare_to_target"
        ? await runTargetAnalysis(loaded, input, warnings, timer)
        : await runContextsAnalysis(loaded, input, warnings, timer);
    return {
      ...result,
      warnings,
      provenance: PROVENANCE,
      timings: timer.finish(),
    };
  }
}

// ---------- 上下文与 occurrence 解析（纯数据） ----------

function loadTargetSource(store, input) {
  const source = resolveCompareSource(store, input.contextId, input.occurrence, "request");
  return { ...source };
}

function loadContextsSources(store, input, warnings) {
  const before = resolveCompareSource(
    store,
    input.before.contextId,
    input.before.occurrence,
    "before"
  );
  const after = resolveCompareSource(store, input.after.contextId, input.after.occurrence, "after");
  // 两侧必须共享同一采样栅格：过去的曲线无法重采样，栅格不同就不存在诚实的逐帧对齐。
  const grids = [before.series, after.series];
  if (
    grids[0].startBlick !== grids[1].startBlick ||
    grids[0].intervalBlick !== grids[1].intervalBlick ||
    grids[0].frames !== grids[1].frames
  ) {
    const error = codedError(
      "ALIGNMENT_UNSUPPORTED",
      "before/after computed-pitch grids differ; re-snapshot both with identical computedPitchSampling"
    );
    error.details = {
      before: pickGrid(grids[0]),
      after: pickGrid(grids[1]),
    };
    throw error;
  }
  if (before.stored.context.quarterBlick !== after.stored.context.quarterBlick) {
    throw codedError(
      "ALIGNMENT_UNSUPPORTED",
      "before/after contexts use different SV.QUARTER timebases and cannot be compared"
    );
  }
  // blick 是乐谱位置：等栅格逐帧配对即按乐谱位置对齐。tempo 图不同只影响 Hz 类
  // 指标（各侧用各自 tempo 换算），不影响配对本身。
  if (!tempoMarksEqual(before.stored.context.tempoMarks, after.stored.context.tempoMarks)) {
    warnings.push({
      code: "TEMPO_MAP_DIFFERS",
      message:
        "Tempo maps differ between contexts; frames are paired by score position (blick) and Hz-based metrics use each side's own tempo map.",
    });
  }
  return { before, after };
}

function resolveCompareSource(store, contextId, requestedOrdinal, label) {
  const stored = store.get(contextId);
  if (!stored) {
    throw unknownContextError(store, contextId, label);
  }
  if (stored.context?.kind !== "range") {
    throw codedError(
      "INVALID_CONTEXT",
      `${label} context must come from sv_snapshot_range with include ["computedPitch"]`
    );
  }
  const map = stored.context.computedPitchByOccurrence;
  const occurrences = Array.isArray(stored.context.occurrences) ? stored.context.occurrences : [];
  if (!map) {
    throw codedError(
      "COMPUTED_PITCH_NOT_CAPTURED",
      `${label} context has no stored computed pitch; re-run sv_snapshot_range with include ["computedPitch"]`
    );
  }
  // 候选判据是"该 occurrence 捕获了 computed pitch"——与其它分析器的"有音符指纹"
  // 不同，因此判据由调用方给出而不是写进选择器。显式点名一个没有 computed pitch 的
  // occurrence 与越界是两回事：前者存在但这项分析用不了。
  const { occurrence, ordinal } = selectOccurrenceByOrdinal(occurrences, requestedOrdinal, {
    eligible: (item) => Object.hasOwn(map, item.occurrence),
    noneCode: "COMPUTED_PITCH_NOT_CAPTURED",
    noneMessage: `${label} context captured no computed pitch for any occurrence`,
    ambiguousMessage: `${label} context has multiple occurrences with computed pitch; pass one occurrence ordinal`,
    ineligibleCode: "COMPUTED_PITCH_NOT_CAPTURED",
    ineligibleMessage: `${label} occurrence exists but captured no computed pitch; re-run sv_snapshot_range with include ["computedPitch"]`,
  });
  const series = getStoredComputedPitch(stored, ordinal);
  if (!series) {
    throw codedError(
      "COMPUTED_PITCH_NOT_CAPTURED",
      `${label} occurrence has no stored computed pitch; re-run sv_snapshot_range with include ["computedPitch"]`
    );
  }
  return { stored, occurrence, ordinal, series };
}

// ---------- compare_to_target ----------

async function runTargetAnalysis(loaded, input, warnings, timer) {
  const { stored, occurrence, ordinal, series } = loaded;
  const context = stored.context;
  const partition = buildNoteSpanPartition(occurrence);
  if (partition.inputNoteCount === 0) {
    throw codedError(
      "NOTES_NOT_CAPTURED",
      'compare_to_target needs note fingerprints; re-run sv_snapshot_range with include ["notes","computedPitch"]'
    );
  }
  if (partition.melodicSpans.length === 0) {
    throw noMelodicEvidence(partition);
  }
  const spans = partition.melodicSpans;
  const params = input.analysis;
  const sampling = buildSamplingBlock(series, context, params, warnings);

  const base = await timer.measure("statsMs", async () => {
    const frameData = buildTargetFrameData(series, spans, partition.excludedSpans);
    const cents = frameData.frameCents.filter(Boolean).map((frame) => frame.cents);
    if (cents.length === 0) {
      throw insufficientComputedPitch(series, frameData);
    }
    return { frameData, summary: buildTargetSummary(series, frameData, cents) };
  });
  warnLowCoverage(base.summary.coverage, params, warnings);

  const detail = await timer.measure("detectMs", async () => {
    const anomalies = input.metrics.anomalySegments
      ? collectAnomalySegments(base.frameData.frameCents, params.anomalyThresholdCent)
      : null;
    if (input.responseMode === "compact") return { anomalies };
    const perNote = input.metrics.perNote
      ? buildPerNoteItems(spans, base.frameData.perSpan, params, context, series, {
          vibrato: input.metrics.vibrato,
          warnings,
        })
      : null;
    const transitions = input.metrics.transitions
      ? buildTransitions(spans, base.frameData.perSpan, params, context)
      : null;
    return { anomalies, perNote, transitions };
  });

  return {
    ok: true,
    status: "succeeded",
    mode: "compare_to_target",
    contextId: stored.contextId,
    occurrence: publicOccurrence(occurrence, ordinal),
    inputNoteCount: partition.inputNoteCount,
    melodicNoteCount: spans.length,
    excludedEvents: partition.excludedEvents,
    sampling,
    summary: base.summary,
    ...(input.responseMode === "compact"
      ? {}
      : {
          ...(detail.perNote ? { perNote: detail.perNote } : {}),
          ...(detail.transitions ? { transitions: detail.transitions } : {}),
          analysis: publicAnalysisParams(params),
        }),
    ...(detail.anomalies
      ? { anomalySegments: emitAnomalies(detail.anomalies, input.responseMode, input.anomalySortBy) }
      : {}),
  };
}

function buildNoteSpans(occurrence) {
  const timeOffset = occurrence.timeOffsetBlick ?? 0;
  const pitchOffset = occurrence.pitchOffsetSemitone ?? 0;
  return (occurrence.noteFingerprints ?? [])
    .map((fingerprint) => ({
      indexInGroup: fingerprint.indexInGroup,
      lyrics: fingerprint.lyrics,
      // 目标音高 = note MIDI + detune(cent→半音) + reference pitchOffset（官方 getPitchOffset 语义）。
      targetSemitone:
        fingerprint.pitch + (fingerprint.detuneCents ?? 0) / 100 + pitchOffset,
      absOnsetBlick: timeOffset + fingerprint.onsetBlick,
      absEndBlick: timeOffset + fingerprint.onsetBlick + fingerprint.durationBlick,
      durationBlick: fingerprint.durationBlick,
    }))
    .sort((left, right) => left.absOnsetBlick - right.absOnsetBlick);
}

function buildNoteSpanPartition(occurrence) {
  const inputSpans = buildNoteSpans(occurrence);
  const sequence = analyzeVocalEventSequence(inputSpans);
  const melodicSpans = sequence.events
    .filter((event) => event.melodicEligible)
    .map((event) => event.note);
  const excludedSpans = sequence.events
    .filter((event) => !event.melodicEligible)
    .map((event) => event.note);
  return {
    inputNoteCount: inputSpans.length,
    melodicSpans,
    excludedSpans,
    excludedEvents: summarizeExcludedVocalEvents(sequence.events),
  };
}

function buildExcludedFrameMask(series, spans) {
  const frameCount = series.frames ?? series.values?.length ?? 0;
  const mask = new Uint8Array(frameCount);
  let count = 0;
  for (const span of spans) {
    const start = Math.max(
      0,
      Math.ceil((span.absOnsetBlick - series.startBlick) / series.intervalBlick)
    );
    const end = Math.min(
      frameCount,
      Math.ceil((span.absEndBlick - series.startBlick) / series.intervalBlick)
    );
    for (let index = start; index < end; index += 1) {
      if (mask[index] === 1) continue;
      mask[index] = 1;
      count += 1;
    }
  }
  return { mask, count };
}

function buildTargetFrameData(series, spans, excludedSpans = []) {
  const perSpan = spans.map(() => []);
  const frameCents = new Array(series.values.length).fill(null);
  let finiteFrames = 0;
  let excludedFiniteFrameCount = 0;
  let framesOutsideNotes = 0;
  let excludedFrameCount = 0;
  // 帧与 span 都按时间单调，单指针扫描；组内音符不重叠（官方编辑器语义）。
  let cursor = 0;
  let excludedCursor = 0;
  for (let index = 0; index < series.values.length; index += 1) {
    const blick = series.startBlick + index * series.intervalBlick;
    const value = series.values[index];
    const finite = Number.isFinite(value);
    while (
      excludedCursor < excludedSpans.length &&
      blick >= excludedSpans[excludedCursor].absEndBlick
    ) {
      excludedCursor += 1;
    }
    if (
      excludedCursor < excludedSpans.length &&
      blick >= excludedSpans[excludedCursor].absOnsetBlick
    ) {
      excludedFrameCount += 1;
      if (finite) excludedFiniteFrameCount += 1;
      continue;
    }
    if (finite) finiteFrames += 1;
    while (cursor < spans.length && blick >= spans[cursor].absEndBlick) cursor += 1;
    const inSpan = cursor < spans.length && blick >= spans[cursor].absOnsetBlick;
    if (inSpan) {
      perSpan[cursor].push({ frameIndex: index, blick, value });
      if (finite) {
        frameCents[index] = { blick, cents: (value - spans[cursor].targetSemitone) * 100 };
      }
    } else if (finite) {
      framesOutsideNotes += 1;
    }
  }
  return {
    perSpan,
    frameCents,
    finiteFrames,
    excludedFiniteFrameCount,
    framesOutsideNotes,
    excludedFrameCount,
    eligibleFrameCount: Math.max(0, series.values.length - excludedFrameCount),
  };
}

function buildTargetSummary(series, frameData, cents) {
  return {
    frameCount: series.values.length,
    eligibleFrameCount: frameData.eligibleFrameCount,
    excludedFrameCount: frameData.excludedFrameCount,
    excludedFiniteFrameCount: frameData.excludedFiniteFrameCount,
    rawFiniteFrameCount: frameData.finiteFrames + frameData.excludedFiniteFrameCount,
    finiteFrameCount: frameData.finiteFrames,
    validFrameCount: cents.length,
    framesOutsideNotes: frameData.framesOutsideNotes,
    coverage:
      frameData.eligibleFrameCount > 0 ? cents.length / frameData.eligibleFrameCount : 0,
    ...summarizeCents(cents),
  };
}

function buildPerNoteItems(spans, perSpan, params, context, series, { vibrato, warnings }) {
  const items = [];
  const total = spans.length;
  for (let index = 0; index < spans.length && items.length < MAX_PER_NOTE_ITEMS; index += 1) {
    const span = spans[index];
    const fs = frameRateAt(
      context.tempoMarks,
      context.quarterBlick,
      Math.floor((span.absOnsetBlick + span.absEndBlick) / 2),
      series.intervalBlick
    );
    items.push({
      note: span.indexInGroup,
      indexInGroup: span.indexInGroup,
      lyrics: span.lyrics,
      targetSemitone: span.targetSemitone,
      ...analyzeNoteSeries(perSpan[index], span.targetSemitone, params, fs, { vibrato }),
    });
  }
  const truncated = total > items.length;
  if (truncated) {
    warnings.push({
      code: "PER_NOTE_TRUNCATED",
      message: `perNote reports the first ${MAX_PER_NOTE_ITEMS} of ${total} notes; narrow the snapshot range for full per-note detail.`,
    });
  }
  return { count: total, truncated, items };
}

// 单音符分析：音准（稳态段中心）与颤音（去趋势 + 自相关）分族。
// noteFrames 含该音符跨度内全部帧（含 null）；targetSemitone 为 null 时只报中心不报误差。
function analyzeNoteSeries(noteFrames, targetSemitone, params, fs, { vibrato }) {
  const finite = noteFrames.filter((frame) => Number.isFinite(frame.value));
  const result = {
    frameCount: noteFrames.length,
    validFrameCount: finite.length,
    coverage: noteFrames.length > 0 ? finite.length / noteFrames.length : 0,
  };
  if (finite.length < params.minValidFramesPerNote) {
    result.status = "insufficient_data";
    return result;
  }
  result.status = "ok";
  if (targetSemitone !== null) {
    // 逐帧误差只是诊断：带颤音的长音在此必然波动，不代表跑调。
    result.framewise = summarizeCents(
      finite.map((frame) => (frame.value - targetSemitone) * 100)
    );
  }
  // 稳态段：按帧位置对称去掉 attack/release 边缘，再取均值作为感知音高中心。
  const cut = Math.floor(noteFrames.length * params.edgeExclusionRatio);
  const stable = noteFrames.slice(cut, noteFrames.length - cut);
  const stableFinite = stable.filter((frame) => Number.isFinite(frame.value));
  if (stableFinite.length >= params.centerMinFrames) {
    const center =
      stableFinite.reduce((sum, frame) => sum + frame.value, 0) / stableFinite.length;
    result.center = {
      status: "ok",
      valueSemitone: center,
      stableFrameCount: stableFinite.length,
      ...(targetSemitone !== null ? { errorCent: (center - targetSemitone) * 100 } : {}),
    };
  } else {
    result.center = { status: "insufficient_data", stableFrameCount: stableFinite.length };
  }
  if (vibrato) {
    const run = longestFiniteRun(stable);
    result.vibrato = detectVibrato(
      run.map((frame) => frame.value * 100),
      fs,
      params.vibrato
    );
  }
  return result;
}

function buildTransitions(spans, perSpan, params, context) {
  const transitions = [];
  for (let index = 0; index + 1 < spans.length; index += 1) {
    const from = spans[index];
    const to = spans[index + 1];
    const direction = Math.sign(to.targetSemitone - from.targetSemitone);
    const item = {
      fromNote: from.indexInGroup,
      toNote: to.indexInGroup,
      intervalSemitones: to.targetSemitone - from.targetSemitone,
      gapBlick: Math.max(0, to.absOnsetBlick - from.absEndBlick),
    };
    if (direction === 0) {
      transitions.push({ ...item, status: "skipped_same_pitch" });
      continue;
    }
    transitions.push({
      ...item,
      direction: direction > 0 ? "up" : "down",
      ...analyzeTransition(to, perSpan[index + 1], direction, params.transition, context),
    });
  }
  return transitions;
}

// 转换分析只看进入新音符后的窗口：overshoot（越过目标的最大有向偏差）、
// arrival（首次进入到达带）与 settling（连续 holdFrames 帧维持在稳定带内）。
function analyzeTransition(toSpan, toFrames, direction, params, context) {
  const boundarySeconds = secondsAtBlick(
    context.tempoMarks,
    context.quarterBlick,
    toSpan.absOnsetBlick
  );
  if (boundarySeconds === null) return { status: "insufficient_data", reason: "tempo_unavailable" };
  const windowSeconds = params.windowMs / 1000;
  const windowFrames = [];
  for (const frame of toFrames) {
    const seconds = secondsAtBlick(context.tempoMarks, context.quarterBlick, frame.blick);
    if (seconds === null) break;
    const offsetMs = (seconds - boundarySeconds) * 1000;
    if (seconds - boundarySeconds > windowSeconds) break;
    windowFrames.push({ ...frame, offsetMs });
  }
  const finite = windowFrames.filter((frame) => Number.isFinite(frame.value));
  if (finite.length === 0) return { status: "insufficient_data", reason: "no_frames_in_window" };
  let overshootCent = 0;
  let arrivalMs = null;
  let settlingMs = null;
  let holdRun = 0;
  for (const frame of windowFrames) {
    if (!Number.isFinite(frame.value)) {
      holdRun = 0;
      continue;
    }
    const errorCent = (frame.value - toSpan.targetSemitone) * 100;
    overshootCent = Math.max(overshootCent, direction * errorCent);
    if (arrivalMs === null && Math.abs(errorCent) <= params.arrivalBandCent) {
      arrivalMs = frame.offsetMs;
    }
    if (Math.abs(errorCent) <= params.settleBandCent) {
      holdRun += 1;
      if (holdRun >= params.holdFrames && settlingMs === null) {
        settlingMs = windowFrames[windowFrames.indexOf(frame) - (params.holdFrames - 1)].offsetMs;
      }
    } else {
      holdRun = 0;
    }
  }
  return {
    status: "ok",
    windowFrameCount: finite.length,
    overshootCent,
    arrived: arrivalMs !== null,
    ...(arrivalMs !== null ? { arrivalMs } : {}),
    settled: settlingMs !== null,
    ...(settlingMs !== null ? { settlingMs } : {}),
  };
}

// ---------- compare_contexts ----------

async function runContextsAnalysis(loaded, input, warnings, timer) {
  const { before, after } = loaded;
  const context = after.stored.context;
  const series = after.series;
  const params = input.analysis;
  const beforePartition = buildNoteSpanPartition(before.occurrence);
  const afterPartition = buildNoteSpanPartition(after.occurrence);
  if (beforePartition.inputNoteCount > 0 && beforePartition.melodicSpans.length === 0) {
    throw noMelodicEvidence(beforePartition, "before");
  }
  if (afterPartition.inputNoteCount > 0 && afterPartition.melodicSpans.length === 0) {
    throw noMelodicEvidence(afterPartition, "after");
  }
  const excludedFrameMask = buildExcludedFrameMask(series, [
    ...beforePartition.excludedSpans,
    ...afterPartition.excludedSpans,
  ]);
  const sampling = {
    ...buildSamplingBlock(series, context, params, warnings),
    nullFrames: {
      before: before.series.evidence?.nullFrameIndices?.length ?? null,
      after: after.series.evidence?.nullFrameIndices?.length ?? null,
    },
  };

  const base = await timer.measure("statsMs", async () => {
    const frameCents = new Array(series.frames).fill(null);
    const deltasSemitone = [];
    for (let index = 0; index < series.frames; index += 1) {
      if (excludedFrameMask.mask[index] === 1) continue;
      const beforeValue = before.series.values[index];
      const afterValue = after.series.values[index];
      if (!Number.isFinite(beforeValue) || !Number.isFinite(afterValue)) continue;
      const delta = afterValue - beforeValue;
      deltasSemitone.push(delta);
      frameCents[index] = {
        blick: series.startBlick + index * series.intervalBlick,
        cents: delta * 100,
      };
    }
    if (deltasSemitone.length === 0) {
      throw insufficientComputedPitch(series, {
        finiteFrames: 0,
        framesOutsideNotes: 0,
      });
    }
    return { frameCents, deltasSemitone };
  });

  const detail = await timer.measure("detectMs", async () => {
    const anomalies = input.metrics.anomalySegments
      ? collectAnomalySegments(base.frameCents, params.anomalyThresholdCent)
      : null;
    if (input.responseMode === "compact") return { anomalies };
    const perNote = input.metrics.perNote
      ? buildContextsPerNote(
          before,
          after,
          params,
          input.metrics.vibrato,
          warnings,
          afterPartition.melodicSpans
        )
      : null;
    return { anomalies, perNote };
  });

  const eligibleFrameCount = Math.max(0, series.frames - excludedFrameMask.count);
  const coverage = eligibleFrameCount > 0 ? base.deltasSemitone.length / eligibleFrameCount : 0;
  warnLowCoverage(coverage, params, warnings);
  return {
    ok: true,
    status: "succeeded",
    mode: "compare_contexts",
    before: publicSide(before),
    after: publicSide(after),
    noteCounts: {
      before: {
        inputNoteCount: beforePartition.inputNoteCount,
        melodicNoteCount: beforePartition.melodicSpans.length,
      },
      after: {
        inputNoteCount: afterPartition.inputNoteCount,
        melodicNoteCount: afterPartition.melodicSpans.length,
      },
    },
    excludedEvents: {
      before: beforePartition.excludedEvents,
      after: afterPartition.excludedEvents,
    },
    sampling,
    summary: {
      frameCount: series.frames,
      eligibleFrameCount,
      excludedFrameCount: excludedFrameMask.count,
      validFrameCount: base.deltasSemitone.length,
      coverage,
      orientation: "after_minus_before",
      ...summarizeCents(base.deltasSemitone.map((delta) => delta * 100)),
    },
    semitoneDelta: buildSemitoneDelta(base.deltasSemitone),
    ...(input.responseMode === "compact"
      ? {}
      : {
          ...(detail.perNote ? { perNote: detail.perNote } : {}),
          analysis: publicAnalysisParams(params),
        }),
    ...(detail.anomalies
      ? { anomalySegments: emitAnomalies(detail.anomalies, input.responseMode, input.anomalySortBy) }
      : {}),
  };
}

// §13.8 兼容的半音差值统计（after - before）。
function buildSemitoneDelta(deltas) {
  const sorted = [...deltas].sort((a, b) => a - b);
  const absMax = Math.max(...deltas.map(Math.abs));
  const framesAtLeast = Object.create(null);
  for (const key of SEMITONE_DELTA_THRESHOLDS) {
    const threshold = Number(key);
    framesAtLeast[key] = deltas.filter((delta) => Math.abs(delta) >= threshold).length;
  }
  return {
    comparedFrames: deltas.length,
    meanDeltaSemitone: deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length,
    meanAbsoluteDeltaSemitone:
      deltas.reduce((sum, delta) => sum + Math.abs(delta), 0) / deltas.length,
    minDeltaSemitone: sorted[0],
    maxDeltaSemitone: sorted[sorted.length - 1],
    maxAbsoluteDeltaSemitone: absMax,
    framesAtLeast,
  };
}

function buildContextsPerNote(before, after, params, wantVibrato, warnings, melodicSpans = null) {
  const spans = melodicSpans ?? buildNoteSpanPartition(after.occurrence).melodicSpans;
  if (spans.length === 0) {
    warnings.push({
      code: "NOTES_NOT_CAPTURED",
      message:
        'per-note comparison skipped: the after context has no note fingerprints (snapshot with include ["notes","computedPitch"]).',
    });
    return null;
  }
  // indexInGroup 不是跨快照稳定身份（结构编辑会重排），故不能按它对齐 before/after：
  // 开头插入一个音符会让其后所有 index 错位，把新音符拿去和旧音符比。改按乐谱绝对起点建立 before 索引。
  const beforeOffset = before.occurrence.timeOffsetBlick ?? 0;
  const beforeByOnset = new Map(
    (before.occurrence.noteFingerprints ?? []).map((fingerprint) => [
      beforeOffset + fingerprint.onsetBlick,
      fingerprint,
    ])
  );
  const afterByIndex = new Map(
    (after.occurrence.noteFingerprints ?? []).map((fingerprint) => [
      fingerprint.indexInGroup,
      fingerprint,
    ])
  );
  // onset 集合一致 = 无插入/删除/移动，只可能就地编辑：位置窗口逐一可信，按 onset 对齐即可。
  // onset 集合不同 = 结构变化：位置窗口与音符身份不再一一对应（插入会占用被后移音符的旧 onset），
  // 只对"完全未变"（同 onset 且指纹一致）的音符给 delta，其余标 unmatched 并省略 before/delta，避免误导数值。
  const afterOnsets = spans.map((span) => span.absOnsetBlick);
  const structuralChange =
    beforeByOnset.size !== afterOnsets.length ||
    afterOnsets.some((onset) => !beforeByOnset.has(onset));
  const beforePitchOffset = before.occurrence.pitchOffsetSemitone ?? 0;
  const afterFrames = buildTargetFrameData(after.series, spans).perSpan;
  const beforeFrames = spans.map((span, index) =>
    afterFrames[index].map((frame) => ({
      ...frame,
      value: before.series.values[frame.frameIndex],
    }))
  );
  // 先对全量 span 做廉价的指纹分类：matched/unmatched/edited 与告警必须统计全量，
  // MAX_PER_NOTE_ITEMS 截断只作用于昂贵的逐音符序列分析（items 明细）。
  const classified = spans.map((span) => {
    const afterFingerprint = afterByIndex.get(span.indexInGroup) ?? null;
    const beforeFingerprint = beforeByOnset.get(span.absOnsetBlick) ?? null;
    const changedFields = beforeFingerprint ? diffFingerprints(beforeFingerprint, afterFingerprint) : [];
    // 结构变化下，只有 onset 处存在且指纹完全一致的音符（既没移动也没改动）位置窗口才可信。
    const comparable = Boolean(beforeFingerprint) && (!structuralChange || changedFields.length === 0);
    return { span, beforeFingerprint, changedFields, comparable };
  });
  const matchedTotal = classified.filter((entry) => entry.comparable).length;
  const unmatchedTotal = classified.length - matchedTotal;
  const editedTotal = classified.filter(
    (entry) => entry.comparable && entry.changedFields.length > 0
  ).length;
  const items = [];
  for (let index = 0; index < classified.length && items.length < MAX_PER_NOTE_ITEMS; index += 1) {
    const { span, beforeFingerprint, changedFields, comparable } = classified[index];
    const midBlick = Math.floor((span.absOnsetBlick + span.absEndBlick) / 2);
    // Hz 类指标（颤音）需按各侧自己的 tempo 图换算帧率：tempo 不同则 before/after 采样率不同，不能共用一个 fs。
    const fsAfter = frameRateAt(
      after.stored.context.tempoMarks,
      after.stored.context.quarterBlick,
      midBlick,
      after.series.intervalBlick
    );
    const afterResult = analyzeNoteSeries(afterFrames[index], span.targetSemitone, params, fsAfter, {
      vibrato: wantVibrato,
    });
    if (!comparable) {
      items.push({
        note: span.indexInGroup,
        indexInGroup: span.indexInGroup,
        lyrics: span.lyrics,
        unmatched: true,
        unmatchedReason: beforeFingerprint ? "structure_changed" : "no_before_note_at_position",
        after: afterResult,
      });
      continue;
    }
    const fsBefore = frameRateAt(
      before.stored.context.tempoMarks,
      before.stored.context.quarterBlick,
      midBlick,
      before.series.intervalBlick
    );
    const beforeTarget =
      beforeFingerprint.pitch + (beforeFingerprint.detuneCents ?? 0) / 100 + beforePitchOffset;
    const beforeResult = analyzeNoteSeries(beforeFrames[index], beforeTarget, params, fsBefore, {
      vibrato: wantVibrato,
    });
    items.push({
      note: span.indexInGroup,
      indexInGroup: span.indexInGroup,
      lyrics: span.lyrics,
      ...(changedFields.length > 0 ? { noteChanged: true, changedFields } : {}),
      before: beforeResult,
      after: afterResult,
      ...(beforeResult.center?.status === "ok" && afterResult.center?.status === "ok"
        ? {
            centerDeltaCent:
              (afterResult.center.valueSemitone - beforeResult.center.valueSemitone) * 100,
          }
        : {}),
    });
  }
  if (editedTotal > 0) {
    warnings.push({
      code: "NOTE_STRUCTURE_CHANGED",
      message: `${editedTotal} matched note(s) had edited fields between snapshots; the per-note delta compares the same score position and is flagged noteChanged.`,
    });
  }
  if (unmatchedTotal > 0) {
    warnings.push({
      code: "PER_NOTE_UNMATCHED",
      message: `${unmatchedTotal} after-note(s) had no unchanged before-note at the same score position (inserted or moved by a structural edit); reported without a before/delta.`,
    });
  }
  const truncated = spans.length > items.length;
  if (truncated) {
    warnings.push({
      code: "PER_NOTE_TRUNCATED",
      message: `perNote reports the first ${MAX_PER_NOTE_ITEMS} of ${spans.length} notes; matched/unmatched still count all ${spans.length}. Narrow the snapshot range for full per-note detail.`,
    });
  }
  // matched/unmatched 是全量计数（与 count 同口径），items 明细才受截断影响。
  return {
    count: spans.length,
    matched: matchedTotal,
    unmatched: unmatchedTotal,
    truncated,
    items,
  };
}

function diffFingerprints(before, after) {
  if (!after) return [];
  if (!before) return ["missing_before"];
  const changed = [];
  for (const field of ["onsetBlick", "durationBlick", "pitch", "detuneCents", "lyrics"]) {
    if (before[field] !== after[field]) changed.push(field);
  }
  return changed;
}

// ---------- 颤音检测（去趋势 + 归一化自相关） ----------

// valuesCents：稳态段内最长连续有限帧（cent 单位）；fs：该音符处的帧率（Hz）。
// 返回值只报实测 rate/depth/regularity，不与任何“规范颤音区间”比较——那是风格判断。
export function detectVibrato(valuesCents, fs, params) {
  if (!Number.isFinite(fs) || fs <= 0) {
    return { status: "insufficient_data", reason: "frame_rate_unavailable" };
  }
  if (valuesCents.length < params.minWindowFrames) {
    return {
      status: "insufficient_data",
      reason: "window_too_short",
      windowFrames: valuesCents.length,
    };
  }
  const [hzMin, hzMax] = params.hzRange;
  const framesPerCycle = fs / hzMax;
  const samplingAssessment =
    framesPerCycle >= 4 ? "ok" : framesPerCycle >= 2 ? "borderline" : "too_coarse";
  // Nyquist 硬下限是 2 帧/周期；4 帧/周期是稳健估计的工程目标，不是物理红线。
  if (samplingAssessment === "too_coarse") {
    return {
      status: "sampling_too_coarse",
      frameRateHz: fs,
      framesPerCycleAtHzMax: framesPerCycle,
    };
  }
  const kMin = Math.max(2, Math.ceil(fs / hzMax));
  const kMax = Math.min(Math.floor(valuesCents.length / 2), Math.round(fs / hzMin));
  if (kMax < kMin) {
    return {
      status: "sampling_too_coarse",
      frameRateHz: fs,
      framesPerCycleAtHzMax: framesPerCycle,
    };
  }
  // 一阶线性去趋势：把滑音/漂移从周期成分中剥离。
  const residuals = detrendLinear(valuesCents);
  let bestLag = kMin;
  let bestRho = -Infinity;
  for (let lag = kMin; lag <= kMax; lag += 1) {
    const rho = normalizedAutocorrelation(residuals, lag);
    if (rho > bestRho) {
      bestRho = rho;
      bestLag = lag;
    }
  }
  if (!(bestRho >= params.minPeakCorrelation)) {
    return {
      status: "not_detected",
      peakCorrelation: Number.isFinite(bestRho) ? bestRho : null,
      frameRateHz: fs,
      samplingAssessment,
    };
  }
  const sorted = [...residuals].sort((a, b) => a - b);
  const depthCent = (quantileSorted(sorted, 0.95) - quantileSorted(sorted, 0.05)) / 2;
  const windowScore = Math.min(1, valuesCents.length / (2 * params.minWindowFrames));
  const samplingScore = samplingAssessment === "ok" ? 1 : 0.6;
  return {
    status: "ok",
    rateHz: fs / bestLag,
    depthCent,
    regularity: bestRho,
    windowFrames: valuesCents.length,
    frameRateHz: fs,
    samplingAssessment,
    confidence: {
      score: clamp01(bestRho) * windowScore * samplingScore,
      kind: "heuristic_score",
      calibrated: false,
      components: {
        peakCorrelation: bestRho,
        windowFrames: valuesCents.length,
        samplingAssessment,
      },
    },
  };
}

function detrendLinear(values) {
  const n = values.length;
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((sum, value) => sum + value, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < n; index += 1) {
    numerator += (index - meanX) * (values[index] - meanY);
    denominator += (index - meanX) ** 2;
  }
  const slope = denominator > 0 ? numerator / denominator : 0;
  const intercept = meanY - slope * meanX;
  return values.map((value, index) => value - (intercept + slope * index));
}

function normalizedAutocorrelation(values, lag) {
  const n = values.length - lag;
  if (n <= 1) return 0;
  let numerator = 0;
  let headEnergy = 0;
  let tailEnergy = 0;
  for (let index = 0; index < n; index += 1) {
    numerator += values[index] * values[index + lag];
    headEnergy += values[index] ** 2;
    tailEnergy += values[index + lag] ** 2;
  }
  const denominator = Math.sqrt(headEnergy * tailEnergy);
  return denominator > 0 ? numerator / denominator : 0;
}

function longestFiniteRun(frames) {
  let best = [];
  let current = [];
  for (const frame of frames) {
    if (Number.isFinite(frame.value)) {
      current.push(frame);
      if (current.length > best.length) best = current;
    } else {
      current = [];
    }
  }
  return best;
}

// ---------- 通用统计与时间换算 ----------

function summarizeCents(values) {
  const n = values.length;
  if (n === 0) return {};
  const sorted = [...values].sort((a, b) => a - b);
  const absSorted = values.map(Math.abs).sort((a, b) => a - b);
  const sum = values.reduce((total, value) => total + value, 0);
  const sumAbs = absSorted.reduce((total, value) => total + value, 0);
  const sumSquares = values.reduce((total, value) => total + value * value, 0);
  return {
    meanCent: sum / n,
    medianCent: n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2,
    maeCent: sumAbs / n,
    rmseCent: Math.sqrt(sumSquares / n),
    p95AbsCent: quantileSorted(absSorted, 0.95),
    maxAbsCent: absSorted[n - 1],
  };
}

function quantileSorted(sortedAscending, quantile) {
  const n = sortedAscending.length;
  const index = Math.min(n - 1, Math.max(0, Math.ceil(quantile * n) - 1));
  return sortedAscending[index];
}

function collectAnomalySegments(frameCents, thresholdCent) {
  const segments = [];
  let current = null;
  for (let index = 0; index < frameCents.length; index += 1) {
    const frame = frameCents[index];
    const qualifies = frame !== null && Math.abs(frame.cents) >= thresholdCent;
    if (qualifies) {
      if (!current) {
        current = {
          startFrameIndex: index,
          startBlick: frame.blick,
          peakAbsCent: 0,
          frames: 0,
        };
      }
      current.endFrameIndex = index;
      current.endBlick = frame.blick;
      current.frames += 1;
      current.peakAbsCent = Math.max(current.peakAbsCent, Math.abs(frame.cents));
    } else if (current) {
      segments.push(current);
      current = null;
    }
  }
  if (current) segments.push(current);
  // 扫描天然按时间顺序产出；排序交给 emitAnomalies 按请求的 sortBy 决定。
  return segments;
}

function emitAnomalies(segments, responseMode, sortBy) {
  // top 恒为最严重段：无论 sortBy 与截断如何，最严重段绝不被时间序截断吞掉。
  const top = segments.reduce(
    (best, segment) => (best === null || segment.peakAbsCent > best.peakAbsCent ? segment : best),
    null
  );
  if (responseMode === "compact") {
    return { total: segments.length, sortBy, top };
  }
  const sorted =
    sortBy === "severity"
      ? [...segments].sort(
          (left, right) =>
            right.peakAbsCent - left.peakAbsCent || left.startBlick - right.startBlick
        )
      : [...segments].sort((left, right) => left.startBlick - right.startBlick);
  return {
    total: segments.length,
    sortBy,
    truncated: segments.length > MAX_ANOMALY_SEGMENTS,
    top,
    items: sorted.slice(0, MAX_ANOMALY_SEGMENTS),
  };
}

// tempoMarks 换算已提升到 musical-time.js（secondsAtBlick），compare 与 expression-plan 共享。
function frameRateAt(tempoMarks, quarterBlick, blick, intervalBlick) {
  const start = secondsAtBlick(tempoMarks, quarterBlick, blick);
  const end = secondsAtBlick(tempoMarks, quarterBlick, blick + intervalBlick);
  if (start === null || end === null || end <= start) return null;
  return 1 / (end - start);
}

function buildSamplingBlock(series, context, params, warnings) {
  const fs = frameRateAt(
    context.tempoMarks,
    context.quarterBlick,
    series.startBlick,
    series.intervalBlick
  );
  const hzMax = params.vibrato.hzRange[1];
  const framesPerCycle = fs === null ? null : fs / hzMax;
  const samplingAssessment =
    fs === null
      ? "unknown"
      : framesPerCycle >= 4
        ? "ok"
        : framesPerCycle >= 2
          ? "borderline"
          : "too_coarse";
  if (samplingAssessment === "unknown") {
    warnings.push({
      code: "TEMPO_MAP_MISSING",
      message: "No usable tempo map in the context; Hz-based metrics are unavailable.",
    });
  } else if (samplingAssessment === "borderline") {
    warnings.push({
      code: "SAMPLING_BORDERLINE_FOR_VIBRATO",
      message:
        "Computed-pitch frame rate is a borderline sample rate for vibrato parameterization; vibrato confidence is reduced. Re-snapshot with a smaller intervalBlick for robust vibrato metrics.",
    });
  } else if (samplingAssessment === "too_coarse") {
    warnings.push({
      code: "SAMPLING_TOO_COARSE_FOR_VIBRATO",
      message:
        "Computed-pitch frame rate is too coarse to measure vibrato in the requested Hz range; vibrato is skipped. Center/intonation metrics remain valid.",
    });
  }
  return {
    startBlick: series.startBlick,
    intervalBlick: series.intervalBlick,
    frames: series.frames,
    frameRateHz: fs,
    framesPerCycleAtHzMax: framesPerCycle,
    samplingAssessment,
    nullFrames: series.evidence?.nullFrameIndices?.length ?? null,
  };
}

// 低覆盖率显式警告：有效帧太少时汇总统计基于小样本，绝不能默默当成可靠结论。
// 覆盖率语义按模式不同（to_target=对齐到音符的有效帧占比；contexts=两侧同帧有限的占比），
// 阈值同一个：低于 lowCoverageWarnRatio 即警告。
function warnLowCoverage(coverage, params, warnings) {
  if (coverage >= params.lowCoverageWarnRatio) return;
  warnings.push({
    code: "LOW_COMPUTED_PITCH_COVERAGE",
    message: `Only ${(coverage * 100).toFixed(1)}% of frames carry usable pitch (threshold ${(params.lowCoverageWarnRatio * 100).toFixed(0)}%); summary statistics rest on a small sample and may not represent the range. Check sv_wait_for_processing, the range bounds, or unvoiced content before trusting them.`,
  });
}

function insufficientComputedPitch(series, frameData) {
  const observed = series.evidence?.observedFrames ?? frameData.finiteFrames;
  const error = codedError(
    "INSUFFICIENT_COMPUTED_PITCH",
    observed === 0
      ? "All computed-pitch frames are null: host processing may not have completed at snapshot time, or the range is entirely unvoiced. Re-run sv_wait_for_processing and snapshot again."
      : "No computed-pitch frames usable for comparison (finite frames exist but none align with notes or with the other context)."
  );
  error.details = {
    frameCount: series.values?.length ?? series.frames,
    finiteFrames: frameData.finiteFrames,
    framesOutsideNotes: frameData.framesOutsideNotes,
  };
  return error;
}

function noMelodicEvidence(partition, side = "request") {
  const error = codedError(
    "NO_MELODIC_EVIDENCE",
    `${side} occurrence contains note fingerprints, but every event is excluded from melodic computed-pitch analysis.`
  );
  error.details = {
    side,
    inputNoteCount: partition.inputNoteCount,
    melodicNoteCount: 0,
    excludedEvents: partition.excludedEvents,
  };
  return error;
}

// ---------- 输出辅助 ----------

function publicOccurrence(occurrence, ordinal) {
  return {
    occurrence: ordinal,
    trackIndex: occurrence.trackIndex,
    groupIndex: occurrence.groupIndex,
    targetGroupUuid: occurrence.targetGroupUuid,
    timeOffsetBlick: occurrence.timeOffsetBlick,
    pitchOffsetSemitone: occurrence.pitchOffsetSemitone ?? 0,
  };
}

function publicSide(side) {
  return {
    contextId: side.stored.contextId,
    observedAt: side.stored.observedAt,
    snapshotToken: side.stored.snapshotToken ?? null,
    occurrence: publicOccurrence(side.occurrence, side.ordinal),
  };
}

function publicAnalysisParams(params) {
  return {
    ...params,
    vibrato: { ...params.vibrato, hzRange: [...params.vibrato.hzRange] },
    transition: { ...params.transition },
    basis: "engineering_defaults_requires_host_calibration",
  };
}

// ---------- 请求校验 ----------

function normalizeCompareRequest(request) {
  if (!isRecord(request)) throw codedError("INVALID_ARGUMENTS", "request must be an object");
  assertKnownKeys(
    request,
    [
      "mode",
      "contextId",
      "occurrence",
      "before",
      "after",
      "metrics",
      "analysis",
      "anomalySortBy",
      "responseMode",
    ],
    "request"
  );
  const mode = request.mode;
  if (!["compare_to_target", "compare_contexts"].includes(mode)) {
    throw codedError(
      "INVALID_ARGUMENTS",
      'mode must be "compare_to_target" or "compare_contexts"'
    );
  }
  const responseMode = request.responseMode ?? "standard";
  if (!["compact", "standard", "verbose"].includes(responseMode)) {
    throw codedError("INVALID_ARGUMENTS", "responseMode must be compact, standard, or verbose");
  }
  const anomalySortBy = request.anomalySortBy ?? "startBlick";
  if (!ANOMALY_SORT_MODES.includes(anomalySortBy)) {
    throw codedError(
      "INVALID_ARGUMENTS",
      `anomalySortBy must be one of ${ANOMALY_SORT_MODES.join(", ")}`
    );
  }
  const metrics = normalizeMetrics(request.metrics);
  const analysis = normalizeAnalysisParams(request.analysis);
  if (mode === "compare_to_target") {
    if (request.before !== undefined || request.after !== undefined) {
      throw codedError("INVALID_ARGUMENTS", "compare_to_target does not accept before/after");
    }
    requireContextId(request.contextId, "contextId");
    requireOptionalOrdinal(request.occurrence, "occurrence");
    return {
      mode,
      contextId: request.contextId,
      occurrence: request.occurrence,
      metrics,
      analysis,
      anomalySortBy,
      responseMode,
    };
  }
  if (request.contextId !== undefined || request.occurrence !== undefined) {
    throw codedError(
      "INVALID_ARGUMENTS",
      "compare_contexts takes before/after objects, not a top-level contextId"
    );
  }
  const before = normalizeSide(request.before, "before");
  const after = normalizeSide(request.after, "after");
  return { mode, before, after, metrics, analysis, anomalySortBy, responseMode };
}

function normalizeSide(value, label) {
  if (!isRecord(value)) throw codedError("INVALID_ARGUMENTS", `${label} must be an object`);
  assertKnownKeys(value, ["contextId", "occurrence"], label);
  requireContextId(value.contextId, `${label}.contextId`);
  requireOptionalOrdinal(value.occurrence, `${label}.occurrence`);
  return { contextId: value.contextId, occurrence: value.occurrence };
}

function normalizeMetrics(value) {
  const defaults = { perNote: true, vibrato: true, transitions: true, anomalySegments: true };
  if (value === undefined) return defaults;
  if (!isRecord(value)) throw codedError("INVALID_ARGUMENTS", "metrics must be an object");
  assertKnownKeys(value, Object.keys(defaults), "metrics");
  const metrics = { ...defaults };
  for (const key of Object.keys(defaults)) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== "boolean") {
      throw codedError("INVALID_ARGUMENTS", `metrics.${key} must be a boolean`);
    }
    metrics[key] = value[key];
  }
  return metrics;
}

function normalizeAnalysisParams(value) {
  const defaults = COMPARE_ANALYSIS_DEFAULTS;
  if (value === undefined) return cloneAnalysisDefaults();
  if (!isRecord(value)) throw codedError("INVALID_ARGUMENTS", "analysis must be an object");
  assertKnownKeys(
    value,
    [
      "minValidFramesPerNote",
      "edgeExclusionRatio",
      "centerMinFrames",
      "lowCoverageWarnRatio",
      "vibrato",
      "transition",
      "anomalyThresholdCent",
    ],
    "analysis"
  );
  const merged = cloneAnalysisDefaults();
  merged.minValidFramesPerNote = checkedInteger(
    value.minValidFramesPerNote,
    1,
    2000,
    defaults.minValidFramesPerNote,
    "analysis.minValidFramesPerNote"
  );
  merged.edgeExclusionRatio = checkedNumber(
    value.edgeExclusionRatio,
    0,
    0.4,
    defaults.edgeExclusionRatio,
    "analysis.edgeExclusionRatio"
  );
  merged.centerMinFrames = checkedInteger(
    value.centerMinFrames,
    1,
    2000,
    defaults.centerMinFrames,
    "analysis.centerMinFrames"
  );
  merged.lowCoverageWarnRatio = checkedNumber(
    value.lowCoverageWarnRatio,
    0,
    1,
    defaults.lowCoverageWarnRatio,
    "analysis.lowCoverageWarnRatio"
  );
  merged.anomalyThresholdCent = checkedNumber(
    value.anomalyThresholdCent,
    1,
    1200,
    defaults.anomalyThresholdCent,
    "analysis.anomalyThresholdCent"
  );
  if (value.vibrato !== undefined) {
    if (!isRecord(value.vibrato)) {
      throw codedError("INVALID_ARGUMENTS", "analysis.vibrato must be an object");
    }
    assertKnownKeys(
      value.vibrato,
      ["minWindowFrames", "hzRange", "minPeakCorrelation"],
      "analysis.vibrato"
    );
    merged.vibrato.minWindowFrames = checkedInteger(
      value.vibrato.minWindowFrames,
      4,
      2000,
      defaults.vibrato.minWindowFrames,
      "analysis.vibrato.minWindowFrames"
    );
    merged.vibrato.minPeakCorrelation = checkedNumber(
      value.vibrato.minPeakCorrelation,
      0,
      1,
      defaults.vibrato.minPeakCorrelation,
      "analysis.vibrato.minPeakCorrelation"
    );
    if (value.vibrato.hzRange !== undefined) {
      const hzRange = value.vibrato.hzRange;
      if (
        !Array.isArray(hzRange) ||
        hzRange.length !== 2 ||
        !hzRange.every((item) => Number.isFinite(item) && item >= 0.5 && item <= 20) ||
        !(hzRange[0] < hzRange[1])
      ) {
        throw codedError(
          "INVALID_ARGUMENTS",
          "analysis.vibrato.hzRange must be an ascending [min, max] within 0.5-20 Hz"
        );
      }
      merged.vibrato.hzRange = [hzRange[0], hzRange[1]];
    }
  }
  if (value.transition !== undefined) {
    if (!isRecord(value.transition)) {
      throw codedError("INVALID_ARGUMENTS", "analysis.transition must be an object");
    }
    assertKnownKeys(
      value.transition,
      ["arrivalBandCent", "settleBandCent", "holdFrames", "windowMs"],
      "analysis.transition"
    );
    merged.transition.arrivalBandCent = checkedNumber(
      value.transition.arrivalBandCent,
      1,
      1200,
      defaults.transition.arrivalBandCent,
      "analysis.transition.arrivalBandCent"
    );
    merged.transition.settleBandCent = checkedNumber(
      value.transition.settleBandCent,
      1,
      1200,
      defaults.transition.settleBandCent,
      "analysis.transition.settleBandCent"
    );
    merged.transition.holdFrames = checkedInteger(
      value.transition.holdFrames,
      1,
      50,
      defaults.transition.holdFrames,
      "analysis.transition.holdFrames"
    );
    merged.transition.windowMs = checkedNumber(
      value.transition.windowMs,
      20,
      5000,
      defaults.transition.windowMs,
      "analysis.transition.windowMs"
    );
  }
  return merged;
}

function cloneAnalysisDefaults() {
  const defaults = COMPARE_ANALYSIS_DEFAULTS;
  return {
    minValidFramesPerNote: defaults.minValidFramesPerNote,
    edgeExclusionRatio: defaults.edgeExclusionRatio,
    centerMinFrames: defaults.centerMinFrames,
    lowCoverageWarnRatio: defaults.lowCoverageWarnRatio,
    vibrato: { ...defaults.vibrato, hzRange: [...defaults.vibrato.hzRange] },
    transition: { ...defaults.transition },
    anomalyThresholdCent: defaults.anomalyThresholdCent,
  };
}

function requireContextId(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw codedError("INVALID_ARGUMENTS", `${label} must be a non-empty string`);
  }
}

function requireOptionalOrdinal(value, label) {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw codedError(
      "INVALID_ARGUMENTS",
      `${label} must be a non-negative occurrence ordinal when provided`
    );
  }
}

function checkedInteger(value, minimum, maximum, fallback, label) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw codedError(
      "INVALID_ARGUMENTS",
      `${label} must be an integer between ${minimum} and ${maximum}`
    );
  }
  return value;
}

function checkedNumber(value, minimum, maximum, fallback, label) {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw codedError(
      "INVALID_ARGUMENTS",
      `${label} must be a number between ${minimum} and ${maximum}`
    );
  }
  return value;
}

function tempoMarksEqual(left, right) {
  const normalize = (marks) =>
    JSON.stringify(
      (Array.isArray(marks) ? marks : []).map((mark) => [mark.positionBlick, mark.bpm])
    );
  return normalize(left) === normalize(right);
}

function pickGrid(series) {
  return {
    startBlick: series.startBlick,
    intervalBlick: series.intervalBlick,
    frames: series.frames,
  };
}

function assertKnownKeys(value, allowed, label) {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw codedError("INVALID_ARGUMENTS", `${label} contains unknown field: ${unknown.join(", ")}`);
  }
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
