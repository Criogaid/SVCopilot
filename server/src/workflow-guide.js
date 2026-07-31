// svcopilot://guide/music-workflows —— 面向"只看 MCP 自描述"的 LLM 的工作流指南资源。
//
// 设计边界（P0-B）：
// - 纯静态数据 + 纯函数：不访问宿主、不进 ExecutionCoordinator、不读 SnapshotStore。
//   指南描述"怎么组合工具"，任何具体工程事实仍必须由 sv_snapshot_range 观测。
// - 每个 step 的 arguments 模板必须逐字通过对应工具公布的 inputSchema
//   （test/workflow-guide.test.mjs 用真实服务器 tools/list 的 schema 校验）。
//   因此模板里的 contextId 等占位符使用形如 "ctx_EXAMPLE" 的合法字符串，
//   而不是 "<contextId>" 之类会破坏语义的伪值——它们必须是 schema 合法的示例值。
// - 状态词沿用工具真实返回值：succeeded / no_change / rolled_back / rollback_failed /
//   partial / outcome_unknown / failed，绝不发明新状态。
// - 主观听感一律 human_only；capability-blocked 分支如实指向官方能力缺口。
//
// 分页：整份指南可能超过单条 resource 的舒适体积，因此
// - svcopilot://guide/music-workflows            → 目录 + 全局规则 + recipe 摘要（不含 steps）
// - svcopilot://guide/music-workflows/{recipeId} → 单个 recipe 全文
// 顶层响应体积上限在测试中断言（< 60 KiB，实际远小于此）。

import { facadeForTool, operationNameForTool } from "./operation-catalog.js";

export const GUIDE_VERSION = "2";

const GUIDE_BASE_URI = "svcopilot://guide/music-workflows";

// 占位符常量：既要让模型看懂"这里填你自己的 id"，又要通过 schema 校验。
const EXAMPLE = {
  contextId: "c_EXAMPLE",
  beforeContextId: "c_EXAMPLE_BEFORE",
  afterContextId: "c_EXAMPLE_AFTER",
  occurrenceId: "c_EXAMPLE:t:0:r:0",
  targetOccurrenceId: "c_EXAMPLE:t:1:r:0",
  // 已迁移到 fingerprint 身份的 operation 用组内 index 引用音符（§3.1）。
  noteIndex: 0,
  secondNoteIndex: 1,
  auditionId: "aud_EXAMPLE",
};

// recipe 内部用内部 handler 名书写（`sv_patch_notes`），但模型只能调用 facade。
// 因此每个 (tool, arguments) 模板在序列化时投影成真正可发送的 facade 请求：
// tool 变成 facade 名，arguments 变成 {operation, arguments} 信封。
// 单一来源：投影结果由 OperationCatalog 派生，指南里不手写第二套工具名。
function projectCall(template) {
  if (!template || typeof template.tool !== "string") return template;
  const { tool, arguments: inner, ...rest } = template;
  return {
    ...rest,
    tool: facadeForTool(tool),
    operation: operationNameForTool(tool),
    // 直接可发送的完整 arguments：模型照抄即可，不需要自己拼信封。
    arguments: { operation: operationNameForTool(tool), arguments: inner },
  };
}

function projectStep(step) {
  const projected = projectCall(step);
  if (step?.onInsufficientData) {
    projected.onInsufficientData = projectCall(step.onInsufficientData);
  }
  return projected;
}

function projectRecipe(recipe) {
  return {
    ...recipe,
    ...(recipe.captureTemplate ? { captureTemplate: projectCall(recipe.captureTemplate) } : {}),
    steps: recipe.steps.map(projectStep),
    ...(recipe.recoveryPath ? { recoveryPath: projectCall(recipe.recoveryPath) } : {}),
  };
}

// byNeed 的 tool 字段有的是单个工具名，有的是散文（"sv_describe / sv_search_api"）。
// 只投影能精确解析的那些，其余原样保留而不是猜。
function projectNeed(entry) {
  try {
    return {
      ...entry,
      tool: `${facadeForTool(entry.tool)}(${operationNameForTool(entry.tool)})`,
    };
  } catch {
    return entry;
  }
}

// 全局规则：适用于所有 recipe，不在每个 step 里重复。
const GLOBAL_RULES = {
  identity: [
    "All indices are 0-based. Bars and beats in sv_snapshot_range scope are 1-based.",
    "Note indexes and occurrenceId are only valid inside the contextId that issued them. Never carry them across contexts.",
    "snapshotToken is a content hash, not a host revision. sinceToken still reads the host before answering no_change.",
  ],
  contextLifecycle: [
    "A successful note, structure, lyric, or sv_edit_phrase write DELETES its contextId. Re-run sv_snapshot_range before any further edit or analysis.",
    "A successful sv_patch_parameter_curves write does NOT delete the contextId, but positions may have drifted if a human edited notes; re-snapshot before analysis that must reflect the new state.",
    "Contexts also expire on their own TTL (see limits.snapshotContextTtlMs in svcopilot://capabilities) and on host reconnection (epoch change).",
    "On STALE_CONTEXT or UNKNOWN_CONTEXT: re-run sv_snapshot_range and re-run the planner with the same options. Never retry the old request and never reuse note indexes from the old context.",
  ],
  planHandoff: [
    "Every planner (sv_plan_expression, sv_align_lyrics, sv_quantize_notes, sv_generate_harmony) returns the SAME apply envelope. Read apply.tool, submit apply.arguments verbatim to that tool. You never need to parse planner-specific field names.",
    "apply is null when there is nothing to do (status no_change). That is success, not an error.",
    "Add dryRun:true to apply.arguments for the review pass, then submit the identical arguments to commit.",
    "apply.atomicity is always \"verified_compensation\" — read-back compensation, never ACID.",
    "apply.expectedUserUndoSteps says how many Undo records the human will see. When apply.callCount > 1, submit apply.arguments first and then each apply.additionalCalls entry in callIndex order; they are separate transactions, so a later failure does NOT roll back earlier commits.",
    "apply.preconditions describes what the plan assumed. The target tool re-validates against the live host anyway — a plan is never a token for skipping preflight, because SynthV exposes no project revision.",
    "The older applyRequests / patchRequest / restructureRequest fields still carry the identical payload but are deprecated; prefer apply.",
  ],
  writeSafety: [
    "Always dry-run a write first and read its plannedDiff; then commit the identical arguments with dryRun removed or false.",
    "SHARED_TARGET_REQUIRES_CONFIRMATION means the target NoteGroup is referenced more than once in the project, so the edit changes every occurrence. Report that to the human and only set allowSharedTargetMutation:true on explicit instruction.",
    "atomic:true is verified compensation with read-back, NOT ACID. Read status: succeeded, rolled_back, rollback_failed, partial, or outcome_unknown.",
    "On outcome_unknown the host neither confirmed nor denied the write. Do NOT retry blind: re-snapshot and compare before deciding anything.",
    "Once a write reports effects:\"verified\", a later processing-observation failure is only a warning. Never re-issue the write because of it.",
  ],
  evidence: [
    "observed = read back from the host. derived = computed from observed data. heuristic = an engineering rule that can be wrong. human_only = requires a person.",
    "Analyzer confidence values are heuristic rankings, not probabilities. Ambiguous key/cadence results return multiple candidates; report the ambiguity instead of picking one silently.",
    "computed pitch that is empty or all-null means NOT ENOUGH DATA TO ANALYZE. It is not zero error, and it is not evidence of a host fault.",
    "Host-native booleans may not describe whether state actually changed. Trust read-back and high-level tool verification, never a raw boolean. SynthV has been observed changing the selection while unselectNote() returned false, which is why sv_set_selection derives `changed` from a before/after read-back.",
  ],
  humanGates: [
    "Whether anything sounds good, better, or in tune to the ear is human_only. MCP has no audio input.",
    "Audition tools only organize playback for a person. Never claim an audition sounded correct.",
    "sv_audition_compare plays two EXISTING versions (different track solos) back to back. It cannot apply a temporary edit for variant B, because the official API has no Undo call and such a write could not be taken back. To compare an edit, commit it to a duplicate track first.",
  ],
  capabilityBlocked: [
    "No audio render, export, or audio bytes exist in the official API. Track.setBounced only flags the Render Panel. Ask the human to render in the UI.",
    "No singer/voicebank enumeration, identity read, or assignment exists. Report unobservable; do not infer a singer from names or parameters.",
    "No project revision or change-event stream exists. Poll by re-snapshotting and comparing tokens; never claim event subscription.",
    "No Undo call and no ACID transaction exist. Rollback is compensating writes with read-back only.",
    "Retakes can be generated, activated, and deleted, but take IDs cannot be listed and the active take cannot be read.",
  ],
  errorClasses: {
    reSnapshotAndReplan: [
      "STALE_CONTEXT",
      "UNKNOWN_CONTEXT",
      "CONTEXT_UNAVAILABLE",
      "UNKNOWN_NOTE_ID",
      "UNKNOWN_OCCURRENCE",
      "EXPECTED_MISMATCH",
      "NOTE_STRUCTURE_CHANGED",
    ],
    fixRequestThenRetry: [
      "INVALID_ARGUMENTS",
      "INVALID_CONTEXT",
      "INVALID_RANGE",
      "INVALID_TARGET",
      "UNKNOWN_PARAMETER",
      "UNKNOWN_VOICE_PARAMETER",
      "AMBIGUOUS_CONTEXT",
      "UNSUPPORTED_PITCH_OFFSET",
    ],
    needsHumanDecision: [
      "SHARED_TARGET_REQUIRES_CONFIRMATION",
      "TARGET_NOTE_CONFLICT",
      "NO_MELODIC_NOTES",
    ],
    neverAutoRetry: [
      "POSTCONDITION_FAILED",
      "HOST_TIMEOUT",
      "HOST_DETACHED",
      "HOST_CALL_FAILED",
    ],
    notAnError: [
      "no_change",
      "LOW_COMPUTED_PITCH_COVERAGE",
      "KEY_AMBIGUOUS",
      "PROCESSING_NOT_CAPTURED",
      "AUTOMATION_NOT_CAPTURED",
      "QUANTIZE_COLLISION",
      "OVERLAP_AFTER_QUANTIZE",
    ],
  },
};

// 通用 capture 模板片段：recipe 只声明必要 include，不鼓励"全都要"。
function captureTemplate(include, extra = {}) {
  return {
    tool: "sv_snapshot_range",
    arguments: {
      scope: { kind: "range", from: { bar: 1 }, to: { bar: 9 } },
      include,
      ...extra,
    },
    notes: [
      "Set from/to to the bars you actually need; the end bar is exclusive.",
      "Add trackIndices to limit the read when the project has many tracks.",
      "tempoMap and meterMap are captured by default and are required by the quantize planner.",
      "Follow page.nextCursor until the response stops returning one; cursor reads do not revisit the host.",
    ],
  };
}

const RECIPES = [
  {
    id: "inspect_project",
    title: "See what is in the project before touching anything",
    goal:
      "Get an honest structural picture of tracks, groups, and one concrete musical range without writing anything.",
    requiredCapabilities: [],
    expectedCalls: { min: 2, max: 3 },
    humanGates: [],
    captureTemplate: captureTemplate(["notes", "tempoMap", "meterMap", "mixer"]),
    steps: [
      {
        n: 1,
        tool: "sv_snapshot",
        purpose: "Enumerate tracks and groups to learn how many tracks exist and which hold notes.",
        arguments: { scope: { kind: "project" }, include: ["structure"] },
        acceptable: ["data.snapshotComplete:true"],
        continueWhen:
          "page.nextCursor is present or data.snapshotComplete is false — call again with that cursor. A partial page is NOT the whole project.",
        nonRetryable: ["HOST_DETACHED", "HOST_TIMEOUT"],
      },
      {
        n: 2,
        tool: "sv_snapshot_range",
        purpose:
          "Capture one editable range with occurrence and note identities. This contextId is the entry point for every analyzer and editor.",
        arguments: {
          scope: { kind: "range", from: { bar: 1 }, to: { bar: 9 } },
          include: ["notes", "tempoMap", "meterMap"],
        },
        requiredInclude: ["notes"],
        acceptable: ["status captured", "status no_change (with sinceToken)"],
        nonRetryable: ["INVALID_RANGE (fix bars first)", "HOST_DETACHED"],
      },
    ],
    reportingRules: [
      "Report track/group counts and note counts as observed. Report absent data as not captured, never as zero.",
      "If the human asked about singers or voicebanks, say the official API cannot enumerate them.",
    ],
    capabilityBlockedBranches: [
      "Asked which singer sings a track → unobservable; offer sv_get_voice_profile for observable voice parameters instead.",
      "Asked to render or export audio → capability-blocked; ask the human to render from the UI.",
    ],
  },
  {
    id: "analyze_vocal_phrase",
    title: "Diagnose one vocal phrase objectively",
    goal:
      "Establish key, phrasing, prosody problems, and objective pitch evidence for a phrase before proposing any edit.",
    requiredCapabilities: ["computedPitch"],
    expectedCalls: { min: 2, max: 4 },
    humanGates: [],
    captureTemplate: captureTemplate(
      ["notes", "tempoMap", "meterMap", "computedPitch", "processing", "automation"],
      { computedPitchSampling: { frames: 320 } }
    ),
    steps: [
      {
        n: 1,
        tool: "sv_snapshot_range",
        purpose:
          "One capture serving every analyzer below. computedPitch and processing must be included here — the analyzers are pure in-memory and cannot read the host later.",
        arguments: {
          scope: { kind: "range", from: { bar: 5 }, to: { bar: 9 } },
          include: ["notes", "tempoMap", "meterMap", "computedPitch", "processing"],
          computedPitchSampling: { frames: 320 },
        },
        requiredInclude: ["notes", "computedPitch", "processing"],
        acceptable: ["status captured"],
        nonRetryable: ["INVALID_RANGE"],
      },
      {
        n: 2,
        tool: "sv_analyze_vocal_context",
        purpose:
          "One call returning phrase, prosody, style, and computed-pitch evidence together. Prefer this over calling the four analyzers separately — it is the same analysis cores, fewer calls, and nothing is silently skipped.",
        arguments: { contextId: EXAMPLE.contextId, occurrenceId: EXAMPLE.occurrenceId },
        acceptable: ["succeeded (read summary.evidence for how complete it is)"],
        nonRetryable: [
          "AMBIGUOUS_CONTEXT — pass occurrenceId; do not guess which occurrence was meant",
          "UNKNOWN_CONTEXT / INVALID_CONTEXT — re-snapshot, do not retry",
        ],
        readingRules: [
          "Read summary.sectionStatus first. succeeded / not_captured / insufficient_evidence / failed are per-section: one weak section does NOT invalidate the others.",
          "summary.evidence says how much you actually have: all_requested_sections_analyzed, partial_evidence, or no_section_produced_evidence. Never report the last one as 'no problems found'.",
          "Each section's authority field names the analyzer that owns the conclusion; this tool adds no musical authority of its own.",
          "topFindings merges prosody issues (heuristic) and computed-pitch anomaly segments (objective measurement) — the confidence field distinguishes them. An anomaly is a deviation measurement, not proof the singing is wrong.",
          "nextSteps names the concrete follow-up tool and arguments. Follow it rather than inventing a next call.",
          "For a section's full item list, re-call the tool named in that section's details.tool with details.arguments. There is no cursor to expire.",
        ],
      },
      {
        n: 3,
        tool: "sv_wait_for_processing",
        purpose:
          "Only when the computedPitch section reported not_captured or insufficient_evidence: let the host finish computing, then re-snapshot and re-analyze.",
        arguments: {
          contextId: EXAMPLE.contextId,
          occurrenceId: EXAMPLE.occurrenceId,
          kind: "computedPitch",
        },
        optional: true,
        acceptable: ["ready", "timeout (reports the last observation, never a fake success)"],
        readingRules: [
          "Missing or all-null computed pitch means NOT ENOUGH DATA TO ANALYZE. It is never zero error and never proof of good intonation.",
          "After ready, re-run sv_snapshot_range and sv_analyze_vocal_context; the analyzers cannot read the host themselves.",
        ],
      },
      {
        n: 4,
        tool: "sv_analyze_phrase",
        purpose:
          "Optional drill-down when you need one section's full detail, or the OPT-IN harmonic-context sections that the composite call does not include.",
        arguments: {
          contextId: EXAMPLE.contextId,
          include: [
            "key",
            "scaleDegrees",
            "phrases",
            "statistics",
            "metricalRoles",
            "chordCandidates",
            "cadence",
            "tensionResolution",
          ],
          responseMode: "verbose",
        },
        optional: true,
        acceptable: ["ok"],
        readingRules: [
          "key.candidates is RANKED. When the margin to the runner-up is thin (relative major/minor on short melodies), report both.",
          "Breath notes (lyrics \"br\") are excluded from key/phrase/statistics by design and reported as breathEvents.",
          "metricalRoles, chordCandidates, cadence, and tensionResolution are opt-in and all declare evidenceScope:\"melody_only\": only ONE melodic line was observed, so a chord candidate is a pitch set COMPATIBLE with the melody, never an observation of the real accompaniment. Never state a chord progression as fact from this alone.",
          "Windows and phrase endings flagged ambiguous carry several ranked candidates — report the alternatives, not just the top score. The runner-up gap is a ranking margin, not a probability.",
          "Without meter marks, metricalRoles and chordCandidates report not_captured rather than assuming 4/4.",
          "tensionResolution names BOTH note indexes plus the actual semitone motion; a suspension-like descent is only a melodic contour, since the accompaniment that would make it a real suspension is unobservable.",
        ],
      },
      {
        n: 5,
        tool: "sv_compare_computed_pitch",
        purpose:
          "Optional drill-down for full per-note intonation, vibrato, and transition detail beyond the composite summary.",
        arguments: {
          mode: "compare_to_target",
          contextId: EXAMPLE.contextId,
          occurrenceId: EXAMPLE.occurrenceId,
          responseMode: "verbose",
        },
        optional: true,
        acceptable: ["ok", "insufficient_data"],
        readingRules: [
          "LOW_COMPUTED_PITCH_COVERAGE means the sample is too small to conclude from. Say so.",
          "All-null frames mean not enough data to analyze — never report zero error or perfect intonation.",
          "If processing is still running, call sv_wait_for_processing (kind computedPitch) and RE-SNAPSHOT before comparing again; the comparer cannot read the host.",
        ],
      },
    ],
    reportingRules: [
      "Separate observed (computed pitch frames, note fields) from derived (key correlation) and heuristic (syllable counts, stress).",
      "State clearly when a section is not_captured or insufficient_evidence instead of filling the gap.",
      "Do not propose an edit in the same breath as an ambiguous diagnosis; name the ambiguity first.",
    ],
    capabilityBlockedBranches: [
      "Asked whether it sounds in tune to the ear → human_only; offer objective centerErrorCent evidence plus an audition.",
    ],
  },
  {
    id: "align_and_commit_lyrics",
    title: "Fill lyrics onto existing notes and commit them",
    goal: "Map lyric text onto notes with reviewable per-note confidence, then commit verified.",
    requiredCapabilities: [],
    expectedCalls: { min: 3, max: 5 },
    humanGates: [
      "Kanji readings are unavailable (no G2P): notes flagged needs_review need a human reading or explicit kana.",
    ],
    captureTemplate: captureTemplate(["notes", "tempoMap", "meterMap"]),
    steps: [
      {
        n: 1,
        tool: "sv_snapshot_range",
        purpose: "Capture the notes that will receive lyrics.",
        arguments: {
          scope: { kind: "range", from: { bar: 1 }, to: { bar: 5 } },
          include: ["notes"],
        },
        requiredInclude: ["notes"],
        acceptable: ["status captured"],
      },
      {
        n: 2,
        tool: "sv_align_lyrics",
        purpose:
          "Plan per-note lyrics and languageOverride. Pure in-memory: returns an apply envelope, writes nothing.",
        arguments: {
          contextId: EXAMPLE.contextId,
          lyrics: "ひかり の なか で",
          language: "auto",
        },
        acceptable: ["ok"],
        readingRules: [
          "Read perNote confidence. needs_review entries (kanji, ambiguous scripts) are the human gate.",
          "The response carries apply.tool and apply.arguments — submit those arguments verbatim. apply is null when nothing needs changing.",
          "PLAN_EXCEEDS_PATCH_CAP means only the first 200 patches are in this batch. Follow the continuation loop, do not hand-build batch 2.",
        ],
      },
      {
        n: 3,
        tool: "sv_patch_notes",
        purpose: "Dry-run the planned patch and read plannedDiff before writing.",
        arguments: {
          contextId: EXAMPLE.contextId,
          patches: [
            { note: 0, expected: { lyrics: "" }, set: { lyrics: "ひ" } },
          ],
          dryRun: true,
        },
        note: "In practice pass apply.arguments from step 2 and add dryRun:true.",
        acceptable: ["status dry_run"],
      },
      {
        n: 4,
        tool: "sv_patch_notes",
        purpose: "Commit the identical arguments with dryRun removed.",
        arguments: {
          contextId: EXAMPLE.contextId,
          patches: [
            { note: 0, expected: { lyrics: "" }, set: { lyrics: "ひ" } },
          ],
          atomic: true,
        },
        acceptable: ["succeeded", "no_change"],
        needsHumanDecision: ["SHARED_TARGET_REQUIRES_CONFIRMATION"],
        nonRetryable: [
          "outcome_unknown — re-snapshot and compare, never re-issue",
          "rollback_failed — report the recorded evidence to the human",
        ],
        afterSuccess:
          "This contextId is now deleted. Re-run sv_snapshot_range for any further step, including the continuation loop.",
      },
      {
        n: 5,
        tool: "sv_align_lyrics",
        purpose:
          "Continuation only: after committing a capped batch, re-snapshot and re-run with IDENTICAL arguments. Already-applied notes come back unchanged, so the loop converges to no_change.",
        arguments: {
          contextId: EXAMPLE.afterContextId,
          lyrics: "ひかり の なか で",
          language: "auto",
        },
        acceptable: ["ok", "no_change (loop finished)"],
        optional: true,
      },
    ],
    reportingRules: [
      "Report which notes were planned heuristically (English syllable counts) versus deterministically (kana morae).",
      "Never claim phoneme parity with the host; G2P parity is not guaranteed.",
    ],
    capabilityBlockedBranches: [
      "Asked for kanji readings → no G2P in the official API; ask the human for kana or accept needs_review flags.",
    ],
  },
  {
    id: "plan_and_commit_expression",
    title: "Plan an expression edit and commit it as Automation curves",
    goal:
      "Turn a musical intention into reviewable, unit-explicit Automation curves and commit them in one Undo.",
    requiredCapabilities: ["automation"],
    expectedCalls: { min: 4, max: 6 },
    humanGates: ["Whether the expression sounds right is human_only — end with an audition."],
    captureTemplate: captureTemplate(["notes", "tempoMap", "meterMap", "automation"]),
    steps: [
      {
        n: 1,
        tool: "sv_snapshot_range",
        purpose: "Capture notes (required) and existing automation (recommended, to see what is already there).",
        arguments: {
          scope: { kind: "range", from: { bar: 9 }, to: { bar: 13 } },
          include: ["notes", "automation"],
        },
        requiredInclude: ["notes"],
        acceptable: ["status captured"],
      },
      {
        n: 2,
        tool: "sv_plan_expression",
        purpose:
          "Compile explicit gestures and/or a heuristic intent into an apply envelope. Pure in-memory; writes nothing.",
        arguments: {
          contextId: EXAMPLE.contextId,
          gestures: [
            { type: "scoop", targets: [[EXAMPLE.noteIndex, 40]], lengthQuarter: 0.2 },
            {
              type: "hairpin",
              from: EXAMPLE.noteIndex,
              to: EXAMPLE.secondNoteIndex,
              amounts: { loudness: 3 },
            },
          ],
        },
        acceptable: ["ok"],
        readingRules: [
          "Units are explicit and must not be mixed: pitchDelta=cents, loudness=dB, tension/breathiness=±1, vibratoEnv=0..2 multiplier.",
          "intent.preset expands into reviewable fields via presetExpansion — show that expansion, never treat it as an opaque button.",
          "apply.arguments.target carries expectedNotes and expectedTimeOffsetBlick drift guards. Submit them; do not strip them.",
          "Intent-derived gestures never anchor on breath notes. Explicit gestures may, deliberately.",
          "Natural vibrato presence is host-unobservable, so a pitchDelta vibrato may stack with it.",
        ],
      },
      {
        n: 3,
        tool: "sv_patch_parameter_curves",
        purpose: "Dry-run the planned curves; read the diff summary before writing.",
        arguments: {
          target: { contextId: EXAMPLE.contextId, occurrenceId: EXAMPLE.occurrenceId },
          curves: [
            {
              parameter: "pitchDelta",
              mode: "replace",
              range: { from: { anchor: { note: EXAMPLE.noteIndex, position: "onset" } }, to: { anchor: { note: EXAMPLE.noteIndex, position: "center" } } },
              points: [
                { anchor: { note: EXAMPLE.noteIndex, position: "onset" }, value: -40 },
                { anchor: { note: EXAMPLE.noteIndex, position: "center" }, value: 0 },
              ],
            },
          ],
          dryRun: true,
        },
        note: "In practice submit apply.arguments from step 2 verbatim plus dryRun:true, then each apply.additionalCalls entry in order when apply.callCount > 1.",
        acceptable: ["status dry_run"],
      },
      {
        n: 4,
        tool: "sv_patch_parameter_curves",
        purpose: "Commit the identical arguments with dryRun removed. One Undo interval for all curves.",
        arguments: {
          target: { contextId: EXAMPLE.contextId, occurrenceId: EXAMPLE.occurrenceId },
          curves: [
            {
              parameter: "loudness",
              mode: "add",
              range: { fromBlick: 0, toBlick: 705600000, coordinate: "local" },
              amount: 1.5,
            },
          ],
          atomic: true,
        },
        acceptable: ["succeeded", "no_change"],
        needsHumanDecision: ["SHARED_TARGET_REQUIRES_CONFIRMATION"],
        nonRetryable: [
          "STALE_CONTEXT — a note or the reference moved after the snapshot; re-snapshot and RE-PLAN, do not resubmit",
          "outcome_unknown — re-snapshot and compare before any further action",
        ],
        afterSuccess:
          "Curve writes do NOT delete the contextId, but re-snapshot before analysis that must reflect the new curves.",
      },
    ],
    nextRecipes: ["verify_after_edit", "audition_for_human"],
    reportingRules: [
      "Say which values came from explicit user gestures and which from heuristic intent mapping.",
      "replace mode overwrites existing points in range and the planner does not check for them — warn the human when replacing.",
      "Never claim the result sounds better; report the planned curve shape and offer an audition.",
    ],
    capabilityBlockedBranches: [
      "Asked to hear the result → MCP has no audio input; use audition_for_human so a person listens.",
    ],
  },
  {
    id: "plan_and_commit_pitch",
    title: "Plan a pitch gesture and commit it as PitchControl curves",
    goal:
      "Turn a pitch intention (slide, attack, release, vibrato) into reviewable, unit-explicit PitchControl curves and commit them in one Undo; optionally bake the host's computed pitch into a curve.",
    requiredCapabilities: ["pitchControls"],
    expectedCalls: { min: 3, max: 6 },
    humanGates: ["Whether the tuning sounds right is human_only — end with an audition."],
    captureTemplate: captureTemplate(["notes", "pitchControls", "computedPitch"]),
    preconditions: [
      "PitchControl write is SynthV 2.1+ and host-gated: offline transaction semantics are verified, but insertion/ordering/clone/remove/scriptData behavior must be confirmed on the real host before release (see tools/pitch-control-probe.mjs).",
    ],
    steps: [
      {
        n: 1,
        tool: "sv_snapshot_range",
        purpose:
          "Capture notes (required to anchor gestures), existing pitchControls (to see ownership/fingerprints), and computedPitch (if you may bake).",
        arguments: {
          scope: { kind: "range", from: { bar: 1 }, to: { bar: 9 } },
          include: ["notes", "pitchControls", "computedPitch"],
        },
        requiredInclude: ["notes", "pitchControls"],
        acceptable: ["status captured"],
        readingRules: [
          "pitchControls entries carry kind (point/curve), group-local AND occurrence-absolute coordinates, ownership, and a content fingerprint. indexInGroup is only a hint — the host re-sorts on every add/remove, so identity is the fingerprint, never the index.",
          "pitch values are group-relative semitones and times are group-local integer BLICK; the occurrence-absolute fields add timeOffset/pitchOffset. Never mix these with pitchDelta cents.",
        ],
      },
      {
        n: 2,
        tool: "sv_plan_pitch_gesture",
        purpose:
          "Compile an explicit gesture into a bounded apply envelope. Pure in-memory; writes nothing.",
        arguments: {
          contextId: EXAMPLE.contextId,
          gestures: [
            { type: "attack", note: EXAMPLE.noteIndex, depthSemitone: 0.3, direction: "up" },
          ],
        },
        acceptable: ["ok", "status planned"],
        readingRules: [
          "apply.arguments.operations are add-only curve definitions in group-local coordinates; the planner never deletes or overwrites existing pitch controls.",
          "apply.arguments.target carries expectedNotes/expectedTimeOffsetBlick/expectedPitchOffsetSemitone drift guards — submit them, do not strip them.",
          "Depth/frequency/phase are bounded; a CONSTRAINT_CLAMPED warning means a value was clamped to the configured budget.",
        ],
      },
      {
        n: 3,
        tool: "sv_patch_pitch_controls",
        purpose: "Dry-run the planned operations; read the planned operations before writing.",
        arguments: {
          contextId: EXAMPLE.contextId,
          occurrenceId: EXAMPLE.occurrenceId,
          operations: [
            {
              op: "add",
              control: {
                kind: "curve",
                anchorPositionBlick: 0,
                anchorPitchSemitone: 60,
                points: [
                  { timeFromAnchorBlick: 0, pitchFromAnchorSemitone: -0.3 },
                  { timeFromAnchorBlick: 705600000, pitchFromAnchorSemitone: 0 },
                ],
              },
            },
          ],
          dryRun: true,
        },
        note: "In practice submit apply.arguments from step 2 verbatim plus dryRun:true.",
        acceptable: ["status dry_run"],
      },
      {
        n: 4,
        tool: "sv_patch_pitch_controls",
        purpose: "Commit the identical arguments with dryRun removed. One Undo interval for all operations.",
        arguments: {
          contextId: EXAMPLE.contextId,
          occurrenceId: EXAMPLE.occurrenceId,
          operations: [
            {
              op: "add",
              control: {
                kind: "curve",
                anchorPositionBlick: 0,
                anchorPitchSemitone: 60,
                points: [
                  { timeFromAnchorBlick: 0, pitchFromAnchorSemitone: -0.3 },
                  { timeFromAnchorBlick: 705600000, pitchFromAnchorSemitone: 0 },
                ],
              },
            },
          ],
          atomic: true,
        },
        acceptable: ["succeeded", "no_change"],
        needsHumanDecision: ["SHARED_TARGET_REQUIRES_CONFIRMATION"],
        nonRetryable: [
          "STALE_CONTEXT / UNKNOWN_CONTROL / TARGET_CONFLICT — the group or an anchored note changed after the snapshot; re-snapshot and RE-PLAN, do not resubmit",
          "AMBIGUOUS_CONTROL — identical duplicates cannot be addressed; re-snapshot and disambiguate, never first-match",
          "outcome_unknown — re-snapshot and compare before any further action",
        ],
        afterSuccess:
          "This contextId is deleted. New controls carry the svcopilot.* ownership namespace; re-snapshot with include:[\"pitchControls\"] to read back the written curves.",
      },
      {
        n: 5,
        tool: "sv_bake_computed_pitch",
        purpose:
          "Optional: freeze the host's computed pitch into ONE owned curve when coverage is sufficient (all-null or below-threshold writes nothing).",
        arguments: {
          contextId: EXAMPLE.contextId,
          occurrenceId: EXAMPLE.occurrenceId,
          dryRun: true,
        },
        optional: true,
        acceptable: ["dry_run", "INSUFFICIENT_COMPUTED_PITCH (zero write; wait for processing and re-snapshot)"],
        readingRules: [
          "All-null or empty computed pitch means NOT ENOUGH DATA — never zero error and never bakeable data.",
          "Existing pitchDelta automation is preserved; clearing it is not supported in this version. Audit for double-counting if pitchDelta drove the computed pitch.",
          "Commit with dryRun:false to write inside one Undo; the curve is svcopilot-owned so a later replace_owned bake can replace it cleanly.",
        ],
      },
    ],
    nextRecipes: ["verify_after_edit", "audition_for_human"],
    reportingRules: [
      "Distinguish a verified write (host read-back) from 'the tuning sounds right' (human_only).",
      "PitchControl has no host UUID — refer to controls by controlId + fingerprint, never by a remembered index.",
      "Never claim a bake or gesture improved the intonation; report objective evidence and offer an audition.",
    ],
    capabilityBlockedBranches: [
      "Asked to hear the result → MCP has no audio input; use audition_for_human so a person listens.",
    ],
  },
  {
    id: "quantize_notes",
    title: "Snap note onsets to a grid deterministically",
    goal: "Plan and commit grid-aligned onsets without reordering notes or guessing.",
    requiredCapabilities: [],
    expectedCalls: { min: 3, max: 5 },
    humanGates: [],
    captureTemplate: captureTemplate(["notes", "tempoMap", "meterMap"]),
    steps: [
      {
        n: 1,
        tool: "sv_snapshot_range",
        purpose:
          "Capture notes plus meterMap. meterMap is required: the grid is bar-anchored and re-anchors at every meter change.",
        arguments: {
          scope: { kind: "range", from: { bar: 1 }, to: { bar: 5 } },
          include: ["notes", "tempoMap", "meterMap"],
        },
        requiredInclude: ["notes", "meterMap"],
        acceptable: ["status captured"],
      },
      {
        n: 2,
        tool: "sv_quantize_notes",
        purpose: "Plan onset (and optionally duration) snapping. Pure in-memory; returns an apply envelope.",
        arguments: {
          contextId: EXAMPLE.contextId,
          grid: { division: "1/16" },
          strength: 1,
        },
        acceptable: ["ok", "no_change (already quantized)"],
        nonRetryable: [
          "INVALID_CONTEXT when meter marks are missing — re-snapshot with meterMap, do not retry the same context",
        ],
        readingRules: [
          "QUANTIZE_COLLISION: two notes landed on one slot; the later note keeps its original onset. This is intended, not a failure.",
          "OVERLAP_AFTER_QUANTIZE: onset changes that would overlap neighbours were reverted. Set quantizeDurations:true to trim the earlier note instead.",
          "Triplet grids (1/8T, 1/16T) reject swing.",
          "There is NO humanize option; random micro-timing conflicts with the deterministic-planner contract.",
          "Breath notes are quantized like any timed note.",
        ],
      },
      {
        n: 3,
        tool: "sv_patch_notes",
        purpose: "Dry-run the planned onsets.",
        arguments: {
          contextId: EXAMPLE.contextId,
          patches: [
            {
              note: 0,
              expected: { onsetBlick: 176400123 },
              set: { onsetBlick: 176400000 },
            },
          ],
          dryRun: true,
        },
        note: "In practice submit apply.arguments from step 2 plus dryRun:true.",
        acceptable: ["status dry_run"],
      },
      {
        n: 4,
        tool: "sv_patch_notes",
        purpose: "Commit with the expected onset preconditions intact.",
        arguments: {
          contextId: EXAMPLE.contextId,
          patches: [
            {
              note: 0,
              expected: { onsetBlick: 176400123 },
              set: { onsetBlick: 176400000 },
            },
          ],
          atomic: true,
        },
        acceptable: ["succeeded", "no_change"],
        needsHumanDecision: ["SHARED_TARGET_REQUIRES_CONFIRMATION"],
        nonRetryable: [
          "EXPECTED_MISMATCH — a human moved the note after the snapshot; re-snapshot and re-plan",
          "outcome_unknown — re-snapshot and compare",
        ],
        afterSuccess:
          "The contextId is deleted. Re-snapshot before the continuation round or any verification.",
      },
    ],
    reportingRules: [
      "Report collisions and reverted onsets explicitly — a quantize that silently skipped notes is misleading.",
      "Whether the tightened timing feels musical is human_only.",
    ],
    capabilityBlockedBranches: [],
  },
  {
    id: "generate_harmony",
    title: "Generate a diatonic harmony line into an existing target group",
    goal: "Plan third/sixth harmony notes and insert them into a prepared destination group.",
    requiredCapabilities: [],
    expectedCalls: { min: 4, max: 6 },
    humanGates: ["Whether the harmony sounds good is human_only."],
    captureTemplate: captureTemplate(["notes", "tempoMap", "meterMap"]),
    preconditions: [
      "sv_generate_harmony NEVER creates tracks or groups. Prepare the destination first (e.g. sv_clone_track_from_template), then re-snapshot so source AND target occurrences live in ONE range context.",
      "sv_clone_track_from_template does not fork musical data: cloned references share their target NoteGroups. Read sharedTargetGroups/isIsolatedEditableTarget in its response before editing.",
    ],
    steps: [
      {
        n: 1,
        tool: "sv_clone_track_from_template",
        purpose: "Optional: create the destination track when one does not exist yet.",
        arguments: { templateTrackIndex: 0, name: "Harmony" },
        acceptable: ["succeeded"],
        optional: true,
        readingRules: [
          "CLONE_SHARES_NOTE_GROUPS means editing the clone also edits the template. Resolve that before inserting harmony.",
          "Hidden singer/database preservation is host-opaque; never claim the clone kept the singer.",
        ],
      },
      {
        n: 2,
        tool: "sv_snapshot_range",
        purpose: "Capture source and target occurrences together in one context.",
        arguments: {
          scope: { kind: "range", from: { bar: 1 }, to: { bar: 9 }, },
          include: ["notes", "tempoMap", "meterMap"],
        },
        requiredInclude: ["notes"],
        acceptable: ["status captured"],
        readingRules: [
          "Both occurrenceIds must come from THIS context. A source in one context and a target in another is rejected.",
        ],
      },
      {
        n: 3,
        tool: "sv_generate_harmony",
        purpose: "Plan diatonic harmony notes in target-local coordinates. Pure in-memory.",
        arguments: {
          contextId: EXAMPLE.contextId,
          sourceOccurrenceId: EXAMPLE.occurrenceId,
          targetOccurrenceId: EXAMPLE.targetOccurrenceId,
          harmony: { interval: "third_below", key: { tonic: "A", mode: "minor" } },
          register: { minPitch: 48, maxPitch: 72 },
          lyricsMode: "copy",
        },
        acceptable: ["ok", "no_change (already applied)"],
        nonRetryable: [
          "UNSUPPORTED_PITCH_OFFSET — a non-integer occurrence pitch offset cannot produce integer MIDI inserts; report it, do not retry",
        ],
        readingRules: [
          "KEY_AMBIGUOUS means detection was thin. Pass harmony.key to lock the mapping instead of trusting the top candidate.",
          "TARGET_NOTE_CONFLICT notes are NEVER overwritten. Report them and let the human decide.",
          "harmonyPitch is target-local MIDI; harmonySoundingPitch is the sounding coordinate. Do not mix them.",
          "needsReview flags mark non-diatonic source notes approximated to the nearest scale tone.",
          "VOICE_CROSSING_AVOIDED / REGISTER_UNREACHABLE notes were skipped deliberately.",
        ],
      },
      {
        n: 4,
        tool: "sv_restructure_notes",
        purpose: "Dry-run the planned inserts.",
        arguments: {
          contextId: EXAMPLE.contextId,
          occurrenceId: EXAMPLE.targetOccurrenceId,
          operations: [
            {
              op: "insert",
              note: { onsetBlick: 0, durationBlick: 705600000, pitch: 57, lyrics: "ひ" },
            },
          ],
          dryRun: true,
        },
        note: "In practice submit apply.arguments from step 3 plus dryRun:true.",
        acceptable: ["status dry_run"],
      },
      {
        n: 5,
        tool: "sv_restructure_notes",
        purpose: "Commit the inserts inside one Undo interval.",
        arguments: {
          contextId: EXAMPLE.contextId,
          occurrenceId: EXAMPLE.targetOccurrenceId,
          operations: [
            {
              op: "insert",
              note: { onsetBlick: 0, durationBlick: 705600000, pitch: 57, lyrics: "ひ" },
            },
          ],
          atomic: true,
        },
        acceptable: ["succeeded", "no_change"],
        needsHumanDecision: ["SHARED_TARGET_REQUIRES_CONFIRMATION"],
        nonRetryable: ["outcome_unknown — re-snapshot and compare"],
        afterSuccess:
          "The contextId is deleted. Re-snapshot before the continuation round; already-inserted notes then report already_applied so the loop converges.",
      },
    ],
    nextRecipes: ["audition_for_human"],
    reportingRules: [
      "State the key used and whether it was explicit or detected, plus every skipped note and its reason.",
      "Never claim the harmony is good; offer an audition.",
    ],
    capabilityBlockedBranches: [
      "Asked to assign a different singer to the harmony track → capability-blocked; report unobservable and let the human assign it in the UI.",
    ],
  },
  {
    id: "verify_after_edit",
    title: "Verify an edit with objective evidence",
    goal: "Prove what actually changed using host read-back and computed-pitch comparison, not assumptions.",
    requiredCapabilities: ["computedPitch"],
    expectedCalls: { min: 2, max: 4 },
    humanGates: ["Whether the change is an improvement is human_only."],
    captureTemplate: captureTemplate(["notes", "computedPitch", "processing"], {
      computedPitchSampling: { frames: 320 },
    }),
    preconditions: [
      "The before-state must have been snapshotted BEFORE the edit with include:[\"notes\",\"computedPitch\"]. The comparer is pure in-memory and cannot reconstruct a past state.",
      "Both sides must use the SAME sampling grid, otherwise the frame-by-frame diff is meaningless.",
    ],
    steps: [
      {
        n: 1,
        tool: "sv_wait_for_processing",
        purpose:
          "Let the host finish recomputing pitch after the edit. Read-only polling; it never changes a verified write outcome.",
        arguments: {
          contextId: EXAMPLE.beforeContextId,
          occurrenceId: EXAMPLE.occurrenceId,
          kind: "computedPitch",
        },
        acceptable: ["ready", "timeout (reports the last observation, never a fake success)"],
        readingRules: [
          "For computedPitch, startBlick/intervalBlick/frames are inherited from a context captured with include:[\"computedPitch\"]; otherwise all three are required.",
          "Empty phonemes are legal and do NOT mean pending.",
          "A timeout is evidence of incomplete data, not proof of a host fault.",
        ],
      },
      {
        n: 2,
        tool: "sv_snapshot_range",
        purpose: "Capture the after-state with the SAME sampling as the before-state.",
        arguments: {
          scope: { kind: "range", from: { bar: 5 }, to: { bar: 9 } },
          include: ["notes", "computedPitch", "processing"],
          computedPitchSampling: { frames: 320 },
        },
        requiredInclude: ["notes", "computedPitch"],
        acceptable: ["status captured"],
      },
      {
        n: 3,
        tool: "sv_compare_computed_pitch",
        purpose: "Diff before against after on the identical grid by score position.",
        arguments: {
          mode: "compare_contexts",
          before: { contextId: EXAMPLE.beforeContextId, occurrenceId: EXAMPLE.occurrenceId },
          after: { contextId: EXAMPLE.afterContextId, occurrenceId: EXAMPLE.occurrenceId },
        },
        acceptable: ["ok", "insufficient_data"],
        readingRules: [
          "PER_NOTE_UNMATCHED means a structural edit removed the positional counterpart. Report unmatched, never compare across different notes.",
          "LOW_COMPUTED_PITCH_COVERAGE caps how much the summary can support.",
          "Deltas are after minus before. State the unit (cents) explicitly.",
        ],
      },
    ],
    reportingRules: [
      "Distinguish 'the write was verified by read-back' from 'the sound changed as intended'. Only the first is observable here.",
      "If computed pitch is all-null on either side, report insufficient evidence rather than declaring success.",
    ],
    capabilityBlockedBranches: [
      "Asked to confirm it sounds fixed → human_only; hand over objective deltas plus an audition.",
    ],
  },
  {
    id: "audition_for_human",
    title: "Organize playback so a person can judge the result",
    goal: "Play a range for a human and restore the project state afterwards, without claiming to hear anything.",
    requiredCapabilities: ["playback"],
    expectedCalls: { min: 1, max: 4 },
    humanGates: ["Every perceptual conclusion. MCP has no audio input."],
    captureTemplate: null,
    steps: [
      {
        n: 1,
        tool: "sv_start_audition",
        purpose:
          "Start non-blocking playback over a blick range, optionally soloing tracks, with an automatic stop and restore.",
        arguments: {
          fromBlick: 0,
          toBlick: 2822400000,
          soloTrackIndices: [0],
          autoStop: true,
          restore: true,
        },
        acceptable: ["prepared / playing"],
        readingRules: [
          "This returns immediately with an auditionId. It does NOT wait for playback to finish.",
          "Keep the recovery payload: it is the crash-recovery escape hatch for leftover solo/playhead state.",
          "HOST_LOOP_REGION_ACTIVE means the host loop region may affect what the human hears; report it.",
          "Blicks here are absolute project coordinates. Get them from a range context's range.from.blick / range.to.blick rather than guessing.",
        ],
      },
      {
        n: 2,
        tool: "sv_get_audition",
        purpose: "Optional: report progress to the human while playback runs.",
        arguments: { auditionId: EXAMPLE.auditionId },
        acceptable: ["playing", "stopped", "stopped_by_user"],
        optional: true,
      },
      {
        n: 3,
        tool: "sv_stop_audition",
        purpose: "Stop early and restore saved playback status, playhead, and temporary solo values.",
        arguments: { auditionId: EXAMPLE.auditionId },
        acceptable: ["succeeded", "restore_failed (evidence preserved for retry)"],
        optional: true,
        readingRules: [
          "Mixer fields are restored ONLY if they still hold the audition-set value; user changes are left alone and reported as RESTORE_SKIPPED_USER_CHANGES.",
          "With autoStop:true this step is unnecessary unless the human wants to stop early.",
        ],
      },
      {
        n: 4,
        tool: "sv_audition_compare",
        purpose:
          "A/B two EXISTING versions back to back (e.g. an original track against an edited duplicate) so a person can choose between them.",
        arguments: {
          fromBlick: 0,
          toBlick: 2822400000,
          variants: [
            { label: "a", soloTrackIndices: [0] },
            { label: "b", soloTrackIndices: [1] },
          ],
          estimatedDurationMs: 8000,
        },
        optional: true,
        acceptable: ["succeeded (playing_a, then gap, then playing_b, then restored)"],
        readingRules: [
          "Non-blocking: it returns a comparisonId immediately. Poll sv_get_audition_compare or stop early with sv_stop_audition_compare (both idempotent).",
          "Variant A is fully stopped and restored BEFORE variant B starts, which is what gives both variants the same playhead, range, and mixer baseline.",
          "It NEVER applies a temporary edit for variant B: the official API has no Undo call, so an audition-only write could not be taken back. To compare an edit, commit it to a duplicate track first, then A/B the two tracks.",
          "It creates no project-content Undo record — only mixer solo and playhead are touched, and both are restored.",
          "Ask the person which variant they preferred. Never state a preference yourself.",
        ],
      },
    ],
    recoveryPath: {
      tool: "sv_restore_audition",
      purpose: "Use the saved recovery payload after a server crash left solo/mute changes behind.",
      arguments: {
        recovery: {
          version: 1,
          savedPlayheadSeconds: 0,
          savedStatus: "stopped",
          mixerChanges: [
            { trackIndex: 0, field: "solo", previousValue: false, setValue: true },
          ],
        },
      },
    },
    reportingRules: [
      "Say what was played and what was restored. Ask the human for the perceptual verdict.",
      "NEVER write or imply that the audition sounded correct, in tune, or better.",
    ],
    capabilityBlockedBranches: [
      "Asked to record, bounce, or export the audition → capability-blocked; no audio bytes or render primitive exists.",
    ],
  },
];

const DEFAULT_WORKFLOW = [
  "svcopilot://capabilities and this guide",
  "sv_snapshot_range (capture what the later steps need — analyzers cannot read the host)",
  "analysis — prefer sv_analyze_vocal_context (one call composing phrase/prosody/style/computedPitch); drill into a single analyzer only when you need its full detail",
  "planner (sv_plan_expression / sv_align_lyrics / sv_quantize_notes / sv_generate_harmony)",
  "hardened editor dryRun:true and read plannedDiff",
  "hardened editor commit and read status/effects",
  "sv_wait_for_processing + re-snapshot + sv_compare_computed_pitch",
  "sv_start_audition for the human verdict",
];

const TOOL_SELECTION = {
  preferHighLevel:
    "Prefer the high-level tools. Fall back to sv_run, and only then to sv_call/sv_index, when a high-level tool explicitly does not cover the need.",
  byNeed: [
    { need: "See project structure", tool: "sv_snapshot", scope: "kind:\"project\"" },
    { need: "Capture an editable phrase", tool: "sv_snapshot_range" },
    { need: "Diagnose a phrase (start here)", tool: "sv_analyze_vocal_context" },
    { need: "Key / phrases / scale degrees", tool: "sv_analyze_phrase" },
    {
      need: "Chord candidates / cadence / strong beats",
      tool: "sv_analyze_phrase",
      scope: "melody_only",
      note: "Opt-in include sections. A single melody cannot determine the real harmony — report candidates, never a chord progression as fact.",
    },
    { need: "Lyric and prosody problems", tool: "sv_validate_lyrics_prosody" },
    { need: "Objective intonation evidence", tool: "sv_compare_computed_pitch" },
    { need: "Cross-section style statistics", tool: "sv_style_profile" },
    { need: "Expression / dynamics / vibrato plan", tool: "sv_plan_expression" },
    { need: "Fill lyrics onto notes", tool: "sv_align_lyrics" },
    { need: "Tighten timing to a grid", tool: "sv_quantize_notes" },
    { need: "Add a harmony line", tool: "sv_generate_harmony" },
    { need: "Edit note fields", tool: "sv_patch_notes" },
    { need: "Insert / delete / split / merge notes", tool: "sv_restructure_notes" },
    { need: "Write Automation curves", tool: "sv_patch_parameter_curves" },
    { need: "Read / write PitchControl points & curves", tool: "sv_patch_pitch_controls" },
    { need: "Plan a pitch gesture (slide/vibrato/attack)", tool: "sv_plan_pitch_gesture" },
    {
      need: "Freeze host computed pitch into a curve",
      tool: "sv_bake_computed_pitch",
      note: "Writes nothing when coverage is insufficient or all-null; null is never zero pitch.",
    },
    { need: "Several edit kinds in ONE Undo", tool: "sv_edit_phrase" },
    { need: "Read observable voice parameters", tool: "sv_get_voice_profile" },
    { need: "Let a human listen", tool: "sv_start_audition" },
    {
      need: "Let a human A/B two existing versions",
      tool: "sv_audition_compare",
      note: "Compares two solo configurations over the same range. It never applies a temporary edit for variant B — there is no Undo API, so an audition-only write could not be taken back.",
    },
    {
      need: "Change the editor note selection",
      tool: "sv_set_selection",
      note: "Reads the selection back to decide `changed`; the host boolean is not trustworthy. Creates no Undo record.",
    },
    { need: "Official API details", tool: "sv_describe / sv_search_api" },
  ],
  doNotAsk: [
    "There is no render/export/bounce tool — audio rendering is capability-blocked.",
    "There is no singer list, singer identity read, or singer assignment tool.",
    "There is no undo tool, revision id, or change-event subscription.",
    "There is no machine listening tool; no tool returns audio.",
  ],
};

function recipeSummary(recipe) {
  return {
    id: recipe.id,
    title: recipe.title,
    goal: recipe.goal,
    requiredCapabilities: recipe.requiredCapabilities,
    expectedCalls: recipe.expectedCalls,
    humanGates: recipe.humanGates,
    stepCount: recipe.steps.length,
    // 摘要里列的必须是模型真能调用的 facade 名。
    tools: [...new Set(recipe.steps.map((step) => facadeForTool(step.tool)))],
    uri: `${GUIDE_BASE_URI}/${recipe.id}`,
  };
}

// 目录页：只给摘要与全局规则，单个 recipe 全文通过子 URI 读取。
export function musicWorkflowGuideIndex(interfaceVersion) {
  return {
    guideVersion: GUIDE_VERSION,
    interfaceVersion,
    description:
      "How to combine SV Copilot tools into safe musical workflows. Read one recipe URI for its full steps. This guide describes tool composition only; every project fact must come from a live sv_snapshot_range.",
    defaultWorkflow: DEFAULT_WORKFLOW,
    toolSelection: { ...TOOL_SELECTION, byNeed: TOOL_SELECTION.byNeed.map(projectNeed) },
    globalRules: GLOBAL_RULES,
    recipes: RECIPES.map(recipeSummary),
  };
}

export function musicWorkflowGuideRecipe(recipeId, interfaceVersion) {
  const recipe = RECIPES.find((candidate) => candidate.id === recipeId);
  if (!recipe) return null;
  return {
    guideVersion: GUIDE_VERSION,
    interfaceVersion,
    recipe: projectRecipe(recipe),
    seeAlso: {
      index: GUIDE_BASE_URI,
      capabilities: "svcopilot://capabilities",
      operations: "svcopilot://operations",
      describeTool: "sv_describe",
    },
  };
}

export function musicWorkflowGuideRecipeIds() {
  return RECIPES.map((recipe) => recipe.id);
}

// 测试与内部校验用：拿到每个 step 的 (tool, arguments) 对，逐一喂给真实 inputSchema。
// 这里返回的是内部 handler 名与内层 arguments——被校验的正是那份严格业务 schema；
// facade 信封由 projectCall 在资源序列化时加上。
export function musicWorkflowGuideExamples() {
  const examples = [];
  for (const recipe of RECIPES) {
    if (recipe.captureTemplate) {
      examples.push({
        recipeId: recipe.id,
        label: "captureTemplate",
        tool: recipe.captureTemplate.tool,
        arguments: recipe.captureTemplate.arguments,
      });
    }
    for (const step of recipe.steps) {
      examples.push({
        recipeId: recipe.id,
        label: `step ${step.n}`,
        tool: step.tool,
        arguments: step.arguments,
      });
      if (step.onInsufficientData) {
        examples.push({
          recipeId: recipe.id,
          label: `step ${step.n} onInsufficientData`,
          tool: step.onInsufficientData.tool,
          arguments: step.onInsufficientData.arguments,
        });
      }
    }
    if (recipe.recoveryPath) {
      examples.push({
        recipeId: recipe.id,
        label: "recoveryPath",
        tool: recipe.recoveryPath.tool,
        arguments: recipe.recoveryPath.arguments,
      });
    }
  }
  return examples;
}
