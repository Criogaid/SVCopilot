import assert from "node:assert/strict";
import test from "node:test";

import { AuditionService } from "../server/src/audition.js";

const Q = 705600;

// playback + mixer + timeAxis 模型：120 BPM 下 1 拍 = 0.5 秒。
function createAuditionModel() {
  let nextHandle = 600;
  const handle = (type) => ({ __handle__: nextHandle++, __type__: type, __epoch__: 1 });
  const h = {
    project: handle("Project"),
    sv: handle("SV"),
    playback: handle("PlaybackControl"),
    timeAxis: handle("TimeAxis"),
    tracks: [handle("Track"), handle("Track"), handle("Track")],
    mixers: [handle("TrackMixer"), handle("TrackMixer"), handle("TrackMixer")],
  };
  const model = {
    handles: h,
    playhead: 12.5,
    status: "stopped",
    playbackCalls: [],
    solo: [false, true, false],
    muted: [false, false, false],
    failures: [],
    ignoreSetSolo: false,
    ignoreSeek: false,
    ignorePlaybackStart: false,
    ignoreStop: false,
    playStatus: "playing",
    advancePlayheadOnReadSeconds: 0,
    epoch: 1,
  };
  model.host = {
    epoch: () => model.epoch,
    roots: async () => ({ project: h.project, sv: h.sv, playback: h.playback }),
    free: async () => {},
    index: async () => null,
    call: async ({ handle: target, method, args = [] }) => {
      const failure = model.failures.find(
        (item) => item.method === method && item.remainingSkips-- <= 0
      );
      if (failure) {
        model.failures.splice(model.failures.indexOf(failure), 1);
        const error = new Error(failure.message ?? `injected failure for ${method}`);
        if (failure.code) error.code = failure.code;
        throw error;
      }
      const id = target?.__handle__;
      if (id === h.project.__handle__) {
        if (method === "getTimeAxis") return h.timeAxis;
        if (method === "getNumTracks") return 3;
        if (method === "getTrack") return h.tracks[args[0] - 1];
      }
      if (id === h.timeAxis.__handle__ && method === "getSecondsFromBlick") {
        return (args[0] / Q) * 0.5;
      }
      const trackIndex = h.tracks.findIndex((track) => track.__handle__ === id);
      if (trackIndex >= 0 && method === "getMixer") return h.mixers[trackIndex];
      const mixerIndex = h.mixers.findIndex((mixer) => mixer.__handle__ === id);
      if (mixerIndex >= 0) {
        if (method === "isSolo") return model.solo[mixerIndex];
        if (method === "setSolo") {
          if (!model.ignoreSetSolo) model.solo[mixerIndex] = args[0];
          return null;
        }
        if (method === "isMuted") return model.muted[mixerIndex];
      }
      if (id === h.playback.__handle__) {
        model.playbackCalls.push([method, ...args]);
        if (method === "getPlayhead") {
          if (model.status !== "stopped") {
            model.playhead += model.advancePlayheadOnReadSeconds;
          }
          return model.playhead;
        }
        if (method === "getStatus") return model.status;
        if (method === "seek") {
          if (!model.ignoreSeek) model.playhead = args[0];
          return null;
        }
        if (method === "play") {
          if (!model.ignorePlaybackStart) model.status = model.playStatus;
          return null;
        }
        if (method === "loop") {
          if (!model.ignorePlaybackStart) model.status = "looping";
          return null;
        }
        if (method === "stop") {
          if (!model.ignoreStop) model.status = "stopped";
          return null;
        }
      }
      throw new Error(`unsupported audition call ${id}.${method}`);
    },
  };
  return model;
}

function createService(model) {
  return new AuditionService(
    { withExclusive: (task) => task(model.host) },
    { now: () => 1000 }
  );
}

function createAutoStopService(model) {
  let now = 1_000;
  let timer = null;
  let acquireDelayMs = 0;
  const session = {
    async withExclusive(task) {
      if (acquireDelayMs > 0) {
        now += acquireDelayMs;
        acquireDelayMs = 0;
      }
      return task(model.host);
    },
  };
  const service = new AuditionService(session, {
    now: () => now,
    setTimeoutFn(callback, delay) {
      timer = { callback, delay, cleared: false };
      return timer;
    },
    clearTimeoutFn(handle) {
      handle.cleared = true;
    },
  });
  return {
    service,
    timer: () => timer,
    advance(ms) {
      now += ms;
    },
    delayNextAcquire(ms) {
      acquireDelayMs = ms;
    },
  };
}

test("sv_start_audition saves state, solos tracks, seeks, and loops", async () => {
  const model = createAuditionModel();
  const service = createService(model);
  const result = await service.start({
    fromBlick: 8 * Q,
    toBlick: 16 * Q,
    soloTrackIndices: [0, 1],
    loop: true,
  });

  assert.equal(result.ok, true);
  assert.match(result.data.auditionId, /^aud_/);
  assert.equal(result.data.playbackStatus, "looping");
  assert.equal(result.data.endPolicy, "host_loop");
  assert.equal(result.data.range.fromSeconds, 4);
  assert.equal(result.data.range.toSeconds, 8);
  // track0 原来 false → 设 true；track1 原来已是 true → 不重复写。
  assert.deepEqual(model.solo, [true, true, false]);
  assert.deepEqual(result.data.recovery.mixerChanges, [
    { trackIndex: 0, field: "solo", previousValue: false, setValue: true },
    { trackIndex: 1, field: "solo", previousValue: true, setValue: true },
  ]);
  assert.equal(result.data.recovery.savedPlayheadSeconds, 12.5);
  assert.ok(model.playbackCalls.some(([method, a]) => method === "seek" && a === 4));
  assert.equal(result.data.perception, "human_only");
});

test("sv_get_audition reads live playback state", async () => {
  const model = createAuditionModel();
  const service = createService(model);
  const started = await service.start({ fromBlick: 0, toBlick: 4 * Q, loop: false });
  const status = await service.get({ auditionId: started.data.auditionId });
  assert.equal(status.data.playbackStatus, "playing");
  assert.equal(started.data.endPolicy, "caller_stop");
  assert.equal(status.data.endPolicy, "caller_stop");
  assert.equal(status.data.playheadSeconds, 0);
  assert.equal(status.data.staleEpoch, false);
});

test("sv_start_audition stops existing playback before deterministic seek verification", async () => {
  const model = createAuditionModel();
  model.status = "playing";
  model.advancePlayheadOnReadSeconds = 0.05;
  const result = await createService(model).start({
    fromBlick: 4 * Q,
    toBlick: 8 * Q,
    loop: false,
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.recovery.savedStatus, "playing");
  assert.equal(result.data.playbackStatus, "playing");
  const stopIndex = model.playbackCalls.findIndex(([method]) => method === "stop");
  const seekIndex = model.playbackCalls.findIndex(([method]) => method === "seek");
  assert.ok(stopIndex >= 0 && stopIndex < seekIndex);
});

test("sv_start_audition accepts looping status from play when the host loop region is active", async () => {
  const model = createAuditionModel();
  model.playStatus = "looping";
  const result = await createService(model).start({
    fromBlick: 0,
    toBlick: 4 * Q,
    loop: false,
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.playbackStatus, "looping");
  assert.ok(result.warnings.some((warning) => warning.code === "HOST_LOOP_REGION_ACTIVE"));
});

test("sv_stop_audition restores only fields the user did not change", async () => {
  const model = createAuditionModel();
  const service = createService(model);
  const started = await service.start({
    fromBlick: 0,
    toBlick: 4 * Q,
    soloTrackIndices: [0, 2],
    loop: true,
  });
  assert.deepEqual(model.solo, [true, true, true]);
  // 用户在 audition 期间手动取消了 track2 的 solo。
  model.solo[2] = false;

  const stopped = await service.stop({ auditionId: started.data.auditionId });
  assert.equal(stopped.ok, true);
  // 有被用户改动而跳过的字段时，状态是 partially_restored 而不是 succeeded。
  assert.equal(stopped.status, "partially_restored");
  assert.equal(stopped.data.playheadRestored, true);
  assert.ok(stopped.warnings.some((warning) => warning.code === "RESTORE_SKIPPED_USER_CHANGES"));
  assert.equal(model.status, "stopped");
  assert.equal(model.playhead, 12.5);
  assert.deepEqual(model.solo, [false, true, false]);
  const track2 = stopped.data.restoration.find((entry) => entry.trackIndex === 2);
  assert.equal(track2.restored, false);
  assert.equal(track2.reason, "user_modified");
  assert.equal(track2.observedAfterRestore, false);

  await assert.rejects(
    service.get({ auditionId: started.data.auditionId }),
    (error) => error.code === "UNKNOWN_AUDITION"
  );
});

test("sv_stop_audition restores the pre-audition playing state", async () => {
  const model = createAuditionModel();
  model.status = "playing";
  model.playStatus = "playing";
  const service = createService(model);
  const started = await service.start({ fromBlick: 0, toBlick: 2 * Q, loop: false });
  const stopped = await service.stop({ auditionId: started.data.auditionId });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.status, "succeeded");
  assert.equal(stopped.data.expectedPlaybackStatus, "playing");
  assert.equal(stopped.data.playbackStateRestored, true);
  assert.equal(model.status, "playing");
  assert.equal(model.playhead, 12.5);
});

test("sv_stop_audition restores looping when the retained host loop region permits it", async () => {
  const model = createAuditionModel();
  model.status = "looping";
  model.playStatus = "looping";
  const service = createService(model);
  const started = await service.start({ fromBlick: 0, toBlick: 2 * Q, loop: false });
  const stopped = await service.stop({ auditionId: started.data.auditionId });
  assert.equal(stopped.status, "succeeded");
  assert.equal(stopped.data.playbackStatus, "looping");
  assert.equal(stopped.data.playbackStateRestored, true);
});

test("sv_stop_audition reports restore_failed when playback cannot resume", async () => {
  const model = createAuditionModel();
  model.status = "playing";
  const service = createService(model);
  const started = await service.start({ fromBlick: 0, toBlick: 2 * Q, loop: false });
  model.ignorePlaybackStart = true;
  const stopped = await service.stop({ auditionId: started.data.auditionId });
  assert.equal(stopped.status, "restore_failed");
  assert.equal(stopped.data.expectedPlaybackStatus, "playing");
  assert.equal(stopped.data.playbackStatus, "stopped");
  assert.equal(stopped.data.playbackStateRestored, false);
});

test("sv_restore_audition works from the recovery payload alone", async () => {
  const model = createAuditionModel();
  const first = createService(model);
  const started = await first.start({
    fromBlick: 0,
    toBlick: 4 * Q,
    soloTrackIndices: [0],
    loop: false,
  });
  const recovery = started.data.recovery;

  // 模拟 server 重启：新实例没有内存中的 audition。
  const second = createService(model);
  await assert.rejects(
    second.stop({ auditionId: started.data.auditionId }),
    (error) => error.code === "UNKNOWN_AUDITION"
  );
  const restored = await second.restore({ recovery: JSON.parse(JSON.stringify(recovery)) });
  assert.equal(restored.ok, true);
  assert.deepEqual(model.solo, [false, true, false]);
  assert.equal(model.playhead, 12.5);
  assert.equal(model.status, "stopped");

  await assert.rejects(
    second.restore({ recovery: { version: 2 } }),
    (error) => error.code === "INVALID_ARGUMENTS"
  );
});

test("sv_start_audition validates range and track indices", async () => {
  const model = createAuditionModel();
  const service = createService(model);
  await assert.rejects(
    service.start({ fromBlick: 4 * Q, toBlick: 4 * Q }),
    (error) => error.code === "INVALID_ARGUMENTS"
  );
  await assert.rejects(
    service.start({ fromBlick: 0, toBlick: Q, soloTrackIndices: [9] }),
    (error) => error.code === "TRACK_INDEX_OUT_OF_RANGE"
  );
});

test("sv_start_audition compensates mixer and playhead when startup fails mid-way", async () => {
  const model = createAuditionModel();
  model.failures.push({ method: "loop", remainingSkips: 0, code: "ARGUMENT_MISMATCH" });
  const service = createService(model);
  const result = await service.start({
    fromBlick: 0,
    toBlick: 4 * Q,
    soloTrackIndices: [0],
    loop: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "rolled_back");
  assert.equal(result.effects, "reverted");
  assert.equal(result.data.rollback.verified, true);
  // solo 与 playhead 均已恢复；没有遗留 audition。
  assert.deepEqual(model.solo, [false, true, false]);
  assert.equal(model.playhead, 12.5);
  assert.ok(result.data.recovery.mixerChanges.length > 0);
  const soloEntry = result.data.restoration.find((entry) => entry.field === "solo");
  assert.equal(soloEntry.expected, false);
  assert.equal(result.data.recovery.savedStatus, "stopped");
  const next = await service.start({ fromBlick: 0, toBlick: Q, loop: false });
  assert.equal(next.ok, true);
});

test("sv_start_audition rejects a second concurrent audition", async () => {
  const model = createAuditionModel();
  const service = createService(model);
  const first = await service.start({ fromBlick: 0, toBlick: Q, loop: false });
  assert.equal(first.ok, true);
  await assert.rejects(
    service.start({ fromBlick: 0, toBlick: Q, loop: false }),
    (error) => error.code === "AUDITION_ACTIVE"
  );
  await service.stop({ auditionId: first.data.auditionId });
  const again = await service.start({ fromBlick: 0, toBlick: Q, loop: false });
  assert.equal(again.ok, true);
});

test("sv_stop_audition reports restore_failed when the host ignores setSolo", async () => {
  const model = createAuditionModel();
  const service = createService(model);
  const started = await service.start({
    fromBlick: 0,
    toBlick: Q,
    soloTrackIndices: [0],
    loop: false,
  });
  assert.deepEqual(model.solo, [true, true, false]);
  // 宿主静默忽略后续 setSolo：写过不算成功，读回决定 restored。
  model.ignoreSetSolo = true;

  const stopped = await service.stop({ auditionId: started.data.auditionId });
  assert.equal(stopped.status, "restore_failed");
  assert.equal(stopped.effects, "may_remain");
  assert.equal(stopped.data.restoration[0].restored, false);
  assert.ok(stopped.warnings.some((warning) => warning.code === "RESTORE_INCOMPLETE"));
  // audition 记录保留，可再次用 recovery 重试。
  const status = await service.get({ auditionId: started.data.auditionId });
  assert.equal(status.ok, true);
});

test("sv_start_audition compensates when getStatus fails after playback started", async () => {
  const model = createAuditionModel();
  // setSolo/seek/loop 都已生效，最后的 getStatus 失败也不能残留状态。
  model.failures.push({ method: "getStatus", remainingSkips: 1, code: "ARGUMENT_MISMATCH" });
  const service = createService(model);
  const result = await service.start({
    fromBlick: 0,
    toBlick: 4 * Q,
    soloTrackIndices: [0],
    loop: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "rolled_back");
  assert.deepEqual(model.solo, [false, true, false]);
  assert.equal(model.playhead, 12.5);
  assert.equal(model.status, "stopped");
  assert.ok(result.data.recovery);
});

test("sv_start_audition compensation verifies the playhead read-back", async () => {
  const model = createAuditionModel();
  model.failures.push({ method: "loop", remainingSkips: 0, code: "ARGUMENT_MISMATCH" });
  // 宿主静默忽略 seek：补偿必须读回发现 playhead 未恢复。
  const service = createService(model);
  const originalCall = model.host.call;
  let sawStartSeek = false;
  model.host.call = async (request) => {
    if (request.method === "seek" && !sawStartSeek) {
      sawStartSeek = true;
      model.playhead = request.args[0];
      return null;
    }
    if (request.method === "seek") {
      // 补偿阶段的 seek 被忽略。
      return null;
    }
    return originalCall(request);
  };
  const result = await service.start({
    fromBlick: 4 * Q,
    toBlick: 8 * Q,
    soloTrackIndices: [0],
    loop: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "rollback_failed");
  assert.equal(result.data.rollback.verified, false);
  const playheadEntry = result.data.restoration.find((entry) => entry.field === "playhead");
  assert.equal(playheadEntry.restored, false);
});

test("sv_start_audition rejects silently ignored startup mutations", async () => {
  const cases = [
    {
      configure(model) {
        model.ignoreSetSolo = true;
      },
      request: { fromBlick: 0, toBlick: Q, soloTrackIndices: [0], loop: false },
    },
    {
      configure(model) {
        model.ignoreSeek = true;
      },
      request: { fromBlick: 4 * Q, toBlick: 8 * Q, loop: false },
    },
    {
      configure(model) {
        model.ignorePlaybackStart = true;
      },
      request: { fromBlick: 0, toBlick: Q, loop: true },
    },
  ];

  for (const item of cases) {
    const model = createAuditionModel();
    item.configure(model);
    const result = await createService(model).start(item.request);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "POSTCONDITION_FAILED");
    assert.equal(result.status, "rolled_back");
    assert.equal(result.effects, "reverted");
  }
});

test("sv_stop_audition reports restore_failed when playback does not stop", async () => {
  const model = createAuditionModel();
  const service = createService(model);
  const started = await service.start({ fromBlick: 0, toBlick: Q, loop: false });
  model.ignoreStop = true;

  const stopped = await service.stop({ auditionId: started.data.auditionId });
  assert.equal(stopped.status, "restore_failed");
  assert.equal(stopped.effects, "may_remain");
  assert.equal(stopped.data.playbackStatus, "playing");
  assert.equal(stopped.data.playbackStopped, false);
  assert.ok(stopped.warnings.some((warning) => warning.code === "RESTORE_INCOMPLETE"));
});

test("sv_start_audition compensation verifies playback stopped", async () => {
  const model = createAuditionModel();
  model.ignoreStop = true;
  // 第一次 getStatus 保存旧状态，第二次在播放开始后失败并触发补偿。
  model.failures.push({ method: "getStatus", remainingSkips: 1, code: "ARGUMENT_MISMATCH" });
  const result = await createService(model).start({
    fromBlick: 0,
    toBlick: Q,
    loop: true,
  });

  assert.equal(result.status, "rollback_failed");
  const playbackEntry = result.data.restoration.find((entry) => entry.field === "playback");
  assert.equal(playbackEntry.restored, false);
  assert.equal(playbackEntry.observed, "looping");
});

test("sv_stop_audition refuses cross-epoch restores and returns the recovery payload", async () => {
  const model = createAuditionModel();
  const service = createService(model);
  const started = await service.start({
    fromBlick: 0,
    toBlick: Q,
    soloTrackIndices: [0],
    loop: false,
  });
  // 桥重连：epoch 变化后，旧 audition 的索引/solo 不能自动写进新工程。
  model.epoch = 2;
  const stopped = await service.stop({ auditionId: started.data.auditionId });

  assert.equal(stopped.ok, false);
  assert.equal(stopped.error.code, "STALE_AUDITION");
  assert.equal(stopped.effects, "none");
  assert.deepEqual(stopped.data.recovery.mixerChanges, started.data.recovery.mixerChanges);
  // 未做任何宿主写入。
  assert.deepEqual(model.solo, [true, true, false]);
  // 显式 sv_restore_audition 仍可用（调用方自行判断工程一致性）。
  const restored = await service.restore({ recovery: stopped.data.recovery });
  assert.equal(restored.ok, true);
  assert.deepEqual(model.solo, [false, true, false]);
});

test("auto-stop schedules without holding the host queue and restores at the endpoint", async () => {
  const model = createAuditionModel();
  const harness = createAutoStopService(model);
  const started = await harness.service.start({
    fromBlick: 0,
    toBlick: 4 * Q,
    soloTrackIndices: [0],
    loop: false,
    autoStop: true,
    restore: true,
    stopToleranceMs: 100,
  });
  assert.equal(started.data.endPolicy, "auto_stop");
  assert.equal(started.data.state, "playing");
  assert.equal(harness.timer().delay, 2_000);
  assert.equal(model.status, "playing");

  model.playhead = 2.12;
  harness.advance(2_120);
  await harness.timer().callback();
  const terminal = await harness.service.get({ auditionId: started.data.auditionId });
  assert.equal(terminal.status, "restored");
  assert.equal(terminal.data.autoStop.timerDelayMs, 120);
  assert.equal(terminal.data.autoStop.queueDelayMs, 0);
  assert.ok(Math.abs(terminal.data.autoStop.overrunMs - 120) < 1e-6);
  assert.deepEqual(
    terminal.data.transitionHistory.map((transition) => transition.state),
    ["scheduled", "playing", "stop_requested", "stopped", "restored"]
  );
  assert.equal(model.status, "stopped");
  assert.equal(model.playhead, 12.5);
  assert.deepEqual(model.solo, [false, true, false]);
  assert.ok(terminal.warnings.some((warning) => warning.code === "AUDITION_STOP_OVERRUN"));
});

test("auto-stop reports coordinator queue delay separately", async () => {
  const model = createAuditionModel();
  const harness = createAutoStopService(model);
  const started = await harness.service.start({
    fromBlick: 0,
    toBlick: 2 * Q,
    autoStop: true,
  });
  model.playhead = 1;
  harness.advance(1_000);
  harness.delayNextAcquire(350);
  await harness.timer().callback();
  const terminal = await harness.service.get({ auditionId: started.data.auditionId });
  assert.equal(terminal.data.autoStop.timerDelayMs, 0);
  assert.equal(terminal.data.autoStop.queueDelayMs, 350);
  assert.equal(terminal.data.autoStop.hostDispatchAt, terminal.data.autoStop.stopRequestedAt + 350);
});

test("auto-stop distinguishes a user stop and still restores temporary mixer state", async () => {
  const model = createAuditionModel();
  const harness = createAutoStopService(model);
  const started = await harness.service.start({
    fromBlick: 0,
    toBlick: 4 * Q,
    soloTrackIndices: [0],
    autoStop: true,
  });
  model.status = "stopped";
  model.playhead = 0.75;
  const terminal = await harness.service.get({ auditionId: started.data.auditionId });
  assert.equal(terminal.status, "stopped_by_user");
  assert.equal(terminal.data.autoStop.timerFiredAt, null);
  assert.equal(terminal.data.autoStop.overrunMs, null);
  assert.deepEqual(
    terminal.data.transitionHistory.map((transition) => transition.state),
    ["scheduled", "playing", "stop_requested", "stopped", "stopped_by_user"]
  );
  assert.equal(harness.timer().cleared, true);
  assert.deepEqual(model.solo, [false, true, false]);
  assert.equal(model.playhead, 12.5);
});

test("auto-stop preserves a manual stop instead of resuming saved playback", async () => {
  const model = createAuditionModel();
  model.status = "playing";
  const harness = createAutoStopService(model);
  const started = await harness.service.start({
    fromBlick: 0,
    toBlick: 4 * Q,
    soloTrackIndices: [0],
    autoStop: true,
  });
  model.status = "stopped";

  const terminal = await harness.service.get({ auditionId: started.data.auditionId });

  assert.equal(terminal.status, "stopped_by_user");
  assert.equal(terminal.data.savedPlaybackStatus, "playing");
  assert.equal(terminal.data.expectedPlaybackStatus, "stopped");
  assert.equal(terminal.data.userStopPreserved, true);
  assert.equal(model.status, "stopped");
  assert.ok(terminal.warnings.some((warning) => warning.code === "USER_STOP_PRESERVED"));
});

test("auto-stop can stop without restoring when restore is false", async () => {
  const model = createAuditionModel();
  const harness = createAutoStopService(model);
  const started = await harness.service.start({
    fromBlick: 0,
    toBlick: 2 * Q,
    soloTrackIndices: [0],
    autoStop: true,
    restore: false,
  });
  model.playhead = 1;
  harness.advance(1_000);
  await harness.timer().callback();
  const terminal = await harness.service.get({ auditionId: started.data.auditionId });
  assert.equal(terminal.status, "stopped");
  assert.equal(model.status, "stopped");
  assert.equal(model.playhead, 1);
  assert.deepEqual(model.solo, [true, true, false]);
});

test("timer and explicit stop share one auto-stop completion", async () => {
  const model = createAuditionModel();
  const harness = createAutoStopService(model);
  const started = await harness.service.start({
    fromBlick: 0,
    toBlick: 2 * Q,
    autoStop: true,
  });
  harness.advance(1_000);
  const timerCompletion = harness.timer().callback();
  const explicitStop = harness.service.stop({ auditionId: started.data.auditionId });
  await Promise.all([timerCompletion, explicitStop]);
  const stopCalls = model.playbackCalls.filter(([method]) => method === "stop");
  assert.equal(stopCalls.length, 1);
});

test("auto-stop failure remains a reusable structured terminal result", async () => {
  const model = createAuditionModel();
  const harness = createAutoStopService(model);
  const started = await harness.service.start({
    fromBlick: 0,
    toBlick: 2 * Q,
    autoStop: true,
  });
  model.failures.push({ method: "getStatus", remainingSkips: 0, code: "HOST_CALL_FAILED" });
  harness.advance(1_000);

  const timerResult = await harness.timer().callback();
  const fromGet = await harness.service.get({ auditionId: started.data.auditionId });
  const fromStop = await harness.service.stop({ auditionId: started.data.auditionId });

  assert.equal(timerResult.status, "restore_failed");
  assert.equal(fromGet.error.code, "HOST_CALL_FAILED");
  assert.equal(fromStop.error.code, "HOST_CALL_FAILED");
  assert.equal(fromGet.data.auditionId, started.data.auditionId);
  assert.deepEqual(fromGet.data.transitionHistory, fromStop.data.transitionHistory);
});
