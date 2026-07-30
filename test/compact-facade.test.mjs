import "./helpers/pipe-namespace.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";

import { TOOLS } from "../server/src/index.js";
import { DESCRIBE_OPERATION_TOOL, createCompactFacade } from "../server/src/compact-facade.js";
import { buildOperationCatalog, operationNameForTool } from "../server/src/operation-catalog.js";

// compact-v2 facade 的跨层契约回归。
//
// 这个文件要挡住的回归是「facade 变成第二套契约」：schema 被复制、校验被放宽、
// operation 名与工具名脱钩、或者新增工具后 compact profile 悄悄漏掉它。
// 因此每条断言都拿 facade 与真实 TOOLS / 真实 spawned server 对比，
// 不使用任何手写的期望 schema。

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverScript = path.resolve(testDir, "..", "server", "src", "index.js");
const MAX_COMPACT_LIST_BYTES = 10 * 1024;

async function withClient(profile, fn) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverScript],
    env: {
      ...process.env,
      ...(profile ? { SV_COPILOT_TOOL_PROFILE: profile } : {}),
    },
    cwd: path.dirname(serverScript),
    stderr: "pipe",
  });
  const client = new Client({ name: "compact-facade-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

test("every tool carries a compact-facade routing label", () => {
  // 新增工具但忘记登记路由时，这里（以及 server 启动本身）立即失败。
  const { operations, excluded } = buildOperationCatalog(TOOLS);
  assert.equal(operations.size + excluded.length, TOOLS.length);
  for (const [name, entry] of operations) {
    assert.equal(name, operationNameForTool(entry.tool), "operation name must derive from tool name");
  }
});

test("catalog rejects unregistered and mislabeled tools", () => {
  assert.throws(
    () => buildOperationCatalog([...TOOLS, { name: "sv_brand_new", inputSchema: { type: "object" } }]),
    /no compact-facade routing label/
  );
  assert.throws(
    () => buildOperationCatalog(TOOLS.filter((tool) => tool.name !== "sv_patch_notes")),
    /references unknown tool "sv_patch_notes"/
  );
  // 把一个破坏性工具标成 read-only 分组必须被机械拒绝，而不是靠 review 记得看。
  const mutated = TOOLS.map((tool) =>
    tool.name === "sv_snapshot"
      ? { ...tool, annotations: { ...tool.annotations, readOnlyHint: false } }
      : tool
  );
  assert.throws(() => buildOperationCatalog(mutated), /must not be routed through facade group "read"/);
});

test("facade schemas are the same objects as direct tool schemas", () => {
  const facade = createCompactFacade(TOOLS);
  const { operations } = buildOperationCatalog(TOOLS);
  for (const entry of operations.values()) {
    const direct = TOOLS.find((tool) => tool.name === entry.tool);
    // 同一引用，不只是深相等：复制 schema 就是维护第二份契约。
    assert.equal(entry.inputSchema, direct.inputSchema, `${entry.tool} schema must be shared`);
  }
  assert.ok(facade.tools.some((tool) => tool.name === DESCRIBE_OPERATION_TOOL));
});

test("facade annotations are the most conservative value in each group", () => {
  const facade = createCompactFacade(TOOLS);
  const { operations } = buildOperationCatalog(TOOLS);
  for (const tool of facade.tools) {
    if (tool.name === DESCRIBE_OPERATION_TOOL) continue;
    const members = [...operations.values()].filter((entry) => entry.facade === tool.name);
    assert.ok(members.length > 0, `${tool.name} must have operations`);
    assert.equal(
      tool.annotations.readOnlyHint,
      members.every((entry) => entry.annotations?.readOnlyHint === true)
    );
    assert.equal(
      tool.annotations.destructiveHint,
      members.some((entry) => entry.annotations?.destructiveHint === true)
    );
  }
  const read = facade.tools.find((tool) => tool.name === "sv_read");
  const edit = facade.tools.find((tool) => tool.name === "sv_edit");
  assert.equal(read.annotations.readOnlyHint, true);
  assert.equal(read.annotations.destructiveHint, false);
  assert.equal(edit.annotations.destructiveHint, true);
});

test("resolveOperation refuses unknown and cross-facade operations", () => {
  const facade = createCompactFacade(TOOLS);
  assert.equal(facade.resolveOperation("sv_edit", "patch_notes").tool, "sv_patch_notes");
  assert.throws(() => facade.resolveOperation("sv_edit", "not_a_thing"), /unknown operation/);
  // 破坏性 operation 不得从只读 facade 进入：否则 annotations 是谎言。
  assert.throws(
    () => facade.resolveOperation("sv_read", "patch_notes"),
    /belongs to sv_edit, not sv_read/
  );
  assert.throws(
    () => facade.resolveOperation("sv_edit", "snapshot_range"),
    /belongs to sv_read, not sv_edit/
  );
});

test("raw dispatcher stays out of the compact profile", () => {
  const facade = createCompactFacade(TOOLS);
  const catalog = facade.catalog("test");
  assert.deepEqual(catalog.excludedTools.tools, [
    "sv_call",
    "sv_free",
    "sv_index",
    "sv_root",
    "sv_run",
  ]);
  for (const name of catalog.excludedTools.tools) {
    assert.ok(!facade.operationNames.includes(operationNameForTool(name)));
  }
});

test("compact-v2 tools/list stays under 10 KiB and exposes only facade tools", async () => {
  const listed = await withClient("compact-v2", (client) => client.listTools());
  const bytes = Buffer.byteLength(JSON.stringify(listed.tools), "utf8");
  assert.ok(
    bytes < MAX_COMPACT_LIST_BYTES,
    `compact-v2 tools/list must be under ${MAX_COMPACT_LIST_BYTES} bytes; got ${bytes}`
  );
  const names = listed.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, createCompactFacade(TOOLS).toolNames.sort());
  // direct tool 不出现在 compact profile 的清单里。
  assert.ok(!names.includes("sv_patch_notes"));
});

test("full profile is unchanged by the facade", async () => {
  const listed = await withClient(null, (client) => client.listTools());
  const names = listed.tools.map((tool) => tool.name);
  assert.equal(names.length, TOOLS.length);
  assert.ok(names.includes("sv_patch_notes"));
  assert.ok(names.includes("sv_call"));
  // facade 工具绝不泄漏到 full profile。
  for (const facadeName of createCompactFacade(TOOLS).toolNames) {
    assert.ok(!names.includes(facadeName), `${facadeName} must not appear in the full profile`);
  }
});

test("sv_describe_operation returns the served direct-tool schema verbatim", async () => {
  const { described, direct } = await withClient("compact-v2", async (client) => {
    const response = await client.callTool({
      name: DESCRIBE_OPERATION_TOOL,
      arguments: { operations: ["patch_notes", "snapshot_range"] },
    });
    return { described: response.structuredContent, direct: null };
  });
  assert.equal(described.ok, true);
  assert.equal(described.operations.length, 2);
  const patch = described.operations.find((entry) => entry.operation === "patch_notes");
  assert.equal(patch.tool, "sv_patch_notes");
  assert.equal(patch.facade, "sv_edit");
  // 与 full profile 里 tools/list 公布的 schema 逐字节相同。
  const served = await withClient(null, async (client) => {
    const listed = await client.listTools();
    return listed.tools.find((tool) => tool.name === "sv_patch_notes").inputSchema;
  });
  assert.deepEqual(patch.inputSchema, served);
  assert.equal(direct, null);
});

test("sv_describe_operation bounds its request and rejects unknown operations", async () => {
  await withClient("compact-v2", async (client) => {
    const tooMany = await client.callTool({
      name: DESCRIBE_OPERATION_TOOL,
      arguments: { operations: ["ping", "snapshot", "snapshot_range", "patch_notes", "edit_phrase"] },
    });
    assert.equal(tooMany.isError, true);
    assert.equal(tooMany.structuredContent.error.code, "INVALID_ARGUMENTS");

    const unknown = await client.callTool({
      name: DESCRIBE_OPERATION_TOOL,
      arguments: { operations: ["definitely_not_an_operation"] },
    });
    assert.equal(unknown.isError, true);
    assert.equal(unknown.structuredContent.error.code, "UNKNOWN_OPERATION");
    // 错误里要给出可用清单，否则模型只能猜。
    assert.ok(Array.isArray(unknown.structuredContent.error.availableOperations));
    assert.ok(unknown.structuredContent.error.availableOperations.includes("patch_notes"));
  });
});

test("unknown operation fails before reaching any handler", async () => {
  await withClient("compact-v2", async (client) => {
    const response = await client.callTool({
      name: "sv_edit",
      arguments: { operation: "not_an_operation", arguments: {} },
    });
    assert.equal(response.isError, true);
    assert.equal(response.structuredContent.error.code, "UNKNOWN_OPERATION");
    // 错误里给出的是该 facade 自己的清单，不是全部 operation。
    assert.ok(response.structuredContent.error.facadeOperations.includes("patch_notes"));
    assert.ok(!response.structuredContent.error.facadeOperations.includes("snapshot_range"));
  });
});

test("facade envelope rejects unknown outer fields and missing operation", async () => {
  await withClient("compact-v2", async (client) => {
    const extra = await client.callTool({
      name: "sv_read",
      arguments: { operation: "snapshot", arguments: {}, planRef: "sneaky" },
    });
    assert.equal(extra.isError, true);
    assert.equal(extra.structuredContent.error.code, "INVALID_ARGUMENTS");

    const missing = await client.callTool({ name: "sv_read", arguments: { arguments: {} } });
    assert.equal(missing.isError, true);
    assert.equal(missing.structuredContent.error.code, "INVALID_ARGUMENTS");
  });
});

test("facade does not relax inner argument validation", async () => {
  await withClient("compact-v2", async (client) => {
    // 内层未知字段必须被 direct tool 的严格 schema 拒绝，而不是被 facade 放过。
    const response = await client.callTool({
      name: "sv_edit",
      arguments: {
        operation: "patch_notes",
        arguments: { contextId: "ctx_missing", notes: [], totallyUnknownField: 1 },
      },
    });
    assert.equal(response.isError, true);
    assert.equal(response.structuredContent.error.code, "INVALID_ARGUMENTS");
    assert.match(response.structuredContent.error.message, /totallyUnknownField/);
  });
});

test("facade reaches the same handler and returns the same error as the direct tool", async () => {
  // 用一个必然失败于业务前置条件（未知 context）的请求对比两条路径：
  // 只要 facade 真的调用了同一个 handler，错误码与消息必然一致。
  const facadeResponse = await withClient("compact-v2", (client) =>
    client.callTool({
      name: "sv_read",
      arguments: { operation: "snapshot_range", arguments: { contextId: "ctx_does_not_exist" } },
    })
  );
  const directResponse = await withClient(null, (client) =>
    client.callTool({
      name: "sv_snapshot_range",
      arguments: { contextId: "ctx_does_not_exist" },
    })
  );
  assert.equal(facadeResponse.isError, true);
  assert.equal(directResponse.isError, true);
  assert.deepEqual(facadeResponse.structuredContent, directResponse.structuredContent);
});

test("direct tool names are rejected in the compact profile", async () => {
  await withClient("compact-v2", async (client) => {
    const response = await client.callTool({ name: "sv_patch_notes", arguments: {} });
    assert.equal(response.isError, true);
    assert.equal(response.structuredContent.error.code, "TOOL_NOT_ENABLED");
  });
});

test("svcopilot://operations catalog matches the served facade tools", async () => {
  const { catalog, listed } = await withClient("compact-v2", async (client) => {
    const resource = await client.readResource({ uri: "svcopilot://operations" });
    return {
      catalog: JSON.parse(resource.contents[0].text),
      listed: await client.listTools(),
    };
  });
  assert.equal(catalog.profile, "compact-v2");
  assert.equal(catalog.describeTool, DESCRIBE_OPERATION_TOOL);
  const catalogFacades = catalog.facades.map((entry) => entry.facade).sort();
  const servedFacades = listed.tools
    .map((tool) => tool.name)
    .filter((name) => name !== DESCRIBE_OPERATION_TOOL)
    .sort();
  assert.deepEqual(catalogFacades, servedFacades);
  // catalog 里每个 operation 都必须真的在对应 facade 的 enum 中。
  for (const entry of catalog.facades) {
    const tool = listed.tools.find((candidate) => candidate.name === entry.facade);
    const enumerated = tool.inputSchema.properties.operation.enum;
    assert.deepEqual(
      entry.operations.map((operation) => operation.operation).sort(),
      [...enumerated].sort()
    );
  }
  // catalog 资源本身也要小：它是模型的第一跳。
  const bytes = Buffer.byteLength(JSON.stringify(catalog), "utf8");
  assert.ok(bytes < 16 * 1024, `operations catalog must stay under 16 KiB; got ${bytes}`);
});

test("capabilities reports the compact profile honestly", async () => {
  const compact = await withClient("compact-v2", async (client) => {
    const resource = await client.readResource({ uri: "svcopilot://capabilities" });
    return JSON.parse(resource.contents[0].text);
  });
  assert.equal(compact.interfaces.toolProfile, "compact-v2");
  assert.equal(compact.interfaces.compact.active, true);
  assert.equal(compact.interfaces.compact.catalog, "svcopilot://operations");

  const full = await withClient(null, async (client) => {
    const resource = await client.readResource({ uri: "svcopilot://capabilities" });
    return JSON.parse(resource.contents[0].text);
  });
  assert.equal(full.interfaces.compact.active, false);
  // 即使未启用，也要告诉客户端这个 profile 存在。
  assert.equal(full.interfaces.compact.profile, "compact-v2");
});
