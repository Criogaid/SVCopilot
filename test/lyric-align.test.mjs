import assert from "node:assert/strict";
import test from "node:test";

import {
  LyricAlignService,
  countEnglishSyllables,
  splitKanaMorae,
} from "../server/src/lyric-align.js";
import { SnapshotStore } from "../server/src/snapshot.js";

const Q = 705600000;

function createStore() {
  return new SnapshotStore({ now: () => 1000 });
}

function createStoredContext(store, options = {}) {
  const { notes = [], extraOccurrenceWithNotes = false } = options;
  const stored = store.create({
    epoch: 1,
    scope: { kind: "range" },
    observedAt: new Date(1000).toISOString(),
    context: { kind: "range", occurrences: [] },
  });
  const occurrenceId = `${stored.contextId}:t:0:r:0`;
  const noteFingerprints = notes.map((note, index) => ({
    indexInGroup: index,
    onsetBlick: note.onsetBlick,
    durationBlick: note.durationBlick,
    pitch: note.pitch ?? 60,
    lyrics: note.lyrics ?? "",
    phonemesOverride: "",
    languageOverride: note.languageOverride ?? "",
    detuneCents: 0,
    noteId: `${occurrenceId}:n:${index}`,
  }));
  stored.context.occurrences.push({
    occurrenceId,
    trackIndex: 0,
    groupIndex: 0,
    targetGroupUuid: "uuid-lyric-test",
    timeOffsetBlick: 0,
    pitchOffsetSemitone: 0,
    sharedTargetOccurrences: [occurrenceId],
    noteFingerprints,
  });
  if (extraOccurrenceWithNotes) {
    const secondId = `${stored.contextId}:t:0:r:1`;
    stored.context.occurrences.push({
      occurrenceId: secondId,
      trackIndex: 0,
      groupIndex: 1,
      targetGroupUuid: "uuid-lyric-test",
      timeOffsetBlick: 0,
      pitchOffsetSemitone: 0,
      sharedTargetOccurrences: [occurrenceId, secondId],
      noteFingerprints: noteFingerprints.map((fingerprint, index) => ({
        ...fingerprint,
        noteId: `${secondId}:n:${index}`,
      })),
    });
  }
  stored.context.quarterBlick = Q;
  stored.context.meterMarks = [{ position: 0, positionBlick: 0, numerator: 4, denominator: 4 }];
  stored.context.tempoMarks = [{ positionBlick: 0, positionSeconds: 0, bpm: 120 }];
  return { stored, occurrenceId };
}

function createService(store) {
  return new LyricAlignService({ store, now: () => 2000 });
}

function noteId(occurrenceId, index) {
  return `${occurrenceId}:n:${index}`;
}

function uniformNotes(lyricsList, options = {}) {
  return lyricsList.map((lyrics, index) => ({
    onsetBlick: index * Q,
    durationBlick: Q,
    lyrics,
    ...(options.languageOverrides ? { languageOverride: options.languageOverrides[index] } : {}),
  }));
}

// ---------- 分词单元测试（确定性规则黄金用例） ----------

test("splitKanaMorae applies mora rules deterministically", () => {
  assert.deepEqual(splitKanaMorae("あさひのきらめき"), ["あ", "さ", "ひ", "の", "き", "ら", "め", "き"]);
  assert.deepEqual(splitKanaMorae("とうきょう"), ["と", "う", "きょ", "う"]); // 拗音合并
  assert.deepEqual(splitKanaMorae("がっこう"), ["が", "っ", "こ", "う"]); // 促音独立
  assert.deepEqual(splitKanaMorae("きって"), ["き", "っ", "て"]);
  assert.deepEqual(splitKanaMorae("しんかんせん"), ["し", "ん", "か", "ん", "せ", "ん"]); // 拨音独立
  assert.deepEqual(splitKanaMorae("カー"), ["カ", "ー"]); // 长音独立
  assert.deepEqual(splitKanaMorae("ファイト"), ["ファ", "イ", "ト"]); // 外来语小元音合并
});

test("countEnglishSyllables follows the vowel-group heuristic", () => {
  assert.equal(countEnglishSyllables("see"), 1);
  assert.equal(countEnglishSyllables("when"), 1);
  assert.equal(countEnglishSyllables("i"), 1);
  assert.equal(countEnglishSyllables("beautiful"), 3);
  assert.equal(countEnglishSyllables("little"), 2); // 词尾 le 不减
  assert.equal(countEnglishSyllables("make"), 1); // silent e
});

// ---------- 黄金用例：§13.2/13.3 fixture 歌词 1:1 对齐 ----------

const FIXTURE_LYRICS = ["br", "when", "i", "see", "あ", "さ", "ひ", "の", "き", "ら", "め", "き"];
const FIXTURE_LANGUAGES = [
  "",
  "english",
  "english",
  "english",
  "japanese",
  "japanese",
  "japanese",
  "japanese",
  "japanese",
  "japanese",
  "japanese",
  "japanese",
];

test("fixture lyrics align 1:1 and an identical plan reports no_change", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, {
    notes: uniformNotes(FIXTURE_LYRICS, { languageOverrides: FIXTURE_LANGUAGES }),
  });
  const result = await createService(store).align({
    contextId: stored.contextId,
    lyrics: "br when i see あさひのきらめき",
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "no_change");
  assert.equal(result.patchRequest, null);
  assert.equal(result.summary.unitCount, 12);
  assert.equal(result.summary.assignedCount, 12);
  assert.equal(result.summary.changedCount, 0);
  assert.equal(result.summary.complete, true);
  assert.equal(result.summary.needsReviewCount, 0);
  assert.deepEqual(
    result.perNote.map((item) => item.plannedLyrics),
    FIXTURE_LYRICS
  );
  // 分档置信：假名 mora 确定性，英语音节启发式。
  const moraItems = result.perNote.slice(4);
  assert.ok(moraItems.every((item) => item.confidence === "deterministic_rule"));
  assert.equal(result.perNote[1].confidence, "heuristic_estimate");
  assert.equal(result.provenance.g2pParity, "not_guaranteed");
});

test("a single lyric change produces one guarded patch", async () => {
  const store = createStore();
  const { stored, occurrenceId } = createStoredContext(store, {
    notes: uniformNotes(FIXTURE_LYRICS, { languageOverrides: FIXTURE_LANGUAGES }),
  });
  const result = await createService(store).align({
    contextId: stored.contextId,
    lyrics: "br when i saw あさひのきらめき",
  });
  assert.equal(result.status, "planned");
  assert.equal(result.summary.changedCount, 1);
  const patches = result.patchRequest.arguments.patches;
  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0], {
    noteId: noteId(occurrenceId, 3),
    expected: { lyrics: "see" },
    set: { lyrics: "saw" },
  });
  assert.equal(result.patchRequest.tool, "sv_patch_notes");
  assert.equal(result.patchRequest.arguments.dryRun, true);
  assert.equal(result.patchRequest.arguments.atomic, true);
  assert.equal(result.patchRequest.arguments.contextId, stored.contextId);
});

test("multi-syllable English words expand into '+' continuations", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, { notes: uniformNotes(["a", "b", "c", "d"]) });
  const result = await createService(store).align({
    contextId: stored.contextId,
    lyrics: "beautiful day",
  });
  assert.deepEqual(
    result.perNote.map((item) => item.plannedLyrics),
    ["beautiful", "+", "+", "day"]
  );
  assert.deepEqual(
    result.perNote.map((item) => item.unit.role),
    ["word", "continuation", "continuation", "word"]
  );
  assert.equal(result.perNote[0].languageOverride.planned, "english");
  // 续拍不设 languageOverride（保持现值）。
  assert.equal(result.perNote[1].languageOverride.planned, "");
});

test("unit overflow and leftover notes are reported honestly", async () => {
  const store = createStore();
  const overflow = createStoredContext(store, { notes: uniformNotes(["x", "y"]) });
  const overflowResult = await createService(store).align({
    contextId: overflow.stored.contextId,
    lyrics: "あさひ",
  });
  assert.equal(overflowResult.summary.complete, false);
  assert.equal(overflowResult.alignment.unassignedUnits.length, 1);
  assert.ok(overflowResult.warnings.some((warning) => warning.code === "NOT_ENOUGH_NOTES"));

  const leftover = createStoredContext(store, { notes: uniformNotes(["x", "y", "z", "w"]) });
  const leftoverResult = await createService(store).align({
    contextId: leftover.stored.contextId,
    lyrics: "あさ",
  });
  assert.equal(leftoverResult.alignment.unfilledNotes.length, 2);
  assert.ok(leftoverResult.warnings.some((warning) => warning.code === "NOTES_LEFT_UNTOUCHED"));
});

test("kanji and ambiguous CJK are flagged instead of guessed", async () => {
  const store = createStore();
  const withKana = createStoredContext(store, { notes: uniformNotes(["a", "b", "c"]) });
  const service = createService(store);
  const japanese = await service.align({
    contextId: withKana.stored.contextId,
    lyrics: "朝日のき",
  });
  // 文本含假名 → 汉字推定日语但 mora 数未知，各占 1 音符并标 needs_review。
  assert.equal(japanese.summary.unitCount, 4);
  assert.ok(japanese.warnings.some((warning) => warning.code === "KANJI_MORA_UNKNOWN"));
  assert.equal(japanese.perNote[0].needsReview, true);
  assert.equal(japanese.perNote[0].languageOverride.planned, "japanese");
  assert.ok(japanese.summary.needsReviewCount >= 2);
  assert.ok(japanese.review.checklist.some((item) => /needs_review/.test(item)));

  const bare = createStoredContext(store, { notes: uniformNotes(["a", "b"]) });
  const ambiguous = await service.align({ contextId: bare.stored.contextId, lyrics: "朝日" });
  assert.ok(ambiguous.warnings.some((warning) => warning.code === "LANGUAGE_AMBIGUOUS"));
  assert.equal(ambiguous.perNote[0].languageOverride.planned, "");

  const mandarin = await service.align({
    contextId: bare.stored.contextId,
    lyrics: "朝日",
    language: "mandarin",
  });
  assert.ok(!mandarin.warnings.some((warning) => warning.code === "LANGUAGE_AMBIGUOUS"));
  assert.equal(mandarin.perNote[0].confidence, "deterministic_rule");
  assert.equal(mandarin.perNote[0].languageOverride.planned, "mandarin");
});

test("startNoteId fills from the middle and implies the occurrence", async () => {
  const store = createStore();
  const { stored, occurrenceId } = createStoredContext(store, {
    notes: uniformNotes(["a", "b", "c", "d"]),
    extraOccurrenceWithNotes: true,
  });
  const result = await createService(store).align({
    contextId: stored.contextId,
    lyrics: "あさ",
    startNoteId: noteId(occurrenceId, 2),
  });
  assert.equal(result.occurrence.occurrenceId, occurrenceId);
  assert.equal(result.summary.startIndex, 2);
  assert.deepEqual(
    result.perNote.map((item) => item.plannedLyrics),
    ["あ", "さ"]
  );
});

test("align resolves contexts honestly across error paths", async () => {
  const store = createStore();
  const service = createService(store);
  await assert.rejects(
    service.align({ contextId: "ctx_missing", lyrics: "あ" }),
    (error) => error.code === "UNKNOWN_CONTEXT"
  );
  const noNotes = createStoredContext(store, { notes: [] });
  await assert.rejects(
    service.align({ contextId: noNotes.stored.contextId, lyrics: "あ" }),
    (error) => error.code === "NOTES_NOT_CAPTURED"
  );
  const ambiguous = createStoredContext(store, {
    notes: uniformNotes(["a"]),
    extraOccurrenceWithNotes: true,
  });
  await assert.rejects(
    service.align({ contextId: ambiguous.stored.contextId, lyrics: "あ" }),
    (error) => error.code === "AMBIGUOUS_CONTEXT"
  );
  const single = createStoredContext(store, { notes: uniformNotes(["a"]) });
  await assert.rejects(
    service.align({
      contextId: single.stored.contextId,
      lyrics: "あ",
      startNoteId: `${single.occurrenceId}:n:9`,
    }),
    (error) => error.code === "UNKNOWN_NOTE_ID"
  );
  await assert.rejects(
    service.align({ contextId: single.stored.contextId, lyrics: "、。！" }),
    (error) => error.code === "EMPTY_LYRICS"
  );
});

test("align validates request shape before touching the store", async () => {
  const store = createStore();
  const service = createService(store);
  for (const request of [
    {},
    { contextId: "ctx_x" },
    { contextId: "ctx_x", lyrics: "" },
    { contextId: "ctx_x", lyrics: "あ", language: "klingon" },
    { contextId: "ctx_x", lyrics: "あ", bogus: true },
    { contextId: "ctx_x", lyrics: "あ", setLanguageOverride: "yes" },
    { contextId: "ctx_x", lyrics: "あ", responseMode: "loud" },
  ]) {
    await assert.rejects(service.align(request), (error) => error.code === "INVALID_ARGUMENTS");
  }
});

test("compact responses keep summary, alignment, and patchRequest only", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, { notes: uniformNotes(["a", "b"]) });
  const result = await createService(store).align({
    contextId: stored.contextId,
    lyrics: "あさ",
    responseMode: "compact",
  });
  assert.equal(result.tokens, undefined);
  assert.equal(result.perNote, undefined);
  assert.ok(result.summary);
  assert.ok(result.patchRequest.arguments.patches.length === 2);
  assert.match(result.planId, /^lyr_[0-9a-f]{16}$/);
});
