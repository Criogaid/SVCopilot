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
