import "./helpers/pipe-namespace.mjs";
import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { Client } from "../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";

import { isErrorStatus } from "../server/src/mcp-result-encoder.js";
import {
  DESCRIBE_OPERATION_TOOL,
  MAX_DESCRIBE_OPERATIONS,
} from "../server/src/compact-facade.js";
import { facadeForTool, operationNameForTool } from "../server/src/operation-catalog.js";

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

// content[0].text 只是一行状态摘要，不再是 payload 的第二份副本；
// 完整机器结果只能从 structuredContent 读取。摘要行仍要断言存在且有界，
// 否则"不复制 payload"会退化成"什么都不返回"。
function assertSummaryLine(response) {
  const text = response.content?.find((item) => item.type === "text")?.text;
  assert.equal(typeof text, "string");
  assert.ok(Buffer.byteLength(text, "utf8") <= 512, `summary line too long: ${text.length}`);
  assert.equal(text.includes("\n"), false);
  const structured = JSON.stringify(response.structuredContent ?? null);
  assert.equal(text.includes(structured), false, "summary line must not duplicate the payload");
  return text;
}

// status 是唯一成败来源；与 status 并存的 ok 布尔已从 MCP surface 移除。
// 仍保留 ok 的结果（如 sv_doctor 的安装健康结论）没有 status 承载同一信息，
// 因此按 status 优先、ok 兜底判定。
function okOf(result) {
  if (typeof result?.status === "string") return !isErrorStatus(result.status);
  return result?.ok;
}

function parseToolResult(response) {
  const text = assertSummaryLine(response);
  if (response.isError) throw new Error(text || "MCP tool failed");
  assert.notEqual(response.structuredContent, undefined);
  return response.structuredContent;
}

function parseToolError(response) {
  assert.equal(response.isError, true);
  assertSummaryLine(response);
  assert.notEqual(response.structuredContent, undefined);
  return response.structuredContent;
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

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverScript],
  env: process.env,
  cwd: path.dirname(serverScript),
  stderr: "pipe",
});
const client = new Client({ name: "sv-copilot-smoke-client", version: "1.0.0" });
let bridge;

// facade 是唯一 surface。用例仍按内部 handler 名书写（可读性最好，也让"哪个服务
// 负责"一目了然），由这里统一投影成 facade 信封——与真实模型走同一条路。
//
// 注意内部 handler `sv_describe`（官方 API 描述）与公开的 schema discovery 工具
// `sv_describe` 同名但不同物：前者投影成 sv_status(describe_api)，后者只由
// describeTools() 直接调用。
function facadeCall(request) {
  return client.callTool({
    name: facadeForTool(request.name),
    arguments: {
      operation: operationNameForTool(request.name),
      arguments: request.arguments ?? {},
    },
  });
}

// direct tool 的 schema 与 description 只能从 sv_describe 取，因此 smoke 也走
// 那条路：一次最多 MAX_DESCRIBE_OPERATIONS 个，分批取完。
async function describeTools(names) {
  const served = new Map();
  // 条数上限之外还有字节预算：被 deferred 的 operation 按 remedy 单独再取一次。
  const pending = [...names];
  while (pending.length > 0) {
    const batch = pending.splice(0, MAX_DESCRIBE_OPERATIONS);
    const response = await client.callTool({
      name: DESCRIBE_OPERATION_TOOL,
      arguments: { operations: batch.map(operationNameForTool) },
    });
    assert.notEqual(response.isError, true, `sv_describe failed for ${batch.join(", ")}`);
    const { operations, deferred } = response.structuredContent;
    for (const name of batch) {
      const entry = operations.find((item) => item.operation === operationNameForTool(name));
      if (!entry) {
        assert.ok(
          deferred?.operations.some((item) => item.operation === operationNameForTool(name)),
          `sv_describe must return ${name} or report it as deferred`
        );
        pending.push(name);
        continue;
      }
      served.set(name, entry);
    }
  }
  return served;
}

// 送出的 schema 把重复片段提到了自己的 $defs，因此结构性穿透必须先解 $ref。
// schema 仍然自包含（`#/$defs/x` 在这份 schema 内即可解析），这里就是按调用方
// 该有的方式解析它。
function deref(node, schema) {
  if (!node || typeof node.$ref !== "string") return node;
  const path = node.$ref.replace(/^#\//, "").split("/");
  let current = schema;
  for (const segment of path) current = current[segment];
  assert.ok(current, `unresolved $ref ${node.$ref}`);
  return deref(current, schema);
}

try {
  transport.stderr?.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));
  await client.connect(transport);
  console.log("[client] connected", client.getServerVersion());
  assert.equal(client.getServerVersion()?.version, "0.9.0");

  bridge = spawn(luaBin, [bridgeHarness, bridgeScript], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  // tools/list 现在只有 8 个 facade；operation 的 schema/description 从 sv_describe 取。
  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name).sort(),
    [
      DESCRIBE_OPERATION_TOOL,
      "sv_artifact",
      "sv_audition",
      "sv_edit",
      "sv_plan",
      "sv_raw",
      "sv_read",
      "sv_status",
    ].sort()
  );
  console.log("[client] tools", listed.tools.map((tool) => tool.name));
  const listBytes = Buffer.byteLength(JSON.stringify(listed.tools), "utf8");
  assert.ok(listBytes < 12 * 1024, `tools/list must stay under 12 KiB; got ${listBytes}`);

  // 每个 operation 都必须从某个 facade 的 enum 里可达。
  const reachable = new Set(
    listed.tools
      .filter((tool) => tool.name !== DESCRIBE_OPERATION_TOOL)
      .flatMap((tool) => tool.inputSchema.properties.operation.enum)
  );
  for (const name of [
    "sv_doctor",
    "sv_search_api",
    "sv_describe",
    "sv_compare_computed_pitch",
    "sv_plan_expression",
    "sv_align_lyrics",
    "sv_analyze_phrase",
    "sv_style_profile",
    "sv_validate_lyrics_prosody",
    "sv_quantize_notes",
    "sv_generate_harmony",
    "sv_analyze_vocal_context",
    "sv_get_audition_compare",
    "sv_stop_audition_compare",
  ]) {
    assert.ok(reachable.has(operationNameForTool(name)), `${name} must stay reachable`);
  }

  const served = await describeTools([
    "sv_release_artifact",
    "sv_audition_compare",
    "sv_set_selection",
    "sv_call",
    "sv_run",
    "sv_wait_for_processing",
    "sv_set_lyrics",
    "sv_clone_track_from_template",
    "sv_patch_parameter_curves",
    "sv_edit_phrase",
    "sv_snapshot_range",
    "sv_start_audition",
    "sv_restore_audition",
    "sv_patch_notes",
  ]);
  const releaseArtifactTool = served.get("sv_release_artifact");
  assert.equal(releaseArtifactTool.inputSchema.additionalProperties, false);
  assert.deepEqual(releaseArtifactTool.inputSchema.required, ["artifactId"]);
  const compareTool = served.get("sv_audition_compare");
  // A/B 只比较既有版本：不做"临时编辑 -> B -> 还原"，因为官方无 Undo 调用。
  // 完整 description 必须经 sv_describe 完整送达，而不是被截成首句摘要。
  assert.match(compareTool.description, /NEVER applies a temporary musical edit/);
  assert.match(compareTool.description, /no project-content Undo record/);
  assert.match(compareTool.description, /human_only/);
  const selectionTool = served.get("sv_set_selection");
  // 高层 selection 的存在理由：宿主 boolean 不可信，必须以读回为准。
  assert.match(selectionTool.description, /never treats a host boolean as evidence/);
  assert.match(selectionTool.description, /creates no Undo record/);
  assert.deepEqual(selectionTool.inputSchema.properties.operation.enum, [
    "clear",
    "select",
    "add",
    "remove",
  ]);
  const callSchema = served.get("sv_call").inputSchema;
  assert.ok(callSchema.properties.args.items.anyOf.some((item) => item.type === "number"));
  assert.ok(callSchema.properties.args.items.anyOf.some((item) => item.type === "object"));
  const runTool = served.get("sv_run");
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
  const waitTool = served.get("sv_wait_for_processing");
  const setLyricsTool = served.get("sv_set_lyrics");
  const cloneTrackTool = served.get("sv_clone_track_from_template");
  const batchCurveTool = served.get("sv_patch_parameter_curves");
  const phraseTool = served.get("sv_edit_phrase");
  const rangeTool = served.get("sv_snapshot_range");
  const auditionTool = served.get("sv_start_audition");
  const restoreAuditionTool = served.get("sv_restore_audition");
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
  assert.ok(rangeTool.inputSchema.properties.budgets.properties.pitchControls);
  assert.ok(rangeTool.inputSchema.properties.computedPitchSampling);
  assert.equal(rangeTool.inputSchema.additionalProperties, false);
  assert.equal(rangeTool.inputSchema.anyOf, undefined);
  assert.equal(batchCurveTool.inputSchema.properties.target.type, "object");
  assert.equal(batchCurveTool.inputSchema.properties.target.anyOf, undefined);
  const curveSchema = batchCurveTool.inputSchema;
  const curvePointsInput = deref(
    deref(curveSchema.properties.curves, curveSchema).items,
    curveSchema
  ).properties.points;
  const explicitPoint = deref(deref(curvePointsInput, curveSchema).anyOf[0], curveSchema);
  assert.equal(deref(explicitPoint.items, curveSchema).oneOf, undefined);
  assert.equal(
    deref(deref(curvePointsInput, curveSchema).anyOf[1], curveSchema).properties.encoding.const,
    "dense-table-v1"
  );
  assert.deepEqual(
    deref(deref(explicitPoint.items, curveSchema).properties.anchor, curveSchema).properties
      .position.enum,
    ["onset", "center", "end", "ratio"]
  );
  assert.equal(auditionTool.inputSchema.properties.autoStop.default, false);
  const recoverySchema = restoreAuditionTool.inputSchema.properties.recovery;
  assert.equal(recoverySchema.additionalProperties, false);
  assert.deepEqual(recoverySchema.properties.savedStatus.enum, ["stopped", "playing", "looping"]);
  assert.ok(recoverySchema.required.includes("savedStatus"));

  const invalidStructureOperation = parseToolError(
    await facadeCall({
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
  assert.ok(
    resources.resources.some(
      (resource) => resource.uri === "svcopilot://guide/music-workflows"
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
  assert.ok(capabilities.interfaces.music.includes("sv_style_profile"));
  assert.ok(capabilities.interfaces.music.includes("sv_validate_lyrics_prosody"));
  assert.ok(capabilities.interfaces.music.includes("sv_quantize_notes"));
  assert.ok(capabilities.interfaces.music.includes("sv_generate_harmony"));
  assert.ok(capabilities.interfaces.music.includes("sv_analyze_vocal_context"));
  assert.deepEqual(capabilities.interfaces.editorState, ["sv_set_selection"]);
  assert.ok(capabilities.interfaces.audition.includes("sv_audition_compare"));
  assert.ok(capabilities.interfaces.audition.includes("sv_stop_audition_compare"));
  assert.equal(capabilities.interfaces.typedResultFormat, "typed-v2");
  assert.equal(capabilities.interfaces.artifact.releaseTool, "sv_release_artifact");
  assert.deepEqual(capabilities.interfaces.artifact.pageBytes, {
    default: 8 * 1024,
    minimum: 8 * 1024,
    maximum: 16 * 1024,
  });
  assert.equal(capabilities.interfaces.artifact.directReadMaxBytes, 16 * 1024);
  assert.match(
    capabilities.interfaces.artifact.resourceTemplate,
    /\{artifactId\}\/\{contentHash\}/
  );
  assert.equal(
    capabilities.interfaces.schemas.musicWorkflowIndex,
    "svcopilot://schemas/music-workflow"
  );
  assert.equal(capabilities.interfaces.schemas.toolTemplate, "svcopilot://schemas/{tool}");
  assert.equal(
    capabilities.interfaces.guide.musicWorkflows,
    "svcopilot://guide/music-workflows"
  );
  assert.equal(
    capabilities.interfaces.guide.recipeTemplate,
    "svcopilot://guide/music-workflows/{recipe}"
  );
  assert.equal(capabilities.interfaceVersion, "0.9.0");
  assert.equal(capabilities.limits.projectPageUnit, "traversalItems");
  assert.deepEqual(capabilities.limits.rangeCapture, {
    notes: 2000,
    automationPoints: 20000,
    computedPitchFrames: 20000,
    pitchControls: 4000,
    pitchControlCurvePoints: 2000,
  });
  assert.equal(capabilities.limits.pitchControl.controlsPerGroup, 512);
  assert.equal(capabilities.limits.pitchControl.operationsPerRequest, 32);
  assert.equal(capabilities.limits.rangeRequest.computedPitchFramesPerGroup, 2000);
  assert.equal(capabilities.limits.rangePage.defaults.computedPitchFrames, 2000);
  assert.equal(capabilities.limits.rangePage.maximums.computedPitchFrames, 20000);
  assert.equal(capabilities.limits.snapshotContextTtlMs, 30 * 60_000);
  assert.equal(capabilities.knownLimits.singer.installedCatalogObservable, false);
  const workflowSchemaIndex = parseResource(
    await client.readResource({ uri: "svcopilot://schemas/music-workflow" })
  );
  assert.deepEqual(
    workflowSchemaIndex.tools.map((tool) => tool.name),
    [
      "sv_patch_parameter_curves",
      "sv_patch_pitch_controls",
      "sv_plan_pitch_gesture",
      "sv_bake_computed_pitch",
      "sv_edit_phrase",
      "sv_compare_computed_pitch",
      "sv_plan_expression",
      "sv_align_lyrics",
      "sv_analyze_phrase",
      "sv_style_profile",
      "sv_validate_lyrics_prosody",
      "sv_quantize_notes",
      "sv_generate_harmony",
      "sv_analyze_vocal_context",
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
    batchSchema.properties.curves.items.properties.points.anyOf[0].items.properties.value.type,
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
    await facadeCall({
      name: "sv_compare_computed_pitch",
      arguments: { mode: "compare_to_target", contextId: "ctx_smoke_missing" },
    })
  );
  assert.equal(compareUnknownContext.error.code, "UNKNOWN_CONTEXT");
  const compareInvalidArguments = parseToolError(
    await facadeCall({
      name: "sv_compare_computed_pitch",
      arguments: { mode: "compare_to_target", contextId: "ctx_smoke", bogus: true },
    })
  );
  assert.equal(compareInvalidArguments.error.code, "INVALID_ARGUMENTS");
  const pitchGestureResource = await client.readResource({
    uri: "svcopilot://schemas/sv_plan_pitch_gesture",
  });
  assert.ok(pitchGestureResource.contents[0].text.length < MAX_SCHEMA_RESOURCE_CHARS);
  const pitchGestureSchema = parseResource(pitchGestureResource).inputSchema;
  assert.deepEqual(pitchGestureSchema.properties.specialEventPolicy.enum, [
    "warn_and_skip",
    "include",
    "error",
  ]);
  assert.equal(pitchGestureSchema.properties.specialEventPolicy.default, "warn_and_skip");
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
    await facadeCall({
      name: "sv_plan_expression",
      arguments: { contextId: "ctx_smoke_missing", intent: { genre: "jpop" } },
    })
  );
  assert.equal(planUnknownContext.error.code, "UNKNOWN_CONTEXT");
  const planInvalidArguments = parseToolError(
    await facadeCall({
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
    await facadeCall({
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
    "metricalRoles",
    "chordCandidates",
    "cadence",
    "tensionResolution",
  ]);
  // P1-A 的和声语境 section 是 opt-in，且候选下限为 2：歧义不得被写成唯一事实。
  assert.match(analyzeSchema.properties.include.description, /OPT-IN/);
  assert.match(analyzeSchema.properties.include.description, /melody_only/);
  assert.equal(analyzeSchema.properties.maxChordCandidates.minimum, 2);
  assert.equal(analyzeSchema.properties.maxCadenceCandidates.minimum, 2);
  assert.deepEqual(analyzeSchema.properties.harmonicWindow.enum, ["bar", "half_bar"]);
  const analyzeUnknownContext = parseToolError(
    await facadeCall({
      name: "sv_analyze_phrase",
      arguments: { contextId: "ctx_smoke_missing" },
    })
  );
  assert.equal(analyzeUnknownContext.error.code, "UNKNOWN_CONTEXT");
  // v0.7.0：风格聚合与咬字/韵律校验（均为纯内存服务，未知 context 结构化报错）。
  const styleResource = await client.readResource({
    uri: "svcopilot://schemas/sv_style_profile",
  });
  assert.ok(styleResource.contents[0].text.length < MAX_SCHEMA_RESOURCE_CHARS);
  const styleSchema = parseResource(styleResource).inputSchema;
  assert.equal(styleSchema.properties.targets.maxItems, 8);
  assert.ok(styleSchema.properties.targets.items.properties.label);
  const styleUnknownContext = parseToolError(
    await facadeCall({
      name: "sv_style_profile",
      arguments: { targets: [{ contextId: "ctx_smoke_missing" }] },
    })
  );
  assert.equal(styleUnknownContext.error.code, "UNKNOWN_CONTEXT");
  const styleInvalidArguments = parseToolError(
    await facadeCall({
      name: "sv_style_profile",
      arguments: { targets: [] },
    })
  );
  assert.equal(styleInvalidArguments.error.code, "INVALID_ARGUMENTS");
  const prosodyResource = await client.readResource({
    uri: "svcopilot://schemas/sv_validate_lyrics_prosody",
  });
  assert.ok(prosodyResource.contents[0].text.length < MAX_SCHEMA_RESOURCE_CHARS);
  const prosodySchema = parseResource(prosodyResource).inputSchema;
  assert.deepEqual(prosodySchema.properties.checks.items.enum, [
    "breath",
    "specialLyricChains",
    "japaneseMora",
    "englishSyllables",
    "languageConsistency",
    "stressAlignment",
    "phonemeCoverage",
  ]);
  const prosodyUnknownContext = parseToolError(
    await facadeCall({
      name: "sv_validate_lyrics_prosody",
      arguments: { contextId: "ctx_smoke_missing" },
    })
  );
  assert.equal(prosodyUnknownContext.error.code, "UNKNOWN_CONTEXT");
  // v0.7.1：量化规划器与 sv_plan_expression 的 section-aware presets。
  assert.deepEqual(planSchema.properties.intent.properties.preset.enum, [
    "jpop_cool",
    "jpop_belt",
    "controlled_anger",
    "intimate_whisper",
    "spoken_rap_transition",
  ]);
  const quantizeResource = await client.readResource({
    uri: "svcopilot://schemas/sv_quantize_notes",
  });
  assert.ok(quantizeResource.contents[0].text.length < MAX_SCHEMA_RESOURCE_CHARS);
  const quantizeSchema = parseResource(quantizeResource).inputSchema;
  assert.deepEqual(quantizeSchema.properties.grid.properties.division.enum, [
    "1/4",
    "1/8",
    "1/16",
    "1/32",
    "1/8T",
    "1/16T",
  ]);
  const quantizeUnknownContext = parseToolError(
    await facadeCall({
      name: "sv_quantize_notes",
      arguments: { contextId: "ctx_smoke_missing", grid: { division: "1/8" } },
    })
  );
  assert.equal(quantizeUnknownContext.error.code, "UNKNOWN_CONTEXT");
  const quantizeInvalidArguments = parseToolError(
    await facadeCall({
      name: "sv_quantize_notes",
      arguments: { contextId: "ctx_smoke", grid: { division: "1/8T" }, swing: 0.3 },
    })
  );
  assert.equal(quantizeInvalidArguments.error.code, "INVALID_ARGUMENTS");
  // v0.8.0：调内和声规划器（纯内存服务，未知 context 结构化报错）。
  const harmonyResource = await client.readResource({
    uri: "svcopilot://schemas/sv_generate_harmony",
  });
  assert.ok(harmonyResource.contents[0].text.length < MAX_SCHEMA_RESOURCE_CHARS);
  const harmonySchema = parseResource(harmonyResource).inputSchema;
  const harmonyInterval = harmonySchema.properties.harmony.properties.interval;
  // v0.9.0：interval 接受旧字符串名或广义 {degree,direction,octaveOffset} 对象。
  assert.deepEqual(harmonyInterval.anyOf[0].enum, [
    "third_below",
    "third_above",
    "sixth_below",
    "sixth_above",
  ]);
  assert.deepEqual(harmonyInterval.anyOf[1].properties.degree.enum, [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(harmonyInterval.anyOf[1].properties.direction.enum, ["above", "below"]);
  assert.deepEqual(harmonySchema.properties.lyricsMode.enum, ["copy", "sustain"]);
  const harmonyUnknownContext = parseToolError(
    await facadeCall({
      name: "sv_generate_harmony",
      arguments: {
        contextId: "ctx_smoke_missing",
        targetOccurrenceId: "ctx_smoke_missing:t:1:r:0",
        harmony: { interval: "third_below" },
      },
    })
  );
  assert.equal(harmonyUnknownContext.error.code, "UNKNOWN_CONTEXT");
  const harmonyInvalidArguments = parseToolError(
    await facadeCall({
      name: "sv_generate_harmony",
      arguments: {
        contextId: "ctx_smoke",
        targetOccurrenceId: "ctx_smoke:t:1:r:0",
        harmony: { interval: "fifth_below" },
      },
    })
  );
  assert.equal(harmonyInvalidArguments.error.code, "INVALID_ARGUMENTS");
  // 同样先解 $ref 再穿透：range/from/anchor 都是被提到 $defs 的共享片段。
  const batchCurveItem = deref(
    deref(batchSchema.properties.curves, batchSchema).items,
    batchSchema
  );
  const batchRangeFrom = deref(
    deref(batchCurveItem.properties.range, batchSchema).properties.from,
    batchSchema
  );
  assert.equal(deref(batchRangeFrom.properties.anchor, batchSchema).type, "object");
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
  assert.ok(
    resourceTemplates.resourceTemplates.some(
      (template) => template.uriTemplate === "svcopilot://guide/music-workflows/{recipe}"
    )
  );
  // 工作流指南：目录页 + 逐 recipe 读取，并确认每个 recipe 的工具名都真实存在。
  const guideResource = await client.readResource({
    uri: "svcopilot://guide/music-workflows",
  });
  const guide = parseResource(guideResource);
  console.log("[client] workflow guide index chars", guideResource.contents[0].text.length);
  assert.ok(guideResource.contents[0].text.length < MAX_SCHEMA_RESOURCE_CHARS);
  assert.equal(guide.interfaceVersion, "0.9.0");
  assert.ok(guide.recipes.length >= 8);
  const facadeNames = new Set(listed.tools.map((tool) => tool.name));
  for (const summary of guide.recipes) {
    const recipe = parseResource(await client.readResource({ uri: summary.uri }));
    assert.equal(recipe.recipe.id, summary.id);
    for (const step of recipe.recipe.steps) {
      // 指南必须给出可直接调用的 facade 名与其 operation，而不是内部 handler 名。
      assert.ok(
        facadeNames.has(step.tool),
        `guide recipe ${summary.id} names unknown facade ${step.tool}`
      );
      assert.equal(step.arguments.operation, step.operation);
    }
  }
  const apiClass = parseResource(await client.readResource({ uri: "svapi://class/Note" }));
  assert.equal(apiClass.class.name, "Note");

  const search = parseToolResult(
    await facadeCall({ name: "sv_search_api", arguments: { query: "setLyrics" } })
  );
  assert.ok(search.results.some((result) => result.className === "Note"));
  const description = parseToolResult(
    await facadeCall({
      name: "sv_describe",
      arguments: { class: "Automation", method: "remove" },
    })
  );
  assert.equal(description.overloads.length, 2);

  const ping = parseToolResult(await facadeCall({ name: "sv_ping", arguments: {} }));
  console.log("[client] sv_ping ->", ping);

  const roots = parseToolResult(await facadeCall({ name: "sv_root", arguments: {} }));
  const projectHandle = roots.project.__handle__;
  console.log("[client] sv_root.project ->", roots.project);
  assert.equal(roots.project.__type__, "Project");

  const workflow = parseToolResult(
    await facadeCall({
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
  assert.equal(okOf(workflow), true);
  assert.equal(workflow.exports.name, "Pipe Vocal");
  assert.deepEqual(workflow.handleOwnership.returnedHandles, []);
  assert.equal(workflow.handleOwnership.callerMustFree, false);

  const legacyReturn = parseToolError(
    await facadeCall({
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
    await facadeCall({
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
    await facadeCall({
      name: "sv_free",
      arguments: { handle: retainedNote },
    })
  );
  const handlesAfterFree = parseResource(
    await client.readResource({ uri: "svcopilot://capabilities" })
  ).connection.knownHandleCount;
  assert.equal(handlesAfterFree, handlesBeforeRetain);

  const projectPage = parseToolResult(
    await facadeCall({
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
    await facadeCall({
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
    await facadeCall({
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
    await facadeCall({
      name: "sv_set_lyrics",
      arguments: {
        contextId: selectionSnapshot.contextId,
        lyrics: ["さ", "よ"],
        waitFor: "phonemes",
        timeoutMs: 1000,
      },
    })
  );
  assert.equal(okOf(lyricEdit), true);
  assert.equal(lyricEdit.effects, "verified");
  assert.equal(lyricEdit.data.processedNotes, 2);
  assert.equal(lyricEdit.data.actuallyChangedNotes, 2);
  assert.equal(lyricEdit.data.processing.state, "ready");
  assert.equal(lyricEdit.data.processing.evidence.expectedNotes, 2);
  assert.deepEqual(lyricEdit.verification.evidence.observedLyrics, ["さ", "よ"]);
  assert.equal(lyricEdit.undo.boundaryCallsCompleted, 2);

  const editedSnapshot = parseToolResult(
    await facadeCall({
      name: "sv_snapshot",
      arguments: { scope: { kind: "selection" }, include: ["notes"] },
    })
  );
  assert.deepEqual(
    editedSnapshot.data.notes.map((note) => note.lyrics),
    ["さ", "よ"]
  );

  const verifiedWrite = parseToolResult(
    await facadeCall({
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
  assert.equal(okOf(verifiedWrite), true);
  assert.equal(verifiedWrite.effects, "verified");
  assert.ok(!verifiedWrite.warnings.some((warning) => warning.code === "UNVERIFIED_WRITE"));

  // sv_patch_notes 公开契约：dry-run 无副作用，真实写入带补偿语义与逐项读回。
  const patchTool = served.get("sv_patch_notes");
  assert.equal(patchTool.inputSchema.properties.atomic.default, true);
  assert.equal(patchTool.inputSchema.properties.dryRun.default, false);
  assert.ok(patchTool.inputSchema.properties.patches.items.properties.set.properties.detuneCents);

  const patchSnapshot = parseToolResult(
    await facadeCall({
      name: "sv_snapshot",
      arguments: { scope: { kind: "selection" } },
    })
  );
  const patchArguments = {
    contextId: patchSnapshot.contextId,
    patches: [
      {
        note: 0,
        expected: { lyrics: "さ" },
        set: { lyrics: "ら", pitch: 61, detuneCents: -8 },
      },
    ],
    waitFor: "phonemes",
    timeoutMs: 1000,
  };
  const patchPlan = parseToolResult(
    await facadeCall({
      name: "sv_patch_notes",
      arguments: { ...patchArguments, dryRun: true },
    })
  );
  assert.equal(okOf(patchPlan), true);
  assert.equal(patchPlan.status, "dry_run");
  assert.equal(patchPlan.effects, "none");
  assert.equal(patchPlan.data.plannedDiff.length, 3);
  assert.equal(patchPlan.data.plannedChangedNotes, 1);

  const patchApplied = parseToolResult(
    await facadeCall({ name: "sv_patch_notes", arguments: patchArguments })
  );
  assert.equal(okOf(patchApplied), true);
  assert.equal(patchApplied.status, "succeeded");
  assert.equal(patchApplied.effects, "verified");
  assert.equal(patchApplied.atomicity, "verified_compensation");
  assert.equal(patchApplied.rollback.attempted, false);
  assert.equal(patchApplied.data.actuallyChangedNotes, 1);
  assert.equal(patchApplied.undo.boundaryCallsCompleted, 2);
  assert.equal(patchApplied.verification.passed, true);
  assert.equal(patchApplied.verification.evidence.observed[0].lyrics, "ら");
  assert.equal(patchApplied.verification.evidence.observed[0].detuneCents, -8);
  assert.equal(patchApplied.data.processing.state, "ready");

  const patchedSnapshot = parseToolResult(
    await facadeCall({
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
    await facadeCall({
      name: "sv_patch_notes",
      arguments: {
        contextId: patchedSnapshot.contextId,
        patches: [
          { note: 0, expected: { lyrics: "さ" }, set: { lyrics: "x" } },
        ],
      },
    })
  );
  assert.equal(okOf(patchConflict), false);
  assert.equal(patchConflict.error.code, "EXPECTED_MISMATCH");
  assert.equal(patchConflict.effects, "none");

  // sv_snapshot_range 公开契约：bar/beat 双坐标、meter/tempo map、mixer 和 sinceToken。
  const rangeSnapshot = parseToolResult(
    await facadeCall({
      name: "sv_snapshot_range",
      arguments: {
        scope: { kind: "range", trackIndices: [0], from: { bar: 1 }, to: { bar: 2 } },
        include: ["notes", "tempoMap", "meterMap", "mixer", "retakes"],
      },
    })
  );
  assert.equal(okOf(rangeSnapshot), true);
  assert.match(rangeSnapshot.contextId, /^c_[A-Za-z0-9_-]{16}$/);
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
  assert.match(rangeSnapshot.data.tracks[0].groups[0].occurrenceId, /^c_/);
  // §3.1/§8.1 的稳定身份：ordinal 索引完整 occurrences 数组；groupNoteCount 是宿主里
  // 该 NoteGroup 的真实总数，capturedNotes 是本次 range 捕获到的数量。两者分开，
  // 因为「index 越界」与「index 未捕获」需要不同的补救动作。
  const firstGroup = rangeSnapshot.data.tracks[0].groups[0];
  assert.equal(firstGroup.occurrence, 0);
  assert.equal(typeof firstGroup.groupNoteCount, "number");
  assert.equal(typeof firstGroup.capturedNotes, "number");
  assert.ok(firstGroup.capturedNotes <= firstGroup.groupNoteCount);
  assert.match(rangeSnapshot.data.notes[0].id, /:n:0$/);
  assert.ok(Number.isFinite(rangeSnapshot.timings.serviceTotalMs));
  assert.ok(rangeSnapshot.artifactRef);
  const rangeArtifactResource = await client.readResource({
    uri: rangeSnapshot.artifactRef.resourceUri,
  });
  assert.equal(
    rangeArtifactResource.contents[0].text,
    JSON.stringify(JSON.parse(rangeArtifactResource.contents[0].text))
  );
  const rangeArtifact = parseResource(rangeArtifactResource);
  assert.equal(rangeArtifact.contentHash, rangeSnapshot.artifactRef.contentHash);
  assert.equal(rangeArtifact.access.mode, "inline");
  assert.equal(rangeArtifact.payload.data.notes.encoding, "dense-table-v1");
  assert.equal(rangeArtifact.payload.data.automation.length, 0);
  const firstArtifactPage = parseResource(
    await client.readResource({ uri: rangeSnapshot.artifactRef.firstPageUri })
  );
  assert.equal(firstArtifactPage.artifact.contentHash, rangeSnapshot.artifactRef.contentHash);
  assert.equal(firstArtifactPage.page.encoding, "json-utf8-fragment");
  assert.ok(firstArtifactPage.page.bytesReturned > 0);
  assert.ok(firstArtifactPage.page.bytesReturned <= 8 * 1024);
  const releasedArtifact = parseToolResult(
    await facadeCall({
      name: "sv_release_artifact",
      arguments: { artifactId: rangeSnapshot.artifactRef.artifactId },
    })
  );
  assert.equal(releasedArtifact.released, true);
  await assert.rejects(
    client.readResource({ uri: rangeSnapshot.artifactRef.resourceUri }),
    /ARTIFACT_NOT_FOUND/
  );

  const rangeProcessing = parseToolResult(
    await facadeCall({
      name: "sv_wait_for_processing",
      arguments: {
        contextId: rangeSnapshot.contextId,
        occurrenceId: rangeSnapshot.data.tracks[0].groups[0].occurrenceId,
        kind: "phonemes",
        timeoutMs: 0,
      },
    })
  );
  assert.equal(okOf(rangeProcessing), true);
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
    await facadeCall({
      name: "sv_patch_notes",
      arguments: {
        contextId: rangeSnapshot.contextId,
        occurrenceId: rangeOccurrenceId,
        allowSharedTargetMutation: true,
        patches: [
          {
            note: rangeNote.indexInGroup,
            expected: { lyrics: rangeNote.lyrics },
            set: { lyrics: "仮" },
          },
        ],
        dryRun: true,
        waitFor: "none",
      },
    })
  );
  assert.equal(okOf(rangePatchPlan), true);
  assert.equal(rangePatchPlan.status, "dry_run");
  assert.equal(rangePatchPlan.effects, "none");
  assert.equal(rangePatchPlan.data.plannedChangedNotes, 1);

  const rangeStructurePlan = parseToolResult(
    await facadeCall({
      name: "sv_restructure_notes",
      arguments: {
        contextId: rangeSnapshot.contextId,
        occurrenceId: rangeOccurrenceId,
        allowSharedTargetMutation: true,
        operations: [
          {
            op: "split",
            noteIndex: rangeNote.indexInGroup,
            atBlick: rangeNote.onsetBlick + Math.floor(rangeNote.durationBlick / 2),
          },
        ],
        dryRun: true,
        waitFor: "none",
      },
    })
  );
  assert.equal(okOf(rangeStructurePlan), true);
  assert.equal(rangeStructurePlan.status, "dry_run");
  assert.equal(rangeStructurePlan.effects, "none");
  assert.equal(rangeStructurePlan.data.initialNoteCount, 2);
  assert.equal(rangeStructurePlan.data.expectedNoteCount, 3);

  const invalidRangeArguments = parseToolError(
    await facadeCall({
      name: "sv_snapshot_range",
      arguments: {
        scope: { kind: "range", trackIndices: [0], from: { bar: 1 }, to: { bar: 2 } },
        responseMod: "compact",
        definitelyUnknownOption: true,
      },
    })
  );
  assert.equal(okOf(invalidRangeArguments), false);
  assert.equal(invalidRangeArguments.error.code, "INVALID_ARGUMENTS");
  assert.match(invalidRangeArguments.error.message, /responseMod/);

  const anchorDryRun = parseToolResult(
    await facadeCall({
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
                anchor: { note: 0, position: "onset" },
                value: 1,
              },
              {
                anchor: {
                  note: 0,
                  position: "ratio",
                  ratio: 0.5,
                },
                value: 1.5,
              },
              {
                anchor: {
                  note: 1,
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
    await facadeCall({
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
    await facadeCall({
      name: "sv_snapshot_range",
      arguments: { cursor: rangeAgain.page.detailCursor },
    })
  );
  assert.equal(refreshedRangeIdentity.contextId, rangeAgain.contextId);
  assert.match(refreshedRangeIdentity.data.notes[0].id, new RegExp(`^${rangeAgain.contextId}`));

  // 参数曲线：读取（双坐标 + definition），replace 写入 + 精确读回验证。
  const curve = parseToolResult(
    await facadeCall({
      name: "sv_get_parameter_curve",
      arguments: {
        target: { trackIndex: 0, groupIndex: 0 },
        parameter: "loudness",
        range: { fromBlick: 0, toBlick: 2 * Q },
      },
    })
  );
  assert.equal(okOf(curve), true);
  assert.deepEqual(curve.data.definition.range, [-24, 24]);
  assert.equal(curve.data.interpolationMethod, "Linear");
  assert.equal(curve.data.stats.count, 2);
  assert.equal(curve.data.points[1].localBlick, Q);

  // 单数 sv_patch_parameter_curve 已删除；一条曲线就是 curves 长度为 1。
  const curvePatch = parseToolResult(
    await facadeCall({
      name: "sv_patch_parameter_curves",
      arguments: {
        target: { trackIndex: 0, groupIndex: 0, allowSharedTargetMutation: true },
        curves: [
          {
            parameter: "loudness",
            mode: "replace",
            range: { fromBlick: 0, toBlick: 2 * Q },
            points: [
              { blick: 0, value: 2 },
              { blick: Q, value: -3 },
            ],
          },
        ],
      },
    })
  );
  assert.equal(okOf(curvePatch), true);
  assert.equal(curvePatch.status, "succeeded");
  assert.equal(curvePatch.effects, "verified");
  assert.equal(curvePatch.curves[0].verification.mode, "exact");
  assert.equal(curvePatch.curves[0].after.pointCount, 2);
  assert.equal(curvePatch.curves[0].after.stats.min, -3);

  // 批量工具必须经过真实 MCP + IO PIPE 路径完成预检、写入和内建回读验证。
  const batchCurvePatch = parseToolResult(
    await facadeCall({
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
  assert.equal(okOf(batchCurvePatch), true);
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
    await facadeCall({
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
  assert.equal(okOf(typoCurvePatch), false);
  assert.equal(typoCurvePatch.effects, "none");
  assert.equal(typoCurvePatch.error.code, "UNKNOWN_PARAMETER");
  assert.equal(typoCurvePatch.curves[0].requestedParameter, "pitchDelt");
  assert.equal(typoCurvePatch.curves[0].resolvedParameter, null);

  const duplicateCurvePatch = parseToolError(
    await facadeCall({
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
    await facadeCall({
      name: "sv_patch_parameter_curves",
      arguments: {
        target: { trackIndex: 0, groupIndex: 0, allowSharedTargetMutation: true },
        curves: [
          {
            parameter: "loudness",
            mode: "replace",
            range: { fromBlick: 0, toBlick: Q },
            points: [{ blick: 0, value: 999 }],
          },
        ],
      },
    })
  );
  assert.equal(curveOutOfRange.error.code, "VALUE_OUT_OF_RANGE");

  // 结构操作：split → merge 回原状，insert → delete 往返，全部走真实 pipe。
  const structureSnapshot = parseToolResult(
    await facadeCall({ name: "sv_snapshot", arguments: { scope: { kind: "selection" } } })
  );
  const splitResult = parseToolResult(
    await facadeCall({
      name: "sv_restructure_notes",
      arguments: {
        contextId: structureSnapshot.contextId,
        waitFor: "none",
        operations: [
          { op: "split", noteIndex: 0, atBlick: 352800 },
        ],
      },
    })
  );
  assert.equal(okOf(splitResult), true);
  assert.equal(splitResult.status, "succeeded");
  assert.equal(splitResult.data.finalNoteCount, 3);
  assert.equal(splitResult.atomicity, "verified_compensation");

  const afterSplit = parseToolResult(
    await facadeCall({
      name: "sv_snapshot",
      arguments: { scope: { kind: "selection" }, include: ["notes"] },
    })
  );
  assert.deepEqual(
    afterSplit.data.notes.map((note) => note.lyrics),
    ["ら", "-", "よ"]
  );

  const mergeResult = parseToolResult(
    await facadeCall({
      name: "sv_restructure_notes",
      arguments: {
        contextId: afterSplit.contextId,
        waitFor: "none",
        operations: [
          {
            op: "merge",
            notes: [0, 1],
            lyricsJoin: "first",
          },
        ],
      },
    })
  );
  assert.equal(okOf(mergeResult), true);
  assert.equal(mergeResult.data.finalNoteCount, 2);

  const insertSnapshot = parseToolResult(
    await facadeCall({ name: "sv_snapshot", arguments: { scope: { kind: "selection" } } })
  );
  assert.deepEqual(
    insertSnapshot.data.notes.map((note) => [note.lyrics, note.durationBlick]),
    [
      ["ら", Q],
      ["よ", Q],
    ]
  );
  const insertResult = parseToolResult(
    await facadeCall({
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
  assert.equal(okOf(insertResult), true);
  assert.equal(insertResult.data.appliedOperations[0].indexInGroup, 2);

  const deleteSnapshot = parseToolResult(
    await facadeCall({ name: "sv_snapshot", arguments: { scope: { kind: "selection" } } })
  );
  const deleteResult = parseToolResult(
    await facadeCall({
      name: "sv_restructure_notes",
      arguments: {
        contextId: deleteSnapshot.contextId,
        waitFor: "none",
        operations: [
          {
            op: "delete",
            noteIndex: 2,
            expected: { lyrics: "ん" },
          },
        ],
      },
    })
  );
  assert.equal(okOf(deleteResult), true);
  assert.equal(deleteResult.data.finalNoteCount, 2);

  const autoAudition = parseToolResult(
    await facadeCall({
      name: "sv_start_audition",
      arguments: { fromBlick: 0, toBlick: Q, loop: false, autoStop: true },
    })
  );
  assert.equal(autoAudition.data.endPolicy, "auto_stop");
  await new Promise((resolve) => setTimeout(resolve, 650));
  const autoAuditionDone = parseToolResult(
    await facadeCall({
      name: "sv_get_audition",
      arguments: { auditionId: autoAudition.data.auditionId },
    })
  );
  // 根 status 走冻结矩阵；audition 的状态机取值留在 data.state（计划 §4.5/§10.7）。
  assert.equal(autoAuditionDone.status, "succeeded");
  assert.ok(["restored", "stopped_by_user"].includes(autoAuditionDone.data.state));
  assert.ok(Number.isFinite(autoAuditionDone.data.autoStop.timerDelayMs));

  // 试听闭环：start（solo + loop）→ get → stop（恢复 solo 与 playhead）。
  const auditionStart = parseToolResult(
    await facadeCall({
      name: "sv_start_audition",
      arguments: { fromBlick: 0, toBlick: 4 * Q, soloTrackIndices: [0], loop: true },
    })
  );
  assert.equal(okOf(auditionStart), true);
  assert.equal(auditionStart.data.playbackStatus, "looping");
  assert.equal(auditionStart.data.range.toSeconds, 2);
  assert.equal(auditionStart.data.recovery.savedPlayheadSeconds, 2.5);
  assert.equal(auditionStart.data.recovery.mixerChanges[0].previousValue, false);

  const auditionStatus = parseToolResult(
    await facadeCall({
      name: "sv_get_audition",
      arguments: { auditionId: auditionStart.data.auditionId },
    })
  );
  assert.equal(auditionStatus.data.playbackStatus, "looping");

  const auditionStop = parseToolResult(
    await facadeCall({
      name: "sv_stop_audition",
      arguments: { auditionId: auditionStart.data.auditionId },
    })
  );
  assert.equal(okOf(auditionStop), true);
  assert.equal(auditionStop.status, "succeeded");
  assert.equal(auditionStop.data.playbackStatus, "stopped");
  assert.equal(auditionStop.data.playheadSeconds, 2.5);
  assert.equal(auditionStop.data.restoration[0].restored, true);
  assert.equal(auditionStop.data.restoration[0].observedAfterRestore, false);

  // voice 降级接口：可观测参数 + 明确 unobservable；clone track 带读回验证。
  const voiceProfile = parseToolResult(
    await facadeCall({
      name: "sv_get_voice_profile",
      arguments: { trackIndex: 0 },
    })
  );
  assert.equal(okOf(voiceProfile), true);
  assert.equal(voiceProfile.data.groups[0].voice.identityStatus, "unobservable");
  assert.equal(voiceProfile.data.groups[0].voice.parameters.paramTension, 0);
  assert.equal(voiceProfile.data.capabilities.singerIdentity, "unobservable");

  const clonedTrack = parseToolResult(
    await facadeCall({
      name: "sv_clone_track_from_template",
      arguments: { templateTrackIndex: 0, name: "Pipe Harmony" },
    })
  );
  assert.equal(okOf(clonedTrack), true);
  assert.equal(clonedTrack.status, "succeeded");
  assert.equal(clonedTrack.data.newTrackIndex, 3);
  assert.equal(clonedTrack.data.trackCountAfter, 4);
  assert.equal(clonedTrack.data.name, "Pipe Harmony");
  assert.equal(clonedTrack.data.identityPreservation, "host_opaque");

  const note = parseToolResult(
    await facadeCall({ name: "sv_call", arguments: { method: "create", args: ["Note"] } })
  );
  assert.equal(note.__type__, "Note");
  // 预检把版本和方法存在性都交给权威宿主，调用被转发；harness 的 Note 没有实现
  // getRapAccent，所以拿到的是宿主自己的 "no such method"。
  const versionDeferred = await facadeCall({
    name: "sv_call",
    arguments: { handle: note.__handle__, method: "getRapAccent", args: [] },
  });
  assert.equal(versionDeferred.isError, true);
  // 宿主原文只在 structuredContent 里；content[0].text 现在只是状态摘要行。
  assert.equal(versionDeferred.structuredContent.error.code, "UNKNOWN_METHOD");
  assert.match(versionDeferred.structuredContent.error.message ?? "", /no such method/);

  parseToolResult(
    await facadeCall({ name: "sv_free", arguments: { handle: note.__handle__ } })
  );
  const released = parseToolError(
    await facadeCall({
      name: "sv_call",
      arguments: { handle: note.__handle__, method: "getDetune", args: [] },
    })
  );
  assert.equal(released.error.code, "UNKNOWN_HANDLE");

  const fileName = parseToolResult(
    await facadeCall({
      name: "sv_call",
      arguments: { handle: projectHandle, method: "getFileName", args: [] },
    })
  );
  console.log("[client] project:getFileName ->", fileName);

  const trackCount = parseToolResult(
    await facadeCall({
      name: "sv_call",
      arguments: { handle: projectHandle, method: "getNumTracks", args: [] },
    })
  );
  console.log("[client] project:getNumTracks ->", trackCount);

  const quarter = parseToolResult(
    await facadeCall({ name: "sv_index", arguments: { field: "QUARTER" } })
  );
  console.log("[client] SV.QUARTER ->", quarter);

  // setLyrics 不是 Project 的方法(不在 Project 的 manifest 条目里)。预检交给宿主,
  // 转发后由宿主报告 "no such method"。
  const methodDeferred = await facadeCall({
    name: "sv_call",
    arguments: { handle: projectHandle, method: "setLyrics", args: ["la"] },
  });
  assert.equal(methodDeferred.isError, true);
  // 宿主原文只在 structuredContent 里；content[0].text 现在只是状态摘要行。
  assert.match(methodDeferred.structuredContent.error.message ?? "", /no such method/);
  assert.equal(parseToolError(methodDeferred).error.code, "UNKNOWN_METHOD");

  const unknownField = parseToolError(
    await facadeCall({ name: "sv_index", arguments: { field: "MISSING" } })
  );
  assert.equal(unknownField.error.code, "UNKNOWN_FIELD");

  // 标量结果在 structuredContent 里统一包装成 { result }，因为 MCP 的
  // structuredContent 必须是对象。
  assert.equal(ping.result, "pong");
  assert.equal(fileName.result, "PipeProject");
  // 前面的 sv_clone_track_from_template 已把轨道数从 3 增加到 4。
  assert.equal(trackCount.result, 4);
  assert.equal(quarter.result, Q);

  console.log("[client] smoke test passed");
} finally {
  await client.close().catch(() => {});
  if (bridge && bridge.exitCode === null) {
    try {
      await waitForExit(bridge);
    } catch {
      bridge.kill();
    }
  }
}
