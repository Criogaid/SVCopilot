import assert from "node:assert/strict";
import test from "node:test";

import {
  buildUniformSecondsGrid,
  compareUniformSecondsGridAxes,
} from "../server/src/pitch-techniques/time-grid.js";
import { secondsAtBlick } from "../server/src/musical-time.js";

const Q = 705_600_000;

function tempoMarks() {
  return [
    { positionBlick: 0, positionSeconds: 0, bpm: 120 },
    { positionBlick: Q, positionSeconds: 0.5, bpm: 60 },
  ];
}

function approx(actual, expected, tolerance = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`
  );
}

test("constant-tempo computed pitch preserves the original uniform frame positions", () => {
  const values = [60, 60.1, null, 60.3, 60.4];
  const grid = buildUniformSecondsGrid({
    startBlick: 0,
    intervalBlick: Q / 40,
    values,
    tempoMarks: [{ positionBlick: 0, positionSeconds: 0, bpm: 120 }],
    quarterBlick: Q,
  });

  assert.equal(grid.status, "ready");
  assert.equal(grid.timeGrid, "uniform_seconds");
  approx(grid.sampleRateHz, 80);
  assert.deepEqual(grid.timeSeconds, [0, 0.0125, 0.025, 0.037500000000000006, 0.05]);
  assert.deepEqual(grid.values, values);
  assert.deepEqual(grid.mask, [true, true, false, true, true]);
  assert.equal(grid.resampling.crossedTempoChange, false);
});

test("tempo-step input is resampled on an equal-seconds axis without changing its phase rate", () => {
  const intervalBlick = Q / 20;
  const sourceFrames = 31;
  const sourceSeconds = Array.from({ length: sourceFrames }, (_, index) => {
    const blick = index * intervalBlick;
    return blick < Q ? blick / Q / 2 : 0.5 + (blick - Q) / Q;
  });
  const targetRateHz = 4;
  const grid = buildUniformSecondsGrid({
    startBlick: 0,
    intervalBlick,
    values: sourceSeconds.map((seconds) => 60 + 0.3 * Math.sin(2 * Math.PI * targetRateHz * seconds)),
    tempoMarks: tempoMarks(),
    quarterBlick: Q,
    sampleIntervalSeconds: 0.025,
  });

  assert.equal(grid.status, "ready");
  assert.equal(grid.resampling.crossedTempoChange, true);
  approx(grid.sampleIntervalSeconds, 0.025);
  for (let index = 1; index < grid.timeSeconds.length; index += 1) {
    approx(grid.timeSeconds[index] - grid.timeSeconds[index - 1], 0.025);
  }
  for (let index = 0; index < grid.timeSeconds.length; index += 1) {
    approx(
      secondsAtBlick(tempoMarks(), Q, grid.blicks[index]),
      grid.timeSeconds[index],
      1e-9
    );
  }
  for (const index of [0, 8, 16, 20, 24, 28]) {
    const expected = 60 + 0.3 * Math.sin(2 * Math.PI * targetRateHz * grid.timeSeconds[index]);
    approx(grid.values[index], expected, 0.025);
  }
});

test("null runs remain null and are never bridged by interpolation", () => {
  const grid = buildUniformSecondsGrid({
    startBlick: 0,
    intervalBlick: Q / 10,
    values: [60, 61, null, null, 64, 65],
    tempoMarks: [{ positionBlick: 0, positionSeconds: 0, bpm: 120 }],
    quarterBlick: Q,
    sampleIntervalSeconds: 0.025,
  });

  assert.equal(grid.status, "ready");
  assert.deepEqual(grid.values, [60, 60.5, 61, null, null, null, null, null, 64, 64.5, 65]);
  assert.deepEqual(grid.mask, [true, true, true, false, false, false, false, false, true, true, true]);
});

test("grid compatibility requires an identical equal-seconds axis", () => {
  const input = {
    startBlick: 0,
    intervalBlick: Q / 20,
    values: new Array(30).fill(60),
    tempoMarks: tempoMarks(),
    quarterBlick: Q,
    sampleIntervalSeconds: 0.025,
  };
  const same = buildUniformSecondsGrid(input);
  const shifted = buildUniformSecondsGrid({ ...input, sampleIntervalSeconds: 0.05 });

  assert.deepEqual(compareUniformSecondsGridAxes(same, same), { compatible: true });
  assert.deepEqual(compareUniformSecondsGridAxes(same, shifted), {
    compatible: false,
    reason: "frame_count_differs",
  });
});

test("unavailable tempo mapping is explicit instead of producing a pseudo-seconds grid", () => {
  const grid = buildUniformSecondsGrid({
    startBlick: 0,
    intervalBlick: Q / 10,
    values: [60, 60.1],
    tempoMarks: [],
    quarterBlick: Q,
  });

  assert.equal(grid.status, "unavailable");
  assert.equal(grid.reason, "tempo_mapping_unavailable");
});
