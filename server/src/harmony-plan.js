import { createHash } from "node:crypto";

import { isBreathLyrics } from "./expression-plan.js";
import { MAX_OPERATIONS } from "./note-structure.js";
import { analyzeKey } from "./phrase-analysis.js";
import { ServiceTiming } from "./service-timing.js";

// sv_generate_harmony：调内和声规划器（HANDOFF §8.16 "仍未实现"清单最后一个规划项）。
//
// 关键契约：
// - 纯内存只读：只读取 range context 的音符指纹，不进 ExecutionCoordinator、绝不写宿主。
//   真正落地由调用方把 restructureRequest 交给现有 sv_restructure_notes（Undo/读回/补偿
//   全部复用）。目标 occurrence 由调用方先准备（sv_clone_track_from_template 或手动建组
//   后重拍快照，使源与目标在同一 range context 内）——本工具不创建轨道或 NoteGroup。
// - 调内映射是启发式不是编曲：三度/六度 = 自然音阶级 ±2/±5；调外源音按最近调内音的
//   半音差近似平移并标 needs_review；音域越界先尝试八度位移；声部交叉守卫跳过而不是
//   悄悄接受。和声"好不好听"永远 human_only。
// - 收敛与不覆盖：目标已有完全一致的音符视为已应用跳过（continuation 收敛基础）；
//   同跨度不同内容列入 conflicts，绝不覆盖目标既有音符。
export const HARMONY_INTERVALS = Object.freeze([
  "third_below",
  "third_above",
  "sixth_below",
  "sixth_above",
]);
export const HARMONY_LYRICS_MODES = Object.freeze(["copy", "sustain"]);

const INTERVAL_STEPS = Object.freeze({
  third_below: -2,
  third_above: 2,
  sixth_below: -5,
  sixth_above: 5,
});
const PITCH_CLASS_NAMES = Object.freeze([
  "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
]);
const MAJOR_SCALE = Object.freeze([0, 2, 4, 5, 7, 9, 11]);
const NATURAL_MINOR_SCALE = Object.freeze([0, 2, 3, 5, 7, 8, 10]);
// K-S margin 低于此值时调性歧义警告（工程默认，未经真机校准）。
const KEY_AMBIGUITY_MARGIN = 0.05;
const MAX_LIST_ITEMS = 100;
const MAX_CONTINUATION_IDENTITIES = 256;

const PROVENANCE = Object.freeze({
  planner: "diatonic_interval_mapper",
  keyMethod: "krumhansl_schmuckler_duration_weighted_pearson",
  keyAmbiguityMargin: "engineering_default_requires_host_calibration",
  nonDiatonicMapping: "nearest_scale_tone_semitone_offset_needs_review",
  trackAndGroupCreation: "not_provided_use_sv_clone_track_from_template_first",
  breathNotes: "skipped_breaths_need_no_harmony",
  basis: "derived_not_host_fact",
  perception: "human_only",
});

export class HarmonyPlanService {
  constructor({ store, now = () => Date.now() } = {}) {
    if (!store) throw new Error("HarmonyPlanService requires the shared SnapshotStore");
    this.store = store;
    this.now = now;
    this.continuationIdentities = new Map();
  }

  async plan(request = {}) {
    const timer = new ServiceTiming({ now: this.now, phaseNames: ["loadMs", "mapMs"] });
    const input = normalizeHarmonyRequest(request);
    // 纯内存服务：不进入协调器；coordinatorQueueMs/operationMs 恒 0，如实报告。
    timer.requestCoordinator();
    const warnings = [];
    pruneContinuationIdentities(this.continuationIdentities, this.now());
    const loaded = await timer.measure("loadMs", async () =>
      resolveHarmonySource(this.store, input, warnings, this.continuationIdentities)
    );
    const planned = await timer.measure("mapMs", async () =>
      mapHarmony(loaded, input, warnings)
    );
    const response = buildHarmonyResponse(loaded, input, planned, warnings, timer.finish());
    if (response.continuation) {
      rememberContinuationIdentities(this.continuationIdentities, loaded, input, this.now());
    }
    return response;
  }
}

// ---------- 上下文解析 ----------

const OCCURRENCE_POSITION_PATTERN = /:t:(\d+):r:(\d+)$/;

function resolveHarmonySource(store, input, warnings, continuationIdentities) {
  const stored = store.get(input.contextId);
  if (!stored) {
    throw codedError("UNKNOWN_CONTEXT", "contextId not found or expired; re-run sv_snapshot_range");
  }
  if (stored.context?.kind !== "range") {
    throw codedError(
      "INVALID_CONTEXT",
      'sv_generate_harmony needs a range context from sv_snapshot_range with include ["notes"]'
    );
  }
  const occurrences = Array.isArray(stored.context.occurrences) ? stored.context.occurrences : [];
  const target = resolveOccurrenceSelector(
    occurrences,
    input.targetOccurrenceId,
    "targetOccurrenceId",
    warnings,
    continuationIdentities
  );
  let source;
  if (input.sourceOccurrenceId !== undefined) {
    source = resolveOccurrenceSelector(
      occurrences,
      input.sourceOccurrenceId,
      "sourceOccurrenceId",
      warnings,
      continuationIdentities
    );
  } else {
    // 自动选择：唯一一个"有音符且不是目标"的 occurrence。
    const candidates = occurrences.filter(
      (item) =>
        item.occurrenceId !== target.occurrenceId &&
        Array.isArray(item.noteFingerprints) &&
        item.noteFingerprints.length > 0
    );
    if (candidates.length === 1) {
      source = candidates[0];
    } else if (candidates.length === 0) {
      throw codedError(
        "NOTES_NOT_CAPTURED",
        "no melodic source occurrence with notes found besides the target; provide sourceOccurrenceId"
      );
    } else {
      const error = codedError(
        "AMBIGUOUS_CONTEXT",
        "range context has multiple candidate source occurrences; provide sourceOccurrenceId"
      );
      error.candidateOccurrences = candidates.map((item) => item.occurrenceId);
      error.details = { candidateOccurrences: error.candidateOccurrences };
      throw error;
    }
  }
  if (source.occurrenceId === target.occurrenceId) {
    throw codedError(
      "INVALID_ARGUMENTS",
      "source and target must be different occurrences; harmony inserted into the melody group would collide with it"
    );
  }
  const quarterBlick = stored.context.quarterBlick;
  if (!Number.isSafeInteger(quarterBlick) || quarterBlick <= 0) {
    throw codedError("INVALID_CONTEXT", "context is missing a usable SV.QUARTER timebase");
  }
  const sourceOffset = source.timeOffsetBlick ?? 0;
  const allSourceNotes = [...(source.noteFingerprints ?? [])]
    .map((fingerprint) => ({
      noteId: fingerprint.noteId,
      indexInGroup: fingerprint.indexInGroup,
      lyrics: fingerprint.lyrics,
      pitch: fingerprint.pitch,
      absOnsetBlick: sourceOffset + fingerprint.onsetBlick,
      durationBlick: fingerprint.durationBlick,
    }))
    .sort((left, right) => left.absOnsetBlick - right.absOnsetBlick);
  if (allSourceNotes.length === 0) {
    throw codedError(
      "NOTES_NOT_CAPTURED",
      'the source occurrence has no note fingerprints; re-run sv_snapshot_range with include ["notes"]'
    );
  }
  let selected = allSourceNotes;
  if (input.noteIds !== undefined) {
    const wanted = new Set(input.noteIds);
    selected = allSourceNotes.filter((note) => wanted.has(note.noteId));
    if (selected.length !== wanted.size) {
      const missing = input.noteIds.find(
        (noteId) => !allSourceNotes.some((note) => note.noteId === noteId)
      );
      throw codedError("UNKNOWN_NOTE_ID", `noteId is not part of the source occurrence: ${missing}`);
    }
  }
  const melodicNotes = selected.filter((note) => !isBreathLyrics(note.lyrics));
  if (melodicNotes.length === 0) {
    throw codedError(
      "NO_MELODIC_NOTES",
      "every selected source note is a breath event (lyrics 'br'); breaths need no harmony"
    );
  }
  const targetNotes = [...(target.noteFingerprints ?? [])].map((fingerprint) => ({
    noteId: fingerprint.noteId,
    localOnsetBlick: fingerprint.onsetBlick,
    durationBlick: fingerprint.durationBlick,
    pitch: fingerprint.pitch,
    lyrics: fingerprint.lyrics,
  }));
  return {
    stored,
    source,
    target,
    melodicNotes,
    skippedBreathCount: selected.length - melodicNotes.length,
    targetNotes,
    targetOffset: target.timeOffsetBlick ?? 0,
    quarterBlick,
  };
}

// selector 解析 + continuation 重锚定（与 quantize 同模式：位置后缀寻找候选，
// 短期身份记录校验 target UUID；结构会被插入改变，不做结构摘要）。
function resolveOccurrenceSelector(occurrences, selectorId, label, warnings, continuationIdentities) {
  let occurrence = occurrences.find((item) => item.occurrenceId === selectorId) ?? null;
  if (!occurrence) {
    const identity = continuationIdentities.get(selectorId);
    const position = identity ? OCCURRENCE_POSITION_PATTERN.exec(selectorId) : null;
    if (position) {
      const matches = occurrences.filter((item) => {
        const own = OCCURRENCE_POSITION_PATTERN.exec(item.occurrenceId);
        return own !== null && own[1] === position[1] && own[2] === position[2];
      });
      if (matches.length === 1) {
        if (matches[0].targetGroupUuid !== identity.targetGroupUuid) {
          const error = codedError(
            "STALE_CONTEXT",
            `${label} continuation selector target changed: expected group UUID ${identity.targetGroupUuid}, observed ${matches[0].targetGroupUuid}; re-snapshot and re-plan`
          );
          error.expectedGroupUuid = identity.targetGroupUuid;
          error.observedGroupUuid = matches[0].targetGroupUuid;
          throw error;
        }
        occurrence = matches[0];
        warnings.push({
          code: "STALE_SELECTOR_REANCHORED",
          message: `${label} references a consumed context; verified target identity, then re-anchored by position (track ${position[1]}, reference ${position[2]}) onto ${occurrence.occurrenceId}.`,
        });
      }
    }
  }
  if (!occurrence) {
    throw codedError("UNKNOWN_OCCURRENCE", `${label} is not part of the supplied contextId`);
  }
  return occurrence;
}

function pruneContinuationIdentities(identities, now) {
  for (const [key, identity] of identities) {
    if (identity.expiresAt <= now) identities.delete(key);
  }
}

function rememberContinuationIdentities(identities, loaded, input, now) {
  const expiresAt = loaded.stored.expiresAt;
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return;
  const entries = [
    [input.targetOccurrenceId, loaded.target.targetGroupUuid],
    ...(input.sourceOccurrenceId !== undefined
      ? [[input.sourceOccurrenceId, loaded.source.targetGroupUuid]]
      : []),
  ];
  for (const [selector, uuid] of entries) {
    if (typeof selector !== "string" || typeof uuid !== "string") continue;
    identities.delete(selector);
    identities.set(selector, { targetGroupUuid: uuid, expiresAt });
  }
  while (identities.size > MAX_CONTINUATION_IDENTITIES) {
    identities.delete(identities.keys().next().value);
  }
}

// ---------- 调性与映射 ----------

function mapHarmony(loaded, input, warnings) {
  let key;
  if (input.harmony.key) {
    key = {
      tonicPitchClass: PITCH_CLASS_NAMES.indexOf(input.harmony.key.tonic),
      tonic: input.harmony.key.tonic,
      mode: input.harmony.key.mode,
      source: "explicit",
    };
  } else {
    const detected = analyzeKey(loaded.melodicNotes, warnings);
    if (!detected) {
      throw codedError(
        "INSUFFICIENT_PITCH_VARIETY",
        "key detection needs at least two distinct pitch classes; pass harmony.key explicitly"
      );
    }
    key = {
      tonicPitchClass: detected.bestCandidate.tonicPitchClass,
      tonic: detected.bestCandidate.tonic,
      mode: detected.bestCandidate.mode,
      source: "detected",
      marginFromNext: detected.marginFromNext,
      runnerUp: {
        tonic: detected.candidates[1].tonic,
        mode: detected.candidates[1].mode,
        correlation: detected.candidates[1].correlation,
      },
    };
    if (detected.marginFromNext < KEY_AMBIGUITY_MARGIN) {
      warnings.push({
        code: "KEY_AMBIGUOUS",
        message: `detected key ${key.tonic} ${key.mode} leads the runner-up ${key.runnerUp.tonic} ${key.runnerUp.mode} by only ${detected.marginFromNext.toFixed(4)} (< ${KEY_AMBIGUITY_MARGIN} engineering threshold); pass harmony.key explicitly to lock the mapping.`,
      });
    }
  }
  const scale = key.mode === "major" ? MAJOR_SCALE : NATURAL_MINOR_SCALE;
  const steps = INTERVAL_STEPS[input.harmony.interval];
  const below = steps < 0;

  const items = [];
  let firstMelodicLyricsUsed = false;
  for (const note of loaded.melodicNotes) {
    const item = {
      sourceNoteId: note.noteId,
      sourceLyrics: note.lyrics,
      sourcePitch: note.pitch,
      absOnsetBlick: note.absOnsetBlick,
      durationBlick: note.durationBlick,
      status: "planned",
      needsReview: false,
      octaveShifted: false,
    };
    items.push(item);
    const offset = ((note.pitch % 12) - key.tonicPitchClass + 12) % 12;
    const scaleIndex = scale.indexOf(offset);
    let harmonyPitch;
    if (scaleIndex >= 0) {
      // 调内：自然音阶级 ±steps，八度随级数回绕。
      const base = note.pitch - offset;
      const newIndex = scaleIndex + steps;
      const octaveShift = Math.floor(newIndex / scale.length);
      const wrapped = ((newIndex % scale.length) + scale.length) % scale.length;
      harmonyPitch = base + octaveShift * 12 + scale[wrapped];
    } else {
      // 调外：借最近调内音（向下取）的映射半音差近似平移，标 needs_review。
      let nearestOffset = scale[0];
      for (const candidate of scale) {
        if (candidate <= offset) nearestOffset = candidate;
      }
      const nearestPitch = note.pitch - offset + nearestOffset;
      const nearestIndex = scale.indexOf(nearestOffset);
      const newIndex = nearestIndex + steps;
      const octaveShift = Math.floor(newIndex / scale.length);
      const wrapped = ((newIndex % scale.length) + scale.length) % scale.length;
      const mappedNearest = nearestPitch - nearestOffset + octaveShift * 12 + scale[wrapped];
      harmonyPitch = note.pitch + (mappedNearest - nearestPitch);
      item.needsReview = true;
      appendOnce(warnings, {
        code: "NON_DIATONIC_SOURCE_APPROXIMATED",
        message: `one or more source notes are outside ${key.tonic} ${key.mode}; their harmony pitches use the nearest scale tone's semitone offset and are flagged needsReview.`,
      });
    }
    // 音域守卫：越界先尝试一次八度位移。
    if (input.register) {
      if (harmonyPitch < input.register.minPitch) {
        harmonyPitch += 12;
        item.octaveShifted = true;
      } else if (harmonyPitch > input.register.maxPitch) {
        harmonyPitch -= 12;
        item.octaveShifted = true;
      }
      if (harmonyPitch < input.register.minPitch || harmonyPitch > input.register.maxPitch) {
        item.status = "skipped";
        item.skipReason = "register_unreachable";
        appendOnce(warnings, {
          code: "REGISTER_UNREACHABLE",
          message:
            "one or more harmony pitches remain outside the requested register even after an octave shift; those notes were skipped.",
        });
        continue;
      }
    }
    if (harmonyPitch < 0 || harmonyPitch > 127) {
      item.status = "skipped";
      item.skipReason = "midi_range";
      continue;
    }
    // 声部交叉守卫：below 变体必须低于源音，above 必须高于（八度位移可能破坏它）。
    if ((below && harmonyPitch >= note.pitch) || (!below && harmonyPitch <= note.pitch)) {
      item.status = "skipped";
      item.skipReason = "voice_crossing";
      appendOnce(warnings, {
        code: "VOICE_CROSSING_AVOIDED",
        message: `the ${input.harmony.interval} harmony would cross the source voice on one or more notes (usually after a register octave shift); those notes were skipped.`,
      });
      continue;
    }
    item.harmonyPitch = harmonyPitch;
    // 歌词：copy 原样复制；sustain 首个旋律词用源词、其余 "-" 延音。
    if (input.lyricsMode === "copy") {
      item.harmonyLyrics = note.lyrics;
    } else if (!firstMelodicLyricsUsed && note.lyrics !== "-" && note.lyrics !== "+") {
      item.harmonyLyrics = note.lyrics;
      firstMelodicLyricsUsed = true;
    } else {
      item.harmonyLyrics = "-";
    }
    // 目标本地坐标：负 onset 无法插入（音符在目标组时间偏移之前）。
    const localOnset = note.absOnsetBlick - loaded.targetOffset;
    if (localOnset < 0) {
      item.status = "skipped";
      item.skipReason = "before_target_offset";
      appendOnce(warnings, {
        code: "BEFORE_TARGET_OFFSET",
        message:
          "one or more harmony notes start before the target occurrence's time offset and cannot be inserted; move the target reference earlier or narrow the source selection.",
      });
      continue;
    }
    item.localOnsetBlick = localOnset;
  }

  // 目标既有音符对照：完全一致 → 已应用跳过（收敛）；跨度重叠但内容不同 → 冲突不覆盖。
  const conflicts = [];
  for (const item of items) {
    if (item.status !== "planned") continue;
    const exact = loaded.targetNotes.find(
      (note) =>
        note.localOnsetBlick === item.localOnsetBlick &&
        note.durationBlick === item.durationBlick &&
        note.pitch === item.harmonyPitch
    );
    if (exact) {
      item.status = "already_applied";
      continue;
    }
    const overlapping = loaded.targetNotes.find(
      (note) =>
        note.localOnsetBlick < item.localOnsetBlick + item.durationBlick &&
        item.localOnsetBlick < note.localOnsetBlick + note.durationBlick
    );
    if (overlapping) {
      item.status = "conflict";
      conflicts.push({
        sourceNoteId: item.sourceNoteId,
        plannedOnsetBlick: item.localOnsetBlick,
        plannedPitch: item.harmonyPitch,
        existingNoteId: overlapping.noteId,
        existingPitch: overlapping.pitch,
      });
    }
  }
  if (conflicts.length > 0) {
    warnings.push({
      code: "TARGET_NOTE_CONFLICT",
      message: `${conflicts.length} planned harmony note(s) overlap existing target notes with different content; they were NOT inserted (this planner never overwrites). Clear or move the conflicting notes first.`,
    });
  }
  return { key, items, conflicts };
}

// ---------- 响应组装 ----------

function buildHarmonyResponse(loaded, input, planned, warnings, timings) {
  const insertable = planned.items.filter((item) => item.status === "planned");
  const operations = insertable
    .sort((left, right) => left.localOnsetBlick - right.localOnsetBlick)
    .map((item) => ({
      op: "insert",
      note: {
        onsetBlick: item.localOnsetBlick,
        durationBlick: item.durationBlick,
        pitch: item.harmonyPitch,
        lyrics: item.harmonyLyrics,
      },
    }));
  const submittable = operations.slice(0, MAX_OPERATIONS);
  const remainingCount = operations.length - submittable.length;
  const restructureRequest =
    submittable.length > 0
      ? {
          tool: "sv_restructure_notes",
          arguments: {
            contextId: loaded.stored.contextId,
            occurrenceId: loaded.target.occurrenceId,
            operations: submittable,
            dryRun: true,
            atomic: true,
          },
        }
      : null;
  const continuation =
    remainingCount > 0
      ? {
          reason: "OPERATION_CAP",
          operationCapPerCall: MAX_OPERATIONS,
          remainingCount,
          workflow: [
            "Commit the returned restructureRequest (dryRun first, then dryRun:false).",
            "A successful commit invalidates this contextId, so re-run sv_snapshot_range over the same range for a fresh context.",
            "Re-run sv_generate_harmony with the same harmony/register/lyricsMode options against the fresh contextId: already-inserted harmony notes match exactly and are skipped as already_applied, so the next round plans the remaining inserts. Explicit occurrence selectors are re-anchored only while their short-lived continuation identities prove the same target group UUIDs (warned as STALE_SELECTOR_REANCHORED).",
            "Repeat until the response carries no continuation (or reports status no_change).",
          ],
        }
      : null;
  if (continuation) {
    warnings.push({
      code: "PLAN_EXCEEDS_OPERATION_CAP",
      message: `${operations.length} inserts exceed the ${MAX_OPERATIONS}-operation per-call cap; restructureRequest carries the first ${submittable.length} and ${remainingCount} remain. Follow continuation.workflow: commit, re-snapshot, re-plan with identical options. Each round is its own transaction and Undo record.`,
    });
  }
  const sharedTargetOccurrences = loaded.target.sharedTargetOccurrences ?? [];
  const requiresSharedTargetConfirmation = sharedTargetOccurrences.length > 1;
  const planId = `hrm_${createHash("sha256")
    .update(
      stableStringify({
        sourceOccurrenceId: loaded.source.occurrenceId,
        targetOccurrenceId: loaded.target.occurrenceId,
        harmony: input.harmony,
        register: input.register,
        lyricsMode: input.lyricsMode,
        operations,
      })
    )
    .digest("hex")
    .slice(0, 16)}`;
  const counts = {
    sourceNotes: loaded.melodicNotes.length,
    skippedBreaths: loaded.skippedBreathCount,
    planned: insertable.length,
    alreadyApplied: planned.items.filter((item) => item.status === "already_applied").length,
    conflicts: planned.conflicts.length,
    skipped: planned.items.filter((item) => item.status === "skipped").length,
    needsReview: planned.items.filter((item) => item.needsReview).length,
    octaveShifted: planned.items.filter((item) => item.octaveShifted).length,
  };
  const cap = input.responseMode === "verbose" ? planned.items.length : MAX_LIST_ITEMS;
  if (input.responseMode !== "compact" && planned.items.length > cap) {
    warnings.push({
      code: "PER_NOTE_TRUNCATED",
      message: `perNote reports the first ${cap} of ${planned.items.length} source notes; use responseMode:"verbose" for the full list. Summary counts always cover all notes.`,
    });
  }
  const checklist = [
    "Review perNote harmony pitches; diatonic mapping is a heuristic, not an arrangement — audition the result (human_only).",
    "Apply through the returned restructureRequest (sv_restructure_notes) with dryRun:true first, then commit.",
  ];
  if (counts.needsReview > 0) {
    checklist.push(
      `${counts.needsReview} harmony note(s) come from non-diatonic source notes (nearest-scale-tone approximation); review them manually.`
    );
  }
  if (counts.conflicts > 0) {
    checklist.push(
      `${counts.conflicts} planned note(s) conflict with existing target notes and were NOT included; clear or move them first.`
    );
  }
  if (requiresSharedTargetConfirmation) {
    checklist.push(
      "The target NoteGroup is shared by multiple occurrences; committing the inserts requires allowSharedTargetMutation:true and affects every occurrence."
    );
  }
  if (continuation) {
    checklist.push(
      `${remainingCount} insert(s) do not fit this call (${MAX_OPERATIONS}-operation cap): after committing, re-snapshot the same range and re-run sv_generate_harmony with identical options — the loop converges to no_change.`
    );
  }
  return {
    ok: true,
    status: restructureRequest ? "planned" : "no_change",
    dryRun: true,
    effects: "none",
    planId,
    contextId: loaded.stored.contextId,
    source: {
      occurrenceId: loaded.source.occurrenceId,
      trackIndex: loaded.source.trackIndex,
      groupIndex: loaded.source.groupIndex,
      targetGroupUuid: loaded.source.targetGroupUuid,
    },
    target: {
      occurrenceId: loaded.target.occurrenceId,
      trackIndex: loaded.target.trackIndex,
      groupIndex: loaded.target.groupIndex,
      targetGroupUuid: loaded.target.targetGroupUuid,
      timeOffsetBlick: loaded.targetOffset,
      sharedTargetOccurrences,
    },
    key: planned.key,
    harmony: {
      interval: input.harmony.interval,
      lyricsMode: input.lyricsMode,
      ...(input.register ? { register: input.register } : {}),
    },
    summary: counts,
    ...(input.responseMode === "compact"
      ? {}
      : {
          perNote: planned.items.slice(0, cap).map((item) => ({
            sourceNoteId: item.sourceNoteId,
            sourceLyrics: item.sourceLyrics,
            sourcePitch: item.sourcePitch,
            status: item.status,
            ...(item.harmonyPitch !== undefined ? { harmonyPitch: item.harmonyPitch } : {}),
            ...(item.harmonyLyrics !== undefined ? { harmonyLyrics: item.harmonyLyrics } : {}),
            ...(item.localOnsetBlick !== undefined
              ? { targetLocalOnsetBlick: item.localOnsetBlick }
              : {}),
            ...(item.skipReason ? { skipReason: item.skipReason } : {}),
            ...(item.needsReview ? { needsReview: true } : {}),
            ...(item.octaveShifted ? { octaveShifted: true } : {}),
          })),
          perNoteTruncated: planned.items.length > cap,
          conflicts: planned.conflicts.slice(0, cap),
        }),
    restructureRequest,
    ...(continuation ? { continuation } : {}),
    review: {
      requiresHumanAudition: true,
      requiresSharedTargetConfirmation,
      checklist,
    },
    provenance: PROVENANCE,
    warnings,
    timings,
  };
}

// ---------- 请求校验 ----------

function normalizeHarmonyRequest(request) {
  if (!isRecord(request)) throw codedError("INVALID_ARGUMENTS", "request must be an object");
  assertKnownKeys(
    request,
    [
      "contextId",
      "sourceOccurrenceId",
      "targetOccurrenceId",
      "harmony",
      "register",
      "lyricsMode",
      "noteIds",
      "responseMode",
    ],
    "request"
  );
  if (typeof request.contextId !== "string" || request.contextId.length === 0) {
    throw codedError("INVALID_ARGUMENTS", "contextId must be a non-empty string");
  }
  if (
    request.sourceOccurrenceId !== undefined &&
    (typeof request.sourceOccurrenceId !== "string" || request.sourceOccurrenceId.length === 0)
  ) {
    throw codedError("INVALID_ARGUMENTS", "sourceOccurrenceId must be a non-empty string when provided");
  }
  if (typeof request.targetOccurrenceId !== "string" || request.targetOccurrenceId.length === 0) {
    throw codedError(
      "INVALID_ARGUMENTS",
      "targetOccurrenceId is required (prepare the destination group first, e.g. via sv_clone_track_from_template, then re-snapshot so source and target share one range context)"
    );
  }
  if (!isRecord(request.harmony)) throw codedError("INVALID_ARGUMENTS", "harmony must be an object");
  assertKnownKeys(request.harmony, ["interval", "key"], "harmony");
  if (!HARMONY_INTERVALS.includes(request.harmony.interval)) {
    throw codedError("INVALID_ARGUMENTS", `harmony.interval must be one of ${HARMONY_INTERVALS.join(", ")}`);
  }
  let key;
  if (request.harmony.key !== undefined) {
    if (!isRecord(request.harmony.key)) {
      throw codedError("INVALID_ARGUMENTS", "harmony.key must be an object");
    }
    assertKnownKeys(request.harmony.key, ["tonic", "mode"], "harmony.key");
    if (!PITCH_CLASS_NAMES.includes(request.harmony.key.tonic)) {
      throw codedError(
        "INVALID_ARGUMENTS",
        `harmony.key.tonic must be one of ${PITCH_CLASS_NAMES.join(", ")} (sharps-only spelling)`
      );
    }
    if (!["major", "minor"].includes(request.harmony.key.mode)) {
      throw codedError("INVALID_ARGUMENTS", "harmony.key.mode must be major or minor");
    }
    key = { tonic: request.harmony.key.tonic, mode: request.harmony.key.mode };
  }
  let register;
  if (request.register !== undefined) {
    if (!isRecord(request.register)) throw codedError("INVALID_ARGUMENTS", "register must be an object");
    assertKnownKeys(request.register, ["minPitch", "maxPitch"], "register");
    const { minPitch, maxPitch } = request.register;
    if (
      !Number.isSafeInteger(minPitch) ||
      !Number.isSafeInteger(maxPitch) ||
      minPitch < 0 ||
      maxPitch > 127 ||
      minPitch >= maxPitch
    ) {
      throw codedError(
        "INVALID_ARGUMENTS",
        "register must satisfy 0 <= minPitch < maxPitch <= 127"
      );
    }
    register = { minPitch, maxPitch };
  }
  const lyricsMode = request.lyricsMode ?? "copy";
  if (!HARMONY_LYRICS_MODES.includes(lyricsMode)) {
    throw codedError("INVALID_ARGUMENTS", `lyricsMode must be one of ${HARMONY_LYRICS_MODES.join(", ")}`);
  }
  if (request.noteIds !== undefined) {
    if (
      !Array.isArray(request.noteIds) ||
      request.noteIds.length === 0 ||
      request.noteIds.length > 2000 ||
      !request.noteIds.every((noteId) => typeof noteId === "string" && noteId.length > 0) ||
      new Set(request.noteIds).size !== request.noteIds.length
    ) {
      throw codedError("INVALID_ARGUMENTS", "noteIds must be 1-2000 unique non-empty strings");
    }
  }
  const responseMode = request.responseMode ?? "standard";
  if (!["compact", "standard", "verbose"].includes(responseMode)) {
    throw codedError("INVALID_ARGUMENTS", "responseMode must be compact, standard, or verbose");
  }
  return {
    contextId: request.contextId,
    sourceOccurrenceId: request.sourceOccurrenceId,
    targetOccurrenceId: request.targetOccurrenceId,
    harmony: { interval: request.harmony.interval, ...(key ? { key } : {}) },
    register,
    lyricsMode,
    noteIds: request.noteIds,
    responseMode,
  };
}

// ---------- 小工具 ----------

function appendOnce(warnings, warning) {
  if (!warnings.some((item) => item.code === warning.code)) warnings.push(warning);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function assertKnownKeys(value, allowed, label) {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw codedError("INVALID_ARGUMENTS", `${label} contains unknown field: ${unknown.join(", ")}`);
  }
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
