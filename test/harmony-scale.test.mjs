import assert from "node:assert/strict";
import test from "node:test";

import {
  HARMONY_SCALE_NAMES,
  HARMONY_SCALE_TYPES,
  HarmonyPlanService,
} from "../server/src/harmony-plan.js";
import { SnapshotStore } from "../server/src/snapshot.js";

const Q = 705600000;

function createStore() {
  return new SnapshotStore({ now: () => 1000 });
}

// 与 harmony-plan.test.mjs 同一夹具：occurrence 0 旋律源、occurrence 1 和声目标。
function createStoredContext(store, { sourceNotes = [], targetNotes = [] } = {}) {
  const stored = store.create({
    epoch: 1,
    scope: { kind: "range" },
    observedAt: new Date(1000).toISOString(),
    context: { kind: "range", occurrences: [] },
  });
  const sourceId = `${stored.contextId}:t:0:r:0`;
  const targetId = `${stored.contextId}:t:1:r:0`;
  const fingerprint = (occurrenceId, note, index) => ({
    indexInGroup: index,
    onsetBlick: note.onsetBlick,
    durationBlick: note.durationBlick,
    pitch: note.pitch,
    lyrics: note.lyrics ?? `n${index}`,
    phonemesOverride: "",
    languageOverride: "",
    detuneCents: 0,
    noteId: `${occurrenceId}:n:${index}`,
  });
  stored.context.occurrences.push({
    occurrenceId: sourceId,
    trackIndex: 0,
    groupIndex: 0,
    targetGroupUuid: "uuid-melody",
    timeOffsetBlick: 0,
    pitchOffsetSemitone: 0,
    sharedTargetOccurrences: [sourceId],
    noteFingerprints: sourceNotes.map((note, index) => fingerprint(sourceId, note, index)),
  });
  stored.context.occurrences.push({
    occurrenceId: targetId,
    trackIndex: 1,
    groupIndex: 0,
    targetGroupUuid: "uuid-harmony",
    timeOffsetBlick: 0,
    pitchOffsetSemitone: 0,
    sharedTargetOccurrences: [targetId],
    noteFingerprints: targetNotes.map((note, index) => fingerprint(targetId, note, index)),
  });
  stored.context.quarterBlick = Q;
  stored.context.meterMarks = [{ position: 0, positionBlick: 0, numerator: 4, denominator: 4 }];
  stored.context.tempoMarks = [{ positionBlick: 0, positionSeconds: 0, bpm: 120 }];
  return { stored, sourceId, targetId };
}

function service(store) {
  return new HarmonyPlanService({ store, now: () => 2000 });
}

const notesFromPitches = (pitches) =>
  pitches.map((pitch, index) => ({ onsetBlick: index * Q, durationBlick: Q, pitch, lyrics: `n${index}` }));

// ---------- 1. 音阶目录 golden fixture ----------

test("the 14-scale catalog matches the expected pitch-class sets", () => {
  assert.deepEqual([...HARMONY_SCALE_NAMES].sort(), [
    "aeolian",
    "blues",
    "chromatic",
    "dorian",
    "harmonic_minor",
    "ionian",
    "locrian",
    "lydian",
    "major_pentatonic",
    "melodic_minor",
    "minor_pentatonic",
    "mixolydian",
    "phrygian",
    "whole_tone",
  ]);
  const expected = {
    ionian: [0, 2, 4, 5, 7, 9, 11],
    dorian: [0, 2, 3, 5, 7, 9, 10],
    phrygian: [0, 1, 3, 5, 7, 8, 10],
    lydian: [0, 2, 4, 6, 7, 9, 11],
    mixolydian: [0, 2, 4, 5, 7, 9, 10],
    aeolian: [0, 2, 3, 5, 7, 8, 10],
    locrian: [0, 1, 3, 5, 6, 8, 10],
    harmonic_minor: [0, 2, 3, 5, 7, 8, 11],
    melodic_minor: [0, 2, 3, 5, 7, 9, 11],
    major_pentatonic: [0, 2, 4, 7, 9],
    minor_pentatonic: [0, 3, 5, 7, 10],
    blues: [0, 3, 5, 6, 7, 10],
    whole_tone: [0, 2, 4, 6, 8, 10],
    chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  };
  for (const [name, semitones] of Object.entries(expected)) {
    assert.deepEqual([...HARMONY_SCALE_TYPES[name]], semitones, `${name} semitone set`);
  }
});

// ---------- 2. degree/direction/octaveOffset 属性 ----------

test("legacy interval names are equivalent to their generalized form", async () => {
  const store = createStore();
  const { stored, sourceId, targetId } = createStoredContext(store, {
    sourceNotes: notesFromPitches([60, 62, 64, 65, 67]),
  });
  const cases = [
    ["third_above", { degree: 3, direction: "above" }],
    ["third_below", { degree: 3, direction: "below" }],
    ["sixth_above", { degree: 6, direction: "above" }],
    ["sixth_below", { degree: 6, direction: "below" }],
  ];
  for (const [legacy, generalized] of cases) {
    const viaLegacy = await service(store).plan({
      contextId: stored.contextId,
      sourceOccurrenceId: sourceId,
      targetOccurrenceId: targetId,
      harmony: { interval: legacy, key: { tonic: "C", mode: "major" } },
    });
    const viaGeneralized = await service(store).plan({
      contextId: stored.contextId,
      sourceOccurrenceId: sourceId,
      targetOccurrenceId: targetId,
      harmony: { interval: generalized, key: { tonic: "C", mode: "major" } },
    });
    const legacyPitches = viaLegacy.perNote.map((item) => item.harmonyPitch);
    const generalizedPitches = viaGeneralized.perNote.map((item) => item.harmonyPitch);
    assert.deepEqual(generalizedPitches, legacyPitches, `${legacy} must equal its generalized form`);
  }
});

test("degree/direction/octaveOffset compose deterministically", async () => {
  const store = createStore();
  const { stored, sourceId, targetId } = createStoredContext(store, {
    sourceNotes: notesFromPitches([60]),
  });
  const plan = async (interval, pitch = 60) =>
    (await service(store).plan({
      contextId: stored.contextId,
      sourceOccurrenceId: sourceId,
      targetOccurrenceId: targetId,
      harmony: { interval, key: { tonic: "C", mode: "major" } },
    })).perNote.find((item) => item.sourcePitch === pitch).harmonyPitch;
  // C ionian：unison 同度=C(60)，三上=E(64)，三上+1 八度=E5(76)，六下=E3(52)，二上=D(62)，
  // unison+octaveOffset 1 = C5(72)（八度 doubling，不触发声部交叉）。
  assert.equal(await plan({ degree: 1, direction: "above" }), 60);
  assert.equal(await plan({ degree: 1, direction: "above", octaveOffset: 1 }), 72);
  assert.equal(await plan({ degree: 3, direction: "above" }), 64);
  assert.equal(await plan({ degree: 3, direction: "above", octaveOffset: 1 }), 76);
  assert.equal(await plan({ degree: 6, direction: "below" }), 52);
  assert.equal(await plan({ degree: 2, direction: "above" }), 62);
});

test("above and below are mirror images around the source", async () => {
  const store = createStore();
  const { stored, sourceId, targetId } = createStoredContext(store, {
    sourceNotes: notesFromPitches([64]),
  });
  const plan = async (direction) =>
    (await service(store).plan({
      contextId: stored.contextId,
      sourceOccurrenceId: sourceId,
      targetOccurrenceId: targetId,
      harmony: { interval: { degree: 3, direction }, key: { tonic: "C", mode: "major" } },
    })).perNote[0].harmonyPitch;
  const above = await plan("above");
  const below = await plan("below");
  assert.ok(above > 64, "above harmony must be above the source");
  assert.ok(below < 64, "below harmony must be below the source");
});

// ---------- 3. 扩展调式映射 ----------

test("dorian maps onto the dorian pitch-class set", async () => {
  const store = createStore();
  const { stored, sourceId, targetId } = createStoredContext(store, {
    sourceNotes: notesFromPitches([62, 64, 65, 67, 69]),
  });
  // D dorian：D E F G A B C。三上（+2 级）= F G A B C（A 是第 5 级，+2 → 第 7 级 C）。
  const result = await service(store).plan({
    contextId: stored.contextId,
    sourceOccurrenceId: sourceId,
    targetOccurrenceId: targetId,
    harmony: { interval: { degree: 3, direction: "above" }, key: { tonic: "D", mode: "minor", scale: "dorian" } },
  });
  assert.equal(result.key.scale, "dorian");
  assert.deepEqual(result.perNote.map((item) => item.harmonyPitch), [65, 67, 69, 71, 72]);
});

test("harmonic minor uses its raised seventh", async () => {
  const store = createStore();
  const { stored, sourceId, targetId } = createStoredContext(store, {
    sourceNotes: notesFromPitches([69, 71, 72]),
  });
  // A harmonic minor：A B C D E F G#。二上 = B C D（G# 而非 G）。
  const result = await service(store).plan({
    contextId: stored.contextId,
    sourceOccurrenceId: sourceId,
    targetOccurrenceId: targetId,
    harmony: { interval: { degree: 2, direction: "above" }, key: { tonic: "A", mode: "minor", scale: "harmonic_minor" } },
  });
  assert.deepEqual(result.perNote.map((item) => item.harmonyPitch), [71, 72, 74]);
});

test("pentatonic degrees wrap at five, not seven", async () => {
  const store = createStore();
  const { stored, sourceId, targetId } = createStoredContext(store, {
    sourceNotes: notesFromPitches([60, 62, 64, 67, 69]),
  });
  // C major pentatonic：C D E G A。三上（+2 级，5 音回绕）= E G A C D（G 第 4 级 +2 → 回绕 C，A 第 5 级 +2 → D）。
  const result = await service(store).plan({
    contextId: stored.contextId,
    sourceOccurrenceId: sourceId,
    targetOccurrenceId: targetId,
    harmony: { interval: { degree: 3, direction: "above" }, key: { tonic: "C", mode: "major", scale: "major_pentatonic" } },
  });
  assert.deepEqual(result.perNote.map((item) => item.harmonyPitch), [64, 67, 69, 72, 74]);
});

test("chromatic maps every note exactly a semitone shift with no approximation", async () => {
  const store = createStore();
  const { stored, sourceId, targetId } = createStoredContext(store, {
    sourceNotes: notesFromPitches([60, 61, 66]),
  });
  // chromatic 每音都在调内：二上 = +1 半音，无 needsReview。
  const result = await service(store).plan({
    contextId: stored.contextId,
    sourceOccurrenceId: sourceId,
    targetOccurrenceId: targetId,
    harmony: { interval: { degree: 2, direction: "above" }, key: { tonic: "C", mode: "major", scale: "chromatic" } },
  });
  assert.deepEqual(result.perNote.map((item) => item.harmonyPitch), [61, 62, 67]);
  assert.equal(result.summary.outOfScale, 0);
  assert.equal(result.summary.needsReview, 0);
});

// ---------- 4. 调外音 review warning（非主观断言） ----------

test("out-of-scale source notes produce a review warning, never a taste verdict", async () => {
  const store = createStore();
  const { stored, sourceId, targetId } = createStoredContext(store, {
    sourceNotes: notesFromPitches([60, 66]), // F# 在 C ionian 调外
  });
  const result = await service(store).plan({
    contextId: stored.contextId,
    sourceOccurrenceId: sourceId,
    targetOccurrenceId: targetId,
    harmony: { interval: { degree: 3, direction: "above" }, key: { tonic: "C", mode: "major" } },
  });
  assert.equal(result.summary.outOfScale, 1);
  assert.equal(result.summary.needsReview, 1);
  assert.ok(result.warnings.some((w) => w.code === "NON_DIATONIC_SOURCE_APPROXIMATED"));
  const flagged = result.perNote.find((item) => item.sourcePitch === 66);
  assert.equal(flagged.needsReview, true);
  // 不出现的断言：没有任何 "好听/不和谐" 类主观词。
  assert.ok(!JSON.stringify(result).match(/dissonant|consonant|sounds good|好听|不和谐/i));
});

// ---------- 5. 呼吸音符不进和声统计 ----------

test("breath notes are excluded even with extended scales", async () => {
  const store = createStore();
  const { stored, sourceId, targetId } = createStoredContext(store, {
    sourceNotes: [
      { onsetBlick: 0, durationBlick: Q, pitch: 60, lyrics: "do" },
      { onsetBlick: Q, durationBlick: Q, pitch: 62, lyrics: "br" },
    ],
  });
  const result = await service(store).plan({
    contextId: stored.contextId,
    sourceOccurrenceId: sourceId,
    targetOccurrenceId: targetId,
    harmony: { interval: { degree: 3, direction: "above" }, key: { tonic: "C", mode: "major", scale: "ionian" } },
  });
  assert.equal(result.summary.sourceNotes, 1);
  assert.equal(result.summary.skippedBreaths, 1);
  assert.equal(result.perNote.length, 1);
});
