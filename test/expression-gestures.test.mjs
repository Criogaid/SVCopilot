import assert from "node:assert/strict";
import test from "node:test";

import {
  HAIRPIN_PARAMETER_ORDER,
  assertExpressionGestureShapes,
  expandExpressionGestures,
} from "../server/src/expression-gestures.js";
import { resolveMutationScope } from "../server/src/scope-source.js";

const Q = 705_600_000;

function scopeWith(indices, { groupNoteCount = 400 } = {}) {
  return resolveMutationScope({
    source: {
      kind: "snapshot",
      stored: {
        contextId: "c_expression",
        epoch: 1,
        context: {
          kind: "range",
          occurrences: [
            {
              occurrence: 0,
              groupNoteCount,
              sharedTargetOccurrences: [],
              noteFingerprints: indices.map((indexInGroup) =>
                Object.freeze({
                  indexInGroup,
                  onsetBlick: indexInGroup * Q,
                  durationBlick: Q,
                  pitch: 60,
                  lyrics: "a",
                  phonemesOverride: "",
                  languageOverride: "",
                  detuneCents: 0,
                }),
              ),
            },
          ],
        },
      },
    },
  });
}

function codeOf(callback) {
  try {
    callback();
    return null;
  } catch (error) {
    return error.code;
  }
}

test("a multi-parameter hairpin expands in deterministic non-pitch whitelist order", () => {
  const scope = scopeWith([0, 62]);
  const forward = expandExpressionGestures({
    gestures: [
      {
        type: "hairpin",
        from: 0,
        to: 62,
        peak: 0.72,
        amounts: { gender: 0.12, loudness: 1.2, tension: 0.08, voicing: -0.1 },
      },
    ],
    scope,
  });
  const reversed = expandExpressionGestures({
    gestures: [
      {
        type: "hairpin",
        from: 0,
        to: 62,
        peak: 0.72,
        amounts: { voicing: -0.1, tension: 0.08, loudness: 1.2, gender: 0.12 },
      },
    ],
    scope,
  });

  assert.deepEqual([...HAIRPIN_PARAMETER_ORDER], [
    "loudness",
    "tension",
    "breathiness",
    "voicing",
    "gender",
  ]);
  assert.deepEqual(
    forward.map((gesture) => gesture.parameter),
    ["loudness", "tension", "voicing", "gender"],
  );
  assert.deepEqual(
    forward.map((gesture) => gesture.parameter),
    reversed.map((gesture) => gesture.parameter),
  );
});

test("canonical hairpins keep captured fingerprint references", () => {
  const scope = scopeWith([0, 5, 9]);
  const expanded = expandExpressionGestures({
    gestures: [{ type: "hairpin", from: 0, to: 9, amounts: { loudness: 1 } }],
    scope,
  });
  assert.equal(expanded.length, 1);
  assert.equal(expanded[0].fromNote, scope.noteByIndex.get(0));
  assert.equal(expanded[0].toNote, scope.noteByIndex.get(9));
  assert.equal(JSON.stringify(expanded).includes("noteId"), false);
});

test("expression rejects every migrated pitch gesture without aliases", () => {
  const scope = scopeWith([0, 1]);
  for (const gesture of [
    { type: "scoop", targets: [[0, 20]] },
    { type: "fall", targets: [[0, 20]] },
    { type: "portamento", transitions: [[0, 1]] },
    { type: "vibrato", notes: [0] },
  ]) {
    assert.equal(codeOf(() => expandExpressionGestures({ gestures: [gesture], scope })), "INVALID_ARGUMENTS");
  }
});

test("hairpin refuses pitchDelta and misspelled parameters", () => {
  const scope = scopeWith([0, 1]);
  for (const amounts of [{ pitchDelta: 20 }, { loudnes: 1.2 }]) {
    assert.equal(
      codeOf(() => expandExpressionGestures({ gestures: [{ type: "hairpin", from: 0, to: 1, amounts }], scope })),
      "INVALID_ARGUMENTS",
    );
  }
});

test("note selection retains distinct out-of-range and uncaptured errors", () => {
  const scope = scopeWith([0, 1], { groupNoteCount: 10 });
  assert.equal(
    codeOf(() => expandExpressionGestures({
      gestures: [{ type: "hairpin", from: 0, to: 99, amounts: { loudness: 1 } }],
      scope,
    })),
    "NOTE_INDEX_OUT_OF_RANGE",
  );
  assert.equal(
    codeOf(() => expandExpressionGestures({
      gestures: [{ type: "hairpin", from: 0, to: 5, amounts: { loudness: 1 } }],
      scope,
    })),
    "NOTE_NOT_IN_CONTEXT",
  );
});

test("shape errors include a grouped-request JSON Pointer", () => {
  try {
    assertExpressionGestureShapes([
      { type: "hairpin", from: 0, to: 1, amounts: { loudness: 0 } },
    ]);
    assert.fail("expected INVALID_ARGUMENTS");
  } catch (error) {
    assert.equal(error.code, "INVALID_ARGUMENTS");
    assert.equal(error.details.path, "/gestures/0/amounts/loudness");
  }
});
