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
import { buildApplyEnvelope, sealApplyEnvelope } from "../server/src/plan-envelope.js";
import { PitchGesturePlanService } from "../server/src/pitch-gesture-plan.js";
import { MAX_CURVE_OPERATIONS_PER_TRANSACTION } from "../server/src/parameter-curve.js";
import { QuantizePlanService } from "../server/src/quantize-plan.js";
import { SnapshotStore } from "../server/src/snapshot.js";

// 跨层契约回归：规划器产出的 planRef 请求和 Artifact 内封存的 mutationRequest
// 都必须能通过真实 MCP 服务器对下游工具公布的 inputSchema——
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

let plannerFixtureSequence = 0;

function createPlannerFixture(Service, store, label) {
  plannerFixtureSequence += 1;
  const artifactStore = new ArtifactStore({ now: () => 2000 });
  const sessionId = `sess_${label}_${plannerFixtureSequence}`;
  return {
    service: new Service({ store, now: () => 2000, artifactStore, sessionId }),
    artifactStore,
    sessionId,
  };
}

function planApplyCalls(plan) {
  if (!plan.apply?.arguments) return [];
  return [plan.apply, ...(plan.apply.additionalCalls ?? [])];
}

function resolvePlanCall(plan, fixture, callIndex = 0) {
  const call = planApplyCalls(plan)[callIndex];
  assert.ok(call, `missing apply call ${callIndex}`);
  const artifact = fixture.artifactStore.resolve({
    artifactId: call.arguments.planRef,
    expectedKind: "plan",
    sessionId: fixture.sessionId,
  });
  return {
    tool: artifact.payload.targetTool,
    arguments: artifact.payload.mutationRequest,
  };
}

function assertPlanRefOnly(plan, label) {
  assert.ok(plan.apply, `${label} must return an apply envelope`);
  assert.ok(plan.apply.expiresAt, `${label} must expose the plan lease`);
  for (const call of planApplyCalls(plan)) {
    assert.deepEqual(
      Object.keys(call.arguments).sort(),
      ["action", "planRef"],
      `${label} must hand off only planRef + action`
    );
    assert.equal(call.arguments.action, "dry_run");
    assert.match(call.arguments.planRef, /^a_[A-Za-z0-9_-]+$/);
  }
  assert.doesNotMatch(
    JSON.stringify(plan),
    /"(?:applyRequests|patchRequest|patchRequests|restructureRequest)"\s*:/,
    `${label} must not expose a legacy inline alias`
  );
}

// facade 是唯一 surface，direct tool 的 schema 不在 tools/list 里；
// 取 schema 的唯一途径就是模型自己会走的那条——sv_describe。
async function fetchServedOperations(toolNames) {
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
    const served = {};
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
      // 业务载荷在 data 里（§10.2.1）。
      const { operations, deferred } = response.structuredContent.data;
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
        served[name] = entry;
      }
    }
    return served;
  } finally {
    await client.close().catch(() => {});
  }
}

async function fetchServedSchemas(toolNames) {
  const served = await fetchServedOperations(toolNames);
  return Object.fromEntries(
    Object.entries(served).map(([toolName, operation]) => [toolName, operation.inputSchema])
  );
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
  const maxTransitions =
    schemas.sv_compare_computed_pitch.properties.metrics.properties.maxTransitions;
  assert.equal(maxTransitions.type, "integer");
  assert.equal(maxTransitions.minimum, 1);
  assert.equal(maxTransitions.maximum, 2000);
  assert.equal(maxTransitions.default, 20);

  const validate = compile(patchSchema);
  assert.equal(
    validate({
      contextId: "ctx_test",
      occurrence: 0,
      patches: [{ note: 0, set: { lyrics: "test" } }],
      action: "dry_run",
      diagnostics: true,
    }),
    true,
    JSON.stringify(validate.errors)
  );
});

test("served sv_edit_phrase schema accepts an insert operation with its note payload", async () => {
  const schemas = await fetchServedSchemas(["sv_edit_phrase"]);
  const validate = compile(schemas.sv_edit_phrase);
  assertValid(
    validate,
    {
      target: { contextId: "ctx_insert", occurrence: 0 },
      structureOperations: [
        {
          op: "insert",
          note: { onsetBlick: 0, durationBlick: Q, pitch: 60, lyrics: "la" },
        },
      ],
      action: "dry_run",
    },
    "sv_edit_phrase insert"
  );
});

test("served processing schema exposes opt-in computed-pitch values", async () => {
  const schemas = await fetchServedSchemas(["sv_wait_for_processing"]);
  assert.equal(schemas.sv_wait_for_processing.properties.includeValues.type, "boolean");
  assert.match(
    schemas.sv_wait_for_processing.properties.includeValues.description,
    /computed pitch/i
  );
});

test("served curve schema exposes the single-transaction operation budget", async () => {
  const schemas = await fetchServedSchemas(["sv_patch_parameter_curves"]);
  assert.equal(
    schemas.sv_patch_parameter_curves.properties.curves.maxItems,
    MAX_CURVE_OPERATIONS_PER_TRANSACTION
  );
});

test("served audition descriptions expose the terminal polling contract", async () => {
  const served = await fetchServedOperations([
    "sv_start_audition",
    "sv_get_audition",
    "sv_stop_audition",
    "sv_restore_audition",
    "sv_audition_compare",
    "sv_get_audition_compare",
    "sv_stop_audition_compare",
  ]);
  for (const [toolName, operation] of Object.entries(served)) {
    assert.match(
      operation.description,
      /data\.terminal/i,
      `${toolName} must tell an MCP-only client how to recognize lifecycle completion`
    );
  }
  assert.match(served.sv_get_audition.description, /stop polling/i);
  assert.match(served.sv_get_audition_compare.description, /stop polling/i);
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
  const expressionFixture = createPlannerFixture(
    ExpressionPlanService,
    planStore,
    "schema_expression"
  );
  const plan = await expressionFixture.service.plan({
    contextId: planContext.stored.contextId,
    intent: { technique: ["controlled_belt"], emotion: "cool_anger", section: "chorus" },
  });
  assertPlanRefOnly(plan, "sv_plan_expression");
  const expressionCalls = planApplyCalls(plan).map((_, index) =>
    resolvePlanCall(plan, expressionFixture, index)
  );
  assert.ok(expressionCalls.length >= 1);
  for (const request of expressionCalls) {
    assert.equal(request.tool, "sv_patch_parameter_curves");
    assert.ok(Array.isArray(request.arguments.target.expectedNotes));
    assertValid(validateCurves, request.arguments, "sv_plan_expression sealed mutation");
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
  const lyricFixture = createPlannerFixture(LyricAlignService, lyricStore, "schema_lyrics");
  const aligned = await lyricFixture.service.align({
    contextId: lyricContext.stored.contextId,
    lyrics: Array.from({ length: count }, (_, index) => pool[index % pool.length]).join(""),
    language: "mandarin",
  });
  assertPlanRefOnly(aligned, "sv_align_lyrics");
  const lyricCall = resolvePlanCall(aligned, lyricFixture);
  assert.equal(lyricCall.tool, "sv_patch_notes");
  assert.equal(lyricCall.arguments.patches.length, 200);
  assert.equal(aligned.continuation.remainingChangedCount, 1);
  assertValid(validatePatches, lyricCall.arguments, "sv_align_lyrics sealed mutation");
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
    { target, curves: [curve], action: "dry_run" },
    "batch curve dense points"
  );
  assertValid(
    compile(schemas.sv_edit_phrase),
    { target, curves: [curve], action: "dry_run" },
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
  const expressionFixture = createPlannerFixture(
    ExpressionPlanService,
    expressionStore,
    "envelope_expression"
  );
  plans.push({
    planner: "sv_plan_expression",
    plan: await expressionFixture.service.plan({
      contextId: expressionContext.stored.contextId,
      intent: { technique: ["controlled_belt"], emotion: "cool_anger", section: "chorus" },
    }),
    fixture: expressionFixture,
  });

  const lyricStore = new SnapshotStore({ now: () => 1000 });
  const lyricContext = createStoredContext(lyricStore, [
    { onsetBlick: 0, durationBlick: Q },
    { onsetBlick: Q, durationBlick: Q },
  ]);
  const lyricFixture = createPlannerFixture(LyricAlignService, lyricStore, "envelope_lyrics");
  plans.push({
    planner: "sv_align_lyrics",
    plan: await lyricFixture.service.align({
      contextId: lyricContext.stored.contextId,
      lyrics: "ひかり",
      language: "japanese",
    }),
    fixture: lyricFixture,
  });

  const quantizeStore = new SnapshotStore({ now: () => 1000 });
  const quantizeContext = createStoredContext(quantizeStore, [
    { onsetBlick: 1234, durationBlick: Q, pitch: 60, lyrics: "a" },
    { onsetBlick: Q + 4321, durationBlick: Q, pitch: 62, lyrics: "b" },
  ]);
  const quantizeFixture = createPlannerFixture(
    QuantizePlanService,
    quantizeStore,
    "envelope_quantize"
  );
  plans.push({
    planner: "sv_quantize_notes",
    plan: await quantizeFixture.service.plan({
      contextId: quantizeContext.stored.contextId,
      grid: { division: "1/16" },
    }),
    fixture: quantizeFixture,
  });

  const harmonyStore = new SnapshotStore({ now: () => 1000 });
  const harmonyCtx = harmonyContext(harmonyStore);
  const harmonyFixture = createPlannerFixture(
    HarmonyPlanService,
    harmonyStore,
    "envelope_harmony"
  );
  plans.push({
    planner: "sv_generate_harmony",
    plan: await harmonyFixture.service.plan({
      contextId: harmonyCtx.stored.contextId,
      sourceOccurrence: 0,
      targetOccurrence: 1,
      harmony: { interval: "third_below", key: { tonic: "C", mode: "major" } },
    }),
    fixture: harmonyFixture,
  });

  const gestureStore = new SnapshotStore({ now: () => 1000 });
  const gestureCtx = createStoredContext(gestureStore, [
    { onsetBlick: 0, durationBlick: Q, pitch: 60, lyrics: "a" },
    { onsetBlick: Q, durationBlick: Q, pitch: 62, lyrics: "i" },
    { onsetBlick: 2 * Q, durationBlick: 4 * Q, pitch: 64, lyrics: "u" },
  ]);
  const gestureFixture = createPlannerFixture(
    PitchGesturePlanService,
    gestureStore,
    "envelope_pitch_gesture"
  );
  plans.push({
    planner: "sv_plan_pitch_gesture",
    plan: await gestureFixture.service.plan({
      contextId: gestureCtx.stored.contextId,
      gestures: [
        { type: "attack", note: 0, depthSemitone: 0.3 },
        { type: "transition", from: 0, to: 1, width: { quarters: 0.5 } },
      ],
    }),
    fixture: gestureFixture,
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

  for (const { planner, plan, fixture } of plans) {
    // 1) 顶层结构统一：不需要按规划器分支。
    assert.ok(plan.planId, `${planner} must return a planId`);
    assertPlanRefOnly(plan, planner);
    assert.ok(plan.review, `${planner} must return review`);
    assert.equal(plan.apply.atomicity, "verified_compensation");
    assert.ok(
      Number.isInteger(plan.apply.expectedUserUndoSteps) && plan.apply.expectedUserUndoSteps >= 1,
      `${planner} must report how many Undo steps the user will see`
    );
    assert.ok(Array.isArray(plan.apply.preconditions));
    assert.match(plan.apply.planIsNotAPreflightToken, /does not authorize skipping live preflight/);

    // 2) 泛型提交路径：PlanRef 请求和其封存的直接 mutation 都必须通过目标 schema。
    const validate = validators.get(plan.apply.tool);
    assert.ok(validate, `${planner} named an unserved tool ${plan.apply.tool}`);
    assertValid(validate, plan.apply.arguments, `${planner} apply.arguments`);
    const resolvedFirst = resolvePlanCall(plan, fixture);
    assert.equal(resolvedFirst.tool, plan.apply.tool);
    assertValid(validate, resolvedFirst.arguments, `${planner} sealed mutation`);

    // 多次调用（expression 的非相邻表现手法簇）同样逐条可校验。
    for (const [index, call] of (plan.apply.additionalCalls ?? []).entries()) {
      assertValid(
        validators.get(call.tool),
        call.arguments,
        `${planner} additionalCalls[${call.callIndex}].arguments`
      );
      const resolved = resolvePlanCall(plan, fixture, index + 1);
      assert.equal(resolved.tool, call.tool);
      assertValid(
        validators.get(call.tool),
        resolved.arguments,
        `${planner} sealed additional mutation ${index + 1}`
      );
    }
    const callCount = 1 + (plan.apply.additionalCalls?.length ?? 0);
    assert.equal(
      plan.apply.expectedUserUndoSteps,
      callCount,
      `${planner} must not under-report Undo steps`
    );

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
    assertPlanRefOnly(plan, label);
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
      /TTL expiry invalidates|Inline apply/,
      `${label} preconditions must describe plan leases accurately`
    );
  }
});

test("oversized lyric alignment lists are capped and backed by a detail artifact", async () => {
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
  });

  // 单一形状（§10.6 规则 14）：计数与首末项恒定返回，逐项列表定量截断，
  // 完整明细走 detailRef。调用方不再需要先选一档才知道能读到什么。
  assert.equal(plan.alignment.unfilledCount, 366);
  assert.deepEqual(plan.alignment.unfilledNotes, []);
  assert.equal(plan.alignment.unfilledTruncated, true);
  assert.equal(plan.alignment.detailsOmitted, true);
  assert.equal(plan.alignment.firstUnfilledNote.note, 7);
  assert.equal(plan.alignment.lastUnfilledNote.note, 372);
  assert.ok(plan.alignment.detailRef);
  // 截断后的信封仍远小于 16 KiB compact 预算，且 366 项完整明细可从 artifact 取回。
  const responseBytes = Buffer.byteLength(JSON.stringify(plan), "utf8");
  assert.ok(responseBytes < 8 * 1024, `alignment response must stay below 8 KiB, got ${responseBytes}`);

  const planArtifact = artifactStore.resolve({
    artifactId: plan.apply.arguments.planRef,
    expectedKind: "plan",
    sessionId,
  });
  assert.equal(
    planArtifact.payload.capsule.context.occurrences[0].noteFingerprints.length,
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

test("disjoint expression ranges share one plan and one transaction", async () => {
  const store = new SnapshotStore({ now: () => 1000 });
  const context = createStoredContext(store, [
    { onsetBlick: 0, durationBlick: Q, pitch: 60, lyrics: "a" },
    { onsetBlick: Q, durationBlick: Q, pitch: 62, lyrics: "b" },
    { onsetBlick: 20 * Q, durationBlick: Q, pitch: 64, lyrics: "c" },
    { onsetBlick: 21 * Q, durationBlick: Q, pitch: 65, lyrics: "d" },
  ]);
  const fixture = createPlannerFixture(ExpressionPlanService, store, "multi_call");
  // 同一参数的两个互不相邻表现手法簇由曲线事务核统一提交。
  const plan = await fixture.service.plan({
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

  assertPlanRefOnly(plan, "single-transaction expression plan");
  assert.equal(plan.summary.applyCallCount, 1);
  assert.equal(plan.apply.callIndex, undefined);
  assert.equal(plan.apply.expectedUserUndoSteps, 1);
  assert.equal(plan.apply.additionalCalls, undefined);
  const request = resolvePlanCall(plan, fixture, 0);
  assert.equal(request.tool, "sv_patch_parameter_curves");
  assert.equal(request.arguments.curves.length, 2);
  assert.equal(new Set(request.arguments.curves.map((curve) => curve.parameter)).size, 1);
});

test("one expression transaction consumes one plan artifact", async () => {
  const store = new SnapshotStore({ now: () => 1000 });
  const context = createStoredContext(store, [
    { onsetBlick: 0, durationBlick: Q, pitch: 60, lyrics: "a" },
    { onsetBlick: Q, durationBlick: Q, pitch: 62, lyrics: "b" },
    { onsetBlick: 20 * Q, durationBlick: Q, pitch: 64, lyrics: "c" },
    { onsetBlick: 21 * Q, durationBlick: Q, pitch: 65, lyrics: "d" },
  ]);
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
    gestures: [
      { type: "hairpin", from: 0, to: 1, amounts: { loudness: 3 } },
      { type: "hairpin", from: 2, to: 3, amounts: { loudness: 3 } },
    ],
  });
  assert.equal(plan.summary.applyCallCount, 1);
  assert.equal(artifactStore.entries.size, 1);
  const artifact = artifactStore.resolve({
    artifactId: plan.apply.arguments.planRef,
    expectedKind: "plan",
    sessionId: "sess_partial_seal",
  });
  assert.equal(artifact.payload.mutationRequest.curves.length, 2);
});

test("an actionable plan without an ArtifactStore fails instead of returning inline mutation data", async () => {
  const store = new SnapshotStore({ now: () => 1000 });
  const context = createStoredContext(store, [
    { onsetBlick: Q / 8, durationBlick: Q, pitch: 60, lyrics: "a" },
  ]);

  await assert.rejects(
    new QuantizePlanService({ store, now: () => 2000 }).plan({
      contextId: context.stored.contextId,
      grid: { division: "1/16" },
    }),
    (error) => {
      assert.equal(error.code, "PLAN_SEAL_FAILED");
      return true;
    }
  );
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
  assert.equal(Object.hasOwn(plan, "patchRequest"), false);
});

test("the shared seal boundary rejects missing, extra, duplicate, or incomplete PlanRefs", () => {
  const envelope = buildApplyEnvelope([
    { tool: "sv_patch_notes", arguments: { action: "dry_run" } },
    { tool: "sv_patch_notes", arguments: { action: "dry_run" } },
  ]);
  const expiresAt = "2026-08-02T12:00:00.000Z";
  const assertSealFailure = (refs, lease = expiresAt) => {
    assert.throws(
      () => sealApplyEnvelope(envelope, refs, lease),
      (error) => error.code === "PLAN_SEAL_FAILED"
    );
  };

  assertSealFailure(["a_first"]);
  assertSealFailure(["a_first", "a_second", "a_extra"]);
  assertSealFailure(["a_same", "a_same"]);
  assertSealFailure(["a_first", ""]);
  assertSealFailure(["a_first", "a_second"], null);
  assert.equal(sealApplyEnvelope(null, null, null), null);

  const sealed = sealApplyEnvelope(envelope, ["a_first", "a_second"], expiresAt);
  assert.deepEqual(sealed.arguments, { planRef: "a_first", action: "dry_run" });
  assert.deepEqual(sealed.additionalCalls[0].arguments, {
    planRef: "a_second",
    action: "dry_run",
  });
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
