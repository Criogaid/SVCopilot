import assert from "node:assert/strict";
import test from "node:test";

import {
  isMandarinReadingCandidate,
  lookupMandarinReading,
  MANDARIN_READING_DATA,
} from "../server/src/mandarin-reading-data.js";

test("Mandarin reading data has the audited unique sizes", () => {
  assert.deepEqual(MANDARIN_READING_DATA, {
    characterCount: 122,
    mappingCount: 410,
    pinyinStyle: "toneless_ascii_v",
  });
});

test("Mandarin reading lookup distinguishes consonant and final changes", () => {
  assert.equal(isMandarinReadingCandidate("还"), true);
  assert.equal(isMandarinReadingCandidate("普通"), false);
  assert.equal(lookupMandarinReading("x a :\\i"), "hai");
  assert.equal(lookupMandarinReading("x ua :n"), "huan");
  assert.equal(lookupMandarinReading("j iAU"), "yao");
});

test("Mandarin reading lookup preserves unknown host formats", () => {
  assert.equal(lookupMandarinReading(" x a :\\i "), null);
  assert.equal(lookupMandarinReading("future-format"), null);
  assert.equal(lookupMandarinReading(null), null);
});
