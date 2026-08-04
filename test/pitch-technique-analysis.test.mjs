import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ArtifactStore } from "../server/src/artifact-store.js";
import { encodeToolError, encodeToolResult } from "../server/src/mcp-result-encoder.js";
import { PitchTechniqueAnalysisService } from "../server/src/pitch-technique-analysis.js";
import { fitRichardsSegment } from "../server/src/pitch-techniques/fit-worker.js";
import { SnapshotStore } from "../server/src/snapshot.js";
import {
  ANALYSIS_REFERENCE_TIMEBASE,
  createTechniqueAnalysisReferenceCases,
  secondsToBlick,
} from "../docs/pitch-techniques/reference/analysis.mjs";

const SESSION_ID = "pitch-technique-analysis-test";

function createFixture(referenceCase, options = {}) {
  const store = new SnapshotStore({ now: () => 1000 });
  const artifactStore = new ArtifactStore({ now: () => 2000 });
  const stored = store.create({
    epoch: 1,
    scope: { kind: "range" },
    observedAt: new Date(1000).toISOString(),
    context: { kind: "range", occurrences: [] },
  });
  const notes = options.notes ?? referenceCase?.notes ?? [];
  const values = options.values ?? referenceCase?.values ?? [];
  const occurrence = {
    occurrence: 0,
    trackIndex: 0,
    groupIndex: 0,
    targetGroupUuid: "uuid-pitch-technique-analysis",
    timeOffsetBlick: 0,
    pitchOffsetSemitone: 0,
    sharedTargetOccurrences: [0],
    noteFingerprints: notes.map((note) => ({
      indexInGroup: note.indexInGroup,
      onsetBlick: secondsToBlick(note.onsetSeconds),
      durationBlick: secondsToBlick(note.durationSeconds),
      pitch: note.pitch,
      lyrics: note.lyrics ?? "a",
      phonemesOverride: "",
      languageOverride: "",
      detuneCents: note.detuneCents ?? 0,
    })),
  };
  stored.context.occurrences.push(occurrence);
  if (options.withComputedPitch !== false) {
    const finiteFrameIndexes = values.flatMap((value, index) => (
      Number.isFinite(value) ? [index] : []
    ));
    stored.context.computedPitchByOccurrence = {
      0: {
        startBlick: 0,
        intervalBlick: options.intervalBlick ?? secondsToBlick(
          1 / (options.sampleRateHz ?? ANALYSIS_REFERENCE_TIMEBASE.sampleRateHz)
        ),
        frames: values.length,
        values,
        evidence: {
          requestedFrames: values.length,
          observedFrames: finiteFrameIndexes.length,
          nullFrameIndices: values.flatMap((value, index) => (
            Number.isFinite(value) ? [] : [index]
          )),
        },
      },
    };
  }
  stored.context.quarterBlick = ANALYSIS_REFERENCE_TIMEBASE.quarterBlick;
  stored.context.meterMarks = [{
    position: 0,
    positionBlick: 0,
    numerator: 4,
    denominator: 4,
  }];
  stored.context.tempoMarks = [{ positionBlick: 0, positionSeconds: 0, bpm: 120 }];
  stored.snapshotToken = `snap_${stored.contextId}`;
  const service = new PitchTechniqueAnalysisService({
    store,
    artifactStore,
    sessionId: SESSION_ID,
    now: () => 3000,
    ...options.service,
  });
  return { store, artifactStore, stored, service };
}

function findCandidate(result, kind, subtype) {
  return result.data.candidates.items.find((candidate) => (
    candidate.kind === kind && (subtype === undefined || candidate.subtype === subtype)
  ));
}

function assertClose(actual, expected, tolerance, label) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: actual=${actual}, expected=${expected}, tolerance=${tolerance}`
  );
}

test("T17 synthetic oracle recovers bounded transition, vibrato, and transient candidates", async () => {
  const cases = createTechniqueAnalysisReferenceCases();
  const transitionCase = cases[0];
  const transitionFixture = createFixture(transitionCase);
  const transition = await transitionFixture.service.analyze({
    contextId: transitionFixture.stored.contextId,
  });
  const transitionCandidate = findCandidate(transition, "transition");
  assert.ok(transitionCandidate, JSON.stringify(transition.data.rejected));
  assert.deepEqual(transitionCandidate.anchors, { fromNote: 0, toNote: 1 });
  assertClose(
    transitionCandidate.parameters.inflectionSeconds,
    transitionCase.expected.transition.inflectionSeconds,
    0.08,
    "Richards inflection"
  );
  assertClose(
    transitionCandidate.parameters.sharpness,
    transitionCase.expected.transition.growthPerSecond * (
      transitionCase.expected.transition.toSeconds - transitionCase.expected.transition.fromSeconds
    ),
    1.5,
    "Richards sharpness"
  );

  const vibratoCase = cases[1];
  const vibratoFixture = createFixture(vibratoCase);
  const vibrato = await vibratoFixture.service.analyze({ contextId: vibratoFixture.stored.contextId });
  const vibratoCandidate = findCandidate(vibrato, "vibrato");
  assert.ok(vibratoCandidate, JSON.stringify(vibrato.data.rejected));
  assertClose(
    vibratoCandidate.parameters.rateHz,
    vibratoCase.expected.vibrato.rateStartHz,
    0.55,
    "vibrato rate"
  );
  assertClose(
    vibratoCandidate.parameters.depthSemitone,
    vibratoCase.expected.vibrato.depthStartSemitone,
    0.08,
    "vibrato depth"
  );

  const transientCase = cases[2];
  const transientFixture = createFixture(transientCase);
  const transient = await transientFixture.service.analyze({ contextId: transientFixture.stored.contextId });
  const transientCandidate = findCandidate(transient, "transient", "overshoot");
  assert.ok(transientCandidate, JSON.stringify(transient.data.rejected));
  assert.equal(transientCandidate.anchors.note, 1);
  assertClose(
    transientCandidate.parameters.peakSemitone,
    transientCase.expected.transient.peakSemitone,
    0.07,
    "transient peak"
  );
  assert.equal(
    transientCandidate.parameters.dampingRatio,
    transientCase.expected.transient.dampingRatio
  );
});

test("T17 keeps mixed candidates explainable and reports a successful empty analysis", async () => {
  const cases = createTechniqueAnalysisReferenceCases();
  const mixedFixture = createFixture(cases[3]);
  const mixed = await mixedFixture.service.analyze({ contextId: mixedFixture.stored.contextId });
  for (const kind of cases[3].expected.kinds) {
    assert.ok(findCandidate(mixed, kind), `${kind}: ${JSON.stringify(mixed.data.rejected)}`);
  }

  const flatFixture = createFixture(null, {
    notes: [{ indexInGroup: 0, onsetSeconds: 0, durationSeconds: 2, pitch: 60 }],
    values: new Array(161).fill(60),
  });
  const flat = await flatFixture.service.analyze({ contextId: flatFixture.stored.contextId });
  assert.equal(flat.status, "succeeded");
  assert.equal(flat.data.summary.analysisStatus, "no_technique_candidate");
  assert.equal(flat.data.summary.reasonCode, "NO_TECHNIQUE_CANDIDATE");
  assert.equal(flat.data.candidates.count, 0);
});

test("T17 rejects capture, provenance, coverage, and sampling evidence with actionable MCP errors", async () => {
  const referenceCase = createTechniqueAnalysisReferenceCases()[0];
  const missingFixture = createFixture(referenceCase, { withComputedPitch: false });
  await assert.rejects(
    missingFixture.service.analyze({ contextId: missingFixture.stored.contextId }),
    (error) => error.code === "COMPUTED_PITCH_NOT_CAPTURED"
  );

  const nullFixture = createFixture(referenceCase, {
    values: new Array(referenceCase.values.length).fill(null),
  });
  await assert.rejects(
    nullFixture.service.analyze({ contextId: nullFixture.stored.contextId }),
    (error) => error.code === "INSUFFICIENT_COMPUTED_PITCH"
      && error.details.reason === "all_frames_null_or_processing_pending"
      && error.details.remedy.tool === "sv_wait_for_processing"
  );

  const fragmentedValues = referenceCase.values.map((value, index) => (
    index % 2 === 0 ? value : null
  ));
  const fragmentedFixture = createFixture(referenceCase, { values: fragmentedValues });
  await assert.rejects(
    fragmentedFixture.service.analyze({ contextId: fragmentedFixture.stored.contextId }),
    (error) => error.code === "INSUFFICIENT_COMPUTED_PITCH"
      && error.details.reason === "low_coverage_or_fragmented"
  );

  const coarseFixture = createFixture(null, {
    notes: [{ indexInGroup: 0, onsetSeconds: 0, durationSeconds: 2, pitch: 60 }],
    values: new Array(21).fill(60),
    sampleRateHz: 10,
  });
  await assert.rejects(
    coarseFixture.service.analyze({ contextId: coarseFixture.stored.contextId }),
    (error) => error.code === "SAMPLING_RATE_TOO_LOW"
      && error.details.minimumSampleRateHz === 17
  );

  const invalidFixture = createFixture(referenceCase);
  await assert.rejects(
    invalidFixture.service.analyze({
      contextId: invalidFixture.stored.contextId,
      unexpected: true,
    }),
    (error) => error.code === "INVALID_ARGUMENTS" && error.details.unknown.includes("unexpected")
  );

  const incompleteFixture = createFixture(referenceCase);
  incompleteFixture.stored.context.computedPitchByOccurrence[0].evidence.observedFrames = 0;
  let caught;
  await assert.rejects(
    incompleteFixture.service.analyze({ contextId: incompleteFixture.stored.contextId }),
    (error) => {
      caught = error;
      return error.code === "INSUFFICIENT_COMPUTED_PITCH"
        && error.details.reason === "sampling_provenance_incomplete";
    }
  );
  const encoded = encodeToolError(caught.code, caught.message, caught.details);
  assert.equal(encoded.structuredContent.error.code, "INSUFFICIENT_COMPUTED_PITCH");
  assert.equal(encoded.structuredContent.error.reason, "sampling_provenance_incomplete");
  assert.equal(encoded.structuredContent.error.remedy.tool, "sv_snapshot_range");

  const invalidDetuneFixture = createFixture(referenceCase);
  invalidDetuneFixture.stored.context.occurrences[0].noteFingerprints[0].detuneCents = "not-a-number";
  await assert.rejects(
    invalidDetuneFixture.service.analyze({ contextId: invalidDetuneFixture.stored.contextId }),
    (error) => error.code === "INVALID_CONTEXT"
  );
});

test("T17 preserves fit and identifiability rejection evidence without inventing a candidate", async () => {
  const referenceCase = createTechniqueAnalysisReferenceCases()[0];
  const unavailableFixture = createFixture(referenceCase, {
    service: {
      fitRichards: async () => {
        const error = new Error("fit worker is unavailable");
        error.code = "FIT_WORKER_UNAVAILABLE";
        throw error;
      },
    },
  });
  const unavailable = await unavailableFixture.service.analyze({
    contextId: unavailableFixture.stored.contextId,
  });
  assert.equal(unavailable.data.rejected.byCode.FIT_WORKER_UNAVAILABLE, 1);
  const unavailableArtifact = unavailableFixture.artifactStore.resolve({
    artifactId: unavailable.data.artifactRef.artifactId,
    expectedContentHash: unavailable.data.artifactRef.contentHash,
    sessionId: SESSION_ID,
  });
  assert.equal(unavailableArtifact.payload.solver[0].failure.code, "FIT_WORKER_UNAVAILABLE");

  const timeoutFixture = createFixture(referenceCase, {
    service: {
      fitRichards: async () => {
        const error = new Error("fit worker timed out");
        error.code = "FIT_TIMEOUT";
        throw error;
      },
    },
  });
  const timeout = await timeoutFixture.service.analyze({ contextId: timeoutFixture.stored.contextId });
  assert.equal(timeout.data.rejected.byCode.FIT_TIMEOUT, 1);

  const limitedFixture = createFixture(referenceCase, {
    service: {
      fitRichards: (request) => {
        const result = structuredClone(fitRichardsSegment(request));
        result.termination = "iteration_limit";
        result.warnings = [{ code: "FIT_DID_NOT_CONVERGE" }];
        return result;
      },
    },
  });
  const limited = await limitedFixture.service.analyze({ contextId: limitedFixture.stored.contextId });
  assert.equal(limited.data.rejected.byCode.FIT_DID_NOT_CONVERGE, 1);

  const endpointFixture = createFixture(referenceCase, {
    values: new Array(referenceCase.values.length).fill(60),
  });
  const endpoint = await endpointFixture.service.analyze({ contextId: endpointFixture.stored.contextId });
  assert.ok(endpoint.data.rejected.byCode.MODEL_NOT_IDENTIFIABLE >= 1);
});

test("T17 is deterministic, stores dense solver evidence in Artifact, and keeps the response compact", async () => {
  const referenceCase = createTechniqueAnalysisReferenceCases()[0];
  const fixture = createFixture(referenceCase);
  const first = await fixture.service.analyze({ contextId: fixture.stored.contextId, maxCandidates: 1 });
  const second = await fixture.service.analyze({ contextId: fixture.stored.contextId, maxCandidates: 1 });
  assert.equal(first.data.analysisHash, second.data.analysisHash);
  assert.deepEqual(first.data.candidates, second.data.candidates);
  assert.ok(first.data.artifactRef.totalBytes > 0);
  assert.equal(first.data.artifactRef.kind, "pitch-technique-analysis");
  assert.equal(first.data.candidates.items.some((candidate) => "contribution" in candidate), false);
  const artifact = fixture.artifactStore.resolve({
    artifactId: first.data.artifactRef.artifactId,
    expectedContentHash: first.data.artifactRef.contentHash,
    sessionId: SESSION_ID,
  });
  assert.equal(artifact.payload.analysisHash, first.data.analysisHash);
  assert.ok(artifact.payload.dense.timeSeconds.length > 100);
  assert.ok(Array.isArray(artifact.payload.solver));
  assert.ok(artifact.payload.candidates.some((candidate) => Array.isArray(candidate.contribution)));
  const page = fixture.artifactStore.readPage({
    artifactId: first.data.artifactRef.artifactId,
    expectedContentHash: first.data.artifactRef.contentHash,
    sessionId: SESSION_ID,
    byteBudget: 128,
  });
  assert.equal(typeof page.page.data, "string");
  assert.equal(page.page.hasMore, true);
  assert.ok(page.page.cursor);
  const encoded = encodeToolResult(first);
  assert.ok(Buffer.byteLength(JSON.stringify(encoded.structuredContent), "utf8") < 16 * 1024);
});

test("T17 has no host session, setter, or Undo dependency", async () => {
  const source = readFileSync(new URL("../server/src/pitch-technique-analysis.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /HostSession|withExclusive|newUndoRecord|\.set[A-Z]\w*\(/);
  const referenceCase = createTechniqueAnalysisReferenceCases()[1];
  const fixture = createFixture(referenceCase);
  let storeWrites = 0;
  const readOnlyStore = new Proxy(fixture.store, {
    set() {
      storeWrites += 1;
      throw new Error("analysis must not mutate SnapshotStore");
    },
  });
  const service = new PitchTechniqueAnalysisService({
    store: readOnlyStore,
    artifactStore: fixture.artifactStore,
    sessionId: SESSION_ID,
    now: () => 3000,
  });
  await service.analyze({ contextId: fixture.stored.contextId });
  assert.equal(storeWrites, 0);
});

test("T17 keeps a 373-note analysis response under the compact surface budget", async () => {
  const noteCount = 373;
  const durationSeconds = 0.1;
  const framesPerNote = durationSeconds * ANALYSIS_REFERENCE_TIMEBASE.sampleRateHz;
  const notes = Array.from({ length: noteCount }, (_, index) => ({
    indexInGroup: index,
    onsetSeconds: index * durationSeconds,
    durationSeconds,
    pitch: index % 2 === 0 ? 60 : 62,
  }));
  const values = Array.from({ length: noteCount * framesPerNote + 1 }, (_, frameIndex) => {
    const noteIndex = Math.min(noteCount - 1, Math.floor(frameIndex / framesPerNote));
    return noteIndex % 2 === 0 ? 60 : 62;
  });
  const fixture = createFixture(null, { notes, values });
  const result = await fixture.service.analyze({
    contextId: fixture.stored.contextId,
    maxCandidates: 12,
  });
  const encoded = encodeToolResult(result);
  assert.equal(result.data.melodicNoteCount, noteCount);
  assert.equal(result.data.candidates.items.some((candidate) => "contribution" in candidate), false);
  assert.equal(result.data.artifactRef.pagingRequired, true);
  assert.ok(Buffer.byteLength(JSON.stringify(encoded.structuredContent), "utf8") < 16 * 1024);
});
