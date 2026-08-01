// SV Live Probe —— Phase 1 有界批量读取的真机性能测量（`live-perf` 门禁）。
//
// 为什么需要它：`test/bench-bulk-note-reads.mjs` 跑的是模拟宿主。它能证明 host-call 数
// 与契约行为，但产出的毫秒数毫无意义——模拟宿主的 getter 是内存查表，真机每次 getter
// 都是一次 IO PIPE 往返加一次 SynthV UI 线程调度。计划要求的 wall/service p50/p95
// 只能来自真机。
//
// 这个脚本把「除了人站在 SynthV 前面」以外的每一步都自动化：定位固定 Group、
// 预热、每场景 20 次、legacy 与 bulk 两路对照、计算分位数、按发布门禁逐条判定，
// 并写出可归档的报告。
//
// 运行方式（人驾驶真实 SynthV）：
//   1. 启动 Synthesizer V Studio 2.2.1，打开一个含 ≥373 音符单一 NoteGroup 的工程。
//      工程不会被修改——全部场景都是 dryRun，0 setter、0 Undo（脚本会断言这一点）。
//   2. 从 Scripts 菜单启动 SV Copilot 桥（StartSynthVCopilot）。
//   3. cd server && node ../tools/bench-live-bulk-reads.mjs
//   4. 读 tools/out/live-bulk-perf-<ts>.json，把 gate 结论抄进实施计划。
//
// 安全边界：**只读**。全部 patch 都是 `action: "dry_run"`，脚本在每次运行后断言宿主
// setter 与 Undo 计数为 0；任一场景出现非零就整体判失败并说明。不写工程、不改选区、
// 不碰 PitchControl。本脚本是测量工具，不进 npm test。

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { HostSession } from "../server/src/host-session.js";
import { PipeRelay } from "../server/src/transport-pipe.js";
import { NotePatchService } from "../server/src/note-patch.js";
import { RangeSnapshotService } from "../server/src/musical-range.js";
import { SnapshotService } from "../server/src/snapshot.js";
import { READ_NOTE_FINGERPRINTS_V1 } from "../server/src/note-fingerprint-reader.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, "out");

// 计划 §7 Phase 1「实机验收」固定的参数，不可由命令行放宽——
// 可调的门禁不是门禁。
const REQUIRED_NOTES = 373;
const ITERATIONS = 20;
const WARMUP = 3;

// 计划 §5.3 的实机基线（373-note、7 个分散 scoped patch、dry-run）。
const PLANNED_BASELINE = {
  scenario: "C",
  wallMs: 183,
  serviceTotalMs: 177,
  hostCalls: 86,
  fingerprintVerificationMs: 122,
};

const SCENARIOS = [
  { id: "A", label: "1 scoped patch", indices: () => [0] },
  { id: "B", label: "first 7", indices: () => [0, 1, 2, 3, 4, 5, 6] },
  {
    id: "C",
    label: "7 scattered",
    indices: (n) => spread(n, 7),
  },
  {
    id: "D",
    label: "200 dry-run",
    indices: (n) => Array.from({ length: Math.min(200, n) }, (_, i) => i),
  },
];

function spread(noteCount, count) {
  const step = Math.floor((noteCount - 1) / (count - 1));
  return Array.from({ length: count }, (_, i) => Math.min(noteCount - 1, i * step));
}

const report = {
  kind: "svcopilot-live-bulk-perf",
  schemaVersion: "1.0.0",
  // 这份报告的证据范围与离线基准截然不同,必须自带标记,防止被误引为对方。
  evidenceScope: "live_host",
  capturedAt: new Date().toISOString(),
  host: null,
  fixture: null,
  parameters: { requiredNotes: REQUIRED_NOTES, iterations: ITERATIONS, warmup: WARMUP },
  plannedBaseline: PLANNED_BASELINE,
  scenarios: [],
  gates: [],
  ok: false,
  notes: [],
};

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const relay = new PipeRelay({ timeoutMs: 30_000 });
  await relay.init();
  const host = new HostSession(relay);
  try {
    await waitForBridge(relay);
    await host.ping();
    const status = host.getStatus();
    report.host = {
      version: status.hostVersion ?? null,
      platform: process.platform,
      negotiatedOps: status.hostOps ?? [],
      supportsBulkOp: host.supportsOp(READ_NOTE_FINGERPRINTS_V1),
    };
    console.error(`[perf] connected; hostVersion=${report.host.version}`);

    if (!report.host.supportsBulkOp) {
      // 没有能力就没有 bulk 一侧的数据。不要产出一份只有 legacy 的"性能报告"。
      throw new Error(
        `the attached bridge does not declare ${READ_NOTE_FINGERPRINTS_V1}; load the current StartSynthVCopilot.lua before measuring`
      );
    }

    const fixture = await locateFixtureGroup(host);
    report.fixture = {
      trackIndex: fixture.trackIndex,
      groupIndex: fixture.groupIndex,
      noteCount: fixture.noteCount,
      // UUID、名称、歌词一概不写盘：报告要能直接归档。
      identity: "withheld",
    };
    console.error(
      `[perf] fixture track=${fixture.trackIndex} group=${fixture.groupIndex} notes=${fixture.noteCount}`
    );

    for (const scenario of SCENARIOS) {
      const indices = scenario.indices(fixture.noteCount);
      console.error(`[perf] scenario ${scenario.id} (${scenario.label}), ${indices.length} note(s)`);
      const modes = {};
      for (const mode of ["legacy", "bulk"]) {
        modes[mode] = await measureMode({ host, fixture, indices, useBulk: mode === "bulk" });
        const m = modes[mode];
        console.error(
          `    ${mode.padEnd(6)} wall p50=${m.wallMs.p50}ms p95=${m.wallMs.p95}ms  service p50=${m.serviceTotalMs.p50}ms  hostCalls=${m.hostCalls}`
        );
      }
      report.scenarios.push({
        id: scenario.id,
        label: scenario.label,
        targetNotes: indices.length,
        legacy: modes.legacy,
        bulk: modes.bulk,
        hostCallReduction: modes.legacy.hostCalls - modes.bulk.hostCalls,
      });
    }

    applyGates();
  } catch (error) {
    report.notes.push({
      code: "RUN_FAILED",
      message: error instanceof Error ? error.message : String(error),
    });
    console.error(`[perf] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await relay.close();
    writeReport();
  }
  process.exit(report.ok ? 0 : 1);
}

// 每个 mode 一次完整测量：预热后跑 ITERATIONS 次,取 p50/p95。
// 关键点:legacy 一侧不是"另一个宿主",而是同一个宿主上禁用了 bulk 能力协商的
// 同一份服务代码——否则对照会把两套代码路径的差异混进传输差异里。
async function measureMode({ host, fixture, indices, useBulk }) {
  const session = wrapSession(host, { allowBulk: useBulk });
  const snapshots = new SnapshotService(session);
  const ranges = new RangeSnapshotService(session, { snapshotService: snapshots });
  const patcher = new NotePatchService(session, snapshots);

  const runOnce = async () => {
    // 每次迭代都重新 snapshot：契约要求写前重新解析上下文,
    // 复用一个 contextId 会把真实预检成本从测量里抹掉。
    const captured = await ranges.snapshot({
      scope: {
        kind: "range",
        from: { position: "blick", blick: 0 },
        to: { position: "blick", blick: fixture.endBlick },
        trackIndices: [fixture.trackIndex],
      },
      include: ["notes"],
    });
    const occurrence = findOccurrence(captured, fixture);
    const startedAt = process.hrtime.bigint();
    const result = await patcher.patchNotes({
      contextId: captured.contextId,
      occurrence: occurrence.occurrence,
      patches: indices.map((index) => ({
        note: index,
        // dryRun 下不写入;set 里给一个必然与现值不同的值,以确保预检真的
        // 走完整的指纹比对路径,而不是走 no_change 短路。
        set: { detuneCents: 7 },
      })),
      action: "dry_run",
      waitFor: "none",
      diagnostics: true,
    });
    const wallMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    assertReadOnly(result);
    return {
      wallMs,
      serviceTotalMs: result.diagnostics.timings.serviceTotalMs,
      fingerprintVerificationMs: result.diagnostics.timings.fingerprintVerificationMs ?? null,
      hostCalls: result.diagnostics.hostCalls.total,
      bulkReads: result.diagnostics.bulkReads ?? null,
      status: result.status,
      effects: result.effects,
    };
  };

  for (let i = 0; i < WARMUP; i += 1) await runOnce();
  const runs = [];
  for (let i = 0; i < ITERATIONS; i += 1) runs.push(await runOnce());

  const last = runs.at(-1);
  return {
    // 计数在同一场景下是确定值;毫秒取分位。
    hostCalls: last.hostCalls,
    status: last.status,
    effects: last.effects,
    bulkReads: last.bulkReads,
    wallMs: percentiles(runs.map((r) => r.wallMs)),
    serviceTotalMs: percentiles(runs.map((r) => r.serviceTotalMs)),
    fingerprintVerificationMs: percentiles(
      runs.map((r) => r.fingerprintVerificationMs).filter((v) => v !== null)
    ),
  };
}

// dryRun 的诚实性断言。宿主布尔值不可信,但 effects/status 是我们自己的契约,
// 一旦这里不成立,整份性能数字都不能用——它可能是在真的写工程。
function assertReadOnly(result) {
  if (result.status !== "dry_run") {
    throw new Error(`expected status dry_run, got ${result.status}; aborting before touching the project`);
  }
  if (result.effects !== "none") {
    throw new Error(`expected effects none, got ${result.effects}; the run may have mutated the project`);
  }
}

// 把 HostSession 包成 withExclusive 形式,并可选地屏蔽 bulk 能力。
// 屏蔽方式是在 lease 上覆盖 supportsOp/bulk,而不是改 relay:
// 改 relay 会让桥端也走另一条路,那就不是同一个对照了。
function wrapSession(host, { allowBulk }) {
  return {
    withExclusive: (task) =>
      host.withExclusive(async (lease) => {
        if (allowBulk) return task(lease);
        const downgraded = Object.freeze({
          ...lease,
          supportsOp: () => false,
          bulk: () => {
            throw new Error("bulk disabled for the legacy control arm");
          },
        });
        return task(downgraded);
      }),
  };
}

// occurrence ordinal 出现在响应的 data.tracks[].groups[] 上。按 track/group
// 索引定位，不猜第一个。
function findOccurrence(captured, fixture) {
  const track = (captured?.data?.tracks ?? []).find((item) => item.index === fixture.trackIndex);
  const group = (track?.groups ?? []).find((item) => item.index === fixture.groupIndex);
  if (!Number.isSafeInteger(group?.occurrence)) {
    throw new Error(
      `range snapshot did not return the fixture occurrence (track=${fixture.trackIndex} group=${fixture.groupIndex}); widen the range scope`
    );
  }
  return group;
}

// 定位第一个音符数 ≥ REQUIRED_NOTES 的非 instrumental group。
// 找不到就明确报错并说明需要什么工程,不退化到更小的 group——
// 用 40 个音符测出来的数字不能拿去满足 373-note 门禁。
async function locateFixtureGroup(host) {
  return host.withExclusive(async (lease) => {
    const roots = await lease.roots();
    const trackCount = await lease.call({ handle: roots.project, method: "getNumTracks", args: [] });
    const seen = [];
    for (let trackIndex = 0; trackIndex < trackCount; trackIndex += 1) {
      const track = await lease.call({
        handle: roots.project,
        method: "getTrack",
        args: [trackIndex + 1],
      });
      const groupCount = await lease.call({ handle: track, method: "getNumGroups", args: [] });
      for (let groupIndex = 0; groupIndex < groupCount; groupIndex += 1) {
        const reference = await lease.call({
          handle: track,
          method: "getGroupReference",
          args: [groupIndex + 1],
        });
        if (await lease.call({ handle: reference, method: "isInstrumental", args: [] })) continue;
        const group = await lease.call({ handle: reference, method: "getTarget", args: [] });
        const noteCount = await lease.call({ handle: group, method: "getNumNotes", args: [] });
        seen.push(noteCount);
        if (noteCount < REQUIRED_NOTES) continue;
        const lastNote = await lease.call({
          handle: group,
          method: "getNote",
          args: [noteCount],
        });
        const onset = await lease.call({ handle: lastNote, method: "getOnset", args: [] });
        const duration = await lease.call({ handle: lastNote, method: "getDuration", args: [] });
        const timeOffset = await lease.call({
          handle: reference,
          method: "getTimeOffset",
          args: [],
        });
        return {
          trackIndex,
          groupIndex,
          noteCount,
          endBlick: onset + duration + timeOffset + 705600000,
        };
      }
    }
    throw new Error(
      `no vocal NoteGroup with >= ${REQUIRED_NOTES} notes found (largest seen: ${Math.max(0, ...seen)}). ` +
        `The plan's acceptance criteria are fixed at ${REQUIRED_NOTES} notes; open a project that has one.`
    );
  });
}

// 计划 §7 Phase 1 的发布要求,逐条判定。纯函数:输入 scenarios,输出 gates 与总判定。
// 不预设绝对毫秒目标——计划明确说不承诺绝对值,只要求相对基线不回归。
export function evaluateGates(scenarios) {
  const byId = new Map(scenarios.map((s) => [s.id, s]));
  const gates = [];

  // 1. B 的 host-call 数显著低于 86。
  const b = byId.get("B");
  gates.push({
    id: "B_HOST_CALLS_BELOW_BASELINE",
    requirement: `scenario B host calls significantly below ${PLANNED_BASELINE.hostCalls}`,
    observed: b ? b.bulk.hostCalls : null,
    // "显著"取 ≤70%,与离线观测到的 82→27 量级一致;仅少几次不算达标。
    passed: b ? b.bulk.hostCalls <= PLANNED_BASELINE.hostCalls * 0.7 : false,
  });

  // 2. p50 与 p95 均不得回归(bulk 不慢于 legacy)。
  for (const scenario of scenarios) {
    for (const metric of ["wallMs", "serviceTotalMs"]) {
      for (const quantileName of ["p50", "p95"]) {
        const legacy = scenario.legacy[metric][quantileName];
        const bulk = scenario.bulk[metric][quantileName];
        gates.push({
          id: `NO_REGRESSION_${scenario.id}_${metric}_${quantileName}`,
          requirement: `scenario ${scenario.id} bulk ${metric} ${quantileName} must not regress vs legacy`,
          observed: { legacy, bulk },
          // 允许 5% 噪声带:真机测量有抖动,把噪声判成回归会让门禁不可用。
          passed: bulk <= legacy * 1.05,
        });
      }
    }
  }

  // 3. dry-run 继续 0 setter、0 Undo。
  const allDryRun =
    scenarios.length > 0 &&
    scenarios.every(
      (s) =>
        s.legacy.status === "dry_run" &&
        s.bulk.status === "dry_run" &&
        s.legacy.effects === "none" &&
        s.bulk.effects === "none"
    );
  gates.push({
    id: "DRY_RUN_HAS_NO_EFFECTS",
    requirement: "every scenario reports status dry_run and effects none on both arms",
    observed: allDryRun,
    passed: allDryRun,
  });

  // 4. 批量路径确实被用上了(否则"没有回归"只是因为两侧跑的是同一条路)。
  const bulkActuallyUsed =
    scenarios.length > 0 &&
    scenarios.every(
      (s) => s.bulk.bulkReads?.fallbackUsed === false && (s.bulk.bulkReads?.bulkHostCalls ?? 0) > 0
    );
  gates.push({
    id: "BULK_PATH_EXERCISED",
    requirement: "the bulk arm must actually use the bulk op, not silently fall back",
    observed: scenarios.map((s) => ({ id: s.id, bulkReads: s.bulk.bulkReads })),
    passed: bulkActuallyUsed,
  });

  // 场景不全时绝不判 PASS:少跑一个场景的报告不能当验收证据。
  const expectedIds = SCENARIOS.map((s) => s.id);
  const complete = expectedIds.every((id) => byId.has(id));
  gates.push({
    id: "ALL_SCENARIOS_MEASURED",
    requirement: `all planned scenarios measured: ${expectedIds.join(", ")}`,
    observed: [...byId.keys()],
    passed: complete,
  });

  return { gates, ok: gates.every((gate) => gate.passed) };
}

function applyGates() {
  const { gates, ok } = evaluateGates(report.scenarios);
  report.gates = gates;
  report.ok = ok;

  console.error("");
  console.error("[perf] release gates:");
  for (const gate of gates) {
    console.error(`  [${gate.passed ? "PASS" : "FAIL"}] ${gate.id}`);
  }
  console.error(`[perf] overall: ${report.ok ? "PASS" : "FAIL"}`);
  if (!report.ok) {
    report.notes.push({
      code: "GATES_NOT_MET",
      message:
        "One or more Phase 1 release gates failed. Do not claim Phase 1 release conditions are met.",
    });
  }
}

function percentiles(values) {
  if (values.length === 0) return { p50: null, p95: null, samples: 0 };
  const sorted = [...values].sort((left, right) => left - right);
  return {
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    samples: sorted.length,
  };
}

function quantile(sorted, fraction) {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return Math.round(sorted[index] * 1000) / 1000;
}

async function waitForBridge(relay, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  console.error(
    "[perf] waiting for the SV Copilot bridge; start StartSynthVCopilot in SynthV…"
  );
  while (Date.now() < deadline) {
    if ((relay.getStatus?.() ?? {}).state === "attached") return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`bridge did not attach within ${timeoutMs}ms`);
}

function writeReport() {
  const stamp = report.capturedAt.replace(/[:.]/g, "-");
  const file = path.join(OUT_DIR, `live-bulk-perf-${stamp}.json`);
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.error(`[perf] report written: ${file}`);
}

// 只有直接运行才连接宿主。纯判定逻辑导出供测试使用——门禁本身有 bug 的话，
// 一份"PASS"报告比没有报告更危险。
export { PLANNED_BASELINE, REQUIRED_NOTES, ITERATIONS, WARMUP, percentiles, spread };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
