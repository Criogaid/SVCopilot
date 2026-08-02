// 根信封字段全集的回归（计划 §10.2.1）。
//
// 「未列出的字段就是禁止的」需要一个能真正拒绝新字段的门禁。这里对真实 spawned
// server 发起覆盖成功/失败/分析/规划/事务各类信封的调用，逐个检查根级字段是否已在
// root-envelope.js 登记。新服务往根上加字段时，这个测试立即失败——而不是等到某个
// 客户端发现契约变了。
import "./helpers/pipe-namespace.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";

import {
  DETAIL_PATHS,
  LEGACY_ROOT_FIELDS,
  ROOT_ENVELOPE_FIELDS,
  STATUSLESS_OPERATIONS,
  classifyRootField,
  isStatuslessOperation,
  unregisteredRootFields,
} from "../server/src/root-envelope.js";
import { RESULT_STATUSES } from "../server/src/result-status.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverScript = path.resolve(testDir, "..", "server", "src", "index.js");
const MISSING_CONTEXT = "c_missing000000000";

// 不需要宿主连接即可返回信封的调用。覆盖：scalar、诊断、API 查询、四类分析、
// 四个规划器、mutation 校验失败、editor state、artifact、raw dispatcher。
const CALLS = [
  ["sv_status", "ping", {}],
  ["sv_status", "doctor", {}],
  ["sv_status", "search_api", { query: "setLyrics" }],
  ["sv_status", "describe_api", { class: "Note" }],
  ["sv_read", "analyze_phrase", { contextId: MISSING_CONTEXT }],
  ["sv_read", "style_profile", { targets: [{ contextId: MISSING_CONTEXT }] }],
  ["sv_read", "check_prosody", { contextId: MISSING_CONTEXT }],
  ["sv_read", "analyze_vocal_context", { contextId: MISSING_CONTEXT }],
  [
    "sv_read",
    "compare_computed_pitch",
    { mode: "compare_to_target", contextId: MISSING_CONTEXT },
  ],
  ["sv_plan", "plan_expression", { contextId: MISSING_CONTEXT, intent: { genre: "jpop" } }],
  ["sv_plan", "align_lyrics", { contextId: MISSING_CONTEXT, lyrics: "占" }],
  [
    "sv_plan",
    "quantize_notes",
    { contextId: MISSING_CONTEXT, grid: { quarter: { numerator: 1, denominator: 4 } } },
  ],
  [
    "sv_plan",
    "generate_harmony",
    {
      contextId: MISSING_CONTEXT,
      targetOccurrence: 1,
      harmony: { interval: "third_above" },
    },
  ],
  ["sv_plan", "plan_pitch_gesture", { contextId: MISSING_CONTEXT, gestures: [] }],
  [
    "sv_edit",
    "patch_notes",
    { contextId: MISSING_CONTEXT, patches: [{ noteId: "x", set: { lyrics: "a" } }] },
  ],
  ["sv_artifact", "release", { artifactId: "a_missing0000000" }],
  // 刻意不包含需要活宿主的调用（sv_raw、ping、set_selection）：没有宿主时它们只能
  // 等满 10 秒调用超时，而它们贡献的是同一个 encodeToolError 错误信封（已由
  // patch_notes 覆盖）。它们的成功形状属于 STATUSLESS_OPERATIONS 登记的欠迁移项，
  // 由 smoke 测试在真实桥上覆盖。
];

// 一次采集，全部测试复用。host-backed 的 operation 在无宿主时要等满 10s 调用超时，
// 逐个测试各自 spawn 一次会让这个文件跑 4 分钟以上。
let cached = null;
function collectEnvelopes() {
  cached ??= collectEnvelopesOnce();
  return cached;
}

async function collectEnvelopesOnce() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverScript],
    env: process.env,
    cwd: path.dirname(serverScript),
    stderr: "pipe",
  });
  const client = new Client({ name: "root-envelope-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    // 并发发起：host-backed 的几个调用在没有宿主时各自要等满 10s 调用超时，
    // 串行会让本文件跑上 40s。Relay 内部仍是 lockstep，并发只是让这些超时重叠。
    return await Promise.all(
      CALLS.map(async ([tool, operation, args]) => {
        const response = await client.callTool({
          name: tool,
          arguments: { operation, arguments: args },
        });
        return {
          operation,
          isError: response.isError === true,
          payload: response.structuredContent,
        };
      })
    );
  } finally {
    await client.close().catch(() => {});
  }
}

test("every root field a real server emits is registered", async () => {
  const envelopes = await collectEnvelopes();
  assert.equal(envelopes.length, CALLS.length);

  const offenders = [];
  for (const { operation, payload } of envelopes) {
    for (const field of unregisteredRootFields(payload)) {
      offenders.push(`${operation}.${field}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these root fields are in neither ROOT_ENVELOPE_FIELDS nor LEGACY_ROOT_FIELDS: ${offenders.join(", ")}`
  );
});

test("enveloped results carry no legacy business field at the root", async () => {
  // 上一个测试只问「这个根级字段登记过吗」，因此登记表既能记录欠迁移项、也能变成
  // 永久豁免口——只要写进表里就永远不会失败。这条门禁问的是另一个问题：**已经有
  // 信封的** operation 必须已经完成折叠，登记表对它们不再是通行证。
  //
  // 仍有信封的 operation 全部走 encodeToolResult 的同一个出口，因此这条断言覆盖整个
  // surface；没有信封的（STATUSLESS_OPERATIONS）不在范围内——它们连 data 都还没定义。
  const offenders = [];
  for (const { operation, payload } of await collectEnvelopes()) {
    if (typeof payload?.status !== "string") continue;
    for (const field of Object.keys(payload)) {
      if (classifyRootField(field) === "legacy") offenders.push(`${operation}.${field}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these business fields must be folded into data, not left at the root: ${offenders.join(", ")}`
  );
});

test("detail never appears at the root", async () => {
  // 根级 detail 会把「业务明细超预算」与「错误证据超预算」混成一个字段。
  // 计划 §10.2.1 固定它只出现在 data.detail 或 error.detail。
  assert.deepEqual([...DETAIL_PATHS], ["data.detail", "error.detail"]);
  for (const { operation, payload } of await collectEnvelopes()) {
    assert.equal(
      Object.hasOwn(payload ?? {}, "detail"),
      false,
      `${operation} put detail at the root; it belongs in ${DETAIL_PATHS.join(" or ")}`
    );
  }
});

test("status is present and inside the frozen matrix wherever there is an envelope", async () => {
  const statusless = [];
  for (const { operation, payload } of await collectEnvelopes()) {
    if (typeof payload?.status !== "string") {
      // 未登记的"缺 status"必须失败；已登记的收集起来，下一个测试核对清单。
      assert.ok(
        isStatuslessOperation(operation),
        `${operation} carries no status and is not registered in STATUSLESS_OPERATIONS`
      );
      statusless.push(operation);
      continue;
    }
    assert.ok(
      RESULT_STATUSES.includes(payload.status),
      `${operation} returned status "${payload.status}" outside the frozen matrix`
    );
  }
  assert.ok(statusless.length > 0, "the probe must actually exercise the statusless operations");
});

test("the statusless registry has no stale entries", async () => {
  // 登记表的价值在于「还欠几个」可数。某个 operation 已经包上信封后，
  // 这条断言迫使它从表里删掉，而不是把表留成一份过期名单。
  //
  // 只检查成功路径：错误一律经 encodeToolError 产出，必然带 status，因此
  // 一个失败的 envelope 说明不了它的成功路径有没有信封。没有真实宿主时
  // ping / sv_raw 只能走错误路径，故这里观察不到它们——登记表仍如实记着它们欠迁移。
  for (const { operation, isError, payload } of await collectEnvelopes()) {
    if (isError || !isStatuslessOperation(operation)) continue;
    assert.equal(
      typeof payload?.status,
      "undefined",
      `${operation} now returns a status; remove it from STATUSLESS_OPERATIONS`
    );
  }
  // 表里每一项都必须写明将来包成什么形状。
  for (const [operation, plan] of Object.entries(STATUSLESS_OPERATIONS)) {
    assert.ok(plan.length >= 10, `${operation}'s migration note is too vague: "${plan}"`);
  }
});

test("failure envelopes carry an error and success envelopes do not", async () => {
  for (const { operation, isError, payload } of await collectEnvelopes()) {
    if (isError) {
      assert.ok(payload.error, `${operation} failed but carries no error`);
      assert.equal(typeof payload.error.code, "string");
    } else {
      assert.equal(
        Object.hasOwn(payload, "error"),
        false,
        `${operation} succeeded but carries an error`
      );
    }
  }
});

test("the contract field set is exactly the plan's fifteen", () => {
  assert.deepEqual(Object.keys(ROOT_ENVELOPE_FIELDS).sort(), [
    "data",
    "effects",
    "error",
    "evidence",
    "invalidatedContexts",
    "next",
    "processing",
    "recovery",
    "retryable",
    "rollback",
    "status",
    "timing",
    "undo",
    "verification",
    "warnings",
  ]);
  // 契约字段与迁移期字段不得重叠：一个字段要么已经是契约，要么还欠迁移。
  for (const field of Object.keys(LEGACY_ROOT_FIELDS)) {
    assert.equal(
      Object.hasOwn(ROOT_ENVELOPE_FIELDS, field),
      false,
      `${field} cannot be both a contract field and a legacy field`
    );
  }
  assert.equal(classifyRootField("status"), "contract");
  assert.equal(classifyRootField("contextId"), "legacy");
  for (const removed of ["applyRequests", "patchRequest", "restructureRequest"]) {
    assert.equal(
      classifyRootField(removed),
      "violation",
      `${removed} must not return through the legacy allowlist`
    );
  }
  assert.equal(classifyRootField("brandNewField"), "violation");
});

test("every legacy entry states where the field is going", () => {
  // 这张表的作用是让「还欠多少」可数。没有去处说明的条目会让它退化成豁免口。
  for (const [field, reason] of Object.entries(LEGACY_ROOT_FIELDS)) {
    assert.equal(typeof reason, "string", `${field} needs a reason`);
    assert.ok(reason.length >= 10, `${field}'s reason is too vague: "${reason}"`);
  }
});
