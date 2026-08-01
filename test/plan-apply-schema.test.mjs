import "./helpers/pipe-namespace.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";
import AjvModule from "../server/node_modules/ajv/dist/ajv.js";

import { ArtifactStore } from "../server/src/artifact-store.js";
import {
  DESCRIBE_OPERATION_TOOL,
  MAX_DESCRIBE_OPERATIONS,
} from "../server/src/compact-facade.js";
import { operationNameForTool } from "../server/src/operation-catalog.js";
import { encodeDense } from "../server/src/dense-codec.js";
import { ExpressionPlanService } from "../server/src/expression-plan.js";
import { HarmonyPlanService } from "../server/src/harmony-plan.js";
import { LyricAlignService } from "../server/src/lyric-align.js";
import { PitchGesturePlanService } from "../server/src/pitch-gesture-plan.js";
import { QuantizePlanService } from "../server/src/quantize-plan.js";
import { SnapshotStore } from "../server/src/snapshot.js";

// 跨层契约回归：规划器（sv_plan_expression / sv_align_lyrics）产出的 applyRequests /
// patchRequest 必须能通过真实 MCP 服务器对下游工具公布的 inputSchema——
// 规划器新增字段（如 target.expectedNotes）而 index.js schema 未同步时，客户端会在
// 提交阶段收到 schema 拒绝，这个测试让该漂移在 npm test 就失败。
// 服务器不带 Lua bridge 启动：sv_describe 不需要宿主连接。

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
  stored.context.occurrences.push({
    occurrence: 0,
    trackIndex: 0,
    groupIndex: 0,
    targetGroupUuid: "uuid-schema-test",
    timeOffsetBlick: 0,
    pitchOffsetSemitone: 0,
    groupNoteCount: notes.length,
    sharedTargetOccurrences: [0],
    noteFingerprints: notes.map((note, index) => ({
      indexInGroup: index,
      onsetBlick: note.onsetBlick,
      durationBlick: note.durationBlick,
      pitch: note.pitch ?? 60,
      lyrics: note.lyrics ?? "",
      phonemesOverride: "",
      languageOverride: "",
      detuneCents: 0,
    })),
  });
  stored.context.quarterBlick = Q;
  stored.context.meterMarks = [{ position: 0, positionBlick: 0, numerator: 4, denominator: 4 }];
  stored.context.tempoMarks = [{ positionBlick: 0, positionSeconds: 0, bpm: 120 }];
  stored.snapshotToken = `snap_${stored.contextId}`;
  return { stored };
}

// facade 是唯一 surface，direct tool 的 schema 不在 tools/list 里；
// 取 schema 的唯一途径就是模型自己会走的那条——sv_describe。
async function fetchServedSchemas(toolNames) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverScript],
    env: process.env,
    cwd: path.dirname(serverScript),
    stderr: "pipe",
  });
  const client = new Client({ name: "plan-apply-schema-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const schemas = {};
    // 每次最多请求 MAX_DESCRIBE_OPERATIONS 个，按批取完。响应还有字节预算：两份大
    // schema 会让第二个被 deferred，此时按它给出的 remedy 单独再取一次。
    const pending = [...toolNames];
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
          // 被推迟的必须如实出现在 deferred 里，而不是静默消失。
          assert.ok(
            deferred?.operations.some((item) => item.operation === operationNameForTool(name)),
            `server must expose ${name} or report it as deferred`
          );
          pending.push(name);
          continue;
        }
        schemas[name] = entry.inputSchema;
      }
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

test("served sv_patch_notes schema exposes diagnostics and scoped note references", async () => {
  const schemas = await fetchServedSchemas(["sv_patch_notes", "sv_compare_computed_pitch"]);
  const patchSchema = schemas.sv_patch_notes;
  assert.deepEqual(patchSchema.properties.diagnostics, {
    type: "boolean",
    default: false,
    description:
      "Add phase timings and aggregate host method counts. Does not log arguments or musical values and does not change write/Undo behavior.",
  });
  assert.equal(
    Object.hasOwn(schemas.sv_compare_computed_pitch.properties, "diagnostics"),
    false
  );

  const validate = compile(patchSchema);
  assert.equal(
    validate({
      contextId: "ctx_test",
      occurrence: 0,
      patches: [{ note: 0, set: { lyrics: "test" } }],
      dryRun: true,
      diagnostics: true,
    }),
    true,
    JSON.stringify(validate.errors)
  );
});

test("all nine occurrence-facing tools expose ordinal-only public schemas", async () => {
  const schemas = await fetchServedSchemas([
    "sv_wait_for_processing",
    "sv_align_lyrics",
    "sv_quantize_notes",
    "sv_generate_harmony",
    "sv_get_parameter_curve",
    "sv_patch_parameter_curves",
    "sv_plan_pitch_gesture",
    "sv_bake_computed_pitch",
    "sv_set_selection",
  ]);
  const assertOrdinal = (schema, label) => {
    assert.deepEqual(
      { type: schema.type, minimum: schema.minimum },
      { type: "integer", minimum: 0 },
      label
    );
  };

  for (const name of [
    "sv_wait_for_processing",
    "sv_align_lyrics",
    "sv_quantize_notes",
    "sv_plan_pitch_gesture",
    "sv_bake_computed_pitch",
    "sv_set_selection",
  ]) {
    assertOrdinal(schemas[name].properties.occurrence, `${name}.occurrence`);
    assert.equal(schemas[name].properties.occurrenceId, undefined, name);
  }
  for (const name of ["sv_get_parameter_curve", "sv_patch_parameter_curves"]) {
    const target = schemas[name].properties.target;
    assertOrdinal(target.properties.occurrence, `${name}.target.occurrence`);
    assert.equal(target.properties.occurrenceId, undefined, name);
  }
  const harmony = schemas.sv_generate_harmony;
  assertOrdinal(harmony.properties.sourceOccurrence, "sv_generate_harmony.sourceOccurrence");
  assertOrdinal(harmony.properties.targetOccurrence, "sv_generate_harmony.targetOccurrence");
  assert.ok(harmony.required.includes("targetOccurrence"));
  for (const removed of ["occurrenceId", "sourceOccurrenceId", "targetOccurrenceId"]) {
    assert.equal(harmony.properties[removed], undefined, removed);
  }
});

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

test("served mutation schemas accept only an explicit planRef execution action", async () => {
  const schemas = await fetchServedSchemas([
    "sv_patch_notes",
    "sv_patch_parameter_curves",
    "sv_patch_pitch_controls",
    "sv_restructure_notes",
  ]);
  // planRef 是裸 artifactId 字符串（§4.3）。
  const reference = "a_schemaExample";

  for (const [toolName, schema] of Object.entries(schemas)) {
    const validate = compile(schema);
    assertValid(
      validate,
      { planRef: reference, action: "dry_run" },
      `${toolName} planRef dry_run`
    );
    assertValid(
      validate,
      { planRef: reference, action: "commit" },
      `${toolName} planRef commit`
    );
    assert.equal(
      validate({ planRef: reference }),
      false,
      `${toolName} must reject an implicit execution action`
    );
    assert.equal(
      validate({ planRef: reference, action: "dry_run", bogus: true }),
      false,
      `${toolName} must reject unknown planRef wrapper fields`
    );
    // 旧的对象形状必须被拒绝，否则"裸字符串"只是文档说法。
    assert.equal(
      validate({ planRef: { artifactId: reference }, action: "dry_run" }),
      false,
      `${toolName} must reject the legacy planRef object`
    );
  }
});

test("served curve schemas accept dense-table-v1 points on batch and phrase writes", async () => {
  const schemas = await fetchServedSchemas(["sv_patch_parameter_curves", "sv_edit_phrase"]);
  const points = encodeDense(
    [
      { blick: 0, value: 0.2 },
      { blick: Q, value: 0.8 },
    ],
    {
      schemaVersion: "1",
      columns: [
        { name: "blick", type: "integer", encoding: "delta" },
        { name: "value", type: "number" },
      ],
    }
  );
  const target = { contextId: "ctx_dense", occurrence: 0 };
  const curve = {
    parameter: "tension",
    mode: "replace",
    range: { fromBlick: 0, toBlick: Q },
    points,
  };
  assertValid(
    compile(schemas.sv_patch_parameter_curves),
    { target, curves: [curve] },
    "batch curve dense points"
  );
  assertValid(
    compile(schemas.sv_edit_phrase),
    { target, curves: [curve] },
    "phrase curve dense points"
  );
});

// P0-D 统一信封：通用消费者只读 apply.tool + apply.arguments 就能提交，不需要知道
// 自己在跟哪个规划器说话。这里对四个规划器跑同一段泛型代码。
function harmonyContext(store) {
  const stored = store.create({
    epoch: 1,
    scope: { kind: "range" },
    observedAt: new Date(1000).toISOString(),
    context: { kind: "range", occurrences: [] },
  });
  const fingerprint = (note, index) => ({
    indexInGroup: index,
    onsetBlick: note.onsetBlick,
    durationBlick: note.durationBlick,
    pitch: note.pitch,
    lyrics: note.lyrics,
    phonemesOverride: "",
    languageOverride: "",
    detuneCents: 0,
  });
  const sourceNotes = [
    { onsetBlick: 0, durationBlick: Q, pitch: 69, lyrics: "a" },
    { onsetBlick: Q, durationBlick: Q, pitch: 71, lyrics: "b" },
    { onsetBlick: 2 * Q, durationBlick: Q, pitch: 72, lyrics: "c" },
    { onsetBlick: 3 * Q, durationBlick: Q, pitch: 74, lyrics: "d" },
  ];
  for (const [ordinal, trackIndex, uuid, notes] of [
    [0, 0, "uuid-melody", sourceNotes],
    [1, 1, "uuid-harmony", []],
  ]) {
    stored.context.occurrences.push({
      occurrence: ordinal,
      trackIndex,
      groupIndex: 0,
      targetGroupUuid: uuid,
      timeOffsetBlick: 0,
      pitchOffsetSemitone: 0,
      sharedTargetOccurrences: [ordinal],
      noteFingerprints: notes.map((note, index) => fingerprint(note, index)),
    });
  }
  stored.context.quarterBlick = Q;
  stored.context.meterMarks = [{ position: 0, positionBlick: 0, numerator: 4, denominator: 4 }];
  stored.context.tempoMarks = [{ positionBlick: 0, positionSeconds: 0, bpm: 120 }];
  return { stored };
}

async function buildPlans() {
  const plans = [];

  const expressionStore = new SnapshotStore({ now: () => 1000 });
  const expressionContext = createStoredContext(expressionStore, [
    { onsetBlick: 0, durationBlick: Q, pitch: 60, lyrics: "when" },
    { onsetBlick: Q, durationBlick: 3 * Q, pitch: 66, lyrics: "see" },
    { onsetBlick: 6 * Q, durationBlick: Q, pitch: 62, lyrics: "go" },
  ]);
  plans.push({
    planner: "sv_plan_expression",
    plan: await new ExpressionPlanService({ store: expressionStore, now: () => 2000 }).plan({
      contextId: expressionContext.stored.contextId,
      intent: { technique: ["controlled_belt"], emotion: "cool_anger", section: "chorus" },
    }),
    legacyField: "applyRequests",
  });

  const lyricStore = new SnapshotStore({ now: () => 1000 });
  const lyricContext = createStoredContext(lyricStore, [
    { onsetBlick: 0, durationBlick: Q },
    { onsetBlick: Q, durationBlick: Q },
  ]);
  plans.push({
    planner: "sv_align_lyrics",
    plan: await new LyricAlignService({ store: lyricStore, now: () => 2000 }).align({
      contextId: lyricContext.stored.contextId,
      lyrics: "ひかり",
      language: "japanese",
    }),
    legacyField: "patchRequest",
  });

  const quantizeStore = new SnapshotStore({ now: () => 1000 });
  const quantizeContext = createStoredContext(quantizeStore, [
    { onsetBlick: 1234, durationBlick: Q, pitch: 60, lyrics: "a" },
    { onsetBlick: Q + 4321, durationBlick: Q, pitch: 62, lyrics: "b" },
  ]);
  plans.push({
    planner: "sv_quantize_notes",
    plan: await new QuantizePlanService({ store: quantizeStore, now: () => 2000 }).plan({
      contextId: quantizeContext.stored.contextId,
      grid: { division: "1/16" },
    }),
    legacyField: "patchRequest",
  });

  const harmonyStore = new SnapshotStore({ now: () => 1000 });
  const harmonyCtx = harmonyContext(harmonyStore);
  plans.push({
    planner: "sv_generate_harmony",
    plan: await new HarmonyPlanService({ store: harmonyStore, now: () => 2000 }).plan({
      contextId: harmonyCtx.stored.contextId,
      sourceOccurrence: 0,
      targetOccurrence: 1,
      harmony: { interval: "third_below", key: { tonic: "C", mode: "major" } },
    }),
    legacyField: "restructureRequest",
  });

  const gestureStore = new SnapshotStore({ now: () => 1000 });
  const gestureCtx = createStoredContext(gestureStore, [
    { onsetBlick: 0, durationBlick: Q, pitch: 60, lyrics: "a" },
    { onsetBlick: Q, durationBlick: Q, pitch: 62, lyrics: "i" },
    { onsetBlick: 2 * Q, durationBlick: 4 * Q, pitch: 64, lyrics: "u" },
  ]);
  plans.push({
    planner: "sv_plan_pitch_gesture",
    plan: await new PitchGesturePlanService({ store: gestureStore, now: () => 2000 }).plan({
      contextId: gestureCtx.stored.contextId,
      gestures: [
        { type: "attack", note: 0, depthSemitone: 0.3 },
        { type: "transition", from: 0, to: 1, width: { quarters: 0.5 } },
      ],
    }),
    legacyField: "applyRequests",
  });

  return plans;
}

test("all five planners share one apply envelope a generic consumer can submit", async () => {
  const plans = await buildPlans();
  assert.equal(plans.length, 5);

  const toolNames = [
    ...new Set(
      plans.flatMap(({ plan }) => [
        plan.apply.tool,
        ...(plan.apply.additionalCalls ?? []).map((call) => call.tool),
      ])
    ),
  ];
  const schemas = await fetchServedSchemas(toolNames);
  const validators = new Map(
    toolNames.map((name) => [name, compile(schemas[name])])
  );

  for (const { planner, plan, legacyField } of plans) {
    // 1) 顶层结构统一：不需要按规划器分支。
    assert.ok(plan.planId, `${planner} must return a planId`);
    assert.ok(plan.apply, `${planner} must return an apply envelope`);
    assert.ok(plan.review, `${planner} must return review`);
    assert.equal(plan.apply.atomicity, "verified_compensation");
    assert.ok(
      Number.isInteger(plan.apply.expectedUserUndoSteps) && plan.apply.expectedUserUndoSteps >= 1,
      `${planner} must report how many Undo steps the user will see`
    );
    assert.ok(Array.isArray(plan.apply.preconditions));
    assert.match(plan.apply.planIsNotAPreflightToken, /does not authorize skipping live preflight/);

    // 2) 泛型提交路径：读 apply.tool，用该工具的 schema 校验 apply.arguments。
    const validate = validators.get(plan.apply.tool);
    assert.ok(validate, `${planner} named an unserved tool ${plan.apply.tool}`);
    assertValid(validate, plan.apply.arguments, `${planner} apply.arguments`);

    // 多次调用（expression 的非相邻表现手法簇）同样逐条可校验。
    for (const call of plan.apply.additionalCalls ?? []) {
      assertValid(
        validators.get(call.tool),
        call.arguments,
        `${planner} additionalCalls[${call.callIndex}].arguments`
      );
    }
    const callCount = 1 + (plan.apply.additionalCalls?.length ?? 0);
    assert.equal(
      plan.apply.expectedUserUndoSteps,
      callCount,
      `${planner} must not under-report Undo steps`
    );

    // 3) 兼容期：旧字段仍在，且与 apply 内容完全一致（不是另一份计划）。
    const legacy = plan[legacyField];
    assert.ok(legacy, `${planner} must keep ${legacyField} for one release`);
    const legacyFirst = Array.isArray(legacy) ? legacy[0] : legacy;
    assert.equal(legacyFirst.tool, plan.apply.tool);
    assert.deepEqual(legacyFirst.arguments, plan.apply.arguments);
  }
});

test("lyric and harmony planners default to complete plan references without inline duplicates", async () => {
  const sessionId = "sess_remaining_planners";
  const artifactStore = new ArtifactStore({ now: () => 2000 });

  const lyricStore = new SnapshotStore({ now: () => 1000 });
  const lyricContext = createStoredContext(lyricStore, [
    { onsetBlick: 0, durationBlick: Q, lyrics: "" },
    { onsetBlick: Q, durationBlick: Q, lyrics: "" },
  ]);
  const lyric = await new LyricAlignService({
    store: lyricStore,
    now: () => 2000,
    artifactStore,
    sessionId,
  }).align({
    contextId: lyricContext.stored.contextId,
    lyrics: "ひかり",
    language: "japanese",
  });

  const harmonyStore = new SnapshotStore({ now: () => 1000 });
  const harmonyCtx = harmonyContext(harmonyStore);
  const harmony = await new HarmonyPlanService({
    store: harmonyStore,
    now: () => 2000,
    artifactStore,
    sessionId,
  }).plan({
    contextId: harmonyCtx.stored.contextId,
    sourceOccurrence: 0,
    targetOccurrence: 1,
    harmony: { interval: "third_below", key: { tonic: "C", mode: "major" } },
  });

  for (const [label, plan] of [
    ["lyrics", lyric],
    ["harmony", harmony],
  ]) {
    const reference = plan.apply.arguments.planRef;
    assert.equal(plan.apply.arguments.action, "dry_run");
    // 裸 artifactId 字符串：没有 kind / contentHash / resourceUri / firstPageUri。
    assert.equal(typeof reference, "string");
    assert.match(reference, /^a_[A-Za-z0-9_-]+$/);
    // 租期是调用方唯一需要知道的时间事实，因此由 apply 信封自己携带（§4.3）。
    assert.ok(plan.apply.expiresAt);
    assert.equal(plan.patchRequest, undefined, `${label} must not duplicate an inline patch request`);
    assert.equal(
      plan.restructureRequest,
      undefined,
      `${label} must not duplicate an inline restructure request`
    );
    assert.doesNotMatch(
      JSON.stringify(plan.apply.preconditions),
      /TTL expiry invalidates/,
      `${label} preconditions must describe plan leases accurately`
    );
  }
});

test("compact lyric plans externalize alignment detail and capsule only touched notes", async () => {
  const sessionId = "sess_compact_lyrics";
  const artifactStore = new ArtifactStore({ now: () => 2000 });
  const store = new SnapshotStore({ now: () => 1000 });
  const context = createStoredContext(
    store,
    Array.from({ length: 373 }, (_, index) => ({
      onsetBlick: index * Q,
      durationBlick: Q,
      lyrics: "",
    }))
  );
  const plan = await new LyricAlignService({
    store,
    now: () => 2000,
    artifactStore,
    sessionId,
  }).align({
    contextId: context.stored.contextId,
    lyrics: "我你他她天地人",
    language: "mandarin",
    responseMode: "compact",
  });

  assert.equal(plan.alignment.unfilledCount, 366);
  assert.equal(plan.alignment.unfilledNotes, undefined);
  assert.equal(plan.alignment.firstUnfilledNote.note, 7);
  assert.equal(plan.alignment.lastUnfilledNote.note, 372);
  assert.ok(plan.alignment.detailRef);
  assert.ok(JSON.stringify(plan).length < 6_000);

  const planArtifact = artifactStore.resolve({
    artifactId: plan.apply.arguments.planRef,
    expectedKind: "plan",
    sessionId,
  });
  assert.equal(
    planArtifact.payload.contextSnapshot.snapshot.context.occurrences[0].noteFingerprints.length,
    7
  );
  assert.ok(planArtifact.totalBytes < 10_000);

  const detailArtifact = artifactStore.resolve({
    artifactId: plan.alignment.detailRef.artifactId,
    expectedKind: "planner-detail",
    sessionId,
  });
  assert.equal(detailArtifact.payload.alignment.unfilledNotes.length, 366);
});

test("the apply envelope reports multiple sequential calls honestly", async () => {
  const store = new SnapshotStore({ now: () => 1000 });
  const context = createStoredContext(store, [
    { onsetBlick: 0, durationBlick: Q, pitch: 60, lyrics: "a" },
    { onsetBlick: Q, durationBlick: Q, pitch: 62, lyrics: "b" },
    { onsetBlick: 20 * Q, durationBlick: Q, pitch: 64, lyrics: "c" },
    { onsetBlick: 21 * Q, durationBlick: Q, pitch: 65, lyrics: "d" },
  ]);
  const notes = context.stored.context.occurrences[0].noteFingerprints;
  // 同一参数的两个互不相邻表现手法簇 → 必须拆成两次调用（两条 Undo 记录）。
  const plan = await new ExpressionPlanService({ store, now: () => 2000 }).plan({
    contextId: context.stored.contextId,
    gestures: [
      {
        type: "hairpin",
        from: 0,
        to: 1,
        amounts: { loudness: 3 },
      },
      {
        type: "hairpin",
        from: 2,
        to: 3,
        amounts: { loudness: 3 },
      },
    ],
  });

  assert.equal(plan.applyRequests.length, 2);
  assert.equal(plan.apply.callCount, 2);
  assert.equal(plan.apply.callIndex, 0);
  assert.equal(plan.apply.expectedUserUndoSteps, 2);
  assert.equal(plan.apply.additionalCalls.length, 1);
  assert.equal(plan.apply.additionalCalls[0].callIndex, 1);
  // 不得暗示多次调用是一个事务。
  assert.match(plan.apply.sequencing, /does NOT roll back earlier committed calls/);
  assert.deepEqual(plan.apply.additionalCalls[0].arguments, plan.applyRequests[1].arguments);
});

test("a partial multi-call artifact seal releases every artifact from that attempt", async () => {
  const store = new SnapshotStore({ now: () => 1000 });
  const context = createStoredContext(store, [
    { onsetBlick: 0, durationBlick: Q, pitch: 60, lyrics: "a" },
    { onsetBlick: Q, durationBlick: Q, pitch: 62, lyrics: "b" },
    { onsetBlick: 20 * Q, durationBlick: Q, pitch: 64, lyrics: "c" },
    { onsetBlick: 21 * Q, durationBlick: Q, pitch: 65, lyrics: "d" },
  ]);
  const notes = context.stored.context.occurrences[0].noteFingerprints;
  const artifactStore = new ArtifactStore({
    now: () => 2000,
    quotas: { maxEntries: 1 },
  });
  const service = new ExpressionPlanService({
    store,
    now: () => 2000,
    artifactStore,
    sessionId: "sess_partial_seal",
  });
  const plan = await service.plan({
    contextId: context.stored.contextId,
    usePlanRef: true,
    gestures: [
      {
        type: "hairpin",
        from: 0,
        to: 1,
        amounts: { loudness: 3 },
      },
      {
        type: "hairpin",
        from: 2,
        to: 3,
        amounts: { loudness: 3 },
      },
    ],
  });

  assert.equal(plan.applyRequests.length, 2);
  assert.equal(artifactStore.entries.size, 0);
  assert.ok(plan.warnings.some((warning) => warning.code === "ARTIFACT_SEAL_FAILED"));
});

test("a no-op plan returns apply:null instead of an empty request", async () => {
  const store = new SnapshotStore({ now: () => 1000 });
  // 已经落在 1/16 网格上的音符：无事可做。
  const context = createStoredContext(store, [
    { onsetBlick: 0, durationBlick: Q, pitch: 60, lyrics: "a" },
    { onsetBlick: Q, durationBlick: Q, pitch: 62, lyrics: "b" },
  ]);
  const plan = await new QuantizePlanService({ store, now: () => 2000 }).plan({
    contextId: context.stored.contextId,
    grid: { division: "1/16" },
  });
  assert.equal(plan.status, "no_change");
  assert.equal(plan.apply, null);
  assert.equal(plan.patchRequest, null);
});

test("generalized harmony input validates against the served sv_generate_harmony schema", async () => {
  const schemas = await fetchServedSchemas(["sv_generate_harmony"]);
  const validate = compile(schemas.sv_generate_harmony);
  // 广义 interval 对象 + 显式 scale 必须通过服务端 inputSchema。
  assertValid(validate, {
    contextId: "ctx_SCHEMA",
    sourceOccurrence: 0,
    targetOccurrence: 1,
    harmony: {
      interval: { degree: 3, direction: "above", octaveOffset: 1 },
      key: { tonic: "D", mode: "minor", scale: "dorian" },
    },
  }, "generalized interval + explicit scale");
  assertValid(validate, {
    contextId: "ctx_SCHEMA",
    targetOccurrence: 1,
    harmony: { interval: { degree: 1, direction: "below" } },
  }, "unison below without key");
  // 字符串 interval 与广义对象 interval 都属于当前业务契约。
  assertValid(validate, {
    contextId: "ctx_SCHEMA",
    targetOccurrence: 1,
    harmony: { interval: "third_below", key: { tonic: "C", mode: "major" } },
  }, "legacy string interval");
});
