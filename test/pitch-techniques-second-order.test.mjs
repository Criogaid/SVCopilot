import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  compileFirstPeakTransient,
  firstPeakAngularFactor as referenceFirstPeakAngularFactor,
  secondOrderImpulse as referenceSecondOrderImpulse,
  secondOrderImpulseDerivative as referenceSecondOrderImpulseDerivative,
  TRANSIENT_TAPER_RATIO as referenceTransientTaperRatio,
} from "../docs/pitch-techniques/reference/model.mjs";
import {
  firstPeakAngularFactor,
  secondOrderImpulse,
  secondOrderImpulseDerivative,
  transientFromFirstPeak,
  TRANSIENT_TAPER_RATIO,
} from "../server/src/pitch-techniques/second-order.js";
import { loadPitchTechniqueCorpus } from "./helpers/pitch-technique-corpus.mjs";

function assertClose(actual, expected, tolerance, message = "values differ") {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message}: actual=${actual}, expected=${expected}, tolerance=${tolerance}`,
  );
}

test("second-order production module only depends on the concentrated reference model", () => {
  const sourcePath = fileURLToPath(
    new URL("../server/src/pitch-techniques/second-order.js", import.meta.url),
  );
  const source = readFileSync(sourcePath, "utf8");
  assert.match(source, /docs\/pitch-techniques\/reference\/model\.mjs/);
  assert.doesNotMatch(source, /artifact-store|host-|mcp|process\.env|session|store/i);
  assert.doesNotMatch(source, /naturalHz|\bgain\b/);
  assert.equal(TRANSIENT_TAPER_RATIO, referenceTransientTaperRatio);
});

test("second-order impulse preserves all damping branches and onset translation", () => {
  const timeSeconds = 0.083;
  const onsetSeconds = 0.37;
  for (const dampingRatio of [0, 0.6, 1, 1.8]) {
    const parameters = {
      naturalAngularFrequencyRadPerSecond: 31,
      dampingRatio,
      numeratorRatePerSecond: 2.7,
    };
    assertClose(
      secondOrderImpulse(timeSeconds, parameters),
      referenceSecondOrderImpulse(timeSeconds, parameters),
      1e-15,
    );
    assertClose(
      secondOrderImpulseDerivative(timeSeconds, parameters),
      referenceSecondOrderImpulseDerivative(timeSeconds, parameters),
      2e-14,
    );
    const shifted = { ...parameters, onsetSeconds };
    assert.equal(secondOrderImpulse(onsetSeconds - 1e-9, shifted), 0);
    assert.equal(secondOrderImpulseDerivative(onsetSeconds - 1e-9, shifted), 0);
    assertClose(
      secondOrderImpulse(onsetSeconds + timeSeconds, shifted),
      secondOrderImpulse(timeSeconds, parameters),
      1e-15,
    );
    assertClose(
      secondOrderImpulseDerivative(onsetSeconds + timeSeconds, shifted),
      secondOrderImpulseDerivative(timeSeconds, parameters),
      2e-14,
    );
  }
});

test("second-order impulse remains stable at critical and finite extremes", () => {
  const critical = {
    naturalAngularFrequencyRadPerSecond: 34.8,
    dampingRatio: 1,
    numeratorRatePerSecond: 34.8,
  };
  for (const timeSeconds of [0, 0.01, 0.05, 0.2]) {
    const expectedValue = secondOrderImpulse(timeSeconds, critical);
    const expectedDerivative = secondOrderImpulseDerivative(timeSeconds, critical);
    for (const dampingRatio of [1 - 1e-12, 1 + 1e-12]) {
      const near = { ...critical, dampingRatio };
      assertClose(secondOrderImpulse(timeSeconds, near), expectedValue, 2e-12);
      assertClose(secondOrderImpulseDerivative(timeSeconds, near), expectedDerivative, 2e-10);
    }
  }
  for (const dampingRatio of [1e155, Number.MAX_VALUE]) {
    const parameters = {
      naturalAngularFrequencyRadPerSecond: 1,
      dampingRatio,
      numeratorRatePerSecond: 1,
    };
    assert.equal(Number.isFinite(secondOrderImpulse(0.25, parameters)), true);
    assert.equal(Number.isFinite(secondOrderImpulseDerivative(0.25, parameters)), true);
    assert.equal(Number.isFinite(firstPeakAngularFactor(dampingRatio)), true);
  }
  const undamped = {
    naturalAngularFrequencyRadPerSecond: Number.MAX_VALUE,
    dampingRatio: 0,
    numeratorRatePerSecond: 1,
  };
  for (const evaluate of [secondOrderImpulse, secondOrderImpulseDerivative]) {
    assert.throws(
      () => evaluate(Number.MAX_VALUE, undamped),
      (error) => error.code === "OSCILLATORY_PHASE_OVERFLOW",
    );
    assert.equal(evaluate(Number.MAX_VALUE, { ...undamped, numeratorRatePerSecond: 0 }), 0);
  }
});

test("first-peak transient preserves angular units and peak time", () => {
  const dampingRatio = 0.5422;
  const peakTimeSeconds = 0.065;
  assertClose(
    firstPeakAngularFactor(dampingRatio),
    referenceFirstPeakAngularFactor(dampingRatio),
    1e-15,
  );
  assertClose(
    firstPeakAngularFactor(dampingRatio) / 34.8,
    0.03412174777505054,
    1e-16,
  );
  const compiled = transientFromFirstPeak({
    peakSemitone: 0.37,
    peakTimeSeconds,
    dampingRatio,
    onsetSeconds: 0.4,
    spanSeconds: 0.6,
    tailPolicy: "continuous_taper",
  });
  assert.equal(compiled.valueAt(0.4 - 1e-9), 0);
  assertClose(compiled.valueAt(0.4 + peakTimeSeconds), 0.37, 2e-14);
  assert.equal(compiled.valueAt(1 + 1e-9), 0);
  assertClose(
    compiled.modelParameters.naturalAngularFrequencyRadPerSecond * peakTimeSeconds,
    firstPeakAngularFactor(dampingRatio),
    2e-14,
  );
  const vibratoPeak = secondOrderImpulse(Math.PI / (2 * 34.5), {
    naturalAngularFrequencyRadPerSecond: 34.5,
    dampingRatio: 0,
    numeratorRatePerSecond: 1.8,
  });
  assertClose(vibratoPeak, 0.05217391304347826, 1e-15);
});

test("first-peak transient distinguishes product-range and tail-policy failures", () => {
  assert.throws(
    () => transientFromFirstPeak({
      peakSemitone: 0.37,
      peakTimeSeconds: 0.065,
      dampingRatio: 1.01,
      spanSeconds: 0.6,
      tailPolicy: "continuous_taper",
    }),
    (error) => error.code === "DAMPING_RATIO_OUT_OF_V1_RANGE"
      && /v1 public transient range/.test(error.message)
      && error.details.dampingRatio === 1.01,
  );
  assert.throws(
    () => transientFromFirstPeak({
      peakSemitone: 0.4,
      peakTimeSeconds: 0.06,
      dampingRatio: 0,
      spanSeconds: 0.5,
      tailPolicy: "reject",
    }),
    (error) => error.code === "UNDAMPED_TAIL_REQUIRES_TAPER"
      && error.details.tailPolicy === "reject",
  );
  assert.throws(
    () => transientFromFirstPeak({
      peakSemitone: 0.4,
      peakTimeSeconds: 0.08,
      dampingRatio: 0.5,
      spanSeconds: 0.1,
      tailPolicy: "continuous_taper",
    }),
    (error) => error.code === "TAPER_OVERLAPS_PEAK",
  );
  assert.throws(
    () => transientFromFirstPeak({
      peakSemitone: 0.4,
      peakTimeSeconds: 0.06,
      dampingRatio: 0.5,
      spanSeconds: 0.1,
      tailPolicy: "reject",
    }),
    (error) => error.code === "TAIL_NOT_SETTLED"
      && Number.isFinite(error.details.observedTailSlopeSemitonePerSecond),
  );
});

test("continuous taper is C1 and does not amplify a first-peak transient", () => {
  const compiled = transientFromFirstPeak({
    peakSemitone: -0.28,
    peakTimeSeconds: 0.08,
    dampingRatio: 0.6681,
    spanSeconds: 0.45,
    tailPolicy: "continuous_taper",
  });
  const step = 1e-6;
  const taperStart = compiled.taper.startSeconds;
  assertClose(compiled.valueAt(taperStart - step), compiled.valueAt(taperStart + step), 2e-5);
  const leftSlope = (compiled.valueAt(taperStart) - compiled.valueAt(taperStart - step)) / step;
  const rightSlope = (compiled.valueAt(taperStart + step) - compiled.valueAt(taperStart)) / step;
  assertClose(leftSlope, rightSlope, 2e-3);
  assert.equal(compiled.valueAt(compiled.spanSeconds), 0);
  const endSlope = (
    compiled.valueAt(compiled.spanSeconds)
    - compiled.valueAt(compiled.spanSeconds - step)
  ) / step;
  assertClose(endSlope, 0, 2e-3);
  for (const dampingRatio of [0, 0.1, 0.3, 0.5422, 0.6681, 0.9, 1]) {
    const candidate = transientFromFirstPeak({
      peakSemitone: -0.42,
      peakTimeSeconds: 0.2,
      dampingRatio,
      spanSeconds: 1,
      tailPolicy: "continuous_taper",
    });
    let observedMaximum = 0;
    for (let index = 0; index <= 500; index++) {
      observedMaximum = Math.max(observedMaximum, Math.abs(candidate.valueAt(index / 500)));
    }
    assert.ok(observedMaximum <= 0.42 + 1e-12);
  }
});

test("second-order production model replays the concentrated corpus cases", () => {
  const { corpus } = loadPitchTechniqueCorpus();
  for (const current of corpus.cases.filter((entry) => (
    entry.family === "first_peak_transient" || entry.family === "second_order_impulse"
  ))) {
    if (current.expectedError) {
      assert.throws(
        () => transientFromFirstPeak(current.input),
        (error) => error.code === current.expectedError.code,
        current.id,
      );
      continue;
    }
    const valueAt = current.family === "first_peak_transient"
      ? transientFromFirstPeak(current.input).valueAt
      : (timeSeconds) => secondOrderImpulse(timeSeconds, current.input);
    for (let index = 0; index < current.sampleSeconds.length; index++) {
      assertClose(
        valueAt(current.sampleSeconds[index]),
        current.denseTruth.values[index],
        current.tolerance.absolute,
        current.id,
      );
    }
  }
});

test("first-peak production wrapper preserves the reference implementation", () => {
  const parameters = {
    peakSemitone: 0.37,
    peakTimeSeconds: 0.065,
    dampingRatio: 0.5422,
    onsetSeconds: 0.4,
    spanSeconds: 0.6,
    tailPolicy: "continuous_taper",
  };
  const actual = transientFromFirstPeak(parameters);
  const expected = compileFirstPeakTransient(parameters);
  assert.deepEqual(actual.modelParameters, expected.modelParameters);
  assert.deepEqual(actual.tailLimits, expected.tailLimits);
  assert.deepEqual(actual.taper, expected.taper);
  for (const timeSeconds of [0.3, 0.4, 0.465, 0.85, 1]) {
    assertClose(actual.valueAt(timeSeconds), expected.valueAt(timeSeconds), 1e-15);
  }
});
