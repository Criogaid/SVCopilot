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

function parseToolError(response) {
  assert.equal(response.isError, true);
  const text = response.content?.find((item) => item.type === "text")?.text;
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
  const callSchema = listed.tools.find((tool) => tool.name === "sv_call")?.inputSchema;
  assert.ok(callSchema.properties.args.items.anyOf.some((item) => item.type === "number"));
  assert.ok(callSchema.properties.args.items.anyOf.some((item) => item.type === "object"));
  const runTool = listed.tools.find((tool) => tool.name === "sv_run");
  assert.match(runTool.description, /#\/steps\/track\/result/);
  assert.match(runTool.inputSchema.properties.steps.items.properties.target.description, /#\/roots\/project/);
  assert.ok(runTool.inputSchema.properties.steps.items.properties.verifiesStep);
  const waitTool = listed.tools.find((tool) => tool.name === "sv_wait_for_processing");
  const setLyricsTool = listed.tools.find((tool) => tool.name === "sv_set_lyrics");
  assert.equal(waitTool.inputSchema.properties.requireNonEmpty.default, false);
  assert.equal(setLyricsTool.inputSchema.properties.requireNonEmptyPhonemes.default, false);

  const resources = await client.listResources();
  assert.ok(resources.resources.some((resource) => resource.uri === "svapi://manifest"));
  assert.ok(resources.resources.some((resource) => resource.uri === "svcopilot://capabilities"));
  const manifest = parseResource(await client.readResource({ uri: "svapi://manifest" }));
  assert.ok(manifest.summary.methodOverloadCount >= 200);
  const capabilities = parseResource(
    await client.readResource({ uri: "svcopilot://capabilities" })
  );
  assert.equal(capabilities.interfaces.typedResultFormat, "typed-v2");
  assert.equal(capabilities.limits.projectPageUnit, "traversalItems");
  assert.equal(capabilities.knownLimits.singer.installedCatalogObservable, false);
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

  const workflow = parseToolResult(
    await client.callTool({
      name: "sv_run",
      arguments: {
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
            id: "name",
            op: "call",
            target: { $ref: "#/steps/track/result" },
            method: "getName",
            expect: { operator: "equals", value: "Pipe Vocal" },
            return: true,
          },
        ],
        exports: { name: { $ref: "#/steps/name/result" } },
      },
    })
  );
  assert.equal(workflow.ok, true);
  assert.equal(workflow.exports.name, "Pipe Vocal");

  const projectPage = parseToolResult(
    await client.callTool({
      name: "sv_snapshot",
      arguments: {
        scope: { kind: "project" },
        include: ["structure", "processing"],
        pageSize: 3,
      },
    })
  );
  assert.equal(projectPage.data.tracks.length, 3);
  assert.equal(projectPage.data.tracks.flatMap((track) => track.groups).length, 3);
  assert.equal(projectPage.data.tracks[2].groups[0].processing.state, "ready");
  assert.equal(projectPage.page.unit, "traversalItems");
  assert.equal(projectPage.page.count, 3);
  assert.deepEqual(projectPage.page.returned, { tracks: 3, groups: 3, notes: 0 });
  assert.equal(projectPage.page.truncated, false);
  assert.equal(projectPage.data.snapshotComplete, true);

  const groupProcessing = parseToolResult(
    await client.callTool({
      name: "sv_snapshot",
      arguments: {
        scope: { kind: "group", trackIndex: 0, groupIndex: 0 },
        include: ["structure", "processing"],
      },
    })
  );
  assert.equal(groupProcessing.data.processing.state, "ready");
  assert.equal(groupProcessing.data.processing.computedItems, 2);

  const selectionSnapshot = parseToolResult(
    await client.callTool({
      name: "sv_snapshot",
      arguments: { scope: { kind: "selection" } },
    })
  );
  assert.equal(selectionSnapshot.status, "succeeded");
  assert.deepEqual(
    selectionSnapshot.data.notes.map((note) => note.lyrics),
    ["a", "i"]
  );
  assert.equal(selectionSnapshot.data.capabilities.singerIdentity, "unobservable");

  const lyricEdit = parseToolResult(
    await client.callTool({
      name: "sv_set_lyrics",
      arguments: {
        contextId: selectionSnapshot.contextId,
        lyrics: ["さ", "よ"],
        waitFor: "phonemes",
        timeoutMs: 1000,
      },
    })
  );
  assert.equal(lyricEdit.ok, true);
  assert.equal(lyricEdit.effects, "verified");
  assert.equal(lyricEdit.data.processedNotes, 2);
  assert.equal(lyricEdit.data.actuallyChangedNotes, 2);
  assert.equal(lyricEdit.data.processing.state, "ready");
  assert.equal(lyricEdit.data.processing.evidence.expectedNotes, 2);
  assert.deepEqual(lyricEdit.verification.evidence.observedLyrics, ["さ", "よ"]);
  assert.equal(lyricEdit.undo.boundaryCallsCompleted, 2);

  const editedSnapshot = parseToolResult(
    await client.callTool({
      name: "sv_snapshot",
      arguments: { scope: { kind: "selection" }, include: ["notes"] },
    })
  );
  assert.deepEqual(
    editedSnapshot.data.notes.map((note) => note.lyrics),
    ["さ", "よ"]
  );

  const verifiedWrite = parseToolResult(
    await client.callTool({
      name: "sv_run",
      arguments: {
        mode: "write",
        steps: [
          { id: "track", op: "call", target: { $ref: "#/roots/project" }, method: "getTrack", args: [1] },
          { id: "group", op: "call", target: { $ref: "#/steps/track/result" }, method: "getGroupReference", args: [1] },
          { id: "target", op: "call", target: { $ref: "#/steps/group/result" }, method: "getTarget" },
          { id: "note", op: "call", target: { $ref: "#/steps/target/result" }, method: "getNote", args: [1] },
          { id: "write", op: "call", target: { $ref: "#/steps/note/result" }, method: "setLyrics", args: ["verified"] },
          { id: "verify", op: "call", target: { $ref: "#/steps/note/result" }, method: "getLyrics", expect: { operator: "equals", value: "verified" }, verifiesStep: "write" },
          { id: "restore", op: "call", target: { $ref: "#/steps/note/result" }, method: "setLyrics", args: ["さ"] },
          { id: "verifyRestore", op: "call", target: { $ref: "#/steps/note/result" }, method: "getLyrics", expect: { operator: "equals", value: "さ" }, verifiesStep: "restore" },
        ],
      },
    })
  );
  assert.equal(verifiedWrite.ok, true);
  assert.equal(verifiedWrite.effects, "verified");
  assert.ok(!verifiedWrite.warnings.some((warning) => warning.code === "UNVERIFIED_WRITE"));

  // sv_patch_notes 公开契约：dry-run 无副作用，真实写入带补偿语义与逐项读回。
  const patchTool = listed.tools.find((tool) => tool.name === "sv_patch_notes");
  assert.ok(patchTool, "sv_patch_notes must be listed");
  assert.equal(patchTool.inputSchema.properties.atomic.default, true);
  assert.equal(patchTool.inputSchema.properties.dryRun.default, false);
  assert.ok(patchTool.inputSchema.properties.patches.items.properties.set.properties.detuneCents);

  const patchSnapshot = parseToolResult(
    await client.callTool({
      name: "sv_snapshot",
      arguments: { scope: { kind: "selection" } },
    })
  );
  const patchTargetId = patchSnapshot.data.notes[0].id;
  const patchArguments = {
    contextId: patchSnapshot.contextId,
    patches: [
      {
        noteId: patchTargetId,
        expected: { lyrics: "さ" },
        set: { lyrics: "ら", pitch: 61, detuneCents: -8 },
      },
    ],
    waitFor: "phonemes",
    timeoutMs: 1000,
  };
  const patchPlan = parseToolResult(
    await client.callTool({
      name: "sv_patch_notes",
      arguments: { ...patchArguments, dryRun: true },
    })
  );
  assert.equal(patchPlan.ok, true);
  assert.equal(patchPlan.status, "dry_run");
  assert.equal(patchPlan.effects, "none");
  assert.equal(patchPlan.data.plannedDiff.length, 3);
  assert.equal(patchPlan.data.plannedChangedNotes, 1);

  const patchApplied = parseToolResult(
    await client.callTool({ name: "sv_patch_notes", arguments: patchArguments })
  );
  assert.equal(patchApplied.ok, true);
  assert.equal(patchApplied.status, "succeeded");
  assert.equal(patchApplied.effects, "verified");
  assert.equal(patchApplied.atomicity, "verified_compensation");
  assert.equal(patchApplied.rollback.attempted, false);
  assert.equal(patchApplied.data.actuallyChangedNotes, 1);
  assert.equal(patchApplied.undo.boundaryCallsCompleted, 2);
  assert.equal(patchApplied.verification.passed, true);
  assert.equal(patchApplied.verification.evidence.observed[patchTargetId].lyrics, "ら");
  assert.equal(patchApplied.verification.evidence.observed[patchTargetId].detuneCents, -8);
  assert.equal(patchApplied.data.processing.state, "ready");

  const patchedSnapshot = parseToolResult(
    await client.callTool({
      name: "sv_snapshot",
      arguments: { scope: { kind: "selection" }, include: ["notes"] },
    })
  );
  assert.deepEqual(
    patchedSnapshot.data.notes.map((note) => [note.lyrics, note.pitch, note.detuneCents]),
    [
      ["ら", 61, -8],
      ["よ", 62, 0],
    ]
  );

  const patchConflict = parseToolError(
    await client.callTool({
      name: "sv_patch_notes",
      arguments: {
        contextId: patchedSnapshot.contextId,
        patches: [
          { noteId: patchedSnapshot.data.notes[0].id, expected: { lyrics: "さ" }, set: { lyrics: "x" } },
        ],
      },
    })
  );
  assert.equal(patchConflict.ok, false);
  assert.equal(patchConflict.error.code, "EXPECTED_MISMATCH");
  assert.equal(patchConflict.effects, "none");

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

  parseToolResult(
    await client.callTool({ name: "sv_free", arguments: { handle: note.__handle__ } })
  );
  const released = parseToolError(
    await client.callTool({
      name: "sv_call",
      arguments: { handle: note.__handle__, method: "getDetune", args: [] },
    })
  );
  assert.equal(released.error.code, "UNKNOWN_HANDLE");

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
  assert.equal(parseToolError(methodDeferred).error.code, "UNKNOWN_METHOD");

  const unknownField = parseToolError(
    await client.callTool({ name: "sv_index", arguments: { field: "MISSING" } })
  );
  assert.equal(unknownField.error.code, "UNKNOWN_FIELD");

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
