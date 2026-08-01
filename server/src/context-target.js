import { isDeepStrictEqual } from "node:util";

import { scanTargetOccurrences } from "./parameter-curve.js";
import { measureDiagnosticPhase } from "./operation-diagnostics.js";
import { createBulkStats, readNoteFingerprints } from "./note-fingerprint-reader.js";
import { createHostScope } from "./snapshot.js";
import { selectOccurrenceByOrdinal } from "./scope-source.js";

export async function resolveContextTarget(
  host,
  stored,
  {
    verify = true,
    acceptRange = false,
    occurrence,
    noteIndicesInGroup,
    diagnostics = null,
  } = {}
) {
  if (stored?.context?.kind === "range") {
    if (!acceptRange) {
      throw codedError(
        "INVALID_CONTEXT",
        "sv_set_lyrics only accepts group or selection contexts from sv_snapshot; for range contexts use sv_patch_notes for per-note lyrics or sv_edit_phrase for atomic phrase edits"
      );
    }
    return resolveRangeContextTarget(host, stored, {
      verify,
      occurrence,
      noteIndicesInGroup,
      diagnostics,
    });
  }
  if (!stored?.context || !["selection", "group"].includes(stored.context.kind)) {
    throw codedError("INVALID_CONTEXT", "context does not identify an editable note group");
  }
  if (occurrence !== undefined) {
    throw codedError(
      "INVALID_ARGUMENTS",
      "occurrence only applies to range contexts from sv_snapshot_range"
    );
  }
  const scope = createHostScope(host);
  const bulkStats = createBulkStats();
  try {
    let roots;
    let track;
    let group;
    let target;
    let expectedGroupUuid = null;
    await measureDiagnosticPhase(diagnostics, "targetResolutionMs", async () => {
      roots = await scope.roots();
      track = await scope.call(roots.project, "getTrack", [stored.context.trackIndex + 1], {
        inferredType: "Track",
      });
      group = await scope.call(track, "getGroupReference", [stored.context.groupIndex + 1], {
        inferredType: "NoteGroupReference",
      });
      target = await scope.call(group, "getTarget", [], { inferredType: "NoteGroup" });
      expectedGroupUuid =
        stored.baseData.group?.uuid ?? stored.baseData.tracks?.[0]?.groups?.[0]?.uuid ?? null;
      if (expectedGroupUuid !== null) {
        const currentGroupUuid = await scope.call(target, "getUUID");
        if (currentGroupUuid !== expectedGroupUuid) {
          throw codedError("STALE_CONTEXT", "the target note group changed after snapshot capture");
        }
      }
    });
    const notes = [];
    const fingerprints = [];
    await measureDiagnosticPhase(diagnostics, "fingerprintVerificationMs", async () => {
      // 写入仍需要 note handle，因此 getNote 保留；被替换掉的是每音符 8 次 getter 往返。
      for (const index of stored.context.noteIndices) {
        const note = await scope.call(target, "getNote", [index + 1], { inferredType: "Note" });
        if (!note?.__handle__) throw codedError("STALE_CONTEXT", `note ${index} no longer exists`);
        notes.push(note);
      }
      // 指纹走有界批量读取；旧桥自动回退到在上面这些 handle 上逐 getter。
      fingerprints.push(
        ...(await readNoteFingerprints(scope, {
          host,
          notes,
          trackIndex: stored.context.trackIndex,
          groupReferenceIndex: stored.context.groupIndex,
          expectedGroupUuid,
          noteIndicesInGroup: stored.context.noteIndices,
          stats: bulkStats,
        }))
      );
      diagnostics?.recordBulkStats(bulkStats);

      if (verify && !isDeepStrictEqual(fingerprints, stored.context.fingerprints)) {
        throw codedError("STALE_CONTEXT", "notes changed after the snapshot was captured");
      }
    });
    return {
      scope,
      roots,
      track,
      group,
      target,
      notes,
      fingerprints,
      contextKind: stored.context.kind,
      bulkStats,
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

// range context 的可编辑解析：语义与 sv_edit_phrase 的 resolveTarget 一致 ——
// 按 occurrence 定位 reference/target、比对 target UUID、逐音符校验指纹（含 detuneCents）。
async function resolveRangeContextTarget(
  host,
  stored,
  { verify, occurrence: requestedOrdinal, noteIndicesInGroup, diagnostics }
) {
  // 候选判据是"可编辑的人声 occurrence"：instrumental 的存在但不能当 NoteGroup 编辑，
  // 因此显式点名它得到 INVALID_TARGET，而不是"越界"或"未捕获"。
  const { occurrence } = selectOccurrenceByOrdinal(stored.context.occurrences, requestedOrdinal, {
    eligible: (item) =>
      typeof item.targetGroupUuid === "string" && item.targetGroupUuid.length > 0,
    noneCode: "INVALID_CONTEXT",
    noneMessage: "range context contains no editable vocal occurrence",
    ambiguousMessage:
      "range context has multiple vocal occurrences; pass one occurrence ordinal",
    ineligibleCode: "INVALID_TARGET",
    ineligibleMessage: "instrumental occurrences cannot be edited as note groups",
  });

  const scope = createHostScope(host);
  const bulkStats = createBulkStats();
  try {
    let roots;
    let track;
    let group;
    let target;
    let targetNoteCount;
    await measureDiagnosticPhase(diagnostics, "targetResolutionMs", async () => {
      roots = await scope.roots();
      track = await scope.call(roots.project, "getTrack", [occurrence.trackIndex + 1], {
        inferredType: "Track",
      });
      group = await scope.call(track, "getGroupReference", [occurrence.groupIndex + 1], {
        inferredType: "NoteGroupReference",
      });
      if (await scope.call(group, "isInstrumental")) {
        throw codedError("INVALID_TARGET", "instrumental occurrences cannot be edited as note groups");
      }
      target = await scope.call(group, "getTarget", [], { inferredType: "NoteGroup" });
      const currentGroupUuid = await scope.call(target, "getUUID");
      if (currentGroupUuid !== occurrence.targetGroupUuid) {
        throw codedError("STALE_CONTEXT", "the target note group changed after snapshot capture");
      }
      targetNoteCount = await scope.call(target, "getNumNotes");
    });
    const notes = [];
    const fingerprints = [];
    const positionByIndexInGroup = new Map();
    const contextPositionByIndexInGroup = new Map();
    const expectedFingerprints = selectRangeFingerprints(occurrence, {
      noteIndicesInGroup,
    });
    const allContextPositions = new Map(
      (occurrence.noteFingerprints ?? []).map((fingerprint, index) => [fingerprint.indexInGroup, index])
    );
    await measureDiagnosticPhase(diagnostics, "fingerprintVerificationMs", async () => {
      // 批量读取前先做范围校验：越界必须仍然报 STALE_CONTEXT，
      // 而不是让整批以宿主的索引错误失败、丢掉是哪个音符过期的信息。
      for (const expected of expectedFingerprints) {
        if (!Number.isSafeInteger(expected.indexInGroup) || expected.indexInGroup >= targetNoteCount) {
          throw codedError("STALE_CONTEXT", `note ${expected.indexInGroup} no longer exists`);
        }
      }
      // 写入仍需要 note handle；先按 occurrence 顺序解析，再一次性批量读指纹。
      const resolvedNotes = [];
      for (const expected of expectedFingerprints) {
        const note = await scope.call(target, "getNote", [expected.indexInGroup + 1], {
          inferredType: "Note",
        });
        if (!note?.__handle__) {
          throw codedError("STALE_CONTEXT", `note ${expected.indexInGroup} no longer exists`);
        }
        resolvedNotes.push(note);
      }
      const observedFingerprints = await readNoteFingerprints(scope, {
        host,
        notes: resolvedNotes,
        trackIndex: occurrence.trackIndex,
        groupReferenceIndex: occurrence.groupIndex,
        expectedGroupUuid: occurrence.targetGroupUuid,
        noteIndicesInGroup: expectedFingerprints.map((expected) => expected.indexInGroup),
        stats: bulkStats,
      });
      diagnostics?.recordBulkStats(bulkStats);
      for (const [position, expected] of expectedFingerprints.entries()) {
        const note = resolvedNotes[position];
        const observed = observedFingerprints[position];
        if (verify && !isDeepStrictEqual(observed, pickRangeFingerprint(expected))) {
          throw codedError(
            "STALE_CONTEXT",
            `note ${expected.indexInGroup} changed after the snapshot was captured`
          );
        }
        positionByIndexInGroup.set(expected.indexInGroup, notes.length);
        contextPositionByIndexInGroup.set(
          expected.indexInGroup,
          allContextPositions.get(expected.indexInGroup)
        );
        notes.push(note);
        fingerprints.push(observed);
      }
    });
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
      positionByIndexInGroup,
      contextPositionByIndexInGroup,
      targetNoteCount,
      bulkStats,
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

function selectRangeFingerprints(occurrence, { noteIndicesInGroup }) {
  const all = occurrence.noteFingerprints ?? [];
  const requestedIndices = new Set(
    (noteIndicesInGroup ?? []).filter((value) => Number.isSafeInteger(value))
  );
  if (requestedIndices.size === 0) return all;
  return all.filter((fingerprint) => requestedIndices.has(fingerprint.indexInGroup));
}

export function contextGroupNoteCount(stored, fallback = null) {
  const candidates = [
    stored?.baseData?.group?.noteCount,
    stored?.baseData?.tracks?.[0]?.groups?.[0]?.noteCount,
    fallback,
  ];
  return candidates.find((value) => Number.isSafeInteger(value) && value >= 0) ?? null;
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

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
