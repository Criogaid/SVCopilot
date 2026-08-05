// 把一次实机 API 表面采集与官方文档 manifest 比对，产出两类输出：
//
//   1. tools/out/api-surface-<ts>.json + -latest.json —— 完整明细，gitignored。
//   2. --evidence <path> —— 精简、脱敏、可提交的证据文件，含 conclusion 块。
//
// 采集文件由 staging/SVApiSurfaceProbe.lua 生成（宿主通过本地链接读取；它直接写盘，
// 不经管道，因此不受 64 KiB 帧上限约束）。本工具是纯离线后处理：不连宿主、不碰工程。
//
// 用法：
//   cd server && npm run api-surface:diff -- --input <capture.json>
//   cd server && npm run api-surface:diff -- --input <capture.json> --evidence
//
// 退出码：差异存在不算失败（那正是要找的东西）；只有输入非法或写盘失败才非零。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  buildApiSurfaceEvidence,
  diffApiSurface,
  normalizeApiSurfaceCapture,
  summarizeApiSurface,
} from "./lib/api-surface.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const OUT_DIR = path.join(HERE, "out");
const DEFAULT_MANIFEST = path.join(REPO_ROOT, "api-docs", "api-manifest.json");
const EVIDENCE_DIR = path.join(REPO_ROOT, "docs", "operations", "evidence");

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const capturePath = path.resolve(options.input);
  if (!existsSync(capturePath)) {
    throw new Error(`capture file not found: ${capturePath}`);
  }
  const manifestPath = path.resolve(options.manifest ?? DEFAULT_MANIFEST);
  if (!existsSync(manifestPath)) {
    throw new Error(
      `API manifest not found: ${manifestPath}; run 'npm run parse:sv-api' first`
    );
  }

  const capture = normalizeApiSurfaceCapture(readJson(capturePath, "capture"));
  const manifest = readJson(manifestPath, "manifest");
  const diff = diffApiSurface(capture, manifest);
  const summary = summarizeApiSurface(diff);

  const report = {
    tool: "api-surface-diff",
    generatedAt: new Date().toISOString(),
    capture: {
      schemaVersion: capture.schemaVersion,
      capturedAt: capture.capturedAt,
      host: capture.host,
      probe: capture.probe,
    },
    manifestGeneratedAt: diff.manifestGeneratedAt,
    summary,
    // 健康度指标要跟报告一起留档，而不只留 warnings：事后回看时，判断"那次采集
    // 是否可信"靠的是 callable 比例、试调次数和真实 luaType 分布，光有一个空的
    // warnings 数组说明不了任何事。
    captureHealth: diff.captureHealth,
    undocumented: diff.undocumented,
    missing: diff.missing,
    unavailable: diff.unavailable,
    ...(diff.semanticProbes ? { semanticProbes: diff.semanticProbes } : {}),
  };

  mkdirSync(OUT_DIR, { recursive: true });
  const stamped = path.join(OUT_DIR, `api-surface-${Date.now()}.json`);
  writeJson(stamped, report);
  writeJson(path.join(OUT_DIR, "api-surface-latest.json"), report);

  let evidencePath = null;
  if (options.evidence !== false) {
    evidencePath = path.resolve(
      typeof options.evidence === "string" && options.evidence.length > 0
        ? options.evidence
        : defaultEvidencePath(capture.host)
    );
    if (existsSync(evidencePath) && options.force !== true) {
      throw new Error(`evidence already exists: ${evidencePath}; pass --force to replace it`);
    }
    const evidence = buildApiSurfaceEvidence({ diff, summary });
    mkdirSync(path.dirname(evidencePath), { recursive: true });
    writeJson(evidencePath, evidence);
  }

  printHumanSummary({ summary, diff, stamped, evidencePath });
}

// 人类可读投影写 stderr，机器可读的 JSON 摘要写 stdout——与仓库里其他探针一致，
// 便于 `... | node -e` 之类的管道用法。
function printHumanSummary({ summary, diff, stamped, evidencePath }) {
  const parity = summary.resultCode === "API_SURFACE_PARITY_CONFIRMED" ? "CONFIRMED" : "DIVERGED";
  console.error(`[api-surface] parity: ${parity}`);
  console.error(
    `[api-surface] matched=${summary.matchedCount} undocumented=${summary.undocumentedCount} ` +
      `missing=${summary.missingCount} unavailable=${summary.unavailableCount}`
  );
  // 采集本身失败时，差异结果毫无意义——必须先喊出来，否则"全部成员误判成 value"
  // 那种 bug 会伪装成一份正常报告。
  if (summary.captureWarnings.length > 0) {
    console.error("[api-surface] CAPTURE PROBLEM — the diff below is not trustworthy:");
    for (const warning of summary.captureWarnings) {
      console.error(`  ! ${warning}`);
    }
    const health = diff.captureHealth;
    const observed = health.observedLuaTypes;
    console.error(
      `  observed luaTypes=${observed.length > 0 ? observed.join(",") : "(none recorded)"} ` +
        `callable=${health.callableCount}/${health.memberCount} trials=${health.trialCount}`
    );
  }
  if (diff.undocumented.length > 0) {
    console.error("[api-surface] runtime members missing from the official manifest:");
    for (const item of diff.undocumented) {
      const trial = item.trial?.status === "ok" ? ` -> ${item.trial.returnedType}` : "";
      console.error(`  + ${item.className}.${item.member} (${item.scope})${trial}`);
    }
  }
  if (diff.unavailable.length > 0) {
    console.error("[api-surface] classes the probe could not instantiate:");
    for (const item of diff.unavailable) {
      console.error(`  ? ${item.name} (${item.origin}) ${item.reason}`);
    }
  }
  if (diff.semanticProbes) {
    const scan = diff.semanticProbes.scan;
    console.error(
      `[api-surface] semantic shapes: tracks=${scan.tracksVisited} ` +
        `vocalGroups=${scan.vocalGroupsVisited} truncated=${scan.truncated}`
    );
    for (const method of diff.semanticProbes.methods) {
      console.error(
        `  ~ ${method.className}.${method.method} attempted=${method.attempted} ` +
          `succeeded=${method.succeeded} shapes=${method.distinctShapes}`
      );
    }
  }
  console.error(`[api-surface] report: ${stamped}`);
  if (evidencePath) console.error(`[api-surface] evidence: ${evidencePath}`);
  console.log(JSON.stringify(summary, null, 2));
}

function defaultEvidencePath(host) {
  const slug = `${host.version}-${host.platform}`.replace(/[^A-Za-z0-9.-]+/g, "-");
  return path.join(EVIDENCE_DIR, `api-surface-synthv-${slug}.json`);
}

function readJson(file, label) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not readable JSON (${file}): ${error.message}`);
  }
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseArgs(args) {
  const options = { input: null, manifest: null, evidence: false, force: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--force") {
      options.force = true;
      continue;
    }
    if (arg === "--evidence") {
      // 可选带值：--evidence 用默认路径，--evidence <path> 指定路径。
      const next = args[index + 1];
      if (next && !next.startsWith("--")) {
        options.evidence = next;
        index += 1;
      } else {
        options.evidence = true;
      }
      continue;
    }
    if (arg === "--input" || arg === "--manifest") {
      const value = args[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      options[arg.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.input) {
    throw new Error("--input <capture.json> is required (produced by SVApiSurfaceProbe)");
  }
  return options;
}

try {
  main();
} catch (error) {
  console.error(`[api-surface] ${error.message}`);
  process.exitCode = 1;
}
