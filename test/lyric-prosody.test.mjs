import assert from "node:assert/strict";
import test from "node:test";

import { LyricProsodyService } from "../server/src/lyric-prosody.js";
import { SnapshotStore } from "../server/src/snapshot.js";

const Q = 705600000;

function createStore() {
  return new SnapshotStore({ now: () => 1000 });
}

function createStoredContext(store, options = {}) {
  const {
    notes = [],
    processing,
    meterMarks = [{ position: 0, positionBlick: 0, numerator: 4, denominator: 4 }],
    extraOccurrenceWithNotes = false,
  } = options;
  const stored = store.create({
    epoch: 1,
    scope: { kind: "range" },
    observedAt: new Date(1000).toISOString(),
    context: { kind: "range", occurrences: [] },
  });
  const noteFingerprints = notes.map((note, index) => ({
    indexInGroup: note.indexInGroup ?? index,
    onsetBlick: note.onsetBlick,
    durationBlick: note.durationBlick,
    pitch: note.pitch ?? 60,
    lyrics: note.lyrics ?? `n${index}`,
    phonemesOverride: note.phonemesOverride ?? "",
    languageOverride: note.languageOverride ?? "",
    detuneCents: 0,
  }));
  stored.context.occurrences.push({
    occurrence: 0,
    trackIndex: 0,
    groupIndex: 0,
    targetGroupUuid: "uuid-prosody-test",
    timeOffsetBlick: 0,
    pitchOffsetSemitone: 0,
    sharedTargetOccurrences: [0],
    noteFingerprints,
    ...(processing !== undefined ? { processing } : {}),
  });
  if (extraOccurrenceWithNotes) {
    stored.context.occurrences.push({
      occurrence: 1,
      trackIndex: 0,
      groupIndex: 1,
      targetGroupUuid: "uuid-prosody-test",
      timeOffsetBlick: 0,
      pitchOffsetSemitone: 0,
      sharedTargetOccurrences: [0, 1],
      noteFingerprints: noteFingerprints.map((fingerprint) => ({ ...fingerprint })),
    });
  }
  stored.context.quarterBlick = Q;
  stored.context.meterMarks = meterMarks;
  stored.context.tempoMarks = [{ positionBlick: 0, positionSeconds: 0, bpm: 120 }];
  return { stored };
}

function createService(store) {
  return new LyricProsodyService({ store, now: () => 2000 });
}

test("breath check flags overrides and unusually long breaths", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, {
    notes: [
      { onsetBlick: 0, durationBlick: Q, lyrics: "br", languageOverride: "japanese" },
      { onsetBlick: Q, durationBlick: 2 * Q, lyrics: "br" },
      { onsetBlick: 3 * Q, durationBlick: Q, lyrics: "br" }, // 干净换气：不报
      { onsetBlick: 4 * Q, durationBlick: Q, lyrics: "la" },
    ],
  });
  const result = await createService(store).validate({
    contextId: stored.contextId,
    checks: ["breath"],
  });
  assert.equal(result.ok, true);
  assert.equal(result.summary.byKind.breath_with_overrides, 1);
  assert.equal(result.summary.byKind.breath_unusually_long, 1);
  assert.equal(result.summary.issueCount, 2);
  const withOverride = result.issues.find((issue) => issue.kind === "breath_with_overrides");
  assert.deepEqual(withOverride.notes, [0]);
  assert.equal(withOverride.severity, "warning");
  const long = result.issues.find((issue) => issue.kind === "breath_unusually_long");
  assert.equal(long.severity, "info");
});

test("specialLyricChains reports orphan continuations with stable structured codes", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, {
    notes: [
      { onsetBlick: 0, durationBlick: Q, lyrics: "+" },
      { onsetBlick: Q, durationBlick: Q, lyrics: "br" },
      { onsetBlick: 2 * Q, durationBlick: Q, lyrics: "-" },
    ],
  });
  const result = await createService(store).validate({
    contextId: stored.contextId,
    checks: ["specialLyricChains"],
  });

  assert.equal(result.summary.byKind.orphan_plus, 1);
  assert.equal(result.summary.byKind.orphan_phonation_continuation, 1);
  assert.deepEqual(
    result.issues.map((issue) => issue.code),
    ["ORPHAN_PLUS", "ORPHAN_PHONATION_CONTINUATION"]
  );
  assert.deepEqual(result.issues[0].notes, [0]);
  assert.equal(result.issues[0].semanticRole, "syllable_continuation");
  assert.equal(result.issues[1].startBlick, 2 * Q);
  assert.equal(result.issues[1].confidence, "official_contract");
});

test("specialLyricChains accepts a contiguous lexical, '+', '-' chain", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, {
    notes: [
      { onsetBlick: 0, durationBlick: Q, lyrics: "glory" },
      { onsetBlick: Q, durationBlick: Q, lyrics: "+" },
      { onsetBlick: 2 * Q, durationBlick: Q, lyrics: "-" },
    ],
  });
  const result = await createService(store).validate({
    contextId: stored.contextId,
    checks: ["specialLyricChains"],
  });

  assert.equal(result.summary.clean, true);
  assert.equal(result.summary.issueCount, 0);
});

test("specialLyricChains preserves a one-BLICK continuation gap as evidence", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, {
    notes: [
      { onsetBlick: 0, durationBlick: Q, lyrics: "glory" },
      { onsetBlick: Q + 1, durationBlick: Q, lyrics: "+" },
    ],
  });
  const result = await createService(store).validate({
    contextId: stored.contextId,
    checks: ["specialLyricChains"],
  });

  assert.equal(result.summary.byKind.syllable_chain_gap, 1);
  assert.equal(result.issues[0].code, "SYLLABLE_CHAIN_GAP");
  assert.equal(result.issues[0].gapBlick, 1);
  assert.equal(result.issues[0].confidence, "host_observed");
  assert.deepEqual(result.issues[0].notes, [0, 1]);
});

test("japaneseMora flags multi-mora lyrics and isolated small kana; clean kana pass", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, {
    notes: [
      { onsetBlick: 0, durationBlick: Q, lyrics: "とう" }, // 2 morae on one note
      { onsetBlick: Q, durationBlick: Q, lyrics: "きょ" }, // 拗音并入前拍 = 1 mora，干净
      { onsetBlick: 2 * Q, durationBlick: Q, lyrics: "ょう" }, // 小假名起头
      { onsetBlick: 3 * Q, durationBlick: Q, lyrics: "ん" }, // 拨音独立成拍，干净
    ],
  });
  const result = await createService(store).validate({
    contextId: stored.contextId,
    checks: ["japaneseMora"],
  });
  assert.equal(result.summary.byKind.note_overfilled_morae, 1);
  assert.equal(result.summary.byKind.isolated_small_kana, 1);
  assert.equal(result.summary.issueCount, 2);
  const overfilled = result.issues.find((issue) => issue.kind === "note_overfilled_morae");
  assert.equal(overfilled.severity, "warning");
  assert.equal(overfilled.confidence, "deterministic_rule");
  const isolated = result.issues.find((issue) => issue.kind === "isolated_small_kana");
  assert.equal(isolated.severity, "error");
});

test("englishSyllables compares heuristic counts against following '+' notes", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, {
    notes: [
      { onsetBlick: 0, durationBlick: Q, lyrics: "hello" }, // 2 音节但无 "+"
      { onsetBlick: Q, durationBlick: Q, lyrics: "cat" }, // 1 音节
      { onsetBlick: 2 * Q, durationBlick: Q, lyrics: "+" }, // 多出的续拍
      { onsetBlick: 3 * Q, durationBlick: Q, lyrics: "water" }, // 2 音节 + 1 "+"：正确
      { onsetBlick: 4 * Q, durationBlick: Q, lyrics: "+" },
    ],
  });
  const result = await createService(store).validate({
    contextId: stored.contextId,
    checks: ["englishSyllables"],
  });
  assert.equal(result.summary.byKind.word_underfilled_syllables, 1);
  assert.equal(result.summary.byKind.word_overfilled_syllables, 1);
  assert.equal(result.summary.issueCount, 2);
  const under = result.issues.find((issue) => issue.kind === "word_underfilled_syllables");
  assert.deepEqual(under.notes, [0]);
  assert.equal(under.confidence, "heuristic_estimate");
  const over = result.issues.find((issue) => issue.kind === "word_overfilled_syllables");
  assert.deepEqual(over.notes, [1, 2]);
});

test("languageConsistency flags script/override conflicts and override-bearing continuations", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, {
    notes: [
      { onsetBlick: 0, durationBlick: Q, lyrics: "あ", languageOverride: "english" }, // kana + english
      { onsetBlick: Q, durationBlick: Q, lyrics: "word", languageOverride: "japanese" }, // latin + japanese
      { onsetBlick: 2 * Q, durationBlick: Q, lyrics: "你", languageOverride: "english" }, // cjk + english
      { onsetBlick: 3 * Q, durationBlick: Q, lyrics: "-", languageOverride: "mandarin" }, // 延音残留
      { onsetBlick: 4 * Q, durationBlick: Q, lyrics: "あ", languageOverride: "japanese" }, // 一致：不报
      { onsetBlick: 5 * Q, durationBlick: Q, lyrics: "word", languageOverride: "english" }, // 一致：不报
      { onsetBlick: 6 * Q, durationBlick: Q, lyrics: "你", languageOverride: "mandarin" }, // 一致：不报
    ],
  });
  const result = await createService(store).validate({
    contextId: stored.contextId,
    checks: ["languageConsistency"],
  });
  assert.equal(result.summary.byKind.language_override_conflict, 3);
  assert.equal(result.summary.byKind.continuation_with_language_override, 1);
  assert.equal(result.summary.issueCount, 4);
});

test("stressAlignment reports weak-beat multi-syllable words as low-confidence info only", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, {
    notes: [
      { onsetBlick: 0, durationBlick: Q, lyrics: "morning" }, // bar1 beat1：强拍，不报
      { onsetBlick: Q, durationBlick: Q, lyrics: "hello" }, // bar1 beat2：弱拍 → info
      { onsetBlick: 2 * Q, durationBlick: Q, lyrics: "sunset" }, // bar1 beat3：4/4 中拍，不报
      { onsetBlick: 3 * Q, durationBlick: Q, lyrics: "cat" }, // 单音节：跳过
    ],
  });
  const result = await createService(store).validate({
    contextId: stored.contextId,
    checks: ["stressAlignment"],
  });
  assert.equal(result.summary.byKind.stressed_syllable_on_weak_beat, 1);
  const issue = result.issues[0];
  assert.equal(issue.severity, "info");
  assert.equal(issue.confidence, "low");
  assert.ok(issue.message.includes("hello"));
  assert.equal(result.coverage.stressAlignment.status, "checked");
  assert.equal(result.coverage.stressAlignment.checkedWords, 3);
  assert.equal(result.provenance.stressModel, "first_syllable_heuristic_no_dictionary");
});

test("phonemeCoverage flags only melodic words; br and continuations stay legitimate", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, {
    notes: [
      { onsetBlick: 0, durationBlick: Q, lyrics: "br" }, // 空音素合法
      { onsetBlick: Q, durationBlick: Q, lyrics: "xyzzy" }, // 空音素可疑
      { onsetBlick: 2 * Q, durationBlick: Q, lyrics: "-" }, // 空音素合法
      { onsetBlick: 3 * Q, durationBlick: Q, lyrics: "la" }, // 有音素
    ],
    processing: {
      state: "ready",
      phonemeCoverage: {
        indexBase: 0,
        totalNotes: 4,
        observedNotes: 4,
        nonEmptyNotes: 1,
        emptyNotes: 3,
        emptyNoteIndices: [0, 1, 2],
        missingNoteIndices: [],
      },
    },
  });
  const result = await createService(store).validate({
    contextId: stored.contextId,
    checks: ["phonemeCoverage"],
  });
  assert.equal(result.summary.byKind.melodic_note_empty_phonemes, 1);
  assert.deepEqual(result.issues[0].notes, [1]);
  assert.equal(result.coverage.phonemeCoverage.status, "captured");
  assert.equal(result.coverage.phonemeCoverage.flaggedNotes, 1);
  assert.equal(result.coverage.phonemeCoverage.legitimatelyEmpty, 2);
});

test("mandarinReading reports the host reading for each polyphonic character", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, {
    notes: [
      { indexInGroup: 3, onsetBlick: 0, durationBlick: Q, lyrics: "还" },
      { indexInGroup: 5, onsetBlick: Q, durationBlick: Q, lyrics: "还" },
      { indexInGroup: 6, onsetBlick: 2 * Q, durationBlick: Q, lyrics: "普通" },
    ],
    processing: {
      state: "ready",
      phonemes: [null, null, null, "x a :\\i", null, "x ua :n", "p u th U N"],
    },
  });
  const result = await createService(store).validate({
    contextId: stored.contextId,
    checks: ["mandarinReading"],
  });

  assert.equal(result.coverage.mandarinReading.status, "checked");
  assert.equal(result.coverage.mandarinReading.candidateNotes, 2);
  assert.equal(result.coverage.mandarinReading.resolvedReadings, 2);
  assert.equal(result.coverage.mandarinReading.hitRate, 1);
  assert.deepEqual(
    result.issues.map((issue) => [issue.notes, issue.hostReading, issue.hostPhonemes]),
    [
      [[3], "hai", "x a :\\i"],
      [[5], "huan", "x ua :n"],
    ]
  );
  assert.ok(
    result.issues.every(
      (issue) =>
        issue.code === "MANDARIN_READING_REQUIRES_CONFIRMATION" &&
        issue.toneOnlyDistinctions === "not_distinguishable"
    )
  );
  assert.equal(
    result.provenance.mandarinReading,
    "host_g2p_readback_toneless_pinyin_lookup"
  );
  assert.equal(
    result.provenance.mandarinReadingLimit,
    "tone_only_differences_not_distinguishable"
  );
});

test("mandarinReading reports unknown formats and raises a zero-hit health warning", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, {
    notes: [{ onsetBlick: 0, durationBlick: Q, lyrics: "还" }],
    processing: { state: "ready", phonemes: ["future-format"] },
  });
  const result = await createService(store).validate({
    contextId: stored.contextId,
    checks: ["mandarinReading"],
  });

  assert.equal(result.coverage.mandarinReading.status, "unknown_phoneme_format");
  assert.equal(result.coverage.mandarinReading.hitRate, 0);
  assert.equal(result.issues[0].code, "MANDARIN_READING_UNKNOWN_PHONEME_FORMAT");
  assert.equal(result.issues[0].kind, "unknown_phoneme_format");
  assert.equal(result.issues[0].hostReading, null);
  assert.equal(result.issues[0].hostPhonemes, "future-format");
  assert.ok(
    result.warnings.some((warning) => warning.code === "MANDARIN_READING_ZERO_HIT_RATE")
  );
});

test("mandarinReading distinguishes missing, legacy, pending, and no-candidate contexts", async () => {
  const cases = [
    {
      processing: undefined,
      status: "not_captured",
      warning: "PROCESSING_NOT_CAPTURED",
    },
    {
      processing: { state: "ready" },
      status: "not_captured",
      warning: "PHONEME_STRINGS_NOT_CAPTURED",
    },
    {
      processing: { state: "pending", phonemes: [""] },
      status: "captured_pending",
      warning: "MANDARIN_READING_PENDING",
    },
  ];
  for (const item of cases) {
    const store = createStore();
    const { stored } = createStoredContext(store, {
      notes: [{ onsetBlick: 0, durationBlick: Q, lyrics: "还" }],
      processing: item.processing,
    });
    const result = await createService(store).validate({
      contextId: stored.contextId,
      checks: ["mandarinReading"],
    });
    assert.equal(result.coverage.mandarinReading.status, item.status);
    assert.equal(result.summary.issueCount, 0);
    assert.ok(result.warnings.some((warning) => warning.code === item.warning));
  }

  const store = createStore();
  const { stored } = createStoredContext(store, {
    notes: [{ onsetBlick: 0, durationBlick: Q, lyrics: "普通" }],
  });
  const result = await createService(store).validate({
    contextId: stored.contextId,
    checks: ["mandarinReading"],
  });
  assert.equal(result.coverage.mandarinReading.status, "checked_no_candidates");
  assert.deepEqual(result.warnings, []);
});

test("near-miss special lyrics remain lexical across every validator check", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, {
    notes: [{ onsetBlick: 0, durationBlick: Q, lyrics: " br " }],
    processing: {
      state: "ready",
      phonemeCoverage: {
        indexBase: 0,
        totalNotes: 1,
        observedNotes: 1,
        nonEmptyNotes: 0,
        emptyNotes: 1,
        emptyNoteIndices: [0],
        missingNoteIndices: [],
      },
    },
  });
  const result = await createService(store).validate({
    contextId: stored.contextId,
    checks: ["specialLyricChains", "phonemeCoverage"],
  });

  assert.ok(
    result.issues.some(
      (issue) => issue.code === "SUSPICIOUS_SPECIAL_LYRIC_VARIANT"
    )
  );
  const empty = result.issues.find(
    (issue) => issue.kind === "melodic_note_empty_phonemes"
  );
  assert.deepEqual(empty.notes, [0]);
  assert.equal(result.coverage.phonemeCoverage.flaggedNotes, 1);
  assert.equal(result.coverage.phonemeCoverage.legitimatelyEmpty, 0);
});

test("phonemeCoverage and stressAlignment degrade honestly when data was not captured", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, {
    notes: [{ onsetBlick: 0, durationBlick: Q, lyrics: "hello" }],
    meterMarks: [],
  });
  const result = await createService(store).validate({
    contextId: stored.contextId,
    checks: ["phonemeCoverage", "stressAlignment"],
  });
  assert.equal(result.coverage.phonemeCoverage.status, "not_captured");
  assert.equal(result.coverage.stressAlignment.status, "not_captured");
  assert.ok(result.warnings.some((warning) => warning.code === "PROCESSING_NOT_CAPTURED"));
  assert.ok(result.warnings.some((warning) => warning.code === "METER_NOT_CAPTURED"));
  assert.equal(result.summary.issueCount, 0);
});

test("a clean passage reports clean:true with zero issues", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, {
    notes: [
      { onsetBlick: 0, durationBlick: Q, lyrics: "br" },
      { onsetBlick: Q, durationBlick: Q, lyrics: "き", languageOverride: "japanese" },
      { onsetBlick: 2 * Q, durationBlick: Q, lyrics: "ら" },
      { onsetBlick: 3 * Q, durationBlick: Q, lyrics: "-" },
    ],
  });
  const result = await createService(store).validate({ contextId: stored.contextId });
  assert.equal(result.summary.clean, true);
  assert.equal(result.summary.issueCount, 0);
  assert.deepEqual(result.summary.bySeverity, { error: 0, warning: 0, info: 0 });
});

test("issues are sorted by severity then start time", async () => {
  const store = createStore();
  // 时间序：先 warning（多 mora），后 error（小假名）；输出必须 error 在前。
  const { stored } = createStoredContext(store, {
    notes: [
      { onsetBlick: 0, durationBlick: Q, lyrics: "とう" },
      { onsetBlick: Q, durationBlick: Q, lyrics: "ょう" },
    ],
  });
  const result = await createService(store).validate({
    contextId: stored.contextId,
    checks: ["japaneseMora"],
  });
  assert.equal(result.issues[0].kind, "isolated_small_kana");
  assert.equal(result.issues[1].kind, "note_overfilled_morae");
  assert.equal(result.summary.issueCount, 2);
});

test("the issue list is capped at 100 with a truncation warning", async () => {
  // 响应形状由契约规定，不由调用方选择（§4.4）：超出上限的完整明细通过 Artifact
  // 读取，而不是让调用方传一个开关把同一份数据要第二遍。
  const store = createStore();
  const count = 130;
  const notes = Array.from({ length: count }, (_, index) => ({
    onsetBlick: index * Q,
    durationBlick: Q,
    lyrics: "とう", // 每个音符一个多 mora warning
  }));
  const { stored } = createStoredContext(store, { notes });
  const result = await createService(store).validate({
    contextId: stored.contextId,
    checks: ["japaneseMora"],
  });
  // 摘要覆盖全部 issue；被截断的只是逐项列表。
  assert.equal(result.summary.issueCount, count);
  assert.equal(result.issues.length, 100);
  assert.equal(result.issuesTruncated, true);
  assert.ok(result.warnings.some((warning) => warning.code === "ISSUES_TRUNCATED"));
});

test("validator resolves contexts honestly across error paths", async () => {
  const store = createStore();
  const service = createService(store);
  await assert.rejects(
    service.validate({ contextId: "ctx_missing" }),
    (error) => error.code === "UNKNOWN_CONTEXT"
  );
  const empty = createStoredContext(store, { notes: [] });
  await assert.rejects(
    service.validate({ contextId: empty.stored.contextId }),
    (error) => error.code === "NOTES_NOT_CAPTURED"
  );
  const ambiguous = createStoredContext(store, {
    notes: [{ onsetBlick: 0, durationBlick: Q, lyrics: "la" }],
    extraOccurrenceWithNotes: true,
  });
  await assert.rejects(
    service.validate({ contextId: ambiguous.stored.contextId }),
    (error) => {
      assert.equal(error.code, "AMBIGUOUS_CONTEXT");
      assert.equal(error.details.candidates.length, 2);
      return true;
    }
  );
});

test("validator rejects malformed requests before touching the store", async () => {
  const store = createStore();
  const service = createService(store);
  for (const request of [
    {},
    { contextId: "" },
    { contextId: "ctx", checks: [] },
    { contextId: "ctx", checks: ["bogus"] },
    { contextId: "ctx", bogus: true },
  ]) {
    await assert.rejects(service.validate(request), (error) => error.code === "INVALID_ARGUMENTS");
  }
});
