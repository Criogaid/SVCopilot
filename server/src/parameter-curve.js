import { createHostScope } from "./snapshot.js";
import { getVocalModeNames, normalizeVoiceParameters } from "./voice-parameters.js";

// Automation 位于 NoteGroup 本地坐标；对外同时报告 local 与 absolute blick。
// local → absolute 的偏移是 getTimeOffset()；getOnset() 已含首音符 onset，不能用作偏移。
const MAX_INLINE_POINTS = 200;
const MIN_VALUE_TOLERANCE = 1e-6;
const RANGE_RELATIVE_TOLERANCE = 1e-6;
const MIN_READ_WINDOW_BLICK = 1024;
const MAX_JOURNAL_POINTS = 4000;
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

export class ParameterCurveService {
  constructor(session, { now = () => Date.now() } = {}) {
    this.session = session;
    this.now = now;
  }

  async getCurve(request) {
    const input = normalizeGetRequest(request);
    return this.session.withExclusive(async (host) => {
      const capture = createHostScope(host);
      try {
        const resolved = await resolveAutomation(capture, input.target, input.parameter);
        const range = toLocalRange(input.range, resolved.groupTimeOffsetBlick);
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
            range: {
              coordinate: input.range.coordinate,
              fromBlick: input.range.fromBlick,
              toBlick: input.range.toBlick,
              localFromBlick: range.fromLocal,
              localToBlick: range.toLocal,
            },
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

  async patchCurve(request) {
    const input = normalizePatchRequest(request);
    const transaction = await this._runTransaction({
      target: input.target,
      curves: [curveInput(input)],
      dryRun: input.dryRun,
      atomic: input.atomic,
      responseMode: "legacy",
      undoLabel: null,
    });
    return formatSingleTransaction(transaction);
  }

  async patchCurves(request) {
    const serviceStartedAt = this.now();
    let input;
    try {
      input = normalizeBatchPatchRequest(request);
    } catch (error) {
      return formatBatchValidationFailure(request, error, {
        elapsedMs: elapsed(serviceStartedAt, this.now()),
      });
    }
    const coordinatorRequestedAt = this.now();
    const transaction = await this._runTransaction(input, {
      serviceStartedAt,
      coordinatorRequestedAt,
    });
    return formatBatchTransaction(transaction, input);
  }

  async _runTransaction(input, timingOrigin = {}) {
    const serviceStartedAt = timingOrigin.serviceStartedAt ?? this.now();
    const coordinatorRequestedAt = timingOrigin.coordinatorRequestedAt ?? serviceStartedAt;
    return this.session.withExclusive(async (host) => {
      const acquiredAt = this.now();
      const capture = createHostScope(host);
      try {
        return await executeCurveTransaction(capture, input, {
          now: this.now,
          serviceStartedAt,
          coordinatorRequestedAt,
          acquiredAt,
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
      transaction.target = await resolveCurveTarget(capture, input.target);
      if (
        input.target.expectedGroupUuid !== undefined &&
        input.target.expectedGroupUuid !== transaction.target.groupUuid
      ) {
        throw codedError(
          "TARGET_CONFLICT",
          `expected group UUID ${input.target.expectedGroupUuid}, observed ${transaction.target.groupUuid}`
        );
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
      return finish();
    }

    phase = "execute";
    await timed(timings, "hostWriteMs", clock.now, async () => {
      await capture.call(transaction.target.roots.project, "newUndoRecord", []);
      transaction.boundaryCalls += 1;
    });
    for (const plan of transaction.plans) {
      failedCurveIndex = plan.index;
      const curveStartedAt = clock.now();
      touched.push(plan);
      plan.status = "writing";
      try {
        await timed(timings, "hostWriteMs", clock.now, () => applyCurvePlan(capture, plan));
        plan.timings.hostWriteMs = elapsed(curveStartedAt, clock.now());
        plan.status = "written";
      } catch (error) {
        plan.timings.hostWriteMs = elapsed(curveStartedAt, clock.now());
        throw withCurveFailure(error, plan.index, plan.typeName, "execute");
      }
    }

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
        throw withCurveFailure(error, plan.index, plan.typeName, "verify");
      }
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

async function prepareCurvePlan(capture, target, input, index) {
  const resolved = await resolveAutomationForTarget(capture, target, input.parameter);
  const range = toLocalRange(input.range, target.groupTimeOffsetBlick);
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
  if (input.mode === "replace") {
    planned = input.points.map((point) => {
      const local = input.range.coordinate === "absolute"
        ? point.blick - target.groupTimeOffsetBlick
        : point.blick;
      if (local < range.fromLocal || local > range.toLocal) {
        throw codedError(
          "INVALID_ARGUMENTS",
          `replace point at ${point.blick} lies outside the requested range`
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
    observed: null,
    simplifyThreshold: input.simplifyThreshold,
    clampedCount,
    verification: null,
    rollback: null,
    warnings,
    timings: { preflightReadMs: 0, hostWriteMs: 0, verificationMs: 0, rollbackMs: 0 },
  };
}

async function applyCurvePlan(capture, plan) {
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

async function resolveAutomation(capture, target, parameter) {
  const resolvedTarget = await resolveCurveTarget(capture, target);
  const resolvedParameter = await resolveParameterName(capture, resolvedTarget, parameter);
  return {
    ...resolvedTarget,
    requestedParameter: parameter,
    resolvedParameter,
    ...(await resolveAutomationForTarget(capture, resolvedTarget, resolvedParameter)),
  };
}

async function resolveParameterName(capture, target, requestedParameter) {
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

async function resolveCurveTarget(capture, target) {
  const roots = await capture.roots();
  const trackCount = await capture.call(roots.project, "getNumTracks");
  if (target.trackIndex >= trackCount) {
    throw codedError(
      "TRACK_INDEX_OUT_OF_RANGE",
      `trackIndex ${target.trackIndex} is outside 0-${Math.max(0, trackCount - 1)} (native index ${target.trackIndex + 1})`
    );
  }
  const track = await capture.call(roots.project, "getTrack", [target.trackIndex + 1], {
    inferredType: "Track",
  });
  const groupCount = await capture.call(track, "getNumGroups");
  if (target.groupIndex >= groupCount) {
    throw codedError(
      "GROUP_INDEX_OUT_OF_RANGE",
      `groupIndex ${target.groupIndex} is outside 0-${Math.max(0, groupCount - 1)} (native index ${target.groupIndex + 1})`
    );
  }
  const reference = await capture.call(track, "getGroupReference", [target.groupIndex + 1], {
    inferredType: "NoteGroupReference",
  });
  if (await capture.call(reference, "isInstrumental")) {
    throw codedError("INVALID_TARGET", "instrumental groups have no parameter automation");
  }
  const group = await capture.call(reference, "getTarget", [], { inferredType: "NoteGroup" });
  return {
    roots,
    reference,
    group,
    groupOnsetBlick: await capture.call(reference, "getOnset"),
    // local → absolute 的真正偏移；getOnset 含首音符 onset，不能用。
    groupTimeOffsetBlick: await capture.call(reference, "getTimeOffset"),
    groupUuid: await capture.call(group, "getUUID"),
  };
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
async function readPointsInRange(capture, automation, range, { maxPoints }) {
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

async function verifyCurve(
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

async function rollbackCurve(capture, automation, range, journal, definition) {
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

function formatSingleTransaction(transaction) {
  const plan = transaction.plans[0] ?? null;
  const timing = { elapsedMs: transaction.timings.serviceTotalMs };
  if (transaction.ok && transaction.status === "dry_run") {
    return {
      ok: true,
      status: "dry_run",
      effects: "none",
      atomicity: transaction.atomicity,
      data: {
        parameter: plan.typeName,
        requestedParameter: plan.requestedParameter,
        resolvedParameter: plan.resolvedParameter,
        mode: plan.mode,
        before: { pointCount: plan.journal.length, stats: pointStats(plan.journal) },
        planned: {
          pointCount: plan.planned.length,
          stats: pointStats(plan.planned),
          points: inlinePoints(plan.planned, transaction.target.groupTimeOffsetBlick),
        },
        clampedCount: plan.clampedCount,
      },
      rollback: { attempted: false, verified: null },
      undo: undoEvidence(0),
      verification: { attempted: false, passed: null },
      warnings: transaction.warnings,
      timing,
    };
  }
  if (transaction.ok) {
    return {
      ok: true,
      status: "succeeded",
      effects: "verified",
      atomicity: transaction.atomicity,
      data: {
        parameter: plan.typeName,
        requestedParameter: plan.requestedParameter,
        resolvedParameter: plan.resolvedParameter,
        mode: plan.mode,
        range: formatRange(plan),
        before: { pointCount: plan.journal.length, stats: pointStats(plan.journal) },
        after: {
          pointCount: plan.observed.length,
          stats: pointStats(plan.observed),
          points: inlinePoints(plan.observed, transaction.target.groupTimeOffsetBlick),
        },
        clampedCount: plan.clampedCount,
        simplified: plan.simplifyThreshold !== undefined,
      },
      rollback: { attempted: false, verified: null },
      undo: undoEvidence(transaction.boundaryCalls, {
        automaticRollback: transaction.rollback.attempted,
      }),
      verification: plan.verification,
      warnings: transaction.warnings,
      timing,
    };
  }

  const failure = transaction.failure ?? {
    code: "HOST_CALL_FAILED",
    message: "curve transaction failed",
  };
  const base = failedResult(failure.code, failure.message, transaction.effects);
  const firstRollbackError = transaction.rollback.curves.find((curve) => curve.error)?.error;
  return {
    ...base,
    status: transaction.status,
    atomicity: transaction.atomicity,
    rollback: {
      attempted: transaction.rollback.attempted,
      verified: transaction.rollback.verified,
      ...(firstRollbackError ? { error: firstRollbackError } : {}),
    },
    undo: undoEvidence(transaction.boundaryCalls, {
      automaticRollback: transaction.rollback.attempted,
    }),
    ...(plan?.verification ? { verification: plan.verification } : {}),
    warnings: transaction.warnings,
    timing,
  };
}

function formatBatchValidationFailure(request, error, { elapsedMs }) {
  const rawCurves = Array.isArray(request?.curves) ? request.curves : [];
  const failure = failureEvidence(error, "validate", null);
  const target = isRecord(request?.target)
    ? {
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
  const undo = undoEvidence(transaction.boundaryCalls, {
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
      trackIndex: input.target.trackIndex,
      groupIndex: input.target.groupIndex,
      ...(input.target.expectedGroupUuid
        ? { expectedGroupUuid: input.target.expectedGroupUuid }
        : {}),
      ...(transaction.target ? { groupUuid: transaction.target.groupUuid } : {}),
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
  return {
    coordinate: plan.inputRange.coordinate,
    fromBlick: plan.inputRange.fromBlick,
    toBlick: plan.inputRange.toBlick,
    localFromBlick: plan.range.fromLocal,
    localToBlick: plan.range.toLocal,
  };
}

function pointStatsCompact(points) {
  const stats = pointStats(points);
  return { min: stats.min, max: stats.max, mean: stats.mean };
}

function curveInput(input) {
  return {
    parameter: input.parameter,
    mode: input.mode,
    range: input.range,
    points: input.points,
    amount: input.amount,
    simplifyThreshold: input.simplifyThreshold,
  };
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

function normalizePatchRequest(request) {
  if (!isRecord(request)) throw codedError("INVALID_ARGUMENTS", "request must be an object");
  const target = normalizeTarget(request.target);
  const curve = normalizeCurveInput(request);
  if (request.dryRun !== undefined && typeof request.dryRun !== "boolean") {
    throw codedError("INVALID_ARGUMENTS", "dryRun must be a boolean");
  }
  if (request.atomic !== undefined && typeof request.atomic !== "boolean") {
    throw codedError("INVALID_ARGUMENTS", "atomic must be a boolean");
  }
  return {
    target,
    ...curve,
    dryRun: request.dryRun === true,
    atomic: request.atomic !== false,
  };
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

function normalizeCurveInput(request) {
  if (!isRecord(request)) throw codedError("INVALID_ARGUMENTS", "curve must be an object");
  const parameter = normalizeParameter(request.parameter);
  if (!["replace", "add", "scale"].includes(request.mode)) {
    throw codedError("INVALID_ARGUMENTS", "mode must be replace, add, or scale");
  }
  const range = normalizeRange(request.range);
  let points = null;
  let amount = null;
  if (request.mode === "replace") {
    if (!Array.isArray(request.points)) {
      throw codedError("INVALID_ARGUMENTS", "replace mode requires a points array");
    }
    if (request.points.length > 2000) {
      throw codedError("INVALID_ARGUMENTS", "points must contain at most 2000 items");
    }
    points = request.points.map((point, index) => {
      if (
        !isRecord(point) ||
        !Number.isFinite(point.blick) ||
        !Number.isSafeInteger(point.blick) ||
        !Number.isFinite(point.value)
      ) {
        throw codedError(
          "INVALID_ARGUMENTS",
          `points[${index}] must be {blick: integer, value: finite number}`
        );
      }
      return { blick: point.blick, value: point.value };
    });
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

function normalizeTarget(target) {
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
  return {
    trackIndex: target.trackIndex,
    groupIndex: target.groupIndex,
    ...(target.expectedGroupUuid !== undefined
      ? { expectedGroupUuid: target.expectedGroupUuid }
      : {}),
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
  return { fromBlick: range.fromBlick, toBlick: range.toBlick, coordinate };
}

function failedResult(code, message, effects) {
  return {
    ok: false,
    status: "failed",
    effects,
    error: {
      code,
      message,
      outcome:
        effects === "none" || effects === "reverted"
          ? "unchanged"
          : effects === "unknown"
            ? "unknown"
            : "partial",
      retryable: false,
    },
    undo: undoEvidence(0),
    verification: { attempted: false, passed: null },
    warnings: [],
  };
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
