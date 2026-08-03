import { createHash } from "node:crypto";

import { blickAtSeconds, secondsAtBlick } from "../../server/src/musical-time.js";

export const TIME_AXIS_EVIDENCE_KIND = "svcopilot-time-axis-evidence";
export const TIME_AXIS_EVIDENCE_SCHEMA_VERSION = "1.0.0";
export const TIME_AXIS_MINIMUM_SAMPLES = 200;
export const NODE_PARITY_MAX_DEVIATION_SECONDS = 1e-6;
export const REQUIRED_TIME_AXIS_SCENARIOS = Object.freeze([
  "constant",
  "tempo_step",
  "dense_tempo",
]);

const SUMMARY_KIND = "svcopilot-time-axis-evidence-summary";
const MAX_PROBE_SAMPLES = 4096;
const SCENARIOS = new Set([...REQUIRED_TIME_AXIS_SCENARIOS, "ramp"]);
const SUMMARY_STATUSES = new Set(["confirmed", "contradicted", "partially_observed"]);
const T03_DISPOSITIONS = new Set([
  "not_required",
  "required",
  "repair_node_boundary_and_retest",
  "not_determined",
]);

export function createTimeAxisProbePlan({
  scenario,
  quarterBlick,
  durationBlick,
  tempoMarks,
  sampleCount = TIME_AXIS_MINIMUM_SAMPLES,
} = {}) {
  const normalized = normalizeTimeAxisInput({
    scenario,
    quarterBlick,
    durationBlick,
    tempoMarks,
  });
  requireIntegerInRange(sampleCount, 1, MAX_PROBE_SAMPLES, "sampleCount");
  if (durationBlick + 1 < sampleCount) {
    throw evidenceError("durationBlick cannot provide the requested number of distinct positions");
  }

  const positions = new Set([0, durationBlick]);
  for (const mark of normalized.tempoMarks) {
    for (const offset of [-1, 0, 1]) {
      const position = mark.positionBlick + offset;
      if (position >= 0 && position <= durationBlick) positions.add(position);
    }
  }
  const targetCount = Math.max(sampleCount, positions.size);
  if (targetCount > MAX_PROBE_SAMPLES) {
    throw evidenceError(`probe requires ${targetCount} positions, exceeding ${MAX_PROBE_SAMPLES}`);
  }
  for (let index = 0; positions.size < targetCount && index < targetCount; index += 1) {
    positions.add(Math.floor((index * durationBlick) / (targetCount - 1)));
  }
  if (positions.size !== targetCount) {
    throw evidenceError("unable to construct the requested distinct probe positions");
  }

  return deepFreeze({
    ...normalized,
    sampleCount: targetCount,
    positions: [...positions].sort((left, right) => left - right),
  });
}

export function evaluateTimeAxisProbe({
  scenario,
  quarterBlick,
  durationBlick,
  tempoMarks,
  samples,
  host,
} = {}) {
  const normalized = normalizeTimeAxisInput({
    scenario,
    quarterBlick,
    durationBlick,
    tempoMarks,
  });
  const normalizedHost = normalizeHost(host);
  const rawSamples = requireArray(samples, "samples");
  if (rawSamples.length === 0 || rawSamples.length > MAX_PROBE_SAMPLES) {
    throw evidenceError(`samples must contain between 1 and ${MAX_PROBE_SAMPLES} entries`);
  }

  const seenBlicks = new Set();
  const measuredSamples = rawSamples.map((value, index) => {
    const sample = requireRecord(value, `samples[${index}]`);
    assertKnownKeys(
      sample,
      [
        "blick",
        "hostSeconds",
        "hostBlickFromSeconds",
        "nodeSeconds",
        "nodeBlickFromHostSeconds",
        "secondsError",
        "blickError",
        "hostRoundTripBlickError",
        "nodeRoundTripBlickError",
      ],
      `samples[${index}]`
    );
    const blick = requireSafeInteger(sample.blick, `samples[${index}].blick`);
    if (blick < 0 || blick > normalized.durationBlick) {
      throw evidenceError(`samples[${index}].blick is outside the project duration`);
    }
    if (seenBlicks.has(blick)) throw evidenceError(`samples contains duplicate blick ${blick}`);
    seenBlicks.add(blick);
    const hostSeconds = requireFinite(sample.hostSeconds, `samples[${index}].hostSeconds`);
    const hostBlickFromSeconds = requireFinite(
      sample.hostBlickFromSeconds,
      `samples[${index}].hostBlickFromSeconds`
    );
    const nodeSeconds = secondsAtBlick(
      normalized.tempoMarks,
      normalized.quarterBlick,
      blick
    );
    const nodeBlickFromHostSeconds = blickAtSeconds(
      normalized.tempoMarks,
      normalized.quarterBlick,
      hostSeconds
    );
    if (!Number.isFinite(nodeSeconds) || !Number.isFinite(nodeBlickFromHostSeconds)) {
      throw evidenceError(`Node conversion is unavailable at samples[${index}]`);
    }
    const measured = {
      blick,
      hostSeconds,
      hostBlickFromSeconds,
      nodeSeconds,
      nodeBlickFromHostSeconds,
      secondsError: Math.abs(nodeSeconds - hostSeconds),
      blickError: Math.abs(nodeBlickFromHostSeconds - hostBlickFromSeconds),
      hostRoundTripBlickError: Math.abs(Math.round(hostBlickFromSeconds) - blick),
      nodeRoundTripBlickError: Math.abs(Math.round(nodeBlickFromHostSeconds) - blick),
    };
    for (const [field, calculated] of Object.entries(measured)) {
      if (field !== "blick" && Object.hasOwn(sample, field) && !Object.is(sample[field], calculated)) {
        throw evidenceError(`samples[${index}].${field} does not match the host observation`);
      }
    }
    return measured;
  });
  measuredSamples.sort((left, right) => left.blick - right.blick);

  const summary = summarizeSamples(measuredSamples);
  return deepFreeze({
    kind: TIME_AXIS_EVIDENCE_KIND,
    schemaVersion: TIME_AXIS_EVIDENCE_SCHEMA_VERSION,
    scenario: normalized.scenario,
    readOnly: true,
    ...(normalizedHost ? { host: normalizedHost } : {}),
    timeAxis: {
      quarterBlick: normalized.quarterBlick,
      durationBlick: normalized.durationBlick,
      tempoMarks: normalized.tempoMarks,
    },
    samples: measuredSamples,
    summary,
  });
}

export function validateTimeAxisProbeReport(value) {
  const report = structuredClone(requireRecord(value, "timeAxisEvidence"));
  assertKnownKeys(
    report,
    ["kind", "schemaVersion", "scenario", "readOnly", "host", "timeAxis", "samples", "summary"],
    "timeAxisEvidence"
  );
  if (report.kind !== TIME_AXIS_EVIDENCE_KIND) {
    throw evidenceError("timeAxisEvidence.kind is unsupported");
  }
  if (report.schemaVersion !== TIME_AXIS_EVIDENCE_SCHEMA_VERSION) {
    throw evidenceError(
      `timeAxisEvidence.schemaVersion must be ${TIME_AXIS_EVIDENCE_SCHEMA_VERSION}`
    );
  }
  if (report.readOnly !== true) throw evidenceError("timeAxisEvidence.readOnly must be true");
  const regenerated = evaluateTimeAxisProbe({
    scenario: report.scenario,
    quarterBlick: report.timeAxis?.quarterBlick,
    durationBlick: report.timeAxis?.durationBlick,
    tempoMarks: report.timeAxis?.tempoMarks,
    samples: report.samples,
    host: report.host,
  });
  if (stableStringify(regenerated.summary) !== stableStringify(report.summary)) {
    throw evidenceError("timeAxisEvidence.summary does not match the samples");
  }
  return regenerated;
}

export function summarizeTimeAxisEvidence(reports) {
  const source = requireArray(reports, "timeAxisEvidence reports");
  if (source.length === 0) throw evidenceError("timeAxisEvidence reports must not be empty");
  const normalizedReports = source.map(validateTimeAxisProbeReport);
  const byScenario = new Map();
  for (const report of normalizedReports) {
    if (byScenario.has(report.scenario)) {
      throw evidenceError(`timeAxisEvidence has duplicate scenario ${report.scenario}`);
    }
    byScenario.set(report.scenario, report);
  }

  const observedScenarios = [...byScenario.keys()].sort(scenarioOrder);
  const sampleCountByScenario = Object.fromEntries(
    observedScenarios.map((scenario) => [scenario, byScenario.get(scenario).samples.length])
  );
  const completeRequiredScenarios = REQUIRED_TIME_AXIS_SCENARIOS.every(
    (scenario) => sampleCountByScenario[scenario] >= TIME_AXIS_MINIMUM_SAMPLES
  );
  const samples = normalizedReports.flatMap((report) => report.samples);
  const rawSummary = summarizeSamples(samples);
  const metrics = {
    sampleCount: samples.length,
    nodeParityMaxDeviationSeconds: rawSummary.nodeParitySeconds.maximum,
    nodeParityMedianDeviationSeconds: rawSummary.nodeParitySeconds.median,
    nodeParityP95DeviationSeconds: rawSummary.nodeParitySeconds.p95,
    nodeParityMaxDeviationBlick: rawSummary.nodeParityBlick.maximum,
    nodeParityMedianDeviationBlick: rawSummary.nodeParityBlick.median,
    nodeParityP95DeviationBlick: rawSummary.nodeParityBlick.p95,
    hostRoundTripMaxDeviationBlick: rawSummary.hostRoundTripBlick.maximum,
    hostRoundTripMedianDeviationBlick: rawSummary.hostRoundTripBlick.median,
    hostRoundTripP95DeviationBlick: rawSummary.hostRoundTripBlick.p95,
    nodeRoundTripMaxDeviationBlick: rawSummary.nodeRoundTripBlick.maximum,
    nodeRoundTripMedianDeviationBlick: rawSummary.nodeRoundTripBlick.median,
    nodeRoundTripP95DeviationBlick: rawSummary.nodeRoundTripBlick.p95,
  };
  const status = !completeRequiredScenarios
    ? "partially_observed"
    : metrics.nodeParityMaxDeviationSeconds <= NODE_PARITY_MAX_DEVIATION_SECONDS
      ? "confirmed"
      : "contradicted";
  const t03Disposition = determineT03Disposition({
    status,
    reports: normalizedReports,
    metrics,
  });
  const summary = {
    kind: SUMMARY_KIND,
    schemaVersion: TIME_AXIS_EVIDENCE_SCHEMA_VERSION,
    status,
    resultCode: resultCodeForStatus(status),
    coverage: {
      requiredScenarios: [...REQUIRED_TIME_AXIS_SCENARIOS],
      observedScenarios,
      sampleCountByScenario,
      completeRequiredScenarios,
    },
    metrics,
    t03Disposition,
    rampSupported: byScenario.has("ramp"),
    artifactSha256: normalizedReports.map((report) => sha256(stableStringify(report))).sort(),
  };
  return validateTimeAxisEvidenceSummary(summary);
}

export function validateTimeAxisEvidenceSummary(value) {
  const summary = structuredClone(requireRecord(value, "timeAxisEvidenceSummary"));
  assertKnownKeys(
    summary,
    [
      "kind",
      "schemaVersion",
      "status",
      "resultCode",
      "coverage",
      "metrics",
      "t03Disposition",
      "rampSupported",
      "artifactSha256",
    ],
    "timeAxisEvidenceSummary"
  );
  if (summary.kind !== SUMMARY_KIND) throw evidenceError("timeAxisEvidenceSummary.kind is unsupported");
  if (summary.schemaVersion !== TIME_AXIS_EVIDENCE_SCHEMA_VERSION) {
    throw evidenceError(
      `timeAxisEvidenceSummary.schemaVersion must be ${TIME_AXIS_EVIDENCE_SCHEMA_VERSION}`
    );
  }
  if (!SUMMARY_STATUSES.has(summary.status)) {
    throw evidenceError("timeAxisEvidenceSummary.status is invalid");
  }
  if (summary.resultCode !== resultCodeForStatus(summary.status)) {
    throw evidenceError("timeAxisEvidenceSummary.resultCode does not match status");
  }
  validateCoverage(summary.coverage);
  validateMetrics(summary.metrics, "timeAxisEvidenceSummary.metrics");
  if (!T03_DISPOSITIONS.has(summary.t03Disposition)) {
    throw evidenceError("timeAxisEvidenceSummary.t03Disposition is invalid");
  }
  if (typeof summary.rampSupported !== "boolean") {
    throw evidenceError("timeAxisEvidenceSummary.rampSupported must be boolean");
  }
  const artifactSha256 = requireArray(summary.artifactSha256, "timeAxisEvidenceSummary.artifactSha256");
  if (new Set(artifactSha256).size !== artifactSha256.length) {
    throw evidenceError("timeAxisEvidenceSummary.artifactSha256 must be unique");
  }
  for (const digest of artifactSha256) {
    if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
      throw evidenceError("timeAxisEvidenceSummary.artifactSha256 contains an invalid digest");
    }
  }

  const complete = summary.coverage.completeRequiredScenarios;
  const maximum = summary.metrics.nodeParityMaxDeviationSeconds;
  if (summary.status === "confirmed") {
    if (!complete || maximum === null || maximum > NODE_PARITY_MAX_DEVIATION_SECONDS) {
      throw evidenceError("confirmed TimeAxis parity requires complete passing coverage");
    }
    if (summary.t03Disposition !== "not_required") {
      throw evidenceError("confirmed TimeAxis parity must mark T03 not_required");
    }
  }
  if (summary.status === "contradicted") {
    if (!complete || maximum === null || maximum <= NODE_PARITY_MAX_DEVIATION_SECONDS) {
      throw evidenceError("contradicted TimeAxis parity requires complete failing coverage");
    }
    if (!["required", "repair_node_boundary_and_retest"].includes(summary.t03Disposition)) {
      throw evidenceError("contradicted TimeAxis parity has an invalid T03 disposition");
    }
  }
  if (summary.status === "partially_observed" && summary.t03Disposition !== "not_determined") {
    throw evidenceError("partial TimeAxis parity must leave T03 not_determined");
  }
  return deepFreeze(summary);
}

function normalizeTimeAxisInput({ scenario, quarterBlick, durationBlick, tempoMarks }) {
  if (!SCENARIOS.has(scenario)) throw evidenceError("scenario is unsupported");
  const normalizedQuarterBlick = requirePositiveSafeInteger(quarterBlick, "quarterBlick");
  const normalizedDurationBlick = requirePositiveSafeInteger(durationBlick, "durationBlick");
  const normalizedTempoMarks = requireArray(tempoMarks, "tempoMarks").map((value, index) => {
    const mark = requireRecord(value, `tempoMarks[${index}]`);
    assertKnownKeys(mark, ["positionBlick", "positionSeconds", "bpm"], `tempoMarks[${index}]`);
    return {
      positionBlick: requireSafeInteger(mark.positionBlick, `tempoMarks[${index}].positionBlick`),
      positionSeconds: requireFinite(mark.positionSeconds, `tempoMarks[${index}].positionSeconds`),
      bpm: requirePositiveFinite(mark.bpm, `tempoMarks[${index}].bpm`),
    };
  });
  if (normalizedTempoMarks.length === 0) throw evidenceError("tempoMarks must not be empty");
  normalizedTempoMarks.sort((left, right) => left.positionBlick - right.positionBlick);
  for (let index = 1; index < normalizedTempoMarks.length; index += 1) {
    const previous = normalizedTempoMarks[index - 1];
    const current = normalizedTempoMarks[index];
    if (current.positionBlick === previous.positionBlick) {
      throw evidenceError("tempoMarks must not contain duplicate positions");
    }
    if (current.positionSeconds < previous.positionSeconds) {
      throw evidenceError("tempoMarks.positionSeconds must be nondecreasing");
    }
  }
  const tempoChanges = normalizedTempoMarks.slice(1).filter(
    (mark, index) => mark.bpm !== normalizedTempoMarks[index].bpm
  ).length;
  if (scenario === "constant" && tempoChanges !== 0) {
    throw evidenceError("constant scenario must not contain a tempo change");
  }
  if (scenario === "tempo_step" && (normalizedTempoMarks.length !== 2 || tempoChanges !== 1)) {
    throw evidenceError("tempo_step scenario must contain exactly one tempo change");
  }
  if (scenario === "dense_tempo" && (normalizedTempoMarks.length < 3 || tempoChanges < 2)) {
    throw evidenceError("dense_tempo scenario must contain at least two tempo changes");
  }
  return {
    scenario,
    quarterBlick: normalizedQuarterBlick,
    durationBlick: normalizedDurationBlick,
    tempoMarks: normalizedTempoMarks,
  };
}

function normalizeHost(value) {
  if (value === undefined) return null;
  const host = requireRecord(value, "host");
  assertKnownKeys(host, ["hostVersion", "bridgeProtocolVersion", "bridgeSha256"], "host");
  const normalized = {};
  if (host.hostVersion !== undefined) {
    if (typeof host.hostVersion !== "string" || !host.hostVersion || /[\\/]/.test(host.hostVersion)) {
      throw evidenceError("host.hostVersion must be a non-path string");
    }
    normalized.hostVersion = host.hostVersion;
  }
  if (host.bridgeProtocolVersion !== undefined) {
    normalized.bridgeProtocolVersion = requirePositiveSafeInteger(
      host.bridgeProtocolVersion,
      "host.bridgeProtocolVersion"
    );
  }
  if (host.bridgeSha256 !== undefined) {
    if (!/^sha256:[0-9a-f]{64}$/.test(host.bridgeSha256)) {
      throw evidenceError("host.bridgeSha256 must be a sha256 digest");
    }
    normalized.bridgeSha256 = host.bridgeSha256;
  }
  return normalized;
}

function summarizeSamples(samples) {
  const positions = samples.map((sample) => sample.blick);
  return {
    sampleCount: samples.length,
    range: {
      fromBlick: Math.min(...positions),
      toBlick: Math.max(...positions),
    },
    nodeParitySeconds: distribution(samples.map((sample) => sample.secondsError)),
    nodeParityBlick: distribution(samples.map((sample) => sample.blickError)),
    hostRoundTripBlick: distribution(samples.map((sample) => sample.hostRoundTripBlickError)),
    nodeRoundTripBlick: distribution(samples.map((sample) => sample.nodeRoundTripBlickError)),
  };
}

function distribution(values) {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.some((value) => !Number.isFinite(value) || value < 0)) {
    throw evidenceError("distribution values must be finite nonnegative numbers");
  }
  const middle = sorted.length / 2;
  return {
    maximum: sorted[sorted.length - 1],
    median:
      sorted.length % 2 === 0
        ? (sorted[middle - 1] + sorted[middle]) / 2
        : sorted[Math.floor(middle)],
    p95: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)],
  };
}

function determineT03Disposition({ status, reports, metrics }) {
  if (status === "confirmed") return "not_required";
  if (status === "partially_observed") return "not_determined";
  const failingSamples = reports.flatMap((report) => report.samples.filter(
    (sample) => sample.secondsError > NODE_PARITY_MAX_DEVIATION_SECONDS
  ));
  const boundaryPositions = new Set();
  for (const report of reports) {
    for (const mark of report.timeAxis.tempoMarks) {
      for (const offset of [-1, 0, 1]) {
        const position = mark.positionBlick + offset;
        if (position >= 0 && position <= report.timeAxis.durationBlick) {
          boundaryPositions.add(position);
        }
      }
    }
  }
  const onlyBoundaryFailures =
    failingSamples.length > 0 && failingSamples.every((sample) => boundaryPositions.has(sample.blick));
  if (onlyBoundaryFailures && metrics.nodeParityMaxDeviationSeconds > NODE_PARITY_MAX_DEVIATION_SECONDS) {
    return "repair_node_boundary_and_retest";
  }
  return "required";
}

function resultCodeForStatus(status) {
  if (status === "confirmed") return "TIME_AXIS_NODE_PARITY_CONFIRMED";
  if (status === "contradicted") return "TIME_AXIS_NODE_PARITY_CONTRADICTED";
  return "TIME_AXIS_NODE_PARITY_PARTIAL";
}

function validateCoverage(value) {
  const coverage = requireRecord(value, "timeAxisEvidenceSummary.coverage");
  assertKnownKeys(
    coverage,
    ["requiredScenarios", "observedScenarios", "sampleCountByScenario", "completeRequiredScenarios"],
    "timeAxisEvidenceSummary.coverage"
  );
  if (stableStringify(coverage.requiredScenarios) !== stableStringify(REQUIRED_TIME_AXIS_SCENARIOS)) {
    throw evidenceError("timeAxisEvidenceSummary.coverage.requiredScenarios is invalid");
  }
  const observed = requireArray(coverage.observedScenarios, "timeAxisEvidenceSummary.coverage.observedScenarios");
  if (new Set(observed).size !== observed.length || observed.some((scenario) => !SCENARIOS.has(scenario))) {
    throw evidenceError("timeAxisEvidenceSummary.coverage.observedScenarios is invalid");
  }
  const counts = requireRecord(
    coverage.sampleCountByScenario,
    "timeAxisEvidenceSummary.coverage.sampleCountByScenario"
  );
  assertKnownKeys(counts, observed, "timeAxisEvidenceSummary.coverage.sampleCountByScenario");
  for (const scenario of observed) {
    requirePositiveSafeInteger(counts[scenario], `timeAxisEvidenceSummary.coverage.sampleCountByScenario.${scenario}`);
  }
  if (typeof coverage.completeRequiredScenarios !== "boolean") {
    throw evidenceError("timeAxisEvidenceSummary.coverage.completeRequiredScenarios must be boolean");
  }
  const expectedComplete = REQUIRED_TIME_AXIS_SCENARIOS.every(
    (scenario) => counts[scenario] >= TIME_AXIS_MINIMUM_SAMPLES
  );
  if (coverage.completeRequiredScenarios !== expectedComplete) {
    throw evidenceError("timeAxisEvidenceSummary.coverage.completeRequiredScenarios is inconsistent");
  }
}

function validateMetrics(value, label) {
  const metrics = requireRecord(value, label);
  const fields = [
    "sampleCount",
    "nodeParityMaxDeviationSeconds",
    "nodeParityMedianDeviationSeconds",
    "nodeParityP95DeviationSeconds",
    "nodeParityMaxDeviationBlick",
    "nodeParityMedianDeviationBlick",
    "nodeParityP95DeviationBlick",
    "hostRoundTripMaxDeviationBlick",
    "hostRoundTripMedianDeviationBlick",
    "hostRoundTripP95DeviationBlick",
    "nodeRoundTripMaxDeviationBlick",
    "nodeRoundTripMedianDeviationBlick",
    "nodeRoundTripP95DeviationBlick",
  ];
  assertKnownKeys(metrics, fields, label);
  requirePositiveSafeInteger(metrics.sampleCount, `${label}.sampleCount`);
  for (const field of fields.slice(1)) {
    const item = metrics[field];
    if (item !== null && (!Number.isFinite(item) || item < 0)) {
      throw evidenceError(`${label}.${field} must be a nonnegative finite number or null`);
    }
  }
  for (const prefix of [
    "nodeParity",
    "hostRoundTrip",
    "nodeRoundTrip",
  ]) {
    const maximum = metrics[`${prefix}MaxDeviation${prefix === "nodeParity" ? "Seconds" : "Blick"}`];
    const median = metrics[`${prefix}MedianDeviation${prefix === "nodeParity" ? "Seconds" : "Blick"}`];
    const p95 = metrics[`${prefix}P95Deviation${prefix === "nodeParity" ? "Seconds" : "Blick"}`];
    if (maximum !== null && ((median !== null && median > maximum) || (p95 !== null && p95 > maximum))) {
      throw evidenceError(`${label}.${prefix} distribution exceeds its maximum`);
    }
  }
}

function scenarioOrder(left, right) {
  const order = [...REQUIRED_TIME_AXIS_SCENARIOS, "ramp"];
  return order.indexOf(left) - order.indexOf(right);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertKnownKeys(value, allowed, label) {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) throw evidenceError(`${label} contains unknown field: ${unknown.join(", ")}`);
}

function requireRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw evidenceError(`${label} must be an object`);
  }
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) throw evidenceError(`${label} must be an array`);
  return value;
}

function requireSafeInteger(value, label) {
  if (!Number.isSafeInteger(value)) throw evidenceError(`${label} must be a safe integer`);
  return value;
}

function requirePositiveSafeInteger(value, label) {
  const result = requireSafeInteger(value, label);
  if (result < 1) throw evidenceError(`${label} must be positive`);
  return result;
}

function requireIntegerInRange(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw evidenceError(`${label} must be an integer in [${minimum}, ${maximum}]`);
  }
  return value;
}

function requireFinite(value, label) {
  if (!Number.isFinite(value)) throw evidenceError(`${label} must be finite`);
  return value;
}

function requirePositiveFinite(value, label) {
  const result = requireFinite(value, label);
  if (result <= 0) throw evidenceError(`${label} must be positive`);
  return result;
}

function evidenceError(message) {
  const error = new Error(message);
  error.code = "INVALID_TIME_AXIS_EVIDENCE";
  return error;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
