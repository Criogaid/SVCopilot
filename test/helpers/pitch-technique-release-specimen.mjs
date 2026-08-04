import { contentHash } from "../../server/src/canonical-json.js";
import { composeTechniqueContributions } from "../../server/src/pitch-techniques/compose.js";
import {
  compilePitchDeltaMutationPlan,
  compilePitchDeltaTransition,
} from "../../server/src/pitch-techniques/pitch-delta-compiler.js";
import { normalizeTechniqueIr } from "../../server/src/pitch-techniques/ir.js";

const QUARTER_BLICK = 1_000;
const OCCURRENCE_OFFSET_BLICK = 2_000;
const WIDTH_SECONDS = 0.4;
const BASELINE_CENTS = 10;

export function releaseProvenanceHashes() {
  const request = releaseRequestSpecimen();
  const fixture = releaseCompilerFixture();
  const compiled = compilePitchDeltaMutationPlan(fixture);
  return {
    requestHash: contentHash(request),
    irHash: contentHash(fixture.ir),
    planHash: compiled.planHash,
  };
}

export function releaseRequestSpecimen() {
  return {
    operation: "sv_plan_pitch_gesture",
    arguments: {
      contextId: "ctx_release_specimen",
      occurrence: 0,
      gestures: [{
        type: "transition",
        from: 0,
        to: 1,
        width: { seconds: WIDTH_SECONDS },
        curve: {
          family: "richards",
          inflectionRatio: 0.58,
          sharpness: 8,
          asymmetryLogB: 0.3,
        },
      }],
    },
  };
}

function releaseCompilerFixture() {
  const notes = [
    { indexInGroup: 0, onsetBlick: 0, durationBlick: 1_000, pitchSemitone: 60 },
    { indexInGroup: 1, onsetBlick: 1_000, durationBlick: 1_000, pitchSemitone: 62 },
  ];
  const boundarySeconds = 3;
  const span = {
    fromSeconds: boundarySeconds - WIDTH_SECONDS / 2,
    toSeconds: boundarySeconds + WIDTH_SECONDS / 2,
  };
  const ir = normalizeTechniqueIr({
    schemaVersion: 1,
    modelVersion: "pitch-techniques-v1",
    scope: {
      contextId: "ctx_release_specimen",
      occurrence: 0,
      expectedTargetGroupUuid: "group_release_specimen",
    },
    timeDomain: "seconds",
    referenceFrame: "pitch_delta_contribution_cents",
    techniques: [{
      id: "transition",
      requestIndex: 0,
      kind: "portamento",
      anchors: { fromNote: 0, toNote: 1 },
      priority: 0,
      exclusive: false,
      model: {
        family: "richards_segment_normalized",
        inflectionRatio: 0.58,
        sharpness: 8,
        asymmetryLogB: 0.3,
      },
      span,
    }],
    composition: {
      rule: "sum_then_clamp",
      maxAbsCents: 1_200,
      overlapPolicy: "explicit_priority_then_canonical_key",
    },
    target: {
      surface: "pitchDelta",
      compositionMode: "baseline_plus_contribution",
      mutationMode: "replace",
      referenceFrame: "pitch_delta_contribution_cents",
      requiredInclude: {
        include: ["notes", "automation"],
        automationParameters: ["pitchDelta"],
      },
      baselineGuard: { pitchDeltaFingerprint: "sha256:release-specimen" },
      interpolationEvidence: {
        pitchDelta: {
          method: "cubic",
          source: "host_getInterpolationMethod",
          capturedAtContextId: "ctx_release_specimen",
          resolvedParameter: "pitchDelta",
        },
      },
      hostProfileHash: "sha256:release-profile-specimen",
    },
  });
  const transition = compilePitchDeltaTransition({
    fromNote: {
      ...notes[0],
      onsetSeconds: 2,
      endSeconds: 3,
    },
    toNote: {
      ...notes[1],
      onsetSeconds: 3,
      endSeconds: 4,
    },
    widthSeconds: WIDTH_SECONDS,
    curve: {
      family: "richards",
      inflectionRatio: 0.58,
      sharpness: 8,
      asymmetryLogB: 0.3,
    },
  });
  const seconds = [
    transition.fromSeconds,
    transition.fromSeconds + WIDTH_SECONDS / 4,
    transition.boundarySeconds,
    transition.toSeconds - WIDTH_SECONDS / 4,
    transition.toSeconds,
  ];
  const baselineCents = seconds.map(() => BASELINE_CENTS);
  const composition = composeTechniqueContributions({
    ir,
    seconds,
    finiteMask: seconds.map(() => true),
    techniqueValues: [{
      canonicalKey: ir.techniques[0].canonicalKey,
      values: seconds.map((value) => transition.contributionCentAt(value)),
    }],
    baselineCents,
  });
  const anchor = (role, timeSeconds, side) => ({
    canonicalKey: ir.techniques[0].canonicalKey,
    role,
    timeSeconds,
    contributionCents: transition.contributionCentAt(timeSeconds, side),
    baselineCents: BASELINE_CENTS,
  });
  const inflectionSeconds = transition.fromSeconds + WIDTH_SECONDS * 0.58;
  const evidence = deepFreeze({
    notes,
    occurrenceTimeOffsetBlick: OCCURRENCE_OFFSET_BLICK,
    tempoMarks: [{ positionBlick: 0, positionSeconds: 0, bpm: 60 }],
    quarterBlick: QUARTER_BLICK,
    baselineCents,
    mandatoryAnchors: [
      anchor("start", transition.fromSeconds),
      anchor("boundary_before", transition.boundarySeconds, "before"),
      anchor("boundary_at", transition.boundarySeconds, "at"),
      anchor("end", transition.toSeconds),
      anchor("inflection", inflectionSeconds),
    ],
  });
  return { ir, composition, evidence };
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
