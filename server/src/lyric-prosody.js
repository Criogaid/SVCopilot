import { classifyCharacter, countEnglishSyllables, splitKanaMorae } from "./lyric-align.js";
import { blickToMusical } from "./musical-time.js";
import { ServiceTiming } from "./service-timing.js";
import {
  analyzeVocalEventSequence,
  isBreathEventLyrics as isBreathLyrics,
} from "./vocal-event-semantics.js";
import { unknownContextError } from "./snapshot.js";

// sv_validate_lyrics_prosody：咬字/韵律校验器（黑盒审计 M-02 / 研究提示 Layer C）。
//
// 关键契约：
// - 纯内存只读：只读取 range context 已存的音符指纹、meterMarks 和 processing 摘要，
//   不进 ExecutionCoordinator、不访问宿主。
// - 只报告不修改：定位是校验器——issues 携带建议（suggestion）指向 sv_patch_notes /
//   sv_align_lyrics / sv_restructure_notes，本工具绝不生成 patch，更不写宿主。
// - 分档诚实置信：mora 切分是确定性规则；英语音节数是启发式（文献 ~85-90%）；
//   重读位置是"首音节重读"近似（无词典），只发 info 级、confidence:"low"，绝不报 error。
// - 音素覆盖率遵守 §5.4 两维度语义：br/延音（"-"/"+"）的空音素合法，只报旋律词音符的
//   空音素；context 未捕获 processing 时如实 not_captured，不猜。
export const PROSODY_CHECKS = Object.freeze([
  "breath",
  "specialLyricChains",
  "japaneseMora",
  "englishSyllables",
  "languageConsistency",
  "stressAlignment",
  "phonemeCoverage",
]);

const MAX_ISSUE_ITEMS = 100;
// 小假名（不能独立起头）：与 lyric-align 的 SMALL_KANA 语义一致。
const SMALL_KANA = new Set([..."ぁぃぅぇぉゃゅょゎァィゥェォャュョヮ"]);
const LONG_BREATH_QUARTERS = 2;

const PROVENANCE = Object.freeze({
  validator: "deterministic_and_heuristic_checks",
  japaneseMora: "deterministic_mora_rules",
  englishSyllables: "heuristic_vowel_groups_85_90_percent_literature_range",
  stressModel: "first_syllable_heuristic_no_dictionary",
  strongBeatModel: "downbeat_and_midbar_from_meter_marks",
  breathDetection: "official_documented_special_lyric_br",
  specialLyricRoles: "official_v2_manual_enter_notes",
  specialLyricChainSpacing: "host_observed_requires_profile_calibration",
  phonemeCoverage: "snapshot_time_processing_state_not_live",
  basis: "derived_not_host_fact",
  perception: "human_only",
});

export class LyricProsodyService {
  constructor({ store, now = () => Date.now() } = {}) {
    if (!store) throw new Error("LyricProsodyService requires the shared SnapshotStore");
    this.store = store;
    this.now = now;
  }

  async validate(request = {}) {
    const timer = new ServiceTiming({ now: this.now, phaseNames: ["loadMs", "checkMs"] });
    const input = normalizeValidateRequest(request);
    // 纯内存服务：不进入协调器；coordinatorQueueMs/operationMs 恒 0，如实报告。
    timer.requestCoordinator();
    const warnings = [];
    const loaded = await timer.measure("loadMs", async () =>
      resolveValidateSource(this.store, input)
    );
    const { issues, coverage } = await timer.measure("checkMs", async () =>
      runChecks(loaded, input, warnings)
    );
    return buildValidateResponse(loaded, input, issues, coverage, warnings, timer.finish());
  }
}

// ---------- 上下文解析（与 phrase-analysis 同模式） ----------

function resolveValidateSource(store, input) {
  const stored = store.get(input.contextId);
  if (!stored) {
    throw unknownContextError(store, input.contextId);
  }
  if (stored.context?.kind !== "range") {
    throw codedError(
      "INVALID_CONTEXT",
      'sv_validate_lyrics_prosody needs a range context from sv_snapshot_range with include ["notes"]'
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
      'sv_validate_lyrics_prosody needs note fingerprints; re-run sv_snapshot_range with include ["notes"]'
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
      indexInGroup: fingerprint.indexInGroup,
      lyrics: fingerprint.lyrics,
      phonemesOverride: fingerprint.phonemesOverride ?? "",
      languageOverride: fingerprint.languageOverride ?? "",
      pitch: fingerprint.pitch,
      absOnsetBlick: timeOffset + fingerprint.onsetBlick,
      durationBlick: fingerprint.durationBlick,
    }))
    .sort((left, right) => left.absOnsetBlick - right.absOnsetBlick);
  if (notes.length === 0) {
    throw codedError(
      "NOTES_NOT_CAPTURED",
      'the selected occurrence has no note fingerprints; re-run sv_snapshot_range with include ["notes"]'
    );
  }
  return {
    stored,
    occurrence,
    notes,
    quarterBlick,
    meterMarks: stored.context.meterMarks ?? null,
  };
}

// ---------- 检查执行 ----------

function runChecks(loaded, input, warnings) {
  const issues = [];
  const coverage = {};
  if (input.checks.has("breath")) checkBreath(loaded, issues);
  if (input.checks.has("specialLyricChains")) checkSpecialLyricChains(loaded, issues);
  if (input.checks.has("japaneseMora")) checkJapaneseMora(loaded, issues);
  if (input.checks.has("englishSyllables")) checkEnglishSyllables(loaded, issues);
  if (input.checks.has("languageConsistency")) checkLanguageConsistency(loaded, issues);
  if (input.checks.has("stressAlignment")) {
    coverage.stressAlignment = checkStressAlignment(loaded, issues, warnings);
  }
  if (input.checks.has("phonemeCoverage")) {
    coverage.phonemeCoverage = checkPhonemeCoverage(loaded, issues, warnings);
  }
  // 稳定输出顺序：severity（error > warning > info）内按乐谱时间序。
  const severityRank = { error: 0, warning: 1, info: 2 };
  issues.sort(
    (left, right) =>
      severityRank[left.severity] - severityRank[right.severity] ||
      left.startBlick - right.startBlick
  );
  return { issues, coverage };
}

function pushIssue(issues, note, issue) {
  issues.push({
    ...issue,
    notes: (issue.notes ?? [note]).map((item) =>
      Number.isSafeInteger(item) ? item : item.indexInGroup
    ),
    lyrics: issue.lyrics ?? note.lyrics,
    startBlick: note.absOnsetBlick,
  });
}

function checkSpecialLyricChains(loaded, issues) {
  const sequence = analyzeVocalEventSequence(
    loaded.notes.map((note) => ({ ...note, phonemes: note.phonemesOverride }))
  );
  for (const issue of sequence.issues) {
    issues.push({
      ...issue,
      // 共享模块回传的是本模块传入的 note 对象；对外身份是组内 index（§3.1）。
      notes: (issue.notes ?? []).map((item) => item.indexInGroup),
      kind: issue.code.toLowerCase(),
      confidence: specialLyricIssueConfidence(issue.code),
      suggestion: specialLyricIssueSuggestion(issue.code),
    });
  }
}

function specialLyricIssueConfidence(code) {
  if (code === "SYLLABLE_CHAIN_GAP") return "host_observed";
  return code === "STANDALONE_APOSTROPHE_UNCALIBRATED" ||
    code === "SUSPICIOUS_SPECIAL_LYRIC_VARIANT" ||
    code === "SYLLABLE_CHAIN_OVERLAP"
    ? "heuristic"
    : "official_contract";
}

function specialLyricIssueSuggestion(code) {
  if (code === "ORPHAN_PLUS" || code === "ORPHAN_PHONATION_CONTINUATION") {
    return "repair the continuation chain with sv_patch_notes or sv_restructure_notes.";
  }
  if (code === "SYLLABLE_CHAIN_GAP" || code === "SYLLABLE_CHAIN_OVERLAP") {
    return "review the two note boundaries, then adjust onset/duration with sv_patch_notes.";
  }
  return "review the special lyric spelling and preserve it unless the intended host semantics are known.";
}

// 1. breath：官方 br 事件不应带 language/phonemes override（override 是可疑残留）；
//    异常长换气只提示不判错。
function checkBreath(loaded, issues) {
  for (const note of loaded.notes) {
    if (!isBreathLyrics(note.lyrics)) continue;
    if (note.languageOverride !== "" || note.phonemesOverride !== "") {
      pushIssue(issues, note, {
        kind: "breath_with_overrides",
        severity: "warning",
        confidence: "deterministic_rule",
        message: `breath note carries ${[
          note.languageOverride !== "" ? `languageOverride "${note.languageOverride}"` : null,
          note.phonemesOverride !== "" ? `phonemesOverride "${note.phonemesOverride}"` : null,
        ]
          .filter(Boolean)
          .join(" and ")}; "br" is an official breath event and overrides are likely leftovers.`,
        suggestion: "clear the override(s) via sv_patch_notes (set languageOverride/phonemesOverride to \"\").",
      });
    }
    if (note.durationBlick >= LONG_BREATH_QUARTERS * loaded.quarterBlick) {
      pushIssue(issues, note, {
        kind: "breath_unusually_long",
        severity: "info",
        confidence: "heuristic_estimate",
        message: `breath note lasts ${(note.durationBlick / loaded.quarterBlick).toFixed(2)} quarters (>= ${LONG_BREATH_QUARTERS}); confirm it is intentional.`,
        suggestion: "shorten the note with sv_patch_notes if the long breath is unintended.",
      });
    }
  }
}

// 2. japaneseMora：一个音符的歌词切出多个 mora → 需要拆分（唱歌中一 mora 一音符）；
//    小假名起头的歌词无法独立发音。
function checkJapaneseMora(loaded, issues) {
  for (const note of loaded.notes) {
    const rawLyrics = typeof note.lyrics === "string" ? note.lyrics : "";
    const lyrics = rawLyrics.trim();
    if (
      lyrics.length === 0 ||
      isBreathLyrics(rawLyrics) ||
      rawLyrics === "+" ||
      rawLyrics === "-"
    ) {
      continue;
    }
    const characters = [...lyrics];
    if (!characters.every((character) => classifyCharacter(character) === "kana")) continue;
    if (SMALL_KANA.has(characters[0])) {
      pushIssue(issues, note, {
        kind: "isolated_small_kana",
        severity: "error",
        confidence: "deterministic_rule",
        message: `lyric "${lyrics}" starts with a small kana, which cannot form a mora on its own.`,
        suggestion: "merge the small kana into the preceding note's lyric via sv_patch_notes.",
      });
      continue;
    }
    const morae = splitKanaMorae(lyrics);
    if (morae.length > 1) {
      pushIssue(issues, note, {
        kind: "note_overfilled_morae",
        severity: "warning",
        confidence: "deterministic_rule",
        message: `lyric "${lyrics}" contains ${morae.length} morae (${morae.join("/")}) on a single note; sung Japanese places one mora per note.`,
        suggestion:
          "split the note with sv_restructure_notes and redistribute the morae, or re-plan the passage with sv_align_lyrics.",
      });
    }
  }
}

// 3. englishSyllables：词的启发式音节数 n 应跟随 n-1 个 "+" 续拍音符。
//    计数本身 ~85-90% 准确（provenance 已声明），偏差只报 warning。
function checkEnglishSyllables(loaded, issues) {
  for (let index = 0; index < loaded.notes.length; index += 1) {
    const note = loaded.notes[index];
    const rawLyrics = typeof note.lyrics === "string" ? note.lyrics : "";
    const lyrics = rawLyrics.trim();
    if (!/^[A-Za-z][A-Za-z']*$/.test(lyrics) || isBreathLyrics(rawLyrics)) continue;
    // 只在语言可判定为英语时检查：显式 english override，或无 override 且词形是纯拉丁多字母。
    if (note.languageOverride !== "" && note.languageOverride !== "english") continue;
    const syllables = countEnglishSyllables(lyrics);
    let continuations = 0;
    for (let next = index + 1; next < loaded.notes.length; next += 1) {
      if (loaded.notes[next].lyrics === "+") continuations += 1;
      else break;
    }
    if (continuations === syllables - 1) continue;
    const involved = loaded.notes
      .slice(index, index + 1 + Math.max(continuations, 0))
      .map((item) => item.indexInGroup);
    pushIssue(issues, note, {
      kind: continuations < syllables - 1 ? "word_underfilled_syllables" : "word_overfilled_syllables",
      severity: "warning",
      confidence: "heuristic_estimate",
      notes: involved,
      message: `"${lyrics}" is estimated at ${syllables} syllable(s) (heuristic, ~85-90% accurate) but is followed by ${continuations} "+" note(s); expected ${syllables - 1}.`,
      suggestion:
        continuations < syllables - 1
          ? 'add "+" continuation notes (sv_restructure_notes split + sv_patch_notes) or verify the syllable count manually.'
          : 'remove or repurpose the extra "+" note(s), or verify the syllable count manually.',
    });
  }
}

// 4. languageConsistency：歌词字符类别与 languageOverride 冲突。
function checkLanguageConsistency(loaded, issues) {
  for (const note of loaded.notes) {
    const rawLyrics = typeof note.lyrics === "string" ? note.lyrics : "";
    const lyrics = rawLyrics.trim();
    const override = note.languageOverride;
    if (lyrics.length === 0 || override === "" || isBreathLyrics(rawLyrics)) continue;
    if (rawLyrics === "+" || rawLyrics === "-") {
      // 续拍/延音不承载语言，带 override 属于可疑残留。
      pushIssue(issues, note, {
        kind: "continuation_with_language_override",
        severity: "info",
        confidence: "deterministic_rule",
        message: `continuation note "${lyrics}" carries languageOverride "${override}", which has no effect on a continuation.`,
        suggestion: 'clear the languageOverride via sv_patch_notes if it is a leftover.',
      });
      continue;
    }
    const kinds = new Set([...lyrics].map(classifyCharacter));
    const conflict =
      (kinds.has("kana") && !["japanese"].includes(override)) ||
      (kinds.has("latin") && !kinds.has("kana") && !kinds.has("cjk") && override === "japanese") ||
      (kinds.has("cjk") && override === "english");
    if (conflict) {
      pushIssue(issues, note, {
        kind: "language_override_conflict",
        severity: "warning",
        confidence: "deterministic_rule",
        message: `lyric "${lyrics}" (${[...kinds].filter((kind) => kind !== "separator").join("/")}) conflicts with languageOverride "${override}".`,
        suggestion: "fix the languageOverride via sv_patch_notes, or re-plan with sv_align_lyrics.",
      });
    }
  }
}

// 5. stressAlignment：多音节英语词首音节假设重读（无词典），与拍强比对。
//    强拍=每小节第 1 拍；次强=中拍（4/4 的第 3 拍、6/8 的第 4 拍）。只发 info。
function checkStressAlignment(loaded, issues, warnings) {
  if (!Array.isArray(loaded.meterMarks) || loaded.meterMarks.length === 0) {
    warnings.push({
      code: "METER_NOT_CAPTURED",
      message: "the range context has no meter marks; stressAlignment was skipped.",
    });
    return { status: "not_captured" };
  }
  let checkedWords = 0;
  for (const note of loaded.notes) {
    const rawLyrics = typeof note.lyrics === "string" ? note.lyrics : "";
    const lyrics = rawLyrics.trim();
    if (!/^[A-Za-z][A-Za-z']*$/.test(lyrics) || isBreathLyrics(rawLyrics)) continue;
    if (note.languageOverride !== "" && note.languageOverride !== "english") continue;
    if (countEnglishSyllables(lyrics) < 2) continue;
    checkedWords += 1;
    const musical = blickToMusical(note.absOnsetBlick, loaded.meterMarks, loaded.quarterBlick);
    const strongBeats = strongBeatsFor(musical.numerator);
    const onDownbeatTick = musical.tickInBeatBlick === 0;
    if (!(onDownbeatTick && strongBeats.has(musical.beat))) {
      pushIssue(issues, note, {
        kind: "stressed_syllable_on_weak_beat",
        severity: "info",
        confidence: "low",
        message: `multi-syllable word "${lyrics}" (first-syllable-stress heuristic, no dictionary) starts at bar ${musical.bar} beat ${musical.beat}${musical.tickInBeatBlick > 0 ? "+" : ""}, which is not a strong beat in ${musical.numerator}/${musical.denominator}.`,
        suggestion:
          "if the word's real stress is on the first syllable, consider shifting the onset (sv_patch_notes) or re-syllabifying; ignore if stress falls elsewhere.",
      });
    }
  }
  return { status: "checked", checkedWords };
}

function strongBeatsFor(numerator) {
  // 每小节第 1 拍恒强；偶数拍号加中拍（4/4→3，6/8→4）。奇数拍号只认 downbeat，不猜分组。
  const strong = new Set([1]);
  if (numerator >= 4 && numerator % 2 === 0) strong.add(numerator / 2 + 1);
  return strong;
}

// 6. phonemeCoverage：只报旋律词音符的空音素；br 与 "-"/"+" 的空音素合法（§5.4）。
//    processing 是快照时状态，可能滞后于当前宿主，provenance 已声明。
function checkPhonemeCoverage(loaded, issues, warnings) {
  const processing = loaded.occurrence.processing;
  if (!isRecord(processing) || !isRecord(processing.phonemeCoverage)) {
    warnings.push({
      code: "PROCESSING_NOT_CAPTURED",
      message:
        'the range context was captured without include ["processing"]; phonemeCoverage was skipped — re-snapshot with processing included.',
    });
    return { status: "not_captured" };
  }
  const emptyIndices = new Set(processing.phonemeCoverage.emptyNoteIndices ?? []);
  const flagged = [];
  for (const note of loaded.notes) {
    if (!emptyIndices.has(note.indexInGroup)) continue;
    const rawLyrics = typeof note.lyrics === "string" ? note.lyrics : "";
    // 合法空音素：呼吸、延音、续拍。
    if (isBreathLyrics(rawLyrics) || rawLyrics === "-" || rawLyrics === "+") continue;
    flagged.push(note);
  }
  for (const note of flagged) {
    pushIssue(issues, note, {
      kind: "melodic_note_empty_phonemes",
      severity: "warning",
      confidence: "deterministic_rule",
      message: `lyric "${note.lyrics}" produced no phonemes at snapshot time; the host G2P may not recognize the token under the effective language.`,
      suggestion:
        "check the lyric/language with sv_align_lyrics or set an explicit phonemesOverride via sv_patch_notes, then verify with sv_wait_for_processing.",
    });
  }
  return {
    status: processing.state === "pending" ? "captured_pending" : "captured",
    processingState: processing.state,
    flaggedNotes: flagged.length,
    legitimatelyEmpty: (processing.phonemeCoverage.emptyNoteIndices ?? []).length - flagged.length,
  };
}

// ---------- 响应组装 ----------

function buildValidateResponse(loaded, input, issues, coverage, warnings, timings) {
  const counts = { error: 0, warning: 0, info: 0 };
  const byKind = Object.create(null);
  for (const issue of issues) {
    counts[issue.severity] += 1;
    byKind[issue.kind] = (byKind[issue.kind] ?? 0) + 1;
  }
  const cap = input.responseMode === "verbose" ? issues.length : MAX_ISSUE_ITEMS;
  if (issues.length > cap) {
    warnings.push({
      code: "ISSUES_TRUNCATED",
      message: `issues reports the first ${cap} of ${issues.length} findings (sorted by severity, then start time); use responseMode:"verbose" for the full list.`,
    });
  }
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
    checks: [...input.checks],
    summary: {
      issueCount: issues.length,
      bySeverity: counts,
      byKind,
      clean: issues.length === 0,
    },
    ...(input.responseMode === "compact" ? {} : { issues: issues.slice(0, cap), issuesTruncated: issues.length > cap }),
    coverage,
    provenance: PROVENANCE,
    warnings,
    timings,
  };
}

// ---------- 请求校验 ----------

function normalizeValidateRequest(request) {
  if (!isRecord(request)) throw codedError("INVALID_ARGUMENTS", "request must be an object");
  assertKnownKeys(request, ["contextId", "occurrenceId", "checks", "responseMode"], "request");
  if (typeof request.contextId !== "string" || request.contextId.length === 0) {
    throw codedError("INVALID_ARGUMENTS", "contextId must be a non-empty string");
  }
  if (
    request.occurrenceId !== undefined &&
    (typeof request.occurrenceId !== "string" || request.occurrenceId.length === 0)
  ) {
    throw codedError("INVALID_ARGUMENTS", "occurrenceId must be a non-empty string when provided");
  }
  let checks;
  if (request.checks === undefined) {
    checks = new Set(PROSODY_CHECKS);
  } else {
    if (
      !Array.isArray(request.checks) ||
      request.checks.length === 0 ||
      !request.checks.every((item) => PROSODY_CHECKS.includes(item))
    ) {
      throw codedError(
        "INVALID_ARGUMENTS",
        `checks must be a non-empty array from ${PROSODY_CHECKS.join(", ")}`
      );
    }
    checks = new Set(request.checks);
  }
  const responseMode = request.responseMode ?? "standard";
  if (!["compact", "standard", "verbose"].includes(responseMode)) {
    throw codedError("INVALID_ARGUMENTS", "responseMode must be compact, standard, or verbose");
  }
  return {
    contextId: request.contextId,
    occurrenceId: request.occurrenceId,
    checks,
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
