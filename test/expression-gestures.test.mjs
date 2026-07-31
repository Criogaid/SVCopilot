// Grouped expression 展开的回归（计划 §3.4 / §9.3 / §13.2）。
//
// 重点不是"能展开"，而是三件容易悄悄出错的事：
//   1. 展开顺序必须确定（请求顺序 → Note 顺序 → 参数白名单顺序），否则同一请求
//      两次规划会产出不同的 operation 序列，point-budget 的截断点随之漂移；
//   2. canonical gesture 不得再出现任何字符串 Note ID——身份是 fingerprint 引用；
//   3. 拼错的字段必须报错而不是被忽略：静默忽略会让模型以为自己的设置生效了。
import assert from "node:assert/strict";
import test from "node:test";

import {
  HAIRPIN_PARAMETER_ORDER,
  expandExpressionGestures,
  normalizeExpressionDefaults,
} from "../server/src/expression-gestures.js";
import { resolveMutationScope } from "../server/src/scope-source.js";

const Q = 705_600_000;

function scopeWith(indices, { groupNoteCount = 400 } = {}) {
  return resolveMutationScope({
    source: {
      kind: "snapshot",
      stored: {
        contextId: "c_x",
        epoch: 1,
        context: {
          kind: "range",
          occurrences: [
            {
              occurrence: 0,
              groupNoteCount,
              capturedNotes: indices.length,
              sharedTargetOccurrences: [],
              noteFingerprints: indices.map((indexInGroup) =>
                Object.freeze({
                  indexInGroup,
                  onsetBlick: indexInGroup * Q,
                  durationBlick: Q,
                  pitch: 60,
                  lyrics: "占",
                })
              ),
            },
          ],
        },
      },
    },
  });
}

function codeOf(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    return error.code;
  }
}

test("a multi-parameter hairpin expands in whitelist order, not key order", () => {
  // 语义相同、只是键序不同的两个请求必须产出同一序列——否则 point-budget 的截断
  // 位置会随请求写法漂移。
  const scope = scopeWith([0, 62]);
  const forward = expandExpressionGestures({
    gestures: [
      { type: "hairpin", from: 0, to: 62, peak: 0.72, amounts: { loudness: 1.2, tension: 0.08 } },
    ],
    scope,
  });
  const reversed = expandExpressionGestures({
    gestures: [
      { type: "hairpin", from: 0, to: 62, peak: 0.72, amounts: { tension: 0.08, loudness: 1.2 } },
    ],
    scope,
  });
  assert.deepEqual(
    forward.map((gesture) => gesture.parameter),
    ["loudness", "tension"]
  );
  assert.deepEqual(
    forward.map((gesture) => gesture.parameter),
    reversed.map((gesture) => gesture.parameter)
  );
  // 白名单顺序本身要覆盖全部合法参数。
  assert.deepEqual([...HAIRPIN_PARAMETER_ORDER], [
    "pitchDelta",
    "loudness",
    "tension",
    "breathiness",
    "voicing",
    "gender",
  ]);
});

test("canonical gestures hold frozen fingerprint references, never string ids", () => {
  // §3.2 结尾：内部身份就是 Context 里那个对象引用。任何 *NoteId 字段残留都说明
  // 又长出了一套并行的字符串身份体系。
  const scope = scopeWith([0, 5, 9]);
  const expanded = expandExpressionGestures({
    gestures: [
      { type: "hairpin", from: 0, to: 9, amounts: { loudness: 1 } },
      { type: "vibrato", notes: [5], depthCents: 15 },
      { type: "scoop", targets: [[9, 22]] },
    ],
    scope,
  });
  const serialized = JSON.stringify(expanded);
  for (const banned of ["noteId", "fromNoteId", "toNoteId", "occurrenceId"]) {
    assert.equal(serialized.includes(banned), false, `${banned} must not survive expansion`);
  }
  // 引用即身份：不是深拷贝。
  assert.equal(expanded[1].note, scope.noteByIndex.get(5));
  assert.equal(expanded[0].fromNote, scope.noteByIndex.get(0));
  assert.equal(expanded[0].toNote, scope.noteByIndex.get(9));
});

test("one vibrato covers many notes with shared parameters", () => {
  const scope = scopeWith([62, 121, 178, 237, 296]);
  const expanded = expandExpressionGestures({
    gestures: [{ type: "vibrato", notes: [62, 121, 178, 237, 296], depthCents: 15, rateHz: 5.2 }],
    scope,
  });
  assert.equal(expanded.length, 5);
  assert.deepEqual(
    expanded.map((gesture) => gesture.note.indexInGroup),
    [62, 121, 178, 237, 296]
  );
  for (const gesture of expanded) {
    assert.equal(gesture.depthCents, 15);
    assert.equal(gesture.rateHz, 5.2);
  }
  // 展开顺序 = 请求里的 Note 顺序。
  assert.deepEqual(
    expanded.map((gesture) => gesture.source.notePosition),
    [0, 1, 2, 3, 4]
  );
});

test("scoop and fall targets are [noteIndex, depthCents] tuples", () => {
  const scope = scopeWith([87, 203, 157]);
  const expanded = expandExpressionGestures({
    gestures: [
      { type: "scoop", targets: [[87, 22], [203, 24]] },
      { type: "fall", targets: [[157, 26]] },
    ],
    scope,
  });
  assert.deepEqual(
    expanded.map((gesture) => [gesture.type, gesture.note.indexInGroup, gesture.depthCents]),
    [
      ["scoop", 87, 22],
      ["scoop", 203, 24],
      ["fall", 157, 26],
    ]
  );
});

test("a malformed tuple is rejected instead of being padded", () => {
  // 长度不对是位置歧义：按"缺省补齐"处理会把 depth 当成 index 用。
  const scope = scopeWith([0, 1]);
  for (const targets of [[[0]], [[0, 22, 3]], [0], [["0", 22]]]) {
    assert.equal(
      codeOf(() => expandExpressionGestures({ gestures: [{ type: "scoop", targets }], scope })),
      "INVALID_ARGUMENTS",
      JSON.stringify(targets)
    );
  }
});

test("gesture fields override defaults", () => {
  const scope = scopeWith([0, 1]);
  const defaults = normalizeExpressionDefaults({
    vibrato: { surface: "pitchDelta", rateHz: 5.2, onsetDelayQuarter: 0.22 },
    scoop: { lengthQuarter: 0.16, shapePower: 2 },
  });
  const expanded = expandExpressionGestures({
    gestures: [
      { type: "vibrato", notes: [0], depthCents: 15 },
      { type: "vibrato", notes: [1], depthCents: 18, rateHz: 7 },
      { type: "scoop", targets: [[0, 22]], lengthQuarter: 0.3 },
    ],
    defaults,
    scope,
  });
  assert.equal(expanded[0].rateHz, 5.2, "default applies");
  assert.equal(expanded[1].rateHz, 7, "gesture wins over default");
  assert.equal(expanded[0].onsetDelayQuarter, 0.22);
  assert.equal(expanded[2].lengthQuarter, 0.3, "gesture wins");
  assert.equal(expanded[2].shapePower, 2, "default fills the rest");
});

test("defaults only accept fields the gesture type declares", () => {
  // 拼错的默认值被静默忽略，会让模型以为自己设置的参数生效了。
  assert.equal(codeOf(() => normalizeExpressionDefaults({ vibrato: { depthCents: 15 } })), "INVALID_ARGUMENTS");
  assert.equal(codeOf(() => normalizeExpressionDefaults({ hairpin: { peak: 0.5 } })), "INVALID_ARGUMENTS");
  assert.equal(codeOf(() => normalizeExpressionDefaults({ scoop: { rateHz: 5 } })), "INVALID_ARGUMENTS");
  assert.doesNotThrow(() => normalizeExpressionDefaults({ fall: { lengthQuarter: 0.2 } }));
});

test("an unknown hairpin parameter is refused, not skipped", () => {
  const scope = scopeWith([0, 1]);
  assert.equal(
    codeOf(() =>
      expandExpressionGestures({
        gestures: [{ type: "hairpin", from: 0, to: 1, amounts: { loudnes: 1.2 } }],
        scope,
      })
    ),
    "INVALID_ARGUMENTS"
  );
});

test("note indices resolve through the shared scope, keeping both failure modes", () => {
  // 越界与"合法但未捕获"必须仍然是两个码（§3.2 规则 4/5）：展开层不得把它们
  // 合并成一个笼统的 INVALID_ARGUMENTS。
  const scope = scopeWith([0, 1], { groupNoteCount: 10 });
  assert.equal(
    codeOf(() => expandExpressionGestures({ gestures: [{ type: "vibrato", notes: [99], depthCents: 15 }], scope })),
    "NOTE_INDEX_OUT_OF_RANGE"
  );
  assert.equal(
    codeOf(() => expandExpressionGestures({ gestures: [{ type: "vibrato", notes: [5], depthCents: 15 }], scope })),
    "NOTE_NOT_IN_CONTEXT"
  );
});

test("errors carry a JSON Pointer into the grouped request", () => {
  // grouped 请求把很多东西压在一起，因此错误必须指到具体位置，否则调用方只能
  // 逐个试。
  const scope = scopeWith([0, 1], { groupNoteCount: 10 });
  try {
    expandExpressionGestures({
      gestures: [
        { type: "vibrato", notes: [0], depthCents: 15 },
        { type: "scoop", targets: [[0, 22], [7, 24]] },
      ],
      scope,
    });
    assert.fail("expected NOTE_NOT_IN_CONTEXT");
  } catch (error) {
    assert.equal(error.code, "NOTE_NOT_IN_CONTEXT");
    assert.equal(error.details.path, "/gestures/1/targets/1/0");
  }
});

test("hairpin requires from <= to", () => {
  const scope = scopeWith([0, 5]);
  assert.equal(
    codeOf(() =>
      expandExpressionGestures({
        gestures: [{ type: "hairpin", from: 5, to: 0, amounts: { loudness: 1 } }],
        scope,
      })
    ),
    "INVALID_ARGUMENTS"
  );
});

test("vibratoEnv and pitchDelta parameter sets stay mutually exclusive", () => {
  // 混用说明调用方没弄清自己写的是哪条曲线。
  const scope = scopeWith([0]);
  assert.equal(
    codeOf(() =>
      expandExpressionGestures({
        gestures: [{ type: "vibrato", notes: [0], surface: "vibratoEnv", depthCents: 15 }],
        scope,
      })
    ),
    "INVALID_ARGUMENTS"
  );
  assert.doesNotThrow(() =>
    expandExpressionGestures({
      gestures: [{ type: "vibrato", notes: [0], surface: "vibratoEnv", level: 1.4 }],
      scope,
    })
  );
});

test("an unknown gesture type fails rather than being dropped", () => {
  const scope = scopeWith([0]);
  assert.equal(
    codeOf(() => expandExpressionGestures({ gestures: [{ type: "portamento", note: 0 }], scope })),
    "INVALID_ARGUMENTS"
  );
});

test("expansion is deterministic across repeated calls", () => {
  const scope = scopeWith([0, 5, 9]);
  const gestures = [
    { type: "hairpin", from: 0, to: 9, amounts: { loudness: 1.2, pitchDelta: 30, tension: 0.1 } },
    { type: "vibrato", notes: [5, 9], depthCents: 15 },
    { type: "fall", targets: [[9, 26]] },
  ];
  const first = expandExpressionGestures({ gestures, scope });
  const second = expandExpressionGestures({ gestures, scope });
  assert.deepEqual(
    first.map((gesture) => [gesture.type, gesture.parameter ?? null, gesture.source]),
    second.map((gesture) => [gesture.type, gesture.parameter ?? null, gesture.source])
  );
  // 请求顺序优先于类型：hairpin 的三个参数先出，然后是两个 vibrato，最后 fall。
  assert.deepEqual(
    first.map((gesture) => gesture.type),
    ["hairpin", "hairpin", "hairpin", "vibrato", "vibrato", "fall"]
  );
});
