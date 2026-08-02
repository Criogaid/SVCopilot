import assert from "node:assert/strict";
import test from "node:test";

import { HarmonyPlanService } from "../server/src/harmony-plan.js";
import { SnapshotStore } from "../server/src/snapshot.js";
import {
  createPlannerService,
  sealedPlannerRequest as sealedRequest,
} from "./helpers/planner-artifact-fixture.mjs";

const Q = 705600000;

function createStore() {
  return new SnapshotStore({ now: () => 1000 });
}

// 双 occurrence range context：occurrence 0 为旋律源，occurrence 1 为和声目标（可有既有音符）。
function createStoredContext(store, options = {}) {
  const {
    sourceNotes = [],
    targetNotes = [],
    targetOffsetBlick = 0,
    sourcePitchOffsetSemitone = 0,
    targetPitchOffsetSemitone = 0,
    sourceUuid = "uuid-melody",
    targetUuid = "uuid-harmony",
    sharedTargetOccurrences = null,
    extraSourceOccurrence = false,
  } = options;
  const stored = store.create({
    epoch: 1,
    scope: { kind: "range" },
    observedAt: new Date(1000).toISOString(),
    context: { kind: "range", occurrences: [] },
  });
  const fingerprint = (note, index) => ({
    indexInGroup: index,
    onsetBlick: note.onsetBlick,
    durationBlick: note.durationBlick,
    pitch: note.pitch,
    lyrics: note.lyrics ?? `n${index}`,
    phonemesOverride: "",
    languageOverride: "",
    detuneCents: 0,
  });
  stored.context.occurrences.push({
    occurrence: 0,
    trackIndex: 0,
    groupIndex: 0,
    targetGroupUuid: sourceUuid,
    timeOffsetBlick: 0,
    pitchOffsetSemitone: sourcePitchOffsetSemitone,
    sharedTargetOccurrences: [0],
    noteFingerprints: sourceNotes.map((note, index) => fingerprint(note, index)),
  });
  stored.context.occurrences.push({
    occurrence: 1,
    trackIndex: 1,
    groupIndex: 0,
    targetGroupUuid: targetUuid,
    timeOffsetBlick: targetOffsetBlick,
    pitchOffsetSemitone: targetPitchOffsetSemitone,
    sharedTargetOccurrences: sharedTargetOccurrences ?? [1],
    noteFingerprints: targetNotes.map((note, index) => fingerprint(note, index)),
  });
  if (extraSourceOccurrence) {
    stored.context.occurrences.push({
      occurrence: 2,
      trackIndex: 2,
      groupIndex: 0,
      targetGroupUuid: "uuid-third",
      timeOffsetBlick: 0,
      pitchOffsetSemitone: 0,
      sharedTargetOccurrences: [2],
      noteFingerprints: sourceNotes.map((note, index) => fingerprint(note, index)),
    });
  }
  stored.context.quarterBlick = Q;
  stored.context.meterMarks = [{ position: 0, positionBlick: 0, numerator: 4, denominator: 4 }];
  stored.context.tempoMarks = [{ positionBlick: 0, positionSeconds: 0, bpm: 120 }];
  return { stored };
}

function createService(store, artifactStore = null) {
  return createPlannerService(HarmonyPlanService, { store, artifactStore });
}

// C 大调音阶旋律：C4 D4 E4 F4 G4（全部调内）。
function cMajorNotes() {
  return [60, 62, 64, 65, 67].map((pitch, index) => ({
    onsetBlick: index * Q,
    durationBlick: Q,
    pitch,
    lyrics: ["do", "re", "mi", "fa", "sol"][index],
  }));
}

test("third_below maps diatonic scale degrees with an explicit key", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, { sourceNotes: cMajorNotes() });
  const result = await createService(store).plan({
    contextId: stored.contextId,
    targetOccurrence: 1,
    harmony: { interval: "third_below", key: { tonic: "C", mode: "major" } },
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "planned");
  assert.equal(result.effects, "none");
  assert.equal(result.key.source, "explicit");
  // C 大调下方三度（自然音阶级 -2）：C→A3, D→B3, E→C4, F→D4, G→E4。
  assert.deepEqual(
    result.perNote.map((item) => item.harmonyPitch),
    [57, 59, 60, 62, 64]
  );
  assert.ok(result.perNote.every((item) => item.status === "planned"));
  assert.equal(result.summary.needsReview, 0);
  assert.equal(result.source.occurrence, 0);
  assert.equal(result.target.occurrence, 1);
  const request = sealedRequest(result);
  assert.equal(request.tool, "sv_restructure_notes");
  assert.equal(request.arguments.occurrence, 1);
  assert.equal(request.arguments.operations.length, 5);
  assert.deepEqual(request.arguments.operations[0], {
    op: "insert",
    note: { onsetBlick: 0, durationBlick: Q, pitch: 57, lyrics: "do" },
  });
});

test("third_above and sixth variants map in the expected directions", async () => {
  const store = createStore();
  const service = createService(store);
  const cases = [
    ["third_above", [64, 65, 67, 69, 71]], // C→E4, D→F4, E→G4, F→A4, G→B4
    ["sixth_below", [52, 53, 55, 57, 59]], // C→E3, D→F3, E→G3, F→A3, G→B3
    ["sixth_above", [69, 71, 72, 74, 76]], // C→A4, D→B4, E→C5, F→D5, G→E5
  ];
  for (const [interval, expected] of cases) {
    const { stored } = createStoredContext(store, { sourceNotes: cMajorNotes() });
    const result = await service.plan({
      contextId: stored.contextId,
      targetOccurrence: 1,
      harmony: { interval, key: { tonic: "C", mode: "major" } },
    });
    assert.deepEqual(
      result.perNote.map((item) => item.harmonyPitch),
      expected,
      interval
    );
  }
});

test("non-diatonic source notes are approximated and flagged needsReview", async () => {
  const store = createStore();
  const notes = cMajorNotes();
  notes.push({ onsetBlick: 5 * Q, durationBlick: Q, pitch: 66, lyrics: "fis" }); // F#4 调外
  const { stored } = createStoredContext(store, { sourceNotes: notes });
  const result = await createService(store).plan({
    contextId: stored.contextId,
    targetOccurrence: 1,
    harmony: { interval: "third_below", key: { tonic: "C", mode: "major" } },
  });
  const fis = result.perNote[5];
  assert.equal(fis.needsReview, true);
  // 最近调内音 F4(65)→D4(62)，半音差 -3 → F#4(66)+(-3)=63。
  assert.equal(fis.harmonyPitch, 63);
  assert.ok(result.warnings.some((warning) => warning.code === "NON_DIATONIC_SOURCE_APPROXIMATED"));
  assert.equal(result.summary.needsReview, 1);
});

test("auto key detection warns when the K-S margin is thin and reports the runner-up", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, { sourceNotes: cMajorNotes() });
  const result = await createService(store).plan({
    contextId: stored.contextId,
    targetOccurrence: 1,
    harmony: { interval: "third_below" },
  });
  assert.equal(result.key.source, "detected");
  assert.equal(typeof result.key.marginFromNext, "number");
  assert.ok(result.key.runnerUp.tonic);
  // 5 音上行 C 大调片段的检测结果与显式 C 大调映射一致与否取决于 K-S 排序；
  // 这里只断言检测确实发生且计划成立（margin 阈值行为由下一个断言覆盖）。
  assert.equal(result.status, "planned");
  if (result.key.marginFromNext < 0.05) {
    assert.ok(result.warnings.some((warning) => warning.code === "KEY_AMBIGUOUS"));
  }
});

test("register bounds trigger octave shifts and skip unreachable notes", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, { sourceNotes: cMajorNotes() });
  const result = await createService(store).plan({
    contextId: stored.contextId,
    targetOccurrence: 1,
    harmony: { interval: "third_below", key: { tonic: "C", mode: "major" } },
    // 下方三度原始结果 57..64；min 60 迫使 57/59 八度上移 → 69/71 越过源音 → 声部交叉跳过。
    register: { minPitch: 60, maxPitch: 80 },
  });
  const shifted = result.perNote.filter((item) => item.octaveShifted);
  assert.equal(shifted.length, 2);
  assert.ok(shifted.every((item) => item.status === "skipped" && item.skipReason === "voice_crossing"));
  assert.ok(result.warnings.some((warning) => warning.code === "VOICE_CROSSING_AVOIDED"));
  assert.equal(result.summary.planned, 3);
  assert.equal(sealedRequest(result).arguments.operations.length, 3);
});

test("register windows that cannot host the harmony skip with REGISTER_UNREACHABLE", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, {
    sourceNotes: [{ onsetBlick: 0, durationBlick: Q, pitch: 60, lyrics: "do" }],
  });
  const result = await createService(store).plan({
    contextId: stored.contextId,
    targetOccurrence: 1,
    harmony: { interval: "third_below", key: { tonic: "C", mode: "major" } },
    register: { minPitch: 90, maxPitch: 95 }, // A3(57) 八度上移到 69 仍不可达
  });
  assert.equal(result.status, "no_change");
  assert.equal(result.perNote[0].skipReason, "register_unreachable");
  assert.ok(result.warnings.some((warning) => warning.code === "REGISTER_UNREACHABLE"));
});

test("sustain lyricsMode uses the first melodic lyric then '-' melisma; copy copies", async () => {
  const store = createStore();
  const first = createStoredContext(store, { sourceNotes: cMajorNotes() });
  const sustained = await createService(store).plan({
    contextId: first.stored.contextId,
    targetOccurrence: 1,
    harmony: { interval: "third_below", key: { tonic: "C", mode: "major" } },
    lyricsMode: "sustain",
  });
  assert.deepEqual(
    sustained.perNote.map((item) => item.harmonyLyrics),
    ["do", "-", "-", "-", "-"]
  );
  const second = createStoredContext(store, { sourceNotes: cMajorNotes() });
  const copied = await createService(store).plan({
    contextId: second.stored.contextId,
    targetOccurrence: 1,
    harmony: { interval: "third_below", key: { tonic: "C", mode: "major" } },
    lyricsMode: "copy",
  });
  assert.deepEqual(
    copied.perNote.map((item) => item.harmonyLyrics),
    ["do", "re", "mi", "fa", "sol"]
  );
});

test("source breaths are skipped; an all-breath selection fails honestly", async () => {
  const store = createStore();
  const notes = [
    { onsetBlick: 0, durationBlick: Q, pitch: 60, lyrics: "br" },
    ...cMajorNotes().map((note) => ({ ...note, onsetBlick: note.onsetBlick + Q })),
  ];
  const { stored } = createStoredContext(store, { sourceNotes: notes });
  const result = await createService(store).plan({
    contextId: stored.contextId,
    targetOccurrence: 1,
    harmony: { interval: "third_below", key: { tonic: "C", mode: "major" } },
  });
  assert.equal(result.summary.skippedBreaths, 1);
  assert.equal(result.summary.sourceNotes, 5);
  assert.equal(result.provenance.breathNotes, "skipped_breaths_need_no_harmony");

  const breathOnly = createStoredContext(store, {
    sourceNotes: [{ onsetBlick: 0, durationBlick: Q, pitch: 60, lyrics: "br" }],
  });
  await assert.rejects(
    createService(store).plan({
      contextId: breathOnly.stored.contextId,
      targetOccurrence: 1,
      harmony: { interval: "third_below", key: { tonic: "C", mode: "major" } },
    }),
    (error) => error.code === "NO_MELODIC_NOTES"
  );
});

test("insert onsets are converted to the target's local coordinates", async () => {
  const store = createStore();
  const offset = 2 * Q;
  const { stored } = createStoredContext(store, {
    sourceNotes: cMajorNotes(),
    targetOffsetBlick: offset,
  });
  const result = await createService(store).plan({
    contextId: stored.contextId,
    targetOccurrence: 1,
    harmony: { interval: "third_below", key: { tonic: "C", mode: "major" } },
  });
  // 源音 0 与 1 落在目标偏移之前，无法插入；其余换算为本地坐标。
  assert.equal(result.perNote[0].skipReason, "before_target_offset");
  assert.equal(result.perNote[1].skipReason, "before_target_offset");
  assert.ok(result.warnings.some((warning) => warning.code === "BEFORE_TARGET_OFFSET"));
  assert.deepEqual(
    sealedRequest(result).arguments.operations.map((op) => op.note.onsetBlick),
    [0, Q, 2 * Q]
  );
});

test("existing identical target notes are skipped as already_applied; different content conflicts", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, {
    sourceNotes: cMajorNotes(),
    targetNotes: [
      { onsetBlick: 0, durationBlick: Q, pitch: 57, lyrics: "do" }, // 与计划完全一致
      { onsetBlick: Q, durationBlick: Q, pitch: 50, lyrics: "x" }, // 同跨度不同音高 → 冲突
    ],
  });
  const result = await createService(store).plan({
    contextId: stored.contextId,
    targetOccurrence: 1,
    harmony: { interval: "third_below", key: { tonic: "C", mode: "major" } },
  });
  assert.equal(result.summary.alreadyApplied, 1);
  assert.equal(result.summary.conflicts, 1);
  assert.equal(result.summary.planned, 3);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].existingPitch, 50);
  assert.ok(result.warnings.some((warning) => warning.code === "TARGET_NOTE_CONFLICT"));
  assert.equal(sealedRequest(result).arguments.operations.length, 3);
});

test("same pitch and span with different lyrics is a target conflict, not already_applied", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, {
    sourceNotes: [{ onsetBlick: 0, durationBlick: Q, pitch: 60, lyrics: "do" }],
    targetNotes: [{ onsetBlick: 0, durationBlick: Q, pitch: 57, lyrics: "WRONG" }],
  });
  const result = await createService(store).plan({
    contextId: stored.contextId,
    targetOccurrence: 1,
    harmony: { interval: "third_below", key: { tonic: "C", mode: "major" } },
    lyricsMode: "copy",
  });

  assert.equal(result.summary.alreadyApplied, 0);
  assert.equal(result.summary.conflicts, 1);
  assert.equal(result.conflicts[0].plannedLyrics, "do");
  assert.equal(result.conflicts[0].existingLyrics, "WRONG");
  assert.ok(result.warnings.some((warning) => warning.code === "TARGET_NOTE_CONFLICT"));
});

test("occurrence pitch offsets are applied in sounding space and converted to target-local pitch", async () => {
  const store = createStore();
  const sourceShifted = createStoredContext(store, {
    sourceNotes: [{ onsetBlick: 0, durationBlick: Q, pitch: 60, lyrics: "do" }],
    sourcePitchOffsetSemitone: 12,
  });
  const sourceResult = await createService(store).plan({
    contextId: sourceShifted.stored.contextId,
    targetOccurrence: 1,
    harmony: { interval: "third_below", key: { tonic: "C", mode: "major" } },
  });
  assert.equal(sealedRequest(sourceResult).arguments.operations[0].note.pitch, 69);
  assert.equal(sourceResult.perNote[0].harmonySoundingPitch, 69);

  const targetShifted = createStoredContext(store, {
    sourceNotes: [{ onsetBlick: 0, durationBlick: Q, pitch: 60, lyrics: "do" }],
    targetPitchOffsetSemitone: 12,
  });
  const targetResult = await createService(store).plan({
    contextId: targetShifted.stored.contextId,
    targetOccurrence: 1,
    harmony: { interval: "third_below", key: { tonic: "C", mode: "major" } },
  });
  assert.equal(sealedRequest(targetResult).arguments.operations[0].note.pitch, 45);
  assert.equal(targetResult.perNote[0].harmonyPitch, 45);
  assert.equal(targetResult.perNote[0].harmonySoundingPitch, 57);
  assert.equal(targetResult.source.pitchOffsetSemitone, 0);
  assert.equal(targetResult.target.pitchOffsetSemitone, 12);
});

test("fractional occurrence pitch offsets fail before emitting a non-integer restructure request", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, {
    sourceNotes: [{ onsetBlick: 0, durationBlick: Q, pitch: 60, lyrics: "do" }],
    sourcePitchOffsetSemitone: 0.5,
  });
  await assert.rejects(
    createService(store).plan({
      contextId: stored.contextId,
      targetOccurrence: 1,
      harmony: { interval: "third_below", key: { tonic: "C", mode: "major" } },
    }),
    (error) => error.code === "UNSUPPORTED_PITCH_OFFSET"
  );
});

test("plans above the operation cap return the first 64 plus a continuation workflow", async () => {
  const store = createStore();
  const count = 65;
  const scale = [60, 62, 64, 65, 67, 69, 71];
  const sourceNotes = Array.from({ length: count }, (_, index) => ({
    onsetBlick: index * Q,
    durationBlick: Q,
    pitch: scale[index % scale.length],
    lyrics: `n${index}`,
  }));
  const { stored } = createStoredContext(store, { sourceNotes });
  const result = await createService(store).plan({
    contextId: stored.contextId,
    targetOccurrence: 1,
    harmony: { interval: "third_below", key: { tonic: "C", mode: "major" } },
  });
  assert.equal(result.summary.planned, count);
  assert.equal(sealedRequest(result).arguments.operations.length, 64);
  assert.equal(result.continuation.reason, "OPERATION_CAP");
  assert.equal(result.continuation.remainingCount, 1);
  assert.ok(result.warnings.some((warning) => warning.code === "PLAN_EXCEEDS_OPERATION_CAP"));
});

test("the continuation loop converges across simulated commit/re-snapshot rounds", async () => {
  const store = createStore();
  const count = 65;
  const scale = [60, 62, 64, 65, 67, 69, 71];
  const sourceNotes = Array.from({ length: count }, (_, index) => ({
    onsetBlick: index * Q,
    durationBlick: Q,
    pitch: scale[index % scale.length],
    lyrics: `n${index}`,
  }));
  const harmonyPitchFor = (pitch) => {
    // C 大调下方三度（用于模拟"前 64 项已插入"的目标内容）。
    const scaleOffsets = [0, 2, 4, 5, 7, 9, 11];
    const offset = pitch % 12;
    const idx = scaleOffsets.indexOf(offset);
    const newIndex = idx - 2;
    const octaveShift = Math.floor(newIndex / 7);
    const wrapped = ((newIndex % 7) + 7) % 7;
    return pitch - offset + octaveShift * 12 + scaleOffsets[wrapped];
  };
  const service = createService(store);
  const options = { harmony: { interval: "third_below", key: { tonic: "C", mode: "major" } } };

  const round1 = createStoredContext(store, { sourceNotes });
  const first = await service.plan({
    contextId: round1.stored.contextId,
    sourceOccurrence: 0,
    targetOccurrence: 1,
    ...options,
  });
  assert.equal(sealedRequest(first).arguments.operations.length, 64);
  assert.equal(first.continuation.remainingCount, 1);

  // 模拟提交：前 64 条和声已进目标组；重拍快照产生新 contextId。
  store.delete(round1.stored.contextId);
  const appliedTargets = sourceNotes.slice(0, 64).map((note, index) => ({
    onsetBlick: note.onsetBlick,
    durationBlick: note.durationBlick,
    pitch: harmonyPitchFor(note.pitch),
    lyrics: note.lyrics,
  }));
  const round2 = createStoredContext(store, { sourceNotes, targetNotes: appliedTargets });
  // 同参重跑：身份记录证明 fresh context 的对应位置仍指向同一 UUID。
  const second = await service.plan({
    contextId: round2.stored.contextId,
    sourceOccurrence: 0,
    targetOccurrence: 1,
    ...options,
  });
  assert.ok(second.warnings.some((warning) => warning.code === "CONTINUATION_IDENTITY_VERIFIED"));
  assert.equal(second.summary.alreadyApplied, 64);
  assert.equal(sealedRequest(second).arguments.operations.length, 1);
  assert.equal(second.continuation, undefined);

  store.delete(round2.stored.contextId);
  const allTargets = sourceNotes.map((note) => ({
    onsetBlick: note.onsetBlick,
    durationBlick: note.durationBlick,
    pitch: harmonyPitchFor(note.pitch),
    lyrics: note.lyrics,
  }));
  const round3 = createStoredContext(store, { sourceNotes, targetNotes: allTargets });
  const third = await service.plan({
    contextId: round3.stored.contextId,
    sourceOccurrence: 0,
    targetOccurrence: 1,
    ...options,
  });
  assert.equal(third.status, "no_change");
  assert.equal(third.summary.alreadyApplied, count);
});

test("a reanchored selector is rejected when the target group UUID changed", async () => {
  const store = createStore();
  const count = 65;
  const scale = [60, 62, 64, 65, 67, 69, 71];
  const sourceNotes = Array.from({ length: count }, (_, index) => ({
    onsetBlick: index * Q,
    durationBlick: Q,
    pitch: scale[index % scale.length],
  }));
  const service = createService(store);
  const options = { harmony: { interval: "third_below", key: { tonic: "C", mode: "major" } } };
  const round1 = createStoredContext(store, { sourceNotes });
  await service.plan({
    contextId: round1.stored.contextId,
    targetOccurrence: 1,
    ...options,
  });
  store.delete(round1.stored.contextId);
  const round2 = createStoredContext(store, { sourceNotes, targetUuid: "uuid-swapped" });
  await assert.rejects(
    service.plan({
      contextId: round2.stored.contextId,
      targetOccurrence: 1,
      ...options,
    }),
    (error) => error.code === "STALE_CONTEXT"
  );
  // ordinal 越界与续跑 UUID 冲突保持不同错误码。
  await assert.rejects(
    service.plan({
      contextId: round2.stored.contextId,
      targetOccurrence: 9,
      ...options,
    }),
    (error) => error.code === "OCCURRENCE_INDEX_OUT_OF_RANGE"
  );
});

test("shared target groups surface the confirmation requirement in review", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, {
    sourceNotes: cMajorNotes(),
    sharedTargetOccurrences: ["occ-a", "occ-b"],
  });
  const result = await createService(store).plan({
    contextId: stored.contextId,
    targetOccurrence: 1,
    harmony: { interval: "third_below", key: { tonic: "C", mode: "major" } },
  });
  assert.equal(result.review.requiresSharedTargetConfirmation, true);
  assert.ok(result.review.checklist.some((item) => /allowSharedTargetMutation/.test(item)));
});

test("identical requests produce identical planIds and perNote is capped at one size", async () => {
  const store = createStore();
  const { stored } = createStoredContext(store, { sourceNotes: cMajorNotes() });
  const service = createService(store);
  const request = {
    contextId: stored.contextId,
    targetOccurrence: 1,
    harmony: { interval: "third_below", key: { tonic: "C", mode: "major" } },
  };
  const first = await service.plan(request);
  const second = await service.plan(request);
  assert.equal(first.planId, second.planId);
  // PlanRef 是一次封存租约的身份，每次规划都应不同；业务计划与 sealed mutation 才必须确定。
  assert.notEqual(first.apply.arguments.planRef, second.apply.arguments.planRef);
  assert.deepEqual(first.summary, second.summary);
  assert.deepEqual(first.perNote, second.perNote);
  assert.deepEqual(first.review, second.review);
  assert.deepEqual(sealedRequest(first), sealedRequest(second));
  // 唯一形状（§10.6 规则 14）：perNote 恒定返回并按同一上限截断，调用方不再挑档。
  assert.equal(first.perNote.length, 5);
  assert.equal(first.summary.planned, 5);
});

test("harmony resolves contexts honestly across error paths", async () => {
  const store = createStore();
  const service = createService(store);
  const options = { harmony: { interval: "third_below", key: { tonic: "C", mode: "major" } } };
  await assert.rejects(
    service.plan({ contextId: "ctx_missing", targetOccurrence: 1, ...options }),
    (error) => error.code === "UNKNOWN_CONTEXT"
  );
  // 源与目标相同直接拒绝。
  const same = createStoredContext(store, { sourceNotes: cMajorNotes() });
  await assert.rejects(
    service.plan({
      contextId: same.stored.contextId,
      sourceOccurrence: 0,
      targetOccurrence: 0,
      ...options,
    }),
    (error) => error.code === "INVALID_ARGUMENTS"
  );
  // 多个候选源 → AMBIGUOUS_CONTEXT。
  const ambiguous = createStoredContext(store, {
    sourceNotes: cMajorNotes(),
    extraSourceOccurrence: true,
  });
  await assert.rejects(
    service.plan({
      contextId: ambiguous.stored.contextId,
      targetOccurrence: 1,
      ...options,
    }),
    (error) => {
      assert.equal(error.code, "AMBIGUOUS_CONTEXT");
      assert.deepEqual(error.details.candidates, [0, 2]);
      return true;
    }
  );
  // 未知 noteId。
  const known = createStoredContext(store, { sourceNotes: cMajorNotes() });
  await assert.rejects(
    service.plan({
      contextId: known.stored.contextId,
      targetOccurrence: 1,
      notes: [9],
      ...options,
    }),
    (error) => error.code === "NOTE_INDEX_OUT_OF_RANGE"
  );
  // 单音级源 + 无显式 key → INSUFFICIENT_PITCH_VARIETY。
  const mono = createStoredContext(store, {
    sourceNotes: [
      { onsetBlick: 0, durationBlick: Q, pitch: 60 },
      { onsetBlick: Q, durationBlick: Q, pitch: 72 },
    ],
  });
  await assert.rejects(
    service.plan({
      contextId: mono.stored.contextId,
      targetOccurrence: 1,
      harmony: { interval: "third_below" },
    }),
    (error) => error.code === "INSUFFICIENT_PITCH_VARIETY"
  );
});

test("harmony rejects malformed requests before touching the store", async () => {
  const store = createStore();
  const service = createService(store);
  for (const request of [
    {},
    { contextId: "ctx" },
    { contextId: "ctx", targetOccurrence: "t", harmony: {} },
    { contextId: "ctx", targetOccurrence: "t", harmony: { interval: "fifth_below" } },
    {
      contextId: "ctx",
      targetOccurrence: "t",
      harmony: { interval: "third_below", key: { tonic: "H", mode: "major" } },
    },
    {
      contextId: "ctx",
      targetOccurrence: "t",
      harmony: { interval: "third_below", key: { tonic: "C", mode: "dorian" } },
    },
    {
      contextId: "ctx",
      targetOccurrence: "t",
      harmony: { interval: "third_below" },
      register: { minPitch: 60, maxPitch: 60 },
    },
    {
      contextId: "ctx",
      targetOccurrence: "t",
      harmony: { interval: "third_below" },
      lyricsMode: "hum",
    },
    {
      contextId: "ctx",
      targetOccurrence: "t",
      harmony: { interval: "third_below" },
      notes: [],
    },
    { contextId: "ctx", targetOccurrence: "t", harmony: { interval: "third_below" }, bogus: 1 },
  ]) {
    await assert.rejects(service.plan(request), (error) => error.code === "INVALID_ARGUMENTS");
  }
});
