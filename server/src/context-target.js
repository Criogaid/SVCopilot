import { isDeepStrictEqual } from "node:util";

import { scanTargetOccurrences } from "./parameter-curve.js";
import { createHostScope } from "./snapshot.js";

export async function resolveContextTarget(
  host,
  stored,
  { verify = true, acceptRange = false, occurrenceId } = {}
) {
  if (stored?.context?.kind === "range") {
    if (!acceptRange) {
      throw codedError(
        "INVALID_CONTEXT",
        "sv_set_lyrics only accepts group or selection contexts from sv_snapshot; for range contexts use sv_patch_notes for per-note lyrics or sv_edit_phrase for atomic phrase edits"
      );
    }
    return resolveRangeContextTarget(host, stored, { verify, occurrenceId });
  }
  if (!stored?.context || !["selection", "group"].includes(stored.context.kind)) {
    throw codedError("INVALID_CONTEXT", "context does not identify an editable note group");
  }
  if (occurrenceId !== undefined) {
    throw codedError(
      "INVALID_ARGUMENTS",
      "occurrenceId only applies to range contexts from sv_snapshot_range"
    );
  }
  const scope = createHostScope(host);
  try {
    const roots = await scope.roots();
    const track = await scope.call(roots.project, "getTrack", [stored.context.trackIndex + 1], {
      inferredType: "Track",
    });
    const group = await scope.call(track, "getGroupReference", [stored.context.groupIndex + 1], {
      inferredType: "NoteGroupReference",
    });
    const target = await scope.call(group, "getTarget", [], { inferredType: "NoteGroup" });
    const expectedGroupUuid =
      stored.baseData.group?.uuid ?? stored.baseData.tracks?.[0]?.groups?.[0]?.uuid ?? null;
    if (expectedGroupUuid !== null) {
      const currentGroupUuid = await scope.call(target, "getUUID");
      if (currentGroupUuid !== expectedGroupUuid) {
        throw codedError("STALE_CONTEXT", "the target note group changed after snapshot capture");
      }
    }
    const notes = [];
    const fingerprints = [];
    for (const index of stored.context.noteIndices) {
      const note = await scope.call(target, "getNote", [index + 1], { inferredType: "Note" });
      if (!note?.__handle__) throw codedError("STALE_CONTEXT", `note ${index} no longer exists`);
      notes.push(note);
      fingerprints.push(await readFingerprint(scope, note));
    }

    if (verify && !isDeepStrictEqual(fingerprints, stored.context.fingerprints)) {
      throw codedError("STALE_CONTEXT", "notes changed after the snapshot was captured");
    }
    return { scope, roots, track, group, target, notes, fingerprints, contextKind: stored.context.kind };
  } catch (error) {
    await scope.releaseAll();
    if (isResolveError(error)) throw error;
    throw codedError(
      "STALE_CONTEXT",
      `could not resolve snapshot target: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

// range context 的可编辑解析：语义与 sv_edit_phrase 的 resolveTarget 一致 ——
// 按 occurrence 定位 reference/target、比对 target UUID、逐音符校验指纹（含 detuneCents）。
async function resolveRangeContextTarget(host, stored, { verify, occurrenceId }) {
  const occurrences = Array.isArray(stored.context.occurrences) ? stored.context.occurrences : [];
  const vocal = occurrences.filter(
    (item) => typeof item.targetGroupUuid === "string" && item.targetGroupUuid.length > 0
  );
  let occurrence = null;
  if (occurrenceId !== undefined) {
    occurrence = occurrences.find((item) => item.occurrenceId === occurrenceId) ?? null;
    if (!occurrence) {
      throw codedError("UNKNOWN_OCCURRENCE", "occurrenceId is not part of the supplied contextId");
    }
    if (!vocal.includes(occurrence)) {
      throw codedError("INVALID_TARGET", "instrumental occurrences cannot be edited as note groups");
    }
  } else if (vocal.length === 1) {
    occurrence = vocal[0];
  } else if (vocal.length === 0) {
    throw codedError("INVALID_CONTEXT", "range context contains no editable vocal occurrence");
  } else {
    const error = codedError(
      "AMBIGUOUS_CONTEXT",
      "range context has multiple vocal occurrences; provide occurrenceId or noteIds from a single occurrence"
    );
    error.candidateOccurrences = vocal.map((item) => item.occurrenceId);
    error.details = { candidateOccurrences: error.candidateOccurrences };
    throw error;
  }

  const scope = createHostScope(host);
  try {
    const roots = await scope.roots();
    const track = await scope.call(roots.project, "getTrack", [occurrence.trackIndex + 1], {
      inferredType: "Track",
    });
    const group = await scope.call(track, "getGroupReference", [occurrence.groupIndex + 1], {
      inferredType: "NoteGroupReference",
    });
    if (await scope.call(group, "isInstrumental")) {
      throw codedError("INVALID_TARGET", "instrumental occurrences cannot be edited as note groups");
    }
    const target = await scope.call(group, "getTarget", [], { inferredType: "NoteGroup" });
    const currentGroupUuid = await scope.call(target, "getUUID");
    if (currentGroupUuid !== occurrence.targetGroupUuid) {
      throw codedError("STALE_CONTEXT", "the target note group changed after snapshot capture");
    }
    const targetNoteCount = await scope.call(target, "getNumNotes");
    const notes = [];
    const fingerprints = [];
    const positionByNoteId = new Map();
    for (const expected of occurrence.noteFingerprints ?? []) {
      if (!Number.isSafeInteger(expected.indexInGroup) || expected.indexInGroup >= targetNoteCount) {
        throw codedError("STALE_CONTEXT", `note ${expected.noteId} no longer exists`);
      }
      const note = await scope.call(target, "getNote", [expected.indexInGroup + 1], {
        inferredType: "Note",
      });
      if (!note?.__handle__) {
        throw codedError("STALE_CONTEXT", `note ${expected.noteId} no longer exists`);
      }
      const observed = await readRangeFingerprint(scope, note);
      if (verify && !isDeepStrictEqual(observed, pickRangeFingerprint(expected))) {
        throw codedError(
          "STALE_CONTEXT",
          `note ${expected.noteId} changed after the snapshot was captured`
        );
      }
      positionByNoteId.set(expected.noteId, notes.length);
      notes.push(note);
      fingerprints.push(observed);
    }
    return {
      scope,
      roots,
      track,
      group,
      target,
      notes,
      fingerprints,
      contextKind: "range",
      occurrence,
      positionByNoteId,
      targetNoteCount,
    };
  } catch (error) {
    await scope.releaseAll();
    if (isResolveError(error)) throw error;
    throw codedError(
      "STALE_CONTEXT",
      `could not resolve snapshot target: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

// 从 noteId 集合推导 range occurrenceId。range noteId 形如 <contextId>:t:X:r:Y:n:Z，
// occurrence 前缀即去掉 ":n:Z" 的部分。推导不了（无 noteId）时返回 undefined，交由
// resolveContextTarget 做单 occurrence 自动选择或返回 AMBIGUOUS_CONTEXT。
export function deriveRangeOccurrenceId(stored, noteIds) {
  if (stored?.context?.kind !== "range") return undefined;
  const prefixes = new Set();
  for (const noteId of noteIds) {
    if (typeof noteId !== "string") continue;
    const cut = noteId.lastIndexOf(":n:");
    if (cut <= 0) continue;
    prefixes.add(noteId.slice(0, cut));
  }
  if (prefixes.size === 0) return undefined;
  if (prefixes.size > 1) {
    throw codedError(
      "INVALID_NOTE_ID",
      "all noteIds in one request must belong to the same range occurrence"
    );
  }
  return prefixes.values().next().value;
}

// 统一 noteId → 上下文位置：group/selection 走 <contextId>:n:<position> 旧格式，
// range 走 occurrence noteFingerprints 建立的映射。
export function parseContextNoteId(noteId, contextId, resolved) {
  if (resolved.contextKind === "range") {
    const position = resolved.positionByNoteId.get(noteId);
    if (position === undefined) {
      throw codedError(
        "UNKNOWN_NOTE_ID",
        `noteId is not part of the resolved occurrence: ${noteId}`
      );
    }
    return position;
  }
  const prefix = `${contextId}:n:`;
  if (typeof noteId !== "string" || !noteId.startsWith(prefix)) {
    throw codedError(
      "INVALID_NOTE_ID",
      `noteId must be of the form ${prefix}<index> from the same snapshot context`
    );
  }
  const suffix = noteId.slice(prefix.length);
  const position = Number(suffix);
  if (!/^\d+$/.test(suffix) || !Number.isSafeInteger(position)) {
    throw codedError("INVALID_NOTE_ID", `noteId index is not a non-negative integer: ${noteId}`);
  }
  if (position >= resolved.notes.length) {
    throw codedError(
      "NOTE_INDEX_OUT_OF_RANGE",
      `noteId ${noteId} refers to position ${position}, but the context has ${resolved.notes.length} note(s)`
    );
  }
  return position;
}

export function contextGroupNoteCount(stored, fallback = null) {
  const candidates = [
    stored?.baseData?.group?.noteCount,
    stored?.baseData?.tracks?.[0]?.groups?.[0]?.noteCount,
    fallback,
  ];
  return candidates.find((value) => Number.isSafeInteger(value) && value >= 0) ?? null;
}

async function readFingerprint(scope, note) {
  // 字段集合必须与 snapshot.js 的 noteFingerprint 一致（含 detuneCents，与 range 指纹对齐）。
  return {
    indexInGroup: toExternalIndex(await scope.call(note, "getIndexInParent")),
    onsetBlick: await scope.call(note, "getOnset"),
    durationBlick: await scope.call(note, "getDuration"),
    pitch: await scope.call(note, "getPitch"),
    lyrics: await scope.call(note, "getLyrics"),
    phonemesOverride: await scope.call(note, "getPhonemes"),
    languageOverride: await scope.call(note, "getLanguageOverride"),
    detuneCents: await scope.call(note, "getDetune"),
  };
}

// 字段集合必须与 musical-range.js 采集的 noteFingerprints 一致（含 detuneCents）。
async function readRangeFingerprint(scope, note) {
  return {
    indexInGroup: toExternalIndex(await scope.call(note, "getIndexInParent")),
    onsetBlick: await scope.call(note, "getOnset"),
    durationBlick: await scope.call(note, "getDuration"),
    pitch: await scope.call(note, "getPitch"),
    lyrics: await scope.call(note, "getLyrics"),
    phonemesOverride: await scope.call(note, "getPhonemes"),
    languageOverride: await scope.call(note, "getLanguageOverride"),
    detuneCents: await scope.call(note, "getDetune"),
  };
}

function pickRangeFingerprint(value) {
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

// range context 的共享 target 契约与 sv_edit_phrase 一致：commit 前扫描整个工程,
// 多 occurrence 且未显式确认时拒绝。group/selection 旧路径不经过这里,行为不变。
export async function ensureSharedTargetConfirmed(resolved, input) {
  if (resolved.contextKind !== "range") return;
  const projectTargetOccurrences = await scanTargetOccurrences(
    resolved.scope,
    resolved.roots.project,
    resolved.occurrence.targetGroupUuid
  );
  const knownCount = Math.max(
    projectTargetOccurrences.length,
    resolved.occurrence.sharedTargetOccurrences?.length ?? 0
  );
  if (knownCount > 1 && input.allowSharedTargetMutation !== true) {
    const error = codedError(
      "SHARED_TARGET_REQUIRES_CONFIRMATION",
      "the target NoteGroup has multiple project occurrences; set allowSharedTargetMutation:true to confirm a project-wide edit"
    );
    error.projectTargetOccurrences = projectTargetOccurrences;
    error.details = { projectTargetOccurrences };
    throw error;
  }
}

export function appendSharedTargetDryRunWarnings(resolved, input, warnings) {
  if (resolved.contextKind !== "range") return;
  warnings.push({
    code: "SHARED_TARGET_CHECK_DEFERRED",
    message:
      "Project-wide shared-target scanning is deferred to commit; dry-run remains side-effect free.",
  });
  if (
    (resolved.occurrence.sharedTargetOccurrences?.length ?? 0) > 1 &&
    input.allowSharedTargetMutation !== true
  ) {
    warnings.push({
      code: "SHARED_TARGET_DRY_RUN",
      message:
        "This dry-run is safe, but commit requires allowSharedTargetMutation:true because every occurrence shares one target NoteGroup.",
    });
  }
}

function isResolveError(error) {
  return [
    "STALE_CONTEXT",
    "INVALID_CONTEXT",
    "INVALID_ARGUMENTS",
    "INVALID_TARGET",
    "UNKNOWN_OCCURRENCE",
    "AMBIGUOUS_CONTEXT",
  ].includes(error?.code);
}

function toExternalIndex(luaIndex) {
  return Number.isSafeInteger(luaIndex) ? luaIndex - 1 : null;
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
