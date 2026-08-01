import { canonicalHashHex } from "./canonical-json.js";
import { artifactReference, planReference } from "./artifact-store.js";
import { buildPlanArtifact } from "./plan-reference.js";

import { MAX_OPERATIONS } from "./note-structure.js";
import { analyzeKey } from "./phrase-analysis.js";
import { buildApplyEnvelope } from "./plan-envelope.js";
import { selectOccurrenceByOrdinal } from "./scope-source.js";
import { ServiceTiming } from "./service-timing.js";
import { isBreathEventLyrics } from "./vocal-event-semantics.js";
import { unknownContextError } from "./snapshot.js";

// sv_generate_harmony：调内和声规划器（HANDOFF §8.16 "仍未实现"清单最后一个规划项）。
//
// 关键契约：
// - 纯内存只读：只读取 range context 的音符指纹，不进 ExecutionCoordinator、绝不写宿主。
//   真正落地由调用方把 apply 交给现有 sv_restructure_notes（Undo/读回/补偿
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

// 显式音阶目录（主计划 P1-C Phase 5）：七种调式 + harmonic/melodic minor + major/minor
// pentatonic + blues + whole-tone + chromatic。音程集合由标准乐理独立给出；外部样本
// （Hrauroras/SV2-Script，MIT）仅作目录存在性的佐证，不作为正确性来源。
export const HARMONY_SCALE_TYPES = Object.freeze({
  ionian: Object.freeze([0, 2, 4, 5, 7, 9, 11]),
  dorian: Object.freeze([0, 2, 3, 5, 7, 9, 10]),
  phrygian: Object.freeze([0, 1, 3, 5, 7, 8, 10]),
  lydian: Object.freeze([0, 2, 4, 6, 7, 9, 11]),
  mixolydian: Object.freeze([0, 2, 4, 5, 7, 9, 10]),
  aeolian: Object.freeze([0, 2, 3, 5, 7, 8, 10]),
  locrian: Object.freeze([0, 1, 3, 5, 6, 8, 10]),
  harmonic_minor: Object.freeze([0, 2, 3, 5, 7, 8, 11]),
  melodic_minor: Object.freeze([0, 2, 3, 5, 7, 9, 11]),
  major_pentatonic: Object.freeze([0, 2, 4, 7, 9]),
  minor_pentatonic: Object.freeze([0, 3, 5, 7, 10]),
  blues: Object.freeze([0, 3, 5, 6, 7, 10]),
  whole_tone: Object.freeze([0, 2, 4, 6, 8, 10]),
  chromatic: Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
});
export const HARMONY_SCALE_NAMES = Object.freeze(Object.keys(HARMONY_SCALE_TYPES));
export const HARMONY_INTERVAL_DEGREES = Object.freeze([1, 2, 3, 4, 5, 6, 7]);
export const HARMONY_INTERVAL_DIRECTIONS = Object.freeze(["above", "below"]);

// 旧命名 interval -> 广义 {degree, direction} 映射。sixth ≡ third 的转位（±5 级）。
const LEGACY_INTERVAL_STEPS = Object.freeze({
  third_below: { degree: 3, direction: "below" },
  third_above: { degree: 3, direction: "above" },
  sixth_below: { degree: 6, direction: "below" },
  sixth_above: { degree: 6, direction: "above" },
});
const MODE_TO_SCALE = Object.freeze({ major: "ionian", minor: "aeolian" });
const PITCH_CLASS_NAMES = Object.freeze([
  "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
]);
const MAJOR_SCALE = HARMONY_SCALE_TYPES.ionian;
const NATURAL_MINOR_SCALE = HARMONY_SCALE_TYPES.aeolian;
// K-S margin 低于此值时调性歧义警告（工程默认，未经真机校准）。
const KEY_AMBIGUITY_MARGIN = 0.05;
const MAX_LIST_ITEMS = 100;
const MAX_CONTINUATION_IDENTITIES = 256;

const PROVENANCE = Object.freeze({
  planner: "diatonic_interval_mapper",
  keyMethod: "krumhansl_schmuckler_duration_weighted_pearson",
  keyAmbiguityMargin: "engineering_default_requires_host_calibration",
  scaleCatalog: "explicit_caller_approved_14_types_ks_detects_major_minor_only",
  intervalModel: "generalized_scale_degree_direction_octave",
  nonDiatonicMapping: "nearest_scale_tone_semitone_offset_needs_review",
  trackAndGroupCreation: "not_provided_use_sv_clone_track_from_template_first",
  breathNotes: "skipped_breaths_need_no_harmony",
  basis: "derived_not_host_fact",
  perception: "human_only",
});

export class HarmonyPlanService {
  constructor({ store, now = () => Date.now(), artifactStore = null, sessionId = null } = {}) {
    if (!store) throw new Error("HarmonyPlanService requires the shared SnapshotStore");
    this.store = store;
    this.now = now;
    this.artifactStore = artifactStore;
    this.sessionId = sessionId;
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
    const response = buildHarmonyResponse(loaded, input, planned, warnings, timer.finish(), {
      artifactStore: this.artifactStore,
      sessionId: this.sessionId,
    });
    if (response.continuation) {
      rememberContinuationIdentities(this.continuationIdentities, loaded, input, this.now());
    }
    return response;
  }
}

// ---------- 上下文解析 ----------

function resolveHarmonySource(store, input, warnings, continuationIdentities) {
  const stored = store.get(input.contextId);
  if (!stored) {
    throw unknownContextError(store, input.contextId);
  }
  if (stored.context?.kind !== "range") {
    throw codedError(
      "INVALID_CONTEXT",
      'sv_generate_harmony needs a range context from sv_snapshot_range with include ["notes"]'
    );
  }
  const occurrences = Array.isArray(stored.context.occurrences) ? stored.context.occurrences : [];
  const targetSelection = resolveOccurrenceSelector(
    occurrences,
    input.targetOccurrence,
    "targetOccurrence",
    warnings,
    continuationIdentities,
    { requireNotes: false, contextId: input.contextId }
  );
  const target = targetSelection.occurrence;
  const targetOrdinal = targetSelection.ordinal;
  let source;
  let sourceOrdinal;
  if (input.sourceOccurrence !== undefined) {
    const sourceSelection = resolveOccurrenceSelector(
      occurrences,
      input.sourceOccurrence,
      "sourceOccurrence",
      warnings,
      continuationIdentities,
      { requireNotes: true, contextId: input.contextId }
    );
    source = sourceSelection.occurrence;
    sourceOrdinal = sourceSelection.ordinal;
  } else {
    // 自动选择：唯一一个"有音符且不是目标"的 occurrence。
    const candidates = occurrences.flatMap((item, ordinal) =>
      item !== target &&
        typeof item.targetGroupUuid === "string" &&
        Array.isArray(item.noteFingerprints) &&
        item.noteFingerprints.length > 0
        ? [{ occurrence: item, ordinal }]
        : []
    );
    if (candidates.length === 1) {
      source = candidates[0].occurrence;
      sourceOrdinal = candidates[0].ordinal;
    } else if (candidates.length === 0) {
      throw codedError(
        "NOTES_NOT_CAPTURED",
        "no melodic source occurrence with notes found besides the target; pass sourceOccurrence"
      );
    } else {
      const error = codedError(
        "AMBIGUOUS_CONTEXT",
        "range context has multiple candidate source occurrences; pass sourceOccurrence"
      );
      error.details = { candidates: candidates.map((item) => item.ordinal) };
      error.candidateOrdinals = error.details.candidates;
      throw error;
    }
  }
  if (sourceOrdinal === targetOrdinal) {
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
  const sourcePitchOffset = occurrencePitchOffset(source, "source");
  const targetPitchOffset = occurrencePitchOffset(target, "target");
  const allSourceNotes = [...(source.noteFingerprints ?? [])]
    .map((fingerprint) => ({
      indexInGroup: fingerprint.indexInGroup,
      lyrics: fingerprint.lyrics,
      pitch: fingerprint.pitch + sourcePitchOffset,
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
  if (input.notes !== undefined) {
    const wanted = new Set(input.notes);
    selected = allSourceNotes.filter((note) => wanted.has(note.indexInGroup));
    if (selected.length !== wanted.size) {
      const missing = input.notes.find(
        (index) => !allSourceNotes.some((note) => note.indexInGroup === index)
      );
      const groupNoteCount = source.groupNoteCount ?? allSourceNotes.length;
      if (missing >= groupNoteCount) {
        throw codedError(
          "NOTE_INDEX_OUT_OF_RANGE",
          `note index ${missing} is outside the source note group`,
          { got: missing, max: groupNoteCount - 1 }
        );
      }
      throw codedError(
        "NOTE_NOT_IN_CONTEXT",
        `note ${missing} exists but was not captured in the source occurrence`,
        { got: missing }
      );
    }
  }
  const melodicNotes = selected.filter((note) => !isBreathEventLyrics(note.lyrics));
  if (melodicNotes.length === 0) {
    throw codedError(
      "NO_MELODIC_NOTES",
      "every selected source note is a breath event (lyrics 'br'); breaths need no harmony"
    );
  }
  const targetNotes = [...(target.noteFingerprints ?? [])].map((fingerprint) => ({
    localOnsetBlick: fingerprint.onsetBlick,
    durationBlick: fingerprint.durationBlick,
    pitch: fingerprint.pitch,
    lyrics: fingerprint.lyrics,
  }));
  return {
    stored,
    source,
    sourceOrdinal,
    target,
    targetOrdinal,
    melodicNotes,
    skippedBreathCount: selected.length - melodicNotes.length,
    targetNotes,
    targetOffset: target.timeOffsetBlick ?? 0,
    sourcePitchOffset,
    targetPitchOffset,
    quarterBlick,
  };
}

function occurrencePitchOffset(occurrence, label) {
  const pitchOffset = occurrence.pitchOffsetSemitone ?? 0;
  if (!Number.isSafeInteger(pitchOffset)) {
    throw codedError(
      "UNSUPPORTED_PITCH_OFFSET",
      `${label} occurrence uses a non-integer pitchOffsetSemitone; sv_generate_harmony cannot produce an integer-MIDI sv_restructure_notes request for it`
    );
  }
  return pitchOffset;
}

// ordinal 选择先遵守完整 occurrences 数组的稳定编号，再用短期 UUID 记录保护续跑。
function resolveOccurrenceSelector(
  occurrences,
  selector,
  label,
  warnings,
  continuationIdentities,
  { requireNotes, contextId }
) {
  const selection = selectOccurrenceByOrdinal(occurrences, selector, {
    eligible: (occurrence) =>
      typeof occurrence?.targetGroupUuid === "string" &&
      (!requireNotes ||
        (Array.isArray(occurrence.noteFingerprints) && occurrence.noteFingerprints.length > 0)),
    noneCode: requireNotes ? "NOTES_NOT_CAPTURED" : "OCCURRENCE_NOT_CAPTURED",
    noneMessage: requireNotes
      ? `${label} requires an occurrence with captured notes`
      : `${label} requires a captured vocal occurrence`,
    ambiguousMessage: `context has multiple candidates for ${label}; pass its 0-based ordinal`,
    ineligibleCode: requireNotes ? "NOTES_NOT_CAPTURED" : "OCCURRENCE_NOT_CAPTURED",
    ineligibleMessage: requireNotes
      ? `${label} does not contain captured notes`
      : `${label} is not a captured vocal occurrence`,
  });
  const key = continuationIdentityKey(label, selection.occurrence);
  const identity = key ? continuationIdentities.get(key) : null;
  if (identity && identity.contextId !== contextId) {
    if (selection.occurrence.targetGroupUuid !== identity.targetGroupUuid) {
      const error = codedError(
        "STALE_CONTEXT",
        `${label} continuation target changed: expected group UUID ${identity.targetGroupUuid}, observed ${selection.occurrence.targetGroupUuid}; re-snapshot and re-plan`
      );
      error.expectedGroupUuid = identity.targetGroupUuid;
      error.observedGroupUuid = selection.occurrence.targetGroupUuid;
      throw error;
    }
    warnings.push({
      code: "CONTINUATION_IDENTITY_VERIFIED",
      message: `${label} uses a fresh context; verified track/reference position and target group UUID before continuing.`,
    });
  }
  return selection;
}

function continuationIdentityKey(label, occurrence) {
  if (!Number.isSafeInteger(occurrence?.trackIndex) || !Number.isSafeInteger(occurrence?.groupIndex)) {
    return null;
  }
  return `${label}:t:${occurrence.trackIndex}:r:${occurrence.groupIndex}`;
}

function pruneContinuationIdentities(identities, now) {
  for (const [key, identity] of identities) {
    if (identity.expiresAt <= now) identities.delete(key);
  }
}

function rememberContinuationIdentities(identities, loaded, _input, now) {
  const expiresAt = loaded.stored.expiresAt;
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return;
  const entries = [
    [continuationIdentityKey("targetOccurrence", loaded.target), loaded.target.targetGroupUuid],
    [continuationIdentityKey("sourceOccurrence", loaded.source), loaded.source.targetGroupUuid],
  ];
  for (const [key, uuid] of entries) {
    if (typeof key !== "string" || typeof uuid !== "string") continue;
    identities.delete(key);
    identities.set(key, { contextId: loaded.stored.contextId, targetGroupUuid: uuid, expiresAt });
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
      // 显式 scale（七模式/harmonic/melodic minor/pentatonic/blues/whole-tone/chromatic）
      // 优先于 mode 推导；缺省 mode→ionian/aeolian（保持旧行为）。
      scale: input.harmony.key.scale ?? MODE_TO_SCALE[input.harmony.key.mode],
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
      // K-S 只检测 major/minor：scale 沿用 mode 推导，绝不假装检测出扩展调式。
      scale: MODE_TO_SCALE[detected.bestCandidate.mode],
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
  const scale = HARMONY_SCALE_TYPES[key.scale];
  const steps = intervalSteps(input.intervalSpec, scale.length);
  const below = steps < 0;

  const items = [];
  let firstMelodicLyricsUsed = false;
  for (const note of loaded.melodicNotes) {
    const item = {
      sourceNote: note.indexInGroup,
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
      item.outOfScale = true;
      appendOnce(warnings, {
        code: "NON_DIATONIC_SOURCE_APPROXIMATED",
        message: `one or more source notes are outside ${key.tonic} ${key.scale}; their harmony pitches use the nearest scale tone's semitone offset and are flagged needsReview.`,
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
    // unison（degree 1）本就是同度/八度 doubling，不会"交叉"——跳过此守卫，否则同度永被误杀。
    if (
      input.intervalSpec.degree !== 1 &&
      ((below && harmonyPitch >= note.pitch) || (!below && harmonyPitch <= note.pitch))
    ) {
      item.status = "skipped";
      item.skipReason = "voice_crossing";
      appendOnce(warnings, {
        code: "VOICE_CROSSING_AVOIDED",
        message: `the ${input.harmony.interval} harmony would cross the source voice on one or more notes (usually after a register octave shift); those notes were skipped.`,
      });
      continue;
    }
    const targetLocalPitch = harmonyPitch - loaded.targetPitchOffset;
    if (targetLocalPitch < 0 || targetLocalPitch > 127) {
      item.status = "skipped";
      item.skipReason = "target_local_midi_range";
      continue;
    }
    item.harmonyPitch = targetLocalPitch;
    item.harmonySoundingPitch = harmonyPitch;
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
        note.pitch === item.harmonyPitch &&
        note.lyrics === item.harmonyLyrics
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
        plannedLyrics: item.harmonyLyrics,
        existingNote: overlapping.indexInGroup,
        existingPitch: overlapping.pitch,
        existingLyrics: overlapping.lyrics,
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

function buildHarmonyResponse(
  loaded,
  input,
  planned,
  warnings,
  timings,
  { artifactStore, sessionId } = {}
) {
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
            occurrence: loaded.targetOrdinal,
            operations: submittable,
            action: "dry_run",
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
            "Submit apply.arguments with action dry_run, then commit.",
            "A successful commit invalidates this contextId, so re-run sv_snapshot_range over the same range for a fresh context.",
            "Re-run sv_generate_harmony with the same harmony/register/lyricsMode options and fresh occurrence ordinals: already-inserted harmony notes match exactly and are skipped as already_applied, so the next round plans the remaining inserts. Short-lived continuation identities verify that each track/reference position still targets the same group UUID.",
            "Repeat until the response carries no continuation (or reports status no_change).",
          ],
        }
      : null;
  if (continuation) {
    warnings.push({
      code: "PLAN_EXCEEDS_OPERATION_CAP",
      message: `${operations.length} inserts exceed the ${MAX_OPERATIONS}-operation per-call cap; apply carries the first ${submittable.length} and ${remainingCount} remain. Follow continuation.workflow: commit, re-snapshot, re-plan with identical options. Each round is its own transaction and Undo record.`,
    });
  }
  const sharedTargetOccurrences = loaded.target.sharedTargetOccurrences ?? [];
  const requiresSharedTargetConfirmation = sharedTargetOccurrences.length > 1;
  const planId = `hrm_${canonicalHashHex({
    sourceOccurrence: loaded.sourceOrdinal,
    targetOccurrence: loaded.targetOrdinal,
    harmony: input.harmony,
    ...(input.register !== undefined ? { register: input.register } : {}),
    lyricsMode: input.lyricsMode,
    operations,
  }).slice(0, 16)}`;
  const counts = {
    sourceNotes: loaded.melodicNotes.length,
    skippedBreaths: loaded.skippedBreathCount,
    planned: insertable.length,
    alreadyApplied: planned.items.filter((item) => item.status === "already_applied").length,
    conflicts: planned.conflicts.length,
    skipped: planned.items.filter((item) => item.status === "skipped").length,
    needsReview: planned.items.filter((item) => item.needsReview).length,
    outOfScale: planned.items.filter((item) => item.outOfScale).length,
    octaveShifted: planned.items.filter((item) => item.octaveShifted).length,
  };
  const cap = MAX_LIST_ITEMS;
  if (planned.items.length > cap) {
    warnings.push({
      code: "PER_NOTE_TRUNCATED",
      message: `perNote reports the first ${cap} of ${planned.items.length} source notes; read the sealed plan artifact for the full list. Summary counts always cover all notes.`,
    });
  }
  const checklist = [
    "Review perNote harmony pitches; diatonic mapping is a heuristic, not an arrangement — audition the result (human_only).",
    "Apply through the returned apply envelope with action dry_run first, then commit.",
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
  let planRef = null;
  let planExpiresAt = null;
  if (artifactStore && sessionId && restructureRequest) {
    try {
      const { payload } = buildPlanArtifact({
        targetTool: "sv_restructure_notes",
        mutationRequest: restructureRequest.arguments,
        targetGroupUuid: loaded.target.targetGroupUuid,
        occurrence: loaded.targetOrdinal,
        capsule: {
          stored: loaded.stored,
          occurrence: loaded.target,
          // harmony 往空目标里插音符，因此不引用目标组的任何既有音符。
          noteIndexes: [],
        },
      });
      const planArtifact = artifactStore.seal({
        kind: "plan",
        schemaVersion: "1",
        sessionId,
        sourceEpoch: loaded.stored.epoch,
        payload,
      });
      planRef = planReference(planArtifact);
      planExpiresAt = planArtifact.expiresAt;
    } catch (error) {
      warnings.push({
        code: "ARTIFACT_SEAL_FAILED",
        message: `Failed to seal harmony plan artifact: ${error.message}`,
      });
    }
  }
  const apply = buildApplyEnvelope(restructureRequest ? [restructureRequest] : null, {
    sharedTargetConfirmationRequired: requiresSharedTargetConfirmation,
  });
  if (planRef && apply?.arguments) {
    apply.arguments = { planRef, action: "dry_run" };
    // 租期是关于这次交接的事实，挂在信封上；planRef 只承载身份（§4.3）。
    apply.expiresAt = planExpiresAt;
  }

  return {
    ok: true,
    status: restructureRequest ? "planned" : "no_change",
    effects: "none",
    planId,
    contextId: loaded.stored.contextId,
    source: {
      occurrence: loaded.sourceOrdinal,
      trackIndex: loaded.source.trackIndex,
      groupIndex: loaded.source.groupIndex,
      targetGroupUuid: loaded.source.targetGroupUuid,
      pitchOffsetSemitone: loaded.sourcePitchOffset,
    },
    target: {
      occurrence: loaded.targetOrdinal,
      trackIndex: loaded.target.trackIndex,
      groupIndex: loaded.target.groupIndex,
      targetGroupUuid: loaded.target.targetGroupUuid,
      timeOffsetBlick: loaded.targetOffset,
      pitchOffsetSemitone: loaded.targetPitchOffset,
      sharedTargetOccurrences,
    },
    key: planned.key,
    harmony: {
      interval: input.harmony.interval,
      intervalSpec: {
        degree: input.intervalSpec.degree,
        direction: input.intervalSpec.direction,
        octaveOffset: input.intervalSpec.octaveOffset,
        scaleSteps: intervalSteps(input.intervalSpec, HARMONY_SCALE_TYPES[planned.key.scale].length),
      },
      scale: planned.key.scale,
      lyricsMode: input.lyricsMode,
      ...(input.register ? { register: input.register } : {}),
    },
    summary: counts,
    perNote: planned.items.slice(0, cap).map((item) => ({
      sourceNoteId: item.sourceNoteId,
      sourceLyrics: item.sourceLyrics,
      sourcePitch: item.sourcePitch,
      status: item.status,
      ...(item.harmonyPitch !== undefined ? { harmonyPitch: item.harmonyPitch } : {}),
      ...(item.harmonySoundingPitch !== undefined
        ? { harmonySoundingPitch: item.harmonySoundingPitch }
        : {}),
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
    apply,
    ...(!planRef ? { restructureRequest } : {}),
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
      "sourceOccurrence",
      "targetOccurrence",
      "harmony",
      "register",
      "lyricsMode",
      "notes",
    ],
    "request"
  );
  if (typeof request.contextId !== "string" || request.contextId.length === 0) {
    throw codedError("INVALID_ARGUMENTS", "contextId must be a non-empty string");
  }
  if (
    request.sourceOccurrence !== undefined &&
    (!Number.isSafeInteger(request.sourceOccurrence) || request.sourceOccurrence < 0)
  ) {
    throw codedError("INVALID_ARGUMENTS", "sourceOccurrence must be a non-negative safe integer when provided");
  }
  if (!Number.isSafeInteger(request.targetOccurrence) || request.targetOccurrence < 0) {
    throw codedError(
      "INVALID_ARGUMENTS",
      "targetOccurrence is required and must be a non-negative safe integer (prepare the destination group first, then re-snapshot so source and target share one range context)"
    );
  }
  if (!isRecord(request.harmony)) throw codedError("INVALID_ARGUMENTS", "harmony must be an object");
  assertKnownKeys(request.harmony, ["interval", "key"], "harmony");
  const intervalSpec = normalizeInterval(request.harmony.interval);
  let key;
  if (request.harmony.key !== undefined) {
    if (!isRecord(request.harmony.key)) {
      throw codedError("INVALID_ARGUMENTS", "harmony.key must be an object");
    }
    assertKnownKeys(request.harmony.key, ["tonic", "mode", "scale"], "harmony.key");
    if (!PITCH_CLASS_NAMES.includes(request.harmony.key.tonic)) {
      throw codedError(
        "INVALID_ARGUMENTS",
        `harmony.key.tonic must be one of ${PITCH_CLASS_NAMES.join(", ")} (sharps-only spelling)`
      );
    }
    if (!["major", "minor"].includes(request.harmony.key.mode)) {
      throw codedError("INVALID_ARGUMENTS", "harmony.key.mode must be major or minor");
    }
    if (
      request.harmony.key.scale !== undefined &&
      !HARMONY_SCALE_NAMES.includes(request.harmony.key.scale)
    ) {
      throw codedError(
        "INVALID_ARGUMENTS",
        `harmony.key.scale must be one of ${HARMONY_SCALE_NAMES.join(", ")}`
      );
    }
    key = {
      tonic: request.harmony.key.tonic,
      mode: request.harmony.key.mode,
      ...(request.harmony.key.scale ? { scale: request.harmony.key.scale } : {}),
    };
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
  if (request.notes !== undefined) {
    if (
      !Array.isArray(request.notes) ||
      request.notes.length === 0 ||
      request.notes.length > 2000 ||
      !request.notes.every((index) => Number.isSafeInteger(index) && index >= 0) ||
      new Set(request.notes).size !== request.notes.length
    ) {
      throw codedError("INVALID_ARGUMENTS", "notes must be 1-2000 unique non-negative indexes");
    }
  }
  return {
    contextId: request.contextId,
    sourceOccurrence: request.sourceOccurrence,
    targetOccurrence: request.targetOccurrence,
    harmony: { interval: request.harmony.interval, ...(key ? { key } : {}) },
    intervalSpec,
    register,
    lyricsMode,
    notes: request.notes,
  };
}

// 归一化 interval：旧命名（third_below 等）映射到广义 {degree, direction}；对象形式
// {degree, direction, octaveOffset} 直接表达 1-7 度、above/below、八度位移。
function normalizeInterval(interval) {
  if (typeof interval === "string") {
    const legacy = LEGACY_INTERVAL_STEPS[interval];
    if (!legacy) {
      throw codedError(
        "INVALID_ARGUMENTS",
        `harmony.interval must be one of ${HARMONY_INTERVALS.join(", ")}, or {degree,direction,octaveOffset?}`
      );
    }
    return { degree: legacy.degree, direction: legacy.direction, octaveOffset: 0, label: interval };
  }
  if (!isRecord(interval)) {
    throw codedError(
      "INVALID_ARGUMENTS",
      "harmony.interval must be a legacy name or {degree,direction,octaveOffset?}"
    );
  }
  assertKnownKeys(interval, ["degree", "direction", "octaveOffset"], "harmony.interval");
  if (!HARMONY_INTERVAL_DEGREES.includes(interval.degree)) {
    throw codedError(
      "INVALID_ARGUMENTS",
      `harmony.interval.degree must be one of ${HARMONY_INTERVAL_DEGREES.join(", ")}`
    );
  }
  if (!HARMONY_INTERVAL_DIRECTIONS.includes(interval.direction)) {
    throw codedError(
      "INVALID_ARGUMENTS",
      `harmony.interval.direction must be ${HARMONY_INTERVAL_DIRECTIONS.join(" or ")}`
    );
  }
  const octaveOffset = interval.octaveOffset ?? 0;
  if (!Number.isSafeInteger(octaveOffset) || Math.abs(octaveOffset) > 3) {
    throw codedError("INVALID_ARGUMENTS", "harmony.interval.octaveOffset must be an integer in [-3, 3]");
  }
  return {
    degree: interval.degree,
    direction: interval.direction,
    octaveOffset,
    label: `${interval.degree}_${interval.direction}${octaveOffset !== 0 ? `_oct${octaveOffset > 0 ? "+" : ""}${octaveOffset}` : ""}`,
  };
}

// 广义音程 -> 自然音阶级步数（含八度位移）。degree N 上方 = +(N-1) 级，下方 = -(N-1) 级；
// octaveOffset 按 scale 度数回绕八度（pentatonic=5、whole-tone=6、heptatonic=7、chromatic=12）。
function intervalSteps(spec, scaleLength) {
  const signed = (spec.degree - 1) * (spec.direction === "below" ? -1 : 1);
  return signed + spec.octaveOffset * scaleLength;
}

// ---------- 小工具 ----------

function appendOnce(warnings, warning) {
  if (!warnings.some((item) => item.code === warning.code)) warnings.push(warning);
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
