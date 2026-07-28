import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeVocalEventSequence,
  classifyVocalEvent,
} from "../server/src/vocal-event-semantics.js";

function note(lyrics, onsetBlick, durationBlick = 10) {
  return {
    noteId: `n${onsetBlick}`,
    lyrics,
    onsetBlick,
    durationBlick,
  };
}

test("classifyVocalEvent distinguishes official special lyrics without rewriting raw input", () => {
  assert.equal(classifyVocalEvent({ lyrics: "+" }).role, "syllable_continuation");
  assert.equal(classifyVocalEvent({ lyrics: "-" }).role, "phonation_continuation");
  assert.equal(classifyVocalEvent({ lyrics: "br" }).role, "breath_event");
  assert.equal(classifyVocalEvent({ lyrics: "'a" }).role, "glottal_onset");
  assert.equal(classifyVocalEvent({ lyrics: "'あ" }).role, "glottal_onset");
  assert.equal(classifyVocalEvent({ lyrics: "'" }).role, "unknown_special");
  assert.equal(classifyVocalEvent({ lyrics: "cl" }).role, "lexical_head");

  const upper = classifyVocalEvent({ lyrics: "BR" });
  assert.equal(upper.role, "lexical_head");
  assert.ok(upper.warnings.some((warning) => warning.code === "SUSPICIOUS_SPECIAL_LYRIC_VARIANT"));

  const fullWidth = classifyVocalEvent({ lyrics: "＋" });
  assert.equal(fullWidth.role, "lexical_head");
  assert.ok(
    fullWidth.warnings.some((warning) => warning.code === "SUSPICIOUS_SPECIAL_LYRIC_VARIANT")
  );
});

test("continuation state accepts valid chains and rejects orphan plus/minus", () => {
  const valid = analyzeVocalEventSequence([
    note("ashame", 0),
    note("+", 10),
    note("-", 20),
    note("-", 30),
  ]);
  assert.deepEqual(
    valid.events.map((event) => event.semanticRole),
    [
      "lexical_head",
      "syllable_continuation",
      "phonation_continuation",
      "phonation_continuation",
    ]
  );
  assert.ok(valid.events.every((event) => event.melodicEligible));
  assert.deepEqual(valid.issues, []);

  const orphaned = analyzeVocalEventSequence([
    note("+", 0),
    note("-", 10),
    note("'a", 20),
    note("br", 30),
  ]);
  assert.deepEqual(
    orphaned.issues.map((issue) => issue.code),
    ["ORPHAN_PLUS", "ORPHAN_PHONATION_CONTINUATION"]
  );
  assert.deepEqual(
    orphaned.events.map((event) => event.melodicEligible),
    [false, false, true, false]
  );
});

test("continuation state reports a one-BLICK syllable-chain gap without invalidating the chain", () => {
  const result = analyzeVocalEventSequence([
    note("beautiful", 0, 10),
    note("+", 11, 10),
  ]);
  const issue = result.issues.find((item) => item.code === "SYLLABLE_CHAIN_GAP");
  assert.ok(issue);
  assert.equal(issue.gapBlick, 1);
  assert.equal(result.events[1].melodicEligible, true);
});
