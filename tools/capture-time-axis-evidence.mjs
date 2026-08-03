import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { Client } from "../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";
import { facadeForTool, operationNameForTool } from "../server/src/operation-catalog.js";
import {
  TIME_AXIS_MINIMUM_SAMPLES,
} from "./lib/time-axis-evidence.mjs";
import { captureTimeAxisEvidence } from "./lib/time-axis-capture.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SERVER = path.resolve(HERE, "..", "server", "src", "index.js");

async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  const serverScript = path.resolve(options.serverScript ?? DEFAULT_SERVER);
  if (!existsSync(serverScript)) throw new Error(`MCP server was not found: ${serverScript}`);
  if (existsSync(options.output) && options.force !== true) {
    throw new Error(`output already exists: ${options.output}; pass --force to replace it`);
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverScript],
    cwd: path.dirname(serverScript),
    env: process.env,
    stderr: "pipe",
  });
  const client = new Client({ name: "svcopilot-time-axis-capture", version: "1.0.0" });
  try {
    await client.connect(transport);
    const report = await captureTimeAxisEvidence({
      host: {
        roots: () => rawCall(client, "sv_root", {}),
        index: (field) => rawCall(client, "sv_index", { field }),
        call: (request) => rawCall(client, "sv_call", request),
      },
      scenario: options.scenario,
      sampleCount: options.sampleCount,
      hostEvidence: async () => hostEvidence(await rawCall(client, "sv_doctor", {})),
    });
    mkdirSync(path.dirname(options.output), { recursive: true });
    writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({
      ok: true,
      output: options.output,
      scenario: report.scenario,
      sampleCount: report.summary.sampleCount,
      summary: report.summary,
      readOnly: true,
      setters: 0,
      undoRecords: 0,
    }, null, 2));
  } finally {
    await client.close().catch(() => {});
  }
}

async function rawCall(client, tool, argumentsValue) {
  const response = await client.callTool({
    name: facadeForTool(tool),
    arguments: {
      operation: operationNameForTool(tool),
      arguments: argumentsValue,
    },
  });
  const payload = response.structuredContent;
  if (response.isError) {
    const error = payload?.error;
    const detail = error?.code ? `${error.code}: ${error.message ?? "host call failed"}` : "host call failed";
    throw new Error(detail);
  }
  if (payload && typeof payload === "object" && Object.keys(payload).length === 1 && Object.hasOwn(payload, "result")) {
    return payload.result;
  }
  return payload;
}

function hostEvidence(doctorResponse) {
  const doctor = doctorResponse?.data ?? doctorResponse;
  const host = {};
  const version = doctor?.transport?.hostVersion;
  if (typeof version === "string" && version) host.hostVersion = version;
  const bridge = doctor?.bridge?.loaded;
  if (Number.isSafeInteger(bridge?.protoVersion) && bridge.protoVersion > 0) {
    host.bridgeProtocolVersion = bridge.protoVersion;
  }
  if (typeof bridge?.sha256 === "string" && /^[0-9a-f]{64}$/.test(bridge.sha256)) {
    host.bridgeSha256 = `sha256:${bridge.sha256}`;
  }
  return host;
}

function parseArgs(args) {
  const options = {
    scenario: null,
    output: null,
    serverScript: null,
    sampleCount: TIME_AXIS_MINIMUM_SAMPLES,
    force: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--force") {
      options.force = true;
      continue;
    }
    if (["--scenario", "--output", "--server-script"].includes(arg)) {
      const value = args[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      const key = arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      options[key] = arg === "--output" ? path.resolve(value) : value;
      index += 1;
      continue;
    }
    if (arg === "--sample-count") {
      const value = Number(args[index + 1]);
      if (!Number.isSafeInteger(value) || value < TIME_AXIS_MINIMUM_SAMPLES || value > 4096) {
        throw new Error(`--sample-count requires an integer in [${TIME_AXIS_MINIMUM_SAMPLES}, 4096]`);
      }
      options.sampleCount = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.scenario) throw new Error("--scenario is required");
  if (!options.output) throw new Error("--output is required");
  return options;
}

main().catch((error) => {
  console.error(`[time-axis-evidence] ${error.message}`);
  process.exitCode = 1;
});
