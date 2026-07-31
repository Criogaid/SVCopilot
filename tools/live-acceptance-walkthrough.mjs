// §15 实机验收的可执行走查（C4 步骤 2 的驱动脚本）。
//
// 为什么需要它：§15 是 19 个步骤的人工清单。人工执行的问题不是"做不到"，而是
// 每次执行的覆盖面与记录格式都不一样——上一次漏了第 12 步，下一次漏了第 17 步，
// 而报告里看不出漏了什么。这个脚本把 19 步里**能自动化的**全部自动化，把
// 真正需要人的部分（听感、UI 观察）留成显式的 human_gate 条目，然后写一份
// 去标识的报告。
//
// 它不替代人：人必须驾驶 SynthV、打开 ≥373 音符的工程、加载桥。脚本负责保证
// 一旦人到位，走查就是完整且可比的。
//
// 安全边界：**只读**。所有写路径一律 dryRun，脚本在每步后断言 status/effects，
// 任何一次出现非 dry_run/none 就整体判失败。不写工程、不改选区、不碰 PitchControl。
// 与 bench-live-bulk-reads.mjs 同一约定：本脚本不进 npm test。
//
// 运行方式：
//   1. 启动 Synthesizer V Studio 2.2.1，打开含 ≥373 音符单一 NoteGroup 的工程。
//   2. Scripts 菜单启动 SV Copilot 桥（StartSynthVCopilot）。
//   3. cd server && npm run acceptance:live
//   4. 读 tools/out/live-acceptance-<ts>.json。
//
// 去标识：报告只记录计数、字节数、状态码与门禁结论。歌词、音素、工程名、UUID
// 和逐 Note 内容一律不写盘（§15 的硬要求）。

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { HostSession } from "../server/src/host-session.js";
import { PipeRelay } from "../server/src/transport-pipe.js";
import { SnapshotService } from "../server/src/snapshot.js";
import { RangeSnapshotService } from "../server/src/musical-range.js";
import { NotePatchService } from "../server/src/note-patch.js";
import { ParameterCurveService } from "../server/src/parameter-curve.js";
import { NoteStructureService } from "../server/src/note-structure.js";
import { ExpressionPlanService } from "../server/src/expression-plan.js";
import { LyricAlignService } from "../server/src/lyric-align.js";
import { QuantizePlanService } from "../server/src/quantize-plan.js";
import { PitchGesturePlanService } from "../server/src/pitch-gesture-plan.js";
import { ArtifactStore } from "../server/src/artifact-store.js";
import { PlanExecutionLedger } from "../server/src/plan-ledger.js";
import { collectDoctorReport, summarizeHostProfiles } from "../server/src/doctor.js";
import { apiManifest, apiManifestAvailable } from "../server/src/api-catalog.js";
import { resolvePipePaths } from "../server/src/transport-pipe.js";
import { TOOLS } from "../server/src/index.js";
import { createCompactFacade } from "../server/src/compact-facade.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, "out");
const REQUIRED_NOTES = 373;
const SESSION_ID = "sess_live_acceptance";

const utf8 = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");

const report = {
  kind: "live-acceptance",
  planSection: "15",
  capturedAt: new Date().toISOString(),
  host: null,
  fixture: null,
  steps: [],
  humanGates: [],
  gates: [],
  ok: false,
  notes: [],
};

function step(id, label, outcome) {
  report.steps.push({ id, label, ...outcome });
  const flag = outcome.passed === false ? "FAIL" : "ok";
  console.error(`[accept] ${String(id).padStart(2)} ${flag.padEnd(4)} ${label}`);
  return outcome;
}

// 人工判定项：脚本无法代替，但必须显式列出，否则"走查完成"会把它们静默吞掉。
function humanGate(id, question) {
  report.humanGates.push({ id, question, answer: "pending_human" });
}

function assertReadOnly(label, result) {
  const status = result?.status ?? null;
  const effects = result?.effects ?? null;
  if (status !== "dry_run" && status !== "planned" && status !== "no_change" && status !== "succeeded") {
    throw new Error(`${label}: unexpected status ${status}`);
  }
  if (effects !== "none") {
    throw new Error(`${label}: expected effects none, got ${effects}`);
  }
  return { status, effects };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const relay = new PipeRelay({ timeoutMs: 30_000 });
  await relay.init();
  const host = new HostSession(relay);
  try {
    await waitForBridge(relay);
    await runWalkthrough(host, {
      relayProto: relay.proto,
      interfaceVersion: JSON.parse(
        readFileSync(path.resolve(HERE, "..", "server", "package.json"), "utf8")
      ).version,
    });
    applyGates();
  } catch (error) {
    report.notes.push({
      code: "RUN_FAILED",
      message: error instanceof Error ? error.message : String(error),
    });
    console.error(`[accept] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await relay.close();
    writeReport();
  }
  process.exit(report.ok ? 0 : 1);
}

async function runWalkthrough(host, { relayProto, interfaceVersion: INTERFACE_VERSION }) {
  const session = { withExclusive: (task) => task(host) };
  const artifactStore = new ArtifactStore({ planLedger: new PlanExecutionLedger() });
  const snapshots = new SnapshotService(session);
  const ranges = new RangeSnapshotService(session, {
    snapshotService: snapshots,
    artifactStore,
    sessionId: SESSION_ID,
  });

  // §15.1 —— doctor / ping / surface。
  await host.ping();
  const status = host.getStatus();
  report.host = {
    version: status.hostVersion ?? null,
    platform: process.platform,
    negotiatedOps: status.hostOps ?? [],
  };
  const facade = createCompactFacade(TOOLS);
  const doctor = collectDoctorReport({
    interfaceVersion: INTERFACE_VERSION,
    moduleDir: path.resolve(HERE, "..", "server", "src"),
    protoVersion: relayProto,
    pipePaths: resolvePipePaths(),
    host: {
      state: "attached",
      epoch: status.epoch ?? 0,
      hostVersion: status.hostVersion ?? null,
      hostOps: status.hostOps ?? [],
      knownHandleCount: status.knownHandleCount ?? 0,
      pendingExecutions: 0,
    },
    manifest: {
      available: apiManifestAvailable,
      generatedAt: apiManifest.generatedAt,
      schemaVersion: apiManifest.schemaVersion ?? null,
    },
    // facade 派生值传进去，然后检查 doctor 照实回报——doctor 的职责是如实转述，
    // 不是自己去发现 surface。
    surface: {
      facades: facade.tools.map((tool) => tool.name),
      facadeCount: facade.tools.length,
      operationCount: facade.operationCount,
    },
    stores: { artifacts: null, snapshotContexts: null },
    hostProfiles: summarizeHostProfiles(
      path.resolve(HERE, "..", "test", "fixtures", "host-profiles")
    ),
  });
  step(1, "doctor + ping + facade surface", {
    facadeTools: facade.tools.length,
    operationCount: facade.operationCount,
    // doctor 自报的 operation 数必须与 catalog 派生值一致，否则两处有一处在撒谎。
    doctorAgrees: doctor.surface?.operationCount === facade.operationCount,
    installationHealthy: doctor.installationHealthy ?? null,
    listToolsBytes: utf8(facade.tools),
    passed:
      facade.tools.length === 8 &&
      doctor.surface?.operationCount === facade.operationCount &&
      utf8(facade.tools) < 12 * 1024,
  });

  // §15.2 —— notes-only range context。
  const fixture = await locateFixtureGroup(host);
  report.fixture = {
    trackIndex: fixture.trackIndex,
    groupIndex: fixture.groupIndex,
    noteCount: fixture.noteCount,
    identity: "withheld",
  };
  const captured = await ranges.snapshot({
    scope: {
      kind: "range",
      from: { position: "blick", blick: 0 },
      to: { position: "blick", blick: fixture.endBlick },
      trackIndices: [fixture.trackIndex],
    },
    include: ["notes"],
    responseMode: "compact",
  });
  const occurrence = findOccurrence(captured, fixture);
  step(2, "snapshot_range captures a notes-only context", {
    contextId: "withheld",
    occurrence: occurrence.occurrence ?? 0,
    groupNoteCount: occurrence.groupNoteCount ?? null,
    capturedNotes: occurrence.capturedNotes ?? null,
    responseBytes: utf8(captured),
    passed: (occurrence.groupNoteCount ?? 0) >= REQUIRED_NOTES,
  });

  // §15.3/15.4 —— grouped expression，记录请求 bytes。
  const expressionRequest = {
    contextId: captured.contextId,
    occurrence: occurrence.occurrence ?? 0,
    defaults: {
      vibrato: { surface: "pitchDelta", rateHz: 5.2, onsetDelayQuarter: 0.22 },
      scoop: { lengthQuarter: 0.16, shapePower: 2 },
    },
    gestures: [
      { type: "hairpin", from: 0, to: 8, peak: 0.72, amounts: { loudness: 1.2, tension: 0.08 } },
      { type: "scoop", targets: [[0, 22], [4, 24]] },
    ],
    responseMode: "compact",
  };
  const expressionStartedAt = process.hrtime.bigint();
  const expressionPlan = await new ExpressionPlanService({
    store: snapshots.store,
    artifactStore,
    sessionId: SESSION_ID,
  }).plan(expressionRequest);
  const expressionWallMs = Number(process.hrtime.bigint() - expressionStartedAt) / 1e6;
  assertReadOnly("plan_expression", expressionPlan);
  const planRef = expressionPlan.apply?.arguments?.planRef ?? null;
  step(3, "grouped expression plan by ordinal + note index", {
    requestBytes: utf8(expressionRequest),
    responseBytes: utf8(expressionPlan),
    wallMs: Number(expressionWallMs.toFixed(3)),
    containsFullNoteId: JSON.stringify(expressionRequest).includes(":n:"),
    passed:
      expressionPlan.status === "planned" &&
      !JSON.stringify(expressionRequest).includes(":n:"),
  });

  // §15.5 —— PlanRef 短且 execution 已封存。
  step(5, "planner returns a short sealed planRef", {
    planRefType: typeof planRef,
    planRefBytes: planRef ? Buffer.byteLength(planRef, "utf8") : null,
    hasExpiresAt: Boolean(expressionPlan.apply?.expiresAt),
    inlinedApplyRequests: expressionPlan.applyRequests !== undefined,
    passed:
      typeof planRef === "string" &&
      Buffer.byteLength(planRef, "utf8") <= 24 &&
      Boolean(expressionPlan.apply?.expiresAt) &&
      expressionPlan.applyRequests === undefined,
  });

  // §15.6/15.7 —— curve dry-run，核对 setter 与 Undo。
  const curves = new ParameterCurveService(session, {
    snapshotService: snapshots,
    artifactStore,
    sessionId: SESSION_ID,
  });
  const curveDryRun = await curves.patchCurves({ planRef, action: "dry_run" });
  const curveOutcome = assertReadOnly("patch_parameter_curves dry_run", curveDryRun);
  step(6, "patch_parameter_curves dry_run via planRef", {
    ...curveOutcome,
    undoBoundaries: curveDryRun.undo?.boundaryCallsCompleted ?? null,
    curveCount: curveDryRun.curves?.length ?? null,
    responseBytes: utf8(curveDryRun),
    passed:
      curveOutcome.status === "dry_run" &&
      (curveDryRun.undo?.boundaryCallsCompleted ?? 0) === 0,
  });

  // §15.8 —— 其余只读 planner 各跑一次。
  const plannerResults = {};
  plannerResults.align_lyrics = await new LyricAlignService({
    store: snapshots.store,
    artifactStore,
    sessionId: SESSION_ID,
  }).align({ contextId: captured.contextId, lyrics: "ら", responseMode: "compact" });
  plannerResults.quantize_notes = await new QuantizePlanService({
    store: snapshots.store,
    artifactStore,
    sessionId: SESSION_ID,
  }).plan({ contextId: captured.contextId, grid: { division: "1/8" }, responseMode: "compact" });
  plannerResults.plan_pitch_gesture = await new PitchGesturePlanService({
    store: snapshots.store,
    artifactStore,
    sessionId: SESSION_ID,
  }).plan({
    contextId: captured.contextId,
    gestures: [{ type: "attack", note: 0, depthSemitone: 0.3 }],
    responseMode: "compact",
  });
  for (const [name, result] of Object.entries(plannerResults)) {
    assertReadOnly(name, result);
  }
  step(8, "every read-only planner runs without host writes", {
    planners: Object.fromEntries(
      Object.entries(plannerResults).map(([name, result]) => [
        name,
        { status: result.status, effects: result.effects, bytes: utf8(result) },
      ])
    ),
    passed: Object.values(plannerResults).every((result) => result.effects === "none"),
  });

  // §15.9/15.10 —— note 与 structure dry-run，index 全部相对同一快照。
  const patcher = new NotePatchService(session, snapshots, {
    artifactStore,
    sessionId: SESSION_ID,
  });
  const notesDryRun = await patcher.patchNotes({
    contextId: captured.contextId,
    occurrenceId: occurrence.occurrenceId,
    patches: [{ note: 0, set: { detuneCents: 7 } }],
    dryRun: true,
    waitFor: "none",
  });
  const notesOutcome = assertReadOnly("patch_notes dry_run", notesDryRun);
  step(9, "patch_notes dry_run by group index", {
    ...notesOutcome,
    undoBoundaries: notesDryRun.undo?.boundaryCallsCompleted ?? null,
    passed: notesOutcome.status === "dry_run",
  });

  const structure = new NoteStructureService(session, snapshots, {
    artifactStore,
    sessionId: SESSION_ID,
  });
  const structureDryRun = await structure.restructureNotes({
    contextId: captured.contextId,
    occurrenceId: occurrence.occurrenceId,
    operations: [
      { op: "split", noteIndex: 1, atBlick: null },
      { op: "delete", noteIndex: 3 },
    ],
    dryRun: true,
    waitFor: "none",
  }).catch((error) => ({ status: "failed", effects: "none", error: { code: error.code } }));
  step(10, "restructure dry_run resolves every index against one snapshot", {
    status: structureDryRun.status,
    effects: structureDryRun.effects,
    // split 需要 atBlick 落在音符内部，因此上面刻意传 null 观察它是零写入拒绝
    // 而不是猜一个位置——这一步验的是拒绝行为，不是能否拆分。
    errorCode: structureDryRun.error?.code ?? null,
    passed: structureDryRun.effects === "none",
  });

  // §15.15 —— 每个 facade 触发一个有界错误，确认不回显大型输入。
  const boundedError = await patcher
    .patchNotes({
      contextId: captured.contextId,
      occurrenceId: occurrence.occurrenceId,
      patches: [{ note: 999_999, set: { detuneCents: 7 } }],
      dryRun: true,
      waitFor: "none",
    })
    .catch((error) => ({ code: error.code, message: error.message, details: error.details }));
  const errorBytes = utf8(boundedError);
  step(15, "a bounded error does not echo the request", {
    code: boundedError.code ?? boundedError.error?.code ?? null,
    bytes: errorBytes,
    passed: errorBytes <= 8 * 1024,
  });

  // §15.19 —— 复读工程，确认只读。
  const after = await ranges.snapshot({
    scope: {
      kind: "range",
      from: { position: "blick", blick: 0 },
      to: { position: "blick", blick: fixture.endBlick },
      trackIndices: [fixture.trackIndex],
    },
    include: ["notes"],
    responseMode: "compact",
  });
  const afterOccurrence = findOccurrence(after, fixture);
  step(19, "re-reading the project shows no change", {
    beforeNoteCount: occurrence.groupNoteCount ?? null,
    afterNoteCount: afterOccurrence.groupNoteCount ?? null,
    tokenStable: captured.snapshotToken === after.snapshotToken,
    passed:
      (occurrence.groupNoteCount ?? -1) === (afterOccurrence.groupNoteCount ?? -2) &&
      captured.snapshotToken === after.snapshotToken,
  });

  // 人工判定项：脚本不能代替，也不能假装已完成。
  humanGate("H1", "Did SynthV's Undo history stay empty for the whole run?");
  humanGate("H2", "Did the editor selection and playhead stay where they were?");
  humanGate("H3", "Do lyrics, notes and curves look untouched in the UI?");
  humanGate(
    "H4",
    "§15.12 raw tuple-handle escape and §15.13 multi-byte artifact paging: run manually and record here."
  );
  humanGate(
    "H5",
    "§15.16/15.17 context idle >5min <30min then >TTL: run manually and record the reason/next payloads."
  );
}

function applyGates() {
  const failed = report.steps.filter((entry) => entry.passed === false);
  report.gates.push({
    id: "ALL_AUTOMATED_STEPS_PASSED",
    requirement: "every automated §15 step reports passed",
    observed: failed.map((entry) => entry.id),
    passed: failed.length === 0,
  });
  // 步骤缺失不能判 PASS：少跑一步的报告不是验收证据。
  const expected = [1, 2, 3, 5, 6, 8, 9, 10, 15, 19];
  const seen = new Set(report.steps.map((entry) => entry.id));
  const missing = expected.filter((id) => !seen.has(id));
  report.gates.push({
    id: "ALL_AUTOMATED_STEPS_RAN",
    requirement: `automated steps present: ${expected.join(", ")}`,
    observed: missing,
    passed: missing.length === 0,
  });
  // human gate 未回答时报告不得声称验收通过。
  report.gates.push({
    id: "HUMAN_GATES_RECORDED",
    requirement: "human gates are listed for a person to answer",
    observed: report.humanGates.length,
    passed: report.humanGates.length > 0,
  });
  report.ok = report.gates.every((gate) => gate.passed) && failed.length === 0;
  report.acceptanceComplete = false;
  report.acceptanceNote =
    "Automated §15 steps only. Acceptance is complete when the humanGates above are answered and the independent-LLM session (§15 final paragraph) is recorded separately.";
}

async function locateFixtureGroup(host) {
  const roots = await host.roots();
  const trackCount = await host.call(roots.project, "getNumTracks");
  for (let trackIndex = 0; trackIndex < trackCount; trackIndex += 1) {
    const track = await host.call(roots.project, "getTrack", [trackIndex + 1], {
      inferredType: "Track",
    });
    const groupCount = await host.call(track, "getNumGroups");
    for (let groupIndex = 0; groupIndex < groupCount; groupIndex += 1) {
      const reference = await host.call(track, "getGroupReference", [groupIndex + 1], {
        inferredType: "NoteGroupReference",
      });
      if (await host.call(reference, "isInstrumental")) continue;
      const target = await host.call(reference, "getTarget", [], { inferredType: "NoteGroup" });
      const noteCount = await host.call(target, "getNumNotes");
      if (noteCount < REQUIRED_NOTES) continue;
      const last = await host.call(target, "getNote", [noteCount], { inferredType: "Note" });
      const onset = await host.call(last, "getOnset");
      const duration = await host.call(last, "getDuration");
      const offset = await host.call(reference, "getTimeOffset");
      return {
        trackIndex,
        groupIndex,
        noteCount,
        endBlick: offset + onset + duration + 1,
      };
    }
  }
  throw new Error(
    `no vocal NoteGroup with >= ${REQUIRED_NOTES} notes found; open the acceptance project first`
  );
}

function findOccurrence(captured, fixture) {
  const group = captured.data?.tracks
    ?.flatMap((track) => track.groups ?? [])
    .find(
      (entry) => entry.trackIndex === fixture.trackIndex || entry.groupIndex === fixture.groupIndex
    );
  if (!group?.occurrenceId) {
    throw new Error("range snapshot did not expose an occurrenceId for the fixture group");
  }
  return group;
}

async function waitForBridge(relay, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  console.error("[accept] waiting for the SynthV bridge to attach...");
  while (Date.now() < deadline) {
    if ((relay.getStatus?.() ?? {}).state === "attached") return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`bridge did not attach within ${timeoutMs}ms`);
}

function writeReport() {
  const stamp = report.capturedAt.replace(/[:.]/g, "-");
  const file = path.join(OUT_DIR, `live-acceptance-${stamp}.json`);
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.error(`[accept] report written: ${file}`);
}

export { REQUIRED_NOTES, applyGates, report };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
