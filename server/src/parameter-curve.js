import { createHostScope } from "./snapshot.js";
import { settlePlanLedger } from "./plan-reference.js";
import { getVocalModeNames, normalizeVoiceParameters } from "./voice-parameters.js";
import {
  musicalToBlick,
  normalizeMeterMarks,
  normalizeMusicalPoint,
  numberToFraction,
} from "./musical-time.js";
import { runChunkedMutation } from "./chunked-mutation.js";
import { decodeDense } from "./dense-codec.js";
import { selectOccurrenceByOrdinal } from "./scope-source.js";

// Automation 位于 NoteGroup 本地坐标；对外同时报告 local 与 absolute blick。
// local → absolute 的偏移是 getTimeOffset()；getOnset() 已含首音符 onset，不能用作偏移。
const MAX_INLINE_POINTS = 200;
const MIN_VALUE_TOLERANCE = 1e-6;
const RANGE_RELATIVE_TOLERANCE = 1e-6;
const MIN_READ_WINDOW_BLICK = 1024;
const MAX_JOURNAL_POINTS = 4000;
const MAX_SNAPSHOT_POINTS = 20_000;
// target.expectedNotes 的上限：apply 前用快照指纹逐条核对锚点音符是否漂移，绑定合理规模。
const MAX_EXPECTED_NOTES = 256;
export const BUILTIN_AUTOMATION_PARAMETERS = Object.freeze([
  "pitchDelta",
  "vibratoEnv",
  "loudness",
  "tension",
  "breathiness",
  "voicing",
  "gender",
]);
const BUILTIN_PARAMETER_BY_LOWERCASE = new Map(
  BUILTIN_AUTOMATION_PARAMETERS.map((parameter) => [parameter.toLowerCase(), parameter])
);

export async function readAutomationSnapshot(
  capture,
  target,
  requestedParameter,
  range,
  { maxPoints = MAX_SNAPSHOT_POINTS } = {}
) {
  const resolvedParameter = await resolveParameterName(capture, target, requestedParameter);
  const resolved = await resolveAutomationForTarget(capture, target, resolvedParameter);
  const localRange = toLocalRange(range, target.groupTimeOffsetBlick);
  const read = await readPointsInRange(capture, resolved.automation, localRange, { maxPoints });
  if (read.truncated) {
    throw codedError(
      "SNAPSHOT_AUTOMATION_LIMIT_REACHED",
      `Automation ${resolved.typeName} exceeds the ${maxPoints}-point capture safety limit`
    );
  }
  return {
    requestedParameter,
    resolvedParameter: resolved.typeName,
    definition: resolved.definition,
    interpolationMethod: resolved.interpolationMethod,
    points: read.points.map((point) => ({
      localBlick: point.blick,
      absoluteBlick: point.blick + target.groupTimeOffsetBlick,
      value: point.value,
    })),
  };
}

export class ParameterCurveService {
  constructor(
    session,
    {
      now = () => Date.now(),
      snapshotService = null,
      artifactStore = null,
      sessionId = null,
    } = {}
  ) {
    this.session = session;
    this.now = now;
    this.snapshotService = snapshotService;
    this.artifactStore = artifactStore;
    this.sessionId = sessionId;
  }

  async getCurve(request) {
    const input = normalizeGetRequest(request);
    return this.session.withExclusive(async (host) => {
      const capture = createHostScope(host);
      try {
        const resolved = await resolveAutomation(capture, input.target, input.parameter, {
          snapshotService: this.snapshotService,
          epoch: host.epoch(),
          readOnly: true,
        });
        const range = await resolveCurveRange(capture, resolved, input.range);
        const read = await readPointsInRange(capture, resolved.automation, range, {
          maxPoints: input.maxPoints,
        });
        const points = read.points.map((point) => ({
          localBlick: point.blick,
          absoluteBlick: point.blick + resolved.groupTimeOffsetBlick,
          value: point.value,
        }));
        const warnings = [];
        if (read.truncated) {
          warnings.push({
            code: "POINTS_TRUNCATED",
            message: `stopped after ${input.maxPoints} control points; continue from data.nextFromBlick (local) to read the rest.`,
          });
        }
        return {
          ok: true,
          status: "succeeded",
          observedAt: new Date(this.now()).toISOString(),
          data: {
            parameter: resolved.typeName,
            requestedParameter: resolved.requestedParameter,
            resolvedParameter: resolved.typeName,
            definition: resolved.definition,
            interpolationMethod: resolved.interpolationMethod,
            group: {
              trackIndex: input.target.trackIndex,
              groupIndex: input.target.groupIndex,
              uuid: resolved.groupUuid,
              onsetBlick: resolved.groupOnsetBlick,
              timeOffsetBlick: resolved.groupTimeOffsetBlick,
            },
            range: formatResolvedRange(input.range, range),
            points,
            stats: pointStats(read.points),
            complete: !read.truncated,
            ...(read.truncated ? { nextFromBlick: read.nextFromBlick } : {}),
          },
          warnings,
        };
      } finally {
        await capture.releaseAll();
      }
    });
  }

  async patchCurves(request) {
    const serviceStartedAt = this.now();
    let resolvedRequest = request;
    let ledgerRef = null;
    let planCapsule = null;
    // 如果请求携带 planRef，先从 artifact 展开为规范 mutation 请求。
    if (request?.planRef && this.artifactStore && this.sessionId) {
      const { resolvePlanReference } = await import("./plan-reference.js");
      const resolved = resolvePlanReference({
        planRef: request.planRef,
        action: request.action,
        confirmations: request.confirmations,
        executionOptions: request.executionOptions,
        expectedTargetTool: "sv_patch_parameter_curves",
        sessionId: this.sessionId,
        artifactStore: this.artifactStore,
        snapshotStore: this.snapshotService?.store,
        planLedger: this.artifactStore.planLedger ?? null,
      });
      resolvedRequest = resolved.mutationRequest;
      ledgerRef = resolved.ledgerRef;
      planCapsule = resolved.capsule;
    }
    let input;
    try {
      input = normalizeBatchPatchRequest(resolvedRequest);
    } catch (error) {
      const failure = formatBatchValidationFailure(resolvedRequest, error, {
        elapsedMs: elapsed(serviceStartedAt, this.now()),
      });
      return settlePlanLedger(this.artifactStore?.planLedger ?? null, ledgerRef, failure);
    }
    const coordinatorRequestedAt = this.now();
    const transaction = await this._runTransaction(input, {
      serviceStartedAt,
      coordinatorRequestedAt,
      planCapsule,
    });
    return settlePlanLedger(
      this.artifactStore?.planLedger ?? null,
      ledgerRef,
      formatBatchTransaction(transaction, input)
    );
  }

  async _runTransaction(input, timingOrigin = {}) {
    const serviceStartedAt = timingOrigin.serviceStartedAt ?? this.now();
    const coordinatorRequestedAt = timingOrigin.coordinatorRequestedAt ?? serviceStartedAt;
    const planCapsule = timingOrigin.planCapsule ?? null;
    return this.session.withExclusive(async (host) => {
      const acquiredAt = this.now();
      const capture = createHostScope(host);
      try {
        return await executeCurveTransaction(capture, input, {
          now: this.now,
          serviceStartedAt,
          coordinatorRequestedAt,
          acquiredAt,
          snapshotService: this.snapshotService,
          epoch: host.epoch(),
          planCapsule,
        });
      } finally {
        await capture.releaseAll();
      }
    });
  }
}

async function executeCurveTransaction(capture, input, clock) {
  const timings = {
    dispatcherQueueMs: null,
    validationMs: elapsed(clock.serviceStartedAt, clock.coordinatorRequestedAt),
    coordinatorQueueMs: elapsed(clock.coordinatorRequestedAt, clock.acquiredAt),
    preflightReadMs: 0,
    hostWriteMs: 0,
    verificationMs: 0,
    rollbackMs: 0,
    operationMs: 0,
    serviceTotalMs: 0,
  };
  const transaction = {
    ok: false,
    status: "failed",
    effects: "none",
    atomicity: input.atomic ? "verified_compensation" : "none",
    target: null,
    resolvedParameters: [],
    plans: [],
    failure: null,
    rollback: { attempted: false, verified: null, curves: [] },
    boundaryCalls: 0,
    warnings: [],
    timings,
  };
  const finish = () => {
    const finishedAt = clock.now();
    timings.operationMs = elapsed(clock.acquiredAt, finishedAt);
    timings.serviceTotalMs = elapsed(clock.serviceStartedAt, finishedAt);
    return transaction;
  };

  let phase = "preflight";
  let failedCurveIndex = null;
  const touched = [];
  try {
    await timed(timings, "preflightReadMs", clock.now, async () => {
      transaction.target = await resolveCurveTarget(capture, input.target, {
        ...clock,
        readOnly: true,
        scanSharedTargets: false,
      });
      if (
        input.target.expectedGroupUuid !== undefined &&
        input.target.expectedGroupUuid !== transaction.target.groupUuid
      ) {
        throw codedError(
          "TARGET_CONFLICT",
          `expected group UUID ${input.target.expectedGroupUuid}, observed ${transaction.target.groupUuid}`
        );
      }
      // 音符锚点漂移守卫：group UUID 相同但音符被 UI/raw API 移动时（contextId 不失效），绝对 BLICK
      // 曲线会落到旧位置，读回只能证明"错误位置写成功"。逐条核对快照指纹，漂移即以 STALE_CONTEXT 失败
      // （发生在任何写入之前，effects 保持 none）。
      // 注意指纹全部是组内本地坐标：整个 reference 被 setTimeOffset 移动时指纹不变，所以还需要
      // expectedTimeOffsetBlick 把快照时的偏移一并锁住——绝对→本地换算用的是提交时的 live offset，
      // 偏移变了，同一绝对坐标就会写到相对音符错误的本地位置。
      if (
        input.target.expectedTimeOffsetBlick !== undefined &&
        input.target.expectedTimeOffsetBlick !== transaction.target.groupTimeOffsetBlick
      ) {
        throw codedError(
          "STALE_CONTEXT",
          `the group reference moved after snapshot: expected timeOffsetBlick ${input.target.expectedTimeOffsetBlick}, observed ${transaction.target.groupTimeOffsetBlick}; re-snapshot and re-plan`
        );
      }
      if (input.target.expectedNotes) {
        for (const expected of input.target.expectedNotes) {
          await verifyAnchoredNote(capture, transaction.target, expected);
        }
      }
      const resolvedCurves = [];
      for (let index = 0; index < input.curves.length; index += 1) {
        failedCurveIndex = index;
        try {
          const requestedParameter = input.curves[index].parameter;
          const resolvedParameter = await resolveParameterName(
            capture,
            transaction.target,
            requestedParameter
          );
          transaction.resolvedParameters[index] = resolvedParameter;
          resolvedCurves.push({
            ...input.curves[index],
            requestedParameter,
            parameter: resolvedParameter,
          });
        } catch (error) {
          throw withCurveFailure(error, index, input.curves[index].parameter, "preflight");
        }
      }
      const parameterOwners = new Map();
      for (let index = 0; index < resolvedCurves.length; index += 1) {
        const resolvedParameter = resolvedCurves[index].parameter;
        const key = resolvedParameter.toLowerCase();
        if (parameterOwners.has(key)) {
          const duplicateError = codedError(
            "DUPLICATE_PARAMETER",
            `curves[${parameterOwners.get(key)}] and curves[${index}] both resolve to ${resolvedParameter}`
          );
          duplicateError.resolvedParameter = resolvedParameter;
          throw withCurveFailure(
            duplicateError,
            index,
            resolvedCurves[index].requestedParameter,
            "preflight"
          );
        }
        parameterOwners.set(key, index);
      }
      for (let index = 0; index < resolvedCurves.length; index += 1) {
        failedCurveIndex = index;
        const curveStartedAt = clock.now();
        try {
          const plan = await prepareCurvePlan(
            capture,
            transaction.target,
            resolvedCurves[index],
            index
          );
          plan.timings.preflightReadMs = elapsed(curveStartedAt, clock.now());
          transaction.plans.push(plan);
          transaction.warnings.push(...plan.warnings);
        } catch (error) {
          throw withCurveFailure(
            error,
            index,
            resolvedCurves[index].requestedParameter,
            "preflight"
          );
        }
      }
      failedCurveIndex = null;
    });

    if (input.dryRun) {
      transaction.ok = true;
      transaction.status = "dry_run";
      for (const plan of transaction.plans) plan.status = "planned";
      if (input.target.contextId) {
        transaction.warnings.push({
          code: "SHARED_TARGET_CHECK_DEFERRED",
          message:
            "Project-wide shared-target scanning is deferred to commit; dry-run remains side-effect free.",
        });
      }
      if (
        Math.max(
          transaction.target.sharedTargetOccurrences.length,
          transaction.target.projectTargetOccurrences.length
        ) > 1 &&
        input.target.allowSharedTargetMutation !== true
      ) {
        transaction.warnings.push({
          code: "SHARED_TARGET_DRY_RUN",
          message:
            "This dry-run is safe, but commit requires allowSharedTargetMutation:true because every occurrence shares one target NoteGroup.",
        });
      }
      return finish();
    }

    // 数学空操作（计划点与现有点完全一致且无 simplify）不开启 Undo 边界、不触碰宿主：
    // 反复预览/归一化曲线的调用方不应制造一串空 Undo 记录（黑盒审计 F-06）。
    if (transaction.plans.every((plan) => curvePlanIsNoOp(plan))) {
      transaction.ok = true;
      transaction.status = "no_change";
      transaction.effects = "none";
      for (const plan of transaction.plans) {
        plan.status = "no_change";
        plan.observed = plan.journal;
        plan.verification = {
          attempted: true,
          passed: true,
          mode: "no_change",
          evidence: {
            observedPointCount: plan.journal.length,
            plannedPointCount: plan.planned.length,
            noChange: true,
          },
        };
      }
      return finish();
    }

    await timed(timings, "preflightReadMs", clock.now, () =>
      assertSharedTargetMutationConfirmed(capture, transaction.target, input.target)
    );
    phase = "execute";
    await timed(timings, "hostWriteMs", clock.now, async () => {
      await capture.call(transaction.target.roots.project, "newUndoRecord", []);
      transaction.boundaryCalls += 1;
    });
    const chunkResult = await runChunkedMutation({
      // 所有曲线 journal 已在第一条写入前完成，这里只负责有序执行与逆序补偿。
      prepareJournal: async () =>
        transaction.plans.map((plan) => ({
          parameter: plan.typeName,
          points: plan.journal,
        })),
      chunks: transaction.plans,
      applyChunk: async (plan) => {
        failedCurveIndex = plan.index;
        const curveStartedAt = clock.now();
        touched.push(plan);
        plan.status = "writing";
        try {
          await timed(timings, "hostWriteMs", clock.now, () => applyCurvePlan(capture, plan));
          plan.timings.hostWriteMs = elapsed(curveStartedAt, clock.now());
          plan.status = "written";
          return { ok: true };
        } catch (error) {
          plan.timings.hostWriteMs = elapsed(curveStartedAt, clock.now());
          const failure = withCurveFailure(error, plan.index, plan.typeName, "execute");
          if (isUnknownOutcomeError(error)) throw failure;
          return { ok: false, error: failure };
        }
      },
      verifyAll: async () => {
        phase = "verify";
        for (const plan of transaction.plans) {
          failedCurveIndex = plan.index;
          const curveStartedAt = clock.now();
          try {
            await timed(timings, "verificationMs", clock.now, async () => {
              const observedRead = await readPointsInRange(capture, plan.automation, plan.range, {
                maxPoints: MAX_JOURNAL_POINTS,
              });
              plan.observed = observedRead.points;
              plan.verification = await verifyCurve(
                capture,
                plan.automation,
                plan.planned,
                plan.observed,
                plan.definition,
                plan.simplifyThreshold,
                observedRead.truncated
              );
            });
            plan.timings.verificationMs = elapsed(curveStartedAt, clock.now());
            if (!plan.verification.passed) {
              throw codedError(
                "POSTCONDITION_FAILED",
                `curve ${plan.typeName} did not match the requested points after write-back verification`
              );
            }
            plan.status = "succeeded";
          } catch (error) {
            plan.timings.verificationMs = elapsed(curveStartedAt, clock.now());
            const failure = withCurveFailure(error, plan.index, plan.typeName, "verify");
            if (isUnknownOutcomeError(error)) throw failure;
            return { ok: false, error: failure };
          }
        }
        return { ok: true };
      },
      rollbackChunk: async (plan) => {
        const rollbackStartedAt = clock.now();
        const rollback = await timed(timings, "rollbackMs", clock.now, () =>
          rollbackCurve(
            capture,
            plan.automation,
            plan.range,
            plan.journal,
            plan.definition
          )
        );
        plan.timings.rollbackMs = elapsed(rollbackStartedAt, clock.now());
        plan.rollback = rollback;
        plan.status = rollback.verified ? "rolled_back" : "rollback_failed";
        transaction.rollback.curves.push({
          parameter: plan.typeName,
          verified: rollback.verified,
          ...(rollback.error ? { error: rollback.error } : {}),
        });
        return {
          ok: rollback.verified,
          ...(rollback.error ? { error: rollback.error } : {}),
        };
      },
      verifyRollback: async () => ({
        ok:
          transaction.rollback.curves.length === touched.length &&
          transaction.rollback.curves.every((curve) => curve.verified),
        evidence: { curves: transaction.rollback.curves },
      }),
      shouldRollback: (error) => input.atomic && !isUnknownOutcomeError(error),
      classifyUnknownOutcome: (error) =>
        isUnknownOutcomeError(error) ? "outcome_unknown" : "partial",
    });

    if (!chunkResult.ok) {
      const runnerError = Object.assign(
        codedError(chunkResult.error.code, chunkResult.error.message),
        chunkResult.error
      );
      transaction.failure = failureEvidence(
        runnerError,
        chunkResult.status === "outcome_unknown" ? "execute" : phase,
        failedCurveIndex
      );
      transaction.rollback = {
        attempted: chunkResult.rollback.attempted,
        verified: chunkResult.rollback.verified,
        curves: transaction.rollback.curves,
        ...(chunkResult.rollback.failures.length > 0
          ? { failures: chunkResult.rollback.failures }
          : {}),
      };
      transaction.status = chunkResult.status;
      transaction.effects =
        chunkResult.status === "rolled_back" ? "reverted" : chunkResult.effects;
      transaction.failure.outcome =
        chunkResult.status === "rolled_back"
          ? "unchanged"
          : chunkResult.status === "outcome_unknown"
            ? "unknown"
            : "partial";
      for (const plan of transaction.plans) {
        if (plan.status === "prepared") plan.status = "not_applied";
        else if (plan.status === "written") plan.status = "applied_unverified";
      }
      await timed(timings, "hostWriteMs", clock.now, () =>
        closeBoundary(
          capture,
          transaction.target,
          transaction.warnings,
          () => (transaction.boundaryCalls += 1)
        )
      );
      return finish();
    }
    failedCurveIndex = null;

    await timed(timings, "hostWriteMs", clock.now, () =>
      closeBoundary(
        capture,
        transaction.target,
        transaction.warnings,
        () => (transaction.boundaryCalls += 1)
      )
    );
    transaction.ok = true;
    transaction.status = "succeeded";
    transaction.effects = "verified";
    return finish();
  } catch (error) {
    transaction.failure = failureEvidence(error, phase, failedCurveIndex);
    const writeAttempted = touched.length > 0;
    if (!writeAttempted) {
      for (const plan of transaction.plans) plan.status = "not_applied";
      transaction.status = error?.code === "TARGET_CONFLICT" ? "conflict" : "failed";
      return finish();
    }

    for (const plan of transaction.plans) {
      if (plan.status === "prepared") plan.status = "not_applied";
      else if (plan.index === transaction.failure.curveIndex) plan.status = "failed";
      else if (plan.status === "written") plan.status = "applied_unverified";
    }

    const unknown = isUnknownOutcomeError(error);
    if (unknown || !input.atomic) {
      await timed(timings, "hostWriteMs", clock.now, () =>
        closeBoundary(
          capture,
          transaction.target,
          transaction.warnings,
          () => (transaction.boundaryCalls += 1)
        )
      );
      transaction.status = unknown ? "outcome_unknown" : "partial";
      transaction.effects = unknown ? "unknown" : "may_remain";
      transaction.failure.outcome = unknown ? "unknown" : "partial";
      return finish();
    }

    phase = "rollback";
    transaction.rollback.attempted = true;
    await timed(timings, "rollbackMs", clock.now, async () => {
      for (const plan of [...touched].reverse()) {
        const rollbackStartedAt = clock.now();
        const rollback = await rollbackCurve(
          capture,
          plan.automation,
          plan.range,
          plan.journal,
          plan.definition
        );
        plan.timings.rollbackMs = elapsed(rollbackStartedAt, clock.now());
        plan.rollback = rollback;
        plan.status = rollback.verified ? "rolled_back" : "rollback_failed";
        transaction.rollback.curves.push({
          parameter: plan.typeName,
          verified: rollback.verified,
          ...(rollback.error ? { error: rollback.error } : {}),
        });
      }
    });
    transaction.rollback.verified = transaction.rollback.curves.every((curve) => curve.verified);
    await timed(timings, "hostWriteMs", clock.now, () =>
      closeBoundary(
        capture,
        transaction.target,
        transaction.warnings,
        () => (transaction.boundaryCalls += 1)
      )
    );
    transaction.status = transaction.rollback.verified ? "rolled_back" : "rollback_failed";
    transaction.effects = transaction.rollback.verified
      ? "reverted"
      : transaction.rollback.curves.some((curve) => curve.error?.code === "HOST_TIMEOUT")
        ? "unknown"
        : "may_remain";
    transaction.failure.outcome = transaction.rollback.verified
      ? "unchanged"
      : transaction.effects === "unknown"
        ? "unknown"
        : "partial";
    return finish();
  }
}

export async function prepareCurvePlan(capture, target, input, index) {
  const resolved = await resolveAutomationForTarget(capture, target, input.parameter);
  const range = await resolveCurveRange(capture, target, input.range);
  const journalRead = await readPointsInRange(capture, resolved.automation, range, {
    maxPoints: MAX_JOURNAL_POINTS,
  });
  if (journalRead.truncated) {
    throw codedError(
      "CURVE_TOO_DENSE",
      `the range holds more than ${MAX_JOURNAL_POINTS} control points; narrow the range before patching`
    );
  }

  const journal = journalRead.points;
  const [minValue, maxValue] = resolved.definition.range;
  let clampedCount = 0;
  let planned;
  let resolvedInputPoints = [];
  if (input.mode === "replace") {
    resolvedInputPoints = await resolveCurvePoints(capture, target, input.points, input.range);
    planned = resolvedInputPoints.map((point) => {
      const local = point.localBlick;
      if (local < range.fromLocal || local > range.toLocal) {
        throw codedError(
          "INVALID_ARGUMENTS",
          `replace point at local blick ${local} lies outside the requested range`
        );
      }
      if (point.value < minValue || point.value > maxValue) {
        throw codedError(
          "VALUE_OUT_OF_RANGE",
          `value ${point.value} is outside the official range [${minValue}, ${maxValue}] for ${resolved.typeName}`
        );
      }
      return { blick: local, value: point.value };
    });
  } else {
    // add/scale 只变换范围内现有控制点，不对连续曲线重新采样。
    planned = journal.map((point) => {
      const rawValue =
        input.mode === "add" ? point.value + input.amount : point.value * input.amount;
      const value = Math.min(maxValue, Math.max(minValue, rawValue));
      if (value !== rawValue) clampedCount += 1;
      return { blick: point.blick, value };
    });
  }
  planned.sort((a, b) => a.blick - b.blick);
  for (let pointIndex = 1; pointIndex < planned.length; pointIndex += 1) {
    if (planned[pointIndex].blick === planned[pointIndex - 1].blick) {
      throw codedError("INVALID_ARGUMENTS", "points must have unique positions");
    }
  }
  const warnings = [];
  if (clampedCount > 0) {
    warnings.push({
      code: "CLAMPED_TO_RANGE",
      parameter: resolved.typeName,
      message: `${clampedCount} computed value(s) were clamped to the official range [${minValue}, ${maxValue}].`,
    });
  }
  return {
    index,
    status: "prepared",
    requestedParameter: input.requestedParameter,
    resolvedParameter: resolved.typeName,
    automation: resolved.automation,
    definition: resolved.definition,
    typeName: resolved.typeName,
    interpolationMethod: resolved.interpolationMethod,
    mode: input.mode,
    inputRange: input.range,
    range,
    journal,
    planned,
    resolvedInputPoints,
    observed: null,
    simplifyThreshold: input.simplifyThreshold,
    clampedCount,
    verification: null,
    rollback: null,
    warnings,
    timings: { preflightReadMs: 0, hostWriteMs: 0, verificationMs: 0, rollbackMs: 0 },
  };
}

async function resolveCurvePoints(capture, target, points, inputRange) {
  const resolved = [];
  for (const point of points) {
    if (point.kind === "blick") {
      const coordinate = inputRange.coordinate ?? "local";
      const localBlick =
        coordinate === "absolute"
          ? point.blick - target.groupTimeOffsetBlick
          : point.blick;
      resolved.push({
        source: "blick",
        input: { blick: point.blick, coordinate },
        localBlick,
        absoluteBlick: localBlick + target.groupTimeOffsetBlick,
        value: point.value,
      });
      continue;
    }
    if (!target.contextOccurrence || !target.storedContext) {
      throw codedError(
        "CONTEXT_REQUIRED",
        "semantic positions require a target from sv_snapshot_range"
      );
    }
    if (point.kind === "musical") {
      await ensureLiveMusicalContext(capture, target);
      const absoluteBlick = musicalToBlick(
        point.musicalPosition,
        target.storedContext.context.meterMarks,
        target.storedContext.context.quarterBlick
      );
      resolved.push({
        source: "musicalPosition",
        input: { bar: point.musicalPosition.bar, beat: point.musicalPosition.beat },
        localBlick: absoluteBlick - target.groupTimeOffsetBlick,
        absoluteBlick,
        value: point.value,
      });
      continue;
    }
    if (point.kind === "rangeBoundary") {
      await ensureLiveMusicalContext(capture, target);
      const boundaryKey = point.rangeBoundary === "start" ? "from" : "to";
      const absoluteBlick = target.storedContext.context.range?.[boundaryKey]?.blick;
      if (!Number.isSafeInteger(absoluteBlick)) {
        throw codedError("INVALID_CONTEXT", "range context has no usable boundary BLICK");
      }
      resolved.push({
        source: "rangeBoundary",
        input: point.rangeBoundary,
        localBlick: absoluteBlick - target.groupTimeOffsetBlick,
        absoluteBlick,
        value: point.value,
      });
      continue;
    }
    if (point.kind === "gap") {
      const after = findAnchorFingerprint(target, point.gap.afterNote);
      const before = findAnchorFingerprint(target, point.gap.beforeNote);
      if (after.indexInGroup + 1 !== before.indexInGroup) {
        throw codedError("INVALID_NOTE_GAP", "gap anchors must identify adjacent notes in order");
      }
      await verifyAnchoredNote(capture, target, after);
      await verifyAnchoredNote(capture, target, before);
      const gapStart = after.onsetBlick + after.durationBlick;
      const gapEnd = before.onsetBlick;
      if (gapEnd < gapStart) {
        throw codedError("INVALID_NOTE_GAP", "adjacent notes overlap and have no non-negative gap");
      }
      const localBase = resolveIntervalPosition(gapStart, gapEnd, point.gap.position, "gap");
      const absoluteBase = localBase + target.groupTimeOffsetBlick;
      if (point.gap.offset.unit !== "blick") await ensureLiveMusicalContext(capture, target);
      const offsetBlick = resolveAnchorOffset(
        point.gap.offset,
        absoluteBase,
        target.storedContext.context.meterMarks,
        target.storedContext.context.quarterBlick
      );
      const localBlick = localBase + offsetBlick;
      resolved.push({
        source: "noteGap",
        input: point.gap,
        localBlick,
        absoluteBlick: localBlick + target.groupTimeOffsetBlick,
        value: point.value,
      });
      continue;
    }
    const fingerprint = findAnchorFingerprint(target, point.anchor.note);
    await verifyAnchoredNote(capture, target, fingerprint);
    const localBase = resolveIntervalPosition(
      fingerprint.onsetBlick,
      fingerprint.onsetBlick + fingerprint.durationBlick,
      point.anchor.position,
      "note anchor"
    );
    const absoluteBase = localBase + target.groupTimeOffsetBlick;
    if (point.anchor.offset.unit !== "blick") await ensureLiveMusicalContext(capture, target);
    const offsetBlick = resolveAnchorOffset(
      point.anchor.offset,
      absoluteBase,
      target.storedContext.context.meterMarks,
      target.storedContext.context.quarterBlick
    );
    const localBlick = localBase + offsetBlick;
    resolved.push({
      source: "noteAnchor",
      input: point.anchor,
      localBlick,
      absoluteBlick: localBlick + target.groupTimeOffsetBlick,
      value: point.value,
    });
  }
  resolved.sort((left, right) => left.localBlick - right.localBlick);
  for (let index = 1; index < resolved.length; index += 1) {
    if (resolved[index].localBlick === resolved[index - 1].localBlick) {
      const error = codedError(
        "DUPLICATE_RESOLVED_POSITION",
        `multiple points resolve to local blick ${resolved[index].localBlick}`
      );
      error.resolvedPosition = {
        localBlick: resolved[index].localBlick,
        absoluteBlick: resolved[index].absoluteBlick,
      };
      throw error;
    }
  }
  return resolved;
}

// 锚点解析按组内 index。两种失败必须分开（§3.2 规则 5）：越界靠重试永远不会成功，
// 未捕获则需要重新捕获更宽的范围——合并成一个码会让模型分不清该怎么办。
function findAnchorFingerprint(target, noteIndex) {
  const fingerprints = target.contextOccurrence.noteFingerprints;
  const fingerprint = fingerprints.find((item) => item.indexInGroup === noteIndex);
  if (!fingerprint) {
    const groupNoteCount = target.contextOccurrence.groupNoteCount ?? fingerprints.length;
    if (noteIndex >= groupNoteCount) {
      throw codedError(
        "NOTE_INDEX_OUT_OF_RANGE",
        `note index ${noteIndex} is outside the note group`,
        { got: noteIndex, max: groupNoteCount - 1 }
      );
    }
    throw codedError(
      "NOTE_NOT_IN_CONTEXT",
      `note ${noteIndex} exists but was not captured in this occurrence`,
      { got: noteIndex }
    );
  }
  return fingerprint;
}

async function ensureLiveMusicalContext(capture, target) {
  if (target.liveMusicalContextVerified) return;
  const timeAxis = await capture.call(target.roots.project, "getTimeAxis", [], {
    inferredType: "TimeAxis",
  });
  const meterMarks = normalizeMeterMarks(
    await capture.call(timeAxis, "getAllMeasureMarks", [], {
      resultFormat: "typed-v2",
      resultShape: "array",
    })
  );
  const quarterBlick = await capture.index("QUARTER");
  const expectedMarks = target.storedContext.context.meterMarks;
  const expectedQuarter = target.storedContext.context.quarterBlick;
  if (
    quarterBlick !== expectedQuarter ||
    JSON.stringify(meterMarks) !== JSON.stringify(expectedMarks)
  ) {
    throw codedError("STALE_CONTEXT", "the musical timebase or meter map changed after snapshot");
  }
  target.liveMusicalContextVerified = true;
}

async function verifyAnchoredNote(capture, target, expected) {
  // 缓存只省略对同一音符的重复宿主读取（按 indexInGroup 键），指纹比对每次调用都必须执行：
  // 若命中缓存即返回，同一 index 的第二份不同指纹会搭首份验证的车绕过比对（复审 R-P2）。
  target.anchorObservedByIndex ??= new Map();
  let observed = target.anchorObservedByIndex.get(expected.indexInGroup);
  if (!observed) {
    const note = await capture.call(target.group, "getNote", [expected.indexInGroup + 1], {
      inferredType: "Note",
    });
    if (!note?.__handle__) {
      throw codedError("STALE_CONTEXT", `anchored note ${expected.indexInGroup} no longer exists`);
    }
    observed = {
      indexInGroup: (await capture.call(note, "getIndexInParent")) - 1,
      onsetBlick: await capture.call(note, "getOnset"),
      durationBlick: await capture.call(note, "getDuration"),
      pitch: await capture.call(note, "getPitch"),
      lyrics: await capture.call(note, "getLyrics"),
      phonemesOverride: await capture.call(note, "getPhonemes"),
      languageOverride: await capture.call(note, "getLanguageOverride"),
      detuneCents: await capture.call(note, "getDetune"),
    };
    target.anchorObservedByIndex.set(expected.indexInGroup, observed);
  }
  const comparableExpected = {
    indexInGroup: expected.indexInGroup,
    onsetBlick: expected.onsetBlick,
    durationBlick: expected.durationBlick,
    pitch: expected.pitch,
    lyrics: expected.lyrics,
    phonemesOverride: expected.phonemesOverride,
    languageOverride: expected.languageOverride,
    detuneCents: expected.detuneCents,
  };
  if (JSON.stringify(observed) !== JSON.stringify(comparableExpected)) {
    const error = codedError(
      "STALE_CONTEXT",
      `anchored note ${expected.indexInGroup} changed after snapshot`
    );
    error.expectedFingerprint = comparableExpected;
    error.observedFingerprint = observed;
    throw error;
  }
  return observed;
}

function resolveIntervalPosition(startBlick, endBlick, position, label) {
  if (position === "onset" || position === "start") return startBlick;
  if (position === "end") return endBlick;
  const ratio = position === "center" ? 0.5 : position.ratio;
  const fraction = numberToFraction(ratio, `${label} ratio`);
  const length = endBlick - startBlick;
  const numerator = length * fraction.numerator;
  if (!Number.isSafeInteger(numerator) || numerator % fraction.denominator !== 0) {
    throw codedError(
      "LOSSY_NOTE_ANCHOR",
      `${label} ratio ${ratio} cannot be represented exactly for interval ${length}`
    );
  }
  return startBlick + numerator / fraction.denominator;
}

function resolveAnchorOffset(offset, absoluteBase, meterMarks, quarterBlick) {
  if (offset.unit === "blick") {
    if (!Number.isSafeInteger(offset.value)) {
      throw codedError("LOSSY_NOTE_ANCHOR", "blick offsets must be integers");
    }
    return offset.value;
  }
  let scale = quarterBlick;
  if (offset.unit === "beat") {
    let active = meterMarks[0];
    for (const mark of meterMarks) {
      if (mark.positionBlick <= absoluteBase) active = mark;
      else break;
    }
    scale = (quarterBlick * 4) / active.denominator;
  }
  const fraction = numberToFraction(offset.value, `${offset.unit} offset`);
  const numerator = fraction.numerator * scale;
  if (!Number.isSafeInteger(numerator) || numerator % fraction.denominator !== 0) {
    throw codedError(
      "LOSSY_NOTE_ANCHOR",
      `${offset.unit} offset ${offset.value} cannot be represented exactly in integer blicks`
    );
  }
  return numerator / fraction.denominator;
}

// 空操作判定必须精确：planned 与 journal 逐点 blick/value 全等（二者均按 blick 升序），
// 且未请求 simplify——simplify 即使在等值计划下也可能合法地删除控制点。
function curvePlanIsNoOp(plan) {
  if (plan.simplifyThreshold !== undefined) return false;
  if (plan.planned.length !== plan.journal.length) return false;
  return plan.planned.every(
    (point, index) =>
      point.blick === plan.journal[index].blick && point.value === plan.journal[index].value
  );
}

async function assertSharedTargetMutationConfirmed(capture, resolved, requested) {
  const confirmed = requested.allowSharedTargetMutation === true;
  if (!confirmed && resolved.sharedTargetOccurrences.length > 1) {
    const error = codedError(
      "SHARED_TARGET_REQUIRES_CONFIRMATION",
      "the target NoteGroup is referenced by multiple occurrences; set allowSharedTargetMutation:true to confirm that every reference may change"
    );
    error.sharedTargetOccurrences = resolved.sharedTargetOccurrences;
    throw error;
  }
  resolved.projectTargetOccurrences = await scanTargetOccurrences(
    capture,
    resolved.roots.project,
    resolved.groupUuid
  );
  if (!confirmed && resolved.projectTargetOccurrences.length > 1) {
    const error = codedError(
      "SHARED_TARGET_REQUIRES_CONFIRMATION",
      "the target NoteGroup has multiple project occurrences; set allowSharedTargetMutation:true to confirm a project-wide edit"
    );
    error.projectTargetOccurrences = resolved.projectTargetOccurrences;
    throw error;
  }
}

export async function applyCurvePlan(capture, plan) {
  await capture.call(plan.automation, "remove", [plan.range.fromLocal, plan.range.toLocal]);
  for (const point of plan.planned) {
    await capture.call(plan.automation, "add", [point.blick, point.value]);
  }
  if (plan.simplifyThreshold !== undefined) {
    await capture.call(plan.automation, "simplify", [
      plan.range.fromLocal,
      plan.range.toLocal,
      plan.simplifyThreshold,
    ]);
  }
}

async function resolveAutomation(capture, target, parameter, context = {}) {
  const resolvedTarget = await resolveCurveTarget(capture, target, context);
  // expectedGroupUuid 是读写共用的目标身份守卫：直连 target（无 contextId）在读取路径
  // 也必须校验，否则读端接受错误 UUID、写端 TARGET_CONFLICT，语义不一致（黑盒审计 F-02）。
  // 写路径的同一校验在 executeCurveTransaction 的 preflight 里。
  if (
    target.expectedGroupUuid !== undefined &&
    target.expectedGroupUuid !== resolvedTarget.groupUuid
  ) {
    throw codedError(
      "TARGET_CONFLICT",
      `expected group UUID ${target.expectedGroupUuid}, observed ${resolvedTarget.groupUuid}`
    );
  }
  // expectedNotes/expectedTimeOffsetBlick 与 expectedGroupUuid 同为读写共用守卫：读取路径也校验
  // 锚点音符与 reference 偏移未漂移，否则读端接受漂移、写端 STALE_CONTEXT，语义不一致。
  // 写路径的同一校验在 executeCurveTransaction。
  if (
    target.expectedTimeOffsetBlick !== undefined &&
    target.expectedTimeOffsetBlick !== resolvedTarget.groupTimeOffsetBlick
  ) {
    throw codedError(
      "STALE_CONTEXT",
      `the group reference moved after snapshot: expected timeOffsetBlick ${target.expectedTimeOffsetBlick}, observed ${resolvedTarget.groupTimeOffsetBlick}; re-snapshot and re-plan`
    );
  }
  if (target.expectedNotes) {
    for (const expected of target.expectedNotes) {
      await verifyAnchoredNote(capture, resolvedTarget, expected);
    }
  }
  const resolvedParameter = await resolveParameterName(capture, resolvedTarget, parameter);
  return {
    ...resolvedTarget,
    requestedParameter: parameter,
    resolvedParameter,
    ...(await resolveAutomationForTarget(capture, resolvedTarget, resolvedParameter)),
  };
}

export async function resolveParameterName(capture, target, requestedParameter) {
  const builtin = BUILTIN_PARAMETER_BY_LOWERCASE.get(requestedParameter.toLowerCase());
  if (builtin) return builtin;
  if (!requestedParameter.toLowerCase().startsWith("vocalmode_")) {
    throw unknownParameterError(requestedParameter, []);
  }

  if (!target.vocalModeParameterByLowercase) {
    const voice = normalizeVoiceParameters(
      await capture.call(target.reference, "getVoice", [], { resultFormat: "typed-v2" })
    );
    target.vocalModeParameterByLowercase = new Map(
      getVocalModeNames(voice).map((name) => {
        const parameter = `vocalMode_${name}`;
        return [parameter.toLowerCase(), parameter];
      })
    );
  }
  const resolved = target.vocalModeParameterByLowercase.get(requestedParameter.toLowerCase());
  if (resolved) return resolved;
  throw unknownParameterError(requestedParameter, [
    ...target.vocalModeParameterByLowercase.values(),
  ]);
}

function unknownParameterError(requestedParameter, vocalModeParameters) {
  const available = [...BUILTIN_PARAMETER_BY_LOWERCASE.values(), ...vocalModeParameters];
  const error = codedError(
    "UNKNOWN_PARAMETER",
    `unknown Automation parameter "${requestedParameter}"; available parameters: ${available.join(", ")}`
  );
  error.requestedParameter = requestedParameter;
  error.availableParameters = available;
  return error;
}

async function resolveCurveTarget(capture, target, context = {}) {
  let requestedTarget = target;
  let contextOccurrence = null;
  let storedContext = null;
  if (target.contextId) {
    if (!context.snapshotService) {
      throw codedError("CONTEXT_UNAVAILABLE", "range context resolution is not configured");
    }
    storedContext = context.snapshotService.getContext(target.contextId, context.epoch, {
      capsule: context.planCapsule ?? null,
    });
    if (storedContext.context?.kind !== "range") {
      throw codedError("INVALID_CONTEXT", "contextId does not identify a range snapshot");
    }
    // occurrence 必填（见 normalizeTarget）：曲线锚定在特定 occurrence 的音符上，
    // 因此没有"唯一候选自动选择"语义。
    contextOccurrence = selectOccurrenceByOrdinal(
      storedContext.context.occurrences,
      target.occurrence,
      {
        eligible: (item) =>
          typeof item.targetGroupUuid === "string" && item.targetGroupUuid.length > 0,
        noneCode: "INVALID_CONTEXT",
        noneMessage: `context ${target.contextId} contains no editable vocal occurrence`,
        ambiguousMessage: "range context has multiple vocal occurrences; pass one occurrence ordinal",
        ineligibleCode: "INVALID_TARGET",
        ineligibleMessage: "instrumental occurrences have no automation to edit",
      }
    ).occurrence;
    if (
      contextOccurrence.sharedTargetOccurrences.length > 1 &&
      context.readOnly !== true &&
      target.allowSharedTargetMutation !== true
    ) {
      const error = codedError(
        "SHARED_TARGET_REQUIRES_CONFIRMATION",
        "the target NoteGroup is referenced by multiple occurrences; set allowSharedTargetMutation:true to confirm that every reference may change"
      );
      error.sharedTargetOccurrences = contextOccurrence.sharedTargetOccurrences;
      throw error;
    }
    requestedTarget = {
      trackIndex: contextOccurrence.trackIndex,
      groupIndex: contextOccurrence.groupIndex,
      expectedGroupUuid: target.expectedGroupUuid ?? contextOccurrence.targetGroupUuid,
    };
  }
  const roots = await capture.roots();
  const trackCount = await capture.call(roots.project, "getNumTracks");
  if (requestedTarget.trackIndex >= trackCount) {
    throw codedError(
      "TRACK_INDEX_OUT_OF_RANGE",
      `trackIndex ${requestedTarget.trackIndex} is outside 0-${Math.max(0, trackCount - 1)} (native index ${requestedTarget.trackIndex + 1})`
    );
  }
  const track = await capture.call(roots.project, "getTrack", [requestedTarget.trackIndex + 1], {
    inferredType: "Track",
  });
  const groupCount = await capture.call(track, "getNumGroups");
  if (requestedTarget.groupIndex >= groupCount) {
    throw codedError(
      "GROUP_INDEX_OUT_OF_RANGE",
      `groupIndex ${requestedTarget.groupIndex} is outside 0-${Math.max(0, groupCount - 1)} (native index ${requestedTarget.groupIndex + 1})`
    );
  }
  const reference = await capture.call(track, "getGroupReference", [requestedTarget.groupIndex + 1], {
    inferredType: "NoteGroupReference",
  });
  if (await capture.call(reference, "isInstrumental")) {
    throw codedError("INVALID_TARGET", "instrumental groups have no parameter automation");
  }
  const group = await capture.call(reference, "getTarget", [], { inferredType: "NoteGroup" });
  const groupUuid = await capture.call(group, "getUUID");
  if (
    target.contextId &&
    requestedTarget.expectedGroupUuid !== undefined &&
    requestedTarget.expectedGroupUuid !== groupUuid
  ) {
    throw codedError(
      target.contextId ? "STALE_CONTEXT" : "TARGET_CONFLICT",
      `expected group UUID ${requestedTarget.expectedGroupUuid}, observed ${groupUuid}`
    );
  }
  const projectTargetOccurrences =
    context.readOnly === true && context.scanSharedTargets !== true
      ? []
      : await scanTargetOccurrences(capture, roots.project, groupUuid);
  const knownOccurrenceCount = Math.max(
    projectTargetOccurrences.length,
    contextOccurrence?.sharedTargetOccurrences?.length ?? 0
  );
  if (
    knownOccurrenceCount > 1 &&
    context.readOnly !== true &&
    target.allowSharedTargetMutation !== true
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
    reference,
    group,
    groupOnsetBlick: await capture.call(reference, "getOnset"),
    // local → absolute 的真正偏移；getOnset 含首音符 onset，不能用。
    groupTimeOffsetBlick: await capture.call(reference, "getTimeOffset"),
    groupUuid,
    trackIndex: requestedTarget.trackIndex,
    groupIndex: requestedTarget.groupIndex,
    contextOccurrence,
    storedContext,
    sharedTargetOccurrences: contextOccurrence?.sharedTargetOccurrences ?? [],
    projectTargetOccurrences,
  };
}

export async function scanTargetOccurrences(capture, project, targetUuid) {
  const occurrences = [];
  const trackCount = await capture.call(project, "getNumTracks");
  for (let trackIndex = 0; trackIndex < trackCount; trackIndex += 1) {
    const track = await capture.call(project, "getTrack", [trackIndex + 1], {
      inferredType: "Track",
    });
    const groupCount = await capture.call(track, "getNumGroups");
    for (let groupIndex = 0; groupIndex < groupCount; groupIndex += 1) {
      const reference = await capture.call(track, "getGroupReference", [groupIndex + 1], {
        inferredType: "NoteGroupReference",
      });
      if (await capture.call(reference, "isInstrumental")) continue;
      const target = await capture.call(reference, "getTarget", [], { inferredType: "NoteGroup" });
      if ((await capture.call(target, "getUUID")) !== targetUuid) continue;
      occurrences.push({
        trackIndex,
        groupIndex,
        timeOffsetBlick: await capture.call(reference, "getTimeOffset"),
      });
    }
  }
  return occurrences;
}

async function resolveAutomationForTarget(capture, target, parameter) {
  const group = target.group;
  const automation = await capture.call(group, "getParameter", [parameter], {
    inferredType: "Automation",
  });
  if (!automation?.__handle__) {
    throw codedError("UNKNOWN_PARAMETER", `the host returned no Automation for "${parameter}"`);
  }
  const definition = await capture.call(automation, "getDefinition", [], {
    resultFormat: "typed-v2",
  });
  if (
    !definition ||
    !Array.isArray(definition.range) ||
    definition.range.length !== 2 ||
    !definition.range.every(Number.isFinite) ||
    typeof definition.typeName !== "string"
  ) {
    throw codedError(
      "HOST_DATA_INVALID",
      "Automation.getDefinition returned no usable typeName/range"
    );
  }
  const typeName = await capture.call(automation, "getType");
  if (
    typeof typeName !== "string" ||
    typeName.toLowerCase() !== parameter.toLowerCase() ||
    definition.typeName.toLowerCase() !== parameter.toLowerCase()
  ) {
    const error = codedError(
      "PARAMETER_RESOLUTION_MISMATCH",
      `requested Automation ${parameter}, but the host resolved getType=${String(typeName)} and definition.typeName=${definition.typeName}`
    );
    error.requestedParameter = parameter;
    error.observedTypeName = typeName;
    error.observedDefinitionTypeName = definition.typeName;
    throw error;
  }
  return {
    automation,
    definition,
    typeName,
    interpolationMethod: await capture.call(automation, "getInterpolationMethod"),
  };
}

// 常见曲线一次 getAllPoints 后本地过滤，使耗时只与点数相关；超帧才按请求范围二分。
export async function readPointsInRange(capture, automation, range, { maxPoints }) {
  try {
    const raw = await capture.call(automation, "getAllPoints", [], {
      resultFormat: "typed-v2",
      resultShape: "array",
    });
    return limitPoints(
      normalizePoints(raw).filter(
        (point) => point.blick >= range.fromLocal && point.blick <= range.toLocal
      ),
      maxPoints
    );
  } catch (error) {
    if (error?.code !== "FRAME_TOO_LARGE") throw error;
    return readPointsChunked(capture, automation, range, { maxPoints });
  }
}

async function readPointsChunked(capture, automation, range, { maxPoints }) {
  const points = [];
  const windows = [{ from: range.fromLocal, to: range.toLocal }];
  while (windows.length > 0) {
    const { from: windowStart, to: windowEnd } = windows.pop();
    let raw;
    try {
      raw = await capture.call(automation, "getPoints", [windowStart, windowEnd], {
        resultFormat: "typed-v2",
        resultShape: "array",
      });
    } catch (error) {
      if (error?.code === "FRAME_TOO_LARGE") {
        if (windowEnd - windowStart + 1 <= MIN_READ_WINDOW_BLICK) {
          throw codedError(
            "CURVE_TOO_DENSE",
            `curve density exceeds the pipe frame limit even within a ${MIN_READ_WINDOW_BLICK}-blick window`
          );
        }
        const midpoint = windowStart + Math.floor((windowEnd - windowStart) / 2);
        // 栈中先放右侧，保证弹出后仍按 blick 升序输出。
        windows.push({ from: midpoint + 1, to: windowEnd });
        windows.push({ from: windowStart, to: midpoint });
        continue;
      }
      throw error;
    }
    for (const point of normalizePoints(raw)) {
      if (points.length >= maxPoints) {
        return { points, truncated: true, nextFromBlick: point.blick };
      }
      points.push(point);
    }
  }
  return { points, truncated: false, nextFromBlick: null };
}

function limitPoints(points, maxPoints) {
  if (points.length <= maxPoints) {
    return { points, truncated: false, nextFromBlick: null };
  }
  return {
    points: points.slice(0, maxPoints),
    truncated: true,
    nextFromBlick: points[maxPoints].blick,
  };
}

export async function verifyCurve(
  capture,
  automation,
  planned,
  observed,
  definition,
  simplifyThreshold,
  observedTruncated
) {
  const valueTolerance = curveValueTolerance(definition);
  // 读回被截断说明范围内点数远超计划，本身就是后置条件失败。
  if (observedTruncated) {
    return {
      attempted: true,
      passed: false,
      mode: simplifyThreshold === undefined ? "exact" : "tolerance_sampled",
      evidence: {
        observedPointCount: observed.length,
        plannedPointCount: planned.length,
        observationTruncated: true,
      },
    };
  }
  if (simplifyThreshold === undefined) {
    const comparison = compareExactPoints(planned, observed, valueTolerance);
    return {
      attempted: true,
      passed: comparison.firstMismatch === null,
      mode: "exact",
      evidence: {
        observedPointCount: observed.length,
        plannedPointCount: planned.length,
        valueTolerance,
        maxValueDelta: comparison.maxValueDelta,
        ...(comparison.firstMismatch ? { firstMismatch: comparison.firstMismatch } : {}),
      },
    };
  }
  // simplify 合法地移除控制点；验证退化为按计划点位置采样，偏差以 threshold 为界。
  // 官方契约保证 simplify 只删除点，因此读回点必须是计划点的子集；这也避免自行模拟
  // Linear/Cosine/Cubic 插值而产生错误的“已验证”结论。
  let maxDeviation = 0;
  for (const point of planned) {
    const value = await capture.call(automation, "get", [point.blick]);
    maxDeviation = Math.max(maxDeviation, Math.abs(value - point.value));
  }
  const plannedByBlick = new Map(planned.map((point) => [point.blick, point]));
  let maxObservedPointDeviation = 0;
  let unexpectedObservedPointCount = 0;
  for (const point of observed) {
    const expected = plannedByBlick.get(point.blick);
    if (!expected) {
      unexpectedObservedPointCount += 1;
      continue;
    }
    maxObservedPointDeviation = Math.max(
      maxObservedPointDeviation,
      Math.abs(point.value - expected.value)
    );
  }
  const effectiveTolerance = simplifyThreshold + valueTolerance;
  return {
    attempted: true,
    passed:
      maxDeviation <= effectiveTolerance &&
      maxObservedPointDeviation <= valueTolerance &&
      unexpectedObservedPointCount === 0,
    mode: "tolerance_sampled",
    evidence: {
      observedPointCount: observed.length,
      plannedPointCount: planned.length,
      maxDeviation,
      maxObservedPointDeviation,
      unexpectedObservedPointCount,
      tolerance: simplifyThreshold,
      valueTolerance,
      effectiveTolerance,
    },
  };
}

function compareExactPoints(planned, observed, valueTolerance) {
  let firstMismatch = null;
  let maxValueDelta = 0;
  const sharedLength = Math.min(planned.length, observed.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const requested = planned[index];
    const actual = observed[index];
    const signedValueDelta = actual.value - requested.value;
    const absoluteValueDelta = Math.abs(signedValueDelta);
    maxValueDelta = Math.max(maxValueDelta, absoluteValueDelta);
    if (
      firstMismatch === null &&
      (actual.blick !== requested.blick || absoluteValueDelta > valueTolerance)
    ) {
      firstMismatch = {
        index,
        reason: actual.blick !== requested.blick ? "blick" : "value",
        requested: { blick: requested.blick, value: requested.value },
        observed: { blick: actual.blick, value: actual.value },
        delta: { blick: actual.blick - requested.blick, value: signedValueDelta },
        absoluteValueDelta,
        valueTolerance,
      };
    }
  }
  if (firstMismatch === null && planned.length !== observed.length) {
    const index = sharedLength;
    const requested = planned[index] ?? null;
    const actual = observed[index] ?? null;
    firstMismatch = {
      index,
      reason: "point_count",
      requested,
      observed: actual,
      delta: null,
      valueTolerance,
    };
  }
  return { firstMismatch, maxValueDelta };
}

function curveValueTolerance(definition) {
  const [minimum, maximum] = definition.range;
  return Math.max(
    MIN_VALUE_TOLERANCE,
    Math.abs(maximum - minimum) * RANGE_RELATIVE_TOLERANCE
  );
}

export async function rollbackCurve(capture, automation, range, journal, definition) {
  const errors = [];
  try {
    await capture.call(automation, "remove", [range.fromLocal, range.toLocal]);
  } catch (error) {
    if (isUnknownOutcomeError(error)) {
      return { verified: false, outcomeUnknown: true, error: rollbackError(error) };
    }
    errors.push(rollbackError(error));
  }
  // 单点补偿写失败不终止其余补偿；宿主超时/断开才放弃。
  for (const point of journal) {
    try {
      await capture.call(automation, "add", [point.blick, point.value]);
    } catch (error) {
      if (isUnknownOutcomeError(error)) {
        return { verified: false, outcomeUnknown: true, error: rollbackError(error) };
      }
      errors.push(rollbackError(error));
    }
  }
  try {
    const observedRead = await readPointsInRange(capture, automation, range, {
      maxPoints: MAX_JOURNAL_POINTS,
    });
    const observed = observedRead.points;
    const valueTolerance = curveValueTolerance(definition);
    const verified =
      errors.length === 0 &&
      !observedRead.truncated &&
      observed.length === journal.length &&
      journal.every(
        (point, index) =>
          observed[index].blick === point.blick &&
          Math.abs(observed[index].value - point.value) <= valueTolerance
      );
    return {
      verified,
      outcomeUnknown: false,
      ...(errors.length > 0 ? { error: errors[0], errors } : {}),
    };
  } catch (error) {
    return {
      verified: false,
      outcomeUnknown: isUnknownOutcomeError(error),
      error: rollbackError(error),
      ...(errors.length > 0 ? { errors } : {}),
    };
  }
}

function rollbackError(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "ROLLBACK_FAILED",
    message: error instanceof Error ? error.message : String(error),
  };
}

async function closeBoundary(capture, resolved, warnings, onSuccess) {
  try {
    await capture.call(resolved.roots.project, "newUndoRecord", []);
    onSuccess();
  } catch (error) {
    warnings.push({
      code: "UNDO_BOUNDARY_CLOSE_FAILED",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function toLocalRange(range, groupOnsetBlick) {
  const offset = range.coordinate === "absolute" ? groupOnsetBlick : 0;
  return { fromLocal: range.fromBlick - offset, toLocal: range.toBlick - offset };
}

async function resolveCurveRange(capture, target, range) {
  if (range.kind !== "semantic") return toLocalRange(range, target.groupTimeOffsetBlick);
  if (!target.contextOccurrence || !target.storedContext) {
    throw codedError("CONTEXT_REQUIRED", "semantic ranges require a target from sv_snapshot_range");
  }
  const [from] = await resolveCurvePoints(capture, target, [{ ...range.from, value: 0 }], {
    coordinate: "local",
  });
  const [to] = await resolveCurvePoints(capture, target, [{ ...range.to, value: 0 }], {
    coordinate: "local",
  });
  if (to.localBlick <= from.localBlick) {
    throw codedError(
      "INVALID_ARGUMENTS",
      "semantic range end must resolve after its start"
    );
  }
  return {
    fromLocal: from.localBlick,
    toLocal: to.localBlick,
    resolvedFrom: from,
    resolvedTo: to,
  };
}

function formatResolvedRange(inputRange, resolvedRange) {
  if (inputRange.kind === "semantic") {
    return {
      coordinate: "semantic",
      from: {
        source: resolvedRange.resolvedFrom.source,
        input: resolvedRange.resolvedFrom.input,
        localBlick: resolvedRange.resolvedFrom.localBlick,
        absoluteBlick: resolvedRange.resolvedFrom.absoluteBlick,
      },
      to: {
        source: resolvedRange.resolvedTo.source,
        input: resolvedRange.resolvedTo.input,
        localBlick: resolvedRange.resolvedTo.localBlick,
        absoluteBlick: resolvedRange.resolvedTo.absoluteBlick,
      },
      localFromBlick: resolvedRange.fromLocal,
      localToBlick: resolvedRange.toLocal,
    };
  }
  return {
    coordinate: inputRange.coordinate,
    fromBlick: inputRange.fromBlick,
    toBlick: inputRange.toBlick,
    localFromBlick: resolvedRange.fromLocal,
    localToBlick: resolvedRange.toLocal,
  };
}

function normalizePoints(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter((entry) => Array.isArray(entry) && entry.length >= 2)
    .map((entry) => ({ blick: entry[0], value: entry[1] }))
    .filter((point) => Number.isFinite(point.blick) && Number.isFinite(point.value))
    .sort((a, b) => a.blick - b.blick);
}

function inlinePoints(points, groupOnsetBlick, maximum = MAX_INLINE_POINTS) {
  return points.slice(0, maximum).map((point) => ({
    localBlick: point.blick,
    absoluteBlick: point.blick + groupOnsetBlick,
    value: point.value,
  }));
}

function pointStats(points) {
  if (points.length === 0) return { count: 0, min: null, max: null, mean: null };
  const values = points.map((point) => point.value);
  return {
    count: points.length,
    min: Math.min(...values),
    max: Math.max(...values),
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
  };
}

function formatBatchValidationFailure(request, error, { elapsedMs }) {
  const rawCurves = Array.isArray(request?.curves) ? request.curves : [];
  const failure = failureEvidence(error, "validate", null);
  const target = isRecord(request?.target)
    ? {
        ...(typeof request.target.contextId === "string"
          ? { contextId: request.target.contextId }
          : {}),
        ...(Number.isSafeInteger(request.target.occurrence)
          ? { occurrence: request.target.occurrence }
          : {}),
        ...(Number.isSafeInteger(request.target.trackIndex)
          ? { trackIndex: request.target.trackIndex }
          : {}),
        ...(Number.isSafeInteger(request.target.groupIndex)
          ? { groupIndex: request.target.groupIndex }
          : {}),
        ...(typeof request.target.expectedGroupUuid === "string"
          ? { expectedGroupUuid: request.target.expectedGroupUuid }
          : {}),
      }
    : null;
  return {
    ok: false,
    status: "failed",
    effects: "none",
    atomicity: request?.atomic === false ? "none" : "verified_compensation",
    indexBase: 0,
    responseMode: ["compact", "standard", "verbose"].includes(request?.responseMode)
      ? request.responseMode
      : "standard",
    target,
    curves: rawCurves.map((curve, index) => {
      const requestedParameter =
        typeof curve?.parameter === "string" ? curve.parameter : null;
      return {
        parameter: requestedParameter,
        requestedParameter,
        resolvedParameter: null,
        status: failure.curveIndex === index ? "failed" : "not_attempted",
        ...(failure.curveIndex === index ? { error: failure } : {}),
      };
    }),
    clampedCount: 0,
    rollback: { attempted: false, verified: null, curves: [] },
    undo: undoEvidence(0),
    undoRecords: 0,
    undoLabel: typeof request?.undoLabel === "string" ? request.undoLabel : null,
    undoLabelApplied: false,
    verification: {
      attempted: false,
      passed: null,
      verifiedCurves: 0,
      totalCurves: rawCurves.length,
    },
    error: failure,
    warnings: [],
    timings: {
      dispatcherQueueMs: null,
      validationMs: elapsedMs,
      coordinatorQueueMs: null,
      preflightReadMs: 0,
      hostWriteMs: 0,
      verificationMs: 0,
      rollbackMs: 0,
      operationMs: 0,
      serviceTotalMs: elapsedMs,
    },
  };
}

function formatBatchTransaction(transaction, input) {
  const plansByIndex = new Map(transaction.plans.map((plan) => [plan.index, plan]));
  const curves = input.curves.map((curve, index) =>
    formatBatchCurve(
      plansByIndex.get(index) ?? null,
      curve,
      index,
      transaction,
      input.responseMode
    )
  );
  const verifiedPlans = transaction.plans.filter((plan) => plan.verification?.attempted);
  const noChange = transaction.status === "no_change";
  const undo = noChange
    ? { boundaryCallsCompleted: 0, expectedUserUndoSteps: 0, automaticRollback: false }
    : undoEvidence(transaction.boundaryCalls, {
        automaticRollback: transaction.rollback.attempted,
      });
  const expectedUndoSteps = undo.expectedUserUndoSteps;
  return {
    ok: transaction.ok,
    status: transaction.status,
    effects: transaction.effects,
    atomicity: transaction.atomicity,
    indexBase: 0,
    responseMode: input.responseMode,
    target: {
      ...(input.target.contextId ? { contextId: input.target.contextId } : {}),
      ...(Number.isSafeInteger(input.target.occurrence)
        ? { occurrence: input.target.occurrence }
        : {}),
      ...(transaction.target
        ? {
            trackIndex: transaction.target.trackIndex,
            groupIndex: transaction.target.groupIndex,
          }
        : Number.isSafeInteger(input.target.trackIndex)
          ? { trackIndex: input.target.trackIndex, groupIndex: input.target.groupIndex }
          : {}),
      ...(input.target.expectedGroupUuid
        ? { expectedGroupUuid: input.target.expectedGroupUuid }
        : {}),
      ...(transaction.target ? { groupUuid: transaction.target.groupUuid } : {}),
      ...(transaction.target?.sharedTargetOccurrences?.length
        ? { sharedTargetOccurrences: transaction.target.sharedTargetOccurrences }
        : {}),
    },
    ...(transaction.target ? { targetUuid: transaction.target.groupUuid } : {}),
    curves,
    clampedCount: transaction.plans.reduce((sum, plan) => sum + plan.clampedCount, 0),
    rollback: transaction.rollback,
    undo,
    undoRecords: transaction.boundaryCalls === 0 ? 0 : expectedUndoSteps,
    undoLabel: input.undoLabel,
    undoLabelApplied: false,
    verification: {
      attempted: verifiedPlans.length > 0,
      passed:
        verifiedPlans.length === 0
          ? null
          : verifiedPlans.length === transaction.plans.length &&
            verifiedPlans.every((plan) => plan.verification.passed),
      verifiedCurves: verifiedPlans.filter((plan) => plan.verification.passed).length,
      totalCurves: input.curves.length,
    },
    ...(transaction.failure ? { error: transaction.failure } : {}),
    warnings: transaction.warnings,
    timings: transaction.timings,
  };
}

function formatBatchCurve(plan, input, index, transaction, responseMode) {
  if (!plan) {
    const isFailure = transaction.failure?.curveIndex === index;
    return {
      parameter: input.parameter,
      requestedParameter: input.parameter,
      resolvedParameter: transaction.resolvedParameters[index] ?? null,
      status: isFailure ? "failed" : "not_attempted",
      ...(isFailure ? { error: transaction.failure } : {}),
    };
  }
  const output = {
    parameter: plan.typeName,
    requestedParameter: plan.requestedParameter,
    resolvedParameter: plan.resolvedParameter,
    mode: plan.mode,
    status: plan.status,
    pointCount: (plan.observed ?? plan.planned).length,
    ...pointStatsCompact(plan.observed ?? plan.planned),
    clampedCount: plan.clampedCount,
    simplified: plan.simplifyThreshold !== undefined,
    verified: plan.verification?.passed ?? null,
    valueTolerance: plan.verification?.evidence?.valueTolerance ?? curveValueTolerance(plan.definition),
    timings: plan.timings,
  };
  if (responseMode !== "compact") {
    output.definition = plan.definition;
    output.interpolationMethod = plan.interpolationMethod;
    output.range = formatRange(plan);
    output.before = { pointCount: plan.journal.length, stats: pointStats(plan.journal) };
    output.planned = { pointCount: plan.planned.length, stats: pointStats(plan.planned) };
    output.after = plan.observed
      ? { pointCount: plan.observed.length, stats: pointStats(plan.observed) }
      : null;
    output.verification = plan.verification ?? { attempted: false, passed: null };
    Object.assign(output, formatResolvedInputPositions(plan));
    if (plan.rollback) output.rollback = plan.rollback;
  }
  if (responseMode === "verbose") {
    const offset = transaction.target.groupTimeOffsetBlick;
    output.before.points = inlinePoints(plan.journal, offset, Number.POSITIVE_INFINITY);
    output.planned.points = inlinePoints(plan.planned, offset, Number.POSITIVE_INFINITY);
    if (plan.observed) {
      output.after.points = inlinePoints(plan.observed, offset, Number.POSITIVE_INFINITY);
    }
  }
  return output;
}

function formatRange(plan) {
  return formatResolvedRange(plan.inputRange, plan.range);
}

function formatResolvedInputPositions(plan) {
  if (!plan.resolvedInputPoints.some((point) => point.source !== "blick")) return {};
  return {
    resolvedPositions: plan.resolvedInputPoints.map((point) => ({
      source: point.source,
      input: point.input,
      localBlick: point.localBlick,
      absoluteBlick: point.absoluteBlick,
      value: point.value,
    })),
  };
}

function pointStatsCompact(points) {
  const stats = pointStats(points);
  return { min: stats.min, max: stats.max, mean: stats.mean };
}

async function timed(timings, key, now, task) {
  const startedAt = now();
  try {
    return await task();
  } finally {
    timings[key] += elapsed(startedAt, now());
  }
}

function elapsed(startedAt, endedAt) {
  return Math.max(0, endedAt - startedAt);
}

function withCurveFailure(error, curveIndex, parameter, phase) {
  const wrapped = error instanceof Error ? error : new Error(String(error));
  wrapped.curveIndex = curveIndex;
  wrapped.parameter = parameter;
  if (typeof parameter === "string") wrapped.requestedParameter = parameter;
  wrapped.phase = phase;
  return wrapped;
}

function failureEvidence(error, fallbackPhase, fallbackCurveIndex) {
  return {
    code: typeof error?.code === "string" ? error.code : "HOST_CALL_FAILED",
    message: error instanceof Error ? error.message : String(error),
    phase: error?.phase ?? fallbackPhase,
    curveIndex: Number.isSafeInteger(error?.curveIndex) ? error.curveIndex : fallbackCurveIndex,
    ...(typeof error?.parameter === "string" ? { parameter: error.parameter } : {}),
    ...(typeof error?.requestedParameter === "string"
      ? { requestedParameter: error.requestedParameter }
      : {}),
    ...(Array.isArray(error?.availableParameters)
      ? { availableParameters: error.availableParameters }
      : {}),
    ...(typeof error?.observedTypeName === "string"
      ? { observedTypeName: error.observedTypeName }
      : {}),
    ...(typeof error?.observedDefinitionTypeName === "string"
      ? { observedDefinitionTypeName: error.observedDefinitionTypeName }
      : {}),
    ...(typeof error?.resolvedParameter === "string"
      ? { resolvedParameter: error.resolvedParameter }
      : {}),
    outcome: isUnknownOutcomeError(error) ? "unknown" : "unchanged",
    retryable: isUnknownOutcomeError(error),
  };
}

function normalizeGetRequest(request) {
  if (!isRecord(request)) throw codedError("INVALID_ARGUMENTS", "request must be an object");
  const target = normalizeTarget(request.target);
  const parameter = normalizeParameter(request.parameter);
  if (request.range === undefined) {
    throw codedError(
      "INVALID_ARGUMENTS",
      "range is required; unbounded reads can exceed the 64 KiB pipe frame. Take group bounds from sv_snapshot_range."
    );
  }
  const range = normalizeRange(request.range);
  const maxPoints = clampInteger(request.maxPoints, 1, 2000, MAX_INLINE_POINTS);
  return { target, parameter, range, maxPoints };
}

function normalizeBatchPatchRequest(request) {
  if (!isRecord(request)) throw codedError("INVALID_ARGUMENTS", "request must be an object");
  const target = normalizeTarget(request.target);
  if (!Array.isArray(request.curves) || request.curves.length < 1 || request.curves.length > 16) {
    throw codedError("INVALID_ARGUMENTS", "curves must contain between 1 and 16 items");
  }
  const curves = request.curves.map((curve, index) => {
    try {
      return normalizeCurveInput(curve);
    } catch (error) {
      throw withCurveFailure(error, index, curve?.parameter, "validate");
    }
  });
  if (request.dryRun !== undefined && typeof request.dryRun !== "boolean") {
    throw codedError("INVALID_ARGUMENTS", "dryRun must be a boolean");
  }
  if (request.atomic !== undefined && typeof request.atomic !== "boolean") {
    throw codedError("INVALID_ARGUMENTS", "atomic must be a boolean");
  }
  const responseMode = request.responseMode ?? "standard";
  if (!["compact", "standard", "verbose"].includes(responseMode)) {
    throw codedError(
      "INVALID_ARGUMENTS",
      "responseMode must be compact, standard, or verbose"
    );
  }
  if (
    request.undoLabel !== undefined &&
    (typeof request.undoLabel !== "string" || request.undoLabel.length > 200)
  ) {
    throw codedError("INVALID_ARGUMENTS", "undoLabel must be a string of at most 200 characters");
  }
  return {
    target,
    curves,
    dryRun: request.dryRun === true,
    atomic: request.atomic !== false,
    responseMode,
    undoLabel: request.undoLabel ?? null,
  };
}

export function normalizeCurveInput(request) {
  if (!isRecord(request)) throw codedError("INVALID_ARGUMENTS", "curve must be an object");
  const parameter = normalizeParameter(request.parameter);
  if (!["replace", "add", "scale"].includes(request.mode)) {
    throw codedError("INVALID_ARGUMENTS", "mode must be replace, add, or scale");
  }
  const range = normalizeRange(request.range);
  let points = null;
  let amount = null;
  if (request.mode === "replace") {
    const decodedPoints =
      isRecord(request.points) && request.points.encoding === "dense-table-v1"
        ? decodeDense(request.points)
        : request.points;
    if (!Array.isArray(decodedPoints)) {
      throw codedError(
        "INVALID_ARGUMENTS",
        "replace mode requires a points array or dense-table-v1 envelope"
      );
    }
    if (decodedPoints.length > 2000) {
      throw codedError("INVALID_ARGUMENTS", "points must contain at most 2000 items");
    }
    points = decodedPoints.map((point, index) => normalizeCurvePoint(point, index));
  } else {
    if (!Number.isFinite(request.amount)) {
      throw codedError("INVALID_ARGUMENTS", `${request.mode} mode requires a finite amount`);
    }
    amount = request.amount;
  }
  if (
    request.simplifyThreshold !== undefined &&
    (!Number.isFinite(request.simplifyThreshold) || request.simplifyThreshold < 0)
  ) {
    throw codedError("INVALID_ARGUMENTS", "simplifyThreshold must be a non-negative number");
  }
  return {
    parameter,
    mode: request.mode,
    range,
    points,
    amount,
    simplifyThreshold: request.simplifyThreshold,
  };
}

function normalizeCurvePoint(point, index) {
  if (!isRecord(point) || !Number.isFinite(point.value)) {
    throw codedError("INVALID_ARGUMENTS", `points[${index}] must contain a finite value`);
  }
  const allowedFields = new Set([
    "value",
    "blick",
    "anchor",
    "musicalPosition",
    "rangeBoundary",
    "gap",
  ]);
  const unknownFields = Object.keys(point).filter((field) => !allowedFields.has(field));
  if (unknownFields.length > 0) {
    throw codedError(
      "INVALID_ARGUMENTS",
      `points[${index}] contains unknown field: ${unknownFields.join(", ")}`
    );
  }
  const positionFields = ["blick", "anchor", "musicalPosition", "rangeBoundary", "gap"].filter(
    (field) => point[field] !== undefined
  );
  if (positionFields.length !== 1) {
    throw codedError(
      "INVALID_ARGUMENTS",
      `points[${index}] must specify exactly one position source`
    );
  }
  if (positionFields[0] === "blick") {
    if (!Number.isSafeInteger(point.blick)) {
      throw codedError("INVALID_ARGUMENTS", `points[${index}].blick must be an integer`);
    }
    return { kind: "blick", blick: point.blick, value: point.value };
  }
  if (positionFields[0] === "musicalPosition") {
    let musicalPosition;
    try {
      musicalPosition = normalizeMusicalPoint(
        point.musicalPosition,
        `points[${index}].musicalPosition`
      );
    } catch (error) {
      throw codedError(error?.code ?? "INVALID_ARGUMENTS", error.message);
    }
    return { kind: "musical", musicalPosition, value: point.value };
  }
  if (positionFields[0] === "rangeBoundary") {
    if (!["start", "end"].includes(point.rangeBoundary)) {
      throw codedError("INVALID_ARGUMENTS", `points[${index}].rangeBoundary must be start or end`);
    }
    return { kind: "rangeBoundary", rangeBoundary: point.rangeBoundary, value: point.value };
  }
  if (positionFields[0] === "gap") {
    return { kind: "gap", gap: normalizeNoteGap(point.gap, index), value: point.value };
  }
  return { kind: "anchor", anchor: normalizeNoteAnchor(point.anchor, index), value: point.value };
}

// Note/gap 语义位置的身份改为组内 index（§B2 步骤 7：只替换身份，不缩减坐标语义）。
// position/offset/ratio 的含义完全不变——变的只是"指哪个音符"的写法。
function normalizeNoteAnchor(anchor, index) {
  const label = `points[${index}].anchor`;
  if (!isRecord(anchor) || !Number.isSafeInteger(anchor.note) || anchor.note < 0) {
    throw codedError(
      "INVALID_ARGUMENTS",
      `${label}.note must be a non-negative note index in the group`
    );
  }
  const position = normalizeRelativePosition(
    anchor.position === "ratio" ? { ratio: anchor.ratio } : anchor.position,
    label,
    ["onset", "center", "end"]
  );
  const offset = normalizeAnchorOffset(anchor.offset, label);
  return { note: anchor.note, position, offset };
}

function normalizeNoteGap(gap, index) {
  const label = `points[${index}].gap`;
  if (
    !isRecord(gap) ||
    !Number.isSafeInteger(gap.afterNote) ||
    gap.afterNote < 0 ||
    !Number.isSafeInteger(gap.beforeNote) ||
    gap.beforeNote < 0 ||
    gap.afterNote === gap.beforeNote
  ) {
    throw codedError("INVALID_ARGUMENTS", `${label} requires two distinct note indexes`);
  }
  return {
    afterNote: gap.afterNote,
    beforeNote: gap.beforeNote,
    position: normalizeRelativePosition(
      gap.position === "ratio" ? { ratio: gap.ratio } : gap.position,
      label,
      ["start", "center", "end"]
    ),
    offset: normalizeAnchorOffset(gap.offset, label),
  };
}

function normalizeRelativePosition(position, label, names) {
  if (names.includes(position)) return position;
  if (
    isRecord(position) &&
    Number.isFinite(position.ratio) &&
    position.ratio >= 0 &&
    position.ratio <= 1
  ) {
    return { ratio: position.ratio };
  }
  throw codedError(
    "INVALID_ARGUMENTS",
    `${label}.position must be ${names.join(", ")}, or {ratio:0..1}`
  );
}

function normalizeAnchorOffset(offset, label) {
  if (offset === undefined) return { unit: "blick", value: 0 };
  if (
    !isRecord(offset) ||
    !["blick", "quarter", "beat"].includes(offset.unit) ||
    !Number.isFinite(offset.value)
  ) {
    throw codedError(
      "INVALID_ARGUMENTS",
      `${label}.offset must be {unit:blick|quarter|beat,value:finite number}`
    );
  }
  return { unit: offset.unit, value: offset.value };
}

// target.expectedNotes：可选的锚点音符指纹快照。apply 预检时对每条调用 verifyAnchoredNote，
// 使音符被 UI/raw API 移动（UUID 不变、contextId 未失效）时以 STALE_CONTEXT 失败，而非在旧位置写曲线。
// verifyAnchoredNote 对 8 个指纹字段做严格全等比对，因此这里必须要求完整指纹：
// 缺字段会导致必然失败的假 STALE_CONTEXT，宁可在归一化阶段拒绝。
function normalizeExpectedNotes(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw codedError(
      "INVALID_ARGUMENTS",
      "target.expectedNotes must be a non-empty array when provided"
    );
  }
  if (value.length > MAX_EXPECTED_NOTES) {
    throw codedError(
      "INVALID_ARGUMENTS",
      `target.expectedNotes must contain at most ${MAX_EXPECTED_NOTES} items`
    );
  }
  return value.map((note, index) => {
    const label = `target.expectedNotes[${index}]`;
    if (!isRecord(note)) {
      throw codedError("INVALID_ARGUMENTS", `${label} must be an object`);
    }
    if (!Number.isSafeInteger(note.indexInGroup) || note.indexInGroup < 0) {
      throw codedError("INVALID_ARGUMENTS", `${label}.indexInGroup must be a non-negative integer`);
    }
    for (const field of ["onsetBlick", "durationBlick"]) {
      if (!Number.isSafeInteger(note[field]) || note[field] < 0) {
        throw codedError(
          "INVALID_ARGUMENTS",
          `${label}.${field} must be a non-negative safe integer (full snapshot fingerprint required)`
        );
      }
    }
    if (!Number.isSafeInteger(note.pitch)) {
      throw codedError("INVALID_ARGUMENTS", `${label}.pitch must be an integer MIDI pitch`);
    }
    if (!Number.isFinite(note.detuneCents)) {
      throw codedError("INVALID_ARGUMENTS", `${label}.detuneCents must be a finite number`);
    }
    for (const field of ["lyrics", "phonemesOverride", "languageOverride"]) {
      if (typeof note[field] !== "string" && note[field] !== null) {
        throw codedError(
          "INVALID_ARGUMENTS",
          `${label}.${field} must be a string or null (full snapshot fingerprint required)`
        );
      }
    }
    return {
      indexInGroup: note.indexInGroup,
      onsetBlick: note.onsetBlick,
      durationBlick: note.durationBlick,
      pitch: note.pitch,
      lyrics: note.lyrics,
      phonemesOverride: note.phonemesOverride,
      languageOverride: note.languageOverride,
      detuneCents: note.detuneCents,
    };
  }).map((note, index, all) => {
    // 同一 indexInGroup 出现两份指纹是自相矛盾的请求：两份不可能同时为真，
    // 且重复项会依赖"逐条验证互不影响"的实现细节——在归一化边界直接拒绝。
    for (let prior = 0; prior < index; prior += 1) {
      if (all[prior].indexInGroup === note.indexInGroup) {
        throw codedError(
          "INVALID_ARGUMENTS",
          `target.expectedNotes contains duplicate indexInGroup ${note.indexInGroup}; each anchored note may appear once`
        );
      }
    }
    return note;
  });
}

export function normalizeTarget(target) {
  const expectedNotes = isRecord(target) ? normalizeExpectedNotes(target.expectedNotes) : undefined;
  if (
    isRecord(target) &&
    target.expectedTimeOffsetBlick !== undefined &&
    !Number.isSafeInteger(target.expectedTimeOffsetBlick)
  ) {
    throw codedError(
      "INVALID_ARGUMENTS",
      "target.expectedTimeOffsetBlick must be a safe integer (the occurrence timeOffsetBlick observed at snapshot time)"
    );
  }
  const expectedTimeOffsetBlick = isRecord(target) ? target.expectedTimeOffsetBlick : undefined;
  if (
    isRecord(target) &&
    (target.contextId !== undefined || target.occurrence !== undefined)
  ) {
    if (
      typeof target.contextId !== "string" ||
      target.contextId.length === 0 ||
      !Number.isSafeInteger(target.occurrence) ||
      target.occurrence < 0
    ) {
      throw codedError(
        "INVALID_ARGUMENTS",
        "context targets require a non-empty contextId and a non-negative occurrence ordinal"
      );
    }
    if (
      target.expectedGroupUuid !== undefined &&
      (typeof target.expectedGroupUuid !== "string" || target.expectedGroupUuid.length === 0)
    ) {
      throw codedError("INVALID_ARGUMENTS", "target.expectedGroupUuid must be a non-empty string");
    }
    if (
      target.allowSharedTargetMutation !== undefined &&
      typeof target.allowSharedTargetMutation !== "boolean"
    ) {
      throw codedError("INVALID_ARGUMENTS", "allowSharedTargetMutation must be a boolean");
    }
    return {
      contextId: target.contextId,
      occurrence: target.occurrence,
      allowSharedTargetMutation: target.allowSharedTargetMutation === true,
      ...(target.expectedGroupUuid !== undefined
        ? { expectedGroupUuid: target.expectedGroupUuid }
        : {}),
      ...(expectedTimeOffsetBlick !== undefined ? { expectedTimeOffsetBlick } : {}),
      ...(expectedNotes ? { expectedNotes } : {}),
    };
  }
  if (
    !isRecord(target) ||
    !Number.isSafeInteger(target.trackIndex) ||
    target.trackIndex < 0 ||
    !Number.isSafeInteger(target.groupIndex) ||
    target.groupIndex < 0
  ) {
    throw codedError(
      "INVALID_ARGUMENTS",
      "target must be {trackIndex, groupIndex} with non-negative integers (0-based)"
    );
  }
  if (
    target.expectedGroupUuid !== undefined &&
    (typeof target.expectedGroupUuid !== "string" || target.expectedGroupUuid.length === 0)
  ) {
    throw codedError("INVALID_ARGUMENTS", "target.expectedGroupUuid must be a non-empty string");
  }
  if (
    target.allowSharedTargetMutation !== undefined &&
    typeof target.allowSharedTargetMutation !== "boolean"
  ) {
    throw codedError("INVALID_ARGUMENTS", "allowSharedTargetMutation must be a boolean");
  }
  return {
    trackIndex: target.trackIndex,
    groupIndex: target.groupIndex,
    allowSharedTargetMutation: target.allowSharedTargetMutation === true,
    ...(target.expectedGroupUuid !== undefined
      ? { expectedGroupUuid: target.expectedGroupUuid }
      : {}),
    ...(expectedTimeOffsetBlick !== undefined ? { expectedTimeOffsetBlick } : {}),
    ...(expectedNotes ? { expectedNotes } : {}),
  };
}

function normalizeParameter(parameter) {
  if (
    typeof parameter !== "string" ||
    parameter.length < 1 ||
    parameter.length > 200 ||
    parameter !== parameter.trim() ||
    /[\u0000-\u001f\u007f]/.test(parameter)
  ) {
    throw codedError(
      "INVALID_ARGUMENTS",
      "parameter must be a non-empty Automation typeName without surrounding whitespace or control characters"
    );
  }
  return parameter;
}

function normalizeRange(range) {
  if (isRecord(range) && (range.from !== undefined || range.to !== undefined)) {
    if (!isRecord(range.from) || !isRecord(range.to)) {
      throw codedError("INVALID_ARGUMENTS", "semantic range requires from and to position objects");
    }
    const from = normalizeCurvePoint({ ...range.from, value: 0 }, "range.from");
    const to = normalizeCurvePoint({ ...range.to, value: 0 }, "range.to");
    return {
      kind: "semantic",
      from: stripSyntheticValue(from),
      to: stripSyntheticValue(to),
    };
  }
  if (
    !isRecord(range) ||
    !Number.isSafeInteger(range.fromBlick) ||
    !Number.isSafeInteger(range.toBlick) ||
    range.toBlick <= range.fromBlick
  ) {
    throw codedError(
      "INVALID_ARGUMENTS",
      "range must be {fromBlick, toBlick, coordinate?} with integer toBlick > fromBlick"
    );
  }
  const coordinate = range.coordinate ?? "local";
  if (!["local", "absolute"].includes(coordinate)) {
    throw codedError("INVALID_ARGUMENTS", 'range.coordinate must be "local" or "absolute"');
  }
  return { kind: "blick", fromBlick: range.fromBlick, toBlick: range.toBlick, coordinate };
}

function stripSyntheticValue(point) {
  const { value, ...position } = point;
  return position;
}


function undoEvidence(boundaryCallsCompleted, { automaticRollback = false } = {}) {
  return {
    boundaryCallsCompleted,
    expectedUserUndoSteps: boundaryCallsCompleted === 2 ? 1 : null,
    automaticRollback,
  };
}

function isUnknownOutcomeError(error) {
  if (error?.code === "HOST_TIMEOUT" || error?.code === "HOST_DETACHED") return true;
  return /Timeout waiting|detached|disconnected|EOF/i.test(
    error instanceof Error ? error.message : String(error)
  );
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
