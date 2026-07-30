import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";

import { collectDoctorReport, summarizeHostProfiles } from "../server/src/doctor.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverScript = path.resolve(testDir, "..", "server", "src", "index.js");
const fixturesDir = path.resolve(testDir, "fixtures", "host-profiles");

async function callDoctor(profile) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverScript],
    env: {
      ...process.env,
      SV_COPILOT_SESSION: `doctor-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ...(profile ? { SV_COPILOT_TOOL_PROFILE: profile } : {}),
    },
    cwd: path.dirname(serverScript),
    stderr: "pipe",
  });
  const client = new Client({ name: "doctor-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const r = await client.callTool({ name: "sv_doctor", arguments: {} });
    return r.structuredContent;
  } finally {
    await client.close().catch(() => {});
  }
}

test("sv_doctor is exposed in full, core, and raw profiles", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverScript],
    env: { ...process.env, SV_COPILOT_SESSION: `doctor-list-${Date.now()}` },
    cwd: path.dirname(serverScript),
    stderr: "pipe",
  });
  const client = new Client({ name: "doctor-list-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.ok(listed.tools.some((t) => t.name === "sv_doctor"), "sv_doctor must appear in full profile");
    const tool = listed.tools.find((t) => t.name === "sv_doctor");
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
  } finally {
    await client.close().catch(() => {});
  }
});

test("sv_doctor returns a structurally valid report", async () => {
  const d = await callDoctor(null);
  assert.equal(d.kind, "svcopilot-doctor");
  assert.equal(typeof d.ok, "boolean");
  assert.ok(d.generatedAt);
  assert.ok(d.versions?.interfaceVersion);
  assert.ok(d.versions?.node);
  assert.ok(d.versions?.platform);
  assert.equal(typeof d.versions?.protoVersionExpected, "number");
  assert.ok(d.bridge);
  assert.ok(d.transport);
  assert.ok(Array.isArray(d.findings));
  assert.ok(Array.isArray(d.hostProfiles));
  assert.ok(d.profile);
  assert.ok(d.stores);
});

test("sv_doctor reports host as not attached when no SynthV is running", async () => {
  const d = await callDoctor(null);
  // 测试环境没有真实宿主；Doctor 必须如实报告，不猜测。
  assert.notEqual(d.transport.hostState, "attached");
  const hostFinding = d.findings.find((f) => f.code === "HOST_NOT_ATTACHED");
  assert.ok(hostFinding, "HOST_NOT_ATTACHED finding must be present");
  assert.equal(hostFinding.severity, "info");
  // 未连接不是错误，不应让 ok 变 false。
  assert.equal(d.ok, !d.findings.some((f) => f.severity === "error"));
});

test("sv_doctor reports staging bridge as found", async () => {
  const d = await callDoctor(null);
  assert.equal(d.bridge.staging.status, "found");
  assert.ok(d.bridge.staging.sha256?.length === 64);
  assert.ok(d.bridge.staging.bytes > 0);
  assert.equal(typeof d.bridge.staging.protoVersion, "number");
  assert.ok(Array.isArray(d.bridge.staging.declaredOps));
});

test("sv_doctor does not expose script source or env var values", async () => {
  const d = await callDoctor(null);
  const text = JSON.stringify(d);
  // 只允许哈希和字节数，不允许脚本内容。
  assert.ok(!text.includes("IDLE_MS"), "script source must not appear in doctor output");
  assert.ok(!text.includes("local json"), "script source must not appear in doctor output");
});

test("sv_doctor reports proto version matching the relay", async () => {
  const d = await callDoctor(null);
  // staging 脚本声明 PROTO_VERSION = 1；relay 也期望 1。
  assert.equal(d.versions.protoVersionExpected, d.bridge.staging.protoVersion);
  // 如果两者一致，不应有 PROTO_VERSION_MISMATCH finding。
  assert.ok(!d.findings.some((f) => f.code === "PROTO_VERSION_MISMATCH"));
});

test("sv_doctor reports profile and store counts", async () => {
  const d = await callDoctor(null);
  assert.equal(d.profile.active, "full");
  assert.ok(d.profile.registered.includes("full"));
  assert.ok(d.profile.registered.includes("compact-v2"));
  assert.equal(typeof d.profile.enabledToolCount, "number");
  assert.ok(d.profile.enabledToolCount > 0);
  assert.equal(typeof d.stores.artifacts.entries, "number");
  assert.equal(typeof d.stores.snapshotContexts.entries, "number");
});

test("sv_doctor is reachable through the compact facade and reports that profile", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverScript],
    env: {
      ...process.env,
      SV_COPILOT_SESSION: `doctor-compact-${Date.now()}`,
      SV_COPILOT_TOOL_PROFILE: "compact-v2",
    },
    cwd: path.dirname(serverScript),
    stderr: "pipe",
  });
  const client = new Client({ name: "doctor-compact-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    // compact profile 只暴露 facade 工具，direct 名字必须被拒绝。
    const direct = await client.callTool({ name: "sv_doctor", arguments: {} });
    assert.equal(direct.isError, true);
    assert.equal(direct.structuredContent.error.code, "TOOL_NOT_ENABLED");

    const viaFacade = await client.callTool({
      name: "sv_status",
      arguments: { operation: "doctor", arguments: {} },
    });
    const d = viaFacade.structuredContent;
    assert.equal(d.kind, "svcopilot-doctor");
    assert.equal(d.profile.active, "compact-v2");
    assert.equal(d.profile.compactActive, true);
  } finally {
    await client.close().catch(() => {});
  }
});

test("sv_doctor summarizes committed host profiles", async () => {
  const d = await callDoctor(null);
  assert.ok(d.hostProfiles.length > 0, "at least one host profile fixture must be present");
  const profile = d.hostProfiles[0];
  assert.ok(profile.file.endsWith(".json"));
  assert.ok(profile.schemaVersion);
  assert.ok(profile.profileId);
  assert.ok(profile.hostSelector);
  assert.ok(profile.semanticStatusCounts);
  assert.ok(typeof profile.semanticStatusCounts.confirmed === "number");
});

test("collectDoctorReport unit: findings are correct for a detached host", () => {
  const moduleDir = path.resolve(testDir, "..", "server", "src");
  const report = collectDoctorReport({
    interfaceVersion: "0.9.0",
    moduleDir,
    protoVersion: 1,
    session: { name: "test", paths: { toSv: "a", fromSv: "b", control: "c" } },
    host: { state: "listening", epoch: 0, hostVersion: null, hostOps: [], knownHandleCount: 0, pendingExecutions: 0 },
    manifest: { available: false, generatedAt: null, schemaVersion: null },
    profile: { active: "full", registered: ["full"], compactActive: false, enabledToolCount: 42, directToolCount: 42 },
    stores: { artifacts: { entries: 0, bytes: 0 }, snapshotContexts: { entries: 0, ttlMs: 300000 } },
  });
  assert.equal(report.kind, "svcopilot-doctor");
  const codes = report.findings.map((f) => f.code);
  assert.ok(codes.includes("HOST_NOT_ATTACHED"));
  assert.ok(codes.includes("API_MANIFEST_UNAVAILABLE"));
  // 未连接时不应有 NO_NEGOTIATED_HOST_OPS（那是连上了但没宣告 ops 的情况）。
  assert.ok(!codes.includes("NO_NEGOTIATED_HOST_OPS"));
});

test("collectDoctorReport unit: proto mismatch produces a finding per found script", () => {
  const moduleDir = path.resolve(testDir, "..", "server", "src");
  const report = collectDoctorReport({
    interfaceVersion: "0.9.0",
    moduleDir,
    protoVersion: 99,
    session: { name: "test", paths: { toSv: "a", fromSv: "b", control: "c" } },
    host: { state: "listening", epoch: 0, hostVersion: null, hostOps: [], knownHandleCount: 0, pendingExecutions: 0 },
    manifest: { available: true, generatedAt: "2025-01-01", schemaVersion: "1.0" },
    profile: { active: "full", registered: ["full"], compactActive: false, enabledToolCount: 42, directToolCount: 42 },
    stores: { artifacts: { entries: 0, bytes: 0 }, snapshotContexts: { entries: 0, ttlMs: 300000 } },
  });
  const mismatches = report.findings.filter((f) => f.code === "PROTO_VERSION_MISMATCH");
  assert.ok(mismatches.length > 0, "PROTO_VERSION_MISMATCH finding must be present");
  // 每个找得到的脚本各报一次：loaded 不一致是错误（那是实际运行的桥），
  // staging 不一致只是警告（它还没被加载）。
  for (const finding of mismatches) {
    assert.ok(["loaded", "staging"].includes(finding.script));
    assert.equal(finding.severity, finding.script === "loaded" ? "error" : "warning");
  }
  const loadedFound = report.bridge.loaded.status === "found";
  assert.equal(
    mismatches.some((f) => f.script === "loaded"),
    loadedFound,
    "a found loaded script with a different proto must be reported"
  );
  assert.equal(report.ok, !loadedFound);
});

test("collectDoctorReport unit: attached host with no ops produces warning", () => {
  const moduleDir = path.resolve(testDir, "..", "server", "src");
  const report = collectDoctorReport({
    interfaceVersion: "0.9.0",
    moduleDir,
    protoVersion: 1,
    session: { name: "test", paths: { toSv: "a", fromSv: "b", control: "c" } },
    host: { state: "attached", epoch: 1, hostVersion: "2.2.1", hostOps: [], knownHandleCount: 0, pendingExecutions: 0 },
    manifest: { available: true, generatedAt: "2025-01-01", schemaVersion: "1.0" },
    profile: { active: "full", registered: ["full"], compactActive: false, enabledToolCount: 42, directToolCount: 42 },
    stores: { artifacts: { entries: 0, bytes: 0 }, snapshotContexts: { entries: 0, ttlMs: 300000 } },
  });
  const noOps = report.findings.find((f) => f.code === "NO_NEGOTIATED_HOST_OPS");
  assert.ok(noOps, "NO_NEGOTIATED_HOST_OPS warning must be present when attached with empty ops");
  assert.equal(noOps.severity, "warning");
});

test("summarizeHostProfiles returns correct shape for existing fixtures", () => {
  const profiles = summarizeHostProfiles(fixturesDir);
  assert.ok(profiles.length > 0);
  for (const p of profiles) {
    assert.ok(p.file);
    if (p.status !== "unreadable") {
      assert.ok(p.schemaVersion);
      assert.ok(p.profileId);
      assert.ok(p.hostSelector);
      assert.ok(p.semanticStatusCounts);
    }
  }
});

test("collectDoctorReport unit: never calls the host", () => {
  const moduleDir = path.resolve(testDir, "..", "server", "src");
  // Doctor 只允许读取已采集好的 status 快照字段。传入的 proxy 对任何看起来像
  // 宿主调用入口的成员抛错——如果哪天有人为了"补全"信息在 Doctor 里发起宿主调用，
  // 这个测试立刻失败，而不是等到用户在 SynthV 关闭时看到诊断卡住。
  const forbidden = ["call", "index", "roots", "free", "ping", "bulk", "lease", "then"];
  const forbiddenHost = new Proxy(
    {
      state: "listening",
      epoch: 0,
      hostVersion: null,
      hostOps: [],
      knownHandleCount: 0,
      pendingExecutions: 0,
    },
    {
      get(target, prop) {
        if (forbidden.includes(String(prop))) {
          throw new Error(`doctor must not invoke host member "${String(prop)}"`);
        }
        return target[prop];
      },
    }
  );
  const report = collectDoctorReport({
    interfaceVersion: "0.9.0",
    moduleDir,
    protoVersion: 1,
    session: { name: "test", paths: { toSv: "a", fromSv: "b", control: "c" } },
    host: forbiddenHost,
    manifest: { available: true, generatedAt: "2025-01-01", schemaVersion: "1.0" },
    profile: { active: "full", registered: ["full"], compactActive: false, enabledToolCount: 42, directToolCount: 42 },
    stores: { artifacts: { entries: 0, bytes: 0 }, snapshotContexts: { entries: 0, ttlMs: 300000 } },
  });
  assert.equal(report.transport.hostState, "listening");
  assert.equal(report.transport.hostVersion, null);
});

test("summarizeHostProfiles returns empty array for a missing directory", () => {
  // Doctor 绝不因为缺目录而抛错：它本身就是用来诊断缺失的工具。
  assert.deepEqual(summarizeHostProfiles(path.join(fixturesDir, "does-not-exist")), []);
});
