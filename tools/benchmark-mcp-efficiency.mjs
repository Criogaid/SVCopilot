// MCP 效率基准：统一测量实际 facade、内部 schema inventory、固定 payload 和离线发现轨迹。
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const productDir = path.resolve(testDir, "..");
const fixturesDir = path.join(productDir, "test", "fixtures", "efficiency");

// 固定夹具版本；变更 schema 或 payload 结构时同步递增。
const FIXTURE_VERSION = "1";

function deterministicId(prefix, index) {
  return `${prefix}_${String(index).padStart(4, "0")}`;
}

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

function buildAutomationPoints(count) {
  const points = [];
  const step = 70560000 / count;
  for (let i = 0; i < count; i += 1) {
    points.push({
      blick: Math.round(i * step),
      value: Math.sin((i / count) * Math.PI * 2) * 0.5 + 0.5,
    });
  }
  return points;
}

function buildComputedPitch(frameCount, nullRatio = 0) {
  const values = [];
  for (let i = 0; i < frameCount; i += 1) {
    const sample = ((i * 2654435761) >>> 0) / 0x1_0000_0000;
    values.push(sample < nullRatio ? null : 60 + Math.sin(i / 10) * 0.5);
  }
  return { startBlick: 0, intervalBlick: 256, values };
}

function createFixtures(outputDir, generatedAt) {
  if (outputDir) mkdirSync(outputDir, { recursive: true });
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
    const payload = { ...hashPayload, generatedAt };
    const text = JSON.stringify(payload);
    const hash = createHash("sha256").update(JSON.stringify(hashPayload)).digest("hex").slice(0, 32);
    const fileName = `${def.name}.json`;
    if (outputDir) writeFileSync(path.join(outputDir, fileName), text, "utf8");
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
  const prettyBytes = Buffer.byteLength(pretty, "utf8");
  const minifiedBytes = Buffer.byteLength(minified, "utf8");
  return {
    label,
    prettyBytes,
    minifiedBytes,
    overheadPercent: Number((((prettyBytes - minifiedBytes) / minifiedBytes) * 100).toFixed(2)),
  };
}

function measureToolResult() {
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
      automation: [{ resolvedParameter: "dynamics", points: buildAutomationPoints(200) }],
    },
    page: { complete: true, nextCursor: null, returned: { notes: 50, automationPoints: 200 } },
    warnings: [],
    timings: { hostReadMs: 120, serializationMs: 5, operationMs: 125, serviceTotalMs: 130 },
  };
  return measureJson(representative, "representative-tool-result");
}

export async function measureEfficiencySurface() {
  const indexUrl = pathToFileURL(path.join(productDir, "server", "src", "index.js")).href;
  const facadeUrl = pathToFileURL(path.join(productDir, "server", "src", "compact-facade.js")).href;
  const catalogUrl = pathToFileURL(path.join(productDir, "server", "src", "operation-catalog.js")).href;
  const [{ INTERFACE_VERSION, TOOLS }, { createCompactFacade, MAX_DESCRIBE_BYTES }, { buildOperationCatalog }] =
    await Promise.all([import(indexUrl), import(facadeUrl), import(catalogUrl)]);

  const facade = createCompactFacade(TOOLS);
  const { operations } = buildOperationCatalog(TOOLS);
  const schemaRows = [...operations.values()]
    .map((entry) => ({
      operation: entry.operation,
      facade: entry.facade,
      schemaBytes: Buffer.byteLength(JSON.stringify(entry.inputSchema), "utf8"),
      descriptionBytes: Buffer.byteLength(entry.description ?? "", "utf8"),
      deduped: Boolean(entry.inputSchema.$defs),
    }))
    .sort((left, right) => right.schemaBytes - left.schemaBytes);

  const internalProjection = TOOLS.map(({ name, description, inputSchema, outputSchema, annotations }) => ({
    name,
    description,
    inputSchema,
    outputSchema,
    annotations,
  }));
  const internalSize = measureJson(internalProjection, "internal-handler-inventory");
  const toolsList = {
    ...measureJson(facade.tools, "tools/list tools"),
    payloadMinifiedBytes: Buffer.byteLength(JSON.stringify({ tools: facade.tools }), "utf8"),
    toolCount: facade.tools.length,
    toolNames: facade.toolNames,
  };
  const catalogPayload = facade.catalog(INTERFACE_VERSION);
  const catalog = measureJson(catalogPayload, "svcopilot://operations");

  const middle = Math.floor(schemaRows.length / 2);
  const describeRequests = [
    ["worst", schemaRows.slice(0, 2)],
    ["median", schemaRows.slice(middle, middle + 2)],
    ["best", schemaRows.slice(-2)],
  ];
  const describeCases = describeRequests.map(([label, rows]) => {
    const operations = rows.map((row) => row.operation);
    const request = { operations };
    const response = facade.describe(operations);
    return {
      label,
      operations,
      requestBytes: Buffer.byteLength(JSON.stringify(request), "utf8"),
      responseBytes: Buffer.byteLength(JSON.stringify(response), "utf8"),
      returned: response.data.operations.length,
      deferred: response.data.deferred?.operations.map((item) => item.operation) ?? [],
    };
  });
  const soloOverBudget = schemaRows
    .filter(
      (row) =>
        Buffer.byteLength(JSON.stringify(facade.describe([row.operation])), "utf8") >
        MAX_DESCRIBE_BYTES
    )
    .map((row) => row.operation);

  const describeRequestBytes = describeCases.reduce((sum, item) => sum + item.requestBytes, 0);
  const describeResponseBytes = describeCases.reduce((sum, item) => sum + item.responseBytes, 0);
  return {
    servedMcp: {
      toolsList,
      catalog,
      describeCases,
      maxDescribeBytes: MAX_DESCRIBE_BYTES,
      soloOverBudget,
      reductionVsInternalPercent: Number(
        ((1 - toolsList.minifiedBytes / internalSize.minifiedBytes) * 100).toFixed(1)
      ),
    },
    operationSchemas: {
      ...internalSize,
      handlerCount: TOOLS.length,
      operationCount: schemaRows.length,
      totalSchemaBytes: schemaRows.reduce((sum, row) => sum + row.schemaBytes, 0),
      schemasWithDefs: schemaRows.filter((row) => row.deduped).length,
      largestOperations: schemaRows.slice(0, 12),
      smallestOperations: schemaRows.slice(-5),
    },
    workflowTrace: {
      scope: "offline_facade_discovery",
      mcpToolCalls: describeCases.length,
      resourceReads: 1,
      describeCalls: describeCases.length,
      requestBytes: describeRequestBytes,
      responseBytes: catalog.minifiedBytes + describeResponseBytes,
      modelVisibleBytes: toolsList.minifiedBytes + catalog.minifiedBytes + describeResponseBytes,
      wallTimeMs: null,
      hostCalls: 0,
      bridgeRoundTrips: 0,
      undoRecords: 0,
    },
  };
}

export async function runBenchmark({
  writeBaseline = false,
  outputDir = null,
  generatedAt = new Date().toISOString(),
  quiet = false,
} = {}) {
  const fixtures = createFixtures(outputDir, generatedAt);
  const surface = await measureEfficiencySurface();
  const fixturePayloads = {
    representativeResult: measureToolResult(),
    fixtures: Object.fromEntries(fixtures.entries()),
  };
  const report = {
    fixtureVersion: FIXTURE_VERSION,
    generatedAt,
    summary: {
      servedToolsListBytes: surface.servedMcp.toolsList.minifiedBytes,
      internalHandlerInventoryBytes: surface.operationSchemas.minifiedBytes,
      facadeReductionPercent: surface.servedMcp.reductionVsInternalPercent,
      workflowModelVisibleBytes: surface.workflowTrace.modelVisibleBytes,
      representativeResultBytes: fixturePayloads.representativeResult.minifiedBytes,
    },
    ...surface,
    fixturePayloads,
    tokenizer: {
      status: "unavailable",
      name: null,
      version: null,
      tokens: null,
      reason: "No tokenizer dependency is bundled; byte metrics remain deterministic.",
    },
    host: {
      status: "not_collected",
      scope: "run npm run acceptance:live against a running SynthV host",
      wallTimeMs: null,
      hostCalls: null,
      bridgeRoundTrips: null,
    },
  };

  const reportText = JSON.stringify(report, null, 2);
  if (!quiet) console.log(reportText);
  if (writeBaseline) {
    const baselineDir = outputDir ?? fixturesDir;
    mkdirSync(baselineDir, { recursive: true });
    writeFileSync(path.join(baselineDir, "baseline.json"), reportText, "utf8");
    console.error(`[benchmark] baseline written to ${path.join(baselineDir, "baseline.json")}`);
  }
  return report;
}

if (import.meta.filename === path.resolve(process.argv[1] ?? "")) {
  const args = new Set(process.argv.slice(2));
  runBenchmark({
    writeBaseline: args.has("--write-baseline"),
    quiet: args.has("--quiet"),
  }).catch((error) => {
    console.error("benchmark failed:", error);
    process.exit(1);
  });
}
