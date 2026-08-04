import assert from "node:assert/strict";
import test from "node:test";

import { captureTimeAxisEvidence } from "../tools/lib/time-axis-capture.mjs";

test("TimeAxis capture uses only read calls and opens no Undo boundary", async () => {
  const project = { id: "project" };
  const timeAxis = { id: "timeAxis" };
  const calls = [];
  const quarterBlick = 1000;
  const host = {
    roots: async () => ({ project, timeAxis }),
    index: async (field) => {
      assert.equal(field, "QUARTER");
      return quarterBlick;
    },
    call: async (request) => {
      calls.push(request);
      if (request.handle === project && request.method === "getDuration") return 240000;
      if (request.handle === timeAxis && request.method === "getAllTempoMarks") {
        return [{ position: 0, positionSeconds: 0, bpm: 120 }];
      }
      if (request.handle === timeAxis && request.method === "getSecondsFromBlick") {
        return (request.args[0] / quarterBlick) * 0.5;
      }
      if (request.handle === timeAxis && request.method === "getBlickFromSeconds") {
        return Math.round(request.args[0] * 2 * quarterBlick);
      }
      throw new Error(`unexpected host call: ${request.method}`);
    },
  };

  const report = await captureTimeAxisEvidence({
    host,
    scenario: "constant",
    sampleCount: 200,
    hostEvidence: { hostVersion: "2.2.1", bridgeProtocolVersion: 2 },
  });

  assert.equal(report.readOnly, true);
  assert.equal(report.summary.sampleCount, 200);
  assert.equal(report.summary.nodeParitySeconds.maximum, 0);
  assert.equal(report.host.hostVersion, "2.2.1");
  assert.equal(calls.filter((call) => call.method === "getSecondsFromBlick").length, 200);
  assert.equal(calls.filter((call) => call.method === "getBlickFromSeconds").length, 200);
  assert.ok(calls.every((call) => !call.method.startsWith("set")));
  assert.ok(calls.every((call) => call.method !== "newUndoRecord"));
});
