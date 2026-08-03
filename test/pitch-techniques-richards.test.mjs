import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { avaRichardsUnitAtInflection } from "../docs/pitch-techniques/reference/model.mjs";
import {
  RICHARDS_MODEL_FAMILY,
  rawRichards,
  richardsInflectionSeconds,
  richardsSegment,
  richardsTransition,
} from "../server/src/pitch-techniques/richards.js";
import { loadPitchTechniqueCorpus } from "./helpers/pitch-technique-corpus.mjs";

function assertClose(actual, expected, tolerance, message = "values differ") {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message}: actual=${actual}, expected=${expected}, tolerance=${tolerance}`,
  );
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

test("Richards production module only depends on the concentrated reference model", () => {
  const sourcePath = fileURLToPath(
    new URL("../server/src/pitch-techniques/richards.js", import.meta.url),
  );
  const source = readFileSync(sourcePath, "utf8");
  assert.match(source, /docs\/pitch-techniques\/reference\/model\.mjs/);
  assert.doesNotMatch(source, /artifact-store|host-|mcp|process\.env|session|store/i);
  assert.deepEqual(RICHARDS_MODEL_FAMILY, {
    asymptotic: "richards_asymptotic",
    segment: "richards_segment_normalized",
  });
});

test("raw Richards uses the reference inflection parameterization", () => {
  const inflectionSeconds = 0.41;
  const steepnessPerSecond = 8.2;
  const asymmetryB = 1.7;
  for (const timeSeconds of [-0.2, 0, inflectionSeconds, 0.9]) {
    assertClose(
      rawRichards(timeSeconds, inflectionSeconds, steepnessPerSecond, asymmetryB),
      avaRichardsUnitAtInflection(timeSeconds, {
        inflectionSeconds,
        growthPerSecond: steepnessPerSecond,
        asymmetryB,
      }),
      2e-15,
    );
  }
  assert.throws(
    () => richardsInflectionSeconds(
      Number.MAX_VALUE,
      Number.MIN_VALUE,
      Number.MIN_VALUE,
      0,
    ),
    (error) => error.code === "RICHARDS_INFLECTION_OVERFLOW",
  );
});

test("endpoint-normalized Richards reaches exact upward and downward endpoints", () => {
  const fromSeconds = 1.25;
  const toSeconds = 1.98;
  const inflectionSeconds = 1.64;
  const steepnessPerSecond = 11;
  const asymmetryB = 1.7;
  for (const [fromValue, toValue, direction] of [
    [60, 64, 1],
    [64, 60, -1],
    [-Number.MAX_VALUE, Number.MAX_VALUE, 1],
  ]) {
    assert.equal(
      richardsSegment(
        fromSeconds,
        fromSeconds,
        toSeconds,
        inflectionSeconds,
        steepnessPerSecond,
        asymmetryB,
      ),
      0,
    );
    assert.equal(
      richardsSegment(
        toSeconds,
        fromSeconds,
        toSeconds,
        inflectionSeconds,
        steepnessPerSecond,
        asymmetryB,
      ),
      1,
    );
    assert.equal(
      richardsTransition(
        fromSeconds,
        fromSeconds,
        toSeconds,
        fromValue,
        toValue,
        inflectionSeconds,
        steepnessPerSecond,
        asymmetryB,
      ),
      fromValue,
    );
    assert.equal(
      richardsTransition(
        toSeconds,
        fromSeconds,
        toSeconds,
        fromValue,
        toValue,
        inflectionSeconds,
        steepnessPerSecond,
        asymmetryB,
      ),
      toValue,
    );
    let previous = fromValue;
    for (let index = 1; index < 20; index++) {
      const value = richardsTransition(
        fromSeconds + (toSeconds - fromSeconds) * index / 20,
        fromSeconds,
        toSeconds,
        fromValue,
        toValue,
        inflectionSeconds,
        steepnessPerSecond,
        asymmetryB,
      );
      assert.equal(Number.isFinite(value), true);
      assert.ok(direction * (value - previous) >= 0);
      previous = value;
    }
  }
});

test("endpoint-normalized Richards preserves inflection and logistic symmetry", () => {
  const fromSeconds = 1.2;
  const toSeconds = 2;
  for (const asymmetryB of [0.35, 1, 3]) {
    const inflectionSeconds = 1.66;
    const step = 1e-4;
    const secondDerivative = (
      richardsSegment(
        inflectionSeconds + step,
        fromSeconds,
        toSeconds,
        inflectionSeconds,
        9,
        asymmetryB,
      )
      - 2 * richardsSegment(
        inflectionSeconds,
        fromSeconds,
        toSeconds,
        inflectionSeconds,
        9,
        asymmetryB,
      )
      + richardsSegment(
        inflectionSeconds - step,
        fromSeconds,
        toSeconds,
        inflectionSeconds,
        9,
        asymmetryB,
      )
    ) / step ** 2;
    assertClose(secondDerivative, 0, 3e-5);
  }
  for (let index = 0; index <= 40; index++) {
    const timeSeconds = fromSeconds + (toSeconds - fromSeconds) * index / 40;
    const mirroredSeconds = fromSeconds + toSeconds - timeSeconds;
    assertClose(
      richardsSegment(timeSeconds, fromSeconds, toSeconds, 1.6, 10, 1)
      + richardsSegment(mirroredSeconds, fromSeconds, toSeconds, 1.6, 10, 1),
      1,
      2e-15,
    );
  }
});

test("endpoint-normalized Richards stays finite across seeded legal parameters", () => {
  const random = seededRandom(0xa7a2_2016);
  for (let trial = 0; trial < 1200; trial++) {
    const durationSeconds = 0.01 + random() * 1.99;
    const fromSeconds = -0.5 + random();
    const toSeconds = fromSeconds + durationSeconds;
    const inflectionSeconds = fromSeconds + durationSeconds * (0.05 + random() * 0.9);
    const steepnessPerSecond = (1 + random() * 39) / durationSeconds;
    const asymmetryB = Math.exp(-3 + random() * 6);
    const fromValue = 40 + random() * 40;
    const toValue = fromValue + (random() < 0.5 ? -1 : 1) * (0.1 + random() * 10.9);
    const direction = Math.sign(toValue - fromValue);
    assert.equal(
      richardsSegment(
        fromSeconds,
        fromSeconds,
        toSeconds,
        inflectionSeconds,
        steepnessPerSecond,
        asymmetryB,
      ),
      0,
    );
    assert.equal(
      richardsSegment(
        toSeconds,
        fromSeconds,
        toSeconds,
        inflectionSeconds,
        steepnessPerSecond,
        asymmetryB,
      ),
      1,
    );
    let previous = fromValue;
    for (let sample = 1; sample <= 10; sample++) {
      const value = richardsTransition(
        sample === 10
          ? toSeconds
          : fromSeconds + durationSeconds * sample / 10,
        fromSeconds,
        toSeconds,
        fromValue,
        toValue,
        inflectionSeconds,
        steepnessPerSecond,
        asymmetryB,
      );
      assert.equal(Number.isFinite(value), true);
      assert.ok(direction * (value - previous) >= -1e-12);
      previous = value;
    }
  }
});

test("Richards production model replays the concentrated corpus cases", () => {
  const { corpus } = loadPitchTechniqueCorpus();
  for (const current of corpus.cases.filter((entry) => entry.family.startsWith("richards_"))) {
    if (current.family === "richards_asymptotic") {
      assert.throws(
        () => richardsInflectionSeconds(
          current.input.A,
          current.input.B,
          current.input.growthPerSecond,
          current.input.midpointSeconds,
        ),
        (error) => error.code === current.expectedError.code,
        current.id,
      );
      continue;
    }
    if (current.expectedError) {
      assert.throws(
        () => richardsSegment(
          current.input.spanSeconds / 2,
          0,
          current.input.spanSeconds,
          current.input.inflectionSeconds,
          current.input.growthPerSecond,
          current.input.asymmetryB,
        ),
        (error) => error.code === current.expectedError.code,
        current.id,
      );
      continue;
    }
    for (let index = 0; index < current.sampleSeconds.length; index++) {
      assertClose(
        richardsTransition(
          current.sampleSeconds[index],
          0,
          current.input.spanSeconds,
          current.input.lowerPitch,
          current.input.upperPitch,
          current.input.inflectionSeconds,
          current.input.growthPerSecond,
          current.input.asymmetryB,
        ),
        current.denseTruth.values[index],
        current.tolerance.absolute,
        current.id,
      );
    }
  }
});

test("Richards rejects invalid and degenerate inputs without non-finite output", () => {
  assert.throws(() => rawRichards(Number.NaN, 0, 1, 1), TypeError);
  assert.throws(() => richardsSegment(-0.1, 0, 1, 0.5, 8, 1), RangeError);
  assert.throws(
    () => richardsSegment(0.5, 0, 1, 0.5, Number.MIN_VALUE, 1),
    (error) => error.code === "RICHARDS_DEGENERATE_SEGMENT",
  );
});

test("production Richards 10000-sample generation stays within the p95 budget", () => {
  const parameters = [0, 1, 0.58, 8, 1.35];
  for (let index = 0; index < 10_000; index++) {
    richardsSegment(index / 10_000, ...parameters);
  }
  const durations = [];
  for (let run = 0; run < 20; run++) {
    const startedAt = performance.now();
    for (let index = 0; index < 10_000; index++) {
      richardsSegment(index / 10_000, ...parameters);
    }
    durations.push(performance.now() - startedAt);
  }
  durations.sort((left, right) => left - right);
  const p95 = durations[Math.ceil(durations.length * 0.95) - 1];
  assert.ok(p95 <= 20, `Richards 10000-sample p95 exceeded 20 ms: ${p95}`);
});
