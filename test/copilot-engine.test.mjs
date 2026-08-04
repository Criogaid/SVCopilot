import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { ExecutionCoordinator } from "../server/src/execution-coordinator.js";
import { HostSession } from "../server/src/host-session.js";
import { LyricsService } from "../server/src/lyrics.js";
import { ProcessingService, waitForProcessing } from "../server/src/processing.js";
import { SnapshotService, SnapshotStore } from "../server/src/snapshot.js";
import { decodeWireValue, getWireArrayMetadata } from "../server/src/wire-codec.js";
import { WorkflowExecutor, validatePlan } from "../server/src/workflow.js";

test("ExecutionCoordinator keeps every workflow contiguous", async () => {
  const coordinator = new ExecutionCoordinator();
  const order = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const first = coordinator.runExclusive(async () => {
    order.push("A1");
    await firstGate;
    order.push("A2");
  });
  const second = coordinator.runExclusive(async () => {
    order.push("B");
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["A1"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["A1", "A2", "B"]);
});

test("typed wire values preserve empty and sparse arrays, maps, nil, and handle epochs", () => {
  assert.deepEqual(
    decodeWireValue({ $sv: "array", length: 0, entries: {} }),
    []
  );
  const sparse = decodeWireValue(
    {
      $sv: "sparse-array",
      length: 4,
      entries: [
        [1, 62.5],
        [3, 64],
      ],
    },
    { epoch: 7 }
  );
  assert.deepEqual(sparse, [null, 62.5, null, 64]);
  assert.deepEqual(getWireArrayMetadata(sparse), {
    declaredLength: 4,
    observedItems: 2,
    observedIndices: [1, 3],
    sparse: true,
  });
  assert.equal(JSON.stringify(sparse), "[null,62.5,null,64]");
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        decodeWireValue({
          $sv: "map",
          entries: [
            ["name", "lead"],
            ["active", true],
          ],
        })
      )
    ),
    { name: "lead", active: true }
  );
  assert.equal(decodeWireValue({ $sv: "nil" }), null);
  assert.deepEqual(decodeWireValue({ $sv: "handle", id: 9, type: "Note" }, { epoch: 7 }), {
    __handle__: 9,
    __type__: "Note",
    __epoch__: 7,
  });
});

test("HostSession rejects epoch-bound handles after the bridge reconnects", async () => {
  class FakeBridge extends EventEmitter {
    getStatus() {
      return { state: "listening", epoch: 0 };
    }

    async call(command) {
      if (command.op === "root") return { project: { __handle__: 1, __type__: "Project" } };
      if (command.op === "call" && command.method === "getHostInfo") {
        return { hostName: "Synthesizer V Studio 2 Pro", hostVersion: "2.2.1" };
      }
      if (command.op === "call" && command.method === "getFileName") return "test.svp";
      throw new Error(`unsupported command: ${command.op}.${command.method ?? ""}`);
    }
  }

  const bridge = new FakeBridge();
  const session = new HostSession(bridge, { logger: { error() {} } });
  bridge.emit("attach", { epoch: 1 });
  const roots = await session.roots();
  assert.equal(roots.project.__epoch__, 1);
  assert.equal(session.getStatus().hostProduct, "Synthesizer V Studio 2 Pro");
  bridge.emit("attach", { epoch: 2 });
  assert.equal(session.getStatus().hostProduct, null);
  await assert.rejects(
    session.call({ handle: roots.project, method: "getFileName", args: [] }),
    (error) => error.code === "STALE_HANDLE"
  );
});

test("sv_run groups undo, resolves references, verifies read-back, and cleans temporary handles", async () => {
  const state = { name: "before", undo: 0, freed: [] };
  const project = handle(1, "Project");
  const note = handle(2, "Note");
  const host = {
    epoch: () => 1,
    roots: async () => ({ project, sv: handle(3, "SV") }),
    call: async ({ handle: target, method, args }) => {
      if (method === "newUndoRecord") return ++state.undo;
      if (target?.__handle__ === note.__handle__ && method === "setLyrics") {
        state.name = args[0];
        return false;
      }
      if (target?.__handle__ === note.__handle__ && method === "getLyrics") return state.name;
      if (method === "getHostInfo") return { hostVersion: "2.2.1" };
      throw new Error(`unsupported call: ${method}`);
    },
    index: async () => null,
    free: async (value) => state.freed.push(value?.__handle__ ?? value),
  };
  const session = { withExclusive: (task) => task(host) };
  const executor = new WorkflowExecutor(session);
  const result = await executor.run({
    mode: "write",
    inputs: { note, expectedLyrics: "after" },
    steps: [
      {
        id: "set",
        op: "call",
        target: { $ref: "#/inputs/note" },
        method: "setLyrics",
        args: ["after"],
      },
      {
        id: "verify",
        op: "call",
        target: { $ref: "#/inputs/note" },
        method: "getLyrics",
        verifiesStep: "set",
        expect: {
          operator: "equals",
          value: { $ref: "#/inputs/expectedLyrics" },
        },
        retainResult: true,
      },
    ],
    exports: { lyrics: { $ref: "#/steps/verify/result" } },
  });

  assert.equal(result.ok, true);
  assert.equal(result.exports.lyrics, "after");
  assert.equal(result.steps[1].verified, true);
  assert.equal(result.steps[1].verifiesStep, "set");
  assert.equal(result.steps[1].resultRef, "#/exports/lyrics");
  assert.equal(result.steps[1].result, undefined);
  assert.equal(result.effects, "verified");
  assert.ok(!result.warnings.some((warning) => warning.code === "UNVERIFIED_WRITE"));
  assert.equal(state.undo, 2);
  assert.equal(result.undo.automaticRollback, false);
  assert.ok(state.freed.includes(project.__handle__));
  assert.ok(!state.freed.includes(note.__handle__), "input handles belong to the caller");
  assert.deepEqual(result.handleOwnership, {
    policy: "caller_frees_returned_handles",
    inputHandleCount: 1,
    observedHandleCount: 2,
    autoFreedHandleCount: 2,
    returnedHandles: [],
    cleanupFailedHandles: [],
    callerMustFree: false,
  });
});

test("sv_run retains only explicit step results and exports", async () => {
  const state = { freed: [] };
  const project = handle(10, "Project");
  const track = handle(11, "Track");
  const group = handle(12, "NoteGroupReference");
  const target = handle(13, "NoteGroup");
  const host = {
    epoch: () => 1,
    roots: async () => ({ project }),
    call: async ({ handle: owner, method }) => {
      if (owner?.__handle__ === project.__handle__ && method === "getTrack") return track;
      if (owner?.__handle__ === track.__handle__ && method === "getGroupReference") return group;
      if (owner?.__handle__ === group.__handle__ && method === "getTarget") return target;
      throw new Error(`unsupported call: ${method}`);
    },
    index: async () => null,
    free: async (value) => state.freed.push(value?.__handle__ ?? value),
  };
  const executor = new WorkflowExecutor({ withExclusive: (task) => task(host) });

  const result = await executor.run({
    mode: "read",
    steps: [
      {
        id: "track",
        op: "call",
        target: { $ref: "#/roots/project" },
        method: "getTrack",
        args: [1],
      },
      {
        id: "group",
        op: "call",
        target: { $ref: "#/steps/track/result" },
        method: "getGroupReference",
        args: [1],
      },
      {
        id: "target",
        op: "call",
        target: { $ref: "#/steps/group/result" },
        method: "getTarget",
        retainResult: true,
      },
    ],
    exports: { group: { $ref: "#/steps/group/result" } },
  });

  assert.equal(result.ok, true);
  assert.equal(result.steps[0].result, undefined);
  assert.equal(result.steps[1].result, undefined);
  assert.deepEqual(result.steps[2].result, target);
  assert.deepEqual(result.exports.group, group);
  assert.deepEqual(result.handleOwnership, {
    policy: "caller_frees_returned_handles",
    inputHandleCount: 0,
    observedHandleCount: 4,
    autoFreedHandleCount: 2,
    returnedHandles: [group, target],
    cleanupFailedHandles: [],
    callerMustFree: true,
  });
  assert.deepEqual(state.freed, [project.__handle__, track.__handle__]);

  await host.free(group);
  await host.free(target);
  assert.deepEqual(state.freed, [
    project.__handle__,
    track.__handle__,
    group.__handle__,
    target.__handle__,
  ]);
});

test("sv_run exposes handles whose automatic cleanup failed", async () => {
  const project = handle(14, "Project");
  const host = {
    epoch: () => 1,
    roots: async () => ({ project }),
    call: async ({ method }) => {
      if (method === "getFileName") return "Example";
      throw new Error(`unsupported call: ${method}`);
    },
    index: async () => null,
    free: async () => {
      throw new Error("temporary failure");
    },
  };
  const executor = new WorkflowExecutor({ withExclusive: (task) => task(host) });

  const result = await executor.run({
    mode: "read",
    steps: [
      {
        id: "name",
        op: "call",
        target: { $ref: "#/roots/project" },
        method: "getFileName",
      },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.handleOwnership.autoFreedHandleCount, 0);
  assert.deepEqual(result.handleOwnership.cleanupFailedHandles, [project]);
  assert.equal(result.handleOwnership.callerMustFree, true);
  assert.ok(result.warnings.some((warning) => warning.code === "HANDLE_CLEANUP_FAILED"));
});

test("sv_run rejects missing input references before calling the host", async () => {
  let hostCalls = 0;
  const executor = new WorkflowExecutor({
    withExclusive: async (task) => {
      hostCalls += 1;
      return task({});
    },
  });
  const result = await executor.run({
    mode: "write",
    inputs: { owned: handle(99, "Note") },
    steps: [
      {
        id: "write",
        op: "call",
        target: { $ref: "#/inputs/missing" },
        method: "setLyrics",
        args: ["la"],
      },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.phase, "validate");
  assert.equal(hostCalls, 0);
  assert.match(result.error.message, /input reference does not exist/);
  assert.equal(result.handleOwnership.inputHandleCount, 1);
  assert.equal(result.handleOwnership.observedHandleCount, 0);
  assert.equal(result.handleOwnership.callerMustFree, false);
  assert.equal(
    validatePlan({
      mode: "read",
      inputs: { expected: "ok" },
      steps: [
        {
          id: "read",
          op: "call",
          method: "getFileName",
          expect: { operator: "equals", value: { $ref: "#/inputs/expected" } },
        },
      ],
    }).ok,
    true
  );
  const legacyReturn = validatePlan({
    mode: "read",
    steps: [{ id: "legacy", op: "call", method: "getFileName", return: true }],
  });
  assert.equal(legacyReturn.ok, false);
  assert.match(legacyReturn.error.message, /return was removed; use retainResult/);
});

test("sv_run still closes its undo boundary after the workflow deadline", async () => {
  let clock = 0;
  let undoCount = 0;
  const project = handle(20, "Project");
  const note = handle(21, "Note");
  const host = {
    epoch: () => 1,
    roots: async () => ({ project }),
    call: async ({ method }) => {
      if (method === "newUndoRecord") return ++undoCount;
      if (method === "setLyrics") {
        clock = 101;
        return null;
      }
      throw new Error(`unsupported call: ${method}`);
    },
    index: async () => null,
    free: async () => {},
  };
  const executor = new WorkflowExecutor(
    { withExclusive: (task) => task(host) },
    { now: () => clock }
  );
  const result = await executor.run({
    mode: "write",
    timeoutMs: 100,
    inputs: { note },
    steps: [
      {
        id: "write",
        op: "call",
        target: { $ref: "#/inputs/note" },
        method: "setLyrics",
        args: ["la"],
      },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(undoCount, 2);
  assert.equal(result.undo.boundaryCallsCompleted, 2);
});

test("sv_run reports coverage details and deduplicates exported large arrays", async () => {
  const values = [...Array(90).fill(60), ...Array(10).fill(null)];
  const host = {
    epoch: () => 1,
    roots: async () => ({ sv: handle(30, "SV") }),
    call: async ({ method }) => {
      if (method === "getComputedPitchForGroup") return values;
      throw new Error(`unsupported call: ${method}`);
    },
    index: async () => null,
    free: async () => {},
  };
  const executor = new WorkflowExecutor({ withExclusive: (task) => task(host) });
  const succeeded = await executor.run({
    mode: "read",
    steps: [
      {
        id: "pitch",
        op: "call",
        method: "getComputedPitchForGroup",
        expect: { operator: "coverageAtLeast", value: 0.9 },
        retainResult: true,
      },
    ],
    exports: { pitch: { $ref: "#/steps/pitch/result" } },
  });

  assert.equal(succeeded.ok, true);
  assert.equal(succeeded.exports.pitch.length, 100);
  assert.equal(succeeded.steps[0].result, undefined);
  assert.equal(succeeded.steps[0].resultRef, "#/exports/pitch");
  assert.deepEqual(succeeded.steps[0].observed, {
    valueShape: "array",
    count: 100,
    populatedCount: 90,
    numericCount: 90,
    min: 60,
    max: 60,
  });
  assert.equal(succeeded.steps[0].assertion.observedCoverage, 0.9);

  const failed = await executor.run({
    mode: "read",
    steps: [
      {
        id: "pitch",
        op: "call",
        method: "getComputedPitchForGroup",
        expect: { operator: "coverageAtLeast", value: 0.91 },
      },
    ],
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.error.details.observedCoverage, 0.9);
  assert.equal(failed.error.details.requiredCoverage, 0.91);
});

test("phoneme readiness distinguishes legal empty values from unfinished shape", async () => {
  const phonemes = [
    "w eh n",
    "ay",
    "s iy",
    "",
    "ao l",
    "dh ax",
    "g l ao",
    "",
    "",
    "",
    "r iy",
    "",
    "",
    "br",
    "dh ae t",
    "l ah v",
    "hh ae z",
    "g ih",
    "v ax n",
    "m iy",
    "m ay",
    "hh ow l",
    "l ay f",
  ];
  const host = {
    call: async () => phonemes,
  };
  const common = {
    roots: { sv: handle(31, "SV") },
    group: handle(32, "NoteGroupReference"),
    kind: "phonemes",
    expectedNotes: 23,
    timeoutMs: 0,
    sleepFn: async () => {},
    now: () => 0,
  };
  const allowed = await waitForProcessing(host, common);
  assert.equal(allowed.status, "succeeded");
  assert.equal(allowed.data.state, "ready");
  assert.equal(allowed.data.evidence.computedItems, 23);
  assert.equal(allowed.data.evidence.nonEmptyPhonemes, 17);
  assert.equal(allowed.data.evidence.emptyPhonemes, 6);
  assert.deepEqual(allowed.data.evidence.emptyPhonemeNotes, [3, 7, 8, 9, 11, 12]);
  assert.equal(allowed.data.evidence.phonemeCoverage.emptyNotes, 6);
  assert.equal(allowed.data.evidence.readinessPolicy, "allow_empty");

  const strict = await waitForProcessing(host, { ...common, requireNonEmpty: true });
  assert.equal(strict.status, "phoneme_coverage_unsatisfied");
  assert.equal(strict.data.state, "ready");
  assert.equal(strict.warnings[0].code, "PHONEME_COVERAGE_UNSATISFIED");
});

test("computed-pitch waiting returns evidence by default and values only on opt-in", async () => {
  const values = Array.from({ length: 640 }, (_, index) =>
    index % 8 === 0 ? null : 60 + index / 1000
  );
  const common = {
    roots: { sv: handle(36, "SV") },
    group: handle(37, "NoteGroupReference"),
    kind: "computedPitch",
    startBlick: 0,
    intervalBlick: 100,
    frames: values.length,
    timeoutMs: 0,
    sleepFn: async () => {},
    now: () => 0,
  };
  const host = { call: async () => values };

  const summary = await waitForProcessing(host, common);
  assert.equal(summary.status, "succeeded");
  assert.equal(summary.data.values, undefined);
  assert.equal(summary.data.evidence.returnedFrames, values.length);
  assert.equal(summary.data.evidence.observedFrames, 560);
  assert.equal(summary.data.evidence.nullFrames, 80);
  assert.equal(summary.data.evidence.coverage, 0.875);
  assert.match(summary.data.evidence.contentHash, /^sha256_[0-9a-f]{64}$/);
  assert.ok(
    Buffer.byteLength(JSON.stringify(summary), "utf8") < 1024,
    "a status-only 640-frame observation must remain a summary response"
  );

  const detailed = await waitForProcessing(host, { ...common, includeValues: true });
  assert.deepEqual(detailed.data.values, values);
  assert.equal(detailed.data.evidence.contentHash, summary.data.evidence.contentHash);
});

test("phoneme readiness uses observed envelope entries instead of padded array length", async () => {
  const padded = decodeWireValue({
    $sv: "sparse-array",
    length: 2,
    entries: [[0, "a"]],
  });
  const result = await waitForProcessing(
    { call: async () => padded },
    {
      roots: { sv: handle(33, "SV") },
      group: handle(34, "NoteGroupReference"),
      kind: "phonemes",
      expectedNotes: 2,
      timeoutMs: 0,
      sleepFn: async () => {},
      now: () => 0,
    }
  );

  assert.equal(result.status, "processing_pending");
  assert.equal(result.data.state, "pending");
  assert.equal(result.data.evidence.computedItems, 1);
  assert.deepEqual(result.data.evidence.missingPhonemeNotes, [1]);
});

test("phoneme stablePolls compares consecutive observations", async () => {
  const observations = [["a", ""], ["changed", ""], ["changed", ""]];
  let calls = 0;
  let clock = 0;
  const result = await waitForProcessing(
    { call: async () => observations[Math.min(calls++, observations.length - 1)] },
    {
      roots: { sv: handle(35, "SV") },
      group: handle(36, "NoteGroupReference"),
      kind: "phonemes",
      expectedNotes: 2,
      stablePolls: 2,
      timeoutMs: 100,
      pollIntervalMs: 20,
      sleepFn: async () => {},
      now: () => clock++,
    }
  );

  assert.equal(result.status, "succeeded");
  assert.equal(result.data.state, "ready");
  assert.equal(result.data.attempts, 3);
});

test("group snapshot reports complete phonemes with legal empty values as ready", async () => {
  const model = createSynthModel();
  model.computedPhonemes = ["a", ""];
  const snapshots = new SnapshotService({ withExclusive: (task) => task(model.host) });
  const snapshot = await snapshots.snapshot({
    scope: { kind: "group", trackIndex: 0, groupIndex: 0 },
    include: ["processing"],
  });

  assert.equal(snapshot.data.processing.state, "ready");
  assert.equal(snapshot.data.processing.computedItems, 2);
  assert.deepEqual(snapshot.data.processing.emptyPhonemeNotes, [1]);
  assert.deepEqual(snapshot.data.processing.phonemeCoverage.emptyNoteIndices, [1]);
});

test("selection snapshot and sv_set_lyrics form a verified high-level workflow", async () => {
  const model = createSynthModel();
  const session = { withExclusive: (task) => task(model.host) };
  const store = new SnapshotStore({ now: () => 1000 });
  const snapshots = new SnapshotService(session, { store, now: () => 1000 });
  const lyrics = new LyricsService(session, snapshots, {
    sleepFn: async () => {},
    now: (() => {
      let value = 1000;
      return () => value++;
    })(),
  });

  const snapshot = await snapshots.snapshot({ scope: { kind: "selection" } });
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.data.notes.length, 2);
  assert.equal(snapshot.data.notes[0].indexInGroup, 0);
  assert.equal(snapshot.data.group.voice.identityStatus, "unobservable");
  assert.equal(snapshot.data.capabilities.singerIdentity, "unobservable");

  const result = await lyrics.setLyrics({
    contextId: snapshot.contextId,
    lyrics: ["さ", "よ"],
    waitFor: "phonemes",
    timeoutMs: 100,
    pollIntervalMs: 20,
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "succeeded");
  assert.equal(result.effects, "verified");
  assert.deepEqual(model.notes.map((note) => note.lyrics), ["さ", "よ"]);
  assert.equal(model.undoCount, 2);
  assert.equal(result.data.processing.evidence.nonEmptyPhonemes, 2);
  assert.equal(result.data.processing.evidence.expectedNotes, 2);
  assert.equal(result.undo.expectedUserUndoSteps, 1);
});

test("sv_set_lyrics directs range contexts to range-capable editors", async () => {
  const model = createSynthModel();
  const session = { withExclusive: (task) => task(model.host) };
  const store = new SnapshotStore({ now: () => 1000 });
  const snapshots = new SnapshotService(session, { store, now: () => 1000 });
  const entry = store.create({
    epoch: 1,
    scope: { kind: "range" },
    observedAt: new Date(1000).toISOString(),
    context: { kind: "range", occurrences: [] },
  });
  const lyrics = new LyricsService(session, snapshots, { now: () => 1000 });

  const result = await lyrics.setLyrics({
    contextId: entry.contextId,
    lyrics: ["where"],
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "INVALID_CONTEXT");
  assert.match(result.error.message, /sv_patch_notes/);
  assert.match(result.error.message, /sv_edit_phrase/);
  assert.equal(model.undoCount, 0);
});

test("sv_set_lyrics reports processed and actually changed notes with full evidence", async () => {
  const model = createSynthModel();
  const session = { withExclusive: (task) => task(model.host) };
  const snapshots = new SnapshotService(session, {
    store: new SnapshotStore({ now: () => 1000 }),
    now: () => 1000,
  });
  const lyrics = new LyricsService(session, snapshots, { now: () => 1000 });
  const snapshot = await snapshots.snapshot({ scope: { kind: "selection" } });
  const result = await lyrics.setLyrics({
    contextId: snapshot.contextId,
    lyrics: ["a", "changed"],
    phonemes: [null, "x"],
    waitFor: "none",
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.processedNotes, 2);
  assert.equal(result.data.actuallyChangedNotes, 1);
  assert.equal(result.data.changedNotes, 1);
  assert.deepEqual(result.verification.evidence.observedLyrics, ["a", "changed"]);
  assert.deepEqual(result.verification.evidence.observedPhonemes, ["", "x"]);
  assert.equal(model.notes[0].lyrics, "a");
  assert.equal(model.notes[1].lyrics, "changed");
  assert.equal(model.undoCount, 2);
});

test("ProcessingService derives expected notes from a group snapshot context", async () => {
  const model = createSynthModel();
  const session = { withExclusive: (task) => task(model.host) };
  const snapshots = new SnapshotService(session, {
    store: new SnapshotStore({ now: () => 1000 }),
    now: () => 1000,
  });
  const snapshot = await snapshots.snapshot({
    scope: { kind: "group", trackIndex: 0, groupIndex: 0 },
    include: ["notes"],
  });
  const processing = new ProcessingService(session, snapshots, {
    sleepFn: async () => {},
    now: () => 1000,
  });
  const result = await processing.wait({
    contextId: snapshot.contextId,
    kind: "phonemes",
    timeoutMs: 0,
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.evidence.expectedNotes, 2);
  assert.equal(result.data.evidence.computedItems, 2);
});

test("ProcessingService resolves single and explicit range occurrences", async () => {
  const model = createSynthModel();
  const callHost = model.host.call;
  let noteGetterCalls = 0;
  const computedPitchCalls = [];
  model.host.call = async (request) => {
    if (
      model.handles.notes.some((note) => note.__handle__ === request.handle?.__handle__) &&
      request.method.startsWith("get")
    ) {
      noteGetterCalls += 1;
    }
    if (
      request.handle?.__handle__ === model.handles.sv.__handle__ &&
      request.method === "getComputedPitchForGroup"
    ) {
      computedPitchCalls.push(request.args);
      return Array.from({ length: request.args[3] }, (_, index) => 60 + index / 100);
    }
    return callHost(request);
  };
  const session = { withExclusive: (task) => task(model.host) };
  const store = new SnapshotStore({ now: () => 1000 });
  const snapshots = new SnapshotService(session, { store, now: () => 1000 });
  const stored = store.create({
    epoch: 1,
    context: { kind: "range", occurrences: [] },
  });
  stored.context.occurrences.push({
    occurrence: 0,
    trackIndex: 0,
    groupIndex: 0,
    targetGroupUuid: "group-1",
  });
  const processing = new ProcessingService(session, snapshots, {
    sleepFn: async () => {},
    now: () => 1000,
  });

  const automatic = await processing.wait({
    contextId: stored.contextId,
    kind: "phonemes",
    timeoutMs: 0,
  });
  assert.equal(automatic.ok, true);
  assert.equal(automatic.target.occurrence, 0);
  assert.equal(automatic.target.groupUuid, "group-1");
  assert.equal(automatic.data.evidence.expectedNotes, 2);

  await assert.rejects(
    processing.wait({
      contextId: stored.contextId,
      kind: "computedPitch",
      timeoutMs: 0,
    }),
    (error) =>
      error.code === "INVALID_ARGUMENTS" &&
      /captured with include:\["computedPitch"\]/.test(error.message)
  );
  assert.equal(computedPitchCalls.length, 0);

  stored.context.computedPitchByOccurrence = {
    0: {
      startBlick: 705_600,
      intervalBlick: 176_400,
      frames: 4,
      values: [null, null, null, null],
    },
  };
  const inferredPitch = await processing.wait({
    contextId: stored.contextId,
    kind: "computedPitch",
    timeoutMs: 0,
  });
  assert.equal(inferredPitch.status, "succeeded");
  assert.deepEqual(computedPitchCalls[0].slice(1), [705_600, 176_400, 4]);
  assert.equal(inferredPitch.data.evidence.requestedFrames, 4);
  assert.equal(inferredPitch.data.evidence.returnedFrames, 4);
  assert.equal(inferredPitch.data.evidence.observedFrames, 4);
  assert.equal(inferredPitch.data.evidence.nullFrames, 0);
  assert.match(inferredPitch.data.evidence.contentHash, /^sha256_[0-9a-f]{64}$/);

  stored.context.occurrences.push({
    occurrence: 1,
    trackIndex: 0,
    groupIndex: 0,
    targetGroupUuid: "group-1",
  });
  await assert.rejects(
    processing.wait({ contextId: stored.contextId, kind: "phonemes", timeoutMs: 0 }),
    (error) => {
      assert.equal(error.code, "AMBIGUOUS_CONTEXT");
      assert.deepEqual(error.details.candidates, [0, 1]);
      return true;
    }
  );

  const explicit = await processing.wait({
    contextId: stored.contextId,
    occurrence: 1,
    kind: "phonemes",
    timeoutMs: 0,
  });
  assert.equal(explicit.ok, true);
  assert.equal(explicit.target.occurrence, 1);
  assert.equal(explicit.data.evidence.computedItems, 2);
  assert.equal(noteGetterCalls, 0);
});

test("HostSession classifies stable host failures", async () => {
  class ErrorBridge extends EventEmitter {
    getStatus() {
      return { state: "listening", epoch: 1 };
    }

    async call(command) {
      if (command.op === "root") return { project: { __handle__: 1, __type__: "Project" } };
      if (command.op === "call" && command.method === "getHostInfo") {
        return { hostVersion: "2.2.1" };
      }
      if (command.op === "index") throw new Error("no such field: MISSING");
      if (command.method === "missing") throw new Error("no such method: missing");
      if (command.method === "released") throw new Error("unknown handle: 99");
      if (command.method === "getTrack") throw new Error("index out of range: 100");
      throw new Error("unclassified native failure");
    }
  }

  const session = new HostSession(new ErrorBridge(), { logger: { error() {} } });
  const roots = await session.roots();
  await assert.rejects(
    session.call({ handle: roots.project, method: "missing" }),
    (error) => error.code === "UNKNOWN_METHOD"
  );
  await assert.rejects(
    session.index({ handle: roots.project, field: "MISSING" }),
    (error) => error.code === "UNKNOWN_FIELD"
  );
  await assert.rejects(
    session.call({ handle: 99, method: "released" }),
    (error) => error.code === "UNKNOWN_HANDLE"
  );
  await assert.rejects(
    session.call({ handle: roots.project, method: "getTrack", args: [100] }),
    (error) => error.code === "INDEX_OUT_OF_RANGE"
  );
});

test("group snapshot reports caller and native indices for out-of-range targets", async () => {
  const model = createSynthModel();
  const snapshots = new SnapshotService({ withExclusive: (task) => task(model.host) });
  await assert.rejects(
    snapshots.snapshot({ scope: { kind: "group", trackIndex: 99, groupIndex: 0 } }),
    (error) =>
      error.code === "TRACK_INDEX_OUT_OF_RANGE" &&
      /trackIndex 99/.test(error.message) &&
      /native index 100/.test(error.message)
  );
});

test("project snapshots stop host traversal at the page boundary", async () => {
  const model = createProjectTraversalModel(30);
  const session = { withExclusive: (task) => task(model.host) };
  const snapshots = new SnapshotService(session, {
    store: new SnapshotStore({ now: () => 1000 }),
    now: () => 1000,
  });

  const first = await snapshots.snapshot({
    scope: { kind: "project" },
    include: ["structure"],
    pageSize: 50,
  });
  assert.equal(first.data.tracks[0].groups.length, 16);
  assert.equal(first.page.unit, "traversalItems");
  assert.equal(first.page.count, 16);
  assert.deepEqual(first.page.returned, { tracks: 1, groups: 16, notes: 0 });
  assert.equal(first.page.effectiveSize, 16);
  assert.equal(first.page.truncated, true);
  assert.ok(first.page.nextCursor);
  assert.ok(model.hostCalls <= 165, `first page made ${model.hostCalls} host calls`);

  const callsAfterFirstPage = model.hostCalls;
  const second = await snapshots.snapshot({ cursor: first.page.nextCursor, pageSize: 50 });
  assert.equal(second.data.tracks[0].groups.length, 14);
  assert.equal(second.page.count, 14);
  assert.equal(second.page.truncated, false);
  assert.equal(second.data.snapshotComplete, true);
  assert.ok(model.hostCalls - callsAfterFirstPage <= 145);
  await assert.rejects(
    snapshots.snapshot({ cursor: first.page.nextCursor, pageSize: 50 }),
    (error) => error.code === "STALE_CURSOR"
  );
});

test("project snapshot bounds a large group even with every include enabled", async () => {
  const model = createProjectTraversalModel(1, 30);
  const session = { withExclusive: (task) => task(model.host) };
  const snapshots = new SnapshotService(session, {
    store: new SnapshotStore({ now: () => 1000 }),
    now: () => 1000,
  });
  const first = await snapshots.snapshot({
    scope: { kind: "project" },
    include: ["structure", "notes", "voiceParameters", "processing"],
    pageSize: 50,
  });

  assert.equal(first.data.notes.length, 16);
  assert.equal(first.data.tracks[0].groups[0].processing.state, "ready");
  assert.equal(first.data.tracks[0].groups[0].voice.identityStatus, "unobservable");
  assert.equal(first.page.count, 16);
  assert.deepEqual(first.page.returned, { tracks: 1, groups: 1, notes: 16 });
  assert.equal(first.page.truncated, true);
  assert.ok(model.hostCalls <= 170, `first rich page made ${model.hostCalls} host calls`);
});

test("project pagination distinguishes traversal budget from returned notes", async () => {
  const model = createProjectTraversalModel(2, [0, 30]);
  const snapshots = new SnapshotService({ withExclusive: (task) => task(model.host) }, {
    store: new SnapshotStore({ now: () => 1000 }),
    now: () => 1000,
  });
  const page = await snapshots.snapshot({
    scope: { kind: "project" },
    include: ["structure", "notes"],
    pageSize: 50,
  });

  assert.equal(page.page.unit, "traversalItems");
  assert.equal(page.page.count, 16);
  assert.equal(page.data.notes.length, 15);
  assert.deepEqual(page.page.returned, { tracks: 1, groups: 2, notes: 15 });

  const nextPage = await snapshots.snapshot({ cursor: page.page.nextCursor, pageSize: 50 });
  assert.equal(nextPage.page.offset, 16);
  assert.equal(nextPage.page.count, 15);
  assert.deepEqual(nextPage.page.returned, { tracks: 1, groups: 1, notes: 15 });
  assert.equal(nextPage.data.notes.length, 15);
  assert.equal(nextPage.data.snapshotComplete, true);
});

test("project page retains root handles while crossing track boundaries", async () => {
  const model = createLifecycleProjectModel([2, 2]);
  const session = { withExclusive: (task) => task(model.host) };
  const snapshots = new SnapshotService(session, {
    store: new SnapshotStore({ now: () => 1000 }),
    now: () => 1000,
  });
  const page = await snapshots.snapshot({
    scope: { kind: "project" },
    include: ["structure"],
    pageSize: 4,
  });

  assert.equal(page.data.tracks.length, 2);
  assert.equal(page.data.tracks.flatMap((track) => track.groups).length, 4);
  assert.equal(page.data.snapshotComplete, true);
});

test("project processing retains the SV root until the page is complete", async () => {
  const model = createLifecycleProjectModel([1], { noteCount: 1 });
  const session = { withExclusive: (task) => task(model.host) };
  const snapshots = new SnapshotService(session, {
    store: new SnapshotStore({ now: () => 1000 }),
    now: () => 1000,
  });
  const page = await snapshots.snapshot({
    scope: { kind: "project" },
    include: ["structure", "processing"],
    pageSize: 1,
  });

  assert.equal(page.data.tracks[0].groups[0].processing.state, "ready");
  assert.equal(page.data.tracks[0].groups[0].processing.expectedNotes, 1);
});

test("group snapshot processing include returns an explicit readiness summary", async () => {
  const model = createSynthModel();
  const session = { withExclusive: (task) => task(model.host) };
  const snapshots = new SnapshotService(session, {
    store: new SnapshotStore({ now: () => 1000 }),
    now: () => 1000,
  });
  const snapshot = await snapshots.snapshot({
    scope: { kind: "group", trackIndex: 0, groupIndex: 0 },
    include: ["structure", "processing"],
  });

  assert.equal(snapshot.data.processing.state, "ready");
  assert.equal(snapshot.data.processing.computedItems, 2);
  assert.deepEqual(snapshot.data.tracks[0].groups[0].processing, snapshot.data.processing);
});

test("empty selection processing does not report the current group's note count", async () => {
  const model = createSynthModel();
  model.selectedNotes = [];
  const session = { withExclusive: (task) => task(model.host) };
  const snapshots = new SnapshotService(session, {
    store: new SnapshotStore({ now: () => 1000 }),
    now: () => 1000,
  });
  const snapshot = await snapshots.snapshot({ scope: { kind: "selection" } });

  assert.equal(snapshot.status, "no_change");
  assert.equal(snapshot.data.notes.length, 0);
  assert.equal(snapshot.data.processing.state, "not_applicable");
  assert.equal(snapshot.data.processing.expectedNotes, 0);
  assert.equal(snapshot.data.processing.computedItems, 0);
});

function createSynthModel() {
  const handles = {
    project: handle(1, "Project"),
    sv: handle(2, "SV"),
    mainEditor: handle(3, "MainEditorView"),
    track: handle(4, "Track"),
    groupReference: handle(5, "NoteGroupReference"),
    group: handle(6, "NoteGroup"),
    selection: handle(7, "TrackInnerSelectionState"),
    notes: [handle(8, "Note"), handle(9, "Note")],
  };
  const notes = [
    noteState(0, 0, 705600, 60, "a"),
    noteState(1, 705600, 705600, 62, "i"),
  ];
  const model = {
    handles,
    notes,
    selectedNotes: handles.notes,
    computedPhonemes: null,
    undoCount: 0,
    freed: [],
  };

  model.host = {
    epoch: () => 1,
    roots: async () => ({
      project: handles.project,
      sv: handles.sv,
      mainEditor: handles.mainEditor,
    }),
    free: async (value) => model.freed.push(value?.__handle__ ?? value),
    index: async () => null,
    call: async ({ handle: target, method, args = [] }) => {
      const id = target?.__handle__;
      if (id === handles.project.__handle__) {
        if (method === "newUndoRecord") return ++model.undoCount;
        if (method === "getTrack") return handles.track;
        if (method === "getNumTracks") return 1;
      }
      if (id === handles.mainEditor.__handle__) {
        if (method === "getCurrentTrack") return handles.track;
        if (method === "getCurrentGroup") return handles.groupReference;
        if (method === "getSelection") return handles.selection;
      }
      if (id === handles.selection.__handle__ && method === "getSelectedNotes") {
        return model.selectedNotes;
      }
      if (id === handles.track.__handle__) {
        if (method === "getIndexInParent") return 1;
        if (method === "getName") return "Main";
        if (method === "getNumGroups") return 1;
        if (method === "getGroupReference") return handles.groupReference;
      }
      if (id === handles.groupReference.__handle__) {
        if (method === "getIndexInParent") return 1;
        if (method === "getTarget") return handles.group;
        if (method === "isInstrumental") return false;
        if (method === "isMain") return true;
        if (method === "getOnset" || method === "getTimeOffset" || method === "getPitchOffset") return 0;
        if (method === "getVoice") return { paramTension: 0 };
      }
      if (id === handles.group.__handle__) {
        if (method === "getName") return "Main Group";
        if (method === "getUUID") return "group-1";
        if (method === "getNumNotes") return notes.length;
        if (method === "getNote") return handles.notes[args[0] - 1] ?? null;
      }
      const noteIndex = handles.notes.findIndex((note) => note.__handle__ === id);
      if (noteIndex >= 0) return callNote(notes[noteIndex], method, args);
      if (id === handles.sv.__handle__ && method === "getPhonemesForGroup") {
        return model.computedPhonemes ?? notes.map((note) => (note.lyrics ? `${note.lyrics}-phoneme` : ""));
      }
      throw new Error(`unsupported call ${id}.${method}`);
    },
  };
  return model;
}

function createProjectTraversalModel(groupCount, noteCount = 0) {
  const project = handle(100, "Project");
  const sv = handle(101, "SV");
  const track = handle(102, "Track");
  const groupReferences = Array.from({ length: groupCount }, (_, index) =>
    handle(200 + index, "NoteGroupReference")
  );
  const groups = Array.from({ length: groupCount }, (_, index) =>
    handle(300 + index, "NoteGroup")
  );
  const noteCounts = Array.isArray(noteCount)
    ? noteCount
    : Array.from({ length: groupCount }, () => noteCount);
  let nextNoteHandle = 400;
  const notes = noteCounts.map((count) =>
    Array.from({ length: count }, () => handle(nextNoteHandle++, "Note"))
  );
  const model = { hostCalls: 0 };
  model.host = {
    epoch: () => 1,
    roots: async () => ({ project, sv }),
    free: async () => {},
    index: async () => null,
    call: async ({ handle: target, method, args = [] }) => {
      model.hostCalls += 1;
      const id = target?.__handle__;
      if (id === project.__handle__) {
        if (method === "getNumTracks") return 1;
        if (method === "getTrack") return track;
      }
      if (id === track.__handle__) {
        if (method === "getName") return "Large Project";
        if (method === "getNumGroups") return groupCount;
        if (method === "getGroupReference") return groupReferences[args[0] - 1];
      }
      const referenceIndex = groupReferences.findIndex((value) => value.__handle__ === id);
      if (referenceIndex >= 0) {
        if (method === "isInstrumental") return false;
        if (method === "isMain") return referenceIndex === 0;
        if (method === "getOnset") return referenceIndex * 705600;
        if (method === "getTimeOffset" || method === "getPitchOffset") return 0;
        if (method === "getTarget") return groups[referenceIndex];
        if (method === "getVoice") return { paramTension: 0 };
      }
      const groupIndex = groups.findIndex((value) => value.__handle__ === id);
      if (groupIndex >= 0) {
        if (method === "getName") return `Group ${groupIndex + 1}`;
        if (method === "getUUID") return `group-${groupIndex + 1}`;
        if (method === "getNumNotes") return noteCounts[groupIndex];
        if (method === "getNote") return notes[groupIndex][args[0] - 1];
      }
      const noteLocation = notes
        .map((groupNotes, groupIndex) => ({
          groupIndex,
          noteIndex: groupNotes.findIndex((value) => value.__handle__ === id),
        }))
        .find((location) => location.noteIndex >= 0);
      if (noteLocation) {
        const { noteIndex } = noteLocation;
        if (method === "getIndexInParent") return noteIndex + 1;
        if (method === "getOnset") return noteIndex * 705600;
        if (method === "getDuration") return 705600;
        if (method === "getPitch") return 60 + (noteIndex % 12);
        if (method === "getLyrics") return `lyric-${noteIndex + 1}`;
        if (method === "getPhonemes" || method === "getLanguageOverride") return "";
        if (method === "getDetune") return 0;
      }
      if (id === sv.__handle__ && method === "getPhonemesForGroup") {
        const referenceIndex = groupReferences.findIndex(
          (value) => value.__handle__ === args[0]?.__handle__
        );
        return Array.from({ length: noteCounts[referenceIndex] ?? 0 }, (_, index) => `p-${index + 1}`);
      }
      throw new Error(`unsupported project traversal call ${id}.${method}`);
    },
  };
  return model;
}

function createLifecycleProjectModel(trackGroupCounts, { noteCount = 0 } = {}) {
  let nextHandle = 500;
  const allocate = (type) => handle(nextHandle++, type);
  const project = allocate("Project");
  const sv = allocate("SV");
  const tracks = trackGroupCounts.map(() => allocate("Track"));
  const references = trackGroupCounts.map((count) =>
    Array.from({ length: count }, () => allocate("NoteGroupReference"))
  );
  const groups = trackGroupCounts.map((count) =>
    Array.from({ length: count }, () => allocate("NoteGroup"))
  );
  const freed = new Set();
  const ensureLive = (target) => {
    if (freed.has(target?.__handle__)) {
      throw new Error(`unknown handle: ${target.__handle__}`);
    }
  };
  const model = {};
  model.host = {
    epoch: () => 1,
    roots: async () => ({ project, sv }),
    free: async (value) => {
      freed.add(value?.__handle__ ?? value);
    },
    index: async () => null,
    call: async ({ handle: target, method, args = [] }) => {
      ensureLive(target);
      const id = target?.__handle__;
      if (id === project.__handle__) {
        if (method === "getNumTracks") return tracks.length;
        if (method === "getTrack") return tracks[args[0] - 1];
      }
      const trackIndex = tracks.findIndex((value) => value.__handle__ === id);
      if (trackIndex >= 0) {
        if (method === "getName") return `Track ${trackIndex + 1}`;
        if (method === "getNumGroups") return trackGroupCounts[trackIndex];
        if (method === "getGroupReference") return references[trackIndex][args[0] - 1];
      }
      for (let currentTrack = 0; currentTrack < references.length; currentTrack += 1) {
        const groupIndex = references[currentTrack].findIndex((value) => value.__handle__ === id);
        if (groupIndex >= 0) {
          if (method === "isInstrumental") return false;
          if (method === "isMain") return groupIndex === 0;
          if (method === "getOnset") return groupIndex * 705600;
          if (method === "getTimeOffset" || method === "getPitchOffset") return 0;
          if (method === "getTarget") return groups[currentTrack][groupIndex];
        }
      }
      for (let currentTrack = 0; currentTrack < groups.length; currentTrack += 1) {
        const groupIndex = groups[currentTrack].findIndex((value) => value.__handle__ === id);
        if (groupIndex >= 0) {
          if (method === "getName") return `Group ${currentTrack + 1}-${groupIndex + 1}`;
          if (method === "getUUID") return `group-${currentTrack + 1}-${groupIndex + 1}`;
          if (method === "getNumNotes") return noteCount;
        }
      }
      if (id === sv.__handle__ && method === "getPhonemesForGroup") {
        return Array.from({ length: noteCount }, () => "a");
      }
      throw new Error(`unsupported lifecycle call ${id}.${method}`);
    },
  };
  return model;
}

function callNote(note, method, args) {
  const getters = {
    getIndexInParent: note.index + 1,
    getOnset: note.onset,
    getDuration: note.duration,
    getPitch: note.pitch,
    getLyrics: note.lyrics,
    getPhonemes: note.phonemes,
    getLanguageOverride: note.language,
    getDetune: note.detune,
  };
  if (Object.hasOwn(getters, method)) return getters[method];
  if (method === "setLyrics") note.lyrics = args[0];
  else if (method === "setPhonemes") note.phonemes = args[0];
  else if (method === "setLanguageOverride") note.language = args[0];
  else throw new Error(`unsupported note method ${method}`);
  return null;
}

function noteState(index, onset, duration, pitch, lyrics) {
  return { index, onset, duration, pitch, lyrics, phonemes: "", language: "", detune: 0 };
}

function handle(id, type) {
  return { __handle__: id, __type__: type, __epoch__: 1 };
}

test("HostSession rejects epoch-less handles after any reconnect", async () => {
  class FakeBridge extends EventEmitter {
    getStatus() {
      return { state: "listening", epoch: 0 };
    }

    async call(command) {
      if (command.op === "root") return { project: { __handle__: 1, __type__: "Project" } };
      if (command.op === "call" && command.method === "getHostInfo") {
        return { hostVersion: "2.2.1" };
      }
      if (command.op === "call" && command.method === "getFileName") return "test.svp";
      throw new Error(`unsupported command: ${command.op}.${command.method ?? ""}`);
    }
  }

  const bridge = new FakeBridge();
  const session = new HostSession(bridge, { logger: { error() {} } });
  bridge.emit("attach", { epoch: 1 });
  const roots = await session.roots();
  // 重连前只有一个 epoch，裸 handle 无歧义，仍然放行。
  assert.equal(
    await session.call({ handle: roots.project.__handle__, method: "getFileName", args: [] }),
    "test.svp"
  );

  bridge.emit("attach", { epoch: 2 });
  const fresh = await session.roots();
  // 重连后新桥会把低位 id 重新分配给别的对象；无 __epoch__ 的 handle 无法自证来源，
  // 必须整体拒绝，否则会静默操作错对象。
  await assert.rejects(
    session.call({ handle: 1, method: "getFileName", args: [] }),
    (error) => error.code === "STALE_HANDLE"
  );
  await assert.rejects(
    session.call({ handle: { __handle__: 1 }, method: "getFileName", args: [] }),
    (error) => error.code === "STALE_HANDLE"
  );
  // 服务器返回的完整 handle（带当前 __epoch__）照常工作。
  assert.equal(
    await session.call({ handle: fresh.project, method: "getFileName", args: [] }),
    "test.svp"
  );
});

test("typed-v2 decoding caps aggregate declared array allocation", () => {
  // 单帧 ≤64KiB，但多个兄弟 length 声明可把分配放大到 GB；聚合预算必须拦截。
  const bomb = {
    $sv: "array",
    length: 3,
    entries: [
      [0, { $sv: "sparse-array", length: 600_000, entries: [] }],
      [1, { $sv: "sparse-array", length: 600_000, entries: [] }],
      [2, { $sv: "sparse-array", length: 600_000, entries: [] }],
    ],
  };
  assert.throws(() => decodeWireValue(bomb), /aggregate array slots/);
  // 单个满额数组仍可解码（getComputedPitchForGroup 的 resultLength 用例）。
  const single = decodeWireValue({ $sv: "sparse-array", length: 1_000_000, entries: [[0, 1]] });
  assert.equal(single.length, 1_000_000);
  assert.equal(single[0], 1);
});

test("project pagination retries the same page without losing items after a transient failure", async () => {
  const model = createProjectTraversalModel(30);
  // 第 2 页中途注入一次 HOST_TIMEOUT——不改 epoch 的瞬时错误，正是会绕过
  // 所有 epoch 校验、直接考验游标提交纪律的那一类。
  const originalCall = model.host.call;
  let injected = false;
  model.host.call = async (request) => {
    if (!injected && request.method === "getGroupReference" && request.args[0] === 26) {
      injected = true;
      const error = new Error("Timeout waiting for SynthV bridge");
      error.code = "HOST_TIMEOUT";
      throw error;
    }
    return originalCall(request);
  };
  const session = { withExclusive: (task) => task(model.host) };
  const snapshots = new SnapshotService(session, {
    store: new SnapshotStore({ now: () => 1000 }),
    now: () => 1000,
  });

  const first = await snapshots.snapshot({
    scope: { kind: "project" },
    include: ["structure"],
    pageSize: 50,
  });
  assert.equal(first.page.count, 16);
  // 单轨跨页：显式分片标记，调用方必须按 index 合并同一轨的跨页分组。
  assert.equal(first.data.tracks[0].continuesOnNextPage, true);
  assert.equal(first.data.tracks[0].fragment, true);

  const cursor = first.page.nextCursor;
  await assert.rejects(
    snapshots.snapshot({ cursor, pageSize: 50 }),
    (error) => error.code === "HOST_TIMEOUT"
  );
  // 同一 cursor 重试：必须从本页页首完整重读；旧实现会从已推进的索引续读，
  // 静默丢掉 16-24 号组并仍报 snapshotComplete。
  const second = await snapshots.snapshot({ cursor, pageSize: 50 });
  assert.equal(second.page.count, 14);
  assert.equal(second.data.snapshotComplete, true);
  assert.equal(second.data.tracks[0].continuedFromPreviousPage, true);
  const groupIndices = [...first.data.tracks, ...second.data.tracks]
    .flatMap((track) => track.groups.map((group) => group.index))
    .sort((a, b) => a - b);
  assert.deepEqual(groupIndices, Array.from({ length: 30 }, (_, index) => index));
});

test("sv_set_lyrics keeps verified success when post-commit processing observation fails", async () => {
  const model = createSynthModel();
  const session = { withExclusive: (task) => task(model.host) };
  const snapshots = new SnapshotService(session, {
    store: new SnapshotStore({ now: () => 1000 }),
    now: () => 1000,
  });
  const lyrics = new LyricsService(session, snapshots, { sleepFn: async () => {}, now: () => 1000 });
  const snapshot = await snapshots.snapshot({ scope: { kind: "selection" } });

  const originalCall = model.host.call;
  model.host.call = async (request) => {
    if (request.method === "getPhonemesForGroup") {
      const error = new Error("Timeout waiting for SynthV bridge");
      error.code = "HOST_TIMEOUT";
      throw error;
    }
    return originalCall(request);
  };
  const result = await lyrics.setLyrics({
    contextId: snapshot.contextId,
    lyrics: ["さ", "よ"],
    waitFor: "phonemes",
    timeoutMs: 100,
    pollIntervalMs: 20,
  });

  // 写入已提交并逐项读回验证；处理观测失败只降级 processing 子结果 + warning。
  assert.equal(result.ok, true);
  assert.equal(result.status, "succeeded");
  assert.equal(result.effects, "verified");
  assert.equal(result.verification.passed, true);
  assert.equal(result.data.processing.status, "observation_failed");
  assert.deepEqual(model.notes.map((note) => note.lyrics), ["さ", "よ"]);
  assert.equal(model.undoCount, 2);
  assert.equal(result.data.processing.error.code, "HOST_TIMEOUT");
  assert.ok(result.warnings.some((warning) => warning.code === "PROCESSING_OBSERVATION_FAILED"));
});

test("sv_wait_for_processing validates expectedNotes, frames, and observation bounds", async () => {
  const model = createSynthModel();
  const session = { withExclusive: (task) => task(model.host) };
  const snapshots = new SnapshotService(session, {
    store: new SnapshotStore({ now: () => 1000 }),
    now: () => 1000,
  });
  const processing = new ProcessingService(session, snapshots, {
    sleepFn: async () => {},
    now: () => 1000,
  });
  const snapshot = await snapshots.snapshot({
    scope: { kind: "group", trackIndex: 0, groupIndex: 0 },
    include: ["notes"],
  });

  await assert.rejects(
    processing.wait({ contextId: snapshot.contextId, kind: "phonemes", expectedNotes: 1_000_000 }),
    (error) => error.code === "INVALID_ARGUMENTS"
  );
  await assert.rejects(
    processing.wait({
      contextId: snapshot.contextId,
      kind: "computedPitch",
      startBlick: 0,
      intervalBlick: 1,
      frames: 2_001,
      minimumObservedFrames: 1,
    }),
    (error) => error.code === "INVALID_ARGUMENTS"
  );
  await assert.rejects(
    processing.wait({
      contextId: snapshot.contextId,
      kind: "computedPitch",
      startBlick: 0,
      intervalBlick: 1,
      frames: 4,
      minimumObservedFrames: 0,
    }),
    (error) => error.code === "INVALID_ARGUMENTS"
  );
  await assert.rejects(
    processing.wait({
      contextId: snapshot.contextId,
      kind: "computedPitch",
      startBlick: 0,
      intervalBlick: 1,
      frames: 4,
      minimumObservedFrames: 8,
    }),
    (error) => error.code === "INVALID_ARGUMENTS"
  );
});
