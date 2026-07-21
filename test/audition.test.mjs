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
  };
  model.host = {
    epoch: () => 1,
    roots: async () => ({ project: h.project, sv: h.sv, playback: h.playback }),
    free: async () => {},
    index: async () => null,
    call: async ({ handle: target, method, args = [] }) => {
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
          model.solo[mixerIndex] = args[0];
          return null;
        }
        if (method === "isMuted") return model.muted[mixerIndex];
      }
      if (id === h.playback.__handle__) {
        model.playbackCalls.push([method, ...args]);
        if (method === "getPlayhead") return model.playhead;
        if (method === "getStatus") return model.status;
        if (method === "seek") {
          model.playhead = args[0];
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
  assert.equal(stopped.status, "succeeded");
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
