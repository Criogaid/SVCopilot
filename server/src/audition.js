import { randomUUID } from "node:crypto";

import { createHostScope } from "./snapshot.js";

// MCP 无法听到声音：audition 只驱动宿主播放，感知判断永远属于人。
// Node 崩溃可能遗留 solo/mute，因此 start 返回可跨重启使用的 recovery payload。
export class AuditionService {
  constructor(session, { now = () => Date.now() } = {}) {
    this.session = session;
    this.now = now;
    this.auditions = new Map();
  }

  async start(request) {
    const input = normalizeStartRequest(request);
    return this.session.withExclusive(async (host) => {
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

        const savedPlayheadSeconds = await capture.call(roots.playback, "getPlayhead");
        const savedStatus = await capture.call(roots.playback, "getStatus");
        const mixerChanges = [];
        for (const trackIndex of input.soloTrackIndices) {
          const track = await capture.call(roots.project, "getTrack", [trackIndex + 1], {
            inferredType: "Track",
          });
          const mixer = await capture.call(track, "getMixer", [], { inferredType: "TrackMixer" });
          const previousSolo = await capture.call(mixer, "isSolo");
          if (previousSolo !== true) {
            await capture.call(mixer, "setSolo", [true]);
          }
          mixerChanges.push({ trackIndex, field: "solo", previousValue: previousSolo, setValue: true });
        }

        const fromSeconds = await capture.call(timeAxis, "getSecondsFromBlick", [input.fromBlick]);
        const toSeconds = await capture.call(timeAxis, "getSecondsFromBlick", [input.toBlick]);
        await capture.call(roots.playback, "seek", [fromSeconds]);
        if (input.loop) {
          await capture.call(roots.playback, "loop", [fromSeconds, toSeconds]);
        } else {
          await capture.call(roots.playback, "play", []);
        }
        const status = await capture.call(roots.playback, "getStatus");

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
          warnings: [],
        };
      } finally {
        await capture.releaseAll();
      }
    });
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
    const result = await this._restore(audition.recovery);
    if (result.ok) this.auditions.delete(auditionId);
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

  async _restore(recovery) {
    return this.session.withExclusive(async (host) => {
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
          let restored = false;
          let reason = null;
          if (observedBeforeRestore === change.setValue) {
            if (change.previousValue !== change.setValue) {
              await capture.call(mixer, "setSolo", [change.previousValue]);
            }
            restored = true;
          } else {
            reason = "user_modified";
          }
          const observedAfterRestore = await capture.call(mixer, "isSolo");
          restoration.push({
            trackIndex: change.trackIndex,
            field: change.field,
            auditionValue: change.setValue,
            previousValue: change.previousValue,
            observedBeforeRestore,
            restored,
            observedAfterRestore,
            ...(reason ? { reason } : {}),
          });
        }
        await capture.call(roots.playback, "seek", [recovery.savedPlayheadSeconds]);
        const playbackStatus = await capture.call(roots.playback, "getStatus");
        const playheadSeconds = await capture.call(roots.playback, "getPlayhead");
        const allRestored = restoration.every(
          (entry) => entry.restored || entry.observedAfterRestore === entry.previousValue
        );
        return {
          ok: true,
          status: allRestored ? "succeeded" : "partially_restored",
          effects: "verified",
          data: {
            playbackStatus,
            playheadSeconds,
            restoration,
          },
          warnings: allRestored
            ? []
            : [
                {
                  code: "RESTORE_SKIPPED_USER_CHANGES",
                  message:
                    "Some mixer fields were changed after the audition started and were left untouched.",
                },
              ],
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

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
