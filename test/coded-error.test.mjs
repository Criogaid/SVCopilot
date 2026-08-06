import assert from "node:assert/strict";
import test from "node:test";

import { codedError } from "../server/src/coded-error.js";

test("coded errors keep the machine code separate from human prose", () => {
  const error = codedError("ARTIFACT_NOT_FOUND", "artifact not found: a_x");

  assert.equal(error.code, "ARTIFACT_NOT_FOUND");
  assert.equal(error.message, "artifact not found: a_x");
  assert.equal("details" in error, false);
});

test("coded errors retain only plain-record details", () => {
  const nullPrototype = Object.assign(Object.create(null), { path: "/x" });
  for (const details of [{ path: "/x" }, nullPrototype]) {
    assert.equal(codedError("X", "Y", details).details, details);
  }

  for (const details of [
    undefined,
    null,
    "detail",
    1,
    [],
    new Date(0),
    new Map([["path", "/x"]]),
    new Error("nested"),
    new (class Detail {})(),
  ]) {
    assert.equal("details" in codedError("X", "Y", details), false);
  }
});
