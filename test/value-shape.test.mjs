import assert from "node:assert/strict";
import test from "node:test";

import { isPlainRecord, isRecord } from "../server/src/value-shape.js";

test("object predicates keep their loose and plain-record contracts distinct", () => {
  const nullPrototype = Object.create(null);
  const customInstance = new (class Example {})();
  const cases = [
    { value: null, record: false, plain: false },
    { value: undefined, record: false, plain: false },
    { value: [], record: false, plain: false },
    { value: {}, record: true, plain: true },
    { value: nullPrototype, record: true, plain: true },
    { value: new Date(0), record: true, plain: false },
    { value: new Map(), record: true, plain: false },
    { value: /x/, record: true, plain: false },
    { value: new Error("x"), record: true, plain: false },
    { value: customInstance, record: true, plain: false },
  ];

  for (const entry of cases) {
    assert.equal(isRecord(entry.value), entry.record);
    assert.equal(isPlainRecord(entry.value), entry.plain);
  }
});
