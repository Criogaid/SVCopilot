// 只读安装诊断（Phase 7A）。
//
// 目的是定位版本错配与 staging/loaded Lua 不一致，而不是"检查一切"。
// 硬约束：
//   - 绝不写盘、绝不改宿主状态、绝不调 setter。
//   - 绝不连接宿主来"补全"信息。宿主未连接时如实报 detached，不猜测。
//   - 找不到的东西报 not_found 并给出查找过的路径，不静默填默认值——
//     Doctor 存在的意义正是发现"你以为加载了的脚本不在那里"。
//   - 只报文件哈希与长度，不回显脚本内容或环境变量值。

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// loaded 脚本在仓库外：SynthV 递归扫描 scripts/，Node 代码与测试必须留在那棵树之外。
// 相对 server/src/ 的候选路径（src → server → SVCopilot → "Synthesizer V Studio 2"），
// 按优先级排列。
const LOADED_BRIDGE_CANDIDATES = [
  "../../../scripts/SynthVCopilotResearch/copilot/sv-scripts/StartSynthVCopilot.lua",
];
const STAGING_BRIDGE = "../../staging/StartSynthVCopilotPipe.lua";

// 只提取能安全公开的标记：协议版本与声明的 opcode。不提取路径、不提取任意代码。
function extractBridgeMarkers(source) {
  const protoMatch = source.match(/^\s*PROTO_VERSION\s*=\s*(\d+)/m);
  const opsMatch = source.match(/ops\s*=\s*\{([^}]*)\}/);
  const declaredOps = opsMatch
    ? [...opsMatch[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map((match) => match[1] ?? match[2]).sort()
    : [];
  return {
    protoVersion: protoMatch ? Number(protoMatch[1]) : null,
    declaredOps,
  };
}

function inspectBridgeScript(absolutePath) {
  let source;
  try {
    source = fs.readFileSync(absolutePath, "utf8");
  } catch (error) {
    return { status: error.code === "ENOENT" ? "not_found" : "unreadable", path: absolutePath };
  }
  // 行尾归一化后再哈希：loaded 与 staging 的 CRLF/LF 差异不是语义漂移，
  // 否则 Doctor 会对每个 checkout 报假不一致。
  const normalized = source.replace(/\r\n/g, "\n");
  return {
    status: "found",
    path: absolutePath,
    sha256: createHash("sha256").update(normalized, "utf8").digest("hex"),
    bytes: Buffer.byteLength(normalized, "utf8"),
    lines: normalized.split("\n").length,
    ...extractBridgeMarkers(normalized),
  };
}

function firstExisting(baseDir, candidates) {
  const searched = [];
  for (const candidate of candidates) {
    const absolutePath = path.resolve(baseDir, candidate);
    searched.push(absolutePath);
    if (fs.existsSync(absolutePath)) return inspectBridgeScript(absolutePath);
  }
  return { status: "not_found", searchedPaths: searched };
}

// loaded 与 staging 的比较结论。CLAUDE.md 的约定是两者在注释/措辞上可以不同，
// 但 dispatcher 与 typed-v2 行为必须一致——哈希不同因此不是错误，只是"需要人核对"。
function compareBridges(loaded, staging) {
  if (loaded.status !== "found" || staging.status !== "found") {
    return {
      verdict: "not_comparable",
      reason: `loaded=${loaded.status}, staging=${staging.status}`,
    };
  }
  if (loaded.sha256 === staging.sha256) {
    return { verdict: "identical" };
  }
  const protoMatches = loaded.protoVersion === staging.protoVersion;
  const opsMatch =
    loaded.declaredOps.length === staging.declaredOps.length &&
    loaded.declaredOps.every((op, index) => op === staging.declaredOps[index]);
  if (protoMatches && opsMatch) {
    return {
      // 已知会发生且被明确允许的差异：仅注释/措辞。不宣称"功能等价"——
      // 哈希无法证明 dispatcher 行为一致，只有 dispatcher_test.lua 能。
      verdict: "differs_in_text_only",
      protoVersion: loaded.protoVersion,
      declaredOps: loaded.declaredOps,
      note: "Interface markers agree. Byte differences may be comments only; run dispatcher_test.lua against both scripts to check dispatcher behavior.",
    };
  }
  return {
    verdict: "interface_mismatch",
    loaded: { protoVersion: loaded.protoVersion, declaredOps: loaded.declaredOps },
    staging: { protoVersion: staging.protoVersion, declaredOps: staging.declaredOps },
    note: "The loaded host script and the in-repo reference declare different protocol markers; the running bridge is not the one this server was tested against.",
  };
}

/**
 * 采集只读安装诊断。
 *
 * @param {object} deps
 * @param {string} deps.interfaceVersion
 * @param {string} deps.moduleDir - server/src 的绝对路径（用于解析脚本候选位置）
 * @param {number} deps.protoVersion - Node 侧期望的传输协议版本
 * @param {object} deps.pipePaths - {toSv, fromSv}
 * @param {object} deps.host - HostSession.getStatus() 的返回值
 * @param {object} deps.manifest - { available, generatedAt, schemaVersion }
 * @param {object} deps.surface - { facades, facadeCount, operationCount }
 * @param {object} deps.stores - { artifacts, contexts }
 * @param {object[]} [deps.hostProfiles] - 已提交 host profile 的摘要
 * @param {object} [deps.runtimeHostProfile] - 当前宿主的精确 profile 匹配摘要
 * @returns {object}
 */
export function collectDoctorReport({
  interfaceVersion,
  moduleDir,
  protoVersion,
  pipePaths,
  host,
  manifest,
  surface,
  stores,
  hostProfiles = [],
  runtimeHostProfile = null,
}) {
  const loaded = firstExisting(moduleDir, LOADED_BRIDGE_CANDIDATES);
  const staging = inspectBridgeScript(path.resolve(moduleDir, STAGING_BRIDGE));
  const bridgeComparison = compareBridges(loaded, staging);

  const findings = [];
  if (loaded.status === "not_found") {
    findings.push({
      severity: "error",
      code: "LOADED_BRIDGE_NOT_FOUND",
      message:
        "The host bridge script was not found. SynthV cannot attach without it; copy staging/StartSynthVCopilotPipe.lua into the scanned scripts directory.",
      searchedPaths: loaded.searchedPaths,
    });
  }
  if (staging.status === "not_found") {
    findings.push({
      severity: "warning",
      code: "STAGING_BRIDGE_NOT_FOUND",
      message: "The in-repo reference bridge copy is missing; loaded/staging drift cannot be checked.",
    });
  }
  if (bridgeComparison.verdict === "interface_mismatch") {
    findings.push({
      severity: "error",
      code: "BRIDGE_INTERFACE_MISMATCH",
      message: bridgeComparison.note,
    });
  }
  // 协议版本要对每个找得到的脚本都检查。只查 loaded 会在 loaded 缺失时静默跳过，
  // 而那正是最需要知道"手上这份 staging 能不能用"的时候。
  for (const [label, script] of [
    ["loaded", loaded],
    ["staging", staging],
  ]) {
    if (script.status !== "found" || script.protoVersion === null) continue;
    if (script.protoVersion === protoVersion) continue;
    findings.push({
      severity: label === "loaded" ? "error" : "warning",
      code: "PROTO_VERSION_MISMATCH",
      message: `The ${label} bridge declares PROTO_VERSION ${script.protoVersion} but this server speaks ${protoVersion}; the handshake would be rejected.`,
      script: label,
    });
  }
  if (!manifest.available) {
    findings.push({
      severity: "error",
      code: "API_MANIFEST_UNAVAILABLE",
      message:
        "The parsed SV API manifest is not loaded; sv_search_api, sv_describe and sv_call pre-flight are degraded. Run 'npm run parse:sv-api'.",
    });
  }
  if (host.state !== "attached") {
    findings.push({
      severity: "info",
      code: "HOST_NOT_ATTACHED",
      message: `The bridge is ${host.state}; every host-backed tool will fail until SynthV runs the Start script. This is expected when SynthV is closed.`,
    });
  }
  // 桥已连接但没宣告 opcode：批量读取会静默回退到逐 getter。回退是正确行为，
  // 但如果用户以为自己在跑新桥，性能数字会莫名其妙——所以要说出来。
  if (host.state === "attached" && (host.hostOps ?? []).length === 0) {
    findings.push({
      severity: "warning",
      code: "NO_NEGOTIATED_HOST_OPS",
      message:
        "The attached bridge declared no internal ops, so bulk note-fingerprint reads fall back to per-getter calls. The loaded script is probably older than this server.",
    });
  }

  return {
    // 诊断本身完成了，因此 status 是 succeeded——即使报告里有 error 级 finding。
    // 「安装是否健康」是另一个问题（§4.5：status 只回答「调用方要求的操作是否完成」），
    // 把它混进 status 会让模型以为诊断调用失败了，而实际上诊断成功地发现了问题。
    status: "succeeded",
    // 刻意不叫 `ok`：与 status 并存的 `ok` 会被编码器当成同义冗余剥掉（那条规则是
    // 对的——绝大多数 `ok` 确实只是 status 的第二份副本）。这个字段承载的是别的
    // 结论，因此用能说清它是什么的名字。
    installationHealthy: !findings.some((finding) => finding.severity === "error"),
    kind: "svcopilot-doctor",
    generatedAt: new Date().toISOString(),
    versions: {
      interfaceVersion,
      protoVersionExpected: protoVersion,
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
    },
    bridge: { loaded, staging, comparison: bridgeComparison },
    transport: {
      pipes: pipePaths,
      hostState: host.state,
      epoch: host.epoch,
      // 宿主版本只有连上之后才可读；未连接时是 null，不是"未知版本"。
      hostVersion: host.hostVersion ?? null,
      hostProduct: host.hostProduct ?? null,
      negotiatedOps: host.hostOps ?? [],
      knownHandleCount: host.knownHandleCount ?? 0,
      pendingExecutions: host.pendingExecutions ?? 0,
    },
    manifest,
    surface,
    stores,
    hostProfiles,
    runtimeHostProfile,
    findings,
  };
}

/**
 * 采集已提交 host profile 的摘要（只读，不采集新证据）。
 *
 * @param {string} fixturesDir
 * @returns {object[]}
 */
export function summarizeHostProfiles(fixturesDir) {
  let names;
  try {
    names = fs.readdirSync(fixturesDir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  return names.sort().map((name) => {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(fixturesDir, name), "utf8"));
      const semantics = parsed.semantics ?? {};
      const statusCounts = {};
      for (const entry of Object.values(semantics)) {
        const status = entry?.status ?? "unknown";
        statusCounts[status] = (statusCounts[status] ?? 0) + 1;
      }
      return {
        file: name,
        schemaVersion: parsed.schemaVersion ?? null,
        profileId: parsed.profileId ?? null,
        // hostSelector 是去身份化的宿主标识（版本/平台），不含工程或用户信息。
        hostSelector: parsed.hostSelector ?? null,
        capturedAt: parsed.capturedAt ?? null,
        // 只有 confirmed 能驱动严格模拟；把计数摊开是为了让"离线测试冒充真机保证"
        // 这件事在诊断输出里显而易见。
        semanticStatusCounts: statusCounts,
      };
    } catch {
      return { file: name, status: "unreadable" };
    }
  });
}
