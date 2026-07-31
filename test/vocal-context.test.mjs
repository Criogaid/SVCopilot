import assert from "node:assert/strict";
import test from "node:test";

import { SnapshotStore } from "../server/src/snapshot.js";
import { VocalContextAnalysisService } from "../server/src/vocal-context.js";

// P0-C 验收：一次调用组合四个分析器，宿主调用数恒为 0，分区状态互不吞噬，
// 缺数据如实报 not_captured / insufficient_evidence 而不是造 0。

const Q = 705600000;

function createStore() {
  return new SnapshotStore({ now: () => 1000 });
}

function createContext(store, options = {}) {
  const {
    notes = [],
    computedPitchValues = null,
    extraOccurrenceNotes = null,
  } = options;
  const stored = store.create({
    epoch: 1,
    scope: { kind: "range" },
    observedAt: new Date(1000).toISOString(),
    context: { kind: "range", occurrences: [] },
  });
  const occurrenceId = `${stored.contextId}:t:0:r:0`;
  const build = (id, trackIndex, uuid, list) => ({
    occurrenceId: id,
    trackIndex,
    groupIndex: 0,
    targetGroupUuid: uuid,
    timeOffsetBlick: 0,
    pitchOffsetSemitone: 0,
    sharedTargetOccurrences: [id],
    noteFingerprints: list.map((note, index) => ({
      indexInGroup: index,
      onsetBlick: note.onsetBlick,
      durationBlick: note.durationBlick,
      pitch: note.pitch ?? 60,
      lyrics: note.lyrics ?? "a",
      phonemesOverride: note.phonemesOverride ?? "",
      languageOverride: note.languageOverride ?? "",
      detuneCents: 0,
      noteId: `${id}:n:${index}`,
    })),
  });
  stored.context.occurrences.push(build(occurrenceId, 0, "uuid-a", notes));
  if (extraOccurrenceNotes) {
    const second = `${stored.contextId}:t:1:r:0`;
    stored.context.occurrences.push(build(second, 1, "uuid-b", extraOccurrenceNotes));
  }
  if (computedPitchValues) {
    // computed pitch 存在 context 级 map 上（与 sv_snapshot_range 的实际存储一致）。
    stored.context.computedPitchByOccurrence = {
      [occurrenceId]: {
        startBlick: 0,
        intervalBlick: Q / 16,
        frames: computedPitchValues.length,
        values: computedPitchValues,
        evidence: {
          requestedFrames: computedPitchValues.length,
          observedFrames: computedPitchValues.filter(Number.isFinite).length,
          nullFrameIndices: computedPitchValues.flatMap((value, index) =>
            Number.isFinite(value) ? [] : [index]
          ),
        },
      },
    };
  }
  stored.context.quarterBlick = Q;
  stored.context.meterMarks = [{ position: 0, positionBlick: 0, numerator: 4, denominator: 4 }];
  stored.context.tempoMarks = [{ positionBlick: 0, positionSeconds: 0, bpm: 120 }];
  stored.context.range = {
    from: { bar: 1, beat: 1, tickInBeatBlick: 0, blick: 0 },
    to: { bar: 2, beat: 1, tickInBeatBlick: 0, blick: 4 * Q },
  };
  stored.snapshotToken = `snap_${stored.contextId}`;
  return { stored, occurrenceId };
}

const MELODY = [
  { onsetBlick: 0, durationBlick: Q, pitch: 69, lyrics: "ひ" },
  { onsetBlick: Q, durationBlick: Q, pitch: 71, lyrics: "か" },
  { onsetBlick: 2 * Q, durationBlick: Q, pitch: 72, lyrics: "り" },
  { onsetBlick: 3 * Q, durationBlick: Q, pitch: 74, lyrics: "の" },
  { onsetBlick: 4 * Q, durationBlick: Q, pitch: 76, lyrics: "な" },
  { onsetBlick: 5 * Q, durationBlick: Q, pitch: 74, lyrics: "か" },
];

function analyzer(store) {
  const service = new VocalContextAnalysisService({ store, now: () => 2000 });
  // 既有 section 断言走 standard；compact 专项测试显式请求 compact。
  return {
    style: service.style,
    analyze: (request) => service.analyze({ responseMode: "standard", ...request }),
  };
}

test("compact projection omits item lists while preserving decisions and detail pointers", async () => {
  const store = createStore();
  const { stored } = createContext(store, { notes: MELODY });
  const result = await analyzer(store).analyze({
    contextId: stored.contextId,
    responseMode: "compact",
  });
  assert.equal(result.sections, undefined);
  assert.equal(result.sectionIndex.style.status, "succeeded");
  assert.ok(result.sectionIndex.style.summary);
  assert.ok(Array.isArray(result.topFindings));
  assert.ok(Array.isArray(result.nextSteps));
});

test("one call returns every requested section from a single range context", async () => {
  const store = createStore();
  const { stored } = createContext(store, { notes: MELODY });
  const result = await analyzer(store).analyze({ contextId: stored.contextId });

  assert.equal(result.ok, true);
  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.requested, ["phrase", "prosody", "style", "computedPitch"]);
  assert.deepEqual(Object.keys(result.sections), ["phrase", "prosody", "style", "computedPitch"]);
  // 每个 section 都声明它的结论归属哪个既有分析器：组合层不新增音乐学权威。
  assert.equal(result.sections.phrase.authority, "sv_analyze_phrase");
  assert.equal(result.sections.prosody.authority, "sv_validate_lyrics_prosody");
  assert.equal(result.sections.style.authority, "sv_style_profile");
  assert.equal(result.sections.computedPitch.authority, "sv_compare_computed_pitch");
  assert.equal(result.provenance.hostAccess, "none_pure_in_memory_over_snapshot_store");
  assert.equal(result.provenance.perception, "human_only");
  assert.equal(result.summary.perception, "human_only");
});

test("composite style summary preserves the standalone style evidence", async () => {
  const store = createStore();
  const notes = [
    { onsetBlick: 0, durationBlick: Q, pitch: 69, lyrics: "ひ" },
    { onsetBlick: Q, durationBlick: Q, pitch: 71, lyrics: "か" },
    { onsetBlick: 2 * Q, durationBlick: Q, pitch: 72, lyrics: "り" },
    { onsetBlick: 3 * Q, durationBlick: Q, pitch: 60, lyrics: "br" },
  ];
  const { stored, occurrenceId } = createContext(store, { notes });
  const service = analyzer(store);
  const standalone = await service.style.profile({
    targets: [{ contextId: stored.contextId, occurrenceId }],
    responseMode: "standard",
  });
  const composite = await service.analyze({
    contextId: stored.contextId,
    occurrenceId,
    include: ["style"],
  });
  const target = standalone.targets[0];
  const summary = composite.sections.style.summary;

  assert.equal(standalone.targetCount, 1);
  assert.equal(target.noteCount, 3);
  assert.equal(target.breathCount, 1);
  assert.equal(composite.sections.style.status, "succeeded");
  assert.equal(summary.targetCount, standalone.targetCount);
  assert.ok(Object.keys(summary.sectionStatus).length > 0);
  assert.deepEqual(summary.rhythm, target.sections.rhythm);
  assert.deepEqual(summary.languages, target.sections.languages);
  assert.deepEqual(summary.breaths, target.sections.breaths);
});

test("the service never touches the host or the coordinator", async () => {
  const store = createStore();
  const { stored } = createContext(store, { notes: MELODY });
  // 没有 host session 被注入，任何宿主访问都会抛错；两次调用都必须成功。
  const service = analyzer(store);
  const first = await service.analyze({ contextId: stored.contextId });
  const second = await service.analyze({ contextId: stored.contextId });
  assert.equal(first.status, "succeeded");
  assert.equal(second.status, "succeeded");
  // 纯内存服务如实报告协调器等待与宿主操作恒为 0。
  assert.equal(first.timings.coordinatorQueueMs, 0);
  assert.equal(first.timings.operationMs, 0);
});

test("identical context and request produce identical output", async () => {
  const store = createStore();
  const { stored } = createContext(store, { notes: MELODY });
  const service = analyzer(store);
  const a = await service.analyze({ contextId: stored.contextId });
  const b = await service.analyze({ contextId: stored.contextId });
  const strip = (value) => JSON.stringify({ ...value, timings: null });
  assert.equal(strip(a), strip(b));
});

test("a missing section reports its own status without swallowing the others", async () => {
  const store = createStore();
  const { stored } = createContext(store, { notes: MELODY });
  const result = await analyzer(store).analyze({ contextId: stored.contextId });

  // 上下文没有 computedPitch：该 section not_captured，其余照常成功。
  assert.equal(result.sections.computedPitch.status, "not_captured");
  assert.equal(result.sections.computedPitch.reason.code, "COMPUTED_PITCH_NOT_CAPTURED");
  assert.match(result.sections.computedPitch.remedy, /include \["notes","computedPitch"\]/);
  assert.equal(result.sections.phrase.status, "succeeded");
  assert.equal(result.sections.prosody.status, "succeeded");
  assert.equal(result.sections.style.status, "succeeded");
  assert.equal(result.summary.usableSections, 3);
  assert.equal(result.summary.evidence, "partial_evidence");
  assert.ok(result.warnings.some((warning) => warning.code === "SECTION_UNAVAILABLE"));
});

test("missing computed pitch is reported as not-enough-data, never as zero error", async () => {
  const store = createStore();
  const { stored } = createContext(store, { notes: MELODY });
  const result = await analyzer(store).analyze({ contextId: stored.contextId });

  const section = result.sections.computedPitch;
  assert.equal(section.summary, undefined, "an unavailable section must not publish a summary");
  const serialized = JSON.stringify(section);
  assert.doesNotMatch(serialized, /"coverage":0\b/);
  assert.doesNotMatch(serialized, /"maeCent":0\b/);

  const step = result.nextSteps.find((entry) => entry.tool === "sv_snapshot_range");
  assert.ok(step, "uncaptured data must point at a new snapshot, not an unusable waiter call");
  assert.deepEqual(step.arguments.scope, {
    kind: "range",
    trackIndices: [0],
    from: { bar: 1, beat: 1 },
    to: { bar: 2, beat: 1 },
  });
  assert.deepEqual(step.arguments.include, ["notes", "computedPitch"]);
  assert.match(step.note, /NOT ENOUGH DATA TO ANALYZE/);
  assert.match(step.note, /never report it as zero error/);
});

test("every section carries a stateless detail pointer instead of a cursor", async () => {
  const store = createStore();
  const { stored, occurrenceId } = createContext(store, { notes: MELODY });
  const result = await analyzer(store).analyze({ contextId: stored.contextId });

  for (const [name, section] of Object.entries(result.sections)) {
    assert.ok(section.details, `${name} must expose a detail pointer`);
    assert.equal(section.details.tool, section.authority);
    assert.equal(section.details.arguments.responseMode, "verbose");
    // 明细通过重跑分析器获得，因此没有可过期的 cursor。
    assert.equal(section.detailCursor, undefined);
  }
  assert.equal(result.sections.phrase.details.arguments.contextId, stored.contextId);
  assert.equal(result.sections.phrase.details.arguments.occurrenceId, occurrenceId);
  assert.equal(
    result.sections.style.details.arguments.targets[0].occurrenceId,
    occurrenceId
  );
});

test("include selects sections and keeps a deterministic order", async () => {
  const store = createStore();
  const { stored } = createContext(store, { notes: MELODY });
  const result = await analyzer(store).analyze({
    contextId: stored.contextId,
    include: ["style", "phrase"],
  });
  assert.deepEqual(result.requested, ["phrase", "style"]);
  assert.deepEqual(Object.keys(result.sections), ["phrase", "style"]);
  assert.equal(result.summary.requestedSections, 2);
});

test("prosody issues surface as ranked findings with an actionable next step", async () => {
  const store = createStore();
  // "br" 换气带 languageOverride 是确定性 error 级问题。
  const { stored } = createContext(store, {
    notes: [
      ...MELODY,
      { onsetBlick: 6 * Q, durationBlick: Q, pitch: 60, lyrics: "br", languageOverride: "japanese" },
    ],
  });
  const result = await analyzer(store).analyze({
    contextId: stored.contextId,
    include: ["prosody"],
  });

  assert.equal(result.sections.prosody.status, "succeeded");
  assert.ok(result.summary.findingCount >= 1);
  const finding = result.topFindings[0];
  assert.equal(finding.source, "prosody");
  assert.equal(finding.authority, "sv_validate_lyrics_prosody");
  assert.ok(["error", "warning", "info"].includes(finding.severity));
  assert.deepEqual(finding.notes, [6]);
  assert.equal(finding.startBlick, 6 * Q);
  // 最高严重度排在最前，供 compact 模式直接展示。
  assert.ok(
    result.topFindings.every(
      (item, index, list) =>
        index === 0 ||
        ["error", "warning", "info"].indexOf(list[index - 1].severity) <=
          ["error", "warning", "info"].indexOf(item.severity)
    )
  );
});

test("composite preserves special-lyric gap evidence and does not call it clean", async () => {
  const store = createStore();
  const { stored, occurrenceId } = createContext(store, {
    notes: [
      { onsetBlick: 0, durationBlick: Q, pitch: 69, lyrics: "glory" },
      { onsetBlick: Q + 1, durationBlick: Q, pitch: 69, lyrics: "+" },
    ],
  });
  const result = await analyzer(store).analyze({
    contextId: stored.contextId,
    include: ["prosody"],
  });

  const issue = result.sections.prosody.issues.find(
    (item) => item.code === "SYLLABLE_CHAIN_GAP"
  );
  assert.ok(issue);
  assert.equal(issue.gapBlick, 1);
  const finding = result.topFindings.find((item) => item.code === "SYLLABLE_CHAIN_GAP");
  assert.ok(finding);
  assert.equal(finding.gapBlick, 1);
  assert.equal(finding.semanticRole, "syllable_continuation");
  assert.deepEqual(finding.notes, [0, 1]);
  assert.ok(
    result.nextSteps.some((step) => step.reason === "special_lyric_chain_findings_present")
  );
  assert.ok(result.nextSteps.every((step) => step.reason !== "no_blocking_finding"));
});

test("mixed findings preserve prosody identity and sort equal severity by score time", async () => {
  const store = createStore();
  const notes = MELODY.map((note, index) =>
    index === MELODY.length - 1 ? { ...note, lyrics: "きら" } : note
  );
  const { stored } = createContext(store, {
    notes,
    // 第一个音符偏低一个半音，产生比末尾 mora warning 更早的 warning。
    computedPitchValues: pitchFramesForMelody([-1, 0, 0, 0, 0, 0]),
  });
  const result = await analyzer(store).analyze({
    contextId: stored.contextId,
    include: ["prosody", "computedPitch"],
  });

  const warnings = result.topFindings.filter((finding) => finding.severity === "warning");
  const pitchIndex = warnings.findIndex((finding) => finding.source === "computedPitch");
  const prosodyIndex = warnings.findIndex((finding) => finding.source === "prosody");
  assert.ok(pitchIndex >= 0 && prosodyIndex >= 0);
  assert.ok(pitchIndex < prosodyIndex, "equal-severity findings must follow score time");
  assert.deepEqual(warnings[prosodyIndex].notes, [MELODY.length - 1]);
  assert.equal(warnings[prosodyIndex].startBlick, 5 * Q);
});

test("an all-breath range degrades to insufficient_evidence rather than failing the call", async () => {
  const store = createStore();
  const { stored } = createContext(store, {
    notes: [
      { onsetBlick: 0, durationBlick: Q, pitch: 60, lyrics: "br" },
      { onsetBlick: 2 * Q, durationBlick: Q, pitch: 60, lyrics: "br" },
    ],
    computedPitchValues: [60, 60],
  });
  const result = await analyzer(store).analyze({
    contextId: stored.contextId,
    include: ["phrase", "prosody", "computedPitch"],
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.sections.phrase.status, "insufficient_evidence");
  assert.equal(result.sections.phrase.reason.code, "NO_MELODIC_NOTES");
  assert.match(result.sections.phrase.remedy, /only breath notes/);
  // 韵律检查对纯换气仍然有效，不被乐句分析的不足拖垮。
  assert.equal(result.sections.prosody.status, "succeeded");
  assert.equal(result.sections.computedPitch.status, "insufficient_evidence");
  assert.equal(result.sections.computedPitch.reason.code, "NO_MELODIC_EVIDENCE");
  assert.ok(result.nextSteps.every((step) => step.tool !== "sv_wait_for_processing"));
});

test("no usable section reports no evidence rather than no problems", async () => {
  const store = createStore();
  const { stored } = createContext(store, {
    notes: [{ onsetBlick: 0, durationBlick: Q, pitch: 60, lyrics: "br" }],
  });
  const result = await analyzer(store).analyze({
    contextId: stored.contextId,
    include: ["phrase"],
  });
  assert.equal(result.summary.usableSections, 0);
  assert.equal(result.summary.evidence, "no_section_produced_evidence");
});

test("request-level problems fail the whole call instead of faking partial results", async () => {
  const store = createStore();
  const { stored } = createContext(store, {
    notes: MELODY,
    extraOccurrenceNotes: MELODY,
  });

  await assert.rejects(
    () => analyzer(store).analyze({ contextId: "ctx_missing" }),
    (error) => error.code === "UNKNOWN_CONTEXT"
  );
  await assert.rejects(
    () => analyzer(store).analyze({ contextId: stored.contextId, occurrenceId: "ctx_x:t:9:r:9" }),
    (error) => error.code === "UNKNOWN_OCCURRENCE"
  );
  // 多个候选 occurrence 必须要求调用方明确指定，而不是自己挑一个。
  await assert.rejects(
    () => analyzer(store).analyze({ contextId: stored.contextId }),
    (error) => error.code === "AMBIGUOUS_CONTEXT"
  );
});

test("malformed requests are rejected before any analysis runs", async () => {
  const store = createStore();
  const { stored } = createContext(store, { notes: MELODY });
  const service = analyzer(store);
  const cases = [
    {},
    { contextId: "" },
    { contextId: stored.contextId, include: [] },
    { contextId: stored.contextId, include: ["nope"] },
    { contextId: stored.contextId, include: ["phrase", "phrase"] },
    { contextId: stored.contextId, phraseGapQuarter: 0 },
    { contextId: stored.contextId, responseMode: "tiny" },
    { contextId: stored.contextId, budgets: { issues: 0 } },
    { contextId: stored.contextId, budgets: { unknown: 1 } },
    { contextId: stored.contextId, unknownField: true },
  ];
  for (const request of cases) {
    await assert.rejects(
      () => service.analyze(request),
      (error) => error.code === "INVALID_ARGUMENTS",
      `expected INVALID_ARGUMENTS for ${JSON.stringify(request)}`
    );
  }
});

test("the byte budget drops item lists but never the summaries or next steps", async () => {
  const store = createStore();
  const many = Array.from({ length: 60 }, (_, index) => ({
    onsetBlick: index * Q,
    durationBlick: Q,
    pitch: 60 + (index % 12),
    lyrics: "br",
    languageOverride: "japanese",
  }));
  const { stored } = createContext(store, { notes: many });
  const result = await analyzer(store).analyze({
    contextId: stored.contextId,
    include: ["prosody"],
    responseMode: "standard",
    budgets: { bytes: 8192 },
  });

  assert.ok(result.warnings.some((warning) => warning.code === "RESPONSE_BUDGET_APPLIED"));
  assert.equal(result.sections.prosody.itemsOmitted, "response_byte_budget");
  assert.equal(result.sections.prosody.issues, undefined);
  // 决策必需的部分必须保留。
  assert.ok(result.sections.prosody.summary);
  assert.ok(result.summary);
  assert.ok(result.nextSteps.length >= 1);
  assert.ok(result.sections.prosody.details.tool);
});

test("with nothing blocking, the next step is a human audition, not a claim of quality", async () => {
  const store = createStore();
  const { stored } = createContext(store, { notes: MELODY });
  const result = await analyzer(store).analyze({
    contextId: stored.contextId,
    include: ["phrase"],
  });
  const step = result.nextSteps.find((entry) => entry.tool === "sv_start_audition");
  assert.ok(step);
  assert.deepEqual(step.arguments, { fromBlick: 0, toBlick: 4 * Q });
  assert.match(step.note, /human_only/);
  // 组合层绝不输出机器听感评分。
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /sounds (good|better|correct)/i);
  assert.doesNotMatch(serialized, /qualityScore/i);
});

// ---------- computed pitch 成功路径 ----------

// 每音符 16 帧；给一段带明显偏差的曲线以产生异常区段。
function pitchFramesForMelody(offsetsSemitone) {
  const frames = [];
  for (let noteIndex = 0; noteIndex < MELODY.length; noteIndex += 1) {
    const target = MELODY[noteIndex].pitch;
    const offset = offsetsSemitone[noteIndex] ?? 0;
    for (let frame = 0; frame < 16; frame += 1) frames.push(target + offset);
  }
  return frames;
}

test("captured computed pitch produces an objective section with measured evidence", async () => {
  const store = createStore();
  const { stored } = createContext(store, {
    notes: MELODY,
    computedPitchValues: pitchFramesForMelody([0, 0, 0, 0, 0, 0]),
  });
  const result = await analyzer(store).analyze({
    contextId: stored.contextId,
    include: ["computedPitch"],
  });

  const section = result.sections.computedPitch;
  assert.equal(section.status, "succeeded");
  assert.equal(section.authority, "sv_compare_computed_pitch");
  assert.ok(section.summary.coverage > 0);
  assert.ok(Number.isFinite(section.summary.frameCount));
  assert.ok(Number.isFinite(section.summary.maeCent));
  // 完美对准的曲线应当没有异常区段，且该结论来自实测而非缺数据。
  assert.equal(section.summary.anomalyCount, 0);
  assert.equal(result.summary.evidence, "all_requested_sections_analyzed");
});

test("pitch anomalies become findings framed as measurements, not verdicts", async () => {
  const store = createStore();
  const { stored } = createContext(store, {
    notes: MELODY,
    // 第 3 个音符偏低约一个半音：足以触发异常区段。
    computedPitchValues: pitchFramesForMelody([0, 0, -1, 0, 0, 0]),
  });
  const result = await analyzer(store).analyze({
    contextId: stored.contextId,
    include: ["computedPitch"],
  });

  const section = result.sections.computedPitch;
  assert.equal(section.status, "succeeded");
  assert.ok(section.summary.anomalyCount >= 1, "a semitone-flat note must be detected");
  assert.ok(section.summary.worstAnomaly, "top anomaly must survive truncation");

  const finding = result.topFindings.find((item) => item.source === "computedPitch");
  assert.ok(finding);
  assert.equal(finding.confidence, "observed_measurement");
  assert.equal(finding.kind, "pitch_anomaly_segment");

  const step = result.nextSteps.find((entry) => entry.tool === "sv_plan_expression");
  assert.ok(step);
  // 偏差是客观测量；是否属于有意演唱由人判断。
  assert.match(step.note, /not a verdict/i);
  assert.match(step.note, /human decides/i);
});

test("all-null computed pitch reports insufficient evidence, never perfect intonation", async () => {
  const store = createStore();
  const { stored } = createContext(store, {
    notes: MELODY,
    computedPitchValues: new Array(MELODY.length * 16).fill(null),
  });
  const result = await analyzer(store).analyze({
    contextId: stored.contextId,
    include: ["computedPitch"],
  });

  const section = result.sections.computedPitch;
  assert.equal(section.status, "insufficient_evidence");
  assert.equal(section.reason.code, "INSUFFICIENT_COMPUTED_PITCH");
  assert.match(section.remedy, /NOT zero error/);
  assert.equal(section.summary, undefined);
  assert.equal(result.summary.evidence, "no_section_produced_evidence");
  // 必须引导到处理等待，而不是宣布音准完美。
  assert.ok(result.nextSteps.some((entry) => entry.tool === "sv_wait_for_processing"));
});
