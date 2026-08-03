import { execFile, spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { writeFileSync } from "node:fs";

import { ArtifactStore } from "../server/src/artifact-store.js";
import {
  createNodeFitCandidate,
  runFitBenchmark,
  sealFitBenchmarkArtifact,
} from "./lib/fit-worker-benchmark.mjs";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const scipyWorker = path.join(here, "fit-worker-scipy.py");

function parseOptions(argumentsList) {
  const options = { skipScipy: false, python: "python", writeReport: null };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const current = argumentsList[index];
    if (current === "--skip-scipy") {
      options.skipScipy = true;
      continue;
    }
    if (current === "--python" || current === "--write-report") {
      const value = argumentsList[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${current} requires a value`);
      if (current === "--python") options.python = value;
      else options.writeReport = path.resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`unknown option: ${current}`);
  }
  return options;
}

async function detectScipy(python) {
  try {
    const { stdout } = await execFileAsync(
      python,
      [
        "-c",
        "import json, numpy, pathlib, scipy, sys; modules={'numpy': numpy, 'scipy': scipy}; sizes={name: sum(path.stat().st_size for path in pathlib.Path(module.__file__).parent.rglob('*') if path.is_file()) for name, module in modules.items()}; print(json.dumps({'python': sys.version.split()[0], 'scipy': scipy.__version__, 'packageBytes': sizes}))",
      ],
      { encoding: "utf8", windowsHide: true },
    );
    const versions = JSON.parse(stdout);
    return {
      available: true,
      python,
      pythonVersion: versions.python,
      scipyVersion: versions.scipy,
      packageBytes: versions.packageBytes,
    };
  } catch (error) {
    return { available: false, reason: error.code ?? error.name };
  }
}

function createScipyCandidate(scipy) {
  const worker = new ScipyWorker(scipy.python);
  return Object.freeze({
    id: "scipy-least-squares",
    engine: Object.freeze({ name: "scipy-least-squares", version: scipy.scipyVersion }),
    python: Object.freeze({
      executable: scipy.python,
      version: scipy.pythonVersion,
      scipyVersion: scipy.scipyVersion,
    }),
    packaging: Object.freeze({
      eligible: false,
      status: "benchmark_only_not_packaged",
      addedRuntimeDependencies: "SciPy runtime not declared by server/package.json",
      windowsMacosInstall: "not_automated",
    }),
    dependencyFootprint: Object.freeze({
      addedRuntimePackages: Object.keys(scipy.packageBytes).length,
      addedRuntimeBytes: Object.values(scipy.packageBytes).reduce((total, value) => total + value, 0),
      localPackageBytes: Object.freeze({ ...scipy.packageBytes }),
      status: "local_benchmark_environment_only",
    }),
    license: Object.freeze({
      eligible: false,
      status: "benchmark_only_notice_not_added",
    }),
    crashIsolation: Object.freeze({ eligible: true, status: "subprocess" }),
    async fit(request) {
      return worker.fit(request);
    },
    async verifyTimeoutRecovery() {
      return { eligible: false, status: "not_selected_for_timeout_packaging" };
    },
    getStartupCostMs() {
      return worker.startupCostMs ?? 0;
    },
    async dispose() {
      await worker.dispose();
    },
  });
}

class ScipyWorker {
  constructor(python) {
    this.python = python;
    this.child = null;
    this.pending = null;
    this.stdout = "";
    this.stderr = "";
    this.startedAt = null;
    this.startupCostMs = null;
  }

  fit(request) {
    this.start();
    if (this.pending) {
      return Promise.reject(codedError("FIT_WORKER_UNAVAILABLE", "SciPy worker received overlapping requests"));
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pending;
        this.pending = null;
        this.child?.kill();
        this.child = null;
        pending?.reject(codedError("FIT_TIMEOUT", "SciPy worker exceeded its request timeout"));
      }, request.limits.timeoutMs + 250);
      this.pending = { resolve, reject, timeout };
      this.child.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
        if (!error) return;
        this.fail(error);
      });
    });
  }

  start() {
    if (this.child) return;
    const child = spawn(this.python, [scipyWorker], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    this.stdout = "";
    this.stderr = "";
    this.startedAt = performance.now();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.consumeStdout(chunk));
    child.stderr.on("data", (chunk) => { this.stderr = `${this.stderr}${chunk}`.slice(-512); });
    child.once("error", (error) => this.fail(error));
    child.once("close", (code) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.pending) {
        this.fail(codedError("FIT_WORKER_UNAVAILABLE", "SciPy worker exited", {
          code,
          stderr: this.stderr,
        }));
      }
    });
  }

  consumeStdout(chunk) {
    this.stdout += chunk;
    let newline = this.stdout.indexOf("\n");
    while (newline >= 0) {
      const line = this.stdout.slice(0, newline);
      this.stdout = this.stdout.slice(newline + 1);
      newline = this.stdout.indexOf("\n");
      if (!line || !this.pending) continue;
      const pending = this.pending;
      this.pending = null;
      clearTimeout(pending.timeout);
      try {
        const response = JSON.parse(line);
        if (this.startupCostMs === null) this.startupCostMs = performance.now() - this.startedAt;
        pending.resolve(response);
      } catch {
        pending.reject(codedError("FIT_WORKER_UNAVAILABLE", "SciPy worker returned invalid JSON"));
      }
    }
  }

  fail(error) {
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
  }

  async dispose() {
    if (!this.child) return;
    const child = this.child;
    this.child = null;
    child.kill();
    await new Promise((resolve) => child.once("close", resolve));
  }
}

function codedError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const candidates = [createNodeFitCandidate()];
  const excludedCandidates = [{
    id: "rust-or-wasm",
    status: "not_benchmarked",
    reason: "no pinned implementation or distributable artifact exists in this repository",
  }];
  if (!options.skipScipy) {
    const scipy = await detectScipy(options.python);
    if (scipy.available) candidates.push(createScipyCandidate(scipy));
    else excludedCandidates.push({
      id: "scipy-least-squares",
      status: "unavailable",
      reason: scipy.reason,
    });
  }
  const benchmark = await runFitBenchmark({ candidates });
  const report = {
    ...benchmark,
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      python: candidates.find((candidate) => candidate.id === "scipy-least-squares")?.python ?? null,
      hardware: {
        cpuModel: os.cpus()[0]?.model ?? "unknown",
        logicalCores: os.cpus().length,
        totalMemoryBytes: os.totalmem(),
      },
    },
    excludedCandidates,
  };
  const artifact = sealFitBenchmarkArtifact({
    artifactStore: new ArtifactStore({ now: () => 0 }),
    report,
    sessionId: "fit-benchmark-tool",
  });
  const output = {
    ...report,
    artifact: {
      kind: artifact.kind,
      schemaVersion: artifact.schemaVersion,
      contentHash: artifact.contentHash,
      totalBytes: artifact.totalBytes,
    },
  };
  const outputText = `${JSON.stringify(output, null, 2)}\n`;
  if (options.writeReport) writeFileSync(options.writeReport, outputText, "utf8");
  process.stdout.write(outputText);
}

await main();
