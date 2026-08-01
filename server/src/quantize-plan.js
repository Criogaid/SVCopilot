import { canonicalHashHex } from "./canonical-json.js";
import { artifactReference, planReference } from "./artifact-store.js";
import { buildPlanArtifact, buildPlanContextSnapshot } from "./plan-reference.js";

import { MAX_PATCHES } from "./note-patch.js";
import { buildApplyEnvelope } from "./plan-envelope.js";
import { selectOccurrenceByOrdinal } from "./scope-source.js";
import { ServiceTiming } from "./service-timing.js";
import { unknownContextError } from "./snapshot.js";

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
  constructor({ store, now = () => Date.now(), artifactStore = null, sessionId = null } = {}) {
    if (!store) throw new Error("QuantizePlanService requires the shared SnapshotStore");
    this.store = store;
    this.now = now;
    this.artifactStore = artifactStore;
    this.sessionId = sessionId;
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
    const response = buildQuantizeResponse(
      loaded,
      input,
      planned,
      warnings,
      timer.finish(),
      this.artifactStore,
      this.sessionId
    );
    if (response.continuation) {
      rememberContinuationIdentity(this.continuationIdentities, loaded, input, this.now());
    }
    return response;
  }
}

// ---------- 上下文解析 ----------

function resolveQuantizeSource(store, input, warnings, continuationIdentities) {
  const stored = store.get(input.contextId);
  if (!stored) {
    throw unknownContextError(store, input.contextId);
  }
  if (stored.context?.kind !== "range") {
    throw codedError(
      "INVALID_CONTEXT",
      'sv_quantize_notes needs a range context from sv_snapshot_range with include ["notes"]'
    );
  }
  const { occurrence, ordinal } = selectOccurrenceByOrdinal(
    stored.context.occurrences,
    input.occurrence,
    {
      eligible: (item) =>
        Array.isArray(item.noteFingerprints) && item.noteFingerprints.length > 0,
      noneCode: "NOTES_NOT_CAPTURED",
      noneMessage:
        'sv_quantize_notes needs note fingerprints; re-run sv_snapshot_range with include ["notes"]',
      ambiguousMessage:
        "range context has multiple occurrences with notes; pass one occurrence ordinal",
      ineligibleCode: "OCCURRENCE_NOT_CAPTURED",
      ineligibleMessage:
        'the selected occurrence has no note fingerprints; re-run sv_snapshot_range with include ["notes"]',
    }
  );
  const identity = continuationIdentities.get(continuationIdentityKey(occurrence));
  if (identity && identity.contextId !== stored.contextId) {
    if (occurrence.targetGroupUuid !== identity.targetGroupUuid) {
      const error = codedError(
        "STALE_CONTEXT",
        `continuation target changed: expected group UUID ${identity.targetGroupUuid}, observed ${occurrence.targetGroupUuid}; re-snapshot and re-plan`
      );
      error.expectedGroupUuid = identity.targetGroupUuid;
      error.observedGroupUuid = occurrence.targetGroupUuid;
      throw error;
    }
    warnings.push({
      code: "CONTINUATION_IDENTITY_VERIFIED",
      message: `Continuation target was re-captured at occurrence ${ordinal}; target identity still matches.`,
    });
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
  if (input.notes !== undefined) {
    const wanted = new Set(input.notes);
    notes = allNotes.filter((note) => wanted.has(note.indexInGroup));
    if (notes.length !== wanted.size) {
      const groupNoteCount = occurrence.groupNoteCount ?? allNotes.length;
      const missing = input.notes.find(
        (index) => !allNotes.some((note) => note.indexInGroup === index)
      );
      if (missing >= groupNoteCount) {
        throw codedError("NOTE_INDEX_OUT_OF_RANGE", `note index ${missing} is outside the note group`, {
          got: missing,
          max: groupNoteCount - 1,
        });
      }
      throw codedError(
        "NOTE_NOT_IN_CONTEXT",
        `note ${missing} exists but was not captured in this occurrence`,
        { got: missing }
      );
    }
  }
  return {
    stored,
    occurrence,
    occurrenceOrdinal: ordinal,
    notes,
    quarterBlick,
    meterMarks,
    timeOffsetBlick: timeOffset,
  };
}

function continuationIdentityKey(occurrence) {
  return JSON.stringify([occurrence?.trackIndex ?? null, occurrence?.groupIndex ?? null]);
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
  const key = continuationIdentityKey(loaded.occurrence);
  identities.delete(key);
  identities.set(key, {
    targetGroupUuid: loaded.occurrence.targetGroupUuid,
    contextId: loaded.stored.contextId,
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

  // onset 回退会改变相邻两侧的关系，因此循环到稳定状态；每轮只会回退尚未回退的
  // onset 或缩短时值，状态单调收敛。快照时已存在的重叠保持不动。
  let overlapAdjusted;
  do {
    overlapAdjusted = false;
    for (let index = 0; index + 1 < perNote.length; index += 1) {
      const current = perNote[index];
      const next = perNote[index + 1];
      const plannedEnd = current.plannedAbsOnsetBlick + current.plannedDurationBlick;
      if (plannedEnd <= next.plannedAbsOnsetBlick) continue;
      const originalEnd = current.note.absOnsetBlick + current.note.durationBlick;
      const preExisting = originalEnd > next.note.absOnsetBlick;
      if (preExisting) continue;
      if (input.quantizeDurations) {
        const trimmedDuration = Math.max(
          1,
          next.plannedAbsOnsetBlick - current.plannedAbsOnsetBlick
        );
        if (trimmedDuration !== current.plannedDurationBlick) {
          current.plannedDurationBlick = trimmedDuration;
          overlapAdjusted = true;
        }
        continue;
      }
      // 后音左移优先撤销；若前音同时右移，必须在后音回到原位后重新检查并一并撤销。
      if (next.plannedAbsOnsetBlick < next.note.absOnsetBlick) {
        next.plannedAbsOnsetBlick = next.note.absOnsetBlick;
        next.onsetReverted = true;
        next.revertReason = "overlap";
        overlapAdjusted = true;
      }
      if (
        current.plannedAbsOnsetBlick + current.plannedDurationBlick >
          next.plannedAbsOnsetBlick &&
        current.plannedAbsOnsetBlick > current.note.absOnsetBlick
      ) {
        current.plannedAbsOnsetBlick = current.note.absOnsetBlick;
        current.onsetReverted = true;
        current.revertReason = "overlap";
        overlapAdjusted = true;
      }
      appendOnce(warnings, {
        code: "OVERLAP_AFTER_QUANTIZE",
        message:
          "quantizing would overlap adjacent notes; every onset change contributing to the overlap was reverted (set quantizeDurations:true to trim durations instead).",
      });
    }
  } while (overlapAdjusted);

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

function buildQuantizeResponse(loaded, input, planned, warnings, timings, artifactStore, sessionId) {
  const changed = planned.filter((item) => item.changed);
  const patches = changed.map((item) => ({
    // sv_patch_notes 的身份是组内 index（§3.1）。
    note: item.note.indexInGroup,
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
  // 与 sv_align_lyrics 相同的 continuation 契约：提交成功使 contextId 失效，因此后续批次
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
            occurrence: loaded.occurrenceOrdinal,
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
            "Re-run sv_quantize_notes with the same grid/strength/swing options against the fresh contextId and its current occurrence ordinal: already-quantized notes come back unchanged, so the next round plans exactly the remaining patches. The short-lived continuation identity verifies the target UUID before planning the next slice.",
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
  const planId = `qnt_${canonicalHashHex({
    occurrence: loaded.occurrenceOrdinal,
    grid: input.grid,
    strength: input.strength,
    swing: input.swing,
    quantizeDurations: input.quantizeDurations,
    patches,
  }).slice(0, 16)}`;
  const revertedCount = planned.filter((item) => item.onsetReverted).length;
  // 共享 target 的写入会同时改变所有 occurrence；规划阶段就如实声明。
  const requiresSharedTargetConfirmation =
    (loaded.occurrence.sharedTargetOccurrences ?? []).length > 1;
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
  if (requiresSharedTargetConfirmation) {
    checklist.push(
      "The target NoteGroup is shared by multiple occurrences: committing changes every one of them and requires allowSharedTargetMutation:true."
    );
  }
  if (continuation) {
    checklist.push(
      `${remainingChangedCount} change(s) do not fit this call (${MAX_PATCHES}-patch cap): after committing, re-snapshot the same range and re-run sv_quantize_notes with identical options — the loop converges to no_change.`
    );
  }
  let planArtifactRef = null;
  let planExpiresAt = null;
  if (input.usePlanRef && artifactStore && sessionId && patchRequest) {
    try {
      const { payload } = buildPlanArtifact({
          targetTool: "sv_patch_notes",
          mutationRequest: patchRequest.arguments,
          targetGroupUuid: loaded.occurrence.targetGroupUuid,
          occurrence: loaded.occurrenceOrdinal,
          fingerprints: {},
          contextSnapshot: buildPlanContextSnapshot(loaded.stored, loaded.occurrence, {
            noteIndexes: submittable.map((patch) => patch.note),
          }),
      });
      const planArtifact = artifactStore.seal({
        kind: "plan",
        schemaVersion: "1",
        sessionId,
        sourceEpoch: loaded.stored.epoch,
        payload,
      });
      planArtifactRef = planReference(planArtifact);
      planExpiresAt = planArtifact.expiresAt;
    } catch (error) {
      warnings.push({
        code: "ARTIFACT_SEAL_FAILED",
        message: `Failed to seal quantize plan artifact: ${error.message}`,
      });
    }
  }

  const applyEnvelope = buildApplyEnvelope(patchRequest ? [patchRequest] : null, {
    sharedTargetConfirmationRequired: requiresSharedTargetConfirmation,
  });
  if (planArtifactRef && applyEnvelope?.arguments) {
    applyEnvelope.arguments = { planRef: planArtifactRef, action: "dry_run" };
    applyEnvelope.expiresAt = planExpiresAt;
  }

  return {
    ok: true,
    status: patchRequest ? "planned" : "no_change",
    dryRun: true,
    effects: "none",
    planId,
    contextId: loaded.stored.contextId,
    occurrence: {
      occurrence: loaded.occurrenceOrdinal,
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
            note: item.note.indexInGroup,
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
    apply: applyEnvelope,
    ...(planArtifactRef ? {} : { patchRequest }),
    ...(continuation ? { continuation } : {}),
    review: { requiresHumanReview: revertedCount > 0, requiresSharedTargetConfirmation, checklist },
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
    ["contextId", "occurrence", "notes", "grid", "strength", "swing", "quantizeDurations", "responseMode", "usePlanRef"],
    "request"
  );
  if (typeof request.contextId !== "string" || request.contextId.length === 0) {
    throw codedError("INVALID_ARGUMENTS", "contextId must be a non-empty string");
  }
  if (
    request.occurrence !== undefined &&
    (!Number.isSafeInteger(request.occurrence) || request.occurrence < 0)
  ) {
    throw codedError("INVALID_ARGUMENTS", "occurrence must be a non-negative safe integer");
  }
  if (request.notes !== undefined) {
    if (
      !Array.isArray(request.notes) ||
      request.notes.length === 0 ||
      request.notes.length > MAX_PATCHES ||
      !request.notes.every((index) => Number.isSafeInteger(index) && index >= 0) ||
      new Set(request.notes).size !== request.notes.length
    ) {
      throw codedError(
        "INVALID_ARGUMENTS",
        `notes must be 1-${MAX_PATCHES} unique non-negative indexes (a subset within the patch cap never needs continuation)`
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
    occurrence: request.occurrence,
    notes: request.notes,
    grid: { division: request.grid.division },
    strength,
    swing,
    quantizeDurations: request.quantizeDurations ?? false,
    responseMode,
    usePlanRef: request.usePlanRef !== false,
  };
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
