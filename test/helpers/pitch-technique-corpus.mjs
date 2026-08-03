import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { contentHash } from "../../server/src/canonical-json.js";

export const PITCH_TECHNIQUE_CORPUS_DIRECTORY = fileURLToPath(
  new URL("../fixtures/pitch-techniques", import.meta.url),
);

const MANIFEST_FILE = "manifest.v1.json";
const REQUIRED_CASE_FIELDS = [
  "id",
  "family",
  "input",
  "sampleSeconds",
  "denseTruth",
  "mask",
  "invariants",
  "tolerance",
  "seed",
];

export function loadPitchTechniqueCorpus({ fixtureDirectory = PITCH_TECHNIQUE_CORPUS_DIRECTORY } = {}) {
  const manifest = readJson(path.join(fixtureDirectory, MANIFEST_FILE), "manifest");
  assertExactKeys(
    manifest,
    ["kind", "schemaVersion", "corpusFile", "corpusHash", "caseCount", "caseIds"],
    "manifest",
  );
  if (manifest.kind !== "svcopilot-pitch-techniques-corpus-manifest") {
    throw corpusError("PITCH_TECHNIQUE_CORPUS_INVALID_MANIFEST", "manifest.kind is unsupported");
  }
  if (manifest.schemaVersion !== 1) {
    throw corpusError("PITCH_TECHNIQUE_CORPUS_INVALID_MANIFEST", "manifest.schemaVersion must be 1");
  }
  if (typeof manifest.corpusFile !== "string" || !manifest.corpusFile.endsWith(".json")) {
    throw corpusError("PITCH_TECHNIQUE_CORPUS_INVALID_MANIFEST", "manifest.corpusFile must name a JSON file");
  }
  if (!/^sha256_[0-9a-f]{64}$/.test(manifest.corpusHash)) {
    throw corpusError("PITCH_TECHNIQUE_CORPUS_INVALID_MANIFEST", "manifest.corpusHash must be a content hash");
  }
  if (!Number.isSafeInteger(manifest.caseCount) || manifest.caseCount < 1) {
    throw corpusError("PITCH_TECHNIQUE_CORPUS_INVALID_MANIFEST", "manifest.caseCount must be a positive safe integer");
  }
  if (!Array.isArray(manifest.caseIds) || manifest.caseIds.some((id) => typeof id !== "string" || !id)) {
    throw corpusError("PITCH_TECHNIQUE_CORPUS_INVALID_MANIFEST", "manifest.caseIds must be non-empty strings");
  }

  const corpus = readJson(path.join(fixtureDirectory, manifest.corpusFile), "corpus");
  const actualHash = contentHash(corpus);
  if (actualHash !== manifest.corpusHash) {
    throw corpusError(
      "PITCH_TECHNIQUE_CORPUS_HASH_MISMATCH",
      "synthetic corpus content hash does not match its manifest",
      { expected: manifest.corpusHash, actual: actualHash },
    );
  }
  validateCorpus(corpus, manifest);
  return Object.freeze({ corpus: deepFreeze(corpus), manifest: deepFreeze(manifest), hash: actualHash });
}

function validateCorpus(corpus, manifest) {
  assertExactKeys(corpus, ["kind", "schemaVersion", "truthSource", "seed", "cases"], "corpus");
  if (corpus.kind !== "svcopilot-pitch-techniques-synthetic-corpus") {
    throw corpusError("PITCH_TECHNIQUE_CORPUS_INVALID", "corpus.kind is unsupported");
  }
  if (corpus.schemaVersion !== 1 || !Number.isSafeInteger(corpus.seed)) {
    throw corpusError("PITCH_TECHNIQUE_CORPUS_INVALID", "corpus version or seed is invalid");
  }
  if (typeof corpus.truthSource !== "string" || !corpus.truthSource) {
    throw corpusError("PITCH_TECHNIQUE_CORPUS_INVALID", "corpus.truthSource is required");
  }
  if (!Array.isArray(corpus.cases) || corpus.cases.length !== manifest.caseCount) {
    throw corpusError("PITCH_TECHNIQUE_CORPUS_INVALID", "corpus case count does not match manifest");
  }
  const ids = [];
  for (const [index, current] of corpus.cases.entries()) {
    validateCase(current, index);
    ids.push(current.id);
  }
  if (new Set(ids).size !== ids.length) {
    throw corpusError("PITCH_TECHNIQUE_CORPUS_INVALID", "corpus case IDs must be unique");
  }
  if (JSON.stringify(ids) !== JSON.stringify(manifest.caseIds)) {
    throw corpusError("PITCH_TECHNIQUE_CORPUS_INVALID", "manifest case IDs do not match corpus order");
  }
}

function validateCase(current, index) {
  if (!current || typeof current !== "object" || Array.isArray(current)) {
    throw corpusError("PITCH_TECHNIQUE_CORPUS_INVALID_CASE", `case ${index} must be an object`);
  }
  const allowed = current.expectedError
    ? [...REQUIRED_CASE_FIELDS, "expectedError"]
    : REQUIRED_CASE_FIELDS;
  assertExactKeys(current, allowed, `case ${index}`);
  for (const field of REQUIRED_CASE_FIELDS) {
    if (!Object.hasOwn(current, field)) {
      throw corpusError("PITCH_TECHNIQUE_CORPUS_INVALID_CASE", `case ${index} is missing ${field}`);
    }
  }
  if (typeof current.id !== "string" || !current.id || typeof current.family !== "string" || !current.family) {
    throw corpusError("PITCH_TECHNIQUE_CORPUS_INVALID_CASE", `case ${index} needs id and family`);
  }
  if (!Array.isArray(current.sampleSeconds) || !Array.isArray(current.mask)) {
    throw corpusError("PITCH_TECHNIQUE_CORPUS_INVALID_CASE", `case ${current.id} needs sampleSeconds and mask arrays`);
  }
  if (!current.denseTruth || typeof current.denseTruth !== "object" || Array.isArray(current.denseTruth)) {
    throw corpusError("PITCH_TECHNIQUE_CORPUS_INVALID_CASE", `case ${current.id} needs denseTruth`);
  }
  assertExactKeys(current.denseTruth, ["unit", "values"], `case ${current.id}.denseTruth`);
  if (typeof current.denseTruth.unit !== "string" || !Array.isArray(current.denseTruth.values)) {
    throw corpusError("PITCH_TECHNIQUE_CORPUS_INVALID_CASE", `case ${current.id} has invalid dense truth`);
  }
  if (
    current.sampleSeconds.length !== current.denseTruth.values.length
    || current.mask.length !== current.denseTruth.values.length
  ) {
    throw corpusError("PITCH_TECHNIQUE_CORPUS_INVALID_CASE", `case ${current.id} has mismatched sample arrays`);
  }
  if (current.sampleSeconds.some((value) => !Number.isFinite(value))) {
    throw corpusError("PITCH_TECHNIQUE_CORPUS_INVALID_CASE", `case ${current.id} has non-finite sample seconds`);
  }
  if (current.mask.some((value) => typeof value !== "boolean")) {
    throw corpusError("PITCH_TECHNIQUE_CORPUS_INVALID_CASE", `case ${current.id} mask must be boolean`);
  }
  if (current.denseTruth.values.some((value, valueIndex) => (
    current.mask[valueIndex] ? !Number.isFinite(value) : value !== null
  ))) {
    throw corpusError("PITCH_TECHNIQUE_CORPUS_INVALID_CASE", `case ${current.id} truth and mask disagree`);
  }
  if (!Array.isArray(current.invariants) || current.invariants.length === 0 || current.invariants.some((value) => typeof value !== "string" || !value)) {
    throw corpusError("PITCH_TECHNIQUE_CORPUS_INVALID_CASE", `case ${current.id} needs invariants`);
  }
  if (!current.tolerance || typeof current.tolerance !== "object" || !Number.isFinite(current.tolerance.absolute) || current.tolerance.absolute < 0) {
    throw corpusError("PITCH_TECHNIQUE_CORPUS_INVALID_CASE", `case ${current.id} needs a finite absolute tolerance`);
  }
  if (!Number.isSafeInteger(current.seed)) {
    throw corpusError("PITCH_TECHNIQUE_CORPUS_INVALID_CASE", `case ${current.id} seed must be safe integer`);
  }
  if (current.expectedError) {
    assertExactKeys(current.expectedError, ["code"], `case ${current.id}.expectedError`);
    if (typeof current.expectedError.code !== "string" || !current.expectedError.code) {
      throw corpusError("PITCH_TECHNIQUE_CORPUS_INVALID_CASE", `case ${current.id} error code is invalid`);
    }
  } else if (current.denseTruth.values.length < 9) {
    throw corpusError("PITCH_TECHNIQUE_CORPUS_INVALID_CASE", `case ${current.id} needs at least nine dense samples`);
  }
}

function readJson(filePath, label) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw corpusError(
      "PITCH_TECHNIQUE_CORPUS_INVALID_JSON",
      `${label} cannot be read as JSON`,
      { cause: error.code ?? error.name },
    );
  }
}

function assertExactKeys(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw corpusError("PITCH_TECHNIQUE_CORPUS_INVALID", `${label} must be an object`);
  }
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw corpusError("PITCH_TECHNIQUE_CORPUS_INVALID", `${label} has unknown fields`, { unknown });
  }
}

function corpusError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
