import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(testDir, "..");
const parser = path.join(rootDir, "tools", "parse-sv-api-docs.mjs");
const repoManifest = path.join(rootDir, "api-docs", "api-manifest.json");
const repoInventory = path.join(rootDir, "api-docs", "api-inventory.json");

function snapshot(file) {
  return existsSync(file) ? readFileSync(file) : null;
}

function unchanged(before, after) {
  if (before === null || after === null) return before === after;
  return before.equals(after);
}

test("official API mirror parses into a typed class catalog (isolated output)", (t) => {
  const outputDir = mkdtempSync(path.join(os.tmpdir(), "sv-api-"));
  t.after(() => rmSync(outputDir, { recursive: true, force: true }));

  // 运行解析器不应把仓库里已提交的产物作为副作用改动。
  const before = { manifest: snapshot(repoManifest), inventory: snapshot(repoInventory) };

  execFileSync(process.execPath, [parser, "--output-dir", outputDir], { cwd: rootDir, stdio: "inherit" });

  const manifest = JSON.parse(readFileSync(path.join(outputDir, "api-manifest.json"), "utf8"));
  assert.ok(manifest.summary.classCount >= 20);
  assert.ok(manifest.summary.methodOverloadCount >= 200);
  assert.equal(manifest.classes.SV.members.QUARTER.type, "number");
  assert.ok(manifest.creatableTypes.includes("Note"));
  assert.ok(manifest.creatableTypes.includes("Automation"));
  assert.equal(manifest.classes.Note.methods.setLyrics[0].parameters[0].type, "string");
  assert.equal(manifest.classes.Automation.methods.remove.length, 2);
  assert.deepEqual(manifest.classes.Project.methods.newUndoRecord[0].returns, []);
  assert.match(manifest.classes.Project.methods.newUndoRecord[0].description, /undo record/i);

  const after = { manifest: snapshot(repoManifest), inventory: snapshot(repoInventory) };
  assert.ok(unchanged(before.manifest, after.manifest), "parser must not touch the committed api-manifest.json");
  assert.ok(unchanged(before.inventory, after.inventory), "parser must not touch the committed api-inventory.json");
});

test("parser rejects --output-dir without a value instead of falling back to api-docs/", () => {
  // 缺值/空值必须非零退出,且绝不触碰仓库里的正式产物。
  const before = { manifest: snapshot(repoManifest), inventory: snapshot(repoInventory) };
  for (const badArgs of [["--output-dir"], ["--output-dir="]]) {
    assert.throws(
      () => execFileSync(process.execPath, [parser, ...badArgs], { cwd: rootDir, stdio: "pipe" }),
      (error) => error.status === 2,
      `expected non-zero exit for: ${badArgs.join(" ") || "(empty)"}`
    );
  }
  const after = { manifest: snapshot(repoManifest), inventory: snapshot(repoInventory) };
  assert.ok(unchanged(before.manifest, after.manifest), "api-manifest.json must stay untouched");
  assert.ok(unchanged(before.inventory, after.inventory), "api-inventory.json must stay untouched");
});
