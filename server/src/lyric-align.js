import { createHash } from "node:crypto";

import { ServiceTiming } from "./service-timing.js";
import { MAX_PATCHES } from "./note-patch.js";

// sv_align_lyrics：无副作用咬字/铺词规划器（HANDOFF §7 P2 定位）。
//
// 关键契约：
// - 纯内存只读：只读取 range context 的音符指纹，不进 ExecutionCoordinator、绝不写宿主，
//   也绝不通过临时写工程来"试算"音素。真正落地由调用方把 patchRequest 交给现有
//   sv_patch_notes（expected.lyrics 前置条件防快照后漂移，冲突检查/Undo/读回全部复用）。
// - 分档诚实置信：日语假名 mora 切分是确定性规则（一假名一拍；拗音/小假名并入前拍；
//   促音/拨音/长音各占一拍）；英语音节数是元音簇启发式（文献准确率 ~85-90%，只影响
//   "+" 续拍数量）；汉字读音不可知（无 G2P），mora/音节数未知，按 1 音符规划并标
//   needs_review；不承诺与宿主内部 G2P 一致。
// - "+"（下一音节）/"-"（延音）/"br"（换气）是宿主/社区约定，不是官方 API 文档事实，
//   provenance 中如实标注。
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
  plusMinusBreath: "host_convention_not_official_api_fact",
  g2pParity: "not_guaranteed",
  perception: "human_only",
});

// 小假名（并入前一 mora）：拗音 ゃゅょ、外来语小元音 ぁぃぅぇぉ、小ゎ 及片假名对应。
const SMALL_KANA = new Set([..."ぁぃぅぇぉゃゅょゎァィゥェォャュョヮ"]);
// 独立成拍的特殊拍：促音、拨音、长音（唱歌中各占一个音符/拍）。
const STANDALONE_KANA = new Set([..."っンんッー"]);
const MAX_CONTINUATION_IDENTITIES = 256;

export class LyricAlignService {
  constructor({ store, now = () => Date.now() } = {}) {
    if (!store) throw new Error("LyricAlignService requires the shared SnapshotStore");
    this.store = store;
    this.now = now;
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
    const response = buildAlignResponse(loaded, input, tokens, mapped, warnings, timer.finish());
    if (response.continuation) {
      rememberContinuationIdentity(this.continuationIdentities, loaded, input, this.now());
    }
    return response;
  }
}

// ---------- 上下文解析（纯数据，与 plan/compare 同模式） ----------

// occurrenceId = `${contextId}:t:${track}:r:${ref}`，noteId 再接 `:n:${index}`。
// 位置后缀只负责寻找候选；必须再通过服务签发的短期记录校验 target UUID 与音符结构。
const OCCURRENCE_POSITION_PATTERN = /:t:(\d+):r:(\d+)$/;

function resolveAlignSource(store, input, warnings, continuationIdentities) {
  const stored = store.get(input.contextId);
  if (!stored) {
    throw codedError("UNKNOWN_CONTEXT", "contextId not found or expired; re-run sv_snapshot_range");
  }
  if (stored.context?.kind !== "range") {
    throw codedError(
      "INVALID_CONTEXT",
      'sv_align_lyrics needs a range context from sv_snapshot_range with include ["notes"]'
    );
  }
  const occurrences = Array.isArray(stored.context.occurrences) ? stored.context.occurrences : [];
  const candidates = occurrences.filter(
    (item) => Array.isArray(item.noteFingerprints) && item.noteFingerprints.length > 0
  );
  const wantedId = selectorOccurrenceId(input);
  let occurrence = null;
  let reanchoredIdentity = null;
  if (wantedId !== undefined) {
    occurrence = occurrences.find((item) => item.occurrenceId === wantedId) ?? null;
    if (!occurrence) {
      const identity = continuationIdentities.get(
        continuationIdentityKey(wantedId, input.startNoteId)
      );
      const position = identity ? OCCURRENCE_POSITION_PATTERN.exec(wantedId) : null;
      if (position) {
        const matches = occurrences.filter((item) => {
          const own = OCCURRENCE_POSITION_PATTERN.exec(item.occurrenceId);
          return own !== null && own[1] === position[1] && own[2] === position[2];
        });
        if (matches.length === 1) {
          const candidate = matches[0];
          if (candidate.targetGroupUuid !== identity.targetGroupUuid) {
            const error = codedError(
              "STALE_CONTEXT",
              `continuation selector target changed: expected group UUID ${identity.targetGroupUuid}, observed ${candidate.targetGroupUuid}; re-snapshot and re-plan`
            );
            error.expectedGroupUuid = identity.targetGroupUuid;
            error.observedGroupUuid = candidate.targetGroupUuid;
            throw error;
          }
          const observedStructureDigest = noteStructureDigest(
            candidate.noteFingerprints,
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
          occurrence = candidate;
          reanchoredIdentity = identity;
          warnings.push({
            code: "STALE_SELECTOR_REANCHORED",
            message: `occurrenceId/startNoteId reference a consumed context; verified target identity and note structure, then re-anchored by position (track ${position[1]}, reference ${position[2]}) onto ${occurrence.occurrenceId}.`,
          });
        }
      }
    }
    if (!occurrence) {
      throw codedError("UNKNOWN_OCCURRENCE", "occurrenceId is not part of the supplied contextId");
    }
  } else if (candidates.length === 1) {
    occurrence = candidates[0];
  } else if (candidates.length === 0) {
    throw codedError(
      "NOTES_NOT_CAPTURED",
      'sv_align_lyrics needs note fingerprints; re-run sv_snapshot_range with include ["notes"]'
    );
  } else {
    const error = codedError(
      "AMBIGUOUS_CONTEXT",
      "range context has multiple occurrences with notes; provide occurrenceId or startNoteId"
    );
    error.candidateOccurrences = candidates.map((item) => item.occurrenceId);
    error.details = { candidateOccurrences: error.candidateOccurrences };
    throw error;
  }
  const notes = [...(occurrence.noteFingerprints ?? [])]
    .map((fingerprint) => ({
      noteId: fingerprint.noteId,
      indexInGroup: fingerprint.indexInGroup,
      onsetBlick: fingerprint.onsetBlick,
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
  if (input.startNoteId !== undefined) {
    startIndex = notes.findIndex((note) => note.noteId === input.startNoteId);
    if (startIndex < 0 && reanchoredIdentity) {
      startIndex = notes.findIndex(
        (note) => note.indexInGroup === reanchoredIdentity.startNoteIndexInGroup
      );
    }
    if (startIndex < 0) {
      throw codedError(
        "UNKNOWN_NOTE_ID",
        `startNoteId is not part of the resolved occurrence: ${input.startNoteId}`
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
  return { stored, occurrence, notes, startIndex };
}

function selectorOccurrenceId(input) {
  if (typeof input.occurrenceId === "string") return input.occurrenceId;
  if (typeof input.startNoteId !== "string") return undefined;
  const cut = input.startNoteId.lastIndexOf(":n:");
  return cut > 0 ? input.startNoteId.slice(0, cut) : undefined;
}

function continuationIdentityKey(occurrenceId, startNoteId) {
  return JSON.stringify([occurrenceId, startNoteId ?? null]);
}

function pruneContinuationIdentities(identities, now) {
  for (const [key, identity] of identities) {
    if (identity.expiresAt <= now) identities.delete(key);
  }
}

function rememberContinuationIdentity(identities, loaded, input, now) {
  const occurrenceId = selectorOccurrenceId(input);
  if (!occurrenceId || typeof loaded.occurrence.targetGroupUuid !== "string") return;
  const startNote = loaded.notes[loaded.startIndex];
  const expiresAt = loaded.stored.expiresAt;
  if (!startNote || !Number.isFinite(expiresAt) || expiresAt <= now) return;
  const key = continuationIdentityKey(occurrenceId, input.startNoteId);
  identities.delete(key);
  identities.set(key, {
    targetGroupUuid: loaded.occurrence.targetGroupUuid,
    startNoteIndexInGroup: startNote.indexInGroup,
    noteStructureDigest: noteStructureDigest(
      loaded.occurrence.noteFingerprints,
      startNote.indexInGroup
    ),
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
  return createHash("sha256").update(stableStringify(structure)).digest("hex");
}

// ---------- 分词（按字符类别分段；确定性） ----------

function tokenizeLyrics(text, language, warnings) {
  const runs = splitRuns(text);
  const hasKana = runs.some((run) => run.kind === "kana");
  const tokens = [];
  let skippedCharacters = 0;
  for (const run of runs) {
    if (run.kind === "separator") continue;
    if (run.kind === "latin") {
      for (const word of run.text.split(/[^A-Za-z'+-]+/).filter(Boolean)) {
        if (word.toLowerCase() === "br") {
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
      if (language !== "auto" && language !== "japanese") {
        appendOnce(warnings, {
          code: "KANA_FORCED_JAPANESE",
          message: "kana characters are always tokenized as Japanese morae regardless of the requested language.",
        });
      }
      for (const mora of splitKanaMorae(run.text)) {
        tokens.push({ kind: "mora", text: mora, language: "japanese", confidence: "deterministic_rule" });
      }
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
  return tokens.map((token, index) => ({ ...token, index }));
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

function classifyCharacter(character) {
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
  // token → 音符单元：英语多音节词 = 词 + (n-1) 个 "+"（SynthV 由词自动分配后续音节）。
  const units = [];
  for (const token of tokens) {
    units.push({ token, text: token.text, role: token.kind === "word" ? "word" : token.kind });
    if (token.kind === "word") {
      for (let extra = 1; extra < token.syllables; extra += 1) {
        units.push({ token, text: "+", role: "continuation" });
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
      unit.role !== "continuation" &&
      unit.token.kind !== "breath" &&
      typeof unit.token.language === "string"
        ? unit.token.language
        : null;
    perNote.push({
      noteId: note.noteId,
      indexInGroup: note.indexInGroup,
      currentLyrics: note.lyrics,
      plannedLyrics,
      unit: {
        tokenIndex: unit.token.index,
        role: unit.role,
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
  const unassignedUnits = units.slice(assignedCount).map((unit) => ({
    tokenIndex: unit.token.index,
    text: unit.text,
    role: unit.role,
  }));
  if (unassignedUnits.length > 0) {
    warnings.push({
      code: "NOT_ENOUGH_NOTES",
      message: `${unassignedUnits.length} lyric unit(s) have no note to land on; extend the range, pick an earlier startNoteId, or add notes with sv_restructure_notes first.`,
    });
  }
  const unfilledNotes = loaded.notes.slice(loaded.startIndex + assignedCount).map((note) => ({
    noteId: note.noteId,
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

// ---------- 响应组装 ----------

function buildAlignResponse(loaded, input, tokens, mapped, warnings, timings) {
  const changed = mapped.perNote.filter((item) => item.changed);
  const patches = changed.map((item) => ({
    noteId: item.noteId,
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
  // contextId（成功写入使快照上下文失效），而 noteId 内嵌 contextId——预烤的第二批必然
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
            patches: submittable,
            dryRun: true,
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
            "Commit the returned patchRequest (dryRun first, then dryRun:false).",
            "A successful commit invalidates this contextId, so re-run sv_snapshot_range over the same range for a fresh context.",
            "Re-run sv_align_lyrics with the same lyrics and options against the fresh contextId: already-applied notes come back unchanged, so the next round plans exactly the remaining patches. Explicit occurrenceId/startNoteId are re-anchored only when their short-lived continuation identity proves the same target UUID and unchanged note structure (warned as STALE_SELECTOR_REANCHORED); otherwise the replay is rejected.",
            "Repeat until the response carries no continuation (or reports status no_change).",
          ],
        }
      : null;
  if (continuation) {
    warnings.push({
      code: "PLAN_EXCEEDS_PATCH_CAP",
      message: `${patches.length} note patches exceed the ${MAX_PATCHES}-patch per-call cap; patchRequest carries the first ${submittable.length} and ${remainingChangedCount} remain. Follow-up batches cannot be pre-generated (a successful sv_patch_notes invalidates the contextId and noteIds embed it) — follow continuation.workflow: commit, re-snapshot, re-align, repeat. Each round is its own transaction and Undo record.`,
    });
  }
  const planId = `lyr_${createHash("sha256")
    .update(
      stableStringify({
        occurrenceId: loaded.occurrence.occurrenceId,
        patches,
        perNote: mapped.perNote.map((item) => [item.noteId, item.plannedLyrics]),
      })
    )
    .digest("hex")
    .slice(0, 16)}`;
  const needsReviewCount = mapped.perNote.filter((item) => item.needsReview).length;
  const checklist = [
    "Review plannedLyrics per note; heuristic English syllable counts only affect the number of '+' continuation notes.",
    "Apply through the returned patchRequest (sv_patch_notes) with dryRun:true first, then commit; expected.lyrics guards against post-snapshot drift.",
    "Phoneme output is decided by the host G2P after the write; verify with sv_wait_for_processing (this planner does not guarantee G2P parity).",
  ];
  if (needsReviewCount > 0) {
    checklist.push(
      `${needsReviewCount} note(s) are flagged needs_review (kanji or ambiguous-language tokens); confirm their reading/segmentation manually.`
    );
  }
  if (continuation) {
    checklist.push(
      `${remainingChangedCount} change(s) do not fit this call (${MAX_PATCHES}-patch cap): after committing, re-snapshot the same range and re-run sv_align_lyrics with identical arguments — each round applies the next slice and the loop converges to no_change.`
    );
  }
  return {
    ok: true,
    status: patchRequest ? "planned" : "no_change",
    dryRun: true,
    effects: "none",
    planId,
    contextId: loaded.stored.contextId,
    occurrence: {
      occurrenceId: loaded.occurrence.occurrenceId,
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
      complete: mapped.unassignedUnits.length === 0,
    },
    ...(input.responseMode === "compact"
      ? {}
      : {
          tokens: tokens.map((token) => ({
            index: token.index,
            text: token.text,
            kind: token.kind,
            language: token.language,
            ...(token.syllables !== undefined ? { syllables: token.syllables } : {}),
            confidence: token.confidence,
            ...(token.needsReview ? { needsReview: true } : {}),
          })),
          perNote: mapped.perNote,
        }),
    alignment: {
      unassignedUnits: mapped.unassignedUnits,
      unfilledNotes: mapped.unfilledNotes,
    },
    patchRequest,
    ...(continuation ? { continuation } : {}),
    review: { requiresHumanReview: needsReviewCount > 0, checklist },
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
    ["contextId", "occurrenceId", "lyrics", "language", "startNoteId", "setLanguageOverride", "responseMode"],
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
    request.startNoteId !== undefined &&
    (typeof request.startNoteId !== "string" || request.startNoteId.length === 0)
  ) {
    throw codedError("INVALID_ARGUMENTS", "startNoteId must be a non-empty string when provided");
  }
  if (
    request.setLanguageOverride !== undefined &&
    typeof request.setLanguageOverride !== "boolean"
  ) {
    throw codedError("INVALID_ARGUMENTS", "setLanguageOverride must be a boolean");
  }
  const responseMode = request.responseMode ?? "standard";
  if (!["compact", "standard", "verbose"].includes(responseMode)) {
    throw codedError("INVALID_ARGUMENTS", "responseMode must be compact, standard, or verbose");
  }
  return {
    contextId: request.contextId,
    occurrenceId: request.occurrenceId,
    lyrics: request.lyrics,
    language,
    startNoteId: request.startNoteId,
    setLanguageOverride: request.setLanguageOverride ?? true,
    responseMode,
  };
}

// ---------- 小工具 ----------

function appendOnce(warnings, warning) {
  if (!warnings.some((item) => item.code === warning.code)) warnings.push(warning);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
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
