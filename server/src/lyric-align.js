import { canonicalHashHex } from "./canonical-json.js";
import { artifactReference, planReference } from "./artifact-store.js";
import { buildPlanArtifact } from "./plan-reference.js";

import { ServiceTiming } from "./service-timing.js";
import { MAX_PATCHES } from "./note-patch.js";
import { buildApplyEnvelope } from "./plan-envelope.js";
import {
  analyzeVocalEventSequence,
  classifyVocalEvent,
} from "./vocal-event-semantics.js";
import { selectOccurrenceByOrdinal } from "./scope-source.js";
import { unknownContextError } from "./snapshot.js";

// sv_align_lyrics：无副作用咬字/铺词规划器（HANDOFF §7 P2 定位）。
//
// 关键契约：
// - 纯内存只读：只读取 range context 的音符指纹，不进 ExecutionCoordinator、绝不写宿主，
//   也绝不通过临时写工程来"试算"音素。真正落地由调用方把 apply 交给现有
//   sv_patch_notes（expected.lyrics 前置条件防快照后漂移，冲突检查/Undo/读回全部复用）。
// - 分档诚实置信：日语假名 mora 切分是确定性规则（一假名一拍；拗音/小假名并入前拍；
//   促音/拨音/长音各占一拍）；英语音节数是元音簇启发式（文献准确率 ~85-90%，只影响
//   "+" 续拍数量）；汉字读音不可知（无 G2P），mora/音节数未知，按 1 音符规划并标
//   needs_review；不承诺与宿主内部 G2P 一致。
// - 精确拼写的 "+"（下一音节）/"-"（延音）/"br"（换气）及前缀 "'"（插入 cl）来自
//   Synthesizer V Studio 2 官方文档；近似拼写保持词面原样并发出警告。
export const ALIGN_LANGUAGES = Object.freeze([
  "auto",
  "japanese",
  "english",
  "mandarin",
  "cantonese",
]);

const PROVENANCE = Object.freeze({
  planner: "deterministic_lyric_tokenizer",
  japaneseKana: "deterministic_mora_rules",
  englishSyllables: "heuristic_vowel_groups_85_90_percent_literature_range",
  kanjiReading: "unknown_no_g2p_available",
  plusMinusBreath: "official_documented_exact_ascii_special_lyrics",
  apostrophePrefix: "official_documented_prefix_inserts_cl_phoneme",
  standaloneApostrophe: "not_documented_requires_human_review",
  g2pParity: "not_guaranteed",
  perception: "human_only",
});

// 小假名（并入前一 mora）：拗音 ゃゅょ、外来语小元音 ぁぃぅぇぉ、小ゎ 及片假名对应。
const SMALL_KANA = new Set([..."ぁぃぅぇぉゃゅょゎァィゥェォャュョヮ"]);
// 独立成拍的特殊拍：促音、拨音、长音（唱歌中各占一个音符/拍）。
const STANDALONE_KANA = new Set([..."っンんッー"]);
const MAX_CONTINUATION_IDENTITIES = 256;
const STANDARD_ALIGNMENT_ITEMS = 50;

export class LyricAlignService {
  constructor({ store, now = () => Date.now(), artifactStore = null, sessionId = null } = {}) {
    if (!store) throw new Error("LyricAlignService requires the shared SnapshotStore");
    this.store = store;
    this.now = now;
    this.artifactStore = artifactStore;
    this.sessionId = sessionId;
    this.continuationIdentities = new Map();
  }

  async align(request = {}) {
    const timer = new ServiceTiming({
      now: this.now,
      phaseNames: ["loadMs", "tokenizeMs", "mapMs"],
    });
    const input = normalizeAlignRequest(request);
    // 纯内存服务：不进入协调器；coordinatorQueueMs/operationMs 恒 0，如实报告。
    timer.requestCoordinator();
    const warnings = [];
    pruneContinuationIdentities(this.continuationIdentities, this.now());
    const loaded = await timer.measure("loadMs", async () =>
      resolveAlignSource(this.store, input, warnings, this.continuationIdentities)
    );
    const tokens = await timer.measure("tokenizeMs", async () =>
      tokenizeLyrics(input.lyrics, input.language, warnings)
    );
    const mapped = await timer.measure("mapMs", async () =>
      mapUnitsToNotes(tokens, loaded, input, warnings)
    );
    const response = buildAlignResponse(loaded, input, tokens, mapped, warnings, timer.finish(), {
      artifactStore: this.artifactStore,
      sessionId: this.sessionId,
    });
    if (response.continuation) {
      rememberContinuationIdentity(this.continuationIdentities, loaded, input, this.now());
    }
    return response;
  }
}

// ---------- 上下文解析（纯数据，与 plan/compare 同模式） ----------

// 续跑身份使用轨道/引用位置与目标 UUID；对外 occurrence 仍是当前 Context 的 ordinal。
// 位置后缀只负责寻找候选；必须再通过服务签发的短期记录校验 target UUID 与音符结构。
function resolveAlignSource(store, input, warnings, continuationIdentities) {
  const stored = store.get(input.contextId);
  if (!stored) {
    throw unknownContextError(store, input.contextId);
  }
  if (stored.context?.kind !== "range") {
    throw codedError(
      "INVALID_CONTEXT",
      'sv_align_lyrics needs a range context from sv_snapshot_range with include ["notes"]'
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
        'sv_align_lyrics needs note fingerprints; re-run sv_snapshot_range with include ["notes"]',
      ambiguousMessage:
        "range context has multiple occurrences with notes; pass one occurrence ordinal",
      ineligibleCode: "OCCURRENCE_NOT_CAPTURED",
      ineligibleMessage:
        'the selected occurrence has no note fingerprints; re-run sv_snapshot_range with include ["notes"]',
    }
  );
  let reanchoredIdentity = null;
  const identity = continuationIdentities.get(
    continuationIdentityKey(occurrence, input.startNote)
  );
  if (identity && identity.contextId !== stored.contextId) {
    if (occurrence.targetGroupUuid !== identity.targetGroupUuid) {
      const error = codedError(
        "STALE_CONTEXT",
        `continuation target changed: expected group UUID ${identity.targetGroupUuid}, observed ${occurrence.targetGroupUuid}; re-snapshot and re-plan`
      );
      error.expectedGroupUuid = identity.targetGroupUuid;
      error.observedGroupUuid = occurrence.targetGroupUuid;
      throw error;
    }
    const observedStructureDigest = noteStructureDigest(
      occurrence.noteFingerprints,
      identity.startNoteIndexInGroup
    );
    if (observedStructureDigest !== identity.noteStructureDigest) {
      const error = codedError(
        "STALE_CONTEXT",
        "continuation start note or following note-structure fingerprint changed; re-snapshot and re-plan"
      );
      error.expectedStructureDigest = identity.noteStructureDigest;
      error.observedStructureDigest = observedStructureDigest;
      throw error;
    }
    reanchoredIdentity = identity;
    warnings.push({
      code: "CONTINUATION_IDENTITY_VERIFIED",
      message: `Continuation target was re-captured at occurrence ${ordinal}; target identity and note structure still match.`,
    });
  }
  const notes = [...(occurrence.noteFingerprints ?? [])]
    .map((fingerprint) => ({
      indexInGroup: fingerprint.indexInGroup,
      onsetBlick: fingerprint.onsetBlick,
      durationBlick: fingerprint.durationBlick,
      lyrics: fingerprint.lyrics,
      languageOverride: fingerprint.languageOverride ?? "",
    }))
    .sort((left, right) => left.onsetBlick - right.onsetBlick);
  if (notes.length === 0) {
    throw codedError(
      "NOTES_NOT_CAPTURED",
      'the selected occurrence has no note fingerprints; re-run sv_snapshot_range with include ["notes"]'
    );
  }
  let startIndex = 0;
  if (input.startNote !== undefined) {
    startIndex = notes.findIndex((note) => note.indexInGroup === input.startNote);
    if (startIndex < 0 && reanchoredIdentity) {
      startIndex = notes.findIndex(
        (note) => note.indexInGroup === reanchoredIdentity.startNoteIndexInGroup
      );
    }
    if (startIndex < 0) {
      const groupNoteCount = occurrence.groupNoteCount ?? notes.length;
      if (input.startNote >= groupNoteCount) {
        throw codedError(
          "NOTE_INDEX_OUT_OF_RANGE",
          `startNote ${input.startNote} is outside the note group`,
          { got: input.startNote, max: groupNoteCount - 1 }
        );
      }
      throw codedError(
        "NOTE_NOT_IN_CONTEXT",
        `startNote ${input.startNote} exists but was not captured in this occurrence`,
        { got: input.startNote }
      );
    }
  } else if (reanchoredIdentity) {
    startIndex = notes.findIndex(
      (note) => note.indexInGroup === reanchoredIdentity.startNoteIndexInGroup
    );
    if (startIndex < 0) {
      throw codedError("STALE_CONTEXT", "continuation start note no longer exists; re-snapshot and re-plan");
    }
  }
  return { stored, occurrence, occurrenceOrdinal: ordinal, notes, startIndex };
}

function continuationIdentityKey(occurrence, startNote) {
  return JSON.stringify([
    occurrence?.trackIndex ?? null,
    occurrence?.groupIndex ?? null,
    startNote ?? null,
  ]);
}

function pruneContinuationIdentities(identities, now) {
  for (const [key, identity] of identities) {
    if (identity.expiresAt <= now) identities.delete(key);
  }
}

function rememberContinuationIdentity(identities, loaded, input, now) {
  if (typeof loaded.occurrence.targetGroupUuid !== "string") return;
  const startNote = loaded.notes[loaded.startIndex];
  const expiresAt = loaded.stored.expiresAt;
  if (!startNote || !Number.isFinite(expiresAt) || expiresAt <= now) return;
  const key = continuationIdentityKey(loaded.occurrence, input.startNote);
  identities.delete(key);
  identities.set(key, {
    targetGroupUuid: loaded.occurrence.targetGroupUuid,
    startNoteIndexInGroup: startNote.indexInGroup,
    noteStructureDigest: noteStructureDigest(
      loaded.occurrence.noteFingerprints,
      startNote.indexInGroup
    ),
    contextId: loaded.stored.contextId,
    expiresAt,
  });
  while (identities.size > MAX_CONTINUATION_IDENTITIES) {
    identities.delete(identities.keys().next().value);
  }
}

function noteStructureDigest(noteFingerprints, startNoteIndexInGroup) {
  const structure = [...(noteFingerprints ?? [])]
    .filter((note) => note.indexInGroup >= startNoteIndexInGroup)
    .sort((left, right) => left.indexInGroup - right.indexInGroup)
    .map((note) => ({
      indexInGroup: note.indexInGroup,
      onsetBlick: note.onsetBlick,
      durationBlick: note.durationBlick,
      pitch: note.pitch,
      detuneCents: note.detuneCents,
    }));
  return canonicalHashHex(structure);
}

// ---------- 分词（按字符类别分段；确定性） ----------

function tokenizeLyrics(text, language, warnings) {
  const runs = splitRuns(text);
  const hasKana = runs.some((run) => run.kind === "kana");
  const tokens = [];
  let skippedCharacters = 0;
  for (let runIndex = 0; runIndex < runs.length; runIndex += 1) {
    const run = runs[runIndex];
    if (run.kind === "separator") continue;
    const nextRun = runs[runIndex + 1];
    if (run.kind === "latin" && run.text === "'" && nextRun?.kind === "kana") {
      appendKanaTokens(tokens, nextRun.text, language, warnings, "'");
      runIndex += 1;
      continue;
    }
    if (run.kind === "latin") {
      for (const word of run.text.split(/[^A-Za-z'+-]+/).filter(Boolean)) {
        if (word === "br") {
          tokens.push({ kind: "breath", text: "br", language: null, confidence: "deterministic_rule" });
        } else if (word === "+" || word === "-") {
          tokens.push({
            kind: "continuation",
            text: word,
            language: null,
            confidence: "deterministic_rule",
          });
        } else {
          const effectiveLanguage = language === "auto" ? "english" : language;
          if (effectiveLanguage === "english") {
            tokens.push({
              kind: "word",
              text: word,
              language: "english",
              syllables: countEnglishSyllables(word),
              confidence: "heuristic_estimate",
            });
          } else {
            // 非英语语境下的拉丁词（如罗马音）：不做音节推断，按 1 音符规划并要求复核。
            tokens.push({
              kind: "word",
              text: word,
              language: effectiveLanguage,
              syllables: 1,
              confidence: "needs_review",
              needsReview: true,
            });
          }
        }
      }
    } else if (run.kind === "kana") {
      appendKanaTokens(tokens, run.text, language, warnings);
    } else if (run.kind === "cjk") {
      for (const character of [...run.text]) {
        if (language === "mandarin" || language === "cantonese") {
          // 官方语义：一字一音节一音符。
          tokens.push({ kind: "syllable", text: character, language, confidence: "deterministic_rule" });
        } else if (language === "japanese" || (language === "auto" && hasKana)) {
          // 汉字读音（音节/mora 数）不可知：按 1 音符规划并要求复核。
          tokens.push({
            kind: "kanji",
            text: character,
            language: "japanese",
            confidence: "needs_review",
            needsReview: true,
          });
          appendOnce(warnings, {
            code: "KANJI_MORA_UNKNOWN",
            message:
              "kanji readings are not available (no G2P); each kanji is planned as one note and flagged needs_review — split it into kana first for exact mora alignment.",
          });
        } else {
          tokens.push({
            kind: "syllable",
            text: character,
            language: null,
            confidence: "needs_review",
            needsReview: true,
          });
          appendOnce(warnings, {
            code: "LANGUAGE_AMBIGUOUS",
            message:
              'CJK ideographs without surrounding kana are ambiguous between Japanese and Chinese; pass language:"japanese"/"mandarin"/"cantonese" explicitly.',
          });
        }
      }
    } else {
      skippedCharacters += [...run.text].length;
    }
  }
  if (skippedCharacters > 0) {
    appendOnce(warnings, {
      code: "UNSUPPORTED_CHARACTERS_SKIPPED",
      message: `${skippedCharacters} character(s) outside kana/CJK/latin were skipped during tokenization.`,
    });
  }
  if (tokens.length === 0) {
    throw codedError("EMPTY_LYRICS", "lyrics contained no alignable tokens");
  }
  return tokens.map((token, index) => {
    const semantics = classifyVocalEvent({ lyrics: token.text });
    for (const warning of semantics.warnings) {
      appendOnce(warnings, { ...warning, tokenIndex: index, lyrics: token.text });
    }
    const needsReview = token.needsReview || semantics.role === "unknown_special";
    return {
      ...token,
      index,
      semanticRole: semantics.role,
      semanticEvidence: semantics.evidenceCode,
      ...(needsReview
        ? {
            needsReview: true,
            ...(semantics.role === "unknown_special" ? { confidence: "needs_review" } : {}),
          }
        : {}),
    };
  });
}

function appendKanaTokens(tokens, text, language, warnings, firstMoraPrefix = "") {
  if (language !== "auto" && language !== "japanese") {
    appendOnce(warnings, {
      code: "KANA_FORCED_JAPANESE",
      message: "kana characters are always tokenized as Japanese morae regardless of the requested language.",
    });
  }
  const morae = splitKanaMorae(text);
  for (let index = 0; index < morae.length; index += 1) {
    tokens.push({
      kind: "mora",
      text: `${index === 0 ? firstMoraPrefix : ""}${morae[index]}`,
      language: "japanese",
      confidence: "deterministic_rule",
    });
  }
}

function splitRuns(text) {
  const runs = [];
  for (const character of [...text]) {
    const kind = classifyCharacter(character);
    const previous = runs[runs.length - 1];
    if (previous && previous.kind === kind) previous.text += character;
    else runs.push({ kind, text: character });
  }
  return runs;
}

// 字符分类（kana/cjk/latin/separator/other）：lyric-prosody 复用（导出），两侧语言判定同源。
export function classifyCharacter(character) {
  const code = character.codePointAt(0);
  if (/\s/.test(character)) return "separator";
  if ((code >= 0x3040 && code <= 0x309f) || (code >= 0x30a0 && code <= 0x30ff)) return "kana";
  if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf)) return "cjk";
  if (/[A-Za-z'+-]/.test(character)) return "latin";
  if (/[、。，．,.!?！？「」()（）:;：；·…]/.test(character)) return "separator";
  return "other";
}

// 日语 mora 切分（确定性）：一假名一拍；小假名并入前拍；っ/ん/ー 独立成拍。
export function splitKanaMorae(text) {
  const morae = [];
  for (const character of [...text]) {
    if (SMALL_KANA.has(character) && morae.length > 0 && !STANDALONE_KANA.has(morae[morae.length - 1])) {
      morae[morae.length - 1] += character;
    } else {
      morae.push(character);
    }
  }
  return morae;
}

// 英语音节计数（元音簇启发式，文献准确率 ~85-90%；只影响 "+" 续拍数量）。
export function countEnglishSyllables(word) {
  const cleaned = word.toLowerCase().replace(/[^a-z]/g, "");
  if (cleaned.length === 0) return 1;
  const groups = cleaned.match(/[aeiouy]+/g);
  let count = groups ? groups.length : 1;
  if (
    count > 1 &&
    cleaned.length > 2 &&
    cleaned.endsWith("e") &&
    !cleaned.endsWith("le") &&
    !/[aeiouy]/.test(cleaned[cleaned.length - 2])
  ) {
    count -= 1;
  }
  return Math.max(1, count);
}

// ---------- 铺排 ----------

function mapUnitsToNotes(tokens, loaded, input, warnings) {
  // 紧随词头的显式 +/- 链代表调用方已经完成铺排，不能再叠加启发式 "+"。
  const units = [];
  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
    const token = tokens[tokenIndex];
    units.push(createLyricUnit(token, token.text, token.kind === "word" ? "word" : token.kind));
    const nextRole = tokens[tokenIndex + 1]?.semanticRole;
    const hasExplicitContinuation =
      nextRole === "syllable_continuation" || nextRole === "phonation_continuation";
    if (token.kind === "word" && !hasExplicitContinuation) {
      for (let extra = 1; extra < token.syllables; extra += 1) {
        units.push(createLyricUnit(token, "+", "continuation"));
      }
    }
  }
  const available = loaded.notes.length - loaded.startIndex;
  const assignedCount = Math.min(units.length, available);
  const perNote = [];
  for (let index = 0; index < assignedCount; index += 1) {
    const note = loaded.notes[loaded.startIndex + index];
    const unit = units[index];
    const plannedLyrics = unit.token.kind === "breath" ? "br" : unit.text;
    // breath 与续拍不设 languageOverride；其余按 token 语言（仅当确定）设置。
    const plannedLanguage =
      input.setLanguageOverride &&
      (unit.semanticRole === "lexical_head" || unit.semanticRole === "glottal_onset") &&
      typeof unit.token.language === "string"
        ? unit.token.language
        : null;
    perNote.push({
      indexInGroup: note.indexInGroup,
      currentLyrics: note.lyrics,
      plannedLyrics,
      unit: {
        tokenIndex: unit.token.index,
        role: unit.role,
        semanticRole: unit.semanticRole,
        semanticEvidence: unit.semanticEvidence,
        ...(unit.token.kind === "word" ? { word: unit.token.text, syllables: unit.token.syllables } : {}),
      },
      languageOverride: {
        current: note.languageOverride,
        planned: plannedLanguage ?? note.languageOverride,
      },
      confidence: unit.token.confidence,
      ...(unit.token.needsReview ? { needsReview: true } : {}),
      changed:
        plannedLyrics !== note.lyrics ||
        (plannedLanguage !== null && plannedLanguage !== note.languageOverride),
    });
  }
  const sequence = analyzeVocalEventSequence(
    perNote.map((item, index) => {
      const note = loaded.notes[loaded.startIndex + index];
      return {
        indexInGroup: item.indexInGroup,
        onsetBlick: note.onsetBlick,
        durationBlick: note.durationBlick,
        lyrics: item.plannedLyrics,
      };
    })
  );
  // 关联走对象身份：共享语义模块原样回传本模块传入的 note 对象。
  const eventsByIndex = new Map(
    sequence.events.map((event) => [event.note.indexInGroup, event])
  );
  const reviewNoteIndexes = new Set(
    sequence.issues.flatMap((issue) => (issue.notes ?? []).map((note) => note.indexInGroup))
  );
  for (const item of perNote) {
    const event = eventsByIndex.get(item.indexInGroup);
    if (!event) continue;
    item.unit.semanticRole = event.semanticRole;
    item.unit.semanticEvidence = event.semanticEvidence;
    // 对外身份是组内 index（§3.1）。
    item.unit.chainHeadNote = event.chainHeadNote?.indexInGroup ?? null;
    item.unit.syllableOrdinal = event.syllableOrdinal;
    item.unit.continuationValid = event.continuationValid;
    if (reviewNoteIndexes.has(item.indexInGroup)) item.needsReview = true;
  }
  for (const issue of sequence.issues) appendOnce(warnings, issue);
  const unassignedUnits = units.slice(assignedCount).map((unit) => ({
    tokenIndex: unit.token.index,
    text: unit.text,
    role: unit.role,
    semanticRole: unit.semanticRole,
    semanticEvidence: unit.semanticEvidence,
  }));
  if (unassignedUnits.length > 0) {
    warnings.push({
      code: "NOT_ENOUGH_NOTES",
      message: `${unassignedUnits.length} lyric unit(s) have no note to land on; extend the range, pick an earlier startNote, or add notes with sv_restructure_notes first.`,
    });
  }
  const unfilledNotes = loaded.notes.slice(loaded.startIndex + assignedCount).map((note) => ({
    note: note.indexInGroup,
    currentLyrics: note.lyrics,
  }));
  if (unfilledNotes.length > 0) {
    warnings.push({
      code: "NOTES_LEFT_UNTOUCHED",
      message: `${unfilledNotes.length} trailing note(s) received no lyric unit and keep their current lyrics; use "-" melisma or delete them if unwanted.`,
    });
  }
  return { units, perNote, unassignedUnits, unfilledNotes, assignedCount };
}

function createLyricUnit(token, text, role) {
  const semantics = classifyVocalEvent({ lyrics: text });
  return {
    token,
    text,
    role,
    semanticRole: semantics.role,
    semanticEvidence: semantics.evidenceCode,
  };
}

// ---------- 响应组装 ----------

function buildAlignResponse(
  loaded,
  input,
  tokens,
  mapped,
  warnings,
  timings,
  { artifactStore, sessionId } = {}
) {
  const changed = mapped.perNote.filter((item) => item.changed);
  const patches = changed.map((item) => ({
    // sv_patch_notes 的身份是组内 index（§3.1）。
    note: item.indexInGroup,
    // expected 前置条件：快照后的并发漂移在 apply 阶段被 sv_patch_notes 冲突检查捕获。
    expected: { lyrics: item.currentLyrics },
    set: {
      lyrics: item.plannedLyrics,
      ...(item.languageOverride.planned !== item.languageOverride.current
        ? { languageOverride: item.languageOverride.planned }
        : {}),
    },
  }));
  // note-patch 硬上限 MAX_PATCHES。超限时不能预生成后续批次：sv_patch_notes 提交成功即删除
  // contextId（成功写入使快照上下文失效）——预烤的第二批必然
  // UNKNOWN_CONTEXT，还会留下"前 200 项已改、其余未改"的中间态。诚实契约是：只交出当前
  // context 下可提交的第一批，其余通过 continuation 工作流收敛——提交后重拍快照、用完全相同
  // 的参数重跑本工具，已应用的音符自动变为 no-change，下一轮恰好规划剩余部分。
  const submittable = patches.slice(0, MAX_PATCHES);
  const remainingChangedCount = patches.length - submittable.length;
  const patchRequest =
    submittable.length > 0
      ? {
          tool: "sv_patch_notes",
          arguments: {
            contextId: loaded.stored.contextId,
            occurrence: loaded.occurrenceOrdinal,
            patches: submittable,
            action: "dry_run",
            atomic: true,
          },
        }
      : null;
  const continuation =
    remainingChangedCount > 0
      ? {
          reason: "PATCH_CAP",
          patchCapPerCall: MAX_PATCHES,
          remainingChangedCount,
          workflow: [
            "Submit apply.arguments with action dry_run, then commit.",
            "A successful commit invalidates this contextId, so re-run sv_snapshot_range over the same range for a fresh context.",
            "Re-run sv_align_lyrics with the same lyrics and options against the fresh contextId and its current occurrence ordinal: already-applied notes come back unchanged, so the next round plans exactly the remaining patches. The short-lived continuation identity verifies the target UUID and note structure before planning the next slice.",
            "Repeat until the response carries no continuation (or reports status no_change).",
          ],
        }
      : null;
  if (continuation) {
    warnings.push({
      code: "PLAN_EXCEEDS_PATCH_CAP",
      message: `${patches.length} note patches exceed the ${MAX_PATCHES}-patch per-call cap; apply carries the first ${submittable.length} and ${remainingChangedCount} remain. Follow-up batches cannot be pre-generated (a successful sv_patch_notes invalidates the contextId) — follow continuation.workflow: commit, re-snapshot, re-align, repeat. Each round is its own transaction and Undo record.`,
    });
  }
  const planId = `lyr_${canonicalHashHex({
    occurrence: loaded.occurrenceOrdinal,
    patches,
    perNote: mapped.perNote.map((item) => [item.indexInGroup, item.plannedLyrics]),
  }).slice(0, 16)}`;
  const needsReviewCount = mapped.perNote.filter((item) => item.needsReview).length;
  const semanticRoles = { total: mapped.units.length, byRole: {} };
  for (const unit of mapped.units) {
    semanticRoles.byRole[unit.semanticRole] =
      (semanticRoles.byRole[unit.semanticRole] ?? 0) + 1;
  }
  // 共享 target 的写入会同时改变所有 occurrence；规划阶段就如实声明，不留给提交时才发现。
  const requiresSharedTargetConfirmation =
    (loaded.occurrence.sharedTargetOccurrences ?? []).length > 1;
  const checklist = [
    "Review plannedLyrics per note; heuristic English syllable counts only affect the number of '+' continuation notes.",
    "Apply through the returned apply envelope with action dry_run first, then commit; expected.lyrics guards against post-snapshot drift.",
    "Phoneme output is decided by the host G2P after the write; verify with sv_wait_for_processing (this planner does not guarantee G2P parity).",
  ];
  if (needsReviewCount > 0) {
    checklist.push(
      `${needsReviewCount} note(s) are flagged needs_review (kanji or ambiguous-language tokens); confirm their reading/segmentation manually.`
    );
  }
  if (requiresSharedTargetConfirmation) {
    checklist.push(
      "The target NoteGroup is shared by multiple occurrences: committing changes every one of them and requires allowSharedTargetMutation:true."
    );
  }
  if (continuation) {
    checklist.push(
      `${remainingChangedCount} change(s) do not fit this call (${MAX_PATCHES}-patch cap): after committing, re-snapshot the same range and re-run sv_align_lyrics with identical arguments — each round applies the next slice and the loop converges to no_change.`
    );
  }
  let planRef = null;
  let planExpiresAt = null;
  if (artifactStore && sessionId && patchRequest) {
    try {
      const { payload } = buildPlanArtifact({
        targetTool: "sv_patch_notes",
        mutationRequest: patchRequest.arguments,
        targetGroupUuid: loaded.occurrence.targetGroupUuid,
        occurrence: loaded.occurrenceOrdinal,
        capsule: {
          stored: loaded.stored,
          occurrence: loaded.occurrence,
          // capsule 只封存被这批 patch 触及的音符；身份是组内 index（§3.1）。
          noteIndexes: submittable.map((patch) => patch.note),
        },
      });
      const planArtifact = artifactStore.seal({
        kind: "plan",
        schemaVersion: "1",
        sessionId,
        sourceEpoch: loaded.stored.epoch,
        payload,
      });
      planRef = planReference(planArtifact);
      planExpiresAt = planArtifact.expiresAt;
    } catch (error) {
      warnings.push({
        code: "ARTIFACT_SEAL_FAILED",
        message: `Failed to seal lyric alignment plan artifact: ${error.message}`,
      });
    }
  }
  let alignmentDetailRef = null;
  const hasAlignmentDetails =
    mapped.unassignedUnits.length > 0 || mapped.unfilledNotes.length > 0;
  if (hasAlignmentDetails && artifactStore && sessionId) {
    try {
      alignmentDetailRef = artifactReference(
        artifactStore.seal({
          kind: "planner-detail",
          schemaVersion: "1",
          sessionId,
          sourceEpoch: loaded.stored.epoch,
          payload: {
            planner: "sv_align_lyrics",
            planId,
            alignment: {
              unassignedUnits: mapped.unassignedUnits,
              unfilledNotes: mapped.unfilledNotes,
            },
          },
        })
      );
    } catch (error) {
      warnings.push({
        code: "ARTIFACT_SEAL_FAILED",
        message: `Failed to seal lyric alignment detail artifact: ${error.message}`,
      });
    }
  }
  const apply = buildApplyEnvelope(patchRequest ? [patchRequest] : null, {
    sharedTargetConfirmationRequired: requiresSharedTargetConfirmation,
  });
  if (planRef && apply?.arguments) {
    apply.arguments = { planRef, action: "dry_run" };
    // 租期是关于这次交接的事实，挂在信封上；planRef 只承载身份（§4.3）。
    apply.expiresAt = planExpiresAt;
  }

  return {
    ok: true,
    status: patchRequest ? "planned" : "no_change",
    effects: "none",
    planId,
    contextId: loaded.stored.contextId,
    occurrence: {
      occurrence: loaded.occurrenceOrdinal,
      trackIndex: loaded.occurrence.trackIndex,
      groupIndex: loaded.occurrence.groupIndex,
      targetGroupUuid: loaded.occurrence.targetGroupUuid,
    },
    summary: {
      tokenCount: tokens.length,
      unitCount: mapped.units.length,
      noteCount: loaded.notes.length,
      startIndex: loaded.startIndex,
      assignedCount: mapped.assignedCount,
      changedCount: changed.length,
      needsReviewCount,
      semanticRoles,
      complete: mapped.unassignedUnits.length === 0,
    },
    tokens: tokens.map((token) => ({
      index: token.index,
      text: token.text,
      kind: token.kind,
      language: token.language,
      semanticRole: token.semanticRole,
      semanticEvidence: token.semanticEvidence,
      ...(token.syllables !== undefined ? { syllables: token.syllables } : {}),
      confidence: token.confidence,
      ...(token.needsReview ? { needsReview: true } : {}),
    })),
    perNote: mapped.perNote,
    alignment: formatAlignment(mapped, alignmentDetailRef),
    apply,
    ...(!planRef ? { patchRequest } : {}),
    ...(continuation ? { continuation } : {}),
    review: { requiresHumanReview: needsReviewCount > 0, requiresSharedTargetConfirmation, checklist },
    provenance: PROVENANCE,
    warnings,
    timings,
  };
}

// ---------- 请求校验 ----------

function normalizeAlignRequest(request) {
  if (!isRecord(request)) throw codedError("INVALID_ARGUMENTS", "request must be an object");
  assertKnownKeys(
    request,
    [
      "contextId",
      "occurrence",
      "lyrics",
      "language",
      "startNote",
      "setLanguageOverride",
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
    throw codedError("INVALID_ARGUMENTS", "occurrence must be a non-negative safe integer");
  }
  if (typeof request.lyrics !== "string" || request.lyrics.trim().length === 0) {
    throw codedError("INVALID_ARGUMENTS", "lyrics must be a non-empty string");
  }
  if (request.lyrics.length > 2000) {
    throw codedError("INVALID_ARGUMENTS", "lyrics must be at most 2000 characters");
  }
  const language = request.language ?? "auto";
  if (!ALIGN_LANGUAGES.includes(language)) {
    throw codedError("INVALID_ARGUMENTS", `language must be one of ${ALIGN_LANGUAGES.join(", ")}`);
  }
  if (
    request.startNote !== undefined &&
    (!Number.isSafeInteger(request.startNote) || request.startNote < 0)
  ) {
    throw codedError(
      "INVALID_ARGUMENTS",
      "startNote must be a non-negative note index when provided"
    );
  }
  if (
    request.setLanguageOverride !== undefined &&
    typeof request.setLanguageOverride !== "boolean"
  ) {
    throw codedError("INVALID_ARGUMENTS", "setLanguageOverride must be a boolean");
  }
  return {
    contextId: request.contextId,
    occurrence: request.occurrence,
    lyrics: request.lyrics,
    language,
    startNote: request.startNote,
    setLanguageOverride: request.setLanguageOverride ?? true,
  };
}

function formatAlignment(mapped, detailRef) {
  const unassignedCount = mapped.unassignedUnits.length;
  const unfilledCount = mapped.unfilledNotes.length;
  const summary = {
    unassignedCount,
    unfilledCount,
    ...(unassignedCount > 0
      ? {
          firstUnassignedUnit: mapped.unassignedUnits[0],
          lastUnassignedUnit: mapped.unassignedUnits.at(-1),
        }
      : {}),
    ...(unfilledCount > 0
      ? {
          firstUnfilledNote: mapped.unfilledNotes[0],
          lastUnfilledNote: mapped.unfilledNotes.at(-1),
        }
      : {}),
  };
  // 单一形状：定量截断的列表 + 溢出时指向完整明细的 detailRef（§10.6 规则 10/14）。
  const limit = STANDARD_ALIGNMENT_ITEMS;
  return {
    ...summary,
    unassignedUnits: mapped.unassignedUnits.slice(0, limit),
    unfilledNotes: mapped.unfilledNotes.slice(0, limit),
    unassignedTruncated: mapped.unassignedUnits.length > limit,
    unfilledTruncated: mapped.unfilledNotes.length > limit,
    ...(hasAlignmentOverflow(mapped, limit) && detailRef ? { detailRef } : {}),
  };
}

function hasAlignmentOverflow(mapped, limit) {
  return mapped.unassignedUnits.length > limit || mapped.unfilledNotes.length > limit;
}

// ---------- 小工具 ----------

function appendOnce(warnings, warning) {
  if (!warnings.some((item) => item.code === warning.code)) warnings.push(warning);
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
