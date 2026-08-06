import { analyzePhonemeResult, observedArrayIndices } from "./phoneme-state.js";
import { getStoredComputedPitch, RANGE_REQUEST_LIMITS } from "./musical-range.js";
import { selectOccurrenceByOrdinal } from "./scope-source.js";
import { createHostScope } from "./snapshot.js";
import { ServiceTiming } from "./service-timing.js";
import { contentHash } from "./canonical-json.js";
import { codedError } from "./coded-error.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const MAX_PROCESSING_EXPECTED_NOTES = 100_000;

export class ProcessingService {
  constructor(session, snapshotService, { sleepFn = sleep, now = () => Date.now() } = {}) {
    this.session = session;
    this.snapshotService = snapshotService;
    this.sleep = sleepFn;
    this.now = now;
  }

  async wait(request) {
    const timer = new ServiceTiming({
      now: this.now,
      phaseNames: ["preflightReadMs", "processingWaitMs"],
    });
    const options = normalizeRequest(request);
    timer.requestCoordinator();
    return this.session.withExclusive(async (host) => {
      timer.acquiredCoordinator();
      let resolved;
      let scope;
      try {
        await timer.measure("preflightReadMs", async () => {
          if (typeof options.contextId === "string") {
            const stored = this.snapshotService.getContext(options.contextId, host.epoch());
            resolved = await resolveProcessingContext(
              host,
              stored,
              options.contextId,
              options.occurrence
            );
            scope = resolved.scope;
            options.expectedNotes ??= resolved.expectedNotes;
          } else {
            scope = createHostScope(host);
            const roots = await scope.roots();
            resolved = { roots, group: options.group };
          }
          if (options.kind === "computedPitch") {
            completeComputedPitchSampling(options, resolved.computedPitchSampling);
          }
        });
        const result = await timer.measure("processingWaitMs", () =>
          waitForProcessing(host, {
            ...options,
            roots: resolved.roots,
            group: resolved.group,
            sleepFn: this.sleep,
            now: this.now,
          })
        );
        return {
          ...result,
          ...(resolved.target ? { target: resolved.target } : {}),
          timings: timer.finish(),
        };
      } finally {
        await scope?.releaseAll();
      }
    });
  }
}

/**
 * 嵌套 `processing.status` 的全部取值。
 *
 * 它刻意与根级的 10 个 status 无交集：两者回答的是不同问题（「写入成不成功」与
 * 「附加观察拿到了什么」）。共用词汇会让「这个 succeeded 说的是哪一层」重新变得
 * 需要靠上下文猜——而那正是把子结论抬到根级时犯的错。
 */
export const NESTED_PROCESSING_STATUSES = Object.freeze([
  "observed",
  "observation_failed",
  "not_ready",
]);

/**
 * 把一次 processing 观察的内部结论投影成**嵌套** `processing.status`（计划 §4.5、§10.6
 * 规则 4、§11 删除项 20）。
 *
 * 为什么必须有这一层：观察发生在提交、逐字段读回和 Undo 边界关闭**之后**，因此它的
 * 结论说的是「附加信息拿没拿到」，而不是「这次写入成不成功」。五个 mutation 服务此前
 * 都写成 `status: processing?.status ?? "succeeded"`，把子结论直接抬到根级——那让
 * 一次**已验证成功**的写入按观察结果改写自己的成败：
 *
 *   - `processing_observation_failed` 靠 STATUS_PROJECTION 才勉强回落到 succeeded，
 *     也就是说正确性依赖投影表里恰好有那一行；
 *   - 更糟的是超时那三个（`processing_pending` / `stability_pending` /
 *     `phoneme_coverage_unsatisfied`）投影成 `failed` + `retryable:true`，与服务自己
 *     给出的 `effects:"verified"` 直接冲突。assertStatusEnvelope 会抛错，于是一次
 *     真实成功的写入在编码边界变成 INTERNAL_ERROR；假如它没抛，模型就会收到
 *     「失败且可原样重放」——去重放一个已经写进工程的 mutation。
 *
 * 因此根级 status 与观察结论必须彻底解耦：根级恒为 `succeeded`（写入已验证），
 * 观察结论降级为 `processing.status` 加一条 warning。
 *
 * `sv_wait_for_processing` 不走这里：它的整个目的就是观察，pending 就是它的答案，
 * 那些 status 在它的根级是诚实的。
 *
 * @param {object|null} processing - waitForProcessing 的返回值，或 null（未请求观察）
 * @returns {"observed"|"observation_failed"|"not_ready"|null} 嵌套用的 status
 */
export function nestedProcessingStatus(processing) {
  if (!processing) return null;
  if (processing.status === "succeeded") return "observed";
  // 宿主调用本身抛了错：连结论都没拿到。
  if (processing.status === "processing_observation_failed") return "observation_failed";
  // 观察成功执行但条件未在超时前达成。这不是失败，是「还没就绪」——重放 mutation
  // 无意义，正确动作是再等一轮或重新观察，因此它绝不能带上 retryable。
  return "not_ready";
}

export async function waitForProcessing(
  host,
  {
    roots,
    group,
    kind,
    expectedNotes,
    requireNonEmpty = false,
    startBlick,
    intervalBlick,
    frames,
    minimumObservedFrames = 1,
    includeValues,
    timeoutMs = 10_000,
    pollIntervalMs = 100,
    stablePolls = 1,
    sleepFn = sleep,
    now = () => Date.now(),
  }
) {
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  let attempts = 0;
  let stable = 0;
  let lastObservation = null;
  let evidence = null;
  let readyState = "ready";
  let lastReadyFingerprint = null;
  const shouldIncludeValues = includeValues ?? kind !== "computedPitch";

  while (true) {
    attempts += 1;
    let conditionReady = false;
    let observationFingerprint = null;
    if (kind === "phonemes") {
      lastObservation = await host.call({
        handle: roots.sv,
        method: "getPhonemesForGroup",
        args: [group],
        resultFormat: "typed-v2",
        resultShape: "array",
        ...(Number.isSafeInteger(expectedNotes) ? { resultLength: expectedNotes } : {}),
      });
      const analysis = analyzePhonemeResult(lastObservation, expectedNotes, {
        includePhonemes: false,
      });
      const contentReady = !requireNonEmpty || analysis.emptyPhonemes === 0;
      evidence = {
        ...analysis,
        readinessPolicy: requireNonEmpty ? "all_non_empty" : "allow_empty",
      };
      readyState = analysis.state;
      conditionReady = readyState !== "pending" && contentReady;
      observationFingerprint = JSON.stringify([analysis.computedItems, lastObservation]);
    } else if (kind === "computedAttributes") {
      lastObservation = await host.call({
        handle: roots.sv,
        method: "getComputedAttributesForGroup",
        args: [group],
        resultFormat: "typed-v2",
        resultShape: "array",
        ...(Number.isSafeInteger(expectedNotes) ? { resultLength: expectedNotes } : {}),
      });
      const values = Array.isArray(lastObservation) ? lastObservation : [];
      const observedItems = observedArrayIndices(values).length;
      const ready = Number.isSafeInteger(expectedNotes)
        ? observedItems >= expectedNotes
        : observedItems > 0;
      readyState = expectedNotes === 0 ? "not_applicable" : ready ? "ready" : "pending";
      evidence = {
        expectedNotes: expectedNotes ?? null,
        computedItems: observedItems,
        shapeComplete: ready,
      };
      conditionReady = readyState !== "pending";
      observationFingerprint = JSON.stringify([observedItems, lastObservation]);
    } else {
      lastObservation = await host.call({
        handle: roots.sv,
        method: "getComputedPitchForGroup",
        args: [group, startBlick, intervalBlick, frames],
        resultFormat: "typed-v2",
        resultShape: "array",
        resultLength: frames,
      });
      const values = Array.isArray(lastObservation) ? lastObservation : [];
      const returnedFrames = observedArrayIndices(values).length;
      const normalizedValues = Array.from({ length: values.length }, (_, index) =>
        typeof values[index] === "number" && Number.isFinite(values[index]) ? values[index] : null
      );
      const observedFrames = normalizedValues.filter((item) => item !== null).length;
      evidence = {
        requestedFrames: frames,
        returnedFrames,
        observedFrames,
        nullFrames: returnedFrames - observedFrames,
        coverage: frames > 0 ? observedFrames / frames : 0,
        contentHash: contentHash(normalizedValues),
      };
      conditionReady = observedFrames >= minimumObservedFrames;
      readyState = conditionReady ? "ready" : "pending";
      observationFingerprint = JSON.stringify([observedFrames, lastObservation]);
    }

    if (conditionReady) {
      stable = observationFingerprint === lastReadyFingerprint ? stable + 1 : 1;
      lastReadyFingerprint = observationFingerprint;
    } else {
      stable = 0;
      lastReadyFingerprint = null;
    }

    if (stable >= stablePolls) {
      return {
        ok: true,
        status: "succeeded",
        data: {
          kind,
          state: readyState,
          attempts,
          elapsedMs: now() - startedAt,
          evidence,
          ...(shouldIncludeValues ? { values: lastObservation } : {}),
        },
        warnings: [],
      };
    }
    if (now() >= deadline) {
      const coverageUnsatisfied =
        kind === "phonemes" &&
        requireNonEmpty &&
        readyState === "ready" &&
        evidence.emptyPhonemes > 0;
      const stabilityPending = readyState !== "pending" && !coverageUnsatisfied;
      return {
        ok: true,
        status: coverageUnsatisfied
          ? "phoneme_coverage_unsatisfied"
          : stabilityPending
            ? "stability_pending"
            : "processing_pending",
        data: {
          kind,
          state: readyState,
          attempts,
          elapsedMs: now() - startedAt,
          evidence,
          ...(shouldIncludeValues ? { values: lastObservation } : {}),
        },
        warnings: [
          {
            code: coverageUnsatisfied
              ? "PHONEME_COVERAGE_UNSATISFIED"
              : stabilityPending
                ? "STABILITY_TIMEOUT"
                : "PROCESSING_TIMEOUT",
            message: coverageUnsatisfied
              ? "Processing is complete, but the requested all-non-empty phoneme coverage condition was not met."
              : stabilityPending
                ? `Processing completed, but the ${kind} result did not remain stable for ${stablePolls} polls before timeout.`
                : `Processing did not complete for ${kind} before timeout.`,
          },
        ],
      };
    }
    await sleepFn(Math.min(pollIntervalMs, Math.max(0, deadline - now())));
  }
}

function normalizeRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw codedError("INVALID_ARGUMENTS", "request must be an object");
  }
  const kind = request.kind ?? "phonemes";
  if (!['phonemes', 'computedAttributes', 'computedPitch'].includes(kind)) {
    throw codedError("INVALID_ARGUMENTS", "kind must be phonemes, computedAttributes, or computedPitch");
  }
  if (typeof request.contextId !== "string" && !isHandle(request.group)) {
    throw codedError("INVALID_TARGET", "contextId or group handle is required");
  }
  if (
    request.occurrence !== undefined &&
    (!Number.isSafeInteger(request.occurrence) || request.occurrence < 0)
  ) {
    throw codedError("INVALID_ARGUMENTS", "occurrence must be a non-negative occurrence ordinal");
  }
  if (request.occurrence !== undefined && typeof request.contextId !== "string") {
    throw codedError("INVALID_ARGUMENTS", "occurrence requires contextId");
  }
  if (kind === "computedPitch") {
    validateComputedPitchSampling(request, { allowMissing: true });
  }
  if (request.requireNonEmpty !== undefined && typeof request.requireNonEmpty !== "boolean") {
    throw codedError("INVALID_ARGUMENTS", "requireNonEmpty must be a boolean");
  }
  if (request.includeValues !== undefined && typeof request.includeValues !== "boolean") {
    throw codedError("INVALID_ARGUMENTS", "includeValues must be a boolean");
  }
  // expectedNotes 直接决定 resultLength 数组分配；不做上限会允许 [1,1e6) 级别的无谓大分配。
  if (
    request.expectedNotes !== undefined &&
    (!Number.isSafeInteger(request.expectedNotes) ||
      request.expectedNotes < 0 ||
      request.expectedNotes > MAX_PROCESSING_EXPECTED_NOTES)
  ) {
    throw codedError(
      "INVALID_ARGUMENTS",
      `expectedNotes must be an integer between 0 and ${MAX_PROCESSING_EXPECTED_NOTES}`
    );
  }
  const minimumObservedFrames = clampInteger(
    request.minimumObservedFrames,
    1,
    RANGE_REQUEST_LIMITS.computedPitchFramesPerGroup,
    1
  );
  if (
    kind === "computedPitch" &&
    request.frames !== undefined &&
    minimumObservedFrames > request.frames
  ) {
    throw codedError(
      "INVALID_ARGUMENTS",
      "minimumObservedFrames cannot exceed the requested frame count"
    );
  }
  return {
    contextId: request.contextId,
    occurrence: request.occurrence,
    group: request.group,
    kind,
    expectedNotes: request.expectedNotes,
    requireNonEmpty: request.requireNonEmpty === true,
    includeValues: request.includeValues ?? kind !== "computedPitch",
    startBlick: request.startBlick,
    intervalBlick: request.intervalBlick,
    frames: request.frames,
    minimumObservedFrames,
    timeoutMs: clampInteger(request.timeoutMs, 0, 30_000, 10_000),
    pollIntervalMs: clampInteger(request.pollIntervalMs, 20, 2_000, 100),
    stablePolls: clampInteger(request.stablePolls, 1, 10, 1),
  };
}

async function resolveProcessingContext(host, stored, contextId, requestedOccurrence) {
  const selected = selectContextOccurrence(stored, contextId, requestedOccurrence);
  const capturedPitch = getStoredComputedPitch(stored, selected.occurrence);
  const scope = createHostScope(host);
  try {
    const roots = await scope.roots();
    const track = await scope.call(roots.project, "getTrack", [selected.trackIndex + 1], {
      inferredType: "Track",
    });
    const group = await scope.call(track, "getGroupReference", [selected.groupIndex + 1], {
      inferredType: "NoteGroupReference",
    });
    if (await scope.call(group, "isInstrumental")) {
      throw codedError("INVALID_TARGET", "instrumental groups have no computed vocal processing");
    }
    const target = await scope.call(group, "getTarget", [], { inferredType: "NoteGroup" });
    const observedGroupUuid = await scope.call(target, "getUUID");
    if (selected.expectedGroupUuid && observedGroupUuid !== selected.expectedGroupUuid) {
      throw codedError("STALE_CONTEXT", "the target note group changed after snapshot capture");
    }
    const expectedNotes = await scope.call(target, "getNumNotes");
    return {
      scope,
      roots,
      group,
      expectedNotes,
      computedPitchSampling: capturedPitch
        ? {
            startBlick: capturedPitch.startBlick,
            intervalBlick: capturedPitch.intervalBlick,
            frames: capturedPitch.frames,
          }
        : null,
      target: {
        contextId,
        ...(Number.isSafeInteger(selected.occurrence) ? { occurrence: selected.occurrence } : {}),
        trackIndex: selected.trackIndex,
        groupIndex: selected.groupIndex,
        groupUuid: observedGroupUuid,
      },
    };
  } catch (error) {
    await scope.releaseAll();
    if (["INVALID_CONTEXT", "INVALID_TARGET", "STALE_CONTEXT"].includes(error?.code)) {
      throw error;
    }
    throw codedError(
      "STALE_CONTEXT",
      `could not resolve processing target: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function completeComputedPitchSampling(options, capturedSampling) {
  for (const name of ["startBlick", "intervalBlick", "frames"]) {
    options[name] ??= capturedSampling?.[name];
  }
  validateComputedPitchSampling(options, { allowMissing: false });
  if (options.minimumObservedFrames > options.frames) {
    throw codedError(
      "INVALID_ARGUMENTS",
      "minimumObservedFrames cannot exceed the requested frame count"
    );
  }
}

function validateComputedPitchSampling(values, { allowMissing }) {
  for (const [name, minimum] of [
    ["startBlick", 0],
    ["intervalBlick", 1],
    ["frames", 1],
  ]) {
    const value = values[name];
    if (value === undefined && allowMissing) continue;
    if (value === undefined) {
      throw codedError(
        "INVALID_ARGUMENTS",
        `${name} is required for computedPitch unless it can be inferred from a range context captured with include:["computedPitch"]`
      );
    }
    if (!Number.isSafeInteger(value) || value < minimum) {
      const requirement = minimum === 0 ? "a non-negative safe integer" : "a positive safe integer";
      throw codedError("INVALID_ARGUMENTS", `${name} must be ${requirement}`);
    }
  }
  // frames 会直接进入宿主计算并决定结果规模，必须在调用 SynthV 前应用单组硬上限。
  if (values.frames > RANGE_REQUEST_LIMITS.computedPitchFramesPerGroup) {
    throw codedError(
      "INVALID_ARGUMENTS",
      `frames must be between 1 and ${RANGE_REQUEST_LIMITS.computedPitchFramesPerGroup}`
    );
  }
}

function selectContextOccurrence(stored, contextId, requestedOrdinal) {
  if (stored?.context?.kind === "range") {
    const { occurrence, ordinal } = selectOccurrenceByOrdinal(
      stored.context.occurrences,
      requestedOrdinal,
      {
        eligible: (item) => typeof item.targetGroupUuid === "string",
        noneCode: "INVALID_CONTEXT",
        noneMessage: "range context has no editable vocal occurrence",
        ambiguousMessage:
          "range context identifies multiple vocal occurrences; pass one occurrence ordinal",
        ineligibleCode: "INVALID_TARGET",
        ineligibleMessage: "selected occurrence is not an editable vocal group",
      }
    );
    return rangeOccurrenceTarget(occurrence, ordinal);
  }
  if (requestedOrdinal !== undefined) {
    throw codedError(
      "INVALID_CONTEXT",
      "occurrence is only valid with a range snapshot context"
    );
  }
  if (!stored?.context || !["selection", "group"].includes(stored.context.kind)) {
    throw codedError("INVALID_CONTEXT", "context does not identify an editable note group");
  }
  return {
    trackIndex: stored.context.trackIndex,
    groupIndex: stored.context.groupIndex,
    expectedGroupUuid:
      stored.baseData?.group?.uuid ?? stored.baseData?.tracks?.[0]?.groups?.[0]?.uuid ?? null,
  };
}

function rangeOccurrenceTarget(occurrence, ordinal) {
  if (typeof occurrence.targetGroupUuid !== "string") {
    throw codedError("INVALID_TARGET", "selected occurrence is not an editable vocal group");
  }
  return {
    occurrence: ordinal,
    trackIndex: occurrence.trackIndex,
    groupIndex: occurrence.groupIndex,
    expectedGroupUuid: occurrence.targetGroupUuid,
  };
}


function clampInteger(value, minimum, maximum, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw codedError("INVALID_ARGUMENTS", `integer must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function isHandle(value) {
  return value !== null && typeof value === "object" && Number.isSafeInteger(value.__handle__);
}
