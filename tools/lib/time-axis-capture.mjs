import {
  createTimeAxisProbePlan,
  evaluateTimeAxisProbe,
} from "./time-axis-evidence.mjs";

export async function captureTimeAxisEvidence({
  host,
  scenario,
  sampleCount,
  hostEvidence,
} = {}) {
  const client = requireHostClient(host);
  const roots = await client.roots();
  if (!roots?.timeAxis || !roots?.project) {
    throw captureError("the attached host did not expose Project and TimeAxis roots");
  }
  const quarterBlick = await client.index("QUARTER");
  const durationBlick = await client.call({
    handle: roots.project,
    method: "getDuration",
    args: [],
  });
  const rawTempoMarks = await client.call({
    handle: roots.timeAxis,
    method: "getAllTempoMarks",
    args: [],
  });
  const plan = createTimeAxisProbePlan({
    scenario,
    quarterBlick,
    durationBlick,
    tempoMarks: normalizeTempoMarks(rawTempoMarks),
    sampleCount,
  });
  const samples = [];
  for (const blick of plan.positions) {
    const hostSeconds = await client.call({
      handle: roots.timeAxis,
      method: "getSecondsFromBlick",
      args: [blick],
    });
    const hostBlickFromSeconds = await client.call({
      handle: roots.timeAxis,
      method: "getBlickFromSeconds",
      args: [hostSeconds],
    });
    samples.push({ blick, hostSeconds, hostBlickFromSeconds });
  }
  const evidence = typeof hostEvidence === "function" ? await hostEvidence() : hostEvidence;
  return evaluateTimeAxisProbe({
    scenario: plan.scenario,
    quarterBlick: plan.quarterBlick,
    durationBlick: plan.durationBlick,
    tempoMarks: plan.tempoMarks,
    samples,
    host: evidence,
  });
}

function normalizeTempoMarks(value) {
  if (!Array.isArray(value)) throw captureError("TimeAxis.getAllTempoMarks returned a non-array value");
  return value.map((mark) => ({
    positionBlick: mark?.position,
    positionSeconds: mark?.positionSeconds,
    bpm: mark?.bpm,
  }));
}

function requireHostClient(value) {
  if (!value || typeof value !== "object") throw captureError("host client is required");
  for (const method of ["roots", "index", "call"]) {
    if (typeof value[method] !== "function") {
      throw captureError(`host client must provide ${method}()`);
    }
  }
  return value;
}

function captureError(message) {
  const error = new Error(message);
  error.code = "TIME_AXIS_CAPTURE_FAILED";
  return error;
}
