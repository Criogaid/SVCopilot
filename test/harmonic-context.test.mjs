import assert from "node:assert/strict";
import test from "node:test";

import { PhraseAnalysisService } from "../server/src/phrase-analysis.js";
import { SnapshotStore } from "../server/src/snapshot.js";

// P1-A 验收：和声语境、强拍与终止式分析。
//
// 核心断言贯穿全文：只观察到单旋律，因此所有和弦/终止式结论必须声明
// evidenceScope:"melody_only"，歧义案例必须返回多个候选，且呼吸音符绝不进入统计。

const Q = 705600000;

function createStore() {
  return new SnapshotStore({ now: () => 1000 });
}

function createContext(store, notes, options = {}) {
  const { meterMarks = [{ position: 0, positionBlick: 0, numerator: 4, denominator: 4 }] } = options;
  const stored = store.create({
    epoch: 1,
    scope: { kind: "range" },
    observedAt: new Date(1000).toISOString(),
    context: { kind: "range", occurrences: [] },
  });
  const occurrenceId = `${stored.contextId}:t:0:r:0`;
  stored.context.occurrences.push({
    occurrenceId,
    trackIndex: 0,
    groupIndex: 0,
    targetGroupUuid: "uuid-harmonic",
    timeOffsetBlick: 0,
    pitchOffsetSemitone: 0,
    sharedTargetOccurrences: [occurrenceId],
    noteFingerprints: notes.map((note, index) => ({
      indexInGroup: index,
      onsetBlick: note.onsetBlick,
      durationBlick: note.durationBlick,
      pitch: note.pitch,
      lyrics: note.lyrics ?? "a",
      phonemesOverride: "",
      languageOverride: "",
      detuneCents: 0,
      noteId: `${occurrenceId}:n:${index}`,
    })),
  });
  stored.context.quarterBlick = Q;
  if (meterMarks) stored.context.meterMarks = meterMarks;
  stored.context.tempoMarks = [{ positionBlick: 0, positionSeconds: 0, bpm: 120 }];
  stored.snapshotToken = `snap_${stored.contextId}`;
  return { stored, occurrenceId };
}

function analyzer(store) {
  return new PhraseAnalysisService({ store, now: () => 2000 });
}

const HARMONIC_INCLUDES = ["metricalRoles", "chordCandidates", "cadence", "tensionResolution"];

// I - IV - V - I，每小节一个分解和弦，末尾长主音：明确的正格终止。
const CLEAR_CADENCE = [
  { onsetBlick: 0, durationBlick: Q, pitch: 60 },
  { onsetBlick: Q, durationBlick: Q, pitch: 64 },
  { onsetBlick: 2 * Q, durationBlick: 2 * Q, pitch: 67 },
  { onsetBlick: 4 * Q, durationBlick: Q, pitch: 65 },
  { onsetBlick: 5 * Q, durationBlick: Q, pitch: 69 },
  { onsetBlick: 6 * Q, durationBlick: 2 * Q, pitch: 72 },
  { onsetBlick: 8 * Q, durationBlick: Q, pitch: 67 },
  { onsetBlick: 9 * Q, durationBlick: Q, pitch: 71 },
  { onsetBlick: 10 * Q, durationBlick: 2 * Q, pitch: 74 },
  { onsetBlick: 12 * Q, durationBlick: 4 * Q, pitch: 72 },
];

test("harmonic sections are opt-in and never inflate the default response", async () => {
  const store = createStore();
  const { stored } = createContext(store, CLEAR_CADENCE);
  const result = await analyzer(store).analyze({ contextId: stored.contextId });

  // 默认 include 仍是基础四项：新增 section 不能在调用方没要求时悄悄出现。
  assert.ok(result.key);
  assert.ok(result.phrases);
  assert.ok(result.statistics);
  for (const name of HARMONIC_INCLUDES) {
    assert.equal(result[name], undefined, `${name} must be opt-in`);
  }
  assert.equal(result.provenance.harmonicContext, undefined);
});

test("every harmonic conclusion declares that only a melody was observed", async () => {
  const store = createStore();
  const { stored } = createContext(store, CLEAR_CADENCE);
  const result = await analyzer(store).analyze({
    contextId: stored.contextId,
    include: ["key", ...HARMONIC_INCLUDES],
  });

  assert.equal(result.provenance.harmonicContext.evidenceScope, "melody_only");
  assert.match(
    result.provenance.harmonicContext.evidenceScopeNote,
    /not an observation of the actual harmony/i
  );
  assert.equal(result.chordCandidates.summary.evidenceScope, "melody_only");
  assert.equal(result.cadence.evidenceScope, "melody_only");
  assert.equal(result.tensionResolution.evidenceScope, "melody_only");
  for (const window of result.chordCandidates.items) {
    assert.equal(window.evidenceScope, "melody_only");
  }
  // confidence 是排序分数，不是概率。
  assert.equal(
    result.provenance.harmonicContext.confidenceKind,
    "heuristic_ranking_not_probability"
  );
});

test("a clear I-IV-V-I melody yields the expected chord and cadence reading", async () => {
  const store = createStore();
  const { stored } = createContext(store, CLEAR_CADENCE);
  const result = await analyzer(store).analyze({
    contextId: stored.contextId,
    include: ["key", "chordCandidates", "cadence"],
  });

  assert.equal(result.key.bestCandidate.tonic, "C");
  assert.equal(result.key.bestCandidate.mode, "major");
  assert.equal(result.chordCandidates.status, "succeeded");
  assert.equal(result.chordCandidates.items.length, 4);
  assert.deepEqual(
    result.chordCandidates.items.slice(0, 3).map((window) => window.candidates[0].symbol),
    ["C", "F", "G"]
  );
  // 每个窗口都报告它凭哪些音判断，以及哪些和弦音根本没被旋律触及。
  const first = result.chordCandidates.items[0];
  assert.deepEqual([...first.pitchClassesPresent].sort(), ["C", "E", "G"]);
  assert.deepEqual(first.candidates[0].chordTonesAbsent, []);
  assert.ok(first.noteIds.length >= 3);

  assert.equal(result.cadence.status, "succeeded");
  const ending = result.cadence.items[result.cadence.items.length - 1];
  assert.equal(ending.finalScaleDegree.degree, 1);
  assert.equal(ending.candidates[0].type, "authentic");
  assert.ok(ending.candidates[0].rationale.length > 0);
  assert.equal(ending.confidenceKind, "heuristic_ranking_not_probability");
});

test("an ambiguous window returns several candidates instead of one asserted fact", async () => {
  const store = createStore();
  // 整段只有一个音级：无法区分大三、小三或任何含该音的和弦。
  const { stored } = createContext(store, [
    { onsetBlick: 0, durationBlick: 2 * Q, pitch: 60 },
    { onsetBlick: 2 * Q, durationBlick: 2 * Q, pitch: 72 },
  ]);
  const result = await analyzer(store).analyze({
    contextId: stored.contextId,
    include: ["chordCandidates"],
  });

  const window = result.chordCandidates.items[0];
  assert.ok(window.candidates.length >= 2, "an ambiguous window must offer alternatives");
  assert.equal(window.ambiguous, true);
  assert.ok(window.runnerUpGap !== null);
  // 只有一个音级时，多数和弦音是被"猜"出来的，必须如实列出。
  assert.ok(window.candidates[0].chordTonesAbsent.length >= 1);
  assert.ok(result.warnings.some((warning) => warning.code === "CHORD_CANDIDATES_AMBIGUOUS"));
});

test("chromatic notes are reported as non-chord tones and tracked for resolution", async () => {
  const store = createStore();
  // C 大调中插入 F#（调外），随后级进解决到 G。
  const { stored } = createContext(store, [
    { onsetBlick: 0, durationBlick: Q, pitch: 60 },
    { onsetBlick: Q, durationBlick: Q, pitch: 64 },
    { onsetBlick: 2 * Q, durationBlick: Q, pitch: 66 },
    { onsetBlick: 3 * Q, durationBlick: Q, pitch: 67 },
    { onsetBlick: 4 * Q, durationBlick: 4 * Q, pitch: 72 },
  ]);
  const result = await analyzer(store).analyze({
    contextId: stored.contextId,
    include: ["key", "chordCandidates", "tensionResolution"],
  });

  const window = result.chordCandidates.items[0];
  assert.ok(window.pitchClassesPresent.includes("F#"));
  // F# 相对最高分候选是非和弦音，必须显式列出而不是被吞掉。
  assert.ok(
    window.candidates.some((candidate) => candidate.nonChordTones.length > 0),
    "a chromatic pitch must surface as a non-chord tone somewhere in the ranking"
  );

  const chromatic = result.tensionResolution.items.find((item) =>
    item.kind.startsWith("chromatic")
  );
  assert.ok(chromatic, "the chromatic note must produce a tension event");
  assert.equal(chromatic.resolved, true);
  assert.equal(chromatic.fromScaleDegree.nonDiatonic, true);
  // 必须同时给出前后 noteId 与实际半音运动。
  assert.ok(chromatic.fromNoteId);
  assert.ok(chromatic.toNoteId);
  assert.equal(chromatic.motionSemitone, 1);
  assert.equal(chromatic.motionDirection, "up");
});

test("an anacrusis is detected instead of being read as a downbeat", async () => {
  const store = createStore();
  // 第一个音落在第 4 拍（弱起），随后正拍进入。
  const { stored } = createContext(store, [
    { onsetBlick: 3 * Q, durationBlick: Q, pitch: 67 },
    { onsetBlick: 4 * Q, durationBlick: Q, pitch: 72 },
    { onsetBlick: 5 * Q, durationBlick: Q, pitch: 71 },
    { onsetBlick: 6 * Q, durationBlick: 2 * Q, pitch: 72 },
  ]);
  const result = await analyzer(store).analyze({
    contextId: stored.contextId,
    include: ["metricalRoles"],
  });

  assert.equal(result.metricalRoles.status, "succeeded");
  assert.ok(result.metricalRoles.summary.anacrusis);
  assert.equal(result.metricalRoles.summary.anacrusis.present, true);
  assert.equal(result.metricalRoles.summary.anacrusis.beat, 4);
  const [first, second] = result.metricalRoles.items;
  assert.equal(first.role, "weak");
  assert.equal(second.role, "downbeat");
  assert.equal(second.weight, 1);
});

test("an atonal fragment still returns ranked alternatives rather than a false certainty", async () => {
  const store = createStore();
  // 半音阶片段：没有任何和弦模板能干净覆盖。
  const { stored } = createContext(store, [
    { onsetBlick: 0, durationBlick: Q, pitch: 60 },
    { onsetBlick: Q, durationBlick: Q, pitch: 61 },
    { onsetBlick: 2 * Q, durationBlick: Q, pitch: 62 },
    { onsetBlick: 3 * Q, durationBlick: Q, pitch: 63 },
    { onsetBlick: 4 * Q, durationBlick: Q, pitch: 64 },
    { onsetBlick: 5 * Q, durationBlick: Q, pitch: 65 },
    { onsetBlick: 6 * Q, durationBlick: Q, pitch: 66 },
    { onsetBlick: 7 * Q, durationBlick: Q, pitch: 67 },
  ]);
  const result = await analyzer(store).analyze({
    contextId: stored.contextId,
    include: ["key", "chordCandidates", "cadence"],
  });

  for (const window of result.chordCandidates.items) {
    assert.ok(window.candidates.length >= 2);
    // 半音阶下没有任何候选能取得高覆盖率；非和弦音比例必须可见。
    assert.ok(window.candidates[0].nonChordWeightRatio > 0);
    assert.ok(window.candidates[0].score < 1);
  }
  // 终止式仍会给出排序，但必须暴露它建立在启发式调性之上。
  assert.equal(result.cadence.keyIsHeuristic, true);
});

test("breath notes never enter harmonic statistics", async () => {
  const store = createStore();
  const withBreath = [
    { onsetBlick: 0, durationBlick: Q, pitch: 60 },
    { onsetBlick: Q, durationBlick: Q, pitch: 64 },
    // 呼吸音符带一个会污染和弦判断的名义音高。
    { onsetBlick: 2 * Q, durationBlick: Q, pitch: 61, lyrics: "br" },
    { onsetBlick: 3 * Q, durationBlick: Q, pitch: 67 },
  ];
  const { stored } = createContext(store, withBreath);
  const result = await analyzer(store).analyze({
    contextId: stored.contextId,
    include: ["metricalRoles", "chordCandidates", "tensionResolution"],
  });

  const window = result.chordCandidates.items[0];
  assert.ok(!window.pitchClassesPresent.includes("C#"), "breath pitch must not enter the histogram");
  assert.deepEqual([...window.pitchClassesPresent].sort(), ["C", "E", "G"]);
  assert.equal(result.metricalRoles.summary.noteCount, 3);
  for (const item of result.metricalRoles.items) {
    assert.ok(!item.noteId.endsWith(":n:2"), "the breath note must not get a metrical role");
  }
  for (const event of result.tensionResolution.items ?? []) {
    assert.ok(!event.fromNoteId.endsWith(":n:2"));
    assert.ok(!event.toNoteId.endsWith(":n:2"));
  }
});

test("a leading tone that does not resolve is reported as unresolved", async () => {
  const store = createStore();
  // 明确的 C 大调（长主音收尾，含 F 排除 G 大调）：B (degree 7) 跳到 A 而不是解决到 C。
  const { stored } = createContext(store, [
    { onsetBlick: 0, durationBlick: Q, pitch: 60 },
    { onsetBlick: Q, durationBlick: Q, pitch: 64 },
    { onsetBlick: 2 * Q, durationBlick: Q, pitch: 65 },
    { onsetBlick: 3 * Q, durationBlick: Q, pitch: 71 },
    { onsetBlick: 4 * Q, durationBlick: Q, pitch: 69 },
    { onsetBlick: 5 * Q, durationBlick: 3 * Q, pitch: 60 },
  ]);
  const result = await analyzer(store).analyze({
    contextId: stored.contextId,
    include: ["key", "tensionResolution"],
  });

  assert.equal(result.key.bestCandidate.tonic, "C");
  const event = result.tensionResolution.items.find(
    (item) => item.kind === "leading_tone_unresolved"
  );
  assert.ok(event, "degree 7 leaping away must be reported as unresolved");
  assert.equal(event.resolved, false);
  assert.equal(event.fromScaleDegree.degree, 7);
  assert.equal(event.motionSemitone, -2);
  assert.match(event.description, /instead of resolving up to 1/);
});

test("a leading tone that resolves upward is reported as resolved", async () => {
  const store = createStore();
  // 同样的 C 大调语境，但 B 正常解决到 C。
  const { stored } = createContext(store, [
    { onsetBlick: 0, durationBlick: Q, pitch: 60 },
    { onsetBlick: Q, durationBlick: Q, pitch: 64 },
    { onsetBlick: 2 * Q, durationBlick: Q, pitch: 65 },
    { onsetBlick: 3 * Q, durationBlick: Q, pitch: 71 },
    { onsetBlick: 4 * Q, durationBlick: 4 * Q, pitch: 72 },
  ]);
  const result = await analyzer(store).analyze({
    contextId: stored.contextId,
    include: ["key", "tensionResolution"],
  });

  assert.equal(result.key.bestCandidate.tonic, "C");
  const event = result.tensionResolution.items.find(
    (item) => item.kind === "leading_tone_resolution"
  );
  assert.ok(event);
  assert.equal(event.resolved, true);
  assert.equal(event.fromScaleDegree.degree, 7);
  assert.equal(event.toScaleDegree.degree, 1);
  assert.equal(event.motionSemitone, 1);
  assert.equal(event.motionDirection, "up");
});

test("missing meter marks degrade the metric sections instead of assuming 4/4", async () => {
  const store = createStore();
  const { stored } = createContext(store, CLEAR_CADENCE, { meterMarks: null });
  const result = await analyzer(store).analyze({
    contextId: stored.contextId,
    include: ["key", "metricalRoles", "chordCandidates", "tensionResolution"],
  });

  assert.equal(result.metricalRoles.status, "not_captured");
  assert.equal(result.chordCandidates.status, "not_captured");
  assert.ok(result.warnings.some((warning) => warning.code === "METER_NOT_CAPTURED"));
  // 不依赖小节线的分析仍然可用。
  assert.equal(result.tensionResolution.status, "succeeded");
  assert.ok(result.key.bestCandidate);
});

test("half_bar windows subdivide the harmonic rhythm", async () => {
  const store = createStore();
  // 一小节内前半 C 大三、后半 G 大三：bar 窗口会混在一起，half_bar 才能分开。
  const { stored } = createContext(store, [
    { onsetBlick: 0, durationBlick: Q, pitch: 60 },
    { onsetBlick: Q, durationBlick: Q, pitch: 64 },
    { onsetBlick: 2 * Q, durationBlick: Q, pitch: 67 },
    { onsetBlick: 3 * Q, durationBlick: Q, pitch: 71 },
  ]);
  const service = analyzer(store);
  const barWindows = await service.analyze({
    contextId: stored.contextId,
    include: ["chordCandidates"],
  });
  const halfWindows = await service.analyze({
    contextId: stored.contextId,
    include: ["chordCandidates"],
    harmonicWindow: "half_bar",
  });

  assert.equal(barWindows.chordCandidates.items.length, 1);
  assert.equal(halfWindows.chordCandidates.items.length, 2);
  assert.equal(halfWindows.chordCandidates.summary.windowUnit, "half_bar");
  assert.deepEqual(
    [...halfWindows.chordCandidates.items[0].pitchClassesPresent].sort(),
    ["C", "E"]
  );
  assert.deepEqual(
    [...halfWindows.chordCandidates.items[1].pitchClassesPresent].sort(),
    ["B", "G"]
  );
});

test("compact mode returns harmonic summaries without per-item lists", async () => {
  const store = createStore();
  const { stored } = createContext(store, CLEAR_CADENCE);
  const result = await analyzer(store).analyze({
    contextId: stored.contextId,
    include: ["key", ...HARMONIC_INCLUDES],
    responseMode: "compact",
  });

  assert.equal(result.metricalRoles.items, undefined);
  assert.equal(result.chordCandidates.items, undefined);
  assert.equal(result.tensionResolution.items, undefined);
  assert.ok(result.metricalRoles.summary);
  assert.ok(result.chordCandidates.summary);
  assert.ok(result.tensionResolution.summary);
  // 终止式在 compact 下仍逐句返回：它不依赖 phrases section 的 items。
  assert.equal(result.cadence.status, "succeeded");
  assert.ok(result.cadence.items.length >= 1);
});

test("harmonic options are validated and the candidate floor stays at two", async () => {
  const store = createStore();
  const { stored } = createContext(store, CLEAR_CADENCE);
  const service = analyzer(store);
  const cases = [
    { harmonicWindow: "measure" },
    { ambiguityThreshold: 2 },
    { ambiguityThreshold: -0.1 },
    // 下限 2：不允许把最高分写成唯一事实。
    { maxChordCandidates: 1 },
    { maxChordCandidates: 13 },
    { maxCadenceCandidates: 1 },
    { suspensionMinQuarter: 0 },
    { unknownHarmonicOption: true },
  ];
  for (const extra of cases) {
    await assert.rejects(
      () => service.analyze({ contextId: stored.contextId, include: ["chordCandidates"], ...extra }),
      (error) => error.code === "INVALID_ARGUMENTS",
      `expected INVALID_ARGUMENTS for ${JSON.stringify(extra)}`
    );
  }
});

test("analysis stays deterministic for an identical context and request", async () => {
  const store = createStore();
  const { stored } = createContext(store, CLEAR_CADENCE);
  const service = analyzer(store);
  const request = {
    contextId: stored.contextId,
    include: ["key", ...HARMONIC_INCLUDES],
  };
  const a = await service.analyze(request);
  const b = await service.analyze(request);
  const strip = (value) => JSON.stringify({ ...value, timings: null });
  assert.equal(strip(a), strip(b));
});
