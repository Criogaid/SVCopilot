// DevSVCopilotFileBridge.lua 的离线验收。
//
// 关键在于「反转」这件事本身能不能成立：脚本先加载、外部后连接。因此这里刻意先起
// Lua 侧、再写命令文件——顺序与正式管道路径相反，而这正是这个入口存在的理由。
//
// 被测的是真实 dispatcher：开发入口只换传输，因此 ping / root / call / index
// 都必须给出与管道路径一致的结果。
import "./helpers/pipe-namespace.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const productDir = path.resolve(testDir, "..", "..");
const luaBin =
  process.env.LUA_BIN ||
  path.join(productDir, "scripts", "SynthVCopilotResearch", "unsafe-experiment", "lua.exe");
const devScript = path.join(
  productDir,
  "scripts",
  "SynthVCopilotResearch",
  "copilot",
  "sv-scripts",
  "DevSVCopilotFileBridge.lua"
);
const harness = path.join(testDir, "dev_file_bridge_harness.lua");

function readJson(file) {
  try {
    const text = fs.readFileSync(file, "utf8");
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

// 原子写：Lua 侧随时可能打开命令文件，就地覆写会让它读到半个 JSON。
//
// rename 需要重试：Windows 上目标文件被打开时 rename 报 EPERM，而 Lua 侧每 20ms
// 就会打开一次 command.json。这不是错误状态，退避重试即可——这也是任何调用方
// （包括将来的 MCP 开发客户端）都必须实现的行为，因此写在这里当作参考实现。
function writeCommand(dir, command) {
  const target = path.join(dir, "command.json");
  const tmp = `${target}.node-tmp`;
  fs.writeFileSync(tmp, JSON.stringify(command), "utf8");
  const deadline = Date.now() + 4000;
  for (;;) {
    try {
      fs.renameSync(tmp, target);
      return;
    } catch (error) {
      if (error.code !== "EPERM" && error.code !== "EBUSY") throw error;
      if (Date.now() > deadline) throw error;
      // 20ms 轮询窗口，退避到下一个间隙。
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
}

async function awaitResponse(dir, id, { timeoutMs = 8000 } = {}) {
  const responseFile = path.join(dir, "response.json");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const payload = readJson(responseFile);
    if (payload && payload.id === id) return payload;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`no response for id ${id} within ${timeoutMs}ms`);
}

test("the dev entry lets the host start first and reuses the real dispatcher", async (t) => {
  if (!fs.existsSync(luaBin)) {
    t.skip(`Lua interpreter not found: ${luaBin}`);
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-copilot-dev-test-"));
  // 先启动 Lua 侧，此刻没有任何"服务器"存在——这正是管道路径做不到的。
  const child = spawn(luaBin, [harness, devScript, dir], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));

  t.after(() => {
    if (child.exitCode === null) child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // 心跳先出现：它是"脚本真的在跑"的唯一证据。
  const stateFile = path.join(dir, "state.json");
  const deadline = Date.now() + 8000;
  let state = null;
  while (Date.now() < deadline) {
    state = readJson(stateFile);
    if (state?.state === "listening") break;
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  assert.equal(
    state?.state,
    "listening",
    `dev bridge never reported listening. stdout=${stdout} stderr=${stderr}`
  );

  // ping 走真实 dispatcher。
  writeCommand(dir, { id: 1, op: "ping" });
  const pong = await awaitResponse(dir, 1);
  assert.equal(pong.ok, true);
  assert.equal(pong.result, "pong");

  // root + call：handle 表来自真实桥，因此这里能拿到 Project 并调它的方法。
  writeCommand(dir, { id: 2, op: "root" });
  const roots = await awaitResponse(dir, 2);
  assert.equal(roots.ok, true);
  const projectHandle = roots.result?.project?.__handle__;
  assert.equal(typeof projectHandle, "number", `root did not return a project handle: ${JSON.stringify(roots)}`);

  writeCommand(dir, { id: 3, op: "call", handle: projectHandle, method: "getFileName", args: [] });
  const fileName = await awaitResponse(dir, 3);
  assert.equal(fileName.ok, true);
  assert.equal(fileName.result, "DevProject");

  // index 读全局字段，验证 marshal 路径。
  writeCommand(dir, { id: 4, op: "index", field: "QUARTER" });
  const quarter = await awaitResponse(dir, 4);
  assert.equal(quarter.ok, true);
  assert.equal(quarter.result, 705600000);

  // 宿主错误必须如实透出 ok:false，而不是被传输层吞掉。
  writeCommand(dir, { id: 5, op: "call", handle: projectHandle, method: "noSuchMethod", args: [] });
  const failure = await awaitResponse(dir, 5);
  assert.equal(failure.ok, false);
  assert.match(String(failure.error), /no such method/);

  // 停止请求走桥自己的 shutdown 分支。
  writeCommand(dir, { id: 6, op: "__dev_stop__" });
  const stopped = await awaitResponse(dir, 6);
  assert.equal(stopped.ok, true);

  const exitCode = await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    child.once("exit", resolve);
  });
  assert.equal(exitCode, 0, `dev bridge exited non-zero. stdout=${stdout} stderr=${stderr}`);
});

test("the dev entry never opens a pipe and never reimplements the dispatcher", () => {
  // 这个入口的全部价值在于「不影响正式路径」。文档里当然会提到管道（说明它不碰
  // 什么），因此先剥掉注释，只检查代码：真正的风险是某行代码真的去打开了管道。
  const code = fs
    .readFileSync(devScript, "utf8")
    // Lua 块注释 --[[ ... ]] 与行注释 -- ...
    .replace(/--\[\[[\s\S]*?\]\]/g, "")
    .split("\n")
    .filter((line) => !/^\s*--/.test(line))
    .join("\n");
  assert.equal(
    code.includes("pipe"),
    false,
    "the dev entry must not reference a pipe in code; it only stubs io.open"
  );
  // 它必须复用真实桥，而不是自带一份 dispatch——两份实现一定会漂移，
  // 那时开发期观察到的行为就不再能说明正式路径的行为。
  assert.match(code, /loadfile\(bridgePath\)/);
  assert.equal(
    code.includes("read_note_fingerprints_v1"),
    false,
    "opcodes belong to the real bridge; the dev entry must not reimplement any"
  );
  // 目录必须与历史 file IPC 的 sv-copilot 区分，否则两者会互相读到对方的命令。
  assert.match(code, /sv-copilot-dev/);
});
