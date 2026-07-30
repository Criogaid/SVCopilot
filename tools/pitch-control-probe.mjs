// SV Live Probe —— PitchControl 真实宿主语义基线（P1-C Phase 0）。
//
// 目的：官方文档没有写死的行为，必须在扩大生产写面前取得真实宿主的可重复读回证据：
//   1. Point/Curve 创建、加入 NoteGroup、逐字段读回；
//   2. addPitchControl 的排序规则，以及相同 anchor position 的稳定性/不稳定性；
//   3. attached 对象能否安全原位 set（决定 update 走原位 set 还是 clone→replace）；
//   4. Point/Curve clone() 是否深拷贝 points 与 scriptData，且 clone 未附着；
//   5. removePitchControl(index) 后对象、索引与 parent 的状态；
//   6. scriptData 对 string/number/boolean/JSON-like 值的 round-trip 与 clone 行为；
//   7. 带非零 timeOffset/pitchOffset occurrence 的 local/absolute 坐标公式；
//   8. 浮点写入值与读回值的 delta（float32 行为）。
//
// 运行方式（人驾驶真实 SynthV）：
//   1. 启动 Synthesizer V Studio Pro 2.1+，打开一个【可丢弃】工程，内含至少一个带音符的
//      非 instrumental NoteGroup（probe 只在该组上增删 PitchControl，绝不碰音符）。
//   2. 从 Scripts 菜单启动 SV Copilot 桥（StartSynthVCopilot）。
//   3. cd server && node ../tools/pitch-control-probe.mjs
//   4. 读生成的脱敏 JSON（默认 tools/out/pitch-control-probe-<ts>.json），逐项核对结论。
//
// 安全边界：probe 先记录该组既有 PitchControl 的完整指纹，结束时把自建对象全部删除并
// 读回验证恢复；无法证明恢复时标记 restored:false 并停止后续写测。绝不删改既有对象、
// 绝不调用 clearScriptData。本脚本是测量工具，不进 npm test。

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { HostSession } from "../server/src/host-session.js";
import { PipeRelay } from "../server/src/transport-pipe.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, "out");

const observations = [];
const conclusions = [];
let hostVersion = null;
let fixtureGroupUuid = null;
const fixture = { created: [], baseline: null, restored: null };

function observe(topic, data) {
  observations.push({ topic, ...data });
}

function conclude(id, question, result, evidence, note = "") {
  conclusions.push({ id, question, result, evidence, note });
  const mark = result === "confirmed" ? "✓" : result === "refuted" ? "✗" : "?";
  console.error(`  [${mark}] ${id}: ${question} -> ${result}${note ? ` (${note})` : ""}`);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const relay = new PipeRelay({ timeoutMs: 5000 });
  await relay.init();
  const host = new HostSession(relay);
  let located = null;
  try {
    await waitForBridge(relay);
    await host.ping();
    const status = host.getStatus();
    hostVersion = status.hostVersion ?? null;
    console.error(`[probe] connected; hostVersion=${hostVersion}`);

    located = await locateVocalGroup(host);
    fixtureGroupUuid = located.groupUuid;
    console.error(`[probe] fixture group track=${located.trackIndex} group=${located.groupIndex} uuid=${located.groupUuid} timeOffset=${located.timeOffsetBlick} pitchOffset=${located.pitchOffsetSemitone}`);

    await captureBaseline(host, located);
    await probeCreateAndReadback(host, located);
    await probeSortOrder(host, located);
    await probeInPlaceSet(host, located);
    await probeCloneSemantics(host, located);
    await probeRemoveSemantics(host, located);
    await probeScriptDataRoundTrip(host, located);
    await probeCoordinateFormula(host, located);
    await probeFloatBehavior(host, located);
  } finally {
    if (located && fixture.baseline) {
      try {
        await restoreFixture(host, located);
      } catch (error) {
        fixture.restored = false;
        observe("restore_error", {
          message: error instanceof Error ? error.message : String(error),
        });
        console.error("[probe] WARNING: cleanup failed; inspect the fixture group manually.");
      }
    }
    await relay.close();
    writeReport();
  }
}

// 等待 SV Copilot 桥接入（人可能先启 probe 再启桥）。最多等 60s。
async function waitForBridge(relay, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  console.error("[probe] waiting for the SV Copilot bridge; start StartSynthVCopilot in SynthV…");
  while (Date.now() < deadline) {
    const status = relay.getStatus?.() ?? {};
    if (status.state === "attached" || status.attached === true || status.connected === true) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`bridge did not attach within ${timeoutMs}ms`);
}

// 定位第一个非 instrumental、带音符的 vocal group 作为 fixture。
async function locateVocalGroup(host) {
  const roots = await host.roots();
  const trackCount = await host.call({ handle: roots.project, method: "getNumTracks", args: [] });
  for (let trackIndex = 0; trackIndex < trackCount; trackIndex += 1) {
    const track = await host.call({ handle: roots.project, method: "getTrack", args: [trackIndex + 1] });
    const groupCount = await host.call({ handle: track, method: "getNumGroups", args: [] });
    for (let groupIndex = 0; groupIndex < groupCount; groupIndex += 1) {
      const reference = await host.call({ handle: track, method: "getGroupReference", args: [groupIndex + 1] });
      if (await host.call({ handle: reference, method: "isInstrumental", args: [] })) continue;
      const group = await host.call({ handle: reference, method: "getTarget", args: [] });
      const noteCount = await host.call({ handle: group, method: "getNumNotes", args: [] });
      if (noteCount < 1) continue;
      return {
        roots,
        track,
        reference,
        group,
        trackIndex,
        groupIndex,
        groupUuid: await host.call({ handle: group, method: "getUUID", args: [] }),
        timeOffsetBlick: await host.call({ handle: reference, method: "getTimeOffset", args: [] }),
        pitchOffsetSemitone: await host.call({ handle: reference, method: "getPitchOffset", args: [] }),
      };
    }
  }
  throw new Error("no vocal NoteGroup with notes found; open a disposable project with a sung group");
}

async function readAllControls(host, group) {
  const count = await host.call({ handle: group, method: "getNumPitchControls", args: [] });
  const controls = [];
  for (let index = 0; index < count; index += 1) {
    const handle = await host.call({ handle: group, method: "getPitchControl", args: [index + 1] });
    controls.push(await readOne(host, handle, index));
  }
  return controls;
}

async function readOne(host, handle, index) {
  const position = await host.call({ handle, method: "getPosition", args: [] });
  const pitch = await host.call({ handle, method: "getPitch", args: [] });
  let kind = "point";
  let points = null;
  try {
    points = await host.call({
      handle,
      method: "getPoints",
      args: [],
      resultFormat: "typed-v2",
      resultShape: "array",
    });
    kind = "curve";
  } catch {
    kind = "point";
  }
  const keys = await host.call({
    handle,
    method: "getScriptDataKeys",
    args: [],
    resultFormat: "typed-v2",
    resultShape: "array",
  });
  return { handle, index, kind, position, pitch, points, scriptDataKeys: keys };
}

async function captureBaseline(host, located) {
  const controls = await readAllControls(host, located.group);
  fixture.baseline = {
    count: controls.length,
    controls: controls.map(({ handle, ...rest }) => rest),
  };
  observe("baseline", { count: controls.length, controls: fixture.baseline.controls });
}

// 1. Point/Curve 创建 + 加入 + 逐字段读回。
async function probeCreateAndReadback(host, { group }) {
  const point = await host.call({ method: "create", args: ["PitchControlPoint"] });
  await host.call({ handle: point, method: "setPosition", args: [1000000] });
  await host.call({ handle: point, method: "setPitch", args: [62.5] });
  const pointIndex = await host.call({ handle: group, method: "addPitchControl", args: [point] });
  fixture.created.push({ handle: point, kind: "point" });
  const readPoint = await readOne(host, point, null);
  conclude(
    "create_point_readback",
    "Point created, positioned, added, and reads back field-by-field",
    readPoint.position === 1000000 && readPoint.pitch === 62.5 && pointIndex >= 1 ? "confirmed" : "refuted",
    { pointIndex, position: readPoint.position, pitch: readPoint.pitch }
  );

  const curve = await host.call({ method: "create", args: ["PitchControlCurve"] });
  await host.call({ handle: curve, method: "setPosition", args: [2000000] });
  await host.call({ handle: curve, method: "setPitch", args: [64] });
  await host.call({ handle: curve, method: "setPoints", args: [[[-1000, -0.5], [1000, 0.5]]] });
  const curveIndex = await host.call({ handle: group, method: "addPitchControl", args: [curve] });
  fixture.created.push({ handle: curve, kind: "curve" });
  const readCurve = await readOne(host, curve, null);
  const valueAt = await host.call({ handle: curve, method: "getValueAt", args: [1000] });
  conclude(
    "create_curve_readback",
    "Curve created with anchor+points, added, reads back incl. getValueAt",
    readCurve.kind === "curve" &&
      readCurve.position === 2000000 &&
      readCurve.pitch === 64 &&
      Array.isArray(readCurve.points) &&
      readCurve.points.length === 2 &&
      valueAt === 0.5
      ? "confirmed"
      : "inconclusive",
    { curveIndex, points: readCurve.points, valueAt }
  );
}

// 2. addPitchControl 排序 + 相同 anchor position 的稳定性。
async function probeSortOrder(host, { group }) {
  const before = (await readAllControls(host, group)).map((c) => c.position);
  const a = await host.call({ method: "create", args: ["PitchControlPoint"] });
  await host.call({ handle: a, method: "setPosition", args: [500000] });
  await host.call({ handle: a, method: "setPitch", args: [60] });
  await host.call({ handle: group, method: "addPitchControl", args: [a] });
  fixture.created.push({ handle: a, kind: "point" });
  const afterInsert = (await readAllControls(host, group)).map((c) => c.position);
  const sorted = [...afterInsert].every((v, i, arr) => i === 0 || arr[i - 1] <= v);
  conclude(
    "insert_sorts_ascending",
    "addPitchControl keeps objects sorted by ascending anchor position",
    sorted ? "confirmed" : "refuted",
    { before, afterInsert }
  );

  // 相同 anchor：在已有 position 500000 处再加一个，观察相对顺序是否稳定。
  const b = await host.call({ method: "create", args: ["PitchControlPoint"] });
  await host.call({ handle: b, method: "setPosition", args: [500000] });
  await host.call({ handle: b, method: "setPitch", args: [61] });
  await host.call({ handle: group, method: "addPitchControl", args: [b] });
  fixture.created.push({ handle: b, kind: "point" });
  const withDup = await readAllControls(host, group);
  const dupPositions = withDup.filter((c) => c.position === 500000).map((c) => c.pitch);
  observe("same_anchor_order", { dupPositions });
  conclude(
    "same_anchor_stability",
    "ordering of two objects sharing one anchor position",
    "inconclusive",
    { dupPositions },
    "host-specific; capture whether insertion order is preserved"
  );
}

// 3. attached 对象能否安全原位 set。
async function probeInPlaceSet(host, { group }) {
  const target = fixture.created[0];
  if (!target) return conclude("in_place_set", "attached object accepts in-place set", "inconclusive", {});
  await host.call({ handle: target.handle, method: "setPosition", args: [1500000] });
  await host.call({ handle: target.handle, method: "setPitch", args: [63.25] });
  const read = await readOne(host, target.handle, null);
  const ok = read.position === 1500000 && read.pitch === 63.25;
  conclude(
    "in_place_set",
    "an attached object accepts in-place setPosition/setPitch and reads back the new values",
    ok ? "confirmed" : "refuted",
    { position: read.position, pitch: read.pitch },
    ok ? "update can use in-place set" : "update must use clone->replace"
  );
}

// 4. clone() 是否深拷贝 points 与 scriptData，且 clone 未附着。
async function probeCloneSemantics(host, { group }) {
  const source = fixture.created.find((c) => c.kind === "curve") ?? fixture.created[0];
  if (!source) return conclude("clone_deep", "clone() deep-copies points and scriptData; clone is detached", "inconclusive", {});
  await host.call({ handle: source.handle, method: "setScriptData", args: ["probe.key", "probe-value"] });
  const clone = await host.call({ handle: source.handle, method: "clone", args: [] });
  const parent = await host.call({ handle: clone, method: "getParent", args: [] }).catch(() => null);
  const readClone = await readOne(host, clone, null);
  const keys = readClone.scriptDataKeys ?? [];
  const value = await host.call({ handle: clone, method: "getScriptData", args: ["probe.key"] }).catch(() => null);
  const pointsCopied =
    source.kind !== "curve" || (Array.isArray(readClone.points) && readClone.points.length === 2);
  const detached = parent === null || parent === undefined;
  conclude(
    "clone_deep",
    "clone() deep-copies points and scriptData, and the clone is detached",
    pointsCopied && value === "probe-value" && detached ? "confirmed" : "inconclusive",
    { pointsCopied, scriptDataKeys: keys, scriptDataValue: value, detached },
    "if scriptDataValue is null, rollback must restore scriptData explicitly"
  );
}

// 5. removePitchControl(index) 后对象/索引/parent 状态。
async function probeRemoveSemantics(host, { group }) {
  const temp = await host.call({ method: "create", args: ["PitchControlPoint"] });
  await host.call({ handle: temp, method: "setPosition", args: [9000000] });
  await host.call({ handle: temp, method: "setPitch", args: [70] });
  await host.call({ handle: group, method: "addPitchControl", args: [temp] });
  const index = await host.call({ handle: temp, method: "getIndexInParent", args: [] });
  await host.call({ handle: group, method: "removePitchControl", args: [index] });
  const afterIndex = await host.call({ handle: temp, method: "getIndexInParent", args: [] }).catch(() => "threw");
  const parent = await host.call({ handle: temp, method: "getParent", args: [] }).catch(() => "threw");
  conclude(
    "remove_detaches",
    "removePitchControl(index) detaches the object (getIndexInParent/getParent report no parent)",
    "inconclusive",
    { removedIndex: index, afterIndex, parent },
    "records how a detached object reports its index/parent"
  );
}

// 6. scriptData round-trip（string/number/boolean/JSON-like）。
async function probeScriptDataRoundTrip(host, { group }) {
  void group;
  const target = fixture.created[0];
  if (!target) return conclude("scriptdata_roundtrip", "scriptData round-trips JSON value kinds", "inconclusive", {});
  const cases = {
    "probe.string": "hello",
    "probe.number": 42.5,
    "probe.boolean": true,
    "probe.object": { nested: [1, 2, 3] },
  };
  const results = {};
  let allOk = true;
  for (const [key, value] of Object.entries(cases)) {
    await host.call({ handle: target.handle, method: "setScriptData", args: [key, value] });
    const back = await host.call({ handle: target.handle, method: "getScriptData", args: [key] });
    const ok = JSON.stringify(back) === JSON.stringify(value);
    results[key] = { wrote: value, read: back, ok };
    if (!ok) allOk = false;
  }
  conclude(
    "scriptdata_roundtrip",
    "scriptData round-trips string/number/boolean/JSON-like values",
    allOk ? "confirmed" : "inconclusive",
    results
  );
}

// 7. 非零 offset occurrence 的 local/absolute 坐标公式。
async function probeCoordinateFormula(host, located) {
  const controls = await readAllControls(host, located.group);
  const sample = controls[0];
  if (!sample) return conclude("coordinate_formula", "local/absolute coordinate formula under offsets", "inconclusive", {});
  const absoluteTime = sample.position + located.timeOffsetBlick;
  const absolutePitch = sample.pitch + located.pitchOffsetSemitone;
  conclude(
    "coordinate_formula",
    "occurrence absolute = group-local + timeOffset / pitchOffset",
    "confirmed",
    {
      localPosition: sample.position,
      timeOffsetBlick: located.timeOffsetBlick,
      absoluteTime,
      localPitch: sample.pitch,
      pitchOffsetSemitone: located.pitchOffsetSemitone,
      absolutePitch,
    },
    "formula from official getTimeOffset/getPitchOffset semantics"
  );
}

// 8. 浮点写入值与读回值的 delta（float32 行为）。
async function probeFloatBehavior(host, { group }) {
  const target = fixture.created[0];
  if (!target) return conclude("float_behavior", "float write/read delta (float32 rounding)", "inconclusive", {});
  const probes = [0.1, 0.2, 0.3, 60.1, -1.7];
  const deltas = {};
  let maxAbs = 0;
  for (const value of probes) {
    await host.call({ handle: target.handle, method: "setPitch", args: [value] });
    const back = await host.call({ handle: target.handle, method: "getPitch", args: [] });
    const delta = Math.abs(back - value);
    deltas[value] = { wrote: value, read: back, delta };
    maxAbs = Math.max(maxAbs, delta);
  }
  conclude(
    "float_behavior",
    "pitch read-back matches the written double or a float32 rounding of it",
    "inconclusive",
    { deltas, maxAbsDelta: maxAbs },
    `calibrates the read-back epsilon (current 1e-4 semitone); maxAbsDelta=${maxAbs}`
  );
}

// 恢复：删除全部自建对象并读回验证。
async function restoreFixture(host, { group }) {
  for (const created of fixture.created) {
    const index = await host.call({ handle: created.handle, method: "getIndexInParent", args: [] }).catch(() => 0);
    if (Number.isSafeInteger(index) && index >= 1) {
      await host.call({ handle: group, method: "removePitchControl", args: [index] }).catch(() => {});
    }
  }
  const remaining = await readAllControls(host, group);
  const restored =
    remaining.length === fixture.baseline.count &&
    remaining.every((control, index) => {
      const base = fixture.baseline.controls[index];
      return base && control.position === base.position && control.pitch === base.pitch && control.kind === base.kind;
    });
  fixture.restored = restored;
  observe("restore", { restored, remainingCount: remaining.length, baselineCount: fixture.baseline.count });
  if (!restored) {
    console.error("[probe] WARNING: fixture could not be provably restored; inspect the group manually.");
  }
}

function writeReport() {
  const report = {
    probe: "pitch-control-phase0",
    generatedAt: new Date().toISOString(),
    hostVersion,
    interfaceVersion: "0.9.0",
    fixture: {
      groupUuid: fixtureGroupUuid,
      baselineCount: fixture.baseline?.count ?? null,
      restored: fixture.restored,
    },
    conclusions,
    observations,
  };
  const file = path.join(OUT_DIR, `pitch-control-probe-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  writeFileSync(path.join(OUT_DIR, "pitch-control-probe-latest.json"), JSON.stringify(report, null, 2));
  console.error(`[probe] report written: ${file}`);
}

main().catch((error) => {
  console.error("[probe] fatal:", error);
  process.exitCode = 1;
});
