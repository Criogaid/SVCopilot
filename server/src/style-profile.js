import { isBreathLyrics, segmentPhrases } from "./expression-plan.js";
import { analyzeStatistics } from "./phrase-analysis.js";
import { ServiceTiming } from "./service-timing.js";
import { getVocalModeNames } from "./voice-parameters.js";

// sv_style_profile：工程级风格统计聚合（HANDOFF §7 P2 / 研究提示 Layer B）。
//
// 关键契约：
// - 纯内存只读：只读取 range context 已存的纯数据（音符指纹、automationByOccurrence、
//   voiceParameters），不进 ExecutionCoordinator、不访问宿主。
// - section 标签来自调用方：服务不推断 verse/chorus——没有和声标注与音频时任何段落
//   推断都是编造证据；caller-provided label 是唯一诚实来源，provenance 显式声明。
// - 缺数据诚实：target 的 context 未 include automation/voiceParameters 时，对应剖面
//   返回 status:"not_captured" + 警告，不报 0 冒充实测。
// - 参数统计的对象是 Automation 控制点，不是宿主插值后的连续可闻曲线（与 §8.9 M2
//   取舍一致），provenance 显式声明。
// - "br" 是呼吸事件（v0.6.2 契约）：从旋律统计剥离，单独计数。
export const STYLE_PROFILE_INCLUDES = Object.freeze([
  "register",
  "intervals",
  "rhythm",
  "phrases",
  "parameters",
  "vocalModes",
  "languages",
  "breaths",
]);

const MAX_TARGETS = 8;
// 逐项列表（乐句分段参数统计等）在长片段上会主导响应体积，与 phrase-analysis 同一预算。
const MAX_LIST_ITEMS = 100;

const PROVENANCE = Object.freeze({
  basis: "derived_not_host_fact",
  sectionLabels: "caller_provided_not_inferred",
  parameterStatistics: "automation_control_points_not_rendered_curve",
  phraseSegmentation: "rest_threshold_heuristic",
  breathDetection: "lyrics_br_host_convention_not_official_api_fact",
  singerIdentity: "unobservable",
  perception: "human_only",
});

export class StyleProfileService {
  constructor({ store, now = () => Date.now() } = {}) {
    if (!store) throw new Error("StyleProfileService requires the shared SnapshotStore");
    this.store = store;
    this.now = now;
  }

  async profile(request = {}) {
    const timer = new ServiceTiming({
      now: this.now,
      phaseNames: ["loadMs", "analyzeMs", "aggregateMs"],
    });
    const input = normalizeProfileRequest(request);
    // 纯内存服务：不进入协调器；coordinatorQueueMs/operationMs 恒 0，如实报告。
    timer.requestCoordinator();
    const warnings = [];
    const loadedTargets = await timer.measure("loadMs", async () =>
      input.targets.map((target, index) => resolveProfileTarget(this.store, target, index))
    );
    const profiles = await timer.measure("analyzeMs", async () =>
      loadedTargets.map((loaded) => buildTargetProfile(loaded, input, warnings))
    );
    if (profiles.every((profile) => profile.noteCount === 0)) {
      throw codedError(
        "NO_MELODIC_NOTES",
        "every captured note across all targets is a breath event (lyrics 'br'); there is no melodic material to profile"
      );
    }
    const aggregate = await timer.measure("aggregateMs", async () =>
      buildAggregate(profiles, input)
    );
    return {
      ok: true,
      status: "succeeded",
      targetCount: profiles.length,
      targets: profiles.map((profile) => publicTargetProfile(profile, input.responseMode)),
      aggregate,
      provenance: PROVENANCE,
      warnings,
      timings: timer.finish(),
    };
  }
}

// ---------- 上下文解析（与 phrase-analysis 同模式，错误信息标注 target 序号） ----------

function resolveProfileTarget(store, target, index) {
  const label = `targets[${index}]`;
  const stored = store.get(target.contextId);
  if (!stored) {
    throw codedError(
      "UNKNOWN_CONTEXT",
      `${label}: contextId not found or expired; re-run sv_snapshot_range`
    );
  }
  if (stored.context?.kind !== "range") {
    throw codedError(
      "INVALID_CONTEXT",
      `${label}: sv_style_profile needs a range context from sv_snapshot_range with include ["notes"]`
    );
  }
  const occurrences = Array.isArray(stored.context.occurrences) ? stored.context.occurrences : [];
  const candidates = occurrences.filter(
    (item) => Array.isArray(item.noteFingerprints) && item.noteFingerprints.length > 0
  );
  let occurrence = null;
  if (target.occurrenceId !== undefined) {
    occurrence = occurrences.find((item) => item.occurrenceId === target.occurrenceId) ?? null;
    if (!occurrence) {
      throw codedError(
        "UNKNOWN_OCCURRENCE",
        `${label}: occurrenceId is not part of the supplied contextId`
      );
    }
  } else if (candidates.length === 1) {
    occurrence = candidates[0];
  } else if (candidates.length === 0) {
    throw codedError(
      "NOTES_NOT_CAPTURED",
      `${label}: sv_style_profile needs note fingerprints; re-run sv_snapshot_range with include ["notes"]`
    );
  } else {
    const error = codedError(
      "AMBIGUOUS_CONTEXT",
      `${label}: range context has multiple occurrences with notes; provide occurrenceId`
    );
    error.candidateOccurrences = candidates.map((item) => item.occurrenceId);
    error.details = { candidateOccurrences: error.candidateOccurrences };
    throw error;
  }
  const quarterBlick = stored.context.quarterBlick;
  if (!Number.isSafeInteger(quarterBlick) || quarterBlick <= 0) {
    throw codedError("INVALID_CONTEXT", `${label}: context is missing a usable SV.QUARTER timebase`);
  }
  const timeOffset = occurrence.timeOffsetBlick ?? 0;
  const allNotes = [...(occurrence.noteFingerprints ?? [])]
    .map((fingerprint) => ({
      noteId: fingerprint.noteId,
      indexInGroup: fingerprint.indexInGroup,
      lyrics: fingerprint.lyrics,
      pitch: fingerprint.pitch,
      targetSemitone: fingerprint.pitch + (fingerprint.detuneCents ?? 0) / 100,
      languageOverride: fingerprint.languageOverride ?? "",
      absOnsetBlick: timeOffset + fingerprint.onsetBlick,
      absEndBlick: timeOffset + fingerprint.onsetBlick + fingerprint.durationBlick,
      durationBlick: fingerprint.durationBlick,
    }))
    .sort((left, right) => left.absOnsetBlick - right.absOnsetBlick);
  const notes = allNotes.filter((note) => !isBreathLyrics(note.lyrics));
  const breathNotes = allNotes.filter((note) => isBreathLyrics(note.lyrics));
  return { index, label: target.label ?? null, stored, occurrence, notes, breathNotes, quarterBlick };
}

// ---------- 逐 target 剖面 ----------

function buildTargetProfile(loaded, input, warnings) {
  const targetLabel = loaded.label ? `targets[${loaded.index}] (${loaded.label})` : `targets[${loaded.index}]`;
  const profile = {
    index: loaded.index,
    label: loaded.label,
    contextId: loaded.stored.contextId,
    occurrence: {
      occurrenceId: loaded.occurrence.occurrenceId,
      trackIndex: loaded.occurrence.trackIndex,
      groupIndex: loaded.occurrence.groupIndex,
      targetGroupUuid: loaded.occurrence.targetGroupUuid,
    },
    noteCount: loaded.notes.length,
    breathCount: loaded.breathNotes.length,
    quarterBlick: loaded.quarterBlick,
    sections: {},
    // 聚合层用的原始池（不进响应）：跨 target 中位数必须用合并样本重算，不能平均中位数。
    pools: {
      pitches: loaded.notes.map((note) => note.pitch),
      durationsQuarter: loaded.notes.map((note) => note.durationBlick / loaded.quarterBlick),
      intervalHistogram: Object.create(null),
      intervalCount: 0,
      rests: { count: 0, totalQuarter: 0, longestQuarter: null },
      phrases: [],
      breathTotalQuarter: loaded.breathNotes.reduce(
        (sum, note) => sum + note.durationBlick / loaded.quarterBlick,
        0
      ),
      languageHistogram: Object.create(null),
    },
  };
  if (loaded.notes.length === 0) {
    warnings.push({
      code: "TARGET_NO_MELODIC_NOTES",
      message: `${targetLabel}: every captured note is a breath event; melodic sections are null for this target.`,
    });
  }
  const hasMelody = loaded.notes.length > 0;
  const stats = hasMelody
    ? analyzeStatistics({ notes: loaded.notes, quarterBlick: loaded.quarterBlick })
    : null;
  if (stats) {
    profile.pools.intervalHistogram = { ...stats.intervals.histogram };
    profile.pools.intervalCount = stats.intervals.count;
    profile.pools.rests = { ...stats.rests, longestQuarter: stats.rests.longestQuarter };
  }
  if (input.include.has("register")) {
    profile.sections.register = stats ? stats.register : null;
  }
  if (input.include.has("intervals")) {
    profile.sections.intervals = stats ? stats.intervals : null;
  }
  if (input.include.has("rhythm")) {
    profile.sections.rhythm = stats ? { ...stats.rhythm, rests: stats.rests } : null;
  }
  if (input.include.has("phrases")) {
    profile.sections.phrases = hasMelody
      ? buildPhraseSection(loaded, input, profile.pools)
      : null;
  }
  if (input.include.has("breaths")) {
    profile.sections.breaths = {
      count: loaded.breathNotes.length,
      totalQuarter: profile.pools.breathTotalQuarter,
      // 呼吸密度以旋律跨度为分母；无旋律时 null。
      perQuarter:
        hasMelody && loaded.notes.length > 0
          ? loaded.breathNotes.length /
            Math.max(
              1e-9,
              (loaded.notes[loaded.notes.length - 1].absEndBlick - loaded.notes[0].absOnsetBlick) /
                loaded.quarterBlick
            )
          : null,
    };
  }
  if (input.include.has("languages")) {
    profile.sections.languages = buildLanguageSection(loaded, profile.pools);
  }
  if (input.include.has("parameters")) {
    profile.sections.parameters = buildParameterSection(loaded, input, warnings, targetLabel, profile);
  }
  if (input.include.has("vocalModes")) {
    profile.sections.vocalModes = buildVocalModeSection(loaded, warnings, targetLabel);
  }
  return profile;
}

function buildPhraseSection(loaded, input, pools) {
  const gapBlick = Math.max(1, Math.round(input.phraseGapQuarter * loaded.quarterBlick));
  const phrases = segmentPhrases(loaded.notes, gapBlick);
  const items = phrases.map((phrase) => {
    const first = phrase.notes[0];
    const last = phrase.notes[phrase.notes.length - 1];
    return {
      noteCount: phrase.notes.length,
      durationQuarter: (last.absEndBlick - first.absOnsetBlick) / loaded.quarterBlick,
      startBlick: first.absOnsetBlick,
      endBlick: last.absEndBlick,
    };
  });
  pools.phrases = items;
  const noteCounts = items.map((item) => item.noteCount);
  const durations = items.map((item) => item.durationQuarter);
  return {
    phraseGapQuarter: input.phraseGapQuarter,
    count: items.length,
    noteCount: { min: Math.min(...noteCounts), max: Math.max(...noteCounts) },
    durationQuarter: {
      min: Math.min(...durations),
      max: Math.max(...durations),
      median: median([...durations].sort((left, right) => left - right)),
    },
  };
}

function buildLanguageSection(loaded, pools) {
  const histogram = Object.create(null);
  for (const note of loaded.notes) {
    const key = note.languageOverride === "" ? "none" : note.languageOverride;
    histogram[key] = (histogram[key] ?? 0) + 1;
  }
  pools.languageHistogram = { ...histogram };
  const overrides = Object.keys(histogram).filter((key) => key !== "none");
  return {
    overrideHistogram: histogram,
    distinctOverrides: overrides,
    mixedLanguages: overrides.length >= 2,
    noOverrideCount: histogram.none ?? 0,
  };
}

function buildParameterSection(loaded, input, warnings, targetLabel, profile) {
  // automationCaptured 区分"context 没 include automation"与"确实无曲线"。
  if (loaded.stored.context.automationCaptured !== true) {
    warnings.push({
      code: "AUTOMATION_NOT_CAPTURED",
      message: `${targetLabel}: the range context was captured without include ["automation"]; parameter statistics are unavailable — re-snapshot with automation included.`,
    });
    return { status: "not_captured" };
  }
  const map = loaded.stored.context.automationByOccurrence ?? Object.create(null);
  const curves = Object.hasOwn(map, loaded.occurrence.occurrenceId)
    ? map[loaded.occurrence.occurrenceId]
    : [];
  const phraseSpans = (profile.pools.phrases ?? []).map((phrase) => ({
    startBlick: phrase.startBlick,
    endBlick: phrase.endBlick,
  }));
  const items = curves.map((curve) => {
    const values = curve.points.map((point) => point.value);
    const defaultValue = curve.definition?.defaultValue;
    const nonDefaultCount = Number.isFinite(defaultValue)
      ? values.filter((value) => value !== defaultValue).length
      : null;
    const perPhrase =
      phraseSpans.length > 0
        ? phraseSpans.slice(0, MAX_LIST_ITEMS).map((span) => {
            const inSpan = curve.points
              .filter(
                (point) => point.absoluteBlick >= span.startBlick && point.absoluteBlick <= span.endBlick
              )
              .map((point) => point.value);
            return inSpan.length > 0
              ? { pointCount: inSpan.length, min: Math.min(...inSpan), max: Math.max(...inSpan) }
              : { pointCount: 0, min: null, max: null };
          })
        : [];
    return {
      parameter: curve.resolvedParameter,
      pointCount: values.length,
      ...(values.length > 0
        ? {
            min: Math.min(...values),
            max: Math.max(...values),
            mean: values.reduce((sum, value) => sum + value, 0) / values.length,
          }
        : { min: null, max: null, mean: null }),
      defaultValue: Number.isFinite(defaultValue) ? defaultValue : null,
      nonDefaultRatio:
        nonDefaultCount !== null && values.length > 0 ? nonDefaultCount / values.length : null,
      ...(input.responseMode !== "compact" && perPhrase.length > 0 ? { perPhrase } : {}),
    };
  });
  return { status: "captured", curves: items };
}

function buildVocalModeSection(loaded, warnings, targetLabel) {
  const voice = loaded.occurrence.voiceParameters;
  if (voice === undefined) {
    warnings.push({
      code: "VOICE_NOT_CAPTURED",
      message: `${targetLabel}: the range context was captured without include ["voiceParameters"]; vocal mode data is unavailable — re-snapshot with voiceParameters included.`,
    });
    return { status: "not_captured" };
  }
  const vocalModeNames = getVocalModeNames(voice);
  const staticParameters = Object.create(null);
  for (const [key, value] of Object.entries(voice)) {
    if (key === "vocalModeParams") continue;
    staticParameters[key] = value;
  }
  return {
    status: "captured",
    vocalModeNames,
    vocalModeParams: voice.vocalModeParams ?? {},
    staticParameters,
    singerIdentity: "unobservable",
  };
}

// ---------- 聚合层 ----------

function buildAggregate(profiles, input) {
  const overall = aggregateGroup(profiles, input);
  const labeled = profiles.filter((profile) => profile.label !== null);
  const byLabel = Object.create(null);
  for (const label of [...new Set(labeled.map((profile) => profile.label))]) {
    byLabel[label] = aggregateGroup(
      labeled.filter((profile) => profile.label === label),
      input
    );
  }
  return {
    overall,
    ...(Object.keys(byLabel).length > 0 ? { byLabel } : {}),
  };
}

function aggregateGroup(profiles, input) {
  const group = {
    targetCount: profiles.length,
    targetIndices: profiles.map((profile) => profile.index),
    noteCount: profiles.reduce((sum, profile) => sum + profile.noteCount, 0),
    breathCount: profiles.reduce((sum, profile) => sum + profile.breathCount, 0),
  };
  const pooledPitches = profiles
    .flatMap((profile) => profile.pools.pitches)
    .sort((left, right) => left - right);
  const pooledDurations = profiles
    .flatMap((profile) => profile.pools.durationsQuarter)
    .sort((left, right) => left - right);
  if (input.include.has("register")) {
    group.register =
      pooledPitches.length > 0
        ? {
            minPitch: pooledPitches[0],
            maxPitch: pooledPitches[pooledPitches.length - 1],
            medianPitch: median(pooledPitches),
            ambitusSemitones: pooledPitches[pooledPitches.length - 1] - pooledPitches[0],
          }
        : null;
  }
  if (input.include.has("intervals")) {
    // 音程只在各 target 内部成立（跨 target 边界的"音程"没有音乐意义），聚合是直方图求和。
    const histogram = Object.create(null);
    let count = 0;
    for (const profile of profiles) {
      count += profile.pools.intervalCount;
      for (const [key, value] of Object.entries(profile.pools.intervalHistogram)) {
        histogram[key] = (histogram[key] ?? 0) + value;
      }
    }
    const stepwise = Object.entries(histogram)
      .filter(([key]) => Math.abs(Number(key)) <= 2)
      .reduce((sum, [, value]) => sum + value, 0);
    group.intervals =
      count > 0 ? { count, histogram, stepwiseRatio: stepwise / count } : null;
  }
  if (input.include.has("rhythm")) {
    const rests = profiles.reduce(
      (merged, profile) => ({
        count: merged.count + profile.pools.rests.count,
        totalQuarter: merged.totalQuarter + profile.pools.rests.totalQuarter,
        longestQuarter:
          profile.pools.rests.longestQuarter === null
            ? merged.longestQuarter
            : Math.max(merged.longestQuarter ?? -Infinity, profile.pools.rests.longestQuarter),
      }),
      { count: 0, totalQuarter: 0, longestQuarter: null }
    );
    group.rhythm =
      pooledDurations.length > 0
        ? {
            minDurationQuarter: pooledDurations[0],
            maxDurationQuarter: pooledDurations[pooledDurations.length - 1],
            medianDurationQuarter: median(pooledDurations),
            sustainCount: pooledDurations.filter((duration) => duration >= 2).length,
            rests,
          }
        : null;
  }
  if (input.include.has("phrases")) {
    const pooledPhrases = profiles.flatMap((profile) => profile.pools.phrases);
    const noteCounts = pooledPhrases.map((phrase) => phrase.noteCount);
    const durations = pooledPhrases
      .map((phrase) => phrase.durationQuarter)
      .sort((left, right) => left - right);
    group.phrases =
      pooledPhrases.length > 0
        ? {
            count: pooledPhrases.length,
            noteCount: { min: Math.min(...noteCounts), max: Math.max(...noteCounts) },
            durationQuarter: {
              min: durations[0],
              max: durations[durations.length - 1],
              median: median(durations),
            },
          }
        : null;
  }
  if (input.include.has("breaths")) {
    group.breaths = {
      count: group.breathCount,
      totalQuarter: profiles.reduce((sum, profile) => sum + profile.pools.breathTotalQuarter, 0),
    };
  }
  if (input.include.has("languages")) {
    const histogram = Object.create(null);
    for (const profile of profiles) {
      for (const [key, value] of Object.entries(profile.pools.languageHistogram)) {
        histogram[key] = (histogram[key] ?? 0) + value;
      }
    }
    const overrides = Object.keys(histogram).filter((key) => key !== "none");
    group.languages = {
      overrideHistogram: histogram,
      distinctOverrides: overrides,
      mixedLanguages: overrides.length >= 2,
    };
  }
  if (input.include.has("parameters")) {
    // 只聚合 captured 的 target；not_captured 不混入（缺数据不能被平均掉）。
    const byParameter = new Map();
    let capturedTargets = 0;
    for (const profile of profiles) {
      const section = profile.sections.parameters;
      if (!section || section.status !== "captured") continue;
      capturedTargets += 1;
      for (const curve of section.curves) {
        const entry = byParameter.get(curve.parameter) ?? {
          parameter: curve.parameter,
          pointCount: 0,
          min: null,
          max: null,
          weightedMeanNumerator: 0,
        };
        entry.pointCount += curve.pointCount;
        if (curve.min !== null) entry.min = entry.min === null ? curve.min : Math.min(entry.min, curve.min);
        if (curve.max !== null) entry.max = entry.max === null ? curve.max : Math.max(entry.max, curve.max);
        if (curve.mean !== null) entry.weightedMeanNumerator += curve.mean * curve.pointCount;
        byParameter.set(curve.parameter, entry);
      }
    }
    group.parameters = {
      capturedTargets,
      notCapturedTargets: profiles.length - capturedTargets,
      curves: [...byParameter.values()].map((entry) => ({
        parameter: entry.parameter,
        pointCount: entry.pointCount,
        min: entry.min,
        max: entry.max,
        mean: entry.pointCount > 0 ? entry.weightedMeanNumerator / entry.pointCount : null,
      })),
    };
  }
  if (input.include.has("vocalModes")) {
    const names = new Set();
    let capturedTargets = 0;
    for (const profile of profiles) {
      const section = profile.sections.vocalModes;
      if (!section || section.status !== "captured") continue;
      capturedTargets += 1;
      for (const name of section.vocalModeNames) names.add(name);
    }
    group.vocalModes = {
      capturedTargets,
      notCapturedTargets: profiles.length - capturedTargets,
      vocalModeNames: [...names].sort(),
      singerIdentity: "unobservable",
    };
  }
  return group;
}

// ---------- 响应裁剪 ----------

function publicTargetProfile(profile, responseMode) {
  const base = {
    index: profile.index,
    label: profile.label,
    contextId: profile.contextId,
    occurrence: profile.occurrence,
    noteCount: profile.noteCount,
    breathCount: profile.breathCount,
  };
  if (responseMode === "compact") return base;
  return { ...base, sections: profile.sections };
}

// ---------- 统计小工具 ----------

function median(sortedAscending) {
  const n = sortedAscending.length;
  return n % 2 === 1
    ? sortedAscending[(n - 1) / 2]
    : (sortedAscending[n / 2 - 1] + sortedAscending[n / 2]) / 2;
}

// ---------- 请求校验 ----------

function normalizeProfileRequest(request) {
  if (!isRecord(request)) throw codedError("INVALID_ARGUMENTS", "request must be an object");
  assertKnownKeys(request, ["targets", "include", "phraseGapQuarter", "responseMode"], "request");
  if (!Array.isArray(request.targets) || request.targets.length < 1 || request.targets.length > MAX_TARGETS) {
    throw codedError("INVALID_ARGUMENTS", `targets must be an array of 1-${MAX_TARGETS} items`);
  }
  const targets = request.targets.map((target, index) => {
    const label = `targets[${index}]`;
    if (!isRecord(target)) throw codedError("INVALID_ARGUMENTS", `${label} must be an object`);
    assertKnownKeys(target, ["contextId", "occurrenceId", "label"], label);
    if (typeof target.contextId !== "string" || target.contextId.length === 0) {
      throw codedError("INVALID_ARGUMENTS", `${label}.contextId must be a non-empty string`);
    }
    if (
      target.occurrenceId !== undefined &&
      (typeof target.occurrenceId !== "string" || target.occurrenceId.length === 0)
    ) {
      throw codedError("INVALID_ARGUMENTS", `${label}.occurrenceId must be a non-empty string when provided`);
    }
    if (
      target.label !== undefined &&
      (typeof target.label !== "string" || target.label.length === 0 || target.label.length > 64)
    ) {
      throw codedError("INVALID_ARGUMENTS", `${label}.label must be a 1-64 character string when provided`);
    }
    return { contextId: target.contextId, occurrenceId: target.occurrenceId, label: target.label };
  });
  // 重复 target 会让聚合统计重复计数，直接拒绝。
  const seen = new Set();
  for (let index = 0; index < targets.length; index += 1) {
    const key = `${targets[index].contextId} ${targets[index].occurrenceId ?? ""}`;
    if (seen.has(key)) {
      throw codedError(
        "INVALID_ARGUMENTS",
        `targets[${index}] duplicates an earlier target (same contextId and occurrenceId); duplicates would double-count aggregate statistics`
      );
    }
    seen.add(key);
  }
  let include;
  if (request.include === undefined) {
    include = new Set(STYLE_PROFILE_INCLUDES);
  } else {
    if (
      !Array.isArray(request.include) ||
      request.include.length === 0 ||
      !request.include.every((item) => STYLE_PROFILE_INCLUDES.includes(item))
    ) {
      throw codedError(
        "INVALID_ARGUMENTS",
        `include must be a non-empty array from ${STYLE_PROFILE_INCLUDES.join(", ")}`
      );
    }
    include = new Set(request.include);
  }
  // parameters 的乐句分段依赖 phrases 池；单独 include parameters 时静默附带 phrases 计算
  // 会让响应缺 phrases 段还耗算力——只在 include phrases 时才给 perPhrase。
  let phraseGapQuarter = request.phraseGapQuarter ?? 1;
  if (!Number.isFinite(phraseGapQuarter) || phraseGapQuarter < 0.25 || phraseGapQuarter > 8) {
    throw codedError("INVALID_ARGUMENTS", "phraseGapQuarter must be a number between 0.25 and 8");
  }
  const responseMode = request.responseMode ?? "standard";
  if (!["compact", "standard", "verbose"].includes(responseMode)) {
    throw codedError("INVALID_ARGUMENTS", "responseMode must be compact, standard, or verbose");
  }
  return { targets, include, phraseGapQuarter, responseMode };
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
