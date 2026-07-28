import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPARE_ANALYSIS_DEFAULTS,
  ComputedPitchCompareService,
  detectVibrato,
} from "../server/src/computed-pitch-compare.js";
import { SnapshotStore } from "../server/src/snapshot.js";

const Q = 705600000;

// 直接向 SnapshotStore 注入 range context：compare 是纯内存服务，
// 合成夹具无需宿主模型；真实 snapshot→compare 集成在 musical-range.test.mjs。
function createStore() {
  return new SnapshotStore({ now: () => 1000 });
}

function createStoredContext(store, options) {
  const {
    values,
    startBlick = 0,
    intervalBlick = Q / 10,
    notes = [],
    bpm = 120,
    timeOffsetBlick = 0,
    pitchOffsetSemitone = 0,
    withComputedPitch = true,
    extraOccurrenceWithPitch = false,
  } = options;
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
    targetGroupUuid: "uuid-compare-test",
    timeOffsetBlick,
    pitchOffsetSemitone,
    sharedTargetOccurrences: [occurrenceId],
    noteFingerprints,
  });
  const map = Object.create(null);
  if (withComputedPitch) {
    map[occurrenceId] = {
      startBlick,
      intervalBlick,
      frames: values.length,
      values,
      evidence: {
        requestedFrames: values.length,
        observedFrames: values.filter(Number.isFinite).length,
        nullFrameIndices: values.flatMap((value, index) =>
          Number.isFinite(value) ? [] : [index]
        ),
      },
    };
  }
  if (extraOccurrenceWithPitch) {
    const secondId = `${stored.contextId}:t:0:r:1`;
    stored.context.occurrences.push({
      occurrenceId: secondId,
      trackIndex: 0,
      groupIndex: 1,
      targetGroupUuid: "uuid-compare-test",
      timeOffsetBlick,
      pitchOffsetSemitone,
      sharedTargetOccurrences: [occurrenceId, secondId],
      noteFingerprints: [],
    });
    map[secondId] = { ...map[occurrenceId] };
  }
  stored.context.computedPitchByOccurrence = map;
  stored.context.quarterBlick = Q;
  stored.context.meterMarks = [{ position: 0, positionBlick: 0, numerator: 4, denominator: 4 }];
  stored.context.tempoMarks = [{ positionBlick: 0, positionSeconds: 0, bpm }];
  stored.snapshotToken = `snap_${stored.contextId}`;
  return { stored, occurrenceId };
}

function createService(store) {
  return new ComputedPitchCompareService({ store, now: () => 2000 });
}

function approx(actual, expected, tolerance = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`
  );
}

// ---------- detectVibrato 单元与 property 测试 ----------

test("detectVibrato measures rate, depth, and regularity of a synthetic vibrato", () => {
  const fs = 80;
  const rate = 5.5;
  const amplitudeCent = 30;
  const values = Array.from(
    { length: 160 },
    (_, index) => amplitudeCent * Math.sin((2 * Math.PI * rate * index) / fs) + 0.05 * index
  );
  const result = detectVibrato(values, fs, COMPARE_ANALYSIS_DEFAULTS.vibrato);
  assert.equal(result.status, "ok");
  assert.equal(result.samplingAssessment, "ok");
  assert.ok(Math.abs(result.rateHz - rate) <= 0.5, `rateHz ${result.rateHz}`);
  assert.ok(result.depthCent >= 25 && result.depthCent <= 32, `depthCent ${result.depthCent}`);
  assert.ok(result.regularity >= 0.8);
  assert.equal(result.confidence.kind, "heuristic_score");
  assert.equal(result.confidence.calibrated, false);
});

test("detectVibrato is invariant to a constant pitch offset (property)", () => {
  const fs = 80;
  const base = Array.from(
    { length: 120 },
    (_, index) => 20 * Math.sin((2 * Math.PI * 6 * index) / fs)
  );
  const shifted = base.map((value) => value + 200);
  const first = detectVibrato(base, fs, COMPARE_ANALYSIS_DEFAULTS.vibrato);
  const second = detectVibrato(shifted, fs, COMPARE_ANALYSIS_DEFAULTS.vibrato);
  assert.equal(first.status, "ok");
  assert.equal(second.status, "ok");
  approx(second.rateHz, first.rateHz);
  approx(second.depthCent, first.depthCent, 1e-6);
});

test("detectVibrato degrades honestly on short windows, flat pitch, and coarse sampling", () => {
  const params = COMPARE_ANALYSIS_DEFAULTS.vibrato;
  assert.equal(detectVibrato([1, 2, 3], 80, params).status, "insufficient_data");
  assert.equal(detectVibrato(new Array(60).fill(0), 80, params).status, "not_detected");
  assert.equal(detectVibrato(new Array(60).fill(0), null, params).status, "insufficient_data");
  // fs=10、hzMax=8.5 → 每周期 1.18 帧，低于 Nyquist 边界 → 明确拒绝而不是硬算。
  const coarse = detectVibrato(new Array(60).fill(0), 10, params);
  assert.equal(coarse.status, "sampling_too_coarse");
});

// ---------- compare_to_target ----------

test("GF-SYN-001: exact match yields zero error and full coverage", async () => {
  const store = createStore();
  const frames = 40;
  const interval = Q / 10;
  const { stored } = createStoredContext(store, {
    values: new Array(frames).fill(60),
    intervalBlick: interval,
    notes: [{ onsetBlick: 0, durationBlick: frames * interval, pitch: 60 }],
  });
  const result = await createService(store).compare({
    mode: "compare_to_target",
    contextId: stored.contextId,
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "succeeded");
  assert.equal(result.summary.frameCount, frames);
  assert.equal(result.summary.validFrameCount, frames);
  assert.equal(result.summary.coverage, 1);
  assert.equal(result.summary.maeCent, 0);
  assert.equal(result.summary.rmseCent, 0);
  assert.equal(result.perNote.items[0].status, "ok");
  assert.equal(result.perNote.items[0].center.status, "ok");
  assert.equal(result.perNote.items[0].center.errorCent, 0);
  assert.equal(result.anomalySegments.total, 0);
  assert.equal(result.provenance.pitchSource, "computedPitch");
  assert.equal(result.timings.coordinatorQueueMs, 0);
});

test("GF-SYN-002: null frames stay out of statistics but count in coverage", async () => {
  const store = createStore();
  const interval = Q / 10;
  const { stored } = createStoredContext(store, {
    values: [60, null, 60.1, null],
    intervalBlick: interval,
    notes: [{ onsetBlick: 0, durationBlick: 4 * interval, pitch: 60 }],
  });
  const result = await createService(store).compare({
    mode: "compare_to_target",
    contextId: stored.contextId,
  });
  assert.equal(result.summary.frameCount, 4);
  assert.equal(result.summary.finiteFrameCount, 2);
  assert.equal(result.summary.validFrameCount, 2);
  assert.equal(result.summary.coverage, 0.5);
  approx(result.summary.maeCent, 5, 1e-9);
  assert.equal(result.sampling.nullFrames, 2);
  // 有效帧少于 minValidFramesPerNote：note 级只报 insufficient_data，不硬给数值。
  assert.equal(result.perNote.items[0].status, "insufficient_data");
});

test("official br events are excluded from computed-pitch coverage and melodic details", async () => {
  const store = createStore();
  const interval = Q / 10;
  const { stored } = createStoredContext(store, {
    values: [...new Array(10).fill(72), ...new Array(10).fill(60)],
    intervalBlick: interval,
    notes: [
      { onsetBlick: 0, durationBlick: 10 * interval, pitch: 72, lyrics: "br" },
      { onsetBlick: 10 * interval, durationBlick: 10 * interval, pitch: 60, lyrics: "word" },
    ],
  });
  const result = await createService(store).compare({
    mode: "compare_to_target",
    contextId: stored.contextId,
    analysis: { minValidFramesPerNote: 2, centerMinFrames: 2 },
  });

  assert.equal(result.summary.frameCount, 20);
  assert.equal(result.summary.eligibleFrameCount, 10);
  assert.equal(result.summary.excludedFrameCount, 10);
  assert.equal(result.summary.excludedFiniteFrameCount, 10);
  assert.equal(result.summary.rawFiniteFrameCount, 20);
  assert.equal(result.summary.finiteFrameCount, 10);
  assert.equal(result.summary.validFrameCount, 10);
  assert.equal(result.summary.coverage, 1);
  assert.equal(result.inputNoteCount, 2);
  assert.equal(result.melodicNoteCount, 1);
  assert.equal(result.excludedEvents.count, 1);
  assert.equal(result.excludedEvents.byRole.breath_event, 1);
  assert.deepEqual(
    result.perNote.items.map((item) => item.lyrics),
    ["word"]
  );
  assert.equal(result.transitions.length, 0);
  assert.ok(!result.warnings.some((warning) => warning.code === "LOW_COMPUTED_PITCH_COVERAGE"));
});

test("an all-br range reports no melodic evidence instead of processing pending", async () => {
  const store = createStore();
  const interval = Q / 10;
  const { stored } = createStoredContext(store, {
    values: new Array(10).fill(null),
    intervalBlick: interval,
    notes: [{ onsetBlick: 0, durationBlick: 10 * interval, pitch: 72, lyrics: "br" }],
  });

  await assert.rejects(
    createService(store).compare({
      mode: "compare_to_target",
      contextId: stored.contextId,
    }),
    (error) =>
      error.code === "NO_MELODIC_EVIDENCE" &&
      error.details?.inputNoteCount === 1 &&
      error.details?.excludedEvents?.byRole?.breath_event === 1
  );
});

test("target uses pitch + detune + reference pitchOffset, and analysis overrides apply", async () => {
  const store = createStore();
  const interval = Q / 10;
  // 目标 = 60 + (-50/100) + 1 = 60.5；观测恒 60.6 → 每帧 +10 cents。
  const { stored } = createStoredContext(store, {
    values: new Array(12).fill(60.6),
    intervalBlick: interval,
    pitchOffsetSemitone: 1,
    notes: [{ onsetBlick: 0, durationBlick: 12 * interval, pitch: 60, detuneCents: -50 }],
  });
  const result = await createService(store).compare({
    mode: "compare_to_target",
    contextId: stored.contextId,
    analysis: { minValidFramesPerNote: 2, centerMinFrames: 2 },
  });
  approx(result.summary.meanCent, 10, 1e-6);
  approx(result.perNote.items[0].center.errorCent, 10, 1e-6);
  approx(result.perNote.items[0].targetSemitone, 60.5, 1e-9);
});

test("GF-SYN-005: transition reports overshoot, arrival, and settling", async () => {
  const store = createStore();
  const interval = Q / 40; // 120bpm → 12.5ms/帧，fs=80
  const values = [];
  for (let index = 0; index < 40; index += 1) values.push(60);
  values.push(61.5, 62.3);
  for (let index = 42; index < 120; index += 1) values.push(62);
  const { stored } = createStoredContext(store, {
    values,
    intervalBlick: interval,
    notes: [
      { onsetBlick: 0, durationBlick: 40 * interval, pitch: 60 },
      { onsetBlick: 40 * interval, durationBlick: 80 * interval, pitch: 62 },
    ],
  });
  const result = await createService(store).compare({
    mode: "compare_to_target",
    contextId: stored.contextId,
  });
  const transition = result.transitions[0];
  assert.equal(transition.direction, "up");
  assert.equal(transition.status, "ok");
  approx(transition.overshootCent, 30, 1e-6);
  assert.equal(transition.arrived, true);
  approx(transition.arrivalMs, 25, 1e-6);
  assert.equal(transition.settled, true);
  approx(transition.settlingMs, 25, 1e-6);
});

test("per-note vibrato is measured from the computed-pitch series", async () => {
  const store = createStore();
  const interval = Q / 40; // fs = 80 Hz → samplingAssessment ok
  const frames = 200;
  const values = Array.from(
    { length: frames },
    (_, index) => 65 + 0.3 * Math.sin((2 * Math.PI * 5.5 * index) / 80)
  );
  const { stored } = createStoredContext(store, {
    values,
    intervalBlick: interval,
    notes: [{ onsetBlick: 0, durationBlick: frames * interval, pitch: 65 }],
  });
  const result = await createService(store).compare({
    mode: "compare_to_target",
    contextId: stored.contextId,
  });
  const vibrato = result.perNote.items[0].vibrato;
  assert.equal(vibrato.status, "ok");
  assert.ok(Math.abs(vibrato.rateHz - 5.5) <= 0.5);
  assert.ok(vibrato.depthCent >= 25 && vibrato.depthCent <= 32);
  // 音准头条来自稳态段均值：正弦均值≈0，健康颤音不得被报成跑调。
  assert.ok(Math.abs(result.perNote.items[0].center.errorCent) < 3);
  assert.equal(result.sampling.samplingAssessment, "ok");
});

test("borderline frame rates are graded and warned, not rejected", async () => {
  const store = createStore();
  const interval = Q / 10; // fs = 20 Hz → 20/8.5 ≈ 2.35 帧/周期 → borderline
  const { stored } = createStoredContext(store, {
    values: new Array(40).fill(60),
    intervalBlick: interval,
    notes: [{ onsetBlick: 0, durationBlick: 40 * interval, pitch: 60 }],
  });
  const result = await createService(store).compare({
    mode: "compare_to_target",
    contextId: stored.contextId,
  });
  assert.equal(result.ok, true);
  assert.equal(result.sampling.samplingAssessment, "borderline");
  approx(result.sampling.frameRateHz, 20, 1e-6);
  assert.ok(result.warnings.some((warning) => warning.code === "SAMPLING_BORDERLINE_FOR_VIBRATO"));
});

test("anomaly segments locate contiguous high-error regions", async () => {
  const store = createStore();
  const interval = Q / 10;
  const values = new Array(30).fill(60);
  values[10] = 61;
  values[11] = 61.2;
  values[12] = 61;
  const { stored } = createStoredContext(store, {
    values,
    intervalBlick: interval,
    notes: [{ onsetBlick: 0, durationBlick: 30 * interval, pitch: 60 }],
  });
  const result = await createService(store).compare({
    mode: "compare_to_target",
    contextId: stored.contextId,
  });
  assert.equal(result.anomalySegments.total, 1);
  const segment = result.anomalySegments.items[0];
  assert.equal(segment.startFrameIndex, 10);
  assert.equal(segment.endFrameIndex, 12);
  assert.equal(segment.frames, 3);
  approx(segment.peakAbsCent, 120, 1e-6);
});

test("anomaly segments default to score order, declare sortBy, and keep top as the most severe", async () => {
  const store = createStore();
  const interval = Q / 10;
  // 三段异常按时间：早(80c) → 中(300c 最严重) → 晚(150c)。
  const values = new Array(40).fill(60);
  values[5] = 60.8;
  values[20] = 63;
  values[21] = 62.5;
  values[33] = 61.5;
  const { stored } = createStoredContext(store, {
    values,
    intervalBlick: interval,
    notes: [{ onsetBlick: 0, durationBlick: 40 * interval, pitch: 60 }],
  });
  const service = createService(store);
  const byTime = await service.compare({
    mode: "compare_to_target",
    contextId: stored.contextId,
  });
  assert.equal(byTime.anomalySegments.total, 3);
  // 修复前按严重程度排序且不声明；现在默认 startBlick 时间序并显式声明 sortBy。
  assert.equal(byTime.anomalySegments.sortBy, "startBlick");
  assert.deepEqual(
    byTime.anomalySegments.items.map((segment) => segment.startFrameIndex),
    [5, 20, 33]
  );
  const starts = byTime.anomalySegments.items.map((segment) => segment.startBlick);
  assert.deepEqual(starts, [...starts].sort((left, right) => left - right));
  // top 恒为最严重段，与排序方式无关。
  approx(byTime.anomalySegments.top.peakAbsCent, 300, 1e-6);
  assert.equal(byTime.anomalySegments.top.startFrameIndex, 20);

  const bySeverity = await service.compare({
    mode: "compare_to_target",
    contextId: stored.contextId,
    anomalySortBy: "severity",
  });
  assert.equal(bySeverity.anomalySegments.sortBy, "severity");
  assert.deepEqual(
    bySeverity.anomalySegments.items.map((segment) => segment.startFrameIndex),
    [20, 33, 5]
  );
  approx(bySeverity.anomalySegments.top.peakAbsCent, 300, 1e-6);
});

test("time-ordered truncation still surfaces a late most-severe segment via top", async () => {
  const store = createStore();
  const interval = Q / 10;
  // 11 段异常（超出 MAX_ANOMALY_SEGMENTS=10），最严重的一段放在最后：
  // 时间序截断会砍掉它，top 必须仍指向它。
  const frames = 23 * 2 + 1;
  const values = new Array(frames).fill(60);
  for (let index = 0; index < 10; index += 1) values[1 + index * 2] = 61; // 100c × 10 段（隔帧）
  values[frames - 1] = 64; // 400c 最严重段在最后
  const { stored } = createStoredContext(store, {
    values,
    intervalBlick: interval,
    notes: [{ onsetBlick: 0, durationBlick: frames * interval, pitch: 60 }],
  });
  const result = await createService(store).compare({
    mode: "compare_to_target",
    contextId: stored.contextId,
  });
  assert.equal(result.anomalySegments.total, 11);
  assert.equal(result.anomalySegments.truncated, true);
  assert.equal(result.anomalySegments.items.length, 10);
  // 时间序前 10 段不含最后的 400c 段……
  assert.ok(result.anomalySegments.items.every((segment) => segment.peakAbsCent < 400));
  // ……但 top 如实指向它，截断不吞掉最严重证据。
  approx(result.anomalySegments.top.peakAbsCent, 400, 1e-6);
});

test("compact responses keep summary and top anomaly only", async () => {
  const store = createStore();
  const interval = Q / 10;
  const values = new Array(20).fill(60);
  values[5] = 61;
  const { stored } = createStoredContext(store, {
    values,
    intervalBlick: interval,
    notes: [{ onsetBlick: 0, durationBlick: 20 * interval, pitch: 60 }],
  });
  const result = await createService(store).compare({
    mode: "compare_to_target",
    contextId: stored.contextId,
    responseMode: "compact",
  });
  assert.equal(result.perNote, undefined);
  assert.equal(result.transitions, undefined);
  assert.equal(result.analysis, undefined);
  assert.ok(result.summary);
  assert.equal(result.anomalySegments.total, 1);
  assert.equal(result.anomalySegments.sortBy, "startBlick");
  approx(result.anomalySegments.top.peakAbsCent, 100, 1e-6);
});

test("low valid-frame coverage raises an explicit warning in compare_to_target", async () => {
  const store = createStore();
  const interval = Q / 10;
  // 40 帧里只有 10 帧有限（26% 那类实测场景的合成版：25% < 默认阈值 0.5）。
  const values = new Array(40).fill(null);
  for (let index = 0; index < 10; index += 1) values[index] = 60;
  const { stored } = createStoredContext(store, {
    values,
    intervalBlick: interval,
    notes: [{ onsetBlick: 0, durationBlick: 40 * interval, pitch: 60 }],
  });
  const result = await createService(store).compare({
    mode: "compare_to_target",
    contextId: stored.contextId,
  });
  assert.equal(result.summary.coverage, 0.25);
  const warning = result.warnings.find(
    (item) => item.code === "LOW_COMPUTED_PITCH_COVERAGE"
  );
  assert.ok(warning, "expected LOW_COMPUTED_PITCH_COVERAGE warning at 25% coverage");
  assert.match(warning.message, /25\.0%/);
  assert.match(warning.message, /small sample/);
});

test("coverage at or above the threshold stays silent; the threshold is adjustable", async () => {
  const store = createStore();
  const interval = Q / 10;
  const values = new Array(40).fill(60);
  for (let index = 20; index < 40; index += 1) values[index] = null; // 覆盖率恰 0.5
  const { stored } = createStoredContext(store, {
    values,
    intervalBlick: interval,
    notes: [{ onsetBlick: 0, durationBlick: 40 * interval, pitch: 60 }],
  });
  const service = createService(store);
  const silent = await service.compare({
    mode: "compare_to_target",
    contextId: stored.contextId,
  });
  assert.equal(silent.summary.coverage, 0.5);
  assert.ok(
    !silent.warnings.some((item) => item.code === "LOW_COMPUTED_PITCH_COVERAGE"),
    "coverage equal to the threshold must not warn"
  );
  // 阈值可调：调到 0.8 后同一数据必须警告；报告的 analysis 参数如实回显新阈值。
  const strict = await service.compare({
    mode: "compare_to_target",
    contextId: stored.contextId,
    analysis: { lowCoverageWarnRatio: 0.8 },
  });
  assert.ok(strict.warnings.some((item) => item.code === "LOW_COMPUTED_PITCH_COVERAGE"));
  assert.equal(strict.analysis.lowCoverageWarnRatio, 0.8);
});

test("low pairwise coverage raises the same warning in compare_contexts", async () => {
  const store = createStore();
  // 4 帧只有 1 对两侧同时有限 → 覆盖率 0.25 < 0.5。
  const { before, after } = createContextsPair(
    store,
    [60, null, 60, null],
    [60.1, 60.1, null, null]
  );
  const result = await createService(store).compare({
    mode: "compare_contexts",
    before: { contextId: before.stored.contextId },
    after: { contextId: after.stored.contextId },
  });
  assert.equal(result.summary.coverage, 0.25);
  assert.ok(result.warnings.some((item) => item.code === "LOW_COMPUTED_PITCH_COVERAGE"));
});

test("compare_contexts excludes special-event frames on both sides and reports note counts", async () => {
  const store = createStore();
  const interval = Q / 10;
  const { before, after } = createContextsPair(
    store,
    [72, 72, 60, 60],
    [71, 71, 60.1, 60.1],
    {
      shared: {
        intervalBlick: interval,
        notes: [
          { onsetBlick: 0, durationBlick: 2 * interval, pitch: 72, lyrics: "br" },
          { onsetBlick: 2 * interval, durationBlick: 2 * interval, pitch: 60, lyrics: "word" },
        ],
      },
    }
  );
  const result = await createService(store).compare({
    mode: "compare_contexts",
    before: { contextId: before.stored.contextId },
    after: { contextId: after.stored.contextId },
  });

  assert.equal(result.summary.frameCount, 4);
  assert.equal(result.summary.eligibleFrameCount, 2);
  assert.equal(result.summary.excludedFrameCount, 2);
  assert.equal(result.summary.validFrameCount, 2);
  assert.equal(result.summary.coverage, 1);
  assert.deepEqual(result.noteCounts, {
    before: { inputNoteCount: 2, melodicNoteCount: 1 },
    after: { inputNoteCount: 2, melodicNoteCount: 1 },
  });
  assert.equal(result.excludedEvents.before.byRole.breath_event, 1);
  assert.equal(result.excludedEvents.after.byRole.breath_event, 1);
  assert.equal(result.perNote.count, 1);
});

// ---------- compare_contexts ----------

function createContextsPair(store, beforeValues, afterValues, options = {}) {
  const before = createStoredContext(store, { values: beforeValues, ...options.before, ...options.shared });
  const after = createStoredContext(store, { values: afterValues, ...options.after, ...options.shared });
  return { before, after };
}

test("GF-SYN-003: semitone delta statistics match the §13.8 shape", async () => {
  const store = createStore();
  const { before, after } = createContextsPair(
    store,
    [60.0, 60.1, 60.2],
    [60.0, 60.01, 60.02]
  );
  const result = await createService(store).compare({
    mode: "compare_contexts",
    before: { contextId: before.stored.contextId },
    after: { contextId: after.stored.contextId },
  });
  assert.equal(result.mode, "compare_contexts");
  assert.equal(result.summary.orientation, "after_minus_before");
  assert.equal(result.semitoneDelta.comparedFrames, 3);
  approx(result.semitoneDelta.meanAbsoluteDeltaSemitone, 0.09, 1e-9);
  approx(result.semitoneDelta.minDeltaSemitone, -0.18, 1e-9);
  approx(result.semitoneDelta.maxDeltaSemitone, 0, 1e-9);
  assert.equal(result.semitoneDelta.framesAtLeast["0.01"], 2);
  assert.equal(result.semitoneDelta.framesAtLeast["0.05"], 2);
  assert.equal(result.semitoneDelta.framesAtLeast["0.10"], 1);
  // 双方都没有 notes：perNote 跳过并显式警告，不静默省略。
  assert.ok(result.warnings.some((warning) => warning.code === "NOTES_NOT_CAPTURED"));
});

test("compare_contexts pairs frames only where both sides are finite", async () => {
  const store = createStore();
  const { before, after } = createContextsPair(
    store,
    [60, null, 60, 60],
    [60.1, 60.1, null, 60.1]
  );
  const result = await createService(store).compare({
    mode: "compare_contexts",
    before: { contextId: before.stored.contextId },
    after: { contextId: after.stored.contextId },
  });
  assert.equal(result.summary.frameCount, 4);
  assert.equal(result.summary.validFrameCount, 2);
  assert.equal(result.summary.coverage, 0.5);
  assert.deepEqual(result.sampling.nullFrames, { before: 1, after: 1 });
});

test("compare_contexts reports per-note center deltas and flags changed notes", async () => {
  const store = createStore();
  const interval = Q / 10;
  const noteSpec = { onsetBlick: 0, durationBlick: 20 * interval, pitch: 60 };
  const { before, after } = createContextsPair(
    store,
    new Array(20).fill(60),
    new Array(20).fill(60.15),
    {
      shared: { intervalBlick: interval },
      before: { notes: [noteSpec] },
      after: { notes: [{ ...noteSpec, pitch: 62 }] },
    }
  );
  const result = await createService(store).compare({
    mode: "compare_contexts",
    before: { contextId: before.stored.contextId },
    after: { contextId: after.stored.contextId },
  });
  const item = result.perNote.items[0];
  assert.equal(item.noteChanged, true);
  assert.deepEqual(item.changedFields, ["pitch"]);
  approx(item.centerDeltaCent, 15, 1e-6);
  assert.equal(item.before.center.status, "ok");
  assert.equal(item.after.center.status, "ok");
  assert.ok(result.warnings.some((warning) => warning.code === "NOTE_STRUCTURE_CHANGED"));
});

test("compare_contexts rejects mismatched sampling grids before any analysis", async () => {
  const store = createStore();
  const before = createStoredContext(store, { values: [60, 60], intervalBlick: Q / 10 });
  const after = createStoredContext(store, { values: [60, 60], intervalBlick: Q / 20 });
  await assert.rejects(
    createService(store).compare({
      mode: "compare_contexts",
      before: { contextId: before.stored.contextId },
      after: { contextId: after.stored.contextId },
    }),
    (error) => {
      assert.equal(error.code, "ALIGNMENT_UNSUPPORTED");
      assert.equal(error.details.before.intervalBlick, Q / 10);
      assert.equal(error.details.after.intervalBlick, Q / 20);
      return true;
    }
  );
});

test("compare_contexts warns when tempo maps differ but still pairs by score position", async () => {
  const store = createStore();
  const { before, after } = createContextsPair(store, [60, 60], [60, 60], {
    after: { bpm: 90 },
  });
  const result = await createService(store).compare({
    mode: "compare_contexts",
    before: { contextId: before.stored.contextId },
    after: { contextId: after.stored.contextId },
  });
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((warning) => warning.code === "TEMPO_MAP_DIFFERS"));
});

test("compare_contexts measures vibrato Hz per side when tempo differs (before-side fs is its own)", async () => {
  const store = createStore();
  const interval = Q / 40; // fs = bpm*2/3 → after(60)=40 Hz, before(120)=80 Hz
  const frames = 200;
  // 同一帧域颤音（10 帧/周期）：物理 Hz 只由各侧帧率决定 → before 应≈2×after，而非共用 after 的 fs。
  const vibrato = Array.from(
    { length: frames },
    (_, index) => 60 + 0.3 * Math.sin((2 * Math.PI * index) / 10)
  );
  const noteSpec = { onsetBlick: 0, durationBlick: frames * interval, pitch: 60 };
  const { before, after } = createContextsPair(store, vibrato, vibrato, {
    shared: { intervalBlick: interval, notes: [noteSpec] },
    before: { bpm: 120 },
    after: { bpm: 60 },
  });
  const result = await createService(store).compare({
    mode: "compare_contexts",
    before: { contextId: before.stored.contextId },
    after: { contextId: after.stored.contextId },
  });
  const item = result.perNote.items[0];
  assert.equal(item.after.vibrato.status, "ok");
  assert.equal(item.before.vibrato.status, "ok");
  approx(item.after.vibrato.rateHz, 4, 0.7); // 40/10
  approx(item.before.vibrato.rateHz, 8, 1.0); // 80/10, 修复前会被误报成 4
  assert.ok(item.before.vibrato.rateHz > item.after.vibrato.rateHz * 1.5);
});

test("compare_contexts flags inserted/shifted notes as unmatched instead of a cross-note delta", async () => {
  const store = createStore();
  const interval = Q / 10;
  const noteLen = 20 * interval;
  const before = createStoredContext(store, {
    values: new Array(60).fill(62),
    intervalBlick: interval,
    notes: [
      { onsetBlick: 0, durationBlick: noteLen, pitch: 62, lyrics: "b" },
      { onsetBlick: noteLen, durationBlick: noteLen, pitch: 64, lyrics: "c" },
    ],
  });
  // after 在开头插入音符 a，其后 b、c 整体后移：不能把新 a 拿去和旧 b 报 delta。
  const after = createStoredContext(store, {
    values: new Array(60).fill(60),
    intervalBlick: interval,
    notes: [
      { onsetBlick: 0, durationBlick: noteLen, pitch: 60, lyrics: "a" },
      { onsetBlick: noteLen, durationBlick: noteLen, pitch: 62, lyrics: "b" },
      { onsetBlick: 2 * noteLen, durationBlick: noteLen, pitch: 64, lyrics: "c" },
    ],
  });
  const result = await createService(store).compare({
    mode: "compare_contexts",
    before: { contextId: before.stored.contextId },
    after: { contextId: after.stored.contextId },
  });
  assert.equal(result.perNote.matched, 0);
  assert.equal(result.perNote.unmatched, 3);
  for (const item of result.perNote.items) {
    assert.equal(item.unmatched, true);
    assert.equal(item.centerDeltaCent, undefined);
    assert.equal(item.before, undefined);
  }
  assert.ok(result.warnings.some((warning) => warning.code === "PER_NOTE_UNMATCHED"));
  assert.ok(!result.warnings.some((warning) => warning.code === "NOTE_STRUCTURE_CHANGED"));
});

test("perNote matched/unmatched count the full population even when items are truncated", async () => {
  const store = createStore();
  const interval = Q / 10;
  const noteLen = 2 * interval;
  const count = 201; // MAX_PER_NOTE_ITEMS=200：明细截断，但计数必须覆盖全量 201
  const notes = Array.from({ length: count }, (_, index) => ({
    onsetBlick: index * noteLen,
    durationBlick: noteLen,
    pitch: 60,
    lyrics: `n${index}`,
  }));
  const values = new Array(count * 2).fill(60);
  const { before, after } = createContextsPair(store, values, values, {
    shared: { intervalBlick: interval, notes },
  });
  const result = await createService(store).compare({
    mode: "compare_contexts",
    before: { contextId: before.stored.contextId },
    after: { contextId: after.stored.contextId },
  });
  assert.equal(result.perNote.count, 201);
  assert.equal(result.perNote.matched, 201); // 修复前：200（只数已报告明细）
  assert.equal(result.perNote.unmatched, 0);
  assert.equal(result.perNote.truncated, true);
  assert.equal(result.perNote.items.length, 200);
  assert.ok(result.warnings.some((warning) => warning.code === "PER_NOTE_TRUNCATED"));
});

test("compare_contexts still reports deltas for unmoved notes when another note is deleted", async () => {
  const store = createStore();
  const interval = Q / 10;
  const noteLen = 20 * interval;
  const before = createStoredContext(store, {
    values: new Array(60).fill(60),
    intervalBlick: interval,
    notes: [
      { onsetBlick: 0, durationBlick: noteLen, pitch: 60, lyrics: "a" },
      { onsetBlick: noteLen, durationBlick: noteLen, pitch: 62, lyrics: "b" },
      { onsetBlick: 2 * noteLen, durationBlick: noteLen, pitch: 64, lyrics: "c" },
    ],
  });
  // 删除中间音符 b，a 与 c 位置/指纹不变：这两个不动的音符仍应给出 delta。
  const after = createStoredContext(store, {
    values: new Array(60).fill(60.1),
    intervalBlick: interval,
    notes: [
      { onsetBlick: 0, durationBlick: noteLen, pitch: 60, lyrics: "a" },
      { onsetBlick: 2 * noteLen, durationBlick: noteLen, pitch: 64, lyrics: "c" },
    ],
  });
  const result = await createService(store).compare({
    mode: "compare_contexts",
    before: { contextId: before.stored.contextId },
    after: { contextId: after.stored.contextId },
  });
  assert.equal(result.perNote.matched, 2);
  assert.equal(result.perNote.unmatched, 0);
  for (const item of result.perNote.items) {
    assert.equal(item.unmatched, undefined);
    assert.ok(Number.isFinite(item.centerDeltaCent));
  }
});

// ---------- 错误路径与校验 ----------

test("compare resolves occurrences honestly across error paths", async () => {
  const store = createStore();
  const service = createService(store);
  await assert.rejects(
    service.compare({ mode: "compare_to_target", contextId: "ctx_missing" }),
    (error) => error.code === "UNKNOWN_CONTEXT"
  );

  const noPitch = createStoredContext(store, { values: [60], withComputedPitch: false });
  await assert.rejects(
    service.compare({ mode: "compare_to_target", contextId: noPitch.stored.contextId }),
    (error) => error.code === "COMPUTED_PITCH_NOT_CAPTURED"
  );

  const ambiguous = createStoredContext(store, {
    values: [60, 60],
    extraOccurrenceWithPitch: true,
  });
  await assert.rejects(
    service.compare({ mode: "compare_to_target", contextId: ambiguous.stored.contextId }),
    (error) => {
      assert.equal(error.code, "AMBIGUOUS_CONTEXT");
      assert.equal(error.details.candidateOccurrences.length, 2);
      return true;
    }
  );
  await assert.rejects(
    service.compare({
      mode: "compare_to_target",
      contextId: ambiguous.stored.contextId,
      occurrenceId: "ctx_bogus:t:9:r:9",
    }),
    (error) => error.code === "UNKNOWN_OCCURRENCE"
  );

  const noNotes = createStoredContext(store, { values: new Array(10).fill(60) });
  await assert.rejects(
    service.compare({ mode: "compare_to_target", contextId: noNotes.stored.contextId }),
    (error) => error.code === "NOTES_NOT_CAPTURED"
  );

  const allNull = createStoredContext(store, {
    values: [null, null, null, null],
    notes: [{ onsetBlick: 0, durationBlick: 4 * (Q / 10), pitch: 60 }],
  });
  await assert.rejects(
    service.compare({ mode: "compare_to_target", contextId: allNull.stored.contextId }),
    (error) => {
      assert.equal(error.code, "INSUFFICIENT_COMPUTED_PITCH");
      assert.match(error.message, /processing may not have completed|unvoiced/);
      return true;
    }
  );
});

test("compare validates request shape before touching the store", async () => {
  const store = createStore();
  const service = createService(store);
  for (const request of [
    { mode: "compare_to_target" },
    { mode: "compare_to_target", contextId: "ctx_x", before: { contextId: "ctx_y" } },
    { mode: "compare_contexts", contextId: "ctx_x" },
    { mode: "compare_contexts", before: { contextId: "ctx_x" } },
    { mode: "compare_to_target", contextId: "ctx_x", bogusField: true },
    { mode: "compare_to_target", contextId: "ctx_x", analysis: { vibrato: { hzRange: [9, 3] } } },
    { mode: "compare_to_target", contextId: "ctx_x", metrics: { perNote: "yes" } },
    { mode: "compare_to_target", contextId: "ctx_x", anomalySortBy: "peak" },
    { mode: "compare_to_target", contextId: "ctx_x", analysis: { lowCoverageWarnRatio: 1.5 } },
    { mode: "nonsense" },
  ]) {
    await assert.rejects(service.compare(request), (error) => error.code === "INVALID_ARGUMENTS");
  }
});
