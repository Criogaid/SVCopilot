// 临时基准：真实 Lua 桥上 200 次顺序 ping，统计 result 帧后的回包类型。
// 每一次 "result→noop" 在真实 SynthV 宿主中等价于一次 20ms 空闲轮询等待。
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PipeRelay } from "../server/src/transport-pipe.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const productDir = path.resolve(testDir, "..", "..");
const luaBin = path.join(
  productDir,
  "scripts",
  "SynthVCopilotResearch",
  "unsafe-experiment",
  "lua.exe"
);
const bridgeScript = path.join(
  productDir,
  "scripts",
  "SynthVCopilotResearch",
  "copilot",
  "sv-scripts",
  "StartSynthVCopilot.lua"
);
const harnessScript = path.join(testDir, "pipe_bridge_harness.lua");

if (!existsSync(luaBin)) {
  console.error("lua.exe not found");
  process.exit(1);
}

const session = `bench-${process.pid}-${Date.now()}`;
const relay = new PipeRelay({ session, timeoutMs: 3000 });
let child = null;
let childDone = null;

try {
  await relay.init();

  let resultNoop = 0;
  let resultCommand = 0;
  let lastFrameWasResult = false;
  const origOnFrame = relay._onFrame.bind(relay);
  relay._onFrame = (line) => {
    try {
      lastFrameWasResult = JSON.parse(line)?.type === "result";
    } catch {
      lastFrameWasResult = false;
    }
    origOnFrame(line);
  };
  const origSendReply = relay._sendReply.bind(relay);
  relay._sendReply = (frame) => {
    if (lastFrameWasResult) {
      if (frame.type === "noop") resultNoop += 1;
      else if (frame.type === "command") resultCommand += 1;
      lastFrameWasResult = false;
    }
    origSendReply(frame);
  };

  child = spawn(luaBin, [harnessScript, bridgeScript], {
    env: { ...process.env, SV_COPILOT_SESSION: session },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  childDone = new Promise((resolve) => {
    child.once("exit", resolve);
    child.once("error", resolve);
  });

  const N = 200;
  const started = process.hrtime.bigint();
  for (let i = 0; i < N; i += 1) {
    await relay.call({ op: "ping" });
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  console.log(`sequential calls: ${N}`);
  console.log(`total: ${elapsedMs.toFixed(1)} ms, per call: ${(elapsedMs / N).toFixed(2)} ms`);
  console.log(`result->command (chained): ${resultCommand}`);
  console.log(`result->noop (would cost IDLE_MS in real host): ${resultNoop}`);
  console.log(
    `estimated real-host time before fix: ~${((elapsedMs + resultCommand * 20) / 1000).toFixed(2)} s; after fix: ~${((elapsedMs + resultNoop * 20) / 1000).toFixed(2)} s`
  );
} finally {
  if (child?.exitCode === null && child.signalCode === null && child.kill()) {
    await childDone;
  }
  await relay.close();
}
