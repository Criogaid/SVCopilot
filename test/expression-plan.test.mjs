import assert from "node:assert/strict";
import test from "node:test";

import {
  EXPRESSION_PLAN_DEFAULTS,
  ExpressionPlanService,
} from "../server/src/expression-plan.js";
import { normalizeCurveInput, normalizeTarget } from "../server/src/parameter-curve.js";
import { SnapshotStore } from "../server/src/snapshot.js";

const Q = 705600000;

// 与 compare 测试同一手法：直接向 SnapshotStore 注入 range context 纯数据。
function createStore() {
  return new SnapshotStore({ now: () => 1000 });
}

function createStoredContext(store, options = {}) {
  const {
    notes = [],
    bpm = 120,
    timeOffsetBlick = 0,
    sharedTargetOccurrences = null,
    extraOccurrenceWithNotes = false,
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
    occurrence: 0,
    occurrenceId,
    trackIndex: 0,
    groupIndex: 0,
    targetGroupUuid: "uuid-plan-test",
    timeOffsetBlick,
    pitchOffsetSemitone: 0,
    groupNoteCount: noteFingerprints.length,
    sharedTargetOccurrences: sharedTargetOccurrences ?? [occurrenceId],
    noteFingerprints,
  });
  if (extraOccurrenceWithNotes) {
    const secondId = `${stored.contextId}:t:0:r:1`;
    stored.context.occurrences.push({
      occurrence: 1,
      occurrenceId: secondId,
      trackIndex: 0,
      groupIndex: 1,
      targetGroupUuid: "uuid-plan-test",
      timeOffsetBlick,
      pitchOffsetSemitone: 0,
      groupNoteCount: noteFingerprints.length,
      sharedTargetOccurrences: [occurrenceId, secondId],
      noteFingerprints: noteFingerprints.map((fingerprint, index) => ({
        ...fingerprint,
        noteId: `${secondId}:n:${index}`,
      })),
    });
  }
  stored.context.computedPitchByOccurrence = Object.create(null);
  stored.context.quarterBlick = Q;
  stored.context.meterMarks = [{ position: 0, positionBlick: 0, numerator: 4, denominator: 4 }];
  stored.context.tempoMarks = [{ positionBlick: 0, positionSeconds: 0, bpm }];
  stored.snapshotToken = `snap_${stored.contextId}`;
  return { stored, occurrenceId };
}

function createService(store) {
  return new ExpressionPlanService({ store, now: () => 2000 });
}

function noteId(occurrenceId, index) {
  return `${occurrenceId}:n:${index}`;
}

function approx(actual, expected, tolerance = 1e-6) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`
  );
}

// applyRequests 的每条 curve 必须能通过 parameter-curve 的真实入参归一化——
// 这是"规划器产物可直接交给现有事务核"契约的可执行证明。
function assertApplyRequestsWellFormed(result) {
  assert.ok(Array.isArray(result.applyRequests) && result.applyRequests.length >= 1);
  for (const request of result.applyRequests) {
    assert.equal(request.tool, "sv_patch_parameter_curves");
    assert.equal(request.arguments.dryRun, true);
    assert.equal(request.arguments.atomic, true);
    assert.ok(request.arguments.target.contextId);
    assert.ok(request.arguments.target.occurrenceId);
    assert.equal(request.arguments.target.expectedGroupUuid, "uuid-plan-test");
    // F1/R2：target 必须携带锚点音符指纹与快照时 reference 偏移，并能通过 parameter-curve 的
    // 真实 target 归一化（apply 前逐条核对；reference 被 setTimeOffset 移动即 STALE_CONTEXT）。
    const normalizedTarget = normalizeTarget(request.arguments.target);
    assert.ok(
      Number.isSafeInteger(normalizedTarget.expectedTimeOffsetBlick),
      "applyRequest target must pin the snapshot-time timeOffsetBlick"
    );
    assert.ok(
      Array.isArray(normalizedTarget.expectedNotes) && normalizedTarget.expectedNotes.length >= 1,
      "applyRequest target must carry expectedNotes fingerprints"
    );
    for (const expected of normalizedTarget.expectedNotes) {
      assert.ok(Number.isInteger(expected.indexInGroup) && expected.indexInGroup >= 0);
      assert.equal(typeof expected.onsetBlick, "number");
      assert.equal(typeof expected.pitch, "number");
    }
    const parameters = request.arguments.curves.map((curve) => curve.parameter);
    assert.equal(new Set(parameters).size, parameters.length, "parameters unique per call");
    for (const curve of request.arguments.curves) {
      const normalized = normalizeCurveInput(curve);
      assert.equal(normalized.mode, "replace");
      assert.ok(normalized.points.length >= 2);
    }
  }
}

// ---------- 显式表现手法 ----------

test("explicit scoop compiles to a guarded pitchDelta replace operation", async () => {
  const store = createStore();
  const { stored, occurrenceId } = createStoredContext(store, {
    notes: [{ onsetBlick: 2 * Q, durationBlick: 2 * Q, pitch: 60 }],
  });
  const result = await createService(store).plan({
    contextId: stored.contextId,
    gestures: [{ type: "scoop", targets: [[0, 30]], lengthQuarter: 0.5 }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "planned");
  assert.equal(result.effects, "none");
  assert.equal(result.dryRun, true);
  assert.match(result.planId, /^plan_[0-9a-f]{16}$/);
  assert.equal(result.summary.operationCount, 1);
  const operation = result.operations[0];
  assert.equal(operation.parameter, "pitchDelta");
  assert.equal(operation.unit, "cents");
  assert.equal(operation.writeSurface, "automation");
  assert.equal(operation.mode, "replace");
  const curve = result.applyRequests[0].arguments.curves[0];
  // 守卫点：onset 前 ε 处回基线 0，让 replace 与周围曲线只跨极小过渡。
  assert.equal(curve.points[0].value, 0);
  assert.ok(curve.points[0].blick < 2 * Q && curve.points[0].blick >= 0);
  approx(curve.points[1].value, -30);
  assert.equal(curve.points[1].blick, 2 * Q);
  const last = curve.points[curve.points.length - 1];
  approx(last.value, 0, 1e-9);
  assert.equal(last.blick, 2 * Q + Q / 2);
  assert.equal(operation.range.fromBlick, curve.points[0].blick);
  assert.equal(operation.range.toBlick, last.blick + 1);
  assertApplyRequestsWellFormed(result);
  assert.equal(result.review.existingPointsChecked, false);
  assert.equal(result.provenance.perception, "human_only");
  assert.equal(result.timings.coordinatorQueueMs, 0);
});

test("explicit fall ends at -depth with a trailing baseline guard", async () => {
  const store = createStore();
  const { stored, occurrenceId } = createStoredContext(store, {
    notes: [{ onsetBlick: 0, durationBlick: 2 * Q, pitch: 60 }],
  });
  const result = await createService(store).plan({
    contextId: stored.contextId,
    gestures: [{ type: "fall", targets: [[0, 50]], lengthQuarter: 0.5 }],
  });
  const points = result.applyRequests[0].arguments.curves[0].points;
  approx(points[0].value, 0, 1e-9);
  approx(points[points.length - 2].value, -50);
  assert.equal(points[points.length - 2].blick, 2 * Q);
  assert.equal(points[points.length - 1].value, 0);
  assert.ok(points[points.length - 1].blick > 2 * Q);
});

test("portamento bends symmetrically so perceived pitch stays continuous", async () => {
  const store = createStore();
  const { stored, occurrenceId } = createStoredContext(store, {
    notes: [
      { onsetBlick: 0, durationBlick: Q, pitch: 60 },
      { onsetBlick: Q, durationBlick: Q, pitch: 62 },
    ],
  });
  const result = await createService(store).plan({
    contextId: stored.contextId,
    gestures: [
      {
        type: "portamento",
        transitions: [[0, 1]],
        lengthQuarter: 0.25,
      },
    ],
  });
  const points = result.applyRequests[0].arguments.curves[0].points;
  const beforeBoundary = points.find((point) => point.blick === Q - 1);
  const atBoundary = points.find((point) => point.blick === Q);
  approx(beforeBoundary.value, 100, 0.5);
  approx(atBoundary.value, -100, 0.5);
  const gesture = result.gestures[0];
  assert.equal(gesture.params.intervalCents, 200);
  assert.equal(gesture.params.clampedGlide, false);
});

test("portamento rejects non-adjacent notes and equal pitches", async () => {
  const store = createStore();
  const { stored, occurrenceId } = createStoredContext(store, {
    notes: [
      { onsetBlick: 0, durationBlick: Q, pitch: 60 },
      { onsetBlick: 2 * Q, durationBlick: Q, pitch: 62 }, // 有休止
      { onsetBlick: 3 * Q, durationBlick: Q, pitch: 62 },
    ],
  });
  const service = createService(store);
  await assert.rejects(
    service.plan({
      contextId: stored.contextId,
      gestures: [
        { type: "portamento", transitions: [[0, 1]] },
      ],
    }),
    (error) => error.code === "PORTAMENTO_NOT_ADJACENT"
  );
  await assert.rejects(
    service.plan({
      contextId: stored.contextId,
      gestures: [
        { type: "portamento", transitions: [[1, 2]] },
      ],
    }),
    (error) => error.code === "INVALID_ARGUMENTS"
  );
});

test("vibrato renders a bounded sine with envelope and honest stacking warning", async () => {
  const store = createStore();
  const { stored, occurrenceId } = createStoredContext(store, {
    notes: [{ onsetBlick: 0, durationBlick: 4 * Q, pitch: 65 }], // 120bpm → 2 s 长音
  });
  const result = await createService(store).plan({
    contextId: stored.contextId,
    gestures: [{ type: "vibrato", notes: [0], depthCents: 40, rateHz: 5.5 }],
  });
  const operation = result.operations[0];
  assert.equal(operation.parameter, "pitchDelta");
  assert.ok(operation.pointCount > 20, `pointCount ${operation.pointCount}`);
  const values = result.applyRequests[0].arguments.curves[0].points.map((point) => point.value);
  assert.ok(Math.max(...values.map(Math.abs)) <= 40 + 1e-9);
  assert.ok(Math.max(...values.map(Math.abs)) > 20, "sine should reach a meaningful depth");
  assert.ok(result.warnings.some((warning) => warning.code === "NATURAL_VIBRATO_UNOBSERVABLE"));
});

test("vibrato respects avoidExcessiveVibrato and minimum sustain", async () => {
  const store = createStore();
  const { stored, occurrenceId } = createStoredContext(store, {
    notes: [{ onsetBlick: 0, durationBlick: Q, pitch: 65 }], // 1 quarter，短于 1.5
  });
  const service = createService(store);
  await assert.rejects(
    service.plan({
      contextId: stored.contextId,
      gestures: [{ type: "vibrato", notes: [0] }],
    }),
    (error) => error.code === "CONSTRAINT_VIOLATION"
  );
  await assert.rejects(
    service.plan({
      contextId: stored.contextId,
      constraints: { avoidExcessiveVibrato: false },
      gestures: [{ type: "vibrato", notes: [0], rateHz: 2, onsetDelayQuarter: 0.5 }],
    }),
    (error) => error.code === "VIBRATO_SPAN_TOO_SHORT"
  );
});

test("vibratoEnv shapes the envelope with baseline-1 guards and conflicts are rejected", async () => {
  const store = createStore();
  const { stored, occurrenceId } = createStoredContext(store, {
    notes: [{ onsetBlick: 2 * Q, durationBlick: 4 * Q, pitch: 65 }],
  });
  const service = createService(store);
  const result = await service.plan({
    contextId: stored.contextId,
    gestures: [
      {
        type: "vibrato",
        notes: [0],
        surface: "vibratoEnv",
        onsetDelayQuarter: 1,
        rampQuarter: 0.5,
      },
    ],
  });
  const operation = result.operations[0];
  assert.equal(operation.parameter, "vibratoEnv");
  assert.equal(operation.unit, "x");
  assert.equal(operation.baselineValue, 1);
  const points = result.applyRequests[0].arguments.curves[0].points;
  assert.equal(points[0].value, 1); // onset 前守卫回基线 1
  assert.equal(points[1].value, 0); // 延迟段压平包络
  approx(points[points.length - 1].value, 1, 1e-9); // level 默认 1，音尾即基线
  await assert.rejects(
    service.plan({
      contextId: stored.contextId,
      gestures: [
        { type: "vibrato", notes: [0], surface: "vibratoEnv" },
        { type: "vibrato", notes: [0], surface: "vibratoEnv", level: 1.5 },
      ],
    }),
    (error) => error.code === "PLAN_CONFLICT"
  );
});

test("hairpin peaks at the requested position in the parameter's own unit", async () => {
  const store = createStore();
  const { stored, occurrenceId } = createStoredContext(store, {
    notes: [
      { onsetBlick: 0, durationBlick: 2 * Q, pitch: 60 },
      { onsetBlick: 2 * Q, durationBlick: 2 * Q, pitch: 64 },
    ],
  });
  const result = await createService(store).plan({
    contextId: stored.contextId,
    gestures: [
      {
        type: "hairpin",
        from: 0,
        to: 1,
        peak: 0.5,
        amounts: { loudness: 3 },
      },
    ],
  });
  const operation = result.operations[0];
  assert.equal(operation.parameter, "loudness");
  assert.equal(operation.unit, "dB");
  approx(operation.stats.max, 3, 1e-6);
  const peak = result.applyRequests[0].arguments.curves[0].points.find(
    (point) => point.blick === 2 * Q
  );
  approx(peak.value, 3, 1e-6);
});

test("overlapping gestures on one parameter merge additively into one operation", async () => {
  const store = createStore();
  const { stored, occurrenceId } = createStoredContext(store, {
    notes: [{ onsetBlick: 0, durationBlick: 4 * Q, pitch: 65 }],
  });
  const result = await createService(store).plan({
    contextId: stored.contextId,
    gestures: [
      { type: "scoop", targets: [[0, 30]], lengthQuarter: 0.5 },
      { type: "vibrato", notes: [0], depthCents: 25 },
    ],
  });
  assert.equal(result.summary.operationCount, 1);
  assert.equal(result.operations[0].fromGestures.length, 2);
  assert.equal(result.summary.applyCallCount, 1);
  const onsetPoint = result.applyRequests[0].arguments.curves[0].points.find(
    (point) => point.blick === 0
  );
  approx(onsetPoint.value, -30);
});

test("disjoint clusters of one parameter partition into sequential apply calls", async () => {
  const store = createStore();
  const { stored, occurrenceId } = createStoredContext(store, {
    notes: [
      { onsetBlick: 0, durationBlick: Q, pitch: 60 },
      { onsetBlick: 4 * Q, durationBlick: Q, pitch: 62 },
    ],
  });
  const result = await createService(store).plan({
    contextId: stored.contextId,
    gestures: [
      { type: "scoop", targets: [[0, 30]], lengthQuarter: 0.25 },
      { type: "scoop", targets: [[1, 30]], lengthQuarter: 0.25 },
    ],
  });
  assert.equal(result.summary.operationCount, 2);
  assert.equal(result.summary.applyCallCount, 2);
  assert.equal(result.summary.expectedUserUndoSteps, 2);
  assert.equal(result.applyRequests.length, 2);
  assert.ok(result.review.checklist.some((item) => /2 sequential batch calls/.test(item)));
  assertApplyRequestsWellFormed(result);
});

// ---------- 意图薄映射 ----------

function intentFixtureNotes() {
  // 两个乐句：n0-n1（n1 为 3Q 长音 climax），休止 2Q，n2 独立短句。
  return [
    { onsetBlick: 0, durationBlick: Q, pitch: 60, lyrics: "when" },
    { onsetBlick: Q, durationBlick: 3 * Q, pitch: 66, lyrics: "see" },
    { onsetBlick: 6 * Q, durationBlick: Q, pitch: 62, lyrics: "あ" },
  ];
}

test("jpop intent derives deterministic per-phrase scoops with heuristic confidence", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, { notes: intentFixtureNotes() });
  const service = createService(store);
  const first = await service.plan({ contextId: stored.contextId, intent: { genre: "jpop" } });
  const second = await service.plan({ contextId: stored.contextId, intent: { genre: "jpop" } });
  assert.equal(first.summary.intentGestureCount, 2); // 每乐句入口一个 scoop
  const gesture = first.gestures[0];
  assert.equal(gesture.type, "scoop");
  assert.equal(gesture.source, "intent:genre:jpop");
  assert.equal(gesture.confidence.kind, "heuristic_score");
  assert.equal(gesture.confidence.calibrated, false);
  assert.equal(first.planId, second.planId); // 确定性：同数据同请求 → 同 planId
  assert.deepEqual(first.applyRequests, second.applyRequests);
});

test("intent-derived gestures skip every non-melodic event with structured warnings", async () => {
  const store = createStore();
  // br / orphan +/- / 单独 apostrophe 均不提供高层旋律证据；后续合法 +/- 链仍保留。
  const { stored, occurrenceId } = createStoredContext(store, {
    notes: [
      { onsetBlick: 0, durationBlick: Q, pitch: 60, lyrics: "br" },
      { onsetBlick: Q, durationBlick: Q, pitch: 61, lyrics: "+" },
      { onsetBlick: 2 * Q, durationBlick: Q, pitch: 62, lyrics: "-" },
      { onsetBlick: 3 * Q, durationBlick: Q, pitch: 63, lyrics: "'" },
      { onsetBlick: 4 * Q, durationBlick: Q, pitch: 60, lyrics: "when" },
      { onsetBlick: 5 * Q, durationBlick: Q, pitch: 62, lyrics: "+" },
      { onsetBlick: 6 * Q, durationBlick: Q, pitch: 64, lyrics: "-" },
      { onsetBlick: 9 * Q, durationBlick: Q, pitch: 64, lyrics: "br" },
      { onsetBlick: 10 * Q, durationBlick: Q, pitch: 62, lyrics: "あ" },
    ],
  });
  const result = await createService(store).plan({
    contextId: stored.contextId,
    intent: { genre: "jpop" },
  });
  const scoops = result.gestures.filter((gesture) => gesture.type === "scoop");
  assert.equal(scoops.length, 2);
  assert.deepEqual(
    scoops.map((gesture) => gesture.noteIndexes[0]),
    [4, 8]
  );
  const skipped = result.warnings.filter(
    (warning) => warning.code === "NON_MELODIC_SPECIAL_EVENT_SKIPPED"
  );
  assert.deepEqual(
    skipped.map((warning) => warning.semanticRole),
    [
      "breath_event",
      "syllable_continuation",
      "phonation_continuation",
      "unknown_special",
      "breath_event",
    ]
  );
  assert.ok(
    skipped.every(
      (warning) => Number.isSafeInteger(warning.noteIndex) && warning.evidence
    )
  );
  assert.ok(
    skipped.find((warning) => warning.semanticRole === "syllable_continuation")
      .issueCodes.includes("ORPHAN_PLUS")
  );
  assert.ok(
    skipped.find((warning) => warning.semanticRole === "phonation_continuation")
      .issueCodes.includes("ORPHAN_PHONATION_CONTINUATION")
  );
  assert.equal(result.provenance.specialLyrics, "official_v2_manual_enter_notes");

  // 显式表现手法不受 intent 过滤：用户点名 br 音符仍可规划。
  const explicit = await createService(store).plan({
    contextId: stored.contextId,
    gestures: [{ type: "fall", targets: [[0, 40]] }],
  });
  assert.equal(explicit.gestures[0].noteIndexes[0], 0);
});

test("intent treats only exact lowercase br as breath and keeps valid continuations melodic", async () => {
  const store = createStore();
  const { stored, occurrenceId } = createStoredContext(store, {
    notes: [
      { onsetBlick: 0, durationBlick: Q, pitch: 60, lyrics: "BR" },
      { onsetBlick: Q, durationBlick: Q, pitch: 62, lyrics: "+" },
      { onsetBlick: 2 * Q, durationBlick: Q, pitch: 64, lyrics: "-" },
      { onsetBlick: 4 * Q, durationBlick: Q, pitch: 65, lyrics: "br" },
      { onsetBlick: 5 * Q, durationBlick: Q, pitch: 67, lyrics: "word" },
    ],
  });
  const result = await createService(store).plan({
    contextId: stored.contextId,
    intent: { genre: "jpop" },
  });
  const scoops = result.gestures.filter((gesture) => gesture.type === "scoop");
  assert.deepEqual(
    scoops.map((gesture) => gesture.noteIndexes[0]),
    [0, 4]
  );
  assert.ok(
    result.warnings.some(
      (warning) =>
        warning.code === "SUSPICIOUS_SPECIAL_LYRIC_VARIANT" &&
        warning.notes.some((note) => note.indexInGroup === 0)
    )
  );
  assert.deepEqual(
    result.warnings
      .filter((warning) => warning.code === "NON_MELODIC_SPECIAL_EVENT_SKIPPED")
      .map((warning) => warning.noteIndex),
    [3]
  );
});

test("an all-excluded intent range returns no_change with warnings instead of an empty write", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, {
    notes: [
      { onsetBlick: 0, durationBlick: Q, pitch: 60, lyrics: "br" },
      { onsetBlick: Q, durationBlick: Q, pitch: 62, lyrics: "+" },
      { onsetBlick: 2 * Q, durationBlick: Q, pitch: 64, lyrics: "'" },
    ],
  });
  const result = await createService(store).plan({
    contextId: stored.contextId,
    intent: { genre: "jpop" },
  });
  assert.equal(result.status, "no_change");
  assert.equal(result.summary.gestureCount, 0);
  assert.equal(result.summary.operationCount, 0);
  assert.equal(result.summary.applyCallCount, 0);
  assert.equal(result.summary.expectedUserUndoSteps, 0);
  assert.equal(result.apply, null);
  assert.deepEqual(result.applyRequests, []);
  assert.equal(
    result.warnings.filter(
      (warning) => warning.code === "NON_MELODIC_SPECIAL_EVENT_SKIPPED"
    ).length,
    3
  );
});

test("controlled_belt derives phrase arcs and sustain vibrato; cool_anger modifies them", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, { notes: intentFixtureNotes() });
  const result = await createService(store).plan({
    contextId: stored.contextId,
    intent: { technique: ["controlled_belt"], emotion: "cool_anger", section: "prechorus" },
  });
  const parameters = result.summary.parameters;
  assert.ok(parameters.includes("loudness"));
  assert.ok(parameters.includes("tension"));
  assert.ok(parameters.includes("pitchDelta")); // 长音颤音
  const tensionGesture = result.gestures.find((gesture) => gesture.parameter === "tension");
  approx(tensionGesture.params.amount, 0.17, 1e-9); // 0.12 + cool_anger 0.05
  assert.ok(tensionGesture.reasons.some((reason) => /cool_anger/.test(reason)));
  const loudnessGesture = result.gestures.find((gesture) => gesture.parameter === "loudness");
  approx(loudnessGesture.params.amount, 4, 1e-9); // 3 + prechorus 1
});

test("light_rasp warns about low-confidence approximation", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, { notes: intentFixtureNotes() });
  const result = await createService(store).plan({
    contextId: stored.contextId,
    intent: { technique: ["light_rasp"] },
  });
  assert.ok(result.warnings.some((warning) => warning.code === "LOW_CONFIDENCE_INTENT"));
  const gesture = result.gestures.find((item) => item.parameter === "tension");
  assert.equal(gesture.confidence.score, 0.3);
});

test("section-only intent seeds a baseline plan instead of EMPTY_PLAN", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, { notes: intentFixtureNotes() });
  const result = await createService(store).plan({
    contextId: stored.contextId,
    intent: { section: "chorus" },
  });
  assert.equal(result.status, "planned");
  assertApplyRequestsWellFormed(result);
  assert.ok(result.summary.parameters.includes("loudness"));
  assert.ok(result.gestures.length >= 1);
  assert.ok(result.gestures.every((gesture) => gesture.source === "intent:section:chorus"));
  assert.ok(result.gestures.some((gesture) => gesture.reasons.some((reason) => /chorus/.test(reason))));
});

test("emotion-only intent seeds a baseline plan instead of EMPTY_PLAN", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, { notes: intentFixtureNotes() });
  const result = await createService(store).plan({
    contextId: stored.contextId,
    intent: { emotion: "tender" },
  });
  assert.equal(result.status, "planned");
  assertApplyRequestsWellFormed(result);
  assert.ok(result.summary.parameters.includes("breathiness"));
  assert.ok(result.summary.parameters.includes("loudness")); // 无 section 时 tender 另补柔和 loudness
  assert.ok(result.gestures.every((gesture) => gesture.source === "intent:emotion:tender"));
});

test("section + emotion together do not double-drive loudness", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, { notes: intentFixtureNotes() });
  const result = await createService(store).plan({
    contextId: stored.contextId,
    intent: { section: "verse", emotion: "cool_anger" },
  });
  assert.equal(result.status, "planned");
  assert.ok(result.summary.parameters.includes("loudness")); // section 驱动
  assert.ok(result.summary.parameters.includes("tension")); // cool_anger 驱动
  const loudnessGestures = result.gestures.filter((gesture) => gesture.parameter === "loudness");
  assert.equal(loudnessGestures.length, 2); // 每乐句恰一条 loudness，cool_anger 不再另加
});

test("plan attaches referenced note fingerprints to each apply target (F1 drift guard)", async () => {
  const store = createStore();
  const { stored, occurrenceId } = createStoredContext(store, {
    notes: intentFixtureNotes(),
    timeOffsetBlick: 2 * Q,
  });
  const result = await createService(store).plan({
    contextId: stored.contextId,
    gestures: [
      {
        type: "hairpin",
        from: 0,
        to: 1,
        amounts: { loudness: 3 },
      },
    ],
  });
  const target = result.applyRequests[0].arguments.target;
  // R2：快照时 reference 偏移被一并锁进 target，setTimeOffset 移动在 apply 预检即失败。
  assert.equal(target.expectedTimeOffsetBlick, 2 * Q);
  assert.ok(Array.isArray(target.expectedNotes));
  const byIndex = new Map(target.expectedNotes.map((note) => [note.indexInGroup, note]));
  // 表现手法锚定 n0、n1 → 指纹须与快照一致（apply 前 verifyAnchoredNote 会逐字段比对）。
  assert.equal(byIndex.get(0).onsetBlick, 0);
  assert.equal(byIndex.get(0).pitch, 60);
  assert.equal(byIndex.get(1).onsetBlick, Q);
  assert.equal(byIndex.get(1).durationBlick, 3 * Q);
  assert.equal(byIndex.get(1).pitch, 66);
  assert.ok(!byIndex.has(2)); // 未被引用的 n2 不携带
});

test("explicit gestures supersede overlapping intent candidates", async () => {
  const store = createStore();
  const { stored, occurrenceId } = createStoredContext(store, { notes: intentFixtureNotes() });
  const result = await createService(store).plan({
    contextId: stored.contextId,
    intent: { genre: "jpop" },
    gestures: [{ type: "scoop", targets: [[0, 55]] }],
  });
  assert.ok(result.warnings.some((warning) => warning.code === "INTENT_GESTURE_SUPERSEDED"));
  assert.equal(result.summary.explicitGestureCount, 1);
  assert.equal(result.summary.intentGestureCount, 1); // 只剩第二乐句的意图 scoop
});

// ---------- 约束、预算与错误路径 ----------

test("constraint clamping bounds values and reports honestly", async () => {
  const store = createStore();
  const { stored, occurrenceId } = createStoredContext(store, {
    notes: [{ onsetBlick: 0, durationBlick: 2 * Q, pitch: 60 }],
  });
  const result = await createService(store).plan({
    contextId: stored.contextId,
    constraints: { maxAbsPitchDeltaCents: 100 },
    gestures: [{ type: "scoop", targets: [[0, 300]] }],
  });
  const values = result.applyRequests[0].arguments.curves[0].points.map((point) => point.value);
  assert.equal(Math.min(...values), -100);
  assert.ok(result.operations[0].clampedCount > 0);
  assert.ok(result.warnings.some((warning) => warning.code === "CONSTRAINT_CLAMPED"));
});

test("plans over the point budget fail with PLAN_TOO_DENSE", async () => {
  const store = createStore();
  const { stored, occurrenceId } = createStoredContext(store, {
    notes: [{ onsetBlick: 0, durationBlick: 8 * Q, pitch: 65 }],
  });
  await assert.rejects(
    createService(store).plan({
      contextId: stored.contextId,
      constraints: { maxTotalPoints: 16 },
      gestures: [{ type: "vibrato", notes: [0] }],
    }),
    (error) => {
      assert.equal(error.code, "PLAN_TOO_DENSE");
      assert.ok(error.details.totalPoints > 16);
      return true;
    }
  );
});

test("plan resolves contexts and notes honestly across error paths", async () => {
  const store = createStore();
  const service = createService(store);
  await assert.rejects(
    service.plan({ contextId: "ctx_missing", intent: { genre: "jpop" } }),
    (error) => error.code === "UNKNOWN_CONTEXT"
  );
  const noNotes = createStoredContext(store, { notes: [] });
  await assert.rejects(
    service.plan({ contextId: noNotes.stored.contextId, intent: { genre: "jpop" } }),
    (error) => error.code === "OCCURRENCE_NOT_CAPTURED"
  );
  const ambiguous = createStoredContext(store, {
    notes: [{ onsetBlick: 0, durationBlick: Q, pitch: 60 }],
    extraOccurrenceWithNotes: true,
  });
  await assert.rejects(
    service.plan({ contextId: ambiguous.stored.contextId, intent: { genre: "jpop" } }),
    (error) => {
      assert.equal(error.code, "AMBIGUOUS_CONTEXT");
      assert.deepEqual(error.details.candidates, [0, 1]);
      return true;
    }
  );
  const single = createStoredContext(store, {
    notes: [{ onsetBlick: 0, durationBlick: Q, pitch: 60 }],
  });
  await assert.rejects(
    service.plan({
      contextId: single.stored.contextId,
      occurrence: 7,
      gestures: [{ type: "scoop", targets: [[0, 30]] }],
    }),
    (error) => error.code === "OCCURRENCE_INDEX_OUT_OF_RANGE"
  );
  await assert.rejects(
    service.plan({
      contextId: single.stored.contextId,
      gestures: [{ type: "scoop", targets: [[9, 30]] }],
    }),
    (error) => error.code === "NOTE_INDEX_OUT_OF_RANGE"
  );
  // 意图对短乐句派生不出任何候选且无显式表现手法 → EMPTY_PLAN。
  await assert.rejects(
    service.plan({
      contextId: single.stored.contextId,
      intent: { technique: ["controlled_belt"] }, // 无 >=2Q 长音
    }),
    (error) => error.code === "EMPTY_PLAN"
  );
});

test("plan validates request shape before touching the store", async () => {
  const store = createStore();
  const service = createService(store);
  for (const request of [
    {},
    { contextId: "ctx_x" }, // 既无 gestures 也无 intent
    { contextId: "ctx_x", bogus: true },
    { contextId: "ctx_x", gestures: [{ type: "bogus" }] },
    { contextId: "ctx_x", gestures: [{ type: "scoop" }] }, // 缺 targets
    { contextId: "ctx_x", gestures: [{ type: "scoop", targets: [[0, 9000]] }] },
    { contextId: "ctx_x", intent: { genre: "metal" } },
    { contextId: "ctx_x", intent: {} },
    {
      contextId: "ctx_x",
      gestures: [{ type: "vibrato", notes: [0], surface: "vibratoEnv", depthCents: 20 }],
    },
    { contextId: "ctx_x", intent: { genre: "jpop" }, responseMode: "loud" },
  ]) {
    await assert.rejects(service.plan(request), (error) => error.code === "INVALID_ARGUMENTS");
  }
});

test("compact responses keep summary, applyRequests, and review only", async () => {
  const store = createStore();
  const { stored, occurrenceId } = createStoredContext(store, {
    notes: [{ onsetBlick: 0, durationBlick: 2 * Q, pitch: 60 }],
  });
  const result = await createService(store).plan({
    contextId: stored.contextId,
    responseMode: "compact",
    gestures: [{ type: "scoop", targets: [[0, 30]] }],
  });
  assert.equal(result.gestures, undefined);
  assert.equal(result.operations, undefined);
  assert.ok(result.summary);
  assert.ok(result.applyRequests[0].arguments.curves[0].points.length > 0);
  assert.ok(result.review.checklist.length > 0);
});

test("shared targets surface in review and default constraints are exposed", async () => {
  const store = createStore();
  const { stored, occurrenceId } = createStoredContext(store, {
    notes: [{ onsetBlick: 0, durationBlick: 2 * Q, pitch: 60 }],
    sharedTargetOccurrences: ["occ-a", "occ-b"],
  });
  const result = await createService(store).plan({
    contextId: stored.contextId,
    gestures: [{ type: "scoop", targets: [[0, 30]] }],
  });
  assert.equal(result.review.requiresSharedTargetConfirmation, true);
  assert.ok(result.review.checklist.some((item) => /allowSharedTargetMutation/.test(item)));
  assert.equal(EXPRESSION_PLAN_DEFAULTS.constraints.maxAbsPitchDeltaCents, 200);
});

// ---------- v0.7.1 section-aware presets（M-04：可审阅常量展开，非黑箱） ----------

function presetFixtureNotes() {
  return [
    { onsetBlick: 0, durationBlick: Q, pitch: 60, lyrics: "a" },
    { onsetBlick: Q, durationBlick: 3 * Q, pitch: 64, lyrics: "hold" }, // 长音（≥2 拍）
    { onsetBlick: 5 * Q, durationBlick: Q, pitch: 62, lyrics: "b" }, // 1 拍休止 → 第二乐句
  ];
}

test("jpop_belt preset expands to genre+technique with a reviewable presetExpansion block", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, { notes: presetFixtureNotes() });
  const result = await createService(store).plan({
    contextId: stored.contextId,
    intent: { preset: "jpop_belt" },
  });
  assert.equal(result.presetExpansion.preset, "jpop_belt");
  assert.deepEqual(result.presetExpansion.expandedFields, {
    genre: "jpop",
    technique: ["controlled_belt"],
  });
  assert.deepEqual(result.presetExpansion.overriddenFields, []);
  assert.ok(result.presetExpansion.notes.length > 0);
  // 展开后的意图确实驱动了表现手法：jpop scoop + belt 弧线。
  assert.ok(result.gestures.some((gesture) => gesture.source === "intent:genre:jpop"));
  assert.ok(
    result.gestures.some((gesture) => gesture.source === "intent:technique:controlled_belt")
  );
  assert.ok(!result.warnings.some((warning) => warning.code === "PRESET_FIELD_OVERRIDDEN"));
});

test("explicit intent fields override the preset's values with a warning", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, { notes: presetFixtureNotes() });
  const result = await createService(store).plan({
    contextId: stored.contextId,
    // intimate_whisper 预设 emotion=tender；用户显式 cool_anger 覆盖。
    intent: { preset: "intimate_whisper", emotion: "cool_anger" },
  });
  assert.deepEqual(result.presetExpansion.expandedFields, { technique: ["soft_airy"] });
  assert.deepEqual(result.presetExpansion.overriddenFields, [
    { field: "emotion", presetValue: "tender", userValue: "cool_anger" },
  ]);
  assert.ok(result.warnings.some((warning) => warning.code === "PRESET_FIELD_OVERRIDDEN"));
});

test("preset constraint defaults apply but explicit constraints always win", async () => {
  const store = createStore();
  const first = createStoredContext(store, { notes: presetFixtureNotes() });
  // intimate_whisper 预设默认 maxAbsLoudnessDeltaDb=3。
  const defaulted = await createService(store).plan({
    contextId: first.stored.contextId,
    intent: { preset: "intimate_whisper" },
  });
  assert.equal(defaulted.presetExpansion.constraintDefaults.maxAbsLoudnessDeltaDb, 3);
  const second = createStoredContext(store, { notes: presetFixtureNotes() });
  // 用户显式 constraints 优先于 preset 默认值：8 dB 上限下 soft_airy 的 -1.5 弧线不再被 3 dB 束缚
  //（本例值域内两者等价，行为差异用 planId 不同来证明约束确实参与编译）。
  const overridden = await createService(store).plan({
    contextId: second.stored.contextId,
    intent: { preset: "intimate_whisper" },
    constraints: { maxAbsLoudnessDeltaDb: 0.5 },
  });
  // 0.5 dB 上限截断了 loudness 弧线的值，计划内容必然不同。
  const defaultedLoudness = defaulted.operations.find((op) => op.parameter === "loudness");
  const overriddenLoudness = overridden.operations.find((op) => op.parameter === "loudness");
  assert.ok(Math.abs(defaultedLoudness.stats.min) > 0.5);
  assert.ok(Math.abs(overriddenLoudness.stats.min) <= 0.5);
  assert.ok(overridden.warnings.some((warning) => warning.code === "CONSTRAINT_CLAMPED"));
});

test("spoken_rap_transition seeds vibratoEnv flattening on sustains", async () => {
  const store = createStore();
  const { stored, occurrenceId } = createStoredContext(store, { notes: presetFixtureNotes() });
  const result = await createService(store).plan({
    contextId: stored.contextId,
    intent: { preset: "spoken_rap_transition" },
  });
  const flattened = result.gestures.filter(
    (gesture) => gesture.source === "intent:preset:spoken_rap_transition"
  );
  assert.equal(flattened.length, 1);
  assert.equal(flattened[0].parameter, "vibratoEnv");
  assert.deepEqual(flattened[0].noteIndexes, [1]);
  assert.equal(flattened[0].params.level, 0.2);
  // preset 收窄 pitchDelta 预算进入 constraintDefaults 回显。
  assert.equal(result.presetExpansion.constraintDefaults.maxAbsPitchDeltaCents, 40);
  assert.ok(result.warnings.some((warning) => warning.code === "NATURAL_VIBRATO_UNOBSERVABLE"));
  assertApplyRequestsWellFormed(result);
});

test("identical preset requests keep planId deterministic", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, { notes: presetFixtureNotes() });
  const service = createService(store);
  const request = { contextId: stored.contextId, intent: { preset: "jpop_cool" } };
  const first = await service.plan(request);
  const second = await service.plan(request);
  assert.equal(first.planId, second.planId);
  assert.equal(first.presetExpansion.preset, "jpop_cool");
  // jpop_cool = genre:jpop + emotion:cool_anger：scoop 深度带 cool_anger 的 +5 修饰。
  const scoop = first.gestures.find((gesture) => gesture.type === "scoop");
  assert.equal(scoop.params.depthCents, 35);
});

test("unknown presets are rejected before touching the store", async () => {
  const store = createStore();
  const service = createService(store);
  await assert.rejects(
    service.plan({ contextId: "ctx_x", intent: { preset: "magic_button" } }),
    (error) => error.code === "INVALID_ARGUMENTS"
  );
});
