import { createHash } from "node:crypto";

import { blickAtSeconds, secondsAtBlick } from "./musical-time.js";
import { buildApplyEnvelope } from "./plan-envelope.js";
import { ServiceTiming } from "./service-timing.js";

// sv_plan_expression：dry-run 表情规划器（M-03 / §6.1 表情手势生成器）。
//
// 关键契约：
// - 纯内存只读：只读取 sv_snapshot_range 已存的音符指纹/tempo/meter 数据，不进入
//   ExecutionCoordinator、绝不写宿主。真正的写入由调用方把 applyRequest 交给现有
//   sv_patch_parameter_curves 事务核（预检/Undo/读回/补偿全部复用，本模块零 mutation）。
// - 确定性：同一 context 数据 + 同一请求 → 逐字节相同的 plan（planId 为内容哈希）；
//   意图映射是显式小词表 + 常量模板，全部标 heuristic，不伪装成听感预测。
// - 单位显式：每条 operation 携带 writeSurface 与 unit（官方 getDefinition 语义：
//   pitchDelta=cents、loudness=dB、vibratoEnv=0..2 倍率、tension/breathiness=±1）。
//   SynthV 的 pitch 写面单位互不相同（automation=cents，PitchControl=半音），P0 只
//   规划 automation 写面并显式声明，杜绝 +25 的量纲歧义。
// - 诚实边界：规划基于快照指纹，宿主并发漂移由 apply 阶段的 UUID/live 校验兜底；
//   replace 模式会覆盖手势区间内的既有控制点，规划器不读宿主、无法核对，review
//   中显式声明 existingPointsChecked:false；能否"更好听"永远是 human_only。
export const EXPRESSION_PLAN_DEFAULTS = Object.freeze({
  constraints: Object.freeze({
    maxAbsPitchDeltaCents: 200,
    maxAbsLoudnessDeltaDb: 6,
    maxAbsTensionDelta: 0.5,
    maxAbsBreathinessDelta: 0.5,
    maxTotalPoints: 400,
    avoidExcessiveVibrato: true,
  }),
  sampling: Object.freeze({
    pointsPerQuarter: 8,
    vibratoPointsPerCycle: 8,
  }),
  intent: Object.freeze({
    phraseGapQuarter: 1,
    sustainQuarter: 2,
    minVibratoQuarter: 1.5,
  }),
});

// 官方 Automation getDefinition 的单位/值域（写入前的最终 clamp 边界）。
const PARAMETER_INFO = Object.freeze({
  pitchDelta: Object.freeze({ unit: "cents", range: Object.freeze([-1200, 1200]), baseline: 0 }),
  vibratoEnv: Object.freeze({ unit: "x", range: Object.freeze([0, 2]), baseline: 1 }),
  loudness: Object.freeze({ unit: "dB", range: Object.freeze([-48, 12]), baseline: 0 }),
  tension: Object.freeze({ unit: "normalized", range: Object.freeze([-1, 1]), baseline: 0 }),
  breathiness: Object.freeze({ unit: "normalized", range: Object.freeze([-1, 1]), baseline: 0 }),
});
const HAIRPIN_PARAMETERS = Object.freeze(["loudness", "tension", "breathiness"]);
const GESTURE_TYPES = Object.freeze(["scoop", "fall", "portamento", "vibrato", "hairpin"]);
const INTENT_GENRES = Object.freeze(["jpop"]);
const INTENT_SECTIONS = Object.freeze(["verse", "prechorus", "chorus", "bridge"]);
const INTENT_EMOTIONS = Object.freeze(["cool_anger", "tender"]);
const INTENT_TECHNIQUES = Object.freeze(["controlled_belt", "soft_airy", "light_rasp"]);
// section-aware presets（M-04）：可审阅的常量展开，不是黑箱按钮。每个 preset 只是现有
// intent 词表字段 + 约束默认值的组合（spoken_rap_transition 额外播种 vibratoEnv 压平
// 手势）；展开结果逐字段回显在 presetExpansion 中，用户显式传的同名 intent 字段覆盖
// preset 值并发警告，用户 constraints 永远优先于 preset 约束默认值。
export const INTENT_PRESETS = Object.freeze({
  jpop_cool: Object.freeze({
    intent: Object.freeze({ genre: "jpop", emotion: "cool_anger" }),
    constraintDefaults: Object.freeze({}),
    notes: "jpop onset scoops with the cool_anger color modifiers",
  }),
  jpop_belt: Object.freeze({
    intent: Object.freeze({ genre: "jpop", technique: Object.freeze(["controlled_belt"]) }),
    constraintDefaults: Object.freeze({}),
    notes: "jpop onset scoops plus controlled-belt dynamic/tension arcs and sustained vibrato",
  }),
  controlled_anger: Object.freeze({
    intent: Object.freeze({ emotion: "cool_anger", technique: Object.freeze(["controlled_belt"]) }),
    constraintDefaults: Object.freeze({ maxAbsTensionDelta: 0.3 }),
    notes: "belt arcs under the cool_anger modifiers with a tighter tension budget",
  }),
  intimate_whisper: Object.freeze({
    intent: Object.freeze({ emotion: "tender", technique: Object.freeze(["soft_airy"]) }),
    constraintDefaults: Object.freeze({ maxAbsLoudnessDeltaDb: 3 }),
    notes: "airy breathiness arcs with tender modifiers and a soft dynamic budget",
  }),
  spoken_rap_transition: Object.freeze({
    intent: Object.freeze({}),
    constraintDefaults: Object.freeze({ maxAbsPitchDeltaCents: 40 }),
    seeds: "flatten_vibrato",
    notes:
      "flattens the host's natural vibrato on sustains via vibratoEnv 0.2 (its presence is unobservable) and narrows the pitchDelta budget for a speech-like delivery; combine with explicit gestures for the transition itself",
  }),
});
const MAX_GESTURES = 32;
const MAX_POINTS_PER_CURVE = 2000;

const PROVENANCE = Object.freeze({
  planner: "deterministic_gesture_compiler",
  anchorsBasis: "observed_snapshot_fingerprints",
  intentMappingBasis: "heuristic",
  thresholdBasis: "engineering_heuristic_requires_host_calibration",
  hostWriteSurfaces: Object.freeze(["automation"]),
  perception: "human_only",
});

export class ExpressionPlanService {
  constructor({ store, now = () => Date.now() } = {}) {
    if (!store) throw new Error("ExpressionPlanService requires the shared SnapshotStore");
    this.store = store;
    this.now = now;
  }

  async plan(request = {}) {
    const timer = new ServiceTiming({
      now: this.now,
      phaseNames: ["loadMs", "buildMs", "compileMs"],
    });
    const input = normalizePlanRequest(request);
    // 纯内存服务：不进入协调器；coordinatorQueueMs/operationMs 恒 0，如实报告。
    timer.requestCoordinator();
    const warnings = [];
    const loaded = await timer.measure("loadMs", async () =>
      resolvePlanSource(this.store, input)
    );
    const gestures = await timer.measure("buildMs", async () =>
      buildGestures(loaded, input, warnings)
    );
    const compiled = await timer.measure("compileMs", async () =>
      compileOperations(gestures, loaded, input, warnings)
    );
    return buildPlanResponse(loaded, input, gestures, compiled, warnings, timer.finish());
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
      'sv_plan_expression needs a range context from sv_snapshot_range with include ["notes"]'
    );
  }
  const occurrences = Array.isArray(stored.context.occurrences) ? stored.context.occurrences : [];
  const candidates = occurrences.filter(
    (item) => Array.isArray(item.noteFingerprints) && item.noteFingerprints.length > 0
  );
  // 与 sv_patch_notes 一致的推导规则：noteId 前缀（去掉 :n:Z）即 occurrenceId。
  const derived = new Set();
  for (const noteId of input.referencedNoteIds) {
    const cut = noteId.lastIndexOf(":n:");
    if (cut > 0) derived.add(noteId.slice(0, cut));
  }
  if (derived.size > 1) {
    throw codedError(
      "INVALID_NOTE_ID",
      "all noteIds in one plan must belong to the same range occurrence"
    );
  }
  const derivedId = derived.size === 1 ? derived.values().next().value : undefined;
  if (
    input.occurrenceId !== undefined &&
    derivedId !== undefined &&
    input.occurrenceId !== derivedId
  ) {
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
      'sv_plan_expression needs note fingerprints; re-run sv_snapshot_range with include ["notes"]'
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
  const notes = [...occurrence.noteFingerprints]
    .map((fingerprint) => ({
      noteId: fingerprint.noteId,
      indexInGroup: fingerprint.indexInGroup,
      lyrics: fingerprint.lyrics,
      targetSemitone: fingerprint.pitch + (fingerprint.detuneCents ?? 0) / 100,
      absOnsetBlick: timeOffset + fingerprint.onsetBlick,
      absEndBlick: timeOffset + fingerprint.onsetBlick + fingerprint.durationBlick,
      durationBlick: fingerprint.durationBlick,
    }))
    .sort((left, right) => left.absOnsetBlick - right.absOnsetBlick);
  const noteById = new Map(notes.map((note) => [note.noteId, note]));
  return {
    stored,
    occurrence,
    notes,
    noteById,
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

// ---------- 手势构建 ----------

function buildGestures(loaded, input, warnings) {
  const explicit = input.gestures.map((gesture, index) =>
    instantiateGesture(gesture, loaded, input, {
      source: "explicit",
      gestureId: `g${index}-${gesture.type}`,
      reasons: [],
    })
  );
  if ((input.presetExpansion?.overriddenFields?.length ?? 0) > 0) {
    appendOnce(warnings, {
      code: "PRESET_FIELD_OVERRIDDEN",
      message: `explicit intent field(s) ${input.presetExpansion.overriddenFields
        .map((item) => item.field)
        .join(", ")} override the ${input.presetExpansion.preset} preset's values; see presetExpansion.overriddenFields.`,
    });
  }
  const derived = input.intent
    ? deriveIntentGestures(loaded, input, explicit, warnings)
    : [];
  const gestures = [...explicit, ...derived].sort(
    (left, right) =>
      left.spanFromBlick - right.spanFromBlick ||
      left.parameter.localeCompare(right.parameter) ||
      left.gestureId.localeCompare(right.gestureId)
  );
  if (gestures.length === 0) {
    throw codedError(
      "EMPTY_PLAN",
      "no gestures to plan: provide explicit gestures, or an intent that matches the phrase structure"
    );
  }
  return gestures;
}

// 把一个（显式或意图派生的）手势请求绑定到音符跨度，生成连续求值函数与采样位置。
function instantiateGesture(gesture, loaded, input, meta) {
  switch (gesture.type) {
    case "scoop":
      return instantiateScoop(gesture, loaded, input, meta);
    case "fall":
      return instantiateFall(gesture, loaded, input, meta);
    case "portamento":
      return instantiatePortamento(gesture, loaded, input, meta);
    case "vibrato":
      return instantiateVibrato(gesture, loaded, input, meta);
    case "hairpin":
      return instantiateHairpin(gesture, loaded, input, meta);
    default:
      throw codedError("INVALID_ARGUMENTS", `unknown gesture type: ${String(gesture.type)}`);
  }
}

function instantiateScoop(gesture, loaded, input, meta) {
  const note = requireNote(loaded, gesture.noteId, `${meta.gestureId}.noteId`);
  const depth = gesture.depthCents ?? 30;
  const power = gesture.shapePower ?? 2;
  const lengthBlick = Math.min(
    quartersToBlick(gesture.lengthQuarter ?? 0.2, loaded.quarterBlick),
    note.durationBlick
  );
  const from = note.absOnsetBlick;
  const to = note.absOnsetBlick + lengthBlick;
  return {
    ...meta,
    type: "scoop",
    parameter: "pitchDelta",
    merge: "delta",
    noteIds: [note.noteId],
    spanFromBlick: from,
    spanToBlick: to,
    params: { depthCents: depth, lengthQuarter: blickToQuarters(lengthBlick, loaded.quarterBlick), shapePower: power },
    evaluate: (blick) => {
      const u = clamp01((blick - from) / Math.max(1, to - from));
      return -depth * (1 - u) ** power;
    },
    samplePositions: () =>
      linearPositions(from, to, sampleCount(lengthBlick, loaded.quarterBlick, input.sampling)),
  };
}

function instantiateFall(gesture, loaded, input, meta) {
  const note = requireNote(loaded, gesture.noteId, `${meta.gestureId}.noteId`);
  const depth = gesture.depthCents ?? 40;
  const power = gesture.shapePower ?? 2;
  const lengthBlick = Math.min(
    quartersToBlick(gesture.lengthQuarter ?? 0.3, loaded.quarterBlick),
    note.durationBlick
  );
  const from = note.absEndBlick - lengthBlick;
  const to = note.absEndBlick;
  return {
    ...meta,
    type: "fall",
    parameter: "pitchDelta",
    merge: "delta",
    noteIds: [note.noteId],
    spanFromBlick: from,
    spanToBlick: to,
    params: { depthCents: depth, lengthQuarter: blickToQuarters(lengthBlick, loaded.quarterBlick), shapePower: power },
    evaluate: (blick) => {
      const u = clamp01((blick - from) / Math.max(1, to - from));
      return -depth * u ** power;
    },
    samplePositions: () =>
      linearPositions(from, to, sampleCount(lengthBlick, loaded.quarterBlick, input.sampling)),
  };
}

// 对称滑音：前音末端向目标弯 +D/2，后音起始从 −D/2 回正——感知音高连续，
// 而 pitchDelta 在边界处的跳变恰好抵消音符本身的跳变。
function instantiatePortamento(gesture, loaded, input, meta) {
  const fromNote = requireNote(loaded, gesture.fromNoteId, `${meta.gestureId}.fromNoteId`);
  const toNote = requireNote(loaded, gesture.toNoteId, `${meta.gestureId}.toNoteId`);
  if (toNote.absOnsetBlick !== fromNote.absEndBlick) {
    throw codedError(
      "PORTAMENTO_NOT_ADJACENT",
      `${meta.gestureId}: portamento requires adjacent notes without a rest between them`
    );
  }
  const intervalCents = (toNote.targetSemitone - fromNote.targetSemitone) * 100;
  if (intervalCents === 0) {
    throw codedError(
      "INVALID_ARGUMENTS",
      `${meta.gestureId}: portamento between equal pitches has no effect`
    );
  }
  const requestedLength = quartersToBlick(gesture.lengthQuarter ?? 0.15, loaded.quarterBlick);
  const lenBefore = Math.min(requestedLength, Math.floor(fromNote.durationBlick / 2));
  const lenAfter = Math.min(requestedLength, Math.floor(toNote.durationBlick / 2));
  const boundary = toNote.absOnsetBlick;
  const maxCents = gesture.maxCents ?? input.constraints.maxAbsPitchDeltaCents;
  const halfRaw = intervalCents / 2;
  const half = Math.sign(halfRaw) * Math.min(Math.abs(halfRaw), maxCents);
  const clampedGlide = Math.abs(half) < Math.abs(halfRaw);
  return {
    ...meta,
    type: "portamento",
    parameter: "pitchDelta",
    merge: "delta",
    noteIds: [fromNote.noteId, toNote.noteId],
    spanFromBlick: boundary - lenBefore,
    spanToBlick: boundary + lenAfter,
    params: {
      intervalCents,
      glideHalfCents: half,
      clampedGlide,
      lengthQuarter: blickToQuarters(requestedLength, loaded.quarterBlick),
    },
    ...(clampedGlide
      ? { reasons: [...meta.reasons, "glide depth clamped by maxAbsPitchDeltaCents"] }
      : {}),
    evaluate: (blick) => {
      if (blick < boundary) {
        const u = clamp01((blick - (boundary - lenBefore)) / Math.max(1, lenBefore));
        return half * smoothstep(u);
      }
      const u = clamp01((blick - boundary) / Math.max(1, lenAfter));
      return -half * (1 - smoothstep(u));
    },
    samplePositions: () => {
      const perSide = Math.max(
        3,
        sampleCount(requestedLength, loaded.quarterBlick, input.sampling)
      );
      const before = linearPositions(boundary - lenBefore, boundary - 1, perSide);
      const after = linearPositions(boundary, boundary + lenAfter, perSide);
      return [...before, ...after];
    },
  };
}

function instantiateVibrato(gesture, loaded, input, meta) {
  const note = requireNote(loaded, gesture.noteId, `${meta.gestureId}.noteId`);
  const surface = gesture.surface ?? "pitchDelta";
  const quarter = loaded.quarterBlick;
  if (
    input.constraints.avoidExcessiveVibrato &&
    note.durationBlick < quartersToBlick(input.intentDefaults.minVibratoQuarter, quarter)
  ) {
    throw codedError(
      "CONSTRAINT_VIOLATION",
      `${meta.gestureId}: note is shorter than ${input.intentDefaults.minVibratoQuarter} quarters; disable avoidExcessiveVibrato to force vibrato`
    );
  }
  const delayBlick = quartersToBlick(gesture.onsetDelayQuarter ?? 0.3, quarter);
  const rampBlick = quartersToBlick(gesture.rampQuarter ?? 0.3, quarter);
  const from = note.absOnsetBlick + Math.min(delayBlick, note.durationBlick);
  const to = note.absEndBlick;
  const startSeconds = secondsAtBlick(loaded.tempoMarks, quarter, from);
  const endSeconds = secondsAtBlick(loaded.tempoMarks, quarter, to);
  if (startSeconds === null || endSeconds === null) {
    throw codedError(
      "TEMPO_MAP_MISSING",
      `${meta.gestureId}: vibrato needs a usable tempo map to express rateHz`
    );
  }
  const rateHz = gesture.rateHz ?? 5.5;
  const rampSeconds = Math.max(0, secondsAtBlick(loaded.tempoMarks, quarter, from + rampBlick) - startSeconds);
  if (surface === "vibratoEnv") {
    const level = gesture.level ?? 1;
    return {
      ...meta,
      type: "vibrato",
      parameter: "vibratoEnv",
      merge: "absolute",
      noteIds: [note.noteId],
      spanFromBlick: note.absOnsetBlick,
      spanToBlick: to,
      params: {
        surface,
        level,
        onsetDelayQuarter: blickToQuarters(from - note.absOnsetBlick, quarter),
        rampQuarter: blickToQuarters(rampBlick, quarter),
      },
      // 诚实边界：宿主是否存在 natural vibrato 不可观测（Note 颤音属性 version-1-only），
      // 包络只在其存在时生效。
      surfaceWarning: {
        code: "NATURAL_VIBRATO_UNOBSERVABLE",
        message:
          "vibratoEnv scales the host's own vibrato, whose presence/depth is unobservable through the official API; audition to confirm the effect.",
      },
      evaluate: (blick) => {
        if (blick < from) return 0;
        const u = clamp01((blick - from) / Math.max(1, rampBlick));
        return level * smoothstep(u);
      },
      samplePositions: () => {
        const rampEnd = Math.min(from + rampBlick, to);
        return [
          note.absOnsetBlick,
          ...linearPositions(from, rampEnd, Math.max(3, sampleCount(rampBlick, quarter, input.sampling))),
          to,
        ];
      },
    };
  }
  const depth = gesture.depthCents ?? 30;
  const fadeBlick = quartersToBlick(gesture.fadeOutQuarter ?? 0.2, quarter);
  const fadeSeconds = Math.max(
    0,
    endSeconds - secondsAtBlick(loaded.tempoMarks, quarter, Math.max(from, to - fadeBlick))
  );
  const spanSeconds = endSeconds - startSeconds;
  const minSpanSeconds = Math.max(2 / rateHz, rampSeconds + fadeSeconds);
  if (spanSeconds < minSpanSeconds) {
    throw codedError(
      "VIBRATO_SPAN_TOO_SHORT",
      `${meta.gestureId}: the note sustain after onsetDelay is too short for ${rateHz} Hz vibrato (needs >= ${minSpanSeconds.toFixed(3)} s)`
    );
  }
  const envelope = (seconds) => {
    const sinceStart = seconds - startSeconds;
    const untilEnd = endSeconds - seconds;
    let value = 1;
    if (rampSeconds > 0) value *= smoothstep(clamp01(sinceStart / rampSeconds));
    if (fadeSeconds > 0) value *= smoothstep(clamp01(untilEnd / fadeSeconds));
    return value;
  };
  return {
    ...meta,
    type: "vibrato",
    parameter: "pitchDelta",
    merge: "delta",
    noteIds: [note.noteId],
    spanFromBlick: from,
    spanToBlick: to,
    params: {
      surface,
      depthCents: depth,
      rateHz,
      onsetDelayQuarter: blickToQuarters(from - note.absOnsetBlick, quarter),
      rampQuarter: blickToQuarters(rampBlick, quarter),
      fadeOutQuarter: blickToQuarters(fadeBlick, quarter),
    },
    surfaceWarning: {
      code: "NATURAL_VIBRATO_UNOBSERVABLE",
      message:
        "explicit pitchDelta vibrato may stack with the host's own (unobservable) natural vibrato; audition and check with sv_compare_computed_pitch.",
    },
    evaluate: (blick) => {
      const seconds = secondsAtBlick(loaded.tempoMarks, quarter, blick);
      if (seconds === null || seconds < startSeconds || seconds > endSeconds) return 0;
      return depth * envelope(seconds) * Math.sin(2 * Math.PI * rateHz * (seconds - startSeconds));
    },
    samplePositions: () => {
      const step = 1 / (rateHz * input.sampling.vibratoPointsPerCycle);
      const positions = [];
      for (let seconds = startSeconds; seconds <= endSeconds; seconds += step) {
        const blick = blickAtSeconds(loaded.tempoMarks, quarter, seconds);
        if (blick !== null) positions.push(Math.round(blick));
      }
      positions.push(to);
      return positions;
    },
  };
}

function instantiateHairpin(gesture, loaded, input, meta) {
  const fromNote = requireNote(loaded, gesture.fromNoteId, `${meta.gestureId}.fromNoteId`);
  const toNote = requireNote(loaded, gesture.toNoteId, `${meta.gestureId}.toNoteId`);
  if (toNote.absEndBlick <= fromNote.absOnsetBlick) {
    throw codedError(
      "INVALID_ARGUMENTS",
      `${meta.gestureId}: hairpin toNoteId must not end before fromNoteId starts`
    );
  }
  const parameter = gesture.parameter ?? "loudness";
  const amount = gesture.amount ?? (parameter === "loudness" ? 3 : 0.15);
  const peak = gesture.peakPosition ?? 0.6;
  const from = fromNote.absOnsetBlick;
  const to = toNote.absEndBlick;
  return {
    ...meta,
    type: "hairpin",
    parameter,
    merge: "delta",
    noteIds: [fromNote.noteId, toNote.noteId],
    spanFromBlick: from,
    spanToBlick: to,
    params: { amount, peakPosition: peak, unit: PARAMETER_INFO[parameter].unit },
    evaluate: (blick) => {
      const u = clamp01((blick - from) / Math.max(1, to - from));
      const shaped = u <= peak ? smoothstep(u / peak) : 1 - smoothstep((u - peak) / (1 - peak));
      return amount * shaped;
    },
    samplePositions: () => {
      const spanQuarters = blickToQuarters(to - from, loaded.quarterBlick);
      const count = Math.max(
        5,
        Math.min(64, Math.ceil((spanQuarters * input.sampling.pointsPerQuarter) / 2))
      );
      const positions = linearPositions(from, to, count);
      positions.push(Math.round(from + (to - from) * peak));
      return positions;
    },
  };
}

// ---------- 意图薄映射（全部 heuristic） ----------

function deriveIntentGestures(loaded, input, explicitGestures, warnings) {
  const intent = input.intent;
  const quarter = loaded.quarterBlick;
  // 意图手势只锚定旋律音符："br" 呼吸音符没有可唱音高，在换气上规划 scoop/颤音/
  // 弧线毫无意义。显式手势不受此过滤（用户的话优先）。br 时值天然成为乐句间隙，
  // 让呼吸位置照常参与 rest 阈值切分。
  const melodicNotes = loaded.notes.filter((note) => !isBreathLyrics(note.lyrics));
  if (melodicNotes.length < loaded.notes.length) {
    appendOnce(warnings, {
      code: "BREATH_NOTES_SKIPPED_BY_INTENT",
      message:
        "breath notes (lyrics 'br') were excluded from intent-derived gesture anchoring; their duration still separates phrases.",
    });
  }
  const phrases = segmentPhrases(melodicNotes, quartersToBlick(input.intentDefaults.phraseGapQuarter, quarter));
  const sustainBlick = quartersToBlick(input.intentDefaults.sustainQuarter, quarter);
  const candidates = [];
  let sequence = 0;
  const push = (source, confidenceScore, reasons, spec) => {
    candidates.push({ source, confidenceScore, reasons, spec, sequence: sequence++ });
  };

  if (intent.genre === "jpop") {
    for (const phrase of phrases) {
      push(
        "intent:genre:jpop",
        0.55,
        [`jpop onset shaping on post-rest entrance "${phrase.notes[0].lyrics}"`],
        { type: "scoop", noteId: phrase.notes[0].noteId, depthCents: 30, lengthQuarter: 0.15 }
      );
    }
  }
  for (const technique of intent.technique ?? []) {
    if (technique === "controlled_belt") {
      for (const phrase of phrases) {
        const sustains = phrase.notes.filter((note) => note.durationBlick >= sustainBlick);
        if (sustains.length === 0) continue;
        push(
          "intent:technique:controlled_belt",
          0.6,
          [`crescendo into the phrase around "${phrase.climax.lyrics}"`],
          {
            type: "hairpin",
            fromNoteId: phrase.notes[0].noteId,
            toNoteId: phrase.notes[phrase.notes.length - 1].noteId,
            parameter: "loudness",
            amount: 3,
            peakPosition: 0.65,
          }
        );
        push(
          "intent:technique:controlled_belt",
          0.5,
          ["belt support: mild tension arc over the phrase"],
          {
            type: "hairpin",
            fromNoteId: phrase.notes[0].noteId,
            toNoteId: phrase.notes[phrase.notes.length - 1].noteId,
            parameter: "tension",
            amount: 0.12,
            peakPosition: 0.65,
          }
        );
        for (const sustain of sustains) {
          push(
            "intent:technique:controlled_belt",
            0.5,
            [`controlled vibrato on sustained "${sustain.lyrics}"`],
            {
              type: "vibrato",
              noteId: sustain.noteId,
              depthCents: 30,
              rateHz: 5.5,
              onsetDelayQuarter: 0.4,
              rampQuarter: 0.4,
            }
          );
        }
      }
    } else if (technique === "soft_airy") {
      for (const phrase of phrases) {
        push(
          "intent:technique:soft_airy",
          0.5,
          ["airy color: breathiness arc over the phrase"],
          {
            type: "hairpin",
            fromNoteId: phrase.notes[0].noteId,
            toNoteId: phrase.notes[phrase.notes.length - 1].noteId,
            parameter: "breathiness",
            amount: 0.12,
            peakPosition: 0.5,
          }
        );
        push(
          "intent:technique:soft_airy",
          0.45,
          ["softer dynamics to match the airy color"],
          {
            type: "hairpin",
            fromNoteId: phrase.notes[0].noteId,
            toNoteId: phrase.notes[phrase.notes.length - 1].noteId,
            parameter: "loudness",
            amount: -1.5,
            peakPosition: 0.5,
          }
        );
      }
    } else if (technique === "light_rasp") {
      appendOnce(warnings, {
        code: "LOW_CONFIDENCE_INTENT",
        message:
          "light_rasp: rasp texture is not an observable or directly controllable host parameter; approximated with a small tension arc at low confidence.",
      });
      for (const phrase of phrases) {
        push(
          "intent:technique:light_rasp",
          0.3,
          ["rasp approximation via tension (texture itself is host-unobservable)"],
          {
            type: "hairpin",
            fromNoteId: phrase.notes[0].noteId,
            toNoteId: phrase.notes[phrase.notes.length - 1].noteId,
            parameter: "tension",
            amount: 0.1,
            peakPosition: 0.6,
          }
        );
      }
    }
  }

  applyIntentModifiers(candidates, intent);
  if (intent.presetSeeds === "flatten_vibrato") {
    // spoken_rap_transition：对每个长音播种 vibratoEnv 压平包络（绝对值 0.2 ≈ 关掉颤音）。
    // natural vibrato 是否存在不可观测——包络只在其存在时生效，低置信如实声明。
    for (const phrase of phrases) {
      for (const sustain of phrase.notes.filter((note) => note.durationBlick >= sustainBlick)) {
        push(
          `intent:preset:${intent.presetName}`,
          0.4,
          [`flatten host vibrato on sustained "${sustain.lyrics}" for a speech-like delivery`],
          {
            type: "vibrato",
            noteId: sustain.noteId,
            surface: "vibratoEnv",
            level: 0.2,
            onsetDelayQuarter: 0,
            rampQuarter: 0.1,
          }
        );
      }
    }
  }
  if (candidates.length === 0 && (intent.section || intent.emotion)) {
    // genre/technique 未产出任何候选，但用户单独给了 section/emotion：直接播种基线手势兜底，
    // 不再必然 EMPTY_PLAN。在 applyIntentModifiers 之后播种，故这些已成形的基线不会被二次修饰。
    seedIntentBaselines(intent, phrases, push);
  }

  const derived = [];
  for (const candidate of candidates) {
    // 显式手势覆盖同类同参数的重叠意图候选，用户的话优先于模板。
    const bounds = candidateSpanBounds(candidate.spec, loaded);
    const superseded = explicitGestures.some(
      (gesture) =>
        gesture.type === candidate.spec.type &&
        gesture.parameter === (candidate.spec.parameter ?? gestureDefaultParameter(candidate.spec.type)) &&
        gesture.spanFromBlick <= bounds.to &&
        bounds.from <= gesture.spanToBlick
    );
    if (superseded) {
      appendOnce(warnings, {
        code: "INTENT_GESTURE_SUPERSEDED",
        message: "one or more intent-derived gestures were dropped in favor of overlapping explicit gestures.",
      });
      continue;
    }
    try {
      derived.push(
        instantiateGesture(candidate.spec, loaded, input, {
          source: candidate.source,
          gestureId: `i${candidate.sequence}-${candidate.spec.type}`,
          reasons: candidate.reasons,
          confidence: {
            score: candidate.confidenceScore,
            kind: "heuristic_score",
            calibrated: false,
          },
        })
      );
    } catch (error) {
      // 意图候选只是建议：放不下（太短/不相邻/tempo 缺失）就静默跳过，不让整个计划失败。
      if (
        !["VIBRATO_SPAN_TOO_SHORT", "CONSTRAINT_VIOLATION", "PORTAMENTO_NOT_ADJACENT", "TEMPO_MAP_MISSING"].includes(
          error?.code
        )
      ) {
        throw error;
      }
    }
  }
  if (derived.length === 0) {
    appendOnce(warnings, {
      code: "INTENT_NO_CANDIDATES",
      message:
        "the intent produced no applicable gesture candidates for this phrase structure (no qualifying phrases/sustains, or candidates could not fit the notes).",
    });
  }
  return derived;
}

// 情绪/段落修饰只作用于意图派生的候选，显式手势保持用户原话。
function applyIntentModifiers(candidates, intent) {
  for (const candidate of candidates) {
    const spec = candidate.spec;
    if (intent.emotion === "cool_anger") {
      if (spec.type === "vibrato" && spec.depthCents !== undefined) {
        const capped = Math.min(spec.depthCents, 30);
        if (capped !== spec.depthCents) candidate.reasons.push("cool_anger: vibrato depth capped to 30 cents");
        spec.depthCents = capped;
      }
      if (spec.type === "hairpin" && spec.parameter === "tension") {
        spec.amount += 0.05;
        candidate.reasons.push("cool_anger: tension raised by 0.05");
      }
      if (spec.type === "hairpin" && spec.parameter === "breathiness") {
        spec.amount -= 0.05;
        candidate.reasons.push("cool_anger: breathiness reduced by 0.05");
      }
      if (spec.type === "scoop") {
        spec.depthCents += 5;
        candidate.reasons.push("cool_anger: slightly deeper onset scoop");
      }
    } else if (intent.emotion === "tender") {
      if (spec.type === "vibrato" && spec.depthCents !== undefined) {
        spec.depthCents = Math.min(60, spec.depthCents + 5);
        candidate.reasons.push("tender: slightly deeper vibrato");
      }
      if (spec.type === "hairpin" && spec.parameter === "loudness") {
        spec.amount -= 1;
        candidate.reasons.push("tender: softer dynamics");
      }
      if (spec.type === "hairpin" && spec.parameter === "breathiness") {
        spec.amount += 0.05;
        candidate.reasons.push("tender: more breath");
      }
      if (spec.type === "scoop") {
        spec.depthCents = Math.max(10, spec.depthCents - 10);
        candidate.reasons.push("tender: gentler onset scoop");
      }
    }
    if (["chorus", "prechorus"].includes(intent.section) && spec.type === "hairpin" && spec.parameter === "loudness") {
      spec.amount += 1;
      candidate.reasons.push(`${intent.section}: stronger dynamic arc`);
    }
    if (intent.section === "verse" && spec.type === "hairpin" && spec.parameter === "loudness") {
      spec.amount -= 0.5;
      candidate.reasons.push("verse: reduced dynamic arc");
    }
  }
}

// section/emotion 单独出现（无 genre/technique 候选）时的基线手势。均为低置信启发式默认表情曲线：
// section 负责逐乐句的动态弧（loudness），emotion 负责其特征色（cool_anger→tension，tender→breathiness）；
// 仅当没有 section 提供 loudness 时，emotion 才另补一条柔和的 loudness 弧，避免同一乐句叠两条 loudness。
function seedIntentBaselines(intent, phrases, push) {
  const hairpin = (from, to, parameter, amount, peakPosition) => ({
    type: "hairpin",
    fromNoteId: from.noteId,
    toNoteId: to.noteId,
    parameter,
    amount,
    peakPosition,
  });
  const sectionLoudness = {
    chorus: { amount: 3, peak: 0.65 },
    prechorus: { amount: 2, peak: 0.7 },
    verse: { amount: 0.8, peak: 0.5 },
    bridge: { amount: 1.5, peak: 0.55 },
  };
  for (const phrase of phrases) {
    const first = phrase.notes[0];
    const last = phrase.notes[phrase.notes.length - 1];
    const section = sectionLoudness[intent.section];
    if (section) {
      push(
        `intent:section:${intent.section}`,
        0.35,
        [`${intent.section}: baseline dynamic arc over the phrase`],
        hairpin(first, last, "loudness", section.amount, section.peak)
      );
    }
    if (intent.emotion === "cool_anger") {
      push(
        "intent:emotion:cool_anger",
        0.35,
        ["cool_anger: controlled tension arc over the phrase"],
        hairpin(first, last, "tension", 0.12, 0.6)
      );
      if (!section) {
        push(
          "intent:emotion:cool_anger",
          0.3,
          ["cool_anger: assertive dynamic push"],
          hairpin(first, last, "loudness", 2, 0.6)
        );
      }
    } else if (intent.emotion === "tender") {
      push(
        "intent:emotion:tender",
        0.35,
        ["tender: breath warmth over the phrase"],
        hairpin(first, last, "breathiness", 0.08, 0.5)
      );
      if (!section) {
        push(
          "intent:emotion:tender",
          0.3,
          ["tender: gentle dynamic swell"],
          hairpin(first, last, "loudness", 1, 0.5)
        );
      }
    }
  }
}

function gestureDefaultParameter(type) {
  return type === "hairpin" ? "loudness" : type === "vibrato" ? "pitchDelta" : "pitchDelta";
}

function candidateSpanBounds(spec, loaded) {
  const ids = [spec.noteId, spec.fromNoteId, spec.toNoteId].filter(Boolean);
  const notes = ids.map((id) => requireNote(loaded, id, "intent candidate"));
  return {
    from: Math.min(...notes.map((note) => note.absOnsetBlick)),
    to: Math.max(...notes.map((note) => note.absEndBlick)),
  };
}

// "br" 是宿主/社区约定的换气音符（与 lyric-align 的分词规则同源）：它带有名义 pitch 字段，
// 但没有可唱音高。调性/音级/乐句/统计与意图手势都必须把它当呼吸事件而不是旋律音符。
export function isBreathLyrics(lyrics) {
  return typeof lyrics === "string" && lyrics.trim().toLowerCase() === "br";
}

// 乐句切分：休止 >= phraseGapBlick 即边界；climax 为最高目标音（并列取更长者）。
// 全部 derived/heuristic，不伪装成宿主事实。phrase-analysis 复用同一实现。
export function segmentPhrases(notes, phraseGapBlick) {
  const phrases = [];
  let current = [];
  for (const note of notes) {
    const previous = current[current.length - 1];
    if (previous && note.absOnsetBlick - previous.absEndBlick >= phraseGapBlick) {
      phrases.push(current);
      current = [];
    }
    current.push(note);
  }
  if (current.length > 0) phrases.push(current);
  return phrases.map((phraseNotes) => ({
    notes: phraseNotes,
    climax: phraseNotes.reduce((best, note) =>
      note.targetSemitone > best.targetSemitone ||
      (note.targetSemitone === best.targetSemitone && note.durationBlick > best.durationBlick)
        ? note
        : best
    ),
  }));
}

// ---------- 编译：采样、合并、clamp、预算 ----------

function compileOperations(gestures, loaded, input, warnings) {
  const byParameter = new Map();
  for (const gesture of gestures) {
    const list = byParameter.get(gesture.parameter) ?? [];
    list.push(gesture);
    byParameter.set(gesture.parameter, list);
    if (gesture.surfaceWarning) appendOnce(warnings, gesture.surfaceWarning);
  }
  const operations = [];
  const guardBlick = Math.max(1, Math.floor(loaded.quarterBlick / 32));
  for (const parameter of [...byParameter.keys()].sort()) {
    const parameterGestures = byParameter.get(parameter);
    const info = PARAMETER_INFO[parameter];
    for (const cluster of clusterBySpanOverlap(parameterGestures)) {
      const absoluteGestures = cluster.filter((gesture) => gesture.merge === "absolute");
      if (absoluteGestures.length > 0 && cluster.length > 1) {
        throw codedError(
          "PLAN_CONFLICT",
          `${parameter}: absolute-valued gestures (vibratoEnv) cannot overlap other gestures on the same parameter`
        );
      }
      operations.push(
        compileCluster(cluster, parameter, info, loaded, input, guardBlick, warnings)
      );
    }
  }
  operations.sort(
    (left, right) =>
      left.range.fromBlick - right.range.fromBlick || left.parameter.localeCompare(right.parameter)
  );
  const totalPoints = operations.reduce((sum, operation) => sum + operation.points.length, 0);
  if (totalPoints > input.constraints.maxTotalPoints) {
    const error = codedError(
      "PLAN_TOO_DENSE",
      `the plan needs ${totalPoints} control points but constraints.maxTotalPoints is ${input.constraints.maxTotalPoints}; reduce gestures/sampling density or raise the budget (hard cap ${MAX_POINTS_PER_CURVE} per curve)`
    );
    error.details = { totalPoints, maxTotalPoints: input.constraints.maxTotalPoints };
    throw error;
  }
  // sv_patch_parameter_curves 一次请求内每个参数只允许出现一次（DUPLICATE_PARAMETER），
  // 而同参数的不相邻手势簇必须保持独立 range——把整段并成一个 replace 会抹掉簇间
  // 既有控制点。因此按"每参数第 j 个簇"分区成 K 次批量调用（通常 K=1），每次调用
  // 内参数唯一；K>1 时产生 K 个 Undo 记录，在 review 中如实声明。
  const clusterIndexByParameter = new Map();
  let applyCallCount = 1;
  for (const operation of operations) {
    const index = clusterIndexByParameter.get(operation.parameter) ?? 0;
    operation.applyCallIndex = index;
    clusterIndexByParameter.set(operation.parameter, index + 1);
    applyCallCount = Math.max(applyCallCount, index + 1);
  }
  return { operations, totalPoints, applyCallCount };
}

function clusterBySpanOverlap(gestures) {
  const sorted = [...gestures].sort((left, right) => left.spanFromBlick - right.spanFromBlick);
  const clusters = [];
  let current = null;
  let currentEnd = -Infinity;
  for (const gesture of sorted) {
    if (!current || gesture.spanFromBlick > currentEnd) {
      current = [gesture];
      clusters.push(current);
      currentEnd = gesture.spanToBlick;
    } else {
      current.push(gesture);
      currentEnd = Math.max(currentEnd, gesture.spanToBlick);
    }
  }
  return clusters;
}

function compileCluster(cluster, parameter, info, loaded, input, guardBlick, warnings) {
  const positions = new Set();
  for (const gesture of cluster) {
    for (const position of gesture.samplePositions()) positions.add(position);
  }
  const sortedPositions = [...positions].sort((left, right) => left - right);
  const limit = constraintLimitFor(parameter, input.constraints);
  const isAbsolute = cluster[0].merge === "absolute";
  let clampedCount = 0;
  const points = sortedPositions.map((blick) => {
    let value;
    if (isAbsolute) {
      // absolute 手势（vibratoEnv）单簇单手势（PLAN_CONFLICT 已挡重叠），值即包络本身。
      value = cluster[0].evaluate(blick);
    } else {
      value = 0;
      for (const gesture of cluster) {
        if (blick >= gesture.spanFromBlick && blick <= gesture.spanToBlick) {
          value += gesture.evaluate(blick);
        }
      }
    }
    const clamped = clampValue(value, info, limit);
    if (clamped !== value) clampedCount += 1;
    return { blick, value: clamped };
  });
  // 边界守卫：在簇两端各加一个基线点，让 replace 与周围曲线的过渡只跨一个极小 ε，
  // 不产生跨大段的意外插值斜坡。首/末采样值已是基线时无需守卫；前守卫不越过 0。
  const first = points[0];
  const last = points[points.length - 1];
  if (Math.abs(first.value - info.baseline) > 1e-9) {
    const guardFrom = Math.max(0, first.blick - guardBlick);
    if (guardFrom < first.blick) {
      points.unshift({ blick: guardFrom, value: info.baseline });
    }
  }
  if (Math.abs(last.value - info.baseline) > 1e-9) {
    points.push({ blick: last.blick + guardBlick, value: info.baseline });
  }
  if (clampedCount > 0) {
    appendOnce(warnings, {
      code: "CONSTRAINT_CLAMPED",
      message: `some planned ${parameter} values were clamped to the configured constraint/host range.`,
    });
  }
  if (points.length > MAX_POINTS_PER_CURVE) {
    throw codedError(
      "PLAN_TOO_DENSE",
      `${parameter}: one operation needs ${points.length} points, above the ${MAX_POINTS_PER_CURVE}-point per-curve cap`
    );
  }
  const values = points.map((point) => point.value);
  return {
    parameter,
    writeSurface: "automation",
    unit: info.unit,
    baselineValue: info.baseline,
    mode: "replace",
    range: {
      coordinate: "absolute",
      fromBlick: points[0].blick,
      toBlick: points[points.length - 1].blick + 1,
      localFromBlick: points[0].blick - loaded.timeOffsetBlick,
      localToBlick: points[points.length - 1].blick + 1 - loaded.timeOffsetBlick,
    },
    points,
    stats: {
      min: Math.min(...values),
      max: Math.max(...values),
      meanAbsDelta:
        values.reduce((sum, value) => sum + Math.abs(value - info.baseline), 0) / values.length,
    },
    clampedCount,
    fromGestures: cluster.map((gesture) => gesture.gestureId),
  };
}

function constraintLimitFor(parameter, constraints) {
  switch (parameter) {
    case "pitchDelta":
      return constraints.maxAbsPitchDeltaCents;
    case "loudness":
      return constraints.maxAbsLoudnessDeltaDb;
    case "tension":
      return constraints.maxAbsTensionDelta;
    case "breathiness":
      return constraints.maxAbsBreathinessDelta;
    default:
      return null; // vibratoEnv 只受宿主 0..2 值域约束
  }
}

function clampValue(value, info, deltaLimit) {
  let result = value;
  if (deltaLimit !== null) {
    result = Math.max(-deltaLimit, Math.min(deltaLimit, result));
  }
  return Math.max(info.range[0], Math.min(info.range[1], result));
}

// ---------- 响应组装 ----------

function buildPlanResponse(loaded, input, gestures, compiled, warnings, timings) {
  const sharedTargetOccurrences = loaded.occurrence.sharedTargetOccurrences ?? [];
  const requiresSharedTargetConfirmation = sharedTargetOccurrences.length > 1;
  const target = {
    contextId: loaded.stored.contextId,
    occurrenceId: loaded.occurrence.occurrenceId,
    ...(loaded.occurrence.targetGroupUuid
      ? { expectedGroupUuid: loaded.occurrence.targetGroupUuid }
      : {}),
    // 计划以绝对 BLICK 表达，apply 用提交时的 live getTimeOffset() 换算回本地；音符指纹是组内
    // 本地坐标，整个 reference 被 setTimeOffset 移动时指纹全部不变——必须把快照时的偏移一并交给
    // 事务核锁住，reference 移动即 STALE_CONTEXT，而不是把曲线写到相对音符错误的本地位置。
    expectedTimeOffsetBlick: loaded.timeOffsetBlick,
  };
  // 手势锚点音符的原始指纹：随 applyRequest 交给事务核，在写入前逐条 verifyAnchoredNote。
  // 音符被 UI/raw API 移动（UUID 不变、contextId 未失效）时，apply 以 STALE_CONTEXT 失败，
  // 而不是把绝对 BLICK 曲线写到音符早已离开的旧位置。
  const fingerprintById = new Map(
    (loaded.occurrence.noteFingerprints ?? []).map((fingerprint) => [fingerprint.noteId, fingerprint])
  );
  const gestureById = new Map(gestures.map((gesture) => [gesture.gestureId, gesture]));
  const expectedNotesFor = (operations) => {
    const noteIds = new Set();
    for (const operation of operations) {
      for (const gestureId of operation.fromGestures) {
        for (const noteId of gestureById.get(gestureId)?.noteIds ?? []) noteIds.add(noteId);
      }
    }
    const notes = [];
    for (const noteId of noteIds) {
      const fingerprint = fingerprintById.get(noteId);
      if (fingerprint) {
        notes.push({
          noteId: fingerprint.noteId,
          indexInGroup: fingerprint.indexInGroup,
          onsetBlick: fingerprint.onsetBlick,
          durationBlick: fingerprint.durationBlick,
          pitch: fingerprint.pitch,
          lyrics: fingerprint.lyrics,
          phonemesOverride: fingerprint.phonemesOverride,
          languageOverride: fingerprint.languageOverride,
          detuneCents: fingerprint.detuneCents,
        });
      }
    }
    // 按 indexInGroup 升序固定顺序，保持请求确定性。
    notes.sort((left, right) => left.indexInGroup - right.indexInGroup);
    return notes;
  };
  const curveOf = (operation) => ({
    parameter: operation.parameter,
    mode: operation.mode,
    range: {
      coordinate: operation.range.coordinate,
      fromBlick: operation.range.fromBlick,
      toBlick: operation.range.toBlick,
    },
    points: operation.points.map((point) => ({ blick: point.blick, value: point.value })),
  });
  const planId = `plan_${createHash("sha256")
    .update(
      stableStringify({
        occurrenceId: loaded.occurrence.occurrenceId,
        targetGroupUuid: loaded.occurrence.targetGroupUuid,
        curves: compiled.operations.map(curveOf),
      })
    )
    .digest("hex")
    .slice(0, 16)}`;
  const applyRequests = [];
  for (let callIndex = 0; callIndex < compiled.applyCallCount; callIndex += 1) {
    const callOperations = compiled.operations.filter(
      (operation) => operation.applyCallIndex === callIndex
    );
    const expectedNotes = expectedNotesFor(callOperations);
    applyRequests.push({
      tool: "sv_patch_parameter_curves",
      arguments: {
        target: { ...target, ...(expectedNotes.length > 0 ? { expectedNotes } : {}) },
        curves: callOperations.map(curveOf),
        dryRun: true,
        atomic: true,
        undoLabel: `sv_plan_expression ${planId} (${callIndex + 1}/${compiled.applyCallCount})`,
      },
    });
  }
  const publicGestures = gestures.map((gesture) => ({
    gestureId: gesture.gestureId,
    type: gesture.type,
    source: gesture.source,
    parameter: gesture.parameter,
    unit: PARAMETER_INFO[gesture.parameter].unit,
    writeSurface: "automation",
    noteIds: gesture.noteIds,
    span: {
      fromBlick: gesture.spanFromBlick,
      toBlick: gesture.spanToBlick,
      localFromBlick: gesture.spanFromBlick - loaded.timeOffsetBlick,
      localToBlick: gesture.spanToBlick - loaded.timeOffsetBlick,
    },
    params: gesture.params,
    ...(gesture.reasons.length > 0 ? { reasons: gesture.reasons } : {}),
    ...(gesture.confidence ? { confidence: gesture.confidence } : {}),
  }));
  const operationsMeta = compiled.operations.map((operation) => ({
    parameter: operation.parameter,
    writeSurface: operation.writeSurface,
    unit: operation.unit,
    baselineValue: operation.baselineValue,
    mode: operation.mode,
    range: operation.range,
    pointCount: operation.points.length,
    stats: operation.stats,
    clampedCount: operation.clampedCount,
    fromGestures: operation.fromGestures,
    applyCallIndex: operation.applyCallIndex,
    ...(input.responseMode === "verbose" ? { points: operation.points } : {}),
  }));
  const checklist = [
    "Review every operation's parameter, unit, and value range before applying.",
    "replace mode overwrites existing control points inside each operation range; the planner does not read the host and did not check for existing points (use sv_get_parameter_curve if unsure).",
    "Apply through the returned applyRequests (sv_patch_parameter_curves) with dryRun:true first, then commit each call.",
    "Musical quality is human-only: audition the result; sv_compare_computed_pitch can verify objective pitch changes.",
  ];
  if (applyRequests.length > 1) {
    checklist.push(
      `This plan needs ${applyRequests.length} sequential batch calls (a parameter has multiple disjoint gesture clusters), producing ${applyRequests.length} Undo records instead of one.`
    );
  }
  if (requiresSharedTargetConfirmation) {
    checklist.push(
      "The target NoteGroup is shared by multiple occurrences; commit requires target.allowSharedTargetMutation:true and affects every occurrence."
    );
  }
  return {
    ok: true,
    status: "planned",
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
      sharedTargetOccurrences,
    },
    summary: {
      gestureCount: gestures.length,
      explicitGestureCount: gestures.filter((gesture) => gesture.source === "explicit").length,
      intentGestureCount: gestures.filter((gesture) => gesture.source !== "explicit").length,
      operationCount: compiled.operations.length,
      totalPoints: compiled.totalPoints,
      applyCallCount: applyRequests.length,
      expectedUserUndoSteps: applyRequests.length,
      parameters: [...new Set(compiled.operations.map((operation) => operation.parameter))],
    },
    ...(input.responseMode === "compact"
      ? {}
      : { gestures: publicGestures, operations: operationsMeta }),
    ...(input.presetExpansion ? { presetExpansion: input.presetExpansion } : {}),
    apply: buildApplyEnvelope(applyRequests, { sharedTargetConfirmationRequired: requiresSharedTargetConfirmation }),
    // deprecated：与 apply 内容一致，保留一个接口版本供既有调用方过渡。
    applyRequests,
    review: {
      requiresHumanAudition: true,
      requiresSharedTargetConfirmation,
      replaceOverwritesExistingPoints: true,
      existingPointsChecked: false,
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
    ["contextId", "occurrenceId", "gestures", "intent", "constraints", "sampling", "responseMode"],
    "request"
  );
  if (typeof request.contextId !== "string" || request.contextId.length === 0) {
    throw codedError("INVALID_ARGUMENTS", "contextId must be a non-empty string");
  }
  if (
    request.occurrenceId !== undefined &&
    (typeof request.occurrenceId !== "string" || request.occurrenceId.length === 0)
  ) {
    throw codedError("INVALID_ARGUMENTS", "occurrenceId must be a non-empty string when provided");
  }
  const responseMode = request.responseMode ?? "standard";
  if (!["compact", "standard", "verbose"].includes(responseMode)) {
    throw codedError("INVALID_ARGUMENTS", "responseMode must be compact, standard, or verbose");
  }
  const gestures = normalizeGestureList(request.gestures);
  const { intent, presetExpansion } = normalizeIntent(request.intent);
  if (gestures.length === 0 && !intent) {
    throw codedError("INVALID_ARGUMENTS", "provide gestures, intent, or both");
  }
  const constraints = normalizeConstraints(
    request.constraints,
    presetExpansion?.constraintDefaults ?? null
  );
  const sampling = normalizeSampling(request.sampling);
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
    intent,
    presetExpansion,
    constraints,
    sampling,
    intentDefaults: EXPRESSION_PLAN_DEFAULTS.intent,
    responseMode,
    referencedNoteIds,
  };
}

function normalizeGestureList(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_GESTURES) {
    throw codedError("INVALID_ARGUMENTS", `gestures must be an array of at most ${MAX_GESTURES} items`);
  }
  return value.map((gesture, index) => normalizeGesture(gesture, index));
}

function normalizeGesture(value, index) {
  const label = `gestures[${index}]`;
  if (!isRecord(value)) throw codedError("INVALID_ARGUMENTS", `${label} must be an object`);
  if (!GESTURE_TYPES.includes(value.type)) {
    throw codedError("INVALID_ARGUMENTS", `${label}.type must be one of ${GESTURE_TYPES.join(", ")}`);
  }
  switch (value.type) {
    case "scoop":
    case "fall":
      assertKnownKeys(value, ["type", "noteId", "depthCents", "lengthQuarter", "shapePower"], label);
      requireNoteIdField(value, "noteId", label);
      checkNumber(value.depthCents, 1, 600, `${label}.depthCents`);
      checkNumber(value.lengthQuarter, 0.01, 16, `${label}.lengthQuarter`);
      checkNumber(value.shapePower, 0.5, 8, `${label}.shapePower`);
      return { ...value };
    case "portamento":
      assertKnownKeys(value, ["type", "fromNoteId", "toNoteId", "lengthQuarter", "maxCents"], label);
      requireNoteIdField(value, "fromNoteId", label);
      requireNoteIdField(value, "toNoteId", label);
      checkNumber(value.lengthQuarter, 0.01, 4, `${label}.lengthQuarter`);
      checkNumber(value.maxCents, 10, 1200, `${label}.maxCents`);
      return { ...value };
    case "vibrato":
      assertKnownKeys(
        value,
        [
          "type",
          "noteId",
          "surface",
          "depthCents",
          "rateHz",
          "onsetDelayQuarter",
          "rampQuarter",
          "fadeOutQuarter",
          "level",
        ],
        label
      );
      requireNoteIdField(value, "noteId", label);
      if (value.surface !== undefined && !["pitchDelta", "vibratoEnv"].includes(value.surface)) {
        throw codedError("INVALID_ARGUMENTS", `${label}.surface must be pitchDelta or vibratoEnv`);
      }
      checkNumber(value.depthCents, 1, 600, `${label}.depthCents`);
      checkNumber(value.rateHz, 0.5, 12, `${label}.rateHz`);
      checkNumber(value.onsetDelayQuarter, 0, 16, `${label}.onsetDelayQuarter`);
      checkNumber(value.rampQuarter, 0, 16, `${label}.rampQuarter`);
      checkNumber(value.fadeOutQuarter, 0, 16, `${label}.fadeOutQuarter`);
      checkNumber(value.level, 0, 2, `${label}.level`);
      if (value.surface === "vibratoEnv" && (value.depthCents !== undefined || value.fadeOutQuarter !== undefined)) {
        throw codedError(
          "INVALID_ARGUMENTS",
          `${label}: vibratoEnv surface takes level/onsetDelayQuarter/rampQuarter, not depthCents/fadeOutQuarter`
        );
      }
      return { ...value };
    case "hairpin":
      assertKnownKeys(
        value,
        ["type", "fromNoteId", "toNoteId", "parameter", "amount", "peakPosition"],
        label
      );
      requireNoteIdField(value, "fromNoteId", label);
      requireNoteIdField(value, "toNoteId", label);
      if (value.parameter !== undefined && !HAIRPIN_PARAMETERS.includes(value.parameter)) {
        throw codedError(
          "INVALID_ARGUMENTS",
          `${label}.parameter must be one of ${HAIRPIN_PARAMETERS.join(", ")}`
        );
      }
      if (value.amount !== undefined) {
        const limit = (value.parameter ?? "loudness") === "loudness" ? 24 : 1;
        checkNumber(value.amount, -limit, limit, `${label}.amount`);
        if (value.amount === 0) {
          throw codedError("INVALID_ARGUMENTS", `${label}.amount must be non-zero`);
        }
      }
      checkNumber(value.peakPosition, 0.05, 0.95, `${label}.peakPosition`);
      return { ...value };
    default:
      throw codedError("INVALID_ARGUMENTS", `${label}.type is unsupported`);
  }
}

function normalizeIntent(value) {
  if (value === undefined) return { intent: null, presetExpansion: null };
  if (!isRecord(value)) throw codedError("INVALID_ARGUMENTS", "intent must be an object");
  assertKnownKeys(value, ["preset", "genre", "section", "emotion", "technique"], "intent");
  // preset 展开为普通 intent 字段的常量默认值：用户显式传的同名字段覆盖 preset 值
  //（覆盖情况在 presetExpansion.overriddenFields 中回显，deriveIntentGestures 发警告）。
  let preset = null;
  if (value.preset !== undefined) {
    if (!Object.hasOwn(INTENT_PRESETS, value.preset)) {
      throw codedError(
        "INVALID_ARGUMENTS",
        `intent.preset must be one of ${Object.keys(INTENT_PRESETS).join(", ")}`
      );
    }
    preset = INTENT_PRESETS[value.preset];
  }
  checkEnum(value.genre, INTENT_GENRES, "intent.genre");
  checkEnum(value.section, INTENT_SECTIONS, "intent.section");
  checkEnum(value.emotion, INTENT_EMOTIONS, "intent.emotion");
  let technique;
  if (value.technique !== undefined) {
    if (
      !Array.isArray(value.technique) ||
      value.technique.length > INTENT_TECHNIQUES.length ||
      !value.technique.every((item) => INTENT_TECHNIQUES.includes(item)) ||
      new Set(value.technique).size !== value.technique.length
    ) {
      throw codedError(
        "INVALID_ARGUMENTS",
        `intent.technique must be unique values from ${INTENT_TECHNIQUES.join(", ")}`
      );
    }
    technique = [...value.technique];
  }
  if (
    preset === null &&
    value.genre === undefined &&
    value.section === undefined &&
    value.emotion === undefined &&
    (technique === undefined || technique.length === 0)
  ) {
    throw codedError("INVALID_ARGUMENTS", "intent must contain at least one field");
  }
  if (preset === null) {
    return {
      intent: { genre: value.genre, section: value.section, emotion: value.emotion, technique },
      presetExpansion: null,
    };
  }
  const expandedFields = {};
  const overriddenFields = [];
  const merged = { genre: value.genre, section: value.section, emotion: value.emotion, technique };
  for (const [field, presetValue] of Object.entries(preset.intent)) {
    if (merged[field] === undefined) {
      merged[field] = Array.isArray(presetValue) ? [...presetValue] : presetValue;
      expandedFields[field] = presetValue;
    } else {
      overriddenFields.push({ field, presetValue, userValue: merged[field] });
    }
  }
  return {
    intent: { ...merged, presetSeeds: preset.seeds ?? null, presetName: value.preset },
    presetExpansion: {
      preset: value.preset,
      expandedFields,
      overriddenFields,
      constraintDefaults: preset.constraintDefaults,
      ...(preset.seeds ? { seeds: preset.seeds } : {}),
      notes: preset.notes,
    },
  };
}

function normalizeConstraints(value, presetDefaults = null) {
  // preset 只调低默认值；用户显式传的 constraints 永远优先。
  const defaults = { ...EXPRESSION_PLAN_DEFAULTS.constraints, ...(presetDefaults ?? {}) };
  if (value === undefined) return { ...defaults };
  if (!isRecord(value)) throw codedError("INVALID_ARGUMENTS", "constraints must be an object");
  assertKnownKeys(
    value,
    [
      "maxAbsPitchDeltaCents",
      "maxAbsLoudnessDeltaDb",
      "maxAbsTensionDelta",
      "maxAbsBreathinessDelta",
      "maxTotalPoints",
      "avoidExcessiveVibrato",
    ],
    "constraints"
  );
  if (value.avoidExcessiveVibrato !== undefined && typeof value.avoidExcessiveVibrato !== "boolean") {
    throw codedError("INVALID_ARGUMENTS", "constraints.avoidExcessiveVibrato must be a boolean");
  }
  return {
    maxAbsPitchDeltaCents: checkedNumber(
      value.maxAbsPitchDeltaCents,
      10,
      1200,
      defaults.maxAbsPitchDeltaCents,
      "constraints.maxAbsPitchDeltaCents"
    ),
    maxAbsLoudnessDeltaDb: checkedNumber(
      value.maxAbsLoudnessDeltaDb,
      0.5,
      24,
      defaults.maxAbsLoudnessDeltaDb,
      "constraints.maxAbsLoudnessDeltaDb"
    ),
    maxAbsTensionDelta: checkedNumber(
      value.maxAbsTensionDelta,
      0.05,
      1,
      defaults.maxAbsTensionDelta,
      "constraints.maxAbsTensionDelta"
    ),
    maxAbsBreathinessDelta: checkedNumber(
      value.maxAbsBreathinessDelta,
      0.05,
      1,
      defaults.maxAbsBreathinessDelta,
      "constraints.maxAbsBreathinessDelta"
    ),
    maxTotalPoints: checkedInteger(
      value.maxTotalPoints,
      16,
      MAX_POINTS_PER_CURVE,
      defaults.maxTotalPoints,
      "constraints.maxTotalPoints"
    ),
    avoidExcessiveVibrato: value.avoidExcessiveVibrato ?? defaults.avoidExcessiveVibrato,
  };
}

function normalizeSampling(value) {
  const defaults = EXPRESSION_PLAN_DEFAULTS.sampling;
  if (value === undefined) return { ...defaults };
  if (!isRecord(value)) throw codedError("INVALID_ARGUMENTS", "sampling must be an object");
  assertKnownKeys(value, ["pointsPerQuarter", "vibratoPointsPerCycle"], "sampling");
  return {
    pointsPerQuarter: checkedInteger(
      value.pointsPerQuarter,
      2,
      32,
      defaults.pointsPerQuarter,
      "sampling.pointsPerQuarter"
    ),
    vibratoPointsPerCycle: checkedInteger(
      value.vibratoPointsPerCycle,
      4,
      16,
      defaults.vibratoPointsPerCycle,
      "sampling.vibratoPointsPerCycle"
    ),
  };
}

// ---------- 小工具 ----------

function quartersToBlick(quarters, quarterBlick) {
  return Math.max(1, Math.round(quarters * quarterBlick));
}

function blickToQuarters(blick, quarterBlick) {
  return blick / quarterBlick;
}

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
    throw codedError(
      "INVALID_ARGUMENTS",
      `${label} must be an integer between ${minimum} and ${maximum}`
    );
  }
  return value;
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
