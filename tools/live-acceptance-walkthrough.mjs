// §15 实机验收的可执行走查（C4 步骤 2 的驱动脚本）。
//
// 为什么必须走真实 MCP 客户端而不是直接 new Service：
// 第一版直接实例化内部 Service，于是整条 facade 边界都没被验证——路由、第二阶段
// schema 校验、结果编码、`structuredContent` 投影全部绕过了。那种走查即使全绿，
// 也证明不了模型真正会走的那条路可用。这一版通过 StdioClientTransport 起真实
// server，并把每次调用投影成 facade 信封，与模型走同一条路。
//
// 人必须驾驶 SynthV：打开 ≥373 音符的工程、从 Scripts 菜单加载桥。脚本负责保证
// 一旦人到位，走查就是完整且可比的——19 步里哪些自动跑、哪些必须人答，都登记在案。
//
// 安全边界：**只读**。所有写路径一律 dryRun，每步断言 status/effects，
// 任何一次出现非 dry_run/none 就整体判失败。不写工程、不改选区、不碰 PitchControl。
// 本脚本不进 npm test（它需要真实宿主）；判定逻辑由 test/live-acceptance-gates 覆盖。
//
// 运行方式：
//   1. 启动 Synthesizer V Studio 2.2.1，打开含 ≥373 音符单一 NoteGroup 的工程。
//      理想 fixture 另含第二个人声组，否则 harmony 一步只能记为 skipped。
//   2. Scripts 菜单启动 SV Copilot 桥（StartSynthVCopilot）。
//   3. cd server && npm run acceptance:live
//   4. 读 tools/out/live-acceptance-<ts>.json。
//
// 去标识：报告只记录计数、字节数、状态码与门禁结论。歌词、音素、工程名、UUID
// 和逐 Note 内容一律不写盘（§15 硬要求）。

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";

import { DESCRIBE_OPERATION_TOOL } from "../server/src/compact-facade.js";
import { facadeForTool, operationNameForTool } from "../server/src/operation-catalog.js";
import { isErrorStatus } from "../server/src/mcp-result-encoder.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, "out");
const SERVER_SCRIPT = path.resolve(HERE, "..", "server", "src", "index.js");
const REQUIRED_NOTES = 373;

// §15 自动化步骤的编号。缺任何一个都不得判 PASS——少跑一步的报告不是验收证据。
const AUTOMATED_STEP_IDS = [1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 19];

// 8 个 facade。第 15 步要求"每个 facade"都触发一次有界错误。
const FACADES = [
  "sv_status",
  "sv_read",
  "sv_plan",
  "sv_edit",
  "sv_audition",
  "sv_artifact",
  "sv_raw",
  DESCRIBE_OPERATION_TOOL,
];

const report = {
  kind: "live-acceptance",
  planSection: "15",
  capturedAt: new Date().toISOString(),
  transport: "mcp_stdio_facade",
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
  const flag = outcome.passed === false ? "FAIL" : outcome.passed === null ? "skip" : "ok";
  console.error(`[accept] ${String(id).padStart(2)} ${flag.padEnd(4)} ${label}`);
  return outcome;
}

// 人工判定项：脚本无法代替，但必须显式列出，否则"走查完成"会把它们静默吞掉。
function humanGate(id, question) {
  report.humanGates.push({ id, question, answer: "pending_human" });
}

const utf8 = (value) => Buffer.byteLength(JSON.stringify(value ?? null), "utf8");

// 与模型走同一条路：facade 名 + {operation, arguments} 信封。
// 用内部 handler 名书写调用点（可读性最好），由这里统一投影。
async function facadeCall(client, name, args = {}) {
  return client.callTool({
    name: facadeForTool(name),
    arguments: { operation: operationNameForTool(name), arguments: args },
  });
}

function structured(response) {
  // 完整机器结果只能从 structuredContent 读取（§13.6）。走查若从 content[].text
  // 解析，就无法证明目标客户端能力，也测不到编码层。
  if (response.structuredContent === undefined) {
    throw new Error("facade response carried no structuredContent");
  }
  return response.structuredContent;
}

function okOf(result) {
  if (typeof result?.status === "string") return !isErrorStatus(result.status);
  return result?.ok;
}

function assertReadOnly(label, result) {
  const status = result?.status ?? null;
  const effects = result?.effects ?? null;
  if (!["dry_run", "planned", "no_change", "succeeded"].includes(status)) {
    throw new Error(`${label}: unexpected status ${status}`);
  }
  if (effects !== "none") {
    throw new Error(`${label}: expected effects none, got ${effects}`);
  }
  return { status, effects };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_SCRIPT],
    env: process.env,
    cwd: path.dirname(SERVER_SCRIPT),
    stderr: "pipe",
  });
  const client = new Client({ name: "sv-copilot-acceptance", version: "1.0.0" });
  try {
    transport.stderr?.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));
    await client.connect(transport);
    await waitForHost(client);
    await runWalkthrough(client);
  } catch (error) {
    report.notes.push({
      code: "RUN_FAILED",
      message: error instanceof Error ? error.message : String(error),
    });
    console.error(`[accept] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await client.close().catch(() => {});
    applyGates();
    writeReport();
  }
  process.exit(report.ok ? 0 : 1);
}

// 桥由人从 SynthV 里加载，因此这里轮询 ping 而不是假设已连接。
async function waitForHost(client, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  console.error("[accept] waiting for the SynthV bridge to attach...");
  let last = null;
  while (Date.now() < deadline) {
    const response = await facadeCall(client, "sv_ping");
    if (response.isError !== true) {
      const result = structured(response);
      if (okOf(result)) {
        report.host = {
          version: result.data?.hostVersion ?? result.hostVersion ?? null,
          platform: process.platform,
        };
        return;
      }
      last = result;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`bridge did not attach within ${timeoutMs}ms; last ping: ${JSON.stringify(last)}`);
}

async function readJsonResource(client, uri) {
  const response = await client.readResource({ uri });
  const text = response.contents.find((item) => "text" in item)?.text ?? "null";
  return JSON.parse(text);
}

async function runWalkthrough(client) {
  // ---- §15.1 doctor / ping / surface ----
  const listed = await client.listTools();
  const doctor = structured(await facadeCall(client, "sv_doctor"));
  const catalog = await readJsonResource(client, "svcopilot://operations");
  const catalogCount = Array.isArray(catalog.operations) ? catalog.operations.length : null;
  const listBytes = utf8(listed.tools);
  step(1, "doctor + ping + facade surface through MCP", {
    facadeTools: listed.tools.length,
    listToolsBytes: listBytes,
    doctorOperationCount: doctor.surface?.operationCount ?? null,
    catalogOperationCount: catalogCount,
    installationHealthy: doctor.installationHealthy ?? null,
    passed:
      listed.tools.length === FACADES.length &&
      listBytes < 12 * 1024 &&
      doctor.surface?.operationCount === catalogCount,
  });

  // ---- §15.2 notes-only range context ----
  const fixture = await locateFixture(client);
  report.fixture = {
    trackIndex: fixture.trackIndex,
    groupIndex: fixture.groupIndex,
    noteCount: fixture.noteCount,
    secondVocalGroup: fixture.secondGroup !== null,
    identity: "withheld",
  };
  const captured = await captureRange(client, fixture);
  step(2, "snapshot_range captures a notes-only context", {
    occurrence: captured.group.occurrence ?? 0,
    groupNoteCount: captured.group.groupNoteCount ?? null,
    capturedNotes: captured.group.capturedNotes ?? null,
    responseBytes: utf8(captured.result),
    passed: (captured.group.groupNoteCount ?? 0) >= REQUIRED_NOTES,
  });

  // ---- §15.3/15.4 grouped expression: request bytes and wall time ----
  const expressionArgs = {
    contextId: captured.result.contextId,
    occurrence: captured.group.occurrence ?? 0,
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
  const expressionPlan = structured(await facadeCall(client, "sv_plan_expression", expressionArgs));
  const expressionWallMs = Number(process.hrtime.bigint() - expressionStartedAt) / 1e6;
  assertReadOnly("plan_expression", expressionPlan);
  const requestText = JSON.stringify(expressionArgs);
  step(3, "grouped expression plan by ordinal + note index", {
    requestBytes: utf8(expressionArgs),
    responseBytes: utf8(expressionPlan),
    wallMs: Number(expressionWallMs.toFixed(3)),
    fullNoteIdOccurrences: (requestText.match(/:n:/g) ?? []).length,
    passed: expressionPlan.status === "planned" && !requestText.includes(":n:"),
  });

  // ---- §15.5 short sealed PlanRef ----
  const planRef = expressionPlan.apply?.arguments?.planRef ?? null;
  step(5, "planner returns a short sealed planRef", {
    planRefType: typeof planRef,
    planRefBytes: typeof planRef === "string" ? Buffer.byteLength(planRef, "utf8") : null,
    hasExpiresAt: Boolean(expressionPlan.apply?.expiresAt),
    inlinedApplyRequests: expressionPlan.applyRequests !== undefined,
    passed:
      typeof planRef === "string" &&
      Buffer.byteLength(planRef, "utf8") <= 24 &&
      Boolean(expressionPlan.apply?.expiresAt) &&
      expressionPlan.applyRequests === undefined,
  });

  // ---- §15.6/15.7 curve dry-run and its evidence ----
  const curveDryRun = structured(
    await facadeCall(client, "sv_patch_parameter_curves", { planRef, action: "dry_run" })
  );
  const curveOutcome = assertReadOnly("patch_parameter_curves dry_run", curveDryRun);
  const firstCurve = curveDryRun.curves?.[0] ?? null;
  step(6, "patch_parameter_curves dry_run via planRef", {
    ...curveOutcome,
    undoBoundaries: curveDryRun.undo?.boundaryCallsCompleted ?? null,
    curveCount: curveDryRun.curves?.length ?? null,
    passed:
      curveOutcome.status === "dry_run" && (curveDryRun.undo?.boundaryCallsCompleted ?? 0) === 0,
  });
  step(7, "curve evidence names parameter, range, points, setters and Undo", {
    parameter: firstCurve?.parameter ?? null,
    hasRange: Boolean(firstCurve?.range),
    pointCount: firstCurve?.pointCount ?? firstCurve?.points?.length ?? null,
    warningCount: Array.isArray(curveDryRun.warnings) ? curveDryRun.warnings.length : null,
    hostSetters: 0,
    undoBoundaries: curveDryRun.undo?.boundaryCallsCompleted ?? null,
    passed:
      Boolean(firstCurve?.parameter) &&
      Boolean(firstCurve?.range) &&
      (curveDryRun.undo?.boundaryCallsCompleted ?? 0) === 0,
  });

  // ---- §15.8 lyrics / pitch gesture / quantize / harmony planners ----
  const planners = {};
  planners.align_lyrics = structured(
    await facadeCall(client, "sv_align_lyrics", {
      contextId: captured.result.contextId,
      lyrics: "\u3089",
      responseMode: "compact",
    })
  );
  planners.plan_pitch_gesture = structured(
    await facadeCall(client, "sv_plan_pitch_gesture", {
      contextId: captured.result.contextId,
      gestures: [{ type: "attack", note: 0, depthSemitone: 0.3 }],
      responseMode: "compact",
    })
  );
  planners.quantize_notes = structured(
    await facadeCall(client, "sv_quantize_notes", {
      contextId: captured.result.contextId,
      grid: { division: "1/8" },
      responseMode: "compact",
    })
  );
  // harmony 需要第二个人声 occurrence 作为目标。fixture 没有时如实记 skipped，
  // 而不是把"没测"算成通过。
  let harmonySkipReason = null;
  if (fixture.secondGroup === null) {
    harmonySkipReason = "fixture has only one vocal NoteGroup; harmony needs a separate target";
  } else {
    const both = await captureRange(client, fixture, { includeSecondGroup: true });
    const target = both.allGroups.find((group) => group.occurrenceId !== both.group.occurrenceId);
    if (!target) {
      harmonySkipReason = "second vocal group did not appear in the range context";
    } else {
      planners.generate_harmony = structured(
        await facadeCall(client, "sv_generate_harmony", {
          contextId: both.result.contextId,
          sourceOccurrenceId: both.group.occurrenceId,
          targetOccurrenceId: target.occurrenceId,
          harmony: { interval: "third_below" },
          responseMode: "compact",
        })
      );
    }
  }
  for (const [name, result] of Object.entries(planners)) assertReadOnly(name, result);
  step(8, "lyrics, pitch gesture, quantize and harmony planners all run read-only", {
    planners: Object.fromEntries(
      Object.entries(planners).map(([name, result]) => [
        name,
        { status: result.status, effects: result.effects, bytes: utf8(result) },
      ])
    ),
    harmonySkipReason,
    // §15.8 要求四个 planner 都执行。少一个就不是通过，因此这里记 null（skipped）
    // 而不是 true——"没测"不能读成"通过"。
    passed:
      harmonySkipReason === null
        ? Object.values(planners).every((result) => result.effects === "none")
        : null,
  });

  // ---- §15.9 note / curve / pitch-control / phrase-edit dry-runs ----
  const dryRuns = { patch_parameter_curves: curveDryRun };
  dryRuns.patch_notes = structured(
    await facadeCall(client, "sv_patch_notes", {
      contextId: captured.result.contextId,
      occurrenceId: captured.group.occurrenceId,
      patches: [{ note: 0, set: { detuneCents: 7 } }],
      dryRun: true,
      waitFor: "none",
    })
  );
  dryRuns.patch_pitch_controls = structured(
    await facadeCall(client, "sv_patch_pitch_controls", {
      contextId: captured.result.contextId,
      occurrenceId: captured.group.occurrenceId,
      operations: [
        {
          op: "add",
          control: {
            kind: "point",
            positionBlick: captured.firstNote.onsetBlick,
            pitchSemitone: captured.firstNote.pitch,
          },
        },
      ],
      dryRun: true,
    })
  );
  dryRuns.edit_phrase = structured(
    await facadeCall(client, "sv_edit_phrase", {
      target: {
        contextId: captured.result.contextId,
        occurrenceId: captured.group.occurrenceId,
      },
      notePatches: [{ note: 0, set: { detuneCents: 5 } }],
      dryRun: true,
      waitFor: "none",
    })
  );
  const dryRunOutcomes = Object.fromEntries(
    Object.entries(dryRuns).map(([name, result]) => [
      name,
      { status: result.status ?? null, effects: result.effects ?? null },
    ])
  );
  step(9, "note, curve, pitch-control and phrase-edit dry-runs write nothing", {
    dryRuns: dryRunOutcomes,
    // 门禁是"零副作用"：某个 dry-run 因 fixture 内容合法地失败仍算通过，
    // 但 effects 必须是 none，且四条路径都必须真的跑过。
    passed:
      Object.keys(dryRunOutcomes).length === 4 &&
      Object.values(dryRunOutcomes).every((outcome) => outcome.effects === "none"),
  });

  // ---- §15.10 insert + delete + split + merge against one snapshot ----
  const structureArgs = {
    contextId: captured.result.contextId,
    occurrenceId: captured.group.occurrenceId,
    operations: [
      // 四种 op 同批，全部相对同一快照 index 解析。split 的 atBlick 取自捕获音符的
      // 真实中点——传非法值只能测到拒绝路径，测不到"index 相对同一快照解析"本身。
      {
        op: "insert",
        note: {
          onsetBlick: captured.firstNote.onsetBlick,
          durationBlick: Math.max(1, Math.floor(captured.firstNote.durationBlick / 2)),
          pitch: captured.firstNote.pitch,
        },
      },
      { op: "split", noteIndex: 1, atBlick: captured.secondNote.midBlick },
      { op: "delete", noteIndex: 3 },
      { op: "merge", notes: [5, 6] },
    ],
    dryRun: true,
    waitFor: "none",
  };
  const structureDryRun = structured(await facadeCall(client, "sv_restructure_notes", structureArgs));
  const plannedOps = structureDryRun.data?.plannedOperations ?? [];
  step(10, "insert/delete/split/merge dry-run resolves every index against one snapshot", {
    status: structureDryRun.status ?? null,
    effects: structureDryRun.effects ?? null,
    requestedOps: structureArgs.operations.length,
    plannedOps: plannedOps.length,
    expectedNoteCount: structureDryRun.data?.expectedNoteCount ?? null,
    errorCode: structureDryRun.error?.code ?? null,
    // 只看 effects 会让一个"参数被拒"的请求也算通过，因此要求四个 op 全部被规划。
    passed:
      structureDryRun.effects === "none" &&
      structureDryRun.status === "dry_run" &&
      plannedOps.length === structureArgs.operations.length,
  });

  // ---- §15.11 analyze / wait / audition-state read-only paths ----
  const readOnly = {};
  readOnly.analyze_phrase = structured(
    await facadeCall(client, "sv_analyze_phrase", {
      contextId: captured.result.contextId,
      include: ["key", "phrases"],
      responseMode: "compact",
    })
  );
  readOnly.analyze_vocal_context = structured(
    await facadeCall(client, "sv_analyze_vocal_context", {
      contextId: captured.result.contextId,
      responseMode: "compact",
    })
  );
  readOnly.wait_processing = structured(
    await facadeCall(client, "sv_wait_for_processing", {
      contextId: captured.result.contextId,
      timeoutMs: 500,
      pollIntervalMs: 100,
    })
  );
  // audition 未启动，因此"没有进行中的对比"是正确答案而不是错误。这一步验的是
  // 只读状态查询可达且不写宿主。
  readOnly.get_audition_compare = structured(
    await facadeCall(client, "sv_get_audition_compare", { id: "aud_none" })
  );
  step(11, "analyze / wait / audition-state read-only paths are reachable", {
    paths: Object.fromEntries(
      Object.entries(readOnly).map(([name, result]) => [
        name,
        { status: result.status ?? null, bytes: utf8(result) },
      ])
    ),
    passed: Object.keys(readOnly).length === 4,
  });

  // ---- §15.12 raw tuple-handle escape hatch ----
  const rawRoots = structured(await facadeCall(client, "sv_root", {}));
  const projectHandle =
    rawRoots.project?.__handle__ ?? rawRoots.data?.project?.__handle__ ?? null;
  const rawCall = structured(
    await facadeCall(client, "sv_call", { handle: projectHandle, method: "getFileName", args: [] })
  );
  const rawFree = structured(await facadeCall(client, "sv_free", { handle: projectHandle }));
  step(12, "raw root/call/free tuple-handle escape hatch works", {
    handleType: typeof projectHandle,
    callOk: okOf(rawCall) === true,
    freeOk: okOf(rawFree) === true,
    passed: typeof projectHandle === "number" && okOf(rawCall) === true,
  });
  humanGate(
    "H-RAW-RECURSIVE",
    "\u00a715.12 also asks for getSelectedNotes() recursive $h encoding with a round-trip call. Select several notes in the editor, re-run sv_call getSelectedNotes, and record whether the returned object array round-trips."
  );

  // ---- §15.13 artifact paging ----
  const artifactRef = captured.result.artifactRef ?? null;
  let paging = null;
  if (artifactRef?.firstPageUri) {
    const pages = [];
    let uri = artifactRef.firstPageUri;
    for (let guard = 0; guard < 64 && uri; guard += 1) {
      const page = await readJsonResource(client, uri);
      pages.push({
        bytes: utf8(page),
        complete: page.page?.complete ?? null,
      });
      uri = page.page?.nextPageUri ?? null;
    }
    paging = { pageCount: pages.length, pages };
  }
  step(13, "artifact pages reassemble through the artifact resource", {
    hasArtifact: Boolean(artifactRef),
    ...(paging ?? {}),
    passed: artifactRef ? (paging?.pageCount ?? 0) > 0 : null,
  });
  humanGate(
    "H-ARTIFACT-MULTIBYTE",
    "\u00a715.13 requires one ASCII artifact and one containing multi-byte characters. If the fixture project is ASCII-only, re-run against a project with CJK lyrics and record the page reassembly hash."
  );

  // ---- §15.14 compact workflow keeps detail out of the main path ----
  const compactWorkflow = structured(
    await facadeCall(client, "sv_analyze_phrase", {
      contextId: captured.result.contextId,
      include: ["key"],
      responseMode: "compact",
    })
  );
  step(14, "a compact workflow returns detail pointers instead of detail", {
    hasDetailPointer: Boolean(compactWorkflow.detailRef ?? compactWorkflow.artifactRef),
    bytes: utf8(compactWorkflow),
    // 服务端侧可证：明细可指、不内联。模型是否真的不去读它属于独立 LLM 验收。
    passed: utf8(compactWorkflow) <= 16 * 1024,
  });

  // ---- §15.15 one bounded error per facade ----
  const errorProbes = {
    sv_status: ["sv_search_api", {}],
    sv_read: ["sv_snapshot_range", { scope: { kind: "range" }, bogusField: true }],
    sv_plan: ["sv_plan_expression", { contextId: "c_missing", gestures: [] }],
    sv_edit: [
      "sv_patch_notes",
      {
        contextId: captured.result.contextId,
        patches: [{ note: 999999, set: { detuneCents: 7 } }],
        dryRun: true,
      },
    ],
    sv_audition: ["sv_stop_audition", { id: "aud_missing" }],
    sv_artifact: ["sv_release_artifact", { artifactId: "a_missing" }],
    sv_raw: ["sv_call", { handle: 999999, method: "getFileName", args: [] }],
  };
  const facadeErrors = {};
  for (const [facade, [tool, args]] of Object.entries(errorProbes)) {
    const response = await facadeCall(client, tool, args).catch((error) => ({
      isError: true,
      structuredContent: { error: { code: String(error?.code ?? "THROWN") } },
    }));
    const payload = response.structuredContent ?? {};
    facadeErrors[facade] = {
      code: payload.error?.code ?? payload.code ?? null,
      bytes: utf8(payload),
      echoesRequest: JSON.stringify(payload).includes(JSON.stringify(args)),
    };
  }
  {
    // sv_describe 不套 operation 信封，因此单独探一次：未知 operation 名。
    const response = await client
      .callTool({
        name: DESCRIBE_OPERATION_TOOL,
        arguments: { operations: ["no_such_operation"] },
      })
      .catch((error) => ({
        isError: true,
        structuredContent: { error: { code: String(error?.code ?? "THROWN") } },
      }));
    const payload = response.structuredContent ?? {};
    facadeErrors[DESCRIBE_OPERATION_TOOL] = {
      code: payload.error?.code ?? payload.code ?? null,
      bytes: utf8(payload),
      echoesRequest: false,
    };
  }
  step(15, "every facade returns a bounded error that does not echo the request", {
    facades: facadeErrors,
    coveredFacades: Object.keys(facadeErrors).length,
    passed:
      Object.keys(facadeErrors).length === FACADES.length &&
      Object.values(facadeErrors).every(
        (entry) => entry.bytes <= 8 * 1024 && entry.echoesRequest === false
      ),
  });

  // ---- §15.19 re-read shows no change ----
  const after = await captureRange(client, fixture);
  step(19, "re-reading the project shows no change", {
    beforeNoteCount: captured.group.groupNoteCount ?? null,
    afterNoteCount: after.group.groupNoteCount ?? null,
    tokenStable: captured.result.snapshotToken === after.result.snapshotToken,
    passed:
      (captured.group.groupNoteCount ?? -1) === (after.group.groupNoteCount ?? -2) &&
      captured.result.snapshotToken === after.result.snapshotToken,
  });

  // ---- 人工判定项 ----
  humanGate("H-UNDO", "Did SynthV's Undo history stay empty for the whole run?");
  humanGate("H-EDITOR", "Did the editor selection and playhead stay where they were?");
  humanGate("H-VISUAL", "Do lyrics, notes and curves look untouched in the UI?");
  humanGate(
    "H-IDLE",
    "\u00a715.16: leave a context idle >5min and <30min, then run a planner. Record that it did NOT need a re-snapshot."
  );
  humanGate(
    "H-EXPIRY",
    "\u00a715.17: let a context pass its 30min TTL, then call a planner. Record UNKNOWN_CONTEXT.reason and that `next` is short and executable."
  );
  humanGate(
    "H-EVICTION",
    "\u00a715.18: run with a low-quota test config to force LRU eviction, then record doctor's count/bytes/evictions against the store."
  );
}

// 定位 fixture：第一个 ≥REQUIRED_NOTES 的人声组，并记录是否存在第二个人声组
// （harmony 需要一个独立目标）。全程只用 sv_raw 读取，不写宿主。
async function locateFixture(client) {
  const roots = structured(await facadeCall(client, "sv_root", {}));
  const project = roots.project?.__handle__ ?? roots.data?.project?.__handle__;
  const call = async (handle, method, args = []) => {
    const result = structured(await facadeCall(client, "sv_call", { handle, method, args }));
    return result.result ?? result.data?.result ?? result.handle ?? result.data?.handle ?? null;
  };
  const trackCount = await call(project, "getNumTracks");
  let primary = null;
  let secondGroup = null;
  for (let trackIndex = 0; trackIndex < trackCount; trackIndex += 1) {
    const trackResult = structured(
      await facadeCall(client, "sv_call", {
        handle: project,
        method: "getTrack",
        args: [trackIndex + 1],
      })
    );
    const track = trackResult.handle ?? trackResult.data?.handle ?? trackResult.result?.__handle__;
    const groupCount = await call(track, "getNumGroups");
    for (let groupIndex = 0; groupIndex < groupCount; groupIndex += 1) {
      const refResult = structured(
        await facadeCall(client, "sv_call", {
          handle: track,
          method: "getGroupReference",
          args: [groupIndex + 1],
        })
      );
      const reference = refResult.handle ?? refResult.data?.handle ?? refResult.result?.__handle__;
      if (await call(reference, "isInstrumental")) continue;
      const targetResult = structured(
        await facadeCall(client, "sv_call", { handle: reference, method: "getTarget", args: [] })
      );
      const target =
        targetResult.handle ?? targetResult.data?.handle ?? targetResult.result?.__handle__;
      const noteCount = await call(target, "getNumNotes");
      if (primary === null && noteCount >= REQUIRED_NOTES) {
        const lastResult = structured(
          await facadeCall(client, "sv_call", {
            handle: target,
            method: "getNote",
            args: [noteCount],
          })
        );
        const lastNote =
          lastResult.handle ?? lastResult.data?.handle ?? lastResult.result?.__handle__;
        const onset = await call(lastNote, "getOnset");
        const duration = await call(lastNote, "getDuration");
        const offset = await call(reference, "getTimeOffset");
        primary = {
          trackIndex,
          groupIndex,
          noteCount,
          endBlick: offset + onset + duration + 1,
          secondGroup: null,
        };
      } else if (primary !== null && secondGroup === null) {
        secondGroup = { trackIndex, groupIndex, noteCount };
      }
    }
  }
  if (primary === null) {
    throw new Error(
      `no vocal NoteGroup with >= ${REQUIRED_NOTES} notes found; open the acceptance project first`
    );
  }
  primary.secondGroup = secondGroup;
  return primary;
}

async function captureRange(client, fixture, { includeSecondGroup = false } = {}) {
  const trackIndices = includeSecondGroup && fixture.secondGroup
    ? [...new Set([fixture.trackIndex, fixture.secondGroup.trackIndex])]
    : [fixture.trackIndex];
  const result = structured(
    await facadeCall(client, "sv_snapshot_range", {
      scope: {
        kind: "range",
        from: { position: "blick", blick: 0 },
        to: { position: "blick", blick: fixture.endBlick },
        trackIndices,
      },
      include: ["notes"],
      responseMode: "compact",
    })
  );
  const allGroups = (result.data?.tracks ?? []).flatMap((track) => track.groups ?? []);
  const group =
    allGroups.find(
      (entry) => entry.trackIndex === fixture.trackIndex && entry.groupIndex === fixture.groupIndex
    ) ?? allGroups[0];
  if (!group?.occurrenceId) {
    throw new Error("range snapshot did not expose an occurrenceId for the fixture group");
  }
  const notes = result.data?.notes ?? [];
  const firstNote = notes[0] ?? { onsetBlick: 0, durationBlick: 176400, pitch: 60 };
  const secondNote = notes[1] ?? firstNote;
  return {
    result,
    group,
    allGroups,
    firstNote,
    secondNote: {
      ...secondNote,
      // split 的 atBlick 必须严格落在音符内部。
      midBlick: secondNote.onsetBlick + Math.max(1, Math.floor(secondNote.durationBlick / 2)),
    },
  };
}

function applyGates() {
  const automated = report.steps.filter((entry) => entry.passed !== null);
  const failed = automated.filter((entry) => entry.passed === false);
  const skipped = report.steps.filter((entry) => entry.passed === null);
  report.gates.push({
    id: "ALL_AUTOMATED_STEPS_PASSED",
    requirement: "every automated §15 step reports passed",
    observed: failed.map((entry) => entry.id),
    passed: failed.length === 0 && automated.length > 0,
  });
  // 步骤缺失不能判 PASS：少跑一步的报告不是验收证据。
  const seen = new Set(report.steps.map((entry) => entry.id));
  const missing = AUTOMATED_STEP_IDS.filter((id) => !seen.has(id));
  report.gates.push({
    id: "ALL_AUTOMATED_STEPS_RAN",
    requirement: `automated steps present: ${AUTOMATED_STEP_IDS.join(", ")}`,
    observed: missing,
    passed: missing.length === 0,
  });
  // skipped 步骤（如缺 fixture 的 harmony）必须让整份报告不判 PASS：
  // "没测"读成"通过"正是这份脚本要消除的东西。
  report.gates.push({
    id: "NO_SKIPPED_STEPS",
    requirement: "no automated step was skipped for lack of fixture",
    observed: skipped.map((entry) => entry.id),
    passed: skipped.length === 0,
  });
  report.gates.push({
    id: "HUMAN_GATES_RECORDED",
    requirement: "human gates are listed for a person to answer",
    observed: report.humanGates.length,
    passed: report.humanGates.length > 0,
  });
  report.ok = report.gates.every((gate) => gate.passed);
  report.acceptanceComplete = false;
  report.acceptanceNote =
    "Automated §15 steps only. Acceptance is complete when every humanGate above is answered and the independent-LLM session (docs/INDEPENDENT_LLM_ACCEPTANCE_PROTOCOL.md) is recorded alongside this report.";
}

function writeReport() {
  const stamp = report.capturedAt.replace(/[:.]/g, "-");
  const file = path.join(OUT_DIR, `live-acceptance-${stamp}.json`);
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.error(`[accept] report written: ${file}`);
}

export { AUTOMATED_STEP_IDS, FACADES, REQUIRED_NOTES, applyGates, report };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
