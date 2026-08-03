import assert from "node:assert/strict";
import test from "node:test";

import { blickAtSeconds, secondsAtBlick } from "../server/src/musical-time.js";
import {
  createTimeAxisProbePlan,
  evaluateTimeAxisProbe,
  NODE_PARITY_MAX_DEVIATION_SECONDS,
  summarizeTimeAxisEvidence,
  validateTimeAxisProbeReport,
  validateTimeAxisEvidenceSummary,
} from "../tools/lib/time-axis-evidence.mjs";

const QUARTER_BLICK = 1000;

function tempoMarks(values) {
  return values.map((item) => ({ ...item }));
}

function makeReport({ scenario, marks, durationBlick = 240000, sampleCount = 200, shiftSeconds = 0 }) {
  const plan = createTimeAxisProbePlan({
    scenario,
    quarterBlick: QUARTER_BLICK,
    durationBlick,
    tempoMarks: marks,
    sampleCount,
  });
  const samples = plan.positions.map((blick) => {
    const nodeSeconds = secondsAtBlick(plan.tempoMarks, plan.quarterBlick, blick);
    const hostSeconds = nodeSeconds + shiftSeconds;
    return {
      blick,
      hostSeconds,
      hostBlickFromSeconds: blickAtSeconds(plan.tempoMarks, plan.quarterBlick, hostSeconds),
    };
  });
  return evaluateTimeAxisProbe({
    scenario: plan.scenario,
    quarterBlick: plan.quarterBlick,
    durationBlick: plan.durationBlick,
    tempoMarks: plan.tempoMarks,
    samples,
    host: { hostVersion: "2.2.1", bridgeProtocolVersion: 2 },
  });
}

test("TimeAxis plans include tempo boundaries and a deterministic 200-point minimum", () => {
  const plan = createTimeAxisProbePlan({
    scenario: "tempo_step",
    quarterBlick: QUARTER_BLICK,
    durationBlick: 240000,
    tempoMarks: tempoMarks([
      { positionBlick: 0, positionSeconds: 0, bpm: 120 },
      { positionBlick: 120000, positionSeconds: 60, bpm: 90 },
    ]),
  });
  assert.equal(plan.positions.length, 200);
  assert.deepEqual(
    [119999, 120000, 120001].map((position) => plan.positions.includes(position)),
    [true, true, true]
  );
  assert.deepEqual(plan.positions, [...plan.positions].sort((left, right) => left - right));
});

test("replaying the same raw TimeAxis report gives the same summaries and parity verdict", () => {
  const report = makeReport({
    scenario: "constant",
    marks: tempoMarks([{ positionBlick: 0, positionSeconds: 0, bpm: 120 }]),
  });
  const replayed = validateTimeAxisProbeReport(structuredClone(report));
  assert.deepEqual(replayed.summary, report.summary);
  assert.equal(report.summary.nodeParitySeconds.maximum, 0);
  assert.ok(report.summary.hostRoundTripBlick.maximum <= 1);
});

test("full required scenario coverage confirms parity and makes T03 unnecessary", () => {
  const reports = [
    makeReport({
      scenario: "constant",
      marks: tempoMarks([{ positionBlick: 0, positionSeconds: 0, bpm: 120 }]),
    }),
    makeReport({
      scenario: "tempo_step",
      marks: tempoMarks([
        { positionBlick: 0, positionSeconds: 0, bpm: 120 },
        { positionBlick: 120000, positionSeconds: 60, bpm: 90 },
      ]),
    }),
    makeReport({
      scenario: "dense_tempo",
      marks: tempoMarks([
        { positionBlick: 0, positionSeconds: 0, bpm: 120 },
        { positionBlick: 60000, positionSeconds: 30, bpm: 100 },
        { positionBlick: 120000, positionSeconds: 66, bpm: 140 },
        { positionBlick: 180000, positionSeconds: 91.71428571428571, bpm: 80 },
      ]),
    }),
  ];
  const summary = summarizeTimeAxisEvidence(reports);
  assert.equal(summary.status, "confirmed");
  assert.equal(summary.metrics.nodeParityMaxDeviationSeconds, 0);
  assert.equal(summary.t03Disposition, "not_required");
  assert.equal(summary.coverage.completeRequiredScenarios, true);
  assert.doesNotThrow(() => validateTimeAxisEvidenceSummary(structuredClone(summary)));
});

test("incomplete evidence remains partial and does not decide T03", () => {
  const report = makeReport({
    scenario: "constant",
    sampleCount: 45,
    marks: tempoMarks([{ positionBlick: 0, positionSeconds: 0, bpm: 120 }]),
  });
  const summary = summarizeTimeAxisEvidence([report]);
  assert.equal(summary.status, "partially_observed");
  assert.equal(summary.t03Disposition, "not_determined");
  assert.equal(summary.coverage.sampleCountByScenario.constant, 45);
});

test("a complete non-boundary mismatch requires the conditional batch opcode", () => {
  const report = makeReport({
    scenario: "constant",
    marks: tempoMarks([{ positionBlick: 0, positionSeconds: 0, bpm: 120 }]),
    shiftSeconds: NODE_PARITY_MAX_DEVIATION_SECONDS * 10,
  });
  const reports = [
    report,
    makeReport({
      scenario: "tempo_step",
      marks: tempoMarks([
        { positionBlick: 0, positionSeconds: 0, bpm: 120 },
        { positionBlick: 120000, positionSeconds: 60, bpm: 90 },
      ]),
      shiftSeconds: NODE_PARITY_MAX_DEVIATION_SECONDS * 10,
    }),
    makeReport({
      scenario: "dense_tempo",
      marks: tempoMarks([
        { positionBlick: 0, positionSeconds: 0, bpm: 120 },
        { positionBlick: 60000, positionSeconds: 30, bpm: 100 },
        { positionBlick: 120000, positionSeconds: 66, bpm: 140 },
      ]),
      shiftSeconds: NODE_PARITY_MAX_DEVIATION_SECONDS * 10,
    }),
  ];
  const summary = summarizeTimeAxisEvidence(reports);
  assert.equal(summary.status, "contradicted");
  assert.equal(summary.t03Disposition, "required");
});

test("TimeAxis evidence rejects stale summaries and unknown fields", () => {
  const report = makeReport({
    scenario: "constant",
    marks: tempoMarks([{ positionBlick: 0, positionSeconds: 0, bpm: 120 }]),
  });
  const stale = structuredClone(report);
  stale.summary.nodeParitySeconds.maximum = 1;
  assert.throws(
    () => validateTimeAxisProbeReport(stale),
    (error) => error.code === "INVALID_TIME_AXIS_EVIDENCE" && /does not match/.test(error.message)
  );

  const extra = structuredClone(report);
  extra.unexpected = true;
  assert.throws(
    () => validateTimeAxisProbeReport(extra),
    (error) => error.code === "INVALID_TIME_AXIS_EVIDENCE" && /unknown field/.test(error.message)
  );
});
