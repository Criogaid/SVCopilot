// SurfaceIoPolicy 覆盖门禁（计划 §9.10 / §2.3）。
//
// 这个文件挡住的是「新增暴露面没人登记」：一个 operation、resource 或 bridge opcode
// 加进去而没有传输策略，就意味着它的请求/响应预算、身份形状和回显规则都没人审过。
// 因此断言全部与真实来源比对（OperationCatalog、真实 spawned server 的 resource 清单、
// 真实 schema），不使用任何手写的期望清单。
import "./helpers/pipe-namespace.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";

import { TOOLS } from "../server/src/index.js";
import { buildOperationCatalog } from "../server/src/operation-catalog.js";
import { READ_NOTE_FINGERPRINTS_V1 } from "../server/src/note-fingerprint-reader.js";
import {
  BANNED_REQUEST_FIELDS,
  COMPACT_MAX_BYTES,
  ERROR_MAX_BYTES,
  LEGACY_REQUEST_FIELDS,
  POLICY_SHAPES,
  allowedEchoReason,
  buildSurfaceIoPolicies,
  isAllowedEcho,
} from "../server/src/surface-io-policy.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverScript = path.resolve(testDir, "..", "server", "src", "index.js");

const policies = buildSurfaceIoPolicies(TOOLS);
const byKind = (kind) => policies.filter((entry) => entry.kind === kind);

async function withClient(fn) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverScript],
    env: process.env,
    cwd: path.dirname(serverScript),
    stderr: "pipe",
  });
  const client = new Client({ name: "surface-io-policy-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

// schema 里所有 properties 键名（递归）。
function collectPropertyNames(schema, into = new Set()) {
  if (schema === null || typeof schema !== "object") return into;
  if (Array.isArray(schema)) {
    for (const item of schema) collectPropertyNames(item, into);
    return into;
  }
  if (schema.properties && typeof schema.properties === "object") {
    for (const name of Object.keys(schema.properties)) into.add(name);
  }
  for (const value of Object.values(schema)) collectPropertyNames(value, into);
  return into;
}

test("every operation is registered exactly once", () => {
  const { operations } = buildOperationCatalog(TOOLS);
  const counts = new Map();
  for (const entry of policies) counts.set(entry.key, (counts.get(entry.key) ?? 0) + 1);

  // Set 比较会吞掉重复登记，因此必须逐 key 校验计数恰好为 1（§9.10 注释）。
  for (const operation of operations.keys()) {
    assert.equal(
      counts.get(`operation:${operation}`),
      1,
      `operation:${operation} must be registered exactly once`
    );
  }
  assert.equal(byKind("operation").length, operations.size);
});

test("an unregistered operation fails the gate", () => {
  // 这是门禁的存在理由：加了 operation 但忘记登记策略时必须失败。
  const registered = new Set(byKind("operation").map((entry) => entry.operation));
  const { operations } = buildOperationCatalog(TOOLS);
  const missing = [...operations.keys()].filter((name) => !registered.has(name));
  assert.deepEqual(missing, [], `these operations have no SurfaceIoPolicy: ${missing.join(", ")}`);

  // 反向：登记了但 catalog 里不存在，说明策略表引用了已删除的 operation。
  const stale = [...registered].filter((name) => !operations.has(name));
  assert.deepEqual(stale, [], `these policies reference unknown operations: ${stale.join(", ")}`);
});

test("every facade tool carries a tool-level policy", async () => {
  const served = await withClient(async (client) => {
    const listed = await client.listTools();
    return listed.tools.map((tool) => tool.name);
  });
  const registered = new Set(byKind("tool").map((entry) => entry.tool));
  for (const name of served) {
    assert.ok(registered.has(name), `${name} is served but has no tool-level policy`);
  }
  // sv_describe 不套 operation 信封，因此它只可能有 tool-level policy——
  // 若哪天漏了，模型看到的唯一 discovery 入口就没有预算约束。
  assert.ok(registered.has("sv_describe"));
  assert.deepEqual([...registered].sort(), [...served].sort());
});

test("every served resource and template carries a policy", async () => {
  const { uris, templates } = await withClient(async (client) => {
    const [resources, resourceTemplates] = await Promise.all([
      client.listResources(),
      client.listResourceTemplates(),
    ]);
    return {
      uris: resources.resources.map((resource) => resource.uri),
      templates: resourceTemplates.resourceTemplates.map((template) => template.uriTemplate),
    };
  });
  const registered = new Set(byKind("resource").map((entry) => entry.uri));

  // 逐 tool schema resource（svcopilot://schemas/sv_xxx）由模板 policy 覆盖：
  // 它们是同一形状的 N 份实例，逐个登记只会让表随工具数增长而无新信息。
  const covered = (uri) =>
    registered.has(uri) || (uri.startsWith("svcopilot://schemas/") && registered.has("svcopilot://schemas/{tool}"));

  for (const uri of uris) {
    assert.ok(covered(uri), `resource ${uri} has no SurfaceIoPolicy`);
  }
  for (const template of templates) {
    assert.ok(registered.has(template), `template ${template} has no SurfaceIoPolicy`);
  }
});

test("every negotiated bridge opcode declares its frame and item limits", () => {
  const bridge = byKind("bridge");
  const registered = new Set(bridge.map((entry) => entry.bridgeOp));
  // 目前只协商一个 opcode；新增时必须同时登记上限，否则一次 bulk read 就能撑爆
  // 64 KiB frame 而没人拦（§2.3 规则 8）。
  assert.ok(registered.has(READ_NOTE_FINGERPRINTS_V1));
  for (const entry of bridge) {
    assert.ok(entry.maxFrameBytes > 0, `${entry.bridgeOp} needs maxFrameBytes`);
    assert.ok(entry.maxItems > 0, `${entry.bridgeOp} needs maxItems`);
    assert.ok(entry.maxFields > 0, `${entry.bridgeOp} needs maxFields`);
    assert.ok(
      entry.maxAllocations >= entry.maxItems,
      `${entry.bridgeOp}'s allocation cap must cover its item cap`
    );
    assert.ok(entry.maxFrameBytes <= 64 * 1024, "bridge frames stay within the 64 KiB transport cap");
  }
});

test("shapes come from the plan's closed vocabulary", () => {
  for (const entry of policies) {
    if (entry.requestShape !== undefined) {
      assert.ok(
        POLICY_SHAPES.includes(entry.requestShape),
        `${entry.key} requestShape "${entry.requestShape}" is not a plan §2.3 category`
      );
    }
    if (entry.responseShape !== undefined) {
      assert.ok(
        POLICY_SHAPES.includes(entry.responseShape),
        `${entry.key} responseShape "${entry.responseShape}" is not a plan §2.3 category`
      );
    }
  }
});

test("read-only operations declare no host writes", () => {
  // hostTraffic 与 annotations 必须一致：一个标着 readOnlyHint 的 operation 声明
  // hostTraffic:"write" 说明两者之一在说谎。
  const { operations } = buildOperationCatalog(TOOLS);
  for (const entry of byKind("operation")) {
    const catalogEntry = operations.get(entry.operation);
    if (catalogEntry.annotations?.readOnlyHint !== true) continue;
    assert.notEqual(
      entry.hostTraffic,
      "write",
      `${entry.operation} is annotated read-only but its policy claims host writes`
    );
  }
});

test("error budget is strictly smaller than the success budget", () => {
  // 错误绝不该塞进大型证据：预算相同的话，"有界错误"就退化成一句口号。
  assert.ok(ERROR_MAX_BYTES < COMPACT_MAX_BYTES);
  for (const entry of byKind("operation")) {
    assert.equal(entry.compactMaxBytes, COMPACT_MAX_BYTES);
    assert.equal(entry.errorMaxBytes, ERROR_MAX_BYTES);
  }
});

test("banned request fields never come back", () => {
  const names = new Set();
  for (const tool of TOOLS) collectPropertyNames(tool.inputSchema, names);
  const present = BANNED_REQUEST_FIELDS.filter((field) => names.has(field));
  assert.deepEqual(present, [], `these fields were removed and must not return: ${present.join(", ")}`);
});

test("the legacy request-field registry stays honest in both directions", () => {
  const names = new Set();
  for (const tool of TOOLS) collectPropertyNames(tool.inputSchema, names);

  // 过期条目：字段已经清掉却还登记着，会让"还欠多少"读成一份虚高的账单。
  const stale = Object.keys(LEGACY_REQUEST_FIELDS).filter((field) => !names.has(field));
  assert.deepEqual(stale, [], `remove these cleaned-up fields from the registry: ${stale.join(", ")}`);

  // 每项必须写明去处与阶段，否则这张表就是豁免口。
  for (const [field, note] of Object.entries(LEGACY_REQUEST_FIELDS)) {
    assert.match(note, /§/, `${field} must cite the plan section that removes it`);
    // 中文全角括号：注释与代码同一约定，别在门禁里悄悄换成半角。
    assert.match(note, /（(B2|C1|C2)）/, `${field} must name the phase that removes it`);
  }
});

test("allowedEchoes is a documented whitelist, not an escape hatch", () => {
  // §10.2.2 的三类必要回显。每项都必须带理由——门禁按这张表放行，
  // 没有理由的条目等于"以后谁都能往里加"。
  for (const field of ["invalidatedContexts", "data.id", "evidence.occurrence", "evidence.note"]) {
    assert.equal(isAllowedEcho(field), true, `${field} must be registered`);
    const reason = allowedEchoReason(field);
    assert.ok(reason && reason.length >= 20, `${field} needs a substantive reason`);
  }
  assert.equal(isAllowedEcho("contextId"), false, "a bare contextId echo is not whitelisted");
  assert.equal(allowedEchoReason("nonsense"), null);
});

test("no tool declares a vacuous outputSchema", async () => {
  // 计划 §13.4：outputSchema 要么不声明，要么严格。
  // `{type:"object", additionalProperties:true}` 是最坏的一种——MCP 客户端 SDK 会据此
  // 校验 structuredContent 并在缺失时报错，因此它把"必须符合"变成了空承诺。
  //
  // 现在选择"不声明"：根信封仍有 57 个迁移期字段在根级（root-envelope.js），一份如实
  // 覆盖当前形状的 schema 得允许 72 个字段，那是把现状抄一遍而不是契约。B2 收完
  // legacy 字段后再为已包信封的 facade 声明严格 schema。
  for (const tool of TOOLS) {
    assert.equal(
      tool.outputSchema,
      undefined,
      `${tool.name} declares an outputSchema; it must be strict or absent, never a bare object`
    );
  }
  const served = await withClient(async (client) => (await client.listTools()).tools);
  for (const tool of served) {
    assert.equal(
      tool.outputSchema,
      undefined,
      `${tool.name} is served with an outputSchema; see plan §13.4`
    );
  }
});

test("the registry is audit-only and never imported by a handler", async () => {
  // §2.3 规则 9：业务 handler 不得读它来决定语义。两份真相会立刻开始漂移，
  // 而且 policy 表本来只是给门禁看的。
  const { readFile, readdir } = await import("node:fs/promises");
  const srcDir = path.resolve(testDir, "..", "server", "src");
  const files = (await readdir(srcDir)).filter(
    (name) => name.endsWith(".js") && name !== "surface-io-policy.js"
  );
  const importers = [];
  for (const name of files) {
    const source = await readFile(path.join(srcDir, name), "utf8");
    if (source.includes("surface-io-policy.js")) importers.push(name);
  }
  assert.deepEqual(
    importers,
    [],
    `SurfaceIoPolicy must stay audit-only; imported by: ${importers.join(", ")}`
  );
});
