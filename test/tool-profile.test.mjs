import assert from "node:assert";
import { filterToolsByProfile, isToolEnabled, registerToolProfile, registeredToolProfiles } from "../server/src/tool-profile.js";

// 已注册 profile 包含 full/core/music/raw。
{
  assert.ok(registeredToolProfiles().includes("full"));
  assert.ok(registeredToolProfiles().includes("core"));
  assert.ok(registeredToolProfiles().includes("music"));
  assert.ok(registeredToolProfiles().includes("raw"));
}

// full 包含所有工具。
{
  const tools = [{ name: "sv_ping" }, { name: "sv_snapshot" }];
  assert.deepStrictEqual(filterToolsByProfile("full", tools), tools);
}

// core 不包含原始 dispatcher 工具。
{
  const tools = [
    { name: "sv_ping" },
    { name: "sv_snapshot" },
    { name: "sv_call" },
    { name: "sv_root" },
  ];
  const core = filterToolsByProfile("core", tools);
  assert.ok(core.some((t) => t.name === "sv_ping"));
  assert.ok(core.some((t) => t.name === "sv_snapshot"));
  assert.ok(!core.some((t) => t.name === "sv_call"));
  assert.ok(!core.some((t) => t.name === "sv_root"));
}

// core 是小型常用面；music 是严格超集，避免两个 profile 只换名字不减 schema。
{
  const tools = [
    { name: "sv_snapshot" },
    { name: "sv_plan_expression" },
    { name: "sv_generate_harmony" },
  ];
  assert.deepStrictEqual(filterToolsByProfile("core", tools), [{ name: "sv_snapshot" }]);
  assert.deepStrictEqual(filterToolsByProfile("music", tools), tools);
}

// raw 只包含 dispatcher 和官方 API 查询。
{
  const tools = [
    { name: "sv_ping" },
    { name: "sv_snapshot" },
    { name: "sv_call" },
    { name: "sv_root" },
  ];
  const raw = filterToolsByProfile("raw", tools);
  assert.ok(raw.some((t) => t.name === "sv_call"));
  assert.ok(raw.some((t) => t.name === "sv_root"));
  assert.ok(!raw.some((t) => t.name === "sv_ping"));
  assert.ok(!raw.some((t) => t.name === "sv_snapshot"));
}

// 自定义 profile 过滤。
{
  const tools = [{ name: "a" }, { name: "b" }, { name: "c" }];
  registerToolProfile("test", ["a", "c"]);
  assert.deepStrictEqual(filterToolsByProfile("test", tools), [{ name: "a" }, { name: "c" }]);
  assert.strictEqual(isToolEnabled("test", "a"), true);
  assert.strictEqual(isToolEnabled("test", "b"), false);
}

// 未知 profile 报错。
{
  assert.throws(() => filterToolsByProfile("unknown", []), /unknown tool profile/);
}

console.log("tool-profile.test.mjs passed");
