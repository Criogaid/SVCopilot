import "./helpers/pipe-namespace.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";

import { TOOLS } from "../server/src/index.js";
import {
  DESCRIBE_OPERATION_TOOL,
  MAX_DESCRIBE_BYTES,
  MAX_DESCRIBE_OPERATIONS,
  createCompactFacade,
} from "../server/src/compact-facade.js";
import { buildOperationCatalog, operationNameForTool } from "../server/src/operation-catalog.js";
import { jsonContentHash } from "../server/src/schema-identity.js";

// facade 是唯一 MCP surface 的跨层契约回归。
//
// 这个文件要挡住的回归是「facade 变成第二套契约」：schema 被复制、校验被放宽、
// operation 名与工具名脱钩、或者新增工具后 facade 悄悄漏掉它（在只有一个 surface
// 的世界里，漏掉即不可达）。因此每条断言都拿 facade 与真实 TOOLS / 真实 spawned
// server 对比，不使用任何手写的期望 schema。

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverScript = path.resolve(testDir, "..", "server", "src", "index.js");
const MAX_LIST_BYTES = 12 * 1024;
const EXPECTED_FACADES = [
  "sv_status",
  "sv_read",
  "sv_plan",
  "sv_edit",
  "sv_audition",
  "sv_artifact",
  "sv_raw",
  DESCRIBE_OPERATION_TOOL,
];

async function withClient(fn) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverScript],
    env: process.env,
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

test("every tool carries a facade routing label", () => {
  // facade 是唯一 surface，因此没有"排除"选项：每个工具都必须可达。
  const { operations } = buildOperationCatalog(TOOLS);
  assert.equal(operations.size, TOOLS.length);
  for (const [name, entry] of operations) {
    assert.equal(name, operationNameForTool(entry.tool), "operation name must derive from tool name");
  }
});

test("catalog rejects unregistered and mislabeled tools", () => {
  assert.throws(
    () => buildOperationCatalog([...TOOLS, { name: "sv_brand_new", inputSchema: { type: "object" } }]),
    /no facade routing label/
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

test("sv_raw keeps the official SV2 escape hatch reachable", () => {
  // 没有 sv_raw，从全量 surface 收敛到 8 工具时这 5 个 dispatcher 就无处可去。
  const facade = createCompactFacade(TOOLS);
  const raw = facade.tools.find((tool) => tool.name === "sv_raw");
  assert.deepEqual([...raw.inputSchema.properties.operation.enum].sort(), [
    "call",
    "free",
    "index",
    "root",
    "run",
  ]);
  assert.equal(raw.annotations.readOnlyHint, false);
  for (const operation of ["root", "call", "index", "free", "run"]) {
    assert.equal(facade.resolveOperation("sv_raw", operation).facade, "sv_raw");
  }
});

test("audition operations drop the redundant verb suffix", () => {
  const facade = createCompactFacade(TOOLS);
  const audition = facade.tools.find((tool) => tool.name === "sv_audition");
  assert.deepEqual([...audition.inputSchema.properties.operation.enum].sort(), [
    "compare",
    "get",
    "get_compare",
    "restore",
    "start",
    "stop",
    "stop_compare",
  ]);
  // sv_describe 这个工具名让位给 schema discovery；官方 API 描述改叫 describe_api。
  assert.equal(facade.resolveOperation("sv_status", "describe_api").tool, "sv_describe");
});

test("artifact facade exposes short read and compatible release operations", () => {
  const facade = createCompactFacade(TOOLS);
  const artifact = facade.tools.find((tool) => tool.name === "sv_artifact");
  assert.deepEqual([...artifact.inputSchema.properties.operation.enum].sort(), ["read", "release"]);
  assert.equal(facade.resolveOperation("sv_artifact", "read").tool, "sv_read_artifact");
  assert.equal(facade.resolveOperation("sv_artifact", "release").tool, "sv_release_artifact");
  // 分组含 release，因此 annotations 必须保持最保守的 destructive=true。
  assert.equal(artifact.annotations.destructiveHint, true);
});

test("tools/list is exactly the facade surface and stays small", async () => {
  const listed = await withClient((client) => client.listTools());
  const bytes = Buffer.byteLength(JSON.stringify(listed.tools), "utf8");
  assert.ok(bytes < MAX_LIST_BYTES, `tools/list must be under ${MAX_LIST_BYTES} bytes; got ${bytes}`);
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [...EXPECTED_FACADES].sort());
  // direct tool 不再出现在清单里；它们只是内部组织单位。
  const names = listed.tools.map((tool) => tool.name);
  assert.ok(!names.includes("sv_patch_notes"));
  assert.ok(!names.includes("sv_call"));
});

test("every operation is reachable through exactly one facade", async () => {
  const listed = await withClient((client) => client.listTools());
  const reachable = new Set();
  for (const tool of listed.tools) {
    if (tool.name === DESCRIBE_OPERATION_TOOL) continue;
    for (const operation of tool.inputSchema.properties.operation.enum) {
      assert.equal(reachable.has(operation), false, `${operation} is exposed by two facades`);
      reachable.add(operation);
    }
  }
  const { operations } = buildOperationCatalog(TOOLS);
  assert.deepEqual([...reachable].sort(), [...operations.keys()].sort());
  assert.equal(reachable.size, TOOLS.length);
});

test("sv_describe returns the operation's real schema and its facade tool", async () => {
  const described = await withClient(async (client) => {
    const response = await client.callTool({
      name: DESCRIBE_OPERATION_TOOL,
      arguments: { operations: ["patch_notes", "snapshot_range"] },
    });
    return response.structuredContent;
  });
  // status 是唯一成败来源；与之并存的 ok 布尔不进入 MCP surface。
  assert.equal(described.status, "succeeded");
  assert.equal("ok" in described, false);
  // 业务载荷在 data 里（§10.2.1）：根信封只保留契约字段。
  assert.equal(described.data.operations.length, 2);
  const patch = described.data.operations.find((entry) => entry.operation === "patch_notes");
  // tool 就是 facade 工具名；不再同时返回 facade 字段重复同一信息。
  assert.equal(patch.tool, "sv_edit");
  assert.equal("facade" in patch, false);
  // 与内部 handler 校验的是同一份 schema。
  const direct = TOOLS.find((tool) => tool.name === "sv_patch_notes");
  assert.deepEqual(patch.inputSchema, direct.inputSchema);
  assert.equal(patch.schemaHash, jsonContentHash(direct.inputSchema));
});

test("sv_describe never exceeds its byte budget and defers honestly", async () => {
  // 条数上限拦不住体积：最大的两份 schema 即使去重后仍约 18 KiB。预算按整个
  // operation 取舍，绝不截断 schema——被截断的 schema 看起来可用，照它构造的请求
  // 却必然被 Ajv 拒绝，那比"这次没给你"更糟。
  const response = await withClient((client) =>
    client.callTool({
      name: DESCRIBE_OPERATION_TOOL,
      arguments: { operations: ["patch_parameter_curves", "edit_phrase"] },
    })
  );
  // 预算按整个 MCP 结果衡量，取舍的对象是 data 里的 operations。
  const envelope = response.structuredContent;
  const payload = envelope.data;
  assert.ok(
    Buffer.byteLength(JSON.stringify(envelope), "utf8") <= MAX_DESCRIBE_BYTES,
    "describe response must stay within its byte budget"
  );
  // 第一个无论多大都要返回，否则请求毫无进展。
  assert.equal(payload.operations.length, 1);
  assert.equal(payload.operations[0].operation, "patch_parameter_curves");
  // 放不下的必须如实上报，并给出可执行的下一步。
  assert.deepEqual(
    payload.deferred.operations.map((item) => item.operation),
    ["edit_phrase"]
  );
  assert.equal(payload.deferred.reason, "response_byte_budget_exhausted");
  assert.match(payload.deferred.remedy, /sv_describe/);
  assert.ok(payload.deferred.operations[0].bytes > 0);
  // 返回的 schema 是完整的，不是被裁过的。
  const direct = TOOLS.find((tool) => tool.name === "sv_patch_parameter_curves");
  assert.deepEqual(payload.operations[0].inputSchema, direct.inputSchema);
});

test("a two-operation describe that fits returns both with no deferral", async () => {
  const payload = await withClient(async (client) => {
    const response = await client.callTool({
      name: DESCRIBE_OPERATION_TOOL,
      arguments: { operations: ["ping", "doctor"] },
    });
    return response.structuredContent.data;
  });
  assert.equal(payload.operations.length, 2);
  assert.equal("deferred" in payload, false);
});

test("sv_describe batches many small contracts while preserving the byte budget", async () => {
  const { operations } = buildOperationCatalog(TOOLS);
  const requested = [...operations.values()]
    .sort(
      (left, right) =>
        Buffer.byteLength(JSON.stringify(left), "utf8") -
        Buffer.byteLength(JSON.stringify(right), "utf8")
    )
    .slice(0, MAX_DESCRIBE_OPERATIONS)
    .map((entry) => entry.operation);
  const response = await withClient((client) =>
    client.callTool({
      name: DESCRIBE_OPERATION_TOOL,
      arguments: { operations: requested },
    })
  );
  assert.notEqual(response.isError, true);
  assert.ok(
    Buffer.byteLength(JSON.stringify(response.structuredContent), "utf8") <= MAX_DESCRIBE_BYTES
  );
  const returned = response.structuredContent.data.operations.map((item) => item.operation);
  const deferred =
    response.structuredContent.data.deferred?.operations.map((item) => item.operation) ?? [];
  assert.ok(returned.length > 2, "batching must improve on the former two-operation cap");
  assert.deepEqual([...returned, ...deferred].sort(), [...requested].sort());
});

test("sv_describe bounds its request and rejects unknown operations", async () => {
  await withClient(async (client) => {
    assert.equal(MAX_DESCRIBE_OPERATIONS, 16);
    const tooMany = await client.callTool({
      name: DESCRIBE_OPERATION_TOOL,
      arguments: { operations: new Array(MAX_DESCRIBE_OPERATIONS + 1).fill("ping") },
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
  await withClient(async (client) => {
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
  await withClient(async (client) => {
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
  await withClient(async (client) => {
    // 内层未知字段必须被 operation 的严格 schema 拒绝，而不是被 facade 放过。
    const response = await client.callTool({
      name: "sv_edit",
      arguments: {
        operation: "patch_notes",
        arguments: { contextId: "c_missing", notes: [], totallyUnknownField: 1 },
      },
    });
    assert.equal(response.isError, true);
    assert.equal(response.structuredContent.error.code, "INVALID_ARGUMENTS");
    assert.match(response.structuredContent.error.message, /totallyUnknownField/);
  });
});

test("facade reaches the real handler and its business preconditions", async () => {
  // 用一个必然失败于业务前置条件（未知 context）的请求确认 facade 真的调用了
  // handler，而不是在路由层就编造成功或提前失败。
  const response = await withClient((client) =>
    client.callTool({
      name: "sv_read",
      arguments: { operation: "analyze_phrase", arguments: { contextId: "c_doesNotExist000" } },
    })
  );
  assert.equal(response.isError, true);
  assert.equal(response.structuredContent.error.code, "UNKNOWN_CONTEXT");
  // 伪造的 ID 只能报 unknown，不得声称"过期"（那会暗示重新快照必然可行）。
  assert.equal(response.structuredContent.error.reason, "unknown");
});

test("direct tool names are not callable", async () => {
  await withClient(async (client) => {
    for (const name of ["sv_patch_notes", "sv_call"]) {
      const response = await client.callTool({ name, arguments: {} });
      assert.equal(response.isError, true);
      assert.equal(response.structuredContent.error.code, "UNKNOWN_TOOL");
    }
  });
});

test("svcopilot://operations catalog matches the served facade tools", async () => {
  const { catalog, listed } = await withClient(async (client) => {
    const resource = await client.readResource({ uri: "svcopilot://operations" });
    return {
      catalog: JSON.parse(resource.contents[0].text),
      listed: await client.listTools(),
    };
  });
  assert.equal(catalog.describeTool, DESCRIBE_OPERATION_TOOL);
  const { catalogHash, ...catalogBody } = catalog;
  assert.match(catalogHash, /^sha256_[0-9a-f]{64}$/);
  assert.equal(catalogHash, jsonContentHash(catalogBody));
  // 没有 profile 名可报告，也没有"被排除的工具"——facade 是唯一 surface。
  assert.equal("profile" in catalog, false);
  assert.equal("excludedTools" in catalog, false);
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
    for (const operation of entry.operations) {
      assert.match(operation.schemaHash, /^sha256_[0-9a-f]{64}$/);
      const direct = TOOLS.find(
        (tool) => operationNameForTool(tool.name) === operation.operation
      );
      assert.equal(operation.schemaHash, jsonContentHash(direct.inputSchema));
    }
  }
  // catalog 资源本身也要小：它是模型的第一跳。
  const bytes = Buffer.byteLength(JSON.stringify(catalog), "utf8");
  assert.ok(bytes < 16 * 1024, `operations catalog must stay under 16 KiB; got ${bytes}`);
});

test("catalog, describe and schema resource share one schemaHash", async () => {
  const result = await withClient(async (client) => {
    const catalogResource = await client.readResource({ uri: "svcopilot://operations" });
    const described = await client.callTool({
      name: DESCRIBE_OPERATION_TOOL,
      arguments: { operations: ["edit_phrase"] },
    });
    const schemaResource = await client.readResource({
      uri: "svcopilot://schemas/sv_edit_phrase",
    });
    return {
      catalog: JSON.parse(catalogResource.contents[0].text),
      described: described.structuredContent.data.operations[0],
      schema: JSON.parse(schemaResource.contents[0].text),
    };
  });
  const catalogEntry = result.catalog.facades
    .flatMap((facade) => facade.operations)
    .find((operation) => operation.operation === "edit_phrase");
  assert.equal(result.described.schemaHash, catalogEntry.schemaHash);
  assert.equal(result.schema.schemaHash, catalogEntry.schemaHash);
  assert.equal(result.schema.schemaHash, jsonContentHash(result.schema.inputSchema));
});

test("schemaHash changes for any served schema byte change", () => {
  const schema = { type: "object", properties: { value: { type: "number" } } };
  const changed = { type: "object", properties: { value: { type: "integer" } } };
  assert.equal(jsonContentHash(schema), jsonContentHash(structuredClone(schema)));
  assert.notEqual(jsonContentHash(schema), jsonContentHash(changed));
});

test("capabilities reports one facade surface with a derived operation count", async () => {
  const capabilities = await withClient(async (client) => {
    const resource = await client.readResource({ uri: "svcopilot://capabilities" });
    assert.ok(
      Buffer.byteLength(resource.contents[0].text, "utf8") < 16 * 1024,
      "capabilities must stay below the compact response hard limit",
    );
    return JSON.parse(resource.contents[0].text);
  });
  const surface = capabilities.interfaces.surface;
  assert.deepEqual(surface.facades.sort(), [...EXPECTED_FACADES].sort());
  assert.equal(surface.operations, TOOLS.length);
  assert.equal(surface.catalog, "svcopilot://operations");
  assert.equal(surface.describeTool, DESCRIBE_OPERATION_TOOL);
  // profile 选择层已删除，不得再出现在自描述里。
  assert.equal("toolProfile" in capabilities.interfaces, false);
  assert.equal("compact" in capabilities.interfaces, false);
  assert.equal(capabilities.interfaceVersion, "0.10.0");
  assert.deepEqual(capabilities.pitchTechniques.model, {
    schemaVersion: 1,
    modelVersion: "pitch-techniques-v1",
    timeDomain: "seconds",
  });
  assert.deepEqual(capabilities.pitchTechniques.solver, {
    name: "node-bounded-richards",
    version: "1",
  });
  assert.equal(capabilities.pitchTechniques.writeSurfaces.pitchDelta, "enabled_primary");
  assert.equal(capabilities.pitchTechniques.writeSurfaces.vibratoEnv, "enabled_auxiliary");
  assert.equal(capabilities.pitchTechniques.writeSurfaces.PitchControlCurve, "capability_gated");
  assert.equal(capabilities.pitchTechniques.capabilityGates.PitchControlCurve.status, "disabled");
  assert.equal(capabilities.pitchTechniques.capabilityGates.boundedClosedLoop.status, "disabled");
  assert.equal(
    capabilities.pitchTechniques.capabilityGates.PitchControlCurve.reasonCode,
    "PITCH_CONTROL_CURVE_HOST_SEMANTICS_INCOMPLETE",
  );
  assert.match(
    capabilities.pitchTechniques.capabilityGates.PitchControlCurve.explanation,
    /ordering behavior is unknown/,
  );
  assert.deepEqual(capabilities.pitchTechniques.capabilityGates.PitchControlCurve.evidence, [
    { id: "H3a", status: "unknown" },
    { id: "H3b", status: "partially_observed" },
  ]);
  assert.equal("reason" in capabilities.pitchTechniques.capabilityGates.PitchControlCurve, false);
  assert.equal(capabilities.interfaces.terminology, "svcopilot://terminology");
  assert.deepEqual(
    capabilities.pitchTechniques.acceptedHostProfiles.map((profile) => profile.profileId),
    ["synthv-2.2.1-win32-v2"],
  );
});

test("terminology resource explains stable codes without changing them", async () => {
  const catalog = await withClient(async (client) => {
    const resource = await client.readResource({ uri: "svcopilot://terminology" });
    return JSON.parse(resource.contents[0].text);
  });
  assert.equal(catalog.schemaVersion, "1.0.0");
  assert.equal(catalog.terms.tempo_step.title, "Single tempo change");
  assert.match(catalog.terms.tempo_step.description, /Exactly one BPM change/);
  assert.ok(Buffer.byteLength(JSON.stringify(catalog), "utf8") < 16 * 1024);
});
