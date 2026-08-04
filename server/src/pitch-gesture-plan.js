import { canonicalHashHex, contentHash } from "./canonical-json.js";
import { encodeDense, decodeDense } from "./dense-codec.js";
import { planReference } from "./artifact-store.js";
import { buildPlanArtifact } from "./plan-reference.js";
import { buildApplyEnvelope, planSealError, sealApplyEnvelope } from "./plan-envelope.js";
import { blickAtSeconds, secondsAtBlick } from "./musical-time.js";
import { analyzeVocalEventSequence } from "./vocal-event-semantics.js";
import { unknownContextError } from "./snapshot.js";
import { resolveMutationScope, resolveNoteIndex } from "./scope-source.js";
import {
  PITCH_DELTA_LIMIT_CENT,
  TRANSIENT_TAPER_RATIO,
  compileFirstPeakTransient,
  compilePitchDeltaTransition,
  timeVaryingVibrato,
} from "../../docs/pitch-techniques/reference/model.mjs";
import { normalizeTechniqueIr } from "./pitch-techniques/ir.js";
import { composeTechniqueContributions } from "./pitch-techniques/compose.js";
import { compilePitchDeltaMutationPlan } from "./pitch-techniques/pitch-delta-compiler.js";
import { buildHostInterpolationPostcondition } from "./pitch-techniques/host-interpolation.js";
import { buildUniformSecondsGrid } from "./pitch-techniques/time-grid.js";
import {
  captureRemediation,
  createCapturedAutomationBaseline,
  evaluateAutomationPoints,
  evaluateCapturedAutomation,
  replaceAutomationPoints,
} from "./pitch-techniques/automation-baseline.js";

export const PITCH_GESTURE_DEFAULTS = Object.freeze({
  retainCorrectionTarget: false,
  constraints: Object.freeze({
    maxAbsPeakSemitone: 1.5,
    maxTotalPoints: 1200,
    maxFitErrorCent: 1,
  }),
});
export const PITCH_GESTURE_TYPES = Object.freeze(["transition", "transient", "vibrato"]);

const MAX_GESTURES = 32;
const MAX_VERIFICATION_MANDATORY_SAMPLES = 256;
const MAX_VERIFICATION_ADAPTIVE_SAMPLES = 128;
const BASE_SAMPLE_INTERVAL_SECONDS = 0.004;
const CENT_QUANTUM = 1e-6;
const SECOND_QUANTUM = 1e-9;
const PHASE_LIMIT_RAD = 6.283185307179;

const DENSE_POINT_PROFILE = Object.freeze({
  schemaVersion: "1",
  kind: "pitch-technique-automation-points",
  maxRows: 2000,
  columns: Object.freeze([
    Object.freeze({ name: "blick", unit: "blick", type: "integer", encoding: "delta" }),
    Object.freeze({
      name: "value",
      unit: "parameter_value",
      type: "number",
      encoding: "qint",
      scale: CENT_QUANTUM,
      maxError: CENT_QUANTUM / 2,
    }),
  ]),
});

const CORRECTION_TARGET_PROFILE = Object.freeze({
  schemaVersion: "1",
  kind: "pitch-technique-correction-target",
  maxRows: 4000,
  columns: Object.freeze([
    Object.freeze({ name: "frame", type: "integer", encoding: "delta" }),
    Object.freeze({
      name: "targetCent",
      unit: "cent",
      type: "number",
      encoding: "qint",
      scale: CENT_QUANTUM,
      maxError: CENT_QUANTUM / 2,
    }),
  ]),
});

// P2 固定写 Automation：PitchControlCurve 仍是 H3 门禁后的独立增量，不能借旧 planner 偷渡。
const PROVENANCE = Object.freeze({
  planner: "pitch_technique_automation_v1",
  writeSurface: "pitchDelta",
  composition: "baseline_plus_contribution",
  verification: "captured_interpolation_then_host_get",
  perception: "human_only",
});

export class PitchGesturePlanService {
  constructor({
    store,
    now = () => Date.now(),
    artifactStore = null,
    sessionId = null,
    hostProfile = null,
    hostProfileProvider = null,
    hostProfileHash = null,
  } = {}) {
    if (!store) throw new Error("PitchGesturePlanService requires the shared SnapshotStore");
    this.store = store;
    this.now = now;
    this.artifactStore = artifactStore;
    this.sessionId = sessionId;
    this.hostProfile = hostProfile;
    this.hostProfileProvider = typeof hostProfileProvider === "function" ? hostProfileProvider : null;
    this.hostProfileHash = hostProfileHash ?? profileHash(hostProfile);
  }

  async plan(request = {}) {
    const input = normalizePlanRequest(request);
    const warnings = [];
    const loaded = resolvePlanSource(this.store, input);
    // 重连后同一版本号也可能不再代表同一宿主产品，故在每次规划时重新选择 profile。
    const hostProfile = this.hostProfileProvider ? this.hostProfileProvider() : this.hostProfile;
    const hostProfileHash = this.hostProfileProvider
      ? profileHash(hostProfile)
      : this.hostProfileHash;
    const selected = resolveAndSelectGestures(input.gestures, loaded, warnings);
    if (selected.length === 0) {
      return noChangeResponse(input, warnings);
    }

    const requiresVibratoEnvelope = selected.some(({ gesture }) => gesture.type === "vibrato");
    const baselines = loadCapturedBaselines(loaded, requiresVibratoEnvelope);
    const techniques = buildTechniqueCandidates(selected, loaded, input);
    const ir = buildTechniqueIr({
      input,
      loaded,
      techniques,
      baselines,
      hostProfileHash,
    });
    const vibratoGate = requiresVibratoEnvelope
      ? requireVibratoGate(hostProfile, selected)
      : null;

    const compiled = compileAutomationPlan({
      input,
      loaded,
      ir,
      baselines,
      vibratoGate,
    });
    warnings.push(...compiled.warnings);
    if (compiled.curves.length === 0) {
      return noChangeResponse(input, warnings, { techniques: ir.techniques.length });
    }
    return sealPlanResponse({
      input,
      loaded,
      ir,
      compiled,
      warnings,
      artifactStore: this.artifactStore,
      sessionId: this.sessionId,
    });
  }
}

function normalizePlanRequest(request) {
  if (!isRecord(request)) throw codedError("INVALID_ARGUMENTS", "request must be an object");
  assertKnownKeys(
    request,
    ["contextId", "occurrence", "gestures", "retainCorrectionTarget", "constraints"],
    "request",
  );
  if (typeof request.contextId !== "string" || request.contextId.length === 0) {
    throw codedError("INVALID_ARGUMENTS", "contextId must be a non-empty string");
  }
  if (!Number.isSafeInteger(request.occurrence) || request.occurrence < 0) {
    throw codedError("INVALID_ARGUMENTS", "occurrence must be a non-negative safe integer");
  }
  if (!Array.isArray(request.gestures) || request.gestures.length === 0 || request.gestures.length > MAX_GESTURES) {
    throw codedError("INVALID_ARGUMENTS", `gestures must contain 1-${MAX_GESTURES} items`);
  }
  if (
    request.retainCorrectionTarget !== undefined
    && typeof request.retainCorrectionTarget !== "boolean"
  ) {
    throw codedError("INVALID_ARGUMENTS", "retainCorrectionTarget must be a boolean");
  }
  return {
    contextId: request.contextId,
    occurrence: request.occurrence,
    gestures: request.gestures.map(normalizeGesture),
    retainCorrectionTarget:
      request.retainCorrectionTarget ?? PITCH_GESTURE_DEFAULTS.retainCorrectionTarget,
    constraints: normalizeConstraints(request.constraints),
  };
}

function normalizeGesture(value, index) {
  const path = `gestures[${index}]`;
  if (!isRecord(value)) throw codedError("INVALID_ARGUMENTS", `${path} must be an object`);
  if (!PITCH_GESTURE_TYPES.includes(value.type)) {
    throw codedError("INVALID_ARGUMENTS", `${path}.type must be transition, transient, or vibrato`);
  }
  if (value.type === "transition") return normalizeTransition(value, path);
  if (value.type === "transient") return normalizeTransient(value, path);
  return normalizeVibrato(value, path);
}

function normalizeTransition(value, path) {
  assertKnownKeys(value, ["type", "from", "to", "priority", "width", "curve"], path);
  requireNoteIndex(value.from, `${path}.from`);
  requireNoteIndex(value.to, `${path}.to`);
  if (value.from === value.to) {
    throw codedError("INVALID_ARGUMENTS", `${path}.from and ${path}.to must differ`);
  }
  if (!isRecord(value.width)) throw codedError("INVALID_ARGUMENTS", `${path}.width must be an object`);
  assertKnownKeys(value.width, ["seconds"], `${path}.width`);
  requireNumber(value.width.seconds, 1e-9, 2, `${path}.width.seconds`);
  if (!isRecord(value.curve)) throw codedError("INVALID_ARGUMENTS", `${path}.curve must be an object`);
  if (value.curve.family === "linear") {
    assertKnownKeys(value.curve, ["family"], `${path}.curve`);
    return {
      type: "transition",
      from: value.from,
      to: value.to,
      priority: normalizePriority(value.priority, `${path}.priority`),
      width: { seconds: value.width.seconds },
      curve: { family: "linear" },
    };
  }
  if (value.curve.family !== "richards") {
    throw codedError("INVALID_ARGUMENTS", `${path}.curve.family must be linear or richards`);
  }
  assertKnownKeys(
    value.curve,
    ["family", "inflectionRatio", "sharpness", "asymmetryLogB"],
    `${path}.curve`,
  );
  return {
    type: "transition",
    from: value.from,
    to: value.to,
    priority: normalizePriority(value.priority, `${path}.priority`),
    width: { seconds: value.width.seconds },
    curve: {
      family: "richards",
      inflectionRatio: optionalNumber(value.curve.inflectionRatio, 0.05, 0.95, 0.5, `${path}.curve.inflectionRatio`),
      sharpness: optionalNumber(value.curve.sharpness, 1, 40, 6, `${path}.curve.sharpness`),
      asymmetryLogB: optionalNumber(value.curve.asymmetryLogB, -3, 3, 0, `${path}.curve.asymmetryLogB`),
    },
  };
}

function normalizeTransient(value, path) {
  assertKnownKeys(
    value,
    [
      "type",
      "note",
      "intent",
      "priority",
      "peakSemitone",
      "peakTimeSeconds",
      "dampingRatio",
      "onsetSeconds",
      "spanSeconds",
      "tailPolicy",
    ],
    path,
  );
  requireNoteIndex(value.note, `${path}.note`);
  if (!["overshoot", "preparation"].includes(value.intent)) {
    throw codedError("INVALID_ARGUMENTS", `${path}.intent must be overshoot or preparation`);
  }
  requireNumber(value.peakSemitone, -1.5, 1.5, `${path}.peakSemitone`);
  requireNumber(value.peakTimeSeconds, 0.005, 0.5, `${path}.peakTimeSeconds`);
  requireNumber(value.spanSeconds, 1e-9, 2, `${path}.spanSeconds`);
  const dampingRatio = optionalNumber(
    value.dampingRatio,
    0,
    1,
    value.intent === "overshoot" ? 0.5422 : 0.6681,
    `${path}.dampingRatio`,
  );
  const tailPolicy = value.tailPolicy ?? "reject";
  if (!["reject", "continuous_taper"].includes(tailPolicy)) {
    throw codedError("INVALID_ARGUMENTS", `${path}.tailPolicy must be reject or continuous_taper`);
  }
  if (dampingRatio === 0 && tailPolicy !== "continuous_taper") {
    throw codedError(
      "UNDAMPED_TAIL_REQUIRES_TAPER",
      `${path}: dampingRatio 0 requires tailPolicy continuous_taper`,
      { dampingRatio, tailPolicy },
    );
  }
  if (value.peakTimeSeconds >= value.spanSeconds) {
    throw codedError("INVALID_ARGUMENTS", `${path}.peakTimeSeconds must be below spanSeconds`);
  }
  return {
    type: "transient",
    note: value.note,
    intent: value.intent,
    priority: normalizePriority(value.priority, `${path}.priority`),
    peakSemitone: value.peakSemitone,
    peakTimeSeconds: value.peakTimeSeconds,
    dampingRatio,
    onsetSeconds: optionalNumber(value.onsetSeconds, -0.5, 0.5, 0, `${path}.onsetSeconds`),
    spanSeconds: value.spanSeconds,
    tailPolicy,
  };
}

function normalizeVibrato(value, path) {
  if (value.source === "explicit_pitch_delta") {
    assertKnownKeys(
      value,
      [
        "type",
        "source",
        "note",
        "priority",
        "startRatio",
        "endRatio",
        "rateHz",
        "endRateHz",
        "depthSemitone",
        "endDepthSemitone",
        "centerDriftSemitone",
        "phaseRad",
        "fadeInSeconds",
        "fadeOutSeconds",
      ],
      path,
    );
    requireNoteIndex(value.note, `${path}.note`);
    const startRatio = optionalNumber(value.startRatio, 0, 1, 0, `${path}.startRatio`);
    const endRatio = optionalNumber(value.endRatio, 0, 1, 1, `${path}.endRatio`);
    assertStrictOrder(startRatio, endRatio, "startRatio", "endRatio", path);
    const rateHz = optionalNumber(value.rateHz, 0.5, 12, 5.5, `${path}.rateHz`);
    const depthSemitone = optionalNumber(value.depthSemitone, 0.01, 2, 0.3, `${path}.depthSemitone`);
    return {
      type: "vibrato",
      source: "explicit_pitch_delta",
      note: value.note,
      priority: normalizePriority(value.priority, `${path}.priority`),
      startRatio,
      endRatio,
      rateHz,
      endRateHz: optionalNumber(value.endRateHz, 0.5, 12, rateHz, `${path}.endRateHz`),
      depthSemitone,
      endDepthSemitone: optionalNumber(
        value.endDepthSemitone,
        0.01,
        2,
        depthSemitone,
        `${path}.endDepthSemitone`,
      ),
      centerDriftSemitone: optionalNumber(value.centerDriftSemitone, -1, 1, 0, `${path}.centerDriftSemitone`),
      phaseRad: optionalNumber(value.phaseRad, -PHASE_LIMIT_RAD, PHASE_LIMIT_RAD, 0, `${path}.phaseRad`),
      fadeInSeconds: optionalNumber(value.fadeInSeconds, 1e-9, 1, 0.3, `${path}.fadeInSeconds`),
      fadeOutSeconds: optionalNumber(value.fadeOutSeconds, 1e-9, 1, 0.2, `${path}.fadeOutSeconds`),
    };
  }
  if (value.source !== "host_envelope") {
    throw codedError("INVALID_ARGUMENTS", `${path}.source must be explicit_pitch_delta or host_envelope`);
  }
  assertKnownKeys(
    value,
    ["type", "source", "note", "priority", "startRatio", "endRatio", "envelopeScale"],
    path,
  );
  requireNoteIndex(value.note, `${path}.note`);
  const startRatio = optionalNumber(value.startRatio, 0, 1, 0, `${path}.startRatio`);
  const endRatio = optionalNumber(value.endRatio, 0, 1, 1, `${path}.endRatio`);
  assertStrictOrder(startRatio, endRatio, "startRatio", "endRatio", path);
  return {
    type: "vibrato",
    source: "host_envelope",
    note: value.note,
    priority: normalizePriority(value.priority, `${path}.priority`),
    startRatio,
    endRatio,
    envelopeScale: optionalNumber(value.envelopeScale, 0, 2, 1, `${path}.envelopeScale`),
  };
}

function normalizeConstraints(value) {
  if (value === undefined) return { ...PITCH_GESTURE_DEFAULTS.constraints };
  if (!isRecord(value)) throw codedError("INVALID_ARGUMENTS", "constraints must be an object");
  assertKnownKeys(value, ["maxAbsPeakSemitone", "maxTotalPoints", "maxFitErrorCent"], "constraints");
  return {
    maxAbsPeakSemitone: optionalNumber(
      value.maxAbsPeakSemitone,
      1e-6,
      1.5,
      PITCH_GESTURE_DEFAULTS.constraints.maxAbsPeakSemitone,
      "constraints.maxAbsPeakSemitone",
    ),
    maxTotalPoints: optionalInteger(
      value.maxTotalPoints,
      2,
      4000,
      PITCH_GESTURE_DEFAULTS.constraints.maxTotalPoints,
      "constraints.maxTotalPoints",
    ),
    maxFitErrorCent: optionalNumber(
      value.maxFitErrorCent,
      1e-6,
      20,
      PITCH_GESTURE_DEFAULTS.constraints.maxFitErrorCent,
      "constraints.maxFitErrorCent",
    ),
  };
}

function resolvePlanSource(store, input) {
  const stored = store.get(input.contextId);
  if (!stored) throw unknownContextError(store, input.contextId);
  if (stored.context?.kind !== "range") {
    throw codedError(
      "INVALID_CONTEXT",
      'sv_plan_pitch_gesture needs a range context from sv_snapshot_range with include ["notes", "automation"]',
    );
  }
  const scope = resolveMutationScope({ source: { kind: "snapshot", stored }, occurrence: input.occurrence });
  const occurrence = scope.occurrence;
  const quarterBlick = stored.context.quarterBlick;
  if (!Number.isSafeInteger(quarterBlick) || quarterBlick <= 0) {
    throw codedError("INVALID_CONTEXT", "context is missing a usable SV.QUARTER timebase");
  }
  const tempoMarks = stored.context.tempoMarks;
  if (!Array.isArray(tempoMarks) || tempoMarks.length === 0) {
    throw codedError("INVALID_CONTEXT", "context is missing a usable tempo map");
  }
  const timeOffsetBlick = occurrence.timeOffsetBlick;
  if (!Number.isSafeInteger(timeOffsetBlick)) {
    throw codedError("INVALID_CONTEXT", "occurrence is missing timeOffsetBlick");
  }
  const notes = (occurrence.noteFingerprints ?? [])
    .map((fingerprint) => ({
      fingerprint,
      indexInGroup: fingerprint.indexInGroup,
      onsetBlick: fingerprint.onsetBlick,
      durationBlick: fingerprint.durationBlick,
      endBlick: fingerprint.onsetBlick + fingerprint.durationBlick,
      pitchSemitone: fingerprint.pitch + fingerprint.detuneCents / 100,
      lyrics: fingerprint.lyrics,
    }))
    .sort((left, right) => left.onsetBlick - right.onsetBlick || left.indexInGroup - right.indexInGroup);
  const noteByIndex = new Map(notes.map((note) => [note.indexInGroup, note]));
  const semanticEvents = analyzeVocalEventSequence(notes);
  const eventByIndex = new Map(semanticEvents.events.map((event) => [event.note.indexInGroup, event]));
  return {
    stored,
    scope,
    occurrence,
    quarterBlick,
    tempoMarks,
    timeOffsetBlick,
    notes,
    noteByIndex,
    eventByIndex,
  };
}

function resolveAndSelectGestures(gestures, loaded, warnings) {
  const selected = [];
  for (const [requestIndex, gesture] of gestures.entries()) {
    const indexes = gesture.type === "transition" ? [gesture.from, gesture.to] : [gesture.note];
    const notes = indexes.map((index, position) => {
      const field = gesture.type === "transition" ? (position === 0 ? "from" : "to") : "note";
      resolveNoteIndex(loaded.scope, index, `/gestures/${requestIndex}/${field}`);
      const note = loaded.noteByIndex.get(index);
      if (!note) throw codedError("INTERNAL_ERROR", "resolved note is missing from the planner view");
      return note;
    });
    const nonMelodic = notes
      .map((note) => ({ note, event: loaded.eventByIndex.get(note.indexInGroup) }))
      .find(({ event }) => event && !event.melodicEligible);
    if (nonMelodic) {
      warnings.push({
        code: "NON_MELODIC_SPECIAL_EVENT_SKIPPED",
        noteIndex: nonMelodic.note.indexInGroup,
        semanticRole: nonMelodic.event.semanticRole,
        evidence: nonMelodic.event.semanticEvidence,
        message: "Skipped a pitch technique that targets a non-melodic special lyric event.",
      });
      continue;
    }
    selected.push({ requestIndex, gesture, notes });
  }
  return selected;
}

function loadCapturedBaselines(loaded, requiresVibratoEnvelope) {
  const parameters = requiresVibratoEnvelope ? ["pitchDelta", "vibratoEnv"] : ["pitchDelta"];
  if (loaded.stored.context.automationCaptured !== true) {
    throw captureEvidenceRequired(parameters, ["automation"]);
  }
  const captured = loaded.stored.context.automationByOccurrence?.[loaded.scope.occurrenceOrdinal] ?? [];
  const baselines = new Map();
  for (const parameter of parameters) {
    const curve = captured.find((item) => item?.resolvedParameter === parameter);
    if (!curve) throw captureEvidenceRequired(parameters, [parameter]);
    baselines.set(
      parameter,
      createCapturedAutomationBaseline({
        curve,
        contextId: loaded.stored.contextId,
        parameter,
      }),
    );
  }
  return baselines;
}

function buildTechniqueCandidates(selected, loaded, input) {
  return selected.map(({ requestIndex, gesture, notes }) => {
    if (gesture.type === "transition") {
      const [fromNote, toNote] = notes;
      const from = noteWithSeconds(fromNote, loaded);
      const to = noteWithSeconds(toNote, loaded);
      const transition = compilePitchDeltaTransition({
        fromNote: from,
        toNote: to,
        widthSeconds: gesture.width.seconds,
        curve: gesture.curve,
        maxAbsPitchDeltaCent: input.constraints.maxAbsPeakSemitone * 100,
      });
      return {
        id: `request_${requestIndex}`,
        requestIndex,
        kind: "portamento",
        anchors: { fromNote: fromNote.indexInGroup, toNote: toNote.indexInGroup },
        priority: gesture.priority,
        exclusive: false,
        model: gesture.curve.family === "linear"
          ? { family: "linear" }
          : {
              family: "richards_segment_normalized",
              inflectionRatio: gesture.curve.inflectionRatio,
              sharpness: gesture.curve.sharpness,
              asymmetryLogB: gesture.curve.asymmetryLogB,
            },
        span: { fromSeconds: transition.fromSeconds, toSeconds: transition.toSeconds },
      };
    }
    const [note] = notes;
    const noteTiming = noteWithSeconds(note, loaded);
    if (gesture.type === "transient") {
      const fromSeconds = noteTiming.onsetSeconds + gesture.onsetSeconds;
      const toSeconds = fromSeconds + gesture.spanSeconds;
      assertProjectSeconds(fromSeconds, toSeconds, loaded, "transient");
      if (Math.abs(gesture.peakSemitone) > input.constraints.maxAbsPeakSemitone) {
        throw codedError("CONSTRAINT_VIOLATION", "transient peak exceeds constraints.maxAbsPeakSemitone", {
          peakSemitone: gesture.peakSemitone,
          maxAbsPeakSemitone: input.constraints.maxAbsPeakSemitone,
        });
      }
      // 编译一次以提前报告 tail/taper 关系错误，避免把失败拖到密封之后。
      compileFirstPeakTransient({
        peakSemitone: gesture.peakSemitone,
        peakTimeSeconds: gesture.peakTimeSeconds,
        dampingRatio: gesture.dampingRatio,
        onsetSeconds: fromSeconds,
        spanSeconds: gesture.spanSeconds,
        tailPolicy: gesture.tailPolicy,
        maxFitErrorCent: input.constraints.maxFitErrorCent,
        sampleIntervalSeconds: BASE_SAMPLE_INTERVAL_SECONDS,
      });
      return {
        id: `request_${requestIndex}`,
        requestIndex,
        kind: "transient",
        anchors: { note: note.indexInGroup },
        priority: gesture.priority,
        exclusive: false,
        model: {
          family: "first_peak_transient",
          intent: gesture.intent,
          peakSemitone: gesture.peakSemitone,
          peakTimeSeconds: gesture.peakTimeSeconds,
          dampingRatio: gesture.dampingRatio,
          onsetSeconds: fromSeconds,
          spanSeconds: gesture.spanSeconds,
          tailPolicy: gesture.tailPolicy,
          taperRatio: TRANSIENT_TAPER_RATIO,
          maxFitErrorCent: input.constraints.maxFitErrorCent,
          sampleIntervalSeconds: BASE_SAMPLE_INTERVAL_SECONDS,
        },
        span: { fromSeconds, toSeconds },
      };
    }
    const durationSeconds = noteTiming.endSeconds - noteTiming.onsetSeconds;
    const startSeconds = noteTiming.onsetSeconds + durationSeconds * gesture.startRatio;
    const endSeconds = noteTiming.onsetSeconds + durationSeconds * gesture.endRatio;
    assertProjectSeconds(startSeconds, endSeconds, loaded, "vibrato");
    if (gesture.source === "explicit_pitch_delta") {
      if (
        Math.max(Math.abs(gesture.depthSemitone), Math.abs(gesture.endDepthSemitone))
        > input.constraints.maxAbsPeakSemitone
      ) {
        throw codedError("CONSTRAINT_VIOLATION", "vibrato depth exceeds constraints.maxAbsPeakSemitone", {
          maximumDepthSemitone: Math.max(Math.abs(gesture.depthSemitone), Math.abs(gesture.endDepthSemitone)),
          maxAbsPeakSemitone: input.constraints.maxAbsPeakSemitone,
        });
      }
      return {
        id: `request_${requestIndex}`,
        requestIndex,
        kind: "vibrato",
        anchors: { note: note.indexInGroup },
        priority: gesture.priority,
        exclusive: false,
        model: {
          family: "time_varying_vibrato",
          source: "explicit_pitch_delta",
          startRatio: gesture.startRatio,
          endRatio: gesture.endRatio,
          startSeconds,
          endSeconds,
          rateHz: gesture.rateHz,
          endRateHz: gesture.endRateHz,
          depthSemitone: gesture.depthSemitone,
          endDepthSemitone: gesture.endDepthSemitone,
          centerDriftSemitone: gesture.centerDriftSemitone,
          phaseRad: gesture.phaseRad,
          fadeInSeconds: gesture.fadeInSeconds,
          fadeOutSeconds: gesture.fadeOutSeconds,
        },
        span: { fromSeconds: startSeconds, toSeconds: endSeconds },
      };
    }
    return {
      id: `request_${requestIndex}`,
      requestIndex,
      kind: "vibrato",
      anchors: { note: note.indexInGroup },
      priority: gesture.priority,
      exclusive: false,
      model: {
        family: "host_envelope",
        source: "host_envelope",
        startRatio: gesture.startRatio,
        endRatio: gesture.endRatio,
        startSeconds,
        endSeconds,
        envelopeScale: gesture.envelopeScale,
      },
      span: { fromSeconds: startSeconds, toSeconds: endSeconds },
    };
  });
}

function buildTechniqueIr({ input, loaded, techniques, baselines, hostProfileHash }) {
  const requiredParameters = techniques.some((technique) => technique.kind === "vibrato")
    ? ["pitchDelta", "vibratoEnv"]
    : ["pitchDelta"];
  return normalizeTechniqueIr({
    schemaVersion: 1,
    modelVersion: "pitch-techniques-v1",
    scope: {
      contextId: input.contextId,
      occurrence: input.occurrence,
      expectedTargetGroupUuid: loaded.occurrence.targetGroupUuid,
    },
    timeDomain: "seconds",
    referenceFrame: "pitch_delta_contribution_cents",
    techniques,
    composition: {
      rule: "sum_then_clamp",
      maxAbsCents: input.constraints.maxAbsPeakSemitone * 100,
      overlapPolicy: "explicit_priority_then_canonical_key",
    },
    target: {
      surface: "pitchDelta",
      compositionMode: "baseline_plus_contribution",
      mutationMode: "replace",
      referenceFrame: "pitch_delta_contribution_cents",
      requiredInclude: {
        include: ["notes", "automation"],
        automationParameters: requiredParameters,
      },
      baselineGuard: Object.fromEntries(requiredParameters.map((parameter) => [
        `${parameter}Fingerprint`,
        baselines.get(parameter).fingerprint,
      ])),
      interpolationEvidence: Object.fromEntries(requiredParameters.map((parameter) => [
        parameter,
        baselines.get(parameter).interpolationEvidence,
      ])),
      hostProfileHash,
    },
  });
}

function compileAutomationPlan({ input, loaded, ir, baselines, vibratoGate }) {
  const warnings = [];
  const pitchTechniques = ir.techniques.filter((technique) => technique.model.source !== "host_envelope");
  const envelopeTechniques = ir.techniques.filter((technique) => technique.model.source === "host_envelope");
  const curves = [];
  let pitchDetail = null;
  if (pitchTechniques.length > 0) {
    const pitchIr = normalizeTechniqueIr({
      ...ir,
      techniques: pitchTechniques.map((technique) => ({
        id: technique.id,
        kind: technique.kind,
        anchors: technique.anchors,
        priority: technique.priority,
        exclusive: technique.exclusive,
        model: technique.model,
        span: technique.span,
      })),
      target: pitchOnlyTarget(ir.target),
    });
    const pitch = compilePitchDeltaCurves({ input, loaded, ir: pitchIr, baseline: baselines.get("pitchDelta") });
    curves.push(...pitch.curves);
    warnings.push(...pitch.warnings);
    pitchDetail = pitch.detail;
  }
  if (envelopeTechniques.length > 0) {
    const envelope = compileEnvelopeScaleCurves({
      input,
      loaded,
      techniques: envelopeTechniques,
      baseline: baselines.get("vibratoEnv"),
    });
    curves.push(...envelope.curves);
    warnings.push(...envelope.warnings);
  }
  const explicit = ir.techniques.filter((technique) => technique.model.source === "explicit_pitch_delta");
  if (explicit.length > 0) {
    const suppressed = compileExplicitVibratoSuppression({
      input,
      loaded,
      techniques: explicit,
      baseline: baselines.get("vibratoEnv"),
      gate: vibratoGate,
    });
    curves.push(...suppressed.curves);
  }
  const totalPoints = curves.reduce((total, curve) => total + decodeDense(curve.points).length, 0);
  if (totalPoints > input.constraints.maxTotalPoints) {
    throw codedError("PITCH_DELTA_POINT_BUDGET_EXCEEDED", "compiled points exceed constraints.maxTotalPoints", {
      maximum: input.constraints.maxTotalPoints,
      actual: totalPoints,
    });
  }
  return {
    curves,
    warnings,
    pointCount: totalPoints,
    detail: pitchDetail,
  };
}

function compilePitchDeltaCurves({ input, loaded, ir, baseline }) {
  const descriptors = buildPitchDescriptors(ir, loaded, input);
  const mandatory = buildPitchMandatoryAnchors({ descriptors, ir, baseline, loaded, input });
  const grid = buildTechniqueGrid({
    techniques: ir.techniques,
    mandatoryTimes: mandatory.map((anchor) => anchor.timeSeconds),
    baseline,
    loaded,
    maxPoints: input.constraints.maxTotalPoints,
    vibratoRateHz: maximumVibratoRate(ir.techniques),
  });
  const baselineCents = grid.seconds.map((seconds, index) => (
    grid.finiteMask[index] ? evaluateBaselineAtSeconds(baseline, seconds, loaded) : null
  ));
  const techniqueValues = ir.techniques.map((technique) => ({
    canonicalKey: technique.canonicalKey,
    values: grid.seconds.map((seconds, index) => (
      grid.finiteMask[index] ? descriptors.get(technique.canonicalKey).evaluate(seconds) : null
    )),
  }));
  const composition = composeTechniqueContributions({
    ir,
    seconds: grid.seconds,
    finiteMask: grid.finiteMask,
    techniqueValues,
    baselineCents,
  });
  const evidence = deepFreeze({
    notes: loaded.notes.map((note) => ({
      indexInGroup: note.indexInGroup,
      onsetBlick: note.onsetBlick,
      durationBlick: note.durationBlick,
      pitchSemitone: note.pitchSemitone,
    })),
    occurrenceTimeOffsetBlick: loaded.timeOffsetBlick,
    tempoMarks: loaded.tempoMarks,
    quarterBlick: loaded.quarterBlick,
    baselineCents,
    mandatoryAnchors: mandatory,
  });
  const plan = compilePitchDeltaMutationPlan({
    ir,
    composition,
    evidence,
    maxPoints: input.constraints.maxTotalPoints,
  });
  const curves = attachHostInterpolation({
    curves: plan.mutation.curves,
    baseline,
    mandatoryAnchors: mandatory,
    maxFitErrorCent: input.constraints.maxFitErrorCent,
    loaded,
    descriptors,
  });
  return {
    curves,
    warnings: composition.warnings,
    detail: { ir, composition, evidence, compiler: plan },
  };
}

function compileEnvelopeScaleCurves({ input, loaded, techniques, baseline }) {
  const grid = buildTechniqueGrid({
    techniques,
    mandatoryTimes: techniques.flatMap((technique) => [technique.span.fromSeconds, technique.span.toSeconds]),
    baseline,
    loaded,
    maxPoints: input.constraints.maxTotalPoints,
    vibratoRateHz: 0,
  });
  const runs = splitGridRuns(grid);
  const curves = [];
  for (const run of runs) {
    const points = run.map(({ seconds }) => {
      const blick = localBlickAtSeconds(seconds, loaded);
      const factor = techniques.reduce((product, technique) => (
        seconds >= technique.span.fromSeconds && seconds <= technique.span.toSeconds
          ? product * technique.model.envelopeScale
          : product
      ), 1);
      return { blick, value: quantize(evaluateCapturedAutomation(baseline, blick) * factor) };
    });
    const normalized = normalizePlannedPoints(points, "vibratoEnv");
    if (normalized.every((point) => sameValue(point.value, evaluateCapturedAutomation(baseline, point.blick)))) {
      continue;
    }
    const mandatory = normalized.filter((point) => (
      techniques.some((technique) => (
        point.blick === localBlickAtSeconds(technique.span.fromSeconds, loaded)
        || point.blick === localBlickAtSeconds(technique.span.toSeconds, loaded)
      ))
    ));
    curves.push(attachOneHostInterpolation({
      curve: encodeReplaceCurve("vibratoEnv", normalized),
      baseline,
      mandatoryPoints: mandatory,
      maxFitErrorCent: input.constraints.maxFitErrorCent,
    }));
  }
  return { curves, warnings: [] };
}

function compileExplicitVibratoSuppression({ input, loaded, techniques, baseline, gate }) {
  if (!gate?.suppression) {
    throw codedError("HOST_SEMANTIC_UNCONFIRMED", "explicit pitchDelta vibrato has no confirmed safe vibratoEnv suppression", {
      semantic: "vibrato.hostEnvelopeWithExplicitPitchDelta",
    });
  }
  const value = gate.suppression.value;
  const grid = buildTechniqueGrid({
    techniques,
    mandatoryTimes: techniques.flatMap((technique) => [technique.span.fromSeconds, technique.span.toSeconds]),
    baseline,
    loaded,
    maxPoints: input.constraints.maxTotalPoints,
    vibratoRateHz: 0,
  });
  const curves = [];
  for (const run of splitGridRuns(grid)) {
    const points = normalizePlannedPoints(
      run.map(({ seconds }) => ({ blick: localBlickAtSeconds(seconds, loaded), value })),
      "vibratoEnv",
    );
    curves.push(attachOneHostInterpolation({
      curve: encodeReplaceCurve("vibratoEnv", points),
      baseline,
      mandatoryPoints: [points[0], points.at(-1)],
      maxFitErrorCent: input.constraints.maxFitErrorCent,
    }));
  }
  return { curves };
}

function buildPitchDescriptors(ir, loaded, input) {
  const descriptors = new Map();
  for (const technique of ir.techniques) {
    if (technique.kind === "portamento") {
      const from = noteWithSeconds(requireLoadedNote(loaded, technique.anchors.fromNote), loaded);
      const to = noteWithSeconds(requireLoadedNote(loaded, technique.anchors.toNote), loaded);
      const compiled = compilePitchDeltaTransition({
        fromNote: from,
        toNote: to,
        widthSeconds: technique.span.toSeconds - technique.span.fromSeconds,
        curve: technique.model.family === "linear"
          ? { family: "linear" }
          : {
              family: "richards",
              inflectionRatio: technique.model.inflectionRatio,
              sharpness: technique.model.sharpness,
              asymmetryLogB: technique.model.asymmetryLogB,
            },
        maxAbsPitchDeltaCent: input.constraints.maxAbsPeakSemitone * 100,
      });
      descriptors.set(technique.canonicalKey, {
        technique,
        compiled,
        evaluate: (seconds, side = "auto") => evaluateTransitionContribution({
          technique,
          compiled,
          seconds,
          side,
        }),
      });
      continue;
    }
    if (technique.kind === "transient") {
      const compiled = compileFirstPeakTransient({
        peakSemitone: technique.model.peakSemitone,
        peakTimeSeconds: technique.model.peakTimeSeconds,
        dampingRatio: technique.model.dampingRatio,
        onsetSeconds: technique.model.onsetSeconds,
        spanSeconds: technique.model.spanSeconds,
        tailPolicy: technique.model.tailPolicy,
        maxFitErrorCent: technique.model.maxFitErrorCent,
        sampleIntervalSeconds: technique.model.sampleIntervalSeconds,
      });
      descriptors.set(technique.canonicalKey, {
        technique,
        compiled,
        evaluate: (seconds) => compiled.valueAt(seconds) * 100,
      });
      continue;
    }
    const model = technique.model;
    descriptors.set(technique.canonicalKey, {
      technique,
      evaluate: (seconds) => timeVaryingVibrato(seconds, {
        startSeconds: model.startSeconds,
        endSeconds: model.endSeconds,
        rateStartHz: model.rateHz,
        rateEndHz: model.endRateHz,
        depthStartSemitone: model.depthSemitone,
        depthEndSemitone: model.endDepthSemitone,
        centerStartSemitone: 0,
        centerEndSemitone: model.centerDriftSemitone,
        phaseRad: model.phaseRad,
        fadeInSeconds: model.fadeInSeconds,
        fadeOutSeconds: model.fadeOutSeconds,
      }) * 100,
    });
  }
  return descriptors;
}

function evaluateTransitionContribution({ technique, compiled, seconds, side }) {
  if (
    seconds < technique.span.fromSeconds - SECOND_QUANTUM
    || seconds > technique.span.toSeconds + SECOND_QUANTUM
  ) {
    return 0;
  }
  const boundedSeconds = Math.max(
    compiled.fromSeconds,
    Math.min(compiled.toSeconds, seconds),
  );
  return compiled.contributionCentAt(boundedSeconds, side);
}

function buildPitchMandatoryAnchors({ descriptors, ir, baseline, loaded, input }) {
  const anchors = [];
  const totalAt = (seconds, current = null, side = "auto") => quantize(
    Math.max(
      -ir.composition.maxAbsCents,
      Math.min(
        ir.composition.maxAbsCents,
        [...descriptors.values()].reduce(
          (total, descriptor) => total + descriptor.evaluate(
            seconds,
            descriptor.technique.canonicalKey === current ? side : "auto",
          ),
          0,
        ),
      ),
    ),
  );
  const push = (descriptor, role, seconds, side = "auto", localBlick = null) => {
    const blick = localBlick ?? localBlickAtSeconds(seconds, loaded);
    anchors.push({
      canonicalKey: descriptor.technique.canonicalKey,
      role,
      timeSeconds: seconds,
      contributionCents: totalAt(seconds, descriptor.technique.canonicalKey, side),
      baselineCents: evaluateCapturedAutomation(baseline, blick),
    });
  };
  for (const descriptor of descriptors.values()) {
    const { technique } = descriptor;
    if (technique.kind === "portamento") {
      const boundaryLocalBlick = requireLoadedNote(loaded, technique.anchors.toNote).onsetBlick;
      push(
        descriptor,
        "start",
        technique.span.fromSeconds,
        "auto",
        localBlickAtSeconds(descriptor.compiled.fromSeconds, loaded),
      );
      push(descriptor, "boundary_before", descriptor.compiled.boundarySeconds, "before", boundaryLocalBlick - 1);
      push(descriptor, "boundary_at", descriptor.compiled.boundarySeconds, "at", boundaryLocalBlick);
      push(
        descriptor,
        "end",
        technique.span.toSeconds,
        "auto",
        localBlickAtSeconds(descriptor.compiled.toSeconds, loaded),
      );
      if (technique.model.family === "richards_segment_normalized") {
        push(
          descriptor,
          "inflection",
          technique.span.fromSeconds
            + (technique.span.toSeconds - technique.span.fromSeconds) * technique.model.inflectionRatio,
        );
      }
      continue;
    }
    push(descriptor, "start", technique.span.fromSeconds);
    if (technique.kind === "transient") {
      push(descriptor, "peak", technique.model.onsetSeconds + technique.model.peakTimeSeconds);
      if (technique.model.tailPolicy === "continuous_taper") {
        push(
          descriptor,
          "taper_start",
          technique.model.onsetSeconds + technique.model.spanSeconds * (1 - TRANSIENT_TAPER_RATIO),
        );
      }
    } else {
      const duration = technique.span.toSeconds - technique.span.fromSeconds;
      push(descriptor, "fade_in_end", Math.min(technique.span.toSeconds, technique.span.fromSeconds + technique.model.fadeInSeconds));
      push(descriptor, "fade_out_start", Math.max(technique.span.fromSeconds, technique.span.toSeconds - technique.model.fadeOutSeconds));
      const extrema = vibratoExtrema(descriptor, duration, input.constraints.maxTotalPoints);
      extrema.forEach((seconds, index) => push(descriptor, `extremum_${alphabeticOrdinal(index)}`, seconds));
    }
    push(descriptor, "end", technique.span.toSeconds);
  }
  return anchors.sort((left, right) => (
    left.timeSeconds - right.timeSeconds
    || left.canonicalKey.localeCompare(right.canonicalKey)
    || left.role.localeCompare(right.role)
  ));
}

function vibratoExtrema(descriptor, duration, pointBudget) {
  const rate = Math.max(descriptor.technique.model.rateHz, descriptor.technique.model.endRateHz);
  const samples = Math.min(pointBudget, Math.max(8, Math.ceil(duration * rate * 24)));
  const result = [];
  let previous = descriptor.evaluate(descriptor.technique.span.fromSeconds);
  let current = descriptor.evaluate(descriptor.technique.span.fromSeconds + duration / samples);
  for (let index = 1; index < samples; index += 1) {
    const seconds = descriptor.technique.span.fromSeconds + (duration * index) / samples;
    const next = descriptor.evaluate(descriptor.technique.span.fromSeconds + (duration * (index + 1)) / samples);
    if ((current >= previous && current > next) || (current <= previous && current < next)) result.push(seconds);
    previous = current;
    current = next;
  }
  return result;
}

function alphabeticOrdinal(index) {
  let remaining = index;
  let output = "";
  do {
    output = String.fromCharCode(97 + (remaining % 26)) + output;
    remaining = Math.floor(remaining / 26) - 1;
  } while (remaining >= 0);
  return output;
}

function buildTechniqueGrid({ techniques, mandatoryTimes, baseline, loaded, maxPoints, vibratoRateHz }) {
  const spans = mergeSpans(techniques.map((technique) => technique.span));
  const step = vibratoRateHz > 0
    ? Math.min(BASE_SAMPLE_INTERVAL_SECONDS, 1 / (vibratoRateHz * 24))
    : BASE_SAMPLE_INTERVAL_SECONDS;
  const samples = [];
  for (const span of spans) {
    const steps = Math.max(1, Math.ceil((span.toSeconds - span.fromSeconds) / step));
    for (let index = 0; index <= steps; index += 1) {
      samples.push({ seconds: span.fromSeconds + ((span.toSeconds - span.fromSeconds) * index) / steps, finite: true });
    }
    for (const seconds of mandatoryTimes) {
      if (seconds >= span.fromSeconds && seconds <= span.toSeconds) samples.push({ seconds, finite: true });
    }
    for (const point of baseline.points) {
      const seconds = secondsAtBlick(
        loaded.tempoMarks,
        loaded.quarterBlick,
        point.blick + loaded.timeOffsetBlick,
      );
      if (Number.isFinite(seconds) && seconds >= span.fromSeconds && seconds <= span.toSeconds) {
        samples.push({ seconds, finite: true });
      }
    }
  }
  for (let index = 1; index < spans.length; index += 1) {
    samples.push({
      seconds: (spans[index - 1].toSeconds + spans[index].fromSeconds) / 2,
      finite: false,
    });
  }
  const deduped = new Map();
  for (const sample of samples) {
    const seconds = quantizeSeconds(sample.seconds);
    const existing = deduped.get(seconds);
    if (existing === undefined || sample.finite) deduped.set(seconds, sample.finite);
  }
  const ordered = [...deduped.entries()].sort((left, right) => left[0] - right[0]);
  const finiteCount = ordered.filter(([, finite]) => finite).length;
  if (finiteCount > maxPoints) {
    throw codedError("PITCH_DELTA_POINT_BUDGET_EXCEEDED", "technique sampling exceeds constraints.maxTotalPoints", {
      maximum: maxPoints,
      actual: finiteCount,
    });
  }
  return {
    seconds: ordered.map(([seconds]) => seconds),
    finiteMask: ordered.map(([, finite]) => finite),
  };
}

function splitGridRuns(grid) {
  const runs = [];
  let active = [];
  for (let index = 0; index < grid.seconds.length; index += 1) {
    if (!grid.finiteMask[index]) {
      if (active.length > 0) runs.push(active);
      active = [];
      continue;
    }
    active.push({ seconds: grid.seconds[index] });
  }
  if (active.length > 0) runs.push(active);
  return runs;
}

function attachHostInterpolation({
  curves,
  baseline,
  mandatoryAnchors,
  maxFitErrorCent,
  loaded,
  descriptors,
}) {
  return curves.map((curve) => {
    const points = decodeDense(curve.points);
    const mandatoryPoints = mandatoryAnchors
      .flatMap((anchor) => {
        const blick = anchorLocalBlick(anchor, loaded, descriptors);
        if (blick < curve.range.fromBlick || blick > curve.range.toBlick) return [];
        return [{ blick, value: pointValueAt(points, blick) }];
      });
    return attachOneHostInterpolation({ curve, baseline, mandatoryPoints, maxFitErrorCent });
  });
}

function attachOneHostInterpolation({ curve, baseline, mandatoryPoints, maxFitErrorCent }) {
  const points = decodeDense(curve.points);
  const range = curve.range;
  const finalSupport = replaceAutomationPoints(baseline, range, points);
  const mandatory = dedupePointSamples([
    ...mandatoryPoints,
    { blick: points[0].blick, value: points[0].value },
    { blick: points.at(-1).blick, value: points.at(-1).value },
  ], "mandatory");
  const baselineBlicks = dedupeIntegers([
    points[0].blick,
    points.at(-1).blick,
    ...baseline.points
      .filter((point) => point.blick >= range.fromBlick && point.blick <= range.toBlick)
      .map((point) => point.blick),
  ]).slice(0, MAX_VERIFICATION_MANDATORY_SAMPLES);
  const baselineSamples = baselineBlicks.map((blick) => ({
    blick,
    value: evaluateCapturedAutomation(baseline, blick),
  }));
  const adaptiveMidpoints = buildAdaptiveMidpoints({
    points,
    finalSupport,
    method: baseline.method,
    defaultValue: baseline.defaultValue,
    excluded: new Set(mandatory.map((sample) => sample.blick)),
  });
  return {
    ...curve,
    hostInterpolation: buildHostInterpolationPostcondition({
      interpolationEvidence: baseline.interpolationEvidence,
      baselineSamples,
      mandatorySamples: mandatory,
      adaptiveMidpoints,
      maxFitErrorCent,
    }),
  };
}

function buildAdaptiveMidpoints({ points, finalSupport, method, defaultValue, excluded }) {
  const candidates = [];
  for (let index = 1; index < points.length; index += 1) {
    const left = points[index - 1];
    const right = points[index];
    if (right.blick - left.blick < 2) continue;
    const blick = left.blick + Math.floor((right.blick - left.blick) / 2);
    if (excluded.has(blick)) continue;
    candidates.push({
      blick,
      leftBlick: left.blick,
      rightBlick: right.blick,
      value: evaluateAutomationPoints({ method, defaultValue, points: finalSupport, blick }),
    });
  }
  candidates.sort((left, right) => (
    (right.rightBlick - right.leftBlick) - (left.rightBlick - left.leftBlick)
    || left.blick - right.blick
  ));
  return candidates
    .slice(0, MAX_VERIFICATION_ADAPTIVE_SAMPLES)
    .sort((left, right) => left.blick - right.blick);
}

function encodeReplaceCurve(parameter, points) {
  const normalized = normalizePlannedPoints(points, parameter);
  return {
    parameter,
    mode: "replace",
    range: {
      fromBlick: normalized[0].blick,
      toBlick: normalized.at(-1).blick,
      coordinate: "local",
    },
    points: encodeDense(normalized, DENSE_POINT_PROFILE),
  };
}

function normalizePlannedPoints(points, parameter) {
  const byBlick = new Map();
  for (const point of points) {
    if (!Number.isSafeInteger(point.blick) || !Number.isFinite(point.value)) {
      throw codedError("TIME_AXIS_MAPPING_UNAVAILABLE", `cannot map ${parameter} plan to local BLICK`);
    }
    const previous = byBlick.get(point.blick);
    if (previous !== undefined && !sameValue(previous, point.value)) {
      throw codedError("PITCH_DELTA_TIME_RESOLUTION_TOO_COARSE", "different values collapse to one BLICK", {
        parameter,
        blick: point.blick,
      });
    }
    byBlick.set(point.blick, quantize(point.value));
  }
  const normalized = [...byBlick.entries()]
    .map(([blick, value]) => ({ blick, value }))
    .sort((left, right) => left.blick - right.blick);
  if (normalized.length < 2 || normalized.at(-1).blick <= normalized[0].blick) {
    throw codedError("PITCH_DELTA_RUN_TOO_SHORT", `${parameter} needs two distinct local BLICK points`);
  }
  if (normalized.length > 2000) {
    throw codedError("PITCH_DELTA_CURVE_POINT_BUDGET_EXCEEDED", `${parameter} exceeds 2000 points`);
  }
  return normalized;
}

function sealPlanResponse({ input, loaded, ir, compiled, warnings, artifactStore, sessionId }) {
  if (!artifactStore || !sessionId) throw planSealError();
  const expectedNotes = selectedExpectedNotes(ir, loaded);
  const planId = `plan_${canonicalHashHex({
    contextId: input.contextId,
    occurrence: input.occurrence,
    ir,
    curves: compiled.curves,
  }).slice(0, 16)}`;
  const mutationRequest = {
    target: {
      contextId: input.contextId,
      occurrence: input.occurrence,
      ...(loaded.occurrence.targetGroupUuid
        ? { expectedGroupUuid: loaded.occurrence.targetGroupUuid }
        : {}),
      expectedTimeOffsetBlick: loaded.timeOffsetBlick,
      ...(expectedNotes.length > 0 ? { expectedNotes } : {}),
    },
    curves: compiled.curves,
    action: "dry_run",
    atomic: true,
    undoLabel: `sv_plan_pitch_gesture ${planId}`,
  };
  let correctionTarget = null;
  if (input.retainCorrectionTarget) {
    if (ir.techniques.some((technique) => technique.kind === "vibrato")) {
      throw codedError(
        "CORRECTION_TARGET_UNAVAILABLE",
        "retainCorrectionTarget is unavailable for plans that touch vibratoEnv",
      );
    }
    correctionTarget = buildCorrectionTarget(compiled.detail, loaded);
  }
  let artifact;
  try {
    const sealed = buildPlanArtifact({
      targetTool: "sv_patch_parameter_curves",
      mutationRequest,
      targetGroupUuid: loaded.occurrence.targetGroupUuid,
      occurrence: input.occurrence,
      expectedTimeOffsetBlick: loaded.timeOffsetBlick,
      fingerprints: { expectedNotes },
      capsule: {
        stored: loaded.stored,
        occurrence: loaded.occurrence,
        noteIndexes: expectedNotes.map((note) => note.indexInGroup),
      },
    });
    sealed.payload.pitchTechniques = {
      schemaVersion: 1,
      planId,
      provenance: PROVENANCE,
      ir,
      compiler: compiled.detail?.compiler
        ? {
            planHash: compiled.detail.compiler.planHash,
            summary: compiled.detail.compiler.summary,
          }
        : null,
      ...(correctionTarget ? { correctionTarget } : {}),
    };
    artifact = artifactStore.seal({
      kind: "plan",
      schemaVersion: "1",
      sessionId,
      sourceEpoch: loaded.stored.epoch,
      payload: sealed.payload,
    });
  } catch (error) {
    throw planSealError(error);
  }
  const apply = sealApplyEnvelope(
    buildApplyEnvelope([
      { tool: "sv_patch_parameter_curves", arguments: mutationRequest },
    ], {
      sharedTargetConfirmationRequired: (loaded.occurrence.sharedTargetOccurrences ?? []).length > 1,
    }),
    planReference(artifact),
    artifact.expiresAt,
  );
  const requiresSharedTargetConfirmation = (loaded.occurrence.sharedTargetOccurrences ?? []).length > 1;
  const checklist = [
    "Review the selected note anchors and technique parameters before applying the sealed Automation replacement.",
    "The transaction replaces only its bounded ranges after validating the captured Automation baseline and host interpolation.",
    "Submit apply.arguments with action dry_run before committing the identical arguments.",
    "Musical quality is human_only: audition the result after the verified write.",
  ];
  if (requiresSharedTargetConfirmation) {
    checklist.push(
      "The target NoteGroup is shared by multiple occurrences; commit requires confirmations.allowSharedTargetMutation:true and affects every occurrence.",
    );
  }
  return {
    ok: true,
    status: "planned",
    effects: "none",
    planId,
    data: {
      techniques: ir.techniques.length,
      curves: compiled.curves.length,
      points: compiled.pointCount,
      composition: "baseline_plus_contribution",
      correctionTargetRetained: correctionTarget !== null,
      requiresHumanAudition: true,
    },
    apply,
    review: {
      requiresHumanAudition: true,
      requiresSharedTargetConfirmation,
      replacesCapturedAutomationBaseline: true,
      checklist,
    },
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function buildCorrectionTarget(detail, loaded) {
  const captured = loaded.stored.context.computedPitchByOccurrence?.[loaded.scope.occurrenceOrdinal];
  if (
    !captured
    || !Array.isArray(captured.values)
    || !Number.isSafeInteger(captured.startBlick)
    || captured.startBlick < 0
    || !Number.isSafeInteger(captured.intervalBlick)
    || captured.intervalBlick < 1
    || !Number.isSafeInteger(captured.frames)
    || captured.frames < 1
    || captured.frames !== captured.values.length
    || !isRecord(captured.evidence)
    || !Number.isSafeInteger(captured.evidence.requestedFrames)
    || !Number.isSafeInteger(captured.evidence.observedFrames)
    || !Array.isArray(captured.evidence.nullFrameIndices)
  ) {
    throw codedError("CORRECTION_TARGET_UNAVAILABLE", "retainCorrectionTarget needs captured computedPitch sampling", {
      remediation: {
        include: ["notes", "automation", "computedPitch"],
        automationParameters: ["pitchDelta"],
      },
    });
  }
  const finiteFrames = captured.values.filter(Number.isFinite).length;
  const nullFrameIndices = captured.values.flatMap((value, index) => (
    Number.isFinite(value) ? [] : [index]
  ));
  if (
    captured.evidence.requestedFrames !== captured.frames
    || captured.evidence.observedFrames !== finiteFrames
    || !sameIntegerArray(captured.evidence.nullFrameIndices, nullFrameIndices)
  ) {
    throw codedError("CORRECTION_TARGET_UNAVAILABLE", "captured computedPitch provenance disagrees", {
      remediation: {
        include: ["notes", "automation", "computedPitch"],
        automationParameters: ["pitchDelta"],
      },
    });
  }
  const composition = detail?.composition;
  if (!composition) {
    throw codedError("CORRECTION_TARGET_UNAVAILABLE", "the plan has no additive pitchDelta composition");
  }
  const grid = buildUniformSecondsGrid({
    startBlick: captured.startBlick,
    intervalBlick: captured.intervalBlick,
    values: captured.values,
    tempoMarks: loaded.tempoMarks,
    quarterBlick: loaded.quarterBlick,
  });
  if (grid.status !== "ready") {
    throw codedError(
      "CORRECTION_TARGET_UNAVAILABLE",
      "captured computedPitch cannot form a uniform-seconds correction target",
      { reason: grid.reason },
    );
  }
  if (grid.frames > CORRECTION_TARGET_PROFILE.maxRows) {
    throw codedError(
      "CORRECTION_TARGET_UNAVAILABLE",
      "captured computedPitch exceeds the retained correction-target frame budget",
      {
        frames: grid.frames,
        maximumFrames: CORRECTION_TARGET_PROFILE.maxRows,
        remediation: { computedPitchSampling: { frames: CORRECTION_TARGET_PROFILE.maxRows } },
      },
    );
  }
  const rows = [];
  for (let index = 0; index < grid.frames; index += 1) {
    const midi = grid.values[index];
    if (!Number.isFinite(midi)) continue;
    const contribution = interpolateComposition(composition, grid.timeSeconds[index]);
    if (!Number.isFinite(contribution)) continue;
    const targetCent = midi * 100 + contribution;
    if (!Number.isFinite(targetCent)) continue;
    rows.push({ frame: index, targetCent: quantize(targetCent) });
  }
  if (rows.length === 0) {
    throw codedError("CORRECTION_TARGET_UNAVAILABLE", "captured computedPitch has no finite frames in the planned range");
  }
  return {
    schemaVersion: 2,
    encoding: "dense-table-v1",
    points: encodeDense(rows, CORRECTION_TARGET_PROFILE),
    finiteFrames: rows.length,
    grid: {
      timeGrid: "uniform_seconds",
      startSeconds: grid.timeSeconds[0],
      sampleIntervalSeconds: grid.sampleIntervalSeconds,
      frames: grid.frames,
    },
  };
}

function interpolateComposition(composition, seconds) {
  const index = composition.seconds.findIndex((entry) => entry >= seconds);
  if (index === -1 || composition.finiteMask[index] !== true) return null;
  if (composition.seconds[index] === seconds) return composition.contributionCents[index];
  if (index === 0 || composition.finiteMask[index - 1] !== true) return null;
  const leftSeconds = composition.seconds[index - 1];
  const rightSeconds = composition.seconds[index];
  const ratio = (seconds - leftSeconds) / (rightSeconds - leftSeconds);
  return (1 - ratio) * composition.contributionCents[index - 1]
    + ratio * composition.contributionCents[index];
}

function sameIntegerArray(left, right) {
  return left.length === right.length && left.every((value, index) => (
    Number.isSafeInteger(value) && value === right[index]
  ));
}

function noChangeResponse(input, warnings, { techniques = 0 } = {}) {
  return {
    ok: true,
    status: "no_change",
    effects: "none",
    data: {
      techniques,
      curves: 0,
      points: 0,
      composition: "baseline_plus_contribution",
      correctionTargetRetained: false,
      requiresHumanAudition: true,
    },
    apply: null,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function selectedExpectedNotes(ir, loaded) {
  const indexes = new Set();
  for (const technique of ir.techniques) {
    if (technique.kind === "portamento") {
      indexes.add(technique.anchors.fromNote);
      indexes.add(technique.anchors.toNote);
    } else {
      indexes.add(technique.anchors.note);
    }
  }
  return [...indexes]
    .map((index) => requireLoadedNote(loaded, index).fingerprint)
    .map((fingerprint) => ({
      indexInGroup: fingerprint.indexInGroup,
      onsetBlick: fingerprint.onsetBlick,
      durationBlick: fingerprint.durationBlick,
      pitch: fingerprint.pitch,
      lyrics: fingerprint.lyrics,
      phonemesOverride: fingerprint.phonemesOverride,
      languageOverride: fingerprint.languageOverride,
      detuneCents: fingerprint.detuneCents,
    }))
    .sort((left, right) => left.indexInGroup - right.indexInGroup);
}

function requireVibratoGate(hostProfile, selected) {
  const fact = hostProfile?.semantics?.["vibrato.hostEnvelopeWithExplicitPitchDelta"];
  if (fact?.status !== "confirmed") {
    throw codedError(
      "HOST_SEMANTIC_UNCONFIRMED",
      "Vibrato planning requires confirmed interaction semantics between vibratoEnv and explicit pitchDelta.",
      {
        semantic: "vibrato.hostEnvelopeWithExplicitPitchDelta",
        status: fact?.status ?? "missing",
        evidenceIds: ["H2"],
      },
    );
  }
  const value = fact.value;
  const hostEnvelopeAllowed = value === "baseline_scale" || value?.hostEnvelope === "baseline_scale";
  const suppression = value?.explicitPitchDelta?.vibratoEnv;
  const needsHostEnvelope = selected.some(({ gesture }) => gesture.source === "host_envelope");
  const needsExplicit = selected.some(({ gesture }) => gesture.source === "explicit_pitch_delta");
  if (needsHostEnvelope && !hostEnvelopeAllowed) {
    throw codedError("HOST_SEMANTIC_UNCONFIRMED", "Host-envelope vibrato requires confirmed baseline-scale semantics for vibratoEnv.", {
      semantic: "vibrato.hostEnvelopeWithExplicitPitchDelta",
      evidenceIds: ["H2"],
    });
  }
  if (
    needsExplicit
    && (!isRecord(suppression) || suppression.mode !== "replace" || !Number.isFinite(suppression.value))
  ) {
    throw codedError("HOST_SEMANTIC_UNCONFIRMED", "Explicit pitchDelta vibrato requires a confirmed safe vibratoEnv suppression value.", {
      semantic: "vibrato.hostEnvelopeWithExplicitPitchDelta",
      evidenceIds: ["H2"],
    });
  }
  return { suppression: needsExplicit ? { value: suppression.value } : null };
}

function pitchOnlyTarget(target) {
  return {
    surface: "pitchDelta",
    compositionMode: "baseline_plus_contribution",
    mutationMode: "replace",
    referenceFrame: "pitch_delta_contribution_cents",
    // 显式 vibrato 的 pitchDelta 编译仍依赖同一计划里的 vibratoEnv 抑制证据。
    requiredInclude: target.requiredInclude,
    baselineGuard: target.baselineGuard,
    interpolationEvidence: target.interpolationEvidence,
    hostProfileHash: target.hostProfileHash,
  };
}

function noteWithSeconds(note, loaded) {
  const onsetSeconds = secondsAtBlick(
    loaded.tempoMarks,
    loaded.quarterBlick,
    loaded.timeOffsetBlick + note.onsetBlick,
  );
  const endSeconds = secondsAtBlick(
    loaded.tempoMarks,
    loaded.quarterBlick,
    loaded.timeOffsetBlick + note.endBlick,
  );
  if (!Number.isFinite(onsetSeconds) || !Number.isFinite(endSeconds) || endSeconds <= onsetSeconds) {
    throw codedError("TIME_AXIS_MAPPING_UNAVAILABLE", "note anchors cannot map to a strictly increasing seconds span");
  }
  return { ...note, onsetSeconds, endSeconds };
}

function assertProjectSeconds(fromSeconds, toSeconds, loaded, label) {
  if (!Number.isFinite(fromSeconds) || !Number.isFinite(toSeconds) || toSeconds <= fromSeconds) {
    throw codedError("INVALID_ARGUMENTS", `${label} must have a strictly increasing seconds span`);
  }
  const fromBlick = blickAtSeconds(loaded.tempoMarks, loaded.quarterBlick, fromSeconds);
  const toBlick = blickAtSeconds(loaded.tempoMarks, loaded.quarterBlick, toSeconds);
  if (!Number.isFinite(fromBlick) || !Number.isFinite(toBlick) || fromBlick < 0 || toBlick < 0) {
    throw codedError("TIME_AXIS_MAPPING_UNAVAILABLE", `${label} cannot map into project BLICK coordinates`);
  }
}

function evaluateBaselineAtSeconds(baseline, seconds, loaded) {
  return evaluateCapturedAutomation(baseline, localBlickAtSeconds(seconds, loaded));
}

function localBlickAtSeconds(seconds, loaded) {
  const absolute = blickAtSeconds(loaded.tempoMarks, loaded.quarterBlick, seconds);
  const rounded = Math.round(absolute);
  const local = rounded - loaded.timeOffsetBlick;
  if (!Number.isFinite(absolute) || !Number.isSafeInteger(local)) {
    throw codedError("TIME_AXIS_MAPPING_UNAVAILABLE", "seconds cannot map to local BLICK", { seconds });
  }
  return local;
}

function anchorLocalBlick(anchor, loaded, descriptors) {
  const descriptor = descriptors.get(anchor.canonicalKey);
  if (descriptor?.technique.kind === "portamento") {
    if (anchor.role === "start") {
      return localBlickAtSeconds(descriptor.compiled.fromSeconds, loaded);
    }
    if (anchor.role === "end") {
      return localBlickAtSeconds(descriptor.compiled.toSeconds, loaded);
    }
    if (anchor.role === "boundary_before" || anchor.role === "boundary_at") {
      const boundary = requireLoadedNote(
        loaded,
        descriptor.technique.anchors.toNote,
      ).onsetBlick;
      return boundary + (anchor.role === "boundary_before" ? -1 : 0);
    }
  }
  return localBlickAtSeconds(anchor.timeSeconds, loaded);
}

function maximumVibratoRate(techniques) {
  return techniques.reduce((maximum, technique) => (
    technique.kind === "vibrato"
      ? Math.max(maximum, technique.model.rateHz, technique.model.endRateHz)
      : maximum
  ), 0);
}

function mergeSpans(spans) {
  const sorted = spans
    .map(({ fromSeconds, toSeconds }) => ({ fromSeconds, toSeconds }))
    .sort((left, right) => left.fromSeconds - right.fromSeconds || left.toSeconds - right.toSeconds);
  const merged = [];
  for (const span of sorted) {
    const previous = merged.at(-1);
    if (!previous || span.fromSeconds > previous.toSeconds + SECOND_QUANTUM) {
      merged.push({ ...span });
      continue;
    }
    previous.toSeconds = Math.max(previous.toSeconds, span.toSeconds);
  }
  return merged;
}

function dedupePointSamples(points, label) {
  const byBlick = new Map();
  for (const point of points) {
    const previous = byBlick.get(point.blick);
    if (previous !== undefined && !sameValue(previous, point.value)) {
      throw codedError("MANDATORY_ANCHOR_BLICK_COLLISION", `${label} samples disagree at one BLICK`, {
        blick: point.blick,
      });
    }
    byBlick.set(point.blick, point.value);
  }
  const output = [...byBlick.entries()]
    .map(([blick, value]) => ({ blick, value }))
    .sort((left, right) => left.blick - right.blick);
  if (output.length > MAX_VERIFICATION_MANDATORY_SAMPLES) {
    throw codedError("PLAN_VERIFICATION_SAMPLE_BUDGET_EXCEEDED", "mandatory interpolation samples exceed the verifier budget", {
      maximum: MAX_VERIFICATION_MANDATORY_SAMPLES,
      actual: output.length,
    });
  }
  return output;
}

function dedupeIntegers(values) {
  return [...new Set(values)].sort((left, right) => left - right);
}

function pointValueAt(points, blick) {
  const point = points.find((entry) => entry.blick === blick);
  if (!point) {
    throw codedError("INTERPOLATION_EXPECTED_VALUE_MISMATCH", "mandatory anchor is absent from the compiled curve", { blick });
  }
  return point.value;
}

function requireLoadedNote(loaded, index) {
  const note = loaded.noteByIndex.get(index);
  if (!note) throw codedError("INTERNAL_ERROR", "TechniqueIR anchor is absent from loaded notes", { index });
  return note;
}

function captureEvidenceRequired(parameters, missing) {
  const remediation = captureRemediation(parameters);
  return codedError(
    "CAPTURE_EVIDENCE_REQUIRED",
    `Capture a range snapshot with sv_snapshot_range arguments ${JSON.stringify(remediation)}.`,
    { remediation, missing },
  );
}

function profileHash(profile) {
  if (typeof profile?.profileHash === "string" && profile.profileHash.length > 0) return profile.profileHash;
  if (typeof profile?.evidenceSha256 === "string" && profile.evidenceSha256.length > 0) {
    return contentHash({ profileId: profile.profileId ?? null, evidenceSha256: profile.evidenceSha256 });
  }
  return contentHash({ kind: "unbound-host-profile", modelVersion: "pitch-techniques-v1" });
}

function assertKnownKeys(value, allowed, path) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw codedError("INVALID_ARGUMENTS", `${path} contains unknown field: ${unknown.join(", ")}`, { path, unknown });
  }
}

function requireNoteIndex(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw codedError("INVALID_ARGUMENTS", `${path} must be a non-negative safe integer`);
  }
}

function normalizePriority(value, path) {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < -100 || value > 100) {
    throw codedError("INVALID_ARGUMENTS", `${path} must be an integer between -100 and 100`);
  }
  return value;
}

function optionalNumber(value, minimum, maximum, fallback, path) {
  if (value === undefined) return fallback;
  requireNumber(value, minimum, maximum, path);
  return value;
}

function optionalInteger(value, minimum, maximum, fallback, path) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw codedError("INVALID_ARGUMENTS", `${path} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function requireNumber(value, minimum, maximum, path) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw codedError("INVALID_ARGUMENTS", `${path} must be a number between ${minimum} and ${maximum}`);
  }
}

function assertStrictOrder(left, right, leftName, rightName, path) {
  if (left < right) return;
  throw codedError("INVALID_ARGUMENTS", `${path}.${leftName} must be less than ${rightName}`);
}

function quantize(value) {
  const output = Math.round(value / CENT_QUANTUM) * CENT_QUANTUM;
  return Object.is(output, -0) ? 0 : output;
}

function quantizeSeconds(value) {
  const output = Math.round(value / SECOND_QUANTUM) * SECOND_QUANTUM;
  return Object.is(output, -0) ? 0 : output;
}

function sameValue(left, right) {
  return Math.abs(left - right) <= CENT_QUANTUM;
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function codedError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}
