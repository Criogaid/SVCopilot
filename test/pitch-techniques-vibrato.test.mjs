import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  integratedLinearFrequencyPhase as referenceIntegratedLinearFrequencyPhase,
  timeVaryingVibrato as referenceTimeVaryingVibrato,
} from "../docs/pitch-techniques/reference/model.mjs";
import {
  integratedLinearFrequencyPhase,
  timeVaryingVibrato,
} from "../server/src/pitch-techniques/vibrato.js";
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

test("vibrato production module only depends on the concentrated reference model", () => {
  const sourcePath = fileURLToPath(
    new URL("../server/src/pitch-techniques/vibrato.js", import.meta.url),
  );
  const source = readFileSync(sourcePath, "utf8");
  assert.match(source, /docs\/pitch-techniques\/reference\/model\.mjs/);
  assert.doesNotMatch(source, /artifact-store|host-|mcp|process\.env|session|store|vibratoEnv/i);
});

test("time-varying vibrato integrates linear frequency in seconds", () => {
  const phaseParameters = {
    durationSeconds: 2,
    rateStartHz: 5,
    rateEndHz: 7,
    phaseRad: 0.3,
  };
  assertClose(
    integratedLinearFrequencyPhase(2, phaseParameters),
    0.3 + 2 * Math.PI * 12,
    1e-13,
  );
  for (const localSeconds of [-1, 0, 0.5, 1, 2, 3]) {
    assertClose(
      integratedLinearFrequencyPhase(localSeconds, phaseParameters),
      referenceIntegratedLinearFrequencyPhase(localSeconds, phaseParameters),
      1e-15,
    );
  }
  const parameters = {
    startSeconds: 1,
    endSeconds: 3,
    rateStartHz: 5,
    rateEndHz: 5,
    depthStartSemitone: 0.1,
    depthEndSemitone: 0.3,
    phaseRad: Math.PI / 2,
    fadeInSeconds: 0.2,
    fadeOutSeconds: 0.2,
  };
  assert.equal(timeVaryingVibrato(1, parameters), 0);
  assertClose(timeVaryingVibrato(1.2, parameters), 0.12, 2e-14);
  assert.equal(timeVaryingVibrato(3, parameters), 0);
});

test("vibrato has zero-input identity and exact fixed-rate zero crossings", () => {
  const common = {
    startSeconds: 0,
    endSeconds: 2,
    rateStartHz: 5,
    rateEndHz: 5,
    centerStartSemitone: 0,
    centerEndSemitone: 0,
    phaseRad: 0,
    fadeInSeconds: 0.1,
    fadeOutSeconds: 0.1,
  };
  const zero = {
    ...common,
    depthStartSemitone: 0,
    depthEndSemitone: 0,
  };
  for (let index = 0; index <= 40; index++) {
    assert.equal(timeVaryingVibrato(index / 20, zero), 0);
  }
  const oscillating = {
    ...common,
    depthStartSemitone: 0.2,
    depthEndSemitone: 0.2,
  };
  for (let crossing = 1; crossing < 20; crossing++) {
    assertClose(
      timeVaryingVibrato(crossing / 10, oscillating),
      0,
      2e-15,
      `fixed-rate zero crossing ${crossing} drifted`,
    );
  }
});

test("vibrato shares its normalized fades with center drift", () => {
  assertClose(
    timeVaryingVibrato(0.5, {
      startSeconds: 0,
      endSeconds: 1,
      rateStartHz: 1,
      rateEndHz: 1,
      depthStartSemitone: 0.2,
      depthEndSemitone: 0.2,
      phaseRad: Math.PI / 2,
      fadeInSeconds: 0.8,
      fadeOutSeconds: 0.8,
    }),
    -0.2,
    2e-14,
  );
  const parameters = {
    startSeconds: 0,
    endSeconds: 1,
    rateStartHz: 5,
    rateEndHz: 5,
    depthStartSemitone: 0.1,
    depthEndSemitone: 0.1,
    centerStartSemitone: 0,
    centerEndSemitone: 0.5,
    fadeInSeconds: 0.2,
    fadeOutSeconds: 0.2,
  };
  assert.equal(timeVaryingVibrato(0, parameters), 0);
  assert.equal(timeVaryingVibrato(1, parameters), 0);
  assert.notEqual(timeVaryingVibrato(0.5, parameters), 0);
  assert.throws(
    () => timeVaryingVibrato(0.5, { ...parameters, fadeInSeconds: 0 }),
    /fadeInSeconds must be > 0/,
  );
  assert.throws(
    () => timeVaryingVibrato(0.5, { ...parameters, fadeOutSeconds: 0 }),
    /fadeOutSeconds must be > 0/,
  );
});

test("vibrato returns finite values or structured numeric failures", () => {
  const common = {
    startSeconds: 0,
    endSeconds: 1,
    rateStartHz: 1,
    rateEndHz: 1,
    depthStartSemitone: 0.2,
    depthEndSemitone: 0.2,
    phaseRad: -Math.PI / 2,
  };
  assertClose(timeVaryingVibrato(0.5, {
    ...common,
    fadeInSeconds: Number.MAX_VALUE,
    fadeOutSeconds: Number.MAX_VALUE,
  }), 0.2, 2e-14);
  assert.throws(
    () => timeVaryingVibrato(0, {
      ...common,
      startSeconds: -Number.MAX_VALUE,
      endSeconds: Number.MAX_VALUE,
    }),
    (error) => error.code === "VIBRATO_SPAN_OVERFLOW",
  );
  assert.throws(
    () => timeVaryingVibrato(0.5, {
      ...common,
      fadeInSeconds: Number.MIN_VALUE,
      fadeOutSeconds: Number.MAX_VALUE,
    }),
    (error) => error.code === "VIBRATO_FADE_RESOLUTION_OVERFLOW",
  );
  assert.throws(
    () => integratedLinearFrequencyPhase(Number.MAX_VALUE, {
      durationSeconds: Number.MAX_VALUE,
      rateStartHz: Number.MAX_VALUE,
      rateEndHz: Number.MAX_VALUE,
    }),
    (error) => error.code === "OSCILLATORY_PHASE_OVERFLOW",
  );
  assert.throws(
    () => timeVaryingVibrato(0.5, {
      ...common,
      centerStartSemitone: Number.MAX_VALUE,
      centerEndSemitone: Number.MAX_VALUE,
      depthStartSemitone: Number.MAX_VALUE,
      depthEndSemitone: Number.MAX_VALUE,
      fadeInSeconds: 0.1,
      fadeOutSeconds: 0.1,
    }),
    (error) => error.code === "VIBRATO_OUTPUT_OVERFLOW",
  );
});

test("time-varying vibrato stays finite across seeded legal inputs", () => {
  const random = seededRandom(0x7337_2026);
  for (let trial = 0; trial < 1200; trial++) {
    const startSeconds = -0.5 + random();
    const durationSeconds = 0.01 + random() * 1.99;
    const parameters = {
      startSeconds,
      endSeconds: startSeconds + durationSeconds,
      rateStartHz: 4 + random() * 5,
      rateEndHz: 4 + random() * 5,
      depthStartSemitone: -0.4 + random() * 0.8,
      depthEndSemitone: -0.4 + random() * 0.8,
      centerStartSemitone: -0.2 + random() * 0.4,
      centerEndSemitone: -0.2 + random() * 0.4,
      phaseRad: -Math.PI + random() * 2 * Math.PI,
      fadeInSeconds: 0.001 + random() * durationSeconds,
      fadeOutSeconds: 0.001 + random() * durationSeconds,
    };
    assert.equal(timeVaryingVibrato(parameters.startSeconds, parameters), 0);
    assert.equal(timeVaryingVibrato(parameters.endSeconds, parameters), 0);
    for (let sample = 1; sample < 10; sample++) {
      const value = timeVaryingVibrato(
        parameters.startSeconds + durationSeconds * sample / 10,
        parameters,
      );
      assert.equal(Number.isFinite(value), true);
    }
  }
});

test("vibrato production model replays the concentrated corpus cases", () => {
  const { corpus } = loadPitchTechniqueCorpus();
  for (const current of corpus.cases.filter((entry) => entry.family === "time_varying_vibrato")) {
    for (let index = 0; index < current.sampleSeconds.length; index++) {
      assertClose(
        timeVaryingVibrato(current.sampleSeconds[index], current.input),
        current.denseTruth.values[index],
        current.tolerance.absolute,
        current.id,
      );
    }
  }
});

test("production vibrato matches the reference model and meets the p95 budget", () => {
  const parameters = {
    startSeconds: 0,
    endSeconds: 1,
    rateStartHz: 9,
    rateEndHz: 4,
    depthStartSemitone: 0.3,
    depthEndSemitone: 0.1,
    centerStartSemitone: 0.03,
    centerEndSemitone: -0.02,
    phaseRad: -0.4,
    fadeInSeconds: 0.2,
    fadeOutSeconds: 0.3,
  };
  for (const timeSeconds of [0, 0.2, 0.5, 0.8, 1]) {
    assertClose(
      timeVaryingVibrato(timeSeconds, parameters),
      referenceTimeVaryingVibrato(timeSeconds, parameters),
      1e-15,
    );
  }
  for (let index = 0; index < 10_000; index++) {
    timeVaryingVibrato(index / 10_000, parameters);
  }
  const durations = [];
  for (let run = 0; run < 20; run++) {
    const startedAt = performance.now();
    for (let index = 0; index < 10_000; index++) {
      timeVaryingVibrato(index / 10_000, parameters);
    }
    durations.push(performance.now() - startedAt);
  }
  durations.sort((left, right) => left - right);
  const p95 = durations[Math.ceil(durations.length * 0.95) - 1];
  assert.ok(p95 <= 20, `vibrato 10000-sample p95 exceeded 20 ms: ${p95}`);
});
