import { isDeepStrictEqual } from "node:util";

import { isReadOnlyMethod } from "./host-session.js";
import { collectHandleRefs } from "./wire-codec.js";
import { codedError } from "./coded-error.js";
import { isRecord } from "./value-shape.js";

const STEP_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const MAX_STEPS = 128;
const ROOT_NAMES = new Set([
  "sv",
  "project",
  "timeAxis",
  "mainEditor",
  "arrangement",
  "playback",
]);

export class WorkflowExecutor {
  constructor(session, { now = () => Date.now() } = {}) {
    this.session = session;
    this.now = now;
  }

  async run(request) {
    const validation = validatePlan(request);
    if (!validation.ok) {
      return failureReport(validation.error, {
        outcome: "not-started",
        inputHandleCount: collectHandleRefs(request?.inputs).size,
      });
    }
    return this.session.withExclusive((host) => this._execute(host, validation.plan));
  }

  async _execute(host, plan) {
    const startedAt = this.now();
    const deadline = startedAt + plan.timeoutMs;
    const context = {
      inputs: plan.inputs,
      roots: null,
      steps: Object.create(null),
    };
    const stepReports = [];
    const warnings = [];
    const pendingWriteVerifications = new Map();
    const directResultExports = findDirectResultExports(plan.exports);
    let hostCalls = 0;
    let undoBoundaryCalls = 0;
    let writeAttempted = false;
    let failed = null;

    const callHost = async (operation) => {
      if (this.now() > deadline) throw codedError("RUN_TIMEOUT", "workflow timeout elapsed");
      hostCalls += 1;
      return operation();
    };

    try {
      context.roots = await callHost(() => host.roots());
      if (plan.mode === "write" && plan.undoBoundary !== "none") {
        await callHost(() =>
          host.call({ handle: context.roots.project, method: "newUndoRecord", args: [] })
        );
        undoBoundaryCalls += 1;
      }

      for (const step of plan.steps) {
        const resolvedTarget = resolveTarget(resolveReferences(step.target, context));
        const report = { id: step.id, status: "succeeded", verified: false };
        let result;
        try {
          if (step.op === "call") {
            const resolvedArgs = resolveReferences(step.args, context);
            if (!isReadOnlyMethod(step.method)) writeAttempted = true;
            result = await callHost(() =>
              host.call({
                handle: resolvedTarget,
                method: step.method,
                args: resolvedArgs,
                resultFormat: step.resultFormat,
                resultShape: step.resultShape,
                resultLength: step.resultLength,
              })
            );
            if (!isReadOnlyMethod(step.method)) {
              pendingWriteVerifications.set(step.id, step.method);
            }
          } else {
            result = await callHost(() => host.index({ handle: resolvedTarget, field: step.field }));
          }

          if (step.expect) {
            const assertion = evaluateExpectation(
              result,
              resolveReferences(step.expect, context)
            );
            report.verified = assertion.ok;
            report.observed = summarizeObserved(assertion.observed);
            if (assertion.details) report.assertion = assertion.details;
            if (!assertion.ok) {
              const error = codedError("POSTCONDITION_FAILED", assertion.message);
              error.details = assertion.details;
              throw error;
            }
            if (step.verifiesStep) {
              pendingWriteVerifications.delete(step.verifiesStep);
              report.verifiesStep = step.verifiesStep;
            }
          }

          context.steps[step.id] = { result };
          if (step.retainResult === true) {
            const exportName = directResultExports.get(step.id);
            if (exportName !== undefined) {
              report.resultRef = `#/exports/${escapePointerSegment(exportName)}`;
            }
            else report.result = result;
          }
          stepReports.push(report);
        } catch (error) {
          report.status = "failed";
          report.error = serializeError(error);
          stepReports.push(report);
          failed = { step, error };
          break;
        }
      }
    } catch (error) {
      failed = { step: null, error };
    } finally {
      if (
        plan.mode === "write" &&
        plan.undoBoundary === "before-and-after" &&
        undoBoundaryCalls > 0 &&
        context.roots?.project
      ) {
        try {
          hostCalls += 1;
          await host.call({
            handle: context.roots.project,
            method: "newUndoRecord",
            args: [],
          });
          undoBoundaryCalls += 1;
        } catch (error) {
          warnings.push({
            code: "UNDO_BOUNDARY_CLOSE_FAILED",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    for (const [stepId, method] of pendingWriteVerifications) {
      warnings.push({
        code: "UNVERIFIED_WRITE",
        stepId,
        message: `${method} completed without a linked read-back assertion.`,
      });
    }

    let exports = Object.create(null);
    if (!failed) {
      try {
        for (const [name, ref] of Object.entries(plan.exports)) {
          exports[name] = resolveReferences(ref, context);
        }
      } catch (error) {
        failed = { step: null, error };
      }
    }

    const inputHandles = collectHandleRefs(plan.inputs);
    const responseHandles = collectHandleRefs(exports);
    for (const step of stepReports) {
      if (step.result !== undefined) collectHandleRefs(step.result, responseHandles);
    }
    // 只有进入响应的句柄才转移给调用方；inputs 中的句柄继续由原调用方持有。
    const retainedHandles = new Map(inputHandles);
    collectHandleRefs(exports, retainedHandles);
    for (const step of stepReports) {
      if (step.result !== undefined) collectHandleRefs(step.result, retainedHandles);
    }
    const generatedHandles = collectHandleRefs({ roots: context.roots, steps: context.steps });
    const autoFreedHandles = [];
    const cleanupFailedHandles = [];
    for (const [handle, handleRef] of generatedHandles) {
      if (retainedHandles.has(handle)) continue;
      try {
        hostCalls += 1;
        await host.free(handle);
        autoFreedHandles.push(handleRef);
      } catch (error) {
        cleanupFailedHandles.push(handleRef);
        warnings.push({
          code: "HANDLE_CLEANUP_FAILED",
          message: `Could not release handle ${handle}: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    const handleOwnership = buildHandleOwnership({
      inputHandles,
      generatedHandles,
      responseHandles,
      autoFreedHandles,
      cleanupFailedHandles,
    });

    const elapsedMs = this.now() - startedAt;
    if (failed) {
      const error = serializeError(failed.error);
      const outcome = writeAttempted
        ? isUnknownOutcomeError(failed.error)
          ? "unknown"
          : "partial"
        : "unchanged";
      return {
        ok: false,
        status: outcome === "unknown" ? "outcome_unknown" : outcome === "partial" ? "partial" : "failed",
        error: {
          ...error,
          phase: failed.step ? "execute" : "prepare",
          outcome,
          retryable: outcome !== "unknown" && !writeAttempted,
          ...(failed.step ? { failedStep: failed.step.id } : {}),
        },
        completedSteps: stepReports.filter((step) => step.status === "succeeded").map((step) => step.id),
        steps: stepReports,
        effects: outcome === "unknown" ? "unknown" : writeAttempted ? "may_remain" : "none",
        undo: undoEvidence(undoBoundaryCalls),
        handleOwnership,
        warnings,
        timing: { elapsedMs, hostCalls },
      };
    }

    return {
      ok: true,
      status: "succeeded",
      // effects 只有矩阵（§4.5）里的取值，且它回答的是「宿主里还剩什么」。
      // 纯读取根本没有写入语义，因此按 §10.2.1 省略 effects，而不是谎报 "none"
      // （那会读成"曾尝试写入但什么都没留下"）。
      // 写入路径确实完成了，所以是 verified；缺少读回断言由 UNVERIFIED_WRITE
      // warning 单独表达，不篡改 effects——以前这里的 "verified_or_warned" 既不在
      // 矩阵内，又把一条 warning 的存在混进了 effects 的判断。
      ...(writeAttempted ? { effects: "verified" } : {}),
      exports,
      steps: stepReports,
      undo: undoEvidence(undoBoundaryCalls),
      handleOwnership,
      warnings,
      timing: { elapsedMs, hostCalls },
    };
  }
}

export function validatePlan(request) {
  if (!isRecord(request)) return invalidPlan("workflow request must be an object");
  const mode = request.mode;
  if (mode !== "read" && mode !== "write") return invalidPlan("mode must be read or write");
  if (!Array.isArray(request.steps) || request.steps.length < 1 || request.steps.length > MAX_STEPS) {
    return invalidPlan(`steps must contain 1-${MAX_STEPS} entries`);
  }

  const inputs = isRecord(request.inputs) ? request.inputs : {};
  const seen = new Set();
  const steps = [];
  for (const rawStep of request.steps) {
    if (!isRecord(rawStep) || !STEP_ID_PATTERN.test(rawStep.id ?? "")) {
      return invalidPlan("every step needs a valid id");
    }
    if (seen.has(rawStep.id)) return invalidPlan(`duplicate step id: ${rawStep.id}`);
    if (rawStep.op !== "call" && rawStep.op !== "index") {
      return invalidPlan(`unsupported op in step ${rawStep.id}: ${String(rawStep.op)}`);
    }
    if (Object.hasOwn(rawStep, "return")) {
      return invalidPlan(`step ${rawStep.id} field return was removed; use retainResult`);
    }
    if (rawStep.retainResult !== undefined && typeof rawStep.retainResult !== "boolean") {
      return invalidPlan(`step ${rawStep.id} retainResult must be a boolean`);
    }
    if (rawStep.op === "call") {
      if (typeof rawStep.method !== "string" || !rawStep.method) {
        return invalidPlan(`step ${rawStep.id} needs a method`);
      }
      if (mode === "read" && !isReadOnlyMethod(rawStep.method)) {
        return invalidPlan(`READ_ONLY_VIOLATION: ${rawStep.method} is not classified as read-only`);
      }
      if (rawStep.args !== undefined && !Array.isArray(rawStep.args)) {
        return invalidPlan(`step ${rawStep.id} args must be an array`);
      }
    } else if (typeof rawStep.field !== "string" || !rawStep.field) {
      return invalidPlan(`step ${rawStep.id} needs a field`);
    }
    if (rawStep.verifiesStep !== undefined) {
      if (!STEP_ID_PATTERN.test(rawStep.verifiesStep)) {
        return invalidPlan(`step ${rawStep.id} has an invalid verifiesStep`);
      }
      const mutation = steps.find((step) => step.id === rawStep.verifiesStep);
      if (!mutation) {
        return invalidPlan(`step ${rawStep.id} verifies a forward or unknown step`);
      }
      if (mutation.op !== "call" || isReadOnlyMethod(mutation.method)) {
        return invalidPlan(`step ${rawStep.id} verifies a step that is not a mutation`);
      }
      if (!rawStep.expect) {
        return invalidPlan(`step ${rawStep.id} needs expect when verifiesStep is present`);
      }
      if (rawStep.op === "call" && !isReadOnlyMethod(rawStep.method)) {
        return invalidPlan(`step ${rawStep.id} must be read-only when verifiesStep is present`);
      }
    }
    const referenceError = validateReferences(rawStep, seen, inputs);
    if (referenceError) return invalidPlan(referenceError);
    seen.add(rawStep.id);
    steps.push({
      ...rawStep,
      args: rawStep.args ?? [],
      target: rawStep.target ?? "SV",
      resultFormat: rawStep.resultFormat === "typed-v2" ? "typed-v2" : "legacy",
    });
  }

  const exports = isRecord(request.exports) ? request.exports : {};
  const exportError = validateReferences(exports, seen, inputs);
  if (exportError) return invalidPlan(exportError);
  const timeoutMs = Number.isInteger(request.timeoutMs)
    ? Math.max(100, Math.min(60_000, request.timeoutMs))
    : 30_000;
  const undoBoundary =
    mode === "write"
      ? ["none", "before", "before-and-after"].includes(request.undoBoundary)
        ? request.undoBoundary
        : "before-and-after"
      : "none";

  return {
    ok: true,
    plan: {
      mode,
      steps,
      inputs,
      exports,
      timeoutMs,
      undoBoundary,
    },
  };
}

function validateReferences(value, previousSteps, inputs) {
  for (const pointer of collectReferences(value)) {
    const segments = parsePointer(pointer);
    if (!segments) return `invalid reference: ${pointer}`;
    if (!["steps", "roots", "inputs"].includes(segments[0])) {
      return `reference must start with #/steps, #/roots, or #/inputs: ${pointer}`;
    }
    if (segments.some((segment) => ["__proto__", "prototype", "constructor"].includes(segment))) {
      return `unsafe reference segment: ${pointer}`;
    }
    if (segments[0] === "steps") {
      if (!previousSteps.has(segments[1])) {
        return `forward or unknown step reference: ${pointer}`;
      }
      if (segments[2] !== "result") {
        return `step reference must select its result: ${pointer}`;
      }
    } else if (segments[0] === "roots") {
      if (!ROOT_NAMES.has(segments[1])) return `unknown root reference: ${pointer}`;
    } else {
      try {
        resolvePointer({ inputs }, pointer);
      } catch {
        return `input reference does not exist: ${pointer}`;
      }
    }
  }
  return null;
}

function collectReferences(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, output);
  } else if (isRecord(value)) {
    if (Object.keys(value).length === 1 && typeof value.$ref === "string") {
      output.push(value.$ref);
    } else {
      for (const nested of Object.values(value)) collectReferences(nested, output);
    }
  }
  return output;
}

function resolveReferences(value, context) {
  if (Array.isArray(value)) return value.map((item) => resolveReferences(item, context));
  if (!isRecord(value)) return value;
  if (Object.keys(value).length === 1 && typeof value.$ref === "string") {
    return resolvePointer(context, value.$ref);
  }
  const output = Object.create(null);
  for (const [key, nested] of Object.entries(value)) output[key] = resolveReferences(nested, context);
  return output;
}

function resolvePointer(context, pointer) {
  const segments = parsePointer(pointer);
  if (!segments) throw codedError("INVALID_REFERENCE", `invalid reference: ${pointer}`);
  let current = context;
  for (const segment of segments) {
    if (!isRecord(current) && !Array.isArray(current)) {
      throw codedError("REF_NOT_FOUND", `reference does not exist: ${pointer}`);
    }
    if (["__proto__", "prototype", "constructor"].includes(segment)) {
      throw codedError("INVALID_REFERENCE", `unsafe reference segment: ${segment}`);
    }
    if (!Object.hasOwn(current, segment)) {
      throw codedError("REF_NOT_FOUND", `reference does not exist: ${pointer}`);
    }
    current = current[segment];
  }
  return current;
}

function parsePointer(pointer) {
  if (typeof pointer !== "string" || !pointer.startsWith("#/")) return null;
  const segments = pointer
    .slice(2)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
  return segments.length > 0 ? segments : null;
}

function resolveTarget(value) {
  if (value === "SV" || value === undefined || value === null) return undefined;
  if (isRecord(value) && Number.isSafeInteger(value.__handle__)) return value;
  throw codedError("REF_TYPE_MISMATCH", "target must resolve to SV or a handle reference");
}

function evaluateExpectation(value, expectation) {
  if (!isRecord(expectation) || typeof expectation.operator !== "string") {
    throw codedError("INVALID_EXPECTATION", "expect must contain an operator");
  }
  const observed = expectation.select
    ? resolvePointer({ value }, `#/value${expectation.select}`)
    : value;
  let ok = false;
  let details = null;
  switch (expectation.operator) {
    case "equals":
      ok = isDeepStrictEqual(observed, expectation.value);
      break;
    case "notEquals":
      ok = !isDeepStrictEqual(observed, expectation.value);
      break;
    case "exists":
      ok = observed !== undefined && observed !== null;
      break;
    case "nonEmpty":
      ok =
        (typeof observed === "string" || Array.isArray(observed))
          ? observed.length > 0
          : isRecord(observed) && Object.keys(observed).length > 0;
      break;
    case "lengthEquals":
      ok = observed?.length === expectation.value;
      break;
    case "everyNonEmptyString":
      ok =
        Array.isArray(observed) &&
        observed.length > 0 &&
        observed.every((item) => typeof item === "string" && item.length > 0);
      break;
    case "coverageAtLeast": {
      const threshold = Number(expectation.value);
      if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
        throw codedError("INVALID_EXPECTATION", "coverageAtLeast value must be between 0 and 1");
      }
      const covered = Array.isArray(observed)
        ? observed.filter((item) => item !== null && item !== undefined).length
        : 0;
      const observedCoverage = Array.isArray(observed) && observed.length > 0
        ? covered / observed.length
        : 0;
      details = {
        observedCoverage,
        requiredCoverage: threshold,
        coveredItems: covered,
        totalItems: Array.isArray(observed) ? observed.length : 0,
      };
      ok = Array.isArray(observed) && observed.length > 0 && observedCoverage >= threshold;
      break;
    }
    default:
      throw codedError("INVALID_EXPECTATION", `unsupported operator: ${expectation.operator}`);
  }
  return {
    ok,
    observed,
    details,
    message: ok
      ? "expectation passed"
      : `expectation ${expectation.operator} did not match the observed result`,
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
  return (
    error?.code === "RUN_TIMEOUT" ||
    /Timeout waiting|detached|disconnected|EOF/i.test(error instanceof Error ? error.message : String(error))
  );
}

function failureReport(error, { outcome, inputHandleCount = 0 }) {
  return {
    ok: false,
    status: "failed",
    error: { ...serializeError(error), phase: "validate", outcome, retryable: true },
    completedSteps: [],
    steps: [],
    effects: "none",
    undo: undoEvidence(0),
    handleOwnership: emptyHandleOwnership(inputHandleCount),
    warnings: [],
    timing: { elapsedMs: 0, hostCalls: 0 },
  };
}

function buildHandleOwnership({
  inputHandles,
  generatedHandles,
  responseHandles,
  autoFreedHandles,
  cleanupFailedHandles,
}) {
  const returnedHandles = [...responseHandles.values()]
    .map(summarizeHandleRef)
    .sort((left, right) => left.__handle__ - right.__handle__);
  const failedHandles = cleanupFailedHandles
    .map(summarizeHandleRef)
    .sort((left, right) => left.__handle__ - right.__handle__);
  return {
    policy: "caller_frees_returned_handles",
    inputHandleCount: inputHandles.size,
    observedHandleCount: generatedHandles.size,
    autoFreedHandleCount: autoFreedHandles.length,
    returnedHandles,
    cleanupFailedHandles: failedHandles,
    callerMustFree: returnedHandles.length > 0 || failedHandles.length > 0,
  };
}

function emptyHandleOwnership(inputHandleCount = 0) {
  return {
    policy: "caller_frees_returned_handles",
    inputHandleCount,
    observedHandleCount: 0,
    autoFreedHandleCount: 0,
    returnedHandles: [],
    cleanupFailedHandles: [],
    callerMustFree: false,
  };
}

function summarizeHandleRef(value) {
  const output = { __handle__: value.__handle__ };
  if (typeof value.__type__ === "string") output.__type__ = value.__type__;
  if (Number.isSafeInteger(value.__epoch__)) output.__epoch__ = value.__epoch__;
  return output;
}

function invalidPlan(message) {
  return { ok: false, error: codedError("INVALID_PLAN", message) };
}

function serializeError(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "HOST_CALL_FAILED",
    message: error instanceof Error ? error.message : String(error),
    ...(error?.details !== undefined ? { details: error.details } : {}),
  };
}

function findDirectResultExports(exports) {
  const result = new Map();
  for (const [name, value] of Object.entries(exports)) {
    if (!isRecord(value) || Object.keys(value).length !== 1 || typeof value.$ref !== "string") {
      continue;
    }
    const segments = parsePointer(value.$ref);
    if (segments?.length === 3 && segments[0] === "steps" && segments[2] === "result") {
      if (!result.has(segments[1])) result.set(segments[1], name);
    }
  }
  return result;
}

function summarizeObserved(value) {
  if (!Array.isArray(value) || value.length <= 32) return value;
  const finiteNumbers = value.filter((item) => typeof item === "number" && Number.isFinite(item));
  return {
    valueShape: "array",
    count: value.length,
    populatedCount: value.filter((item) => item !== null && item !== undefined).length,
    numericCount: finiteNumbers.length,
    ...(finiteNumbers.length > 0
      ? { min: Math.min(...finiteNumbers), max: Math.max(...finiteNumbers) }
      : {}),
  };
}

function escapePointerSegment(value) {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}
