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
    note: 3,
    expected: { lyrics: "see" },
    set: { lyrics: "saw" },
  });
  assert.equal(result.patchRequest.tool, "sv_patch_notes");
  assert.equal(result.patchRequest.arguments.dryRun, true);
  assert.equal(result.patchRequest.arguments.atomic, true);
  assert.equal(result.patchRequest.arguments.contextId, stored.contextId);
});

function mandarinLyrics(count) {
  const pool = "我你他她们的一二三四五六七八九十日月山川风花雪";
  return Array.from({ length: count }, (_, index) => pool[index % pool.length]).join("");
}

// 像 sv_patch_notes 成功提交那样把 patch 应用到音符数据（该行为由 note-patch 自己的测试覆盖），
// 返回下一轮快照用的音符数组。提交成功即消费 contextId，续轮必须用新 context——这正是
// continuation 工作流的形状：commit → re-snapshot → re-align。
function applyPatchesToNotes(notes, occurrenceId, patches) {
  const updated = notes.map((note) => ({ ...note }));
  for (const patch of patches) {
    const index = patch.note;
    assert.ok(Number.isSafeInteger(index) && index >= 0, "patch identity is a group index");
    assert.equal(updated[index].lyrics ?? "", patch.expected.lyrics); // expected 前置条件成立
    updated[index].lyrics = patch.set.lyrics;
    if (patch.set.languageOverride !== undefined) {
      updated[index].languageOverride = patch.set.languageOverride;
    }
  }
  return updated;
}

test("oversized plans emit one submittable batch plus an honest continuation, never pre-baked dead batches", async () => {
  const store = createStore();
  const count = 201;
  const { stored } = createStoredContext(store, {
    notes: uniformNotes(new Array(count).fill("")),
  });
  const result = await createService(store).align({
    contextId: stored.contextId,
    lyrics: mandarinLyrics(count),
    language: "mandarin",
  });
  assert.equal(result.status, "planned");
  assert.equal(result.summary.changedCount, count);
  // 唯一可提交批：当前 context 下的前 200 项。预烤第二批必然 UNKNOWN_CONTEXT（提交成功即删
  // context），因此响应里不允许存在 patchRequests 数组。
  assert.equal(result.patchRequest.arguments.patches.length, 200);
  assert.equal(result.patchRequest.arguments.contextId, stored.contextId);
  assert.equal(result.patchRequests, undefined);
  assert.equal(result.continuation.reason, "PATCH_CAP");
  assert.equal(result.continuation.patchCapPerCall, 200);
  assert.equal(result.continuation.remainingChangedCount, 1);
  assert.ok(result.continuation.workflow.some((step) => /sv_snapshot_range/.test(step)));
  assert.ok(result.continuation.workflow.some((step) => /sv_align_lyrics/.test(step)));
  assert.ok(result.warnings.some((warning) => warning.code === "PLAN_EXCEEDS_PATCH_CAP"));
});

test("continuation rounds converge: commit, re-snapshot, re-align until no_change", async () => {
  const store = createStore();
  const count = 201;
  const lyrics = mandarinLyrics(count);
  let notes = uniformNotes(new Array(count).fill(""));
  const service = createService(store);

  // 第 1 轮：200 项可提交，1 项留给续轮。
  const round1Context = createStoredContext(store, { notes });
  const round1 = await service.align({ contextId: round1Context.stored.contextId, lyrics, language: "mandarin" });
  assert.equal(round1.patchRequest.arguments.patches.length, 200);
  assert.equal(round1.continuation.remainingChangedCount, 1);
  notes = applyPatchesToNotes(notes, round1Context.occurrenceId, round1.patchRequest.arguments.patches);

  // 第 2 轮：新快照新 contextId；已应用的 200 项自动 no-change，恰好只剩 1 个 patch。
  const round2Context = createStoredContext(store, { notes });
  assert.notEqual(round2Context.stored.contextId, round1Context.stored.contextId);
  const round2 = await service.align({ contextId: round2Context.stored.contextId, lyrics, language: "mandarin" });
  assert.equal(round2.status, "planned");
  assert.equal(round2.patchRequest.arguments.patches.length, 1);
  assert.equal(round2.continuation, undefined);
  // 续轮 patch 落在新 occurrence 的组内 index 上——这正是预烤批次不可能提前知道的部分。
  assert.equal(round2.patchRequest.arguments.patches[0].note, 200);
  notes = applyPatchesToNotes(notes, round2Context.occurrenceId, round2.patchRequest.arguments.patches);

  // 第 3 轮：全部就位 → no_change，循环终止。
  const round3Context = createStoredContext(store, { notes });
  const round3 = await service.align({ contextId: round3Context.stored.contextId, lyrics, language: "mandarin" });
  assert.equal(round3.status, "no_change");
  assert.equal(round3.patchRequest, null);
  assert.equal(round3.continuation, undefined);
});

test("PATCH_CAP continuation can replay explicit occurrenceId/startNote against a fresh context", async () => {
  const store = createStore();
  const lyrics = mandarinLyrics(201);
  let notes = uniformNotes(new Array(202).fill(""));
  const service = createService(store);
  const round1Context = createStoredContext(store, {
    notes,
    extraOccurrenceWithNotes: true,
  });
  const originalOptions = {
    occurrenceId: round1Context.occurrenceId,
    startNote: 1,
    lyrics,
    language: "mandarin",
  };
  const round1 = await service.align({
    contextId: round1Context.stored.contextId,
    ...originalOptions,
  });
  assert.equal(round1.patchRequest.arguments.patches.length, 200);
  assert.equal(round1.continuation.remainingChangedCount, 1);
  notes = applyPatchesToNotes(
    notes,
    round1Context.occurrenceId,
    round1.patchRequest.arguments.patches
  );
  // 模拟提交成功消费旧上下文；continuation 明确承诺新快照后可用同一组 options 重跑。
  store.delete(round1Context.stored.contextId);
  const round2Context = createStoredContext(store, {
    notes,
    extraOccurrenceWithNotes: true,
  });
  let round2;
  await assert.doesNotReject(async () => {
    round2 = await service.align({
      contextId: round2Context.stored.contextId,
      ...originalOptions,
    });
  });
  assert.equal(round2.status, "planned");
  assert.equal(round2.patchRequest.arguments.patches.length, 1);
  assert.equal(
    round2.patchRequest.arguments.patches[0].note,
    201
  );
});

test("PATCH_CAP continuation refuses positional re-anchor when target or start-note identity changed", async () => {
  const store = createStore();
  const lyrics = mandarinLyrics(201);
  let notes = uniformNotes(new Array(202).fill(""));
  const service = createService(store);
  const round1Context = createStoredContext(store, {
    notes,
    extraOccurrenceWithNotes: true,
  });
  const originalOptions = {
    occurrenceId: round1Context.occurrenceId,
    startNote: 1,
    lyrics,
    language: "mandarin",
  };
  const round1 = await service.align({
    contextId: round1Context.stored.contextId,
    ...originalOptions,
  });
  notes = applyPatchesToNotes(
    notes,
    round1Context.occurrenceId,
    round1.patchRequest.arguments.patches
  );
  store.delete(round1Context.stored.contextId);
  const round2Context = createStoredContext(store, {
    notes,
    extraOccurrenceWithNotes: true,
  });
  // track/reference 位置可被另一个 group 占用；旧 selector 不能只凭位置后缀重锚。
  round2Context.stored.context.occurrences[0].targetGroupUuid = "uuid-replaced-target";
  await assert.rejects(
    service.align({
      contextId: round2Context.stored.contextId,
      ...originalOptions,
    }),
    (error) => error.code === "STALE_CONTEXT" && /target|uuid/i.test(error.message)
  );

  const round3Context = createStoredContext(store, {
    notes,
    extraOccurrenceWithNotes: true,
  });
  const movedStart = round3Context.stored.context.occurrences[0].noteFingerprints.find(
    (note) => note.indexInGroup === 1
  );
  movedStart.onsetBlick += Q;
  await assert.rejects(
    service.align({
      contextId: round3Context.stored.contextId,
      ...originalOptions,
    }),
    (error) => error.code === "STALE_CONTEXT" && /start note|fingerprint/i.test(error.message)
  );
});

test("exactly the patch cap stays a single request with no continuation", async () => {
  const store = createStore();
  const count = 200;
  const { stored } = createStoredContext(store, {
    notes: uniformNotes(new Array(count).fill("")),
  });
  const result = await createService(store).align({
    contextId: stored.contextId,
    lyrics: mandarinLyrics(count),
    language: "mandarin",
  });
  assert.equal(result.summary.changedCount, count);
  assert.equal(result.patchRequest.arguments.patches.length, 200);
  assert.equal(result.continuation, undefined);
  assert.ok(!result.warnings.some((warning) => warning.code === "PLAN_EXCEEDS_PATCH_CAP"));
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

test("explicit continuation chains override inferred English syllable expansion", async () => {
  const cases = [
    {
      lyrics: "beautiful + +",
      plannedLyrics: ["beautiful", "+", "+"],
      semanticRoles: ["lexical_head", "syllable_continuation", "syllable_continuation"],
    },
    {
      lyrics: "ashame + - -",
      plannedLyrics: ["ashame", "+", "-", "-"],
      semanticRoles: [
        "lexical_head",
        "syllable_continuation",
        "phonation_continuation",
        "phonation_continuation",
      ],
    },
    {
      lyrics: "ashame - + -",
      plannedLyrics: ["ashame", "-", "+", "-"],
      semanticRoles: [
        "lexical_head",
        "phonation_continuation",
        "syllable_continuation",
        "phonation_continuation",
      ],
    },
  ];

  for (const fixture of cases) {
    const store = createStore();
    const { stored, occurrenceId } = createStoredContext(store, {
      notes: uniformNotes(new Array(fixture.plannedLyrics.length).fill("")),
    });
    const result = await createService(store).align({
      contextId: stored.contextId,
      lyrics: fixture.lyrics,
    });

    assert.equal(result.summary.unitCount, fixture.plannedLyrics.length);
    assert.deepEqual(
      result.perNote.map((item) => item.plannedLyrics),
      fixture.plannedLyrics
    );
    assert.deepEqual(
      result.perNote.map((item) => item.unit.semanticRole),
      fixture.semanticRoles
    );
    assert.equal(result.perNote[0].unit.chainHeadNote, 0);
    assert.ok(
      result.perNote
        .slice(1)
        .every((item) => item.unit.continuationValid === true)
    );
    assert.ok(
      !result.warnings.some((warning) => warning.code === "SYLLABLE_CHAIN_GAP")
    );
  }
});

test("orphan continuations require review and compact preserves semantic counts", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, {
    notes: uniformNotes(["", "", ""]),
  });
  const result = await createService(store).align({
    contextId: stored.contextId,
    lyrics: "+ - word",
    responseMode: "compact",
  });

  assert.equal(result.tokens, undefined);
  assert.equal(result.perNote, undefined);
  assert.deepEqual(result.summary.semanticRoles.byRole, {
    syllable_continuation: 1,
    phonation_continuation: 1,
    lexical_head: 1,
  });
  assert.equal(result.summary.needsReviewCount, 2);
  assert.equal(result.review.requiresHumanReview, true);
  assert.ok(result.warnings.some((warning) => warning.code === "ORPHAN_PLUS"));
  assert.ok(
    result.warnings.some(
      (warning) => warning.code === "ORPHAN_PHONATION_CONTINUATION"
    )
  );
});

test("special lyrics use exact spelling and expose official semantic evidence", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, {
    notes: uniformNotes(["", ""]),
  });
  const result = await createService(store).align({
    contextId: stored.contextId,
    lyrics: "br BR",
  });

  assert.deepEqual(
    result.perNote.map((item) => item.plannedLyrics),
    ["br", "BR"]
  );
  assert.deepEqual(
    result.tokens.map((token) => token.semanticRole),
    ["breath_event", "lexical_head"]
  );
  assert.deepEqual(
    result.tokens.map((token) => token.semanticEvidence),
    ["official_documented_special_lyric_br", "similar_to_official_special_lyric_but_not_exact"]
  );
  assert.ok(
    result.warnings.some((warning) => warning.code === "SUSPICIOUS_SPECIAL_LYRIC_VARIANT")
  );
  assert.equal(
    result.provenance.plusMinusBreath,
    "official_documented_exact_ascii_special_lyrics"
  );
});

test("apostrophe prefixes carry glottal semantics while standalone apostrophe requires review", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, {
    notes: uniformNotes(["", "", "", ""]),
  });
  const result = await createService(store).align({
    contextId: stored.contextId,
    lyrics: "'a 'あ ' cl",
  });

  assert.deepEqual(
    result.perNote.map((item) => item.plannedLyrics),
    ["'a", "'あ", "'", "cl"]
  );
  assert.deepEqual(
    result.tokens.map((token) => token.semanticRole),
    ["glottal_onset", "glottal_onset", "unknown_special", "lexical_head"]
  );
  assert.deepEqual(
    result.tokens.map((token) => token.semanticEvidence),
    [
      "official_documented_apostrophe_prefix_cl",
      "official_documented_apostrophe_prefix_cl",
      "standalone_apostrophe_pending_host_calibration",
      "official_documented_lexical_lyric",
    ]
  );
  assert.equal(result.tokens[2].needsReview, true);
  assert.equal(result.perNote[2].needsReview, true);
  assert.equal(result.review.requiresHumanReview, true);
  assert.ok(
    result.warnings.some(
      (warning) => warning.code === "STANDALONE_APOSTROPHE_UNCALIBRATED"
    )
  );
  assert.equal(
    result.provenance.apostrophePrefix,
    "official_documented_prefix_inserts_cl_phoneme"
  );
  assert.equal(
    result.provenance.standaloneApostrophe,
    "not_documented_requires_human_review"
  );
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

test("startNote fills from the middle; it no longer implies an occurrence", async () => {
  const store = createStore();
  const { stored, occurrenceId } = createStoredContext(store, {
    notes: uniformNotes(["a", "b", "c", "d"]),
    extraOccurrenceWithNotes: true,
  });
  // index 不携带 occurrence 前缀，因此多 occurrence 时必须显式点名。
  const result = await createService(store).align({
    contextId: stored.contextId,
    occurrenceId,
    lyrics: "あさ",
    startNote: 2,
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
    service.align({
      contextId: ambiguous.stored.contextId,
      occurrenceId: "forged:t:0:r:0",
      lyrics: "あ",
    }),
    (error) => error.code === "UNKNOWN_OCCURRENCE"
  );
  await assert.rejects(
    service.align({ contextId: ambiguous.stored.contextId, lyrics: "あ" }),
    (error) => error.code === "AMBIGUOUS_CONTEXT"
  );
  const single = createStoredContext(store, { notes: uniformNotes(["a"]) });
  await assert.rejects(
    service.align({
      contextId: single.stored.contextId,
      lyrics: "あ",
      startNote: 9,
    }),
    (error) => error.code === "NOTE_INDEX_OUT_OF_RANGE"
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
  assert.equal(result.alignment.unassignedUnits, undefined);
  assert.equal(result.alignment.unfilledNotes, undefined);
  assert.equal(result.alignment.unassignedCount, 0);
  assert.equal(result.alignment.unfilledCount, 0);
  assert.ok(result.patchRequest.arguments.patches.length === 2);
  assert.match(result.planId, /^lyr_[0-9a-f]{16}$/);
});
