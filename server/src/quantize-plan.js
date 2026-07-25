import { createHash } from "node:crypto";

import { MAX_PATCHES } from "./note-patch.js";
import { ServiceTiming } from "./service-timing.js";

// sv_quantize_notes：无副作用量化规划器（HANDOFF §8.16 "仍未实现"清单项）。
//
// 关键契约：
// - 纯内存只读：只读取 range context 的音符指纹与 meterMarks，不进 ExecutionCoordinator、
//   绝不写宿主。真正落地由调用方把 patchRequest 交给现有 sv_patch_notes（expected
//   前置条件防快照后漂移，冲突检查/Undo/读回/补偿全部复用）。
// - 确定性且不重排：同一 context + 同一请求 → 相同 planId；量化保持原音符顺序，两音符
//   落同一格时后者保留原位（QUANTIZE_COLLISION），不自作主张挪半格。
// - 不做 humanize：随机微时移与确定性规划器契约冲突，明确不提供。
// - 网格以小节边界为原点（拍号变化处重锚），swing 只对直分网格有意义（三连音 + swing
//   直接拒绝）。"br" 换气音符照常量化——它有时值位置，不属于"无音高"排除范畴。
export const QUANTIZE_DIVISIONS = Object.freeze(["1/4", "1/8", "1/16", "1/32", "1/8T", "1/16T"]);

// 每 division 对应的每拍格数（step = quarterBlick * 4 / denominatorUnits）。
// 直接以四分音符为基准：1/4=1 格/拍，1/8T=3 格/拍（三连音）。
const DIVISION_STEPS_PER_QUARTER = Object.freeze({
  "1/4": 1,
  "1/8": 2,
  "1/16": 4,
  "1/32": 8,
  "1/8T": 3,
  "1/16T": 6,
});
const TRIPLET_DIVISIONS = new Set(["1/8T", "1/16T"]);
const MAX_LIST_ITEMS = 100;
const MAX_CONTINUATION_IDENTITIES = 256;

const PROVENANCE = Object.freeze({
  planner: "deterministic_grid_quantizer",
  gridOrigin: "bar_boundaries_from_meter_marks",
  humanize: "not_provided_conflicts_with_deterministic_planner_contract",
  breathNotes: "quantized_like_any_timed_note",
  basis: "derived_not_host_fact",
  perception: "human_only",
});

export class QuantizePlanService {
  constructor({ store, now = () => Date.now() } = {}) {
    if (!store) throw new Error("QuantizePlanService requires the shared SnapshotStore");
    this.store = store;
    this.now = now;
    this.continuationIdentities = new Map();
  }

  async plan(request = {}) {
    const timer = new ServiceTiming({ now: this.now, phaseNames: ["loadMs", "quantizeMs"] });
    const input = normalizeQuantizeRequest(request);
    // 纯内存服务：不进入协调器；coordinatorQueueMs/operationMs 恒 0，如实报告。
    timer.requestCoordinator();
    const warnings = [];
    pruneContinuationIdentities(this.continuationIdentities, this.now());
    const loaded = await timer.measure("loadMs", async () =>
      resolveQuantizeSource(this.store, input, warnings, this.continuationIdentities)
    );
    const planned = await timer.measure("quantizeMs", async () =>
      quantizeNotes(loaded, input, warnings)
    );
    const response = buildQuantizeResponse(loaded, input, planned, warnings, timer.finish());
    if (response.continuation && typeof input.occurrenceId === "string") {
      rememberContinuationIdentity(this.continuationIdentities, loaded, input, this.now());
    }
    return response;
  }
}

// ---------- 上下文解析 ----------

const OCCURRENCE_POSITION_PATTERN = /:t:(\d+):r:(\d+)$/;

function resolveQuantizeSource(store, input, warnings, continuationIdentities) {
  const stored = store.get(input.contextId);
  if (!stored) {
    throw codedError("UNKNOWN_CONTEXT", "contextId not found or expired; re-run sv_snapshot_range");
  }
  if (stored.context?.kind !== "range") {
    throw codedError(
      "INVALID_CONTEXT",
      'sv_quantize_notes needs a range context from sv_snapshot_range with include ["notes"]'
    );
  }
  const occurrences = Array.isArray(stored.context.occurrences) ? stored.context.occurrences : [];
  const candidates = occurrences.filter(
    (item) => Array.isArray(item.noteFingerprints) && item.noteFingerprints.length > 0
  );
  // noteId 前缀（去掉 :n:Z）即 occurrenceId，与 sv_patch_notes 一致。
  const derived = new Set();
  for (const noteId of input.noteIds ?? []) {
    const cut = noteId.lastIndexOf(":n:");
    if (cut > 0) derived.add(noteId.slice(0, cut));
  }
  if (derived.size > 1) {
    throw codedError("INVALID_NOTE_ID", "all noteIds must belong to the same range occurrence");
  }
  const derivedId = derived.size === 1 ? derived.values().next().value : undefined;
  if (input.occurrenceId !== undefined && derivedId !== undefined && input.occurrenceId !== derivedId) {
    throw codedError("INVALID_NOTE_ID", "noteIds belong to a different occurrence than occurrenceId");
  }
  const wantedId = input.occurrenceId ?? derivedId;
  let occurrence = null;
  if (wantedId !== undefined) {
    occurrence = occurrences.find((item) => item.occurrenceId === wantedId) ?? null;
    if (!occurrence && input.occurrenceId !== undefined && derivedId === undefined) {
      // continuation 重锚定：selector 内嵌旧 contextId 时按位置后缀寻找候选，
      // 但必须通过服务签发的短期身份记录校验 target UUID——量化会改变音符结构，
      // 结构摘要在这里不可用（与 lyric-align 不同），身份只看组 UUID。
      const identity = continuationIdentities.get(wantedId);
      const position = identity ? OCCURRENCE_POSITION_PATTERN.exec(wantedId) : null;
      if (position) {
        const matches = occurrences.filter((item) => {
          const own = OCCURRENCE_POSITION_PATTERN.exec(item.occurrenceId);
          return own !== null && own[1] === position[1] && own[2] === position[2];
        });
        if (matches.length === 1) {
          if (matches[0].targetGroupUuid !== identity.targetGroupUuid) {
            const error = codedError(
              "STALE_CONTEXT",
              `continuation selector target changed: expected group UUID ${identity.targetGroupUuid}, observed ${matches[0].targetGroupUuid}; re-snapshot and re-plan`
            );
            error.expectedGroupUuid = identity.targetGroupUuid;
            error.observedGroupUuid = matches[0].targetGroupUuid;
            throw error;
          }
          occurrence = matches[0];
          warnings.push({
            code: "STALE_SELECTOR_REANCHORED",
            message: `occurrenceId references a consumed context; verified target identity, then re-anchored by position (track ${position[1]}, reference ${position[2]}) onto ${occurrence.occurrenceId}.`,
          });
        }
      }
    }
    if (!occurrence) {
      throw codedError("UNKNOWN_OCCURRENCE", "occurrenceId is not part of the supplied contextId");
    }
  } else if (candidates.length === 1) {
    occurrence = candidates[0];
  } else if (candidates.length === 0) {
    throw codedError(
      "NOTES_NOT_CAPTURED",
      'sv_quantize_notes needs note fingerprints; re-run sv_snapshot_range with include ["notes"]'
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
  const quarterBlick = stored.context.quarterBlick;
  if (!Number.isSafeInteger(quarterBlick) || quarterBlick <= 0) {
    throw codedError("INVALID_CONTEXT", "context is missing a usable SV.QUARTER timebase");
  }
  const meterMarks = stored.context.meterMarks;
  if (!Array.isArray(meterMarks) || meterMarks.length === 0) {
    throw codedError(
      "INVALID_CONTEXT",
      'sv_quantize_notes needs meter marks; re-run sv_snapshot_range (they are captured automatically)'
    );
  }
  const timeOffset = occurrence.timeOffsetBlick ?? 0;
  const allNotes = [...(occurrence.noteFingerprints ?? [])]
    .map((fingerprint) => ({
      noteId: fingerprint.noteId,
      indexInGroup: fingerprint.indexInGroup,
      lyrics: fingerprint.lyrics,
      localOnsetBlick: fingerprint.onsetBlick,
      absOnsetBlick: timeOffset + fingerprint.onsetBlick,
      durationBlick: fingerprint.durationBlick,
    }))
    .sort((left, right) => left.absOnsetBlick - right.absOnsetBlick);
  if (allNotes.length === 0) {
    throw codedError(
      "NOTES_NOT_CAPTURED",
      'the selected occurrence has no note fingerprints; re-run sv_snapshot_range with include ["notes"]'
    );
  }
  let notes = allNotes;
  if (input.noteIds !== undefined) {
    const wanted = new Set(input.noteIds);
    notes = allNotes.filter((note) => wanted.has(note.noteId));
    if (notes.length !== wanted.size) {
      const missing = input.noteIds.find((noteId) => !allNotes.some((note) => note.noteId === noteId));
      throw codedError("UNKNOWN_NOTE_ID", `noteId is not part of the resolved occurrence: ${missing}`);
    }
  }
  return { stored, occurrence, notes, quarterBlick, meterMarks, timeOffsetBlick: timeOffset };
}

function pruneContinuationIdentities(identities, now) {
  for (const [key, identity] of identities) {
    if (identity.expiresAt <= now) identities.delete(key);
  }
}

function rememberContinuationIdentity(identities, loaded, input, now) {
  if (typeof loaded.occurrence.targetGroupUuid !== "string") return;
  const expiresAt = loaded.stored.expiresAt;
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return;
  identities.delete(input.occurrenceId);
  identities.set(input.occurrenceId, {
    targetGroupUuid: loaded.occurrence.targetGroupUuid,
    expiresAt,
  });
  while (identities.size > MAX_CONTINUATION_IDENTITIES) {
    identities.delete(identities.keys().next().value);
  }
}

// ---------- 量化 ----------

function quantizeNotes(loaded, input, warnings) {
  const stepsPerQuarter = DIVISION_STEPS_PER_QUARTER[input.grid.division];
  const perNote = loaded.notes.map((note) => {
    const grid = gridContextAt(note.absOnsetBlick, loaded.meterMarks, loaded.quarterBlick);
    const step = grid.barLengthBlick / grid.stepsPerBar(stepsPerQuarter);
    const offset = note.absOnsetBlick - grid.barStartBlick;
    const gridIndex = Math.round(offset / step);
    let target = grid.barStartBlick + gridIndex * step;
    // swing：小节内奇数格后移 swing × 半格（直分网格；三连音在入参校验已拒绝）。
    if (input.swing > 0 && gridIndex % 2 === 1) {
      target += (input.swing * step) / 2;
    }
    // strength：原位置向网格目标线性插值（1 = 完全吸附）。
    const plannedAbs = Math.max(0, Math.round(note.absOnsetBlick + input.strength * (target - note.absOnsetBlick)));
    let plannedDuration = note.durationBlick;
    if (input.quantizeDurations) {
      plannedDuration = Math.max(Math.round(step), Math.round(note.durationBlick / step) * Math.round(step));
    }
    return {
      note,
      gridIndex,
      stepBlick: Math.round(step),
      plannedAbsOnsetBlick: plannedAbs,
      plannedDurationBlick: plannedDuration,
      onsetReverted: false,
      revertReason: null,
    };
  });

  // 碰撞检查：保持原顺序，落到不大于前一音符规划 onset 的目标保留原位。
  let previousOnset = -Infinity;
  for (const item of perNote) {
    if (item.plannedAbsOnsetBlick <= previousOnset) {
      if (item.note.absOnsetBlick > previousOnset) {
        item.plannedAbsOnsetBlick = item.note.absOnsetBlick;
        item.onsetReverted = true;
        item.revertReason = "collision";
        appendOnce(warnings, {
          code: "QUANTIZE_COLLISION",
          message:
            "two or more notes quantize onto the same grid position; later notes keep their original onset instead of being nudged (deterministic, no half-step guessing).",
        });
      }
      // 原位仍然冲突（原本就重叠/同位）：保持现状，不是量化引入的问题。
    }
    previousOnset = Math.max(previousOnset, item.plannedAbsOnsetBlick);
  }

  // 重叠检查：量化把前音推进后音、或把后音拉进前音时，撤销引入重叠的 onset 变更
  // （quantizeDurations:true 时优先收短前音时值）。快照时已存在的重叠不动。
  for (let index = 0; index + 1 < perNote.length; index += 1) {
    const current = perNote[index];
    const next = perNote[index + 1];
    const plannedEnd = current.plannedAbsOnsetBlick + current.plannedDurationBlick;
    if (plannedEnd <= next.plannedAbsOnsetBlick) continue;
    const originalEnd = current.note.absOnsetBlick + current.note.durationBlick;
    const preExisting = originalEnd > next.note.absOnsetBlick;
    if (preExisting) continue;
    if (input.quantizeDurations) {
      current.plannedDurationBlick = Math.max(1, next.plannedAbsOnsetBlick - current.plannedAbsOnsetBlick);
      continue;
    }
    // 谁的移动引入了重叠就撤销谁：后音左移优先撤销，其次前音右移。
    if (next.plannedAbsOnsetBlick < next.note.absOnsetBlick) {
      next.plannedAbsOnsetBlick = next.note.absOnsetBlick;
      next.onsetReverted = true;
      next.revertReason = "overlap";
    } else {
      current.plannedAbsOnsetBlick = current.note.absOnsetBlick;
      current.onsetReverted = true;
      current.revertReason = "overlap";
    }
    appendOnce(warnings, {
      code: "OVERLAP_AFTER_QUANTIZE",
      message:
        "quantizing would overlap adjacent notes; the onset change that introduced the overlap was reverted (set quantizeDurations:true to trim durations instead).",
    });
  }

  for (const item of perNote) {
    item.changedOnset = item.plannedAbsOnsetBlick !== item.note.absOnsetBlick;
    item.changedDuration = item.plannedDurationBlick !== item.note.durationBlick;
    item.changed = item.changedOnset || item.changedDuration;
    item.deltaBlick = item.plannedAbsOnsetBlick - item.note.absOnsetBlick;
  }
  return perNote;
}

// 定位包含 absBlick 的小节：拍号变化处网格重锚。
function gridContextAt(absBlick, meterMarks, quarterBlick) {
  let active = meterMarks[0];
  for (const mark of meterMarks) {
    if (mark.positionBlick <= absBlick) active = mark;
    else break;
  }
  const wholeBlick = quarterBlick * 4;
  const barLengthBlick = (active.numerator * wholeBlick) / active.denominator;
  const barsIntoSegment = Math.floor((absBlick - active.positionBlick) / barLengthBlick);
  return {
    barStartBlick: active.positionBlick + barsIntoSegment * barLengthBlick,
    barLengthBlick,
    // 每小节格数 = 拍数(以四分音符计) × 每拍格数 = numerator*4/denominator × stepsPerQuarter。
    stepsPerBar: (stepsPerQuarter) => Math.max(1, Math.round((active.numerator * 4 * stepsPerQuarter) / active.denominator)),
  };
}

// ---------- 响应组装 ----------

function buildQuantizeResponse(loaded, input, planned, warnings, timings) {
  const changed = planned.filter((item) => item.changed);
  const patches = changed.map((item) => ({
    noteId: item.note.noteId,
    // expected 前置条件用组内本地坐标（sv_patch_notes 的 onsetBlick 语义）。
    expected: {
      onsetBlick: item.note.localOnsetBlick,
      durationBlick: item.note.durationBlick,
    },
    set: {
      ...(item.changedOnset
        ? { onsetBlick: item.plannedAbsOnsetBlick - loaded.timeOffsetBlick }
        : {}),
      ...(item.changedDuration ? { durationBlick: item.plannedDurationBlick } : {}),
    },
  }));
  // 与 sv_align_lyrics 相同的 continuation 契约：提交成功使 contextId 失效且 noteId 内嵌
  // contextId，后续批次无法预生成——只交出第一批，其余通过"commit → 重拍快照 → 同参重跑"
  // 收敛（已量化音符自动 no-change）。
  const submittable = patches.slice(0, MAX_PATCHES);
  const remainingChangedCount = patches.length - submittable.length;
  const patchRequest =
    submittable.length > 0
      ? {
          tool: "sv_patch_notes",
          arguments: {
            contextId: loaded.stored.contextId,
            patches: submittable,
            dryRun: true,
            atomic: true,
          },
        }
      : null;
  const continuation =
    remainingChangedCount > 0
      ? {
          reason: "PATCH_CAP",
          patchCapPerCall: MAX_PATCHES,
          remainingChangedCount,
          workflow: [
            "Commit the returned patchRequest (dryRun first, then dryRun:false).",
            "A successful commit invalidates this contextId, so re-run sv_snapshot_range over the same range for a fresh context.",
            "Re-run sv_quantize_notes with the same grid/strength/swing options against the fresh contextId: already-quantized notes come back unchanged, so the next round plans exactly the remaining patches. An explicit occurrenceId is re-anchored only while its short-lived continuation identity proves the same target group UUID (warned as STALE_SELECTOR_REANCHORED); otherwise the replay is rejected.",
            "Repeat until the response carries no continuation (or reports status no_change).",
          ],
        }
      : null;
  if (continuation) {
    warnings.push({
      code: "PLAN_EXCEEDS_PATCH_CAP",
      message: `${patches.length} note patches exceed the ${MAX_PATCHES}-patch per-call cap; patchRequest carries the first ${submittable.length} and ${remainingChangedCount} remain. Follow continuation.workflow: commit, re-snapshot, re-quantize with identical options. Each round is its own transaction and Undo record.`,
    });
  }
  const planId = `qnt_${createHash("sha256")
    .update(
      stableStringify({
        occurrenceId: loaded.occurrence.occurrenceId,
        grid: input.grid,
        strength: input.strength,
        swing: input.swing,
        quantizeDurations: input.quantizeDurations,
        patches,
      })
    )
    .digest("hex")
    .slice(0, 16)}`;
  const revertedCount = planned.filter((item) => item.onsetReverted).length;
  const cap = input.responseMode === "verbose" ? planned.length : MAX_LIST_ITEMS;
  if (input.responseMode !== "compact" && planned.length > cap) {
    warnings.push({
      code: "PER_NOTE_TRUNCATED",
      message: `perNote reports the first ${cap} of ${planned.length} notes; use responseMode:"verbose" for the full list. Summary counts always cover all notes.`,
    });
  }
  const checklist = [
    "Review perNote deltas; quantization is a deterministic grid snap, not a musical judgment (no humanize is provided).",
    "Apply through the returned patchRequest (sv_patch_notes) with dryRun:true first, then commit; expected onset/duration preconditions guard against post-snapshot drift.",
  ];
  if (revertedCount > 0) {
    checklist.push(
      `${revertedCount} note(s) kept their original onset (grid collision or introduced overlap); resolve them manually if the grid position matters.`
    );
  }
  if (continuation) {
    checklist.push(
      `${remainingChangedCount} change(s) do not fit this call (${MAX_PATCHES}-patch cap): after committing, re-snapshot the same range and re-run sv_quantize_notes with identical options — the loop converges to no_change.`
    );
  }
  return {
    ok: true,
    status: patchRequest ? "planned" : "no_change",
    dryRun: true,
    effects: "none",
    planId,
    contextId: loaded.stored.contextId,
    occurrence: {
      occurrenceId: loaded.occurrence.occurrenceId,
      trackIndex: loaded.occurrence.trackIndex,
      groupIndex: loaded.occurrence.groupIndex,
      targetGroupUuid: loaded.occurrence.targetGroupUuid,
    },
    grid: {
      division: input.grid.division,
      strength: input.strength,
      swing: input.swing,
      quantizeDurations: input.quantizeDurations,
      origin: "bar_boundaries",
    },
    summary: {
      noteCount: planned.length,
      changedCount: changed.length,
      changedOnsets: planned.filter((item) => item.changedOnset).length,
      changedDurations: planned.filter((item) => item.changedDuration).length,
      revertedCount,
      maxAbsDeltaBlick: planned.reduce((max, item) => Math.max(max, Math.abs(item.deltaBlick)), 0),
    },
    ...(input.responseMode === "compact"
      ? {}
      : {
          perNote: planned.slice(0, cap).map((item) => ({
            noteId: item.note.noteId,
            lyrics: item.note.lyrics,
            originalOnsetBlick: item.note.absOnsetBlick,
            plannedOnsetBlick: item.plannedAbsOnsetBlick,
            deltaBlick: item.deltaBlick,
            ...(input.quantizeDurations
              ? {
                  originalDurationBlick: item.note.durationBlick,
                  plannedDurationBlick: item.plannedDurationBlick,
                }
              : {}),
            gridIndex: item.gridIndex,
            changed: item.changed,
            ...(item.onsetReverted ? { onsetReverted: true, revertReason: item.revertReason } : {}),
          })),
          perNoteTruncated: planned.length > cap,
        }),
    patchRequest,
    ...(continuation ? { continuation } : {}),
    review: { requiresHumanReview: revertedCount > 0, checklist },
    provenance: PROVENANCE,
    warnings,
    timings,
  };
}

// ---------- 请求校验 ----------

function normalizeQuantizeRequest(request) {
  if (!isRecord(request)) throw codedError("INVALID_ARGUMENTS", "request must be an object");
  assertKnownKeys(
    request,
    ["contextId", "occurrenceId", "noteIds", "grid", "strength", "swing", "quantizeDurations", "responseMode"],
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
  if (request.noteIds !== undefined) {
    if (
      !Array.isArray(request.noteIds) ||
      request.noteIds.length === 0 ||
      request.noteIds.length > MAX_PATCHES ||
      !request.noteIds.every((noteId) => typeof noteId === "string" && noteId.length > 0) ||
      new Set(request.noteIds).size !== request.noteIds.length
    ) {
      throw codedError(
        "INVALID_ARGUMENTS",
        `noteIds must be 1-${MAX_PATCHES} unique non-empty strings (a subset within the patch cap never needs continuation)`
      );
    }
  }
  if (!isRecord(request.grid)) throw codedError("INVALID_ARGUMENTS", "grid must be an object");
  assertKnownKeys(request.grid, ["division"], "grid");
  if (!QUANTIZE_DIVISIONS.includes(request.grid.division)) {
    throw codedError("INVALID_ARGUMENTS", `grid.division must be one of ${QUANTIZE_DIVISIONS.join(", ")}`);
  }
  const strength = request.strength ?? 1;
  if (!Number.isFinite(strength) || strength <= 0 || strength > 1) {
    throw codedError("INVALID_ARGUMENTS", "strength must be a number in (0, 1]");
  }
  const swing = request.swing ?? 0;
  if (!Number.isFinite(swing) || swing < 0 || swing > 1) {
    throw codedError("INVALID_ARGUMENTS", "swing must be a number in [0, 1]");
  }
  if (swing > 0 && TRIPLET_DIVISIONS.has(request.grid.division)) {
    throw codedError(
      "INVALID_ARGUMENTS",
      "swing only applies to straight divisions; triplet grids already imply the swung feel"
    );
  }
  if (request.quantizeDurations !== undefined && typeof request.quantizeDurations !== "boolean") {
    throw codedError("INVALID_ARGUMENTS", "quantizeDurations must be a boolean");
  }
  const responseMode = request.responseMode ?? "standard";
  if (!["compact", "standard", "verbose"].includes(responseMode)) {
    throw codedError("INVALID_ARGUMENTS", "responseMode must be compact, standard, or verbose");
  }
  return {
    contextId: request.contextId,
    occurrenceId: request.occurrenceId,
    noteIds: request.noteIds,
    grid: { division: request.grid.division },
    strength,
    swing,
    quantizeDurations: request.quantizeDurations ?? false,
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
