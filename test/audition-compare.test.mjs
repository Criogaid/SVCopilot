import assert from "node:assert/strict";
import test from "node:test";

import { AuditionCompareService } from "../server/src/audition-compare.js";
import { AuditionService } from "../server/src/audition.js";

// P1-D 验收：既有版本的人类 A/B 试听编排。
//
// 核心断言：本模块只做编排，播放/恢复全部走既有 audition 内核；A 完整恢复后 B 才开始；
// 不产生工程内容 Undo；不声称听见任何声音。

const Q = 705600;

function createModel() {
  let nextHandle = 800;
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
    solo: [false, false, false],
    soloHistory: [],
    methodCalls: [],
    failures: [],
    epoch: 1,
  };
  model.host = {
    epoch: () => model.epoch,
    roots: async () => ({ project: h.project, sv: h.sv, playback: h.playback }),
    free: async () => {},
    index: async () => null,
    call: async ({ handle: target, method, args = [] }) => {
      model.methodCalls.push(method);
      const failure = model.failures.find((item) => item.method === method);
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
          model.solo[mixerIndex] = args[0];
          model.soloHistory.push({ trackIndex: mixerIndex, value: args[0] });
          return null;
        }
        if (method === "isMuted") return false;
      }
      if (id === h.playback.__handle__) {
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
      throw new Error(`unsupported call ${id}.${method}`);
    },
  };
  return model;
}

// 两层都用可控时钟与定时器：audition 的 auto-stop 与 compare 的切换调度都能手动推进。
function createHarness(model) {
  let now = 1_000;
  const timers = new Set();
  const clock = {
    now: () => now,
    setTimeoutFn(callback, delay) {
      const entry = { callback, dueAt: now + delay, cleared: false };
      timers.add(entry);
      return entry;
    },
    clearTimeoutFn(entry) {
      entry.cleared = true;
      timers.delete(entry);
    },
  };
  const audition = new AuditionService(
    { withExclusive: (task) => task(model.host) },
    clock
  );
  const compare = new AuditionCompareService(audition, clock);
  return {
    audition,
    compare,
    async advance(ms) {
      now += ms;
      // 到期的定时器按时间顺序触发，并等待它们引发的异步工作完成。
      for (let guard = 0; guard < 32; guard += 1) {
        const due = [...timers]
          .filter((entry) => !entry.cleared && entry.dueAt <= now)
          .sort((left, right) => left.dueAt - right.dueAt);
        if (due.length === 0) break;
        const entry = due[0];
        timers.delete(entry);
        await entry.callback();
        await new Promise((resolve) => setImmediate(resolve));
      }
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

const BASE_REQUEST = Object.freeze({
  fromBlick: 0,
  toBlick: 8 * Q,
  variants: [
    { label: "a", soloTrackIndices: [0] },
    { label: "b", soloTrackIndices: [1] },
  ],
  estimatedDurationMs: 4000,
  gapMs: 200,
});

test("a comparison starts variant A immediately and returns without blocking", async () => {
  const model = createModel();
  const { compare } = createHarness(model);

  const result = await compare.compare({ ...BASE_REQUEST });

  assert.equal(result.ok, true);
  assert.equal(result.data.currentVariant, "a");
  assert.equal(result.data.state, "playing_a");
  assert.deepEqual(result.data.order, ["a", "b"]);
  // 立即返回：B 尚未播放。
  assert.deepEqual(model.solo, [true, false, false]);
  assert.equal(result.data.perception, "human_only");
  assert.match(result.data.humanGate, /never state a preference yourself/i);
  assert.ok(result.data.recovery, "each variant must expose its recovery escape hatch");
});

test("variant A is fully restored before variant B starts", async () => {
  const model = createModel();
  const harness = createHarness(model);
  const started = await harness.compare.compare({ ...BASE_REQUEST });
  const originalPlayhead = 12.5;

  await harness.advance(4200);

  const state = await harness.compare.get({ comparisonId: started.data.comparisonId });
  assert.equal(state.data.currentVariant, "b");
  // A 的 solo 已撤销，B 的已建立——两者不重叠，说明 A 先恢复到基线。
  assert.deepEqual(model.solo, [false, true, false]);
  const historyStates = state.data.transitionHistory.map((entry) => entry.state);
  assert.deepEqual(historyStates.slice(0, 4), ["prepared", "playing_a", "gap", "playing_b"]);
  // B 从与 A 相同的起点开始播放。
  assert.notEqual(originalPlayhead, model.playhead);
  assert.equal(model.playhead, 0);
});

test("the comparison completes with restore evidence and no content Undo", async () => {
  const model = createModel();
  const harness = createHarness(model);
  const started = await harness.compare.compare({ ...BASE_REQUEST });

  await harness.advance(4200);
  await harness.advance(4200);

  const final = await harness.compare.get({ comparisonId: started.data.comparisonId });
  assert.equal(final.data.state, "restored");
  assert.equal(final.data.reason, "completed");
  assert.deepEqual(
    final.data.playedVariants.map((entry) => entry.label),
    ["a", "b"]
  );
  // 全部 solo 恢复原状，playhead 回到原位。
  assert.deepEqual(model.solo, [false, false, false]);
  assert.equal(model.playhead, 12.5);
  // A/B 只改 mixer 与 playhead：绝不产生工程内容 Undo。
  assert.ok(!model.methodCalls.includes("newUndoRecord"));
  assert.equal(final.provenance.projectContentUndo, "none_only_mixer_and_playhead_are_touched");
  assert.equal(final.data.perception, "human_only");
});

test("stopping early restores state and is idempotent", async () => {
  const model = createModel();
  const harness = createHarness(model);
  const started = await harness.compare.compare({ ...BASE_REQUEST });

  const stopped = await harness.compare.stop({ comparisonId: started.data.comparisonId });
  assert.equal(stopped.data.reason, "stopped_by_user");
  assert.equal(stopped.data.state, "restored");
  assert.deepEqual(model.solo, [false, false, false]);
  assert.equal(model.playhead, 12.5);

  const again = await harness.compare.stop({ comparisonId: started.data.comparisonId });
  assert.deepEqual(again.data, stopped.data);
  const read = await harness.compare.get({ comparisonId: started.data.comparisonId });
  assert.deepEqual(read.data, stopped.data);
});

test("a stop request cancels the pending switch to variant B", async () => {
  const model = createModel();
  const harness = createHarness(model);
  const started = await harness.compare.compare({ ...BASE_REQUEST });

  await harness.compare.stop({ comparisonId: started.data.comparisonId });
  await harness.advance(10_000);

  const final = await harness.compare.get({ comparisonId: started.data.comparisonId });
  assert.deepEqual(
    final.data.playedVariants.map((entry) => entry.label),
    ["a"],
    "variant B must not start after an explicit stop"
  );
  assert.deepEqual(model.solo, [false, false, false]);
});

test("the comparison reuses the audition kernel rather than its own playback path", async () => {
  const model = createModel();
  const harness = createHarness(model);
  const started = await harness.compare.compare({ ...BASE_REQUEST });

  // 底层 audition 记录可直接查询：编排层没有另建一套播放状态。
  const variant = started.data;
  const state = await harness.compare.get({ comparisonId: variant.comparisonId });
  assert.ok(state.data.variantPlayback.ok);
  assert.equal(state.data.variantPlayback.data.state, "playing");
  assert.equal(
    state.provenance.playbackKernel,
    "reuses_sv_start_audition_start_stop_restore"
  );
});

test("a failed first variant fails the whole comparison instead of hiding it", async () => {
  const model = createModel();
  model.failures.push({ method: "play", code: "HOST_CALL_FAILED", message: "play refused" });
  const harness = createHarness(model);

  const result = await harness.compare.compare({ ...BASE_REQUEST });

  assert.equal(result.ok, false);
  assert.equal(result.status, "failed");
  assert.equal(result.data.failedVariant, "a");
  assert.ok(result.error.code);
  // 启动失败后不得残留 solo。
  assert.deepEqual(model.solo, [false, false, false]);
});

test("a thrown first-variant preflight failure becomes terminal and does not lock comparisons", async () => {
  const model = createModel();
  const harness = createHarness(model);
  const invalid = {
    ...BASE_REQUEST,
    variants: [
      { label: "a", soloTrackIndices: [99] },
      { label: "b", soloTrackIndices: [1] },
    ],
  };

  const failed = await harness.compare.compare(invalid);
  assert.equal(failed.ok, false);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error.code, "TRACK_INDEX_OUT_OF_RANGE");
  assert.equal(failed.data.failedVariant, "a");

  const next = await harness.compare.compare({ ...BASE_REQUEST });
  assert.equal(next.ok, true, "a terminal preflight failure must not leave COMPARISON_ACTIVE");
});

test("a failed variant restore aborts before the next variant starts", async () => {
  const model = createModel();
  const harness = createHarness(model);
  const started = await harness.compare.compare({ ...BASE_REQUEST });
  model.failures.push({
    method: "setSolo",
    code: "HOST_CALL_FAILED",
    message: "solo restore refused",
  });

  await harness.advance(4200);
  const result = await harness.compare.get({ comparisonId: started.data.comparisonId });

  assert.equal(result.ok, false);
  assert.equal(result.status, "restore_failed");
  assert.equal(result.data.reason, "variant_restore_failed");
  assert.equal(result.data.playedVariants.length, 1, "variant B must not start off a dirty baseline");
  assert.ok(result.data.recovery, "the failed restore must retain its recovery payload");
});

test("a structured later-variant start failure remains failed instead of becoming succeeded", async () => {
  const model = createModel();
  const harness = createHarness(model);
  const started = await harness.compare.compare({ ...BASE_REQUEST });
  model.failures.push({ method: "play", code: "HOST_CALL_FAILED", message: "B play refused" });

  await harness.advance(4200);
  const result = await harness.compare.get({ comparisonId: started.data.comparisonId });

  assert.equal(result.ok, false);
  assert.equal(result.status, "failed");
  assert.equal(result.data.failedVariant, "b");
  assert.equal(result.error.code, "HOST_CALL_FAILED");
});

test("a thrown later-variant preflight failure is caught by the background transition", async () => {
  const model = createModel();
  const harness = createHarness(model);
  const started = await harness.compare.compare({
    ...BASE_REQUEST,
    variants: [
      { label: "a", soloTrackIndices: [0] },
      { label: "b", soloTrackIndices: [99] },
    ],
  });

  await harness.advance(4200);
  const result = await harness.compare.get({ comparisonId: started.data.comparisonId });

  assert.equal(result.ok, false);
  assert.equal(result.status, "failed");
  assert.equal(result.data.failedVariant, "b");
  assert.equal(result.error.code, "TRACK_INDEX_OUT_OF_RANGE");
});

test("an explicit stop waits for an in-flight variant restore and preserves its failure", async () => {
  let scheduled = null;
  let releaseStop;
  const stopGate = new Promise((resolve) => {
    releaseStop = resolve;
  });
  const audition = {
    start: async () => ({
      ok: true,
      data: { auditionId: "aud_deferred", playbackStartedAt: 1000, recovery: {} },
      warnings: [],
    }),
    get: async () => ({ ok: true }),
    stop: async () => stopGate,
  };
  const compare = new AuditionCompareService(audition, {
    now: () => 1000,
    setTimeoutFn: (callback) => {
      scheduled = callback;
      return callback;
    },
    clearTimeoutFn: () => {},
  });
  const started = await compare.compare({ ...BASE_REQUEST });

  scheduled();
  await new Promise((resolve) => setImmediate(resolve));
  let settled = false;
  const stopPromise = compare
    .stop({ comparisonId: started.data.comparisonId })
    .then((result) => {
      settled = true;
      return result;
    });
  await new Promise((resolve) => setImmediate(resolve));
  const settledBeforeRestore = settled;
  releaseStop({
    ok: false,
    status: "restore_failed",
    data: { recovery: { version: 1 }, restoration: [] },
    error: { code: "RESTORE_FAILED", message: "injected restore failure" },
  });
  const result = await stopPromise;

  assert.equal(settledBeforeRestore, false, "stop must share the in-flight restore completion");
  assert.equal(result.ok, false);
  assert.equal(result.status, "restore_failed");
  assert.equal(result.data.state, "restore_failed");
});

test("only one comparison may be active at a time", async () => {
  const model = createModel();
  const harness = createHarness(model);
  const first = await harness.compare.compare({ ...BASE_REQUEST });

  await assert.rejects(
    () => harness.compare.compare({ ...BASE_REQUEST }),
    (error) => error.code === "COMPARISON_ACTIVE"
  );

  await harness.compare.stop({ comparisonId: first.data.comparisonId });
  // 终止后可以再开一次。
  const second = await harness.compare.compare({ ...BASE_REQUEST });
  assert.equal(second.ok, true);
});

test("an explicit order overrides the default a-then-b rounds", async () => {
  const model = createModel();
  const harness = createHarness(model);
  const started = await harness.compare.compare({
    ...BASE_REQUEST,
    order: ["b", "a", "b"],
  });

  assert.deepEqual(started.data.order, ["b", "a", "b"]);
  assert.equal(started.data.currentVariant, "b");
  assert.deepEqual(model.solo, [false, true, false]);

  await harness.advance(4200);
  const mid = await harness.compare.get({ comparisonId: started.data.comparisonId });
  assert.equal(mid.data.currentVariant, "a");
  assert.deepEqual(model.solo, [true, false, false]);
});

test("repeats expands into alternating rounds", async () => {
  const model = createModel();
  const harness = createHarness(model);
  const started = await harness.compare.compare({ ...BASE_REQUEST, repeats: 2 });
  assert.deepEqual(started.data.order, ["a", "b", "a", "b"]);
});

test("unknown comparison ids are rejected", async () => {
  const model = createModel();
  const harness = createHarness(model);
  await assert.rejects(
    () => harness.compare.get({ comparisonId: "cmp_missing" }),
    (error) => error.code === "UNKNOWN_COMPARISON"
  );
  await assert.rejects(
    () => harness.compare.stop({ comparisonId: "cmp_missing" }),
    (error) => error.code === "UNKNOWN_COMPARISON"
  );
});

test("malformed comparison requests are rejected before touching the host", async () => {
  const model = createModel();
  const harness = createHarness(model);
  const cases = [
    {},
    { fromBlick: 0, toBlick: 0, variants: BASE_REQUEST.variants },
    { fromBlick: 0, toBlick: 8 * Q, variants: [{ label: "a", soloTrackIndices: [0] }] },
    {
      fromBlick: 0,
      toBlick: 8 * Q,
      variants: [
        { label: "a", soloTrackIndices: [0] },
        { label: "a", soloTrackIndices: [1] },
      ],
    },
    // 两个 variant solo 完全相同：没有可比较的差异。
    {
      fromBlick: 0,
      toBlick: 8 * Q,
      variants: [
        { label: "a", soloTrackIndices: [0] },
        { label: "b", soloTrackIndices: [0] },
      ],
    },
    { ...BASE_REQUEST, order: ["a", "a"] },
    { ...BASE_REQUEST, order: ["a", "b"], repeats: 2 },
    { ...BASE_REQUEST, gapMs: -1 },
    { ...BASE_REQUEST, estimatedDurationMs: 10 },
    { ...BASE_REQUEST, autoRestore: false },
    { ...BASE_REQUEST, unknownField: true },
  ];
  for (const request of cases) {
    await assert.rejects(
      () => harness.compare.compare(request),
      (error) => error.code === "INVALID_ARGUMENTS",
      `expected INVALID_ARGUMENTS for ${JSON.stringify(request)}`
    );
  }
  assert.equal(model.methodCalls.length, 0, "validation must precede any host call");
});

test("the service never claims to have heard the audio", async () => {
  const model = createModel();
  const harness = createHarness(model);
  const started = await harness.compare.compare({ ...BASE_REQUEST });
  await harness.advance(4200);
  await harness.advance(4200);
  const final = await harness.compare.get({ comparisonId: started.data.comparisonId });

  const serialized = JSON.stringify(final);
  assert.doesNotMatch(serialized, /sounded/i);
  assert.doesNotMatch(serialized, /better|preferred variant|winner/i);
  assert.match(serialized, /human_only/);
  assert.equal(
    final.provenance.temporaryEditsForVariantB,
    "not_supported_no_undo_api_means_no_general_recovery_token"
  );
});
