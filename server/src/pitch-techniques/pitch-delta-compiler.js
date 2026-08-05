import { contentHash } from "../canonical-json.js";
import { encodeDense } from "../dense-codec.js";
import { blickAtSeconds, secondsAtBlick } from "../musical-time.js";
import {
  compilePitchDeltaTransition as compileTransitionOracle,
  PITCH_DELTA_LIMIT_CENT,
  projectTransitionMandatoryBlickAnchors,
} from "./model.js";
import { assertNormalizedTechniqueIr } from "./ir.js";

export const PITCH_DELTA_MAX_COMPILED_POINTS = 4_000;
export const PITCH_DELTA_MAX_POINTS_PER_CURVE = 2_000;

const TIME_TOLERANCE_SECONDS = 1e-9;
const CENT_QUANTUM = 1e-6;
const CENT_TOLERANCE = CENT_QUANTUM;

const PITCH_DELTA_POINT_DENSE_PROFILE = Object.freeze({
  schemaVersion: "1",
  kind: "pitch-delta-points",
  maxRows: PITCH_DELTA_MAX_POINTS_PER_CURVE,
  columns: Object.freeze([
    Object.freeze({ name: "blick", unit: "blick", type: "integer", encoding: "delta" }),
    Object.freeze({
      name: "value",
      unit: "cent",
      type: "number",
      encoding: "qint",
      scale: CENT_QUANTUM,
      maxError: CENT_QUANTUM / 2,
    }),
  ]),
});

// 公开 planner 尚未接入前，这里只生成可封存的 replace 请求，不执行任何宿主操作。
export function compilePitchDeltaMutationPlan(input) {
  assertRecord(input, "$");
  assertKnownKeys(input, ["ir", "composition", "evidence", "maxPoints"], "$");
  const ir = assertNormalizedTechniqueIr(input.ir);
  const composition = normalizeComposition(input.composition, ir);
  const evidence = normalizeEvidence(input.evidence, composition);
  const maxPoints = normalizeMaxPoints(input.maxPoints);
  const transitions = compileTransitions(ir, evidence);
  const anchors = normalizeMandatoryAnchors(evidence.mandatoryAnchors, ir, transitions);
  assertTransitionAnchors(transitions, anchors);
  assertTechniqueBoundaryAnchors(ir, anchors);
  const runs = compileDenseRuns({ composition, evidence, transitions });
  const attached = attachMandatoryAnchors({ runs, anchors, evidence, transitions });
  const encoded = encodeCurves(attached, maxPoints);
  const curves = encoded.curves;
  const mutation = {
    action: "dry_run",
    atomic: true,
    curves,
  };
  const plan = {
    schemaVersion: 1,
    surface: "pitchDelta",
    compositionMode: "baseline_plus_contribution",
    mutationMode: "replace",
    referenceFrame: "pitch_delta_contribution_cents",
    interpolationMethod: ir.target.interpolationEvidence.pitchDelta.method,
    mutation,
    postcondition: {
      status: "pending_t12_host_interpolation",
      requiredRead: "Automation.get",
    },
    summary: {
      curveCount: curves.length,
      pointCount: encoded.pointCount,
      densePointCount: runs.reduce((total, run) => total + run.densePointCount, 0),
      mandatoryAnchorCount: anchors.length,
      overriddenDensePointCount: attached.reduce(
        (total, run) => total + run.overriddenDensePointCount,
        0,
      ),
      serializedMutationBytes: Buffer.byteLength(JSON.stringify(mutation), "utf8"),
    },
  };
  return deepFreeze({
    ...plan,
    planHash: contentHash(plan),
  });
}

export {
  compilePitchDeltaTransition,
  projectTransitionMandatoryBlickAnchors,
} from "./model.js";

function normalizeComposition(composition, ir) {
  assertRecord(composition, "$/composition");
  assertDeepFrozen(composition, "$/composition");
  assertKnownKeys(
    composition,
    [
      "techniqueOrder",
      "seconds",
      "finiteMask",
      "contributionCents",
      "warnings",
      "summary",
      "finalPitchDeltaCents",
      "compositionHash",
    ],
    "$/composition",
  );
  if (typeof composition.compositionHash !== "string" || composition.compositionHash.length === 0) {
    throw codedError("COMPOSITION_EVIDENCE_INVALID", "compositionHash is required", {
      path: "$/composition/compositionHash",
    });
  }
  const { compositionHash, ...body } = composition;
  if (contentHash(body) !== compositionHash) {
    throw codedError("COMPOSITION_EVIDENCE_MISMATCH", "compositionHash does not match its body", {
      path: "$/composition/compositionHash",
    });
  }
  assertCompositionTechniqueOrder(composition.techniqueOrder, ir);
  if (!Array.isArray(composition.seconds) || composition.seconds.length === 0) {
    throw codedError("COMPOSITION_EVIDENCE_INVALID", "composition seconds must be non-empty", {
      path: "$/composition/seconds",
    });
  }
  const length = composition.seconds.length;
  if (
    !Array.isArray(composition.finiteMask)
    || !Array.isArray(composition.contributionCents)
    || composition.finiteMask.length !== length
    || composition.contributionCents.length !== length
  ) {
    throw codedError("COMPOSITION_EVIDENCE_INVALID", "composition vectors must align", {
      path: "$/composition",
      length,
    });
  }
  if (
    composition.finalPitchDeltaCents !== undefined
    && (!Array.isArray(composition.finalPitchDeltaCents)
      || composition.finalPitchDeltaCents.length !== length)
  ) {
    throw codedError("COMPOSITION_EVIDENCE_INVALID", "finalPitchDeltaCents must align", {
      path: "$/composition/finalPitchDeltaCents",
      length,
    });
  }
  const seconds = [];
  const finiteMask = [];
  const contributionCents = [];
  let previousSeconds = -Infinity;
  for (let index = 0; index < length; index += 1) {
    const secondsValue = composition.seconds[index];
    if (!Number.isFinite(secondsValue) || secondsValue <= previousSeconds) {
      throw codedError("COMPOSITION_EVIDENCE_INVALID", "composition seconds must strictly increase", {
        path: `$/composition/seconds/${index}`,
        previousSeconds,
        value: secondsValue,
      });
    }
    const finite = composition.finiteMask[index];
    const contribution = composition.contributionCents[index];
    if (typeof finite !== "boolean" || (finite && !Number.isFinite(contribution)) || (!finite && contribution !== null)) {
      throw codedError("COMPOSITION_EVIDENCE_INVALID", "finite mask and contribution values disagree", {
        path: `$/composition/${finite ? "contributionCents" : "finiteMask"}/${index}`,
      });
    }
    seconds.push(secondsValue);
    finiteMask.push(finite);
    contributionCents.push(finite ? contribution : null);
    previousSeconds = secondsValue;
  }
  return {
    source: composition,
    seconds,
    finiteMask,
    contributionCents,
  };
}

function assertCompositionTechniqueOrder(actual, ir) {
  if (!Array.isArray(actual) || actual.length !== ir.techniques.length) {
    throw codedError("COMPOSITION_EVIDENCE_MISMATCH", "composition technique order does not match the IR", {
      expected: ir.techniques.length,
      actual: Array.isArray(actual) ? actual.length : null,
    });
  }
  const expected = [...ir.techniques].sort((left, right) => (
    left.priority - right.priority || compareStrings(left.canonicalKey, right.canonicalKey)
  ));
  for (let index = 0; index < expected.length; index += 1) {
    const entry = actual[index];
    if (
      !isRecord(entry)
      || entry.id !== expected[index].id
      || entry.priority !== expected[index].priority
      || entry.canonicalKey !== expected[index].canonicalKey
    ) {
      throw codedError("COMPOSITION_EVIDENCE_MISMATCH", "composition technique order differs from the IR", {
        index,
        expected: techniqueReference(expected[index]),
        actual: entry ?? null,
      });
    }
  }
}

function normalizeEvidence(evidence, composition) {
  assertRecord(evidence, "$/evidence");
  assertDeepFrozen(evidence, "$/evidence");
  assertKnownKeys(
    evidence,
    [
      "notes",
      "occurrenceTimeOffsetBlick",
      "tempoMarks",
      "quarterBlick",
      "baselineCents",
      "mandatoryAnchors",
    ],
    "$/evidence",
  );
  const notes = normalizeNotes(evidence.notes);
  const occurrenceTimeOffsetBlick = requireSafeInteger(
    evidence.occurrenceTimeOffsetBlick,
    "$/evidence/occurrenceTimeOffsetBlick",
  );
  const timeAxis = normalizeTimeAxis(evidence.tempoMarks, evidence.quarterBlick);
  const baselineCents = normalizeBaselineCents(evidence.baselineCents, composition);
  return {
    notes,
    occurrenceTimeOffsetBlick,
    ...timeAxis,
    baselineCents,
    mandatoryAnchors: evidence.mandatoryAnchors,
  };
}

function normalizeNotes(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw codedError("INVALID_PITCH_DELTA_EVIDENCE", "notes must be a non-empty array", {
      path: "$/evidence/notes",
    });
  }
  const byIndex = new Map();
  for (const [position, note] of value.entries()) {
    const path = `$/evidence/notes/${position}`;
    assertRecord(note, path);
    assertKnownKeys(note, ["indexInGroup", "onsetBlick", "durationBlick", "pitchSemitone"], path);
    const indexInGroup = requireSafeInteger(note.indexInGroup, `${path}/indexInGroup`, 0);
    const onsetBlick = requireSafeInteger(note.onsetBlick, `${path}/onsetBlick`, 0);
    const durationBlick = requireSafeInteger(note.durationBlick, `${path}/durationBlick`, 1);
    if (!Number.isFinite(note.pitchSemitone)) {
      throw codedError("INVALID_PITCH_DELTA_EVIDENCE", "pitchSemitone must be finite", {
        path: `${path}/pitchSemitone`,
      });
    }
    const endBlick = onsetBlick + durationBlick;
    if (!Number.isSafeInteger(endBlick)) {
      throw codedError("INVALID_INTEGER_SEMANTIC_FIELD", "note end BLICK exceeds safe integers", {
        field: "endBlick",
        path: `${path}/endBlick`,
        value: endBlick,
      });
    }
    if (byIndex.has(indexInGroup)) {
      throw codedError("INVALID_PITCH_DELTA_EVIDENCE", "notes repeat indexInGroup", {
        indexInGroup,
      });
    }
    byIndex.set(indexInGroup, {
      indexInGroup,
      onsetBlick,
      durationBlick,
      endBlick,
      pitchSemitone: note.pitchSemitone,
    });
  }
  return byIndex;
}

function normalizeTimeAxis(tempoMarks, quarterBlick) {
  if (!Number.isSafeInteger(quarterBlick) || quarterBlick < 1) {
    throw codedError("INVALID_PITCH_DELTA_EVIDENCE", "quarterBlick must be a positive safe integer", {
      path: "$/evidence/quarterBlick",
    });
  }
  if (!Array.isArray(tempoMarks) || tempoMarks.length === 0) {
    throw codedError("TIME_AXIS_MAPPING_UNAVAILABLE", "tempoMarks are required for pitchDelta compilation", {
      path: "$/evidence/tempoMarks",
    });
  }
  let previousBlick = -Infinity;
  let previousSeconds = -Infinity;
  const normalized = tempoMarks.map((mark, index) => {
    const path = `$/evidence/tempoMarks/${index}`;
    assertRecord(mark, path);
    assertKnownKeys(mark, ["positionBlick", "positionSeconds", "bpm"], path);
    const positionBlick = requireSafeInteger(mark.positionBlick, `${path}/positionBlick`, 0);
    if (
      !Number.isFinite(mark.positionSeconds)
      || !Number.isFinite(mark.bpm)
      || mark.bpm <= 0
      || positionBlick <= previousBlick
      || mark.positionSeconds <= previousSeconds
    ) {
      throw codedError("INVALID_PITCH_DELTA_EVIDENCE", "tempoMarks must be strictly ordered finite positions", {
        path,
      });
    }
    previousBlick = positionBlick;
    previousSeconds = mark.positionSeconds;
    return { positionBlick, positionSeconds: mark.positionSeconds, bpm: mark.bpm };
  });
  return { tempoMarks: normalized, quarterBlick };
}

function normalizeBaselineCents(value, composition) {
  if (!Array.isArray(value) || value.length !== composition.seconds.length) {
    throw codedError("INVALID_PITCH_DELTA_EVIDENCE", "baselineCents must align with composition", {
      path: "$/evidence/baselineCents",
      expected: composition.seconds.length,
      actual: Array.isArray(value) ? value.length : null,
    });
  }
  return value.map((entry, index) => {
    const finite = composition.finiteMask[index];
    if ((finite && !Number.isFinite(entry)) || (!finite && entry !== null)) {
      throw codedError("INVALID_PITCH_DELTA_EVIDENCE", "baselineCents must preserve finite-mask gaps", {
        path: `$/evidence/baselineCents/${index}`,
      });
    }
    if (
      composition.source.finalPitchDeltaCents !== undefined
      && finite
      && !sameCents(
        composition.source.finalPitchDeltaCents[index],
        entry + composition.contributionCents[index],
      )
    ) {
      throw codedError("COMPOSITION_EVIDENCE_MISMATCH", "composition final values do not match baseline plus contribution", {
        index,
      });
    }
    return finite ? entry : null;
  });
}

function compileTransitions(ir, evidence) {
  const transitions = new Map();
  const boundaries = new Map();
  for (const technique of ir.techniques) {
    if (technique.kind !== "portamento") continue;
    const fromNote = evidence.notes.get(technique.anchors.fromNote);
    const toNote = evidence.notes.get(technique.anchors.toNote);
    if (!fromNote || !toNote) {
      throw codedError("TRANSITION_NOTE_NOT_CAPTURED", "transition anchors must be present in captured notes", {
        canonicalKey: technique.canonicalKey,
        fromNote: technique.anchors.fromNote,
        toNote: technique.anchors.toNote,
      });
    }
    const compiled = compileTransitionOracle({
      fromNote: withSeconds(fromNote, evidence),
      toNote: withSeconds(toNote, evidence),
      widthSeconds: technique.span.toSeconds - technique.span.fromSeconds,
      curve: transitionCurve(technique.model),
    });
    if (
      !sameSeconds(compiled.fromSeconds, technique.span.fromSeconds)
      || !sameSeconds(compiled.toSeconds, technique.span.toSeconds)
    ) {
      throw codedError("TRANSITION_SPAN_MISMATCH", "TechniqueIR transition span must be symmetric around the score boundary", {
        canonicalKey: technique.canonicalKey,
        expected: { fromSeconds: compiled.fromSeconds, toSeconds: compiled.toSeconds },
        actual: technique.span,
      });
    }
    const boundaryAbsoluteBlick = absoluteBlick(toNote.onsetBlick, evidence);
    const spanFromAbsoluteBlick = secondsToAbsoluteBlick(compiled.fromSeconds, evidence);
    const spanToAbsoluteBlick = secondsToAbsoluteBlick(compiled.toSeconds, evidence);
    const projected = projectTransitionMandatoryBlickAnchors({
      spanFromBlick: spanFromAbsoluteBlick,
      boundaryBlick: boundaryAbsoluteBlick,
      spanToBlick: spanToAbsoluteBlick,
    });
    const prior = boundaries.get(boundaryAbsoluteBlick);
    if (prior) {
      throw codedError("TRANSITION_BOUNDARY_CONFLICT", "multiple portamenti target the same score boundary", {
        boundaryAbsoluteBlick,
        leftCanonicalKey: prior,
        rightCanonicalKey: technique.canonicalKey,
      });
    }
    boundaries.set(boundaryAbsoluteBlick, technique.canonicalKey);
    const localProjection = new Map(
      projected.map((anchor) => [anchor.role, localBlick(anchor.blick, evidence)]),
    );
    const inflectionSeconds = technique.model.family === "richards_segment_normalized"
      ? compiled.fromSeconds + compiled.widthSeconds * (technique.model.inflectionRatio ?? 0.5)
      : null;
    transitions.set(technique.canonicalKey, {
      technique,
      fromNote,
      toNote,
      compiled,
      localProjection,
      inflectionSeconds,
    });
  }
  return transitions;
}

function withSeconds(note, evidence) {
  return {
    ...note,
    onsetSeconds: secondsAtAbsoluteBlick(absoluteBlick(note.onsetBlick, evidence), evidence),
    endSeconds: secondsAtAbsoluteBlick(absoluteBlick(note.endBlick, evidence), evidence),
  };
}

function transitionCurve(model) {
  assertRecord(model, "$/technique/model");
  if (model.family === "linear") return { family: "linear" };
  if (model.family === "richards_segment_normalized") {
    return {
      family: "richards",
      inflectionRatio: model.inflectionRatio ?? 0.5,
      sharpness: model.sharpness ?? 6,
      asymmetryLogB: model.asymmetryLogB ?? 0,
    };
  }
  throw codedError("UNSUPPORTED_TRANSITION_MODEL", "portamento requires a linear or normalized Richards model", {
    family: model.family,
  });
}

function normalizeMandatoryAnchors(value, ir, transitions) {
  if (!Array.isArray(value)) {
    throw codedError("INVALID_PITCH_DELTA_EVIDENCE", "mandatoryAnchors must be an array", {
      path: "$/evidence/mandatoryAnchors",
    });
  }
  const knownKeys = new Set(ir.techniques.map((technique) => technique.canonicalKey));
  const seen = new Set();
  const anchors = value.map((anchor, index) => {
    const path = `$/evidence/mandatoryAnchors/${index}`;
    assertRecord(anchor, path);
    assertKnownKeys(
      anchor,
      ["canonicalKey", "role", "timeSeconds", "contributionCents", "baselineCents"],
      path,
    );
    if (typeof anchor.canonicalKey !== "string" || !knownKeys.has(anchor.canonicalKey)) {
      throw codedError("INVALID_PITCH_DELTA_EVIDENCE", "mandatory anchor references an unknown technique", {
        path: `${path}/canonicalKey`,
        canonicalKey: anchor.canonicalKey,
      });
    }
    if (typeof anchor.role !== "string" || !/^[a-z][a-z_]*$/.test(anchor.role)) {
      throw codedError("INVALID_PITCH_DELTA_EVIDENCE", "mandatory anchor role is invalid", {
        path: `${path}/role`,
      });
    }
    for (const field of ["timeSeconds", "contributionCents", "baselineCents"]) {
      if (!Number.isFinite(anchor[field])) {
        throw codedError("INVALID_PITCH_DELTA_EVIDENCE", `mandatory anchor ${field} must be finite`, {
          path: `${path}/${field}`,
        });
      }
    }
    const identity = `${anchor.canonicalKey}\u0000${anchor.role}`;
    if (seen.has(identity)) {
      throw codedError("MANDATORY_ANCHOR_DUPLICATE", "mandatory anchors repeat a technique role", {
        canonicalKey: anchor.canonicalKey,
        role: anchor.role,
      });
    }
    seen.add(identity);
    return {
      canonicalKey: anchor.canonicalKey,
      role: anchor.role,
      timeSeconds: anchor.timeSeconds,
      contributionCents: anchor.contributionCents,
      baselineCents: anchor.baselineCents,
      transition: transitions.get(anchor.canonicalKey) ?? null,
    };
  });
  return anchors.sort((left, right) => (
    left.timeSeconds - right.timeSeconds
    || compareStrings(left.canonicalKey, right.canonicalKey)
    || compareStrings(left.role, right.role)
  ));
}

function assertTransitionAnchors(transitions, anchors) {
  for (const [canonicalKey, transition] of transitions) {
    const byRole = new Map(
      anchors
        .filter((anchor) => anchor.canonicalKey === canonicalKey)
        .map((anchor) => [anchor.role, anchor]),
    );
    const expected = [
      ["start", transition.compiled.fromSeconds],
      ["boundary_before", transition.compiled.boundarySeconds],
      ["boundary_at", transition.compiled.boundarySeconds],
      ["end", transition.compiled.toSeconds],
      ...(transition.inflectionSeconds === null ? [] : [["inflection", transition.inflectionSeconds]]),
    ];
    for (const [role, expectedSeconds] of expected) {
      const anchor = byRole.get(role);
      if (!anchor) {
        throw codedError("MANDATORY_ANCHOR_REQUIRED", "transition is missing a mandatory anchor", {
          canonicalKey,
          role,
        });
      }
      if (!sameSeconds(anchor.timeSeconds, expectedSeconds)) {
        throw codedError("MANDATORY_ANCHOR_TIME_MISMATCH", "mandatory anchor seconds differ from the transition oracle", {
          canonicalKey,
          role,
          expectedSeconds,
          actualSeconds: anchor.timeSeconds,
        });
      }
    }
    const before = byRole.get("boundary_before");
    const at = byRole.get("boundary_at");
    const expectedJump = transition.compiled.atBoundaryContributionCent
      - transition.compiled.beforeBoundaryContributionCent;
    const actualJump = at.contributionCents - before.contributionCents;
    if (!sameCents(actualJump, expectedJump)) {
      throw codedError("TRANSITION_SCORE_STEP_NOT_CANCELLED", "boundary anchor contributions do not cancel the score step", {
        canonicalKey,
        expectedJumpCents: expectedJump,
        actualJumpCents: actualJump,
      });
    }
    const beforeAbsolutePitch = transition.fromNote.pitchSemitone + before.contributionCents / 100;
    const atAbsolutePitch = transition.toNote.pitchSemitone + at.contributionCents / 100;
    if (Math.abs(beforeAbsolutePitch - atAbsolutePitch) > CENT_TOLERANCE / 100) {
      throw codedError("TRANSITION_SCORE_STEP_NOT_CANCELLED", "score-step absolute pitch is discontinuous", {
        canonicalKey,
        beforeAbsolutePitch,
        atAbsolutePitch,
      });
    }
  }
}

function assertTechniqueBoundaryAnchors(ir, anchors) {
  for (const technique of ir.techniques) {
    if (technique.kind === "portamento") continue;
    const byRole = new Map(
      anchors
        .filter((anchor) => anchor.canonicalKey === technique.canonicalKey)
        .map((anchor) => [anchor.role, anchor]),
    );
    for (const [role, expectedSeconds] of [
      ["start", technique.span.fromSeconds],
      ["end", technique.span.toSeconds],
    ]) {
      const anchor = byRole.get(role);
      if (!anchor) {
        throw codedError("MANDATORY_ANCHOR_REQUIRED", "technique is missing a span boundary anchor", {
          canonicalKey: technique.canonicalKey,
          role,
        });
      }
      if (!sameSeconds(anchor.timeSeconds, expectedSeconds)) {
        throw codedError("MANDATORY_ANCHOR_TIME_MISMATCH", "technique span boundary differs from canonical IR", {
          canonicalKey: technique.canonicalKey,
          role,
          expectedSeconds,
          actualSeconds: anchor.timeSeconds,
        });
      }
    }
  }
}

function compileDenseRuns({ composition, evidence, transitions }) {
  const runs = [];
  let active = null;
  for (let index = 0; index < composition.seconds.length; index += 1) {
    if (!composition.finiteMask[index]) {
      if (active) runs.push(active);
      active = null;
      continue;
    }
    if (!active) {
      active = {
        startSeconds: composition.seconds[index],
        endSeconds: composition.seconds[index],
        points: new Map(),
        densePointCount: 0,
        overriddenDensePointCount: 0,
      };
    }
    const contributionCents = composition.contributionCents[index];
    const baselineCents = evidence.baselineCents[index];
    const finalCents = checkedFinalCents(
      baselineCents,
      contributionCents,
      transitions,
      { index, seconds: composition.seconds[index] },
    );
    const absolute = secondsToAbsoluteBlick(composition.seconds[index], evidence);
    const blick = localBlick(absolute, evidence);
    insertDensePoint(active, {
      blick,
      value: finalCents,
      index,
      seconds: composition.seconds[index],
    });
    active.endSeconds = composition.seconds[index];
  }
  if (active) runs.push(active);
  if (runs.length === 0) {
    throw codedError("PITCH_DELTA_NO_FINITE_SAMPLES", "composition contains no finite runs");
  }
  return runs;
}

function insertDensePoint(run, point) {
  const previous = run.points.get(point.blick);
  if (previous) {
    if (!sameCents(previous.value, point.value)) {
      throw codedError("PITCH_DELTA_TIME_RESOLUTION_TOO_COARSE", "multiple dense samples collapse to one BLICK", {
        blick: point.blick,
        previous,
        current: point,
      });
    }
    return;
  }
  run.points.set(point.blick, {
    blick: point.blick,
    value: point.value,
    source: "dense",
  });
  run.densePointCount += 1;
}

function attachMandatoryAnchors({ runs, anchors, evidence, transitions }) {
  for (const anchor of anchors) {
    const run = runs.find((candidate) => (
      anchor.timeSeconds >= candidate.startSeconds - TIME_TOLERANCE_SECONDS
      && anchor.timeSeconds <= candidate.endSeconds + TIME_TOLERANCE_SECONDS
    ));
    if (!run) {
      throw codedError("MANDATORY_ANCHOR_OUTSIDE_FINITE_RUN", "mandatory anchors cannot cross a composition gap", {
        canonicalKey: anchor.canonicalKey,
        role: anchor.role,
        timeSeconds: anchor.timeSeconds,
      });
    }
    const blick = anchorLocalBlick(anchor, evidence);
    const value = checkedFinalCents(
      anchor.baselineCents,
      anchor.contributionCents,
      transitions,
      { canonicalKey: anchor.canonicalKey, role: anchor.role, seconds: anchor.timeSeconds },
    );
    const previous = run.points.get(blick);
    if (previous?.source === "mandatory" && !sameCents(previous.value, value)) {
      throw codedError("MANDATORY_ANCHOR_BLICK_COLLISION", "mandatory anchors map different values to one BLICK", {
        blick,
        previous,
        current: { canonicalKey: anchor.canonicalKey, role: anchor.role, value },
      });
    }
    if (previous?.source === "dense" && !sameCents(previous.value, value)) {
      run.overriddenDensePointCount += 1;
    }
    run.points.set(blick, {
      blick,
      value,
      source: "mandatory",
      canonicalKey: anchor.canonicalKey,
      role: anchor.role,
    });
  }
  return runs;
}

function anchorLocalBlick(anchor, evidence) {
  const projected = anchor.transition?.localProjection.get(anchor.role);
  if (projected !== undefined) return projected;
  return localBlick(secondsToAbsoluteBlick(anchor.timeSeconds, evidence), evidence);
}

function encodeCurves(runs, maxPoints) {
  let totalPoints = 0;
  const curves = runs.map((run, index) => {
    const points = [...run.points.values()]
      .map(({ blick, value }) => ({ blick, value }))
      .sort((left, right) => left.blick - right.blick);
    if (points.length < 2 || points.at(-1).blick <= points[0].blick) {
      throw codedError("PITCH_DELTA_RUN_TOO_SHORT", "a finite run must map to two distinct BLICK points", {
        run: index,
        pointCount: points.length,
      });
    }
    if (points.length > PITCH_DELTA_MAX_POINTS_PER_CURVE) {
      throw codedError("PITCH_DELTA_CURVE_POINT_BUDGET_EXCEEDED", "one replace curve exceeds the transaction point limit", {
        run: index,
        maximum: PITCH_DELTA_MAX_POINTS_PER_CURVE,
        actual: points.length,
      });
    }
    totalPoints += points.length;
    return {
      parameter: "pitchDelta",
      mode: "replace",
      range: {
        fromBlick: points[0].blick,
        toBlick: points.at(-1).blick,
        coordinate: "local",
      },
      points: encodeDense(points, PITCH_DELTA_POINT_DENSE_PROFILE),
    };
  });
  if (totalPoints > maxPoints) {
    throw codedError("PITCH_DELTA_POINT_BUDGET_EXCEEDED", "compiled pitchDelta points exceed the plan budget", {
      maximum: maxPoints,
      actual: totalPoints,
    });
  }
  return { curves, pointCount: totalPoints };
}

function checkedFinalCents(baselineCents, contributionCents, transitions, details) {
  const finalCents = baselineCents + contributionCents;
  if (!Number.isFinite(finalCents) || Math.abs(finalCents) > PITCH_DELTA_LIMIT_CENT) {
    const hasTransition = transitions.size > 0;
    throw codedError(
      hasTransition ? "TRANSITION_EXCEEDS_PITCH_DELTA_RANGE" : "PITCH_DELTA_RANGE_EXCEEDED",
      "baseline plus contribution exceeds the pitchDelta range",
      {
        stage: "final",
        baselineCents,
        contributionCents,
        finalPitchDeltaCents: finalCents,
        maximumAbsCents: PITCH_DELTA_LIMIT_CENT,
        ...details,
      },
    );
  }
  return quantizeCents(finalCents);
}

function secondsAtAbsoluteBlick(blick, evidence) {
  const seconds = secondsAtBlick(evidence.tempoMarks, evidence.quarterBlick, blick);
  if (!Number.isFinite(seconds)) {
    throw codedError("TIME_AXIS_MAPPING_UNAVAILABLE", "BLICK-to-seconds mapping is unavailable", { blick });
  }
  return seconds;
}

function secondsToAbsoluteBlick(seconds, evidence) {
  const rawBlick = blickAtSeconds(evidence.tempoMarks, evidence.quarterBlick, seconds);
  const blick = Math.round(rawBlick);
  if (!Number.isFinite(rawBlick) || !Number.isSafeInteger(blick) || blick < 0) {
    throw codedError("TIME_AXIS_MAPPING_UNAVAILABLE", "seconds-to-BLICK mapping is unavailable", {
      seconds,
      rawBlick: Number.isFinite(rawBlick) ? rawBlick : null,
    });
  }
  return blick;
}

function absoluteBlick(local, evidence) {
  const absolute = evidence.occurrenceTimeOffsetBlick + local;
  if (!Number.isSafeInteger(absolute) || absolute < 0) {
    throw codedError("TIME_AXIS_MAPPING_UNAVAILABLE", "local BLICK cannot map to a valid absolute BLICK", {
      localBlick: local,
      occurrenceTimeOffsetBlick: evidence.occurrenceTimeOffsetBlick,
      absoluteBlick: absolute,
    });
  }
  return absolute;
}

function localBlick(absolute, evidence) {
  const local = absolute - evidence.occurrenceTimeOffsetBlick;
  if (!Number.isSafeInteger(local)) {
    throw codedError("TIME_AXIS_MAPPING_UNAVAILABLE", "absolute BLICK cannot map to a local BLICK", {
      absoluteBlick: absolute,
      occurrenceTimeOffsetBlick: evidence.occurrenceTimeOffsetBlick,
      localBlick: local,
    });
  }
  return local;
}

function normalizeMaxPoints(value) {
  if (value === undefined) return PITCH_DELTA_MAX_COMPILED_POINTS;
  if (!Number.isSafeInteger(value) || value < 2 || value > PITCH_DELTA_MAX_COMPILED_POINTS) {
    throw codedError("INVALID_ARGUMENTS", "maxPoints must be an integer within the compiled point budget", {
      path: "$/maxPoints",
      minimum: 2,
      maximum: PITCH_DELTA_MAX_COMPILED_POINTS,
      value,
    });
  }
  return value;
}

function quantizeCents(value) {
  const quantized = Math.round(value / CENT_QUANTUM) * CENT_QUANTUM;
  return Object.is(quantized, -0) ? 0 : quantized;
}

function sameSeconds(left, right) {
  return Math.abs(left - right) <= TIME_TOLERANCE_SECONDS;
}

function sameCents(left, right) {
  return Math.abs(left - right) <= CENT_TOLERANCE;
}

function techniqueReference(technique) {
  return {
    id: technique.id,
    priority: technique.priority,
    canonicalKey: technique.canonicalKey,
  };
}

function compareStrings(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function requireSafeInteger(value, path, minimum = Number.MIN_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw codedError("INVALID_INTEGER_SEMANTIC_FIELD", "value must be a safe integer", {
      path,
      value,
      minimum,
    });
  }
  return value;
}

function assertDeepFrozen(value, path, seen = new WeakSet()) {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  if (!Object.isFrozen(value)) {
    throw codedError("FROZEN_EVIDENCE_REQUIRED", "compiler inputs must be deeply frozen", { path });
  }
  seen.add(value);
  for (const child of Object.values(value)) assertDeepFrozen(child, path, seen);
}

function assertKnownKeys(value, allowed, path) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw codedError("INVALID_ARGUMENTS", `unknown field: ${unknown.join(", ")}`, { path, unknown });
  }
}

function assertRecord(value, path) {
  if (isRecord(value)) return;
  throw codedError("INVALID_ARGUMENTS", "value must be an object", { path });
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function codedError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}
