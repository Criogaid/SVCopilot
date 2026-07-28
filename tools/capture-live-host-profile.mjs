import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  compileReadOnlyHostProfile,
  diffHostBehaviorProfiles,
  validateHostBehaviorProfile,
} from "./lib/host-behavior-profile.mjs";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROBE_CLI = path.resolve(
  HERE,
  "..",
  "..",
  "scripts",
  "SVLiveProbe",
  "sv-live-probe.mjs"
);

async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  const probeCli = path.resolve(options.probeCli ?? DEFAULT_PROBE_CLI);
  if (!existsSync(probeCli)) {
    throw new Error(`SV Live Probe CLI not found: ${probeCli}`);
  }

  const hostEnvelope = await runProbe(probeCli, ["host"]);
  const groupsEnvelope = await runProbe(probeCli, ["groups", "--max-groups", "2048"]);
  const selected = selectPitchOccurrence(groupsEnvelope);
  const pitchEnvelope = await runProbe(probeCli, [
    "pitch",
    "--track",
    String(selected.trackIndex),
    "--group",
    String(selected.groupIndex),
    "--frames",
    String(options.frames),
    "--repeat",
    String(options.repeat),
    "--delay-ms",
    String(options.delayMs),
  ]);
  const profile = compileReadOnlyHostProfile({
    hostEnvelope,
    groupsEnvelope,
    pitchEnvelope,
  });

  const outputPath = resolveOutputPath(options.output, profile.profileId);
  if (existsSync(outputPath) && options.force !== true) {
    throw new Error(`output already exists: ${outputPath}; pass --force to replace it`);
  }
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(profile, null, 2)}\n`, "utf8");

  let comparison = null;
  if (options.baseline) {
    const baseline = validateHostBehaviorProfile(
      JSON.parse(readFileSync(path.resolve(options.baseline), "utf8"))
    );
    comparison = diffHostBehaviorProfiles(baseline, profile);
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        output: outputPath,
        profileId: profile.profileId,
        hostSelector: profile.hostSelector,
        semanticSummary: summarizeSemantics(profile),
        comparison,
      },
      null,
      2
    )
  );
}

async function runProbe(probeCli, args) {
  const { stdout } = await execFileAsync(process.execPath, [probeCli, ...args], {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  });
  return JSON.parse(stdout);
}

function selectPitchOccurrence(groupsEnvelope) {
  const groups = groupsEnvelope?.result?.groups;
  if (!Array.isArray(groups)) throw new Error("SV Live Probe groups response is malformed");
  const candidates = groups.filter(
    (item) =>
      item &&
      item.instrumental !== true &&
      Number.isSafeInteger(item.noteCount) &&
      item.noteCount > 0 &&
      Number.isSafeInteger(item.trackIndex) &&
      Number.isSafeInteger(item.groupIndex)
  );
  candidates.sort((a, b) => scorePitchCandidate(b) - scorePitchCandidate(a));
  if (candidates.length === 0) {
    throw new Error("no non-empty vocal occurrence is available for computed-pitch observation");
  }
  return candidates[0];
}

function scorePitchCandidate(item) {
  let score = 0;
  if (item.timeOffsetBlick !== 0) score += 4;
  if (item.pitchOffset !== 0) score += 2;
  if (
    Number.isSafeInteger(item.referenceOnsetBlick) &&
    Number.isSafeInteger(item.targetFirstNoteOnsetBlick) &&
    item.referenceOnsetBlick !== item.timeOffsetBlick + item.targetFirstNoteOnsetBlick
  ) {
    score += 1;
  }
  return score;
}

function resolveOutputPath(explicit, profileId) {
  if (explicit) return path.resolve(explicit);
  const root =
    process.env.LOCALAPPDATA ||
    path.join(os.tmpdir(), "SVCopilot-local");
  return path.join(
    root,
    "SVCopilot",
    "host-profiles",
    "candidates",
    `${profileId}-${Date.now()}.json`
  );
}

function summarizeSemantics(profile) {
  const counts = { confirmed: 0, contradicted: 0, unknown: 0, not_observable: 0 };
  for (const fact of Object.values(profile.semantics)) counts[fact.status] += 1;
  return counts;
}

function parseArgs(args) {
  const options = {
    output: null,
    baseline: null,
    probeCli: null,
    force: false,
    frames: 160,
    repeat: 3,
    delayMs: 250,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--force") {
      options.force = true;
      continue;
    }
    if (["--output", "--baseline", "--probe-cli"].includes(arg)) {
      const value = args[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      options[arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
      index += 1;
      continue;
    }
    if (["--frames", "--repeat", "--delay-ms"].includes(arg)) {
      const value = Number(args[index + 1]);
      const minimum = arg === "--delay-ms" ? 0 : arg === "--repeat" ? 2 : 1;
      if (!Number.isSafeInteger(value) || value < minimum) {
        throw new Error(`${arg} requires an integer >= ${minimum}`);
      }
      const key = arg === "--delay-ms" ? "delayMs" : arg.slice(2);
      options[key] = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

main().catch((error) => {
  console.error(`[host-profile] ${error.message}`);
  process.exitCode = 1;
});
