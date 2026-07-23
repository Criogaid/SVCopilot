import {
  applyCurvePlan,
  normalizeCurveInput,
  prepareCurvePlan,
  readPointsInRange,
  rollbackCurve,
  resolveParameterName,
  scanTargetOccurrences,
  verifyCurve,
} from "./parameter-curve.js";
import { waitForProcessing } from "./processing.js";
import { ServiceTiming } from "./service-timing.js";
import { createHostScope } from "./snapshot.js";
import { normalizeVoiceParameters } from "./voice-parameters.js";

const MAX_CURVES = 16;
const MAX_NOTE_PATCHES = 200;
const MAX_STRUCTURE_OPERATIONS = 100;
const MAX_CURVE_VERIFY_POINTS = 4_000;
const NOTE_FIELDS = Object.freeze({
  lyrics: { getter: "getLyrics", setter: "setLyrics", kind: "string" },
  phonemesOverride: { getter: "getPhonemes", setter: "setPhonemes", kind: "string" },
  languageOverride: {
    getter: "getLanguageOverride",
    setter: "setLanguageOverride",
    kind: "string",
  },
  pitch: { getter: "getPitch", setter: "setPitch", kind: "midi" },
  onsetBlick: { getter: "getOnset", setter: "setOnset", kind: "nonNegativeInteger" },
  durationBlick: { getter: "getDuration", setter: "setDuration", kind: "positiveInteger" },
  detuneCents: { getter: "getDetune", setter: "setDetune", kind: "number" },
  attributes: { getter: "getAttributes", setter: "setAttributes", kind: "object" },
});

export class PhraseEditService {
  constructor(session, snapshotService, { sleepFn, now = () => Date.now() } = {}) {
    this.session = session;
    this.snapshotService = snapshotService;
    this.sleep = sleepFn;
    this.now = now;
  }

  async edit(request) {
    const timer = new ServiceTiming({
      now: this.now,
      phaseNames: [
        "preflightReadMs",
        "detachedPrepareMs",
        "hostWriteMs",
        "verificationMs",
        "processingWaitMs",
        "rollbackMs",
      ],
    });
    let input;
    try {
      input = normalizeRequest(request);
    } catch (error) {
      return validationFailure(error, timer.finish());
    }
    timer.requestCoordinator();
    return this.session.withExclusive(async (host) => {
      timer.acquiredCoordinator();
      const capture = createHostScope(host);
      let boundaryCalls = 0;
      const mutationState = { touchedCurves: [], notesTouched: false, voiceWritten: false };
      let prepared = null;
      const warnings = [];
      try {
        const resolved = await timer.measure("preflightReadMs", () =>
          resolveTarget(capture, host, this.snapshotService, input.target, {
            readOnly: input.dryRun,
            scanSharedTargets:
              !input.dryRun &&
              (input.notePatches.length > 0 ||
                input.structureOperations.length > 0 ||
                input.curves.length > 0),
            readVoice: input.voicePatch !== undefined,
            readGeometry: input.curves.length > 0,
          })
        );
        prepared = await timer.measure("detachedPrepareMs", () =>
          prepareDetachedPhrase(capture, resolved, input)
        );
        if (input.dryRun) {
          if (
            input.notePatches.length > 0 ||
            input.structureOperations.length > 0 ||
            input.curves.length > 0
          ) {
            warnings.push({
              code: "SHARED_TARGET_CHECK_DEFERRED",
              message:
                "Project-wide shared-target scanning is deferred to commit; dry-run remains side-effect free.",
            });
          }
          if (
            resolved.knownTargetOccurrenceCount > 1 &&
            input.target.allowSharedTargetMutation !== true
          ) {
            warnings.push({
              code: "SHARED_TARGET_DRY_RUN",
              message:
                "This dry-run is safe, but commit requires allowSharedTargetMutation:true because every occurrence shares one target NoteGroup.",
            });
          }
          return phraseSuccess({
            input,
            resolved,
            prepared,
            status: "dry_run",
            effects: "none",
            boundaryCalls,
            processing: null,
            warnings,
            timings: timer.finish(),
          });
        }
        if (!prepared.hasChanges) {
          return phraseSuccess({
            input,
            resolved,
            prepared,
            status: "no_change",
            effects: "none",
            boundaryCalls,
            processing: null,
            verification: {
              attempted: true,
              passed: true,
              phase: preflightVerificationPhase(prepared),
            },
            warnings,
            timings: timer.finish(),
          });
        }

        await timer.measure("hostWriteMs", async () => {
          await capture.call(resolved.roots.project, "newUndoRecord", []);
          boundaryCalls += 1;
          for (const plan of prepared.liveCurvePlans) {
            mutationState.touchedCurves.push(plan);
            await applyCurvePlan(capture, plan);
          }
          if (input.notePatches.length > 0 || input.structureOperations.length > 0) {
            mutationState.notesTouched = true;
            // onset 写入可能立即重排组内 index；所有 noteId 必须先绑定到稳定 handle。
            const liveNotes = await resolveOccurrenceNotes(
              capture,
              resolved.originalTarget,
              resolved.occurrence
            );
            await applyNotePatches(
              capture,
              liveNotes,
              input.notePatches
            );
            await applyStructureOperations(
              capture,
              resolved.roots,
              resolved.originalTarget,
              input.structureOperations,
              liveNotes
            );
          }
          if (prepared.voice.changed) {
            mutationState.voiceWritten = true;
            await capture.call(resolved.reference, "setVoice", [prepared.voice.planned]);
          }
        });

        const verification = await timer.measure("verificationMs", () =>
          verifyCommittedPhrase(capture, resolved, prepared)
        );
        if (!verification.passed) {
          const error = codedError(
            "POSTCONDITION_FAILED",
            "the committed phrase did not match the verified detached plan"
          );
          error.verification = verification;
          throw error;
        }

        await timer.measure("hostWriteMs", async () => {
          await closeUndoBoundary(capture, resolved.roots.project, warnings);
          boundaryCalls += 1;
        });

        let processing = null;
        if (input.waitFor !== "none") {
          try {
            processing = await timer.measure("processingWaitMs", () =>
              waitForProcessing(host, {
                roots: resolved.roots,
                group: resolved.reference,
                kind: input.waitFor,
                expectedNotes: prepared.finalNoteCount,
                timeoutMs: input.timeoutMs,
                pollIntervalMs: input.pollIntervalMs,
                sleepFn: this.sleep,
                now: this.now,
              })
            );
            warnings.push(...processing.warnings);
          } catch (error) {
            // 提交和回读已完成；处理数据只是后续观测，失败不能制造第二次 Undo 或撤销音乐修改。
            processing = {
              ok: false,
              status: "processing_observation_failed",
              data: { state: "unknown", evidence: null },
              error: failureEvidence(error),
              warnings: [],
            };
            warnings.push({
              code: "PROCESSING_OBSERVATION_FAILED",
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
        this.snapshotService.store.delete(input.target.contextId);
        return phraseSuccess({
          input,
          resolved,
          prepared,
          status: processing?.status ?? "succeeded",
          effects: "verified",
          boundaryCalls,
          processing,
          verification,
          warnings,
          timings: timer.finish(),
        });
      } catch (error) {
        const unknown = isUnknownOutcomeError(error);
        const mutationAttempted =
          mutationState.touchedCurves.length > 0 ||
          mutationState.notesTouched ||
          mutationState.voiceWritten;
        if (!mutationAttempted) {
          return phraseFailure({
            atomicity: phraseAtomicity(input),
            error,
            status: "failed",
            effects: "none",
            boundaryCalls,
            rollback: { attempted: false, verified: null },
            prepared,
            warnings,
            timings: timer.finish(),
          });
        }
        this.snapshotService.store.delete(input.target.contextId);
        if (unknown || !input.atomic) {
          await tryCloseBoundary(capture, prepared?.resolved?.roots?.project, warnings, () => {
            boundaryCalls += 1;
          });
          return phraseFailure({
            atomicity: phraseAtomicity(input),
            error,
            status: unknown ? "outcome_unknown" : "partial",
            effects: unknown ? "unknown" : "may_remain",
            boundaryCalls,
            rollback: { attempted: false, verified: null },
            prepared,
            warnings,
            timings: timer.finish(),
          });
        }

        const rollback = await timer.measure("rollbackMs", () =>
          rollbackPhrase(capture, prepared.resolved, prepared, mutationState)
        );
        await tryCloseBoundary(capture, prepared.resolved.roots.project, warnings, () => {
          boundaryCalls += 1;
        });
        return phraseFailure({
          atomicity: phraseAtomicity(input),
          error,
          status: rollback.verified ? "rolled_back" : "rollback_failed",
          effects: rollback.verified ? "reverted" : rollback.outcomeUnknown ? "unknown" : "may_remain",
          boundaryCalls,
          rollback,
          prepared,
          warnings,
          timings: timer.finish(),
        });
      } finally {
        await capture.releaseAll();
      }
    });
  }
}

async function resolveTarget(
  capture,
  host,
  snapshotService,
  targetInput,
  {
    readOnly = false,
    scanSharedTargets = true,
    readVoice = true,
    readGeometry = true,
  } = {}
) {
  const stored = snapshotService.getContext(targetInput.contextId, host.epoch());
  if (stored.context?.kind !== "range") {
    throw codedError("INVALID_CONTEXT", "sv_edit_phrase requires a range snapshot context");
  }
  const occurrence = stored.context.occurrences.find(
    (item) => item.occurrenceId === targetInput.occurrenceId
  );
  if (!occurrence) {
    throw codedError("UNKNOWN_OCCURRENCE", "occurrenceId is not part of the supplied contextId");
  }
  const roots = await capture.roots();
  const track = await capture.call(roots.project, "getTrack", [occurrence.trackIndex + 1], {
    inferredType: "Track",
  });
  const reference = await capture.call(track, "getGroupReference", [occurrence.groupIndex + 1], {
    inferredType: "NoteGroupReference",
  });
  if (await capture.call(reference, "isInstrumental")) {
    throw codedError("INVALID_TARGET", "instrumental occurrences cannot be edited as phrases");
  }
  const originalTarget = await capture.call(reference, "getTarget", [], {
    inferredType: "NoteGroup",
  });
  const originalTargetUuid = await capture.call(originalTarget, "getUUID");
  const expectedUuid = targetInput.expectedGroupUuid ?? occurrence.targetGroupUuid;
  if (originalTargetUuid !== expectedUuid) {
    throw codedError(
      "STALE_CONTEXT",
      `expected group UUID ${expectedUuid}, observed ${originalTargetUuid}`
    );
  }
  const originalVoice = readVoice
    ? normalizeVoiceParameters(
        await capture.call(reference, "getVoice", [], { resultFormat: "typed-v2" })
      )
    : null;
  const projectTargetOccurrences = scanSharedTargets
    ? await scanTargetOccurrences(capture, roots.project, originalTargetUuid)
    : [];
  const knownSharedCount = Math.max(
    projectTargetOccurrences.length,
    occurrence.sharedTargetOccurrences?.length ?? 0
  );
  if (
    knownSharedCount > 1 &&
    scanSharedTargets &&
    !readOnly &&
    targetInput.allowSharedTargetMutation !== true
  ) {
    const error = codedError(
      "SHARED_TARGET_REQUIRES_CONFIRMATION",
      "the target NoteGroup has multiple project occurrences; set allowSharedTargetMutation:true to confirm a project-wide edit"
    );
    error.projectTargetOccurrences = projectTargetOccurrences;
    throw error;
  }
  return {
    roots,
    track,
    reference,
    originalTarget,
    originalTargetUuid,
    originalVoice,
    projectTargetOccurrences,
    knownTargetOccurrenceCount: knownSharedCount,
    mutatesSharedTarget: scanSharedTargets,
    occurrence,
    storedContext: stored,
    groupTimeOffsetBlick: readGeometry
      ? await capture.call(reference, "getTimeOffset")
      : occurrence.timeOffsetBlick,
    groupOnsetBlick: readGeometry ? await capture.call(reference, "getOnset") : null,
  };
}

async function prepareDetachedPhrase(capture, resolved, input) {
  if (
    input.notePatches.length === 0 &&
    input.structureOperations.length === 0 &&
    input.curves.every((curve) => curve.simplifyThreshold === undefined)
  ) {
    return prepareNonStructuralPhrase(capture, resolved, input);
  }
  await verifyContextFingerprints(capture, resolved);
  const backup = await capture.call(resolved.originalTarget, "clone", [], {
    inferredType: "NoteGroup",
  });
  const clone = await capture.call(backup, "clone", [], { inferredType: "NoteGroup" });
  const cloneUuid = await capture.call(clone, "getUUID");
  const detachedTarget = {
    roots: resolved.roots,
    reference: resolved.reference,
    group: clone,
    groupUuid: cloneUuid,
    groupTimeOffsetBlick: resolved.groupTimeOffsetBlick,
    groupOnsetBlick: resolved.groupOnsetBlick,
    contextOccurrence: resolved.occurrence,
    storedContext: resolved.storedContext,
  };

  const liveTarget = {
    ...detachedTarget,
    group: resolved.originalTarget,
    groupUuid: resolved.originalTargetUuid,
  };
  const liveCurvePlans = await prepareCurves(capture, liveTarget, input.curves);
  const curvePlans = await prepareCurves(capture, detachedTarget, input.curves);
  for (const plan of curvePlans) {
    await applyCurvePlan(capture, plan);
    const observed = await readPointsInRange(capture, plan.automation, plan.range, {
      maxPoints: MAX_CURVE_VERIFY_POINTS,
    });
    plan.observed = observed.points;
    plan.verification = await verifyCurve(
      capture,
      plan.automation,
      plan.planned,
      plan.observed,
      plan.definition,
      plan.simplifyThreshold,
      observed.truncated
    );
    if (!plan.verification.passed) {
      throw codedError(
        "DETACHED_PREPARATION_FAILED",
        `detached Automation ${plan.typeName} failed read-back verification`
      );
    }
  }

  // clone 也遵循宿主的自动排序语义，因此预检同样先固定 noteId → handle。
  const detachedNotes = await resolveOccurrenceNotes(capture, clone, resolved.occurrence);
  const notePlan = await applyNotePatches(capture, detachedNotes, input.notePatches);
  const structurePlan = await applyStructureOperations(
    capture,
    resolved.roots,
    clone,
    input.structureOperations,
    detachedNotes
  );
  const finalNoteCount = await capture.call(clone, "getNumNotes");
  const backupNotes = await readGroupNoteStates(capture, backup);
  const finalNotes = await readGroupNoteStates(capture, clone);
  const voice = planVoicePatch(resolved.originalVoice, input.voicePatch);
  const curvesChanged = curvePlans.some(
    (plan) => !jsonEqual(plan.journal, plan.observed)
  );
  return {
    resolved,
    clone,
    cloneUuid,
    backup,
    backupNotes,
    finalNotes,
    detachedTarget,
    curvePlans,
    liveCurvePlans,
    notePlan,
    structurePlan,
    voice,
    finalNoteCount,
    hasChanges:
      !jsonEqual(backupNotes, finalNotes) ||
      curvesChanged ||
      voice.changed,
    preflightMode: "detached_note_group",
  };
}

async function prepareNonStructuralPhrase(capture, resolved, input) {
  const liveTarget = {
    roots: resolved.roots,
    reference: resolved.reference,
    group: resolved.originalTarget,
    groupUuid: resolved.originalTargetUuid,
    groupTimeOffsetBlick: resolved.groupTimeOffsetBlick,
    groupOnsetBlick: resolved.groupOnsetBlick,
    contextOccurrence: resolved.occurrence,
    storedContext: resolved.storedContext,
  };
  const liveCurvePlans = await prepareCurves(capture, liveTarget, input.curves);
  for (const plan of liveCurvePlans) {
    plan.verification = { attempted: false, passed: null, phase: "live_preflight" };
  }
  const voice = planVoicePatch(resolved.originalVoice, input.voicePatch);
  const noteCount = await capture.call(resolved.originalTarget, "getNumNotes");
  return {
    resolved,
    clone: null,
    cloneUuid: null,
    backup: null,
    backupNotes: null,
    finalNotes: null,
    detachedTarget: null,
    curvePlans: liveCurvePlans,
    liveCurvePlans,
    notePlan: { requested: 0, changedNotes: 0, diff: [] },
    structurePlan: {
      operations: [],
      initialNoteCount: noteCount,
      finalNoteCount: noteCount,
      countScope: "target_group",
    },
    voice,
    finalNoteCount: noteCount,
    hasChanges:
      liveCurvePlans.some((plan) => !jsonEqual(plan.journal, plan.planned)) || voice.changed,
    preflightMode: "live_non_structural",
  };
}

async function verifyContextFingerprints(capture, resolved) {
  for (const expected of resolved.occurrence.noteFingerprints) {
    const note = await capture.call(resolved.originalTarget, "getNote", [expected.indexInGroup + 1], {
      inferredType: "Note",
    });
    if (!note?.__handle__) throw codedError("STALE_CONTEXT", `note ${expected.noteId} no longer exists`);
    const observed = await readNoteFingerprint(capture, note);
    const comparable = pickFingerprint(expected);
    if (!jsonEqual(observed, comparable)) {
      const error = codedError("STALE_CONTEXT", `note ${expected.noteId} changed after snapshot`);
      error.noteId = expected.noteId;
      error.expectedFingerprint = comparable;
      error.observedFingerprint = observed;
      throw error;
    }
  }
}

async function prepareCurves(capture, target, curves) {
  const resolvedInputs = [];
  const ownerByParameter = new Map();
  for (let index = 0; index < curves.length; index += 1) {
    const requestedParameter = curves[index].parameter;
    const parameter = await resolveParameterName(capture, target, requestedParameter);
    const key = parameter.toLowerCase();
    if (ownerByParameter.has(key)) {
      throw codedError(
        "DUPLICATE_PARAMETER",
        `curves[${ownerByParameter.get(key)}] and curves[${index}] both resolve to ${parameter}`
      );
    }
    ownerByParameter.set(key, index);
    resolvedInputs.push({ ...curves[index], requestedParameter, parameter });
  }
  const plans = [];
  for (let index = 0; index < resolvedInputs.length; index += 1) {
    plans.push(await prepareCurvePlan(capture, target, resolvedInputs[index], index));
  }
  return plans;
}

async function resolveOccurrenceNotes(capture, group, occurrence) {
  const notes = new Map();
  for (const fingerprint of occurrence.noteFingerprints) {
    const note = await capture.call(group, "getNote", [fingerprint.indexInGroup + 1], {
      inferredType: "Note",
    });
    if (!note?.__handle__) {
      throw codedError("STALE_CONTEXT", `note ${fingerprint.noteId} no longer exists`);
    }
    notes.set(fingerprint.noteId, note);
  }
  return notes;
}

async function applyNotePatches(capture, notesById, patches) {
  const diff = [];
  for (const patch of patches) {
    const note = notesById.get(patch.noteId);
    if (!note) {
      throw codedError("UNKNOWN_NOTE_ID", `noteId is not part of occurrence: ${patch.noteId}`);
    }
    for (const [field, expected] of Object.entries(patch.expected ?? {})) {
      const observed = await readNoteField(capture, note, field);
      if (!noteFieldEqual(field, observed, expected)) {
        const error = codedError("EXPECTED_MISMATCH", `${patch.noteId}.${field} changed`);
        error.expected = expected;
        error.observed = observed;
        throw error;
      }
    }
    for (const [field, requested] of Object.entries(patch.set)) {
      const before = await readNoteField(capture, note, field);
      const planned = field === "attributes" ? { ...before, ...requested } : requested;
      if (noteFieldEqual(field, before, planned)) continue;
      await writeNoteField(capture, note, field, planned);
      const observed = await readNoteField(capture, note, field);
      if (!noteFieldEqual(field, observed, planned)) {
        throw codedError("DETACHED_PREPARATION_FAILED", `${patch.noteId}.${field} did not read back`);
      }
      diff.push({ noteId: patch.noteId, field, before, after: observed });
    }
  }
  return {
    requested: patches.length,
    changedNotes: new Set(diff.map((item) => item.noteId)).size,
    diff,
  };
}

// 宿主可能以 float32 存储 detune/attributes 浮点值，读回带量化误差；
// 这两个字段按 voiceValueEqual 的相对容差比较，其余字段（blick/pitch/文本）仍精确比较。
function noteFieldEqual(field, observed, expected) {
  if (field === "detuneCents" || field === "attributes") {
    return voiceValueEqual(observed, expected);
  }
  return jsonEqual(observed, expected);
}

async function applyStructureOperations(
  capture,
  roots,
  clone,
  operations,
  originalNotes
) {
  const initialNoteCount = await capture.call(clone, "getNumNotes");
  const results = [];
  const claimed = new Set();
  for (const operation of operations) {
    for (const noteId of operationNoteIds(operation)) {
      if (claimed.has(noteId)) {
        throw codedError("DUPLICATE_NOTE_ID", `noteId is used by multiple structure operations: ${noteId}`);
      }
      if (!originalNotes.has(noteId)) {
        throw codedError("UNKNOWN_NOTE_ID", `noteId is not part of occurrence: ${noteId}`);
      }
      claimed.add(noteId);
    }
    if (operation.op === "insert") {
      const note = await capture.call(roots.sv, "create", ["Note"], { inferredType: "Note" });
      await capture.call(note, "setTimeRange", [operation.note.onsetBlick, operation.note.durationBlick]);
      await capture.call(note, "setPitch", [operation.note.pitch]);
      for (const [field, value] of Object.entries(operation.note)) {
        if (["onsetBlick", "durationBlick", "pitch"].includes(field)) continue;
        await writeNoteField(capture, note, field, value);
      }
      const hostIndex = await capture.call(clone, "addNote", [note]);
      results.push({ op: "insert", indexInGroup: hostIndex - 1 });
      continue;
    }
    if (operation.op === "delete") {
      const note = originalNotes.get(operation.noteId);
      const hostIndex = await capture.call(note, "getIndexInParent");
      await capture.call(clone, "removeNote", [hostIndex]);
      results.push({ op: "delete", noteId: operation.noteId });
      continue;
    }
    if (operation.op === "split") {
      const note = originalNotes.get(operation.noteId);
      const onset = await capture.call(note, "getOnset");
      const duration = await capture.call(note, "getDuration");
      const end = onset + duration;
      if (operation.atBlick <= onset || operation.atBlick >= end) {
        throw codedError("INVALID_ARGUMENTS", "split atBlick must be strictly inside the note");
      }
      const second = await capture.call(note, "clone", [], { inferredType: "Note" });
      await capture.call(second, "setTimeRange", [operation.atBlick, end - operation.atBlick]);
      await capture.call(second, "setLyrics", [operation.secondLyrics]);
      await capture.call(note, "setDuration", [operation.atBlick - onset]);
      await capture.call(clone, "addNote", [second]);
      results.push({ op: "split", noteId: operation.noteId, atBlick: operation.atBlick });
      continue;
    }
    const ordered = [];
    for (const noteId of operation.noteIds) {
      const note = originalNotes.get(noteId);
      const hostIndex = await capture.call(note, "getIndexInParent");
      if (!Number.isSafeInteger(hostIndex) || hostIndex < 1) {
        throw codedError("STALE_CONTEXT", `merge note is no longer in the target group: ${noteId}`);
      }
      ordered.push({ noteId, note, hostIndex });
    }
    ordered.sort((left, right) => left.hostIndex - right.hostIndex);
    const indices = ordered.map((item) => item.hostIndex);
    for (let index = 1; index < indices.length; index += 1) {
      if (indices[index] !== indices[index - 1] + 1) {
        throw codedError("INVALID_ARGUMENTS", "merge noteIds must be consecutive");
      }
    }
    const first = ordered[0].note;
    const firstOnset = await capture.call(first, "getOnset");
    const last = ordered.at(-1).note;
    const lastEnd = (await capture.call(last, "getOnset")) + (await capture.call(last, "getDuration"));
    const lyrics =
      operation.lyricsJoin === "concat"
        ? (await Promise.all(ordered.map((item) => capture.call(item.note, "getLyrics")))).join("")
        : await capture.call(first, "getLyrics");
    for (const item of [...ordered.slice(1)].reverse()) {
      await capture.call(clone, "removeNote", [await capture.call(item.note, "getIndexInParent")]);
    }
    await capture.call(first, "setDuration", [lastEnd - firstOnset]);
    await capture.call(first, "setLyrics", [lyrics]);
    results.push({ op: "merge", noteIds: operation.noteIds, lyricsJoin: operation.lyricsJoin });
  }
  const observedNoteCount = await capture.call(clone, "getNumNotes");
  const expectedNoteCount =
    initialNoteCount +
    operations.reduce((delta, operation) => {
      if (operation.op === "insert" || operation.op === "split") return delta + 1;
      if (operation.op === "delete") return delta - 1;
      return delta - (operation.noteIds.length - 1);
    }, 0);
  if (observedNoteCount !== expectedNoteCount) {
    throw codedError(
      "DETACHED_PREPARATION_FAILED",
      `expected ${expectedNoteCount} notes after structure edits, observed ${observedNoteCount}`
    );
  }
  return {
    operations: results,
    initialNoteCount,
    finalNoteCount: observedNoteCount,
    countScope: "target_group",
  };
}

function planVoicePatch(original, patch) {
  if (!patch) return { changed: false, before: original, planned: original, diff: [] };
  const diff = [];
  const planned = mergeObservableVoice(original, patch, "voicePatch", diff);
  return { changed: diff.length > 0, before: original, planned, diff };
}

function mergeObservableVoice(original, patch, path, diff) {
  if (!isRecord(original) || !isRecord(patch)) {
    throw codedError("INVALID_ARGUMENTS", `${path} must patch an observable voice object`);
  }
  const merged = { ...original };
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(original, key)) {
      throw codedError("UNKNOWN_VOICE_PARAMETER", `${path}.${key} is not observable on this occurrence`);
    }
    const childPath = `${path}.${key}`;
    if (isRecord(value)) {
      merged[key] = mergeObservableVoice(original[key], value, childPath, diff);
    } else {
      if (!isJsonScalar(value)) {
        throw codedError("INVALID_ARGUMENTS", `${childPath} must be a JSON scalar or object`);
      }
      validateVoiceScalar(original[key], value, childPath);
      if (!jsonEqual(original[key], value)) diff.push({ path: childPath, before: original[key], after: value });
      merged[key] = value;
    }
  }
  return merged;
}

async function verifyCommittedPhrase(capture, resolved, prepared) {
  const observedTarget = await capture.call(resolved.reference, "getTarget", [], {
    inferredType: "NoteGroup",
  });
  const observedUuid = await capture.call(observedTarget, "getUUID");
  const observedNotes =
    prepared.finalNotes === null ? null : await readGroupNoteStates(capture, observedTarget);
  const observedNoteCount =
    observedNotes?.length ?? await capture.call(observedTarget, "getNumNotes");
  const observedVoice = prepared.voice.changed
    ? normalizeVoiceParameters(
        await capture.call(resolved.reference, "getVoice", [], { resultFormat: "typed-v2" })
      )
    : null;
  const voicePassed =
    !prepared.voice.changed ||
    patchMatches(prepared.voice.planned, observedVoice, prepared.voice.diff);
  const curveChecks = [];
  for (const plan of prepared.liveCurvePlans) {
    const automation = await capture.call(observedTarget, "getParameter", [plan.typeName], {
      inferredType: "Automation",
    });
    const observed = await readPointsInRange(capture, automation, plan.range, {
      maxPoints: MAX_CURVE_VERIFY_POINTS,
    });
    const verification = await verifyCurve(
      capture,
      automation,
      plan.planned,
      observed.points,
      plan.definition,
      plan.simplifyThreshold,
      observed.truncated
    );
    plan.verification = verification;
    curveChecks.push({ parameter: plan.typeName, passed: verification.passed, evidence: verification.evidence });
  }
  const notesPassed =
    observedNoteCount === prepared.finalNoteCount &&
    (prepared.finalNotes === null || jsonEqual(observedNotes, prepared.finalNotes));
  const curvesPassed = curveChecks.every((check) => check.passed);
  return {
    attempted: true,
    phase: "commit_readback",
    passed:
      observedUuid === resolved.originalTargetUuid &&
      voicePassed &&
      notesPassed &&
      curvesPassed,
    evidence: {
      expectedTargetUuid: resolved.originalTargetUuid,
      observedTargetUuid: observedUuid,
      expectedNoteCount: prepared.finalNoteCount,
      observedNoteCount,
      voicePassed,
      notesPassed,
      curvesPassed,
      curveChecks,
    },
  };
}

async function rollbackPhrase(capture, resolved, prepared, state) {
  const steps = [];
  let outcomeUnknown = false;
  const attempt = async (kind, action) => {
    try {
      const evidence = await action();
      steps.push({ kind, verified: evidence?.verified !== false, ...evidence });
    } catch (error) {
      const unknown = isUnknownOutcomeError(error);
      outcomeUnknown ||= unknown;
      steps.push({ kind, verified: false, error: failureEvidence(error) });
    }
  };

  if (state.voiceWritten) {
    await attempt("voice", async () => {
      await capture.call(resolved.reference, "setVoice", [resolved.originalVoice]);
      const observed = normalizeVoiceParameters(
        await capture.call(resolved.reference, "getVoice", [], { resultFormat: "typed-v2" })
      );
      return { verified: voiceValueEqual(observed, resolved.originalVoice) };
    });
  }
  if (state.notesTouched) {
    await attempt("notes", async () => {
      await restoreGroupNotes(capture, resolved.originalTarget, prepared.backup);
      const observed = await readGroupNoteStates(capture, resolved.originalTarget);
      return {
        verified: jsonEqual(observed, prepared.backupNotes),
        expectedNoteCount: prepared.backupNotes.length,
        observedNoteCount: observed.length,
      };
    });
  }
  for (const plan of [...state.touchedCurves].reverse()) {
    await attempt(`curve:${plan.typeName}`, async () => {
      const result = await rollbackCurve(
        capture,
        plan.automation,
        plan.range,
        plan.journal,
        plan.definition
      );
      return { ...result, verified: result.verified };
    });
  }
  await attempt("target", async () => {
    const observedTarget = await capture.call(resolved.reference, "getTarget", [], {
      inferredType: "NoteGroup",
    });
    const observedTargetUuid = await capture.call(observedTarget, "getUUID");
    return {
      verified: observedTargetUuid === resolved.originalTargetUuid,
      observedTargetUuid,
    };
  });
  return {
    attempted: true,
    verified: steps.every((step) => step.verified),
    outcomeUnknown,
    evidence: { steps },
    ...(steps.find((step) => step.error)?.error
      ? { error: steps.find((step) => step.error).error }
      : {}),
  };
}

async function restoreGroupNotes(capture, target, backup) {
  const currentCount = await capture.call(target, "getNumNotes");
  for (let index = currentCount; index >= 1; index -= 1) {
    await capture.call(target, "removeNote", [index]);
  }
  const backupCount = await capture.call(backup, "getNumNotes");
  for (let index = 1; index <= backupCount; index += 1) {
    const source = await capture.call(backup, "getNote", [index], { inferredType: "Note" });
    const note = await capture.call(source, "clone", [], { inferredType: "Note" });
    await capture.call(target, "addNote", [note]);
  }
}

async function readGroupNoteStates(capture, group) {
  const count = await capture.call(group, "getNumNotes");
  const notes = [];
  for (let index = 1; index <= count; index += 1) {
    const note = await capture.call(group, "getNote", [index], { inferredType: "Note" });
    notes.push({
      ...(await readNoteFingerprint(capture, note)),
      attributes: await capture.call(note, "getAttributes", [], { resultFormat: "typed-v2" }),
    });
  }
  return notes;
}

async function readNoteFingerprint(capture, note) {
  return {
    indexInGroup: (await capture.call(note, "getIndexInParent")) - 1,
    onsetBlick: await capture.call(note, "getOnset"),
    durationBlick: await capture.call(note, "getDuration"),
    pitch: await capture.call(note, "getPitch"),
    lyrics: await capture.call(note, "getLyrics"),
    phonemesOverride: await capture.call(note, "getPhonemes"),
    languageOverride: await capture.call(note, "getLanguageOverride"),
    detuneCents: await capture.call(note, "getDetune"),
  };
}

function pickFingerprint(value) {
  return {
    indexInGroup: value.indexInGroup,
    onsetBlick: value.onsetBlick,
    durationBlick: value.durationBlick,
    pitch: value.pitch,
    lyrics: value.lyrics,
    phonemesOverride: value.phonemesOverride,
    languageOverride: value.languageOverride,
    detuneCents: value.detuneCents,
  };
}

async function readNoteField(capture, note, field) {
  const spec = NOTE_FIELDS[field];
  if (!spec) throw codedError("UNKNOWN_FIELD", `unsupported note field: ${field}`);
  return capture.call(note, spec.getter, [], {
    ...(field === "attributes" ? { resultFormat: "typed-v2" } : {}),
  });
}

async function writeNoteField(capture, note, field, value) {
  const spec = NOTE_FIELDS[field];
  if (!spec) throw codedError("UNKNOWN_FIELD", `unsupported note field: ${field}`);
  return capture.call(note, spec.setter, [value]);
}

function patchMatches(expected, observed, diff) {
  return diff.every((item) =>
    voiceValueEqual(readPath(observed, item.path.slice("voicePatch.".length)), item.after)
  );
}

function readPath(value, path) {
  return path.split(".").reduce((current, key) => current?.[key], value);
}

async function closeUndoBoundary(capture, project, warnings) {
  try {
    await capture.call(project, "newUndoRecord", []);
  } catch (error) {
    warnings.push({
      code: "UNDO_BOUNDARY_CLOSE_FAILED",
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function tryCloseBoundary(capture, project, warnings, onClosed) {
  if (!project) return;
  try {
    await capture.call(project, "newUndoRecord", []);
    onClosed();
  } catch (error) {
    warnings.push({
      code: "UNDO_BOUNDARY_CLOSE_FAILED",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function phraseSuccess(options) {
  const { input, resolved, prepared, status, effects, boundaryCalls, processing, verification, warnings, timings } = options;
  return {
    ok: true,
    status,
    effects,
    atomicity: phraseAtomicity(input),
    preflightMode: prepared.preflightMode,
    target: {
      contextId: input.target.contextId,
      occurrenceId: input.target.occurrenceId,
      trackIndex: resolved.occurrence.trackIndex,
      groupIndex: resolved.occurrence.groupIndex,
      groupUuid: resolved.originalTargetUuid,
      ...(prepared.cloneUuid ? { detachedPlanUuid: prepared.cloneUuid } : {}),
      projectTargetOccurrences: resolved.projectTargetOccurrences,
      knownTargetOccurrenceCount: resolved.knownTargetOccurrenceCount,
      targetSemantics:
        !resolved.mutatesSharedTarget && prepared.voice.changed && prepared.curvePlans.length === 0
          ? effects === "verified"
            ? "occurrence_voice_mutated"
            : "occurrence_voice_observed"
          : effects === "verified"
          ? resolved.knownTargetOccurrenceCount > 1
            ? "shared_target_mutated_with_confirmation"
            : "single_target_mutated"
          : resolved.knownTargetOccurrenceCount > 1
            ? "shared_target_observed"
            : "single_target_observed",
    },
    changes: phraseChanges(prepared, input.responseMode),
    undo: {
      boundaryCallsCompleted: boundaryCalls,
      expectedUserUndoSteps: boundaryCalls === 2 ? 1 : boundaryCalls === 0 ? 0 : null,
    },
    verification: verification ?? {
      attempted: true,
      passed: true,
      phase: preflightVerificationPhase(prepared),
    },
    ...(processing
      ? {
          processing: {
            status: processing.status,
            state: processing.data.state,
            evidence: processing.data.evidence,
            ...(processing.error ? { error: processing.error } : {}),
          },
        }
      : {}),
    warnings,
    timings,
  };
}

function preflightVerificationPhase(prepared) {
  return prepared.preflightMode === "detached_note_group"
    ? "detached_preflight"
    : "live_preflight";
}

function phraseFailure(options) {
  const {
    atomicity,
    error,
    status,
    effects,
    boundaryCalls,
    rollback,
    prepared,
    warnings,
    timings,
  } = options;
  return {
    ok: false,
    status,
    effects,
    atomicity,
    error: failureEvidence(error),
    rollback,
    undo: {
      boundaryCallsCompleted: boundaryCalls,
      expectedUserUndoSteps: boundaryCalls === 2 ? 1 : boundaryCalls === 0 ? 0 : null,
    },
    ...(prepared ? { changes: phraseChanges(prepared, "compact") } : {}),
    warnings,
    timings,
  };
}

function phraseChanges(prepared, responseMode) {
  const curves = prepared.curvePlans.map((plan) => ({
    parameter: plan.typeName,
    points: plan.planned.length,
    verified: plan.verification?.passed ?? null,
    ...(responseMode === "verbose"
      ? {
          resolvedPositions: plan.resolvedInputPoints,
          plannedPoints: plan.planned,
        }
      : {}),
  }));
  return {
    notePatches: {
      requested: prepared.notePlan.requested,
      changedNotes: prepared.notePlan.changedNotes,
      ...(responseMode === "compact" ? {} : { diff: prepared.notePlan.diff }),
    },
    structure: prepared.structurePlan,
    curves,
    voice: {
      changed: prepared.voice.changed,
      ...(responseMode === "compact" ? {} : { diff: prepared.voice.diff }),
    },
    finalNoteCount: prepared.finalNoteCount,
  };
}

function phraseAtomicity(input) {
  return input.atomic
    ? "operation_specific_preflight_live_journal_with_verified_compensation"
    : "none";
}

function validationFailure(error, timings) {
  return {
    ok: false,
    status: "failed",
    effects: "none",
    error: failureEvidence(error),
    rollback: { attempted: false, verified: null },
    undo: { boundaryCallsCompleted: 0, expectedUserUndoSteps: 0 },
    verification: { attempted: false, passed: null },
    warnings: [],
    timings,
  };
}

function normalizeRequest(request) {
  if (!isRecord(request)) throw codedError("INVALID_ARGUMENTS", "request must be an object");
  const target = request.target;
  if (
    !isRecord(target) ||
    typeof target.contextId !== "string" ||
    !target.contextId ||
    typeof target.occurrenceId !== "string" ||
    !target.occurrenceId
  ) {
    throw codedError("INVALID_ARGUMENTS", "target requires contextId and occurrenceId");
  }
  if (
    target.expectedGroupUuid !== undefined &&
    (typeof target.expectedGroupUuid !== "string" || !target.expectedGroupUuid)
  ) {
    throw codedError("INVALID_ARGUMENTS", "target.expectedGroupUuid must be a non-empty string");
  }
  if (
    target.allowSharedTargetMutation !== undefined &&
    typeof target.allowSharedTargetMutation !== "boolean"
  ) {
    throw codedError("INVALID_ARGUMENTS", "target.allowSharedTargetMutation must be a boolean");
  }
  const notePatches = normalizeNotePatches(request.notePatches ?? []);
  const structureOperations = normalizeStructureOperations(request.structureOperations ?? []);
  const structurallyEditedNotes = new Set(structureOperations.flatMap(operationNoteIds));
  const overlappingPatch = notePatches.find((patch) => structurallyEditedNotes.has(patch.noteId));
  if (overlappingPatch) {
    throw codedError(
      "OVERLAPPING_NOTE_EDIT",
      `note ${overlappingPatch.noteId} cannot be patched and structurally edited in one transaction`
    );
  }
  const curves = normalizeCurves(request.curves ?? []);
  const voicePatch = request.voicePatch;
  if (voicePatch !== undefined && !isRecord(voicePatch)) {
    throw codedError("INVALID_ARGUMENTS", "voicePatch must be an object");
  }
  if (
    notePatches.length === 0 &&
    structureOperations.length === 0 &&
    curves.length === 0 &&
    voicePatch === undefined
  ) {
    throw codedError("INVALID_ARGUMENTS", "at least one phrase edit is required");
  }
  const waitFor = request.waitFor ?? "none";
  if (!["none", "phonemes", "computedAttributes"].includes(waitFor)) {
    throw codedError("INVALID_ARGUMENTS", "waitFor must be none, phonemes, or computedAttributes");
  }
  const responseMode = request.responseMode ?? "standard";
  if (!["compact", "standard", "verbose"].includes(responseMode)) {
    throw codedError("INVALID_ARGUMENTS", "responseMode must be compact, standard, or verbose");
  }
  return {
    target: {
      contextId: target.contextId,
      occurrenceId: target.occurrenceId,
      expectedGroupUuid: target.expectedGroupUuid,
      allowSharedTargetMutation: target.allowSharedTargetMutation === true,
    },
    notePatches,
    structureOperations,
    curves,
    voicePatch,
    dryRun: request.dryRun === true,
    atomic: request.atomic !== false,
    waitFor,
    responseMode,
    timeoutMs: clampInteger(request.timeoutMs, 0, 30_000, 10_000),
    pollIntervalMs: clampInteger(request.pollIntervalMs, 20, 2_000, 100),
  };
}

function normalizeNotePatches(value) {
  if (!Array.isArray(value) || value.length > MAX_NOTE_PATCHES) {
    throw codedError("INVALID_ARGUMENTS", `notePatches must contain at most ${MAX_NOTE_PATCHES} items`);
  }
  const seen = new Set();
  return value.map((patch, index) => {
    if (!isRecord(patch) || typeof patch.noteId !== "string" || !patch.noteId) {
      throw codedError("INVALID_ARGUMENTS", `notePatches[${index}] requires noteId`);
    }
    if (!isRecord(patch.set) || Object.keys(patch.set).length === 0) {
      throw codedError("INVALID_ARGUMENTS", `notePatches[${index}].set must be a non-empty object`);
    }
    if (seen.has(patch.noteId)) {
      throw codedError("DUPLICATE_NOTE_ID", `noteId appears in multiple notePatches: ${patch.noteId}`);
    }
    seen.add(patch.noteId);
    validateNoteFields(patch.set, `notePatches[${index}].set`, true);
    if (patch.expected !== undefined) {
      if (!isRecord(patch.expected)) {
        throw codedError("INVALID_ARGUMENTS", `notePatches[${index}].expected must be an object`);
      }
      validateNoteFields(patch.expected, `notePatches[${index}].expected`, false);
    }
    return { noteId: patch.noteId, set: patch.set, expected: patch.expected };
  });
}

function validateNoteFields(value, label, validateValues) {
  for (const [field, fieldValue] of Object.entries(value)) {
    const spec = NOTE_FIELDS[field];
    if (!spec) throw codedError("UNKNOWN_FIELD", `${label}.${field} is not patchable`);
    if (!validateValues) continue;
    if (spec.kind === "string" && typeof fieldValue !== "string") {
      throw codedError("INVALID_ARGUMENTS", `${label}.${field} must be a string`);
    }
    if (spec.kind === "midi" && (!Number.isSafeInteger(fieldValue) || fieldValue < 0 || fieldValue > 127)) {
      throw codedError("INVALID_ARGUMENTS", `${label}.${field} must be MIDI 0-127`);
    }
    if (spec.kind === "nonNegativeInteger" && (!Number.isSafeInteger(fieldValue) || fieldValue < 0)) {
      throw codedError("INVALID_ARGUMENTS", `${label}.${field} must be a non-negative integer`);
    }
    if (spec.kind === "positiveInteger" && (!Number.isSafeInteger(fieldValue) || fieldValue < 1)) {
      throw codedError("INVALID_ARGUMENTS", `${label}.${field} must be a positive integer`);
    }
    if (spec.kind === "number" && !Number.isFinite(fieldValue)) {
      throw codedError("INVALID_ARGUMENTS", `${label}.${field} must be finite`);
    }
    if (spec.kind === "object" && (!isRecord(fieldValue) || Object.keys(fieldValue).length === 0)) {
      throw codedError("INVALID_ARGUMENTS", `${label}.${field} must be a non-empty object`);
    }
  }
}

function normalizeStructureOperations(value) {
  if (!Array.isArray(value) || value.length > MAX_STRUCTURE_OPERATIONS) {
    throw codedError(
      "INVALID_ARGUMENTS",
      `structureOperations must contain at most ${MAX_STRUCTURE_OPERATIONS} items`
    );
  }
  return value.map((operation, index) => {
    if (!isRecord(operation) || !["insert", "delete", "split", "merge"].includes(operation.op)) {
      throw codedError("INVALID_ARGUMENTS", `structureOperations[${index}].op is invalid`);
    }
    if (operation.op === "insert") {
      if (!isRecord(operation.note)) {
        throw codedError("INVALID_ARGUMENTS", `structureOperations[${index}].note is required`);
      }
      validateInsertedNote(operation.note, index);
      return { op: "insert", note: operation.note };
    }
    if (operation.op === "merge") {
      if (
        !Array.isArray(operation.noteIds) ||
        operation.noteIds.length < 2 ||
        !operation.noteIds.every((item) => typeof item === "string" && item)
      ) {
        throw codedError("INVALID_ARGUMENTS", `structureOperations[${index}].noteIds is invalid`);
      }
      return {
        op: "merge",
        noteIds: operation.noteIds,
        lyricsJoin: operation.lyricsJoin === "concat" ? "concat" : "first",
      };
    }
    if (typeof operation.noteId !== "string" || !operation.noteId) {
      throw codedError("INVALID_ARGUMENTS", `structureOperations[${index}].noteId is required`);
    }
    if (operation.op === "split") {
      if (!Number.isSafeInteger(operation.atBlick)) {
        throw codedError("INVALID_ARGUMENTS", `structureOperations[${index}].atBlick must be an integer`);
      }
      return {
        op: "split",
        noteId: operation.noteId,
        atBlick: operation.atBlick,
        secondLyrics: typeof operation.secondLyrics === "string" ? operation.secondLyrics : "-",
      };
    }
    return { op: "delete", noteId: operation.noteId };
  });
}

function validateInsertedNote(note, index) {
  if (!Number.isSafeInteger(note.onsetBlick) || note.onsetBlick < 0) {
    throw codedError("INVALID_ARGUMENTS", `structureOperations[${index}].note.onsetBlick is invalid`);
  }
  if (!Number.isSafeInteger(note.durationBlick) || note.durationBlick < 1) {
    throw codedError("INVALID_ARGUMENTS", `structureOperations[${index}].note.durationBlick is invalid`);
  }
  if (!Number.isSafeInteger(note.pitch) || note.pitch < 0 || note.pitch > 127) {
    throw codedError("INVALID_ARGUMENTS", `structureOperations[${index}].note.pitch is invalid`);
  }
  validateNoteFields(
    Object.fromEntries(
      Object.entries(note).filter(([field]) => !["onsetBlick", "durationBlick", "pitch"].includes(field))
    ),
    `structureOperations[${index}].note`,
    true
  );
}

function normalizeCurves(value) {
  if (!Array.isArray(value) || value.length > MAX_CURVES) {
    throw codedError("INVALID_ARGUMENTS", `curves must contain at most ${MAX_CURVES} items`);
  }
  return value.map((curve) => normalizeCurveInput(curve));
}

function operationNoteIds(operation) {
  if (operation.op === "insert") return [];
  if (operation.op === "merge") return operation.noteIds;
  return [operation.noteId];
}

function failureEvidence(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "HOST_CALL_FAILED",
    message: error instanceof Error ? error.message : String(error),
    outcome: isUnknownOutcomeError(error) ? "unknown" : "unchanged",
    retryable: isUnknownOutcomeError(error),
    ...(error?.verification ? { verification: error.verification } : {}),
  };
}

function isUnknownOutcomeError(error) {
  return (
    error?.code === "HOST_TIMEOUT" ||
    error?.code === "HOST_DETACHED" ||
    /Timeout waiting for (?:SynthV|host)|SynthV bridge detached|host (?:is )?detached|disconnected|\bEOF\b/i.test(
      error instanceof Error ? error.message : String(error)
    )
  );
}

function jsonEqual(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => jsonEqual(item, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]))
    );
  }
  return false;
}

function isJsonScalar(value) {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function validateVoiceScalar(observed, requested, path) {
  if (typeof observed === "number") {
    if (typeof requested !== "number" || !Number.isFinite(requested)) {
      throw codedError("INVALID_ARGUMENTS", `${path} must be a finite number`);
    }
    return;
  }
  if (observed === null) {
    if (requested !== null) {
      throw codedError("INVALID_ARGUMENTS", `${path} must remain null because its type is unavailable`);
    }
    return;
  }
  if (typeof requested !== typeof observed) {
    throw codedError("INVALID_ARGUMENTS", `${path} must be a ${typeof observed}`);
  }
}

function voiceValueEqual(observed, expected) {
  if (typeof observed === "number" && typeof expected === "number") {
    const tolerance = Math.max(1e-6, Math.abs(expected) * 1e-6);
    return Number.isFinite(observed) && Math.abs(observed - expected) <= tolerance;
  }
  if (Array.isArray(observed) && Array.isArray(expected)) {
    return (
      observed.length === expected.length &&
      observed.every((value, index) => voiceValueEqual(value, expected[index]))
    );
  }
  if (isRecord(observed) && isRecord(expected)) {
    const observedKeys = Object.keys(observed);
    const expectedKeys = Object.keys(expected);
    return (
      observedKeys.length === expectedKeys.length &&
      observedKeys.every(
        (key) => Object.hasOwn(expected, key) && voiceValueEqual(observed[key], expected[key])
      )
    );
  }
  return observed === expected;
}

function clampInteger(value, minimum, maximum, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw codedError("INVALID_ARGUMENTS", `integer must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
