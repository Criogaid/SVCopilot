#!/usr/bin/env node
// index.js -- MCP server exposing a generic SynthV-API dispatcher over stdio.
//
// Tools:
//   sv_root  -> handles to root SV objects (call first)
//   sv_call  -> call any method on any SV object (this is the "most complete" surface)
//   sv_index -> read a field/constant (e.g. SV.QUARTER)
//   sv_free  -> release a handle
//   sv_ping  -> health check
//
// Completeness comes from sv_call: the SynthV side registers every returned
// object as an integer handle, so the LLM can traverse the whole SV object graph
// and call any documented method -- no per-operation tool needed.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  apiManifest,
  describeApi,
  getApiClass,
  inferReturnedHandleType,
  searchApi,
  validateApiCall,
} from "./api-catalog.js";
import { PipeRelay, resolvePipePaths, resolveSession } from "./transport-pipe.js";

const bridge = new PipeRelay();
const handleTypes = new Map();
const ROOT_HANDLE_TYPES = Object.freeze({
  sv: "SV",
  project: "Project",
  timeAxis: "TimeAxis",
  mainEditor: "MainEditorView",
  arrangement: "ArrangementView",
  playback: "PlaybackControl",
});
let hostVersion = null;

const TOOLS = [
  {
    name: "sv_root",
    description:
      "Get handles to the root SynthV objects (sv, project, timeAxis, mainEditor, arrangement, playback). Call this FIRST; use the returned __handle__ integers with sv_call / sv_index.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "sv_call",
    description:
      'Call a method on a SynthV API object (colon-style: self = the object). Omit `handle` to call global SV. Known handle types are checked against the local official API manifest before dispatch, including method name, arity, argument types, and documented minimum version. `args` may include handle refs written as {"__handle__":N}.',
    inputSchema: {
      type: "object",
      properties: {
        handle: {
          type: "number",
          description: "Target object handle. Omit for the global SV object.",
        },
        method: {
          type: "string",
          description: "Method name, e.g. getProject, getNumTracks, setLyrics.",
        },
        args: {
          type: "array",
          description: 'Positional arguments; pass object handles as {"__handle__":N}.',
        },
      },
      required: ["method"],
    },
  },
  {
    name: "sv_index",
    description:
      'Read a field/constant on a SynthV object with dot-access (not a method call). Omit `handle` for the global SV. Example: {"field":"QUARTER"} returns SV.QUARTER.',
    inputSchema: {
      type: "object",
      properties: {
        handle: {
          type: "number",
          description: "Target object handle. Omit for the global SV object.",
        },
        field: { type: "string", description: "Field/constant name, e.g. QUARTER." },
      },
      required: ["field"],
    },
  },
  {
    name: "sv_free",
    description: "Release a handle you no longer need.",
    inputSchema: {
      type: "object",
      properties: { handle: { type: "number" } },
      required: ["handle"],
    },
  },
  {
    name: "sv_ping",
    description: 'Health check: returns "pong" if the SynthV bridge loop is alive.',
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "sv_search_api",
    description:
      "Search the parsed local mirror of the official Synthesizer V scripting API. Returns matching classes, methods, overloads, parameters, return types, version requirements, and source anchors.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Class, method, parameter, type, or concept to search." },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Maximum matches, default 25." },
      },
      required: ["query"],
    },
  },
  {
    name: "sv_describe",
    description:
      "Read one official API class or one method's complete overload metadata from the parsed local documentation mirror.",
    inputSchema: {
      type: "object",
      properties: {
        class: { type: "string", description: "Exact official API class name, for example Note or Project." },
        method: { type: "string", description: "Optional exact method name." },
      },
      required: ["class"],
    },
  },
];

const server = new Server(
  { name: "sv-copilot", version: "0.1.0" },
  { capabilities: { tools: {}, resources: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: "svapi://manifest",
      name: "Synthesizer V official API manifest",
      description: "The complete API catalog parsed from the local official documentation mirror.",
      mimeType: "application/json",
    },
  ],
}));

server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
  resourceTemplates: [
    {
      uriTemplate: "svapi://class/{class}",
      name: "Synthesizer V API class",
      description: "One API class and all documented methods, indexed by exact official class name.",
      mimeType: "application/json",
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const payload = readApiResource(request.params.uri);
  return {
    contents: [
      {
        uri: request.params.uri,
        mimeType: "application/json",
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;
  const args = request.params.arguments ?? {};
  try {
    let result;
    switch (name) {
      case "sv_root": {
        result = await bridge.call({ op: "root" });
        rememberRootHandles(result);
        await refreshHostVersion();
        break;
      }
      case "sv_call": {
        if (typeof args.method !== "string" || !args.method) {
          return toolError("INVALID_METHOD: method must be a non-empty string.");
        }
        const callArgs = args.args ?? [];
        const targetType = resolveTargetType(args.handle);
        const validation = validateApiCall({
          className: targetType,
          method: args.method,
          args: callArgs,
          hostVersion,
          resolveHandleType: (handle) => handleTypes.get(handle) ?? null,
        });
        if (!validation.ok) return toolError(`${validation.code}: ${validation.message}`);

        const cmd = { op: "call", method: args.method, args: callArgs };
        if (args.handle !== undefined && args.handle !== null) cmd.handle = args.handle;
        result = await bridge.call(cmd);
        rememberHandles(
          result,
          inferReturnedHandleType(targetType, args.method, callArgs, validation.overloads)
        );
        break;
      }
      case "sv_index": {
        resolveTargetType(args.handle);
        const cmd = { op: "index", field: args.field };
        if (args.handle !== undefined && args.handle !== null) cmd.handle = args.handle;
        result = await bridge.call(cmd);
        rememberHandles(result);
        break;
      }
      case "sv_free":
        requireHandle(args.handle);
        result = await bridge.call({ op: "free", handle: args.handle });
        handleTypes.delete(args.handle);
        break;
      case "sv_ping":
        result = await bridge.call({ op: "ping" });
        break;
      case "sv_search_api":
        result = searchApi(args.query, { limit: args.limit });
        break;
      case "sv_describe": {
        if (!getApiClass(args.class)) return toolError(`UNKNOWN_CLASS: ${String(args.class)}.`);
        result = describeApi(args.class, args.method);
        if (!result) return toolError(`UNKNOWN_METHOD: ${args.class}.${String(args.method)}.`);
        break;
      }
      default:
        return toolError(`Unknown tool: ${name}`);
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result ?? null, null, 2) }],
    };
  } catch (err) {
    return {
      content: [
        { type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` },
      ],
      isError: true,
    };
  }
});

function toolError(message) {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

function readApiResource(uri) {
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error(`Invalid resource URI: ${uri}`);
  }
  if (parsed.protocol !== "svapi:") throw new Error(`Unsupported resource URI: ${uri}`);

  if (parsed.hostname === "manifest" && (parsed.pathname === "" || parsed.pathname === "/")) {
    return apiManifest;
  }
  if (parsed.hostname === "class") {
    const className = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
    if (!className || className.includes("/")) throw new Error(`Invalid API class resource: ${uri}`);
    const apiClass = getApiClass(className);
    if (!apiClass) throw new Error(`Unknown API class: ${className}`);
    return {
      schemaVersion: apiManifest.schemaVersion,
      generatedAt: apiManifest.generatedAt,
      sourceMirror: apiManifest.sourceMirror,
      class: apiClass,
    };
  }
  throw new Error(`Unsupported resource URI: ${uri}`);
}

function resolveTargetType(handle) {
  if (handle === undefined || handle === null) return "SV";
  requireHandle(handle);
  return handleTypes.get(handle) ?? null;
}

function requireHandle(handle) {
  if (!Number.isSafeInteger(handle) || handle < 1) {
    throw new Error("handle must be a positive safe integer.");
  }
}

function rememberRootHandles(roots) {
  if (!roots || typeof roots !== "object") return;
  for (const [name, type] of Object.entries(ROOT_HANDLE_TYPES)) {
    rememberHandles(roots[name], type);
  }
}

function rememberHandles(value, inferredType = null) {
  if (Array.isArray(value)) {
    for (const item of value) rememberHandles(item, inferredType);
    return;
  }
  if (!value || typeof value !== "object") return;

  if (Number.isSafeInteger(value.__handle__)) {
    const explicitType = typeof value.__type__ === "string" ? value.__type__ : null;
    const type = getApiClass(explicitType) ? explicitType : inferredType;
    if (getApiClass(type)) {
      handleTypes.set(value.__handle__, type);
      value.__type__ = type;
    }
    return;
  }
  for (const nested of Object.values(value)) rememberHandles(nested);
}

async function refreshHostVersion() {
  hostVersion = null;
  try {
    const hostInfo = await bridge.call({ op: "call", method: "getHostInfo", args: [] });
    if (typeof hostInfo?.hostVersion === "string") {
      hostVersion = hostInfo.hostVersion;
    } else if (Number.isSafeInteger(hostInfo?.hostVersionNumber)) {
      const version = hostInfo.hostVersionNumber;
      hostVersion = `${(version >>> 16) & 0xff}.${(version >>> 8) & 0xff}.${version & 0xff}`;
    }
  } catch {
    hostVersion = null;
  }
}

async function main() {
  await bridge.init();
  const session = resolveSession();
  const paths = resolvePipePaths(session);
  console.error(`[sv-copilot] IO PIPE relay listening (session=${session})`);
  console.error(`[sv-copilot] to-sv: ${paths.toSv}`);
  console.error(`[sv-copilot] from-sv: ${paths.fromSv}`);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[sv-copilot] MCP server running on stdio");
}

let shuttingDown = false;
async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[sv-copilot] shutting down: ${reason}`);
  if (typeof bridge.close === "function") await bridge.close();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.stdin.once("end", () => void shutdown("stdin closed"));

main().catch((e) => {
  console.error("[sv-copilot] fatal:", e);
  process.exit(1);
});
