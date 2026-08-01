import assert from "node:assert/strict";
import test from "node:test";

import { PhraseAnalysisService } from "../server/src/phrase-analysis.js";
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
  const noteFingerprints = notes.map((note, index) => ({
    indexInGroup: index,
    onsetBlick: note.onsetBlick,
    durationBlick: note.durationBlick,
    pitch: note.pitch,
    lyrics: note.lyrics ?? `n${index}`,
    phonemesOverride: "",
    languageOverride: "",
    detuneCents: note.detuneCents ?? 0,
  }));
  stored.context.occurrences.push({
    occurrence: 0,
    trackIndex: 0,
    groupIndex: 0,
    targetGroupUuid: "uuid-analysis-test",
    timeOffsetBlick: 0,
    pitchOffsetSemitone: 0,
    sharedTargetOccurrences: [0],
    noteFingerprints,
  });
  if (extraOccurrenceWithNotes) {
    stored.context.occurrences.push({
      occurrence: 1,
      trackIndex: 0,
      groupIndex: 1,
      targetGroupUuid: "uuid-analysis-test",
      timeOffsetBlick: 0,
      pitchOffsetSemitone: 0,
      sharedTargetOccurrences: [0, 1],
      noteFingerprints: noteFingerprints.map((fingerprint) => ({ ...fingerprint })),
    });
  }
  stored.context.quarterBlick = Q;
  stored.context.meterMarks = [{ position: 0, positionBlick: 0, numerator: 4, denominator: 4 }];
  stored.context.tempoMarks = [{ positionBlick: 0, positionSeconds: 0, bpm: 120 }];
  return { stored };
}

function createService(store) {
  return new PhraseAnalysisService({ store, now: () => 2000 });
}

// §13.3 fixture 的精确音高/时值：br when i see あ さ ひ の き ら め き。
// see 为 5 拍 climax，其后 1 拍休止分开日语乐句（黑盒审计的人工乐理判读一致）。
// br 是呼吸事件：排除在调性/音级/乐句/统计之外，单独进 breathEvents。
function fixtureNotes() {
  const rows = [
    [5644800000, 705600000, 59, "br"],
    [6350400000, 705600000, 59, "when"],
    [7056000000, 705600000, 63, "i"],
    [7761600000, 3528000000, 66, "see"],
    [11995200000, 705600000, 63, "あ"],
    [12700800000, 705600000, 64, "さ"],
    [13406400000, 705600000, 61, "ひ"],
    [14112000000, 352800000, 59, "の"],
    [14464800000, 352800000, 61, "き"],
    [14817600000, 705600000, 63, "ら"],
    [15523200000, 705600000, 54, "め"],
    [16228800000, 705600000, 56, "き"],
  ];
  return rows.map(([onsetBlick, durationBlick, pitch, lyrics]) => ({
    onsetBlick,
    durationBlick,
    pitch,
    lyrics,
  }));
}

test("fixture melody ranks F# major first once the breath note stops padding the histogram", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, { notes: fixtureNotes() });
  const result = await createService(store).analyze({ contextId: stored.contextId });
  assert.equal(result.ok, true);
  // br 修复前：br 的名义 B 音高给直方图垫了 1 拍 B，让 B 大调以 0.787 险胜 F# 大调 0.777。
  // 排除呼吸后（11 个旋律音符），5 拍 F# 长音主导时值加权直方图，K-S 排序如实翻转：
  // F# 大调居首，B 大调跌至第三——短旋律的关系调歧义仍在 candidates 中暴露。
  assert.equal(result.noteCount, 11);
  assert.equal(result.breathCount, 1);
  const key = result.key;
  assert.equal(key.bestCandidate.tonic, "F#");
  assert.equal(key.bestCandidate.mode, "major");
  assert.ok(key.bestCandidate.correlation > 0.5);
  assert.ok(key.marginFromNext > 0);
  assert.equal(key.candidates[1].tonic, "D#");
  assert.equal(key.candidates[1].mode, "minor");
  assert.equal(key.candidates[2].tonic, "B");
  assert.equal(key.candidates[2].mode, "major");
  assert.equal(key.confidence.kind, "normalized_margin");
  assert.equal(key.confidence.calibrated, false);
  assert.equal(key.enharmonicSpelling, "sharps_only");
  assert.equal(result.provenance.keyProfiles, "krumhansl_kessler_1982");
  assert.equal(
    result.provenance.breathNotes,
    "excluded_from_all_musical_statistics_reported_as_breathEvents"
  );
});

test("scale degrees cover melodic notes only and expose the E natural against F# major", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, { notes: fixtureNotes() });
  const result = await createService(store).analyze({
    contextId: stored.contextId,
    include: ["scaleDegrees"],
  });
  assert.equal(result.key, undefined); // 未请求 key 段落，但 scaleDegrees 内部使用它
  assert.equal(result.scaleDegrees.relativeTo.tonic, "F#");
  // br 不再出现在音级列表里：11 个旋律音符，且没有任何 item 的歌词是 br。
  assert.equal(result.scaleDegrees.items.length, 11);
  assert.ok(result.scaleDegrees.items.every((item) => item.lyrics !== "br"));
  // F# 大调下 さ(E4) 是外音（E# 才是调内音）——相对当前最佳候选如实标记。
  const chromatic = result.scaleDegrees.items.filter((item) => !item.inScale);
  assert.equal(chromatic.length, 1);
  assert.equal(chromatic[0].lyrics, "さ");
  const first = result.scaleDegrees.items[0];
  assert.equal(first.lyrics, "when");
  assert.equal(first.pitchClass, "B");
  assert.equal(first.degree, 4);
});

test("non-diatonic notes are flagged explicitly", async () => {
  const store = createStore();
  const notes = fixtureNotes();
  notes.push({ onsetBlick: 16934400000, durationBlick: Q, pitch: 60, lyrics: "x" }); // C 自然音
  const { stored } = createStoredContext(store, { notes });
  const result = await createService(store).analyze({
    contextId: stored.contextId,
    include: ["key", "scaleDegrees"],
  });
  // 排除 br 后 F# 大调本就居首；加入 C 自然音不再翻转排名，只是新增一个外音。
  // E4 与 C 都是 F# 大调外音；身份是组内 index，br 占位不重新编号。
  assert.equal(result.key.bestCandidate.tonic, "F#");
  assert.equal(result.key.bestCandidate.mode, "major");
  assert.ok(result.scaleDegrees.nonDiatonicNotes.includes(12));
  assert.deepEqual(result.scaleDegrees.nonDiatonicNotes, [5, 12]);
});

test("phrase segmentation finds the climax and the one-beat rest without counting the breath", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, { notes: fixtureNotes() });
  const result = await createService(store).analyze({
    contextId: stored.contextId,
    include: ["phrases"],
  });
  assert.equal(result.phrases.items.length, 2);
  const [first, second] = result.phrases.items;
  // br 修复前 noteCount 是 4（br 被算进第一乐句）；呼吸不是旋律音符，如实数 3。
  assert.equal(first.noteCount, 3);
  assert.equal(first.firstNote, 1); // 乐句从 when 开始，不从 br
  assert.equal(first.climax.lyrics, "see");
  assert.equal(first.climax.pitch, 66);
  assert.equal(first.restAfterBlick, Q);
  assert.equal(second.noteCount, 8);
  assert.equal(second.restAfterBlick, null);
  assert.equal(result.phrases.phraseGapQuarter, 1);
  assert.equal(result.phrases.summary.totalNotes, 11);
  // 呼吸事件单独返回，带名义音高与位置。
  assert.equal(result.breathEvents.count, 1);
  const breath = result.breathEvents.items[0];
  assert.equal(breath.lyrics, "br");
  assert.equal(breath.nominalPitch, 59);
  assert.equal(breath.startBlick, 5644800000);
  assert.equal(breath.durationQuarter, 1);
});

test("scaleDegrees keeps the summary and caps items at one budget", async () => {
  const store = createStore();
  const count = 130;
  const scale = [59, 61, 63, 64, 66, 68, 70];
  const notes = Array.from({ length: count }, (_, index) => ({
    onsetBlick: index * Q,
    durationBlick: Q,
    pitch: scale[index % scale.length],
    lyrics: `n${index}`,
  }));
  const { stored } = createStoredContext(store, { notes });
  const service = createService(store);

  // 单一响应形状（§4.4 规则 14）：不再有 compact/standard/verbose 三档。
  // 汇总恒返回，逐项按同一预算截断并如实标注。
  const result = await service.analyze({
    contextId: stored.contextId,
    include: ["scaleDegrees"],
  });
  assert.equal(result.scaleDegrees.summary.noteCount, count);
  assert.ok(result.scaleDegrees.summary.degreeHistogram);
  assert.equal(result.scaleDegrees.items.length, 100);
  assert.equal(result.scaleDegrees.itemsTruncated, true);
  assert.ok(result.warnings.some((warning) => warning.code === "SCALE_DEGREES_TRUNCATED"));

  // 截断必须是如实的：nonDiatonicNotes 覆盖全部音符，不受逐项预算影响。
  assert.equal(
    result.scaleDegrees.summary.inScaleCount + result.scaleDegrees.summary.nonDiatonicCount,
    count
  );
});

test("phrases keeps the aggregate summary and caps items with a truncation warning", async () => {
  const store = createStore();
  const count = 130;
  const notes = Array.from({ length: count }, (_, index) => ({
    onsetBlick: index * 2 * Q, // 每个音符后留 1 拍休止 → 每音符自成一乐句
    durationBlick: Q,
    pitch: [59, 61][index % 2],
    lyrics: `n${index}`,
  }));
  const { stored } = createStoredContext(store, { notes });
  const service = createService(store);

  const result = await service.analyze({ contextId: stored.contextId, include: ["phrases"] });
  assert.equal(result.phrases.count, count);
  assert.equal(result.phrases.items.length, 100);
  assert.equal(result.phrases.itemsTruncated, true);
  assert.ok(result.warnings.some((warning) => warning.code === "PHRASES_TRUNCATED"));
  // 聚合摘要覆盖全部乐句，而不只是被返回的那 100 条——否则截断会让统计说谎。
  assert.equal(result.phrases.summary.totalNotes, count);
  assert.equal(result.phrases.summary.noteCount.max, 1);
});

test("statistics report register, intervals, rhythm, and rests over melodic notes only", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, { notes: fixtureNotes() });
  const result = await createService(store).analyze({
    contextId: stored.contextId,
    include: ["statistics"],
  });
  const statistics = result.statistics;
  assert.equal(statistics.register.minPitch, 54);
  assert.equal(statistics.register.maxPitch, 66);
  assert.equal(statistics.register.ambitusSemitones, 12);
  // br 修复前是 11（br→when 的假 0 度音程被计入）；11 个旋律音符只有 10 个音程。
  assert.equal(statistics.intervals.count, 10);
  assert.equal(statistics.rhythm.sustainCount, 1); // see = 5 拍
  assert.equal(statistics.rests.count, 1);
  assert.equal(statistics.rests.totalQuarter, 1);
  assert.equal(statistics.rests.longestQuarter, 1);
});

test("a breath between melodic notes contributes its gap as a rest, not an interval", async () => {
  const store = createStore();
  // a(1Q) br(1Q) b(1Q)：br 夹在两旋律音符中间。旋律序列是 a→b，
  // 音程只有 a→b 一个；a 与 b 之间的 2Q 空隙（含 br 时段）如实进 rests。
  const { stored } = createStoredContext(store, {
    notes: [
      { onsetBlick: 0, durationBlick: Q, pitch: 60, lyrics: "a" },
      { onsetBlick: Q, durationBlick: Q, pitch: 64, lyrics: "br" },
      { onsetBlick: 3 * Q, durationBlick: Q, pitch: 64, lyrics: "b" },
    ],
  });
  const result = await createService(store).analyze({
    contextId: stored.contextId,
    include: ["statistics", "phrases"],
  });
  assert.equal(result.noteCount, 2);
  assert.equal(result.breathCount, 1);
  assert.equal(result.statistics.intervals.count, 1);
  assert.equal(result.statistics.rests.count, 1);
  assert.equal(result.statistics.rests.longestQuarter, 2);
  // 3Q 空隙 >= 默认 1Q 阈值：呼吸位置照常成为乐句边界。
  assert.equal(result.phrases.count, 2);
  assert.equal(result.breathEvents.items[0].nominalPitch, 64);
});

test("only exact lowercase br is a breath event; suspicious variants remain melodic", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, {
    notes: [
      { onsetBlick: 0, durationBlick: Q, pitch: 60, lyrics: "BR" },
      { onsetBlick: Q, durationBlick: Q, pitch: 60, lyrics: " br " },
      { onsetBlick: 2 * Q, durationBlick: Q, pitch: 60, lyrics: "bright" }, // 只匹配整词
      { onsetBlick: 3 * Q, durationBlick: Q, pitch: 62, lyrics: "la" },
    ],
  });
  const result = await createService(store).analyze({ contextId: stored.contextId });
  assert.equal(result.inputNoteCount, 4);
  assert.equal(result.melodicNoteCount, 4);
  assert.equal(result.noteCount, 4);
  assert.equal(result.breathCount, 0);
  assert.equal(result.excludedEvents.count, 0);
  assert.equal(
    result.warnings.filter((warning) => warning.code === "SUSPICIOUS_SPECIAL_LYRIC_VARIANT")
      .length,
    2
  );
  assert.equal(result.provenance.breathDetection, "official_documented_special_lyric_br");
});

test("valid plus/minus continuation chains remain melodic evidence", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, {
    notes: [
      { onsetBlick: 0, durationBlick: Q, pitch: 60, lyrics: "ashame" },
      { onsetBlick: Q, durationBlick: Q, pitch: 62, lyrics: "+" },
      { onsetBlick: 2 * Q, durationBlick: Q, pitch: 64, lyrics: "-" },
      { onsetBlick: 3 * Q, durationBlick: Q, pitch: 65, lyrics: "-" },
    ],
  });
  const result = await createService(store).analyze({
    contextId: stored.contextId,
    include: ["statistics"],
  });
  assert.equal(result.inputNoteCount, 4);
  assert.equal(result.melodicNoteCount, 4);
  assert.equal(result.excludedEvents.count, 0);
  assert.equal(result.statistics.intervals.count, 3);
  assert.ok(!result.warnings.some((warning) => warning.code.startsWith("ORPHAN_")));
});

test("orphan continuations and standalone apostrophe are excluded with structured evidence", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, {
    notes: [
      { onsetBlick: 0, durationBlick: Q, pitch: 72, lyrics: "+" },
      { onsetBlick: Q, durationBlick: Q, pitch: 71, lyrics: "-" },
      { onsetBlick: 2 * Q, durationBlick: Q, pitch: 70, lyrics: "'" },
      { onsetBlick: 3 * Q, durationBlick: Q, pitch: 60, lyrics: "word" },
    ],
  });
  const result = await createService(store).analyze({
    contextId: stored.contextId,
    include: ["statistics"],
  });
  assert.equal(result.inputNoteCount, 4);
  assert.equal(result.melodicNoteCount, 1);
  assert.equal(result.breathCount, 0);
  assert.equal(result.excludedEvents.count, 3);
  assert.deepEqual(result.excludedEvents.byRole, {
    syllable_continuation: 1,
    phonation_continuation: 1,
    unknown_special: 1,
  });
  assert.equal(result.statistics.register.minPitch, 60);
  assert.equal(result.statistics.register.maxPitch, 60);
  assert.ok(result.warnings.some((warning) => warning.code === "ORPHAN_PLUS"));
  assert.ok(
    result.warnings.some(
      (warning) => warning.code === "ORPHAN_PHONATION_CONTINUATION"
    )
  );
  assert.ok(
    result.warnings.some(
      (warning) => warning.code === "STANDALONE_APOSTROPHE_UNCALIBRATED"
    )
  );
});

test("an all-breath range fails with NO_MELODIC_NOTES instead of inventing statistics", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, {
    notes: [
      { onsetBlick: 0, durationBlick: Q, pitch: 60, lyrics: "br" },
      { onsetBlick: Q, durationBlick: Q, pitch: 62, lyrics: "br" },
    ],
  });
  await assert.rejects(
    createService(store).analyze({ contextId: stored.contextId }),
    (error) => error.code === "NO_MELODIC_NOTES"
  );
});

test("breath events report their count and cap items at one budget", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, { notes: fixtureNotes() });
  const result = await createService(store).analyze({ contextId: stored.contextId });
  assert.equal(result.breathCount, 1);
  assert.equal(result.breathEvents.count, 1);
  // 单一形状：小规模下逐项完整返回，不需要调用方选档。
  assert.equal(result.breathEvents.items.length, 1);
  assert.equal(result.breathEvents.itemsTruncated, false);
});

test("breath events beyond the item budget are capped with an honest warning", async () => {
  const store = createStore();
  const breathCount = 130;
  const notes = [
    { onsetBlick: 0, durationBlick: Q, pitch: 60, lyrics: "lead" },
    ...Array.from({ length: breathCount }, (_, index) => ({
      onsetBlick: (index + 1) * Q,
      durationBlick: Q,
      pitch: 60,
      lyrics: "br",
    })),
  ];
  const { stored } = createStoredContext(store, { notes });

  const result = await createService(store).analyze({
    contextId: stored.contextId,
    include: ["statistics"],
  });
  // count 必须是全量事实；items 才是被预算截断的那一部分。混同两者会让"呼吸有多少"
  // 随响应预算变化。
  assert.equal(result.breathEvents.count, breathCount);
  assert.equal(result.breathEvents.items.length, 100);
  assert.equal(result.breathEvents.itemsTruncated, true);
  assert.ok(result.warnings.some((warning) => warning.code === "BREATH_EVENTS_TRUNCATED"));
});

test("uniform pitch classes degrade honestly instead of inventing a key", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, {
    notes: [
      { onsetBlick: 0, durationBlick: Q, pitch: 60 },
      { onsetBlick: Q, durationBlick: Q, pitch: 72 }, // 同音级不同八度
    ],
  });
  const result = await createService(store).analyze({
    contextId: stored.contextId,
    include: ["key", "scaleDegrees"],
  });
  assert.equal(result.key, null);
  assert.equal(result.scaleDegrees, null);
  assert.ok(result.warnings.some((warning) => warning.code === "INSUFFICIENT_PITCH_VARIETY"));
});

test("analysis resolves contexts honestly across error paths", async () => {
  const store = createStore();
  const service = createService(store);
  await assert.rejects(
    service.analyze({ contextId: "ctx_missing" }),
    (error) => error.code === "UNKNOWN_CONTEXT"
  );
  const noNotes = createStoredContext(store, { notes: [] });
  await assert.rejects(
    service.analyze({ contextId: noNotes.stored.contextId }),
    (error) => error.code === "NOTES_NOT_CAPTURED"
  );
  const ambiguous = createStoredContext(store, {
    notes: fixtureNotes(),
    extraOccurrenceWithNotes: true,
  });
  await assert.rejects(
    service.analyze({ contextId: ambiguous.stored.contextId }),
    (error) => {
      assert.equal(error.code, "AMBIGUOUS_CONTEXT");
      // 候选是 ordinal 列表：模型拿到的就是它下一步该填进 `occurrence` 的值。
      assert.deepEqual(error.details.candidates, [0, 1]);
      return true;
    }
  );
});

test("analysis validates request shape before touching the store", async () => {
  const store = createStore();
  const service = createService(store);
  for (const request of [
    {},
    { contextId: "ctx_x", include: [] },
    { contextId: "ctx_x", include: ["bogus"] },
    { contextId: "ctx_x", phraseGapQuarter: 0 },
    { contextId: "ctx_x", bogus: true },
    { contextId: "ctx_x", responseMode: "compact" },
  ]) {
    await assert.rejects(service.analyze(request), (error) => error.code === "INVALID_ARGUMENTS");
  }
});
