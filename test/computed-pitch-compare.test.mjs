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
  approx(result.anomalySegments.top.peakAbsCent, 100, 1e-6);
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
    { mode: "nonsense" },
  ]) {
    await assert.rejects(service.compare(request), (error) => error.code === "INVALID_ARGUMENTS");
  }
});
