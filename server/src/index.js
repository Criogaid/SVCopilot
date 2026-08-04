#!/usr/bin/env node
// MCP 入口只负责工具与资源路由；宿主会话、工作流、快照和处理等待各自封装。

import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

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
import { AuditionCompareService } from "./audition-compare.js";
import { AuditionService } from "./audition.js";
import { BakeComputedPitchService } from "./bake-computed-pitch.js";
import { ComputedPitchCompareService } from "./computed-pitch-compare.js";
import { PitchTechniqueAnalysisService } from "./pitch-technique-analysis.js";
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
  MAX_CURVE_OPERATIONS_PER_TRANSACTION,
  ParameterCurveService,
} from "./parameter-curve.js";
import { PITCH_CONTROL_LIMITS } from "./pitch-control.js";
import { PitchControlPatchService } from "./pitch-control-patch.js";
import { PitchCorrectionPlanService } from "./pitch-correction-plan.js";
import { PitchGesturePlanService } from "./pitch-gesture-plan.js";
import { FIT_WORKER_NODE_ENGINE } from "./pitch-techniques/fit-worker.js";
import {
  HOST_INTERPOLATION_MAX_ADAPTIVE_MIDPOINTS,
  HOST_INTERPOLATION_MAX_BASELINE_SAMPLES,
  HOST_INTERPOLATION_MAX_MANDATORY_SAMPLES,
  HOST_INTERPOLATION_POSTCONDITION_VERSION,
} from "./pitch-techniques/host-interpolation.js";
import {
  TECHNIQUE_IR_MODEL_VERSION,
  TECHNIQUE_IR_SCHEMA_VERSION,
  TECHNIQUE_IR_TIME_DOMAIN,
} from "./pitch-techniques/ir.js";
import { MAX_PROCESSING_EXPECTED_NOTES, ProcessingService } from "./processing.js";
import {
  musicWorkflowGuideIndex,
  musicWorkflowGuideRecipe,
  musicWorkflowGuideRecipeIds,
} from "./workflow-guide.js";
import { PhraseEditService } from "./phrase-edit.js";
import { PhraseAnalysisService } from "./phrase-analysis.js";
import { QuantizePlanService } from "./quantize-plan.js";
import { SelectionService } from "./selection.js";
import { VocalContextAnalysisService } from "./vocal-context.js";
import { MAX_PROJECT_PAGE_ITEMS, SnapshotService } from "./snapshot.js";
import { StyleProfileService } from "./style-profile.js";
import { PipeRelay, resolvePipePaths } from "./transport-pipe.js";
import { VoiceProfileService } from "./voice-profile.js";
import { WorkflowExecutor } from "./workflow.js";
import { encodeToolError, encodeToolResult } from "./mcp-result-encoder.js";
import {
  ArtifactStore,
  DEFAULT_ARTIFACT_PAGE_BYTES,
  MAX_ARTIFACT_DIRECT_READ_BYTES,
  MAX_ARTIFACT_PAGE_BYTES,
  MIN_ARTIFACT_PAGE_BYTES,
  artifactReference,
  artifactResourceView,
} from "./artifact-store.js";
import { PlanExecutionLedger } from "./plan-ledger.js";
import { DESCRIBE_OPERATION_TOOL, createCompactFacade } from "./compact-facade.js";
import { dedupeSchema } from "./schema-defs.js";
import { collectDoctorReport, summarizeHostProfiles } from "./doctor.js";
import { loadRuntimeHostProfiles, selectRuntimeHostProfile } from "./runtime-host-profile.js";

// 单一接口版本来源：server info、capabilities、schema 资源和指南资源都引用它，
// 避免升级时漏改其中一处。
const INTERFACE_VERSION = "0.10.0";
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

const bridge = new PipeRelay();
const hostSession = new HostSession(bridge);
const runtimeHostProfiles = loadRuntimeHostProfiles(
  path.resolve(moduleDir, "../../test/fixtures/host-profiles")
);
// ArtifactStore 与 SnapshotStore 分离：artifact 是只读数据，可跨 context 过期后继续读取。
// 使用进程级 session id 让同一 server 实例内的 tool/resource 共享 artifact。
const serverSessionId = `sess_${randomUUID()}`;

const snapshotService = new SnapshotService(hostSession);
const workflowExecutor = new WorkflowExecutor(hostSession);
// Plan 执行 ledger：同一个 planRef 至多 commit 一次（§4.3.1）。挂在 ArtifactStore 上，
// 因为 seal 是"计划开始存在"的唯一时刻，登记放在别处就会漏掉某条封存路径。
const planLedger = new PlanExecutionLedger();
const artifactStore = new ArtifactStore({ planLedger });
const processingService = new ProcessingService(hostSession, snapshotService);
const lyricsService = new LyricsService(hostSession, snapshotService);
const notePatchService = new NotePatchService(hostSession, snapshotService, {
  artifactStore,
  sessionId: serverSessionId,
});
const rangeSnapshotService = new RangeSnapshotService(hostSession, {
  snapshotService,
  artifactStore,
  sessionId: serverSessionId,
});
const parameterCurveService = new ParameterCurveService(hostSession, {
  snapshotService,
  artifactStore,
  sessionId: serverSessionId,
});
const noteStructureService = new NoteStructureService(hostSession, snapshotService, {
  artifactStore,
  sessionId: serverSessionId,
});
const pitchControlPatchService = new PitchControlPatchService(hostSession, snapshotService, {
  artifactStore,
  sessionId: serverSessionId,
});
const bakeComputedPitchService = new BakeComputedPitchService(
  hostSession,
  snapshotService,
  pitchControlPatchService
);
const auditionService = new AuditionService(hostSession);
const auditionCompareService = new AuditionCompareService(auditionService);
const voiceProfileService = new VoiceProfileService(hostSession);
const phraseEditService = new PhraseEditService(hostSession, snapshotService);
// 纯内存分析服务：与 range snapshot 共享同一 SnapshotStore，不访问宿主。
const computedPitchCompareService = new ComputedPitchCompareService({
  store: snapshotService.store,
});
const pitchTechniqueAnalysisService = new PitchTechniqueAnalysisService({
  store: snapshotService.store,
  artifactStore,
  sessionId: serverSessionId,
});
const pitchCorrectionPlanService = new PitchCorrectionPlanService({
  store: snapshotService.store,
  artifactStore,
  sessionId: serverSessionId,
});
const expressionPlanService = new ExpressionPlanService({
  store: snapshotService.store,
  artifactStore,
  sessionId: serverSessionId,
});
const lyricAlignService = new LyricAlignService({
  store: snapshotService.store,
  artifactStore,
  sessionId: serverSessionId,
});
const phraseAnalysisService = new PhraseAnalysisService({ store: snapshotService.store });
const styleProfileService = new StyleProfileService({ store: snapshotService.store });
const lyricProsodyService = new LyricProsodyService({ store: snapshotService.store });
const quantizePlanService = new QuantizePlanService({
  store: snapshotService.store,
  artifactStore,
  sessionId: serverSessionId,
});
const harmonyPlanService = new HarmonyPlanService({
  store: snapshotService.store,
  artifactStore,
  sessionId: serverSessionId,
});
const vocalContextService = new VocalContextAnalysisService({
  store: snapshotService.store,
  artifactStore,
  sessionId: serverSessionId,
});
const pitchGesturePlanService = new PitchGesturePlanService({
  store: snapshotService.store,
  artifactStore,
  sessionId: serverSessionId,
  hostProfileProvider: () => selectProfileForHostStatus(hostSession.getStatus()),
});
const selectionService = new SelectionService(hostSession, { snapshotService });

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
    occurrence: {
      type: "integer",
      minimum: 0,
      description:
        "0-based occurrence ordinal; indexes the full occurrences array. Optional when exactly one occurrence has computed pitch.",
    },
  },
  required: ["contextId"],
};
const CURVE_TARGET_SCHEMA = {
  type: "object",
  additionalProperties: false,
  description:
    "Use either trackIndex+groupIndex, or contextId+occurrence from sv_snapshot_range.",
  properties: {
    trackIndex: { type: "integer", minimum: 0 },
    groupIndex: { type: "integer", minimum: 0 },
    contextId: { type: "string", minLength: 1 },
    occurrence: {
      type: "integer",
      minimum: 0,
      description: "0-based occurrence ordinal indexing the full range-context occurrences array.",
    },
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
        "Optional note-anchor drift guard: full snapshot fingerprints of the notes this curve edit is anchored to. Each entry is compared field-by-field against the live host before any read or write; a moved/edited note fails STALE_CONTEXT with effects none instead of writing curves at the note's old position. sv_plan_expression seals this automatically in its Plan Artifact.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
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
// sv_patch_pitch_controls 的共享子 schema。单位纪律（GOAL §5.4）：position 是 group-local
// 整数 BLICK，pitch 是 group-relative semitone，Curve 点相对 curve anchor，三者字段名都带
// 单位后缀，绝不与 pitchDelta(cents)/Note.detune(cents) 混用。
const PITCH_CONTROL_CURVE_POINT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    timeFromAnchorBlick: {
      type: "integer",
      description: "Point time in integer BLICK relative to the curve anchor position.",
    },
    pitchFromAnchorSemitone: {
      type: "number",
      description: "Point pitch offset in semitones relative to the curve anchor pitch.",
    },
  },
  required: ["timeFromAnchorBlick", "pitchFromAnchorSemitone"],
};
const PITCH_CONTROL_POINT_SPEC_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: { const: "point" },
    positionBlick: {
      type: "integer",
      description: "Anchor position in integer BLICK, group-local (NOT occurrence-absolute).",
    },
    pitchSemitone: {
      type: "number",
      description: "Pitch in semitones, group-relative (NOT cents, NOT occurrence-absolute).",
    },
    generator: { type: "string", minLength: 1, maxLength: 100 },
  },
  required: ["kind", "positionBlick", "pitchSemitone"],
};
const PITCH_CONTROL_CURVE_SPEC_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: { const: "curve" },
    anchorPositionBlick: {
      type: "integer",
      description: "Anchor position in integer BLICK, group-local (NOT occurrence-absolute).",
    },
    anchorPitchSemitone: {
      type: "number",
      description: "Anchor pitch in semitones, group-relative (NOT cents, NOT occurrence-absolute).",
    },
    points: {
      type: "array",
      minItems: 1,
      maxItems: 2000,
      items: PITCH_CONTROL_CURVE_POINT_SCHEMA,
      description: "Ordered points relative to the anchor; times must be strictly increasing.",
    },
    generator: { type: "string", minLength: 1, maxLength: 100 },
  },
  required: ["kind", "anchorPositionBlick", "anchorPitchSemitone", "points"],
};
const PITCH_CONTROL_SPEC_SCHEMA = {
  discriminator: { propertyName: "kind" },
  oneOf: [PITCH_CONTROL_POINT_SPEC_SCHEMA, PITCH_CONTROL_CURVE_SPEC_SCHEMA],
};
const PITCH_CONTROL_SET_SCHEMA = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  description:
    "Fields to change. A point accepts positionBlick/pitchSemitone; a curve accepts anchorPositionBlick/anchorPitchSemitone/points. Cross-kind fields are rejected.",
  properties: {
    positionBlick: { type: "integer" },
    pitchSemitone: { type: "number" },
    anchorPositionBlick: { type: "integer" },
    anchorPitchSemitone: { type: "number" },
    points: {
      type: "array",
      minItems: 1,
      maxItems: 2000,
      items: PITCH_CONTROL_CURVE_POINT_SCHEMA,
    },
  },
};
const NOTE_ANCHOR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    note: {
      type: "integer",
      minimum: 0,
      description: "0-based note index within the NoteGroup (from the snapshot).",
    },
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
  required: ["note", "position"],
};
const NOTE_GAP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    afterNote: { type: "integer", minimum: 0 },
    beforeNote: { type: "integer", minimum: 0 },
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
  required: ["afterNote", "beforeNote", "position"],
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
const DENSE_TABLE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    encoding: { const: "dense-table-v1" },
    schemaVersion: { type: "string", minLength: 1 },
    kind: { type: "string", minLength: 1 },
    columns: {
      type: "array",
      minItems: 1,
      maxItems: 64,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string", minLength: 1 },
          unit: { type: "string" },
          type: { enum: ["integer", "number", "string", "boolean"] },
          encoding: { enum: ["delta", "qint", "identity", "dictionary"] },
          scale: { type: "number", exclusiveMinimum: 0 },
          maxError: { type: "number", minimum: 0 },
          default: {},
          dictionary: {
            type: "array",
            minItems: 1,
            items: { type: "string" },
          },
          nullable: { type: "boolean" },
        },
        required: ["name", "type"],
      },
    },
    points: {
      type: "array",
      maxItems: 2000,
      items: { type: "array", maxItems: 64 },
    },
  },
  required: ["encoding", "schemaVersion", "columns", "points"],
};
const CURVE_POINTS_INPUT_SCHEMA = {
  anyOf: [
    { type: "array", maxItems: 2000, items: CURVE_POINT_SCHEMA },
    DENSE_TABLE_SCHEMA,
  ],
  description:
    "Object points or a schema-described dense-table-v1 envelope whose decoded rows match the point schema.",
};
const HOST_INTERPOLATION_SAMPLE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    blick: {
      type: "integer",
      minimum: Number.MIN_SAFE_INTEGER,
      maximum: Number.MAX_SAFE_INTEGER,
    },
    value: { type: "number" },
  },
  required: ["blick", "value"],
};
const HOST_INTERPOLATION_POSTCONDITION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  description:
    "Sealed host interpolation postcondition emitted by sv_plan_pitch_gesture. It rechecks captured baseline samples before writing and final samples after writing.",
  properties: {
    schemaVersion: { const: HOST_INTERPOLATION_POSTCONDITION_VERSION },
    kind: { const: "host_interpolation" },
    interpolationEvidence: {
      type: "object",
      additionalProperties: false,
      properties: {
        method: { enum: ["linear", "cosine", "cubic"] },
        source: { const: "host_getInterpolationMethod" },
        capturedAtContextId: { type: "string", minLength: 1 },
        resolvedParameter: { type: "string", minLength: 1 },
      },
      required: ["method", "source", "capturedAtContextId", "resolvedParameter"],
    },
    baseline: {
      type: "object",
      additionalProperties: false,
      properties: {
        samples: {
          type: "array",
          minItems: 1,
          maxItems: HOST_INTERPOLATION_MAX_BASELINE_SAMPLES,
          items: HOST_INTERPOLATION_SAMPLE_SCHEMA,
        },
        fingerprint: { type: "string", minLength: 1 },
      },
      required: ["samples", "fingerprint"],
    },
    final: {
      type: "object",
      additionalProperties: false,
      properties: {
        mandatorySamples: {
          type: "array",
          minItems: 2,
          maxItems: HOST_INTERPOLATION_MAX_MANDATORY_SAMPLES,
          items: HOST_INTERPOLATION_SAMPLE_SCHEMA,
        },
        adaptiveMidpoints: {
          type: "array",
          minItems: 1,
          maxItems: HOST_INTERPOLATION_MAX_ADAPTIVE_MIDPOINTS,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              blick: {
                type: "integer",
                minimum: Number.MIN_SAFE_INTEGER,
                maximum: Number.MAX_SAFE_INTEGER,
              },
              value: { type: "number" },
              leftBlick: {
                type: "integer",
                minimum: Number.MIN_SAFE_INTEGER,
                maximum: Number.MAX_SAFE_INTEGER,
              },
              rightBlick: {
                type: "integer",
                minimum: Number.MIN_SAFE_INTEGER,
                maximum: Number.MAX_SAFE_INTEGER,
              },
            },
            required: ["blick", "value", "leftBlick", "rightBlick"],
          },
        },
      },
      required: ["mandatorySamples", "adaptiveMidpoints"],
    },
    maxFitErrorCent: { type: "number", minimum: 0.000001, maximum: 20 },
  },
  required: ["schemaVersion", "kind", "interpolationEvidence", "baseline", "final", "maxFitErrorCent"],
};
// PlanRef 是裸 artifactId 字符串（§4.3）。目标校验完全在服务端按 artifactId 完成：
// kind、实例归属与 sealed targetTool 都不依赖调用方回传任何东西，因此以前那些
// contentHash / resourceUri / firstPageUri 字段既不构成校验，也只是让模型每次
// 交接都多复制一遍。
const PLAN_REF_SCHEMA = {
  type: "string",
  minLength: 1,
  description: "The artifactId string from a planner's apply.planRef.",
};
// 每个 mutation 请求都必须显式说明自己要不要写（§10.6 / §13.4 规则 5）。
//
// 为什么不是 `dryRun` 布尔：布尔有默认值，而"默认值"在写操作上是错的方向——省略
// 它就等于同意写入。旧 schema 的 `dryRun: {default: false}` 让"我忘了填"和"我确实
// 要提交"变成同一个请求。enum 没有默认值，因此 schema 层就能挡住漏填。
const ACTION_SCHEMA = {
  enum: ["dry_run", "commit"],
  description:
    "Required. dry_run validates and reports the planned diff without any host write; commit writes and keeps every live preflight check. There is no default — a write must be asked for explicitly.",
};
const PLAN_EXECUTION_PROPERTIES = {
  planRef: PLAN_REF_SCHEMA,
  action: ACTION_SCHEMA,
  confirmations: {
    type: "object",
    additionalProperties: false,
    properties: {
      allowSharedTargetMutation: { type: "boolean", default: false },
    },
  },
  executionOptions: {
    type: "object",
    additionalProperties: false,
    properties: {
      atomic: { type: "boolean" },
      undoLabel: { type: "string", maxLength: 200 },
      waitFor: { enum: ["none", "phonemes", "computedAttributes", "computedPitch"] },
      timeoutMs: { type: "integer", minimum: 0, maximum: 30000 },
      pollIntervalMs: { type: "integer", minimum: 20, maximum: 2000 },
    },
    description:
      "Optional execution-only overrides. Unsupported options are rejected for the referenced target tool.",
  },
};

// 内部 handler 目录。这些名字不出现在 tools/list 里（facade 是唯一 surface），
// 它们的 inputSchema 通过 sv_describe 按需提供。
//
// 刻意不声明 outputSchema（计划 §13.4 的决策）：
//   - MCP 规范把 outputSchema 当成承诺——客户端 SDK 会据此校验 structuredContent，
//     缺失或不符即报错。因此声明一个 `{type:"object", additionalProperties:true}`
//     等于承诺"是个对象"，既无验证价值，又让「服务器 MUST 符合该 schema」变成空约束。
//   - 声明**严格**的信封 schema 现在也不成立：根信封字段全集（root-envelope.js）里
//     15 个是契约字段，另有 57 个迁移期字段仍在根级。一份如实覆盖当前形状的 schema
//     必须允许 72 个字段，那不是契约，而是把现状抄一遍。
// 因此在 B2 把 legacy 根字段收进 data 之前不声明；届时再为已包信封的 facade 声明
// 严格 schema，并由门禁校验它与 root-envelope/result-status 同源。
export const TOOLS = [
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
    name: "sv_release_artifact",
    description:
      "Release one immutable artifact before its lease expires. The artifact must belong to this MCP server session; repeated release returns released:false.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        artifactId: { type: "string", minLength: 1 },
      },
      required: ["artifactId"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  },
  {
    name: "sv_doctor",
    description:
      "Read-only installation doctor: interface and protocol versions, loaded-vs-staging Lua bridge hashes and declared ops, pipe paths, negotiated capabilities, manifest state, active tool profile, and store counts. Never connects to the host or writes anything; reports detached state honestly instead of guessing.",
    inputSchema: { type: "object", additionalProperties: false, properties: {}, required: [] },
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
  },
  {
    name: "sv_wait_for_processing",
    description:
      'Poll read-only computed data until phonemes, computed attributes, or computed pitch complete and remain stable. Accepts group/selection snapshot contexts and range snapshot contexts. For a range context, provide the 0-based occurrence ordinal; it may be omitted only when exactly one vocal occurrence exists. Multiple candidates return AMBIGUOUS_CONTEXT with ordinal candidates. For computedPitch, omitted startBlick/intervalBlick/frames inherit that occurrence\'s sampling when the range context was captured with include:["computedPitch"]; otherwise all three are required. Explicit values override captured sampling. Computed pitch returns coverage/count/hash evidence by default; set includeValues:true only when raw frames are needed. Phoneme and computed-attribute values remain included by default. Legal empty phonemes do not make processing pending. An explicit all-non-empty quality condition may return phoneme_coverage_unsatisfied while processing state remains ready.',
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        contextId: { type: "string" },
        occurrence: {
          type: "integer",
          minimum: 0,
          description:
            "0-based occurrence ordinal from sv_snapshot_range; optional only when the range contains exactly one vocal occurrence.",
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
        includeValues: {
          type: "boolean",
          description:
            "Include raw observed values. Defaults to false for computed pitch and true for phonemes/computedAttributes.",
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
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  {
    name: "sv_patch_notes",
    description:
      'Patch fields of existing notes identified by 0-based note index within the resolved NoteGroup. Provide occurrence when a range context has multiple vocal occurrences. For range contexts a shared target NoteGroup is scanned project-wide at commit and requires allowSharedTargetMutation:true. Validates everything before writing, produces a plannedDiff (action dry_run returns it without side effects), writes inside undo boundaries, reads every value back, and with atomic:true compensates verified failures by restoring journaled previous values. diagnostics:true adds phase timings and aggregate host method counts without logging musical values. atomicity is "verified_compensation", not ACID: status distinguishes succeeded, rolled_back, rollback_failed, partial, and outcome_unknown.',
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...PLAN_EXECUTION_PROPERTIES,
        contextId: { type: "string", minLength: 1 },
        occurrence: {
          type: "integer",
          minimum: 0,
          description:
            "Range contexts only: 0-based occurrence ordinal indexing the full occurrences array. May be omitted when exactly one vocal occurrence exists.",
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
              note: {
                type: "integer",
                minimum: 0,
                description:
                  "0-based note index within the resolved target NoteGroup, from the snapshot. Provide occurrence when the range context has multiple vocal occurrences.",
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
            required: ["note", "set"],
          },
        },
        action: ACTION_SCHEMA,
        atomic: {
          type: "boolean",
          default: true,
          description:
            "On failure after writes began, restore journaled previous values in reverse order and verify the restoration (compensation, not a database transaction).",
        },
        diagnostics: {
          type: "boolean",
          default: false,
          description:
            "Add phase timings and aggregate host method counts. Does not log arguments or musical values and does not change write/Undo behavior.",
        },
        waitFor: { enum: ["none", "phonemes", "computedAttributes"] },
        timeoutMs: { type: "integer", minimum: 0, maximum: 30000 },
        pollIntervalMs: { type: "integer", minimum: 20, maximum: 2000 },
      },
      oneOf: [
        { required: ["contextId", "patches", "action"] },
        { required: ["planRef", "action"] },
      ],
    },
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
              "pitchControls",
              "attributes",
              "processing",
              "retakes",
            ],
          },
          description:
            "Defaults to notes, tempoMap, meterMap. pitchControls reads Point/Curve with dual coordinates, ownership, and fingerprints (SynthV 2.1+). retakes is capability-blocked and produces an UNSUPPORTED_INCLUDE warning.",
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
            pitchControls: {
              type: "integer",
              minimum: 1,
              maximum: RANGE_PAGE_LIMITS.maximums.pitchControls,
            },
            bytes: { type: "integer", minimum: 8192, maximum: RANGE_PAGE_LIMITS.maximums.bytes },
          },
          description: "Independent per-page data budgets; overflow returns page.nextCursor.",
        },
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
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "sv_compare_computed_pitch",
    description:
      'Objective singing analysis over computed pitch already captured by sv_snapshot_range (include ["notes","computedPitch"]). Pure in-memory read: never touches the host, so before/after states must each be snapshotted first. Each raw frame is mapped through the TimeAxis-calibrated seconds path and resampled linearly only within finite runs to a uniform-seconds grid; null gaps are never bridged. compare_to_target measures one context against note targets (per-note stable-window centerErrorCent, framewise diagnostics, detrended-autocorrelation vibrato rate/depth/regularity, transition overshoot/arrival/settling, anomaly segments). transitions is a bounded {count,returned,truncated,items} summary; metrics.maxTransitions defaults to 20 and can be raised when detail is needed. compare_contexts builds each side\'s own seconds grid and rejects incompatible axes, including tempo-map changes that alter the axis; compatible contexts diff frame-by-frame after minus before with per-note center deltas. Per-note pairing matches notes by score position: after a structural edit (insert/delete/move), notes without an unchanged before-note at the same position are reported unmatched with no before/delta instead of a misleading cross-note comparison. anomalySegments.items are sorted by startBlick (score order) by default — anomalySortBy:"severity" sorts by peak error instead; the response declares sortBy, and top always carries the most severe segment regardless of sorting or truncation. Coverage below analysis.lowCoverageWarnRatio (default 0.5) raises LOW_COMPUTED_PITCH_COVERAGE so small-sample summaries are never mistaken for reliable conclusions. Null frames stay null (unvoiced or processing-incomplete) and never enter statistics. Frame-rate adequacy for vibrato is graded ok/borderline/too_coarse instead of failing. Analysis thresholds are engineering defaults, not host-calibrated; musical quality judgment remains human-only.',
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
        occurrence: {
          type: "integer",
          minimum: 0,
          description:
            "compare_to_target only: 0-based occurrence ordinal; optional with exactly one computed-pitch occurrence.",
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
            maxTransitions: {
              type: "integer",
              minimum: 1,
              maximum: 2000,
              default: 20,
              description:
                "Maximum transition detail items returned by compare_to_target; count always reports the full population.",
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
      },
      required: ["mode"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "sv_analyze_pitch_techniques",
    description:
      'Read-only decomposition of transition, transient, and vibrato candidates from computed pitch already captured by sv_snapshot_range with include ["notes","computedPitch"]. It never opens a host session, setter, Undo record, or control surface: all inputs come from the stored context, are mapped to a uniform-seconds grid without bridging null gaps, and the complete dense reconstruction plus bounded solver traces are sealed in an Artifact. The compact response reports only explainable candidates, confidence as an uncalibrated heuristic, rejected-reason counts, and the Artifact reference. All-null/pending data, low coverage, incomplete sampling provenance, and insufficient sample rate fail with actionable evidence rather than returning invented parameters. A successful empty result has analysisStatus:"no_technique_candidate"; it does not judge musical quality. If a client collapses nested types to unknown, read svcopilot://schemas/sv_analyze_pitch_techniques for the exact validated input schema.',
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        contextId: {
          type: "string",
          minLength: 1,
          description:
            "Range context from sv_snapshot_range captured with include [\"notes\",\"computedPitch\"].",
        },
        occurrence: {
          type: "integer",
          minimum: 0,
          description:
            "Optional 0-based occurrence ordinal; required when the context has multiple usable occurrences.",
        },
        maxCandidates: {
          type: "integer",
          minimum: 1,
          maximum: 32,
          default: 12,
          description:
            "Maximum compact candidate items. Dense candidates, rejected fits, and solver traces remain in the Artifact.",
        },
      },
      required: ["contextId"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "sv_plan_expression",
    description:
      'Dry-run non-pitch expression planner for hairpin automation over a range context captured with include ["notes"]. It writes only loudness, tension, breathiness, voicing, and gender arcs through a sealed sv_patch_parameter_curves PlanRef. Pitch techniques, pitchDelta, and vibratoEnv are intentionally absent: plan transition, transient, or vibrato with sv_plan_pitch_gesture. Intent may derive non-pitch dynamics and color arcs; intent that previously implied pitch technique returns guidance to that planner instead. The planner is pure in-memory, deterministic, never touches the host, and uses expected note fingerprints plus expectedTimeOffsetBlick to make a later apply fail STALE_CONTEXT on drift. Submit action dry_run before commit, then audition the result.',
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        contextId: {
          type: "string",
          minLength: 1,
          description: "Range context from sv_snapshot_range captured with notes.",
        },
        occurrence: {
          type: "integer",
          minimum: 0,
          description:
            "0-based occurrence ordinal within the context. Optional when the context has exactly one occurrence.",
        },
        gestures: {
          type: "array",
          maxItems: 32,
          description:
            "Explicit non-pitch gestures; deterministic assembly, user values win over intent. Notes are referenced by 0-based index within the NoteGroup. One hairpin can cover several dynamics and color parameters over one span.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              type: { const: "hairpin" },
              from: { type: "integer", minimum: 0 },
              to: { type: "integer", minimum: 0 },
              amounts: {
                type: "object",
                additionalProperties: false,
                minProperties: 1,
                description:
                  "Peak delta per parameter in that parameter own unit. One hairpin can drive several non-pitch parameters over the same span.",
                properties: {
                  loudness: { type: "number", minimum: -24, maximum: 24 },
                  tension: { type: "number", minimum: -1, maximum: 1 },
                  breathiness: { type: "number", minimum: -1, maximum: 1 },
                  voicing: { type: "number", minimum: -1, maximum: 1 },
                  gender: { type: "number", minimum: -1, maximum: 1 },
                },
              },
              peak: { type: "number", minimum: 0.05, maximum: 0.95, default: 0.6 },
            },
            required: ["type", "from", "to", "amounts"],
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
            maxAbsLoudnessDeltaDb: { type: "number", minimum: 0.5, maximum: 24, default: 6 },
            maxAbsTensionDelta: { type: "number", minimum: 0.05, maximum: 1, default: 0.5 },
            maxAbsBreathinessDelta: { type: "number", minimum: 0.05, maximum: 1, default: 0.5 },
            maxTotalPoints: { type: "integer", minimum: 16, maximum: 2000, default: 400 },
          },
        },
        sampling: {
          type: "object",
          additionalProperties: false,
          properties: {
            pointsPerQuarter: { type: "integer", minimum: 2, maximum: 32, default: 8 },
          },
        },
      },
      required: ["contextId"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "sv_align_lyrics",
    description:
      'Side-effect-free lyric alignment planner over a range context (include ["notes"]): tokenizes mixed-language lyric text and maps units onto notes without touching the host. Japanese kana use deterministic mora rules (one kana per beat; small kana merge into the previous mora; sokuon/moraic-n/chouon each take one note); English words use a heuristic vowel-group syllable count (~85-90% literature accuracy, only affects inferred "+" continuation notes); an explicit +/- chain is authoritative and is never expanded again. Mandarin/Cantonese map one character per note; kanji readings are unavailable (no G2P) so each kanji is planned as one note flagged needs_review. Exact ASCII "+", "-", and "br", plus an ASCII apostrophe prefix, use the official Synthesizer V Studio 2 special-lyric semantics; similar spellings such as "BR" remain lexical and emit a warning. Tokens and per-note units expose semanticRole/semanticEvidence, and orphan continuations or an uncalibrated standalone apostrophe require human review. Returns per-note planned lyrics/languageOverride plus a unified apply envelope. apply.arguments carries a sealed planRef (the bare artifactId) and apply.expiresAt reports its lease; the executor always resolves identity from the plan\'s bounded immutable capsule, then performs live target/precondition validation. The original snapshot TTL does not change this execution path. Plans above the 200-patch per-call cap return the first 200 plus a continuation block. G2P parity with the host is not guaranteed.',
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        contextId: {
          type: "string",
          minLength: 1,
          description: "Range context from sv_snapshot_range captured with notes.",
        },
        occurrence: {
          type: "integer",
          minimum: 0,
          description:
            "0-based occurrence ordinal indexing the full range-context array; optional when exactly one occurrence has notes.",
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
        startNote: {
          type: "integer",
          minimum: 0,
          description:
            "First note to fill, as a 0-based index within the NoteGroup; defaults to the occurrence's first captured note.",
        },
        setLanguageOverride: {
          type: "boolean",
          default: true,
          description: "Also plan per-note languageOverride values where the token language is known.",
        },
      },
      required: ["contextId", "lyrics"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "sv_analyze_phrase",
    description:
      'Read-only music-theory analysis over a range context (include ["notes"]): duration-weighted pitch-class histogram correlated against all 24 Krumhansl-Kessler key profiles returns RANKED key candidates with Pearson correlations and the margin to the runner-up (relative major/minor ambiguity on short melodies is expected and exposed, not hidden); per-note scale degrees with non-diatonic flags (sharps-only spelling, natural-minor degrees); rest-threshold phrase segmentation with climax/ambitus/rests; register, interval, and rhythm statistics. Four OPT-IN harmonic-context sections extend it: metricalRoles (bar/beat position and downbeat/strong/weak/offbeat weight per note, plus anacrusis detection), chordCandidates (pitch classes aggregated per bar or half-bar weighted by duration AND metric position, matched against triad/seventh templates into a ranked list with root, quality, covered chord tones, ABSENT chord tones, non-chord tones, score, and runner-up gap), cadence (phrase endings ranked heuristically from key candidates, final and penultimate scale degrees, and metric position), and tensionResolution (leading-tone resolution or escape, chromatic resolution, and suspension-like descents, each naming BOTH note indexes plus the actual semitone motion and scale degrees). CRITICAL HONESTY BOUND: only one melodic line is observable, so every harmonic section declares evidenceScope:"melody_only" — chord candidates are pitch sets COMPATIBLE with the melody, never an observation of the real accompaniment, which may differ entirely. Ambiguous windows and phrase endings return multiple ranked candidates and are flagged ambiguous; confidence is a heuristic ranking margin, never a probability. Without meter marks, metricalRoles and chordCandidates report not_captured instead of assuming 4/4. Exact lowercase "br" is the officially documented breath special lyric: its nominal pitch and any orphan +/- or uncalibrated standalone apostrophe are excluded from melodic inference and reported through excludedEvents; valid continuation chains remain melodic. inputNoteCount and melodicNoteCount make every exclusion explicit. Everything is derived/heuristic, never claimed as host fact; musical judgment stays human-only.',
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        contextId: {
          type: "string",
          minLength: 1,
          description: "Range context from sv_snapshot_range captured with notes.",
        },
        occurrence: {
          type: "integer",
          minimum: 0,
          description:
            "0-based occurrence ordinal within the context; indexes the full occurrences array. Optional when exactly one occurrence has notes.",
        },
        include: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: {
            enum: [
              "key",
              "scaleDegrees",
              "phrases",
              "statistics",
              "metricalRoles",
              "chordCandidates",
              "cadence",
              "tensionResolution",
            ],
          },
          description:
            'Defaults to key, scaleDegrees, phrases, statistics. scaleDegrees implies key detection. The harmonic-context sections (metricalRoles, chordCandidates, cadence, tensionResolution) are OPT-IN and every one of them declares evidenceScope:"melody_only".',
        },
        harmonicWindow: {
          enum: ["bar", "half_bar"],
          default: "bar",
          description:
            "chordCandidates only: the span aggregated into one harmonic window. Notes spanning a boundary contribute their overlapping duration to each window.",
        },
        ambiguityThreshold: {
          type: "number",
          minimum: 0,
          maximum: 1,
          default: 0.08,
          description:
            "chordCandidates/cadence only: a runner-up gap below this marks the window or phrase ending ambiguous. It is a ranking margin, not a probability.",
        },
        maxChordCandidates: {
          type: "integer",
          minimum: 2,
          maximum: 12,
          default: 4,
          description:
            "chordCandidates only. The floor is 2 so an ambiguous window can never be reported as a single asserted chord.",
        },
        maxCadenceCandidates: {
          type: "integer",
          minimum: 2,
          maximum: 8,
          default: 3,
          description: "cadence only. The floor is 2 for the same reason as maxChordCandidates.",
        },
        suspensionMinQuarter: {
          type: "number",
          minimum: 0.25,
          maximum: 8,
          default: 1,
          description:
            "tensionResolution only: minimum note length (in quarters) on a strong beat before a stepwise descent is reported as suspension-like.",
        },
        phraseGapQuarter: {
          type: "number",
          minimum: 0.25,
          maximum: 8,
          default: 1,
          description: "Rest length (in quarters) treated as a phrase boundary.",
        },
      },
      required: ["contextId"],
    },
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
              occurrence: {
                type: "integer",
                minimum: 0,
                description:
                  "0-based occurrence ordinal within the context; indexes the full occurrences array. Optional when exactly one occurrence has notes.",
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
          description: "Duplicate contextId+occurrence pairs are rejected (they would double-count aggregates).",
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
      },
      required: ["targets"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "sv_validate_lyrics_prosody",
    description:
      'Read-only lyric/prosody validator over a range context (include ["notes"]; in-memory only, never touches the host, never generates patches — fixes go through sv_patch_notes / sv_align_lyrics / sv_restructure_notes). Checks: breath (official exact "br" notes carrying language/phonemes overrides, unusually long breaths), specialLyricChains (ORPHAN_PLUS, ORPHAN_PHONATION_CONTINUATION, SYLLABLE_CHAIN_GAP/OVERLAP, standalone-apostrophe and suspicious-variant evidence from the shared special-lyric state machine), japaneseMora (multiple morae on one note via deterministic mora rules, isolated small kana), englishSyllables (heuristic vowel-group syllable count ~85-90% accurate vs. following "+" continuation notes), languageConsistency (script class vs. languageOverride conflicts), stressAlignment (first-syllable-stress heuristic with NO dictionary vs. meter strong beats — info-level and confidence:"low" only, never an error), and phonemeCoverage (melodic notes with empty phonemes at snapshot time; empty phonemes on br/"-"/"+" are legitimate per the processing-state contract, and the check reports not_captured when the context lacks include ["processing"]). Issues preserve stable code, note indexes, semanticRole, and gapBlick/overlapBlick evidence and are sorted by severity then score-time order. Musical conclusions remain derived/heuristic; the exact special-lyric roles themselves come from the official V2 manual.',
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        contextId: {
          type: "string",
          minLength: 1,
          description: "Range context from sv_snapshot_range captured with notes.",
        },
        occurrence: {
          type: "integer",
          minimum: 0,
          description:
            "0-based occurrence ordinal within the context; indexes the full occurrences array. Optional when exactly one occurrence has notes.",
        },
        checks: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: {
            enum: [
              "breath",
              "specialLyricChains",
              "japaneseMora",
              "englishSyllables",
              "languageConsistency",
              "stressAlignment",
              "phonemeCoverage",
            ],
          },
          description: "Defaults to all checks.",
        },
      },
      required: ["contextId"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "sv_quantize_notes",
    description:
      'Side-effect-free quantize planner over a range context (include ["notes"]; in-memory only, never touches the host). Snaps note onsets to a bar-anchored grid ("1/4"|"1/8"|"1/16"|"1/32"|"1/8T"|"1/16T"; the grid re-anchors at every meter change), with strength (0-1 linear interpolation toward the grid), swing (odd grid slots shifted by swing×half-step; straight divisions only — triplet grids reject swing), and optional duration quantization. Deterministic and order-preserving: notes that collide onto one grid slot keep their original onset (QUANTIZE_COLLISION) and onset changes that would introduce overlaps are reverted (OVERLAP_AFTER_QUANTIZE) unless quantizeDurations trims the earlier note — no half-step guessing, and NO humanize (random micro-timing conflicts with the deterministic-planner contract). Breath notes ("br") are quantized like any timed note. Returns a unified apply envelope whose arguments contain only planRef + action; the full patch and expected onset/duration preconditions remain sealed server-side. Plans above the 200-patch cap return the first 200 plus a continuation block (commit → re-snapshot → re-run with identical options; already-quantized notes come back unchanged so the loop converges to no_change).',
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        contextId: {
          type: "string",
          minLength: 1,
          description: "Range context from sv_snapshot_range captured with notes.",
        },
        occurrence: {
          type: "integer",
          minimum: 0,
          description:
            "0-based occurrence ordinal indexing the full range-context array; optional when exactly one occurrence has notes.",
        },
        notes: {
          type: "array",
          minItems: 1,
          maxItems: 200,
          uniqueItems: true,
          items: { type: "integer", minimum: 0 },
          description:
            "Optional subset, as 0-based note indexes within the resolved NoteGroup.",
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
      },
      required: ["contextId", "grid"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "sv_generate_harmony",
    description:
      'Side-effect-free diatonic harmony planner over a range context (in-memory only, never touches the host, never creates tracks or groups — prepare the destination group first, e.g. via sv_clone_track_from_template, then re-snapshot so source and target occurrences share ONE range context). Maps melodic source notes (breaths "br" are skipped) using an explicit key or Krumhansl-Schmuckler detection. Existing exact target notes are skipped; overlapping different notes become TARGET_NOTE_CONFLICT and are never overwritten. Returns a unified apply envelope targeting sv_restructure_notes. apply.arguments carries a sealed planRef (the bare artifactId) and apply.expiresAt reports its lease; the executor always resolves identity from the plan\'s bounded immutable capsule, then performs live target/precondition validation. The original snapshot TTL does not change this execution path. Plans above the 64-operation cap return the first 64 plus a continuation block. Whether the harmony sounds good is human-only.',
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        contextId: {
          type: "string",
          minLength: 1,
          description: "Range context from sv_snapshot_range capturing BOTH source and target occurrences with notes.",
        },
        sourceOccurrence: {
          type: "integer",
          minimum: 0,
          description: "Optional when exactly one non-target occurrence has notes.",
        },
        targetOccurrence: {
          type: "integer",
          minimum: 0,
          description: "Destination occurrence for the harmony inserts; must differ from the source.",
        },
        harmony: {
          type: "object",
          additionalProperties: false,
          properties: {
            interval: {
              description:
                "Legacy name (third/sixth below/above) or a generalized {degree,direction,octaveOffset?} object (degrees 1-7 incl. unison, above/below, octave displacement).",
              anyOf: [
                { enum: ["third_below", "third_above", "sixth_below", "sixth_above"] },
                {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    degree: { enum: [1, 2, 3, 4, 5, 6, 7] },
                    direction: { enum: ["above", "below"] },
                    octaveOffset: { type: "integer", minimum: -3, maximum: 3, default: 0 },
                  },
                  required: ["degree", "direction"],
                },
              ],
            },
            key: {
              type: "object",
              additionalProperties: false,
              properties: {
                tonic: {
                  enum: ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"],
                },
                mode: { enum: ["major", "minor"] },
                scale: {
                  enum: [
                    "ionian",
                    "dorian",
                    "phrygian",
                    "lydian",
                    "mixolydian",
                    "aeolian",
                    "locrian",
                    "harmonic_minor",
                    "melodic_minor",
                    "major_pentatonic",
                    "minor_pentatonic",
                    "blues",
                    "whole_tone",
                    "chromatic",
                  ],
                  description:
                    "Optional explicit scale (caller-approved). Defaults to ionian/aeolian from mode; K-S detection never invents an extended scale.",
                },
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
        notes: {
          type: "array",
          minItems: 1,
          maxItems: 2000,
          uniqueItems: true,
          items: { type: "integer", minimum: 0 },
          description:
            "Optional source-note subset, as 0-based indexes within the source NoteGroup.",
        },
      },
      required: ["contextId", "targetOccurrence", "harmony"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "sv_analyze_vocal_context",
    description:
      'One-shot vocal context analysis: composes sv_analyze_phrase, sv_validate_lyrics_prosody, sv_style_profile, and sv_compare_computed_pitch over ONE range context in a single call (in-memory only, never touches the host, makes zero host calls). It adds NO new musical authority — every conclusion belongs to the analyzer named in the section\'s authority field and in provenance.sectionAuthority. Each section independently reports succeeded, not_captured, insufficient_evidence, or failed with a remedy, so one weak section never swallows the rest; only request-level problems (unknown/invalid context, unknown or ambiguous occurrence, bad arguments) fail the whole call. Computed pitch that was not captured points to an executable sv_snapshot_range recapture request; captured but unusable/all-null frames point to sv_wait_for_processing. Neither case is zero error. topFindings preserves prosody note indexes and score time while merging heuristic prosody issues with objective computed-pitch anomaly measurements, sorted by severity then score time. nextSteps names the concrete follow-up tool and arguments. compact (default) returns summaries, the top findings, and next steps; every section also carries details.tool/details.arguments for re-running that analyzer verbatim to get its full lists — there is no cursor to expire because these analyzers are free to re-run. Deterministic: identical context and request produce identical output. Whether the singing sounds good remains human_only.',
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        contextId: {
          type: "string",
          minLength: 1,
          description: "Range context from sv_snapshot_range captured with notes.",
        },
        occurrence: {
          type: "integer",
          minimum: 0,
          description:
            "0-based occurrence ordinal within the context; indexes the full occurrences array. Optional when exactly one occurrence has notes.",
        },
        include: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: { enum: ["phrase", "prosody", "style", "computedPitch"] },
          description:
            'Defaults to all sections. computedPitch needs a context captured with include ["computedPitch"]; prosody phoneme coverage needs include ["processing"]; style parameter statistics need include ["automation"].',
        },
        phraseGapQuarter: {
          type: "number",
          minimum: 0.25,
          maximum: 8,
          default: 1,
          description: "Rest length (in quarters) treated as a phrase boundary.",
        },
        budgets: {
          type: "object",
          additionalProperties: false,
          properties: {
            issues: { type: "integer", minimum: 1, maximum: 500, default: 50 },
            perNote: { type: "integer", minimum: 1, maximum: 2000, default: 100 },
            anomalySegments: { type: "integer", minimum: 1, maximum: 200, default: 20 },
            bytes: { type: "integer", minimum: 8192, maximum: 200000, default: 60000 },
          },
          description:
            "Per-section item caps plus a response byte budget. Exceeding bytes drops per-section item lists (never the summaries, topFindings, or nextSteps) and warns RESPONSE_BUDGET_APPLIED.",
        },
      },
      required: ["contextId"],
    },
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
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "sv_patch_parameter_curves",
    description:
      `Atomically edit 1-${MAX_CURVE_OPERATIONS_PER_TRANSACTION} Automation ranges on one note group. Built-in names and observable vocalMode_<Name> values are resolved before any getParameter call; the returned Automation typeName is checked again and aliases report requestedParameter/resolvedParameter. One parameter may appear more than once only when its resolved group-local ranges are disjoint; overlapping or touching ranges fail before any write. The service validates every range, opens one host Undo interval, writes and verifies every curve, and compensates every touched range in reverse order on failure (verified compensation, not ACID). target.expectedNotes and target.expectedTimeOffsetBlick (emitted by sv_plan_expression) are verified against the live host in preflight so curves are never written at positions the notes or the whole reference have drifted away from. Large successful batches keep aggregate status, verification, Undo, and timings inline while moving per-curve evidence to detailRef. undoLabel is audit-only. timings exposes coordinatorQueueMs and service-internal phases; dispatcherQueueMs is null because MCP SDK waiting before handler entry is not observable. If a client collapses nested range/point types to unknown, read svcopilot://schemas/sv_patch_parameter_curves for the exact validated input schema.`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...PLAN_EXECUTION_PROPERTIES,
        target: CURVE_TARGET_SCHEMA,
        curves: {
          type: "array",
          minItems: 1,
          maxItems: MAX_CURVE_OPERATIONS_PER_TRANSACTION,
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
                ...CURVE_POINTS_INPUT_SCHEMA,
                description:
                  "replace mode only; use blick, a musicalPosition, or a note anchor from the target range context.",
              },
              amount: { type: "number", description: "add/scale mode only." },
              simplifyThreshold: { type: "number", minimum: 0 },
              hostInterpolation: HOST_INTERPOLATION_POSTCONDITION_SCHEMA,
            },
            required: ["parameter", "mode", "range"],
          },
        },
        action: ACTION_SCHEMA,
        atomic: { type: "boolean", default: true },
        undoLabel: {
          type: "string",
          maxLength: 200,
          description: "Audit metadata only; the SynthV Undo API cannot display custom labels.",
        },
      },
      oneOf: [
        { required: ["target", "curves", "action"] },
        { required: ["planRef", "action"] },
      ],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  {
    name: "sv_patch_pitch_controls",
    description:
      "Atomically add, update, or delete PitchControlPoint/PitchControlCurve objects on one note group occurrence (SynthV 2.1+). Every operation resolves its target by expectedFingerprint (never by stale index — the host re-sorts on every add/remove), re-reads the group UUID and the live group fingerprint before writing, opens one host Undo interval, writes in place, then verifies by host read-back (pitch within 1e-4 semitone, BLICK/point-count exact). New objects are tagged with the svcopilot.* ownership namespace; external objects keep their scriptData. On any failure after the first write, every touched control is restored in reverse order with read-back (verified compensation, not ACID). Units are explicit and must not be mixed: position=group-local integer BLICK, pitch=group-relative semitone, curve points relative to the curve anchor — never cents. action dry_run and no_change perform zero host writes and create zero Undo. Requires a range context from sv_snapshot_range include:[\"pitchControls\"]; shared targets need allowSharedTargetMutation:true. If a client collapses the nested operation/kind types to unknown, read svcopilot://schemas/sv_patch_pitch_controls for the exact validated input schema.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...PLAN_EXECUTION_PROPERTIES,
        contextId: { type: "string", minLength: 1 },
        occurrence: {
          type: "integer",
          minimum: 0,
          description:
            "Required: 0-based occurrence ordinal from sv_snapshot_range. PitchControl edits have no single-candidate default because the whole group's controls are rewritten.",
        },
        target: {
          type: "object",
          additionalProperties: false,
          properties: {
            expectedGroupUuid: { type: "string", minLength: 1 },
            expectedPitchControlFingerprint: {
              type: "string",
              minLength: 1,
              description:
                "Whole-group guard from the occurrence's pitchControlGroupFingerprint; any add/remove/reorder/field change since snapshot conflicts before any write.",
            },
            expectedTimeOffsetBlick: {
              type: "integer",
              description: "Optional drift guard: the occurrence timeOffsetBlick at snapshot time.",
            },
            expectedPitchOffsetSemitone: {
              type: "number",
              description: "Optional drift guard: the occurrence pitchOffsetSemitone at snapshot time.",
            },
            expectedNotes: {
              type: "array",
              minItems: 1,
              maxItems: 256,
              description:
                "Optional note-anchor drift guard (emitted by sv_plan_pitch_gesture): full snapshot fingerprints of the notes the gesture curves are anchored to. Each is compared field-by-field against the live host before any write; a moved/edited note fails STALE_CONTEXT with effects none instead of writing curves at the note's old position.",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  note: { type: "integer", minimum: 0 },
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
            allowSharedTargetMutation: { type: "boolean", default: false },
          },
        },
        operations: {
          type: "array",
          minItems: 1,
          maxItems: 32,
          items: {
            discriminator: { propertyName: "op" },
            oneOf: [
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  op: { const: "add" },
                  control: PITCH_CONTROL_SPEC_SCHEMA,
                },
                required: ["op", "control"],
              },
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  op: { const: "update" },
                  controlId: { type: "string", minLength: 1 },
                  expectedFingerprint: {
                    type: "string",
                    minLength: 1,
                    description: "The control's fingerprint from sv_snapshot_range; the write-time identity guard.",
                  },
                  set: PITCH_CONTROL_SET_SCHEMA,
                },
                required: ["op", "controlId", "expectedFingerprint", "set"],
              },
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  op: { const: "delete" },
                  controlId: { type: "string", minLength: 1 },
                  expectedFingerprint: { type: "string", minLength: 1 },
                },
                required: ["op", "controlId", "expectedFingerprint"],
              },
            ],
          },
        },
        action: ACTION_SCHEMA,
        atomic: {
          type: "boolean",
          const: true,
          default: true,
          description: "Only atomic:true is supported; atomic:false is rejected, never silently ignored.",
        },
        waitFor: {
          enum: ["none", "computedPitch"],
          default: "none",
          description: "Post-commit observation only; a failure here never reclassifies a verified write.",
        },
        timeoutMs: { type: "integer", minimum: 0, maximum: 30000 },
        pollIntervalMs: { type: "integer", minimum: 20, maximum: 2000 },
      },
      oneOf: [
        { required: ["contextId", "occurrence", "operations", "action"] },
        { required: ["planRef", "action"] },
      ],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  {
    name: "sv_plan_pitch_correction",
    description:
      'Plan exactly one open-loop pitchDelta correction from a previously committed sv_plan_pitch_gesture PlanRef that retained its correction target. Capture a new matching range with include ["notes","automation","computedPitch"] after the source plan has committed, then provide its contextId. The planner is pure in-memory: it validates the committed source artifact and target identity, maps observed pitch to the sealed uniform-seconds grid without crossing null gaps, solves each finite run independently with a bounded five-diagonal Cholesky system, applies the requested post-solve amplitude clamp, and returns a new sealed sv_patch_parameter_curves PlanRef only when projected RMSE improves. It never iterates, commits, opens Undo, or claims observed improvement; re-snapshot and compare after commit. Short/null runs are reported as insufficient_evidence, and source plans without retainCorrectionTarget:true fail before any write exists. If a client collapses nested types to unknown, read svcopilot://schemas/sv_plan_pitch_correction for the exact validated input schema.',
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["sourcePlanRef", "observedContextId"],
      properties: {
        sourcePlanRef: {
          type: "string",
          pattern: "^a_[A-Za-z0-9_-]+$",
          description:
            "A successfully committed sv_plan_pitch_gesture PlanRef created with retainCorrectionTarget:true.",
        },
        observedContextId: {
          type: "string",
          minLength: 1,
          description:
            "Post-source-plan range context with notes, pitchDelta Automation, and computed pitch for the same target occurrence.",
        },
        evidence: {
          type: "object",
          additionalProperties: false,
          default: {},
          properties: {
            minimumCoverage: { type: "number", minimum: 0, maximum: 1, default: 0.8 },
            minimumRunFrames: { type: "integer", minimum: 1, maximum: 1000, default: 3 },
          },
        },
        regularization: {
          type: "object",
          additionalProperties: false,
          default: {},
          properties: {
            smoothnessLambda: { type: "number", minimum: 0, maximum: 100, default: 0.4 },
            magnitudeMu: { type: "number", minimum: 0.000001, maximum: 100, default: 0.01 },
            maxAbsCorrectionCent: { type: "number", minimum: 0.000001, maximum: 1200, default: 50 },
          },
        },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "sv_plan_pitch_gesture",
    description:
      'Compile explicit pitch techniques into a deterministic Automation replacement plan. Capture the selected range with include ["notes", "automation"] and pitchDelta; either vibrato variant also requires vibratoEnv. transition writes a score-step-cancelling pitchDelta contribution, transient writes a bounded first-peak response, and vibrato selects either an explicit pitchDelta model or a host-envelope scale. The planner never touches the host: it composes captured Automation baseline plus contributions, seals an sv_patch_parameter_curves PlanRef, and includes interpolation read-back postconditions. Exact lowercase "br" and other non-melodic special events are skipped with structured warnings; an all-skipped request returns no_change. vibrato requires confirmed H2 host-profile semantics and otherwise returns HOST_SEMANTIC_UNCONFIRMED before any mutation exists. Submit apply.arguments unchanged with action dry_run first, then commit after human audition. No execution, surface, referenceFrame, or mode field is accepted because this MVP has one fixed write surface and transaction path. If a client collapses nested gesture types to unknown, read svcopilot://schemas/sv_plan_pitch_gesture for the exact validated input schema.',
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["contextId", "occurrence", "gestures"],
      properties: {
        contextId: { type: "string", minLength: 1 },
        occurrence: {
          type: "integer",
          minimum: 0,
          maximum: 9007199254740991,
          description: "0-based occurrence ordinal within the captured range context.",
        },
        gestures: {
          type: "array",
          minItems: 1,
          maxItems: 32,
          items: {
            oneOf: [
              { $ref: "#/$defs/transition" },
              { $ref: "#/$defs/transient" },
              { $ref: "#/$defs/explicitVibrato" },
              { $ref: "#/$defs/hostVibrato" },
            ],
          },
        },
        retainCorrectionTarget: { type: "boolean", default: false },
        constraints: {
          type: "object",
          additionalProperties: false,
          properties: {
            maxAbsPeakSemitone: { type: "number", minimum: 0.000001, maximum: 1.5, default: 1.5 },
            maxTotalPoints: { type: "integer", minimum: 2, maximum: 4000, default: 1200 },
            maxFitErrorCent: { type: "number", minimum: 0.000001, maximum: 20, default: 1 },
          },
        },
      },
      $defs: {
        noteIndex: { type: "integer", minimum: 0, maximum: 9007199254740991 },
        priority: { type: "integer", minimum: -100, maximum: 100, default: 0 },
        width: {
          type: "object",
          additionalProperties: false,
          required: ["seconds"],
          properties: {
            seconds: { type: "number", minimum: 0.000000001, maximum: 2 },
          },
        },
        linearCurve: {
          type: "object",
          additionalProperties: false,
          required: ["family"],
          properties: { family: { const: "linear" } },
        },
        richardsCurve: {
          type: "object",
          additionalProperties: false,
          required: ["family"],
          properties: {
            family: { const: "richards" },
            inflectionRatio: { type: "number", minimum: 0.05, maximum: 0.95, default: 0.5 },
            sharpness: { type: "number", minimum: 1, maximum: 40, default: 6 },
            asymmetryLogB: { type: "number", minimum: -3, maximum: 3, default: 0 },
          },
        },
        transition: {
          type: "object",
          additionalProperties: false,
          required: ["type", "from", "to", "width", "curve"],
          properties: {
            type: { const: "transition" },
            from: { $ref: "#/$defs/noteIndex" },
            to: { $ref: "#/$defs/noteIndex" },
            priority: { $ref: "#/$defs/priority" },
            width: { $ref: "#/$defs/width" },
            curve: {
              oneOf: [
                { $ref: "#/$defs/linearCurve" },
                { $ref: "#/$defs/richardsCurve" },
              ],
            },
          },
        },
        transient: {
          type: "object",
          additionalProperties: false,
          required: ["type", "note", "intent", "peakSemitone", "peakTimeSeconds", "spanSeconds"],
          allOf: [
            {
              if: { properties: { intent: { const: "overshoot" } }, required: ["intent"] },
              then: { properties: { dampingRatio: { default: 0.5422 } } },
            },
            {
              if: { properties: { intent: { const: "preparation" } }, required: ["intent"] },
              then: { properties: { dampingRatio: { default: 0.6681 } } },
            },
            {
              if: { properties: { dampingRatio: { const: 0 } }, required: ["dampingRatio"] },
              then: {
                required: ["tailPolicy"],
                properties: { tailPolicy: { const: "continuous_taper" } },
              },
            },
          ],
          properties: {
            type: { const: "transient" },
            note: { $ref: "#/$defs/noteIndex" },
            intent: { enum: ["overshoot", "preparation"] },
            priority: { $ref: "#/$defs/priority" },
            peakSemitone: { type: "number", minimum: -1.5, maximum: 1.5 },
            peakTimeSeconds: { type: "number", minimum: 0.005, maximum: 0.5 },
            dampingRatio: { type: "number", minimum: 0, maximum: 1 },
            onsetSeconds: { type: "number", minimum: -0.5, maximum: 0.5, default: 0 },
            spanSeconds: { type: "number", minimum: 0.000000001, maximum: 2 },
            tailPolicy: { enum: ["reject", "continuous_taper"], default: "reject" },
          },
        },
        explicitVibrato: {
          type: "object",
          additionalProperties: false,
          required: ["type", "source", "note"],
          properties: {
            type: { const: "vibrato" },
            source: { const: "explicit_pitch_delta" },
            note: { $ref: "#/$defs/noteIndex" },
            priority: { $ref: "#/$defs/priority" },
            startRatio: { type: "number", minimum: 0, maximum: 1, default: 0 },
            endRatio: { type: "number", minimum: 0, maximum: 1, default: 1 },
            rateHz: { type: "number", minimum: 0.5, maximum: 12, default: 5.5 },
            endRateHz: { type: "number", minimum: 0.5, maximum: 12 },
            depthSemitone: { type: "number", minimum: 0.01, maximum: 2, default: 0.3 },
            endDepthSemitone: { type: "number", minimum: 0.01, maximum: 2 },
            centerDriftSemitone: { type: "number", minimum: -1, maximum: 1, default: 0 },
            phaseRad: { type: "number", minimum: -6.283185307179, maximum: 6.283185307179, default: 0 },
            fadeInSeconds: { type: "number", minimum: 0.000000001, maximum: 1, default: 0.3 },
            fadeOutSeconds: { type: "number", minimum: 0.000000001, maximum: 1, default: 0.2 },
          },
        },
        hostVibrato: {
          type: "object",
          additionalProperties: false,
          required: ["type", "source", "note"],
          properties: {
            type: { const: "vibrato" },
            source: { const: "host_envelope" },
            note: { $ref: "#/$defs/noteIndex" },
            priority: { $ref: "#/$defs/priority" },
            startRatio: { type: "number", minimum: 0, maximum: 1, default: 0 },
            endRatio: { type: "number", minimum: 0, maximum: 1, default: 1 },
            envelopeScale: { type: "number", minimum: 0, maximum: 2, default: 1 },
          },
        },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "sv_bake_computed_pitch",
    description:
      "Bake the host's computed pitch into ONE new svcopilot-owned PitchControlCurve on a note group occurrence (SynthV 2.1+). Absolute (sounding) MIDI is converted to group-relative semitones and absolute BLICK to group-local; a bounded Ramer-Douglas-Peucker simplification preserves endpoints and keeps max fit error within toleranceSemitone. All-null, empty, processing-incomplete, or below-threshold coverage writes NOTHING (INSUFFICIENT_COMPUTED_PITCH) — null is never treated as zero pitch. The write itself is delegated to the sv_patch_pitch_controls transaction (one Undo, host read-back, reverse compensation). Strategies: preserve_existing (add only), replace_owned (replace svcopilot-owned controls in range), replace_explicit (replace only caller-confirmed controls). Existing pitchDelta automation is preserved (clearing is not supported in this version and is rejected, never silently ignored). Reports sourceSampling, finiteFrames, nullFrames, coverage, fitError, and the modified range. If a client collapses nested types to unknown, read svcopilot://schemas/sv_bake_computed_pitch for the exact validated input schema.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        contextId: { type: "string", minLength: 1 },
        occurrence: {
          type: "integer",
          minimum: 0,
          description:
            "0-based occurrence ordinal indexing the full range-context array; optional when exactly one vocal occurrence exists.",
        },
        sampling: {
          type: "object",
          additionalProperties: false,
          description: "Optional explicit sampling (startBlick/intervalBlick/frames, absolute BLICK). Omit to inherit the snapshot's captured computed pitch.",
          properties: {
            startBlick: { type: "integer", minimum: 0 },
            intervalBlick: { type: "integer", minimum: 1 },
            frames: { type: "integer", minimum: 1 },
          },
          required: ["startBlick", "intervalBlick", "frames"],
        },
        strategy: {
          enum: ["preserve_existing", "replace_owned", "replace_explicit"],
          default: "preserve_existing",
        },
        explicitTargets: {
          type: "array",
          minItems: 1,
          description: "replace_explicit only: caller-confirmed controls to replace.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              controlId: { type: "string", minLength: 1 },
              expectedFingerprint: { type: "string", minLength: 1 },
            },
            required: ["controlId", "expectedFingerprint"],
          },
        },
        coverageThreshold: { type: "number", minimum: 0.01, maximum: 1, default: 0.8 },
        toleranceSemitone: { type: "number", minimum: 0.001, maximum: 2, default: 0.05 },
        maxPoints: { type: "integer", minimum: 8, maximum: 400 },
        pitchDeltaHandling: {
          enum: ["preserve"],
          default: "preserve",
          description: "Only preserve is supported; clearing pitchDelta requires a cross-type transaction this version does not implement.",
        },
        allowSharedTargetMutation: { type: "boolean", default: false },
        action: ACTION_SCHEMA,
      },
      required: ["contextId", "action"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  {
    name: "sv_edit_phrase",
    description:
      "Commit note fields, lyrics/language, structural note operations, multiple Automation curves, and observable voice parameters as one phrase transaction. Fully captured deterministic dry-runs use targeted live fingerprint checks plus an in-memory structural model without cloning the group; partial captures, host-defined curve simplification, and every commit keep the detached NoteGroup preflight. Commit journals and applies the verified plan to the original target inside one Undo interval because SynthV does not allow changing an existing reference target. Shared target mutations require allowSharedTargetMutation:true and are scanned at commit; dry-run defers the project-wide scan. Any commit failure restores notes, curves, voice, and target identity with read-back verification. Notes are referenced by 0-based group index from the same sv_snapshot_range context. If a client collapses nested note, structure, range, or point types to unknown, read svcopilot://schemas/sv_edit_phrase for the exact validated input schema.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        target: {
          type: "object",
          additionalProperties: false,
          properties: {
            contextId: { type: "string", minLength: 1 },
            occurrence: {
              type: "integer",
              minimum: 0,
              description:
                "Required: 0-based occurrence ordinal. A combined transaction must name its target explicitly.",
            },
            expectedGroupUuid: { type: "string", minLength: 1 },
            allowSharedTargetMutation: { type: "boolean", default: false },
          },
          required: ["contextId", "occurrence"],
        },
        notePatches: {
          type: "array",
          maxItems: 200,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              note: { type: "integer", minimum: 0 },
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
            required: ["note", "set"],
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
                properties: {
                  op: { const: "delete" },
                  noteIndex: { type: "integer", minimum: 0 },
                },
                required: ["op", "noteIndex"],
              },
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  op: { const: "split" },
                  noteIndex: { type: "integer", minimum: 0 },
                  atBlick: { type: "integer" },
                  secondLyrics: { type: "string" },
                },
                required: ["op", "noteIndex", "atBlick"],
              },
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  op: { const: "merge" },
                  notes: { type: "array", minItems: 2, items: { type: "integer", minimum: 0 } },
                  lyricsJoin: { enum: ["first", "concat"], default: "first" },
                },
                required: ["op", "notes"],
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
              points: CURVE_POINTS_INPUT_SCHEMA,
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
        action: ACTION_SCHEMA,
        atomic: { type: "boolean", default: true },
        waitFor: { enum: ["none", "phonemes", "computedAttributes"], default: "none" },
        timeoutMs: { type: "integer", minimum: 0, maximum: 30000 },
        pollIntervalMs: { type: "integer", minimum: 20, maximum: 2000 },
      },
      required: ["target", "action"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  {
    name: "sv_restructure_notes",
    description:
      "Structural note edits on a snapshot context: insert new notes, delete (with a deep-copy compensation backup), split one note at a group-local blick (second half defaults to the \"-\" extender lyric), and merge consecutive notes. Accepts group/selection contexts from sv_snapshot and range contexts from sv_snapshot_range (notes are referenced by 0-based group index, so a multi-occurrence range needs an occurrence ordinal, and a shared target NoteGroup requires allowSharedTargetMutation:true after a commit-time project scan). Operations run in caller order with live index resolution, inside undo boundaries. atomic:true restores the journal (clones and durations) in reverse order on failure — verified compensation, not ACID. A successful write invalidates the contextId; re-snapshot before further edits.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...PLAN_EXECUTION_PROPERTIES,
        contextId: { type: "string", minLength: 1 },
        occurrence: {
          type: "integer",
          minimum: 0,
          description:
            "Range contexts only: 0-based occurrence ordinal indexing the full occurrences array. May be omitted when exactly one vocal occurrence exists.",
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
              noteIndex: {
                type: "integer",
                minimum: 0,
                description: "delete/split: 0-based note index within the NoteGroup.",
              },
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
              notes: {
                type: "array",
                minItems: 2,
                items: { type: "integer", minimum: 0 },
                description: "merge only: consecutive note indexes in group order.",
              },
              lyricsJoin: { enum: ["first", "concat"], description: "merge only; default first." },
            },
            required: ["op"],
          },
        },
        action: ACTION_SCHEMA,
        atomic: { type: "boolean", default: true },
        waitFor: { enum: ["none", "phonemes", "computedAttributes"] },
        timeoutMs: { type: "integer", minimum: 0, maximum: 30000 },
        pollIntervalMs: { type: "integer", minimum: 20, maximum: 2000 },
      },
      oneOf: [
        { required: ["contextId", "operations", "action"] },
        { required: ["planRef", "action"] },
      ],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  {
    name: "sv_start_audition",
    description:
      "Non-blocking audition with verified startup and recovery. autoStop:true schedules a server timer without holding the host coordinator; when it fires, stop/restore is dispatched through the queue and the terminal state reports timer delay, queue delay, host stop time, and playhead overrun. Responses expose data.terminal: false while active and true after the lifecycle has finished. User stops become stopped_by_user. Temporary solo/playhead values are restored only when the user has not changed them. The recovery payload remains the crash-recovery escape hatch. MCP cannot hear audio; a human judges the sound.",
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
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  {
    name: "sv_get_audition",
    description:
      "Read the current playback status and playhead for an audition. Stop polling as soon as data.terminal is true; stopped, restored, restore_failed, and stopped_by_user are terminal states whose remembered result is replayed idempotently.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { auditionId: { type: "string", minLength: 1 } },
      required: ["auditionId"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "sv_stop_audition",
    description:
      "Stop an audition and restore its saved playback status (stopped, playing, or looping), playhead, and temporary solo fields. Mixer fields are restored ONLY if they still hold the audition-set value; user changes are left untouched and reported. Success requires every requested value to read back correctly, otherwise restore_failed preserves recovery evidence for retry. The completed response has data.terminal:true and is replayed idempotently.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { auditionId: { type: "string", minLength: 1 } },
      required: ["auditionId"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  {
    name: "sv_restore_audition",
    description:
      "Restore mixer and playhead state from a recovery payload returned by sv_start_audition. Use after a server crash left solo/mute changes behind. Same skip-if-user-modified semantics as sv_stop_audition. The response is terminal and reports data.terminal:true.",
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
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  {
    name: "sv_set_selection",
    description:
      'Set the editor note selection with a trustworthy result. SynthV has been observed CHANGING selection state while unselectNote() returned false, so this tool never treats a host boolean as evidence: it reads the selection before and after the operation and derives `changed` from that read-back, reporting the raw hostResults alongside and warning HOST_RETURN_DISAGREES_WITH_READBACK when they contradict each other. Operations: "clear" (unselect all notes), "select" (replace the selection), "add" (extend it), "remove" (unselect the listed notes). Target notes either by `notes` (0-based group indexes from a sv_snapshot or sv_snapshot_range context; a multi-occurrence range requires its 0-based occurrence ordinal) or by indexInGroup against the host\'s CURRENT editor group directly. Context references are accepted only when their target NoteGroup UUID matches the current editor group; otherwise CURRENT_GROUP_MISMATCH is returned before any selection mutation. If the group shrank after the snapshot, the call fails NOTE_INDEX_OUT_OF_RANGE instead of quietly selecting a different note. Selection is UI state: this creates no Undo record, because the official API does not make one for it.',
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        operation: {
          enum: ["clear", "select", "add", "remove"],
          description:
            '"clear" takes no targets. "select" replaces the current selection, "add" extends it, "remove" unselects the listed notes.',
        },
        contextId: {
          type: "string",
          minLength: 1,
          description: "Required with notes; the context that issued them.",
        },
        occurrence: {
          type: "integer",
          minimum: 0,
          description:
            "0-based occurrence ordinal for range-context notes. Optional only when the range has one captured occurrence. The host selection always applies to the current editor group.",
        },
        notes: {
          type: "array",
          minItems: 1,
          maxItems: 200,
          items: { type: "integer", minimum: 0 },
          description: "Note ids from the supplied contextId. Mutually exclusive with indexInGroup.",
        },
        indexInGroup: {
          type: "array",
          minItems: 1,
          maxItems: 200,
          items: { type: "integer", minimum: 0 },
          description:
            "0-based note indices in the host's CURRENT editor group, for when no snapshot context is held. Mutually exclusive with notes/contextId.",
        },
      },
      required: ["operation"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "sv_audition_compare",
    description:
      'Organize a non-blocking human A/B audition of two EXISTING versions over the same range — different track solo configurations, e.g. an original take against an edited duplicate track. Returns a comparisonId immediately with data.terminal:false; stop polling once any response reports data.terminal:true. The variants play in sequence with a gap between them. Every variant runs through the same hardened sv_start_audition kernel (verified startup, auto-stop timing, restore-only-if-the-user-has-not-changed-it mixer semantics, per-variant recovery payload), so playback recovery is never reimplemented here. Variant A must fully stop and restore BEFORE variant B starts; restore failure terminates the comparison, and concurrent get/stop/timer transitions share one lifecycle completion. autoRestore is therefore always true. This tool NEVER applies a temporary musical edit for variant B: the official API has no Undo call, so there is no general recovery token after a successful commit, and an un-undoable "audition-only write" would be dishonest. It therefore creates no project-content Undo record; only mixer solo and playhead are touched, and both are restored. MCP cannot hear audio: the response reports playback order and restore evidence only, and perception stays human_only — ask the person which variant they preferred and never state a preference yourself.',
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        fromBlick: { type: "integer", minimum: 0 },
        toBlick: { type: "integer", minimum: 1 },
        variants: {
          type: "array",
          minItems: 2,
          maxItems: 2,
          description: 'Exactly two variants labelled "a" and "b" with different solo configurations.',
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              label: { enum: ["a", "b"] },
              soloTrackIndices: {
                type: "array",
                minItems: 1,
                maxItems: 32,
                items: { type: "integer", minimum: 0 },
                description: "0-based tracks soloed while this variant plays.",
              },
            },
            required: ["label", "soloTrackIndices"],
          },
        },
        order: {
          type: "array",
          minItems: 2,
          maxItems: 8,
          items: { enum: ["a", "b"] },
          description:
            'Explicit playback order, e.g. ["a","b","a","b"]. Mutually exclusive with repeats; must include both labels.',
        },
        repeats: {
          type: "integer",
          minimum: 1,
          maximum: 4,
          default: 1,
          description: 'Number of a-then-b rounds when order is omitted. Mutually exclusive with order.',
        },
        gapMs: {
          type: "integer",
          minimum: 0,
          maximum: 5000,
          default: 400,
          description: "Silence between variants so the listener can reset.",
        },
        estimatedDurationMs: {
          type: "integer",
          minimum: 100,
          maximum: 600000,
          default: 8000,
          description:
            "How long the range takes to play, used only to schedule the switch between variants. The authoritative stop is still the underlying audition's own auto-stop. Compute it from the range's seconds when you know the tempo.",
        },
        autoRestore: {
          const: true,
          default: true,
          description:
            "Must remain true: restoring each variant is the safety invariant that gives A and B one baseline.",
        },
        stopToleranceMs: {
          type: "integer",
          minimum: 0,
          maximum: 2000,
          default: 100,
          description: "Passed through to each variant's audition for overrun reporting.",
        },
      },
      required: ["fromBlick", "toBlick", "variants"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  {
    name: "sv_get_audition_compare",
    description:
      "Read the current state of an A/B comparison, including which variant is playing, the transition history, and the live playback state of the underlying audition. Stop polling when data.terminal is true. Idempotent; once the comparison is restored, restore_failed, or failed it returns the remembered terminal result.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { comparisonId: { type: "string", minLength: 1 } },
      required: ["comparisonId"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "sv_stop_audition_compare",
    description:
      "Stop an A/B comparison early and restore the saved playhead and temporary solo state through the underlying audition kernel. The completed response has data.terminal:true. Idempotent: repeat calls return the same remembered terminal result. Mixer fields the user changed themselves are left alone and reported.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { comparisonId: { type: "string", minLength: 1 } },
      required: ["comparisonId"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
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
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
];

// schema 内部重复的共享片段在启动时一次性提到各自的 $defs。就地替换 inputSchema，
// 使「sv_describe 送出的 schema」与「Ajv 校验用的 schema」始终是同一个对象——若分成
// 两份，模型看到的契约就可能与实际执行的校验不同。
for (const tool of TOOLS) {
  tool.inputSchema = dedupeSchema(tool.inputSchema);
}

// facade 是唯一 MCP surface：direct tool 只作为内部组织单位，不进入 tools/list。
// 没有 profile 选择层——多套 profile 需要维护 N 份「哪些工具可达」的真相，而收益
// 只是元数据体积，facade 已经解决了后者。
const compactFacade = createCompactFacade(TOOLS);
const enabledTools = compactFacade.tools;

const server = new Server(
  { name: "sv-copilot", version: INTERFACE_VERSION },
  { capabilities: { tools: {}, resources: {} } }
);

const schemaValidator = new Ajv({ allErrors: true, strict: false, discriminator: true });
const toolArgumentValidators = new Map(
  TOOLS.map((tool) => [tool.name, schemaValidator.compile(tool.inputSchema)])
);
// facade 信封的校验器与业务 schema 分开：facade 只校验 operation/arguments 外壳，
// 内层 arguments 仍然由上面这份 direct tool validator 校验。
const facadeArgumentValidators = new Map(
  compactFacade.tools.map((tool) => [tool.name, schemaValidator.compile(tool.inputSchema)])
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: enabledTools }));

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
      uri: "svcopilot://operations",
      name: "SV Copilot compact operation catalog",
      description:
        "Facade-to-operation routing: which operation each facade tool accepts and a one-line summary per operation. Call sv_describe for an operation's exact arguments schema.",
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
      uri: "svcopilot://schemas/sv_patch_pitch_controls",
      name: "sv_patch_pitch_controls input schema",
      description: "Exact JSON input schema used to validate sv_patch_pitch_controls.",
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
      uri: "svcopilot://schemas/sv_analyze_pitch_techniques",
      name: "sv_analyze_pitch_techniques input schema",
      description: "Exact JSON input schema used to validate sv_analyze_pitch_techniques.",
      mimeType: "application/json",
    },
    {
      uri: "svcopilot://schemas/sv_plan_expression",
      name: "sv_plan_expression input schema",
      description: "Exact JSON input schema used to validate sv_plan_expression.",
      mimeType: "application/json",
    },
    {
      uri: "svcopilot://schemas/sv_plan_pitch_gesture",
      name: "sv_plan_pitch_gesture input schema",
      description: "Exact JSON input schema used to validate sv_plan_pitch_gesture.",
      mimeType: "application/json",
    },
    {
      uri: "svcopilot://schemas/sv_plan_pitch_correction",
      name: "sv_plan_pitch_correction input schema",
      description: "Exact JSON input schema used to validate sv_plan_pitch_correction.",
      mimeType: "application/json",
    },
    {
      uri: "svcopilot://schemas/sv_bake_computed_pitch",
      name: "sv_bake_computed_pitch input schema",
      description: "Exact JSON input schema used to validate sv_bake_computed_pitch.",
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
    {
      uri: "svcopilot://schemas/sv_analyze_vocal_context",
      name: "sv_analyze_vocal_context input schema",
      description: "Exact JSON input schema used to validate sv_analyze_vocal_context.",
      mimeType: "application/json",
    },
    {
      uri: "svcopilot://artifacts",
      name: "SV Copilot immutable artifact store",
      description:
        "Read-only container for large results and sealed plans. Artifact descriptors provide hash-bound full and paged resource URIs.",
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
    {
      uriTemplate: "svcopilot://artifacts/{artifactId}/{contentHash}",
      name: "SV Copilot artifact",
      description: "Immutable read-only artifact containing a large result or sealed plan.",
      mimeType: "application/json",
    },
    {
      uriTemplate: "svcopilot://artifacts/{artifactId}/{contentHash}/pages/{cursor}",
      name: "SV Copilot artifact page",
      description: "Paginated read-only chunk of an immutable artifact.",
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
  const requestedName = request.params.name;
  // facade 是唯一 surface；direct tool 名不再可调用，否则 tools/list 与实际可达
  // 集合就会分叉，模型也无从知道哪一套名字才算契约。
  if (!compactFacade.isFacadeTool(requestedName)) {
    return toolError(
      "UNKNOWN_TOOL",
      `tool "${requestedName}" is not exposed; call one of ${compactFacade.toolNames.join(", ")}`
    );
  }

  const facadeArguments = request.params.arguments ?? {};
  const facadeValidator = facadeArgumentValidators.get(requestedName);

  // sv_describe 是唯一不套 {operation, arguments} 信封的工具：它直接接受
  // operations 数组，因为 schema discovery 本身不是某个 operation。
  if (requestedName === DESCRIBE_OPERATION_TOOL) {
    if (!facadeValidator(facadeArguments)) {
      return toolError("INVALID_ARGUMENTS", formatSchemaErrors(facadeValidator.errors));
    }
    try {
      return toolResult(compactFacade.describe(facadeArguments.operations));
    } catch (error) {
      return toolError(
        typeof error?.code === "string" ? error.code : "INTERNAL_ERROR",
        error instanceof Error ? error.message : String(error),
        error?.details
      );
    }
  }

  // facade 只做解析：把 facade 调用翻译成内部 handler 名 + arguments 之后，
  // 后续每一步（normalize、Ajv 校验、dispatch）与内部调用共用同一条路径。
  //
  // 先解析 operation，再校验信封。schema 里的 enum 是给模型的可见清单，
  // 但它对 unknown 与 cross-facade 都只报 INVALID_ARGUMENTS，无法告诉模型
  // 「这个 operation 存在，只是在另一个 facade 上」——先解析才能给出可行动的错误。
  // 缺失或非字符串 operation 属于信封本身的问题，交给下面的 schema 校验。
  let entry;
  if (typeof facadeArguments?.operation === "string") {
    try {
      entry = compactFacade.resolveOperation(requestedName, facadeArguments.operation);
    } catch (error) {
      return toolError(
        typeof error?.code === "string" ? error.code : "INTERNAL_ERROR",
        error instanceof Error ? error.message : String(error),
        error?.details
      );
    }
  }
  if (!facadeValidator(facadeArguments)) {
    return toolError("INVALID_ARGUMENTS", formatSchemaErrors(facadeValidator.errors));
  }
  const name = entry.tool;

  const args = normalizeToolArguments(name, facadeArguments.arguments ?? {});
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
      case "sv_doctor":
        result = doctorReport();
        break;
      case "sv_release_artifact":
        result = {
          ok: true,
          status: "succeeded",
          artifactId: args.artifactId,
          released: artifactStore.release({
            artifactId: args.artifactId,
            sessionId: serverSessionId,
          }),
        };
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
      case "sv_analyze_pitch_techniques":
        result = await pitchTechniqueAnalysisService.analyze(args);
        break;
      case "sv_plan_expression":
        result = await expressionPlanService.plan(args);
        break;
      case "sv_plan_pitch_correction":
        result = await pitchCorrectionPlanService.plan(args);
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
      case "sv_analyze_vocal_context":
        result = await vocalContextService.analyze(args);
        break;
      case "sv_set_selection":
        result = await selectionService.setSelection(args);
        break;
      case "sv_audition_compare":
        result = await auditionCompareService.compare(args);
        break;
      case "sv_get_audition_compare":
        result = await auditionCompareService.get(args);
        break;
      case "sv_stop_audition_compare":
        result = await auditionCompareService.stop(args);
        break;
      case "sv_get_parameter_curve":
        result = await parameterCurveService.getCurve(args);
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
      case "sv_patch_pitch_controls":
        result = await pitchControlPatchService.patch(args);
        break;
      case "sv_plan_pitch_gesture":
        result = await pitchGesturePlanService.plan(args);
        break;
      case "sv_bake_computed_pitch":
        result = await bakeComputedPitchService.bake(args);
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
  return encodeToolResult(result);
}

function toolError(code, message, details) {
  return encodeToolError(code, message, details);
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
  if (parsed.protocol === "svcopilot:" && parsed.hostname === "operations") {
    return compactFacade.catalog(INTERFACE_VERSION);
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
  if (parsed.protocol === "svcopilot:" && parsed.hostname === "artifacts") {
    return readArtifactResource(parsed, uri);
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

function readArtifactResource(parsed, uri) {
  const rawPath = parsed.pathname.replace(/^\/+|\/+$/g, "");
  if (!rawPath) {
    // 返回当前 store 元数据摘要，不暴露 payload。
    return {
      schemaVersion: INTERFACE_VERSION,
      sessionId: serverSessionId,
      artifactCount: artifactStore.entries.size,
      totalBytes: artifactStore.totalBytes,
    };
  }
  const segments = rawPath.split("/").map((segment) => decodeURIComponent(segment));
  const [artifactId, contentHash] = segments;
  const isPage = segments.length === 4 && segments[2] === "pages";
  if (
    !artifactId ||
    !contentHash ||
    (!isPage && segments.length !== 2) ||
    (isPage && !segments[3])
  ) {
    throw new Error(`Invalid artifact resource URI: ${uri}`);
  }
  if (isPage) {
    const unknownQueryFields = [...parsed.searchParams.keys()].filter(
      (field) => field !== "byteBudget"
    );
    if (unknownQueryFields.length > 0) {
      throw new Error(`Invalid artifact page query: ${unknownQueryFields.join(", ")}`);
    }
    const byteBudgetText = parsed.searchParams.get("byteBudget");
    const byteBudget =
      byteBudgetText === null ? DEFAULT_ARTIFACT_PAGE_BYTES : Number(byteBudgetText);
    if (
      !Number.isSafeInteger(byteBudget) ||
      byteBudget < MIN_ARTIFACT_PAGE_BYTES ||
      byteBudget > MAX_ARTIFACT_PAGE_BYTES
    ) {
      throw new Error(
        `artifact page byteBudget must be ${MIN_ARTIFACT_PAGE_BYTES}-${MAX_ARTIFACT_PAGE_BYTES}`
      );
    }
    const result = artifactStore.readPage({
      artifactId,
      expectedContentHash: contentHash,
      sessionId: serverSessionId,
      cursor: segments[3],
      byteBudget,
    });
    const reference = artifactReference(result.artifact);
    return {
      artifact: reference,
      page: {
        ...result.page,
        nextPageUri: result.page.cursor
          ? `${reference.resourceUri}/pages/${encodeURIComponent(
              result.page.cursor
            )}?byteBudget=${byteBudget}`
          : null,
      },
    };
  }
  const artifact = artifactStore.resolve({
    artifactId,
    expectedContentHash: contentHash,
    sessionId: serverSessionId,
  });
  return artifactResourceView(artifact);
}

function capabilities() {
  return {
    interfaceVersion: INTERFACE_VERSION,
    connection: hostSession.getStatus(),
    manifest: {
      available: apiManifestAvailable,
      generatedAt: apiManifest.generatedAt,
    },
    pitchTechniques: {
      releaseStatus: "mvp",
      model: {
        schemaVersion: TECHNIQUE_IR_SCHEMA_VERSION,
        modelVersion: TECHNIQUE_IR_MODEL_VERSION,
        timeDomain: TECHNIQUE_IR_TIME_DOMAIN,
      },
      solver: FIT_WORKER_NODE_ENGINE,
      compiler: {
        name: "pitch-delta",
        version: "1",
      },
      operations: {
        plan: "sv_plan_pitch_gesture",
        analyze: "sv_analyze_pitch_techniques",
        correctOnce: "sv_plan_pitch_correction",
        apply: "sv_patch_parameter_curves",
      },
      supportedTechniques: [
        "richards_transition",
        "linear_transition",
        "overshoot",
        "preparation",
        "explicit_pitch_delta_vibrato",
        "host_envelope_vibrato",
      ],
      units: {
        techniqueTime: "seconds",
        vibratoRate: "hertz",
        gesturePitch: "semitone",
        automationPitch: "cent",
        hostTime: "blick",
      },
      writeSurfaces: {
        pitchDelta: "enabled_primary",
        vibratoEnv: "enabled_auxiliary",
        PitchControlCurve: "capability_gated",
      },
      capabilityGates: {
        PitchControlCurve: {
          status: "disabled",
          reason: "H3a_unknown_and_H3b_partially_observed",
        },
        boundedClosedLoop: {
          status: "disabled",
          reason: "safety_gates_not_enabled",
        },
      },
      acceptedHostProfiles: runtimeHostProfiles.map((profile) => ({
        profileId: profile.profileId,
        hostSelector: profile.hostSelector,
      })),
      perception: "human_only",
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
      pitchControl: PITCH_CONTROL_LIMITS,
      snapshotContextTtlMs: snapshotService.store.ttlMs,
      artifacts: {
        ...artifactStore.quotas,
        activeEntries: artifactStore.entries.size,
        activeBytes: artifactStore.totalBytes,
        cursorIntegrity: "hmac-sha256",
        sessionScoped: true,
      },
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
        "sv_patch_parameter_curves",
        "sv_patch_pitch_controls",
        "sv_plan_pitch_correction",
        "sv_plan_pitch_gesture",
        "sv_bake_computed_pitch",
        "sv_edit_phrase",
        "sv_compare_computed_pitch",
        "sv_analyze_pitch_techniques",
        "sv_plan_expression",
        "sv_align_lyrics",
        "sv_analyze_phrase",
        "sv_style_profile",
        "sv_validate_lyrics_prosody",
        "sv_quantize_notes",
        "sv_generate_harmony",
        "sv_analyze_vocal_context",
      ],
      audition: [
        "sv_start_audition",
        "sv_get_audition",
        "sv_stop_audition",
        "sv_restore_audition",
        "sv_audition_compare",
        "sv_get_audition_compare",
        "sv_stop_audition_compare",
      ],
      voice: ["sv_get_voice_profile", "sv_clone_track_from_template"],
      editorState: ["sv_set_selection"],
      artifact: {
        index: "svcopilot://artifacts",
        resourceTemplate: "svcopilot://artifacts/{artifactId}/{contentHash}",
        pageTemplate: "svcopilot://artifacts/{artifactId}/{contentHash}/pages/{cursor}",
        releaseTool: "sv_release_artifact",
        pageBytes: {
          default: DEFAULT_ARTIFACT_PAGE_BYTES,
          minimum: MIN_ARTIFACT_PAGE_BYTES,
          maximum: MAX_ARTIFACT_PAGE_BYTES,
        },
        directReadMaxBytes: MAX_ARTIFACT_DIRECT_READ_BYTES,
      },
      // facade 是唯一 surface，没有 profile 可选：facade 只做 operation 路由，
      // 前置条件、事务语义和失败模型与内部 handler 完全一致。
      surface: {
        facades: compactFacade.toolNames,
        operations: compactFacade.operationCount,
        describeTool: DESCRIBE_OPERATION_TOOL,
        catalog: "svcopilot://operations",
      },
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
        sv_patch_parameter_curves: ["range", "direct_target"],
        sv_patch_pitch_controls: ["range"],
        sv_edit_phrase: ["range"],
        sv_compare_computed_pitch: ["range"],
        sv_analyze_pitch_techniques: ["range"],
        sv_plan_expression: ["range"],
        sv_plan_pitch_correction: ["range"],
        sv_plan_pitch_gesture: ["range"],
        sv_bake_computed_pitch: ["range"],
        sv_align_lyrics: ["range"],
        sv_analyze_phrase: ["range"],
        sv_style_profile: ["range"],
        sv_validate_lyrics_prosody: ["range"],
        sv_quantize_notes: ["range"],
        sv_generate_harmony: ["range"],
        sv_analyze_vocal_context: ["range"],
      },
      rangeSharedTargetConfirmation: [
        "sv_patch_notes",
        "sv_restructure_notes",
        "sv_patch_parameter_curves",
        "sv_patch_pitch_controls",
        "sv_bake_computed_pitch",
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

// Doctor 只读采集：不连接宿主、不写盘，宿主未连接时如实报当前状态。
function doctorReport() {
  const host = hostSession.getStatus();
  const profile = selectProfileForHostStatus(host);
  return collectDoctorReport({
    interfaceVersion: INTERFACE_VERSION,
    moduleDir,
    protoVersion: bridge.proto,
    pipePaths: resolvePipePaths(),
    host,
    manifest: {
      available: apiManifestAvailable,
      generatedAt: apiManifest.generatedAt,
      schemaVersion: apiManifest.schemaVersion ?? null,
    },
    // profile 列表与运行时选择共享目录；不精确匹配时 planner 仍保持 fail-closed。
    surface: {
      facades: compactFacade.toolNames,
      facadeCount: enabledTools.length,
      operationCount: compactFacade.operationCount,
    },
    stores: {
      artifacts: {
        entries: artifactStore.entries.size,
        bytes: artifactStore.totalBytes,
      },
      // accountedBytes 是逻辑驻留字节，不是 V8 heap 实测值；evictions 让配额
      // 生效与否可观测，而不是只能看条数。
      snapshotContexts: snapshotService.store.stats(),
    },
    hostProfiles: summarizeHostProfiles(
      path.resolve(moduleDir, "../../test/fixtures/host-profiles")
    ),
    runtimeHostProfile: summarizeRuntimeHostProfile(profile, host),
  });
}

function selectProfileForHostStatus(host) {
  return selectRuntimeHostProfile(runtimeHostProfiles, {
    ...host,
    platform: process.platform,
  });
}

function summarizeRuntimeHostProfile(profile, host) {
  if (profile) {
    return {
      status: "matched",
      profileId: profile.profileId,
      evidenceSha256: profile.evidenceSha256,
    };
  }
  return {
    status: host.state === "attached" ? "unmatched" : "not_evaluated",
    profileId: null,
    evidenceSha256: null,
  };
}

function musicWorkflowSchemaIndex() {
  const names = [
    "sv_patch_parameter_curves",
    "sv_patch_pitch_controls",
    "sv_plan_pitch_correction",
    "sv_plan_pitch_gesture",
    "sv_bake_computed_pitch",
    "sv_edit_phrase",
    "sv_compare_computed_pitch",
    "sv_analyze_pitch_techniques",
    "sv_plan_expression",
    "sv_align_lyrics",
    "sv_analyze_phrase",
    "sv_style_profile",
    "sv_validate_lyrics_prosody",
    "sv_quantize_notes",
    "sv_generate_harmony",
    "sv_analyze_vocal_context",
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
        "sv_patch_pitch_controls",
        "sv_plan_pitch_correction",
        "sv_plan_pitch_gesture",
        "sv_bake_computed_pitch",
        "sv_edit_phrase",
        "sv_compare_computed_pitch",
        "sv_analyze_pitch_techniques",
        "sv_plan_expression",
        "sv_align_lyrics",
        "sv_analyze_phrase",
        "sv_style_profile",
        "sv_validate_lyrics_prosody",
        "sv_quantize_notes",
        "sv_generate_harmony",
        "sv_analyze_vocal_context",
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
  // resource 与 tool result 一律紧凑编码，避免 pretty-print 抵消 artifact/dense 的传输收益。
  return JSON.stringify(payload);
}

async function main() {
  await bridge.init();
  const paths = resolvePipePaths();
  console.error("[sv-copilot] IO PIPE relay listening");
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

// 只有直接作为主模块启动时才运行 server；作为库导入时不应初始化网络资源。
if (import.meta.filename === path.resolve(process.argv[1] ?? "")) {
  main().catch((error) => {
    console.error("[sv-copilot] fatal:", error);
    process.exit(1);
  });
}
