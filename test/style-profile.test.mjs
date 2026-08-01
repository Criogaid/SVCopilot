import assert from "node:assert/strict";
import test from "node:test";

import { StyleProfileService } from "../server/src/style-profile.js";
import { SnapshotStore } from "../server/src/snapshot.js";

const Q = 705600000;

function createStore() {
  return new SnapshotStore({ now: () => 1000 });
}

// 与 phrase-analysis 测试同模式的 range context 装配；style-profile 额外可挂
// automation/voiceParameters（v0.7.0 基础层留存的纯数据剖面）。
function createStoredContext(store, options = {}) {
  const {
    notes = [],
    automation = null,
    voiceParameters,
    extraOccurrenceWithNotes = false,
    uuid = "uuid-style-test",
  } = options;
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
    languageOverride: note.languageOverride ?? "",
    detuneCents: note.detuneCents ?? 0,
  }));
  stored.context.occurrences.push({
    occurrence: 0,
    trackIndex: 0,
    groupIndex: 0,
    targetGroupUuid: uuid,
    timeOffsetBlick: 0,
    pitchOffsetSemitone: 0,
    sharedTargetOccurrences: [0],
    noteFingerprints,
    ...(voiceParameters !== undefined ? { voiceParameters } : {}),
  });
  if (extraOccurrenceWithNotes) {
    stored.context.occurrences.push({
      occurrence: 1,
      trackIndex: 0,
      groupIndex: 1,
      targetGroupUuid: uuid,
      timeOffsetBlick: 0,
      pitchOffsetSemitone: 0,
      sharedTargetOccurrences: [0, 1],
      noteFingerprints: noteFingerprints.map((fingerprint) => ({ ...fingerprint })),
    });
  }
  stored.context.quarterBlick = Q;
  stored.context.meterMarks = [{ position: 0, positionBlick: 0, numerator: 4, denominator: 4 }];
  stored.context.tempoMarks = [{ positionBlick: 0, positionSeconds: 0, bpm: 120 }];
  stored.context.automationCaptured = automation !== null;
  stored.context.automationByOccurrence = Object.create(null);
  if (automation !== null) {
    stored.context.automationByOccurrence[0] = automation;
  }
  return { stored };
}

function createService(store) {
  return new StyleProfileService({ store, now: () => 2000 });
}

function simpleNotes() {
  return [
    { onsetBlick: 0, durationBlick: Q, pitch: 60, lyrics: "a" },
    { onsetBlick: Q, durationBlick: Q, pitch: 62, lyrics: "b" },
    { onsetBlick: 2 * Q, durationBlick: 2 * Q, pitch: 64, lyrics: "c" },
    // 1 拍休止 → 第二乐句
    { onsetBlick: 5 * Q, durationBlick: Q, pitch: 67, lyrics: "d", languageOverride: "english" },
    { onsetBlick: 6 * Q, durationBlick: Q, pitch: 65, lyrics: "br" },
  ];
}

test("single-target profile reports melodic statistics with breaths separated", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, { notes: simpleNotes() });
  const result = await createService(store).profile({
    targets: [{ contextId: stored.contextId }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.targetCount, 1);
  const target = result.targets[0];
  assert.equal(target.noteCount, 4); // br 剥离
  assert.equal(target.breathCount, 1);
  assert.equal(target.sections.register.minPitch, 60);
  assert.equal(target.sections.register.maxPitch, 67);
  assert.equal(target.sections.intervals.count, 3);
  assert.equal(target.sections.phrases.count, 2);
  assert.equal(target.sections.breaths.count, 1);
  assert.equal(target.sections.languages.overrideHistogram.english, 1);
  assert.equal(target.sections.languages.overrideHistogram.none, 3);
  assert.equal(target.sections.languages.mixedLanguages, false);
  assert.equal(result.aggregate.overall.noteCount, 4);
  assert.equal(result.aggregate.overall.register.ambitusSemitones, 7);
  assert.equal(result.provenance.sectionLabels, "caller_provided_not_inferred");
  assert.equal(result.provenance.parameterStatistics, "automation_control_points_not_rendered_curve");
});

test("multi-target aggregate pools samples and groups by caller-provided labels", async () => {
  const store = createStore();
  const verse = createStoredContext(store, {
    notes: [
      { onsetBlick: 0, durationBlick: Q, pitch: 55, lyrics: "v1" },
      { onsetBlick: Q, durationBlick: Q, pitch: 57, lyrics: "v2" },
    ],
    uuid: "uuid-verse",
  });
  const chorus = createStoredContext(store, {
    notes: [
      { onsetBlick: 0, durationBlick: Q, pitch: 67, lyrics: "c1" },
      { onsetBlick: Q, durationBlick: Q, pitch: 71, lyrics: "c2" },
    ],
    uuid: "uuid-chorus",
  });
  const result = await createService(store).profile({
    targets: [
      { contextId: verse.stored.contextId, label: "verse" },
      { contextId: chorus.stored.contextId, label: "chorus" },
    ],
    include: ["register", "intervals"],
  });
  // overall 用合并样本：中位数不是两侧中位数的平均。
  assert.equal(result.aggregate.overall.noteCount, 4);
  assert.equal(result.aggregate.overall.register.minPitch, 55);
  assert.equal(result.aggregate.overall.register.maxPitch, 71);
  assert.equal(result.aggregate.overall.register.ambitusSemitones, 16);
  // 音程不跨 target 边界：每 target 各 1 个。
  assert.equal(result.aggregate.overall.intervals.count, 2);
  // label 分组可并排比较，不下听感结论。
  assert.equal(result.aggregate.byLabel.verse.register.maxPitch, 57);
  assert.equal(result.aggregate.byLabel.chorus.register.minPitch, 67);
  assert.deepEqual(result.aggregate.byLabel.chorus.targetIndices, [1]);
});

test("parameter statistics describe control points and honor per-phrase spans", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, {
    notes: simpleNotes(),
    automation: [
      {
        requestedParameter: "loudness",
        resolvedParameter: "loudness",
        definition: { typeName: "loudness", range: [-48, 12], defaultValue: 0 },
        interpolationMethod: "Linear",
        points: [
          { localBlick: 0, absoluteBlick: 0, value: 0 },
          { localBlick: Q, absoluteBlick: Q, value: 2 },
          { localBlick: 5 * Q, absoluteBlick: 5 * Q, value: -1 },
        ],
      },
    ],
  });
  const result = await createService(store).profile({
    targets: [{ contextId: stored.contextId }],
    include: ["phrases", "parameters"],
  });
  const section = result.targets[0].sections.parameters;
  assert.equal(section.status, "captured");
  assert.equal(section.curves.length, 1);
  const curve = section.curves[0];
  assert.equal(curve.parameter, "loudness");
  assert.equal(curve.pointCount, 3);
  assert.equal(curve.min, -1);
  assert.equal(curve.max, 2);
  assert.equal(curve.defaultValue, 0);
  // 3 点中 2 点非默认值。
  assert.ok(Math.abs(curve.nonDefaultRatio - 2 / 3) < 1e-12);
  // 乐句分段：第一乐句 [0,4Q] 含 2 点，第二乐句 [5Q,7Q] 含 1 点。
  assert.equal(curve.perPhrase.length, 2);
  assert.equal(curve.perPhrase[0].pointCount, 2);
  assert.equal(curve.perPhrase[1].pointCount, 1);
  assert.equal(result.aggregate.overall.parameters.capturedTargets, 1);
  assert.equal(result.aggregate.overall.parameters.curves[0].pointCount, 3);
});

test("targets captured without automation report not_captured instead of fake zeros", async () => {
  const store = createStore();
  const withAutomation = createStoredContext(store, {
    notes: simpleNotes(),
    automation: [
      {
        requestedParameter: "tension",
        resolvedParameter: "tension",
        definition: { typeName: "tension", range: [-1, 1], defaultValue: 0 },
        interpolationMethod: "Linear",
        points: [{ localBlick: 0, absoluteBlick: 0, value: 0.2 }],
      },
    ],
    uuid: "uuid-a",
  });
  const withoutAutomation = createStoredContext(store, {
    notes: simpleNotes(),
    uuid: "uuid-b",
  });
  const result = await createService(store).profile({
    targets: [
      { contextId: withAutomation.stored.contextId },
      { contextId: withoutAutomation.stored.contextId },
    ],
    include: ["parameters"],
  });
  assert.equal(result.targets[0].sections.parameters.status, "captured");
  assert.equal(result.targets[1].sections.parameters.status, "not_captured");
  assert.ok(result.warnings.some((warning) => warning.code === "AUTOMATION_NOT_CAPTURED"));
  // 聚合只吃 captured 的 target，并如实报告缺数据侧。
  assert.equal(result.aggregate.overall.parameters.capturedTargets, 1);
  assert.equal(result.aggregate.overall.parameters.notCapturedTargets, 1);
});

test("vocal modes report observable keys with unobservable singer identity", async () => {
  const store = createStore();
  const captured = createStoredContext(store, {
    notes: simpleNotes(),
    voiceParameters: {
      paramLoudness: 0.1,
      vocalModeParams: { Power: { pitch: 0.5 }, Soft: { pitch: 0 } },
    },
    uuid: "uuid-a",
  });
  const missing = createStoredContext(store, { notes: simpleNotes(), uuid: "uuid-b" });
  const result = await createService(store).profile({
    targets: [{ contextId: captured.stored.contextId }, { contextId: missing.stored.contextId }],
    include: ["vocalModes"],
  });
  const section = result.targets[0].sections.vocalModes;
  assert.equal(section.status, "captured");
  assert.deepEqual(section.vocalModeNames, ["Power", "Soft"]);
  assert.equal(section.staticParameters.paramLoudness, 0.1);
  assert.equal(section.singerIdentity, "unobservable");
  assert.equal(result.targets[1].sections.vocalModes.status, "not_captured");
  assert.ok(result.warnings.some((warning) => warning.code === "VOICE_NOT_CAPTURED"));
  assert.deepEqual(result.aggregate.overall.vocalModes.vocalModeNames, ["Power", "Soft"]);
});

test("an all-breath target keeps null sections and the run fails only when every target is breath-only", async () => {
  const store = createStore();
  const breathOnly = createStoredContext(store, {
    notes: [{ onsetBlick: 0, durationBlick: Q, pitch: 60, lyrics: "br" }],
    uuid: "uuid-breath",
  });
  const melodic = createStoredContext(store, { notes: simpleNotes(), uuid: "uuid-melodic" });
  const mixed = await createService(store).profile({
    targets: [
      { contextId: breathOnly.stored.contextId },
      { contextId: melodic.stored.contextId },
    ],
    include: ["register", "breaths"],
  });
  assert.equal(mixed.targets[0].noteCount, 0);
  assert.equal(mixed.targets[0].sections.register, null);
  assert.equal(mixed.targets[0].sections.breaths.count, 1);
  assert.ok(mixed.warnings.some((warning) => warning.code === "TARGET_NO_MELODIC_NOTES"));

  await assert.rejects(
    createService(store).profile({ targets: [{ contextId: breathOnly.stored.contextId }] }),
    (error) => error.code === "NO_MELODIC_NOTES"
  );
});

test("every target carries its sections alongside the aggregate", async () => {
  // 单一响应形状（§4.4）：per-target sections 与 aggregate 一起返回，调用方不需要
  // 先猜一个 responseMode 再决定能读到什么。
  const store = createStore();
  const { stored } = createStoredContext(store, { notes: simpleNotes() });
  const result = await createService(store).profile({
    targets: [{ contextId: stored.contextId }],
  });
  assert.ok(result.targets[0].sections.register);
  assert.ok(result.aggregate.overall.register);
});

test("profile resolves contexts honestly across error paths", async () => {
  const store = createStore();
  const service = createService(store);
  await assert.rejects(
    service.profile({ targets: [{ contextId: "ctx_missing" }] }),
    (error) => error.code === "UNKNOWN_CONTEXT" && error.message.includes("targets[0]")
  );
  const ambiguous = createStoredContext(store, {
    notes: simpleNotes(),
    extraOccurrenceWithNotes: true,
  });
  await assert.rejects(
    service.profile({ targets: [{ contextId: ambiguous.stored.contextId }] }),
    (error) => {
      assert.equal(error.code, "AMBIGUOUS_CONTEXT");
      assert.equal(error.details.candidates.length, 2);
      return true;
    }
  );
  const empty = createStoredContext(store, { notes: [] });
  await assert.rejects(
    service.profile({ targets: [{ contextId: empty.stored.contextId }] }),
    (error) => error.code === "NOTES_NOT_CAPTURED"
  );
});

test("profile validates request shape and rejects duplicate targets", async () => {
  const store = createStore();
  const service = createService(store);
  const { stored } = createStoredContext(store, { notes: simpleNotes() });
  for (const request of [
    {},
    { targets: [] },
    { targets: [{ contextId: "" }] },
    { targets: [{ contextId: "ctx", bogus: 1 }] },
    { targets: [{ contextId: "ctx" }], include: [] },
    { targets: [{ contextId: "ctx" }], include: ["bogus"] },
    { targets: [{ contextId: "ctx" }], phraseGapQuarter: 0 },
    { targets: Array.from({ length: 9 }, () => ({ contextId: "ctx" })) },
    {
      targets: [{ contextId: stored.contextId }, { contextId: stored.contextId }],
    },
  ]) {
    await assert.rejects(service.profile(request), (error) => error.code === "INVALID_ARGUMENTS");
  }
});
