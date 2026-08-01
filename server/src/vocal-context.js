// sv_analyze_vocal_context：一次性声乐上下文分析（主计划 P0-C）。
//
// 目的：把已有的 phrase / prosody / style / computedPitch 分析器组合成一次调用，
// 让 LLM 在一个响应里拿到乐句、韵律、风格和客观音高证据。
//
// 关键契约（"只减少调用和遗漏，不新增算法权威"）：
// - 只读 SnapshotStore：不访问宿主、不进 ExecutionCoordinator、宿主调用数恒为 0。
// - 复用现有分析核：直接调用四个既有 service，不复制一套调性/韵律/音高算法。
//   因此本模块没有任何音乐学判断，所有结论的 provenance 归属原分析器。
// - 分区隔离：每个 section 独立返回 succeeded / not_captured / processing_pending /
//   insufficient_evidence / failed，一个 section 数据不足绝不吞掉其余结果。
// - 确定性：相同 context + 相同 request → 相同输出（各分析器本身即确定性）。
// - 不伪造数据：缺 automation / processing / computedPitch 时返回局部状态，绝不用 0 冒充实测。
// - 不输出机器听感评分：suggestions 只引用 issue/note/anomaly ID 和下一步工具。
//
// compact 明细策略：这些分析器都是纯内存且可无代价重跑，因此 compact 不引入
// cursor 存储（那会带来 TTL、淘汰和 EXPIRED_CURSOR 失败模式），而是给出
// details.tool + details.arguments —— 调用方照抄即可拿到该 section 的完整明细。

import { ComputedPitchCompareService } from "./computed-pitch-compare.js";
import { artifactReference } from "./artifact-store.js";
import { LyricProsodyService } from "./lyric-prosody.js";
import { PhraseAnalysisService } from "./phrase-analysis.js";
import { project, registerProjection } from "./response-projection.js";
import { ServiceTiming } from "./service-timing.js";
import { StyleProfileService } from "./style-profile.js";
import { unknownContextError } from "./snapshot.js";
import { selectOccurrenceByOrdinal } from "./scope-source.js";

const SECTIONS = ["phrase", "prosody", "style", "computedPitch"];
const PROJECTION_KIND = "vocal-context-analysis";

const DEFAULT_BUDGETS = Object.freeze({
  issues: 50,
  perNote: 100,
  anomalySegments: 20,
  bytes: 60000,
});

const BUDGET_LIMITS = Object.freeze({
  issues: { min: 1, max: 500 },
  perNote: { min: 1, max: 2000 },
  anomalySegments: { min: 1, max: 200 },
  bytes: { min: 8192, max: 200000 },
});

const PROVENANCE = Object.freeze({
  composition: "reuses_existing_analyzers_adds_no_new_musical_authority",
  hostAccess: "none_pure_in_memory_over_snapshot_store",
  sectionAuthority: Object.freeze({
    phrase: "sv_analyze_phrase",
    prosody: "sv_validate_lyrics_prosody",
    style: "sv_style_profile",
    computedPitch: "sv_compare_computed_pitch",
  }),
  perception: "human_only",
});

// 各 section 失败时的语义分类。分析器抛出的 code 决定 section 状态，
// 而不是笼统地把一切都算作 failed。
const NOT_CAPTURED_CODES = new Set([
  "NOTES_NOT_CAPTURED",
  "COMPUTED_PITCH_NOT_CAPTURED",
  "AUTOMATION_NOT_CAPTURED",
  "PROCESSING_NOT_CAPTURED",
]);
const INSUFFICIENT_EVIDENCE_CODES = new Set([
  "INSUFFICIENT_COMPUTED_PITCH",
  "NO_MELODIC_EVIDENCE",
  "NO_MELODIC_NOTES",
  "NOT_ENOUGH_NOTES",
  "INSUFFICIENT_PITCH_VARIETY",
]);
// 这些错误说明请求本身有问题（而不是数据不足），整次调用应当直接失败，
// 否则模型会误以为"分析跑过了只是没结果"。
const FATAL_CODES = new Set([
  "UNKNOWN_CONTEXT",
  "INVALID_CONTEXT",
  "UNKNOWN_OCCURRENCE",
  "AMBIGUOUS_CONTEXT",
  "INVALID_ARGUMENTS",
]);

registerProjection(PROJECTION_KIND, {
  summarize: (canonical) => ({
    sectionIndex: Object.fromEntries(
      Object.entries(canonical.sections).map(([name, section]) => [
        name,
        {
          status: section.status,
          authority: section.authority,
          ...(section.summary !== undefined ? { summary: section.summary } : {}),
          ...(section.reason !== undefined ? { reason: section.reason } : {}),
          ...(section.remedy !== undefined ? { remedy: section.remedy } : {}),
          details: section.details,
        },
      ])
    ),
    summary: canonical.summary,
    topFindings: canonical.topFindings,
    nextSteps: canonical.nextSteps,
  }),
  chooseRepresentativeItems: (canonical) => ({ sections: canonical.sections }),
  paginateDetail: (_canonical, options) =>
    options.artifactRef ? { detailRef: options.artifactRef } : {},
});

export class VocalContextAnalysisService {
  constructor({ store, now = () => Date.now(), artifactStore = null, sessionId = null } = {}) {
    if (!store) throw new Error("VocalContextAnalysisService requires the shared SnapshotStore");
    this.store = store;
    this.now = now;
    this.artifactStore = artifactStore;
    this.sessionId = sessionId;
    // 复用既有分析器实例：它们本身无状态（只读 store），共享安全。
    this.phrase = new PhraseAnalysisService({ store, now });
    this.prosody = new LyricProsodyService({ store, now });
    this.style = new StyleProfileService({ store, now });
    this.computedPitch = new ComputedPitchCompareService({ store, now });
  }

  async analyze(request = {}) {
    const timer = new ServiceTiming({
      now: this.now,
      phaseNames: ["phraseMs", "prosodyMs", "styleMs", "computedPitchMs"],
    });
    const input = normalizeRequest(request);
    // 纯内存服务：不进入协调器；coordinatorQueueMs/operationMs 恒 0，如实报告。
    timer.requestCoordinator();
    const warnings = [];

    // 先解析目标 occurrence：请求级错误必须整体失败，而不是四个 section 各报一次。
    const target = resolveTarget(this.store, input);

    const sections = {};
    for (const name of input.include) {
      sections[name] = await runSection(this, name, input, target, timer, warnings);
    }

    const findings = collectFindings(sections, input);
    const canonical = {
      sections,
      summary: summarize(sections, findings),
      topFindings: findings.slice(0, input.budgets.issues),
      nextSteps: nextSteps(sections, findings, target),
    };
    let artifactRef = null;
    if (this.artifactStore && this.sessionId) {
      try {
        const artifact = this.artifactStore.seal({
          kind: "vocal-context-analysis",
          schemaVersion: "1",
          sessionId: this.sessionId,
          payload: {
            contextId: target.contextId,
            occurrence: target.publicOccurrence,
            requested: [...input.include],
            ...canonical,
          },
        });
        artifactRef = artifactReference(artifact);
      } catch (error) {
        warnings.push({
          code: "ARTIFACT_SEAL_FAILED",
          message: `Failed to seal vocal-context detail artifact: ${error.message}`,
        });
      }
    }
    const projection = project({
      kind: PROJECTION_KIND,
      canonical,
      mode: input.responseMode === "verbose" ? "audit" : input.responseMode,
      options: { artifactRef },
    });
    return applyByteBudget(
      {
        ok: true,
        status: "succeeded",
        contextId: target.contextId,
        occurrence: target.publicOccurrence,
        requested: [...input.include],
        responseMode: input.responseMode,
        ...projection.summary,
        ...(projection.representative ?? {}),
        ...(projection.detail ?? {}),
        provenance: PROVENANCE,
        warnings,
        timings: timer.finish(),
        ...(artifactRef ? { artifactRef } : {}),
      },
      input,
      warnings
    );
  }
}

// ---------- 目标解析 ----------

function resolveTarget(store, input) {
  const stored = store.get(input.contextId);
  if (!stored) {
    throw unknownContextError(store, input.contextId);
  }
  if (stored.context?.kind !== "range") {
    throw codedError(
      "INVALID_CONTEXT",
      'sv_analyze_vocal_context needs a range context from sv_snapshot_range with include ["notes"]'
    );
  }
  const { occurrence, ordinal } = selectOccurrenceByOrdinal(
    stored.context.occurrences,
    input.occurrence,
    {
      eligible: (item) =>
        Array.isArray(item.noteFingerprints) && item.noteFingerprints.length > 0,
      noneCode: "NOTES_NOT_CAPTURED",
      noneMessage:
        'sv_analyze_vocal_context needs note fingerprints; re-run sv_snapshot_range with include ["notes"]',
      ambiguousMessage:
        "range context has multiple occurrences with notes; pass one occurrence ordinal",
    }
  );
  return {
    contextId: stored.contextId,
    // 复合分析把同一个 target 转发给四个分析器，因此这里存的必须是它们如今接受的
    // 身份：ordinal。存字符串 id 会让每个 argumentsFor 各自再翻译一次。
    occurrence: ordinal,
    captureRange: stored.context.range,
    publicOccurrence: {
      occurrence: ordinal,
      trackIndex: occurrence.trackIndex,
      groupIndex: occurrence.groupIndex,
      targetGroupUuid: occurrence.targetGroupUuid,
    },
  };
}

// ---------- section 执行 ----------

const SECTION_RUNNERS = {
  phrase: {
    phase: "phraseMs",
    tool: "sv_analyze_phrase",
    argumentsFor: (input, target) => ({
      contextId: target.contextId,
      occurrence: target.occurrence,
      include: ["key", "phrases", "statistics"],
      phraseGapQuarter: input.phraseGapQuarter,
      responseMode: "standard",
    }),
    run: (service, args) => service.phrase.analyze(args),
    summarize: summarizePhrase,
  },
  prosody: {
    phase: "prosodyMs",
    tool: "sv_validate_lyrics_prosody",
    argumentsFor: (_input, target) => ({
      contextId: target.contextId,
      occurrence: target.occurrence,
      responseMode: "standard",
    }),
    run: (service, args) => service.prosody.validate(args),
    summarize: summarizeProsody,
  },
  style: {
    phase: "styleMs",
    tool: "sv_style_profile",
    argumentsFor: (input, target) => ({
      targets: [{ contextId: target.contextId, occurrence: target.occurrence }],
      phraseGapQuarter: input.phraseGapQuarter,
      responseMode: "standard",
    }),
    run: (service, args) => service.style.profile(args),
    summarize: summarizeStyle,
  },
  computedPitch: {
    phase: "computedPitchMs",
    tool: "sv_compare_computed_pitch",
    argumentsFor: (_input, target) => ({
      mode: "compare_to_target",
      contextId: target.contextId,
      occurrence: target.occurrence,
      responseMode: "standard",
    }),
    run: (service, args) => service.computedPitch.compare(args),
    summarize: summarizeComputedPitch,
  },
};

async function runSection(service, name, input, target, timer, warnings) {
  const runner = SECTION_RUNNERS[name];
  const args = runner.argumentsFor(input, target);
  const detailArgs = { ...args, responseMode: "verbose" };
  try {
    const result = await timer.measure(runner.phase, async () => runner.run(service, args));
    return {
      status: "succeeded",
      authority: runner.tool,
      ...runner.summarize(result, input),
      // compact 明细指针：分析器可无代价重跑，因此不引入 cursor 存储。
      details: { tool: runner.tool, arguments: detailArgs },
    };
  } catch (error) {
    const code = typeof error?.code === "string" ? error.code : "ANALYSIS_FAILED";
    // 请求级错误（未知 context/occurrence、歧义）必须整体失败：让它伪装成
    // "某个 section 数据不足"会误导模型继续基于半份结果决策。
    if (FATAL_CODES.has(code)) throw error;
    const status = NOT_CAPTURED_CODES.has(code)
      ? "not_captured"
      : INSUFFICIENT_EVIDENCE_CODES.has(code)
        ? "insufficient_evidence"
        : "failed";
    warnings.push({
      code: "SECTION_UNAVAILABLE",
      message: `${name} section is ${status} (${code}): ${error instanceof Error ? error.message : String(error)}`,
    });
    return {
      status,
      authority: runner.tool,
      reason: { code, message: error instanceof Error ? error.message : String(error) },
      ...(error?.details !== undefined ? { detail: error.details } : {}),
      remedy: remedyFor(name, code),
      details: { tool: runner.tool, arguments: detailArgs },
    };
  }
}

function remedyFor(section, code) {
  if (code === "NOTES_NOT_CAPTURED") {
    return 'Re-run sv_snapshot_range with include ["notes"].';
  }
  if (code === "COMPUTED_PITCH_NOT_CAPTURED") {
    return 'Re-run sv_snapshot_range with include ["notes","computedPitch"].';
  }
  if (code === "PROCESSING_NOT_CAPTURED") {
    return 'Re-run sv_snapshot_range with include ["processing"] to observe phoneme coverage.';
  }
  if (code === "AUTOMATION_NOT_CAPTURED") {
    return 'Re-run sv_snapshot_range with include ["automation"] to profile control points.';
  }
  if (code === "INSUFFICIENT_COMPUTED_PITCH") {
    return "Not enough usable pitch frames to analyze — this is NOT zero error. Run sv_wait_for_processing (kind computedPitch), then re-snapshot and re-analyze.";
  }
  if (code === "NO_MELODIC_EVIDENCE") {
    return "The range has no event eligible for melodic computed-pitch analysis; widen it to include sung notes.";
  }
  if (code === "NO_MELODIC_NOTES") {
    return "The range holds only breath notes; widen the range to include sung notes.";
  }
  return `The ${section} analyzer could not produce a result; report the reason instead of assuming a clean result.`;
}

// ---------- 各 section 摘要（只搬运原分析器结论，不重新判断） ----------

function summarizePhrase(result) {
  const candidates = result.key?.candidates ?? [];
  const best = candidates[0] ?? null;
  const runnerUp = candidates[1] ?? null;
  return {
    summary: {
      melodicNoteCount: result.noteCount,
      breathCount: result.breathCount,
      key: best
        ? {
            tonic: best.tonic,
            mode: best.mode,
            correlation: best.correlation,
            // 候选是排序结果而非概率；次名差距薄时必须一并报告。
            runnerUp: runnerUp
              ? { tonic: runnerUp.tonic, mode: runnerUp.mode, correlation: runnerUp.correlation }
              : null,
            marginFromNext: result.key?.marginFromNext ?? null,
            confidence: result.key?.confidence ?? null,
          }
        : null,
      phraseCount: result.phrases?.count ?? null,
      register: result.statistics?.register ?? null,
    },
    sectionWarnings: (result.warnings ?? []).map((warning) => warning.code),
  };
}

function summarizeProsody(result, input) {
  const issues = result.issues ?? [];
  return {
    summary: {
      issueCount: result.summary?.issueCount ?? 0,
      bySeverity: result.summary?.bySeverity ?? null,
      byKind: result.summary?.byKind ?? null,
      clean: Boolean(result.summary?.clean),
      phonemeCoverage: result.coverage ?? null,
    },
    // 明细项在 topFindings 中统一按严重度排序展示，这里只留预算内的原始条目。
    issues: issues.slice(0, input.budgets.issues),
    issuesTruncated: issues.length > input.budgets.issues,
    sectionWarnings: (result.warnings ?? []).map((warning) => warning.code),
  };
}

function summarizeStyle(result) {
  if (
    !Array.isArray(result.targets) ||
    result.targets.length === 0 ||
    result.targetCount !== result.targets.length
  ) {
    throw codedError(
      "ANALYSIS_CONTRACT_MISMATCH",
      "sv_style_profile returned an inconsistent target summary"
    );
  }
  const profile = result.targets[0];
  const profileSections = profile.sections ?? {};
  // not_captured 如实透出，绝不折叠成 0。null section 表示该维度无旋律样本。
  const sectionStatus = Object.fromEntries(
    Object.entries(profileSections).map(([key, value]) => [
      key,
      value === null ? "no_data" : (value.status ?? "captured"),
    ])
  );
  return {
    summary: {
      targetCount: result.targetCount,
      sectionStatus,
      rhythm: profileSections.rhythm ?? null,
      languages: profileSections.languages ?? null,
      breaths: profileSections.breaths ?? null,
    },
    sectionWarnings: (result.warnings ?? []).map((warning) => warning.code),
  };
}

function summarizeComputedPitch(result, input) {
  const anomalies = result.anomalySegments?.items ?? [];
  return {
    summary: {
      coverage: result.summary?.coverage ?? null,
      frameCount: result.summary?.frameCount ?? null,
      validFrameCount: result.summary?.validFrameCount ?? null,
      maeCent: result.summary?.maeCent ?? null,
      p95AbsCent: result.summary?.p95AbsCent ?? null,
      maxAbsCent: result.summary?.maxAbsCent ?? null,
      anomalyCount: result.anomalySegments?.total ?? anomalies.length,
      // top 恒为最严重段，截断不会吞掉最重要证据。
      worstAnomaly: result.anomalySegments?.top ?? null,
    },
    anomalySegments: anomalies.slice(0, input.budgets.anomalySegments),
    anomalySegmentsTruncated: anomalies.length > input.budgets.anomalySegments,
    ...(Array.isArray(result.perNote)
      ? {
          perNote: result.perNote.slice(0, input.budgets.perNote),
          perNoteTruncated: result.perNote.length > input.budgets.perNote,
        }
      : {}),
    sectionWarnings: (result.warnings ?? []).map((warning) => warning.code),
  };
}

// ---------- 跨 section 汇总 ----------

const SEVERITY_RANK = { error: 0, warning: 1, info: 2 };

function collectFindings(sections, input) {
  const findings = [];
  const prosody = sections.prosody;
  if (prosody?.status === "succeeded") {
    for (const issue of prosody.issues ?? []) {
      findings.push({
        ...issue,
        source: "prosody",
        authority: "sv_validate_lyrics_prosody",
        ...(Array.isArray(issue.notes) ? { notes: [...issue.notes] } : {}),
      });
    }
  }
  const pitch = sections.computedPitch;
  if (pitch?.status === "succeeded") {
    for (const segment of pitch.anomalySegments ?? []) {
      findings.push({
        source: "computedPitch",
        authority: "sv_compare_computed_pitch",
        // 异常区段是客观测量，不是"唱得不好"的判断。
        severity: "warning",
        kind: "pitch_anomaly_segment",
        confidence: "observed_measurement",
        message: `Computed pitch deviates from the note target over ${segment.startBlick}--${segment.endBlick} blick (peak ${segment.peakAbsCent} cent).`,
        startBlick: segment.startBlick,
        endBlick: segment.endBlick,
        peakAbsCent: segment.peakAbsCent,
        ...(Number.isSafeInteger(segment.note) ? { note: segment.note } : {}),
      });
    }
  }
  findings.sort((a, b) => {
    const rank = (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3);
    if (rank !== 0) return rank;
    return (a.startBlick ?? 0) - (b.startBlick ?? 0);
  });
  return findings;
}

function summarize(sections, findings) {
  const byStatus = {};
  for (const [name, section] of Object.entries(sections)) {
    byStatus[name] = section.status;
  }
  const usable = Object.values(byStatus).filter((status) => status === "succeeded").length;
  return {
    sectionStatus: byStatus,
    usableSections: usable,
    requestedSections: Object.keys(sections).length,
    findingCount: findings.length,
    // 没有可用 section 时必须说"没有证据"，而不是"没有问题"。
    evidence:
      usable === 0
        ? "no_section_produced_evidence"
        : usable < Object.keys(sections).length
          ? "partial_evidence"
          : "all_requested_sections_analyzed",
    perception: "human_only",
  };
}

function nextSteps(sections, findings, target) {
  const steps = [];
  const pitch = sections.computedPitch;
  if (pitch?.status === "not_captured") {
    const from = snapshotMusicalPoint(target.captureRange?.from);
    const to = snapshotMusicalPoint(target.captureRange?.to);
    steps.push({
      reason: pitch.reason?.code ?? "computed_pitch_not_captured",
      tool: "sv_snapshot_range",
      arguments: {
        scope: {
          kind: "range",
          trackIndices: [target.publicOccurrence.trackIndex],
          from,
          to,
        },
        include: ["notes", "computedPitch"],
      },
      then: "Use the new contextId and occurrence ordinal with sv_analyze_vocal_context.",
      note: "Missing computed pitch means NOT ENOUGH DATA TO ANALYZE — never report it as zero error.",
    });
  } else if (
    pitch?.status === "insufficient_evidence" &&
    pitch.reason?.code !== "NO_MELODIC_EVIDENCE"
  ) {
    steps.push({
      reason: pitch.reason?.code ?? "computed_pitch_unavailable",
      tool: "sv_wait_for_processing",
      arguments: {
        contextId: target.contextId,
        occurrence: target.occurrence,
        kind: "computedPitch",
      },
      then: "Re-run sv_snapshot_range, then sv_analyze_vocal_context again.",
      note: "Missing computed pitch means NOT ENOUGH DATA TO ANALYZE — never report it as zero error.",
    });
  }
  const prosodyErrors = findings.filter(
    (finding) => finding.source === "prosody" && finding.severity === "error"
  );
  const specialLyricChainFindings = findings.filter(
    (finding) =>
      finding.source === "prosody" &&
      ["ORPHAN_PLUS", "ORPHAN_PHONATION_CONTINUATION", "SYLLABLE_CHAIN_GAP", "SYLLABLE_CHAIN_OVERLAP"].includes(
        finding.code
      )
  );
  if (prosodyErrors.length > 0) {
    steps.push({
      reason: "prosody_errors_present",
      tool: "sv_align_lyrics",
      arguments: { contextId: target.contextId, occurrence: target.occurrence, lyrics: "<replacement lyric text>" },
      then: "Review the plan, dry-run apply.arguments, then commit.",
      note: `${prosodyErrors.length} error-severity lyric issue(s); sv_patch_notes or sv_restructure_notes may fit better for targeted fixes.`,
    });
  }
  if (specialLyricChainFindings.some((finding) => finding.severity !== "error")) {
    steps.push({
      reason: "special_lyric_chain_findings_present",
      tool: "sv_validate_lyrics_prosody",
      arguments: {
        contextId: target.contextId,
        occurrence: target.occurrence,
        checks: ["specialLyricChains"],
        responseMode: "verbose",
      },
      then: "Use code plus gapBlick/overlapBlick to choose a targeted sv_patch_notes or sv_restructure_notes edit.",
      note: "A continuation gap or overlap is an actionable score-structure finding, not a clean result.",
    });
  }
  if (pitch?.status === "succeeded" && (pitch.anomalySegments?.length ?? 0) > 0) {
    steps.push({
      reason: "pitch_anomaly_segments_present",
      tool: "sv_plan_expression",
      arguments: { contextId: target.contextId, occurrence: target.occurrence },
      then: "Anchor gestures on the anomalous notes, dry-run, then commit through apply.",
      note: "Anomaly segments are objective deviation measurements, not a verdict that the singing is wrong. A human decides whether the deviation is intentional.",
    });
  }
  if (steps.length === 0) {
    const range = snapshotBlickRange(target.captureRange);
    steps.push({
      reason: "no_blocking_finding",
      tool: "sv_start_audition",
      arguments: range,
      then: "Let a human listen over the analyzed range.",
      note: "No analyzer finding requires an edit. Whether it sounds right is human_only.",
    });
  }
  return steps;
}

function snapshotMusicalPoint(point) {
  if (!isRecord(point) || !Number.isSafeInteger(point.bar) || point.bar < 1) {
    throw codedError(
      "INVALID_CONTEXT",
      "range context is missing the musical boundaries needed to recapture computed pitch"
    );
  }
  return {
    bar: point.bar,
    ...(point.beat === undefined
      ? {}
      : {
          beat: isRecord(point.beat) ? { ...point.beat } : point.beat,
        }),
  };
}

function snapshotBlickRange(range) {
  const fromBlick = range?.from?.blick;
  const toBlick = range?.to?.blick;
  if (
    !Number.isSafeInteger(fromBlick) ||
    fromBlick < 0 ||
    !Number.isSafeInteger(toBlick) ||
    toBlick <= fromBlick
  ) {
    throw codedError(
      "INVALID_CONTEXT",
      "range context is missing the BLICK boundaries needed for audition"
    );
  }
  return { fromBlick, toBlick };
}

// ---------- 预算 ----------

function applyByteBudget(response, input, warnings) {
  const size = Buffer.byteLength(JSON.stringify(response), "utf8");
  if (size <= input.budgets.bytes) return response;
  if (!response.sections) return response;
  // 超预算时先丢逐项明细（摘要与 topFindings 是决策必需），并如实警告。
  const trimmed = { ...response, sections: { ...response.sections } };
  for (const [name, section] of Object.entries(trimmed.sections)) {
    if (section.status !== "succeeded") continue;
    const copy = { ...section };
    delete copy.issues;
    delete copy.perNote;
    delete copy.anomalySegments;
    trimmed.sections[name] = { ...copy, itemsOmitted: "response_byte_budget" };
  }
  warnings.push({
    code: "RESPONSE_BUDGET_APPLIED",
    message: `The full response was ${size} bytes over the ${input.budgets.bytes}-byte budget; per-section item lists were dropped. Summaries, topFindings, and nextSteps are complete — read each section's details.tool/arguments for the full lists.`,
  });
  return trimmed;
}

// ---------- 请求校验 ----------

function normalizeRequest(request) {
  if (!isRecord(request)) throw codedError("INVALID_ARGUMENTS", "request must be an object");
  assertKnownKeys(
    request,
    ["contextId", "occurrence", "include", "phraseGapQuarter", "responseMode", "budgets"],
    "request"
  );
  if (typeof request.contextId !== "string" || request.contextId.length === 0) {
    throw codedError("INVALID_ARGUMENTS", "contextId must be a non-empty string");
  }
  if (
    request.occurrence !== undefined &&
    (!Number.isSafeInteger(request.occurrence) || request.occurrence < 0)
  ) {
    throw codedError(
      "INVALID_ARGUMENTS",
      "occurrence must be a non-negative occurrence ordinal when provided"
    );
  }
  let include = SECTIONS;
  if (request.include !== undefined) {
    if (!Array.isArray(request.include) || request.include.length === 0) {
      throw codedError("INVALID_ARGUMENTS", "include must be a non-empty array when provided");
    }
    const seen = new Set();
    for (const name of request.include) {
      if (!SECTIONS.includes(name)) {
        throw codedError(
          "INVALID_ARGUMENTS",
          `include contains an unknown section: ${String(name)}; expected ${SECTIONS.join(", ")}`
        );
      }
      if (seen.has(name)) {
        throw codedError("INVALID_ARGUMENTS", `include contains a duplicate section: ${name}`);
      }
      seen.add(name);
    }
    // 固定顺序输出，保证同一请求逐字节确定性。
    include = SECTIONS.filter((name) => seen.has(name));
  }
  const phraseGapQuarter = request.phraseGapQuarter ?? 1;
  if (typeof phraseGapQuarter !== "number" || !(phraseGapQuarter >= 0.25 && phraseGapQuarter <= 8)) {
    throw codedError("INVALID_ARGUMENTS", "phraseGapQuarter must be a number between 0.25 and 8");
  }
  const responseMode = request.responseMode ?? "compact";
  if (!["compact", "standard", "verbose"].includes(responseMode)) {
    throw codedError("INVALID_ARGUMENTS", "responseMode must be compact, standard, or verbose");
  }
  const budgets = { ...DEFAULT_BUDGETS };
  if (request.budgets !== undefined) {
    if (!isRecord(request.budgets)) throw codedError("INVALID_ARGUMENTS", "budgets must be an object");
    assertKnownKeys(request.budgets, Object.keys(DEFAULT_BUDGETS), "budgets");
    for (const [key, limit] of Object.entries(BUDGET_LIMITS)) {
      const value = request.budgets[key];
      if (value === undefined) continue;
      if (!Number.isSafeInteger(value) || value < limit.min || value > limit.max) {
        throw codedError(
          "INVALID_ARGUMENTS",
          `budgets.${key} must be an integer between ${limit.min} and ${limit.max}`
        );
      }
      budgets[key] = value;
    }
  }
  // compact 只保留摘要与最高优先问题；明细通过 details.tool/arguments 展开。
  if (responseMode === "compact") {
    budgets.issues = Math.min(budgets.issues, 10);
    budgets.perNote = 0;
    budgets.anomalySegments = Math.min(budgets.anomalySegments, 5);
  }
  return {
    contextId: request.contextId,
    occurrence: request.occurrence,
    include,
    phraseGapQuarter,
    responseMode,
    budgets,
  };
}

function assertKnownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw codedError("INVALID_ARGUMENTS", `${label} has an unknown field: ${key}`);
    }
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
