// 第 14 章量化门禁中**离线可测**的那部分（C4 步骤 1）。
//
// 为什么要单独一个文件：§14 的表格混着两类门禁。一类只需要序列化和纯函数就能判定
// （请求体积、身份出现次数、信封上限），另一类必须有真机或独立 LLM 会话（翻页行为、
// 10 分钟工作流 Context expiry、模型是否重复读 schema）。前者能在 npm test 里持续
// 生效，后者只能在 §15 验收时人工执行。把两者混在散落的测试里，结果是没人能回答
// "离线那部分到底过了没有"。
//
// 数值一律从真实结构派生，不写死常量：门槛本身来自计划（35%、12 KiB、16 KiB、8 KiB），
// 而被测量的那一侧必须是当前代码的实际输出。手写实测值会让门禁在下一次重构后变成
// 一句过时的断言。
import assert from "node:assert/strict";
import test from "node:test";

import { TOOLS } from "../server/src/index.js";
import { createCompactFacade, MAX_DESCRIBE_BYTES } from "../server/src/compact-facade.js";
import { buildOperationCatalog } from "../server/src/operation-catalog.js";
import { COMPACT_MAX_BYTES, ERROR_MAX_BYTES } from "../server/src/surface-io-policy.js";
import { ArtifactStore } from "../server/src/artifact-store.js";
import { ExpressionPlanService } from "../server/src/expression-plan.js";
import { SnapshotStore } from "../server/src/snapshot.js";

const Q = 705_600_000;

// §14 的门槛。这些是计划规定的目标值，因此可以是常量；被比较的另一侧不可以。
const GROUPED_REQUEST_MAX_RATIO = 0.35;
const LIST_TOOLS_MAX_BYTES = 12 * 1024;

const utf8 = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");

function createRangeContext(store, noteCount) {
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
    targetGroupUuid: "uuid-gate",
    timeOffsetBlick: 0,
    pitchOffsetSemitone: 0,
    groupNoteCount: noteCount,
    sharedTargetOccurrences: [0],
    noteFingerprints: Array.from({ length: noteCount }, (_, index) => ({
      indexInGroup: index,
      onsetBlick: index * 2 * Q,
      durationBlick: 2 * Q,
      pitch: 60 + (index % 12),
      lyrics: "la",
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

// §3.4 的示例请求，逐字段照抄计划。它同时是 grouped schema 的可执行文档：
// 若 schema 漂移到无法接受这份请求，这里会先失败。
function groupedExpressionRequest(contextId) {
  return {
    contextId,
    occurrence: 0,
    defaults: {
      vibrato: {
        surface: "pitchDelta",
        rateHz: 5.2,
        onsetDelayQuarter: 0.22,
        rampQuarter: 0.18,
        fadeOutQuarter: 0.14,
      },
      scoop: { lengthQuarter: 0.16, shapePower: 2 },
      fall: { lengthQuarter: 0.22, shapePower: 2 },
    },
    gestures: [
      {
        type: "hairpin",
        from: 0,
        to: 62,
        peak: 0.72,
        amounts: { loudness: 1.2, tension: 0.08, breathiness: 0.12 },
      },
      { type: "vibrato", notes: [62, 121, 178, 237, 296], depthCents: 15 },
      { type: "vibrato", notes: [314, 336], depthCents: 18 },
      { type: "scoop", targets: [[87, 22], [203, 24], [274, 18], [302, 28]] },
      { type: "fall", targets: [[157, 22], [273, 26], [372, 32]] },
    ],
    constraints: {
      maxAbsPitchDeltaCents: 80,
      maxAbsLoudnessDeltaDb: 4.5,
      maxAbsTensionDelta: 0.45,
      maxAbsBreathinessDelta: 0.25,
      maxTotalPoints: 1200,
      avoidExcessiveVibrato: true,
    },
    sampling: { pointsPerQuarter: 4, vibratoPointsPerCycle: 8 },
  };
}

// 迁移前的等价请求：同一音乐意图，但身份是完整字符串 ID，hairpin 每参数一条，
// vibrato 每 Note 一条且重复全部共享参数，scoop/fall 每 Note 一条。
//
// 这不是"随便写一个更长的版本"——它精确复现 §1.1 列出的四种重复来源，否则比值
// 就只是在跟一个虚构的坏例子比。
function legacyExpressionRequest(contextId) {
  const occurrenceId = `${contextId}:t:0:r:0`;
  const nid = (index) => `${occurrenceId}:n:${index}`;
  const gestures = [];
  for (const [parameter, amount] of [
    ["loudness", 1.2],
    ["tension", 0.08],
    ["breathiness", 0.12],
  ]) {
    gestures.push({
      type: "hairpin",
      fromNoteId: nid(0),
      toNoteId: nid(62),
      parameter,
      amount,
      peakPosition: 0.72,
    });
  }
  for (const [notes, depthCents] of [
    [[62, 121, 178, 237, 296], 15],
    [[314, 336], 18],
  ]) {
    for (const index of notes) {
      gestures.push({
        type: "vibrato",
        noteId: nid(index),
        surface: "pitchDelta",
        depthCents,
        rateHz: 5.2,
        onsetDelayQuarter: 0.22,
        rampQuarter: 0.18,
        fadeOutQuarter: 0.14,
      });
    }
  }
  for (const [index, depthCents] of [[87, 22], [203, 24], [274, 18], [302, 28]]) {
    gestures.push({
      type: "scoop",
      noteId: nid(index),
      depthCents,
      lengthQuarter: 0.16,
      shapePower: 2,
    });
  }
  for (const [index, depthCents] of [[157, 22], [273, 26], [372, 32]]) {
    gestures.push({
      type: "fall",
      noteId: nid(index),
      depthCents,
      lengthQuarter: 0.22,
      shapePower: 2,
    });
  }
  return {
    contextId,
    occurrenceId,
    gestures,
    constraints: {
      maxAbsPitchDeltaCents: 80,
      maxAbsLoudnessDeltaDb: 4.5,
      maxAbsTensionDelta: 0.45,
      maxAbsBreathinessDelta: 0.25,
      maxTotalPoints: 1200,
      avoidExcessiveVibrato: true,
    },
    sampling: { pointsPerQuarter: 4, vibratoPointsPerCycle: 8 },
  };
}

test("a grouped expression request stays under 35% of the pre-migration shape", () => {
  const contextId = "c_N7GgW3hQyWmVxA";
  const groupedBytes = utf8(groupedExpressionRequest(contextId));
  const legacyBytes = utf8(legacyExpressionRequest(contextId));
  const ratio = groupedBytes / legacyBytes;
  assert.ok(
    ratio < GROUPED_REQUEST_MAX_RATIO,
    `grouped request must stay under ${GROUPED_REQUEST_MAX_RATIO * 100}% of the legacy shape; ` +
      `got ${(ratio * 100).toFixed(1)}% (${groupedBytes} vs ${legacyBytes} bytes)`
  );
  // 收益的来源必须是分组本身，而不是碰巧删了几个字段：gesture 条数下降，
  // 且请求里一个完整 Note ID 都不剩。
  assert.ok(groupedExpressionRequest(contextId).gestures.length < 6);
  assert.ok(legacyExpressionRequest(contextId).gestures.length > 15);
});

test("no request in the served surface carries a context-prefixed note identity", () => {
  // §14：普通请求中完整 Note/Occurrence ID 的出现次数 = 0。
  // 这里查的是**请求**侧：任何仍以 `<contextId>:n:<index>` 形状描述身份的 schema
  // 字段都会让模型重新开始拼长字符串。
  const request = groupedExpressionRequest("c_N7GgW3hQyWmVxA");
  assert.equal(JSON.stringify(request).includes(":n:"), false);
  assert.equal(JSON.stringify(request).includes(":t:0:r:0"), false);

  // schema 侧：没有任何 operation 还声明 noteId / noteIds / startNoteId 之类的字段。
  const { operations } = buildOperationCatalog(TOOLS);
  const offenders = [];
  for (const entry of operations.values()) {
    const names = new Set();
    collectPropertyNames(entry.inputSchema, names);
    for (const banned of ["noteId", "noteIds", "fromNoteId", "toNoteId", "startNoteId"]) {
      if (names.has(banned)) offenders.push(`${entry.operation}.${banned}`);
    }
  }
  assert.deepEqual(offenders, [], `string note identities remain in: ${offenders.join(", ")}`);
});

test("no served description promises a field the surface no longer returns", () => {
  // §14 只数了请求侧的长身份，但描述同样是契约的一部分——本轮没有 outputSchema，
  // 因此工具描述是模型唯一能读到的输出形状说明。三份分析器描述曾在 input schema
  // 清空 noteId 之后仍写着"结果含 noteIds"，那会直接把使用者引向一个不存在的字段。
  const offenders = [];
  for (const tool of TOOLS) {
    const description = tool.description ?? "";
    for (const banned of [
      "noteId",
      "noteIds",
      "startNoteId",
      "fromNoteId",
      "toNoteId",
      "occurrenceId",
      "sourceOccurrenceId",
      "targetOccurrenceId",
    ]) {
      if (description.includes(banned)) offenders.push(`${tool.name}: ${banned}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `descriptions still promise removed identity fields: ${offenders.join(", ")}`
  );
});

test("tools/list and every describe response stay inside their byte budgets", () => {
  // §14：默认 tools/list < 12 KiB；单次 sv_describe < 16 KiB。
  const listBytes = utf8(TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  })));
  // TOOLS 是内部 42 个 handler；模型看到的是 facade 投影，因此这里测的是后者。
  const facade = createCompactFacade(TOOLS);
  const servedBytes = utf8(facade.tools);
  assert.ok(
    servedBytes < LIST_TOOLS_MAX_BYTES,
    `served tools/list must stay under 12 KiB; got ${servedBytes}`
  );
  // 内部 handler 总量远大于送出的量——这正是 facade 的收益，顺手记录下来，
  // 让"为什么需要 facade"在门禁里也有据可查。
  assert.ok(listBytes > servedBytes * 5);

  const { operations } = buildOperationCatalog(TOOLS);
  for (const entry of operations.values()) {
    const response = facade.describe([entry.operation]);
    const bytes = utf8(response);
    assert.ok(
      bytes <= MAX_DESCRIBE_BYTES,
      `describe(${entry.operation}) must stay within ${MAX_DESCRIBE_BYTES} bytes; got ${bytes}`
    );
    // 单个 operation 永远不该被推迟：预算是给多 operation 请求留的，
    // 一个都放不下说明某份 schema 已经越界。
    assert.deepEqual(
      response.deferred?.operations ?? [],
      [],
      `describe(${entry.operation}) must fit on its own`
    );
  }
});

test("a planner success envelope fits the compact budget without its detail payload", async () => {
  // §14：compact success envelope ≤ 16 KiB。用 373 音符（§15 的真实规模）验证，
  // 因为体积问题只在真实规模下出现。
  //
  // artifactStore + sessionId 是必需的，不是测试便利：预算只有在 planRef 路径上
  // 才成立。没有它们时 planner 会内联整份 applyRequests（含每条曲线的全部控制点），
  // 实测 68 KiB——responseMode:"compact" 一个人挡不住这件事。
  const store = new SnapshotStore({ now: () => 1000 });
  const { stored } = createRangeContext(store, 373);
  const result = await new ExpressionPlanService({
    store,
    now: () => 2000,
    artifactStore: new ArtifactStore({ now: () => 2000 }),
    sessionId: "sess_gate",
  }).plan({
    contextId: stored.contextId,
    ...groupedExpressionRequest(stored.contextId),
  });
  assert.equal(result.ok, true);
  const bytes = utf8(result);
  assert.ok(
    bytes <= COMPACT_MAX_BYTES,
    `compact planner envelope must stay within ${COMPACT_MAX_BYTES} bytes; got ${bytes}`
  );
  // compact 的收益必须来自把明细移出主路径，而不是少算了 operation。
  assert.ok(result.summary.operationCount > 0);
  assert.equal(result.gestures, undefined);
  assert.equal(result.operations, undefined);
  // 明细移出主路径的证据：apply 只交接一个短 planRef，不内联 applyRequests。
  assert.equal(typeof result.apply.arguments.planRef, "string");
  assert.equal(result.applyRequests, undefined);
});

test("every mutation requires an explicit action and no schema takes dryRun", () => {
  // §10.6 / §13.4 规则 5：写入意图必须显式。`dryRun` 是布尔，因此带默认值，而在写
  // 操作上默认值指向错误的方向——省略它就等于同意写入。`action` 是无默认 enum，
  // 所以「忘了填」在 schema 层就被拒绝，而不是变成一次真实写入。
  //
  // 这条门禁同时查两侧：dryRun 不得回来，且每条 mutation 路径都必须 require action。
  // 只查前者不够——把 action 加进 properties 但忘了加进 required，会让漏填重新变成
  // 「Ajv 放行、服务端默认提交」。
  const { operations } = buildOperationCatalog(TOOLS);
  const offenders = [];
  const notRequired = [];
  for (const entry of operations.values()) {
    const names = new Set();
    collectPropertyNames(entry.inputSchema, names);
    if (names.has("dryRun")) offenders.push(entry.operation);
    const schema = entry.inputSchema;
    if (!schema.properties?.action) continue;
    // action 存在时，它必须出现在每一个 required 分支里（顶层 required，或 oneOf 的
    // 每一支）。任何一支漏掉，那条路径就还能不带 action 提交。
    const branches = Array.isArray(schema.oneOf)
      ? schema.oneOf.map((branch) => branch.required ?? [])
      : [schema.required ?? []];
    if (!branches.every((required) => required.includes("action"))) {
      notRequired.push(entry.operation);
    }
  }
  assert.deepEqual(offenders, [], `dryRun must not come back: ${offenders.join(", ")}`);
  assert.deepEqual(
    notRequired,
    [],
    `these operations accept action but do not require it on every path: ${notRequired.join(", ")}`
  );
});

test("no response echoes a context-prefixed occurrence identity", async () => {
  // 请求侧的门禁（surface-io-policy 的 BANNED_REQUEST_FIELDS）只看 input schema，
  // 因此挡不住"请求收 ordinal、响应仍回字符串"这种半迁移状态——而那恰恰是最坏的
  // 形态：模型从响应里读到一个它无法回传的身份，只能自己拆字符串。
  //
  // 本轮没有 outputSchema，所以响应形状唯一可机械检查的方式就是真跑一次并扫描
  // 序列化结果。`:t:<n>:r:<n>` 是被删掉的那个形状，它内嵌一个已经失效的 contextId。
  const store = new SnapshotStore({ now: () => 1000 });
  const { stored } = createRangeContext(store, 373);
  const result = await new ExpressionPlanService({
    store,
    now: () => 2000,
    artifactStore: new ArtifactStore({ now: () => 2000 }),
    sessionId: "sess_ordinal_gate",
  }).plan({
    contextId: stored.contextId,
    ...groupedExpressionRequest(stored.contextId),
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(":r:"), false, "response still carries an occurrence ID string");
  assert.equal(serialized.includes(":n:"), false, "response still carries a note ID string");
  const names = new Set();
  collectKeyNames(result, names);
  const offenders = ["occurrenceId", "sourceOccurrenceId", "targetOccurrenceId", "noteId", "noteIds"]
    .filter((field) => names.has(field));
  assert.deepEqual(offenders, [], `response fields must be ordinals: ${offenders.join(", ")}`);
  // 正向证据：ordinal 确实在响应里，否则上面三条断言在"什么都不回"时也会通过。
  // planner 的 occurrence 是个描述符对象，其内层 occurrence 才是可回传的 ordinal。
  assert.equal(result.occurrence.occurrence, 0);
  assert.deepEqual(result.occurrence.sharedTargetOccurrences, [0]);
});

// 递归收集一个响应值里出现过的所有对象键名。
function collectKeyNames(value, into) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeyNames(item, into);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    into.add(key);
    collectKeyNames(child, into);
  }
}

test("a planner failure envelope stays inside the smaller error budget", async () => {
  // §14：error envelope ≤ 8 KiB，且不得回显调用方刚发过的大型请求。
  // 错误预算比成功预算小是刻意的：失败时最该给的是可执行的下一步，不是证据堆。
  const store = new SnapshotStore({ now: () => 1000 });
  const { stored } = createRangeContext(store, 373);
  const service = new ExpressionPlanService({ store, now: () => 2000 });
  let failure = null;
  try {
    await service.plan({
      contextId: stored.contextId,
      occurrence: 0,
      // 越界 index：错误必须点明位置，但不能把整份 gestures 抄回来。
      gestures: [{ type: "scoop", targets: [[9999, 30]] }],
    });
  } catch (error) {
    failure = { code: error.code, message: error.message, details: error.details };
  }
  assert.ok(failure, "an out-of-range note index must fail");
  assert.equal(failure.code, "NOTE_INDEX_OUT_OF_RANGE");
  const bytes = utf8(failure);
  assert.ok(
    bytes <= ERROR_MAX_BYTES,
    `error envelope must stay within ${ERROR_MAX_BYTES} bytes; got ${bytes}`
  );
  // 有界证据：越界值本身要给出，捕获范围只给摘要，不逐个列出 373 个 index。
  assert.equal(failure.details.got, 9999);
});

function collectPropertyNames(node, into) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectPropertyNames(item, into);
    return;
  }
  if (node.properties && typeof node.properties === "object") {
    for (const name of Object.keys(node.properties)) into.add(name);
  }
  for (const [key, value] of Object.entries(node)) {
    // properties 的**键**是字段名，已在上面收过；这里只继续走 schema 结构，
    // 不把 default / const 之类的数据当 schema 递归。
    if (key === "default" || key === "const" || key === "enum" || key === "examples") continue;
    collectPropertyNames(value, into);
  }
}
