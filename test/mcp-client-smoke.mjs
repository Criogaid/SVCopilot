import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { Client } from "../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";

const Q = 705600000;
const MAX_SCHEMA_RESOURCE_CHARS = 16_000;
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
  assert.equal(client.getServerVersion()?.version, "0.6.0");

  bridge = spawn(luaBin, [bridgeHarness, bridgeScript], {
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  const listed = await client.listTools();
  assert.equal(listed.tools.length, 28);
  console.log("[client] tools", listed.tools.map((tool) => tool.name));
  assert.ok(listed.tools.some((tool) => tool.name === "sv_search_api"));
  assert.ok(listed.tools.some((tool) => tool.name === "sv_describe"));
  assert.ok(listed.tools.some((tool) => tool.name === "sv_compare_computed_pitch"));
  assert.ok(listed.tools.some((tool) => tool.name === "sv_plan_expression"));
  assert.ok(listed.tools.some((tool) => tool.name === "sv_align_lyrics"));
  assert.ok(listed.tools.some((tool) => tool.name === "sv_analyze_phrase"));
  const callSchema = listed.tools.find((tool) => tool.name === "sv_call")?.inputSchema;
  assert.ok(callSchema.properties.args.items.anyOf.some((item) => item.type === "number"));
  assert.ok(callSchema.properties.args.items.anyOf.some((item) => item.type === "object"));
  const runTool = listed.tools.find((tool) => tool.name === "sv_run");
  assert.match(runTool.description, /#\/steps\/track\/result/);
  assert.match(runTool.description, /caller-owned/);
  assert.match(runTool.inputSchema.properties.steps.items.properties.target.description, /#\/roots\/project/);
  assert.ok(runTool.inputSchema.properties.steps.items.properties.verifiesStep);
  assert.equal(runTool.inputSchema.properties.steps.items.additionalProperties, false);
  assert.equal(
    runTool.inputSchema.properties.steps.items.properties.retainResult.default,
    false
  );
  assert.equal(runTool.inputSchema.properties.steps.items.properties.return, undefined);
  assert.match(
    runTool.inputSchema.properties.steps.items.properties.retainResult.description,
    /sv_free/
  );
  assert.match(runTool.inputSchema.properties.exports.description, /sv_free/);
  const waitTool = listed.tools.find((tool) => tool.name === "sv_wait_for_processing");
  const setLyricsTool = listed.tools.find((tool) => tool.name === "sv_set_lyrics");
  const cloneTrackTool = listed.tools.find(
    (tool) => tool.name === "sv_clone_track_from_template"
  );
  const batchCurveTool = listed.tools.find(
    (tool) => tool.name === "sv_patch_parameter_curves"
  );
  const phraseTool = listed.tools.find((tool) => tool.name === "sv_edit_phrase");
  const rangeTool = listed.tools.find((tool) => tool.name === "sv_snapshot_range");
  const auditionTool = listed.tools.find((tool) => tool.name === "sv_start_audition");
  const restoreAuditionTool = listed.tools.find((tool) => tool.name === "sv_restore_audition");
  assert.equal(waitTool.inputSchema.properties.requireNonEmpty.default, false);
  assert.equal(waitTool.inputSchema.properties.occurrenceId.type, "string");
  assert.equal(waitTool.inputSchema.additionalProperties, false);
  assert.equal(waitTool.inputSchema.properties.expectedNotes.maximum, 100_000);
  assert.equal(waitTool.inputSchema.properties.frames.maximum, 2_000);
  assert.equal(waitTool.inputSchema.properties.minimumObservedFrames.minimum, 1);
  assert.equal(waitTool.inputSchema.properties.minimumObservedFrames.maximum, 2_000);
  assert.equal(setLyricsTool.inputSchema.properties.requireNonEmptyPhonemes.default, false);
  assert.match(cloneTrackTool.description, /not an isolated musical-data fork/);
  assert.match(cloneTrackTool.description, /sharedTargetGroups/);
  assert.equal(batchCurveTool.inputSchema.properties.curves.maxItems, 16);
  assert.equal(batchCurveTool.inputSchema.properties.responseMode.default, "standard");
  const curveTarget = batchCurveTool.inputSchema.properties.target;
  assert.ok(curveTarget.properties.trackIndex);
  assert.ok(curveTarget.properties.expectedGroupUuid);
  assert.ok(curveTarget.properties.contextId);
  assert.ok(curveTarget.properties.occurrenceId);
  assert.ok(curveTarget.properties.allowSharedTargetMutation);
  assert.ok(phraseTool);
  assert.ok(phraseTool.inputSchema.properties.notePatches);
  assert.ok(phraseTool.inputSchema.properties.structureOperations);
  assert.ok(phraseTool.inputSchema.properties.curves);
  assert.ok(phraseTool.inputSchema.properties.voicePatch);
  assert.match(phraseTool.description, /does not allow changing an existing reference target/);
  assert.ok(rangeTool.inputSchema.properties.budgets.properties.automationPoints);
  assert.ok(rangeTool.inputSchema.properties.computedPitchSampling);
  assert.equal(rangeTool.inputSchema.additionalProperties, false);
  assert.equal(rangeTool.inputSchema.anyOf, undefined);
  assert.equal(batchCurveTool.inputSchema.properties.target.type, "object");
  assert.equal(batchCurveTool.inputSchema.properties.target.anyOf, undefined);
  assert.equal(
    batchCurveTool.inputSchema.properties.curves.items.properties.points.items.oneOf,
    undefined
  );
  assert.deepEqual(
    batchCurveTool.inputSchema.properties.curves.items.properties.points.items.properties.anchor
      .properties.position.enum,
    ["onset", "center", "end", "ratio"]
  );
  assert.equal(auditionTool.inputSchema.properties.autoStop.default, false);
  const recoverySchema = restoreAuditionTool.inputSchema.properties.recovery;
  assert.equal(recoverySchema.additionalProperties, false);
  assert.deepEqual(recoverySchema.properties.savedStatus.enum, ["stopped", "playing", "looping"]);
  assert.ok(recoverySchema.required.includes("savedStatus"));

  const invalidStructureOperation = parseToolError(
    await client.callTool({
      name: "sv_edit_phrase",
      arguments: {
        target: { contextId: "ctx_schema", occurrenceId: "occ_schema" },
        structureOperations: [{ op: "splitt" }],
      },
    })
  );
  assert.equal(invalidStructureOperation.error.code, "INVALID_ARGUMENTS");
  assert.match(invalidStructureOperation.error.message, /tag "op"/);
  assert.doesNotMatch(invalidStructureOperation.error.message, /must be equal to constant/);

  const resources = await client.listResources();
  assert.ok(resources.resources.some((resource) => resource.uri === "svapi://manifest"));
  assert.ok(resources.resources.some((resource) => resource.uri === "svcopilot://capabilities"));
  assert.ok(
    resources.resources.some(
      (resource) => resource.uri === "svcopilot://schemas/music-workflow"
    )
  );
  assert.ok(
    resources.resources.some(
      (resource) => resource.uri === "svcopilot://schemas/sv_edit_phrase"
    )
  );
  assert.ok(
    resources.resources.some(
      (resource) => resource.uri === "svcopilot://schemas/sv_patch_parameter_curves"
    )
  );
  assert.ok(
    resources.resources.some(
      (resource) => resource.uri === "svcopilot://schemas/sv_compare_computed_pitch"
    )
  );
  assert.ok(
    resources.resources.some(
      (resource) => resource.uri === "svcopilot://schemas/sv_plan_expression"
    )
  );
  const manifest = parseResource(await client.readResource({ uri: "svapi://manifest" }));
  assert.ok(manifest.summary.methodOverloadCount >= 200);
  const capabilities = parseResource(
    await client.readResource({ uri: "svcopilot://capabilities" })
  );
  assert.deepEqual(capabilities.knownLimits.automationParameters.builtIn, [
    "pitchDelta",
    "vibratoEnv",
    "loudness",
    "tension",
    "breathiness",
    "voicing",
    "gender",
  ]);
  assert.equal(
    capabilities.knownLimits.automationParameters.vocalModes,
    "dynamic_from_target_voice"
  );
  assert.equal(capabilities.knownLimits.audioRendering.status, "capability_blocked");
  assert.ok(capabilities.interfaces.music.includes("sv_edit_phrase"));
  assert.ok(capabilities.interfaces.music.includes("sv_compare_computed_pitch"));
  assert.ok(capabilities.interfaces.music.includes("sv_plan_expression"));
  assert.ok(capabilities.interfaces.music.includes("sv_align_lyrics"));
  assert.ok(capabilities.interfaces.music.includes("sv_analyze_phrase"));
  assert.equal(capabilities.interfaces.typedResultFormat, "typed-v2");
  assert.equal(
    capabilities.interfaces.schemas.musicWorkflowIndex,
    "svcopilot://schemas/music-workflow"
  );
  assert.equal(capabilities.interfaces.schemas.toolTemplate, "svcopilot://schemas/{tool}");
  assert.equal(capabilities.interfaceVersion, "0.6.0");
  assert.equal(capabilities.limits.projectPageUnit, "traversalItems");
  assert.deepEqual(capabilities.limits.rangeCapture, {
    notes: 2000,
    automationPoints: 20000,
    computedPitchFrames: 20000,
  });
  assert.equal(capabilities.limits.rangeRequest.computedPitchFramesPerGroup, 2000);
  assert.equal(capabilities.limits.rangePage.defaults.computedPitchFrames, 2000);
  assert.equal(capabilities.limits.rangePage.maximums.computedPitchFrames, 20000);
  assert.equal(capabilities.limits.snapshotContextTtlMs, 5 * 60_000);
  assert.equal(capabilities.knownLimits.singer.installedCatalogObservable, false);
  const workflowSchemaIndex = parseResource(
    await client.readResource({ uri: "svcopilot://schemas/music-workflow" })
  );
  assert.deepEqual(
    workflowSchemaIndex.tools.map((tool) => tool.name),
    [
      "sv_patch_parameter_curves",
      "sv_edit_phrase",
      "sv_compare_computed_pitch",
      "sv_plan_expression",
      "sv_align_lyrics",
      "sv_analyze_phrase",
    ]
  );
  const phraseResource = await client.readResource({
    uri: "svcopilot://schemas/sv_edit_phrase",
  });
  const batchResource = await client.readResource({
    uri: "svcopilot://schemas/sv_patch_parameter_curves",
  });
  console.log("[client] workflow schema resource chars", {
    sv_edit_phrase: phraseResource.contents[0].text.length,
    sv_patch_parameter_curves: batchResource.contents[0].text.length,
  });
  assert.ok(phraseResource.contents[0].text.length < MAX_SCHEMA_RESOURCE_CHARS);
  assert.ok(batchResource.contents[0].text.length < MAX_SCHEMA_RESOURCE_CHARS);
  const phraseSchema = parseResource(phraseResource).inputSchema;
  const batchSchema = parseResource(batchResource).inputSchema;
  assert.equal(
    phraseSchema.properties.notePatches.items.properties.set.properties.pitch.maximum,
    127
  );
  assert.deepEqual(
    phraseSchema.properties.structureOperations.items.oneOf.map(
      (schema) => schema.properties.op.const
    ),
    ["insert", "delete", "split", "merge"]
  );
  assert.equal(
    batchSchema.properties.curves.items.properties.points.items.properties.value.type,
    "number"
  );
  const compareResource = await client.readResource({
    uri: "svcopilot://schemas/sv_compare_computed_pitch",
  });
  assert.ok(compareResource.contents[0].text.length < MAX_SCHEMA_RESOURCE_CHARS);
  const compareSchema = parseResource(compareResource).inputSchema;
  assert.deepEqual(compareSchema.properties.mode.enum, [
    "compare_to_target",
    "compare_contexts",
  ]);
  assert.equal(compareSchema.properties.analysis.properties.vibrato.properties.hzRange.maxItems, 2);
  // compare 是纯内存服务：未知 context 直接结构化报错，不触碰宿主。
  const compareUnknownContext = parseToolError(
    await client.callTool({
      name: "sv_compare_computed_pitch",
      arguments: { mode: "compare_to_target", contextId: "ctx_smoke_missing" },
    })
  );
  assert.equal(compareUnknownContext.error.code, "UNKNOWN_CONTEXT");
  const compareInvalidArguments = parseToolError(
    await client.callTool({
      name: "sv_compare_computed_pitch",
      arguments: { mode: "compare_to_target", contextId: "ctx_smoke", bogus: true },
    })
  );
  assert.equal(compareInvalidArguments.error.code, "INVALID_ARGUMENTS");
  const planResource = await client.readResource({
    uri: "svcopilot://schemas/sv_plan_expression",
  });
  assert.ok(planResource.contents[0].text.length < MAX_SCHEMA_RESOURCE_CHARS);
  const planSchema = parseResource(planResource).inputSchema;
  assert.deepEqual(
    planSchema.properties.gestures.items.oneOf.map((schema) => schema.properties.type.const),
    ["scoop", "fall", "portamento", "vibrato", "hairpin"]
  );
  assert.deepEqual(planSchema.properties.intent.properties.emotion.enum, [
    "cool_anger",
    "tender",
  ]);
  // planner 是纯内存服务：未知 context 直接结构化报错，不触碰宿主。
  const planUnknownContext = parseToolError(
    await client.callTool({
      name: "sv_plan_expression",
      arguments: { contextId: "ctx_smoke_missing", intent: { genre: "jpop" } },
    })
  );
  assert.equal(planUnknownContext.error.code, "UNKNOWN_CONTEXT");
  const planInvalidArguments = parseToolError(
    await client.callTool({
      name: "sv_plan_expression",
      arguments: { contextId: "ctx_smoke" },
    })
  );
  assert.equal(planInvalidArguments.error.code, "INVALID_ARGUMENTS");
  // v0.6.0：咬字规划与乐理分析（均为纯内存服务，未知 context 结构化报错）。
  const alignResource = await client.readResource({
    uri: "svcopilot://schemas/sv_align_lyrics",
  });
  assert.ok(alignResource.contents[0].text.length < MAX_SCHEMA_RESOURCE_CHARS);
  const alignSchema = parseResource(alignResource).inputSchema;
  assert.deepEqual(alignSchema.properties.language.enum, [
    "auto",
    "japanese",
    "english",
    "mandarin",
    "cantonese",
  ]);
  const alignUnknownContext = parseToolError(
    await client.callTool({
      name: "sv_align_lyrics",
      arguments: { contextId: "ctx_smoke_missing", lyrics: "あさひ" },
    })
  );
  assert.equal(alignUnknownContext.error.code, "UNKNOWN_CONTEXT");
  const analyzeResource = await client.readResource({
    uri: "svcopilot://schemas/sv_analyze_phrase",
  });
  assert.ok(analyzeResource.contents[0].text.length < MAX_SCHEMA_RESOURCE_CHARS);
  const analyzeSchema = parseResource(analyzeResource).inputSchema;
  assert.deepEqual(analyzeSchema.properties.include.items.enum, [
    "key",
    "scaleDegrees",
    "phrases",
    "statistics",
  ]);
  const analyzeUnknownContext = parseToolError(
    await client.callTool({
      name: "sv_analyze_phrase",
      arguments: { contextId: "ctx_smoke_missing" },
    })
  );
  assert.equal(analyzeUnknownContext.error.code, "UNKNOWN_CONTEXT");
  assert.equal(
    batchSchema.properties.curves.items.properties.range.properties.from.properties.anchor.type,
    "object"
  );
  const resourceTemplates = await client.listResourceTemplates();
  assert.ok(
    resourceTemplates.resourceTemplates.some(
      (template) => template.uriTemplate === "svapi://class/{class}"
    )
  );
  assert.ok(
    resourceTemplates.resourceTemplates.some(
      (template) => template.uriTemplate === "svcopilot://schemas/{tool}"
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
            retainResult: true,
          },
        ],
        exports: { name: { $ref: "#/steps/name/result" } },
      },
    })
  );
  assert.equal(workflow.ok, true);
  assert.equal(workflow.exports.name, "Pipe Vocal");
  assert.deepEqual(workflow.handleOwnership.returnedHandles, []);
  assert.equal(workflow.handleOwnership.callerMustFree, false);

  const legacyReturn = parseToolError(
    await client.callTool({
      name: "sv_run",
      arguments: {
        mode: "read",
        steps: [
          {
            id: "host",
            op: "call",
            method: "getHostInfo",
            return: true,
          },
        ],
      },
    })
  );
  assert.equal(legacyReturn.error.code, "INVALID_ARGUMENTS");
  assert.match(legacyReturn.error.message, /unknown field return/);

  const handlesBeforeRetain = parseResource(
    await client.readResource({ uri: "svcopilot://capabilities" })
  ).connection.knownHandleCount;
  const retainedWorkflow = parseToolResult(
    await client.callTool({
      name: "sv_run",
      arguments: {
        mode: "write",
        undoBoundary: "none",
        steps: [
          {
            id: "note",
            op: "call",
            method: "create",
            args: ["Note"],
            retainResult: true,
          },
        ],
      },
    })
  );
  const retainedNote = retainedWorkflow.steps[0].result;
  assert.equal(retainedNote.__type__, "Note");
  assert.equal(retainedWorkflow.handleOwnership.callerMustFree, true);
  assert.deepEqual(retainedWorkflow.handleOwnership.returnedHandles, [retainedNote]);
  const handlesAfterRetain = parseResource(
    await client.readResource({ uri: "svcopilot://capabilities" })
  ).connection.knownHandleCount;
  assert.equal(handlesAfterRetain, handlesBeforeRetain + 1);
  parseToolResult(
    await client.callTool({
      name: "sv_free",
      arguments: { handle: retainedNote },
    })
  );
  const handlesAfterFree = parseResource(
    await client.readResource({ uri: "svcopilot://capabilities" })
  ).connection.knownHandleCount;
  assert.equal(handlesAfterFree, handlesBeforeRetain);

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

  // sv_snapshot_range 公开契约：bar/beat 双坐标、meter/tempo map、mixer 和 sinceToken。
  const rangeSnapshot = parseToolResult(
    await client.callTool({
      name: "sv_snapshot_range",
      arguments: {
        scope: { kind: "range", trackIndices: [0], from: { bar: 1 }, to: { bar: 2 } },
        include: ["notes", "tempoMap", "meterMap", "mixer", "retakes"],
      },
    })
  );
  assert.equal(rangeSnapshot.ok, true);
  assert.match(rangeSnapshot.contextId, /^ctx_/);
  assert.equal(rangeSnapshot.data.barBase, 1);
  assert.equal(rangeSnapshot.data.range.to.blick, 4 * Q);
  assert.equal(rangeSnapshot.data.timebase.quarterBlick, Q);
  assert.deepEqual(
    rangeSnapshot.data.notes.map((note) => [note.lyrics, note.musical.bar, note.musical.beat]),
    [
      ["ら", 1, 1],
      ["よ", 1, 2],
    ]
  );
  assert.equal(rangeSnapshot.data.notes[0].nextLyrics, "よ");
  assert.equal(rangeSnapshot.data.tempoMap[0].bpm, 120);
  assert.equal(rangeSnapshot.data.meterMap[0].numerator, 4);
  assert.equal(rangeSnapshot.data.tracks[0].mixer.muted, false);
  assert.ok(rangeSnapshot.warnings.some((warning) => warning.code === "UNSUPPORTED_INCLUDE"));
  assert.match(rangeSnapshot.data.tracks[0].groups[0].occurrenceId, /^ctx_/);
  assert.match(rangeSnapshot.data.notes[0].id, /:n:0$/);
  assert.ok(Number.isFinite(rangeSnapshot.timings.serviceTotalMs));

  const rangeProcessing = parseToolResult(
    await client.callTool({
      name: "sv_wait_for_processing",
      arguments: {
        contextId: rangeSnapshot.contextId,
        occurrenceId: rangeSnapshot.data.tracks[0].groups[0].occurrenceId,
        kind: "phonemes",
        timeoutMs: 0,
      },
    })
  );
  assert.equal(rangeProcessing.ok, true);
  assert.equal(rangeProcessing.data.state, "ready");
  assert.equal(rangeProcessing.data.evidence.expectedNotes, 2);
  assert.equal(
    rangeProcessing.target.occurrenceId,
    rangeSnapshot.data.tracks[0].groups[0].occurrenceId
  );

  // range context 必须穿过 MCP schema 和 dispatch，不能只在 service 单测中成立。
  const rangeOccurrenceId = rangeSnapshot.data.tracks[0].groups[0].occurrenceId;
  const rangeNote = rangeSnapshot.data.notes[0];
  const rangePatchPlan = parseToolResult(
    await client.callTool({
      name: "sv_patch_notes",
      arguments: {
        contextId: rangeSnapshot.contextId,
        occurrenceId: rangeOccurrenceId,
        allowSharedTargetMutation: true,
        patches: [
          {
            noteId: rangeNote.id,
            expected: { lyrics: rangeNote.lyrics },
            set: { lyrics: "仮" },
          },
        ],
        dryRun: true,
        waitFor: "none",
      },
    })
  );
  assert.equal(rangePatchPlan.ok, true);
  assert.equal(rangePatchPlan.status, "dry_run");
  assert.equal(rangePatchPlan.effects, "none");
  assert.equal(rangePatchPlan.data.plannedChangedNotes, 1);

  const rangeStructurePlan = parseToolResult(
    await client.callTool({
      name: "sv_restructure_notes",
      arguments: {
        contextId: rangeSnapshot.contextId,
        occurrenceId: rangeOccurrenceId,
        allowSharedTargetMutation: true,
        operations: [
          {
            op: "split",
            noteId: rangeNote.id,
            atBlick: rangeNote.onsetBlick + Math.floor(rangeNote.durationBlick / 2),
          },
        ],
        dryRun: true,
        waitFor: "none",
      },
    })
  );
  assert.equal(rangeStructurePlan.ok, true);
  assert.equal(rangeStructurePlan.status, "dry_run");
  assert.equal(rangeStructurePlan.effects, "none");
  assert.equal(rangeStructurePlan.data.initialNoteCount, 2);
  assert.equal(rangeStructurePlan.data.expectedNoteCount, 3);

  const invalidRangeArguments = parseToolError(
    await client.callTool({
      name: "sv_snapshot_range",
      arguments: {
        scope: { kind: "range", trackIndices: [0], from: { bar: 1 }, to: { bar: 2 } },
        responseMod: "compact",
        definitelyUnknownOption: true,
      },
    })
  );
  assert.equal(invalidRangeArguments.ok, false);
  assert.equal(invalidRangeArguments.error.code, "INVALID_ARGUMENTS");
  assert.match(invalidRangeArguments.error.message, /responseMod/);

  const anchorDryRun = parseToolResult(
    await client.callTool({
      name: "sv_patch_parameter_curves",
      arguments: {
        target: {
          contextId: rangeSnapshot.contextId,
          occurrenceId: rangeSnapshot.data.tracks[0].groups[0].occurrenceId,
        },
        curves: [
          {
            parameter: "loudness",
            mode: "replace",
            range: { fromBlick: 0, toBlick: 2 * Q },
            points: [
              {
                anchor: { noteId: rangeSnapshot.data.notes[0].id, position: "onset" },
                value: 1,
              },
              {
                anchor: {
                  noteId: rangeSnapshot.data.notes[0].id,
                  position: "ratio",
                  ratio: 0.5,
                },
                value: 1.5,
              },
              {
                anchor: {
                  noteId: rangeSnapshot.data.notes[1].id,
                  position: { ratio: 0.5 },
                },
                value: 2,
              },
            ],
          },
        ],
        dryRun: true,
      },
    })
  );
  assert.equal(anchorDryRun.status, "dry_run");
  assert.equal(anchorDryRun.curves[0].resolvedPositions[0].localBlick, 0);
  assert.deepEqual(
    anchorDryRun.curves[0].resolvedPositions.map((point) => point.localBlick),
    [0, Q / 2, Q + Q / 2]
  );
  assert.ok(
    anchorDryRun.warnings.some((warning) => warning.code === "SHARED_TARGET_CHECK_DEFERRED")
  );
  const rangeAgain = parseToolResult(
    await client.callTool({
      name: "sv_snapshot_range",
      arguments: {
        scope: { kind: "range", trackIndices: [0], from: { bar: 1 }, to: { bar: 2 } },
        include: ["notes", "tempoMap", "meterMap", "mixer", "retakes"],
        sinceToken: rangeSnapshot.snapshotToken,
      },
    })
  );
  assert.equal(rangeAgain.status, "no_change");
  assert.equal(rangeAgain.data, null);
  assert.match(rangeAgain.contextExpiresAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(rangeAgain.page.detailCursor);
  const refreshedRangeIdentity = parseToolResult(
    await client.callTool({
      name: "sv_snapshot_range",
      arguments: { cursor: rangeAgain.page.detailCursor },
    })
  );
  assert.equal(refreshedRangeIdentity.contextId, rangeAgain.contextId);
  assert.match(refreshedRangeIdentity.data.notes[0].id, new RegExp(`^${rangeAgain.contextId}`));

  // 参数曲线：读取（双坐标 + definition），replace 写入 + 精确读回验证。
  const curve = parseToolResult(
    await client.callTool({
      name: "sv_get_parameter_curve",
      arguments: {
        target: { trackIndex: 0, groupIndex: 0 },
        parameter: "loudness",
        range: { fromBlick: 0, toBlick: 2 * Q },
      },
    })
  );
  assert.equal(curve.ok, true);
  assert.deepEqual(curve.data.definition.range, [-24, 24]);
  assert.equal(curve.data.interpolationMethod, "Linear");
  assert.equal(curve.data.stats.count, 2);
  assert.equal(curve.data.points[1].localBlick, Q);

  const curvePatch = parseToolResult(
    await client.callTool({
      name: "sv_patch_parameter_curve",
      arguments: {
        target: { trackIndex: 0, groupIndex: 0, allowSharedTargetMutation: true },
        parameter: "loudness",
        mode: "replace",
        range: { fromBlick: 0, toBlick: 2 * Q },
        points: [
          { blick: 0, value: 2 },
          { blick: Q, value: -3 },
        ],
      },
    })
  );
  assert.equal(curvePatch.ok, true);
  assert.equal(curvePatch.status, "succeeded");
  assert.equal(curvePatch.effects, "verified");
  assert.equal(curvePatch.verification.mode, "exact");
  assert.equal(curvePatch.data.after.pointCount, 2);
  assert.equal(curvePatch.data.after.stats.min, -3);

  // 批量工具必须经过真实 MCP + IO PIPE 路径完成预检、写入和内建回读验证。
  const batchCurvePatch = parseToolResult(
    await client.callTool({
      name: "sv_patch_parameter_curves",
      arguments: {
        target: {
          trackIndex: 0,
          groupIndex: 0,
          expectedGroupUuid: "pipe-group-1",
          allowSharedTargetMutation: true,
        },
        curves: [
          {
            parameter: "loudness",
            mode: "replace",
            range: { fromBlick: 0, toBlick: 2 * Q },
            points: [
              { blick: 0, value: 1 },
              { blick: Q, value: -2 },
            ],
          },
        ],
        responseMode: "compact",
        undoLabel: "Smoke batch curve",
      },
    })
  );
  assert.equal(batchCurvePatch.ok, true);
  assert.equal(batchCurvePatch.status, "succeeded");
  assert.equal(batchCurvePatch.targetUuid, "pipe-group-1");
  assert.equal(batchCurvePatch.curves[0].verified, true);
  assert.equal(batchCurvePatch.undoRecords, 1);
  assert.equal(batchCurvePatch.undoLabelApplied, false);
  assert.equal(batchCurvePatch.timings.dispatcherQueueMs, null);
  assert.ok(Number.isFinite(batchCurvePatch.timings.validationMs));
  assert.ok(Number.isFinite(batchCurvePatch.timings.coordinatorQueueMs));
  assert.ok(Number.isFinite(batchCurvePatch.timings.operationMs));
  assert.ok(Number.isFinite(batchCurvePatch.timings.serviceTotalMs));

  // Relay 宿主故意把未知名称回退到默认曲线；高层工具必须在调用宿主前拒绝 typo。
  const typoCurvePatch = parseToolError(
    await client.callTool({
      name: "sv_patch_parameter_curves",
      arguments: {
        target: { trackIndex: 0, groupIndex: 0 },
        curves: [
          {
            parameter: "pitchDelt",
            mode: "replace",
            range: { fromBlick: 0, toBlick: Q },
            points: [{ blick: 0, value: 0 }],
          },
        ],
        dryRun: true,
      },
    })
  );
  assert.equal(typoCurvePatch.ok, false);
  assert.equal(typoCurvePatch.effects, "none");
  assert.equal(typoCurvePatch.error.code, "UNKNOWN_PARAMETER");
  assert.equal(typoCurvePatch.curves[0].requestedParameter, "pitchDelt");
  assert.equal(typoCurvePatch.curves[0].resolvedParameter, null);

  const duplicateCurvePatch = parseToolError(
    await client.callTool({
      name: "sv_patch_parameter_curves",
      arguments: {
        target: { trackIndex: 0, groupIndex: 0 },
        curves: ["loudness", "LoUdNeSs"].map((parameter) => ({
          parameter,
          mode: "replace",
          range: { fromBlick: 0, toBlick: Q },
          points: [{ blick: 0, value: 0 }],
        })),
        dryRun: true,
      },
    })
  );
  assert.equal(duplicateCurvePatch.error.code, "DUPLICATE_PARAMETER");
  assert.deepEqual(
    duplicateCurvePatch.curves.map((curve) => curve.resolvedParameter),
    ["loudness", "loudness"]
  );
  assert.equal(duplicateCurvePatch.undoRecords, 0);

  const curveOutOfRange = parseToolError(
    await client.callTool({
      name: "sv_patch_parameter_curve",
      arguments: {
        target: { trackIndex: 0, groupIndex: 0, allowSharedTargetMutation: true },
        parameter: "loudness",
        mode: "replace",
        range: { fromBlick: 0, toBlick: Q },
        points: [{ blick: 0, value: 999 }],
      },
    })
  );
  assert.equal(curveOutOfRange.error.code, "VALUE_OUT_OF_RANGE");

  // 结构操作：split → merge 回原状，insert → delete 往返，全部走真实 pipe。
  const structureSnapshot = parseToolResult(
    await client.callTool({ name: "sv_snapshot", arguments: { scope: { kind: "selection" } } })
  );
  const splitResult = parseToolResult(
    await client.callTool({
      name: "sv_restructure_notes",
      arguments: {
        contextId: structureSnapshot.contextId,
        waitFor: "none",
        operations: [
          { op: "split", noteId: structureSnapshot.data.notes[0].id, atBlick: 352800 },
        ],
      },
    })
  );
  assert.equal(splitResult.ok, true);
  assert.equal(splitResult.status, "succeeded");
  assert.equal(splitResult.data.finalNoteCount, 3);
  assert.equal(splitResult.atomicity, "verified_compensation");

  const afterSplit = parseToolResult(
    await client.callTool({
      name: "sv_snapshot",
      arguments: { scope: { kind: "selection" }, include: ["notes"] },
    })
  );
  assert.deepEqual(
    afterSplit.data.notes.map((note) => note.lyrics),
    ["ら", "-", "よ"]
  );

  const mergeResult = parseToolResult(
    await client.callTool({
      name: "sv_restructure_notes",
      arguments: {
        contextId: afterSplit.contextId,
        waitFor: "none",
        operations: [
          {
            op: "merge",
            noteIds: [afterSplit.data.notes[0].id, afterSplit.data.notes[1].id],
            lyricsJoin: "first",
          },
        ],
      },
    })
  );
  assert.equal(mergeResult.ok, true);
  assert.equal(mergeResult.data.finalNoteCount, 2);

  const insertSnapshot = parseToolResult(
    await client.callTool({ name: "sv_snapshot", arguments: { scope: { kind: "selection" } } })
  );
  assert.deepEqual(
    insertSnapshot.data.notes.map((note) => [note.lyrics, note.durationBlick]),
    [
      ["ら", Q],
      ["よ", Q],
    ]
  );
  const insertResult = parseToolResult(
    await client.callTool({
      name: "sv_restructure_notes",
      arguments: {
        contextId: insertSnapshot.contextId,
        waitFor: "none",
        operations: [
          { op: "insert", note: { onsetBlick: 2 * Q, durationBlick: Q, pitch: 64, lyrics: "ん" } },
        ],
      },
    })
  );
  assert.equal(insertResult.ok, true);
  assert.equal(insertResult.data.appliedOperations[0].indexInGroup, 2);

  const deleteSnapshot = parseToolResult(
    await client.callTool({ name: "sv_snapshot", arguments: { scope: { kind: "selection" } } })
  );
  const deleteResult = parseToolResult(
    await client.callTool({
      name: "sv_restructure_notes",
      arguments: {
        contextId: deleteSnapshot.contextId,
        waitFor: "none",
        operations: [
          {
            op: "delete",
            noteId: deleteSnapshot.data.notes[2].id,
            expected: { lyrics: "ん" },
          },
        ],
      },
    })
  );
  assert.equal(deleteResult.ok, true);
  assert.equal(deleteResult.data.finalNoteCount, 2);

  const autoAudition = parseToolResult(
    await client.callTool({
      name: "sv_start_audition",
      arguments: { fromBlick: 0, toBlick: Q, loop: false, autoStop: true },
    })
  );
  assert.equal(autoAudition.data.endPolicy, "auto_stop");
  await new Promise((resolve) => setTimeout(resolve, 650));
  const autoAuditionDone = parseToolResult(
    await client.callTool({
      name: "sv_get_audition",
      arguments: { auditionId: autoAudition.data.auditionId },
    })
  );
  assert.ok(["restored", "stopped_by_user"].includes(autoAuditionDone.status));
  assert.ok(Number.isFinite(autoAuditionDone.data.autoStop.timerDelayMs));

  // 试听闭环：start（solo + loop）→ get → stop（恢复 solo 与 playhead）。
  const auditionStart = parseToolResult(
    await client.callTool({
      name: "sv_start_audition",
      arguments: { fromBlick: 0, toBlick: 4 * Q, soloTrackIndices: [0], loop: true },
    })
  );
  assert.equal(auditionStart.ok, true);
  assert.equal(auditionStart.data.playbackStatus, "looping");
  assert.equal(auditionStart.data.range.toSeconds, 2);
  assert.equal(auditionStart.data.recovery.savedPlayheadSeconds, 2.5);
  assert.equal(auditionStart.data.recovery.mixerChanges[0].previousValue, false);

  const auditionStatus = parseToolResult(
    await client.callTool({
      name: "sv_get_audition",
      arguments: { auditionId: auditionStart.data.auditionId },
    })
  );
  assert.equal(auditionStatus.data.playbackStatus, "looping");

  const auditionStop = parseToolResult(
    await client.callTool({
      name: "sv_stop_audition",
      arguments: { auditionId: auditionStart.data.auditionId },
    })
  );
  assert.equal(auditionStop.ok, true);
  assert.equal(auditionStop.status, "succeeded");
  assert.equal(auditionStop.data.playbackStatus, "stopped");
  assert.equal(auditionStop.data.playheadSeconds, 2.5);
  assert.equal(auditionStop.data.restoration[0].restored, true);
  assert.equal(auditionStop.data.restoration[0].observedAfterRestore, false);

  // voice 降级接口：可观测参数 + 明确 unobservable；clone track 带读回验证。
  const voiceProfile = parseToolResult(
    await client.callTool({
      name: "sv_get_voice_profile",
      arguments: { trackIndex: 0 },
    })
  );
  assert.equal(voiceProfile.ok, true);
  assert.equal(voiceProfile.data.groups[0].voice.identityStatus, "unobservable");
  assert.equal(voiceProfile.data.groups[0].voice.parameters.paramTension, 0);
  assert.equal(voiceProfile.data.capabilities.singerIdentity, "unobservable");

  const clonedTrack = parseToolResult(
    await client.callTool({
      name: "sv_clone_track_from_template",
      arguments: { templateTrackIndex: 0, name: "Pipe Harmony" },
    })
  );
  assert.equal(clonedTrack.ok, true);
  assert.equal(clonedTrack.status, "succeeded");
  assert.equal(clonedTrack.data.newTrackIndex, 3);
  assert.equal(clonedTrack.data.trackCountAfter, 4);
  assert.equal(clonedTrack.data.name, "Pipe Harmony");
  assert.equal(clonedTrack.data.identityPreservation, "host_opaque");

  const note = parseToolResult(
    await client.callTool({ name: "sv_call", arguments: { method: "create", args: ["Note"] } })
  );
  assert.equal(note.__type__, "Note");
  // 预检把版本和方法存在性都交给权威宿主，调用被转发；harness 的 Note 没有实现
  // getRapAccent，所以拿到的是宿主自己的 "no such method"。
  const versionDeferred = await client.callTool({
    name: "sv_call",
    arguments: { handle: note.__handle__, method: "getRapAccent", args: [] },
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
  // 前面的 sv_clone_track_from_template 已把轨道数从 3 增加到 4。
  assert.equal(trackCount, 4);
  assert.equal(quarter, Q);

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
