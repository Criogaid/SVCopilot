import "./helpers/pipe-namespace.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";
import AjvModule from "../server/node_modules/ajv/dist/ajv.js";

import {
  DESCRIBE_OPERATION_TOOL,
  MAX_DESCRIBE_OPERATIONS,
} from "../server/src/compact-facade.js";
import { operationNameForTool } from "../server/src/operation-catalog.js";
import {
  GUIDE_VERSION,
  musicWorkflowGuideExamples,
  musicWorkflowGuideIndex,
  musicWorkflowGuideRecipe,
  musicWorkflowGuideRecipeIds,
} from "../server/src/workflow-guide.js";

// P0-B 验收：指南资源必须
// 1) 每个示例 request 逐字通过真实服务器公布的 inputSchema（否则模型照抄会被拒）；
// 2) 只引用真实存在的工具名（不得发明 render/singer API）；
// 3) 目录页保持在 60 KiB 以内并可按 recipe ID 单独读取；
// 4) 通过 MCP 协议真实可列可读。

const Ajv = AjvModule.default ?? AjvModule;
const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverScript = path.resolve(testDir, "..", "server", "src", "index.js");

const REQUIRED_RECIPES = [
  "inspect_project",
  "analyze_vocal_phrase",
  "align_and_commit_lyrics",
  "plan_and_commit_expression",
  "plan_and_commit_pitch",
  "quantize_notes",
  "generate_harmony",
  "verify_after_edit",
  "audition_for_human",
];

// 官方能力缺口：指南绝不能建议这些不存在的工具。
const FORBIDDEN_TOOL_PATTERNS = [
  /sv_render/i,
  /sv_export/i,
  /sv_bounce/i,
  /sv_list_singers/i,
  /sv_set_singer/i,
  /sv_get_singer/i,
  /sv_undo/i,
  /sv_subscribe/i,
];

async function withServer(run) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverScript],
    env: process.env,
    cwd: path.dirname(serverScript),
    stderr: "pipe",
  });
  const client = new Client({ name: "workflow-guide-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    return await run(client);
  } finally {
    await client.close().catch(() => {});
  }
}

function parseResource(result) {
  assert.equal(result.contents.length, 1);
  return JSON.parse(result.contents[0].text);
}

test("every guide example validates against the schemas the real server serves", async () => {
  // facade 是唯一 surface，因此 schema 只能从 sv_describe 取——与模型走同一条路。
  const operations = [
    ...new Set(musicWorkflowGuideExamples().map((example) => operationNameForTool(example.tool))),
  ];
  const schemas = await withServer(async (client) => {
    const collected = new Map();
    // 响应有字节预算：被 deferred 的 operation 按它给出的 remedy 再单独取一次。
    const pending = [...operations];
    while (pending.length > 0) {
      const batch = pending.splice(0, MAX_DESCRIBE_OPERATIONS);
      const response = await client.callTool({
        name: DESCRIBE_OPERATION_TOOL,
        arguments: { operations: batch },
      });
      assert.notEqual(response.isError, true, `sv_describe failed for ${batch.join(", ")}`);
      for (const entry of response.structuredContent.operations) {
        collected.set(entry.operation, entry.inputSchema);
      }
      for (const item of response.structuredContent.deferred?.operations ?? []) {
        pending.push(item.operation);
      }
    }
    return collected;
  });

  // 与 index.js 相同的 Ajv 配置，确保判定一致。
  const ajv = new Ajv({ allErrors: true, strict: false, discriminator: true });
  const validators = new Map();
  const examples = musicWorkflowGuideExamples();
  assert.ok(examples.length >= 24, `expected a substantial example set, got ${examples.length}`);

  for (const example of examples) {
    const operation = operationNameForTool(example.tool);
    assert.ok(
      schemas.has(operation),
      `${example.recipeId}/${example.label} references unknown operation ${operation}`
    );
    if (!validators.has(operation)) {
      validators.set(operation, ajv.compile(schemas.get(operation)));
    }
    const validate = validators.get(operation);
    const valid = validate(example.arguments);
    assert.ok(
      valid,
      `${example.recipeId}/${example.label} (${example.tool}) must pass the served inputSchema; errors: ${JSON.stringify(validate.errors)}`
    );
  }
});

test("the guide covers the required recipes and never invents host capabilities", () => {
  const index = musicWorkflowGuideIndex("0.8.0");
  assert.equal(index.guideVersion, GUIDE_VERSION);
  assert.equal(index.interfaceVersion, "0.8.0");
  assert.deepEqual(musicWorkflowGuideRecipeIds(), REQUIRED_RECIPES);

  for (const id of REQUIRED_RECIPES) {
    const summary = index.recipes.find((entry) => entry.id === id);
    assert.ok(summary, `index must summarize ${id}`);
    assert.equal(summary.uri, `svcopilot://guide/music-workflows/${id}`);
    assert.ok(summary.stepCount >= 1, `${id} must have steps`);
    assert.ok(summary.expectedCalls.min >= 1 && summary.expectedCalls.max >= summary.expectedCalls.min);

    const full = musicWorkflowGuideRecipe(id, "0.8.0");
    assert.ok(full, `${id} must be readable individually`);
    for (const step of full.recipe.steps) {
      assert.ok(step.tool, `${id} step ${step.n} needs a tool`);
      assert.ok(step.purpose, `${id} step ${step.n} needs a purpose`);
      assert.ok(step.arguments, `${id} step ${step.n} needs a request template`);
    }
  }

  // 不得出现不存在的 render/singer/undo/事件订阅工具名。
  const serialized = JSON.stringify({
    index,
    recipes: REQUIRED_RECIPES.map((id) => musicWorkflowGuideRecipe(id, "0.8.0")),
  });
  for (const pattern of FORBIDDEN_TOOL_PATTERNS) {
    assert.ok(
      !pattern.test(serialized),
      `guide must not suggest a nonexistent tool matching ${pattern}`
    );
  }

  // 能力阻塞与人类门必须显式存在，而不是靠模型自己推断。
  assert.ok(index.globalRules.capabilityBlocked.some((line) => /render/i.test(line)));
  assert.ok(index.globalRules.capabilityBlocked.some((line) => /singer|voicebank/i.test(line)));
  assert.ok(index.globalRules.humanGates.some((line) => /human_only|no audio input/i.test(line)));
  assert.ok(
    index.globalRules.contextLifecycle.some((line) => /STALE_CONTEXT/.test(line)),
    "the guide must state the stale-context re-capture rule"
  );
  assert.ok(
    index.globalRules.writeSafety.some(
      (line) => /verified compensation/i.test(line) && /not ACID/i.test(line)
    ),
    "the guide must state that atomic:true is compensation, not ACID"
  );

  // P0-D：指南必须教统一 apply 信封，而不是让模型去认四种规划器专属字段。
  assert.ok(Array.isArray(index.globalRules.planHandoff));
  assert.ok(
    index.globalRules.planHandoff.some(
      (line) => /apply\.tool/.test(line) && /apply\.arguments/.test(line)
    ),
    "the guide must tell the model to read apply.tool and submit apply.arguments"
  );
  assert.ok(
    index.globalRules.planHandoff.some((line) => /apply is null/i.test(line)),
    "the guide must explain that apply:null is no_change, not an error"
  );
  assert.ok(
    index.globalRules.planHandoff.some(
      (line) => /additionalCalls/.test(line) && /separate transactions/i.test(line)
    ),
    "the guide must warn that multi-call applies are not one transaction"
  );
  assert.ok(
    index.globalRules.planHandoff.some((line) => /never a token for skipping preflight/i.test(line)),
    "the guide must state that a plan does not authorize skipping live preflight"
  );
});

test("the audition recipe offers A/B without promising an undoable temporary edit", () => {
  const { recipe } = musicWorkflowGuideRecipe("audition_for_human", "0.8.0");
  const compare = recipe.steps.find((step) => step.operation === "compare");
  assert.ok(compare, "the guide must show the A/B comparison");
  const rules = compare.readingRules.join(" ");
  assert.match(rules, /fully stopped and restored BEFORE variant B starts/i);
  assert.match(rules, /NEVER applies a temporary edit/i);
  assert.match(rules, /no Undo call/i);
  assert.match(rules, /creates no project-content Undo record/i);
  assert.match(rules, /Never state a preference yourself/i);

  // 全局人类门也必须写明这条边界，而不是只藏在一个 recipe 里。
  const index = musicWorkflowGuideIndex("0.8.0");
  assert.ok(
    index.globalRules.humanGates.some(
      (line) => /sv_audition_compare/.test(line) && /cannot apply a temporary edit/i.test(line)
    )
  );
});

test("recipes that consume range data declare what the capture must include", () => {
  // 纯内存分析器无法回头读宿主，所以每个消费 range context 的 step 必须声明必要 include。
  const analyzerRecipes = ["analyze_vocal_phrase", "quantize_notes", "verify_after_edit"];
  for (const id of analyzerRecipes) {
    const { recipe } = musicWorkflowGuideRecipe(id, "0.8.0");
    const capture = recipe.steps.find((step) => step.operation === "snapshot_range");
    assert.ok(capture, `${id} must start from a range capture`);
    assert.ok(
      Array.isArray(capture.requiredInclude) && capture.requiredInclude.length >= 1,
      `${id} must declare requiredInclude on its capture step`
    );
    for (const field of capture.requiredInclude) {
      assert.ok(
        capture.arguments.arguments.include.includes(field),
        `${id} capture template must actually include ${field}`
      );
    }
  }

  // quantize 依赖 meterMap（网格以小节为原点），必须显式声明。
  const quantize = musicWorkflowGuideRecipe("quantize_notes", "0.8.0").recipe;
  const quantizeCapture = quantize.steps.find((step) => step.operation === "snapshot_range");
  assert.ok(quantizeCapture.requiredInclude.includes("meterMap"));

  // computed-pitch 相关 recipe 必须要求 computedPitch。
  for (const id of ["analyze_vocal_phrase", "verify_after_edit"]) {
    const { recipe } = musicWorkflowGuideRecipe(id, "0.8.0");
    const capture = recipe.steps.find((step) => step.operation === "snapshot_range");
    assert.ok(capture.requiredInclude.includes("computedPitch"), `${id} needs computedPitch`);
  }
});

test("the diagnosis recipe leads with the composite analyzer, not four separate calls", () => {
  const { recipe } = musicWorkflowGuideRecipe("analyze_vocal_phrase", "0.8.0");
  const required = recipe.steps.filter((step) => !step.optional);
  // 必做步骤应当只有"捕获 + 一次组合分析"；逐分析器调用降级为可选钻取。
  // 投影后 step.tool 是 facade 名，step.operation 才是具体 operation。
  assert.deepEqual(
    required.map((step) => step.operation),
    ["snapshot_range", "analyze_vocal_context"]
  );
  assert.equal(recipe.expectedCalls.min, 2);

  const composite = required[1];
  const rules = composite.readingRules.join(" ");
  assert.match(rules, /summary\.sectionStatus/);
  assert.match(rules, /one weak section does NOT invalidate the others/i);
  assert.match(rules, /no_section_produced_evidence/);
  assert.match(rules, /never report the last one as 'no problems found'/i);
  assert.match(rules, /details\.tool/);

  // 目录页的选工具表也要把它列为诊断入口。
  const index = musicWorkflowGuideIndex("0.8.0");
  assert.ok(
    index.toolSelection.byNeed.some((entry) => entry.tool === "sv_read(analyze_vocal_context)"),
    "the tool-selection table must offer the composite analyzer"
  );

  // P1-A：和声语境是 opt-in，且指南必须写明单旋律无法确定真实和弦。
  const drill = recipe.steps.find(
    (step) =>
      step.operation === "analyze_phrase" &&
      step.arguments.arguments.include.includes("chordCandidates")
  );
  assert.ok(drill, "the guide must show how to request the harmonic-context sections");
  const drillRules = drill.readingRules.join(" ");
  assert.match(drillRules, /melody_only/);
  assert.match(drillRules, /never an observation of the real accompaniment/i);
  assert.match(drillRules, /Never state a chord progression as fact/i);
  assert.match(drillRules, /ranking margin, not a probability/i);
  assert.match(drillRules, /not_captured rather than assuming 4\/4/);
  const harmonicEntry = index.toolSelection.byNeed.find((entry) =>
    /cadence/i.test(entry.need)
  );
  assert.ok(harmonicEntry);
  assert.equal(harmonicEntry.scope, "melody_only");
});

test("every write recipe names the shared-target gate and the non-retryable outcomes", () => {
  const writeRecipes = [
    "align_and_commit_lyrics",
    "plan_and_commit_expression",
    "plan_and_commit_pitch",
    "quantize_notes",
    "generate_harmony",
  ];
  for (const id of writeRecipes) {
    const { recipe } = musicWorkflowGuideRecipe(id, "0.8.0");
    const commitSteps = recipe.steps.filter((step) => step.needsHumanDecision);
    assert.ok(commitSteps.length >= 1, `${id} must mark a human-decision gate`);
    assert.ok(
      commitSteps.every((step) =>
        step.needsHumanDecision.includes("SHARED_TARGET_REQUIRES_CONFIRMATION")
      ),
      `${id} must gate shared-target mutation`
    );
    const serialized = JSON.stringify(recipe);
    assert.ok(
      /outcome_unknown/.test(serialized),
      `${id} must tell the model not to blind-retry outcome_unknown`
    );
    assert.ok(
      recipe.steps.some((step) => step.arguments?.arguments?.dryRun === true),
      `${id} must dry-run before committing`
    );
  }
});

test("the guide is served over MCP, stays under 60 KiB, and pages by recipe id", async () => {
  await withServer(async (client) => {
    const listed = await client.listResources();
    assert.ok(
      listed.resources.some((resource) => resource.uri === "svcopilot://guide/music-workflows"),
      "the guide must be listed as a resource"
    );

    const templates = await client.listResourceTemplates();
    assert.ok(
      templates.resourceTemplates.some(
        (template) => template.uriTemplate === "svcopilot://guide/music-workflows/{recipe}"
      ),
      "per-recipe reads must be advertised as a template"
    );

    const indexResult = await client.readResource({ uri: "svcopilot://guide/music-workflows" });
    const indexBytes = Buffer.byteLength(indexResult.contents[0].text, "utf8");
    assert.ok(indexBytes < 60 * 1024, `guide index must stay under 60 KiB, got ${indexBytes}`);
    const index = parseResource(indexResult);
    assert.deepEqual(
      index.recipes.map((recipe) => recipe.id),
      REQUIRED_RECIPES
    );
    // 目录页不带 steps：细节留给单 recipe 读取，保证目录本身廉价。
    assert.ok(index.recipes.every((recipe) => recipe.steps === undefined));

    for (const id of REQUIRED_RECIPES) {
      const recipeResult = await client.readResource({
        uri: `svcopilot://guide/music-workflows/${id}`,
      });
      const bytes = Buffer.byteLength(recipeResult.contents[0].text, "utf8");
      assert.ok(bytes < 60 * 1024, `recipe ${id} must stay under 60 KiB, got ${bytes}`);
      const payload = parseResource(recipeResult);
      assert.equal(payload.recipe.id, id);
      assert.ok(payload.recipe.steps.length >= 1);
    }

    await assert.rejects(
      () => client.readResource({ uri: "svcopilot://guide/music-workflows/not_a_recipe" }),
      /Unknown workflow recipe/
    );

    // capabilities 必须指向指南，否则只读 capabilities 的模型发现不了它。
    const capabilities = parseResource(
      await client.readResource({ uri: "svcopilot://capabilities" })
    );
    assert.equal(capabilities.interfaces.guide.musicWorkflows, "svcopilot://guide/music-workflows");
    assert.deepEqual(capabilities.interfaces.guide.recipes, REQUIRED_RECIPES);
  });
});
