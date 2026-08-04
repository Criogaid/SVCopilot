import assert from "node:assert/strict";
import test from "node:test";

import {
  ANALYSIS_REFERENCE_TIMEBASE,
  ANALYSIS_REFERENCE_VERSION,
  createTechniqueAnalysisReferenceCases,
  secondsToBlick,
} from "./analysis.mjs";

test("analysis reference corpus has finite, deterministic, timebase-aligned ground truth", () => {
  const first = createTechniqueAnalysisReferenceCases();
  const second = createTechniqueAnalysisReferenceCases();
  assert.equal(ANALYSIS_REFERENCE_VERSION, 1);
  assert.deepEqual(first, second);
  assert.equal(first.length, 4);
  for (const current of first) {
    assert.ok(current.values.length >= 161, current.id);
    assert.ok(current.values.every(Number.isFinite), current.id);
    assert.ok(current.notes.every((note) => Number.isSafeInteger(secondsToBlick(note.onsetSeconds))), current.id);
    assert.ok(current.notes.every((note) => Number.isSafeInteger(secondsToBlick(note.durationSeconds))), current.id);
  }
  assert.equal(secondsToBlick(1 / ANALYSIS_REFERENCE_TIMEBASE.sampleRateHz), 17640000);
});

test("analysis reference cases cover isolated and mixed explainable technique families", () => {
  const cases = createTechniqueAnalysisReferenceCases();
  assert.deepEqual(
    cases.map((current) => current.id),
    [
      "analysis-richards-transition-v1",
      "analysis-steady-vibrato-v1",
      "analysis-first-peak-transient-v1",
      "analysis-mixed-transition-vibrato-v1",
    ]
  );
  assert.equal(cases[0].expected.transition.growthPerSecond, 14);
  assert.equal(cases[1].expected.vibrato.rateStartHz, 5.5);
  assert.equal(cases[2].expected.transient.peakSemitone, 0.35);
  assert.deepEqual(cases[3].expected.kinds, ["transition", "vibrato"]);
  assert.equal(cases[3].values.length, 241);
});
