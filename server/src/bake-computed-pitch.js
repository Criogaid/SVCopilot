import { getStoredComputedPitch } from "./musical-range.js";
import { codedError, isRecord } from "./pitch-control.js";
import { ServiceTiming } from "./service-timing.js";
import { selectOccurrenceByOrdinal } from "./scope-source.js";
import { dryRunFromAction } from "./mutation-action.js";

// sv_bake_computed_pitch —— 把宿主 computed pitch 显式固化为一条 SVCopilot 自有的
// PitchControlCurve（主计划 P1-C Phase 4）。
//
// 安全契约：
// - 覆盖不足 / 全 null / 空数组 / 采样身份不匹配一律零写入（INSUFFICIENT_COMPUTED_PITCH）。
//   全 null 绝不解释为零音高、已完成或可 bake 数据。
// - 写面复用 sv_patch_pitch_controls 事务核（预检 / 一个 Undo / 读回 / 逆序补偿），本模块
//   只负责"算"与"编排"，不重实现事务。一次调用 = 一个事务，不用循环伪装。
// - 坐标换算：computed pitch 是绝对(sounding) MIDI，curve 需要 group-relative semitone
//   （groupRelative = absolute - pitchOffsetSemitone）；frame 绝对 BLICK 转 group-local
//   （local = absolute - timeOffsetBlick）。anchor 取首个有效帧，points 相对 anchor。
// - 确定性简化（Ramer-Douglas-Peucker）：保留端点与有效区间边界，拟合误差 ≤ tolerance，
//   不用固定 BLICK 间隔遍历巨大范围；报告 maxFitError 与 coverage。
// - 既有 pitchDelta 默认保留（preserve）。clear 需要 PitchControl + Automation 跨类型
//   journal/Undo/rollback，本版显式拒绝（PITCH_DELTA_CLEAR_UNSUPPORTED）而不是静默忽略。

export const BAKE_STRATEGIES = Object.freeze(["preserve_existing", "replace_owned", "replace_explicit"]);
const DEFAULT_COVERAGE_THRESHOLD = 0.8;
const DEFAULT_TOLERANCE_SEMITONE = 0.05; // 5 cents
const MAX_BAKE_POINTS = 400;

const PROVENANCE = Object.freeze({
  baker: "deterministic_computed_pitch_bake",
  simplification: "ramer_douglas_peucker_bounded",
  hostWriteSurfaces: Object.freeze(["pitchControl"]),
  perception: "human_only",
});

export class BakeComputedPitchService {
  constructor(session, snapshotService, patchService, { now = () => Date.now(), sleepFn } = {}) {
    this.session = session;
    this.snapshotService = snapshotService;
    this.patchService = patchService;
    this.now = now;
    this.sleep = sleepFn;
  }

  async bake(request = {}) {
    const timer = new ServiceTiming({ now: this.now, phaseNames: ["loadMs", "simplifyMs"] });
    const input = normalizeBakeRequest(request);
    timer.requestCoordinator();
    // 纯内存阶段：读 stored context 与 computed pitch，绝不在持锁外重读宿主。
    const loaded = await timer.measure("loadMs", async () => this._load(input));
    const plan = await timer.measure("simplifyMs", async () => buildBakePlan(loaded, input));
    if (input.dryRun) {
      return formatBakeResponse(loaded, input, plan, null, timer.finish());
    }
    // 写面：把整个 operation 集合一次提交给事务核（一个 Undo、读回、补偿），不用循环伪装。
    const patchResult = await this.patchService.patch({
      contextId: input.contextId,
      occurrence: loaded.occurrenceOrdinal,
      target: {
        ...(loaded.occurrence.targetGroupUuid ? { expectedGroupUuid: loaded.occurrence.targetGroupUuid } : {}),
        ...(loaded.groupFingerprint ? { expectedPitchControlFingerprint: loaded.groupFingerprint } : {}),
        expectedTimeOffsetBlick: loaded.occurrence.timeOffsetBlick ?? 0,
        ...(Number.isFinite(loaded.occurrence.pitchOffsetSemitone)
          ? { expectedPitchOffsetSemitone: loaded.occurrence.pitchOffsetSemitone }
          : {}),
        allowSharedTargetMutation: input.allowSharedTargetMutation === true,
      },
      operations: plan.operations,
      action: "commit",
      atomic: true,
    });
    return formatBakeResponse(loaded, input, plan, patchResult, timer.finish());
  }

  async _load(input) {
    // 采样来源：显式 sampling → 现场读；否则继承 snapshot 捕获的 computed pitch。
    if (input.sampling) {
      return this.session.withExclusive(async (host) => {
        const stored = this.snapshotService.getContext(input.contextId, host.epoch());
        const { occurrence, ordinal } = resolveOccurrence(stored, input.occurrence);
        const series = await readLiveComputedPitch(host, occurrence, input.sampling);
        return { stored, occurrence, occurrenceOrdinal: ordinal, series, samplingSource: "live", groupFingerprint: occurrence.pitchControlGroupFingerprint ?? null };
      });
    }
    // 继承路径不需要持锁：stored context 已有 computed pitch 与 occurrence 指纹。
    const epoch = this.session.getStatus?.().epoch ?? 0;
    const stored = this.snapshotService.getContext(input.contextId, epoch);
    const { occurrence, ordinal } = resolveOccurrence(stored, input.occurrence);
    const series = getStoredComputedPitch(stored, ordinal);
    if (!series) {
      throw codedError(
        "COMPUTED_PITCH_NOT_CAPTURED",
        'the occurrence has no stored computed pitch; re-run sv_snapshot_range with include ["computedPitch"], or pass explicit sampling'
      );
    }
    return { stored, occurrence, occurrenceOrdinal: ordinal, series, samplingSource: "snapshot", groupFingerprint: occurrence.pitchControlGroupFingerprint ?? null };
  }
}

function resolveOccurrence(stored, requestedOrdinal) {
  // 与其它 range-scoped operation 共用同一个选择器：显式 ordinal 索引**完整**数组，
  // 省略时唯一 vocal occurrence 自动选中，其余情况给出 ordinal 候选。手写第二份
  // 选择逻辑会让错误码与候选形状随时间漂移——那正是迁移前的状态。
  return selectOccurrenceByOrdinal(stored?.context?.occurrences, requestedOrdinal, {
    eligible: (item) => typeof item.targetGroupUuid === "string" && item.targetGroupUuid.length > 0,
    noneCode: "INVALID_CONTEXT",
    noneMessage: "range context contains no vocal occurrence to bake",
    ambiguousMessage: "range context has multiple vocal occurrences; pass one occurrence ordinal",
    ineligibleCode: "INVALID_TARGET",
    ineligibleMessage: "instrumental occurrences cannot be baked",
  });
}

async function readLiveComputedPitch(host, occurrence, sampling) {
  const roots = await host.roots();
  // 需要 reference handle：computed pitch 是对 occurrence reference 采样的。
  const track = await host.call({
    handle: roots.project,
    method: "getTrack",
    args: [occurrence.trackIndex + 1],
  });
  const reference = await host.call({
    handle: track,
    method: "getGroupReference",
    args: [occurrence.groupIndex + 1],
  });
  const raw = await host.call({
    handle: roots.sv,
    method: "getComputedPitchForGroup",
    args: [reference, sampling.startBlick, sampling.intervalBlick, sampling.frames],
    resultFormat: "typed-v2",
    resultShape: "array",
    resultLength: sampling.frames,
  });
  const values = (Array.isArray(raw) ? raw : []).map((value) =>
    Number.isFinite(value) ? value : null
  );
  return {
    startBlick: sampling.startBlick,
    intervalBlick: sampling.intervalBlick,
    frames: sampling.frames,
    values,
  };
}

// ---------- 计划：覆盖校验 + 坐标换算 + RDP 简化 ----------

function buildBakePlan(loaded, input) {
  const { occurrence, series } = loaded;
  const values = Array.isArray(series?.values) ? series.values : [];
  const totalFrames = values.length;
  const finiteIndices = [];
  for (let index = 0; index < totalFrames; index += 1) {
    if (Number.isFinite(values[index])) finiteIndices.push(index);
  }
  const finiteFrames = finiteIndices.length;
  const nullFrames = totalFrames - finiteFrames;
  const coverage = totalFrames === 0 ? 0 : finiteFrames / totalFrames;
  const evidence = {
    totalFrames,
    finiteFrames,
    nullFrames,
    coverage,
    threshold: input.coverageThreshold,
  };
  if (totalFrames === 0 || finiteFrames === 0 || coverage < input.coverageThreshold) {
    const error = codedError(
      "INSUFFICIENT_COMPUTED_PITCH",
      `computed pitch coverage ${(coverage * 100).toFixed(1)}% is below the ${(input.coverageThreshold * 100).toFixed(0)}% threshold (finite ${finiteFrames}/${totalFrames}); wait for processing and re-snapshot, or widen sampling — nothing was written`
    );
    error.details = evidence;
    error.insufficientData = true;
    throw error;
  }

  const timeOffset = occurrence.timeOffsetBlick ?? 0;
  const pitchOffset = occurrence.pitchOffsetSemitone ?? 0;
  // 有效区间：[firstFinite, lastFinite]。anchor 取首个有效帧（group-local / group-relative）。
  const firstIndex = finiteIndices[0];
  const lastIndex = finiteIndices[finiteIndices.length - 1];
  const frames = finiteIndices.map((index) => ({
    localBlick: series.startBlick + index * series.intervalBlick - timeOffset,
    groupRelativeSemitone: values[index] - pitchOffset,
  }));
  const anchorLocalBlick = frames[0].localBlick;
  const anchorSemitone = frames[0].groupRelativeSemitone;

  // RDP 简化（tolerance 内），保留端点；输出相对 anchor 的有序点。
  const simplified = rdpSimplify(frames, input.toleranceSemitone, input.maxPoints);
  const points = simplified.map((frame) => ({
    timeFromAnchorBlick: frame.localBlick - anchorLocalBlick,
    pitchFromAnchorSemitone: frame.groupRelativeSemitone - anchorSemitone,
  }));
  // 拟合误差：简化曲线在每个有效帧处的最大偏差（semitone）。
  const maxFitError = computeMaxFitError(frames, anchorLocalBlick, anchorSemitone, points);

  const curve = {
    kind: "curve",
    anchorPositionBlick: anchorLocalBlick,
    anchorPitchSemitone: anchorSemitone,
    points,
    generator: "sv_bake_computed_pitch",
  };
  const operations = [];
  // 策略决定删除面；add 永远在最后。
  if (input.strategy === "replace_owned") {
    for (const target of resolveOwnedTargets(loaded, anchorLocalBlick, frames)) {
      operations.push({ op: "delete", controlId: target.controlId, expectedFingerprint: target.fingerprint });
    }
  } else if (input.strategy === "replace_explicit") {
    for (const target of input.explicitTargets) {
      operations.push({ op: "delete", controlId: target.controlId, expectedFingerprint: target.expectedFingerprint });
    }
  }
  operations.push({ op: "add", control: curve });

  return {
    operations,
    curve,
    evidence,
    fitError: { maxSemitone: maxFitError, toleranceSemitone: input.toleranceSemitone },
    pointCount: points.length,
    modifiedRange: {
      localFromBlick: anchorLocalBlick,
      localToBlick: frames[frames.length - 1].localBlick,
      absoluteFromBlick: series.startBlick + firstIndex * series.intervalBlick,
      absoluteToBlick: series.startBlick + lastIndex * series.intervalBlick,
    },
  };
}

// replace_owned：删除 bake 范围内（anchor 落在有效区间）的 SVCopilot 自有 control。
// 依据 stored context 的 ownership；事务核对每个 expectedFingerprint 对活宿主重新校验。
function resolveOwnedTargets(loaded, fromBlick, toBlickFrames) {
  const toBlick = toBlickFrames[toBlickFrames.length - 1].localBlick;
  const stored = loaded.stored;
  const byOccurrence = stored?.context?.pitchControlsByOccurrence;
  if (!byOccurrence || !Object.hasOwn(byOccurrence, loaded.occurrenceOrdinal)) {
    throw codedError(
      "PITCH_CONTROLS_NOT_CAPTURED",
      'replace_owned needs the snapshot to capture pitch controls; re-run sv_snapshot_range with include ["pitchControls","computedPitch"]'
    );
  }
  const list = byOccurrence[loaded.occurrenceOrdinal] ?? [];
  return list
    .filter((control) => control.ownership?.owner === "svcopilot")
    .filter((control) => {
      const position = control.kind === "curve" ? control.anchor?.groupLocalBlick : control.position?.groupLocalBlick;
      return Number.isSafeInteger(position) && position >= fromBlick && position <= toBlick;
    })
    .map((control) => ({ controlId: control.controlId, fingerprint: control.fingerprint }));
}

// Ramer-Douglas-Peucker（迭代实现，避免深递归）。点数预算不能改变调用者要求的容差。
function rdpSimplify(frames, tolerance, maxPoints) {
  const kept = rdp(frames, tolerance);
  if (kept.length > maxPoints) {
    const error = codedError(
      "BAKE_POINT_BUDGET_EXCEEDED",
      `the requested ${tolerance}-semitone fit needs ${kept.length} points, exceeding maxPoints ${maxPoints}; increase maxPoints or toleranceSemitone — nothing was written`
    );
    error.details = {
      requiredPoints: kept.length,
      maxPoints,
      toleranceSemitone: tolerance,
    };
    throw error;
  }
  return kept;
}

function rdp(points, epsilon) {
  if (points.length <= 2) return [...points];
  const keep = new Array(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  const stack = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop();
    if (end <= start + 1) continue;
    const a = points[start];
    const b = points[end];
    let maxDistance = -1;
    let maxIndex = -1;
    for (let index = start + 1; index < end; index += 1) {
      const distance = perpendicularDistance(points[index], a, b);
      if (distance > maxDistance) {
        maxDistance = distance;
        maxIndex = index;
      }
    }
    if (maxDistance > epsilon) {
      keep[maxIndex] = true;
      stack.push([start, maxIndex]);
      stack.push([maxIndex, end]);
    }
  }
  return points.filter((_, index) => keep[index]);
}

// 点到直线（anchor 时间-音高平面）的垂直距离；时间量纲大，用参数化投影而非欧氏距离，
// 只比较音高偏差（semitone），与 tolerance 同量纲。
function perpendicularDistance(point, a, b) {
  const spanTime = b.localBlick - a.localBlick;
  if (spanTime === 0) return Math.abs(point.groupRelativeSemitone - a.groupRelativeSemitone);
  const t = (point.localBlick - a.localBlick) / spanTime;
  const interpolated = a.groupRelativeSemitone + t * (b.groupRelativeSemitone - a.groupRelativeSemitone);
  return Math.abs(point.groupRelativeSemitone - interpolated);
}

function computeMaxFitError(frames, anchorLocalBlick, anchorSemitone, points) {
  let maxError = 0;
  for (const frame of frames) {
    const fitted = evaluateCurve(points, frame.localBlick - anchorLocalBlick) + anchorSemitone;
    maxError = Math.max(maxError, Math.abs(fitted - frame.groupRelativeSemitone));
  }
  return maxError;
}

// 线性插值求 anchor 相对时间 t 处的曲线值（相对 anchor 音高）。读模型端只用于拟合误差报告。
function evaluateCurve(points, timeFromAnchor) {
  if (points.length === 0) return 0;
  if (timeFromAnchor <= points[0].timeFromAnchorBlick) return points[0].pitchFromAnchorSemitone;
  const last = points[points.length - 1];
  if (timeFromAnchor >= last.timeFromAnchorBlick) return last.pitchFromAnchorSemitone;
  for (let index = 1; index < points.length; index += 1) {
    const current = points[index];
    if (timeFromAnchor === current.timeFromAnchorBlick) return current.pitchFromAnchorSemitone;
    if (timeFromAnchor < current.timeFromAnchorBlick) {
      const previous = points[index - 1];
      const span = current.timeFromAnchorBlick - previous.timeFromAnchorBlick;
      const t = (timeFromAnchor - previous.timeFromAnchorBlick) / span;
      return previous.pitchFromAnchorSemitone + t * (current.pitchFromAnchorSemitone - previous.pitchFromAnchorSemitone);
    }
  }
  return last.pitchFromAnchorSemitone;
}

// ---------- 响应组装 ----------

function formatBakeResponse(loaded, input, plan, patchResult, timings) {
  const sharedTargetOccurrences = loaded.occurrence.sharedTargetOccurrences ?? [];
  const base = {
    contextId: loaded.stored.contextId,
    occurrence: {
      occurrence: loaded.occurrenceOrdinal,
      trackIndex: loaded.occurrence.trackIndex,
      groupIndex: loaded.occurrence.groupIndex,
      targetGroupUuid: loaded.occurrence.targetGroupUuid,
      timeOffsetBlick: loaded.occurrence.timeOffsetBlick ?? 0,
      pitchOffsetSemitone: loaded.occurrence.pitchOffsetSemitone ?? 0,
      sharedTargetOccurrences,
    },
    sourceSampling: {
      source: loaded.samplingSource,
      startBlick: loaded.series.startBlick,
      intervalBlick: loaded.series.intervalBlick,
      frames: loaded.series.frames,
    },
    coverage: plan.evidence.coverage,
    finiteFrames: plan.evidence.finiteFrames,
    nullFrames: plan.evidence.nullFrames,
    totalFrames: plan.evidence.totalFrames,
    coverageThreshold: input.coverageThreshold,
    fitError: plan.fitError,
    strategy: input.strategy,
    pitchDeltaHandling: input.pitchDeltaHandling,
    bakedCurve: {
      anchorPositionBlick: plan.curve.anchorPositionBlick,
      anchorPitchSemitone: plan.curve.anchorPitchSemitone,
      pointCount: plan.pointCount,
      ...(input.responseMode === "verbose" ? { points: plan.curve.points } : {}),
    },
    modifiedRange: plan.modifiedRange,
    provenance: PROVENANCE,
    timings,
  };
  if (input.dryRun || patchResult === null) {
    return {
      ok: true,
      status: "dry_run",
      effects: "none",
      ...base,
      plannedOperations: plan.operations.map((operation) => ({
        op: operation.op,
        ...(operation.op === "add" ? { kind: "curve", pointCount: operation.control.points.length } : { controlId: operation.controlId }),
      })),
      review: {
        requiresHumanAudition: true,
        requiresSharedTargetConfirmation: sharedTargetOccurrences.length > 1,
        checklist: [
          "This bakes the host's computed pitch into ONE new svcopilot-owned curve; the host may still be recomputing (see coverage).",
          "Existing pitchDelta automation is preserved; the baked curve and pitchDelta both affect pitch — audit for double-counting if pitchDelta drove the computed pitch.",
          "Commit the identical request with action commit to write inside one Undo with read-back and reverse compensation.",
          "Musical quality is human-only; audition the result.",
        ],
      },
      warnings: [],
    };
  }
  // commit：如实透出事务核结果（effects/undo/verification/rollback），不重复包装。
  return {
    ok: patchResult.ok,
    status: patchResult.status,
    effects: patchResult.effects,
    ...base,
    operations: patchResult.operations,
    undo: patchResult.undo,
    verification: patchResult.verification,
    rollback: patchResult.rollback,
    ...(patchResult.error ? { error: patchResult.error } : {}),
    warnings: patchResult.warnings ?? [],
  };
}

// ---------- 请求校验 ----------

function normalizeBakeRequest(request) {
  if (!isRecord(request)) throw codedError("INVALID_ARGUMENTS", "request must be an object");
  assertKnownKeys(
    request,
    [
      "contextId",
      "occurrence",
      "sampling",
      "strategy",
      "explicitTargets",
      "coverageThreshold",
      "toleranceSemitone",
      "maxPoints",
      "pitchDeltaHandling",
      "allowSharedTargetMutation",
      "action",
      "responseMode",
    ],
    "request"
  );
  if (typeof request.contextId !== "string" || !request.contextId) {
    throw codedError("INVALID_ARGUMENTS", "contextId is required; take it from sv_snapshot_range");
  }
  if (
    request.occurrence !== undefined &&
    (!Number.isSafeInteger(request.occurrence) || request.occurrence < 0)
  ) {
    throw codedError(
      "INVALID_ARGUMENTS",
      "occurrence must be a non-negative occurrence ordinal when provided"
    );
  }
  const strategy = request.strategy ?? "preserve_existing";
  if (!BAKE_STRATEGIES.includes(strategy)) {
    throw codedError("INVALID_ARGUMENTS", `strategy must be one of ${BAKE_STRATEGIES.join(", ")}`);
  }
  let explicitTargets = [];
  if (strategy === "replace_explicit") {
    if (!Array.isArray(request.explicitTargets) || request.explicitTargets.length === 0) {
      throw codedError(
        "INVALID_ARGUMENTS",
        "replace_explicit requires a non-empty explicitTargets array of caller-confirmed controls"
      );
    }
    explicitTargets = request.explicitTargets.map((target, index) => {
      const label = `explicitTargets[${index}]`;
      if (!isRecord(target) || typeof target.controlId !== "string" || !target.controlId) {
        throw codedError("INVALID_ARGUMENTS", `${label}.controlId must be a non-empty string`);
      }
      if (typeof target.expectedFingerprint !== "string" || !target.expectedFingerprint) {
        throw codedError("INVALID_ARGUMENTS", `${label}.expectedFingerprint must be a non-empty string`);
      }
      return { controlId: target.controlId, expectedFingerprint: target.expectedFingerprint };
    });
  }
  const pitchDeltaHandling = request.pitchDeltaHandling ?? "preserve";
  if (pitchDeltaHandling === "clear") {
    throw codedError(
      "PITCH_DELTA_CLEAR_UNSUPPORTED",
      "clearing pitchDelta requires a cross-type (PitchControl + Automation) journal/Undo/rollback, which this version does not implement; use pitchDeltaHandling:\"preserve\" (the default)"
    );
  }
  if (pitchDeltaHandling !== "preserve") {
    throw codedError("INVALID_ARGUMENTS", "pitchDeltaHandling must be preserve");
  }
  let sampling = null;
  if (request.sampling !== undefined) {
    if (!isRecord(request.sampling)) throw codedError("INVALID_ARGUMENTS", "sampling must be an object");
    assertKnownKeys(request.sampling, ["startBlick", "intervalBlick", "frames"], "sampling");
    for (const field of ["startBlick", "intervalBlick", "frames"]) {
      if (!Number.isSafeInteger(request.sampling[field]) || request.sampling[field] < 0) {
        throw codedError("INVALID_ARGUMENTS", `sampling.${field} must be a non-negative safe integer`);
      }
    }
    if (request.sampling.frames < 1 || request.sampling.intervalBlick < 1) {
      throw codedError("INVALID_ARGUMENTS", "sampling.frames and sampling.intervalBlick must be >= 1");
    }
    sampling = request.sampling;
  }
  return {
    contextId: request.contextId,
    occurrence: request.occurrence,
    sampling,
    strategy,
    explicitTargets,
    coverageThreshold: checkedNumber(request.coverageThreshold, 0.01, 1, DEFAULT_COVERAGE_THRESHOLD, "coverageThreshold"),
    toleranceSemitone: checkedNumber(request.toleranceSemitone, 0.001, 2, DEFAULT_TOLERANCE_SEMITONE, "toleranceSemitone"),
    maxPoints: checkedInteger(request.maxPoints, 8, MAX_BAKE_POINTS, MAX_BAKE_POINTS, "maxPoints"),
    pitchDeltaHandling,
    allowSharedTargetMutation: request.allowSharedTargetMutation === true,
    dryRun: dryRunFromAction(request.action),
    responseMode: ["compact", "standard", "verbose"].includes(request.responseMode) ? request.responseMode : "standard",
  };
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
