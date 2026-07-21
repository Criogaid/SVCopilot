import { contextGroupNoteCount, resolveContextTarget } from "./context-target.js";
import { analyzePhonemeResult, observedArrayIndices } from "./phoneme-state.js";
import { createHostScope } from "./snapshot.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class ProcessingService {
  constructor(session, snapshotService, { sleepFn = sleep, now = () => Date.now() } = {}) {
    this.session = session;
    this.snapshotService = snapshotService;
    this.sleep = sleepFn;
    this.now = now;
  }

  async wait(request) {
    const options = normalizeRequest(request);
    return this.session.withExclusive(async (host) => {
      let resolved;
      let scope;
      try {
        if (typeof options.contextId === "string") {
          const stored = this.snapshotService.getContext(options.contextId, host.epoch());
          resolved = await resolveContextTarget(host, stored, { verify: false });
          scope = resolved.scope;
          options.expectedNotes ??= contextGroupNoteCount(stored, resolved.notes.length);
        } else {
          scope = createHostScope(host);
          const roots = await scope.roots();
          resolved = { roots, group: options.group };
        }
        return await waitForProcessing(host, {
          ...options,
          roots: resolved.roots,
          group: resolved.group,
          sleepFn: this.sleep,
          now: this.now,
        });
      } finally {
        await scope?.releaseAll();
      }
    });
  }
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
      const analysis = analyzePhonemeResult(lastObservation, expectedNotes);
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
      const observedFrames = values.filter((item) => typeof item === "number").length;
      evidence = { requestedFrames: frames, observedFrames };
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
          values: lastObservation,
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
          values: lastObservation,
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
  if (kind === "computedPitch") {
    for (const [name, value] of [
      ["startBlick", request.startBlick],
      ["intervalBlick", request.intervalBlick],
      ["frames", request.frames],
    ]) {
      const minimum = name === "startBlick" ? 0 : 1;
      if (!Number.isSafeInteger(value) || value < minimum) {
        throw codedError("INVALID_ARGUMENTS", `${name} must be a valid non-negative integer`);
      }
    }
  }
  if (request.requireNonEmpty !== undefined && typeof request.requireNonEmpty !== "boolean") {
    throw codedError("INVALID_ARGUMENTS", "requireNonEmpty must be a boolean");
  }
  return {
    contextId: request.contextId,
    group: request.group,
    kind,
    expectedNotes: request.expectedNotes,
    requireNonEmpty: request.requireNonEmpty === true,
    startBlick: request.startBlick,
    intervalBlick: request.intervalBlick,
    frames: request.frames,
    minimumObservedFrames: Number.isSafeInteger(request.minimumObservedFrames)
      ? request.minimumObservedFrames
      : 1,
    timeoutMs: clampInteger(request.timeoutMs, 0, 30_000, 10_000),
    pollIntervalMs: clampInteger(request.pollIntervalMs, 20, 2_000, 100),
    stablePolls: clampInteger(request.stablePolls, 1, 10, 1),
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

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
