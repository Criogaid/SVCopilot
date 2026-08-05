import { segmentPhrases } from "./expression-plan.js";
import {
  HARMONIC_INCLUDES,
  HARMONIC_PROVENANCE,
  analyzeCadence,
  analyzeChordCandidates,
  analyzeMetricalRoles,
  analyzeTensionResolution,
} from "./harmonic-context.js";
import { ServiceTiming } from "./service-timing.js";
import {
  analyzeVocalEventSequence,
  summarizeExcludedVocalEvents,
} from "./vocal-event-semantics.js";
import { unknownContextError } from "./snapshot.js";
import { selectOccurrenceByOrdinal } from "./scope-source.js";

// sv_analyze_phrase：只读乐理分析（调性候选 / 音级 / 乐句 / 统计）。
//
// 关键契约：
// - 纯内存只读：只读取 range context 的音符指纹，不访问宿主。
// - 调性检测是"排序器"不是"分类器"：时值加权音级直方图与 24 个 Krumhansl-Kessler
//   profile 旋转做皮尔逊相关，返回排序候选 + 与次名的差距（margin）。旋律（尤其
//   单声部短句）在关系大小调间天然歧义，把歧义如实暴露正是正确行为。
// - V2 官方特殊歌词语义由 vocal-event-semantics 统一解释。只有精确小写 "br" 是呼吸事件；
//   无合法前驱的 +/- 与未校准的单独 apostrophe 也不作为高层音乐证据。原始歌词始终保留。
// - 全部结论标 derived/heuristic：乐句、climax、调性都是推断，不是宿主事实；
//   拼写只用升号（不做同音异名判定）；小调音级按自然小调解释。
export const PHRASE_ANALYSIS_INCLUDES = Object.freeze([
  "key",
  "scaleDegrees",
  "phrases",
  "statistics",
  ...HARMONIC_INCLUDES,
]);
// 默认只返回基础四项。P1-A 的和声语境 section 需要显式 include：它们体积更大，
// 而且结论受"只观察到单旋律"的硬约束，不应在调用方没要求时悄悄塞进响应。
const DEFAULT_INCLUDES = Object.freeze(["key", "scaleDegrees", "phrases", "statistics"]);

// Krumhansl-Kessler (1982) 音级权重（music21 analysis/discrete.py 同源）。
const KK_MAJOR = Object.freeze([
  6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
]);
const KK_MINOR = Object.freeze([
  6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
]);
const PITCH_CLASS_NAMES = Object.freeze([
  "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
]);
const MAJOR_SCALE = Object.freeze([0, 2, 4, 5, 7, 9, 11]);
const NATURAL_MINOR_SCALE = Object.freeze([0, 2, 3, 5, 7, 8, 10]);
const TOP_CANDIDATES = 5;
// 逐音符/逐乐句列表在长片段（数百音符）上会主导响应体积。standard 截断到此上限并给出警告，
// verbose 完整返回，compact 只给汇总不逐项展开。
const MAX_LIST_ITEMS = 100;

const PROVENANCE = Object.freeze({
  keyMethod: "krumhansl_schmuckler_duration_weighted_pearson",
  keyProfiles: "krumhansl_kessler_1982",
  enharmonicSpelling: "sharps_only",
  minorScaleDegrees: "natural_minor",
  phraseSegmentation: "rest_threshold_heuristic",
  breathNotes: "excluded_from_all_musical_statistics_reported_as_breathEvents",
  breathDetection: "official_documented_special_lyric_br",
  specialLyrics: "official_v2_manual_enter_notes",
  melodicEligibility: "shared_vocal_event_sequence_semantics",
  pitchBasis: "sounding_midi_with_occurrence_pitch_offset",
  hostDeclaredScale: "NoteGroup.getScale_metadata_never_overrides_inference",
  basis: "derived_not_host_fact",
  perception: "human_only",
});

export class PhraseAnalysisService {
  constructor({ store, now = () => Date.now() } = {}) {
    if (!store) throw new Error("PhraseAnalysisService requires the shared SnapshotStore");
    this.store = store;
    this.now = now;
  }

  async analyze(request = {}) {
    const timer = new ServiceTiming({ now: this.now, phaseNames: ["loadMs", "analyzeMs"] });
    const input = normalizeAnalyzeRequest(request);
    // 纯内存服务：不进入协调器；coordinatorQueueMs/operationMs 恒 0，如实报告。
    timer.requestCoordinator();
    const warnings = [];
    const loaded = await timer.measure("loadMs", async () =>
      resolveAnalysisSource(this.store, input)
    );
    const analysis = await timer.measure("analyzeMs", async () =>
      runAnalysis(loaded, input, warnings)
    );
    warnings.push(...loaded.semanticIssues);
    return {
      ok: true,
      status: "succeeded",
      contextId: loaded.stored.contextId,
      occurrence: {
        occurrence: loaded.occurrenceOrdinal,
        trackIndex: loaded.occurrence.trackIndex,
        groupIndex: loaded.occurrence.groupIndex,
        targetGroupUuid: loaded.occurrence.targetGroupUuid,
        pitchOffsetSemitone: loaded.occurrence.pitchOffsetSemitone ?? 0,
      },
      inputNoteCount: loaded.inputNoteCount,
      melodicNoteCount: loaded.notes.length,
      // noteCount 保持既有含义：只数进入高层音乐推断的音符。
      noteCount: loaded.notes.length,
      breathCount: loaded.breathNotes.length,
      excludedEvents: buildExcludedEvents(loaded, warnings),
      ...analysis,
      breathEvents: buildBreathEvents(loaded, warnings),
      // 请求了和声语境时，把它的证据边界（尤其 evidenceScope:"melody_only"）并入 provenance。
      provenance: HARMONIC_INCLUDES.some((name) => input.include.has(name))
        ? { ...PROVENANCE, harmonicContext: HARMONIC_PROVENANCE }
        : PROVENANCE,
      warnings,
      timings: timer.finish(),
    };
  }
}

// ---------- 上下文解析（纯数据，与 plan/compare 同模式） ----------

function resolveAnalysisSource(store, input) {
  const stored = store.get(input.contextId);
  if (!stored) {
    throw unknownContextError(store, input.contextId);
  }
  if (stored.context?.kind !== "range") {
    throw codedError(
      "INVALID_CONTEXT",
      'sv_analyze_phrase needs a range context from sv_snapshot_range with include ["notes"]'
    );
  }
  const { occurrence, ordinal } = selectOccurrenceByOrdinal(
    stored.context.occurrences,
    input.occurrence,
    {
      eligible: (item) =>
        Array.isArray(item.noteFingerprints) && item.noteFingerprints.length > 0,
      noneCode: "NOTES_NOT_CAPTURED",
      noneMessage:
        'sv_analyze_phrase needs note fingerprints; re-run sv_snapshot_range with include ["notes"]',
      ambiguousMessage:
        "range context has multiple occurrences with notes; pass one occurrence ordinal",
    }
  );
  const quarterBlick = stored.context.quarterBlick;
  if (!Number.isSafeInteger(quarterBlick) || quarterBlick <= 0) {
    throw codedError("INVALID_CONTEXT", "context is missing a usable SV.QUARTER timebase");
  }
  const timeOffset = occurrence.timeOffsetBlick ?? 0;
  const pitchOffset = occurrence.pitchOffsetSemitone ?? 0;
  if (!Number.isInteger(pitchOffset)) {
    throw codedError(
      "INVALID_CONTEXT",
      "occurrence pitchOffsetSemitone must be an integer for MIDI pitch analysis"
    );
  }
  const allNotes = [...(occurrence.noteFingerprints ?? [])]
    .map((fingerprint) => ({
      indexInGroup: fingerprint.indexInGroup,
      lyrics: fingerprint.lyrics,
      // Reference 的 pitch offset 会改变实际发声音高；调性、音域与和声语境必须使用同一坐标。
      pitch: fingerprint.pitch + pitchOffset,
      // detune 是表现性微调，只并入 targetSemitone 供乐句 climax 等连续音高统计使用。
      targetSemitone:
        fingerprint.pitch + pitchOffset + (fingerprint.detuneCents ?? 0) / 100,
      absOnsetBlick: timeOffset + fingerprint.onsetBlick,
      absEndBlick: timeOffset + fingerprint.onsetBlick + fingerprint.durationBlick,
      durationBlick: fingerprint.durationBlick,
    }))
    .sort((left, right) => left.absOnsetBlick - right.absOnsetBlick);
  if (allNotes.length === 0) {
    throw codedError(
      "NOTES_NOT_CAPTURED",
      'the selected occurrence has no note fingerprints; re-run sv_snapshot_range with include ["notes"]'
    );
  }
  const semantics = analyzeVocalEventSequence(allNotes);
  const notes = semantics.events
    .filter((event) => event.melodicEligible)
    .map((event) => event.note);
  const breathNotes = semantics.events
    .filter((event) => event.semanticRole === "breath_event")
    .map((event) => event.note);
  const excludedEvents = summarizeExcludedVocalEvents(semantics.events);
  if (notes.length === 0) {
    const error = codedError(
      "NO_MELODIC_NOTES",
      "every captured note is excluded from high-level musical inference; there is no melodic material to analyze"
    );
    error.details = { excludedEvents };
    throw error;
  }
  // meterMarks 供 metricalRoles/chordCandidates 的小节与强拍分区使用。sv_snapshot_range
  // 默认捕获它；缺失时相关 section 如实降级，而不是假设 4/4。
  const meterMarks = Array.isArray(stored.context.meterMarks) ? stored.context.meterMarks : null;
  return {
    stored,
    occurrence,
    occurrenceOrdinal: ordinal,
    inputNoteCount: allNotes.length,
    notes,
    breathNotes,
    semanticIssues: semantics.issues,
    excludedEvents,
    quarterBlick,
    meterMarks,
    hostDeclaredScale: normalizeStoredHostDeclaredScale(occurrence.hostDeclaredScale),
  };
}

// 呼吸事件逐项返回：音高字段标 nominalPitch——宿主要求换气音符也有 pitch，
// 但它不是可唱音高，绝不进入调性/音级/统计。三档响应与其他逐项列表共享同一预算。
function buildBreathEvents(loaded, warnings) {
  const count = loaded.breathNotes.length;
  const cap = MAX_LIST_ITEMS;
  if (count > cap) {
    warnings.push({
      code: "BREATH_EVENTS_TRUNCATED",
      message: `breathEvents.items reports the first ${cap} of ${count} breath events; read the sealed detail artifact for the full list.`,
    });
  }
  return {
    count,
    items: loaded.breathNotes.slice(0, cap).map((note) => ({
      note: note.indexInGroup,
      lyrics: note.lyrics,
      nominalPitch: note.pitch,
      startBlick: note.absOnsetBlick,
      endBlick: note.absEndBlick,
      durationQuarter: note.durationBlick / loaded.quarterBlick,
    })),
    itemsTruncated: count > cap,
  };
}

function buildExcludedEvents(loaded, warnings) {
  const { count, byRole, items } = loaded.excludedEvents;
  const cap = MAX_LIST_ITEMS;
  if (count > cap) {
    warnings.push({
      code: "EXCLUDED_EVENTS_TRUNCATED",
      message: `excludedEvents.items reports the first ${cap} of ${count} excluded events; read the sealed detail artifact for the full list.`,
    });
  }
  return {
    count,
    byRole: { ...byRole },
    items: items.slice(0, cap),
    itemsTruncated: count > cap,
  };
}

// ---------- 分析 ----------

function runAnalysis(loaded, input, warnings) {
  const result = {};
  let bestKey = null;
  let keyResult = null;
  // 和声语境各 section 都依赖调性；用同一次 K-S 检测结果，避免重复计算或结论不一致。
  const needsKey =
    input.include.has("key") ||
    input.include.has("scaleDegrees") ||
    input.include.has("cadence") ||
    input.include.has("tensionResolution");
  if (needsKey) {
    keyResult = analyzeKey(loaded.notes, warnings);
    if (keyResult) {
      keyResult = {
        ...keyResult,
        hostDeclaredScale: loaded.hostDeclaredScale,
        hostScaleComparison: compareHostDeclaredScale(
          loaded.hostDeclaredScale,
          keyResult.bestCandidate
        ),
      };
    }
    bestKey = keyResult?.bestCandidate ?? null;
    if (input.include.has("key")) result.key = keyResult;
  }
  if (input.include.has("scaleDegrees")) {
    result.scaleDegrees = bestKey
      ? scaleDegreesFor(loaded.notes, bestKey, warnings)
      : null;
  }
  if (input.include.has("phrases")) {
    result.phrases = analyzePhrases(loaded, input.phraseGapQuarter, warnings);
  }
  if (input.include.has("statistics")) {
    result.statistics = analyzeStatistics(loaded);
  }
  // ---- P1-A：和声语境。单旋律无法确定真实和弦，各 section 自带 evidenceScope。----
  const harmonicOptions = {
    phraseGapQuarter: input.phraseGapQuarter,
    harmonicWindow: input.harmonicWindow,
    ambiguityThreshold: input.ambiguityThreshold,
    maxChordCandidates: input.maxChordCandidates,
    maxCadenceCandidates: input.maxCadenceCandidates,
    suspensionMinQuarter: input.suspensionMinQuarter,
  };
  if (input.include.has("metricalRoles")) {
    result.metricalRoles = analyzeMetricalRoles(loaded, warnings);
  }
  // cadence 会引用和弦窗口作为佐证，因此先算 chordCandidates。
  let chordSection = null;
  if (input.include.has("chordCandidates") || input.include.has("cadence")) {
    chordSection = analyzeChordCandidates(loaded, harmonicOptions, warnings);
    if (input.include.has("chordCandidates")) result.chordCandidates = chordSection;
  }
  if (input.include.has("cadence")) {
    result.cadence = analyzeCadence(loaded, keyResult, chordSection, harmonicOptions, warnings);
  }
  if (input.include.has("tensionResolution")) {
    result.tensionResolution = analyzeTensionResolution(loaded, keyResult, harmonicOptions, warnings);
  }
  return result;
}

function normalizeStoredHostDeclaredScale(value) {
  if (
    value?.status === "observed" &&
    typeof value.root === "string" &&
    typeof value.type === "string"
  ) {
    return { status: "observed", root: value.root, type: value.type };
  }
  if (["unavailable", "invalid"].includes(value?.status)) {
    return { status: value.status };
  }
  return { status: "not_captured" };
}

function compareHostDeclaredScale(hostScale, inferred) {
  if (hostScale.status !== "observed") {
    return { status: "not_comparable", reason: hostScale.status };
  }
  const tonicPitchClass = PITCH_CLASS_NAMES.indexOf(hostScale.root);
  const mode = hostScale.type === "Major"
    ? "major"
    : hostScale.type === "NaturalMinor"
      ? "minor"
      : null;
  if (tonicPitchClass < 0) {
    return { status: "not_comparable", reason: "unsupported_root" };
  }
  if (mode === null) {
    return { status: "not_comparable", reason: "unsupported_mode" };
  }
  return {
    status:
      tonicPitchClass === inferred.tonicPitchClass && mode === inferred.mode
        ? "matched"
        : "different",
    host: { tonicPitchClass, tonic: hostScale.root, mode },
    inferred: {
      tonicPitchClass: inferred.tonicPitchClass,
      tonic: inferred.tonic,
      mode: inferred.mode,
    },
  };
}

// K-K 调性排序器：style-profile 复用（导出）。输入音符需带 pitch/durationBlick。
export function analyzeKey(notes, warnings) {
  // 时值加权音级直方图：每个音级累计 blick 时长。
  const histogram = new Array(12).fill(0);
  for (const note of notes) {
    histogram[((note.pitch % 12) + 12) % 12] += note.durationBlick;
  }
  // 单一音级无法定调：Pearson 仍可计算但排序毫无意义，如实降级而不是给假候选。
  if (histogram.filter((weight) => weight > 0).length < 2) {
    warnings.push({
      code: "INSUFFICIENT_PITCH_VARIETY",
      message: "fewer than two distinct pitch classes; key detection is not meaningful.",
    });
    return null;
  }
  const candidates = [];
  for (let tonic = 0; tonic < 12; tonic += 1) {
    for (const [mode, profile] of [
      ["major", KK_MAJOR],
      ["minor", KK_MINOR],
    ]) {
      const rotated = new Array(12);
      for (let degree = 0; degree < 12; degree += 1) {
        rotated[(tonic + degree) % 12] = profile[degree];
      }
      candidates.push({
        tonicPitchClass: tonic,
        tonic: PITCH_CLASS_NAMES[tonic],
        mode,
        correlation: pearson(histogram, rotated),
      });
    }
  }
  candidates.sort((left, right) => right.correlation - left.correlation);
  const best = candidates[0];
  const marginFromNext = best.correlation - candidates[1].correlation;
  return {
    bestCandidate: best,
    candidates: candidates.slice(0, TOP_CANDIDATES),
    marginFromNext,
    confidence: {
      score: marginFromNext,
      kind: "normalized_margin",
      calibrated: false,
      note: "margin between the top two Pearson correlations; relative major/minor ambiguity is expected on short melodic contexts.",
    },
    enharmonicSpelling: "sharps_only",
  };
}

function scaleDegreesFor(notes, key, warnings) {
  const scale = key.mode === "major" ? MAJOR_SCALE : NATURAL_MINOR_SCALE;
  const degreeByOffset = new Map(scale.map((offset, index) => [offset, index + 1]));
  const items = notes.map((note) => {
    const pitchClass = ((note.pitch % 12) + 12) % 12;
    const offset = (pitchClass - key.tonicPitchClass + 12) % 12;
    const degree = degreeByOffset.get(offset) ?? null;
    return {
      note: note.indexInGroup,
      lyrics: note.lyrics,
      pitch: note.pitch,
      pitchClass: PITCH_CLASS_NAMES[pitchClass],
      degree,
      inScale: degree !== null,
    };
  });
  const nonDiatonicNotes = items.filter((item) => !item.inScale).map((item) => item.note);
  // 汇总各模式都返回：时值无关的音级直方图与非调内计数，便于不展开逐音符也能判断调性贴合度。
  const degreeHistogram = Object.create(null);
  for (const item of items) {
    const bucket = item.degree === null ? "chromatic" : String(item.degree);
    degreeHistogram[bucket] = (degreeHistogram[bucket] ?? 0) + 1;
  }
  const base = {
    relativeTo: { tonic: key.tonic, mode: key.mode },
    summary: {
      noteCount: items.length,
      inScaleCount: items.length - nonDiatonicNotes.length,
      nonDiatonicCount: nonDiatonicNotes.length,
      degreeHistogram,
    },
  };
  const cap = MAX_LIST_ITEMS;
  if (items.length > cap) {
    warnings.push({
      code: "SCALE_DEGREES_TRUNCATED",
      message: `scaleDegrees.items reports the first ${cap} of ${items.length} notes; read the sealed detail artifact for the full per-note list.`,
    });
  }
  return {
    ...base,
    items: items.slice(0, cap),
    itemsTruncated: items.length > cap,
    nonDiatonicNotes,
  };
}

function analyzePhrases(loaded, phraseGapQuarter, warnings) {
  const gapBlick = Math.max(1, Math.round(phraseGapQuarter * loaded.quarterBlick));
  const phrases = segmentPhrases(loaded.notes, gapBlick);
  const items = phrases.map((phrase, index) => {
    const first = phrase.notes[0];
    const last = phrase.notes[phrase.notes.length - 1];
    const next = phrases[index + 1]?.notes[0] ?? null;
    const pitches = phrase.notes.map((note) => note.pitch);
    return {
      index,
      noteCount: phrase.notes.length,
      firstNote: first.indexInGroup,
      lastNote: last.indexInGroup,
      startBlick: first.absOnsetBlick,
      endBlick: last.absEndBlick,
      durationQuarter: (last.absEndBlick - first.absOnsetBlick) / loaded.quarterBlick,
      climax: {
        note: phrase.climax.indexInGroup,
        lyrics: phrase.climax.lyrics,
        pitch: phrase.climax.pitch,
      },
      ambitusSemitones: Math.max(...pitches) - Math.min(...pitches),
      restAfterBlick: next ? Math.max(0, next.absOnsetBlick - last.absEndBlick) : null,
    };
  });
  // 各模式共有的聚合摘要：compact 不展开逐乐句 items 时仍能判断切分结果的规模与形状。
  const noteCounts = items.map((item) => item.noteCount);
  const durations = items.map((item) => item.durationQuarter);
  const summary = {
    totalNotes: noteCounts.reduce((sum, value) => sum + value, 0),
    noteCount: { min: Math.min(...noteCounts), max: Math.max(...noteCounts) },
    durationQuarter: { min: Math.min(...durations), max: Math.max(...durations) },
  };
  const cap = MAX_LIST_ITEMS;
  if (items.length > cap) {
    warnings.push({
      code: "PHRASES_TRUNCATED",
      message: `phrases.items reports the first ${cap} of ${items.length} phrases; read the sealed detail artifact for the full list.`,
    });
  }
  return {
    phraseGapQuarter,
    count: items.length,
    summary,
    items: items.slice(0, cap),
    itemsTruncated: items.length > cap,
  };
}

// 音域/音程/节奏/休止统计：style-profile 复用（导出）。输入需带 pitch/durationBlick/
// absOnsetBlick/absEndBlick 与 quarterBlick。
export function analyzeStatistics(loaded) {
  const pitches = loaded.notes.map((note) => note.pitch).sort((left, right) => left - right);
  const durationsQuarter = loaded.notes
    .map((note) => note.durationBlick / loaded.quarterBlick)
    .sort((left, right) => left - right);
  const intervals = [];
  const rests = [];
  for (let index = 1; index < loaded.notes.length; index += 1) {
    intervals.push(loaded.notes[index].pitch - loaded.notes[index - 1].pitch);
    const gap = loaded.notes[index].absOnsetBlick - loaded.notes[index - 1].absEndBlick;
    if (gap > 0) rests.push(gap);
  }
  const intervalHistogram = Object.create(null);
  for (const interval of intervals) {
    const key = String(Math.max(-24, Math.min(24, interval)));
    intervalHistogram[key] = (intervalHistogram[key] ?? 0) + 1;
  }
  return {
    register: {
      minPitch: pitches[0],
      maxPitch: pitches[pitches.length - 1],
      medianPitch: median(pitches),
      ambitusSemitones: pitches[pitches.length - 1] - pitches[0],
    },
    intervals: {
      count: intervals.length,
      histogram: intervalHistogram,
      stepwiseRatio:
        intervals.length > 0
          ? intervals.filter((interval) => Math.abs(interval) <= 2).length / intervals.length
          : null,
    },
    rhythm: {
      minDurationQuarter: durationsQuarter[0],
      maxDurationQuarter: durationsQuarter[durationsQuarter.length - 1],
      medianDurationQuarter: median(durationsQuarter),
      sustainCount: durationsQuarter.filter((duration) => duration >= 2).length,
    },
    rests: {
      count: rests.length,
      totalQuarter: rests.reduce((sum, rest) => sum + rest, 0) / loaded.quarterBlick,
      longestQuarter: rests.length > 0 ? Math.max(...rests) / loaded.quarterBlick : null,
    },
  };
}

// ---------- 统计小工具 ----------

function pearson(left, right) {
  const n = left.length;
  const meanLeft = left.reduce((sum, value) => sum + value, 0) / n;
  const meanRight = right.reduce((sum, value) => sum + value, 0) / n;
  let numerator = 0;
  let leftEnergy = 0;
  let rightEnergy = 0;
  for (let index = 0; index < n; index += 1) {
    const deltaLeft = left[index] - meanLeft;
    const deltaRight = right[index] - meanRight;
    numerator += deltaLeft * deltaRight;
    leftEnergy += deltaLeft ** 2;
    rightEnergy += deltaRight ** 2;
  }
  const denominator = Math.sqrt(leftEnergy * rightEnergy);
  return denominator > 0 ? numerator / denominator : 0;
}

function median(sortedAscending) {
  const n = sortedAscending.length;
  return n % 2 === 1
    ? sortedAscending[(n - 1) / 2]
    : (sortedAscending[n / 2 - 1] + sortedAscending[n / 2]) / 2;
}

// ---------- 请求校验 ----------

function normalizeAnalyzeRequest(request) {
  if (!isRecord(request)) throw codedError("INVALID_ARGUMENTS", "request must be an object");
  assertKnownKeys(
    request,
    [
      "contextId",
      "occurrence",
      "include",
      "phraseGapQuarter",
      "harmonicWindow",
      "ambiguityThreshold",
      "maxChordCandidates",
      "maxCadenceCandidates",
      "suspensionMinQuarter",
    ],
    "request"
  );
  if (typeof request.contextId !== "string" || request.contextId.length === 0) {
    throw codedError("INVALID_ARGUMENTS", "contextId must be a non-empty string");
  }
  if (
    request.occurrence !== undefined &&
    (!Number.isSafeInteger(request.occurrence) || request.occurrence < 0)
  ) {
    throw codedError(
      "INVALID_ARGUMENTS",
      "occurrence must be a non-negative occurrence ordinal when provided"
    );
  }
  let include;
  if (request.include === undefined) {
    include = new Set(DEFAULT_INCLUDES);
  } else {
    if (
      !Array.isArray(request.include) ||
      request.include.length === 0 ||
      !request.include.every((item) => PHRASE_ANALYSIS_INCLUDES.includes(item))
    ) {
      throw codedError(
        "INVALID_ARGUMENTS",
        `include must be a non-empty array from ${PHRASE_ANALYSIS_INCLUDES.join(", ")}`
      );
    }
    include = new Set(request.include);
  }
  let phraseGapQuarter = request.phraseGapQuarter ?? 1;
  if (!Number.isFinite(phraseGapQuarter) || phraseGapQuarter < 0.25 || phraseGapQuarter > 8) {
    throw codedError("INVALID_ARGUMENTS", "phraseGapQuarter must be a number between 0.25 and 8");
  }
  const harmonicWindow = request.harmonicWindow ?? "bar";
  if (!["bar", "half_bar"].includes(harmonicWindow)) {
    throw codedError("INVALID_ARGUMENTS", 'harmonicWindow must be "bar" or "half_bar"');
  }
  const ambiguityThreshold = request.ambiguityThreshold ?? 0.08;
  if (!Number.isFinite(ambiguityThreshold) || ambiguityThreshold < 0 || ambiguityThreshold > 1) {
    throw codedError("INVALID_ARGUMENTS", "ambiguityThreshold must be a number between 0 and 1");
  }
  const maxChordCandidates = request.maxChordCandidates ?? 4;
  if (!Number.isSafeInteger(maxChordCandidates) || maxChordCandidates < 2 || maxChordCandidates > 12) {
    // 下限 2：歧义案例必须能返回至少两个候选，不允许把最高分写成唯一事实。
    throw codedError("INVALID_ARGUMENTS", "maxChordCandidates must be an integer between 2 and 12");
  }
  const maxCadenceCandidates = request.maxCadenceCandidates ?? 3;
  if (
    !Number.isSafeInteger(maxCadenceCandidates) ||
    maxCadenceCandidates < 2 ||
    maxCadenceCandidates > 8
  ) {
    throw codedError("INVALID_ARGUMENTS", "maxCadenceCandidates must be an integer between 2 and 8");
  }
  const suspensionMinQuarter = request.suspensionMinQuarter ?? 1;
  if (
    !Number.isFinite(suspensionMinQuarter) ||
    suspensionMinQuarter < 0.25 ||
    suspensionMinQuarter > 8
  ) {
    throw codedError(
      "INVALID_ARGUMENTS",
      "suspensionMinQuarter must be a number between 0.25 and 8"
    );
  }
  return {
    contextId: request.contextId,
    occurrence: request.occurrence,
    include,
    phraseGapQuarter,
    harmonicWindow,
    ambiguityThreshold,
    maxChordCandidates,
    maxCadenceCandidates,
    suspensionMinQuarter,
  };
}

function assertKnownKeys(value, allowed, label) {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw codedError("INVALID_ARGUMENTS", `${label} contains unknown field: ${unknown.join(", ")}`);
  }
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
