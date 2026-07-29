import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PipeRelay } from "../server/src/transport-pipe.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const productDir = path.resolve(testDir, "..", "..");
const luaBin =
  process.env.LUA_BIN ||
  path.join(productDir, "scripts", "SynthVCopilotResearch", "unsafe-experiment", "lua.exe");
const bridgeScript = path.join(
  productDir,
  "scripts",
  "SynthVCopilotResearch",
  "copilot",
  "sv-scripts",
  "StartSynthVCopilot.lua"
);
const stopScript = path.join(
  productDir,
  "scripts",
  "SynthVCopilotResearch",
  "copilot",
  "sv-scripts",
  "StopSynthVCopilot.lua"
);
const harnessScript = path.join(testDir, "pipe_bridge_harness.lua");
const stopHarnessScript = path.join(testDir, "stop_bridge_harness.lua");

function handleOf(value) {
  assert.equal(typeof value?.__handle__, "number");
  return value.__handle__;
}

function waitForExit(child, timeoutMs = 2000) {
  if (child.exitCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Lua bridge did not exit")), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

test("real Lua bridge dispatches SV calls over Windows IO PIPE", { timeout: 10000 }, async (t) => {
  if (!existsSync(luaBin)) {
    t.skip(`Lua interpreter not found: ${luaBin}`);
    return;
  }

  const session = `e2e-${process.pid}-${Date.now()}`;
  const relay = new PipeRelay({ session, timeoutMs: 3000 });
  await relay.init();

  const child = spawn(luaBin, [harnessScript, bridgeScript], {
    env: { ...process.env, SV_COPILOT_SESSION: session },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));

  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await relay.close();
  });

  assert.equal(await relay.call({ op: "ping" }), "pong");
  const roots = await relay.call({ op: "root" });
  const projectHandle = handleOf(roots.project);

  assert.equal(
    await relay.call({ op: "call", handle: projectHandle, method: "getFileName", args: [] }),
    "PipeProject"
  );
  assert.equal(await relay.call({ op: "index", field: "QUARTER" }), 705600000);
  assert.deepEqual(
    await relay.call({ op: "call", handle: projectHandle, method: "getStruct", args: [] }),
    { bpm: 160, position: 0 }
  );
  assert.deepEqual(
    await relay.call({
      op: "call",
      handle: projectHandle,
      method: "getEmpty",
      args: [],
      resultFormat: "typed-v2",
      resultShape: "array",
      resultLength: 0,
    }),
    { $sv: "array", length: 0, entries: {} }
  );
  const sparse = await relay.call({
    op: "call",
    handle: projectHandle,
    method: "getSparse",
    args: [],
    resultFormat: "typed-v2",
    resultShape: "array",
    resultLength: 4,
  });
  assert.equal(sparse.$sv, "sparse-array");
  assert.equal(sparse.length, 4);

  const note = await relay.call({ op: "call", method: "create", args: ["Note"] });
  await relay.call({ op: "call", method: "boxSet", args: [note] });
  const roundTripped = await relay.call({ op: "call", method: "boxGet", args: [] });
  assert.equal(
    await relay.call({
      op: "call",
      handle: handleOf(roundTripped),
      method: "getType",
      args: [],
    }),
    "Note"
  );

  await assert.rejects(
    relay.call({ op: "call", handle: projectHandle, method: "noSuchMethod", args: [] }),
    /no such method/
  );

  // 能力协商必须来自真实桥的 hello，而不是测试里手写的帧。
  assert.equal(relay.supportsOp("read_note_fingerprints_v1"), true);
  assert.equal(relay.supportsOp("read_note_fingerprints_v2"), false);
  assert.deepEqual(relay.getStatus().hostOps, ["read_note_fingerprints_v1"]);

  const bulkFields = [
    "indexInGroup",
    "onsetBlick",
    "durationBlick",
    "pitch",
    "lyrics",
    "phonemesOverride",
    "languageOverride",
    "detuneCents",
  ];
  const bulk = await relay.call({
    op: "read_note_fingerprints_v1",
    trackIndex: 0,
    groupReferenceIndex: 0,
    expectedGroupUuid: "pipe-group-1",
    noteIndicesInGroup: [0, 1],
    fields: bulkFields,
    resultFormat: "typed-v2",
  });
  assert.equal(bulk.groupUuid, "pipe-group-1");
  assert.equal(bulk.noteCount, 2);
  assert.deepEqual(
    Object.values(bulk.items).map((item) => item.noteIndexInGroup),
    [0, 1]
  );
  // 0-based 契约要跨真实管道成立：宿主的 native index 1/2 必须回到 0/1。
  assert.deepEqual(
    Object.values(bulk.items).map((item) => item.fingerprint.indexInGroup),
    [0, 1]
  );
  assert.deepEqual(
    Object.values(bulk.items).map((item) => item.fingerprint.lyrics),
    ["a", "i"]
  );
  assert.equal(Object.values(bulk.items)[1].fingerprint.pitch, 62);
  // 批量结果永远不含 handle，也不应在宿主留下可释放对象。
  assert.equal(JSON.stringify(bulk).includes("__handle__"), false);

  // 逐字段读取同一音符必须与批量结果一致（同一根管道、同一宿主状态）。
  const groupReference = await relay.call({
    op: "call",
    handle: handleOf(
      await relay.call({ op: "call", handle: projectHandle, method: "getTrack", args: [1] })
    ),
    method: "getGroupReference",
    args: [1],
  });
  const target = await relay.call({
    op: "call",
    handle: handleOf(groupReference),
    method: "getTarget",
    args: [],
  });
  const firstNote = await relay.call({
    op: "call",
    handle: handleOf(target),
    method: "getNote",
    args: [1],
  });
  assert.equal(
    await relay.call({
      op: "call",
      handle: handleOf(firstNote),
      method: "getLyrics",
      args: [],
    }),
    Object.values(bulk.items)[0].fingerprint.lyrics
  );

  await assert.rejects(
    relay.call({
      op: "read_note_fingerprints_v1",
      trackIndex: 0,
      groupReferenceIndex: 0,
      expectedGroupUuid: "stale-uuid",
      noteIndicesInGroup: [0],
      fields: ["pitch"],
      resultFormat: "typed-v2",
    }),
    /STALE_GROUP_UUID/
  );
  await assert.rejects(
    relay.call({
      op: "read_note_fingerprints_v1",
      trackIndex: 0,
      groupReferenceIndex: 0,
      noteIndicesInGroup: [7],
      fields: ["pitch"],
      resultFormat: "typed-v2",
    }),
    /note index out of range/
  );
  // 结构化拒绝之后锁步必须仍然存活：桥没被拖死，后续命令照常返回。
  assert.equal(await relay.call({ op: "ping" }), "pong");

  const stopChild = spawn(luaBin, [stopHarnessScript, stopScript], {
    env: { ...process.env, SV_COPILOT_SESSION: session },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stopExit = await waitForExit(stopChild);
  assert.equal(stopExit.code, 0);
  const exit = await waitForExit(child);
  assert.equal(exit.code, 0, `Lua failed\nstdout: ${stdout}\nstderr: ${stderr}`);
});
