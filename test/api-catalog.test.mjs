import assert from "node:assert/strict";
import test from "node:test";

import {
  describeApi,
  normalizeManifest,
  searchApi,
  validateApiCall,
} from "../server/src/api-catalog.js";

test("API catalog searches and describes parsed official methods", () => {
  const search = searchApi("setLyrics");
  assert.ok(search.total >= 1);
  assert.ok(search.results.some((result) => result.className === "Note" && result.method === "setLyrics"));

  const description = describeApi("Automation", "remove");
  assert.equal(description.className, "Automation");
  assert.equal(description.method, "remove");
  assert.equal(description.overloads.length, 2);
  assert.equal(describeApi("NoSuchClass"), null);
});

test("API catalog preflight validates methods, arguments, handles, and host version", () => {
  const valid = validateApiCall({
    className: "Project",
    method: "getNumTracks",
    args: [],
    hostVersion: "2.2.1",
  });
  assert.equal(valid.ok, true);

  const unknownMethod = validateApiCall({
    className: "Project",
    method: "setLyrics",
    args: [],
    hostVersion: "2.2.1",
  });
  assert.deepEqual(unknownMethod.ok, false);
  assert.equal(unknownMethod.code, "UNKNOWN_METHOD");

  const wrongArity = validateApiCall({
    className: "Note",
    method: "setLyrics",
    args: [],
    hostVersion: "2.2.1",
  });
  assert.equal(wrongArity.code, "ARGUMENT_MISMATCH");

  const wrongHandleType = validateApiCall({
    className: "Project",
    method: "addNoteGroup",
    args: [{ __handle__: 12 }],
    hostVersion: "2.2.1",
    resolveHandleType: () => "Project",
  });
  assert.equal(wrongHandleType.code, "ARGUMENT_MISMATCH");
  assert.match(wrongHandleType.message, /expects NoteGroup handle/);

  const unsupportedVersion = validateApiCall({
    className: "Note",
    method: "getDetune",
    args: [],
    hostVersion: "2.0.0",
  });
  assert.equal(unsupportedVersion.code, "VERSION_UNSUPPORTED");
});

test("normalizeManifest degrades structurally broken manifests to the unavailable stub", () => {
  for (const broken of [null, {}, [], "not-json", 42, { classes: null }, { classes: [] }]) {
    const manifest = normalizeManifest(broken);
    assert.equal(manifest.available, false);
    assert.deepEqual(manifest.classes, {});
  }

  const usable = normalizeManifest({ classes: { Note: { methods: {} } } });
  assert.notEqual(usable.available, false);
  assert.ok(usable.classes.Note);
});
