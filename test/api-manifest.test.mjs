import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(testDir, "..");
const parser = path.join(rootDir, "tools", "parse-sv-api-docs.mjs");
const manifestPath = path.join(rootDir, "api-docs", "api-manifest.json");

test("official API mirror parses into a typed class catalog", () => {
  execFileSync(process.execPath, [parser], { cwd: rootDir, stdio: "inherit" });
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  assert.ok(manifest.summary.classCount >= 20);
  assert.ok(manifest.summary.methodOverloadCount >= 200);
  assert.equal(manifest.classes.SV.members.QUARTER.type, "number");
  assert.ok(manifest.creatableTypes.includes("Note"));
  assert.ok(manifest.creatableTypes.includes("Automation"));
  assert.equal(manifest.classes.Note.methods.setLyrics[0].parameters[0].type, "string");
  assert.equal(manifest.classes.Automation.methods.remove.length, 2);
  assert.deepEqual(manifest.classes.Project.methods.newUndoRecord[0].returns, []);
  assert.match(manifest.classes.Project.methods.newUndoRecord[0].description, /undo record/i);
});
