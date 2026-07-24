import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";
import AjvModule from "../server/node_modules/ajv/dist/ajv.js";

import { ExpressionPlanService } from "../server/src/expression-plan.js";
import { LyricAlignService } from "../server/src/lyric-align.js";
import { SnapshotStore } from "../server/src/snapshot.js";

// 跨层契约回归：规划器（sv_plan_expression / sv_align_lyrics）产出的 applyRequests /
// patchRequest 必须能通过真实 MCP 服务器对下游工具公布的 inputSchema——
// 规划器新增字段（如 target.expectedNotes）而 index.js schema 未同步时，客户端会在
// 提交阶段收到 schema 拒绝，这个测试让该漂移在 npm test 就失败。
// 服务器不带 Lua bridge 启动：tools/list 不需要宿主连接。

const Ajv = AjvModule.default ?? AjvModule;
const Q = 705600000;
const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverScript = path.resolve(testDir, "..", "server", "src", "index.js");

function createStoredContext(store, notes) {
  const stored = store.create({
    epoch: 1,
    scope: { kind: "range" },
    observedAt: new Date(1000).toISOString(),
    context: { kind: "range", occurrences: [] },
  });
  const occurrenceId = `${stored.contextId}:t:0:r:0`;
  stored.context.occurrences.push({
    occurrenceId,
    trackIndex: 0,
    groupIndex: 0,
    targetGroupUuid: "uuid-schema-test",
    timeOffsetBlick: 0,
    pitchOffsetSemitone: 0,
    sharedTargetOccurrences: [occurrenceId],
    noteFingerprints: notes.map((note, index) => ({
      indexInGroup: index,
      onsetBlick: note.onsetBlick,
      durationBlick: note.durationBlick,
      pitch: note.pitch ?? 60,
      lyrics: note.lyrics ?? "",
      phonemesOverride: "",
      languageOverride: "",
      detuneCents: 0,
      noteId: `${occurrenceId}:n:${index}`,
    })),
  });
  stored.context.quarterBlick = Q;
  stored.context.meterMarks = [{ position: 0, positionBlick: 0, numerator: 4, denominator: 4 }];
  stored.context.tempoMarks = [{ positionBlick: 0, positionSeconds: 0, bpm: 120 }];
  stored.snapshotToken = `snap_${stored.contextId}`;
  return { stored, occurrenceId };
}

async function fetchServedSchemas(toolNames) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverScript],
    env: { ...process.env, SV_COPILOT_SESSION: `plan-schema-${process.pid}-${Date.now()}` },
    cwd: path.dirname(serverScript),
    stderr: "pipe",
  });
  const client = new Client({ name: "plan-apply-schema-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const schemas = {};
    for (const name of toolNames) {
      const tool = listed.tools.find((item) => item.name === name);
      assert.ok(tool, `server must expose ${name}`);
      schemas[name] = tool.inputSchema;
    }
    return schemas;
  } finally {
    await client.close().catch(() => {});
  }
}

function compile(schema) {
  // 与 index.js 相同的 Ajv 配置，确保这里的判定与服务器端一致。
  const ajv = new Ajv({ allErrors: true, strict: false, discriminator: true });
  return ajv.compile(schema);
}

function assertValid(validate, payload, label) {
  const valid = validate(payload);
  assert.ok(
    valid,
    `${label} must pass the served inputSchema; errors: ${JSON.stringify(validate.errors)}`
  );
}

test("planner outputs validate against the schemas the real server serves", async () => {
  const schemas = await fetchServedSchemas(["sv_patch_parameter_curves", "sv_patch_notes"]);
  const validateCurves = compile(schemas.sv_patch_parameter_curves);
  const validatePatches = compile(schemas.sv_patch_notes);

  // sv_plan_expression → sv_patch_parameter_curves（含 F1 的 target.expectedNotes 漂移守卫）。
  const planStore = new SnapshotStore({ now: () => 1000 });
  const planContext = createStoredContext(planStore, [
    { onsetBlick: 0, durationBlick: Q, pitch: 60, lyrics: "when" },
    { onsetBlick: Q, durationBlick: 3 * Q, pitch: 66, lyrics: "see" },
    { onsetBlick: 6 * Q, durationBlick: Q, pitch: 62, lyrics: "あ" },
  ]);
  const plan = await new ExpressionPlanService({ store: planStore, now: () => 2000 }).plan({
    contextId: planContext.stored.contextId,
    intent: { technique: ["controlled_belt"], emotion: "cool_anger", section: "chorus" },
  });
  assert.ok(plan.applyRequests.length >= 1);
  for (const request of plan.applyRequests) {
    assert.equal(request.tool, "sv_patch_parameter_curves");
    assert.ok(Array.isArray(request.arguments.target.expectedNotes));
    assertValid(validateCurves, request.arguments, "sv_plan_expression applyRequest");
  }

  // sv_align_lyrics → sv_patch_notes（F2：>200 时单可提交批 + continuation，绝不预烤死批次）。
  const lyricStore = new SnapshotStore({ now: () => 1000 });
  const count = 201;
  const lyricContext = createStoredContext(
    lyricStore,
    Array.from({ length: count }, (_, index) => ({
      onsetBlick: index * Q,
      durationBlick: Q,
    }))
  );
  const pool = "我你他她们的一二三四五六七八九十日月山川风花雪";
  const aligned = await new LyricAlignService({ store: lyricStore, now: () => 2000 }).align({
    contextId: lyricContext.stored.contextId,
    lyrics: Array.from({ length: count }, (_, index) => pool[index % pool.length]).join(""),
    language: "mandarin",
  });
  assert.equal(aligned.patchRequest.tool, "sv_patch_notes");
  assert.equal(aligned.patchRequest.arguments.patches.length, 200);
  assert.equal(aligned.continuation.remainingChangedCount, 1);
  assertValid(validatePatches, aligned.patchRequest.arguments, "sv_align_lyrics patchRequest");
});
