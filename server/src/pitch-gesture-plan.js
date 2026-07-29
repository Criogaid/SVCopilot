import { canonicalHashHex } from "./canonical-json.js";
import { artifactReference } from "./artifact-store.js";
import { buildPlanArtifact, buildPlanContextSnapshot } from "./plan-reference.js";
import { blickAtSeconds, secondsAtBlick } from "./musical-time.js";
import { buildApplyEnvelope } from "./plan-envelope.js";
import { ServiceTiming } from "./service-timing.js";
import { analyzeVocalEventSequence } from "./vocal-event-semantics.js";

// sv_plan_pitch_gesture —— 把"起音上滑 / 句尾下坠 / 转音 / 颤音"等音乐意图编译成
// PitchControlCurve 的 add 操作（主计划 P1-C Phase 3，目标写面 sv_patch_pitch_controls）。
//
// 关键契约（与 sv_plan_expression 一致，绝不放宽）：
// - 纯内存只读：只读取 sv_snapshot_range 已存的音符指纹 / tempo / quarter 数据，不进入
//   ExecutionCoordinator、绝不写宿主。真正的写入由调用方把 apply 交给
//   sv_patch_pitch_controls 事务核（预检 / Undo / 读回 / 补偿全部复用，本模块零 mutation）。
// - 确定性：同一 context 数据 + 同一请求 → 逐字节相同的 plan（planId 为内容哈希）。
// - 单位纪律（GOAL §5.4）：意图可用秒或音符比例表达，经 TimeAxis 转成整数 BLICK；
//   PitchControl 的 pitch 一律是 group-relative semitone（绝不与 pitchDelta 的 cents 混用），
//   请求用 depthSemitone 等带单位后缀的字段，从 schema 上杜绝量纲歧义。
// - 有界不超调：所有包络/振荡都被 clamp 到深度范围，不用任何名义单调实际过冲的三次插值。
// - 诚实边界：只生成 add；不删除/覆盖不属于本计划的既有 PitchControl（那是另一个需显式
//   fingerprint 的事务）。anchor 音高默认取音符目标音（group-relative），调用方可覆盖；
//   它不会从宿主 computed pitch 推断（那是 sv_bake_computed_pitch 的职责）。能否"更好听"
//   永远是 human_only。

export const PITCH_GESTURE_DEFAULTS = Object.freeze({
  specialEventPolicy: "warn_and_skip",
  constraints: Object.freeze({
    maxAbsDepthSemitone: 2,
    maxTotalPoints: 600,
    maxPointsPerCurve: 400,
    minVibratoQuarter: 1.5,
  }),
  sampling: Object.freeze({
    pointsPerQuarter: 8,
    vibratoPointsPerCycle: 8,
  }),
});
export const PITCH_GESTURE_TYPES = Object.freeze(["transition", "attack", "release", "vibrato"]);
export const PITCH_GESTURE_SHAPES = Object.freeze(["linear", "smoothstep", "cosine"]);
export const PITCH_GESTURE_DIRECTIONS = Object.freeze(["up", "down", "auto"]);
const MAX_GESTURES = 32;

const PROVENANCE = Object.freeze({
  planner: "deterministic_pitch_gesture_compiler",
  anchorsBasis: "observed_snapshot_fingerprints",
  interpolation: "bounded_no_overshoot",
  hostWriteSurfaces: Object.freeze(["pitchControl"]),
  specialLyrics: "official_v2_manual_enter_notes",
  perception: "human_only",
});

export class PitchGesturePlanService {
  constructor({ store, now = () => Date.now(), artifactStore = null, sessionId = null } = {}) {
    if (!store) throw new Error("PitchGesturePlanService requires the shared SnapshotStore");
    this.store = store;
    this.now = now;
    this.artifactStore = artifactStore;
    this.sessionId = sessionId;
  }

  async plan(request = {}) {
    const timer = new ServiceTiming({ now: this.now, phaseNames: ["loadMs", "buildMs", "compileMs"] });
    const input = normalizePlanRequest(request);
    timer.requestCoordinator();
    const warnings = [];
    const loaded = await timer.measure("loadMs", async () => resolvePlanSource(this.store, input));
    const selection = selectGesturesForPolicy(input.gestures, loaded, input, warnings);
    const gestures = await timer.measure("buildMs", async () =>
      selection.included.map(({ gesture, requestIndex }) =>
        instantiateGesture(gesture, loaded, input, warnings, requestIndex)
      )
    );
    const compiled = await timer.measure("compileMs", async () =>
      compileOperations(gestures, loaded, input, warnings)
    );
    return buildPlanResponse(
      loaded,
      input,
      gestures,
      compiled,
      selection,
      warnings,
      timer.finish(),
      this.artifactStore,
      this.sessionId
    );
  }
}

// ---------- 上下文与音符解析（纯数据） ----------

function resolvePlanSource(store, input) {
  const stored = store.get(input.contextId);
  if (!stored) {
    throw codedError("UNKNOWN_CONTEXT", "contextId not found or expired; re-run sv_snapshot_range");
  }
  if (stored.context?.kind !== "range") {
    throw codedError(
      "INVALID_CONTEXT",
      'sv_plan_pitch_gesture needs a range context from sv_snapshot_range with include ["notes"]'
    );
  }
  const occurrences = Array.isArray(stored.context.occurrences) ? stored.context.occurrences : [];
  const candidates = occurrences.filter(
    (item) => Array.isArray(item.noteFingerprints) && item.noteFingerprints.length > 0
  );
  // noteId 前缀（去掉 :n:Z）即 occurrenceId；同一计划的所有 noteId 必须同属一个 occurrence。
  const derived = new Set();
  for (const noteId of input.referencedNoteIds) {
    const cut = noteId.lastIndexOf(":n:");
    if (cut > 0) derived.add(noteId.slice(0, cut));
  }
  if (derived.size > 1) {
    throw codedError("INVALID_NOTE_ID", "all noteIds in one plan must belong to the same range occurrence");
  }
  const derivedId = derived.size === 1 ? derived.values().next().value : undefined;
  if (input.occurrenceId !== undefined && derivedId !== undefined && input.occurrenceId !== derivedId) {
    throw codedError("INVALID_NOTE_ID", "noteIds belong to a different occurrence than occurrenceId");
  }
  const wantedId = input.occurrenceId ?? derivedId;
  let occurrence = null;
  if (wantedId !== undefined) {
    occurrence = occurrences.find((item) => item.occurrenceId === wantedId) ?? null;
    if (!occurrence) {
      throw codedError("UNKNOWN_OCCURRENCE", "occurrenceId is not part of the supplied contextId");
    }
  } else if (candidates.length === 1) {
    occurrence = candidates[0];
  } else if (candidates.length === 0) {
    throw codedError(
      "NOTES_NOT_CAPTURED",
      'sv_plan_pitch_gesture needs note fingerprints; re-run sv_snapshot_range with include ["notes"]'
    );
  } else {
    const error = codedError(
      "AMBIGUOUS_CONTEXT",
      "range context has multiple occurrences with notes; provide occurrenceId or noteIds"
    );
    error.candidateOccurrences = candidates.map((item) => item.occurrenceId);
    error.details = { candidateOccurrences: error.candidateOccurrences };
    throw error;
  }
  if (!Array.isArray(occurrence.noteFingerprints) || occurrence.noteFingerprints.length === 0) {
    throw codedError(
      "NOTES_NOT_CAPTURED",
      'the selected occurrence has no note fingerprints; re-run sv_snapshot_range with include ["notes"]'
    );
  }
  const quarterBlick = stored.context.quarterBlick;
  if (!Number.isSafeInteger(quarterBlick) || quarterBlick <= 0) {
    throw codedError("INVALID_CONTEXT", "context is missing a usable SV.QUARTER timebase");
  }
  const timeOffset = occurrence.timeOffsetBlick ?? 0;
  // group-local 坐标：PitchControl 的 position 是相对 NoteGroup 的（不含 occurrence timeOffset）。
  const notes = [...occurrence.noteFingerprints]
    .map((fingerprint) => ({
      noteId: fingerprint.noteId,
      indexInGroup: fingerprint.indexInGroup,
      lyrics: fingerprint.lyrics,
      targetSemitone: fingerprint.pitch + (fingerprint.detuneCents ?? 0) / 100,
      localOnsetBlick: fingerprint.onsetBlick,
      localEndBlick: fingerprint.onsetBlick + fingerprint.durationBlick,
      durationBlick: fingerprint.durationBlick,
    }))
    .sort((left, right) => left.localOnsetBlick - right.localOnsetBlick);
  const noteById = new Map(notes.map((note) => [note.noteId, note]));
  const semantics = analyzeVocalEventSequence(notes);
  const semanticEvents = semantics.events;
  const eventByNoteId = new Map(semanticEvents.map((event) => [event.noteId, event]));
  return {
    stored,
    occurrence,
    notes,
    noteById,
    eventByNoteId,
    semanticIssues: semantics.issues,
    quarterBlick,
    tempoMarks: stored.context.tempoMarks ?? [],
    timeOffsetBlick: timeOffset,
  };
}

function requireNote(loaded, noteId, label) {
  const note = loaded.noteById.get(noteId);
  if (!note) {
    throw codedError("UNKNOWN_NOTE_ID", `${label} is not part of the resolved occurrence: ${noteId}`);
  }
  return note;
}

function selectGesturesForPolicy(gestures, loaded, input, warnings) {
  const included = [];
  const excluded = [];
  const referencedNoteIds = new Set(input.referencedNoteIds);
  for (const issue of loaded.semanticIssues) {
    if ((issue.noteIds ?? []).some((noteId) => referencedNoteIds.has(noteId))) {
      warnings.push({ ...issue });
    }
  }
  for (let requestIndex = 0; requestIndex < gestures.length; requestIndex += 1) {
    const gesture = gestures[requestIndex];
    const gestureId = `g${requestIndex}-${gesture.type}`;
    const targetedEvents = gestureNoteIds(gesture)
      .map((noteId) => loaded.eventByNoteId.get(noteId))
      .filter(Boolean);
    const nonMelodic = targetedEvents.filter((event) => !event.melodicEligible);
    if (nonMelodic.length === 0 || input.specialEventPolicy === "include") {
      included.push({ gesture, requestIndex });
      continue;
    }
    const first = nonMelodic[0];
    if (input.specialEventPolicy === "error") {
      const error = codedError(
        "NON_MELODIC_SPECIAL_EVENT_TARGETED",
        `${gestureId} targets a non-melodic special lyric event`
      );
      error.details = {
        gestureId,
        noteId: first.noteId,
        semanticRole: first.semanticRole,
        lyrics: first.classification.rawLyrics,
        evidence: first.semanticEvidence,
      };
      throw error;
    }
    excluded.push({ gestureId, events: nonMelodic });
    for (const event of nonMelodic) {
      warnings.push({
        code: "NON_MELODIC_SPECIAL_EVENT_SKIPPED",
        gestureId,
        noteId: event.noteId,
        semanticRole: event.semanticRole,
        lyrics: event.classification.rawLyrics,
        evidence: event.semanticEvidence,
        message: "Skipped pitch planning for a non-melodic special lyric event.",
      });
    }
  }

  const uniqueEvents = new Map();
  for (const item of excluded) {
    for (const event of item.events) uniqueEvents.set(event.noteId, event);
  }
  const byRole = Object.create(null);
  for (const event of uniqueEvents.values()) {
    byRole[event.semanticRole] = (byRole[event.semanticRole] ?? 0) + 1;
  }
  return {
    included,
    skippedGestureCount: excluded.length,
    excludedEvents: {
      count: uniqueEvents.size,
      byRole,
    },
  };
}

function gestureNoteIds(gesture) {
  return ["noteId", "fromNoteId", "toNoteId"]
    .map((key) => gesture[key])
    .filter((noteId) => typeof noteId === "string");
}

// ---------- 时间量解析：秒 / 音符比例 / quarter，统一成整数 BLICK ----------

// seconds → blick 走 TimeAxis（tempo map）。缺 tempo 即 TEMPO_MAP_MISSING（可改 quarter/noteRatio）。
function secondsToBlick(loaded, seconds, label) {
  const reference = loaded.notes[0] ? loaded.notes[0].localOnsetBlick + loaded.timeOffsetBlick : loaded.timeOffsetBlick;
  const referenceSeconds = secondsAtBlick(loaded.tempoMarks, loaded.quarterBlick, reference);
  if (referenceSeconds === null) {
    throw codedError("TEMPO_MAP_MISSING", `${label}: seconds need a usable tempo map; use quarters or noteRatio`);
  }
  const blick = blickAtSeconds(loaded.tempoMarks, loaded.quarterBlick, referenceSeconds + seconds);
  if (blick === null) {
    throw codedError("TEMPO_MAP_MISSING", `${label}: seconds need a usable tempo map; use quarters or noteRatio`);
  }
  return Math.max(1, Math.round(blick - reference));
}

function quartersToBlick(quarters, quarterBlick) {
  return Math.max(1, Math.round(quarters * quarterBlick));
}

// duration 解析：{seconds|quarters|noteRatio} 之一 → 整数 BLICK（按 note 比例时相对 note 时值）。
function resolveDuration(loaded, duration, note, fallbackQuarters, label) {
  if (duration === undefined || duration === null) return quartersToBlick(fallbackQuarters, loaded.quarterBlick);
  const kinds = ["seconds", "quarters", "noteRatio"].filter((key) => duration[key] !== undefined);
  if (kinds.length !== 1) {
    throw codedError("INVALID_ARGUMENTS", `${label} must specify exactly one of seconds/quarters/noteRatio`);
  }
  if (duration.seconds !== undefined) return secondsToBlick(loaded, duration.seconds, label);
  if (duration.quarters !== undefined) return quartersToBlick(duration.quarters, loaded.quarterBlick);
  const ratio = duration.noteRatio;
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 1) {
    throw codedError("INVALID_ARGUMENTS", `${label}.noteRatio must be in (0, 1]`);
  }
  return Math.max(1, Math.round(note.durationBlick * ratio));
}

// ---------- 音高变化构建（全部 group-local 坐标） ----------

function instantiateGesture(gesture, loaded, input, warnings, index) {
  const meta = { gestureId: `g${index}-${gesture.type}`, source: "explicit" };
  switch (gesture.type) {
    case "transition":
      return instantiateTransition(gesture, loaded, input, meta);
    case "attack":
      return instantiateAttack(gesture, loaded, input, meta);
    case "release":
      return instantiateRelease(gesture, loaded, input, meta);
    case "vibrato":
      return instantiateVibrato(gesture, loaded, input, meta, warnings);
    default:
      throw codedError("INVALID_ARGUMENTS", `unknown gesture type: ${String(gesture.type)}`);
  }
}

// 每种音高变化最终产出一个 anchor 相对坐标系下的采样曲线定义：
// { anchorLocalBlick, anchorSemitone, spanFromBlick, spanToBlick, evaluate(blick)->semitoneOffset,
//   samplePositions()->[blick] }。evaluate 的值被保证落在 [-depth, depth]（有界不超调）。

function instantiateTransition(gesture, loaded, input, meta) {
  const fromNote = requireNote(loaded, gesture.fromNoteId, `${meta.gestureId}.fromNoteId`);
  const toNote = requireNote(loaded, gesture.toNoteId, `${meta.gestureId}.toNoteId`);
  if (toNote.localOnsetBlick !== fromNote.localEndBlick) {
    throw codedError(
      "TRANSITION_NOT_ADJACENT",
      `${meta.gestureId}: transition requires adjacent notes without a rest between them`
    );
  }
  const interval = toNote.targetSemitone - fromNote.targetSemitone;
  if (interval === 0) {
    throw codedError("INVALID_ARGUMENTS", `${meta.gestureId}: transition between equal pitches has no effect`);
  }
  const widthBlick = resolveDuration(loaded, gesture.width, fromNote, 0.2, `${meta.gestureId}.width`);
  const halfBefore = Math.min(Math.floor(widthBlick / 2), Math.floor(fromNote.durationBlick / 2));
  const halfAfter = Math.min(widthBlick - halfBefore, Math.floor(toNote.durationBlick / 2));
  const boundary = toNote.localOnsetBlick;
  const from = boundary - halfBefore;
  const to = boundary + halfAfter;
  const shape = gesture.shape ?? "smoothstep";
  // 深度 = 音程（默认）或显式 depthSemitone；按 constraints 上限 clamp 并记 warning。
  const requestedDepth = gesture.depthSemitone ?? Math.abs(interval);
  const depth = clampDepth(requestedDepth, input.constraints, meta, gesture);
  const direction = Math.sign(interval);
  return {
    ...meta,
    type: "transition",
    noteIds: [fromNote.noteId, toNote.noteId],
    anchorLocalBlick: boundary,
    anchorSemitone: gesture.anchorSemitone ?? toNote.targetSemitone,
    spanFromBlick: from,
    spanToBlick: to,
    params: {
      intervalSemitone: interval,
      depthSemitone: depth,
      widthBlick: halfBefore + halfAfter,
      shape,
      clamped: requestedDepth > depth,
    },
    evaluate: (blick) => {
      // anchor 位于目标音：从 source 侧的 -/+depth 平滑收敛到目标音 0，绝不越过目标。
      const u = clamp01((blick - from) / Math.max(1, to - from));
      return direction * depth * (shapeCurve(shape, u) - 1);
    },
    samplePositions: () => linearPositions(from, to, sampleCount(halfBefore + halfAfter, loaded.quarterBlick, input.sampling)),
  };
}

function instantiateAttack(gesture, loaded, input, meta) {
  const note = requireNote(loaded, gesture.noteId, `${meta.gestureId}.noteId`);
  const requestedDepth = gesture.depthSemitone ?? 0.3;
  const depth = clampDepth(requestedDepth, input.constraints, meta, gesture);
  const direction = gesture.direction ?? "up";
  if (direction === "auto") {
    throw codedError("INVALID_ARGUMENTS", `${meta.gestureId}.direction "auto" is only valid for release`);
  }
  const sign = direction === "up" ? -1 : 1; // 起音上滑 = 从下方滑入；下滑 = 从上方。
  const lengthBlick = Math.min(
    resolveDuration(loaded, gesture.length, note, 0.2, `${meta.gestureId}.length`),
    note.durationBlick
  );
  const from = note.localOnsetBlick;
  const to = note.localOnsetBlick + lengthBlick;
  const shape = gesture.shape ?? "smoothstep";
  return {
    ...meta,
    type: "attack",
    noteIds: [note.noteId],
    anchorLocalBlick: from,
    anchorSemitone: gesture.anchorSemitone ?? note.targetSemitone,
    spanFromBlick: from,
    spanToBlick: to,
    params: { depthSemitone: depth, lengthBlick, direction, shape, clamped: requestedDepth > depth },
    evaluate: (blick) => {
      const u = clamp01((blick - from) / Math.max(1, to - from));
      // 从 sign*depth 回到 0（u=0 时偏移最大，u=1 时归 0）。
      return sign * depth * (1 - shapeCurve(shape, u));
    },
    samplePositions: () => linearPositions(from, to, sampleCount(lengthBlick, loaded.quarterBlick, input.sampling)),
  };
}

function instantiateRelease(gesture, loaded, input, meta) {
  const note = requireNote(loaded, gesture.noteId, `${meta.gestureId}.noteId`);
  const requestedDepth = gesture.depthSemitone ?? 0.4;
  const depth = clampDepth(requestedDepth, input.constraints, meta, gesture);
  let direction = gesture.direction ?? "down";
  if (direction === "auto") {
    // `br` 和无效 continuation 的名义 MIDI 不是旋律证据；遇到这类边界保持默认下坠。
    const next = loaded.notes[loaded.notes.findIndex((candidate) => candidate.noteId === note.noteId) + 1];
    const nextEvent = next ? loaded.eventByNoteId.get(next.noteId) : null;
    direction =
      next && nextEvent?.melodicEligible && next.targetSemitone > note.targetSemitone
        ? "up"
        : "down";
  }
  const sign = direction === "down" ? -1 : 1;
  const lengthBlick = Math.min(
    resolveDuration(loaded, gesture.length, note, 0.3, `${meta.gestureId}.length`),
    note.durationBlick
  );
  const from = note.localEndBlick - lengthBlick;
  const to = note.localEndBlick;
  const shape = gesture.shape ?? "smoothstep";
  return {
    ...meta,
    type: "release",
    noteIds: [note.noteId],
    anchorLocalBlick: to,
    anchorSemitone: gesture.anchorSemitone ?? note.targetSemitone,
    spanFromBlick: from,
    spanToBlick: to,
    params: { depthSemitone: depth, lengthBlick, direction, shape, clamped: requestedDepth > depth },
    evaluate: (blick) => {
      const u = clamp01((blick - from) / Math.max(1, to - from));
      // 从 0 走到 sign*depth（句尾下坠/上扬）。
      return sign * depth * shapeCurve(shape, u);
    },
    samplePositions: () => linearPositions(from, to, sampleCount(lengthBlick, loaded.quarterBlick, input.sampling)),
  };
}

function instantiateVibrato(gesture, loaded, input, meta, warnings) {
  const note = requireNote(loaded, gesture.noteId, `${meta.gestureId}.noteId`);
  if (note.durationBlick < quartersToBlick(input.constraints.minVibratoQuarter, loaded.quarterBlick)) {
    throw codedError(
      "CONSTRAINT_VIOLATION",
      `${meta.gestureId}: note is shorter than ${input.constraints.minVibratoQuarter} quarters; vibrato needs a longer sustain`
    );
  }
  const requestedDepth = gesture.depthSemitone ?? 0.3;
  const depth = clampDepth(requestedDepth, input.constraints, meta, gesture);
  const rateHz = gesture.rateHz ?? 5.5;
  const phase = gesture.phase ?? 0;
  // start/fadeIn/fadeOut 以秒表达（经 tempo map）；这是颤音的自然参数域。
  const absOnset = note.localOnsetBlick + loaded.timeOffsetBlick;
  const absEnd = note.localEndBlick + loaded.timeOffsetBlick;
  const onsetSeconds = secondsAtBlick(loaded.tempoMarks, loaded.quarterBlick, absOnset);
  const endSeconds = secondsAtBlick(loaded.tempoMarks, loaded.quarterBlick, absEnd);
  if (onsetSeconds === null || endSeconds === null) {
    throw codedError("TEMPO_MAP_MISSING", `${meta.gestureId}: vibrato needs a usable tempo map for seconds`);
  }
  const startSeconds = onsetSeconds + (gesture.startSeconds ?? 0.3);
  const fadeInSeconds = Math.max(0, gesture.fadeInSeconds ?? 0.3);
  const fadeOutSeconds = Math.max(0, gesture.fadeOutSeconds ?? 0.2);
  const spanSeconds = endSeconds - startSeconds;
  const minSpanSeconds = Math.max(2 / rateHz, fadeInSeconds + fadeOutSeconds);
  if (spanSeconds < minSpanSeconds) {
    throw codedError(
      "VIBRATO_SPAN_TOO_SHORT",
      `${meta.gestureId}: the sustain after startSeconds is too short for ${rateHz} Hz vibrato (needs >= ${minSpanSeconds.toFixed(3)} s)`
    );
  }
  const fromAbs = blickAtSeconds(loaded.tempoMarks, loaded.quarterBlick, startSeconds);
  if (fromAbs === null) {
    throw codedError("TEMPO_MAP_MISSING", `${meta.gestureId}: cannot map vibrato start to blicks`);
  }
  const from = Math.round(fromAbs) - loaded.timeOffsetBlick;
  const to = note.localEndBlick;
  const envelope = (seconds) => {
    const sinceStart = seconds - startSeconds;
    const untilEnd = endSeconds - seconds;
    let value = 1;
    if (fadeInSeconds > 0) value *= smoothstep(clamp01(sinceStart / fadeInSeconds));
    if (fadeOutSeconds > 0) value *= smoothstep(clamp01(untilEnd / fadeOutSeconds));
    return value;
  };
  return {
    ...meta,
    type: "vibrato",
    noteIds: [note.noteId],
    anchorLocalBlick: from,
    anchorSemitone: gesture.anchorSemitone ?? note.targetSemitone,
    spanFromBlick: from,
    spanToBlick: to,
    params: {
      depthSemitone: depth,
      rateHz,
      phase,
      startSeconds: gesture.startSeconds ?? 0.3,
      fadeInSeconds,
      fadeOutSeconds,
      clamped: requestedDepth > depth,
    },
    evaluate: (blick) => {
      const seconds = secondsAtBlick(loaded.tempoMarks, loaded.quarterBlick, blick + loaded.timeOffsetBlick);
      if (seconds === null || seconds < startSeconds || seconds > endSeconds) return 0;
      // 有界正弦：|value| <= depth * envelope <= depth，绝不超调。
      return depth * envelope(seconds) * Math.sin(2 * Math.PI * rateHz * (seconds - startSeconds) + phase);
    },
    samplePositions: () => {
      const step = 1 / (rateHz * input.sampling.vibratoPointsPerCycle);
      const positions = [];
      for (let seconds = startSeconds; seconds <= endSeconds; seconds += step) {
        const blick = blickAtSeconds(loaded.tempoMarks, loaded.quarterBlick, seconds);
        if (blick !== null) positions.push(Math.round(blick) - loaded.timeOffsetBlick);
      }
      positions.push(to);
      return positions;
    },
  };
}

function clampDepth(requestedDepth, constraints, meta, gesture) {
  void meta;
  void gesture;
  return Math.min(Math.abs(requestedDepth), constraints.maxAbsDepthSemitone);
}

// 有界形状曲线：u∈[0,1] → [0,1]，单调不超调。cosine 是 (1-cos(πu))/2 的 ease-in-out。
function shapeCurve(shape, u) {
  const x = clamp01(u);
  switch (shape) {
    case "linear":
      return x;
    case "cosine":
      return (1 - Math.cos(Math.PI * x)) / 2;
    case "smoothstep":
    default:
      return smoothstep(x);
  }
}

// ---------- 编译：采样、组装 curve、clamp、预算 ----------

function compileOperations(gestures, loaded, input, warnings) {
  const operations = [];
  let totalPoints = 0;
  let clampedCount = 0;
  for (const gesture of gestures) {
    const positions = [...new Set(gesture.samplePositions())]
      .filter((blick) => Number.isSafeInteger(blick))
      .sort((left, right) => left - right);
    if (positions.length < 2) {
      throw codedError(
        "PLAN_TOO_SPARSE",
        `${gesture.gestureId}: the gesture resolves to fewer than 2 sample points; widen its span`
      );
    }
    const points = positions.map((blick) => {
      const value = gesture.evaluate(blick);
      // 数值保险：包络理论上有界，这里仍按 constraints 硬 clamp 并计数，杜绝任何浮点越界。
      const clamped = Math.max(
        -input.constraints.maxAbsDepthSemitone,
        Math.min(input.constraints.maxAbsDepthSemitone, value)
      );
      if (clamped !== value) clampedCount += 1;
      return {
        timeFromAnchorBlick: blick - gesture.anchorLocalBlick,
        pitchFromAnchorSemitone: clamped,
      };
    });
    // 去重（采样网格在 tempo 非线性处可能撞点）：anchor 相对时间必须严格递增。
    const deduped = [];
    for (const point of points) {
      if (deduped.length === 0 || point.timeFromAnchorBlick > deduped[deduped.length - 1].timeFromAnchorBlick) {
        deduped.push(point);
      }
    }
    if (deduped.length > input.constraints.maxPointsPerCurve) {
      const error = codedError(
        "PLAN_TOO_DENSE",
        `${gesture.gestureId}: one curve needs ${deduped.length} points, above constraints.maxPointsPerCurve ${input.constraints.maxPointsPerCurve}`
      );
      error.details = { points: deduped.length, maxPointsPerCurve: input.constraints.maxPointsPerCurve };
      throw error;
    }
    totalPoints += deduped.length;
    operations.push({
      gestureId: gesture.gestureId,
      type: gesture.type,
      noteIds: gesture.noteIds,
      control: {
        kind: "curve",
        anchorPositionBlick: gesture.anchorLocalBlick,
        anchorPitchSemitone: gesture.anchorSemitone,
        points: deduped,
      },
      params: gesture.params,
      applyOperation: {
        op: "add",
        control: {
          kind: "curve",
          anchorPositionBlick: gesture.anchorLocalBlick,
          anchorPitchSemitone: gesture.anchorSemitone,
          points: deduped,
          generator: "sv_plan_pitch_gesture",
        },
      },
    });
    if (gesture.params?.clamped) {
      appendOnce(warnings, {
        code: "CONSTRAINT_CLAMPED",
        message: "one or more gesture depths were clamped to constraints.maxAbsDepthSemitone.",
      });
    }
  }
  operations.sort(
    (left, right) =>
      left.control.anchorPositionBlick - right.control.anchorPositionBlick ||
      left.gestureId.localeCompare(right.gestureId)
  );
  if (totalPoints > input.constraints.maxTotalPoints) {
    const error = codedError(
      "PLAN_TOO_DENSE",
      `the plan needs ${totalPoints} points but constraints.maxTotalPoints is ${input.constraints.maxTotalPoints}; reduce gestures/sampling density`
    );
    error.details = { totalPoints, maxTotalPoints: input.constraints.maxTotalPoints };
    throw error;
  }
  return { operations, totalPoints, clampedCount };
}

// ---------- 响应组装 ----------

function buildPlanResponse(loaded, input, gestures, compiled, selection, warnings, timings, artifactStore, sessionId) {
  const sharedTargetOccurrences = loaded.occurrence.sharedTargetOccurrences ?? [];
  const requiresSharedTargetConfirmation = sharedTargetOccurrences.length > 1;
  const target = {
    contextId: loaded.stored.contextId,
    occurrenceId: loaded.occurrence.occurrenceId,
    ...(loaded.occurrence.targetGroupUuid ? { expectedGroupUuid: loaded.occurrence.targetGroupUuid } : {}),
    // 曲线是 group-local 坐标；整个 reference 被 setTimeOffset/setPitchOffset 移动时快照偏移即
    // 过期——交给事务核锁住，偏移变化即 STALE_CONTEXT。
    expectedTimeOffsetBlick: loaded.timeOffsetBlick,
    ...(Number.isFinite(loaded.occurrence.pitchOffsetSemitone)
      ? { expectedPitchOffsetSemitone: loaded.occurrence.pitchOffsetSemitone }
      : {}),
  };
  // 音高变化锚点音符的原始指纹：随 apply 交给事务核，写入前逐条 verifyAnchoredNote。
  const fingerprintById = new Map(
    (loaded.occurrence.noteFingerprints ?? []).map((fingerprint) => [fingerprint.noteId, fingerprint])
  );
  const anchorNoteIds = new Set();
  for (const gesture of gestures) for (const noteId of gesture.noteIds) anchorNoteIds.add(noteId);
  const expectedNotes = [...anchorNoteIds]
    .map((noteId) => fingerprintById.get(noteId))
    .filter(Boolean)
    .map((fingerprint) => ({
      noteId: fingerprint.noteId,
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

  const hasOperations = compiled.operations.length > 0;
  const applyArguments = hasOperations
    ? {
        contextId: loaded.stored.contextId,
        occurrenceId: loaded.occurrence.occurrenceId,
        target: {
          expectedGroupUuid: target.expectedGroupUuid,
          expectedTimeOffsetBlick: target.expectedTimeOffsetBlick,
          ...(target.expectedPitchOffsetSemitone !== undefined
            ? { expectedPitchOffsetSemitone: target.expectedPitchOffsetSemitone }
            : {}),
          ...(expectedNotes.length > 0 ? { expectedNotes } : {}),
        },
        operations: compiled.operations.map((operation) => operation.applyOperation),
        dryRun: true,
        atomic: true,
      }
    : null;
  const applyRequests = applyArguments
    ? [{ tool: "sv_patch_pitch_controls", arguments: applyArguments }]
    : [];
  const planId = `plan_${canonicalHashHex({
    occurrenceId: loaded.occurrence.occurrenceId,
    targetGroupUuid: loaded.occurrence.targetGroupUuid,
    specialEventPolicy: input.specialEventPolicy,
    requestedGestures: input.gestures,
    operations: compiled.operations.map((operation) => operation.control),
  }).slice(0, 16)}`;

  const publicGestures = gestures.map((gesture) => ({
    gestureId: gesture.gestureId,
    type: gesture.type,
    noteIds: gesture.noteIds,
    anchor: {
      groupLocalBlick: gesture.anchorLocalBlick,
      occurrenceAbsoluteBlick: gesture.anchorLocalBlick + loaded.timeOffsetBlick,
      groupRelativeSemitone: gesture.anchorSemitone,
    },
    span: {
      localFromBlick: gesture.spanFromBlick,
      localToBlick: gesture.spanToBlick,
      absoluteFromBlick: gesture.spanFromBlick + loaded.timeOffsetBlick,
      absoluteToBlick: gesture.spanToBlick + loaded.timeOffsetBlick,
    },
    params: gesture.params,
  }));
  const operationsMeta = compiled.operations.map((operation) => ({
    gestureId: operation.gestureId,
    type: operation.type,
    control: input.responseMode === "verbose" ? operation.control : {
      kind: "curve",
      anchorPositionBlick: operation.control.anchorPositionBlick,
      anchorPitchSemitone: operation.control.anchorPitchSemitone,
      pointCount: operation.control.points.length,
    },
    pointCount: operation.control.points.length,
  }));
  const checklist = [
    "Review every gesture's anchor pitch and depth before applying; the anchor defaults to the note target pitch (group-relative semitone).",
    "This plan only ADDS new owned curves; it never deletes or overwrites existing pitch controls (that is a separate transaction needing explicit fingerprints).",
    "Apply through apply.arguments (sv_patch_pitch_controls) with dryRun:true first, then commit the identical arguments.",
    "Pitch values are group-relative semitones, NOT cents; do not mix with pitchDelta automation.",
    "Musical quality is human-only: audition the result; sv_compare_computed_pitch can verify objective pitch changes.",
  ];
  if (requiresSharedTargetConfirmation) {
    checklist.push(
      "The target NoteGroup is shared by multiple occurrences; commit requires target.allowSharedTargetMutation:true and affects every occurrence."
    );
  }

  let planArtifactRef = null;
  if (input.usePlanRef && artifactStore && sessionId && hasOperations) {
    try {
      const { payload } = buildPlanArtifact({
          targetTool: "sv_patch_pitch_controls",
          mutationRequest: applyRequests[0].arguments,
          targetGroupUuid: loaded.occurrence.targetGroupUuid,
          occurrenceId: loaded.occurrence.occurrenceId,
          expectedTimeOffsetBlick: loaded.timeOffsetBlick,
          fingerprints: { expectedNotes: applyRequests[0].arguments.target?.expectedNotes ?? [] },
          contextSnapshot: buildPlanContextSnapshot(loaded.stored, loaded.occurrence, {
            noteIds: (applyRequests[0].arguments.target?.expectedNotes ?? []).map(
              (fingerprint) => fingerprint.noteId
            ),
          }),
      });
      const planArtifact = artifactStore.seal({
        kind: "plan",
        schemaVersion: "1",
        sessionId,
        sourceEpoch: loaded.stored.epoch,
        payload,
      });
      planArtifactRef = artifactReference(planArtifact);
    } catch (error) {
      warnings.push({
        code: "ARTIFACT_SEAL_FAILED",
        message: `Failed to seal pitch gesture plan artifact: ${error.message}`,
      });
    }
  }

  const applyEnvelope = buildApplyEnvelope(hasOperations ? applyRequests : null, {
    sharedTargetConfirmationRequired: requiresSharedTargetConfirmation,
  });
  // planArtifactRef 存在时，apply.arguments 使用 planRef 而不是内联完整请求。
  if (planArtifactRef && applyEnvelope?.arguments) {
    applyEnvelope.arguments = { planRef: planArtifactRef, action: "dry_run" };
  }

  return {
    ok: true,
    status: hasOperations ? "planned" : "no_change",
    dryRun: true,
    effects: "none",
    planId,
    contextId: loaded.stored.contextId,
    occurrence: {
      occurrenceId: loaded.occurrence.occurrenceId,
      trackIndex: loaded.occurrence.trackIndex,
      groupIndex: loaded.occurrence.groupIndex,
      targetGroupUuid: loaded.occurrence.targetGroupUuid,
      timeOffsetBlick: loaded.timeOffsetBlick,
      pitchOffsetSemitone: loaded.occurrence.pitchOffsetSemitone ?? 0,
      sharedTargetOccurrences,
    },
    summary: {
      requestedGestureCount: input.gestures.length,
      gestureCount: gestures.length,
      skippedGestureCount: selection.skippedGestureCount,
      excludedEvents: selection.excludedEvents,
      operationCount: compiled.operations.length,
      totalPoints: compiled.totalPoints,
      applyCallCount: hasOperations ? 1 : 0,
      expectedUserUndoSteps: hasOperations ? 1 : 0,
      types: [...new Set(gestures.map((gesture) => gesture.type))],
    },
    ...(input.responseMode === "compact" ? {} : { gestures: publicGestures, operations: operationsMeta }),
    apply: applyEnvelope,
    ...(planArtifactRef ? {} : { applyRequests }),
    review: {
      requiresHumanAudition: true,
      requiresSharedTargetConfirmation,
      onlyAddsOwnedControls: true,
      checklist,
    },
    provenance: PROVENANCE,
    warnings,
    timings,
  };
}

// ---------- 请求校验 ----------

function normalizePlanRequest(request) {
  if (!isRecord(request)) throw codedError("INVALID_ARGUMENTS", "request must be an object");
  assertKnownKeys(
    request,
    [
      "contextId",
      "occurrenceId",
      "gestures",
      "specialEventPolicy",
      "constraints",
      "sampling",
      "responseMode",
      "usePlanRef",
    ],
    "request"
  );
  if (typeof request.contextId !== "string" || request.contextId.length === 0) {
    throw codedError("INVALID_ARGUMENTS", "contextId must be a non-empty string");
  }
  if (request.occurrenceId !== undefined && (typeof request.occurrenceId !== "string" || request.occurrenceId.length === 0)) {
    throw codedError("INVALID_ARGUMENTS", "occurrenceId must be a non-empty string when provided");
  }
  if (!Array.isArray(request.gestures) || request.gestures.length === 0) {
    throw codedError("INVALID_ARGUMENTS", "gestures must be a non-empty array");
  }
  if (request.gestures.length > MAX_GESTURES) {
    throw codedError("INVALID_ARGUMENTS", `gestures must contain at most ${MAX_GESTURES} items`);
  }
  const responseMode = request.responseMode ?? "standard";
  if (!["compact", "standard", "verbose"].includes(responseMode)) {
    throw codedError("INVALID_ARGUMENTS", "responseMode must be compact, standard, or verbose");
  }
  const specialEventPolicy =
    request.specialEventPolicy ?? PITCH_GESTURE_DEFAULTS.specialEventPolicy;
  if (!["warn_and_skip", "include", "error"].includes(specialEventPolicy)) {
    throw codedError(
      "INVALID_ARGUMENTS",
      "specialEventPolicy must be warn_and_skip, include, or error"
    );
  }
  const gestures = request.gestures.map((gesture, index) => normalizeGesture(gesture, index));
  const referencedNoteIds = [];
  for (const gesture of gestures) {
    for (const key of ["noteId", "fromNoteId", "toNoteId"]) {
      if (typeof gesture[key] === "string") referencedNoteIds.push(gesture[key]);
    }
  }
  return {
    contextId: request.contextId,
    occurrenceId: request.occurrenceId,
    gestures,
    specialEventPolicy,
    constraints: normalizeConstraints(request.constraints),
    sampling: normalizeSampling(request.sampling),
    responseMode,
    referencedNoteIds,
    usePlanRef: request.usePlanRef !== false,
  };
}

function normalizeGesture(value, index) {
  const label = `gestures[${index}]`;
  if (!isRecord(value)) throw codedError("INVALID_ARGUMENTS", `${label} must be an object`);
  if (!PITCH_GESTURE_TYPES.includes(value.type)) {
    throw codedError("INVALID_ARGUMENTS", `${label}.type must be one of ${PITCH_GESTURE_TYPES.join(", ")}`);
  }
  switch (value.type) {
    case "transition":
      assertKnownKeys(value, ["type", "fromNoteId", "toNoteId", "width", "depthSemitone", "shape", "anchorSemitone"], label);
      requireNoteIdField(value, "fromNoteId", label);
      requireNoteIdField(value, "toNoteId", label);
      normalizeDurationField(value.width, `${label}.width`);
      checkNumber(value.depthSemitone, 0.01, 24, `${label}.depthSemitone`);
      checkEnum(value.shape, PITCH_GESTURE_SHAPES, `${label}.shape`);
      checkNumber(value.anchorSemitone, 0, 127, `${label}.anchorSemitone`);
      return { ...value };
    case "attack":
    case "release":
      assertKnownKeys(value, ["type", "noteId", "direction", "length", "depthSemitone", "shape", "anchorSemitone"], label);
      requireNoteIdField(value, "noteId", label);
      checkEnum(value.direction, PITCH_GESTURE_DIRECTIONS, `${label}.direction`);
      normalizeDurationField(value.length, `${label}.length`);
      checkNumber(value.depthSemitone, 0.01, 24, `${label}.depthSemitone`);
      checkEnum(value.shape, PITCH_GESTURE_SHAPES, `${label}.shape`);
      checkNumber(value.anchorSemitone, 0, 127, `${label}.anchorSemitone`);
      return { ...value };
    case "vibrato":
      assertKnownKeys(
        value,
        ["type", "noteId", "startSeconds", "fadeInSeconds", "fadeOutSeconds", "rateHz", "depthSemitone", "phase", "anchorSemitone"],
        label
      );
      requireNoteIdField(value, "noteId", label);
      checkNumber(value.startSeconds, 0, 30, `${label}.startSeconds`);
      checkNumber(value.fadeInSeconds, 0, 30, `${label}.fadeInSeconds`);
      checkNumber(value.fadeOutSeconds, 0, 30, `${label}.fadeOutSeconds`);
      checkNumber(value.rateHz, 0.5, 12, `${label}.rateHz`);
      checkNumber(value.depthSemitone, 0.01, 24, `${label}.depthSemitone`);
      checkNumber(value.phase, -Math.PI * 2, Math.PI * 2, `${label}.phase`);
      checkNumber(value.anchorSemitone, 0, 127, `${label}.anchorSemitone`);
      return { ...value };
    default:
      throw codedError("INVALID_ARGUMENTS", `${label}.type is unsupported`);
  }
}

function normalizeDurationField(value, label) {
  if (value === undefined) return;
  if (!isRecord(value)) throw codedError("INVALID_ARGUMENTS", `${label} must be an object`);
  assertKnownKeys(value, ["seconds", "quarters", "noteRatio"], label);
  const kinds = ["seconds", "quarters", "noteRatio"].filter((key) => value[key] !== undefined);
  if (kinds.length !== 1) {
    throw codedError("INVALID_ARGUMENTS", `${label} must specify exactly one of seconds/quarters/noteRatio`);
  }
  if (value.seconds !== undefined) checkNumber(value.seconds, 0.001, 30, `${label}.seconds`);
  if (value.quarters !== undefined) checkNumber(value.quarters, 0.01, 16, `${label}.quarters`);
  if (value.noteRatio !== undefined) checkNumber(value.noteRatio, 0.01, 1, `${label}.noteRatio`);
}

function normalizeConstraints(value) {
  const defaults = PITCH_GESTURE_DEFAULTS.constraints;
  if (value === undefined) return { ...defaults };
  if (!isRecord(value)) throw codedError("INVALID_ARGUMENTS", "constraints must be an object");
  assertKnownKeys(value, ["maxAbsDepthSemitone", "maxTotalPoints", "maxPointsPerCurve", "minVibratoQuarter"], "constraints");
  return {
    maxAbsDepthSemitone: checkedNumber(value.maxAbsDepthSemitone, 0.01, 24, defaults.maxAbsDepthSemitone, "constraints.maxAbsDepthSemitone"),
    maxTotalPoints: checkedInteger(value.maxTotalPoints, 16, 4000, defaults.maxTotalPoints, "constraints.maxTotalPoints"),
    maxPointsPerCurve: checkedInteger(value.maxPointsPerCurve, 2, 2000, defaults.maxPointsPerCurve, "constraints.maxPointsPerCurve"),
    minVibratoQuarter: checkedNumber(value.minVibratoQuarter, 0.25, 8, defaults.minVibratoQuarter, "constraints.minVibratoQuarter"),
  };
}

function normalizeSampling(value) {
  const defaults = PITCH_GESTURE_DEFAULTS.sampling;
  if (value === undefined) return { ...defaults };
  if (!isRecord(value)) throw codedError("INVALID_ARGUMENTS", "sampling must be an object");
  assertKnownKeys(value, ["pointsPerQuarter", "vibratoPointsPerCycle"], "sampling");
  return {
    pointsPerQuarter: checkedInteger(value.pointsPerQuarter, 2, 32, defaults.pointsPerQuarter, "sampling.pointsPerQuarter"),
    vibratoPointsPerCycle: checkedInteger(value.vibratoPointsPerCycle, 4, 16, defaults.vibratoPointsPerCycle, "sampling.vibratoPointsPerCycle"),
  };
}

// ---------- 小工具 ----------

function sampleCount(lengthBlick, quarterBlick, sampling) {
  return Math.max(4, Math.ceil((lengthBlick / quarterBlick) * sampling.pointsPerQuarter) + 1);
}

function linearPositions(fromBlick, toBlick, count) {
  if (toBlick <= fromBlick) return [fromBlick];
  const positions = [];
  const steps = Math.max(1, count - 1);
  for (let index = 0; index <= steps; index += 1) {
    positions.push(Math.round(fromBlick + ((toBlick - fromBlick) * index) / steps));
  }
  return positions;
}

function smoothstep(u) {
  return u * u * (3 - 2 * u);
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function appendOnce(warnings, warning) {
  if (!warnings.some((item) => item.code === warning.code)) warnings.push(warning);
}

function requireNoteIdField(value, field, label) {
  if (typeof value[field] !== "string" || value[field].length === 0) {
    throw codedError("INVALID_ARGUMENTS", `${label}.${field} must be a non-empty noteId string`);
  }
}

function checkNumber(value, minimum, maximum, label) {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw codedError("INVALID_ARGUMENTS", `${label} must be a number between ${minimum} and ${maximum}`);
  }
}

function checkEnum(value, allowed, label) {
  if (value === undefined) return;
  if (!allowed.includes(value)) {
    throw codedError("INVALID_ARGUMENTS", `${label} must be one of ${allowed.join(", ")}`);
  }
}

function checkedNumber(value, minimum, maximum, fallback, label) {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw codedError("INVALID_ARGUMENTS", `${label} must be a number between ${minimum} and ${maximum}`);
  }
  return value;
}

function checkedInteger(value, minimum, maximum, fallback, label) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw codedError("INVALID_ARGUMENTS", `${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
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
