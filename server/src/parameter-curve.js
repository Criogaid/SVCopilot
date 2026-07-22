import { createHostScope } from "./snapshot.js";

// Automation 位于 NoteGroup 本地坐标；对外同时报告 local 与 absolute blick。
// local → absolute 的偏移是 getTimeOffset()；getOnset() 已含首音符 onset，不能用作偏移。
const MAX_INLINE_POINTS = 200;
const VALUE_EPSILON = 1e-9;
// PIPE 单帧上限 64 KiB。窗口大小不能先验保证结果帧不超限（单窗口点数无上限），
// 因此依赖 Relay 把超限 result 变成本命令的 FRAME_TOO_LARGE 稳定错误（连接保持），
// 读取端按该错误二分缩小窗口；到最小窗口仍超限时以 CURVE_TOO_DENSE 显式拒绝。
const READ_WINDOW_BLICK = 8 * 705600;
const MIN_READ_WINDOW_BLICK = 1024;
const MAX_JOURNAL_POINTS = 4000;

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
        const read = await readPointsChunked(capture, resolved.automation, range, {
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
    return this.session.withExclusive(async (host) => {
      const capture = createHostScope(host);
      let boundaryCalls = 0;
      let writeAttempted = false;
      const warnings = [];
      const startedAt = this.now();
      const atomicity = input.atomic ? "verified_compensation" : "none";
      try {
        const resolved = await resolveAutomation(capture, input.target, input.parameter);
        const range = toLocalRange(input.range, resolved.groupTimeOffsetBlick);
        const [minValue, maxValue] = resolved.definition.range;

        // 补偿日志：范围内的全部现有控制点。分段读取以避免超过 PIPE 单帧上限；
        // 超过硬上限的密集范围直接拒绝，而不是带着不完整日志去写。
        const journalRead = await readPointsChunked(capture, resolved.automation, range, {
          maxPoints: MAX_JOURNAL_POINTS,
        });
        if (journalRead.truncated) {
          throw codedError(
            "CURVE_TOO_DENSE",
            `the range holds more than ${MAX_JOURNAL_POINTS} control points; narrow the range before patching`
          );
        }
        const journal = journalRead.points;
        const before = pointStats(journal);

        let planned;
        let clampedCount = 0;
        if (input.mode === "replace") {
          planned = input.points.map((point) => {
            const local = input.range.coordinate === "absolute"
              ? point.blick - resolved.groupTimeOffsetBlick
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
          // add/scale 操作现有控制点（不是连续采样曲线）；结果值 clamp 到官方 range。
          planned = journal.map((point) => {
            const rawValue =
              input.mode === "add" ? point.value + input.amount : point.value * input.amount;
            const value = Math.min(maxValue, Math.max(minValue, rawValue));
            if (value !== rawValue) clampedCount += 1;
            return { blick: point.blick, value };
          });
        }
        planned.sort((a, b) => a.blick - b.blick);
        for (let index = 1; index < planned.length; index += 1) {
          if (planned[index].blick === planned[index - 1].blick) {
            throw codedError("INVALID_ARGUMENTS", "points must have unique positions");
          }
        }
        if (clampedCount > 0) {
          warnings.push({
            code: "CLAMPED_TO_RANGE",
            message: `${clampedCount} computed value(s) were clamped to the official range [${minValue}, ${maxValue}].`,
          });
        }

        if (input.dryRun) {
          return {
            ok: true,
            status: "dry_run",
            effects: "none",
            atomicity,
            data: {
              parameter: resolved.typeName,
              mode: input.mode,
              before: { pointCount: journal.length, stats: before },
              planned: {
                pointCount: planned.length,
                stats: pointStats(planned),
                points: inlinePoints(planned, resolved.groupTimeOffsetBlick),
              },
              clampedCount,
            },
            rollback: { attempted: false, verified: null },
            undo: undoEvidence(0),
            verification: { attempted: false, passed: null },
            warnings,
            timing: { elapsedMs: this.now() - startedAt },
          };
        }

        await capture.call(resolved.roots.project, "newUndoRecord", []);
        boundaryCalls += 1;

        let applyError = null;
        try {
          writeAttempted = true;
          await capture.call(resolved.automation, "remove", [range.fromLocal, range.toLocal]);
          for (const point of planned) {
            await capture.call(resolved.automation, "add", [point.blick, point.value]);
          }
          if (input.simplifyThreshold !== undefined) {
            await capture.call(resolved.automation, "simplify", [
              range.fromLocal,
              range.toLocal,
              input.simplifyThreshold,
            ]);
          }
        } catch (error) {
          applyError = error;
        }

        // 读回本身抛错也必须走补偿路径，而不是漏到外层 catch。
        let verifyError = null;
        let observed = null;
        let verification = null;
        if (!applyError) {
          try {
            const observedRead = await readPointsChunked(capture, resolved.automation, range, {
              maxPoints: MAX_JOURNAL_POINTS,
            });
            observed = observedRead.points;
            verification = await verifyCurve(
              capture,
              resolved.automation,
              planned,
              observed,
              input.simplifyThreshold,
              observedRead.truncated
            );
          } catch (error) {
            verifyError = error;
          }
        }

        if (applyError || verifyError || verification?.passed === false) {
          const causeError = applyError ?? verifyError;
          const failure = causeError
            ? {
                code: typeof causeError?.code === "string" ? causeError.code : "HOST_CALL_FAILED",
                message: causeError instanceof Error ? causeError.message : String(causeError),
              }
            : {
                code: "POSTCONDITION_FAILED",
                message: "The curve did not match the requested points after write-back verification.",
              };
          if (causeError && isUnknownOutcomeError(causeError)) {
            await closeBoundary(capture, resolved, warnings, () => (boundaryCalls += 1));
            return {
              ...failedResult(failure.code, failure.message, "unknown"),
              status: "outcome_unknown",
              atomicity,
              rollback: { attempted: false, verified: null },
              undo: undoEvidence(boundaryCalls),
              warnings,
              timing: { elapsedMs: this.now() - startedAt },
            };
          }
          if (!input.atomic) {
            await closeBoundary(capture, resolved, warnings, () => (boundaryCalls += 1));
            return {
              ...failedResult(failure.code, failure.message, "may_remain"),
              status: "partial",
              atomicity,
              rollback: { attempted: false, verified: null },
              undo: undoEvidence(boundaryCalls),
              ...(verification ? { verification } : {}),
              warnings,
              timing: { elapsedMs: this.now() - startedAt },
            };
          }
          const rollback = await rollbackCurve(capture, resolved.automation, range, journal);
          await closeBoundary(capture, resolved, warnings, () => (boundaryCalls += 1));
          return {
            ...failedResult(
              failure.code,
              failure.message,
              rollback.verified ? "reverted" : rollback.outcomeUnknown ? "unknown" : "may_remain"
            ),
            status: rollback.verified ? "rolled_back" : "rollback_failed",
            atomicity,
            rollback: {
              attempted: true,
              verified: rollback.verified,
              ...(rollback.error ? { error: rollback.error } : {}),
            },
            undo: undoEvidence(boundaryCalls),
            ...(verification ? { verification } : {}),
            warnings,
            timing: { elapsedMs: this.now() - startedAt },
          };
        }

        await closeBoundary(capture, resolved, warnings, () => (boundaryCalls += 1));
        return {
          ok: true,
          status: "succeeded",
          effects: "verified",
          atomicity,
          data: {
            parameter: resolved.typeName,
            mode: input.mode,
            range: {
              coordinate: input.range.coordinate,
              fromBlick: input.range.fromBlick,
              toBlick: input.range.toBlick,
              localFromBlick: range.fromLocal,
              localToBlick: range.toLocal,
            },
            before: { pointCount: journal.length, stats: before },
            after: {
              pointCount: observed.length,
              stats: pointStats(observed),
              points: inlinePoints(observed, resolved.groupTimeOffsetBlick),
            },
            clampedCount,
            simplified: input.simplifyThreshold !== undefined,
          },
          rollback: { attempted: false, verified: null },
          undo: undoEvidence(boundaryCalls),
          verification,
          warnings,
          timing: { elapsedMs: this.now() - startedAt },
        };
      } catch (error) {
        const unknown = isUnknownOutcomeError(error);
        const effects = writeAttempted ? (unknown ? "unknown" : "may_remain") : "none";
        if (boundaryCalls === 1 && !unknown) {
          try {
            await capture.call(
              (await capture.roots()).project,
              "newUndoRecord",
              []
            );
            boundaryCalls += 1;
          } catch (closeError) {
            warnings.push({
              code: "UNDO_BOUNDARY_CLOSE_FAILED",
              message: closeError instanceof Error ? closeError.message : String(closeError),
            });
          }
        }
        return {
          ...failedResult(
            typeof error?.code === "string" ? error.code : "HOST_CALL_FAILED",
            error instanceof Error ? error.message : String(error),
            effects
          ),
          status: writeAttempted ? (unknown ? "outcome_unknown" : "partial") : "failed",
          atomicity,
          rollback: { attempted: false, verified: null },
          undo: undoEvidence(boundaryCalls),
          warnings,
        };
      } finally {
        await capture.releaseAll();
      }
    });
  }
}

async function resolveAutomation(capture, target, parameter) {
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
    !definition.range.every(Number.isFinite)
  ) {
    throw codedError("HOST_DATA_INVALID", "Automation.getDefinition returned no usable range");
  }
  return {
    roots,
    automation,
    definition,
    typeName: await capture.call(automation, "getType"),
    interpolationMethod: await capture.call(automation, "getInterpolationMethod"),
    groupOnsetBlick: await capture.call(reference, "getOnset"),
    // local → absolute 的真正偏移；getOnset 含首音符 onset，不能用。
    groupTimeOffsetBlick: await capture.call(reference, "getTimeOffset"),
    groupUuid: await capture.call(group, "getUUID"),
  };
}

// 分段调用 getPoints：窗口遇 FRAME_TOO_LARGE 时二分重试，成功后逐步恢复窗口大小。
async function readPointsChunked(capture, automation, range, { maxPoints }) {
  const points = [];
  let windowStart = range.fromLocal;
  let windowSize = READ_WINDOW_BLICK;
  while (windowStart <= range.toLocal) {
    const windowEnd = Math.min(windowStart + windowSize - 1, range.toLocal);
    let raw;
    try {
      raw = await capture.call(automation, "getPoints", [windowStart, windowEnd], {
        resultFormat: "typed-v2",
        resultShape: "array",
      });
    } catch (error) {
      if (error?.code === "FRAME_TOO_LARGE") {
        if (windowSize <= MIN_READ_WINDOW_BLICK) {
          throw codedError(
            "CURVE_TOO_DENSE",
            `curve density exceeds the pipe frame limit even within a ${MIN_READ_WINDOW_BLICK}-blick window`
          );
        }
        windowSize = Math.max(MIN_READ_WINDOW_BLICK, Math.floor(windowSize / 2));
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
    windowStart = windowEnd + 1;
    if (windowSize < READ_WINDOW_BLICK) {
      windowSize = Math.min(READ_WINDOW_BLICK, windowSize * 2);
    }
  }
  return { points, truncated: false, nextFromBlick: null };
}

async function verifyCurve(capture, automation, planned, observed, simplifyThreshold, observedTruncated) {
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
    const passed =
      observed.length === planned.length &&
      planned.every(
        (point, index) =>
          observed[index].blick === point.blick &&
          Math.abs(observed[index].value - point.value) <= VALUE_EPSILON
      );
    return {
      attempted: true,
      passed,
      mode: "exact",
      evidence: { observedPointCount: observed.length, plannedPointCount: planned.length },
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
  const tolerance = simplifyThreshold + VALUE_EPSILON;
  return {
    attempted: true,
    passed:
      maxDeviation <= tolerance &&
      maxObservedPointDeviation <= VALUE_EPSILON &&
      unexpectedObservedPointCount === 0,
    mode: "tolerance_sampled",
    evidence: {
      observedPointCount: observed.length,
      plannedPointCount: planned.length,
      maxDeviation,
      maxObservedPointDeviation,
      unexpectedObservedPointCount,
      tolerance: simplifyThreshold,
    },
  };
}

async function rollbackCurve(capture, automation, range, journal) {
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
    const observedRead = await readPointsChunked(capture, automation, range, {
      maxPoints: MAX_JOURNAL_POINTS,
    });
    const observed = observedRead.points;
    const verified =
      errors.length === 0 &&
      !observedRead.truncated &&
      observed.length === journal.length &&
      journal.every(
        (point, index) =>
          observed[index].blick === point.blick &&
          Math.abs(observed[index].value - point.value) <= VALUE_EPSILON
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

function inlinePoints(points, groupOnsetBlick) {
  return points.slice(0, MAX_INLINE_POINTS).map((point) => ({
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
  if (request.dryRun !== undefined && typeof request.dryRun !== "boolean") {
    throw codedError("INVALID_ARGUMENTS", "dryRun must be a boolean");
  }
  if (request.atomic !== undefined && typeof request.atomic !== "boolean") {
    throw codedError("INVALID_ARGUMENTS", "atomic must be a boolean");
  }
  return {
    target,
    parameter,
    mode: request.mode,
    range,
    points,
    amount,
    simplifyThreshold: request.simplifyThreshold,
    dryRun: request.dryRun === true,
    atomic: request.atomic !== false,
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
  return { trackIndex: target.trackIndex, groupIndex: target.groupIndex };
}

function normalizeParameter(parameter) {
  if (typeof parameter !== "string" || !/^[A-Za-z][A-Za-z0-9_]*$/.test(parameter)) {
    throw codedError("INVALID_ARGUMENTS", "parameter must be an official Automation typeName");
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

function undoEvidence(boundaryCallsCompleted) {
  return {
    boundaryCallsCompleted,
    expectedUserUndoSteps: boundaryCallsCompleted === 2 ? 1 : null,
    automaticRollback: false,
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
