#!/usr/bin/env node
// `npm run doctor`：只读安装诊断的命令行入口。
//
// 与 sv_doctor 共用同一个 collectDoctorReport，因此 CLI 与 MCP 工具不会给出不同结论。
// 不启动 relay、不监听管道、不连接宿主——纯静态检查加上"宿主未连接"这一事实。
// 因此它在 SynthV 关闭时也能用，而那恰好是最需要它的时候。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { collectDoctorReport, summarizeHostProfiles } from "../server/src/doctor.js";
import { apiManifest, apiManifestAvailable } from "../server/src/api-catalog.js";
import { PipeRelay, resolvePipePaths, resolveSession } from "../server/src/transport-pipe.js";
import { registeredToolProfiles } from "../server/src/tool-profile.js";

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const moduleDir = path.resolve(toolsDir, "..", "server", "src");
const asJson = process.argv.includes("--json");

// 版本与协议号都取自唯一来源，不在 CLI 里硬编码第二份：
// 硬编码会让 Doctor 在版本升级后报告陈旧值，而它存在的意义正是发现版本错配。
const interfaceVersion = JSON.parse(
  fs.readFileSync(path.resolve(toolsDir, "..", "server", "package.json"), "utf8")
).version;
// 构造 PipeRelay 不监听任何管道；只读它的协议版本默认值。
const protoVersion = new PipeRelay().proto;

const session = resolveSession();
const report = collectDoctorReport({
  interfaceVersion,
  moduleDir,
  protoVersion,
  session: { name: session, paths: resolvePipePaths(session) },
  // CLI 不建立连接，因此宿主状态只能是 "not_started"——如实报告，不假装 listening。
  host: {
    state: "not_started",
    epoch: 0,
    hostVersion: null,
    hostOps: [],
    knownHandleCount: 0,
    pendingExecutions: 0,
  },
  manifest: {
    available: apiManifestAvailable,
    generatedAt: apiManifest.generatedAt,
    schemaVersion: apiManifest.schemaVersion ?? null,
  },
  profile: {
    active: process.env.SV_COPILOT_TOOL_PROFILE ?? "full",
    registered: registeredToolProfiles(),
    compactActive: process.env.SV_COPILOT_TOOL_PROFILE === "compact-v2",
    enabledToolCount: null,
    directToolCount: null,
  },
  // CLI 没有运行中的 store。null 而不是 0：0 会读成"有 store 且为空"。
  stores: { artifacts: null, snapshotContexts: null },
  hostProfiles: summarizeHostProfiles(
    path.resolve(toolsDir, "..", "test", "fixtures", "host-profiles")
  ),
});

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  printHuman(report);
}

// 只有 error 级 finding 才影响退出码：宿主未连接是 info，不该让 CI 或用户脚本失败。
process.exit(report.ok ? 0 : 1);

function printHuman(value) {
  const { versions, bridge, transport, manifest, profile, findings } = value;
  console.log("SV Copilot doctor");
  console.log(`  interface        ${versions.interfaceVersion}`);
  console.log(`  proto expected   ${versions.protoVersionExpected}`);
  console.log(`  node             ${versions.node} (${versions.platform})`);
  console.log("");
  console.log("Bridge scripts");
  printScript("loaded ", bridge.loaded);
  printScript("staging", bridge.staging);
  console.log(`  comparison       ${bridge.comparison.verdict}`);
  if (bridge.comparison.note) console.log(`                   ${bridge.comparison.note}`);
  console.log("");
  console.log("Transport");
  console.log(`  session          ${transport.session}`);
  console.log(`  to-sv            ${transport.pipes.toSv}`);
  console.log(`  from-sv          ${transport.pipes.fromSv}`);
  console.log(`  control          ${transport.pipes.control}`);
  console.log(`  host state       ${transport.hostState}`);
  console.log("");
  console.log("Environment");
  console.log(`  API manifest     ${manifest.available ? `available (${manifest.generatedAt})` : "UNAVAILABLE"}`);
  console.log(`  tool profile     ${profile.active}`);
  console.log(`  profiles         ${profile.registered.join(", ")}`);
  console.log("");
  if (findings.length === 0) {
    console.log("No findings.");
    return;
  }
  console.log("Findings");
  for (const finding of findings) {
    console.log(`  [${finding.severity}] ${finding.code}`);
    console.log(`      ${finding.message}`);
    if (finding.searchedPaths) {
      for (const searched of finding.searchedPaths) console.log(`      searched: ${searched}`);
    }
  }
}

function printScript(label, script) {
  if (script.status !== "found") {
    console.log(`  ${label}          ${script.status}`);
    return;
  }
  console.log(
    `  ${label}          proto=${script.protoVersion} ops=[${script.declaredOps.join(", ")}] ${script.bytes}B sha256=${script.sha256.slice(0, 12)}…`
  );
}
