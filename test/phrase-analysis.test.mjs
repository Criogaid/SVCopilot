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
  const occurrenceId = `${stored.contextId}:t:0:r:0`;
  const noteFingerprints = notes.map((note, index) => ({
    indexInGroup: index,
    onsetBlick: note.onsetBlick,
    durationBlick: note.durationBlick,
    pitch: note.pitch,
    lyrics: note.lyrics ?? `n${index}`,
    phonemesOverride: "",
    languageOverride: "",
    detuneCents: note.detuneCents ?? 0,
    noteId: `${occurrenceId}:n:${index}`,
  }));
  stored.context.occurrences.push({
    occurrenceId,
    trackIndex: 0,
    groupIndex: 0,
    targetGroupUuid: "uuid-analysis-test",
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
      targetGroupUuid: "uuid-analysis-test",
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
  return new PhraseAnalysisService({ store, now: () => 2000 });
}

// §13.3 fixture 的精确音高/时值：br when i see あ さ ひ の き ら め き。
// see 为 5 拍 climax，其后 1 拍休止分开日语乐句（黑盒审计的人工乐理判读一致）。
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

test("fixture melody ranks B major first with the relative minor as a live alternative", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, { notes: fixtureNotes() });
  const result = await createService(store).analyze({ contextId: stored.contextId });
  assert.equal(result.ok, true);
  const key = result.key;
  // 排序器契约：B 大调居首；5 拍属音长音让 F# 大调紧随其后——K-S 对长属音的
  // 已知歧义被如实暴露为第二候选，而不是被隐藏。
  assert.equal(key.bestCandidate.tonic, "B");
  assert.equal(key.bestCandidate.mode, "major");
  assert.ok(key.bestCandidate.correlation > 0.5);
  assert.ok(key.marginFromNext > 0);
  assert.equal(key.candidates[1].tonic, "F#");
  assert.equal(key.candidates[1].mode, "major");
  assert.equal(key.confidence.kind, "normalized_margin");
  assert.equal(key.confidence.calibrated, false);
  assert.equal(key.enharmonicSpelling, "sharps_only");
  assert.equal(result.provenance.keyProfiles, "krumhansl_kessler_1982");
});

test("scale degrees mark the fixture as fully diatonic in B major", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, { notes: fixtureNotes() });
  const result = await createService(store).analyze({
    contextId: stored.contextId,
    include: ["scaleDegrees"],
  });
  assert.equal(result.key, undefined); // 未请求 key 段落，但 scaleDegrees 内部使用它
  assert.equal(result.scaleDegrees.relativeTo.tonic, "B");
  assert.equal(result.scaleDegrees.items.length, 12);
  assert.ok(result.scaleDegrees.items.every((item) => item.inScale));
  assert.deepEqual(result.scaleDegrees.nonDiatonicNoteIds, []);
  const first = result.scaleDegrees.items[0];
  assert.equal(first.pitchClass, "B");
  assert.equal(first.degree, 1);
});

test("non-diatonic notes are flagged explicitly", async () => {
  const store = createStore();
  const notes = fixtureNotes();
  notes.push({ onsetBlick: 16934400000, durationBlick: Q, pitch: 60, lyrics: "x" }); // C 自然音
  const { stored, occurrenceId } = createStoredContext(store, { notes });
  const result = await createService(store).analyze({
    contextId: stored.contextId,
    include: ["key", "scaleDegrees"],
  });
  // 加入一个外音就足以让本就险胜的 B/F# 排名翻转——K-S 在短旋律上的真实敏感度，
  // 如实按当前最佳候选（F# 大调）报告音级；E4 与 C 都是 F# 大调外音。
  assert.equal(result.key.bestCandidate.tonic, "F#");
  assert.equal(result.key.bestCandidate.mode, "major");
  assert.ok(result.scaleDegrees.nonDiatonicNoteIds.includes(`${occurrenceId}:n:12`));
  assert.deepEqual(result.scaleDegrees.nonDiatonicNoteIds, [
    `${occurrenceId}:n:5`,
    `${occurrenceId}:n:12`,
  ]);
});

test("phrase segmentation finds the climax and the one-beat rest", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, { notes: fixtureNotes() });
  const result = await createService(store).analyze({
    contextId: stored.contextId,
    include: ["phrases"],
  });
  assert.equal(result.phrases.items.length, 2);
  const [first, second] = result.phrases.items;
  assert.equal(first.noteCount, 4);
  assert.equal(first.climax.lyrics, "see");
  assert.equal(first.climax.pitch, 66);
  assert.equal(first.restAfterBlick, Q);
  assert.equal(second.noteCount, 8);
  assert.equal(second.restAfterBlick, null);
  assert.equal(result.phrases.phraseGapQuarter, 1);
});

test("responseMode governs scaleDegrees size: compact summarizes, standard caps, verbose is full", async () => {
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

  const compact = await service.analyze({
    contextId: stored.contextId,
    include: ["scaleDegrees"],
    responseMode: "compact",
  });
  assert.equal(compact.scaleDegrees.items, undefined);
  assert.equal(compact.scaleDegrees.summary.noteCount, count);
  assert.ok(compact.scaleDegrees.summary.degreeHistogram);

  const standard = await service.analyze({
    contextId: stored.contextId,
    include: ["scaleDegrees"],
  });
  assert.equal(standard.scaleDegrees.items.length, 100);
  assert.equal(standard.scaleDegrees.itemsTruncated, true);
  assert.ok(standard.warnings.some((warning) => warning.code === "SCALE_DEGREES_TRUNCATED"));

  const verbose = await service.analyze({
    contextId: stored.contextId,
    include: ["scaleDegrees"],
    responseMode: "verbose",
  });
  assert.equal(verbose.scaleDegrees.items.length, count);
  assert.equal(verbose.scaleDegrees.itemsTruncated, false);
  assert.ok(!verbose.warnings.some((warning) => warning.code === "SCALE_DEGREES_TRUNCATED"));

  // 修复前 compact 与 verbose 逐字节相同；现在 compact 明显更小。
  assert.ok(JSON.stringify(compact).length < JSON.stringify(verbose).length);
});

test("responseMode caps phrases.items with a truncation warning", async () => {
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

  const standard = await service.analyze({ contextId: stored.contextId, include: ["phrases"] });
  assert.equal(standard.phrases.count, count);
  assert.equal(standard.phrases.items.length, 100);
  assert.equal(standard.phrases.itemsTruncated, true);
  assert.equal(standard.phrases.summary.totalNotes, count);
  assert.ok(standard.warnings.some((warning) => warning.code === "PHRASES_TRUNCATED"));

  // compact 契约（R3）：不展开逐乐句列表，只给 count + 聚合摘要，且 payload 必须真的更小。
  const compact = await service.analyze({
    contextId: stored.contextId,
    include: ["phrases"],
    responseMode: "compact",
  });
  assert.equal(compact.phrases.items, undefined);
  assert.equal(compact.phrases.count, count);
  assert.equal(compact.phrases.summary.totalNotes, count);
  assert.equal(compact.phrases.summary.noteCount.max, 1);
  assert.ok(!compact.warnings.some((warning) => warning.code === "PHRASES_TRUNCATED"));
  assert.ok(JSON.stringify(compact).length < JSON.stringify(standard).length);

  const verbose = await service.analyze({
    contextId: stored.contextId,
    include: ["phrases"],
    responseMode: "verbose",
  });
  assert.equal(verbose.phrases.items.length, count);
  assert.equal(verbose.phrases.itemsTruncated, false);
});

test("statistics report register, intervals, rhythm, and rests", async () => {
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
  assert.equal(statistics.intervals.count, 11);
  assert.equal(statistics.rhythm.sustainCount, 1); // see = 5 拍
  assert.equal(statistics.rests.count, 1);
  assert.equal(statistics.rests.totalQuarter, 1);
  assert.equal(statistics.rests.longestQuarter, 1);
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
      assert.equal(error.details.candidateOccurrences.length, 2);
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
    { contextId: "ctx_x", responseMode: "loud" },
  ]) {
    await assert.rejects(service.analyze(request), (error) => error.code === "INVALID_ARGUMENTS");
  }
});
