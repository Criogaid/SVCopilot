import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { Client } from "../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const productDir = path.resolve(testDir, "..", "..");
const serverScript = path.join(productDir, "SVCopilot", "server", "src", "index.js");
const luaBin = path.join(
  productDir,
  "scripts",
  "SynthVCopilotResearch",
  "unsafe-experiment",
  "lua.exe"
);
const bridgeHarness = path.join(testDir, "pipe_bridge_harness.lua");
const bridgeScript = path.join(
  productDir,
  "scripts",
  "SynthVCopilotResearch",
  "copilot",
  "sv-scripts",
  "StartSynthVCopilot.lua"
);
const stopHarness = path.join(testDir, "stop_bridge_harness.lua");
const stopScript = path.join(
  productDir,
  "scripts",
  "SynthVCopilotResearch",
  "copilot",
  "sv-scripts",
  "StopSynthVCopilot.lua"
);

function parseToolResult(response) {
  const text = response.content?.find((item) => item.type === "text")?.text;
  if (response.isError) throw new Error(text || "MCP tool failed");
  assert.equal(typeof text, "string");
  return JSON.parse(text);
}

function parseResource(response) {
  const text = response.contents?.find((item) => "text" in item)?.text;
  assert.equal(typeof text, "string");
  return JSON.parse(text);
}

function waitForExit(child, timeoutMs = 3000) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`process ${child.pid} did not exit`)), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

const session = `mcp-client-${process.pid}-${Date.now()}`;
const childEnv = { ...process.env, SV_COPILOT_SESSION: session };
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverScript],
  env: childEnv,
  cwd: path.dirname(serverScript),
  stderr: "pipe",
});
const client = new Client({ name: "sv-copilot-smoke-client", version: "1.0.0" });
let bridge;

try {
  transport.stderr?.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));
  await client.connect(transport);
  console.log("[client] connected", client.getServerVersion());

  bridge = spawn(luaBin, [bridgeHarness, bridgeScript], {
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  const listed = await client.listTools();
  console.log("[client] tools", listed.tools.map((tool) => tool.name));
  assert.ok(listed.tools.some((tool) => tool.name === "sv_search_api"));
  assert.ok(listed.tools.some((tool) => tool.name === "sv_describe"));

  const resources = await client.listResources();
  assert.ok(resources.resources.some((resource) => resource.uri === "svapi://manifest"));
  const manifest = parseResource(await client.readResource({ uri: "svapi://manifest" }));
  assert.ok(manifest.summary.methodOverloadCount >= 200);
  const resourceTemplates = await client.listResourceTemplates();
  assert.ok(
    resourceTemplates.resourceTemplates.some(
      (template) => template.uriTemplate === "svapi://class/{class}"
    )
  );
  const apiClass = parseResource(await client.readResource({ uri: "svapi://class/Note" }));
  assert.equal(apiClass.class.name, "Note");

  const search = parseToolResult(
    await client.callTool({ name: "sv_search_api", arguments: { query: "setLyrics" } })
  );
  assert.ok(search.results.some((result) => result.className === "Note"));
  const description = parseToolResult(
    await client.callTool({
      name: "sv_describe",
      arguments: { class: "Automation", method: "remove" },
    })
  );
  assert.equal(description.overloads.length, 2);

  const ping = parseToolResult(await client.callTool({ name: "sv_ping", arguments: {} }));
  console.log("[client] sv_ping ->", ping);

  const roots = parseToolResult(await client.callTool({ name: "sv_root", arguments: {} }));
  const projectHandle = roots.project.__handle__;
  console.log("[client] sv_root.project ->", roots.project);
  assert.equal(roots.project.__type__, "Project");

  const note = parseToolResult(
    await client.callTool({ name: "sv_call", arguments: { method: "create", args: ["Note"] } })
  );
  assert.equal(note.__type__, "Note");
  // getDetune 在 manifest 里有版本门。预检现在把版本和方法存在性都交给权威宿主,
  // 于是调用被转发;harness 的 Note 没有 getDetune,所以拿到的是宿主自己的 "no such method"。
  const versionDeferred = await client.callTool({
    name: "sv_call",
    arguments: { handle: note.__handle__, method: "getDetune", args: [] },
  });
  assert.equal(versionDeferred.isError, true);
  assert.match(versionDeferred.content?.[0]?.text ?? "", /no such method/);

  const fileName = parseToolResult(
    await client.callTool({
      name: "sv_call",
      arguments: { handle: projectHandle, method: "getFileName", args: [] },
    })
  );
  console.log("[client] project:getFileName ->", fileName);

  const trackCount = parseToolResult(
    await client.callTool({
      name: "sv_call",
      arguments: { handle: projectHandle, method: "getNumTracks", args: [] },
    })
  );
  console.log("[client] project:getNumTracks ->", trackCount);

  const quarter = parseToolResult(
    await client.callTool({ name: "sv_index", arguments: { field: "QUARTER" } })
  );
  console.log("[client] SV.QUARTER ->", quarter);

  // setLyrics 不是 Project 的方法(不在 Project 的 manifest 条目里)。预检交给宿主,
  // 转发后由宿主报告 "no such method"。
  const methodDeferred = await client.callTool({
    name: "sv_call",
    arguments: { handle: projectHandle, method: "setLyrics", args: ["la"] },
  });
  assert.equal(methodDeferred.isError, true);
  assert.match(methodDeferred.content?.[0]?.text ?? "", /no such method/);

  assert.equal(ping, "pong");
  assert.equal(fileName, "PipeProject");
  assert.equal(trackCount, 3);
  assert.equal(quarter, 705600);

  const stop = spawn(luaBin, [stopHarness, stopScript], {
    env: childEnv,
    stdio: "ignore",
    windowsHide: true,
  });
  assert.equal(await waitForExit(stop), 0);
  assert.equal(await waitForExit(bridge), 0);
  console.log("[client] StopSynthVCopilot -> bridge exited cleanly");
  console.log("[client] smoke test passed");
} finally {
  if (bridge && bridge.exitCode === null) bridge.kill();
  await client.close().catch(() => {});
}
