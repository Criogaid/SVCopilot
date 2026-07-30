// MCP 效率基准的回归测试：验证 benchmark runner 输出、fixture 稳定性以及关键指标。
import assert from "node:assert";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runBenchmark } from "../tools/benchmark-mcp-efficiency.mjs";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(testDir, "fixtures", "efficiency");
const outputDir = mkdtempSync(path.join(os.tmpdir(), "svcopilot-efficiency-"));
const before = snapshotDirectory(fixturesDir);

try {
  // 测试只写临时目录；固定时间确保同一输入逐字节稳定。
  const report = await runBenchmark({
    writeBaseline: false,
    outputDir,
    generatedAt: "2026-01-01T00:00:00.000Z",
    quiet: true,
  });

// 报告结构。
assert.strictEqual(typeof report.fixtureVersion, "string");
assert.strictEqual(typeof report.generatedAt, "string");
assert.ok(report.summary, "report.summary 必须存在");
assert.ok(report.listTools, "report.listTools 必须存在");
assert.ok(report.toolResult, "report.toolResult 必须存在");
assert.ok(report.fixtures, "report.fixtures 必须存在");

// ListTools 指标：minified 应小于 pretty，且与 PRD 基线接近。
assert.ok(report.listTools.minifiedBytes > 0, "ListTools minified bytes 必须大于 0");
assert.ok(report.listTools.prettyBytes > report.listTools.minifiedBytes, "pretty 必须大于 minified");
assert.strictEqual(report.listTools.toolCount, 42, "当前工具数应保持 42");
assert.ok(
  report.listTools.descriptionBytes > 0,
  "description bytes 必须大于 0"
);
assert.ok(report.listTools.schemaBytes > 0, "schema bytes 必须大于 0");

// 典型工具响应的 pretty/minified 差异。
assert.ok(report.toolResult.minifiedBytes > 0, "representative result minified bytes 必须大于 0");
assert.ok(
  report.toolResult.prettyBytes > report.toolResult.minifiedBytes,
  "representative result pretty 必须大于 minified"
);
assert.ok(
  report.toolResult.overheadPercent > 0,
  "representative result pretty overhead 必须为正"
);

// Fixtures 已生成。
const expectedFixtures = [
  "notes-10",
  "notes-100",
  "notes-373",
  "notes-1000",
  "automation-10",
  "automation-100",
  "automation-1000",
  "automation-2000",
  "computed-pitch-null",
  "computed-pitch-sparse",
  "computed-pitch-160",
  "computed-pitch-1000",
];
for (const name of expectedFixtures) {
  const fixture = report.fixtures[name];
  assert.ok(fixture, `fixture ${name} 必须存在`);
  assert.strictEqual(typeof fixture.hash, "string");
  assert.strictEqual(fixture.hash.length, 32);
  assert.ok(existsSync(path.join(outputDir, fixture.fileName)), `fixture 文件 ${fixture.fileName} 必须存在`);
}

// notes fixture 的 itemCount 正确。
assert.strictEqual(report.fixtures["notes-373"].itemCount, 373);
assert.strictEqual(report.fixtures["automation-2000"].itemCount, 2000);
assert.strictEqual(report.tokenizer.status, "unavailable");
assert.strictEqual(report.execution.scope, "static_serialization_only");
assert.deepStrictEqual(snapshotDirectory(fixturesDir), before, "benchmark test 不得修改仓库 fixture");

console.log("efficiency-benchmark.test.mjs passed");
} finally {
  rmSync(outputDir, { recursive: true, force: true });
}

function snapshotDirectory(directory) {
  if (!existsSync(directory)) return {};
  return Object.fromEntries(
    readdirSync(directory)
      .sort()
      .map((name) => [name, readFileSync(path.join(directory, name)).toString("base64")])
  );
}
