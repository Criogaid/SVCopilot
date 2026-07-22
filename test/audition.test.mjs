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
        if (method === "getPlayhead") return model.playhead;
        if (method === "getStatus") return model.status;
        if (method === "seek") {
          if (!model.ignoreSeek) model.playhead = args[0];
          return null;
        }
        if (method === "play") {
          model.status = "playing";
          return null;
        }
        if (method === "loop") {
          model.status = "looping";
          return null;
        }
        if (method === "stop") {
          model.status = "stopped";
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
  assert.equal(status.data.playheadSeconds, 0);
  assert.equal(status.data.staleEpoch, false);
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
