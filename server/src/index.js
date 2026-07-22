#!/usr/bin/env node
// MCP 入口只负责工具与资源路由；宿主会话、工作流、快照和处理等待各自封装。

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
  apiManifestAvailable,
  describeApi,
  getApiClass,
  searchApi,
} from "./api-catalog.js";
import { HostSession } from "./host-session.js";
import { AuditionService } from "./audition.js";
import { LyricsService } from "./lyrics.js";
import { RangeSnapshotService } from "./musical-range.js";
import { NotePatchService } from "./note-patch.js";
import { NoteStructureService } from "./note-structure.js";
import {
  BUILTIN_AUTOMATION_PARAMETERS,
  ParameterCurveService,
} from "./parameter-curve.js";
import { ProcessingService } from "./processing.js";
import { MAX_PROJECT_PAGE_ITEMS, SnapshotService } from "./snapshot.js";
import { PipeRelay, resolvePipePaths, resolveSession } from "./transport-pipe.js";
import { VoiceProfileService } from "./voice-profile.js";
import { WorkflowExecutor } from "./workflow.js";

const bridge = new PipeRelay();
const hostSession = new HostSession(bridge);
const snapshotService = new SnapshotService(hostSession);
const workflowExecutor = new WorkflowExecutor(hostSession);
const processingService = new ProcessingService(hostSession, snapshotService);
const lyricsService = new LyricsService(hostSession, snapshotService);
const notePatchService = new NotePatchService(hostSession, snapshotService);
const rangeSnapshotService = new RangeSnapshotService(hostSession);
const parameterCurveService = new ParameterCurveService(hostSession);
const noteStructureService = new NoteStructureService(hostSession, snapshotService);
const auditionService = new AuditionService(hostSession);
const voiceProfileService = new VoiceProfileService(hostSession);

const HANDLE_SCHEMA = {
  anyOf: [
    { type: "integer", minimum: 1 },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        __handle__: { type: "integer", minimum: 1 },
        __type__: { type: "string" },
        __epoch__: { type: "integer", minimum: 0 },
      },
      required: ["__handle__"],
    },
  ],
};
const JSON_ARGUMENT_SCHEMA = {
  anyOf: [
    { type: "null" },
    { type: "boolean" },
    { type: "number" },
    { type: "string" },
    { type: "array" },
    { type: "object" },
  ],
};
const LOCAL_REFERENCE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    $ref: {
      type: "string",
      pattern: "^#/(roots|inputs|steps)/",
      description:
        "JSON Pointer to a root, input, or previous step result, for example #/steps/track/result.",
    },
  },
  required: ["$ref"],
};

const TOOLS = [
  {
    name: "sv_root",
    description:
      "Get handles to the root SynthV objects. Call this first when using the raw dispatcher tools.",
    inputSchema: { type: "object", properties: {}, required: [] },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "sv_call",
    description:
      'Call one official SynthV method. Omit handle for global SV; pass handle arguments as {"__handle__":N}. This raw escape hatch preserves host-native indexing and semantics.',
    inputSchema: {
      type: "object",
      properties: {
        handle: {
          ...HANDLE_SCHEMA,
          description: "Target handle integer or epoch-bound handle object; omit for global SV.",
        },
        method: { type: "string", minLength: 1 },
        args: {
          type: "array",
          items: JSON_ARGUMENT_SCHEMA,
          default: [],
          description:
            "Ordered JSON arguments. Preserve native types: use 1 for a numeric index, not the string \"1\"; handles are objects with __handle__.",
        },
      },
      required: ["method"],
    },
  },
  {
    name: "sv_index",
    description: "Read a field or constant on global SV or a handle using dot access.",
    inputSchema: {
      type: "object",
      properties: {
        handle: HANDLE_SCHEMA,
        field: { type: "string", minLength: 1 },
      },
      required: ["field"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "sv_free",
    description: "Release a raw dispatcher handle that is no longer needed.",
    inputSchema: {
      type: "object",
      properties: { handle: HANDLE_SCHEMA },
      required: ["handle"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "sv_ping",
    description: 'End-to-end health check; returns "pong" when the SynthV bridge loop is alive.',
    inputSchema: { type: "object", properties: {}, required: [] },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "sv_search_api",
    description: "Search the parsed local mirror of the official Synthesizer V scripting API.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      required: ["query"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "sv_describe",
    description: "Read one official API class or method's complete overload metadata.",
    inputSchema: {
      type: "object",
      properties: {
        class: { type: "string", minLength: 1 },
        method: { type: "string" },
      },
      required: ["class"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "sv_snapshot",
    description:
      "Inspect the current selection, project, or one group as canonical 0-based data. Returns a short-lived contextId for conflict-checked high-level edits. Project page.count measures traversalItems, while page.returned reports actual tracks, groups, and notes. Follow page.nextCursor until data.snapshotComplete is true.",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "object",
          properties: {
            kind: { enum: ["selection", "project", "group"] },
            trackIndex: { type: "integer", minimum: 0 },
            groupIndex: { type: "integer", minimum: 0 },
          },
          required: ["kind"],
        },
        include: {
          type: "array",
          uniqueItems: true,
          items: { enum: ["structure", "notes", "voiceParameters", "processing"] },
          description:
            "Requested data. processing adds an explicit processing summary for selection/group and each project group.",
        },
        pageSize: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description:
            `Maximum returned items. Project traversal is additionally capped at ${MAX_PROJECT_PAGE_ITEMS} host-backed items per page to bound latency.`,
        },
        cursor: {
          type: "string",
          description: "Opaque page.nextCursor from the preceding response.",
        },
      },
    },
    outputSchema: { type: "object", additionalProperties: true },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "sv_run",
    description:
      'Run an ordered, fail-fast workflow of raw call/index steps with local JSON Pointer references, read-back assertions, undo boundaries, structured partial failure, and scoped handle cleanup. Exact two-step example: {"mode":"read","steps":[{"id":"track","op":"call","target":{"$ref":"#/roots/project"},"method":"getTrack","args":[1]},{"id":"name","op":"call","target":{"$ref":"#/steps/track/result"},"method":"getName","return":true}]}. It is not atomic and never auto-rolls back.',
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        mode: { enum: ["read", "write"] },
        inputs: {
          type: "object",
          description: "Caller values addressable as #/inputs/<name>.",
        },
        undoBoundary: { enum: ["none", "before", "before-and-after"] },
        timeoutMs: { type: "integer", minimum: 100, maximum: 60000 },
        steps: {
          type: "array",
          minItems: 1,
          maxItems: 128,
          items: {
            type: "object",
            properties: {
              id: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$" },
              op: { enum: ["call", "index"] },
              target: {
                anyOf: [{ const: "SV" }, HANDLE_SCHEMA, LOCAL_REFERENCE_SCHEMA],
                description:
                  'Use "SV", a handle, {"$ref":"#/roots/project"}, or {"$ref":"#/steps/<earlier-id>/result"}.',
              },
              method: { type: "string" },
              field: { type: "string" },
              args: {
                type: "array",
                items: JSON_ARGUMENT_SCHEMA,
                description:
                  "Ordered JSON arguments. A single-key {$ref: ...} object may reference roots, inputs, or an earlier step result.",
              },
              resultFormat: { enum: ["legacy", "typed-v2"] },
              resultShape: { enum: ["array"] },
              resultLength: { type: "integer", minimum: 0 },
              expect: {
                type: "object",
                properties: {
                  operator: {
                    enum: [
                      "equals",
                      "notEquals",
                      "exists",
                      "nonEmpty",
                      "lengthEquals",
                      "everyNonEmptyString",
                      "coverageAtLeast"
                    ],
                  },
                  value: {},
                  select: { type: "string" },
                },
                required: ["operator"],
              },
              verifiesStep: {
                type: "string",
                pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$",
                description:
                  "Previous mutation step whose postcondition is established by this step's successful expect assertion.",
              },
              return: { type: "boolean" },
            },
            required: ["id", "op"],
          },
        },
        exports: {
          type: "object",
          description:
            'Named output values, typically {"name":{"$ref":"#/steps/name/result"}}.',
        },
      },
      required: ["mode", "steps"],
    },
    outputSchema: { type: "object", additionalProperties: true },
  },
  {
    name: "sv_wait_for_processing",
    description:
      "Poll read-only computed data until phonemes, computed attributes, or computed pitch complete and remain stable. Legal empty phonemes do not make processing pending. An explicit all-non-empty quality condition may return phoneme_coverage_unsatisfied while processing state remains ready.",
    inputSchema: {
      type: "object",
      properties: {
        contextId: { type: "string" },
        group: {
          type: "object",
          properties: {
            __handle__: { type: "integer", minimum: 1 },
            __type__: { type: "string" },
            __epoch__: { type: "integer", minimum: 0 },
          },
          required: ["__handle__"],
        },
        kind: { enum: ["phonemes", "computedAttributes", "computedPitch"] },
        expectedNotes: { type: "integer", minimum: 0 },
        requireNonEmpty: {
          type: "boolean",
          default: false,
          description:
            "Optional phoneme coverage condition, default false. It never changes processing state; on timeout, complete results remain ready and the tool reports phoneme_coverage_unsatisfied.",
        },
        startBlick: { type: "integer", minimum: 0 },
        intervalBlick: { type: "integer", minimum: 1 },
        frames: { type: "integer", minimum: 1 },
        minimumObservedFrames: { type: "integer", minimum: 0 },
        timeoutMs: { type: "integer", minimum: 0, maximum: 30000 },
        pollIntervalMs: { type: "integer", minimum: 20, maximum: 2000 },
        stablePolls: { type: "integer", minimum: 1, maximum: 10 },
      },
    },
    outputSchema: { type: "object", additionalProperties: true },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "sv_set_lyrics",
    description:
      "Set lyrics on the current selection or a snapshot context. Validates cardinality and staleness before writing, creates undo boundaries, reads every value back, and optionally waits for computed processing.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        contextId: { type: "string" },
        lyrics: { type: "array", items: { type: "string" } },
        phonemes: { type: "array", items: { type: ["string", "null"] } },
        languageOverride: { type: "string" },
        requireNonEmptyPhonemes: {
          type: "boolean",
          default: false,
          description:
            "Optional post-write phoneme coverage condition, default false. Legal empty phonemes never make processing pending.",
        },
        waitFor: { enum: ["none", "phonemes", "computedAttributes"] },
        timeoutMs: { type: "integer", minimum: 0, maximum: 30000 },
        pollIntervalMs: { type: "integer", minimum: 20, maximum: 2000 },
      },
      required: ["lyrics"],
    },
    outputSchema: { type: "object", additionalProperties: true },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  {
    name: "sv_patch_notes",
    description:
      'Patch fields of existing notes identified by snapshot noteIds (from sv_snapshot data.notes[].id). Validates everything before writing, produces a plannedDiff (dryRun returns it without side effects), writes inside undo boundaries, reads every value back, and with atomic:true compensates verified failures by restoring journaled previous values. atomicity is "verified_compensation", not ACID: status distinguishes succeeded, rolled_back, rollback_failed, partial, and outcome_unknown.',
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        contextId: { type: "string", minLength: 1 },
        patches: {
          type: "array",
          minItems: 1,
          maxItems: 200,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              noteId: {
                type: "string",
                description: "Note id from the same snapshot context, e.g. ctx_...:n:4.",
              },
              expected: {
                type: "object",
                additionalProperties: false,
                properties: {
                  lyrics: { type: "string" },
                  phonemesOverride: { type: "string" },
                  languageOverride: { type: "string" },
                  pitch: { type: "integer" },
                  onsetBlick: { type: "integer" },
                  durationBlick: { type: "integer" },
                  detuneCents: { type: "number" },
                  attributes: { type: "object" },
                },
                description:
                  "Optional per-field preconditions checked against the live note before any write.",
              },
              set: {
                type: "object",
                additionalProperties: false,
                minProperties: 1,
                properties: {
                  lyrics: { type: "string" },
                  phonemesOverride: { type: "string" },
                  languageOverride: { type: "string" },
                  pitch: { type: "integer", minimum: 0, maximum: 127 },
                  onsetBlick: { type: "integer", minimum: 0 },
                  durationBlick: { type: "integer", minimum: 1 },
                  detuneCents: { type: "number" },
                  attributes: {
                    type: "object",
                    description:
                      "Partial attribute write: only the provided keys are set and verified.",
                  },
                },
              },
            },
            required: ["noteId", "set"],
          },
        },
        dryRun: {
          type: "boolean",
          default: false,
          description: "Validate and return plannedDiff without any host write.",
        },
        atomic: {
          type: "boolean",
          default: true,
          description:
            "On failure after writes began, restore journaled previous values in reverse order and verify the restoration (compensation, not a database transaction).",
        },
        waitFor: { enum: ["none", "phonemes", "computedAttributes"] },
        timeoutMs: { type: "integer", minimum: 0, maximum: 30000 },
        pollIntervalMs: { type: "integer", minimum: 20, maximum: 2000 },
      },
      required: ["contextId", "patches"],
    },
    outputSchema: { type: "object", additionalProperties: true },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  {
    name: "sv_snapshot_range",
    description:
      "Read a musical range (1-based bar/beat, converted with the host-reported SV.QUARTER timebase and project meter map) across selected tracks as canonical 0-based data with both blick and bar/beat coordinates, per-note rests and neighbor lyrics, tempo and meter maps, and optional mixer state. Returns timebase.quarterBlick as conversion evidence and a content-hash snapshotToken (not a host revision): pass it back as sinceToken to get no_change when the observed content is identical. Read-only; use sv_snapshot (selection/group) to obtain an editable contextId.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        scope: {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { const: "range" },
            trackIndices: {
              type: "array",
              minItems: 1,
              items: { type: "integer", minimum: 0 },
              description: "0-based track indices; omit for all tracks.",
            },
            from: {
              type: "object",
              additionalProperties: false,
              properties: {
                bar: { type: "integer", minimum: 1 },
                beat: { type: "integer", minimum: 1 },
              },
              required: ["bar"],
            },
            to: {
              type: "object",
              additionalProperties: false,
              properties: {
                bar: { type: "integer", minimum: 1 },
                beat: { type: "integer", minimum: 1 },
              },
              required: ["bar"],
              description: "Exclusive end of the range (bar/beat are 1-based).",
            },
          },
          required: ["kind", "from", "to"],
        },
        include: {
          type: "array",
          uniqueItems: true,
          items: {
            enum: [
              "notes",
              "tempoMap",
              "meterMap",
              "mixer",
              "voiceParameters",
              "automation",
              "attributes",
              "retakes",
            ],
          },
          description:
            "Defaults to notes, tempoMap, meterMap. automation/attributes/retakes are not yet available and produce an UNSUPPORTED_INCLUDE warning instead of failing.",
        },
        sinceToken: {
          type: "string",
          description: "snapshotToken from a previous read; identical content returns no_change.",
        },
      },
      required: ["scope"],
    },
    outputSchema: { type: "object", additionalProperties: true },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "sv_get_parameter_curve",
    description:
      "Read one Automation parameter curve of a note group within a required blick range. Accepted built-ins are pitchDelta, vibratoEnv, loudness, tension, breathiness, voicing, and gender; vocalMode_<Name> is accepted only when <Name> exists in the target group's observable vocalModeParams. Names are case-insensitive and the response reports requestedParameter and resolvedParameter. Unknown names are rejected before NoteGroup.getParameter because SynthV may silently return a default curve. The host curve is read once with getAllPoints and filtered locally; only an oversized 64 KiB result falls back to density-based range bisection. Automation lives in group-local blicks; every point reports localBlick and absoluteBlick together with the official definition and interpolation method.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        target: {
          type: "object",
          additionalProperties: false,
          properties: {
            trackIndex: { type: "integer", minimum: 0 },
            groupIndex: { type: "integer", minimum: 0 },
          },
          required: ["trackIndex", "groupIndex"],
        },
        parameter: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description:
            "One official built-in Automation typeName or a vocalMode_<Name> exposed by the target group's voice.",
        },
        range: {
          type: "object",
          additionalProperties: false,
          properties: {
            fromBlick: { type: "integer" },
            toBlick: { type: "integer" },
            coordinate: { enum: ["local", "absolute"], default: "local" },
          },
          required: ["fromBlick", "toBlick"],
        },
        maxPoints: { type: "integer", minimum: 1, maximum: 2000 },
      },
      required: ["target", "parameter", "range"],
    },
    outputSchema: { type: "object", additionalProperties: true },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "sv_patch_parameter_curve",
    description:
      "Edit one validated Automation parameter curve inside a blick range. Accepted built-ins are pitchDelta, vibratoEnv, loudness, tension, breathiness, voicing, and gender; vocalMode_<Name> must exist in the target group's observable vocalModeParams. Unknown names are rejected before NoteGroup.getParameter, and the returned Automation typeName is checked again to prevent host fallback. replace removes the range and writes explicit points; add/scale transform existing CONTROL POINTS. Writes use Undo boundaries, read-back verification, and optional verified compensation (not ACID).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        target: {
          type: "object",
          additionalProperties: false,
          properties: {
            trackIndex: { type: "integer", minimum: 0 },
            groupIndex: { type: "integer", minimum: 0 },
            expectedGroupUuid: { type: "string", minLength: 1 },
          },
          required: ["trackIndex", "groupIndex"],
        },
        parameter: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description:
            "One official built-in Automation typeName or a vocalMode_<Name> exposed by the target group's voice.",
        },
        mode: { enum: ["replace", "add", "scale"] },
        range: {
          type: "object",
          additionalProperties: false,
          properties: {
            fromBlick: { type: "integer" },
            toBlick: { type: "integer" },
            coordinate: { enum: ["local", "absolute"], default: "local" },
          },
          required: ["fromBlick", "toBlick"],
        },
        points: {
          type: "array",
          maxItems: 2000,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              blick: { type: "integer" },
              value: { type: "number" },
            },
            required: ["blick", "value"],
          },
          description: "replace mode only; blick uses range.coordinate.",
        },
        amount: { type: "number", description: "add/scale mode only." },
        simplifyThreshold: { type: "number", minimum: 0 },
        dryRun: { type: "boolean", default: false },
        atomic: { type: "boolean", default: true },
      },
      required: ["target", "parameter", "mode", "range"],
    },
    outputSchema: { type: "object", additionalProperties: true },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  {
    name: "sv_patch_parameter_curves",
    description:
      "Atomically edit 1-16 distinct Automation parameters on one note group. Built-in names and observable vocalMode_<Name> values are resolved before any getParameter call; the returned Automation typeName is checked again, aliases report requestedParameter/resolvedParameter, and uniqueness is enforced after resolution. The service then validates all curves, opens one host Undo interval, writes and verifies every curve, and compensates every touched curve in reverse order on failure (verified compensation, not ACID). compact/standard/verbose control evidence size. undoLabel is audit-only. timings exposes coordinatorQueueMs and service-internal phases; dispatcherQueueMs is null because MCP SDK waiting before handler entry is not observable.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        target: {
          type: "object",
          additionalProperties: false,
          properties: {
            trackIndex: { type: "integer", minimum: 0 },
            groupIndex: { type: "integer", minimum: 0 },
            expectedGroupUuid: { type: "string", minLength: 1 },
          },
          required: ["trackIndex", "groupIndex"],
        },
        curves: {
          type: "array",
          minItems: 1,
          maxItems: 16,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              parameter: {
                type: "string",
                minLength: 1,
                maxLength: 200,
                description:
                  "One official built-in Automation typeName or a vocalMode_<Name> exposed by the target group's voice.",
              },
              mode: { enum: ["replace", "add", "scale"] },
              range: {
                type: "object",
                additionalProperties: false,
                properties: {
                  fromBlick: { type: "integer" },
                  toBlick: { type: "integer" },
                  coordinate: { enum: ["local", "absolute"], default: "local" },
                },
                required: ["fromBlick", "toBlick"],
              },
              points: {
                type: "array",
                maxItems: 2000,
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    blick: { type: "integer" },
                    value: { type: "number" },
                  },
                  required: ["blick", "value"],
                },
                description: "replace mode only; blick uses range.coordinate.",
              },
              amount: { type: "number", description: "add/scale mode only." },
              simplifyThreshold: { type: "number", minimum: 0 },
            },
            required: ["parameter", "mode", "range"],
          },
        },
        dryRun: { type: "boolean", default: false },
        atomic: { type: "boolean", default: true },
        responseMode: { enum: ["compact", "standard", "verbose"], default: "standard" },
        undoLabel: {
          type: "string",
          maxLength: 200,
          description: "Audit metadata only; the SynthV Undo API cannot display custom labels.",
        },
      },
      required: ["target", "curves"],
    },
    outputSchema: { type: "object", additionalProperties: true },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  {
    name: "sv_restructure_notes",
    description:
      "Structural note edits on a snapshot context: insert new notes, delete (with a deep-copy compensation backup), split one note at a group-local blick (second half defaults to the \"-\" extender lyric), and merge consecutive notes. Operations run in caller order with live index resolution, inside undo boundaries. atomic:true restores the journal (clones and durations) in reverse order on failure — verified compensation, not ACID. A successful write invalidates the contextId; re-snapshot before further edits.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        contextId: { type: "string", minLength: 1 },
        operations: {
          type: "array",
          minItems: 1,
          maxItems: 64,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              op: { enum: ["insert", "delete", "split", "merge"] },
              note: {
                type: "object",
                additionalProperties: false,
                properties: {
                  onsetBlick: { type: "integer", minimum: 0 },
                  durationBlick: { type: "integer", minimum: 1 },
                  pitch: { type: "integer", minimum: 0, maximum: 127 },
                  lyrics: { type: "string" },
                  phonemesOverride: { type: "string" },
                  languageOverride: { type: "string" },
                },
                required: ["onsetBlick", "durationBlick", "pitch"],
                description: "insert only. onsetBlick is group-local.",
              },
              noteId: { type: "string", description: "delete/split: note id from the same context." },
              expected: {
                type: "object",
                description: "delete only: fingerprint preconditions checked before any write.",
              },
              atBlick: {
                type: "integer",
                minimum: 1,
                description: "split only: group-local position strictly inside the note.",
              },
              secondLyrics: { type: "string", description: 'split only; defaults to "-".' },
              noteIds: {
                type: "array",
                minItems: 2,
                items: { type: "string" },
                description: "merge only: consecutive notes in group order.",
              },
              lyricsJoin: { enum: ["first", "concat"], description: "merge only; default first." },
            },
            required: ["op"],
          },
        },
        dryRun: { type: "boolean", default: false },
        atomic: { type: "boolean", default: true },
        waitFor: { enum: ["none", "phonemes", "computedAttributes"] },
        timeoutMs: { type: "integer", minimum: 0, maximum: 30000 },
        pollIntervalMs: { type: "integer", minimum: 20, maximum: 2000 },
      },
      required: ["contextId", "operations"],
    },
    outputSchema: { type: "object", additionalProperties: true },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  {
    name: "sv_start_audition",
    description:
      "Non-blocking audition: save playhead and target-track solo state, stop existing playback when necessary, solo the requested tracks, seek to the range start (absolute blicks converted via TimeAxis), and play or loop. Startup succeeds only after read-back confirms solo, playhead, and an active playback status; silently ignored host writes are compensated and reported as failure. For loop:false, toBlick describes the requested range but PlaybackControl has no bounded-play primitive: data.endPolicy is caller_stop and the caller must invoke sv_stop_audition. A normal play request may report looping when the host UI loop region is active. Returns an auditionId plus a recovery payload the caller should keep — if this server crashes, sv_restore_audition can undo solo/playhead changes from the payload alone. MCP cannot hear audio; a human judges the sound.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        fromBlick: { type: "integer", minimum: 0 },
        toBlick: { type: "integer", minimum: 1 },
        soloTrackIndices: {
          type: "array",
          items: { type: "integer", minimum: 0 },
          description: "0-based tracks to solo for the audition; omit to leave the mixer untouched.",
        },
        loop: { type: "boolean", default: false },
      },
      required: ["fromBlick", "toBlick"],
    },
    outputSchema: { type: "object", additionalProperties: true },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  {
    name: "sv_get_audition",
    description: "Read the current playback status and playhead for a running audition.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { auditionId: { type: "string", minLength: 1 } },
      required: ["auditionId"],
    },
    outputSchema: { type: "object", additionalProperties: true },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "sv_stop_audition",
    description:
      "Stop an audition and restore the saved state: playback stops, solo fields are restored ONLY if they still hold the audition-set value (user changes are left untouched and reported), and the playhead returns to the saved position. Success requires read-back status stopped plus the saved playhead and mixer values; otherwise restore_failed preserves the audition for retry. Returns per-field restoration evidence.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { auditionId: { type: "string", minLength: 1 } },
      required: ["auditionId"],
    },
    outputSchema: { type: "object", additionalProperties: true },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  {
    name: "sv_restore_audition",
    description:
      "Restore mixer and playhead state from a recovery payload returned by sv_start_audition. Use after a server crash left solo/mute changes behind. Same skip-if-user-modified semantics as sv_stop_audition.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        recovery: {
          type: "object",
          description: "The recovery payload from sv_start_audition (version 1).",
        },
      },
      required: ["recovery"],
    },
    outputSchema: { type: "object", additionalProperties: true },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  {
    name: "sv_get_voice_profile",
    description:
      "Read observable voice parameters (getVoice, including vocalModeParams names) for a track's groups. The official API exposes NO singer identity, installed voicebank catalog, or assignment relation — those are reported as unobservable, never inferred.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        trackIndex: { type: "integer", minimum: 0 },
        groupIndex: {
          type: "integer",
          minimum: 0,
          description: "Omit to profile every group on the track.",
        },
      },
      required: ["trackIndex"],
    },
    outputSchema: { type: "object", additionalProperties: true },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "sv_clone_track_from_template",
    description:
      "Clone an existing track (Track.clone + Project.addTrack) to create e.g. a harmony track inheriting the template's groups and voice settings, inside undo boundaries with read-back verification. Track.clone only promises a deep copy: whether hidden singer state survives is host-opaque and reported as identityPreservation: \"host_opaque\".",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        templateTrackIndex: { type: "integer", minimum: 0 },
        name: { type: "string", minLength: 1 },
      },
      required: ["templateTrackIndex"],
    },
    outputSchema: { type: "object", additionalProperties: true },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
];

const server = new Server(
  { name: "sv-copilot", version: "0.3.0" },
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
    {
      uri: "svcopilot://capabilities",
      name: "SV Copilot runtime capabilities",
      description: "Connection state, limits, workflow features, and explicit host capability gaps.",
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
  const payload = readResource(request.params.uri);
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
      case "sv_root":
        result = await hostSession.roots();
        break;
      case "sv_call":
        result = await hostSession.call({
          handle: args.handle,
          method: args.method,
          args: args.args ?? [],
        });
        break;
      case "sv_index":
        result = await hostSession.index({ handle: args.handle, field: args.field });
        break;
      case "sv_free":
        result = await hostSession.free(args.handle);
        break;
      case "sv_ping":
        result = await hostSession.ping();
        break;
      case "sv_search_api":
        if (!apiManifestAvailable) return manifestUnavailableError();
        result = searchApi(args.query, { limit: args.limit });
        break;
      case "sv_describe":
        if (!apiManifestAvailable) return manifestUnavailableError();
        if (!getApiClass(args.class)) return toolError("UNKNOWN_CLASS", String(args.class));
        result = describeApi(args.class, args.method);
        if (!result) return toolError("UNKNOWN_METHOD", `${args.class}.${String(args.method)}`);
        break;
      case "sv_snapshot":
        result = await snapshotService.snapshot(args);
        break;
      case "sv_run":
        result = await workflowExecutor.run(args);
        break;
      case "sv_wait_for_processing":
        result = await processingService.wait(args);
        break;
      case "sv_set_lyrics":
        result = await lyricsService.setLyrics(args);
        break;
      case "sv_patch_notes":
        result = await notePatchService.patchNotes(args);
        break;
      case "sv_snapshot_range":
        result = await rangeSnapshotService.snapshot(args);
        break;
      case "sv_get_parameter_curve":
        result = await parameterCurveService.getCurve(args);
        break;
      case "sv_patch_parameter_curve":
        result = await parameterCurveService.patchCurve(args);
        break;
      case "sv_patch_parameter_curves":
        result = await parameterCurveService.patchCurves(args);
        break;
      case "sv_restructure_notes":
        result = await noteStructureService.restructureNotes(args);
        break;
      case "sv_start_audition":
        result = await auditionService.start(args);
        break;
      case "sv_get_audition":
        result = await auditionService.get(args);
        break;
      case "sv_stop_audition":
        result = await auditionService.stop(args);
        break;
      case "sv_restore_audition":
        result = await auditionService.restore(args);
        break;
      case "sv_get_voice_profile":
        result = await voiceProfileService.getProfile(args);
        break;
      case "sv_clone_track_from_template":
        result = await voiceProfileService.cloneTrackFromTemplate(args);
        break;
      default:
        return toolError("UNKNOWN_TOOL", name);
    }
    return toolResult(result);
  } catch (error) {
    return toolError(
      typeof error?.code === "string" ? error.code : "INTERNAL_ERROR",
      error instanceof Error ? error.message : String(error)
    );
  }
});

function toolResult(result) {
  const value = result ?? null;
  const structuredContent =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? value
      : { result: value };
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent,
    ...(value?.ok === false ? { isError: true } : {}),
  };
}

function toolError(code, message) {
  const result = {
    ok: false,
    status: "failed",
    error: { code, message },
  };
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
    isError: true,
  };
}

function manifestUnavailableError() {
  return toolError(
    "API_MANIFEST_UNAVAILABLE",
    "The parsed SV API manifest is not loaded; run 'npm run parse:sv-api'."
  );
}

function readResource(uri) {
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error(`Invalid resource URI: ${uri}`);
  }
  if (parsed.protocol === "svcopilot:" && parsed.hostname === "capabilities") {
    return capabilities();
  }
  if (parsed.protocol !== "svapi:") throw new Error(`Unsupported resource URI: ${uri}`);
  if (parsed.hostname === "manifest" && (parsed.pathname === "" || parsed.pathname === "/")) {
    return apiManifest;
  }
  if (parsed.hostname === "class") {
    if (!apiManifestAvailable) throw new Error("API_MANIFEST_UNAVAILABLE");
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

function capabilities() {
  return {
    interfaceVersion: "0.3.0",
    connection: hostSession.getStatus(),
    manifest: {
      available: apiManifestAvailable,
      generatedAt: apiManifest.generatedAt,
    },
    limits: {
      maxFrameBytes: 64 * 1024,
      maxQueuedCalls: 64,
      maxWorkflowSteps: 128,
      maxSnapshotPageSize: 200,
      maxProjectPageItems: MAX_PROJECT_PAGE_ITEMS,
      projectPageUnit: "traversalItems",
      singleInFlight: true,
    },
    interfaces: {
      raw: ["sv_root", "sv_call", "sv_index", "sv_free"],
      workflow: ["sv_snapshot", "sv_snapshot_range", "sv_run", "sv_wait_for_processing"],
      music: [
        "sv_set_lyrics",
        "sv_patch_notes",
        "sv_restructure_notes",
        "sv_get_parameter_curve",
        "sv_patch_parameter_curve",
        "sv_patch_parameter_curves",
      ],
      audition: [
        "sv_start_audition",
        "sv_get_audition",
        "sv_stop_audition",
        "sv_restore_audition",
      ],
      voice: ["sv_get_voice_profile", "sv_clone_track_from_template"],
      typedResultFormat: "typed-v2",
    },
    knownLimits: {
      snapshotConsistency: "best-effort",
      genericRollback: false,
      nativeMutationReturnValues:
        "Host-native booleans are preserved and may not describe whether state changed; use read-back assertions or high-level tools.",
      singer: {
        installedCatalogObservable: false,
        activeIdentityObservable: false,
        assignmentObservable: false,
      },
      automationParameters: {
        builtIn: BUILTIN_AUTOMATION_PARAMETERS,
        caseSensitive: false,
        vocalModes: "dynamic_from_target_voice",
      },
    },
  };
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
  await bridge.close();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.stdin.once("end", () => void shutdown("stdin closed"));

main().catch((error) => {
  console.error("[sv-copilot] fatal:", error);
  process.exit(1);
});
