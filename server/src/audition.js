import { randomUUID } from "node:crypto";

import { createHostScope } from "./snapshot.js";

// MCP 无法听到声音：audition 只驱动宿主播放，感知判断永远属于人。
// Node 崩溃可能遗留 solo/mute，因此 start 返回可跨重启使用的 recovery payload。
const PLAYHEAD_EPSILON_SECONDS = 1e-6;

export class AuditionService {
  constructor(session, { now = () => Date.now() } = {}) {
    this.session = session;
    this.now = now;
    this.auditions = new Map();
  }

  async start(request) {
    const input = normalizeStartRequest(request);
    return this.session.withExclusive(async (host) => {
      // 同一时间只允许一个 audition：停止其中一个会覆盖另一个的播放/mixer 状态。
      for (const [existingId, existing] of this.auditions) {
        if (existing.epoch !== host.epoch()) {
          this.auditions.delete(existingId);
          continue;
        }
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
          return compensation;
        }

        const auditionId = `aud_${randomUUID()}`;
        const recovery = {
          version: 1,
          savedPlayheadSeconds,
          savedStatus,
          mixerChanges,
        };
        this.auditions.set(auditionId, {
          createdAt: this.now(),
          epoch: host.epoch(),
          recovery,
          range: { fromBlick: input.fromBlick, toBlick: input.toBlick, fromSeconds, toSeconds },
          loop: input.loop,
        });

        return {
          ok: true,
          status: "succeeded",
          data: {
            auditionId,
            playbackStatus: status,
            range: { fromBlick: input.fromBlick, toBlick: input.toBlick, fromSeconds, toSeconds },
            loop: input.loop,
            soloTrackIndices: input.soloTrackIndices,
            // 调用方应保存 recovery；server 重启后可用 sv_restore_audition 恢复。
            recovery,
            perception: "human_only",
          },
          warnings,
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

  async get(request) {
    const auditionId = requireAuditionId(request);
    const audition = this.auditions.get(auditionId);
    if (!audition) throw codedError("UNKNOWN_AUDITION", `audition not found: ${auditionId}`);
    return this.session.withExclusive(async (host) => {
      const capture = createHostScope(host);
      try {
        const roots = await capture.roots();
        const playheadSeconds = await capture.call(roots.playback, "getPlayhead");
        const status = await capture.call(roots.playback, "getStatus");
        return {
          ok: true,
          status: "succeeded",
          data: {
            auditionId,
            playbackStatus: status,
            playheadSeconds,
            range: audition.range,
            loop: audition.loop,
            elapsedMs: this.now() - audition.createdAt,
            staleEpoch: audition.epoch !== host.epoch(),
          },
          warnings: [],
        };
      } finally {
        await capture.releaseAll();
      }
    });
  }

  async stop(request) {
    const auditionId = requireAuditionId(request);
    const audition = this.auditions.get(auditionId);
    if (!audition) throw codedError("UNKNOWN_AUDITION", `audition not found: ${auditionId}`);
    const result = await this._restore(audition.recovery, { expectedEpoch: audition.epoch });
    if (result.status === "stale_epoch") {
      // 跨 epoch 自动恢复可能把旧工程的索引/solo/播放头写进新工程；拒绝并交还 payload。
      this.auditions.delete(auditionId);
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
        data: { auditionId, recovery: audition.recovery },
        warnings: [],
      };
    }
    // 恢复未完全成功时保留 audition 记录，调用方可凭 recovery 重试。
    if (result.status !== "restore_failed") this.auditions.delete(auditionId);
    return { ...result, data: { ...result.data, auditionId } };
  }

  async restore(request) {
    const recovery = request?.recovery;
    if (
    !isRecord(recovery) ||
      recovery.version !== 1 ||
      !Array.isArray(recovery.mixerChanges) ||
      !Number.isFinite(recovery.savedPlayheadSeconds)
    ) {
      throw codedError(
        "INVALID_ARGUMENTS",
        "recovery must be the payload returned by sv_start_audition (version 1)"
      );
    }
    return this._restore(recovery);
  }

  async _restore(recovery, { expectedEpoch } = {}) {
    return this.session.withExclusive(async (host) => {
      // stop 携带 audition 的 epoch；sv_restore_audition 是显式逃生通道，不带该约束。
      if (expectedEpoch !== undefined && host.epoch() !== expectedEpoch) {
        return { status: "stale_epoch" };
      }
      const capture = createHostScope(host);
      try {
        const roots = await capture.roots();
        await capture.call(roots.playback, "stop", []);
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
        const playbackStatus = await capture.call(roots.playback, "getStatus");
        const playheadSeconds = await capture.call(roots.playback, "getPlayhead");
        const playbackStopped = playbackStatus === "stopped";
        const playheadRestored =
          Math.abs(playheadSeconds - recovery.savedPlayheadSeconds) <= PLAYHEAD_EPSILON_SECONDS;
        const skippedUserChanges = restoration.filter((entry) => entry.reason === "user_modified");
        const failedRestores = restoration.filter(
          (entry) => !entry.restored && entry.reason !== "user_modified"
        );
        const allRestored = failedRestores.length === 0 && playbackStopped && playheadRestored;
        const warnings = [];
        if (skippedUserChanges.length > 0) {
          warnings.push({
            code: "RESTORE_SKIPPED_USER_CHANGES",
            message:
              "Some mixer fields were changed after the audition started and were left untouched.",
          });
        }
        if (!allRestored) {
          warnings.push({
            code: "RESTORE_INCOMPLETE",
            message: !playbackStopped
              ? `Playback did not stop; observed status ${playbackStatus}.`
              : playheadRestored
                ? "One or more mixer fields did not read back as their pre-audition values."
                : "The playhead did not read back at the saved position.",
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
  return {
    fromBlick: request.fromBlick,
    toBlick: request.toBlick,
    soloTrackIndices,
    loop: request.loop === true,
  };
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
