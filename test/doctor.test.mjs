import "./helpers/pipe-namespace.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";

import { collectDoctorReport, summarizeHostProfiles } from "../server/src/doctor.js";
import { resolvePipePaths } from "../server/src/transport-pipe.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverScript = path.resolve(testDir, "..", "server", "src", "index.js");
const fixturesDir = path.resolve(testDir, "fixtures", "host-profiles");

// doctor 只能通过 sv_status facade 到达：facade 是唯一 surface。
async function callDoctor() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverScript],
    env: process.env,
    cwd: path.dirname(serverScript),
    stderr: "pipe",
  });
  const client = new Client({ name: "doctor-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const r = await client.callTool({
      name: "sv_status",
      arguments: { operation: "doctor", arguments: {} },
    });
    return r.structuredContent;
  } finally {
    await client.close().catch(() => {});
  }
}

test("the doctor operation is reachable through sv_status and stays read-only", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverScript],
    env: process.env,
    cwd: path.dirname(serverScript),
    stderr: "pipe",
  });
  const client = new Client({ name: "doctor-list-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const status = listed.tools.find((t) => t.name === "sv_status");
    assert.ok(status, "sv_status must be exposed");
    assert.ok(status.inputSchema.properties.operation.enum.includes("doctor"));
    // 整组 read-only：诊断绝不写宿主。
    assert.equal(status.annotations.readOnlyHint, true);
    assert.equal(status.annotations.destructiveHint, false);
    // direct 工具名不可调用。
    const direct = await client.callTool({ name: "sv_doctor", arguments: {} });
    assert.equal(direct.isError, true);
    assert.equal(direct.structuredContent.error.code, "UNKNOWN_TOOL");
  } finally {
    await client.close().catch(() => {});
  }
});

test("sv_doctor returns a structurally valid report", async () => {
  const d = await callDoctor();
  assert.equal(d.kind, "svcopilot-doctor");
  assert.equal(typeof d.ok, "boolean");
  assert.ok(d.generatedAt);
  assert.ok(d.versions?.interfaceVersion);
  assert.ok(d.versions?.node);
  assert.ok(d.versions?.platform);
  assert.equal(typeof d.versions?.protoVersionExpected, "number");
  assert.ok(d.bridge);
  assert.ok(d.transport);
  assert.equal("session" in d.transport, false);
  // 子进程继承测试命名空间，因此与同一解析器比对，而不是写死安装期名字。
  assert.deepEqual(d.transport.pipes, resolvePipePaths());
  assert.ok(Array.isArray(d.findings));
  assert.ok(Array.isArray(d.hostProfiles));
  assert.ok(d.surface);
  assert.ok(d.stores);
});

test("sv_doctor reports host as not attached when no SynthV is running", async () => {
  const d = await callDoctor();
  // 测试环境没有真实宿主；Doctor 必须如实报告，不猜测。
  assert.notEqual(d.transport.hostState, "attached");
  const hostFinding = d.findings.find((f) => f.code === "HOST_NOT_ATTACHED");
  assert.ok(hostFinding, "HOST_NOT_ATTACHED finding must be present");
  assert.equal(hostFinding.severity, "info");
  // 未连接不是错误，不应让 ok 变 false。
  assert.equal(d.ok, !d.findings.some((f) => f.severity === "error"));
});

test("sv_doctor reports staging bridge as found", async () => {
  const d = await callDoctor();
  assert.equal(d.bridge.staging.status, "found");
  assert.ok(d.bridge.staging.sha256?.length === 64);
  assert.ok(d.bridge.staging.bytes > 0);
  assert.equal(typeof d.bridge.staging.protoVersion, "number");
  assert.ok(Array.isArray(d.bridge.staging.declaredOps));
});

test("sv_doctor does not expose script source or env var values", async () => {
  const d = await callDoctor();
  const text = JSON.stringify(d);
  // 只允许哈希和字节数，不允许脚本内容。
  assert.ok(!text.includes("IDLE_MS"), "script source must not appear in doctor output");
  assert.ok(!text.includes("local json"), "script source must not appear in doctor output");
});

test("sv_doctor reports proto version matching the relay", async () => {
  const d = await callDoctor();
  // staging 脚本与 Relay 必须声明相同协议版本。
  assert.equal(d.versions.protoVersionExpected, d.bridge.staging.protoVersion);
  // 如果两者一致，不应有 PROTO_VERSION_MISMATCH finding。
  assert.ok(!d.findings.some((f) => f.code === "PROTO_VERSION_MISMATCH"));
});

test("sv_doctor reports the facade surface and store counts", async () => {
  const d = await callDoctor();
  // 没有 profile 可报告；surface 是固定 facade 集合，operation 数从 catalog 派生。
  assert.equal("profile" in d, false);
  assert.equal(d.surface.facadeCount, 8);
  assert.ok(d.surface.operationCount > 0);
  assert.ok(d.surface.facades.includes("sv_status"));
  assert.equal(typeof d.stores.artifacts.entries, "number");
  assert.equal(typeof d.stores.snapshotContexts.entries, "number");
  // accountedBytes 是逻辑驻留字节，不是 V8 heap 实测值；evictions 让配额是否生效可观测。
  assert.equal(typeof d.stores.snapshotContexts.accountedBytes, "number");
  assert.equal(typeof d.stores.snapshotContexts.evictions, "number");
  assert.equal(d.stores.snapshotContexts.ttlMs, 30 * 60_000);
  assert.equal(typeof d.stores.snapshotContexts.maxTotalBytes, "number");
});

test("sv_doctor summarizes committed host profiles", async () => {
  const d = await callDoctor();
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
    protoVersion: 2,
    pipePaths: { toSv: "a", fromSv: "b" },
    host: { state: "listening", epoch: 0, hostVersion: null, hostOps: [], knownHandleCount: 0, pendingExecutions: 0 },
    manifest: { available: false, generatedAt: null, schemaVersion: null },
    surface: { facades: ["sv_status"], facadeCount: 8, operationCount: 42 },
    stores: { artifacts: { entries: 0, bytes: 0 }, snapshotContexts: { entries: 0, accountedBytes: 0, evictions: 0, ttlMs: 1800000, maxTotalBytes: 67108864 } },
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
    pipePaths: { toSv: "a", fromSv: "b" },
    host: { state: "listening", epoch: 0, hostVersion: null, hostOps: [], knownHandleCount: 0, pendingExecutions: 0 },
    manifest: { available: true, generatedAt: "2025-01-01", schemaVersion: "1.0" },
    surface: { facades: ["sv_status"], facadeCount: 8, operationCount: 42 },
    stores: { artifacts: { entries: 0, bytes: 0 }, snapshotContexts: { entries: 0, accountedBytes: 0, evictions: 0, ttlMs: 1800000, maxTotalBytes: 67108864 } },
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
    protoVersion: 2,
    pipePaths: { toSv: "a", fromSv: "b" },
    host: { state: "attached", epoch: 1, hostVersion: "2.2.1", hostOps: [], knownHandleCount: 0, pendingExecutions: 0 },
    manifest: { available: true, generatedAt: "2025-01-01", schemaVersion: "1.0" },
    surface: { facades: ["sv_status"], facadeCount: 8, operationCount: 42 },
    stores: { artifacts: { entries: 0, bytes: 0 }, snapshotContexts: { entries: 0, accountedBytes: 0, evictions: 0, ttlMs: 1800000, maxTotalBytes: 67108864 } },
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
    protoVersion: 2,
    pipePaths: { toSv: "a", fromSv: "b" },
    host: forbiddenHost,
    manifest: { available: true, generatedAt: "2025-01-01", schemaVersion: "1.0" },
    surface: { facades: ["sv_status"], facadeCount: 8, operationCount: 42 },
    stores: { artifacts: { entries: 0, bytes: 0 }, snapshotContexts: { entries: 0, accountedBytes: 0, evictions: 0, ttlMs: 1800000, maxTotalBytes: 67108864 } },
  });
  assert.equal(report.transport.hostState, "listening");
  assert.equal(report.transport.hostVersion, null);
});

test("summarizeHostProfiles returns empty array for a missing directory", () => {
  // Doctor 绝不因为缺目录而抛错：它本身就是用来诊断缺失的工具。
  assert.deepEqual(summarizeHostProfiles(path.join(fixturesDir, "does-not-exist")), []);
});
