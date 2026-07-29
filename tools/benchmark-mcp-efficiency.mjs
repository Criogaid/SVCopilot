// MCP 效率基准：无宿主情况下测量 ListTools、典型响应和 fixtures 的字节/文本成本。
// 需要真实宿主的工作负载通过可选 hook 接入；默认只输出可静态复现的数据。
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const productDir = path.resolve(testDir, "..");
const fixturesDir = path.join(productDir, "test", "fixtures", "efficiency");

// 固定夹具版本；变更 schema 或 payload 结构时同步递增。
const FIXTURE_VERSION = "1";

// 确定性 ID 生成器，避免 UUID 导致 fixture hash 不稳定。
function deterministicId(prefix, index) {
  return `${prefix}_${String(index).padStart(4, "0")}`;
}

// 创建音符 fixture，覆盖不同规模。
function buildNotes(count) {
  const notes = [];
  for (let i = 0; i < count; i += 1) {
    notes.push({
      noteId: deterministicId("n", i),
      indexInGroup: i,
      onsetBlick: i * 70560000 + 120000,
      durationBlick: 70560000 - 240000,
      endBlick: (i + 1) * 70560000 - 120000,
      pitch: 60 + (i % 12),
      detuneCents: 0,
      lyrics: i % 7 === 0 ? "la" : i % 5 === 0 ? "a" : "",
      phonemesOverride: "",
      languageOverride: "",
      attributes: {},
    });
  }
  return notes;
}

// 创建 Automation 点 fixture。
function buildAutomationPoints(count) {
  const points = [];
  const startBlick = 0;
  const step = 70560000 / count;
  for (let i = 0; i < count; i += 1) {
    points.push({
      blick: Math.round(startBlick + i * step),
      value: Math.sin((i / count) * Math.PI * 2) * 0.5 + 0.5,
    });
  }
  return points;
}

// 创建 computed pitch fixture。
function buildComputedPitch(frameCount, nullRatio = 0) {
  const values = [];
  for (let i = 0; i < frameCount; i += 1) {
    // 固定的低差异序列，避免 benchmark fixture 因随机源抖动。
    const sample = ((i * 2654435761) >>> 0) / 0x1_0000_0000;
    if (sample < nullRatio) {
      values.push(null);
    } else {
      values.push(60 + Math.sin(i / 10) * 0.5);
    }
  }
  return { startBlick: 0, intervalBlick: 256, values };
}

function createFixtures(outputDir, generatedAt) {
  mkdirSync(outputDir, { recursive: true });
  const fixtureMap = new Map();

  const fixtureDefs = [
    { name: "notes-10", data: buildNotes(10) },
    { name: "notes-100", data: buildNotes(100) },
    { name: "notes-373", data: buildNotes(373) },
    { name: "notes-1000", data: buildNotes(1000) },
    { name: "automation-10", data: buildAutomationPoints(10) },
    { name: "automation-100", data: buildAutomationPoints(100) },
    { name: "automation-1000", data: buildAutomationPoints(1000) },
    { name: "automation-2000", data: buildAutomationPoints(2000) },
    { name: "computed-pitch-null", data: buildComputedPitch(160, 1.0) },
    { name: "computed-pitch-sparse", data: buildComputedPitch(160, 0.5) },
    { name: "computed-pitch-160", data: buildComputedPitch(160, 0.0) },
    { name: "computed-pitch-1000", data: buildComputedPitch(1000, 0.0) },
  ];

  for (const def of fixtureDefs) {
    const hashPayload = {
      fixtureVersion: FIXTURE_VERSION,
      fixtureName: def.name,
      data: def.data,
    };
    const payload = {
      ...hashPayload,
      generatedAt,
    };
    const text = JSON.stringify(payload);
    const hash = createHash("sha256").update(JSON.stringify(hashPayload)).digest("hex").slice(0, 32);
    const fileName = `${def.name}.json`;
    writeFileSync(path.join(outputDir, fileName), text, "utf8");
    fixtureMap.set(def.name, {
      fileName,
      hash,
      minifiedBytes: Buffer.byteLength(text, "utf8"),
      itemCount: Array.isArray(def.data) ? def.data.length : def.data.values?.length ?? 0,
    });
  }
  return fixtureMap;
}

function measureJson(value, label) {
  const pretty = JSON.stringify(value, null, 2);
  const minified = JSON.stringify(value);
  return {
    label,
    prettyBytes: Buffer.byteLength(pretty, "utf8"),
    minifiedBytes: Buffer.byteLength(minified, "utf8"),
    overheadPercent: Number(
      (
        ((Buffer.byteLength(pretty, "utf8") - Buffer.byteLength(minified, "utf8")) /
          Buffer.byteLength(minified, "utf8")) *
        100
      ).toFixed(2)
    ),
  };
}

async function measureListTools() {
  // 动态导入 server 模块，避免在未 install 时崩溃。
  const { TOOLS } = await import(pathToFileURL(path.join(productDir, "server", "src", "index.js")).href);
  const result = measureJson(TOOLS, "ListTools");
  const descriptionBytes = TOOLS.reduce((sum, tool) => sum + Buffer.byteLength(tool.description ?? "", "utf8"), 0);
  const schemaBytes = TOOLS.reduce((sum, tool) => {
    const inputSize = Buffer.byteLength(JSON.stringify(tool.inputSchema ?? {}), "utf8");
    const outputSize = Buffer.byteLength(JSON.stringify(tool.outputSchema ?? {}), "utf8");
    return sum + inputSize + outputSize;
  }, 0);
  return {
    ...result,
    toolCount: TOOLS.length,
    descriptionBytes,
    schemaBytes,
    largestTools: TOOLS
      .map((tool) => ({
        name: tool.name,
        totalBytes: Buffer.byteLength(JSON.stringify(tool), "utf8"),
        inputBytes: Buffer.byteLength(JSON.stringify(tool.inputSchema ?? {}), "utf8"),
        outputBytes: Buffer.byteLength(JSON.stringify(tool.outputSchema ?? {}), "utf8"),
        descriptionBytes: Buffer.byteLength(tool.description ?? "", "utf8"),
      }))
      .sort((a, b) => b.totalBytes - a.totalBytes)
      .slice(0, 5),
  };
}

function measureToolResult() {
  // 代表性工具响应：range snapshot standard page。
  const representative = {
    ok: true,
    status: "succeeded",
    contextId: "ctx_001",
    snapshotToken: "snap_abc123",
    observedAt: "2026-07-28T12:00:00.000Z",
    contextExpiresAt: "2026-07-28T12:05:00.000Z",
    consistency: "best-effort",
    data: {
      notes: buildNotes(50),
      automation: [
        { resolvedParameter: "dynamics", points: buildAutomationPoints(200) },
      ],
    },
    page: { complete: true, nextCursor: null, returned: { notes: 50, automationPoints: 200 } },
    warnings: [],
    timings: { hostReadMs: 120, serializationMs: 5, operationMs: 125, serviceTotalMs: 130 },
  };
  return measureJson(representative, "representative-tool-result");
}

function runReport({ listTools, toolResult, fixtures, generatedAt }) {
  const report = {
    fixtureVersion: FIXTURE_VERSION,
    generatedAt,
    summary: {
      listToolsMinifiedBytes: listTools.minifiedBytes,
      listToolsPrettyBytes: listTools.prettyBytes,
      representativeResultMinifiedBytes: toolResult.minifiedBytes,
      representativeResultPrettyBytes: toolResult.prettyBytes,
    },
    listTools,
    toolResult,
    fixtures: Object.fromEntries(fixtures.entries()),
    tokenizer: {
      status: "unavailable",
      name: null,
      version: null,
      tokens: null,
      reason: "No tokenizer dependency is bundled; byte metrics remain deterministic.",
    },
    execution: {
      mcpCalls: 0,
      hostCalls: 0,
      undoRecords: 0,
      coordinatorQueueMs: null,
      bridgeRoundTrips: 0,
      totalTimeMs: null,
      scope: "static_serialization_only",
    },
  };
  return report;
}

export async function runBenchmark({
  writeBaseline = true,
  outputDir = fixturesDir,
  generatedAt = new Date().toISOString(),
  quiet = false,
} = {}) {
  const fixtures = createFixtures(outputDir, generatedAt);
  const listTools = await measureListTools();
  const toolResult = measureToolResult();
  const report = runReport({ listTools, toolResult, fixtures, generatedAt });

  const reportText = JSON.stringify(report, null, 2);
  if (!quiet) console.log(reportText);

  if (writeBaseline) {
    const baselinePath = path.join(outputDir, "baseline.json");
    writeFileSync(baselinePath, reportText, "utf8");
    console.error(`[benchmark] baseline written to ${baselinePath}`);
  }

  return report;
}

// 只有直接作为主模块启动时才运行；作为库导入时不应自动执行。
if (import.meta.filename === path.resolve(process.argv[1] ?? "")) {
  runBenchmark().catch((error) => {
    console.error("benchmark failed:", error);
    process.exit(1);
  });
}
