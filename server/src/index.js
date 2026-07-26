#!/usr/bin/env node
// MCP 入口只负责工具与资源路由；宿主会话、工作流、快照和处理等待各自封装。

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import Ajv from "ajv";
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
import { ComputedPitchCompareService } from "./computed-pitch-compare.js";
import { ExpressionPlanService } from "./expression-plan.js";
import { HarmonyPlanService } from "./harmony-plan.js";
import { LyricAlignService } from "./lyric-align.js";
import { LyricProsodyService } from "./lyric-prosody.js";
import { LyricsService } from "./lyrics.js";
import {
  RANGE_CAPTURE_LIMITS,
  RANGE_PAGE_LIMITS,
  RANGE_REQUEST_LIMITS,
  RangeSnapshotService,
} from "./musical-range.js";
import { NotePatchService } from "./note-patch.js";
import { NoteStructureService } from "./note-structure.js";
import {
  BUILTIN_AUTOMATION_PARAMETERS,
  ParameterCurveService,
} from "./parameter-curve.js";
import { MAX_PROCESSING_EXPECTED_NOTES, ProcessingService } from "./processing.js";
import {
  musicWorkflowGuideIndex,
  musicWorkflowGuideRecipe,
  musicWorkflowGuideRecipeIds,
} from "./workflow-guide.js";
import { PhraseEditService } from "./phrase-edit.js";
import { PhraseAnalysisService } from "./phrase-analysis.js";
import { QuantizePlanService } from "./quantize-plan.js";
import { MAX_PROJECT_PAGE_ITEMS, SnapshotService } from "./snapshot.js";
import { StyleProfileService } from "./style-profile.js";
import { PipeRelay, resolvePipePaths, resolveSession } from "./transport-pipe.js";
import { VoiceProfileService } from "./voice-profile.js";
import { WorkflowExecutor } from "./workflow.js";

// 单一接口版本来源：server info、capabilities、schema 资源和指南资源都引用它，
// 避免升级时漏改其中一处（维护规则见 docs/MCP_MUSIC_WORKFLOW_MASTER_PLAN.md §10）。
const INTERFACE_VERSION = "0.8.0";

const bridge = new PipeRelay();
const hostSession = new HostSession(bridge);
const snapshotService = new SnapshotService(hostSession);
const workflowExecutor = new WorkflowExecutor(hostSession);
const processingService = new ProcessingService(hostSession, snapshotService);
const lyricsService = new LyricsService(hostSession, snapshotService);
const notePatchService = new NotePatchService(hostSession, snapshotService);
const rangeSnapshotService = new RangeSnapshotService(hostSession, { snapshotService });
const parameterCurveService = new ParameterCurveService(hostSession, { snapshotService });
const noteStructureService = new NoteStructureService(hostSession, snapshotService);
const auditionService = new AuditionService(hostSession);
const voiceProfileService = new VoiceProfileService(hostSession);
const phraseEditService = new PhraseEditService(hostSession, snapshotService);
// 纯内存分析服务：与 range snapshot 共享同一 SnapshotStore，不访问宿主。
const computedPitchCompareService = new ComputedPitchCompareService({
  store: snapshotService.store,
});
const expressionPlanService = new ExpressionPlanService({ store: snapshotService.store });
const lyricAlignService = new LyricAlignService({ store: snapshotService.store });
const phraseAnalysisService = new PhraseAnalysisService({ store: snapshotService.store });
const styleProfileService = new StyleProfileService({ store: snapshotService.store });
const lyricProsodyService = new LyricProsodyService({ store: snapshotService.store });
const quantizePlanService = new QuantizePlanService({ store: snapshotService.store });
const harmonyPlanService = new HarmonyPlanService({ store: snapshotService.store });

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
const MUSICAL_BEAT_SCHEMA = {
  anyOf: [
    { type: "number", minimum: 1 },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        numerator: { type: "integer", minimum: 1 },
        denominator: { type: "integer", minimum: 1 },
      },
      required: ["numerator", "denominator"],
    },
  ],
};
const COMPARE_SIDE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    contextId: { type: "string", minLength: 1 },
    occurrenceId: {
      type: "string",
      minLength: 1,
      description: "Optional when the context has exactly one occurrence with computed pitch.",
    },
  },
  required: ["contextId"],
};
const CURVE_TARGET_SCHEMA = {
  type: "object",
  additionalProperties: false,
  description:
    "Use either trackIndex+groupIndex, or contextId+occurrenceId from sv_snapshot_range.",
  properties: {
    trackIndex: { type: "integer", minimum: 0 },
    groupIndex: { type: "integer", minimum: 0 },
    contextId: { type: "string", minLength: 1 },
    occurrenceId: { type: "string", minLength: 1 },
    expectedGroupUuid: { type: "string", minLength: 1 },
    allowSharedTargetMutation: { type: "boolean", default: false },
    expectedTimeOffsetBlick: {
      type: "integer",
      description:
        "Optional drift guard for the whole reference: the occurrence timeOffsetBlick observed at snapshot time. Absolute-coordinate points are converted to group-local positions with the live getTimeOffset() at apply time, and note fingerprints are group-local, so moving the reference via setTimeOffset changes neither — this field fails such a move with STALE_CONTEXT instead of writing curves at wrong local positions. sv_plan_expression emits it automatically.",
    },
    expectedNotes: {
      type: "array",
      minItems: 1,
      maxItems: 256,
      description:
        "Optional note-anchor drift guard: full snapshot fingerprints of the notes this curve edit is anchored to. Each entry is compared field-by-field against the live host before any read or write; a moved/edited note fails STALE_CONTEXT with effects none instead of writing curves at the note's old position. sv_plan_expression emits this automatically in its applyRequests.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          noteId: { type: "string", minLength: 1 },
          indexInGroup: { type: "integer", minimum: 0 },
          onsetBlick: { type: "integer", minimum: 0 },
          durationBlick: { type: "integer", minimum: 0 },
          pitch: { type: "integer" },
          lyrics: { type: ["string", "null"] },
          phonemesOverride: { type: ["string", "null"] },
          languageOverride: { type: ["string", "null"] },
          detuneCents: { type: "number" },
        },
        required: [
          "indexInGroup",
          "onsetBlick",
          "durationBlick",
          "pitch",
          "lyrics",
          "phonemesOverride",
          "languageOverride",
          "detuneCents",
        ],
      },
    },
  },
};
const NOTE_ANCHOR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    noteId: { type: "string", minLength: 1 },
    position: {
      enum: ["onset", "center", "end", "ratio"],
      description: 'Use "ratio" together with the sibling ratio field.',
    },
    ratio: { type: "number", minimum: 0, maximum: 1 },
    offset: {
      type: "object",
      additionalProperties: false,
      properties: {
        unit: { enum: ["blick", "quarter", "beat"] },
        value: { type: "number" },
      },
      required: ["unit", "value"],
    },
  },
  required: ["noteId", "position"],
};
const NOTE_GAP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    afterNoteId: { type: "string", minLength: 1 },
    beforeNoteId: { type: "string", minLength: 1 },
    position: {
      enum: ["start", "center", "end", "ratio"],
      description: 'Use "ratio" together with the sibling ratio field.',
    },
    ratio: { type: "number", minimum: 0, maximum: 1 },
    offset: {
      type: "object",
      additionalProperties: false,
      properties: {
        unit: { enum: ["blick", "quarter", "beat"] },
        value: { type: "number" },
      },
      required: ["unit", "value"],
    },
  },
  required: ["afterNoteId", "beforeNoteId", "position"],
};
const MUSICAL_POSITION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { bar: { type: "integer", minimum: 1 }, beat: MUSICAL_BEAT_SCHEMA },
  required: ["bar"],
};
const CURVE_POSITION_PROPERTIES = {
  blick: { type: "integer" },
  anchor: NOTE_ANCHOR_SCHEMA,
  musicalPosition: MUSICAL_POSITION_SCHEMA,
  rangeBoundary: { enum: ["start", "end"] },
  gap: NOTE_GAP_SCHEMA,
};
const CURVE_POSITION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: CURVE_POSITION_PROPERTIES,
  description:
    "Exactly one position field is required: blick, anchor, musicalPosition, rangeBoundary, or gap.",
};
const CURVE_POINT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...CURVE_POSITION_PROPERTIES,
    value: { type: "number" },
  },
  required: ["value"],
  description:
    "A value plus exactly one position field: blick, anchor, musicalPosition, rangeBoundary, or gap.",
};
const CURVE_RANGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  description:
    "Use either fromBlick+toBlick, or semantic from+to positions. coordinate applies only to BLICK ranges.",
  properties: {
    fromBlick: { type: "integer" },
    toBlick: { type: "integer" },
    coordinate: { enum: ["local", "absolute"], default: "local" },
    from: CURVE_POSITION_SCHEMA,
    to: CURVE_POSITION_SCHEMA,
  },
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
    description:
      "Release a raw dispatcher handle that is no longer needed, including handles retained by sv_run through retainResult or exports.",
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
      'Run an ordered, fail-fast workflow of raw call/index steps with local JSON Pointer references, read-back assertions, undo boundaries, structured partial failure, and explicit handle ownership. Step results remain available to later references without being returned. Set retainResult:true or place a value in exports to return it; every returned handle becomes caller-owned and must be released with sv_free. Unreturned temporary handles are freed automatically, with counts and retained handles reported in handleOwnership. Exact two-step example: {"mode":"read","steps":[{"id":"track","op":"call","target":{"$ref":"#/roots/project"},"method":"getTrack","args":[1]},{"id":"name","op":"call","target":{"$ref":"#/steps/track/result"},"method":"getName","retainResult":true}]}. It is not atomic and never auto-rolls back.',
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
            additionalProperties: false,
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
              retainResult: {
                type: "boolean",
                default: false,
                description:
                  "Include this step result in the response. Any reachable handle remains live, transfers to the caller, and must later be released with sv_free. When false or omitted, the result is still available to later $ref steps but is not returned.",
              },
            },
            required: ["id", "op"],
          },
        },
        exports: {
          type: "object",
          description:
            'Named output values, typically {"name":{"$ref":"#/steps/name/result"}}. Any handle reachable from exports remains live, transfers to the caller, and must later be released with sv_free.',
        },
      },
      required: ["mode", "steps"],
    },
    outputSchema: { type: "object", additionalProperties: true },
  },
  {
    name: "sv_wait_for_processing",
    description:
      'Poll read-only computed data until phonemes, computed attributes, or computed pitch complete and remain stable. Accepts group/selection snapshot contexts and range snapshot contexts. For a range context, provide occurrenceId; it may be omitted only when exactly one vocal occurrence exists. Multiple candidates return AMBIGUOUS_CONTEXT. For computedPitch, omitted startBlick/intervalBlick/frames inherit that occurrence\'s sampling when the range context was captured with include:["computedPitch"]; otherwise all three are required. Explicit values override captured sampling. Legal empty phonemes do not make processing pending. An explicit all-non-empty quality condition may return phoneme_coverage_unsatisfied while processing state remains ready.',
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        contextId: { type: "string" },
        occurrenceId: {
          type: "string",
          minLength: 1,
          description:
            "Occurrence from sv_snapshot_range; optional only when the range contains exactly one vocal occurrence.",
        },
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
        expectedNotes: {
          type: "integer",
          minimum: 0,
          maximum: MAX_PROCESSING_EXPECTED_NOTES,
        },
        requireNonEmpty: {
          type: "boolean",
          default: false,
          description:
            "Optional phoneme coverage condition, default false. It never changes processing state; on timeout, complete results remain ready and the tool reports phoneme_coverage_unsatisfied.",
        },
        startBlick: {
          type: "integer",
          minimum: 0,
          description:
            'Computed pitch only. Optional when inferred from a range context captured with include:["computedPitch"]; otherwise required.',
        },
        intervalBlick: {
          type: "integer",
          minimum: 1,
          description:
            'Computed pitch only. Optional when inferred from a range context captured with include:["computedPitch"]; otherwise required.',
        },
        frames: {
          type: "integer",
          minimum: 1,
          maximum: RANGE_REQUEST_LIMITS.computedPitchFramesPerGroup,
          description:
            'Computed pitch only. Optional when inferred from a range context captured with include:["computedPitch"]; otherwise required.',
        },
        minimumObservedFrames: {
          type: "integer",
          minimum: 1,
          maximum: RANGE_REQUEST_LIMITS.computedPitchFramesPerGroup,
        },
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
      "Legacy lyrics writer for group/selection snapshot contexts only (range contexts are rejected by design). Prefer sv_patch_notes for simple per-note lyric edits on a range context, and sv_edit_phrase for atomic phrase edits; this tool remains for whole-selection lyric replacement. Validates cardinality and staleness before writing, creates undo boundaries, reads every value back, and optionally waits for computed processing.",
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
      'Patch fields of existing notes identified by snapshot noteIds. Accepts group/selection contexts from sv_snapshot (noteId form ctx_...:n:4) and range contexts from sv_snapshot_range (noteId form ctx_...:t:0:r:1:n:4; the occurrence is derived from the noteIds, or pass occurrenceId). For range contexts a shared target NoteGroup is scanned project-wide at commit and requires allowSharedTargetMutation:true. Validates everything before writing, produces a plannedDiff (dryRun returns it without side effects), writes inside undo boundaries, reads every value back, and with atomic:true compensates verified failures by restoring journaled previous values. atomicity is "verified_compensation", not ACID: status distinguishes succeeded, rolled_back, rollback_failed, partial, and outcome_unknown.',
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        contextId: { type: "string", minLength: 1 },
        occurrenceId: {
          type: "string",
          minLength: 1,
          description:
            "Range contexts only: the occurrence to edit. May be omitted when the noteIds identify one occurrence or exactly one vocal occurrence exists.",
        },
        allowSharedTargetMutation: {
          type: "boolean",
          default: false,
          description:
            "Range contexts: required true when the target NoteGroup has multiple project occurrences (the edit applies to all of them).",
        },
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
      "Capture one editable musical-range context with occurrence and note identities, including notes sustained across the range start. A single host lease can include notes, voice parameters, Automation, computed pitch, attributes, processing, tempo/meter maps, and mixer state. Decimal or rational beats are converted exactly with host SV.QUARTER. Independent response budgets page already-captured pure data through cursor without rereading the host; global capture limits are published in svcopilot://capabilities. snapshotToken is a content hash, not a host revision; sinceToken still reads and hashes before returning no_change.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      description: "Provide scope for a new host read, or cursor alone for a cached page.",
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
                beat: MUSICAL_BEAT_SCHEMA,
              },
              required: ["bar"],
            },
            to: {
              type: "object",
              additionalProperties: false,
              properties: {
                bar: { type: "integer", minimum: 1 },
                beat: MUSICAL_BEAT_SCHEMA,
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
              "computedPitch",
              "attributes",
              "processing",
              "retakes",
            ],
          },
          description:
            "Defaults to notes, tempoMap, meterMap. retakes is capability-blocked and produces an UNSUPPORTED_INCLUDE warning.",
        },
        automationParameters: {
          type: "array",
          minItems: 1,
          maxItems: 16,
          uniqueItems: true,
          items: { type: "string", minLength: 1 },
          description:
            "Automation names to capture; defaults to pitchDelta, tension, loudness, and breathiness. Names use the same validated resolver as curve writes.",
        },
        computedPitchSampling: {
          type: "object",
          additionalProperties: false,
          properties: {
            frames: {
              type: "integer",
              minimum: 1,
              maximum: RANGE_REQUEST_LIMITS.computedPitchFramesPerGroup,
              default: 160,
            },
            startBlick: { type: "integer", minimum: 0 },
            intervalBlick: { type: "integer", minimum: 1 },
          },
        },
        budgets: {
          type: "object",
          additionalProperties: false,
          properties: {
            notes: { type: "integer", minimum: 1, maximum: RANGE_PAGE_LIMITS.maximums.notes },
            attributes: {
              type: "integer",
              minimum: 1,
              maximum: RANGE_PAGE_LIMITS.maximums.attributes,
            },
            automationPoints: {
              type: "integer",
              minimum: 1,
              maximum: RANGE_PAGE_LIMITS.maximums.automationPoints,
            },
            computedPitchFrames: {
              type: "integer",
              minimum: 1,
              maximum: RANGE_PAGE_LIMITS.maximums.computedPitchFrames,
            },
            bytes: { type: "integer", minimum: 8192, maximum: RANGE_PAGE_LIMITS.maximums.bytes },
          },
          description: "Independent per-page data budgets; overflow returns page.nextCursor.",
        },
        responseMode: { enum: ["compact", "standard", "verbose"], default: "standard" },
        sinceToken: {
          type: "string",
          description: "snapshotToken from a previous read; identical content returns no_change.",
        },
        cursor: {
          type: "string",
          minLength: 1,
          description: "Opaque range page or compact detail cursor; cursor reads do not revisit SynthV.",
        },
      },
    },
    outputSchema: { type: "object", additionalProperties: true },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "sv_compare_computed_pitch",
    description:
      'Objective singing analysis over computed pitch already captured by sv_snapshot_range (include ["notes","computedPitch"]). Pure in-memory read: never touches the host, so before/after states must each be snapshotted first. compare_to_target measures one context against note targets (per-note stable-window centerErrorCent, framewise diagnostics, detrended-autocorrelation vibrato rate/depth/regularity, transition overshoot/arrival/settling, anomaly segments). compare_contexts diffs two contexts frame-by-frame on the identical sampling grid by score position (after minus before) with per-note center deltas; Hz-based metrics use each side\'s own tempo map. Per-note pairing matches notes by score position: after a structural edit (insert/delete/move), notes without an unchanged before-note at the same position are reported unmatched with no before/delta instead of a misleading cross-note comparison. anomalySegments.items are sorted by startBlick (score order) by default — anomalySortBy:"severity" sorts by peak error instead; the response declares sortBy, and top always carries the most severe segment regardless of sorting or truncation. Coverage below analysis.lowCoverageWarnRatio (default 0.5) raises LOW_COMPUTED_PITCH_COVERAGE so small-sample summaries are never mistaken for reliable conclusions. Null frames stay null (unvoiced or processing-incomplete) and never enter statistics. Frame-rate adequacy for vibrato is graded ok/borderline/too_coarse instead of failing. Analysis thresholds are engineering defaults, not host-calibrated; musical quality judgment remains human-only.',
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        mode: { enum: ["compare_to_target", "compare_contexts"] },
        contextId: {
          type: "string",
          minLength: 1,
          description: "compare_to_target only: range context from sv_snapshot_range.",
        },
        occurrenceId: {
          type: "string",
          minLength: 1,
          description: "compare_to_target only; optional with exactly one computed-pitch occurrence.",
        },
        before: { ...COMPARE_SIDE_SCHEMA, description: "compare_contexts only: baseline snapshot." },
        after: { ...COMPARE_SIDE_SCHEMA, description: "compare_contexts only: edited snapshot." },
        metrics: {
          type: "object",
          additionalProperties: false,
          properties: {
            perNote: { type: "boolean", default: true },
            vibrato: { type: "boolean", default: true },
            transitions: {
              type: "boolean",
              default: true,
              description: "compare_to_target only; ignored by compare_contexts.",
            },
            anomalySegments: { type: "boolean", default: true },
          },
        },
        analysis: {
          type: "object",
          additionalProperties: false,
          description:
            "Threshold overrides; defaults are engineering heuristics that require host calibration.",
          properties: {
            minValidFramesPerNote: { type: "integer", minimum: 1, maximum: 2000 },
            edgeExclusionRatio: { type: "number", minimum: 0, maximum: 0.4 },
            centerMinFrames: { type: "integer", minimum: 1, maximum: 2000 },
            lowCoverageWarnRatio: {
              type: "number",
              minimum: 0,
              maximum: 1,
              default: 0.5,
              description:
                "Coverage below this ratio raises LOW_COMPUTED_PITCH_COVERAGE; 0 disables the warning.",
            },
            vibrato: {
              type: "object",
              additionalProperties: false,
              properties: {
                minWindowFrames: { type: "integer", minimum: 4, maximum: 2000 },
                hzRange: {
                  type: "array",
                  minItems: 2,
                  maxItems: 2,
                  items: { type: "number", minimum: 0.5, maximum: 20 },
                  description: "Ascending [min, max] Hz search band for autocorrelation lags.",
                },
                minPeakCorrelation: { type: "number", minimum: 0, maximum: 1 },
              },
            },
            transition: {
              type: "object",
              additionalProperties: false,
              properties: {
                arrivalBandCent: { type: "number", minimum: 1, maximum: 1200 },
                settleBandCent: { type: "number", minimum: 1, maximum: 1200 },
                holdFrames: { type: "integer", minimum: 1, maximum: 50 },
                windowMs: { type: "number", minimum: 20, maximum: 5000 },
              },
            },
            anomalyThresholdCent: { type: "number", minimum: 1, maximum: 1200 },
          },
        },
        anomalySortBy: {
          enum: ["startBlick", "severity"],
          default: "startBlick",
          description:
            "Ordering of anomalySegments.items: startBlick = score order (default), severity = peak error descending. top is always the most severe segment.",
        },
        responseMode: { enum: ["compact", "standard", "verbose"], default: "standard" },
      },
      required: ["mode"],
    },
    outputSchema: { type: "object", additionalProperties: true },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "sv_plan_expression",
    description:
      'Dry-run expression planner: turns explicit gestures (scoop/fall/portamento/vibrato/hairpin) and/or a small heuristic intent vocabulary into a reviewable, deterministic automation plan over a range context (include ["notes"]). Pure in-memory read — never writes the host. Every operation is unit-explicit (pitchDelta=cents, loudness=dB, vibratoEnv=0..2 multiplier, tension/breathiness=±1, writeSurface=automation) and compiles into ready-to-submit applyRequests for sv_patch_parameter_curves (dryRun first, then commit through that hardened transaction kernel). Each applyRequest target carries expectedNotes fingerprints of the gesture-anchored notes plus the snapshot-time expectedTimeOffsetBlick, so a note edit or a whole-reference setTimeOffset move after the snapshot fails the apply with STALE_CONTEXT instead of writing curves at stale positions — re-snapshot and re-plan on that error. intent.genre/technique seed gesture candidates; intent.section/emotion modify them, or seed baseline dynamic/color arcs when used alone. Intent-derived gestures never anchor on breath notes (lyrics "br", no singable pitch — their duration still separates phrases; explicit gestures may still target them deliberately). replace mode overwrites existing points inside each operation range and the planner does not check for them; natural vibrato presence is host-unobservable; intent mappings are engineering heuristics; whether it sounds better remains human-only.',
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        contextId: {
          type: "string",
          minLength: 1,
          description: "Range context from sv_snapshot_range captured with notes.",
        },
        occurrenceId: {
          type: "string",
          minLength: 1,
          description: "Optional when noteIds imply it or the context has one occurrence with notes.",
        },
        gestures: {
          type: "array",
          maxItems: 32,
          description: "Explicit gestures; deterministic assembly, user values win over intent.",
          items: {
            type: "object",
            oneOf: [
              {
                additionalProperties: false,
                properties: {
                  type: { const: "scoop" },
                  noteId: { type: "string", minLength: 1 },
                  depthCents: { type: "number", minimum: 1, maximum: 600, default: 30 },
                  lengthQuarter: { type: "number", minimum: 0.01, maximum: 16, default: 0.2 },
                  shapePower: { type: "number", minimum: 0.5, maximum: 8, default: 2 },
                },
                required: ["type", "noteId"],
              },
              {
                additionalProperties: false,
                properties: {
                  type: { const: "fall" },
                  noteId: { type: "string", minLength: 1 },
                  depthCents: { type: "number", minimum: 1, maximum: 600, default: 40 },
                  lengthQuarter: { type: "number", minimum: 0.01, maximum: 16, default: 0.3 },
                  shapePower: { type: "number", minimum: 0.5, maximum: 8, default: 2 },
                },
                required: ["type", "noteId"],
              },
              {
                additionalProperties: false,
                properties: {
                  type: { const: "portamento" },
                  fromNoteId: { type: "string", minLength: 1 },
                  toNoteId: { type: "string", minLength: 1 },
                  lengthQuarter: { type: "number", minimum: 0.01, maximum: 4, default: 0.15 },
                  maxCents: { type: "number", minimum: 10, maximum: 1200 },
                },
                required: ["type", "fromNoteId", "toNoteId"],
                description: "Symmetric glide between adjacent notes (no rest between).",
              },
              {
                additionalProperties: false,
                properties: {
                  type: { const: "vibrato" },
                  noteId: { type: "string", minLength: 1 },
                  surface: {
                    enum: ["pitchDelta", "vibratoEnv"],
                    default: "pitchDelta",
                    description:
                      "pitchDelta renders an explicit sine (may stack with unobservable natural vibrato); vibratoEnv shapes the host envelope (effect depends on natural vibrato).",
                  },
                  depthCents: { type: "number", minimum: 1, maximum: 600, default: 30 },
                  rateHz: { type: "number", minimum: 0.5, maximum: 12, default: 5.5 },
                  onsetDelayQuarter: { type: "number", minimum: 0, maximum: 16, default: 0.3 },
                  rampQuarter: { type: "number", minimum: 0, maximum: 16, default: 0.3 },
                  fadeOutQuarter: { type: "number", minimum: 0, maximum: 16, default: 0.2 },
                  level: { type: "number", minimum: 0, maximum: 2, default: 1 },
                },
                required: ["type", "noteId"],
              },
              {
                additionalProperties: false,
                properties: {
                  type: { const: "hairpin" },
                  fromNoteId: { type: "string", minLength: 1 },
                  toNoteId: { type: "string", minLength: 1 },
                  parameter: { enum: ["loudness", "tension", "breathiness"], default: "loudness" },
                  amount: {
                    type: "number",
                    minimum: -24,
                    maximum: 24,
                    description: "Peak delta in the parameter's own unit (dB for loudness, ±1 scale otherwise).",
                  },
                  peakPosition: { type: "number", minimum: 0.05, maximum: 0.95, default: 0.6 },
                },
                required: ["type", "fromNoteId", "toNoteId"],
              },
            ],
          },
        },
        intent: {
          type: "object",
          additionalProperties: false,
          description:
            "Small heuristic vocabulary; derived gestures carry heuristic confidence. preset expands to constant intent-field and constraint defaults (reviewable via presetExpansion in the response, never an opaque button); explicit intent fields override the preset's values with a PRESET_FIELD_OVERRIDDEN warning, and explicit constraints always win over preset constraint defaults.",
          properties: {
            preset: {
              enum: [
                "jpop_cool",
                "jpop_belt",
                "controlled_anger",
                "intimate_whisper",
                "spoken_rap_transition",
              ],
            },
            genre: { enum: ["jpop"] },
            section: { enum: ["verse", "prechorus", "chorus", "bridge"] },
            emotion: { enum: ["cool_anger", "tender"] },
            technique: {
              type: "array",
              uniqueItems: true,
              items: { enum: ["controlled_belt", "soft_airy", "light_rasp"] },
            },
          },
        },
        constraints: {
          type: "object",
          additionalProperties: false,
          properties: {
            maxAbsPitchDeltaCents: { type: "number", minimum: 10, maximum: 1200, default: 200 },
            maxAbsLoudnessDeltaDb: { type: "number", minimum: 0.5, maximum: 24, default: 6 },
            maxAbsTensionDelta: { type: "number", minimum: 0.05, maximum: 1, default: 0.5 },
            maxAbsBreathinessDelta: { type: "number", minimum: 0.05, maximum: 1, default: 0.5 },
            maxTotalPoints: { type: "integer", minimum: 16, maximum: 2000, default: 400 },
            avoidExcessiveVibrato: { type: "boolean", default: true },
          },
        },
        sampling: {
          type: "object",
          additionalProperties: false,
          properties: {
            pointsPerQuarter: { type: "integer", minimum: 2, maximum: 32, default: 8 },
            vibratoPointsPerCycle: { type: "integer", minimum: 4, maximum: 16, default: 8 },
          },
        },
        responseMode: { enum: ["compact", "standard", "verbose"], default: "standard" },
      },
      required: ["contextId"],
    },
    outputSchema: { type: "object", additionalProperties: true },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "sv_align_lyrics",
    description:
      'Side-effect-free lyric alignment planner over a range context (include ["notes"]): tokenizes mixed-language lyric text and maps units onto notes without touching the host. Japanese kana use deterministic mora rules (one kana per beat; small kana merge into the previous mora; sokuon/moraic-n/chouon each take one note); English words use a heuristic vowel-group syllable count (~85-90% literature accuracy, only affects the number of "+" continuation notes); Mandarin/Cantonese map one character per note; kanji readings are unavailable (no G2P) so each kanji is planned as one note flagged needs_review; "br" is an explicit breath note. Returns per-note planned lyrics/languageOverride with tiered confidence plus one ready-to-submit sv_patch_notes patchRequest whose expected.lyrics preconditions guard against post-snapshot drift. Plans above the 200-patch per-call cap return the first 200 plus a continuation block (warned as PLAN_EXCEEDS_PATCH_CAP): follow-up batches cannot be pre-generated because a successful sv_patch_notes invalidates the contextId (and noteIds embed it) — commit, re-run sv_snapshot_range, re-run this tool with identical arguments, and repeat. Applied notes come back unchanged so the rounds converge to status no_change. Explicit occurrenceId/startNoteId are re-anchored only while a short-lived continuation identity proves the same target UUID and unchanged note structure (warned as STALE_SELECTOR_REANCHORED); forged, expired, or drifted selectors are rejected. "+"/"-"/"br" are host conventions; G2P parity with the host is not guaranteed.',
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        contextId: {
          type: "string",
          minLength: 1,
          description: "Range context from sv_snapshot_range captured with notes.",
        },
        occurrenceId: {
          type: "string",
          minLength: 1,
          description: "Optional when startNoteId implies it or the context has one occurrence with notes.",
        },
        lyrics: {
          type: "string",
          minLength: 1,
          maxLength: 2000,
          description: "Free lyric text; kana/CJK/latin segments are classified automatically.",
        },
        language: {
          enum: ["auto", "japanese", "english", "mandarin", "cantonese"],
          default: "auto",
          description:
            "auto classifies per segment; CJK ideographs without surrounding kana then need an explicit language.",
        },
        startNoteId: {
          type: "string",
          minLength: 1,
          description: "First note to fill; defaults to the occurrence's first captured note.",
        },
        setLanguageOverride: {
          type: "boolean",
          default: true,
          description: "Also plan per-note languageOverride values where the token language is known.",
        },
        responseMode: { enum: ["compact", "standard", "verbose"], default: "standard" },
      },
      required: ["contextId", "lyrics"],
    },
    outputSchema: { type: "object", additionalProperties: true },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "sv_analyze_phrase",
    description:
      'Read-only music-theory analysis over a range context (include ["notes"]): duration-weighted pitch-class histogram correlated against all 24 Krumhansl-Kessler key profiles returns RANKED key candidates with Pearson correlations and the margin to the runner-up (relative major/minor ambiguity on short melodies is expected and exposed, not hidden); per-note scale degrees with non-diatonic flags (sharps-only spelling, natural-minor degrees); rest-threshold phrase segmentation with climax/ambitus/rests; register, interval, and rhythm statistics. Breath notes (lyrics "br", a host convention) carry a nominal pitch but no singable pitch: they are excluded from key/scale-degree/phrase/statistics entirely and reported separately as breathEvents with nominalPitch (noteCount counts melodic notes only; a range that is all breaths fails with NO_MELODIC_NOTES). Everything is derived/heuristic, never claimed as host fact; musical judgment stays human-only.',
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        contextId: {
          type: "string",
          minLength: 1,
          description: "Range context from sv_snapshot_range captured with notes.",
        },
        occurrenceId: {
          type: "string",
          minLength: 1,
          description: "Optional when the context has exactly one occurrence with notes.",
        },
        include: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: { enum: ["key", "scaleDegrees", "phrases", "statistics"] },
          description: "Defaults to all sections; scaleDegrees implies key detection.",
        },
        phraseGapQuarter: {
          type: "number",
          minimum: 0.25,
          maximum: 8,
          default: 1,
          description: "Rest length (in quarters) treated as a phrase boundary.",
        },
        responseMode: {
          enum: ["compact", "standard", "verbose"],
          default: "standard",
          description:
            "compact returns summaries without per-note item lists; standard caps scaleDegrees.items, phrases.items, and breathEvents.items at 100 with a truncation warning; verbose returns full lists.",
        },
      },
      required: ["contextId"],
    },
    outputSchema: { type: "object", additionalProperties: true },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "sv_style_profile",
    description:
      'Read-only style statistics aggregated over 1-8 range contexts (in-memory only, never touches the host). Per target: register/interval/rhythm/rest statistics and phrase-length distribution over MELODIC notes (breath notes "br" are counted separately per the v0.6.2 contract), languageOverride distribution, Automation control-point statistics per parameter (point counts, min/max/mean, non-default ratio, per-phrase min/max — these describe CONTROL POINTS, not the host-interpolated audible curve), and observable vocalModeParams key names (singer identity stays unobservable). Section labels are CALLER-PROVIDED via targets[].label and never inferred — the aggregate reports overall plus per-label groups so verse/chorus comparisons rest on the caller\'s own labeling evidence. Targets whose context was captured without include ["automation"]/["voiceParameters"] report status:"not_captured" for those sections instead of fake zeros. Everything is derived/heuristic; musical judgment stays human-only.',
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        targets: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              contextId: {
                type: "string",
                minLength: 1,
                description: "Range context from sv_snapshot_range captured with notes.",
              },
              occurrenceId: {
                type: "string",
                minLength: 1,
                description: "Optional when the context has exactly one occurrence with notes.",
              },
              label: {
                type: "string",
                minLength: 1,
                maxLength: 64,
                description:
                  "Caller-provided section label (e.g. verse/chorus) used for aggregate grouping; never inferred by the service.",
              },
            },
            required: ["contextId"],
          },
          description: "Duplicate contextId+occurrenceId pairs are rejected (they would double-count aggregates).",
        },
        include: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: {
            enum: [
              "register",
              "intervals",
              "rhythm",
              "phrases",
              "parameters",
              "vocalModes",
              "languages",
              "breaths",
            ],
          },
          description: "Defaults to all sections.",
        },
        phraseGapQuarter: {
          type: "number",
          minimum: 0.25,
          maximum: 8,
          default: 1,
          description: "Rest length (in quarters) treated as a phrase boundary.",
        },
        responseMode: {
          enum: ["compact", "standard", "verbose"],
          default: "standard",
          description: "compact returns per-target counts and the aggregate without per-target sections.",
        },
      },
      required: ["targets"],
    },
    outputSchema: { type: "object", additionalProperties: true },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "sv_validate_lyrics_prosody",
    description:
      'Read-only lyric/prosody validator over a range context (include ["notes"]; in-memory only, never touches the host, never generates patches — fixes go through sv_patch_notes / sv_align_lyrics / sv_restructure_notes). Checks: breath (br notes carrying language/phonemes overrides, unusually long breaths), japaneseMora (multiple morae on one note via deterministic mora rules, isolated small kana), englishSyllables (heuristic vowel-group syllable count ~85-90% accurate vs. following "+" continuation notes), languageConsistency (script class vs. languageOverride conflicts), stressAlignment (first-syllable-stress heuristic with NO dictionary vs. meter strong beats — info-level and confidence:"low" only, never an error), and phonemeCoverage (melodic notes with empty phonemes at snapshot time; empty phonemes on br/"-"/"+" are legitimate per the processing-state contract, and the check reports not_captured when the context lacks include ["processing"]). Issues carry kind/severity/confidence/suggestion and are sorted by severity then score-time order. All findings are derived/heuristic, not host facts.',
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        contextId: {
          type: "string",
          minLength: 1,
          description: "Range context from sv_snapshot_range captured with notes.",
        },
        occurrenceId: {
          type: "string",
          minLength: 1,
          description: "Optional when the context has exactly one occurrence with notes.",
        },
        checks: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: {
            enum: [
              "breath",
              "japaneseMora",
              "englishSyllables",
              "languageConsistency",
              "stressAlignment",
              "phonemeCoverage",
            ],
          },
          description: "Defaults to all checks.",
        },
        responseMode: {
          enum: ["compact", "standard", "verbose"],
          default: "standard",
          description:
            "compact returns the summary without the issue list; standard caps issues at 100 with a truncation warning; verbose returns all issues.",
        },
      },
      required: ["contextId"],
    },
    outputSchema: { type: "object", additionalProperties: true },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "sv_quantize_notes",
    description:
      'Side-effect-free quantize planner over a range context (include ["notes"]; in-memory only, never touches the host). Snaps note onsets to a bar-anchored grid ("1/4"|"1/8"|"1/16"|"1/32"|"1/8T"|"1/16T"; the grid re-anchors at every meter change), with strength (0-1 linear interpolation toward the grid), swing (odd grid slots shifted by swing×half-step; straight divisions only — triplet grids reject swing), and optional duration quantization. Deterministic and order-preserving: notes that collide onto one grid slot keep their original onset (QUANTIZE_COLLISION) and onset changes that would introduce overlaps are reverted (OVERLAP_AFTER_QUANTIZE) unless quantizeDurations trims the earlier note — no half-step guessing, and NO humanize (random micro-timing conflicts with the deterministic-planner contract). Breath notes ("br") are quantized like any timed note. Returns one ready-to-submit sv_patch_notes patchRequest with expected onset/duration preconditions; plans above the 200-patch cap return the first 200 plus a continuation block (commit → re-snapshot → re-run with identical options; already-quantized notes come back unchanged so the loop converges to no_change; an explicit occurrenceId is re-anchored only while a short-lived continuation identity proves the same target group UUID).',
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        contextId: {
          type: "string",
          minLength: 1,
          description: "Range context from sv_snapshot_range captured with notes.",
        },
        occurrenceId: {
          type: "string",
          minLength: 1,
          description: "Optional when noteIds imply it or the context has one occurrence with notes.",
        },
        noteIds: {
          type: "array",
          minItems: 1,
          maxItems: 200,
          uniqueItems: true,
          items: { type: "string", minLength: 1 },
          description: "Optional subset; all noteIds must belong to one occurrence.",
        },
        grid: {
          type: "object",
          additionalProperties: false,
          properties: {
            division: { enum: ["1/4", "1/8", "1/16", "1/32", "1/8T", "1/16T"] },
          },
          required: ["division"],
        },
        strength: {
          type: "number",
          exclusiveMinimum: 0,
          maximum: 1,
          default: 1,
          description: "1 snaps fully onto the grid; smaller values interpolate toward it.",
        },
        swing: {
          type: "number",
          minimum: 0,
          maximum: 1,
          default: 0,
          description: "Shifts odd grid slots late by swing×half-step; straight divisions only.",
        },
        quantizeDurations: {
          type: "boolean",
          default: false,
          description: "Also snap durations to whole grid steps and trim overlaps.",
        },
        responseMode: { enum: ["compact", "standard", "verbose"], default: "standard" },
      },
      required: ["contextId", "grid"],
    },
    outputSchema: { type: "object", additionalProperties: true },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "sv_generate_harmony",
    description:
      'Side-effect-free diatonic harmony planner over a range context (in-memory only, never touches the host, never creates tracks or groups — prepare the destination group first, e.g. via sv_clone_track_from_template, then re-snapshot so source and target occurrences share ONE range context). Maps melodic source notes (breaths "br" are skipped) a diatonic third or sixth below/above using an explicit key or Krumhansl-Schmuckler detection (a thin margin warns KEY_AMBIGUOUS with the runner-up; pass harmony.key to lock the mapping). Integer occurrence pitch offsets participate in key/register/voice-crossing calculations in sounding MIDI space; perNote.harmonyPitch and the insert request use target-local MIDI, while perNote.harmonySoundingPitch reports the sounding coordinate. A non-integer occurrence offset returns UNSUPPORTED_PITCH_OFFSET because sv_restructure_notes requires integer MIDI note pitches. Non-diatonic source notes get a nearest-scale-tone semitone-offset approximation flagged needsReview. Register bounds trigger one octave shift, then skip; a shift that would cross the source voice is skipped as VOICE_CROSSING_AVOIDED. lyricsMode "copy" copies source lyrics, "sustain" uses the first melodic lyric then "-" melisma. Existing target notes that match onset, duration, local pitch, and lyrics are skipped as already_applied (convergence basis); overlapping-but-different target notes become TARGET_NOTE_CONFLICT and are NEVER overwritten. Returns one ready-to-submit sv_restructure_notes insert request in the target\'s local coordinates; plans above the 64-operation cap return the first 64 plus a continuation block (commit → re-snapshot → re-run with identical options; already-inserted notes skip as already_applied so the loop converges to no_change). Whether the harmony sounds good is human-only.',
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        contextId: {
          type: "string",
          minLength: 1,
          description: "Range context from sv_snapshot_range capturing BOTH source and target occurrences with notes.",
        },
        sourceOccurrenceId: {
          type: "string",
          minLength: 1,
          description: "Optional when exactly one non-target occurrence has notes.",
        },
        targetOccurrenceId: {
          type: "string",
          minLength: 1,
          description: "Destination occurrence for the harmony inserts; must differ from the source.",
        },
        harmony: {
          type: "object",
          additionalProperties: false,
          properties: {
            interval: { enum: ["third_below", "third_above", "sixth_below", "sixth_above"] },
            key: {
              type: "object",
              additionalProperties: false,
              properties: {
                tonic: {
                  enum: ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"],
                },
                mode: { enum: ["major", "minor"] },
              },
              required: ["tonic", "mode"],
              description: "Optional explicit key (sharps-only spelling); omitted keys use K-S detection.",
            },
          },
          required: ["interval"],
        },
        register: {
          type: "object",
          additionalProperties: false,
          properties: {
            minPitch: { type: "integer", minimum: 0, maximum: 127 },
            maxPitch: { type: "integer", minimum: 0, maximum: 127 },
          },
          required: ["minPitch", "maxPitch"],
          description: "Optional harmony register; out-of-range pitches octave-shift once, then skip.",
        },
        lyricsMode: { enum: ["copy", "sustain"], default: "copy" },
        noteIds: {
          type: "array",
          minItems: 1,
          maxItems: 2000,
          uniqueItems: true,
          items: { type: "string", minLength: 1 },
          description: "Optional source-note subset; all noteIds must belong to the source occurrence.",
        },
        responseMode: { enum: ["compact", "standard", "verbose"], default: "standard" },
      },
      required: ["contextId", "targetOccurrenceId", "harmony"],
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
        target: CURVE_TARGET_SCHEMA,
        parameter: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description:
            "One official built-in Automation typeName or a vocalMode_<Name> exposed by the target group's voice.",
        },
        range: CURVE_RANGE_SCHEMA,
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
        target: CURVE_TARGET_SCHEMA,
        parameter: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description:
            "One official built-in Automation typeName or a vocalMode_<Name> exposed by the target group's voice.",
        },
        mode: { enum: ["replace", "add", "scale"] },
        range: CURVE_RANGE_SCHEMA,
        points: {
          type: "array",
          maxItems: 2000,
          items: CURVE_POINT_SCHEMA,
          description:
            "replace mode only; use blick, a musicalPosition, or a note anchor from the target range context.",
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
      "Atomically edit 1-16 distinct Automation parameters on one note group. Built-in names and observable vocalMode_<Name> values are resolved before any getParameter call; the returned Automation typeName is checked again, aliases report requestedParameter/resolvedParameter, and uniqueness is enforced after resolution. The service then validates all curves, opens one host Undo interval, writes and verifies every curve, and compensates every touched curve in reverse order on failure (verified compensation, not ACID). target.expectedNotes and target.expectedTimeOffsetBlick (emitted by sv_plan_expression) are verified against the live host in preflight so curves are never written at positions the notes or the whole reference have drifted away from. compact/standard/verbose control evidence size. undoLabel is audit-only. timings exposes coordinatorQueueMs and service-internal phases; dispatcherQueueMs is null because MCP SDK waiting before handler entry is not observable. If a client collapses nested range/point types to unknown, read svcopilot://schemas/sv_patch_parameter_curves for the exact validated input schema.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        target: CURVE_TARGET_SCHEMA,
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
              range: CURVE_RANGE_SCHEMA,
              points: {
                type: "array",
                maxItems: 2000,
                items: CURVE_POINT_SCHEMA,
                description:
                  "replace mode only; use blick, a musicalPosition, or a note anchor from the target range context.",
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
    name: "sv_edit_phrase",
    description:
      "Commit note fields, lyrics/language, structural note operations, multiple Automation curves, and observable voice parameters as one phrase transaction. Note/structure edits use a detached NoteGroup plan; curve/voice-only edits use operation-specific live preflight without cloning the full group. Commit journals and applies the verified plan to the original target inside one Undo interval because SynthV does not allow changing an existing reference target. Shared target mutations require allowSharedTargetMutation:true and are scanned at commit; dry-run defers the project-wide scan. Any commit failure restores notes, curves, voice, and target identity with read-back verification. noteId/occurrenceId must come from the same sv_snapshot_range context. If a client collapses nested note, structure, range, or point types to unknown, read svcopilot://schemas/sv_edit_phrase for the exact validated input schema.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        target: {
          type: "object",
          additionalProperties: false,
          properties: {
            contextId: { type: "string", minLength: 1 },
            occurrenceId: { type: "string", minLength: 1 },
            expectedGroupUuid: { type: "string", minLength: 1 },
            allowSharedTargetMutation: { type: "boolean", default: false },
          },
          required: ["contextId", "occurrenceId"],
        },
        notePatches: {
          type: "array",
          maxItems: 200,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              noteId: { type: "string", minLength: 1 },
              expected: { type: "object" },
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
                  attributes: { type: "object", minProperties: 1 },
                },
              },
            },
            required: ["noteId", "set"],
          },
        },
        structureOperations: {
          type: "array",
          maxItems: 100,
          items: {
            discriminator: { propertyName: "op" },
            oneOf: [
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  op: { const: "insert" },
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
                      detuneCents: { type: "number" },
                      attributes: { type: "object" },
                    },
                    required: ["onsetBlick", "durationBlick", "pitch"],
                  },
                },
                required: ["op", "note"],
              },
              {
                type: "object",
                additionalProperties: false,
                properties: { op: { const: "delete" }, noteId: { type: "string", minLength: 1 } },
                required: ["op", "noteId"],
              },
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  op: { const: "split" },
                  noteId: { type: "string", minLength: 1 },
                  atBlick: { type: "integer" },
                  secondLyrics: { type: "string" },
                },
                required: ["op", "noteId", "atBlick"],
              },
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  op: { const: "merge" },
                  noteIds: { type: "array", minItems: 2, items: { type: "string", minLength: 1 } },
                  lyricsJoin: { enum: ["first", "concat"], default: "first" },
                },
                required: ["op", "noteIds"],
              },
            ],
          },
        },
        curves: {
          type: "array",
          maxItems: 16,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              parameter: { type: "string", minLength: 1, maxLength: 200 },
              mode: { enum: ["replace", "add", "scale"] },
              range: CURVE_RANGE_SCHEMA,
              points: { type: "array", maxItems: 2000, items: CURVE_POINT_SCHEMA },
              amount: { type: "number" },
              simplifyThreshold: { type: "number", minimum: 0 },
            },
            required: ["parameter", "mode", "range"],
          },
        },
        voicePatch: {
          type: "object",
          additionalProperties: true,
          properties: {
            paramLoudness: { type: "number", description: "Loudness (dB)." },
            paramTension: { type: "number", description: "Tension." },
            paramBreathiness: { type: "number", description: "Breathiness." },
            paramGender: { type: "number", description: "Gender." },
            paramToneShift: { type: "number", description: "Tone shift." },
            vocalModeParams: {
              type: "object",
              additionalProperties: {
                type: "object",
                additionalProperties: true,
                properties: {
                  pitch: { type: "number", description: "Official range 0-150." },
                  timbre: { type: "number", description: "Official range 0-150." },
                  pronunciation: { type: "number", description: "Official range 0-150." },
                },
              },
              description:
                "Keys are vocal mode names, dynamic per voicebank; discover them via sv_get_voice_profile or the occurrence's voiceParameters in sv_snapshot_range.",
            },
          },
          description:
            "Partial patch of NoteGroupReference getVoice/setVoice state. Static fields are enumerated above; every patched field must still be observable in this occurrence's getVoice result, otherwise UNKNOWN_VOICE_PARAMETER.",
        },
        dryRun: { type: "boolean", default: false },
        atomic: { type: "boolean", default: true },
        waitFor: { enum: ["none", "phonemes", "computedAttributes"], default: "none" },
        timeoutMs: { type: "integer", minimum: 0, maximum: 30000 },
        pollIntervalMs: { type: "integer", minimum: 20, maximum: 2000 },
        responseMode: { enum: ["compact", "standard", "verbose"], default: "standard" },
      },
      required: ["target"],
    },
    outputSchema: { type: "object", additionalProperties: true },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  {
    name: "sv_restructure_notes",
    description:
      "Structural note edits on a snapshot context: insert new notes, delete (with a deep-copy compensation backup), split one note at a group-local blick (second half defaults to the \"-\" extender lyric), and merge consecutive notes. Accepts group/selection contexts from sv_snapshot and range contexts from sv_snapshot_range (range noteIds identify the occurrence; insert-only requests on a multi-occurrence range need occurrenceId, and a shared target NoteGroup requires allowSharedTargetMutation:true after a commit-time project scan). Operations run in caller order with live index resolution, inside undo boundaries. atomic:true restores the journal (clones and durations) in reverse order on failure — verified compensation, not ACID. A successful write invalidates the contextId; re-snapshot before further edits.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        contextId: { type: "string", minLength: 1 },
        occurrenceId: {
          type: "string",
          minLength: 1,
          description:
            "Range contexts only: the occurrence to edit. May be omitted when operation noteIds identify one occurrence or exactly one vocal occurrence exists.",
        },
        allowSharedTargetMutation: {
          type: "boolean",
          default: false,
          description:
            "Range contexts: required true when the target NoteGroup has multiple project occurrences (the edit applies to all of them).",
        },
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
      "Non-blocking audition with verified startup and recovery. autoStop:true schedules a server timer without holding the host coordinator; when it fires, stop/restore is dispatched through the queue and the terminal state reports timer delay, queue delay, host stop time, and playhead overrun. User stops become stopped_by_user. Temporary solo/playhead values are restored only when the user has not changed them. The recovery payload remains the crash-recovery escape hatch. MCP cannot hear audio; a human judges the sound.",
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
        autoStop: {
          type: "boolean",
          default: false,
          description: "For loop:false, stop at the requested endpoint without occupying the host queue while waiting.",
        },
        restore: {
          type: "boolean",
          default: true,
          description: "After an automatic stop, restore temporary solo and saved playhead state.",
        },
        stopToleranceMs: {
          type: "integer",
          minimum: 0,
          maximum: 2000,
          default: 100,
          description: "Report AUDITION_STOP_OVERRUN when playhead overrun exceeds this threshold.",
        },
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
      "Stop an audition and restore its saved playback status (stopped, playing, or looping), playhead, and temporary solo fields. Mixer fields are restored ONLY if they still hold the audition-set value; user changes are left untouched and reported. Success requires every requested value to read back correctly, otherwise restore_failed preserves recovery evidence for retry.",
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
          additionalProperties: false,
          description: "The recovery payload from sv_start_audition (version 1).",
          properties: {
            version: { const: 1 },
            savedPlayheadSeconds: { type: "number", minimum: 0 },
            savedStatus: { enum: ["stopped", "playing", "looping"] },
            mixerChanges: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  trackIndex: { type: "integer", minimum: 0 },
                  field: { const: "solo" },
                  previousValue: { type: "boolean" },
                  setValue: { type: "boolean" },
                },
                required: ["trackIndex", "field", "previousValue", "setValue"],
              },
            },
          },
          required: ["version", "savedPlayheadSeconds", "savedStatus", "mixerChanges"],
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
      "Clone an existing track (Track.clone + Project.addTrack) to create e.g. a harmony track inheriting the template's references and voice settings, inside undo boundaries with read-back verification. This is not an isolated musical-data fork: cloned NoteGroupReference objects do not copy their target NoteGroups, so editing a shared target can also change the template. The response reports sharedTargetGroups/isIsolatedEditableTarget and warns when targets are shared. Hidden singer/database preservation remains host-opaque.",
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
  { name: "sv-copilot", version: INTERFACE_VERSION },
  { capabilities: { tools: {}, resources: {} } }
);

const schemaValidator = new Ajv({ allErrors: true, strict: false, discriminator: true });
const toolArgumentValidators = new Map(
  TOOLS.map((tool) => [tool.name, schemaValidator.compile(tool.inputSchema)])
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
    {
      uri: "svcopilot://guide/music-workflows",
      name: "SV Copilot music workflow guide",
      description:
        "Recipe index for combining the tools into safe musical workflows: what to capture, which planner to call, how to commit, which errors are retryable, and where a human must judge. Read svcopilot://guide/music-workflows/{recipe} for full steps.",
      mimeType: "application/json",
    },
    {
      uri: "svcopilot://schemas/music-workflow",
      name: "SV Copilot music workflow schema index",
      description:
        "Small index of per-tool schemas for composite music tools whose nested fields may be collapsed by MCP clients.",
      mimeType: "application/json",
    },
    {
      uri: "svcopilot://schemas/sv_patch_parameter_curves",
      name: "sv_patch_parameter_curves input schema",
      description: "Exact JSON input schema used to validate sv_patch_parameter_curves.",
      mimeType: "application/json",
    },
    {
      uri: "svcopilot://schemas/sv_edit_phrase",
      name: "sv_edit_phrase input schema",
      description: "Exact JSON input schema used to validate sv_edit_phrase.",
      mimeType: "application/json",
    },
    {
      uri: "svcopilot://schemas/sv_compare_computed_pitch",
      name: "sv_compare_computed_pitch input schema",
      description: "Exact JSON input schema used to validate sv_compare_computed_pitch.",
      mimeType: "application/json",
    },
    {
      uri: "svcopilot://schemas/sv_plan_expression",
      name: "sv_plan_expression input schema",
      description: "Exact JSON input schema used to validate sv_plan_expression.",
      mimeType: "application/json",
    },
    {
      uri: "svcopilot://schemas/sv_align_lyrics",
      name: "sv_align_lyrics input schema",
      description: "Exact JSON input schema used to validate sv_align_lyrics.",
      mimeType: "application/json",
    },
    {
      uri: "svcopilot://schemas/sv_analyze_phrase",
      name: "sv_analyze_phrase input schema",
      description: "Exact JSON input schema used to validate sv_analyze_phrase.",
      mimeType: "application/json",
    },
    {
      uri: "svcopilot://schemas/sv_style_profile",
      name: "sv_style_profile input schema",
      description: "Exact JSON input schema used to validate sv_style_profile.",
      mimeType: "application/json",
    },
    {
      uri: "svcopilot://schemas/sv_validate_lyrics_prosody",
      name: "sv_validate_lyrics_prosody input schema",
      description: "Exact JSON input schema used to validate sv_validate_lyrics_prosody.",
      mimeType: "application/json",
    },
    {
      uri: "svcopilot://schemas/sv_quantize_notes",
      name: "sv_quantize_notes input schema",
      description: "Exact JSON input schema used to validate sv_quantize_notes.",
      mimeType: "application/json",
    },
    {
      uri: "svcopilot://schemas/sv_generate_harmony",
      name: "sv_generate_harmony input schema",
      description: "Exact JSON input schema used to validate sv_generate_harmony.",
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
    {
      uriTemplate: "svcopilot://guide/music-workflows/{recipe}",
      name: "SV Copilot music workflow recipe",
      description:
        "One workflow recipe with full steps, minimal request templates, acceptable and non-retryable states, human gates, and capability-blocked branches.",
      mimeType: "application/json",
    },
    {
      uriTemplate: "svcopilot://schemas/{tool}",
      name: "SV Copilot tool input schema",
      description: "Exact runtime input schema for a supported composite music tool.",
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
        text: serializeResource(request.params.uri, payload),
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;
  const args = normalizeToolArguments(name, request.params.arguments ?? {});
  const argumentValidator = toolArgumentValidators.get(name);
  if (!argumentValidator) return toolError("UNKNOWN_TOOL", name);
  if (!argumentValidator(args)) {
    return toolError("INVALID_ARGUMENTS", formatSchemaErrors(argumentValidator.errors));
  }
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
      case "sv_compare_computed_pitch":
        result = await computedPitchCompareService.compare(args);
        break;
      case "sv_plan_expression":
        result = await expressionPlanService.plan(args);
        break;
      case "sv_align_lyrics":
        result = await lyricAlignService.align(args);
        break;
      case "sv_analyze_phrase":
        result = await phraseAnalysisService.analyze(args);
        break;
      case "sv_style_profile":
        result = await styleProfileService.profile(args);
        break;
      case "sv_validate_lyrics_prosody":
        result = await lyricProsodyService.validate(args);
        break;
      case "sv_quantize_notes":
        result = await quantizePlanService.plan(args);
        break;
      case "sv_generate_harmony":
        result = await harmonyPlanService.plan(args);
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
      case "sv_edit_phrase":
        result = await phraseEditService.edit(args);
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
    }
    return toolResult(result);
  } catch (error) {
    return toolError(
      typeof error?.code === "string" ? error.code : "INTERNAL_ERROR",
      error instanceof Error ? error.message : String(error),
      error?.details
    );
  }
});

function normalizeToolArguments(name, args) {
  if (
    ![
      "sv_get_parameter_curve",
      "sv_patch_parameter_curve",
      "sv_patch_parameter_curves",
      "sv_edit_phrase",
    ].includes(name)
  ) {
    return args;
  }
  return normalizeLegacyRatioPositions(args);
}

// v0.3 曾公开 position:{ratio};严格 schema 改用具名字段后继续接受旧请求。
function normalizeLegacyRatioPositions(value) {
  if (Array.isArray(value)) return value.map(normalizeLegacyRatioPositions);
  if (value === null || typeof value !== "object") return value;
  const normalized = Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, normalizeLegacyRatioPositions(item)])
  );
  const legacyPosition = value.position;
  if (
    legacyPosition !== null &&
    typeof legacyPosition === "object" &&
    !Array.isArray(legacyPosition) &&
    Object.keys(legacyPosition).length === 1 &&
    Number.isFinite(legacyPosition.ratio) &&
    normalized.ratio === undefined
  ) {
    normalized.position = "ratio";
    normalized.ratio = legacyPosition.ratio;
  }
  return normalized;
}

function formatSchemaErrors(errors = []) {
  return errors
    .map((error) => {
      const path = error.instancePath || "$";
      if (error.keyword === "additionalProperties") {
        return `${path}: unknown field ${error.params.additionalProperty}`;
      }
      if (error.keyword === "required") {
        return `${path}: missing required field ${error.params.missingProperty}`;
      }
      return `${path}: ${error.message}`;
    })
    .join("; ");
}

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

function toolError(code, message, details) {
  const result = {
    ok: false,
    status: "failed",
    error: {
      code,
      message,
      ...(details && typeof details === "object" && !Array.isArray(details) ? details : {}),
    },
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
  // 指南：目录页与单 recipe 页共用一个 hostname，用 pathname 区分。
  if (parsed.protocol === "svcopilot:" && parsed.hostname === "guide") {
    const segments = parsed.pathname.replace(/^\//, "").split("/");
    if (segments[0] !== "music-workflows" || segments.length > 2) {
      throw new Error(`Unsupported resource URI: ${uri}`);
    }
    if (segments.length === 1) return musicWorkflowGuideIndex(INTERFACE_VERSION);
    const recipeId = decodeURIComponent(segments[1]);
    const recipe = musicWorkflowGuideRecipe(recipeId, INTERFACE_VERSION);
    if (!recipe) {
      throw new Error(
        `Unknown workflow recipe: ${recipeId}; available: ${musicWorkflowGuideRecipeIds().join(", ")}`
      );
    }
    return recipe;
  }
  if (
    parsed.protocol === "svcopilot:" &&
    parsed.hostname === "schemas" &&
    parsed.pathname === "/music-workflow"
  ) {
    return musicWorkflowSchemaIndex();
  }
  if (parsed.protocol === "svcopilot:" && parsed.hostname === "schemas") {
    const toolName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
    return toolInputSchema(toolName);
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
    interfaceVersion: INTERFACE_VERSION,
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
      rangeCapture: RANGE_CAPTURE_LIMITS,
      rangeRequest: RANGE_REQUEST_LIMITS,
      rangePage: RANGE_PAGE_LIMITS,
      snapshotContextTtlMs: snapshotService.store.ttlMs,
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
        "sv_edit_phrase",
        "sv_compare_computed_pitch",
        "sv_plan_expression",
        "sv_align_lyrics",
        "sv_analyze_phrase",
        "sv_style_profile",
        "sv_validate_lyrics_prosody",
        "sv_quantize_notes",
        "sv_generate_harmony",
      ],
      audition: [
        "sv_start_audition",
        "sv_get_audition",
        "sv_stop_audition",
        "sv_restore_audition",
      ],
      voice: ["sv_get_voice_profile", "sv_clone_track_from_template"],
      typedResultFormat: "typed-v2",
      guide: {
        musicWorkflows: "svcopilot://guide/music-workflows",
        recipeTemplate: "svcopilot://guide/music-workflows/{recipe}",
        recipes: musicWorkflowGuideRecipeIds(),
      },
      schemas: {
        musicWorkflowIndex: "svcopilot://schemas/music-workflow",
        toolTemplate: "svcopilot://schemas/{tool}",
      },
    },
    // context 兼容矩阵：哪些工具接受哪种 contextId。range context 由 sv_snapshot_range 签发。
    contextCompatibility: {
      producers: {
        sv_snapshot: ["selection", "group", "project"],
        sv_snapshot_range: ["range"],
      },
      consumers: {
        sv_set_lyrics: ["selection", "group"],
        sv_patch_notes: ["selection", "group", "range"],
        sv_restructure_notes: ["selection", "group", "range"],
        sv_wait_for_processing: ["selection", "group", "range"],
        sv_get_parameter_curve: ["range", "direct_target"],
        sv_patch_parameter_curve: ["range", "direct_target"],
        sv_patch_parameter_curves: ["range", "direct_target"],
        sv_edit_phrase: ["range"],
        sv_compare_computed_pitch: ["range"],
        sv_plan_expression: ["range"],
        sv_align_lyrics: ["range"],
        sv_analyze_phrase: ["range"],
        sv_style_profile: ["range"],
        sv_validate_lyrics_prosody: ["range"],
        sv_quantize_notes: ["range"],
        sv_generate_harmony: ["range"],
      },
      rangeSharedTargetConfirmation: [
        "sv_patch_notes",
        "sv_restructure_notes",
        "sv_patch_parameter_curve",
        "sv_patch_parameter_curves",
        "sv_edit_phrase",
      ],
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
      audioRendering: {
        status: "capability_blocked",
        reason: "official_script_api_has_no_audio_bytes_or_offline_render_primitive",
        uiAutomationFallback: false,
      },
      automationParameters: {
        builtIn: BUILTIN_AUTOMATION_PARAMETERS,
        caseSensitive: false,
        vocalModes: "dynamic_from_target_voice",
      },
    },
  };
}

function musicWorkflowSchemaIndex() {
  const names = [
    "sv_patch_parameter_curves",
    "sv_edit_phrase",
    "sv_compare_computed_pitch",
    "sv_plan_expression",
    "sv_align_lyrics",
    "sv_analyze_phrase",
    "sv_style_profile",
    "sv_validate_lyrics_prosody",
    "sv_quantize_notes",
    "sv_generate_harmony",
  ];
  return {
    schemaVersion: INTERFACE_VERSION,
    description:
      "Read one per-tool resource to avoid client truncation of a combined schema payload.",
    tools: names.map((name) => ({
      name,
      uri: `svcopilot://schemas/${name}`,
    })),
  };
}

function toolInputSchema(name) {
  const tool = TOOLS.find(
    (candidate) =>
      candidate.name === name &&
      [
        "sv_patch_parameter_curves",
        "sv_edit_phrase",
        "sv_compare_computed_pitch",
        "sv_plan_expression",
        "sv_align_lyrics",
        "sv_analyze_phrase",
        "sv_style_profile",
        "sv_validate_lyrics_prosody",
        "sv_quantize_notes",
        "sv_generate_harmony",
      ].includes(candidate.name)
  );
  if (!tool) throw new Error(`Unsupported workflow schema: ${name}`);
  return {
    schemaVersion: INTERFACE_VERSION,
    tool: tool.name,
    inputSchema: tool.inputSchema,
  };
}

function serializeResource(uri, payload) {
  // 部分 MCP 客户端会截断较大的 resource 文本；schema 与指南使用紧凑 JSON 降低上下文成本。
  return uri.startsWith("svcopilot://schemas/") || uri.startsWith("svcopilot://guide/")
    ? JSON.stringify(payload)
    : JSON.stringify(payload, null, 2);
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
