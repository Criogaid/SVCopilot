// MCP 效率基准回归：验证 facade、内部 inventory、离线 trace 与 fixture 的边界。
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
  const report = await runBenchmark({
    writeBaseline: false,
    outputDir,
    generatedAt: "2026-01-01T00:00:00.000Z",
    quiet: true,
  });

  const repeat = await runBenchmark({
    writeBaseline: false,
    generatedAt: "2026-01-01T00:00:00.000Z",
    quiet: true,
  });
  assert.deepStrictEqual(repeat, report, "固定输入的 benchmark report 必须逐字段稳定");

  assert.strictEqual(report.fixtureVersion, "1");
  assert.ok(report.servedMcp);
  assert.ok(report.operationSchemas);
  assert.ok(report.fixturePayloads);
  assert.ok(report.workflowTrace);
  assert.ok(report.host);
  assert.strictEqual(report.listTools, undefined, "旧的含混 listTools 口径必须删除");

  const { TOOLS } = await import("../server/src/index.js");
  assert.strictEqual(report.servedMcp.toolsList.toolCount, 8);
  assert.strictEqual(report.operationSchemas.handlerCount, TOOLS.length);
  assert.strictEqual(report.operationSchemas.operationCount, TOOLS.length);
  assert.ok(report.servedMcp.toolsList.minifiedBytes < 12 * 1024);
  assert.ok(report.operationSchemas.minifiedBytes > report.servedMcp.toolsList.minifiedBytes);
  assert.ok(report.servedMcp.reductionVsInternalPercent > 90);
  assert.strictEqual(report.servedMcp.soloOverBudget.length, 0);
  assert.strictEqual(report.servedMcp.describeCases.length, 3);

  assert.strictEqual(report.workflowTrace.scope, "offline_facade_discovery");
  assert.strictEqual(report.workflowTrace.mcpToolCalls, 3);
  assert.strictEqual(report.workflowTrace.resourceReads, 1);
  assert.strictEqual(report.workflowTrace.describeCalls, 3);
  assert.ok(report.workflowTrace.requestBytes > 0);
  assert.ok(report.workflowTrace.responseBytes > 0);
  assert.ok(report.workflowTrace.modelVisibleBytes > report.workflowTrace.responseBytes);
  assert.strictEqual(report.workflowTrace.wallTimeMs, null);
  assert.strictEqual(report.workflowTrace.hostCalls, 0);
  assert.strictEqual(report.host.status, "not_collected");

  const result = report.fixturePayloads.representativeResult;
  assert.ok(result.minifiedBytes > 0);
  assert.ok(result.prettyBytes > result.minifiedBytes);
  assert.ok(result.overheadPercent > 0);

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
    const fixture = report.fixturePayloads.fixtures[name];
    assert.ok(fixture, `fixture ${name} 必须存在`);
    assert.strictEqual(fixture.hash.length, 32);
    assert.ok(existsSync(path.join(outputDir, fixture.fileName)));
  }
  assert.strictEqual(report.fixturePayloads.fixtures["notes-373"].itemCount, 373);
  assert.strictEqual(report.fixturePayloads.fixtures["automation-2000"].itemCount, 2000);
  assert.strictEqual(report.tokenizer.status, "unavailable");
  assert.deepStrictEqual(snapshotDirectory(fixturesDir), before, "benchmark test 不得修改仓库 fixture");
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
