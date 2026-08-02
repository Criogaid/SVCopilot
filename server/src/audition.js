import { randomUUID } from "node:crypto";

import { createHostScope } from "./snapshot.js";
import { ServiceTiming } from "./service-timing.js";

// MCP 无法听到声音：audition 只驱动宿主播放，感知判断永远属于人。
// Node 崩溃可能遗留 solo/mute，因此 start 返回可跨重启使用的 recovery payload。
const PLAYHEAD_EPSILON_SECONDS = 1e-6;
const PLAYBACK_STATUSES = new Set(["stopped", "playing", "looping"]);

export class AuditionService {
  constructor(
    session,
    {
      now = () => Date.now(),
      setTimeoutFn = (callback, delay) => setTimeout(callback, delay),
      clearTimeoutFn = (timer) => clearTimeout(timer),
    } = {}
  ) {
    this.session = session;
    this.now = now;
    this.setTimeout = setTimeoutFn;
    this.clearTimeout = clearTimeoutFn;
    this.auditions = new Map();
  }

  async start(request) {
    const timer = new ServiceTiming({ now: this.now });
    const input = normalizeStartRequest(request);
    pruneTerminalAuditions(this.auditions, 63);
    timer.requestCoordinator();
    return this.session.withExclusive(async (host) => {
      timer.acquiredCoordinator();
      // 同一时间只允许一个 audition：停止其中一个会覆盖另一个的播放/mixer 状态。
      for (const [existingId, existing] of this.auditions) {
        if (existing.epoch !== host.epoch()) {
          if (existing.timer) this.clearTimeout(existing.timer);
          this.auditions.delete(existingId);
          continue;
        }
        if (isTerminalAuditionState(existing.state)) continue;
        throw codedError(
          "AUDITION_ACTIVE",
          `audition ${existingId} is still active; stop it before starting another`
        );
      }
      const capture = createHostScope(host);
      try {
        const roots = await capture.roots();
        const timeAxis = await capture.call(roots.project, "getTimeAxis", [], {
          inferredType: "TimeAxis",
        });
        const trackCount = await capture.call(roots.project, "getNumTracks");
        for (const index of input.soloTrackIndices) {
          if (index >= trackCount) {
            throw codedError(
              "TRACK_INDEX_OUT_OF_RANGE",
              `trackIndex ${index} is outside 0-${Math.max(0, trackCount - 1)} (native index ${index + 1})`
            );
          }
        }

        // 先完成全部读取和换算，再触碰任何宿主状态；mutation 阶段失败时做补偿。
        const savedPlayheadSeconds = await capture.call(roots.playback, "getPlayhead");
        const savedStatus = await capture.call(roots.playback, "getStatus");
        const fromSeconds = await capture.call(timeAxis, "getSecondsFromBlick", [input.fromBlick]);
        const toSeconds = await capture.call(timeAxis, "getSecondsFromBlick", [input.toBlick]);
        const mixerTargets = [];
        for (const trackIndex of input.soloTrackIndices) {
          const track = await capture.call(roots.project, "getTrack", [trackIndex + 1], {
            inferredType: "Track",
          });
          const mixer = await capture.call(track, "getMixer", [], { inferredType: "TrackMixer" });
          mixerTargets.push({
            trackIndex,
            mixer,
            previousSolo: await capture.call(mixer, "isSolo"),
          });
        }

        const mixerChanges = [];
        const warnings = [];
        let status;
        let playbackStartedAt;
        try {
          // 官方 seek 在播放中会立即续播，严格位置读回前必须先进入 stopped。
          if (savedStatus !== "stopped") {
            await capture.call(roots.playback, "stop", []);
            const observedStoppedStatus = await capture.call(roots.playback, "getStatus");
            if (observedStoppedStatus !== "stopped") {
              throw codedError(
                "POSTCONDITION_FAILED",
                `playback did not stop before audition seek; observed ${observedStoppedStatus}`
              );
            }
          }
          for (const target of mixerTargets) {
            if (target.previousSolo !== true) {
              await capture.call(target.mixer, "setSolo", [true]);
            }
            mixerChanges.push({
              trackIndex: target.trackIndex,
              field: "solo",
              previousValue: target.previousSolo,
              setValue: true,
            });
            const observedSolo = await capture.call(target.mixer, "isSolo");
            if (observedSolo !== true) {
              throw codedError(
                "POSTCONDITION_FAILED",
                `track ${target.trackIndex} did not enter solo state during audition startup`
              );
            }
          }
          await capture.call(roots.playback, "seek", [fromSeconds]);
          const observedStartPlayhead = await capture.call(roots.playback, "getPlayhead");
          if (Math.abs(observedStartPlayhead - fromSeconds) > PLAYHEAD_EPSILON_SECONDS) {
            throw codedError(
              "POSTCONDITION_FAILED",
              `playhead did not reach the audition start (${fromSeconds}); observed ${observedStartPlayhead}`
            );
          }
          if (input.loop) {
            await capture.call(roots.playback, "loop", [fromSeconds, toSeconds]);
          } else {
            await capture.call(roots.playback, "play", []);
          }
          playbackStartedAt = this.now();
          // getStatus 也在补偿段内：此时播放/solo 已生效，读取失败同样不能残留状态。
          status = await capture.call(roots.playback, "getStatus");
          const statusAccepted = input.loop
            ? status === "looping"
            : status === "playing" || status === "looping";
          if (!statusAccepted) {
            throw codedError(
              "POSTCONDITION_FAILED",
              `audition playback did not start; observed ${status}`
            );
          }
          if (!input.loop && status === "looping") {
            warnings.push({
              code: "HOST_LOOP_REGION_ACTIVE",
              message: "Playback entered looping mode because the host loop region is active.",
            });
          }
        } catch (error) {
          // 启动中途失败：尽力恢复已改的 solo 和 playhead，不留下部分 audition 状态。
          const compensation = await this._compensateStartFailure(
            capture,
            roots,
            mixerTargets,
            mixerChanges,
            savedPlayheadSeconds,
            savedStatus,
            error
          );
          return { ...compensation, timings: finishAuditionTiming(timer) };
        }

        const auditionId = `aud_${randomUUID()}`;
        const recovery = {
          version: 1,
          savedPlayheadSeconds,
          savedStatus,
          mixerChanges,
        };
        const createdAt = this.now();
        const plannedStopAt = input.autoStop
          ? playbackStartedAt + Math.max(0, (toSeconds - fromSeconds) * 1000)
          : null;
        const audition = {
          id: auditionId,
          createdAt,
          epoch: host.epoch(),
          recovery,
          range: { fromBlick: input.fromBlick, toBlick: input.toBlick, fromSeconds, toSeconds },
          loop: input.loop,
          autoStop: input.autoStop,
          restore: input.restore,
          stopToleranceMs: input.stopToleranceMs,
          endPolicy: input.loop ? "host_loop" : input.autoStop ? "auto_stop" : "caller_stop",
          state: "playing",
          transitionHistory: [
            { state: "scheduled", at: createdAt },
            { state: "playing", at: createdAt },
          ],
          plannedStopAt,
          playbackStartedAt,
          timerFiredAt: null,
          stopRequestedAt: null,
          hostDispatchAt: null,
          hostStoppedAt: null,
          stoppedPlayheadSeconds: null,
          terminalResult: null,
          completionPromise: null,
          timer: null,
        };
        this.auditions.set(auditionId, audition);
        if (input.autoStop) {
          const delay = Math.max(0, plannedStopAt - this.now());
          audition.timer = this.setTimeout(() => this._completeAutoStop(auditionId), delay);
        }

        return {
          ok: true,
          status: "succeeded",
          data: {
            auditionId,
            playbackStatus: status,
            range: { fromBlick: input.fromBlick, toBlick: input.toBlick, fromSeconds, toSeconds },
            loop: input.loop,
            autoStop: input.autoStop,
            restore: input.restore,
            state: audition.state,
            terminal: false,
            transitionHistory: audition.transitionHistory,
            endPolicy: audition.endPolicy,
            plannedStopAt,
            playbackStartedAt,
            soloTrackIndices: input.soloTrackIndices,
            // 调用方应保存 recovery；server 重启后可用 sv_restore_audition 恢复。
            recovery,
            perception: "human_only",
          },
          warnings,
          timings: finishAuditionTiming(timer),
        };
      } finally {
        await capture.releaseAll();
      }
    });
  }

  async _compensateStartFailure(
    capture,
    roots,
    mixerTargets,
    mixerChanges,
    savedPlayheadSeconds,
    savedStatus,
    cause
  ) {
    const unknown = isUnknownOutcomeError(cause);
    const restoration = [];
    let compensationVerified = !unknown;
    if (!unknown) {
      for (const change of mixerChanges) {
        const target = mixerTargets.find((item) => item.trackIndex === change.trackIndex);
        try {
          if (change.previousValue !== change.setValue) {
            await capture.call(target.mixer, "setSolo", [change.previousValue]);
          }
          const observed = await capture.call(target.mixer, "isSolo");
          const restored = observed === change.previousValue;
          if (!restored) compensationVerified = false;
          restoration.push({
            trackIndex: change.trackIndex,
            field: "solo",
            restored,
            observed,
            expected: change.previousValue,
          });
        } catch (error) {
          compensationVerified = false;
          restoration.push({
            trackIndex: change.trackIndex,
            field: "solo",
            restored: false,
            expected: change.previousValue,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      try {
        await capture.call(roots.playback, "stop", []);
        const observedStatus = await capture.call(roots.playback, "getStatus");
        const playbackStopped = observedStatus === "stopped";
        if (!playbackStopped) compensationVerified = false;
        restoration.push({
          field: "playback",
          restored: playbackStopped,
          observed: observedStatus,
          expected: "stopped",
        });
      } catch (error) {
        compensationVerified = false;
        restoration.push({
          field: "playback",
          restored: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      try {
        await capture.call(roots.playback, "seek", [savedPlayheadSeconds]);
        // 补偿的 playhead 也必须读回确认，不能因为 seek 没抛错就声称已恢复。
        const observedPlayhead = await capture.call(roots.playback, "getPlayhead");
        const playheadRestored =
          Math.abs(observedPlayhead - savedPlayheadSeconds) <= PLAYHEAD_EPSILON_SECONDS;
        if (!playheadRestored) compensationVerified = false;
        restoration.push({
          field: "playhead",
          restored: playheadRestored,
          observed: observedPlayhead,
          expected: savedPlayheadSeconds,
        });
        const playback = await restoreSavedPlaybackState(
          capture,
          roots.playback,
          savedStatus
        );
        if (!playback.restored) compensationVerified = false;
        restoration.push({ field: "playbackState", ...playback });
      } catch (error) {
        compensationVerified = false;
        restoration.push({
          field: "playhead",
          restored: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return {
      ok: false,
      status: unknown ? "outcome_unknown" : compensationVerified ? "rolled_back" : "rollback_failed",
      effects: unknown ? "unknown" : compensationVerified ? "reverted" : "may_remain",
      error: {
        code: typeof cause?.code === "string" ? cause.code : "HOST_CALL_FAILED",
        message: cause instanceof Error ? cause.message : String(cause),
        outcome: unknown ? "unknown" : compensationVerified ? "unchanged" : "partial",
        retryable: false,
      },
      data: {
        rollback: { attempted: !unknown, verified: unknown ? null : compensationVerified },
        restoration,
        // 即使补偿失败也提供 payload，调用方可用 sv_restore_audition 重试。
        recovery: { version: 1, savedPlayheadSeconds, savedStatus, mixerChanges },
      },
      warnings: [],
    };
  }

  async _completeAutoStop(auditionId, { stoppedByUser = false } = {}) {
    const audition = this.auditions.get(auditionId);
    if (!audition || audition.terminalResult) return audition?.terminalResult ?? null;
    if (!audition.autoStop) return null;
    if (audition.completionPromise) return audition.completionPromise;
    audition.completionPromise = this._performAutoStop(auditionId, { stoppedByUser }).catch(
      (error) => {
        const current = this.auditions.get(auditionId);
        if (!current) return null;
        transitionAudition(current, "restore_failed", this.now());
        current.terminalResult = autoStopFailure(current, error);
        return current.terminalResult;
      }
    );
    return audition.completionPromise;
  }

  async _performAutoStop(auditionId, { stoppedByUser }) {
    const audition = this.auditions.get(auditionId);
    if (!audition) return null;
    audition.timer = null;
    if (!stoppedByUser) audition.timerFiredAt ??= this.now();
    audition.stopRequestedAt = this.now();
    transitionAudition(audition, "stop_requested", audition.stopRequestedAt);
    const result = await this._restore(audition.recovery, {
      expectedEpoch: audition.epoch,
      restoreState: audition.restore,
      preserveObservedStop: true,
      onAcquired: () => {
        audition.hostDispatchAt = this.now();
      },
    });
    if (result.status === "stale_epoch") {
      const error = codedError(
        "STALE_AUDITION",
        "the bridge reconnected before automatic stop; recovery requires explicit caller confirmation"
      );
      transitionAudition(audition, "restore_failed", this.now());
      audition.terminalResult = autoStopFailure(audition, error);
      return audition.terminalResult;
    }
    audition.hostStoppedAt = result.data?.hostStoppedAt ?? this.now();
    audition.stoppedPlayheadSeconds = result.data?.observedBeforeStop?.playheadSeconds ?? null;
    const observedUserStop =
      stoppedByUser || result.data?.observedBeforeStop?.playbackStatus === "stopped";
    const terminalState = observedUserStop
      ? "stopped_by_user"
      : result.status === "restore_failed"
        ? "restore_failed"
        : audition.restore
          ? "restored"
          : "stopped";
    transitionAudition(audition, "stopped", audition.hostStoppedAt);
    if (terminalState !== "stopped") transitionAudition(audition, terminalState, this.now());
    const timing = autoStopTiming(audition);
    const warnings = [...(result.warnings ?? [])];
    if (
      Number.isFinite(timing.overrunMs) &&
      timing.overrunMs > audition.stopToleranceMs
    ) {
      warnings.push({
        code: "AUDITION_STOP_OVERRUN",
        message: `audition exceeded its requested endpoint by ${timing.overrunMs} ms`,
      });
    }
    audition.terminalResult = {
      ...result,
      status: audition.state,
      data: {
        ...result.data,
        auditionId,
        state: audition.state,
        terminal: true,
        transitionHistory: audition.transitionHistory,
        endPolicy: "auto_stop",
        autoStop: timing,
        perception: "human_only",
      },
      warnings,
    };
    return audition.terminalResult;
  }

  async get(request) {
    const timer = new ServiceTiming({ now: this.now, phaseNames: ["hostReadMs"] });
    const auditionId = requireAuditionId(request);
    const audition = this.auditions.get(auditionId);
    if (!audition) throw codedError("UNKNOWN_AUDITION", `audition not found: ${auditionId}`);
    if (audition.terminalResult) {
      return { ...audition.terminalResult, timings: timer.finish() };
    }
    if (audition.completionPromise) {
      const completed = await audition.completionPromise;
      return { ...completed, timings: finishAuditionTiming(timer) };
    }
    timer.requestCoordinator();
    const observed = await this.session.withExclusive(async (host) => {
      timer.acquiredCoordinator();
      const capture = createHostScope(host);
      try {
        const { playheadSeconds, status } = await timer.measure("hostReadMs", async () => {
          const roots = await capture.roots();
          return {
            playheadSeconds: await capture.call(roots.playback, "getPlayhead"),
            status: await capture.call(roots.playback, "getStatus"),
          };
        });
        return {
          ok: true,
          status: "succeeded",
          data: {
            auditionId,
            playbackStatus: status,
            playheadSeconds,
            range: audition.range,
            loop: audition.loop,
            autoStop: audition.autoStop,
            state: audition.state,
            terminal: false,
            transitionHistory: audition.transitionHistory,
            endPolicy: audition.endPolicy,
            plannedStopAt: audition.plannedStopAt,
            elapsedMs: this.now() - audition.createdAt,
            staleEpoch: audition.epoch !== host.epoch(),
            perception: "human_only",
          },
          warnings: [],
          timings: timer.finish(),
        };
      } finally {
        await capture.releaseAll();
      }
    });
    if (
      audition.autoStop &&
      observed.data.playbackStatus === "stopped" &&
      !isTerminalAuditionState(audition.state)
    ) {
      if (audition.timer) this.clearTimeout(audition.timer);
      const completed = await this._completeAutoStop(auditionId, { stoppedByUser: true });
      if (!completed) {
        // 并发的 stop/restore 已释放该 audition 记录；observed 里的实时播放状态仍然真实，
        // 不能把 null 展开成缺 ok/status/data 的畸形响应。
        return {
          ...observed,
          warnings: [
            ...observed.warnings,
            {
              code: "AUDITION_RECORD_RELEASED",
              message:
                "The audition record was released by a concurrent stop/restore; live playback state above is still accurate.",
            },
          ],
        };
      }
      return { ...completed, timings: timer.finish() };
    }
    return observed;
  }

  async stop(request) {
    const timer = new ServiceTiming({ now: this.now });
    const auditionId = requireAuditionId(request);
    const audition = this.auditions.get(auditionId);
    if (!audition) throw codedError("UNKNOWN_AUDITION", `audition not found: ${auditionId}`);
    if (audition.timer) {
      this.clearTimeout(audition.timer);
      audition.timer = null;
    }
    if (audition.terminalResult) {
      return { ...audition.terminalResult, timings: timer.finish() };
    }
    if (audition.completionPromise) {
      const completed = await audition.completionPromise;
      return { ...completed, timings: finishAuditionTiming(timer) };
    }
    timer.requestCoordinator();
    // 显式 stop 与 autoStop/并发 stop 共享同一次完成记忆：completionPromise 在首个
    // await 之前同步占位，并发的第二个 stop/get 等待同一结果，宿主的 stop/seek/setSolo
    // 只执行一次，也不会把首次恢复的效果误判成 user_modified。
    audition.completionPromise = this._performExplicitStop(audition, timer).catch((error) => {
      // 恢复中途宿主抛错也必须返回结构化 restore_failed + recovery，
      // 而不是退化成裸 INTERNAL_ERROR 丢掉逃生通道（对齐 autoStop 侧的 .catch）。
      transitionAudition(audition, "restore_failed", this.now());
      audition.terminalResult = explicitStopFailure(audition, error);
      return audition.terminalResult;
    });
    const completed = await audition.completionPromise;
    // 未记忆终态（读回确认的 restore_failed）保持可重试：释放共享 promise，
    // 让下一次显式 stop 重新执行恢复，而不是永远重放同一失败。
    if (!audition.terminalResult) audition.completionPromise = null;
    return { ...completed, timings: finishAuditionTiming(timer) };
  }

  async _performExplicitStop(audition, timer) {
    audition.stopRequestedAt = this.now();
    transitionAudition(audition, "stop_requested", audition.stopRequestedAt);
    const result = await this._restore(audition.recovery, {
      expectedEpoch: audition.epoch,
      restoreState: audition.restore,
      onAcquired: () => timer.acquiredCoordinator(),
    });
    if (result.status === "stale_epoch") {
      // 跨 epoch 自动恢复可能把旧工程的索引/solo/播放头写进新工程；拒绝并交还 payload。
      this.auditions.delete(audition.id);
      return {
        ok: false,
        status: "failed",
        effects: "none",
        error: {
          code: "STALE_AUDITION",
          message:
            "the bridge reconnected after this audition started; automatic restore is refused. If the same project is still open, call sv_restore_audition with data.recovery explicitly.",
          outcome: "unchanged",
          retryable: false,
        },
        data: { auditionId: audition.id, terminal: true, recovery: audition.recovery },
        warnings: [],
      };
    }
    audition.hostStoppedAt = result.data?.hostStoppedAt ?? this.now();
    transitionAudition(audition, "stopped", audition.hostStoppedAt);
    const terminalState =
      result.status === "restore_failed"
        ? "restore_failed"
        : audition.restore
          ? "restored"
          : "stopped";
    if (terminalState !== "stopped") transitionAudition(audition, terminalState, this.now());
    const completed = {
      ...result,
      data: {
        ...result.data,
        auditionId: audition.id,
        state: audition.state,
        terminal: true,
        transitionHistory: audition.transitionHistory,
        endPolicy: audition.endPolicy,
        perception: "human_only",
      },
    };
    // 恢复未完全成功时保留 audition 记录且不记忆终态，调用方可凭同一 auditionId 重试
    // 或用 recovery 走 sv_restore_audition；成功则记忆并移除（既有契约：之后的
    // get/stop 返回 UNKNOWN_AUDITION）。
    if (result.status !== "restore_failed") {
      audition.terminalResult = completed;
      this.auditions.delete(audition.id);
    }
    return completed;
  }

  async restore(request) {
    const timer = new ServiceTiming({ now: this.now });
    const recovery = normalizeRecoveryPayload(request?.recovery);
    timer.requestCoordinator();
    let result;
    try {
      result = await this._restore(recovery, {
        onAcquired: () => timer.acquiredCoordinator(),
      });
    } catch (error) {
      // 逃生通道的恢复失败同样要结构化并交还 payload 供重试，不能裸抛 INTERNAL_ERROR。
      return {
        ok: false,
        status: "restore_failed",
        effects: "may_remain",
        error: {
          code: typeof error?.code === "string" ? error.code : "HOST_CALL_FAILED",
          message: error instanceof Error ? error.message : String(error),
          outcome: "partial",
          retryable: false,
        },
        data: { recovery, terminal: true, perception: "human_only" },
        warnings: [],
        timings: finishAuditionTiming(timer),
      };
    }
    this._absorbExternalRestore(recovery, result);
    return {
      ...result,
      data: { ...result.data, terminal: true, perception: "human_only" },
      timings: finishAuditionTiming(timer),
    };
  }

  // sv_restore_audition 成功后，若其 payload 对应内存中仍活跃的 audition，将其转入
  // restored 终态并记忆结果：后续 sv_get_audition 如实报告 restored，sv_stop_audition
  // 幂等重放同一结果，不再二次恢复宿主状态、也不会把服务自己的恢复误判成用户修改（F-01）。
  _absorbExternalRestore(recovery, result) {
    if (result.status !== "succeeded" && result.status !== "partially_restored") return;
    for (const [auditionId, audition] of this.auditions) {
      if (isTerminalAuditionState(audition.state)) continue;
      if (!recoveryEquals(audition.recovery, recovery)) continue;
      if (audition.timer) {
        this.clearTimeout(audition.timer);
        audition.timer = null;
      }
      transitionAudition(audition, "stopped", this.now());
      transitionAudition(audition, "restored", this.now());
      audition.terminalResult = {
        ...result,
        data: {
          ...result.data,
          auditionId,
          state: audition.state,
          terminal: true,
          transitionHistory: audition.transitionHistory,
          endPolicy: audition.endPolicy,
          restoredVia: "sv_restore_audition",
          perception: "human_only",
        },
      };
    }
  }

  async _restore(
    recovery,
    {
      expectedEpoch,
      restoreState = true,
      preserveObservedStop = false,
      onAcquired = null,
    } = {}
  ) {
    return this.session.withExclusive(async (host) => {
      onAcquired?.();
      // stop 携带 audition 的 epoch；sv_restore_audition 是显式逃生通道，不带该约束。
      if (expectedEpoch !== undefined && host.epoch() !== expectedEpoch) {
        return { status: "stale_epoch" };
      }
      const capture = createHostScope(host);
      try {
        const roots = await capture.roots();
        const observedBeforeStop = {
          playbackStatus: await capture.call(roots.playback, "getStatus"),
          playheadSeconds: await capture.call(roots.playback, "getPlayhead"),
        };
        await capture.call(roots.playback, "stop", []);
        const stoppedStatus = await capture.call(roots.playback, "getStatus");
        const hostStoppedAt = this.now();
        if (!restoreState) {
          const playbackStopped = stoppedStatus === "stopped";
          return {
            ok: playbackStopped,
            status: playbackStopped ? "stopped" : "restore_failed",
            effects: playbackStopped ? "verified" : "may_remain",
            data: {
              playbackStatus: stoppedStatus,
              playbackStopped,
              observedBeforeStop,
              hostStoppedAt,
              restoration: [],
            },
            warnings: playbackStopped
              ? []
              : [
                  {
                    code: "RESTORE_INCOMPLETE",
                    message: `Playback did not stop; observed status ${stoppedStatus}.`,
                  },
                ],
          };
        }
        const restoration = [];
        for (const change of recovery.mixerChanges) {
          const track = await capture.call(roots.project, "getTrack", [change.trackIndex + 1], {
            inferredType: "Track",
          });
          const mixer = await capture.call(track, "getMixer", [], { inferredType: "TrackMixer" });
          const observedBeforeRestore = await capture.call(mixer, "isSolo");
          // 只恢复仍等于 audition 设置值的字段，避免覆盖用户同时做出的修改。
          let attempted = false;
          let reason = null;
          if (observedBeforeRestore === change.setValue) {
            if (change.previousValue !== change.setValue) {
              await capture.call(mixer, "setSolo", [change.previousValue]);
            }
            attempted = true;
          } else {
            reason = "user_modified";
          }
          const observedAfterRestore = await capture.call(mixer, "isSolo");
          // restored 由读回结果决定，而不是"写过就算成功"。
          restoration.push({
            trackIndex: change.trackIndex,
            field: change.field,
            auditionValue: change.setValue,
            previousValue: change.previousValue,
            observedBeforeRestore,
            restored: attempted && observedAfterRestore === change.previousValue,
            observedAfterRestore,
            ...(reason ? { reason } : {}),
          });
        }
        await capture.call(roots.playback, "seek", [recovery.savedPlayheadSeconds]);
        const playheadSeconds = await capture.call(roots.playback, "getPlayhead");
        const playheadRestored =
          Math.abs(playheadSeconds - recovery.savedPlayheadSeconds) <= PLAYHEAD_EPSILON_SECONDS;
        // 自动试听期间的人工 stop 是用户意图，不能为了恢复旧 playing 状态而重新启动播放。
        const userStopPreserved =
          preserveObservedStop && observedBeforeStop.playbackStatus === "stopped";
        const expectedPlaybackStatus = userStopPreserved ? "stopped" : recovery.savedStatus;
        const playbackState = await restoreSavedPlaybackState(
          capture,
          roots.playback,
          expectedPlaybackStatus
        );
        const playbackStatus = playbackState.observed;
        const playbackStopped = playbackStatus === "stopped";
        const skippedUserChanges = restoration.filter((entry) => entry.reason === "user_modified");
        const failedRestores = restoration.filter(
          (entry) => !entry.restored && entry.reason !== "user_modified"
        );
        const allRestored =
          failedRestores.length === 0 && playheadRestored && playbackState.restored;
        const warnings = [];
        if (skippedUserChanges.length > 0) {
          warnings.push({
            code: "RESTORE_SKIPPED_USER_CHANGES",
            message:
              "Some mixer fields were changed after the audition started and were left untouched.",
          });
        }
        if (userStopPreserved) {
          warnings.push({
            code: "USER_STOP_PRESERVED",
            message: "Playback remains stopped because the user stopped the automatic audition.",
          });
        }
        if (!allRestored) {
          warnings.push({
            code: "RESTORE_INCOMPLETE",
            message: !playbackState.restored
              ? `Playback state did not restore to ${expectedPlaybackStatus}; observed ${playbackStatus}.`
              : !playheadRestored
                ? "The playhead did not read back at the saved position."
                : "One or more mixer fields did not read back as their pre-audition values.",
          });
        }
        return {
          ok: true,
          status: allRestored
            ? skippedUserChanges.length > 0
              ? "partially_restored"
              : "succeeded"
            : "restore_failed",
          effects: allRestored ? "verified" : "may_remain",
          data: {
            playbackStatus,
            playbackStopped,
            playbackStateRestored: playbackState.restored,
            savedPlaybackStatus: recovery.savedStatus,
            expectedPlaybackStatus,
            userStopPreserved,
            observedBeforeStop,
            hostStoppedAt,
            playheadSeconds,
            playheadRestored,
            restoration,
          },
          warnings,
        };
      } finally {
        await capture.releaseAll();
      }
    });
  }
}

async function restoreSavedPlaybackState(capture, playback, savedStatus) {
  if (savedStatus !== "stopped") await capture.call(playback, "play", []);
  const observed = await capture.call(playback, "getStatus");
  return { expected: savedStatus, observed, restored: observed === savedStatus };
}

function normalizeRecoveryPayload(recovery) {
  // recovery 会驱动 stop/seek/play，所有字段必须在首次宿主调用前完成校验。
  const valid =
    isRecord(recovery) &&
    recovery.version === 1 &&
    Array.isArray(recovery.mixerChanges) &&
    Number.isFinite(recovery.savedPlayheadSeconds) &&
    recovery.savedPlayheadSeconds >= 0 &&
    PLAYBACK_STATUSES.has(recovery.savedStatus) &&
    recovery.mixerChanges.every(
      (change) =>
        isRecord(change) &&
        Number.isSafeInteger(change.trackIndex) &&
        change.trackIndex >= 0 &&
        change.field === "solo" &&
        typeof change.previousValue === "boolean" &&
        typeof change.setValue === "boolean"
    );
  if (!valid) {
    throw codedError(
      "INVALID_ARGUMENTS",
      "recovery must be the payload returned by sv_start_audition (version 1)"
    );
  }
  return recovery;
}

function normalizeStartRequest(request) {
  if (!isRecord(request)) throw codedError("INVALID_ARGUMENTS", "request must be an object");
  if (
    !Number.isSafeInteger(request.fromBlick) ||
    request.fromBlick < 0 ||
    !Number.isSafeInteger(request.toBlick) ||
    request.toBlick <= request.fromBlick
  ) {
    throw codedError(
      "INVALID_ARGUMENTS",
      "fromBlick/toBlick must be non-negative integers with toBlick > fromBlick (absolute blicks)"
    );
  }
  let soloTrackIndices = [];
  if (request.soloTrackIndices !== undefined) {
    if (
      !Array.isArray(request.soloTrackIndices) ||
      !request.soloTrackIndices.every((index) => Number.isSafeInteger(index) && index >= 0)
    ) {
      throw codedError(
        "INVALID_ARGUMENTS",
        "soloTrackIndices must be an array of non-negative integers"
      );
    }
    soloTrackIndices = [...new Set(request.soloTrackIndices)].sort((a, b) => a - b);
  }
  if (request.loop !== undefined && typeof request.loop !== "boolean") {
    throw codedError("INVALID_ARGUMENTS", "loop must be a boolean");
  }
  if (request.autoStop !== undefined && typeof request.autoStop !== "boolean") {
    throw codedError("INVALID_ARGUMENTS", "autoStop must be a boolean");
  }
  if (request.restore !== undefined && typeof request.restore !== "boolean") {
    throw codedError("INVALID_ARGUMENTS", "restore must be a boolean");
  }
  if (request.loop === true && request.autoStop === true) {
    throw codedError("INVALID_ARGUMENTS", "autoStop is only available when loop is false");
  }
  const stopToleranceMs = request.stopToleranceMs ?? 100;
  if (
    !Number.isSafeInteger(stopToleranceMs) ||
    stopToleranceMs < 0 ||
    stopToleranceMs > 2_000
  ) {
    throw codedError("INVALID_ARGUMENTS", "stopToleranceMs must be an integer between 0 and 2000");
  }
  return {
    fromBlick: request.fromBlick,
    toBlick: request.toBlick,
    soloTrackIndices,
    loop: request.loop === true,
    autoStop: request.autoStop === true,
    restore: request.restore !== false,
    stopToleranceMs,
  };
}

function autoStopTiming(audition) {
  const timerDelayMs =
    audition.timerFiredAt === null || audition.plannedStopAt === null
      ? null
      : Math.max(0, audition.timerFiredAt - audition.plannedStopAt);
  const queueDelayMs =
    audition.hostDispatchAt === null || audition.stopRequestedAt === null
      ? null
      : Math.max(0, audition.hostDispatchAt - audition.stopRequestedAt);
  const overrunMs =
    audition.stoppedPlayheadSeconds === null || audition.state === "stopped_by_user"
      ? null
      : Math.max(0, (audition.stoppedPlayheadSeconds - audition.range.toSeconds) * 1000);
  return {
    plannedStopAt: audition.plannedStopAt,
    timerFiredAt: audition.timerFiredAt,
    stopRequestedAt: audition.stopRequestedAt,
    hostDispatchAt: audition.hostDispatchAt,
    hostStoppedAt: audition.hostStoppedAt,
    timerDelayMs,
    queueDelayMs,
    overrunMs,
  };
}

function transitionAudition(audition, state, at) {
  audition.state = state;
  audition.transitionHistory ??= [];
  const previous = audition.transitionHistory.at(-1);
  if (previous?.state !== state) audition.transitionHistory.push({ state, at });
}

function finishAuditionTiming(timer) {
  const timings = timer.finish();
  return {
    ...timings,
    preflightReadMs: null,
    hostWriteMs: null,
    verificationMs: null,
    hostOperationMs: timings.operationMs,
  };
}

function autoStopFailure(audition, cause) {
  return {
    ok: false,
    status: "restore_failed",
    effects: "may_remain",
    error: {
      code: cause?.code ?? "HOST_CALL_FAILED",
      message: cause instanceof Error ? cause.message : String(cause),
      outcome: "partial",
      retryable: false,
    },
    data: {
      auditionId: audition.id,
      state: "restore_failed",
      terminal: true,
      transitionHistory: audition.transitionHistory,
      recovery: audition.recovery,
      autoStop: autoStopTiming(audition),
      perception: "human_only",
    },
    warnings: [],
  };
}

// 显式 stop 的恢复中途抛错：与 autoStopFailure 同构的结构化终态（含 recovery 逃生通道），
// 只是没有 autoStop 计时段。
function explicitStopFailure(audition, cause) {
  return {
    ok: false,
    status: "restore_failed",
    effects: "may_remain",
    error: {
      code: typeof cause?.code === "string" ? cause.code : "HOST_CALL_FAILED",
      message: cause instanceof Error ? cause.message : String(cause),
      outcome: "partial",
      retryable: false,
    },
    data: {
      auditionId: audition.id,
      state: "restore_failed",
      terminal: true,
      transitionHistory: audition.transitionHistory,
      recovery: audition.recovery,
      endPolicy: audition.endPolicy,
      perception: "human_only",
    },
    warnings: [],
  };
}

// recovery payload 的结构化等值比较（不能用 JSON.stringify：客户端重放的 payload
// 可能改变键序）。字段集合与 sv_start_audition 生成的 version 1 payload 一致。
function recoveryEquals(left, right) {
  if (!isRecord(left) || !isRecord(right)) return false;
  if (left.version !== right.version) return false;
  if (left.savedPlayheadSeconds !== right.savedPlayheadSeconds) return false;
  if (left.savedStatus !== right.savedStatus) return false;
  const leftChanges = Array.isArray(left.mixerChanges) ? left.mixerChanges : [];
  const rightChanges = Array.isArray(right.mixerChanges) ? right.mixerChanges : [];
  return (
    leftChanges.length === rightChanges.length &&
    leftChanges.every((change, index) => {
      const other = rightChanges[index];
      return (
        isRecord(change) &&
        isRecord(other) &&
        change.trackIndex === other.trackIndex &&
        change.field === other.field &&
        change.previousValue === other.previousValue &&
        change.setValue === other.setValue
      );
    })
  );
}

function isTerminalAuditionState(state) {
  return ["stopped", "restored", "restore_failed", "stopped_by_user"].includes(state);
}

function pruneTerminalAuditions(auditions, maximumEntries) {
  if (auditions.size <= maximumEntries) return;
  const terminal = [...auditions.entries()]
    .filter(([, audition]) => isTerminalAuditionState(audition.state))
    .sort((left, right) => left[1].createdAt - right[1].createdAt);
  while (auditions.size > maximumEntries && terminal.length > 0) {
    auditions.delete(terminal.shift()[0]);
  }
}

function requireAuditionId(request) {
  if (!isRecord(request) || typeof request.auditionId !== "string" || !request.auditionId) {
    throw codedError("INVALID_ARGUMENTS", "auditionId is required");
  }
  return request.auditionId;
}

function isUnknownOutcomeError(error) {
  if (error?.code === "HOST_TIMEOUT" || error?.code === "HOST_DETACHED") return true;
  return /Timeout waiting|detached|disconnected|EOF/i.test(
    error instanceof Error ? error.message : String(error)
  );
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
