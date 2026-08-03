import { performance } from "node:perf_hooks";

import { ArtifactStore } from "../server/src/artifact-store.js";
import { ExpressionPlanService } from "../server/src/expression-plan.js";
import { SnapshotStore } from "../server/src/snapshot.js";

const QUARTER_BLICK = 705_600_000;
const RUNS = 25;

function createRangeContext(noteCount) {
  const store = new SnapshotStore({ now: () => 1_000 });
  const stored = store.create({
    epoch: 1,
    scope: { kind: "range" },
    observedAt: new Date(1_000).toISOString(),
    context: { kind: "range", occurrences: [] },
  });
  stored.context.occurrences.push({
    occurrence: 0,
    trackIndex: 0,
    groupIndex: 0,
    targetGroupUuid: "synthetic-pitch-technique-baseline",
    timeOffsetBlick: 0,
    pitchOffsetSemitone: 0,
    groupNoteCount: noteCount,
    sharedTargetOccurrences: [0],
    noteFingerprints: Array.from({ length: noteCount }, (_, index) => ({
      indexInGroup: index,
      onsetBlick: index * 2 * QUARTER_BLICK,
      durationBlick: 2 * QUARTER_BLICK,
      pitch: 60 + (index % 12),
      lyrics: "la",
      phonemesOverride: "",
      languageOverride: "",
      detuneCents: 0,
    })),
  });
  stored.context.quarterBlick = QUARTER_BLICK;
  stored.context.meterMarks = [{ position: 0, positionBlick: 0, numerator: 4, denominator: 4 }];
  stored.context.tempoMarks = [{ positionBlick: 0, positionSeconds: 0, bpm: 120 }];
  stored.snapshotToken = `snap_${stored.contextId}`;
  return { store, stored };
}

function requestFor(contextId, noteCount) {
  const end = noteCount - 1;
  const vibratoNote = Math.floor(noteCount / 2);
  return {
    contextId,
    occurrence: 0,
    defaults: {
      vibrato: {
        surface: "pitchDelta",
        rateHz: 5.2,
        onsetDelayQuarter: 0.22,
        rampQuarter: 0.18,
        fadeOutQuarter: 0.14,
      },
      scoop: { lengthQuarter: 0.16, shapePower: 2 },
      fall: { lengthQuarter: 0.22, shapePower: 2 },
    },
    gestures: [
      {
        type: "hairpin",
        from: 0,
        to: end,
        peak: 0.72,
        amounts: { loudness: 1.2, tension: 0.08, breathiness: 0.12 },
      },
      { type: "vibrato", notes: [vibratoNote], depthCents: 15 },
      { type: "scoop", targets: [[Math.max(1, Math.floor(noteCount / 3)), 22]] },
      { type: "fall", targets: [[Math.max(2, Math.floor(noteCount * 2 / 3)), 24]] },
    ],
    constraints: {
      maxAbsPitchDeltaCents: 80,
      maxAbsLoudnessDeltaDb: 4.5,
      maxAbsTensionDelta: 0.45,
      maxAbsBreathinessDelta: 0.25,
      maxTotalPoints: 1200,
      avoidExcessiveVibrato: true,
    },
    sampling: { pointsPerQuarter: 4, vibratoPointsPerCycle: 8 },
  };
}

async function measure(noteCount) {
  const durations = [];
  let sample;
  for (let run = 0; run < RUNS + 3; run += 1) {
    const { store, stored } = createRangeContext(noteCount);
    const input = requestFor(stored.contextId, noteCount);
    const service = new ExpressionPlanService({
      store,
      now: () => 2_000,
      artifactStore: new ArtifactStore({ now: () => 2_000 }),
      sessionId: "baseline",
    });
    const startedAt = performance.now();
    const result = await service.plan(input);
    const elapsedMs = performance.now() - startedAt;
    if (!result.ok) throw new Error(`baseline planning failed for ${noteCount} notes`);
    if (run >= 3) durations.push(elapsedMs);
    sample ??= {
      inputBytes: Buffer.byteLength(JSON.stringify(input), "utf8"),
      responseBytes: Buffer.byteLength(JSON.stringify(result), "utf8"),
      operationCount: result.summary.operationCount,
      artifactCount: result.artifacts?.length ?? 0,
    };
  }
  durations.sort((left, right) => left - right);
  return {
    noteCount,
    runs: RUNS,
    ...sample,
    medianMs: durations[Math.floor(durations.length / 2)],
    p95Ms: durations[Math.ceil(durations.length * 0.95) - 1],
    execution: { hostCalls: 0, undoRecords: 0, scope: "in_memory_planner" },
  };
}

const report = {
  kind: "svcopilot-pitch-technique-baseline",
  schemaVersion: 1,
  tokenizer: { status: "unavailable", reason: "no tokenizer dependency is bundled" },
  scenarios: [await measure(12), await measure(373)],
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
