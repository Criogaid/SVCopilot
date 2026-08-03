import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import {
  avaGeneralizedLogistic,
  avaInflectionSeconds,
  avaRichardsUnitAtInflection,
  buildCorrectionTargetCent,
  CANONICAL_PHASE_LIMIT_RAD,
  canonicalizeTechniques,
  compileFirstPeakTransient,
  compilePitchDeltaTransition,
  firstPeakAngularFactor,
  integratedLinearFrequencyPhase,
  normalizedRichardsSegment,
  normalizedRichardsTransition,
  PITCH_DELTA_LIMIT_CENT,
  projectTransitionMandatoryBlickAnchors,
  secondOrderImpulse,
  secondOrderImpulseDerivative,
  SEMANTIC_NUMERIC_QUANTA,
  solveOpenLoopCorrection,
  splitFiniteRuns,
  TECHNIQUE_IR_NUMERIC_FIELD_SCHEMA,
  TRANSIENT_TAPER_RATIO,
  timeVaryingVibrato,
} from "./model.mjs";

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

test("AVA generalized logistic matches the published equation and inflection", () => {
  const parameters = {
    lowerPitch: 60,
    upperPitch: 67,
    A: 2.4,
    B: 0.65,
    growthPerSecond: 9.5,
    midpointSeconds: 0.13,
  };
  const timeSeconds = 0.27;
  const direct = parameters.lowerPitch + (
    parameters.upperPitch - parameters.lowerPitch
  ) / (
    1 + parameters.A * Math.exp(
      -parameters.growthPerSecond * (timeSeconds - parameters.midpointSeconds),
    )
  ) ** (1 / parameters.B);
  assertClose(avaGeneralizedLogistic(timeSeconds, parameters), direct, 1e-13);

  const inflection = avaInflectionSeconds(parameters);
  const step = 1e-4;
  const secondDerivative = (
    avaGeneralizedLogistic(inflection + step, parameters)
    - 2 * avaGeneralizedLogistic(inflection, parameters)
    + avaGeneralizedLogistic(inflection - step, parameters)
  ) / step ** 2;
  assertClose(secondDerivative, 0, 2e-5, "published inflection must have zero curvature");
});

test("AVA inflection remains finite for extreme positive finite ratios", () => {
  const expectedMagnitude = Math.log(Number.MAX_VALUE) - Math.log(Number.MIN_VALUE);
  const positive = avaInflectionSeconds({
    A: Number.MAX_VALUE,
    B: Number.MIN_VALUE,
    growthPerSecond: 1,
    midpointSeconds: 0,
  });
  const negative = avaInflectionSeconds({
    A: Number.MIN_VALUE,
    B: Number.MAX_VALUE,
    growthPerSecond: 1,
    midpointSeconds: 0,
  });
  assert.equal(Number.isFinite(positive), true);
  assert.equal(Number.isFinite(negative), true);
  assertClose(positive, expectedMagnitude, 1e-12);
  assertClose(negative, -expectedMagnitude, 1e-12);
});

test("AVA evaluation avoids endpoint subtraction overflow", () => {
  const parameters = {
    lowerPitch: -Number.MAX_VALUE,
    upperPitch: Number.MAX_VALUE,
    A: 1,
    B: 1,
    growthPerSecond: 1,
    midpointSeconds: 0,
  };
  assert.equal(avaGeneralizedLogistic(0, parameters), 0);
  assert.equal(avaGeneralizedLogistic(-Number.MAX_VALUE, parameters), -Number.MAX_VALUE);
  assert.equal(avaGeneralizedLogistic(Number.MAX_VALUE, parameters), Number.MAX_VALUE);
  assert.throws(
    () => avaInflectionSeconds({
      A: Number.MAX_VALUE,
      B: Number.MIN_VALUE,
      growthPerSecond: Number.MIN_VALUE,
      midpointSeconds: 0,
    }),
    (error) => error.code === "RICHARDS_INFLECTION_OVERFLOW",
  );
});

test("inflection-parameterized Richards is algebraically identical to AVA", () => {
  const inflectionSeconds = 0.41;
  const growthPerSecond = 8.2;
  const asymmetryB = 1.7;
  const midpointSeconds = 0;
  const A = asymmetryB * Math.exp(growthPerSecond * inflectionSeconds);
  for (const timeSeconds of [-0.2, 0, 0.41, 0.9]) {
    const exact = avaGeneralizedLogistic(timeSeconds, {
      lowerPitch: 0,
      upperPitch: 1,
      A,
      B: asymmetryB,
      growthPerSecond,
      midpointSeconds,
    });
    const reparameterized = avaRichardsUnitAtInflection(timeSeconds, {
      inflectionSeconds,
      growthPerSecond,
      asymmetryB,
    });
    assertClose(reparameterized, exact, 2e-15);
  }
});

test("finite Richards segment reaches exact endpoints for many shapes", () => {
  for (const asymmetryB of [0.25, 0.5, 1, 2, 4]) {
    for (const inflectionRatio of [0.2, 0.5, 0.8]) {
      const parameters = {
        spanSeconds: 0.73,
        inflectionSeconds: 0.73 * inflectionRatio,
        growthPerSecond: 11,
        asymmetryB,
      };
      assert.equal(normalizedRichardsSegment(0, parameters), 0);
      assert.equal(normalizedRichardsSegment(parameters.spanSeconds, parameters), 1);
      let previous = -Infinity;
      for (let index = 0; index <= 200; index++) {
        const value = normalizedRichardsSegment(
          parameters.spanSeconds * index / 200,
          parameters,
        );
        assert.ok(value >= previous - 1e-14);
        previous = value;
      }
    }
  }
});

test("finite Richards transition compiles exact upward and downward endpoints", () => {
  const common = {
    spanSeconds: 0.73,
    inflectionSeconds: 0.39,
    growthPerSecond: 11,
    asymmetryB: 1.7,
  };
  for (const [fromPitch, toPitch, direction] of [
    [60, 64, 1],
    [64, 60, -1],
    [-Number.MAX_VALUE, Number.MAX_VALUE, 1],
  ]) {
    assert.equal(normalizedRichardsTransition(0, fromPitch, toPitch, common), fromPitch);
    assert.equal(
      normalizedRichardsTransition(common.spanSeconds, fromPitch, toPitch, common),
      toPitch,
    );
    let previous = fromPitch;
    for (let index = 1; index < 20; index++) {
      const value = normalizedRichardsTransition(
        common.spanSeconds * index / 20,
        fromPitch,
        toPitch,
        common,
      );
      assert.equal(Number.isFinite(value), true);
      assert.ok(direction * (value - previous) >= 0);
      previous = value;
    }
  }
});

test("pitchDelta transition cancels the score step for upward and downward intervals", () => {
  for (const [fromPitch, toPitch] of [[60, 67], [67, 59]]) {
    for (const curve of [
      { family: "linear" },
      {
        family: "richards",
        inflectionRatio: 0.58,
        sharpness: 8,
        asymmetryLogB: 0.3,
      },
    ]) {
      const compiled = compilePitchDeltaTransition({
        fromNote: {
          indexInGroup: 4,
          onsetBlick: 0,
          durationBlick: 1000,
          onsetSeconds: 0,
          endSeconds: 1,
          pitchSemitone: fromPitch,
        },
        toNote: {
          indexInGroup: 5,
          onsetBlick: 1000,
          durationBlick: 1000,
          onsetSeconds: 1,
          endSeconds: 2,
          pitchSemitone: toPitch,
        },
        widthSeconds: 0.4,
        curve,
      });

      assert.equal(compiled.contributionCentAt(compiled.fromSeconds), 0);
      assert.equal(compiled.contributionCentAt(compiled.toSeconds), 0);
      assertClose(
        fromPitch + compiled.beforeBoundaryContributionCent / 100,
        toPitch + compiled.atBoundaryContributionCent / 100,
        1e-12,
        "boundary absolute pitch must be continuous",
      );
      assertClose(
        compiled.atBoundaryContributionCent - compiled.beforeBoundaryContributionCent,
        -100 * (toPitch - fromPitch),
        1e-12,
        "pitchDelta jump must cancel the score step",
      );
      assert.deepEqual(
        compiled.mandatoryAnchors.map((anchor) => anchor.boundarySide),
        ["at", "before", "at", "at"],
      );

      const samples = Array.from({ length: 101 }, (_, index) => (
        compiled.desiredPitchAt(compiled.fromSeconds + compiled.widthSeconds * index / 100)
      ));
      const direction = Math.sign(toPitch - fromPitch);
      for (let index = 1; index < samples.length; index++) {
        assert.ok(direction * (samples[index] - samples[index - 1]) >= -1e-12);
      }
    }
  }
});

test("pitchDelta transition satisfies 600 seeded score-step composition cases", () => {
  const random = seededRandom(0x504f5254);
  for (let trial = 0; trial < 600; trial++) {
    const fromPitch = 40 + random() * 40;
    const direction = random() < 0.5 ? -1 : 1;
    const interval = direction * (0.1 + random() * 10.9);
    const toPitch = fromPitch + interval;
    const widthSeconds = 0.01 + random() * 1.99;
    const curve = trial % 2 === 0
      ? { family: "linear" }
      : {
          family: "richards",
          inflectionRatio: 0.05 + random() * 0.9,
          sharpness: 1 + random() * 39,
          asymmetryLogB: -3 + random() * 6,
        };
    const compiled = compilePitchDeltaTransition({
      fromNote: {
        indexInGroup: 0,
        onsetBlick: 0,
        durationBlick: 10_000,
        onsetSeconds: 0,
        endSeconds: 5,
        pitchSemitone: fromPitch,
      },
      toNote: {
        indexInGroup: 1,
        onsetBlick: 10_000,
        durationBlick: 10_000,
        onsetSeconds: 5,
        endSeconds: 10,
        pitchSemitone: toPitch,
      },
      widthSeconds,
      curve,
    });
    assertClose(compiled.contributionCentAt(compiled.fromSeconds), 0, 1e-10);
    assertClose(compiled.contributionCentAt(compiled.toSeconds), 0, 1e-10);
    assertClose(
      fromPitch + compiled.beforeBoundaryContributionCent / 100,
      toPitch + compiled.atBoundaryContributionCent / 100,
      2e-13,
    );
    assertClose(
      compiled.atBoundaryContributionCent - compiled.beforeBoundaryContributionCent,
      -100 * interval,
      2e-11,
    );
    let previous = compiled.desiredPitchAt(compiled.fromSeconds);
    for (let sample = 1; sample <= 20; sample++) {
      const current = compiled.desiredPitchAt(
        compiled.fromSeconds + widthSeconds * sample / 20,
      );
      assert.ok(direction * (current - previous) >= -2e-13);
      previous = current;
    }
  }
});

test("pitchDelta transition rejects rests, short notes, and unrepresentable intervals", () => {
  const fromNote = {
    indexInGroup: 0,
    onsetBlick: 0,
    durationBlick: 1000,
    onsetSeconds: 0,
    endSeconds: 1,
    pitchSemitone: 60,
  };
  const toNote = {
    indexInGroup: 1,
    onsetBlick: 1000,
    durationBlick: 1000,
    onsetSeconds: 1,
    endSeconds: 2,
    pitchSemitone: 64,
  };
  const base = { fromNote, toNote, widthSeconds: 0.4, curve: { family: "linear" } };

  assert.throws(
    () => compilePitchDeltaTransition({
      ...base,
      toNote: { ...toNote, onsetBlick: 1001 },
    }),
    (error) => error.code === "TRANSITION_NOT_ADJACENT"
      && error.details.fromEndBlick === 1000
      && error.details.toOnsetBlick === 1001,
  );
  assert.throws(
    () => compilePitchDeltaTransition({
      ...base,
      toNote: { ...toNote, onsetSeconds: 1.000001 },
    }),
    (error) => error.code === "TRANSITION_TIME_MAPPING_INCONSISTENT"
      && error.details.boundarySkewSeconds > error.details.toleranceSeconds,
  );
  assert.throws(
    () => compilePitchDeltaTransition({
      ...base,
      toNote: { ...toNote, pitchSemitone: fromNote.pitchSemitone },
    }),
    (error) => error.code === "TRANSITION_EQUAL_PITCH"
      && error.details.pitchSemitone === fromNote.pitchSemitone,
  );
  assert.throws(
    () => compilePitchDeltaTransition({
      ...base,
      curve: { family: "unknown" },
    }),
    (error) => error.code === "INVALID_ARGUMENTS"
      && error.details.parameter === "curve.family"
      && error.details.value === "unknown",
  );
  assert.throws(
    () => compilePitchDeltaTransition({
      ...base,
      fromNote: { ...fromNote, onsetSeconds: 0.9 },
      widthSeconds: 0.4,
    }),
    (error) => error.code === "TRANSITION_WIDTH_EXCEEDS_ADJACENT_NOTES"
      && error.details.requiredPerSideSeconds === 0.2,
  );
  assert.throws(
    () => compilePitchDeltaTransition({
      ...base,
      toNote: { ...toNote, pitchSemitone: 90 },
    }),
    (error) => error.code === "TRANSITION_EXCEEDS_PITCH_DELTA_RANGE"
      && error.details.requiredAbsPitchDeltaCent > PITCH_DELTA_LIMIT_CENT,
  );
});

test("transition BLICK projection preserves distinct boundary-side anchors", () => {
  assert.deepEqual(
    projectTransitionMandatoryBlickAnchors({
      spanFromBlick: 800,
      boundaryBlick: 1000,
      spanToBlick: 1200,
    }),
    [
      { role: "start", blick: 800 },
      { role: "boundary_before", blick: 999 },
      { role: "boundary_at", blick: 1000 },
      { role: "end", blick: 1200 },
    ],
  );
  for (const range of [
    { spanFromBlick: 999, boundaryBlick: 1000, spanToBlick: 1200 },
    { spanFromBlick: 800, boundaryBlick: 1000, spanToBlick: 1000 },
  ]) {
    assert.throws(
      () => projectTransitionMandatoryBlickAnchors(range),
      (error) => error.code === "TRANSITION_TIME_RESOLUTION_TOO_COARSE"
        && error.details.boundaryBlick === 1000,
    );
  }
});

test("finite Richards normalization preserves the raw inflection time", () => {
  for (const asymmetryB of [0.35, 1, 3]) {
    const parameters = {
      spanSeconds: 0.8,
      inflectionSeconds: 0.46,
      growthPerSecond: 9,
      asymmetryB,
    };
    const step = 1e-4;
    const secondDerivative = (
      normalizedRichardsSegment(parameters.inflectionSeconds + step, parameters)
      - 2 * normalizedRichardsSegment(parameters.inflectionSeconds, parameters)
      + normalizedRichardsSegment(parameters.inflectionSeconds - step, parameters)
    ) / step ** 2;
    assertClose(secondDerivative, 0, 3e-5);
  }
});

test("zero Richards asymmetry is symmetric around the midpoint", () => {
  const parameters = {
    spanSeconds: 0.8,
    inflectionSeconds: 0.4,
    growthPerSecond: 10,
    asymmetryB: 1,
  };
  for (let index = 0; index <= 40; index++) {
    const timeSeconds = parameters.spanSeconds * index / 40;
    const mirrored = normalizedRichardsSegment(
      parameters.spanSeconds - timeSeconds,
      parameters,
    );
    assertClose(
      normalizedRichardsSegment(timeSeconds, parameters) + mirrored,
      1,
      2e-15,
    );
  }
});

test("finite Richards segment satisfies 1200 seeded public-domain property cases", () => {
  const random = seededRandom(0xa7a2_2016);
  for (let trial = 0; trial < 1200; trial++) {
    const spanSeconds = 0.01 + random() * 1.99;
    const inflectionRatio = 0.05 + random() * 0.9;
    const sharpness = 1 + random() * 39;
    const parameters = {
      spanSeconds,
      inflectionSeconds: spanSeconds * inflectionRatio,
      growthPerSecond: sharpness / spanSeconds,
      asymmetryB: Math.exp(-3 + random() * 6),
    };
    assert.equal(normalizedRichardsSegment(0, parameters), 0);
    assert.equal(normalizedRichardsSegment(spanSeconds, parameters), 1);
    let previous = 0;
    for (let sample = 1; sample < 10; sample++) {
      const value = normalizedRichardsSegment(spanSeconds * sample / 10, parameters);
      assert.equal(Number.isFinite(value), true);
      assert.ok(value >= previous - 1e-12 && value <= 1 + 1e-12);
      previous = value;
    }
  }
});

test("finite Richards segment rejects a numerically degenerate interval", () => {
  assert.throws(() => normalizedRichardsSegment(0.5, {
    spanSeconds: 1,
    inflectionSeconds: 0.5,
    growthPerSecond: Number.MIN_VALUE,
    asymmetryB: 1,
  }), (error) => (
    error.code === "RICHARDS_DEGENERATE_SEGMENT"
    && /numerically degenerate/.test(error.message)
  ));
});

test("finite Richards 10000-sample generation stays within the recorded p95 budget", () => {
  const parameters = {
    spanSeconds: 1,
    inflectionSeconds: 0.58,
    growthPerSecond: 8,
    asymmetryB: 1.35,
  };
  for (let index = 0; index < 10_000; index++) {
    normalizedRichardsSegment(index / 10_000, parameters);
  }
  const durations = [];
  for (let run = 0; run < 20; run++) {
    const startedAt = performance.now();
    for (let index = 0; index < 10_000; index++) {
      normalizedRichardsSegment(index / 10_000, parameters);
    }
    durations.push(performance.now() - startedAt);
  }
  durations.sort((left, right) => left - right);
  const p95 = durations[Math.ceil(durations.length * 0.95) - 1];
  assert.ok(p95 <= 20, `Richards 10000-sample p95 exceeded 20 ms: ${p95}`);
});

test("Saitou second-order response implements all damping branches", () => {
  const timeSeconds = 0.083;
  const omega = 31;
  const numerator = 2.7;

  const noLoss = secondOrderImpulse(timeSeconds, {
    naturalAngularFrequencyRadPerSecond: omega,
    dampingRatio: 0,
    numeratorRatePerSecond: numerator,
  });
  assertClose(noLoss, numerator / omega * Math.sin(omega * timeSeconds), 1e-15);

  const zetaUnder = 0.6;
  const rootUnder = Math.sqrt(1 - zetaUnder ** 2);
  const under = numerator / (omega * rootUnder)
    * Math.exp(-zetaUnder * omega * timeSeconds)
    * Math.sin(omega * rootUnder * timeSeconds);
  assertClose(secondOrderImpulse(timeSeconds, {
    naturalAngularFrequencyRadPerSecond: omega,
    dampingRatio: zetaUnder,
    numeratorRatePerSecond: numerator,
  }), under, 1e-15);

  const critical = numerator * timeSeconds * Math.exp(-omega * timeSeconds);
  assertClose(secondOrderImpulse(timeSeconds, {
    naturalAngularFrequencyRadPerSecond: omega,
    dampingRatio: 1,
    numeratorRatePerSecond: numerator,
  }), critical, 1e-15);

  const zetaOver = 1.8;
  const rootOver = Math.sqrt(zetaOver ** 2 - 1);
  const over = numerator / (2 * omega * rootOver) * (
    Math.exp((-zetaOver + rootOver) * omega * timeSeconds)
    - Math.exp((-zetaOver - rootOver) * omega * timeSeconds)
  );
  assertClose(secondOrderImpulse(timeSeconds, {
    naturalAngularFrequencyRadPerSecond: omega,
    dampingRatio: zetaOver,
    numeratorRatePerSecond: numerator,
  }), over, 1e-15);
});

test("Saitou response rejects damping outside the paper's nonnegative domain", () => {
  assert.throws(() => secondOrderImpulse(0.1, {
    naturalAngularFrequencyRadPerSecond: 34.8,
    dampingRatio: -0.1,
    numeratorRatePerSecond: 34.8,
  }), /dampingRatio must be >= 0/);
});

test("second-order onset is an exact time translation in every damping branch", () => {
  const onsetSeconds = 0.37;
  const localSeconds = 0.083;
  for (const dampingRatio of [0, 0.6, 1, 1.8]) {
    const base = {
      naturalAngularFrequencyRadPerSecond: 31,
      dampingRatio,
      numeratorRatePerSecond: 2.7,
    };
    const shifted = { ...base, onsetSeconds };
    assert.equal(secondOrderImpulse(onsetSeconds - 1e-9, shifted), 0);
    assert.equal(secondOrderImpulseDerivative(onsetSeconds - 1e-9, shifted), 0);
    assertClose(
      secondOrderImpulse(onsetSeconds + localSeconds, shifted),
      secondOrderImpulse(localSeconds, base),
      1e-15,
    );
    assertClose(
      secondOrderImpulseDerivative(onsetSeconds + localSeconds, shifted),
      secondOrderImpulseDerivative(localSeconds, base),
      2e-14,
    );
  }
});

test("second-order response remains stable arbitrarily close to critical damping", () => {
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
      assertClose(
        secondOrderImpulseDerivative(timeSeconds, near),
        expectedDerivative,
        2e-10,
      );
    }
  }
});

test("overdamped closed forms remain finite at the largest damping ratios", () => {
  for (const dampingRatio of [1e155, Number.MAX_VALUE]) {
    const parameters = {
      naturalAngularFrequencyRadPerSecond: 1,
      dampingRatio,
      numeratorRatePerSecond: 1,
    };
    assert.equal(secondOrderImpulse(0, parameters), 0);
    assert.equal(secondOrderImpulseDerivative(0, parameters), 1);
    assert.equal(Number.isFinite(secondOrderImpulse(0.25, parameters)), true);
    assert.equal(Number.isFinite(secondOrderImpulseDerivative(0.25, parameters)), true);
    assert.equal(Number.isFinite(firstPeakAngularFactor(dampingRatio)), true);
  }
  const extreme = {
    naturalAngularFrequencyRadPerSecond: 1,
    dampingRatio: Number.MAX_VALUE,
    numeratorRatePerSecond: 1,
  };
  assert.ok(secondOrderImpulse(Number.MIN_VALUE, extreme) > 0);
  assertClose(secondOrderImpulseDerivative(Number.MIN_VALUE, extreme), 1, 3e-15);

  for (const [omega, dampingRatio, timeSeconds] of [
    [Number.MAX_VALUE, Number.MAX_VALUE, 2],
    [2, Number.MAX_VALUE, Number.MAX_VALUE],
  ]) {
    const parameters = {
      naturalAngularFrequencyRadPerSecond: omega,
      dampingRatio,
      numeratorRatePerSecond: 1,
    };
    assert.equal(Number.isFinite(secondOrderImpulse(timeSeconds, parameters)), true);
    assert.equal(Number.isFinite(secondOrderImpulseDerivative(timeSeconds, parameters)), true);
  }
});

test("second-order extreme products never leak NaN", () => {
  for (const dampingRatio of [0.5, 1, 1 + Number.EPSILON, Number.MAX_VALUE]) {
    const parameters = {
      naturalAngularFrequencyRadPerSecond: Number.MAX_VALUE,
      dampingRatio,
      numeratorRatePerSecond: Number.MAX_VALUE,
    };
    assert.equal(Number.isNaN(secondOrderImpulse(Number.MAX_VALUE, parameters)), false);
    assert.equal(Number.isNaN(secondOrderImpulseDerivative(Number.MAX_VALUE, parameters)), false);
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

test("Saitou millisecond parameters preserve both period and amplitude in seconds", () => {
  const omegaPerSecond = 0.0345 * 1000;
  const numeratorPerSecond = 0.0018 * 1000;
  const quarterPeriod = Math.PI / (2 * omegaPerSecond);
  const periodSeconds = 2 * Math.PI / omegaPerSecond;
  const peak = secondOrderImpulse(quarterPeriod, {
    naturalAngularFrequencyRadPerSecond: omegaPerSecond,
    dampingRatio: 0,
    numeratorRatePerSecond: numeratorPerSecond,
  });
  assertClose(periodSeconds, 0.1821213132515822, 1e-15);
  assertClose(peak, 0.0018 / 0.0345, 1e-15);
  assertClose(peak, 0.05217391304347826, 1e-15);
});

test("Saitou overshoot peak time catches both 2-pi unit mistakes", () => {
  const zeta = 0.5422;
  const omegaPerSecond = 34.8;
  const correct = firstPeakAngularFactor(zeta) / omegaPerSecond;
  const mistakenAsHz = firstPeakAngularFactor(zeta) / (2 * Math.PI * omegaPerSecond);
  const mistakenHzAsRadians = firstPeakAngularFactor(zeta) / (omegaPerSecond / (2 * Math.PI));
  assertClose(correct, 0.03412174777505054, 1e-16);
  assertClose(mistakenAsHz, correct / (2 * Math.PI), 1e-16);
  assertClose(mistakenHzAsRadians, correct * 2 * Math.PI, 1e-15);
});

test("second-order closed forms satisfy the homogeneous ODE away from the impulse", () => {
  const random = seededRandom(0x5a17_2026);
  for (let trial = 0; trial < 120; trial++) {
    const dampingRatio = trial % 3 === 0
      ? random() * 0.95
      : trial % 3 === 1
        ? 1
        : 1.05 + random() * 2;
    const omega = 10 + random() * 40;
    const numerator = 0.2 + random() * 4;
    const timeSeconds = 0.03 + random() * 0.2;
    const step = 2e-5;
    const parameters = {
      naturalAngularFrequencyRadPerSecond: omega,
      dampingRatio,
      numeratorRatePerSecond: numerator,
    };
    const left = secondOrderImpulse(timeSeconds - step, parameters);
    const center = secondOrderImpulse(timeSeconds, parameters);
    const right = secondOrderImpulse(timeSeconds + step, parameters);
    const first = (right - left) / (2 * step);
    const second = (right - 2 * center + left) / step ** 2;
    const residual = second + 2 * dampingRatio * omega * first + omega ** 2 * center;
    assert.ok(Math.abs(residual) <= 0.015, `ODE residual too large: ${residual}`);
  }
});

test("first-peak parameterization reaches the requested peak across public damping range", () => {
  for (const dampingRatio of [0, 0.2, 0.5422, 0.9, 1]) {
    const compiled = compileFirstPeakTransient({
      peakSemitone: 0.37,
      peakTimeSeconds: 0.065,
      dampingRatio,
      spanSeconds: 0.6,
      tailPolicy: "continuous_taper",
    });
    assertClose(compiled.valueAt(0.065), 0.37, 2e-14);
    assertClose(
      compiled.modelParameters.naturalAngularFrequencyRadPerSecond * 0.065,
      firstPeakAngularFactor(dampingRatio),
      2e-14,
    );
  }
  assertClose(firstPeakAngularFactor(0.999999), 1.0000003333334666, 2e-10);
  assertClose(firstPeakAngularFactor(1), 1, 0);
  assertClose(firstPeakAngularFactor(1.000001), 0.9999996666668, 2e-10);
});

test("public first-peak compiler rejects overdamping as a v1 range choice", () => {
  assert.throws(() => compileFirstPeakTransient({
    peakSemitone: 0.37,
    peakTimeSeconds: 0.065,
    dampingRatio: 1.01,
    spanSeconds: 0.6,
    tailPolicy: "continuous_taper",
  }), (error) => (
    error.code === "DAMPING_RATIO_OUT_OF_V1_RANGE"
    && /v1 public transient range/.test(error.message)
    && error.details.dampingRatio === 1.01
    && error.details.maximum === 1
  ));
  assert.equal(Number.isFinite(firstPeakAngularFactor(1.01)), true);
});

test("first-peak compiler applies onset without changing local peak or span", () => {
  const compiled = compileFirstPeakTransient({
    peakSemitone: 0.37,
    peakTimeSeconds: 0.065,
    dampingRatio: 0.5422,
    onsetSeconds: 0.4,
    spanSeconds: 0.6,
    tailPolicy: "continuous_taper",
  });
  assert.equal(compiled.valueAt(0.4 - 1e-9), 0);
  assertClose(compiled.valueAt(0.4 + 0.065), 0.37, 2e-14);
  assert.equal(compiled.valueAt(1 + 1e-9), 0);
  assertClose(compiled.taper.startSeconds, 0.85, 1e-15);
});

test("continuous taper is C1 at its start and reaches zero with zero slope", () => {
  const compiled = compileFirstPeakTransient({
    peakSemitone: -0.28,
    peakTimeSeconds: 0.08,
    dampingRatio: 0.6681,
    spanSeconds: 0.45,
    tailPolicy: "continuous_taper",
  });
  const start = compiled.taper.startSeconds;
  const step = 1e-6;
  assertClose(compiled.valueAt(start - step), compiled.valueAt(start + step), 2e-5);
  const leftSlope = (
    compiled.valueAt(start) - compiled.valueAt(start - step)
  ) / step;
  const rightSlope = (
    compiled.valueAt(start + step) - compiled.valueAt(start)
  ) / step;
  assertClose(leftSlope, rightSlope, 2e-3);
  assert.equal(compiled.valueAt(compiled.spanSeconds), 0);
  const endSlope = (
    compiled.valueAt(compiled.spanSeconds)
    - compiled.valueAt(compiled.spanSeconds - step)
  ) / step;
  assertClose(endSlope, 0, 2e-3);
});

test("continuous taper never creates a peak larger than the requested first peak", () => {
  for (const dampingRatio of [0, 0.1, 0.3, 0.5422, 0.6681, 0.9, 1]) {
    for (const peakTimeSeconds of [0.06, 0.2, 0.5, 0.75]) {
      const compiled = compileFirstPeakTransient({
        peakSemitone: -0.42,
        peakTimeSeconds,
        dampingRatio,
        spanSeconds: 1,
        tailPolicy: "continuous_taper",
      });
      let observedMaximum = 0;
      for (let index = 0; index <= 2000; index++) {
        observedMaximum = Math.max(
          observedMaximum,
          Math.abs(compiled.valueAt(index / 2000)),
        );
      }
      assert.ok(
        observedMaximum <= 0.42 + 1e-12,
        `taper amplified peak: zeta=${dampingRatio}, peakTime=${peakTimeSeconds}, max=${observedMaximum}`,
      );
    }
  }
});

test("reject tail policy reports an unsettled finite span", () => {
  assert.throws(() => compileFirstPeakTransient({
    peakSemitone: 0.4,
    peakTimeSeconds: 0.06,
    dampingRatio: 0.5,
    spanSeconds: 0.1,
    tailPolicy: "reject",
  }), (error) => error.code === "TAIL_NOT_SETTLED"
    && Math.abs(error.details.observedTailSemitone) > error.details.maxTailSemitone
    && Number.isFinite(error.details.observedTailSlopeSemitonePerSecond));
});

test("undamped transients require the documented continuous taper", () => {
  assert.equal(TRANSIENT_TAPER_RATIO, 0.25);
  assert.throws(() => compileFirstPeakTransient({
    peakSemitone: 0.4,
    peakTimeSeconds: 0.06,
    dampingRatio: 0,
    spanSeconds: 0.5,
    tailPolicy: "reject",
  }), (error) => error.code === "UNDAMPED_TAIL_REQUIRES_TAPER"
    && error.details.dampingRatio === 0
    && error.details.tailPolicy === "reject");
  const compiled = compileFirstPeakTransient({
    peakSemitone: 0.4,
    peakTimeSeconds: 0.06,
    dampingRatio: 0,
    spanSeconds: 0.5,
    tailPolicy: "continuous_taper",
  });
  assert.equal(compiled.taper.ratio, TRANSIENT_TAPER_RATIO);
});

test("tail limits derive only from fit error and sampling interval", () => {
  const compiled = compileFirstPeakTransient({
    peakSemitone: 0.4,
    peakTimeSeconds: 0.06,
    dampingRatio: 0.5,
    spanSeconds: 0.5,
    tailPolicy: "continuous_taper",
    maxFitErrorCent: 2,
    sampleIntervalSeconds: 0.02,
  });
  assert.deepEqual(compiled.tailLimits, {
    maxTailSemitone: 0.02,
    maxTailSlopeSemitonePerSecond: 1,
    maxFitErrorCent: 2,
    sampleIntervalSeconds: 0.02,
  });
});

test("continuous taper rejects a span that would alter the requested peak", () => {
  assert.throws(() => compileFirstPeakTransient({
    peakSemitone: 0.4,
    peakTimeSeconds: 0.08,
    dampingRatio: 0.5,
    spanSeconds: 0.1,
    tailPolicy: "continuous_taper",
  }), (error) => error.code === "TAPER_OVERLAPS_PEAK");
});

test("time-varying vibrato integrates frequency instead of multiplying endpoint rate", () => {
  const phase = integratedLinearFrequencyPhase(2, {
    durationSeconds: 2,
    rateStartHz: 5,
    rateEndHz: 7,
    phaseRad: 0.3,
  });
  assertClose(phase, 0.3 + 2 * Math.PI * 12, 1e-13);

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
  assertClose(timeVaryingVibrato(3, parameters), 0, 2e-14);
});

test("vibrato zero-input identity and fixed-rate zero crossings are exact", () => {
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

test("overlapping vibrato fades are normalized by one deterministic factor", () => {
  const value = timeVaryingVibrato(0.5, {
    startSeconds: 0,
    endSeconds: 1,
    rateStartHz: 1,
    rateEndHz: 1,
    depthStartSemitone: 0.2,
    depthEndSemitone: 0.2,
    phaseRad: Math.PI / 2,
    fadeInSeconds: 0.8,
    fadeOutSeconds: 0.8,
  });
  assertClose(value, -0.2, 2e-14);

  const asymmetric = timeVaryingVibrato(0.2, {
    startSeconds: 0,
    endSeconds: 1,
    rateStartHz: 1,
    rateEndHz: 1,
    depthStartSemitone: 0.2,
    depthEndSemitone: 0.2,
    phaseRad: Math.PI / 10,
    fadeInSeconds: 0.8,
    fadeOutSeconds: 0.4,
  });
  const expectedFadeIn = 0.5 - 0.5 * Math.cos(Math.PI * 0.3);
  assertClose(asymmetric, 0.2 * expectedFadeIn, 2e-14);
});

test("vibrato center drift shares the fade and cannot jump at span boundaries", () => {
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
  assertClose(timeVaryingVibrato(1, parameters), 0, 1e-14);
  assert.notEqual(timeVaryingVibrato(0.5, parameters), 0);
});

test("explicit vibrato requires positive fades and defaults to continuous endpoints", () => {
  const parameters = {
    startSeconds: 1,
    endSeconds: 2,
    rateStartHz: 5,
    rateEndHz: 5,
    depthStartSemitone: 0.2,
    depthEndSemitone: 0.2,
    phaseRad: Math.PI / 2,
  };
  assert.equal(timeVaryingVibrato(1, parameters), 0);
  assert.equal(timeVaryingVibrato(2, parameters), 0);
  assert.throws(
    () => timeVaryingVibrato(1.5, { ...parameters, fadeInSeconds: 0 }),
    /fadeInSeconds must be > 0/,
  );
  assert.throws(
    () => timeVaryingVibrato(1.5, { ...parameters, fadeOutSeconds: 0 }),
    /fadeOutSeconds must be > 0/,
  );
});

test("time-varying vibrato handles or diagnoses representative finite extremes", () => {
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
});

test("correction target uses one absolute-cent reference frame and preserves nulls", () => {
  assert.deepEqual(
    buildCorrectionTargetCent([60, 60.1, null, 61], [0, 12, 8, null]),
    [6000, 6022, null, null],
  );
  assert.deepEqual(
    buildCorrectionTargetCent([Number.MAX_VALUE], [1]),
    [null],
  );
});

test("open-loop correction has the closed-form solution when smoothness is disabled", () => {
  const result = solveOpenLoopCorrection({
    targetAbsoluteCent: [6000, 6010, 6020, 6030],
    observedComputedMidi: [59.9, 60, 60.1, 60.2],
    currentPitchDeltaCent: [0, 0, 0, 0],
  }, {
    smoothnessLambda: 0,
    magnitudeMu: 0.25,
    minimumCoverage: 1,
    minimumRunFrames: 1,
    maxAbsCorrectionCent: 100,
  });
  for (const correction of result.correctionCent) {
    assertClose(correction, 10 / 1.25, 1e-12);
  }
});

test("open-loop correction uses the published magnitudeMu parameter", () => {
  const input = {
    targetAbsoluteCent: [6000, 6000, 6000],
    observedComputedMidi: [59.99, 59.99, 59.99],
    currentPitchDeltaCent: [0, 0, 0],
  };
  const common = {
    smoothnessLambda: 0,
    minimumCoverage: 1,
    minimumRunFrames: 1,
    maxAbsCorrectionCent: 100,
  };
  const weak = solveOpenLoopCorrection(input, { ...common, magnitudeMu: 0.000001 });
  const strong = solveOpenLoopCorrection(input, { ...common, magnitudeMu: 100 });
  assertClose(weak.correctionCent[0], 1 / 1.000001, 1e-14);
  assertClose(strong.correctionCent[0], 1 / 101, 1e-14);
  assert.notDeepEqual(weak.correctionCent, strong.correctionCent);
  assert.throws(
    () => solveOpenLoopCorrection(input, { ...common, correctionMu: 0.1 }),
    (error) => (
      error.code === "INVALID_ARGUMENTS"
      && error.details.parameter === "correctionMu"
    ),
  );
});

test("open-loop dataWeight is the diagonal W value, not its square", () => {
  const result = solveOpenLoopCorrection({
    targetAbsoluteCent: [6000, 6000, 6000],
    observedComputedMidi: [59.9, 59.9, 59.9],
    currentPitchDeltaCent: [0, 0, 0],
  }, {
    smoothnessLambda: 0,
    magnitudeMu: 0.25,
    dataWeight: 4,
    minimumCoverage: 1,
    minimumRunFrames: 1,
    maxAbsCorrectionCent: 100,
  });
  for (const correction of result.correctionCent) {
    assertClose(correction, 40 / 4.25, 1e-12);
  }
});

test("open-loop amplitude clamp is a post-solve safety projection", () => {
  const result = solveOpenLoopCorrection({
    targetAbsoluteCent: [6100, 5900, 6100],
    observedComputedMidi: [60, 60, 60],
    currentPitchDeltaCent: [0, 0, 0],
  }, {
    smoothnessLambda: 0,
    magnitudeMu: 0.01,
    minimumCoverage: 1,
    minimumRunFrames: 1,
    maxAbsCorrectionCent: 12,
  });
  assert.deepEqual(result.correctionCent, [12, -12, 12]);
});

test("open-loop correction is stationary for randomized smooth finite runs", () => {
  const random = seededRandom(0xc011_ec71);
  for (let trial = 0; trial < 50; trial++) {
    const length = 3 + Math.floor(random() * 14);
    const current = Array.from({ length }, () => -20 + random() * 40);
    const error = Array.from({ length }, () => -15 + random() * 30);
    const observed = Array.from({ length }, (_, index) => 60 + index * 0.01);
    const target = observed.map((midi, index) => midi * 100 + error[index]);
    const smoothnessLambda = random() * 10;
    const magnitudeMu = 0.01 + random();
    const dataWeight = 0.2 + random() * 4;
    const solved = solveOpenLoopCorrection({
      targetAbsoluteCent: target,
      observedComputedMidi: observed,
      currentPitchDeltaCent: current,
    }, {
      smoothnessLambda,
      magnitudeMu,
      dataWeight,
      minimumCoverage: 1,
      minimumRunFrames: 1,
      maxAbsCorrectionCent: 1e6,
    }).correctionCent;

    function objective(delta) {
      let value = 0;
      for (let index = 0; index < length; index++) {
        value += dataWeight * (delta[index] - error[index]) ** 2
          + magnitudeMu * delta[index] ** 2;
      }
      for (let index = 0; index + 2 < length; index++) {
        const secondDifference = (
          current[index] + delta[index]
          - 2 * (current[index + 1] + delta[index + 1])
          + current[index + 2] + delta[index + 2]
        );
        value += smoothnessLambda * secondDifference ** 2;
      }
      return value;
    }

    const step = 1e-5;
    for (let index = 0; index < length; index++) {
      const left = [...solved];
      const right = [...solved];
      left[index] -= step;
      right[index] += step;
      const derivative = (objective(right) - objective(left)) / (2 * step);
      assertClose(derivative, 0, 2e-5, "correction objective gradient must vanish");
    }
    assert.ok(objective(solved) <= objective(Array(length).fill(0)) + 1e-9);
  }
});

test("correction solver never couples across a null gap", () => {
  const common = {
    targetAbsoluteCent: [6000, 6010, 6020, null, 6100, 6110, 6120],
    observedComputedMidi: [59.9, 60, 60.1, null, 60.9, 61, 61.1],
    currentPitchDeltaCent: [0, 0, 0, null, 0, 0, 0],
  };
  const options = {
    smoothnessLambda: 8,
    magnitudeMu: 0.1,
    minimumCoverage: 0.8,
    minimumRunFrames: 3,
    maxAbsCorrectionCent: 200,
  };
  const first = solveOpenLoopCorrection(common, options);
  const changedRight = solveOpenLoopCorrection({
    ...common,
    targetAbsoluteCent: [6000, 6010, 6020, null, 6200, 6230, 6260],
  }, options);
  assert.deepEqual(first.runs, [
    { start: 0, endExclusive: 3 },
    { start: 4, endExclusive: 7 },
  ]);
  for (let index = 0; index < 3; index++) {
    assertClose(first.correctionCent[index], changedRight.correctionCent[index], 1e-13);
  }
  assert.equal(first.correctionCent[3], null);
});

test("correction solver reports observed and required coverage", () => {
  assert.throws(() => solveOpenLoopCorrection({
    targetAbsoluteCent: [6000, null, null, 6030],
    observedComputedMidi: [60, null, null, 60.3],
    currentPitchDeltaCent: [0, null, null, 0],
  }, {
    minimumCoverage: 0.75,
  }), (error) => (
    error.code === "INSUFFICIENT_COMPUTED_PITCH"
    && error.details.observedCoverage === 0.5
    && error.details.requiredCoverage === 0.75
  ));
});

test("correction solver rejects finite evidence made only of short fragments", () => {
  assert.throws(() => solveOpenLoopCorrection({
    targetAbsoluteCent: [6000, null, 6020, null, 6040],
    observedComputedMidi: [59.9, null, 60.1, null, 60.3],
    currentPitchDeltaCent: [0, null, 0, null, 0],
  }, {
    minimumCoverage: 0.5,
    minimumRunFrames: 2,
  }), (error) => (
    error.code === "INSUFFICIENT_COMPUTED_PITCH"
    && error.details.reason === "NO_ELIGIBLE_FINITE_RUN"
    && error.details.observedCoverage === 0.6
    && error.details.minimumRunFrames === 2
    && error.details.skippedRuns.length === 3
  ));
});

test("finite runs honor minimum length", () => {
  assert.deepEqual(splitFiniteRuns(
    [true, true, false, true, true, true, false, true],
    3,
  ), [{ start: 3, endExclusive: 6 }]);
  assert.throws(
    () => splitFiniteRuns([true], Number.MAX_SAFE_INTEGER + 1),
    /positive safe integer/,
  );
});

test("eligible singleton correction runs remain independent across null gaps", () => {
  const result = solveOpenLoopCorrection({
    targetAbsoluteCent: [6010, null, 6020, 6030, 6040],
    observedComputedMidi: [60, null, 60.1, 60.2, 60.3],
    currentPitchDeltaCent: [0, null, 0, 0, 0],
  }, {
    smoothnessLambda: 8,
    magnitudeMu: 0.25,
    minimumCoverage: 0.8,
    minimumRunFrames: 1,
    maxAbsCorrectionCent: 100,
  });
  assert.deepEqual(result.runs, [
    { start: 0, endExclusive: 1 },
    { start: 2, endExclusive: 5 },
  ]);
  assertClose(result.correctionCent[0], 10 / 1.25, 1e-12);
  assert.equal(result.correctionCent[1], null);
});

test("correction rejects invalid run lengths and numeric overflow structurally", () => {
  const input = {
    targetAbsoluteCent: [6000, 6010, 6020],
    observedComputedMidi: [60, 60.1, 60.2],
    currentPitchDeltaCent: [0, 0, 0],
  };
  assert.throws(
    () => solveOpenLoopCorrection(input, { minimumRunFrames: 1.5 }),
    /minimumRunFrames must be a positive safe integer/,
  );
  assert.throws(
    () => solveOpenLoopCorrection({
      ...input,
      currentPitchDeltaCent: [Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE],
    }, {
      smoothnessLambda: Number.MAX_VALUE,
      magnitudeMu: 1,
      minimumCoverage: 1,
      minimumRunFrames: 1,
      maxAbsCorrectionCent: 100,
    }),
    (error) => error.code === "CORRECTION_NUMERIC_OVERFLOW",
  );
  assert.throws(
    () => solveOpenLoopCorrection({
      targetAbsoluteCent: [Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE],
      observedComputedMidi: [-Number.MAX_VALUE, -Number.MAX_VALUE, -Number.MAX_VALUE],
      currentPitchDeltaCent: [0, 0, 0],
    }, { minimumCoverage: 1, minimumRunFrames: 1 }),
    (error) => (
      error.code === "INSUFFICIENT_COMPUTED_PITCH"
      && error.details.observedFiniteFrames === 0
    ),
  );
});

test("canonical IR quantizes before hashing and is invariant to request order", () => {
  const first = {
    id: "caller-a",
    requestIndex: 99,
    priority: 0,
    type: "transition",
    spanSeconds: 0.3000000000001,
    model: { family: "richards_segment_normalized", growthPerSecond: 9.2 },
  };
  const second = {
    id: "caller-b",
    requestIndex: 1,
    priority: 2,
    type: "transient",
    peakTimeSeconds: 0.0650000000002,
    peakSemitone: 0.2800000000001,
  };
  const forward = canonicalizeTechniques([first, second]);
  const reverse = canonicalizeTechniques([second, first]);
  assert.deepEqual(forward, reverse);
  assert.equal(forward[0].id, "tech_0");
  assert.match(forward[0].canonicalKey, /^sha256_[0-9a-f]{64}$/);
  assert.equal(forward[0].semantic.spanSeconds, 0.3);
  assert.equal(forward[1].semantic.peakSemitone, 0.28);
});

test("canonical IR is identical across every permutation of three peer techniques", () => {
  const techniques = [
    {
      id: "first",
      type: "transition",
      priority: 0,
      spanSeconds: 0.3,
      model: { family: "richards_segment_normalized", sharpness: 4 },
    },
    {
      id: "second",
      type: "transition",
      priority: 0,
      spanSeconds: 0.3,
      model: { family: "richards_segment_normalized", sharpness: 7 },
    },
    {
      id: "third",
      type: "transition",
      priority: 0,
      spanSeconds: 0.3,
      model: { family: "richards_segment_normalized", sharpness: 10 },
    },
  ];
  const permutations = [
    [0, 1, 2], [0, 2, 1], [1, 0, 2],
    [1, 2, 0], [2, 0, 1], [2, 1, 0],
  ];
  const expected = canonicalizeTechniques(techniques);
  for (const order of permutations) {
    assert.deepEqual(
      canonicalizeTechniques(order.map((index) => techniques[index])),
      expected,
    );
  }
});

test("canonical quantization rejects near-colliding duplicate techniques", () => {
  const base = {
    priority: 0,
    type: "vibrato",
    rateHz: 5.2,
    depthSemitone: 0.18,
  };
  assert.throws(() => canonicalizeTechniques([
    { ...base, id: "literal", requestIndex: 4 },
    {
      ...base,
      id: "rounded",
      requestIndex: 9,
      rateHz: 5.2 + 2e-10,
      depthSemitone: 0.18 - 2e-10,
    },
  ]), (error) => (
    error.code === "DUPLICATE_TECHNIQUE"
    && error.details.priority === 0
    && error.details.left.quantization.some((entry) => (
      entry.field === "rateHz"
      && entry.input === 5.2
      && entry.output === 5.2
      && entry.quantum === 1e-9
    ))
    && error.details.right.quantization.some((entry) => (
      entry.field === "rateHz"
      && entry.input === 5.2 + 2e-10
      && entry.output === 5.2
      && entry.quantum === 1e-9
    ))
    && [error.details.left.source.id, error.details.right.source.id].sort().join(",")
      === "literal,rounded"
  ));
});

test("numeric field schema is the sole source of quantization rules", () => {
  const fields = Object.keys(TECHNIQUE_IR_NUMERIC_FIELD_SCHEMA);
  assert.ok(fields.length > 0);
  assert.deepEqual(Object.keys(SEMANTIC_NUMERIC_QUANTA), fields);
  for (const field of fields) {
    const rule = TECHNIQUE_IR_NUMERIC_FIELD_SCHEMA[field];
    assert.equal(SEMANTIC_NUMERIC_QUANTA[field], rule.quantum);
    assert.ok(rule.unit.length > 0);
    assert.ok(["finite", "safe_integer"].includes(rule.domain));
    assert.ok(rule.owners.length > 0);
  }
  assert.equal(TECHNIQUE_IR_NUMERIC_FIELD_SCHEMA.note.domain, "safe_integer");
  assert.equal(TECHNIQUE_IR_NUMERIC_FIELD_SCHEMA.schemaVersion.unit, "version");
  assert.equal(TECHNIQUE_IR_NUMERIC_FIELD_SCHEMA.fromNote.domain, "safe_integer");
  assert.equal(TECHNIQUE_IR_NUMERIC_FIELD_SCHEMA.toNote.domain, "safe_integer");
  assert.equal(TECHNIQUE_IR_NUMERIC_FIELD_SCHEMA.fromBlick.domain, "safe_integer");
  assert.equal(TECHNIQUE_IR_NUMERIC_FIELD_SCHEMA.tension.quantum, 1e-12);
  assert.equal(TECHNIQUE_IR_NUMERIC_FIELD_SCHEMA.loudness.quantum, 1e-6);
  assert.equal(TECHNIQUE_IR_NUMERIC_FIELD_SCHEMA.rateHz.unit, "hertz");
  assert.equal(
    TECHNIQUE_IR_NUMERIC_FIELD_SCHEMA.naturalAngularFrequencyRadPerSecond.unit,
    "radian_per_second",
  );
  assert.equal(
    TECHNIQUE_IR_NUMERIC_FIELD_SCHEMA.numeratorRatePerSecond.unit,
    "response_unit_per_second",
  );
  assert.equal(Object.hasOwn(TECHNIQUE_IR_NUMERIC_FIELD_SCHEMA, "fromNoteIndex"), false);
  assert.equal(Object.hasOwn(TECHNIQUE_IR_NUMERIC_FIELD_SCHEMA, "toNoteIndex"), false);
});

test("canonical IR rejects fractional and unsafe integer identity fields", () => {
  for (const [field, value] of [
    ["note", 0.6],
    ["fromBlick", 1.5],
    ["occurrence", Number.MAX_SAFE_INTEGER + 1],
    ["priority", 0.5],
  ]) {
    assert.throws(() => canonicalizeTechniques([{
      type: "transition",
      [field]: value,
    }]), (error) => (
      error.code === "INVALID_INTEGER_SEMANTIC_FIELD"
      && error.details.field === field
      && error.details.path === `$/` + field
      && error.details.value === value
    ));
  }
});

test("canonical IR quantizes unitless shape and envelope scale fields", () => {
  const [transition, vibrato] = canonicalizeTechniques([
    {
      type: "transition",
      priority: 0,
      sharpness: 6.0000000000002,
      asymmetryLogB: 0.3000000000002,
    },
    {
      type: "vibrato",
      priority: 1,
      envelopeScale: 1.2000000000002,
    },
  ]);
  assert.equal(transition.semantic.sharpness, 6);
  assert.equal(transition.semantic.asymmetryLogB, 0.3);
  assert.equal(vibrato.semantic.envelopeScale, 1.2);
});

test("canonical IR quantizes every registered expression numeric field", () => {
  const arithmetic = canonicalizeTechniques([{
    type: "vibrato",
    level: 0.1 + 0.2,
    shapePower: 0.1 + 1.9,
    tension: 0.1 + 0.2,
    onsetDelayQuarter: 0.1 + 0.2,
    rampQuarter: 0.1 + 0.2,
    fadeOutQuarter: 0.1 + 0.2,
  }])[0];
  const literal = canonicalizeTechniques([{
    type: "vibrato",
    level: 0.3,
    shapePower: 2,
    tension: 0.3,
    onsetDelayQuarter: 0.3,
    rampQuarter: 0.3,
    fadeOutQuarter: 0.3,
  }])[0];
  assert.equal(arithmetic.canonicalKey, literal.canonicalKey);
  assert.deepEqual(arithmetic.semantic, literal.semantic);
});

test("canonical IR rejects unknown numeric fields without substring guessing", () => {
  for (const field of [
    "separateFlag",
    "accurateSeconds",
    "newNumericModelField",
    "growthRate",
    "inflection",
    "maxCents",
    "overshoot",
    "phase",
    "polarity",
  ]) {
    assert.throws(() => canonicalizeTechniques([{
      type: "transition",
      model: { [field]: 0.1 + 0.2 },
    }]), (error) => (
      error.code === "UNQUANTIZED_SEMANTIC_FIELD"
      && error.details.field === field
      && error.details.path === `$/model/${field}`
      && error.details.value === 0.1 + 0.2
    ));
  }
});

test("canonical IR revalidates ordered relations after quantization", () => {
  for (const [technique, relation] of [
    [{ kind: "vibrato", model: { startRatio: 0, endRatio: 4e-13 } }, "startRatio<endRatio"],
    [{ kind: "transient", model: { peakTimeSeconds: 0.1, spanSeconds: 0.1000000000004 } }, "peakTimeSeconds<spanSeconds"],
    [{ kind: "portamento", span: { fromSeconds: 0.1, toSeconds: 0.1000000000004 } }, "fromSeconds<toSeconds"],
  ]) {
    assert.throws(
      () => canonicalizeTechniques([technique]),
      (error) => error.code === "CANONICAL_RELATION_INVALID"
        && error.details.relation === relation
        && error.details.left.value === error.details.right.value,
    );
  }
});

test("canonical transient rechecks the undamped tail rule after quantization", () => {
  assert.throws(
    () => canonicalizeTechniques([{
      kind: "transient",
      model: {
        dampingRatio: 4e-13,
        tailPolicy: "reject",
      },
    }]),
    (error) => error.code === "UNDAMPED_TAIL_REQUIRES_TAPER"
      && error.details.dampingRatio === 0
      && error.details.tailPolicy === "reject",
  );
  const [accepted] = canonicalizeTechniques([{
    kind: "transient",
    model: {
      dampingRatio: 4e-13,
      tailPolicy: "continuous_taper",
    },
  }]);
  assert.equal(accepted.semantic.model.dampingRatio, 0);
});

test("canonical phase boundary is lattice-aligned and remains in range", () => {
  for (const phaseRad of [-CANONICAL_PHASE_LIMIT_RAD, CANONICAL_PHASE_LIMIT_RAD]) {
    const [technique] = canonicalizeTechniques([{
      kind: "vibrato",
      model: { phaseRad },
    }]);
    assert.equal(technique.semantic.model.phaseRad, phaseRad);
  }
  assert.throws(
    () => canonicalizeTechniques([{
      kind: "vibrato",
      model: { phaseRad: CANONICAL_PHASE_LIMIT_RAD + 1e-12 },
    }]),
    (error) => error.code === "CANONICAL_VALUE_OUT_OF_RANGE"
      && error.details.field === "phaseRad",
  );
});
