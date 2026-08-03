import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { contentHash } from "../server/src/canonical-json.js";
import {
  loadPitchTechniqueCorpus,
  PITCH_TECHNIQUE_CORPUS_DIRECTORY,
} from "./helpers/pitch-technique-corpus.mjs";
import {
  createSyntheticPitchTechniqueCorpus,
  syntheticPitchTechniqueCorpusHash,
} from "../tools/generate-pitch-technique-corpus.mjs";

test("synthetic pitch-technique corpus is replayable and complete", () => {
  const loaded = loadPitchTechniqueCorpus();
  assert.equal(loaded.hash, syntheticPitchTechniqueCorpusHash());
  assert.equal(loaded.hash, contentHash(createSyntheticPitchTechniqueCorpus()));
  assert.equal(loaded.manifest.caseCount, 20);
  assert.deepEqual(
    new Set(loaded.corpus.cases.map((current) => current.family)),
    new Set([
      "richards_segment",
      "richards_asymptotic",
      "first_peak_transient",
      "second_order_impulse",
      "time_varying_vibrato",
      "uniform_seconds_grid",
      "open_loop_correction",
      "technique_composition",
      "pitch_delta_transition",
    ]),
  );
  assert.equal(Object.isFrozen(loaded.corpus), true);
  assert.ok(loaded.corpus.cases.every((current) => current.seed !== loaded.corpus.seed));
});

test("synthetic pitch-technique corpus rejects fixture corruption", () => {
  withTemporaryCorpus((directory) => {
    const corpusPath = path.join(directory, "synthetic-corpus.v1.json");
    const source = JSON.parse(readFileSync(corpusPath, "utf8"));
    source.cases[0].denseTruth.values[1] += 0.01;
    writeFileSync(corpusPath, JSON.stringify(source), "utf8");
    assert.throws(
      () => loadPitchTechniqueCorpus({ fixtureDirectory: directory }),
      (error) => error.code === "PITCH_TECHNIQUE_CORPUS_HASH_MISMATCH",
    );
  });
});

test("synthetic pitch-technique corpus rejects incomplete cases even with a matching hash", () => {
  withTemporaryCorpus((directory) => {
    const corpusPath = path.join(directory, "synthetic-corpus.v1.json");
    const manifestPath = path.join(directory, "manifest.v1.json");
    const source = JSON.parse(readFileSync(corpusPath, "utf8"));
    delete source.cases[0].seed;
    writeFileSync(corpusPath, JSON.stringify(source), "utf8");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.corpusHash = contentHash(source);
    writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
    assert.throws(
      () => loadPitchTechniqueCorpus({ fixtureDirectory: directory }),
      (error) => error.code === "PITCH_TECHNIQUE_CORPUS_INVALID_CASE",
    );
  });
});

function withTemporaryCorpus(run) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "svcopilot-pitch-corpus-"));
  try {
    for (const fileName of ["manifest.v1.json", "synthetic-corpus.v1.json"]) {
      writeFileSync(
        path.join(directory, fileName),
        readFileSync(path.join(PITCH_TECHNIQUE_CORPUS_DIRECTORY, fileName)),
      );
    }
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
