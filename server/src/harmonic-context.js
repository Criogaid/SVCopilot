// 和声语境、强拍与终止式分析（主计划 P1-A）。sv_analyze_phrase 的扩展 include。
//
// 最重要的诚实边界：**只有单声部旋律无法确定真实和弦**。本模块只观察到一条旋律线，
// 因此每个响应都声明 evidenceScope:"melody_only"，所有和弦结论都是"与这些音高相容的
// 候选"，不是"这里的和弦是什么"。真实伴奏可能与最高分候选完全不同。
//
// 其余契约：
// - 纯内存只读：只消费 phrase-analysis 已加载的音符指纹与 meterMarks，不访问宿主。
// - "br" 呼吸音符继续排除在所有音高统计之外（与 v0.6.2 契约一致）。
// - confidence 是排序用的启发式分数，绝不冒充概率；歧义时必须返回多个候选。
// - suspension/resolution 同时给出前后音符 index 与实际半音/音级运动，不只说"有个挂留"。
// - 缺 meterMarks 时相关 section 如实报 not_captured，绝不假设 4/4。

import { segmentPhrases } from "./expression-plan.js";
import { blickToMusical } from "./musical-time.js";

// 逐项列表统一预算（§4.4 规则 10）：超出的明细进 Artifact，不由调用方选择响应形状。
const MAX_LIST_ITEMS = 100;

export const HARMONIC_INCLUDES = Object.freeze([
  "metricalRoles",
  "chordCandidates",
  "cadence",
  "tensionResolution",
]);

const PITCH_CLASS_NAMES = Object.freeze([
  "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
]);

// 三和弦/七和弦模板：相对根音的半音集合。顺序即同分时的优先顺序
// （更简单、更常见的和弦优先）。
const CHORD_TEMPLATES = Object.freeze([
  { quality: "major", intervals: [0, 4, 7], size: 3 },
  { quality: "minor", intervals: [0, 3, 7], size: 3 },
  { quality: "diminished", intervals: [0, 3, 6], size: 3 },
  { quality: "augmented", intervals: [0, 4, 8], size: 3 },
  { quality: "sus4", intervals: [0, 5, 7], size: 3 },
  { quality: "sus2", intervals: [0, 2, 7], size: 3 },
  { quality: "dominant7", intervals: [0, 4, 7, 10], size: 4 },
  { quality: "major7", intervals: [0, 4, 7, 11], size: 4 },
  { quality: "minor7", intervals: [0, 3, 7, 10], size: 4 },
  { quality: "halfDiminished7", intervals: [0, 3, 6, 10], size: 4 },
  { quality: "diminished7", intervals: [0, 3, 6, 9], size: 4 },
  { quality: "minorMajor7", intervals: [0, 3, 7, 11], size: 4 },
]);

const MAJOR_SCALE = Object.freeze([0, 2, 4, 5, 7, 9, 11]);
const NATURAL_MINOR_SCALE = Object.freeze([0, 2, 3, 5, 7, 8, 10]);

// 节拍权重：强拍承载更多和声信息。这是通用记谱惯例的工程近似，不是宿主事实。
const METRICAL_WEIGHT = Object.freeze({
  downbeat: 1,
  strong: 0.7,
  weak: 0.4,
  offbeat: 0.2,
});

export const HARMONIC_PROVENANCE = Object.freeze({
  evidenceScope: "melody_only",
  evidenceScopeNote:
    "Only one melodic line was observed. Chord candidates are pitch sets COMPATIBLE with that melody, not an observation of the actual harmony. Real accompaniment may differ entirely.",
  chordMethod: "duration_and_metric_weighted_pitch_class_template_match",
  cadenceMethod: "heuristic_ranking_over_key_candidates_phrase_endings_and_metric_position",
  confidenceKind: "heuristic_ranking_not_probability",
  metricalWeights: "engineering_approximation_of_common_practice_notation",
  breathNotes: "excluded_from_all_pitch_statistics",
  basis: "derived_not_host_fact",
  perception: "human_only",
});

// ---------- metricalRoles ----------

// 每个音符的小节/拍位置与强弱角色。没有 meterMarks 就没有小节线，只能如实报 not_captured。
export function analyzeMetricalRoles(loaded, warnings) {
  if (!loaded.meterMarks || loaded.meterMarks.length === 0) {
    warnings.push({
      code: "METER_NOT_CAPTURED",
      message:
        'metricalRoles needs meter marks; re-run sv_snapshot_range with include ["meterMap"] (it is captured by default).',
    });
    return { status: "not_captured" };
  }
  const items = loaded.notes.map((note) => {
    const position = blickToMusical(note.absOnsetBlick, loaded.meterMarks, loaded.quarterBlick);
    const role = metricalRole(position, loaded.quarterBlick);
    return {
      note: note.indexInGroup,
      bar: position.bar,
      beat: position.beat,
      tickInBeatBlick: position.tickInBeatBlick,
      meter: `${position.numerator}/${position.denominator}`,
      role,
      weight: METRICAL_WEIGHT[role],
      onBeat: position.tickInBeatBlick === 0,
    };
  });
  const counts = {};
  for (const item of items) counts[item.role] = (counts[item.role] ?? 0) + 1;
  const anacrusis = detectAnacrusis(loaded, items);
  const summary = {
    noteCount: items.length,
    byRole: counts,
    downbeatCount: counts.downbeat ?? 0,
    offbeatCount: counts.offbeat ?? 0,
    ...(anacrusis ? { anacrusis } : {}),
  };
  const cap = MAX_LIST_ITEMS;
  if (items.length > cap) {
    warnings.push({
      code: "METRICAL_ROLES_TRUNCATED",
      message: `metricalRoles reports the first ${cap} of ${items.length} notes; read the sealed detail artifact for the full list.`,
    });
  }
  return {
    status: "succeeded",
    summary,
    items: items.slice(0, cap),
    itemsTruncated: items.length > cap,
  };
}

function metricalRole(position, quarterBlick) {
  if (position.tickInBeatBlick !== 0) return "offbeat";
  if (position.beat === 1) return "downbeat";
  // 4/4 的第 3 拍、6/8 的第 4 拍等次强拍：分子偶数时的中点。
  const midpoint = position.numerator / 2 + 1;
  if (position.numerator % 2 === 0 && position.beat === midpoint) return "strong";
  return "weak";
}

// 弱起：第一个音符不落在小节首，且第一小节被"切掉"了前面部分。
function detectAnacrusis(loaded, items) {
  const first = items[0];
  if (!first) return null;
  if (first.beat === 1 && first.tickInBeatBlick === 0) return null;
  return {
    present: true,
    firstNote: first.indexInGroup,
    bar: first.bar,
    beat: first.beat,
    note: "The first melodic note does not fall on a downbeat; treat bar 1 as an upbeat when reading chord windows.",
  };
}

// ---------- chordCandidates ----------

// 按小节（或指定 harmonic window）聚合音级，用时值 × 节拍权重加权，再与模板匹配。
export function analyzeChordCandidates(loaded, options, warnings) {
  if (!loaded.meterMarks || loaded.meterMarks.length === 0) {
    warnings.push({
      code: "METER_NOT_CAPTURED",
      message:
        'chordCandidates needs meter marks to build harmonic windows; re-run sv_snapshot_range with include ["meterMap"].',
    });
    return { status: "not_captured" };
  }
  const windows = buildHarmonicWindows(loaded, options.harmonicWindow);
  if (windows.length === 0) {
    return { status: "insufficient_evidence", reason: "no_window_contains_melodic_notes" };
  }
  const items = windows.map((window) => scoreWindow(window, options));
  const ambiguousCount = items.filter((item) => item.ambiguous).length;
  if (ambiguousCount > 0) {
    warnings.push({
      code: "CHORD_CANDIDATES_AMBIGUOUS",
      message: `${ambiguousCount} of ${items.length} harmonic window(s) have a thin gap between the top two candidates; a single melody line cannot decide between them. Report the alternatives instead of the top score alone.`,
    });
  }
  const cap = MAX_LIST_ITEMS;
  if (items.length > cap) {
    warnings.push({
      code: "CHORD_CANDIDATES_TRUNCATED",
      message: `chordCandidates reports the first ${cap} of ${items.length} windows; read the sealed detail artifact for the full list.`,
    });
  }
  const summary = {
    windowCount: items.length,
    windowUnit: options.harmonicWindow,
    ambiguousWindowCount: ambiguousCount,
    // 单旋律的根本限制：即使某个窗口只有一个候选，也不代表伴奏就是它。
    evidenceScope: "melody_only",
  };
  return {
    status: "succeeded",
    summary,
    items: items.slice(0, cap),
    itemsTruncated: items.length > cap,
  };
}

// 把音符按小节（bar）或半小节（half_bar）切分；跨窗音符按重叠时值分摊到各窗口。
function buildHarmonicWindows(loaded, unit) {
  const { meterMarks, quarterBlick, notes } = loaded;
  const boundaries = [];
  const firstOnset = notes[0].absOnsetBlick;
  const lastEnd = notes.reduce((max, note) => Math.max(max, note.absEndBlick), firstOnset);
  const wholeBlick = quarterBlick * 4;
  for (let index = 0; index < meterMarks.length; index += 1) {
    const mark = meterMarks[index];
    const next = meterMarks[index + 1];
    const barLength = (mark.numerator * wholeBlick) / mark.denominator;
    const step = unit === "half_bar" ? barLength / 2 : barLength;
    const segmentEnd = next ? next.positionBlick : lastEnd + step;
    for (let at = mark.positionBlick; at < segmentEnd && at <= lastEnd; at += step) {
      if (at + step <= firstOnset) continue;
      boundaries.push({ startBlick: at, endBlick: Math.min(at + step, segmentEnd) });
    }
  }
  const windows = [];
  for (const boundary of boundaries) {
    const overlapping = [];
    for (const note of loaded.notes) {
      const overlap =
        Math.min(note.absEndBlick, boundary.endBlick) -
        Math.max(note.absOnsetBlick, boundary.startBlick);
      if (overlap > 0) overlapping.push({ note, overlapBlick: overlap });
    }
    if (overlapping.length === 0) continue;
    windows.push({ ...boundary, notes: overlapping, loaded });
  }
  return windows;
}

function scoreWindow(window, options) {
  const { loaded } = window;
  // 音级权重 = 窗内时值 × 节拍权重。强拍上的长音最能代表和声。
  const weights = new Array(12).fill(0);
  const contributors = [];
  for (const entry of window.notes) {
    const position = blickToMusical(
      entry.note.absOnsetBlick,
      loaded.meterMarks,
      loaded.quarterBlick
    );
    const metricWeight = METRICAL_WEIGHT[metricalRole(position, loaded.quarterBlick)];
    const weight = (entry.overlapBlick / loaded.quarterBlick) * metricWeight;
    const pitchClass = ((entry.note.pitch % 12) + 12) % 12;
    weights[pitchClass] += weight;
    contributors.push({ note: entry.note.indexInGroup, pitchClass, weight });
  }
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  if (totalWeight === 0) {
    return {
      startBlick: window.startBlick,
      endBlick: window.endBlick,
      status: "insufficient_evidence",
    };
  }
  const present = weights.map((value, index) => ({ pitchClass: index, weight: value }))
    .filter((entry) => entry.weight > 0);

  const scored = [];
  for (let root = 0; root < 12; root += 1) {
    for (const template of CHORD_TEMPLATES) {
      const members = new Set(template.intervals.map((interval) => (root + interval) % 12));
      let covered = 0;
      let nonChord = 0;
      for (const entry of present) {
        if (members.has(entry.pitchClass)) covered += entry.weight;
        else nonChord += entry.weight;
      }
      const coveredPitchClasses = [...members].filter((pitchClass) => weights[pitchClass] > 0);
      // 未被旋律触及的和弦音是"猜测出来的"；用它折减分数，避免七和弦仅因音多就胜出。
      const memberCoverage = coveredPitchClasses.length / members.size;
      const rootBonus = weights[root] > 0 ? 0.1 : 0;
      const score = (covered / totalWeight) * memberCoverage + rootBonus;
      scored.push({
        root,
        rootName: PITCH_CLASS_NAMES[root],
        quality: template.quality,
        symbol: `${PITCH_CLASS_NAMES[root]}${qualitySuffix(template.quality)}`,
        score,
        coveredWeightRatio: covered / totalWeight,
        nonChordWeightRatio: nonChord / totalWeight,
        chordTonesPresent: coveredPitchClasses.map((pitchClass) => PITCH_CLASS_NAMES[pitchClass]),
        chordTonesAbsent: [...members]
          .filter((pitchClass) => weights[pitchClass] === 0)
          .map((pitchClass) => PITCH_CLASS_NAMES[pitchClass]),
        nonChordTones: present
          .filter((entry) => !members.has(entry.pitchClass))
          .map((entry) => PITCH_CLASS_NAMES[entry.pitchClass]),
      });
    }
  }
  scored.sort((left, right) => right.score - left.score || left.root - right.root);
  const candidates = scored.slice(0, options.maxChordCandidates);
  const gap = candidates.length > 1 ? candidates[0].score - candidates[1].score : null;
  const musical = blickToMusical(window.startBlick, loaded.meterMarks, loaded.quarterBlick);
  return {
    startBlick: window.startBlick,
    endBlick: window.endBlick,
    bar: musical.bar,
    beat: musical.beat,
    status: "succeeded",
    notes: contributors.map((entry) => entry.note),
    pitchClassesPresent: present
      .sort((left, right) => right.weight - left.weight)
      .map((entry) => PITCH_CLASS_NAMES[entry.pitchClass]),
    candidates,
    runnerUpGap: gap,
    // 差距薄 = 单旋律不足以在候选间裁决，必须如实标记。
    ambiguous: gap !== null && gap < options.ambiguityThreshold,
    evidenceScope: "melody_only",
  };
}

function qualitySuffix(quality) {
  switch (quality) {
    case "major":
      return "";
    case "minor":
      return "m";
    case "diminished":
      return "dim";
    case "augmented":
      return "aug";
    case "sus4":
      return "sus4";
    case "sus2":
      return "sus2";
    case "dominant7":
      return "7";
    case "major7":
      return "maj7";
    case "minor7":
      return "m7";
    case "halfDiminished7":
      return "m7b5";
    case "diminished7":
      return "dim7";
    case "minorMajor7":
      return "mMaj7";
    default:
      return quality;
  }
}

// ---------- cadence ----------

// 终止式只依据调性候选、句末音级、节拍位置和（若有）和弦候选进行启发式排序。
// 单旋律无法证实终止式，confidence 只是排序分数。
// 注意：这里自行做乐句切分，不依赖 phrases section 的输出——compact 模式不返回
// phrases.items，但终止式在任何情况下都必须可用。
export function analyzeCadence(loaded, keyResult, chordSection, options, warnings) {
  const best = keyResult?.bestCandidate ?? null;
  if (!best) {
    return { status: "insufficient_evidence", reason: "no_key_candidate" };
  }
  const gapBlick = Math.max(1, Math.round(options.phraseGapQuarter * loaded.quarterBlick));
  const phrases = segmentPhrases(loaded.notes, gapBlick);
  if (phrases.length === 0) {
    return { status: "insufficient_evidence", reason: "no_phrase_segmentation" };
  }
  const scale = best.mode === "major" ? MAJOR_SCALE : NATURAL_MINOR_SCALE;
  const items = [];
  for (let index = 0; index < phrases.length; index += 1) {
    const phraseNotes = phrases[index].notes;
    if (phraseNotes.length === 0) continue;
    const finalNote = phraseNotes[phraseNotes.length - 1];
    const penultimate = phraseNotes.length > 1 ? phraseNotes[phraseNotes.length - 2] : null;
    items.push(
      classifyCadence(
        loaded,
        best,
        scale,
        finalNote,
        penultimate,
        {
          index,
          startBlick: phraseNotes[0].absOnsetBlick,
          endBlick: finalNote.absEndBlick,
        },
        chordSection,
        options
      )
    );
  }
  if (items.length === 0) {
    return { status: "insufficient_evidence", reason: "no_phrase_contained_melodic_notes" };
  }
  const ambiguous = items.filter((item) => item.ambiguous).length;
  if (ambiguous > 0) {
    warnings.push({
      code: "CADENCE_AMBIGUOUS",
      message: `${ambiguous} of ${items.length} phrase ending(s) fit more than one cadence type closely; a melody line alone cannot decide. Report the alternatives.`,
    });
  }
  return {
    status: "succeeded",
    keyUsed: { tonic: best.tonic, mode: best.mode },
    keyIsHeuristic: true,
    summary: { phraseEndingCount: items.length, ambiguousCount: ambiguous },
    items,
    evidenceScope: "melody_only",
  };
}

function classifyCadence(loaded, key, scale, finalNote, penultimate, phrase, chordSection, options) {
  const tonicPitchClass = PITCH_CLASS_NAMES.indexOf(key.tonic);
  const finalDegree = degreeOf(finalNote.pitch, tonicPitchClass, scale);
  const penultimateDegree = penultimate
    ? degreeOf(penultimate.pitch, tonicPitchClass, scale)
    : null;
  const position = loaded.meterMarks
    ? blickToMusical(finalNote.absOnsetBlick, loaded.meterMarks, loaded.quarterBlick)
    : null;
  const finalMetricalRole = position ? metricalRole(position, loaded.quarterBlick) : null;
  const onStrongBeat =
    finalMetricalRole === "downbeat" || finalMetricalRole === "strong";
  const chordWindow = chordSection?.items?.find(
    (window) => finalNote.absOnsetBlick >= window.startBlick && finalNote.absOnsetBlick < window.endBlick
  );
  const topChord = chordWindow?.candidates?.[0] ?? null;

  // 候选终止式的启发式打分。每条规则都可以被真实伴奏推翻——这正是 melody_only 的含义。
  const candidates = [];
  const push = (type, score, rationale) => candidates.push({ type, score, rationale });

  if (finalDegree?.degree === 1) {
    push(
      "authentic",
      0.5 + (onStrongBeat ? 0.2 : 0) + (penultimateDegree?.degree === 7 || penultimateDegree?.degree === 5 ? 0.2 : 0),
      "Phrase ends on scale degree 1; a leading-tone or dominant-degree approach strengthens an authentic reading."
    );
    push("plagal", 0.35 + (penultimateDegree?.degree === 4 || penultimateDegree?.degree === 6 ? 0.2 : 0), "Ending on degree 1 approached from degree 4 or 6 also fits a plagal reading.");
  }
  if (finalDegree?.degree === 5) {
    push(
      "half",
      0.55 + (onStrongBeat ? 0.15 : 0),
      "Phrase ends on scale degree 5, the classic melodic marker of a half cadence."
    );
  }
  if (finalDegree?.degree === 3) {
    push("authentic_inversion_or_open", 0.3, "Ending on degree 3 can sit over a tonic chord (inverted) or continue the phrase; a melody cannot distinguish these.");
  }
  if (finalDegree?.degree === 6 && penultimateDegree?.degree === 7) {
    push("deceptive", 0.45, "Degree 7 moving to degree 6 is the melodic signature of a deceptive resolution.");
  }
  if (finalDegree && finalDegree.nonDiatonic) {
    push("inconclusive", 0.4, "The phrase ends on a non-diatonic pitch; no common-practice cadence type fits cleanly.");
  }
  if (candidates.length === 0) {
    push("inconclusive", 0.3, `Phrase ends on scale degree ${finalDegree?.degree ?? "unknown"}, which is not a characteristic cadence ending in this key.`);
  }
  if (topChord && finalDegree?.degree === 1 && topChord.quality === "major") {
    const authentic = candidates.find((candidate) => candidate.type === "authentic");
    if (authentic) {
      authentic.score += 0.1;
      authentic.rationale += " The window's top chord candidate is a major triad, consistent with a tonic arrival.";
    }
  }
  candidates.sort((left, right) => right.score - left.score);
  const gap = candidates.length > 1 ? candidates[0].score - candidates[1].score : null;
  return {
    phraseIndex: phrase.index,
    startBlick: phrase.startBlick,
    endBlick: phrase.endBlick,
    finalNote: finalNote.indexInGroup,
    ...(penultimate ? { penultimateNote: penultimate.indexInGroup } : {}),
    finalScaleDegree: finalDegree,
    penultimateScaleDegree: penultimateDegree,
    onStrongBeat,
    ...(chordWindow ? { chordWindowTopCandidate: topChord?.symbol ?? null } : {}),
    candidates: candidates.slice(0, options.maxCadenceCandidates),
    runnerUpGap: gap,
    ambiguous: gap !== null && gap < options.ambiguityThreshold,
    // confidence 是排序分数，不是"这里有 x% 概率是正格终止"。
    confidenceKind: "heuristic_ranking_not_probability",
  };
}

function degreeOf(pitch, tonicPitchClass, scale) {
  const interval = (((pitch % 12) + 12) % 12 - tonicPitchClass + 12) % 12;
  const index = scale.indexOf(interval);
  if (index >= 0) return { degree: index + 1, semitoneFromTonic: interval, nonDiatonic: false };
  return { degree: null, semitoneFromTonic: interval, nonDiatonic: true };
}

// ---------- tensionResolution ----------

// 张力—解决：必须同时指出前后音符 index 与实际半音/音级运动，而不是只说"有个悬留"。
export function analyzeTensionResolution(loaded, keyResult, options, warnings) {
  const best = keyResult?.bestCandidate ?? null;
  if (!best) {
    return { status: "insufficient_evidence", reason: "no_key_candidate" };
  }
  const scale = best.mode === "major" ? MAJOR_SCALE : NATURAL_MINOR_SCALE;
  const tonicPitchClass = PITCH_CLASS_NAMES.indexOf(best.tonic);
  const items = [];
  for (let index = 0; index + 1 < loaded.notes.length; index += 1) {
    const from = loaded.notes[index];
    const to = loaded.notes[index + 1];
    const fromDegree = degreeOf(from.pitch, tonicPitchClass, scale);
    const toDegree = degreeOf(to.pitch, tonicPitchClass, scale);
    const motionSemitone = to.pitch - from.pitch;
    const event = classifyTension(
      loaded,
      { from, to, fromDegree, toDegree, motionSemitone },
      options
    );
    if (event) items.push(event);
  }
  if (items.length === 0) {
    return {
      status: "succeeded",
      summary: { eventCount: 0 },
      items: [],
      note: "No leading-tone, non-diatonic, or suspension-like motion was detected in this melody.",
      evidenceScope: "melody_only",
    };
  }
  const cap = MAX_LIST_ITEMS;
  if (items.length > cap) {
    warnings.push({
      code: "TENSION_RESOLUTION_TRUNCATED",
      message: `tensionResolution reports the first ${cap} of ${items.length} events; read the sealed detail artifact for the full list.`,
    });
  }
  const byKind = {};
  for (const item of items) byKind[item.kind] = (byKind[item.kind] ?? 0) + 1;
  const summary = { eventCount: items.length, byKind };
  return {
    status: "succeeded",
    summary,
    items: items.slice(0, cap),
    itemsTruncated: items.length > cap,
    evidenceScope: "melody_only",
  };
}

function classifyTension(loaded, motion, options) {
  const { from, to, fromDegree, toDegree, motionSemitone } = motion;
  const position = loaded.meterMarks
    ? blickToMusical(from.absOnsetBlick, loaded.meterMarks, loaded.quarterBlick)
    : null;
  const fromRole = position ? metricalRole(position, loaded.quarterBlick) : null;
  const base = {
    fromNote: from.indexInGroup,
    toNote: to.indexInGroup,
    fromScaleDegree: fromDegree,
    toScaleDegree: toDegree,
    motionSemitone,
    motionDirection: motionSemitone === 0 ? "static" : motionSemitone > 0 ? "up" : "down",
    ...(fromRole ? { fromMetricalRole: fromRole } : {}),
  };

  // 导音解决：7 → 1 上行半音。
  if (fromDegree.degree === 7 && toDegree.degree === 1 && motionSemitone === 1) {
    return {
      ...base,
      kind: "leading_tone_resolution",
      resolved: true,
      description: "Scale degree 7 resolves up a semitone to degree 1.",
    };
  }
  // 导音未解决：停在 7 却跳走。
  if (fromDegree.degree === 7 && toDegree.degree !== 1) {
    return {
      ...base,
      kind: "leading_tone_unresolved",
      resolved: false,
      description: `Scale degree 7 moves to degree ${toDegree.degree ?? "non-diatonic"} instead of resolving up to 1.`,
    };
  }
  // 调外音：解决与否取决于是否级进回到调内。
  if (fromDegree.nonDiatonic) {
    const stepwise = Math.abs(motionSemitone) <= 2 && !toDegree.nonDiatonic;
    return {
      ...base,
      kind: stepwise ? "chromatic_resolution" : "chromatic_unresolved",
      resolved: stepwise,
      description: stepwise
        ? `A non-diatonic pitch (${motion.fromDegree.semitoneFromTonic} semitones above the tonic) resolves by step into the scale.`
        : `A non-diatonic pitch (${motion.fromDegree.semitoneFromTonic} semitones above the tonic) leaves by ${Math.abs(motionSemitone)} semitones without a stepwise resolution.`,
    };
  }
  // 悬留式下行：强拍长音级进下行到弱位——旋律层面能观察到的"挂留—解决"轮廓。
  if (
    fromRole &&
    (fromRole === "downbeat" || fromRole === "strong") &&
    motionSemitone < 0 &&
    Math.abs(motionSemitone) <= 2 &&
    from.durationBlick >= loaded.quarterBlick * options.suspensionMinQuarter
  ) {
    return {
      ...base,
      kind: "suspension_like_descent",
      resolved: true,
      description: `A long note on a ${fromRole} resolves down ${Math.abs(motionSemitone)} semitone(s) (degree ${fromDegree.degree} to degree ${toDegree.degree}). Whether this is a true suspension depends on the accompaniment, which is not observable here.`,
    };
  }
  return null;
}
