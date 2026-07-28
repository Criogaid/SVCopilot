import { createHash } from "node:crypto";

export const HOST_PROFILE_KIND = "svcopilot-host-profile";
export const HOST_PROFILE_SCHEMA_VERSION = "1.0.0";

export const HOST_SEMANTIC_KEYS = Object.freeze([
  "occurrence.referenceBoundsIndependentOfNoteBounds",
  "computedPitch.coordinateSpace",
  "computedPitch.pendingRepresentation",
  "pitchControl.ordering",
  "pitchControl.equalAnchorTieBreak",
  "pitchControl.add.returnIndexBase",
  "pitchControl.attachedSet.reorders",
  "pitchControl.clone.attachedAllowed",
  "pitchControl.clone.detachedSourceAllowed",
  "pitchControl.clone.detached",
  "pitchControl.clone.deepPoints",
  "pitchControl.clone.copiesScriptData",
  "pitchControl.remove.indexAfterRemove",
  "pitchControl.scriptData.missingValue",
  "pitchControl.numericStorage",
]);

const FACT_STATUSES = new Set(["confirmed", "contradicted", "unknown", "not_observable"]);
const EVIDENCE_SOURCES = new Set(["live_read_only", "official_doc", "live_reversible_write"]);
const EVIDENCE_SCOPES = new Set(["host_version", "fixture_observation"]);
const CONFIRMED_SEMANTIC_VALUES = Object.freeze({
  "occurrence.referenceBoundsIndependentOfNoteBounds": (value) => typeof value === "boolean",
  "computedPitch.coordinateSpace": oneOf("occurrence_absolute_blick", "group_local_blick"),
  "computedPitch.pendingRepresentation": oneOf("requested_length_null_array"),
  "pitchControl.ordering": oneOf(
    "position_ascending",
    "position_descending",
    "insertion_order"
  ),
  "pitchControl.equalAnchorTieBreak": oneOf("insertion_stable", "reverse_insertion"),
  "pitchControl.add.returnIndexBase": oneOf(0, 1),
  "pitchControl.attachedSet.reorders": (value) => typeof value === "boolean",
  "pitchControl.clone.attachedAllowed": (value) => typeof value === "boolean",
  "pitchControl.clone.detachedSourceAllowed": (value) => typeof value === "boolean",
  "pitchControl.clone.detached": (value) => typeof value === "boolean",
  "pitchControl.clone.deepPoints": (value) => typeof value === "boolean",
  "pitchControl.clone.copiesScriptData": (value) => typeof value === "boolean",
  "pitchControl.remove.indexAfterRemove": (value) => Number.isSafeInteger(value),
  "pitchControl.scriptData.missingValue": oneOf("undefined", "null"),
  "pitchControl.numericStorage": oneOf("double", "float32"),
});
const FORBIDDEN_PERSISTED_KEYS = new Set([
  "projectFileName",
  "trackName",
  "groupName",
  "targetGroupUuid",
  "lyrics",
  "phonemes",
  "notes",
  "points",
  "values",
]);

export function compileReadOnlyHostProfile({
  hostEnvelope,
  groupsEnvelope,
  pitchEnvelope,
  capturedAt = new Date().toISOString(),
} = {}) {
  const host = requireSuccessfulEnvelope(hostEnvelope, "host");
  const listed = requireSuccessfulEnvelope(groupsEnvelope, "groups");
  if (host.readOnly !== true) {
    throw profileError("host result must declare readOnly:true");
  }
  const hostInfo = requireRecord(host.hostInfo, "host.result.hostInfo");
  const groups = Array.isArray(listed.groups) ? listed.groups : [];
  const pitchAttempts = normalizePitchAttempts(pitchEnvelope);
  const groupEvidence = summarizeGroupEvidence(groups);
  const pitchEvidence = summarizePitchEvidence(pitchAttempts);
  const hostVersion = requireNonEmptyString(hostInfo.hostVersion, "hostInfo.hostVersion");
  const platform = normalizePlatform(hostInfo.osType);
  const profileId = `synthv-${hostVersion}-${platform}-readonly-v1`;

  const evidence = [
    {
      id: "EV-OCCURRENCE-BOUNDS-1",
      source: "live_read_only",
      scope: "fixture_observation",
      supports: ["occurrence.referenceBoundsIndependentOfNoteBounds"],
      oracleVersion: 1,
      resultCode: groupEvidence.resultCode,
      sampleCount: groupEvidence.sampleCount,
    },
    {
      id: "EV-COMPUTED-PITCH-1",
      source: "live_read_only",
      scope: "fixture_observation",
      supports: [
        "computedPitch.coordinateSpace",
        "computedPitch.pendingRepresentation",
      ],
      oracleVersion: 1,
      resultCode: pitchEvidence.resultCode,
      sampleCount: pitchEvidence.sampleCount,
      ...(pitchEvidence.requestedFrames
        ? { requestedFrames: pitchEvidence.requestedFrames }
        : {}),
    },
  ];
  const semantics = {
    "occurrence.referenceBoundsIndependentOfNoteBounds": groupEvidence.divergenceObserved
      ? confirmedFact(true, ["EV-OCCURRENCE-BOUNDS-1"])
      : unknownFact("NO_REFERENCE_BOUND_DIVERGENCE_OBSERVED", ["EV-OCCURRENCE-BOUNDS-1"]),
    "computedPitch.coordinateSpace": unknownFact(
      pitchEvidence.coordinateResultsDiffer
        ? "COORDINATE_RESULTS_DIFFER_WITHOUT_ORACLE"
        : "NO_DISCRIMINATING_FINITE_FRAMES",
      ["EV-COMPUTED-PITCH-1"]
    ),
    "computedPitch.pendingRepresentation": pitchEvidence.stableAllNull
      ? confirmedFact("requested_length_null_array", ["EV-COMPUTED-PITCH-1"])
      : unknownFact("NO_STABLE_ALL_NULL_OBSERVATION", ["EV-COMPUTED-PITCH-1"]),
    ...pitchControlUnknownFacts(),
  };
  const sanitizedEvidence = {
    hostSelector: {
      product: requireNonEmptyString(hostInfo.hostName, "hostInfo.hostName"),
      version: hostVersion,
      versionNumber: requireSafeInteger(hostInfo.hostVersionNumber, "hostInfo.hostVersionNumber"),
      platform,
    },
    quarterBlick: requirePositiveSafeInteger(host.quarterBlick, "host.quarterBlick"),
    evidence,
    semantics,
  };
  const profile = {
    kind: HOST_PROFILE_KIND,
    schemaVersion: HOST_PROFILE_SCHEMA_VERSION,
    profileRevision: 1,
    profileId,
    hostSelector: sanitizedEvidence.hostSelector,
    producer: {
      probe: "SVLiveProbe",
      probeProtocolVersion: requirePositiveSafeInteger(
        host.protocolVersion,
        "host.protocolVersion"
      ),
      suite: "common-readonly",
      suiteVersion: 1,
      sanitizerVersion: 1,
      readOnly: true,
    },
    capturedAt,
    evidenceSha256: sha256(stableStringify(sanitizedEvidence)),
    constants: {
      quarterBlick: sanitizedEvidence.quarterBlick,
    },
    semantics,
    evidence,
  };
  return validateHostBehaviorProfile(profile);
}

export function validateHostBehaviorProfile(value) {
  const profile = structuredClone(requireRecord(value, "profile"));
  assertKnownKeys(
    profile,
    [
      "kind",
      "schemaVersion",
      "profileRevision",
      "profileId",
      "hostSelector",
      "producer",
      "capturedAt",
      "evidenceSha256",
      "constants",
      "semantics",
      "evidence",
    ],
    "profile"
  );
  if (profile.kind !== HOST_PROFILE_KIND) throw profileError("profile.kind is unsupported");
  if (profile.schemaVersion !== HOST_PROFILE_SCHEMA_VERSION) {
    throw profileError(`profile.schemaVersion must be ${HOST_PROFILE_SCHEMA_VERSION}`);
  }
  requirePositiveSafeInteger(profile.profileRevision, "profile.profileRevision");
  requireNonEmptyString(profile.profileId, "profile.profileId");
  validateHostSelector(profile.hostSelector);
  validateProducer(profile.producer);
  if (!Number.isFinite(Date.parse(profile.capturedAt))) {
    throw profileError("profile.capturedAt must be an ISO timestamp");
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(profile.evidenceSha256)) {
    throw profileError("profile.evidenceSha256 must be a sha256 digest");
  }
  const constants = requireRecord(profile.constants, "profile.constants");
  assertKnownKeys(constants, ["quarterBlick"], "profile.constants");
  requirePositiveSafeInteger(constants.quarterBlick, "profile.constants.quarterBlick");

  const evidence = requireArray(profile.evidence, "profile.evidence");
  const evidenceById = new Map();
  for (const [index, item] of evidence.entries()) {
    validateEvidence(item, index);
    if (evidenceById.has(item.id)) throw profileError(`duplicate evidence id: ${item.id}`);
    evidenceById.set(item.id, item);
  }
  const semantics = requireRecord(profile.semantics, "profile.semantics");
  assertKnownKeys(semantics, HOST_SEMANTIC_KEYS, "profile.semantics");
  for (const key of HOST_SEMANTIC_KEYS) {
    validateFact(semantics[key], key, evidenceById);
  }
  privacyLint(profile);
  const expectedDigest = sha256(
    stableStringify({
      hostSelector: profile.hostSelector,
      quarterBlick: constants.quarterBlick,
      evidence,
      semantics,
    })
  );
  if (profile.evidenceSha256 !== expectedDigest) {
    throw profileError("profile.evidenceSha256 does not match the profile evidence");
  }
  return deepFreeze(profile);
}

export function diffHostBehaviorProfiles(baselineValue, candidateValue) {
  const baseline = validateHostBehaviorProfile(baselineValue);
  const candidate = validateHostBehaviorProfile(candidateValue);
  const selectorChanged =
    stableStringify(baseline.hostSelector) !== stableStringify(candidate.hostSelector);
  const semanticChanges = [];
  const constantChanges = [];
  for (const key of new Set([
    ...Object.keys(baseline.constants),
    ...Object.keys(candidate.constants),
  ])) {
    if (!Object.is(baseline.constants[key], candidate.constants[key])) {
      constantChanges.push({
        key,
        before: baseline.constants[key],
        after: candidate.constants[key],
      });
    }
  }
  for (const key of HOST_SEMANTIC_KEYS) {
    const before = baseline.semantics[key];
    const after = candidate.semantics[key];
    if (stableStringify(before) !== stableStringify(after)) {
      semanticChanges.push({ key, before, after });
    }
  }
  const producerChanged =
    stableStringify(baseline.producer) !== stableStringify(candidate.producer);
  const evidenceChanged =
    stableStringify(baseline.evidence) !== stableStringify(candidate.evidence);
  return {
    compatibleHost: !selectorChanged,
    selectorChanged,
    producerChanged,
    evidenceChanged,
    constantChanges,
    semanticChanges,
    changed:
      selectorChanged ||
      producerChanged ||
      evidenceChanged ||
      constantChanges.length > 0 ||
      semanticChanges.length > 0,
  };
}

export function hostModelDefaultsFromProfile(value) {
  const profile = validateHostBehaviorProfile(value);
  return {
    quarterBlick: profile.constants.quarterBlick,
    hostVersion: profile.hostSelector.version,
  };
}

export function computedPitchScenarioFromProfile(value) {
  const profile = validateHostBehaviorProfile(value);
  const fact = profile.semantics["computedPitch.pendingRepresentation"];
  if (fact.status !== "confirmed" || fact.value !== "requested_length_null_array") {
    const error = profileError("profile has no confirmed all-null computed-pitch scenario");
    error.code = "HOST_PROFILE_SCENARIO_UNAVAILABLE";
    throw error;
  }
  const evidence = profile.evidence.find((item) => fact.evidenceIds.includes(item.id));
  const frames = evidence?.requestedFrames;
  if (!Number.isSafeInteger(frames) || frames < 1) {
    const error = profileError("computed-pitch evidence does not declare requestedFrames");
    error.code = "HOST_PROFILE_SCENARIO_UNAVAILABLE";
    throw error;
  }
  return {
    computedPitchValues: new Array(frames).fill(null),
    frames,
    state: "all_null",
  };
}

function summarizeGroupEvidence(groups) {
  const targetCounts = new Map();
  let sampleCount = 0;
  let onsetDivergence = 0;
  let endDivergence = 0;
  for (const group of groups) {
    if (!group || typeof group !== "object" || group.instrumental === true) continue;
    if (!Number.isSafeInteger(group.noteCount) || group.noteCount < 1) continue;
    if (
      !Number.isSafeInteger(group.referenceOnsetBlick) ||
      !Number.isSafeInteger(group.referenceEndBlick) ||
      !Number.isSafeInteger(group.timeOffsetBlick) ||
      !Number.isSafeInteger(group.targetFirstNoteOnsetBlick) ||
      !Number.isSafeInteger(group.targetLastNoteEndBlick)
    ) {
      continue;
    }
    sampleCount += 1;
    if (group.referenceOnsetBlick !== group.timeOffsetBlick + group.targetFirstNoteOnsetBlick) {
      onsetDivergence += 1;
    }
    if (group.referenceEndBlick !== group.timeOffsetBlick + group.targetLastNoteEndBlick) {
      endDivergence += 1;
    }
    if (typeof group.targetGroupUuid === "string" && group.targetGroupUuid) {
      targetCounts.set(group.targetGroupUuid, (targetCounts.get(group.targetGroupUuid) ?? 0) + 1);
    }
  }
  const sharedTargetSets = [...targetCounts.values()].filter((count) => count > 1).length;
  return {
    sampleCount,
    divergenceObserved: onsetDivergence > 0 || endDivergence > 0,
    resultCode:
      onsetDivergence > 0 || endDivergence > 0
        ? "REFERENCE_BOUNDS_DIVERGE_FROM_NOTE_BOUNDS"
        : "NO_REFERENCE_BOUND_DIVERGENCE",
    sharedTargetSets,
  };
}

function summarizePitchEvidence(attempts) {
  const official = attempts.map((item) => requireRecord(item.officialAbsolute, "officialAbsolute"));
  const legacy = attempts.map((item) => requireRecord(item.legacySubtractOffset, "legacySubtractOffset"));
  const requestedFrameCounts = new Set(
    [...official, ...legacy].map((item) => item.requestedFrames)
  );
  const stableAllNull =
    official.length >= 2 &&
    requestedFrameCounts.size === 1 &&
    [...official, ...legacy].every(
      (item) =>
        Number.isSafeInteger(item.requestedFrames) &&
        item.requestedFrames > 0 &&
        item.numericCount === 0 &&
        item.nullCount === item.requestedFrames
    );
  const coordinateResultsDiffer = attempts.some((item, index) => {
    if (item.startsAreEqual === true) return false;
    const a = pitchSignature(official[index]);
    const b = pitchSignature(legacy[index]);
    return a.numericCount > 0 && stableStringify(a) !== stableStringify(b);
  });
  const requestedFrames =
    official.length > 0 && Number.isSafeInteger(official[0].requestedFrames)
      ? official[0].requestedFrames
      : null;
  return {
    sampleCount: attempts.length,
    requestedFrames,
    stableAllNull,
    coordinateResultsDiffer,
    resultCode: coordinateResultsDiffer
      ? "COORDINATE_RESULTS_DIFFER_WITHOUT_ORACLE"
      : stableAllNull
        ? "BOTH_COORDINATES_STABLE_ALL_NULL"
        : "NO_DISCRIMINATING_FINITE_FRAMES",
  };
}

function normalizePitchAttempts(envelope) {
  const source = requireRecord(envelope, "pitch");
  if (Array.isArray(source.observations)) {
    return source.observations.map((item, index) =>
      requireSuccessfulEnvelope(item, `pitch.observations[${index}]`)
    );
  }
  return [requireSuccessfulEnvelope(source, "pitch")];
}

function pitchSignature(item) {
  return {
    requestedFrames: item.requestedFrames,
    rawLuaLength: item.rawLuaLength,
    rawNumericKeyCount: item.rawNumericKeyCount,
    numericCount: item.numericCount,
    nullCount: item.nullCount,
    firstNumericIndex: item.firstNumericIndex,
    lastNumericIndex: item.lastNumericIndex,
    min: item.min,
    max: item.max,
  };
}

function pitchControlUnknownFacts() {
  return Object.fromEntries(
    HOST_SEMANTIC_KEYS.filter((key) => key.startsWith("pitchControl.")).map((key) => [
      key,
      notObservableFact("REQUIRES_REVERSIBLE_MUTATION"),
    ])
  );
}

function confirmedFact(value, evidenceIds) {
  return { status: "confirmed", value, evidenceIds };
}

function unknownFact(reason, evidenceIds = []) {
  return { status: "unknown", reason, evidenceIds };
}

function notObservableFact(reason) {
  return { status: "not_observable", reason, evidenceIds: [] };
}

function validateHostSelector(value) {
  const selector = requireRecord(value, "profile.hostSelector");
  assertKnownKeys(selector, ["product", "version", "versionNumber", "platform"], "profile.hostSelector");
  requireNonEmptyString(selector.product, "profile.hostSelector.product");
  requireNonEmptyString(selector.version, "profile.hostSelector.version");
  requireSafeInteger(selector.versionNumber, "profile.hostSelector.versionNumber");
  requireNonEmptyString(selector.platform, "profile.hostSelector.platform");
}

function validateProducer(value) {
  const producer = requireRecord(value, "profile.producer");
  assertKnownKeys(
    producer,
    [
      "probe",
      "probeProtocolVersion",
      "suite",
      "suiteVersion",
      "sanitizerVersion",
      "readOnly",
    ],
    "profile.producer"
  );
  if (producer.probe !== "SVLiveProbe") throw profileError("profile.producer.probe is unsupported");
  requirePositiveSafeInteger(producer.probeProtocolVersion, "profile.producer.probeProtocolVersion");
  if (producer.suite !== "common-readonly") {
    throw profileError("profile.producer.suite is unsupported");
  }
  requirePositiveSafeInteger(producer.suiteVersion, "profile.producer.suiteVersion");
  requirePositiveSafeInteger(producer.sanitizerVersion, "profile.producer.sanitizerVersion");
  if (producer.readOnly !== true) throw profileError("profile.producer.readOnly must be true");
}

function validateEvidence(value, index) {
  const label = `profile.evidence[${index}]`;
  const evidence = requireRecord(value, label);
  assertKnownKeys(
    evidence,
    [
      "id",
      "source",
      "scope",
      "supports",
      "oracleVersion",
      "resultCode",
      "sampleCount",
      "requestedFrames",
    ],
    label
  );
  requireNonEmptyString(evidence.id, `${label}.id`);
  if (!EVIDENCE_SOURCES.has(evidence.source)) throw profileError(`${label}.source is invalid`);
  if (!EVIDENCE_SCOPES.has(evidence.scope)) throw profileError(`${label}.scope is invalid`);
  const supports = requireArray(evidence.supports, `${label}.supports`);
  if (supports.length === 0 || new Set(supports).size !== supports.length) {
    throw profileError(`${label}.supports must contain unique semantic keys`);
  }
  for (const key of supports) {
    if (!HOST_SEMANTIC_KEYS.includes(key)) {
      throw profileError(`${label}.supports contains an unknown semantic key`);
    }
  }
  requirePositiveSafeInteger(evidence.oracleVersion, `${label}.oracleVersion`);
  if (!/^[A-Z0-9_]+$/.test(evidence.resultCode)) {
    throw profileError(`${label}.resultCode must be an uppercase code`);
  }
  requirePositiveSafeInteger(evidence.sampleCount, `${label}.sampleCount`);
  if (evidence.requestedFrames !== undefined) {
    requirePositiveSafeInteger(evidence.requestedFrames, `${label}.requestedFrames`);
  }
}

function validateFact(value, key, evidenceById) {
  const label = `profile.semantics.${key}`;
  const fact = requireRecord(value, label);
  assertKnownKeys(fact, ["status", "value", "reason", "evidenceIds"], label);
  if (!FACT_STATUSES.has(fact.status)) throw profileError(`${label}.status is invalid`);
  const refs = requireArray(fact.evidenceIds, `${label}.evidenceIds`);
  for (const id of refs) {
    if (typeof id !== "string" || !evidenceById.has(id)) {
      throw profileError(`${label}.evidenceIds contains an unknown id`);
    }
    if (!evidenceById.get(id).supports.includes(key)) {
      throw profileError(`${label}.evidenceIds contains evidence for another semantic`);
    }
  }
  if (fact.status === "confirmed" && !Object.hasOwn(fact, "value")) {
    throw profileError(`${label}.value is required when confirmed`);
  }
  if (fact.status === "confirmed" && refs.length === 0) {
    throw profileError(`${label}.evidenceIds must not be empty when confirmed`);
  }
  if (
    fact.status === "confirmed" &&
    !CONFIRMED_SEMANTIC_VALUES[key](fact.value)
  ) {
    throw profileError(`${label}.value is not supported for this semantic`);
  }
  if (
    fact.status === "confirmed" &&
    !refs.some((id) => evidenceCanConfirm(key, evidenceById.get(id)))
  ) {
    throw profileError(`${label}.evidenceIds do not contain confirmation-grade evidence`);
  }
  if (fact.status !== "confirmed" && Object.hasOwn(fact, "value")) {
    throw profileError(`${label}.value is forbidden unless confirmed`);
  }
  if (
    (fact.status === "unknown" || fact.status === "not_observable") &&
    (typeof fact.reason !== "string" || !fact.reason)
  ) {
    throw profileError(`${label}.reason is required for ${fact.status}`);
  }
}

function privacyLint(value, path = "profile") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => privacyLint(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && /[\\/]/.test(value)) {
      throw profileError(`${path} contains a path separator`);
    }
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_PERSISTED_KEYS.has(key)) {
      throw profileError(`${path}.${key} is forbidden by the profile privacy contract`);
    }
    privacyLint(nested, `${path}.${key}`);
  }
}

function evidenceCanConfirm(key, evidence) {
  if (key.startsWith("pitchControl.")) {
    return evidence.source === "live_reversible_write";
  }
  if (key === "computedPitch.coordinateSpace") {
    return (
      evidence.source === "official_doc" ||
      evidence.resultCode === "ABSOLUTE_COORDINATE_MATCHES_ORACLE"
    );
  }
  if (key === "computedPitch.pendingRepresentation") {
    return (
      evidence.source === "live_read_only" &&
      evidence.resultCode === "BOTH_COORDINATES_STABLE_ALL_NULL" &&
      evidence.sampleCount >= 2
    );
  }
  if (key === "occurrence.referenceBoundsIndependentOfNoteBounds") {
    return (
      evidence.source === "live_read_only" &&
      evidence.resultCode === "REFERENCE_BOUNDS_DIVERGE_FROM_NOTE_BOUNDS"
    );
  }
  return false;
}

function requireSuccessfulEnvelope(value, label) {
  const envelope = requireRecord(value, label);
  if (envelope.ok !== true) throw profileError(`${label} probe request did not succeed`);
  return requireRecord(envelope.result, `${label}.result`);
}

function normalizePlatform(osType) {
  const source = String(osType ?? "").toLowerCase();
  if (source.includes("windows")) return "win32";
  if (source.includes("mac")) return "darwin";
  if (source.includes("linux")) return "linux";
  return "unknown";
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
  if (unknown.length > 0) throw profileError(`${label} contains unknown field: ${unknown.join(", ")}`);
}

function requireRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw profileError(`${label} must be an object`);
  }
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) throw profileError(`${label} must be an array`);
  return value;
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || !value) throw profileError(`${label} must be a non-empty string`);
  return value;
}

function requireSafeInteger(value, label) {
  if (!Number.isSafeInteger(value)) throw profileError(`${label} must be a safe integer`);
  return value;
}

function requirePositiveSafeInteger(value, label) {
  const result = requireSafeInteger(value, label);
  if (result < 1) throw profileError(`${label} must be positive`);
  return result;
}

function oneOf(...allowed) {
  return (value) => allowed.some((candidate) => Object.is(candidate, value));
}

function profileError(message) {
  const error = new Error(message);
  error.code = "INVALID_HOST_PROFILE";
  return error;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
