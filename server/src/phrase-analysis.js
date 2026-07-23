import { segmentPhrases } from "./expression-plan.js";
import { ServiceTiming } from "./service-timing.js";

// sv_analyze_phrase：只读乐理分析（调性候选 / 音级 / 乐句 / 统计）。
//
// 关键契约：
// - 纯内存只读：只读取 range context 的音符指纹，不访问宿主。
// - 调性检测是"排序器"不是"分类器"：时值加权音级直方图与 24 个 Krumhansl-Kessler
//   profile 旋转做皮尔逊相关，返回排序候选 + 与次名的差距（margin）。旋律（尤其
//   单声部短句）在关系大小调间天然歧义，把歧义如实暴露正是正确行为。
// - 全部结论标 derived/heuristic：乐句、climax、调性都是推断，不是宿主事实；
//   拼写只用升号（不做同音异名判定）；小调音级按自然小调解释。
export const PHRASE_ANALYSIS_INCLUDES = Object.freeze([
  "key",
  "scaleDegrees",
  "phrases",
  "statistics",
]);

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

const PROVENANCE = Object.freeze({
  keyMethod: "krumhansl_schmuckler_duration_weighted_pearson",
  keyProfiles: "krumhansl_kessler_1982",
  enharmonicSpelling: "sharps_only",
  minorScaleDegrees: "natural_minor",
  phraseSegmentation: "rest_threshold_heuristic",
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
    return {
      ok: true,
      status: "succeeded",
      contextId: loaded.stored.contextId,
      occurrence: {
        occurrenceId: loaded.occurrence.occurrenceId,
        trackIndex: loaded.occurrence.trackIndex,
        groupIndex: loaded.occurrence.groupIndex,
        targetGroupUuid: loaded.occurrence.targetGroupUuid,
      },
      noteCount: loaded.notes.length,
      ...analysis,
      provenance: PROVENANCE,
      warnings,
      timings: timer.finish(),
    };
  }
}

// ---------- 上下文解析（纯数据，与 plan/compare 同模式） ----------

function resolveAnalysisSource(store, input) {
  const stored = store.get(input.contextId);
  if (!stored) {
    throw codedError("UNKNOWN_CONTEXT", "contextId not found or expired; re-run sv_snapshot_range");
  }
  if (stored.context?.kind !== "range") {
    throw codedError(
      "INVALID_CONTEXT",
      'sv_analyze_phrase needs a range context from sv_snapshot_range with include ["notes"]'
    );
  }
  const occurrences = Array.isArray(stored.context.occurrences) ? stored.context.occurrences : [];
  const candidates = occurrences.filter(
    (item) => Array.isArray(item.noteFingerprints) && item.noteFingerprints.length > 0
  );
  let occurrence = null;
  if (input.occurrenceId !== undefined) {
    occurrence = occurrences.find((item) => item.occurrenceId === input.occurrenceId) ?? null;
    if (!occurrence) {
      throw codedError("UNKNOWN_OCCURRENCE", "occurrenceId is not part of the supplied contextId");
    }
  } else if (candidates.length === 1) {
    occurrence = candidates[0];
  } else if (candidates.length === 0) {
    throw codedError(
      "NOTES_NOT_CAPTURED",
      'sv_analyze_phrase needs note fingerprints; re-run sv_snapshot_range with include ["notes"]'
    );
  } else {
    const error = codedError(
      "AMBIGUOUS_CONTEXT",
      "range context has multiple occurrences with notes; provide occurrenceId"
    );
    error.candidateOccurrences = candidates.map((item) => item.occurrenceId);
    error.details = { candidateOccurrences: error.candidateOccurrences };
    throw error;
  }
  const quarterBlick = stored.context.quarterBlick;
  if (!Number.isSafeInteger(quarterBlick) || quarterBlick <= 0) {
    throw codedError("INVALID_CONTEXT", "context is missing a usable SV.QUARTER timebase");
  }
  const timeOffset = occurrence.timeOffsetBlick ?? 0;
  const notes = [...(occurrence.noteFingerprints ?? [])]
    .map((fingerprint) => ({
      noteId: fingerprint.noteId,
      indexInGroup: fingerprint.indexInGroup,
      lyrics: fingerprint.lyrics,
      pitch: fingerprint.pitch,
      // 调性统计用记谱 MIDI 音高；detune 是表现性微调，只并入 targetSemitone 供乐句 climax 等使用。
      targetSemitone: fingerprint.pitch + (fingerprint.detuneCents ?? 0) / 100,
      absOnsetBlick: timeOffset + fingerprint.onsetBlick,
      absEndBlick: timeOffset + fingerprint.onsetBlick + fingerprint.durationBlick,
      durationBlick: fingerprint.durationBlick,
    }))
    .sort((left, right) => left.absOnsetBlick - right.absOnsetBlick);
  if (notes.length === 0) {
    throw codedError(
      "NOTES_NOT_CAPTURED",
      'the selected occurrence has no note fingerprints; re-run sv_snapshot_range with include ["notes"]'
    );
  }
  return { stored, occurrence, notes, quarterBlick };
}

// ---------- 分析 ----------

function runAnalysis(loaded, input, warnings) {
  const result = {};
  let bestKey = null;
  if (input.include.has("key") || input.include.has("scaleDegrees")) {
    const key = analyzeKey(loaded.notes, warnings);
    bestKey = key?.bestCandidate ?? null;
    if (input.include.has("key")) result.key = key;
  }
  if (input.include.has("scaleDegrees")) {
    result.scaleDegrees = bestKey ? scaleDegreesFor(loaded.notes, bestKey) : null;
  }
  if (input.include.has("phrases")) {
    result.phrases = analyzePhrases(loaded, input.phraseGapQuarter);
  }
  if (input.include.has("statistics")) {
    result.statistics = analyzeStatistics(loaded);
  }
  return result;
}

function analyzeKey(notes, warnings) {
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

function scaleDegreesFor(notes, key) {
  const scale = key.mode === "major" ? MAJOR_SCALE : NATURAL_MINOR_SCALE;
  const degreeByOffset = new Map(scale.map((offset, index) => [offset, index + 1]));
  const items = notes.map((note) => {
    const pitchClass = ((note.pitch % 12) + 12) % 12;
    const offset = (pitchClass - key.tonicPitchClass + 12) % 12;
    const degree = degreeByOffset.get(offset) ?? null;
    return {
      noteId: note.noteId,
      lyrics: note.lyrics,
      pitch: note.pitch,
      pitchClass: PITCH_CLASS_NAMES[pitchClass],
      degree,
      inScale: degree !== null,
    };
  });
  return {
    relativeTo: { tonic: key.tonic, mode: key.mode },
    items,
    nonDiatonicNoteIds: items.filter((item) => !item.inScale).map((item) => item.noteId),
  };
}

function analyzePhrases(loaded, phraseGapQuarter) {
  const gapBlick = Math.max(1, Math.round(phraseGapQuarter * loaded.quarterBlick));
  const phrases = segmentPhrases(loaded.notes, gapBlick);
  return {
    phraseGapQuarter,
    items: phrases.map((phrase, index) => {
      const first = phrase.notes[0];
      const last = phrase.notes[phrase.notes.length - 1];
      const next = phrases[index + 1]?.notes[0] ?? null;
      const pitches = phrase.notes.map((note) => note.pitch);
      return {
        index,
        noteCount: phrase.notes.length,
        firstNoteId: first.noteId,
        lastNoteId: last.noteId,
        startBlick: first.absOnsetBlick,
        endBlick: last.absEndBlick,
        durationQuarter: (last.absEndBlick - first.absOnsetBlick) / loaded.quarterBlick,
        climax: {
          noteId: phrase.climax.noteId,
          lyrics: phrase.climax.lyrics,
          pitch: phrase.climax.pitch,
        },
        ambitusSemitones: Math.max(...pitches) - Math.min(...pitches),
        restAfterBlick: next ? Math.max(0, next.absOnsetBlick - last.absEndBlick) : null,
      };
    }),
  };
}

function analyzeStatistics(loaded) {
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
    ["contextId", "occurrenceId", "include", "phraseGapQuarter", "responseMode"],
    "request"
  );
  if (typeof request.contextId !== "string" || request.contextId.length === 0) {
    throw codedError("INVALID_ARGUMENTS", "contextId must be a non-empty string");
  }
  if (
    request.occurrenceId !== undefined &&
    (typeof request.occurrenceId !== "string" || request.occurrenceId.length === 0)
  ) {
    throw codedError("INVALID_ARGUMENTS", "occurrenceId must be a non-empty string when provided");
  }
  let include;
  if (request.include === undefined) {
    include = new Set(PHRASE_ANALYSIS_INCLUDES);
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
  const responseMode = request.responseMode ?? "standard";
  if (!["compact", "standard", "verbose"].includes(responseMode)) {
    throw codedError("INVALID_ARGUMENTS", "responseMode must be compact, standard, or verbose");
  }
  return {
    contextId: request.contextId,
    occurrenceId: request.occurrenceId,
    include,
    phraseGapQuarter,
    responseMode,
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
