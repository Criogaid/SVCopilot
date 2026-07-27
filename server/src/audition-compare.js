import { randomUUID } from "node:crypto";

import { ServiceTiming } from "./service-timing.js";

// sv_audition_compare：既有版本的人类 A/B 试听编排（主计划 P1-D）。
//
// 设计要点：
// - **不复制播放恢复内核**。每个 variant 都通过既有 AuditionService.start/stop 执行，
//   因此启动读回校验、auto-stop 计时、"用户改过就不覆盖"的 mixer 恢复、recovery
//   payload 全部原样复用。本模块只负责编排顺序与状态机。
// - 相同基线：A 结束后完整恢复到原始 playhead/mixer，B 才从同一基线开始。因此
//   "A/B 使用相同 playhead、范围、mixer 基线"是由 restore 保证的，而不是靠假设。
// - 非阻塞：立即返回 comparisonId；get/stop/restore 幂等。
// - **不做"应用临时编辑 -> B -> 自动还原"**：官方 API 没有 Undo 调用，成功提交后
//   不存在通用恢复 token，那样会制造无法撤销的"试听用写入"。本工具只比较已经存在
//   的两个版本（不同 track solo 配置），因此不产生任何工程内容 Undo。
// - MCP 听不到声音：perception 恒为 human_only，只报告播放顺序与恢复证据。

const MAX_VARIANT_TRACKS = 32;
const DEFAULT_GAP_MS = 400;

const PROVENANCE = Object.freeze({
  perception: "human_only",
  playbackKernel: "reuses_sv_start_audition_start_stop_restore",
  baselineGuarantee: "variant_a_fully_restored_before_variant_b_starts",
  projectContentUndo: "none_only_mixer_and_playhead_are_touched",
  temporaryEditsForVariantB: "not_supported_no_undo_api_means_no_general_recovery_token",
});

export class AuditionCompareService {
  constructor(
    auditionService,
    {
      now = () => Date.now(),
      setTimeoutFn = (callback, delay) => setTimeout(callback, delay),
      clearTimeoutFn = (timer) => clearTimeout(timer),
    } = {}
  ) {
    if (!auditionService) {
      throw new Error("AuditionCompareService requires the AuditionService");
    }
    this.audition = auditionService;
    this.now = now;
    this.setTimeout = setTimeoutFn;
    this.clearTimeout = clearTimeoutFn;
    this.comparisons = new Map();
  }

  async compare(request) {
    const timer = new ServiceTiming({ now: this.now });
    const input = normalizeCompareRequest(request);
    pruneTerminal(this.comparisons, 31);
    for (const [existingId, existing] of this.comparisons) {
      if (isTerminal(existing.state)) continue;
      throw codedError(
        "COMPARISON_ACTIVE",
        `comparison ${existingId} is still active; stop it before starting another`
      );
    }

    const comparisonId = `cmp_${randomUUID()}`;
    const createdAt = this.now();
    const comparison = {
      id: comparisonId,
      createdAt,
      input,
      state: "prepared",
      transitionHistory: [{ state: "prepared", at: createdAt }],
      order: input.order,
      playedVariants: [],
      currentVariantIndex: -1,
      currentAuditionId: null,
      currentStopPromise: null,
      transitionPromise: null,
      finishPromise: null,
      lastVariantResult: null,
      timer: null,
      terminalResult: null,
      stopRequested: false,
      warnings: [],
    };
    this.comparisons.set(comparisonId, comparison);

    // 第一个 variant 同步启动，这样启动失败能直接返回给调用方，而不是藏进后台。
    let first;
    try {
      first = await this._startVariant(comparison, 0);
    } catch (error) {
      first = failureResult(error, "AUDITION_START_FAILED");
    }
    if (!first.ok) {
      this._failVariant(comparison, 0, first);
      return { ...comparison.terminalResult, timings: timer.finish() };
    }
    this._scheduleNext(comparison);

    return {
      ok: true,
      status: "succeeded",
      data: {
        comparisonId,
        state: comparison.state,
        transitionHistory: comparison.transitionHistory,
        order: input.order,
        range: { fromBlick: input.fromBlick, toBlick: input.toBlick },
        variants: input.variants.map((variant) => ({
          label: variant.label,
          soloTrackIndices: variant.soloTrackIndices,
        })),
        gapMs: input.gapMs,
        repeats: input.repeats,
        autoRestore: input.autoRestore,
        currentVariant: input.order[0],
        // 每个 variant 的 recovery 都是独立逃生通道：server 崩溃后可用
        // sv_restore_audition 逐个恢复。
        recovery: first.data?.recovery ?? null,
        perception: "human_only",
        humanGate:
          "MCP cannot hear audio. Ask the person which variant they preferred; never state a preference yourself.",
      },
      provenance: PROVENANCE,
      warnings: comparison.warnings,
      timings: timer.finish(),
    };
  }

  async get(request) {
    const timer = new ServiceTiming({ now: this.now });
    const comparison = this._require(request);
    if (comparison.terminalResult) {
      return { ...comparison.terminalResult, timings: timer.finish() };
    }
    // 底层 audition 的实时状态由既有 get 提供，这里不另做一套播放观测。
    let variantState = null;
    if (comparison.currentAuditionId) {
      variantState = await this.audition
        .get({ auditionId: comparison.currentAuditionId })
        .catch((error) => ({
          ok: false,
          error: { code: error?.code ?? "AUDITION_LOOKUP_FAILED", message: String(error?.message ?? error) },
        }));
    }
    return {
      ok: true,
      status: "succeeded",
      data: {
        comparisonId: comparison.id,
        state: comparison.state,
        transitionHistory: comparison.transitionHistory,
        currentVariant: comparison.input.order[comparison.currentVariantIndex] ?? null,
        playedVariants: comparison.playedVariants,
        variantPlayback: variantState,
        perception: "human_only",
      },
      provenance: PROVENANCE,
      warnings: comparison.warnings,
      timings: timer.finish(),
    };
  }

  async stop(request) {
    const timer = new ServiceTiming({ now: this.now });
    const comparison = this._require(request);
    if (comparison.terminalResult) {
      return { ...comparison.terminalResult, timings: timer.finish() };
    }
    comparison.stopRequested = true;
    transition(comparison, "stop_requested", this.now());
    if (comparison.timer) {
      this.clearTimeout(comparison.timer);
      comparison.timer = null;
    }
    // 后台切换可能正在 stop A 或 start B；先等同一条状态迁移收敛，避免漏停刚启动的 B。
    if (comparison.transitionPromise) {
      await comparison.transitionPromise;
      if (comparison.terminalResult) {
        return { ...comparison.terminalResult, timings: timer.finish() };
      }
    }
    const result = await this._finish(comparison, "stopped_by_user");
    return { ...result, timings: timer.finish() };
  }

  // ---------- 内部编排 ----------

  _require(request) {
    if (!isRecord(request) || typeof request.comparisonId !== "string" || !request.comparisonId) {
      throw codedError("INVALID_ARGUMENTS", "comparisonId must be a non-empty string");
    }
    const comparison = this.comparisons.get(request.comparisonId);
    if (!comparison) {
      throw codedError("UNKNOWN_COMPARISON", `comparison not found: ${request.comparisonId}`);
    }
    return comparison;
  }

  async _startVariant(comparison, index) {
    const label = comparison.input.order[index];
    const variant = comparison.input.variants.find((item) => item.label === label);
    comparison.currentVariantIndex = index;
    transition(comparison, `playing_${label}`, this.now());
    // 完全走既有 start：读回校验、auto-stop、restore 语义一次都不重写。
    const result = await this.audition.start({
      fromBlick: comparison.input.fromBlick,
      toBlick: comparison.input.toBlick,
      soloTrackIndices: variant.soloTrackIndices,
      loop: false,
      autoStop: true,
      restore: comparison.input.autoRestore,
      stopToleranceMs: comparison.input.stopToleranceMs,
    });
    if (result.ok) {
      comparison.currentAuditionId = result.data.auditionId;
      comparison.playedVariants.push({
        label,
        auditionId: result.data.auditionId,
        startedAt: result.data.playbackStartedAt,
        soloTrackIndices: variant.soloTrackIndices,
      });
      for (const warning of result.warnings ?? []) {
        comparison.warnings.push({ ...warning, variant: label });
      }
    }
    return result;
  }

  _scheduleNext(comparison) {
    const durationMs = comparison.input.estimatedDurationMs;
    const delay = Math.max(0, durationMs + comparison.input.gapMs);
    comparison.timer = this.setTimeout(() => {
      comparison.timer = null;
      if (comparison.terminalResult || comparison.stopRequested) return null;
      let tracked;
      tracked = this._advance(comparison.id)
        .catch((error) => {
          if (!comparison.terminalResult) {
            this._failVariant(
              comparison,
              Math.max(0, comparison.currentVariantIndex),
              failureResult(error, "AUDITION_TRANSITION_FAILED")
            );
          }
          return comparison.terminalResult;
        })
        .finally(() => {
          if (comparison.transitionPromise === tracked) comparison.transitionPromise = null;
        });
      comparison.transitionPromise = tracked;
      return tracked;
    }, delay);
  }

  async _advance(comparisonId) {
    const comparison = this.comparisons.get(comparisonId);
    if (!comparison || comparison.terminalResult || comparison.stopRequested) return;
    // 上一个 variant 必须完整停止并恢复，B 才能从同一基线开始。stop 幂等：
    // auto-stop 已经跑过时它直接返回记忆的终态。
    const previous = await this._stopCurrentVariant(comparison);
    if (previous && !previous.ok) {
      comparison.warnings.push({
        code: "VARIANT_STOP_INCOMPLETE",
        message: `stopping a variant did not fully restore; see its recovery payload (${previous.status ?? "failed"}).`,
      });
      await this._finish(comparison, "variant_restore_failed", previous);
      return;
    }
    if (comparison.stopRequested) {
      await this._finish(comparison, "stopped_by_user", previous);
      return;
    }
    const nextIndex = comparison.currentVariantIndex + 1;
    if (nextIndex >= comparison.input.order.length) {
      await this._finish(comparison, "completed", previous);
      return;
    }
    transition(comparison, "gap", this.now());
    let started;
    try {
      started = await this._startVariant(comparison, nextIndex);
    } catch (error) {
      started = failureResult(error, "AUDITION_START_FAILED");
    }
    if (!started.ok) {
      comparison.warnings.push({
        code: "VARIANT_START_FAILED",
        message: `variant ${comparison.input.order[nextIndex]} could not start; the comparison ends early.`,
      });
      this._failVariant(comparison, nextIndex, started);
      return;
    }
    if (comparison.stopRequested) {
      await this._finish(comparison, "stopped_by_user");
      return;
    }
    this._scheduleNext(comparison);
  }

  async _stopCurrentVariant(comparison) {
    if (comparison.currentStopPromise) return comparison.currentStopPromise;
    if (!comparison.currentAuditionId) return null;
    const auditionId = comparison.currentAuditionId;
    let tracked;
    tracked = Promise.resolve()
      .then(() => this.audition.stop({ auditionId }))
      .catch((error) => failureResult(error, "AUDITION_STOP_FAILED"))
      .then((result) => {
        comparison.lastVariantResult = result;
        return result;
      })
      .finally(() => {
        if (comparison.currentAuditionId === auditionId) comparison.currentAuditionId = null;
        if (comparison.currentStopPromise === tracked) comparison.currentStopPromise = null;
      });
    comparison.currentStopPromise = tracked;
    return tracked;
  }

  async _finish(comparison, reason, knownStopResult = undefined) {
    if (comparison.terminalResult) return comparison.terminalResult;
    if (comparison.finishPromise) return comparison.finishPromise;
    comparison.finishPromise = this._performFinish(comparison, reason, knownStopResult);
    return comparison.finishPromise;
  }

  async _performFinish(comparison, reason, knownStopResult) {
    if (comparison.timer) {
      this.clearTimeout(comparison.timer);
      comparison.timer = null;
    }
    transition(comparison, "restoring", this.now());
    const finalStop =
      knownStopResult === undefined
        ? await this._stopCurrentVariant(comparison)
        : knownStopResult;
    const restorationResult = finalStop ?? comparison.lastVariantResult;
    const restored = restorationResult?.ok === true;
    transition(comparison, restored ? "restored" : "restore_failed", this.now());
    comparison.terminalResult = {
      ok: restored,
      status: restored ? "succeeded" : "restore_failed",
      data: {
        comparisonId: comparison.id,
        state: comparison.state,
        reason,
        transitionHistory: comparison.transitionHistory,
        order: comparison.input.order,
        playedVariants: comparison.playedVariants,
        finalVariantResult: restorationResult,
        // 恢复证据来自底层 audition 的读回，不是本模块的断言。
        restoreEvidence: restorationResult?.data?.restoration ?? null,
        recovery: restorationResult?.data?.recovery ?? null,
        perception: "human_only",
        humanGate:
          "Ask the person which variant they preferred. MCP has no audio input and cannot judge.",
      },
      provenance: PROVENANCE,
      warnings: comparison.warnings,
    };
    return comparison.terminalResult;
  }

  _failVariant(comparison, index, result) {
    if (comparison.terminalResult) return comparison.terminalResult;
    transition(comparison, "failed", this.now());
    comparison.terminalResult = {
      ok: false,
      status: "failed",
      data: {
        comparisonId: comparison.id,
        state: comparison.state,
        transitionHistory: comparison.transitionHistory,
        failedVariant: comparison.input.order[index] ?? null,
        variantResult: result,
        perception: "human_only",
      },
      error: result.error ?? {
        code: "AUDITION_START_FAILED",
        message: "the variant could not start",
      },
      provenance: PROVENANCE,
      warnings: comparison.warnings,
    };
    return comparison.terminalResult;
  }
}

// ---------- 状态机 ----------

function transition(comparison, state, at) {
  comparison.state = state;
  comparison.transitionHistory.push({ state, at });
}

function isTerminal(state) {
  return state === "restored" || state === "restore_failed" || state === "failed";
}

function pruneTerminal(comparisons, maximumEntries) {
  for (const [id, comparison] of comparisons) {
    if (comparisons.size <= maximumEntries) break;
    if (isTerminal(comparison.state)) comparisons.delete(id);
  }
}

// ---------- 请求校验 ----------

function normalizeCompareRequest(request) {
  if (!isRecord(request)) throw codedError("INVALID_ARGUMENTS", "request must be an object");
  assertKnownKeys(
    request,
    ["fromBlick", "toBlick", "variants", "order", "gapMs", "repeats", "autoRestore", "stopToleranceMs", "estimatedDurationMs"],
    "request"
  );
  const fromBlick = request.fromBlick;
  const toBlick = request.toBlick;
  if (!Number.isSafeInteger(fromBlick) || fromBlick < 0) {
    throw codedError("INVALID_ARGUMENTS", "fromBlick must be a non-negative integer");
  }
  if (!Number.isSafeInteger(toBlick) || toBlick <= fromBlick) {
    throw codedError("INVALID_ARGUMENTS", "toBlick must be an integer greater than fromBlick");
  }
  if (!Array.isArray(request.variants) || request.variants.length !== 2) {
    throw codedError("INVALID_ARGUMENTS", "variants must contain exactly two entries (A and B)");
  }
  const variants = request.variants.map((variant, index) => {
    if (!isRecord(variant)) {
      throw codedError("INVALID_ARGUMENTS", `variants[${index}] must be an object`);
    }
    assertKnownKeys(variant, ["label", "soloTrackIndices"], `variants[${index}]`);
    if (variant.label !== "a" && variant.label !== "b") {
      throw codedError("INVALID_ARGUMENTS", `variants[${index}].label must be "a" or "b"`);
    }
    if (
      !Array.isArray(variant.soloTrackIndices) ||
      variant.soloTrackIndices.length === 0 ||
      variant.soloTrackIndices.length > MAX_VARIANT_TRACKS
    ) {
      throw codedError(
        "INVALID_ARGUMENTS",
        `variants[${index}].soloTrackIndices must list 1-${MAX_VARIANT_TRACKS} track indices`
      );
    }
    for (const trackIndex of variant.soloTrackIndices) {
      if (!Number.isSafeInteger(trackIndex) || trackIndex < 0) {
        throw codedError(
          "INVALID_ARGUMENTS",
          `variants[${index}].soloTrackIndices entries must be non-negative integers`
        );
      }
    }
    return { label: variant.label, soloTrackIndices: [...new Set(variant.soloTrackIndices)] };
  });
  if (variants[0].label === variants[1].label) {
    throw codedError("INVALID_ARGUMENTS", 'variants must use distinct labels "a" and "b"');
  }
  // 两个 variant 的 solo 配置完全相同时，A/B 听起来必然一样——那不是比较。
  if (
    JSON.stringify([...variants[0].soloTrackIndices].sort()) ===
    JSON.stringify([...variants[1].soloTrackIndices].sort())
  ) {
    throw codedError(
      "INVALID_ARGUMENTS",
      "both variants solo the same tracks; there is nothing to compare"
    );
  }
  const repeats = request.repeats ?? 1;
  if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 4) {
    throw codedError("INVALID_ARGUMENTS", "repeats must be an integer between 1 and 4");
  }
  let order;
  if (request.order === undefined) {
    order = [];
    for (let round = 0; round < repeats; round += 1) order.push("a", "b");
  } else {
    if (!Array.isArray(request.order) || request.order.length < 2 || request.order.length > 8) {
      throw codedError("INVALID_ARGUMENTS", "order must list 2-8 variant labels");
    }
    for (const label of request.order) {
      if (label !== "a" && label !== "b") {
        throw codedError("INVALID_ARGUMENTS", 'order entries must be "a" or "b"');
      }
    }
    if (!request.order.includes("a") || !request.order.includes("b")) {
      throw codedError("INVALID_ARGUMENTS", "order must play both variants at least once");
    }
    if (request.repeats !== undefined) {
      throw codedError("INVALID_ARGUMENTS", "order and repeats are mutually exclusive");
    }
    order = [...request.order];
  }
  const gapMs = request.gapMs ?? DEFAULT_GAP_MS;
  if (!Number.isSafeInteger(gapMs) || gapMs < 0 || gapMs > 5000) {
    throw codedError("INVALID_ARGUMENTS", "gapMs must be an integer between 0 and 5000");
  }
  const autoRestore = request.autoRestore ?? true;
  if (autoRestore !== true) {
    throw codedError(
      "INVALID_ARGUMENTS",
      "autoRestore must be true because every variant must restore the shared A/B baseline"
    );
  }
  const stopToleranceMs = request.stopToleranceMs ?? 100;
  if (!Number.isSafeInteger(stopToleranceMs) || stopToleranceMs < 0 || stopToleranceMs > 2000) {
    throw codedError("INVALID_ARGUMENTS", "stopToleranceMs must be an integer between 0 and 2000");
  }
  // 段长换算需要 TimeAxis，而调度必须在协调器之外进行；调用方可用 range 的秒数覆盖，
  // 否则用一个保守默认值，真正的停止时刻仍由底层 audition 的 auto-stop 决定。
  const estimatedDurationMs = request.estimatedDurationMs ?? 8000;
  if (
    !Number.isSafeInteger(estimatedDurationMs) ||
    estimatedDurationMs < 100 ||
    estimatedDurationMs > 600000
  ) {
    throw codedError(
      "INVALID_ARGUMENTS",
      "estimatedDurationMs must be an integer between 100 and 600000"
    );
  }
  return {
    fromBlick,
    toBlick,
    variants,
    order,
    repeats,
    gapMs,
    autoRestore,
    stopToleranceMs,
    estimatedDurationMs,
  };
}

function assertKnownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw codedError("INVALID_ARGUMENTS", `${label} has an unknown field: ${key}`);
    }
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function failureResult(error, fallbackCode) {
  return {
    ok: false,
    status: "failed",
    error: {
      code: typeof error?.code === "string" ? error.code : fallbackCode,
      message: error instanceof Error ? error.message : String(error),
    },
  };
}
