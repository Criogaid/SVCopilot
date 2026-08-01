// ScopeSource 与 capsule 要求的回归（计划 §4.3.2 / §3.5 / §9.2）。
//
// 两个要点：
//   1. snapshot 与 plan_capsule 必须产出**同一个形状**。若两者有差异，下游就会
//      长出「如果是 capsule 就…」的分支，那正是这个模块要消灭的东西。
//   2. 错误分类必须能区分"重试无用"与"重新捕获即可"。合并它们会让模型采取错误动作。
import assert from "node:assert/strict";
import test from "node:test";

import {
  CAPSULE_REQUIREMENTS_BY_OPERATION,
  UNIVERSAL_CAPSULE_FIELDS,
  assertCapsuleSatisfies,
  capsuleFieldsFor,
  resolveMutationScope,
  resolveNoteIndex,
  summarizeIndexRuns,
} from "../server/src/scope-source.js";

const Q = 705_600_000;

function fingerprint(indexInGroup) {
  return Object.freeze({
    indexInGroup,
    onsetBlick: indexInGroup * Q,
    durationBlick: Q,
    pitch: 60 + (indexInGroup % 12),
    lyrics: "占",
    phonemesOverride: "",
    languageOverride: "",
    detuneCents: 0,
  });
}

function occurrenceWith(indices, extra = {}) {
  return {
    trackIndex: 0,
    groupIndex: 0,
    targetGroupUuid: "uuid-1",
    groupNoteCount: 8,
    sharedTargetOccurrences: ["c_x:t:0:r:0"],
    noteFingerprints: indices.map(fingerprint),
    ...extra,
  };
}

function storedWith(occurrences) {
  return { contextId: "c_stored000000000", epoch: 3, context: { kind: "range", occurrences } };
}

function codeOf(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    return error.code;
  }
}

test("both sources produce the identical scope shape", () => {
  // 这条是整个模块的存在理由：如果两条来源形状不同，下游必然长出来源判断分支。
  const occurrence = occurrenceWith([0, 1, 2]);
  const fromSnapshot = resolveMutationScope({
    source: { kind: "snapshot", stored: storedWith([occurrence]) },
  });
  const fromCapsule = resolveMutationScope({
    source: {
      kind: "plan_capsule",
      // capsule 与 store entry 同形：epoch + context.occurrences，而不是一套
      // 只有测试认识的扁平字段。两者同形正是本测试要守的性质。
      capsule: { epoch: 3, context: { kind: "range", occurrences: [occurrence] } },
    },
  });

  assert.deepEqual(Object.keys(fromSnapshot).sort(), Object.keys(fromCapsule).sort());
  for (const key of ["epoch", "occurrenceOrdinal", "groupNoteCount"]) {
    assert.deepEqual(fromSnapshot[key], fromCapsule[key], `${key} must match across sources`);
  }
  assert.deepEqual([...fromSnapshot.noteByIndex.keys()], [...fromCapsule.noteByIndex.keys()]);
  assert.deepEqual(fromSnapshot.sharedTargetOccurrences, fromCapsule.sharedTargetOccurrences);
  // 只有来源标签和 contextId 不同——capsule 刻意不带 contextId，因为它不在 store 里。
  assert.equal(fromSnapshot.sourceKind, "snapshot");
  assert.equal(fromCapsule.sourceKind, "plan_capsule");
  assert.equal(fromCapsule.contextId, null);
});

test("a filtered or reordered occurrences array is refused", () => {
  // Context 自己记录 ordinal（musical-range 在 prepareStoredRange 里写入）。若有人
  // 过滤或重排过数组，同一个 ordinal 会在不同请求里指向不同 occurrence——那正是
  // §3.1 规则 1/5 要防止的。静默接受会让写入落到错误的音符组上。
  const stored = {
    contextId: "c_x",
    epoch: 1,
    context: {
      kind: "range",
      // 只保留了原本 ordinal 为 1 的那一个（模拟"按 capturedNotes 过滤"）。
      occurrences: [occurrenceWith([0, 1], { occurrence: 1 })],
    },
  };
  assert.equal(
    codeOf(() => resolveMutationScope({ source: { kind: "snapshot", stored }, occurrence: 0 })),
    "INVALID_CONTEXT"
  );
  // 一致时正常通过。
  const intact = storedWith([occurrenceWith([0], { occurrence: 0 })]);
  assert.doesNotThrow(() => resolveMutationScope({ source: { kind: "snapshot", stored: intact } }));
});

test("the scope is frozen so downstream cannot mutate shared fingerprints", () => {
  const scope = resolveMutationScope({
    source: { kind: "snapshot", stored: storedWith([occurrenceWith([0, 1])]) },
  });
  assert.equal(Object.isFrozen(scope), true);
});

test("a single occurrence may omit the ordinal; several may not", () => {
  const one = storedWith([occurrenceWith([0, 1])]);
  assert.equal(resolveMutationScope({ source: { kind: "snapshot", stored: one } }).occurrenceOrdinal, 0);

  const many = storedWith([occurrenceWith([0]), occurrenceWith([1])]);
  const code = codeOf(() => resolveMutationScope({ source: { kind: "snapshot", stored: many } }));
  assert.equal(code, "AMBIGUOUS_CONTEXT");
});

test("ambiguity lists every ordinal, including uncaptured ones", () => {
  // 按 capturedNotes 过滤后，若全部为空捕获会返回空数组——模型就拿不到任何下一步。
  const many = storedWith([occurrenceWith([0]), occurrenceWith([5])]);
  try {
    resolveMutationScope({ source: { kind: "snapshot", stored: many } });
    assert.fail("expected AMBIGUOUS_CONTEXT");
  } catch (error) {
    assert.deepEqual(error.details.candidates, [0, 1]);
  }
});

test("the ordinal indexes the full occurrence array, not the captured subset", () => {
  // §3.1 规则 1：索引空间恒定为完整数组。按捕获过滤会让同一个 Context 在不同
  // 请求里给出不同编号。
  const stored = storedWith([occurrenceWith([]), occurrenceWith([3, 4])]);
  const scope = resolveMutationScope({ source: { kind: "snapshot", stored }, occurrence: 1 });
  assert.equal(scope.occurrenceOrdinal, 1);
  assert.deepEqual([...scope.noteByIndex.keys()], [3, 4]);
});

test("an ordinal inside the array but with no captured notes is its own error", () => {
  // §3.1 规则 3：不得降级成 Note 越界——那会让模型以为是自己的 index 写错了。
  const stored = storedWith([occurrenceWith([])]);
  assert.equal(
    codeOf(() => resolveMutationScope({ source: { kind: "snapshot", stored }, occurrence: 0 })),
    "OCCURRENCE_NOT_CAPTURED"
  );
});

test("an empty capture is caught even when the ordinal is omitted", () => {
  // 只在显式 ordinal 分支检查会让单 occurrence 的省略路径漏过（§9.2 注释）。
  const stored = storedWith([occurrenceWith([])]);
  assert.equal(
    codeOf(() => resolveMutationScope({ source: { kind: "snapshot", stored } })),
    "OCCURRENCE_NOT_CAPTURED"
  );
});

test("an out-of-range ordinal reports the maximum", () => {
  const stored = storedWith([occurrenceWith([0])]);
  try {
    resolveMutationScope({ source: { kind: "snapshot", stored }, occurrence: 7 });
    assert.fail("expected OCCURRENCE_INDEX_OUT_OF_RANGE");
  } catch (error) {
    assert.equal(error.code, "OCCURRENCE_INDEX_OUT_OF_RANGE");
    assert.equal(error.details.got, 7);
    assert.equal(error.details.max, 0);
  }
});

test("a capsule seals exactly one occurrence, so a non-zero ordinal is a mix-up", () => {
  // 把 Context ordinal 当成 capsule ordinal 传进来时静默接受，会读到错误的 occurrence。
  const capsule = {
    epoch: 1,
    context: { kind: "range", occurrences: [occurrenceWith([0, 1])] },
  };
  assert.equal(
    codeOf(() => resolveMutationScope({ source: { kind: "plan_capsule", capsule }, occurrence: 2 })),
    "OCCURRENCE_INDEX_OUT_OF_RANGE"
  );
  assert.doesNotThrow(() =>
    resolveMutationScope({ source: { kind: "plan_capsule", capsule }, occurrence: 0 })
  );
});

test("a non-range context is refused rather than silently misread", () => {
  const stored = { contextId: "c_x", epoch: 1, context: { kind: "selection", noteIndices: [0] } };
  assert.equal(
    codeOf(() => resolveMutationScope({ source: { kind: "snapshot", stored } })),
    "INVALID_CONTEXT"
  );
});

test("an unknown source kind fails instead of defaulting to snapshot", () => {
  assert.equal(codeOf(() => resolveMutationScope({ source: { kind: "guess" } })), "INVALID_ARGUMENTS");
  assert.equal(codeOf(() => resolveMutationScope({})), "INVALID_ARGUMENTS");
});

test("out-of-range and not-captured are different note errors", () => {
  // 前者靠重试永远不会成功；后者需要重新捕获更宽的范围。合并成一个码会让模型
  // 采取错误动作（§3.2 规则 5）。
  const scope = resolveMutationScope({
    source: { kind: "snapshot", stored: storedWith([occurrenceWith([0, 1, 5])]) },
  });
  assert.equal(resolveNoteIndex(scope, 5, "/notes/0").indexInGroup, 5);

  try {
    resolveNoteIndex(scope, 99, "/notes/0");
    assert.fail("expected NOTE_INDEX_OUT_OF_RANGE");
  } catch (error) {
    assert.equal(error.code, "NOTE_INDEX_OUT_OF_RANGE");
    assert.equal(error.details.got, 99);
    assert.equal(error.details.max, 7);
  }

  try {
    resolveNoteIndex(scope, 3, "/notes/1");
    assert.fail("expected NOTE_NOT_IN_CONTEXT");
  } catch (error) {
    assert.equal(error.code, "NOTE_NOT_IN_CONTEXT");
    assert.equal(error.details.path, "/notes/1");
    // 证据是有界区间摘要，不是全部合法 index。
    assert.deepEqual(error.details.captured, [
      [0, 1],
      [5, 5],
    ]);
  }
});

test("a negative or fractional index is an argument error, not a range error", () => {
  const scope = resolveMutationScope({
    source: { kind: "snapshot", stored: storedWith([occurrenceWith([0])]) },
  });
  for (const bad of [-1, 1.5, Number.NaN, "0"]) {
    assert.equal(codeOf(() => resolveNoteIndex(scope, bad, "/x")), "INVALID_ARGUMENTS", String(bad));
  }
});

test("resolveNoteIndex returns the frozen context fingerprint, not a copy", () => {
  // 内部身份就是这个对象引用；复制会让"同一个 Note"的判定退化成字段比较。
  const occurrence = occurrenceWith([0, 1]);
  const scope = resolveMutationScope({
    source: { kind: "snapshot", stored: storedWith([occurrence]) },
  });
  assert.equal(resolveNoteIndex(scope, 1, "/x"), occurrence.noteFingerprints[1]);
});

test("captured runs are bounded to eight segments", () => {
  const sparse = Array.from({ length: 40 }, (_, index) => index * 2);
  const runs = summarizeIndexRuns(sparse, { maxRuns: 8 });
  assert.equal(runs.length, 8);
  assert.deepEqual(runs[0], [0, 0]);
  // 连续区间被压成一段，而不是逐个列出。
  assert.deepEqual(summarizeIndexRuns([0, 1, 2, 7, 8]), [
    [0, 2],
    [7, 8],
  ]);
});

test("every mutation operation declares what its capsule must carry", () => {
  // 笼统只存「被引用的 fingerprints」对结构编辑和 add 模式曲线是不够的，
  // 这张表存在就是为了让"存少了"可机械判定。
  for (const [operation, entry] of Object.entries(CAPSULE_REQUIREMENTS_BY_OPERATION)) {
    assert.ok(entry.fields.includes("target"), `${operation} must seal its target identity`);
    assert.ok(
      entry.fields.includes("referencedNotes"),
      `${operation} must seal the fingerprints it references`
    );
    assert.ok(entry.reason.length >= 20, `${operation} must explain its field set`);
  }
  // 结构编辑必须带 anchor 邻居与 groupNoteCount：insert 要验证 onset 解析到 before，
  // 越界判定需要总数。
  const structure = CAPSULE_REQUIREMENTS_BY_OPERATION.restructure_notes.fields;
  assert.ok(structure.includes("anchorNeighbors"));
  assert.ok(structure.includes("mergeSpanNotes"));
  assert.ok(structure.includes("groupNoteCount"));
  // add 模式曲线必须带基线，否则无法防止重复叠加。
  assert.ok(CAPSULE_REQUIREMENTS_BY_OPERATION.patch_parameter_curves.fields.includes("curveBaseline"));
  // pitch control 按 anchor/间隙定位，宿主会重排，因此索引不可用。
  assert.ok(
    CAPSULE_REQUIREMENTS_BY_OPERATION.patch_pitch_controls.fields.includes("pitchControlAdjacency")
  );
});

test("edit_phrase requires the union of its sub-edit requirements", () => {
  // 组合事务在一个 Undo 内做多种编辑；漏掉任一子编辑的判据都会让那一部分失去保护。
  const phrase = new Set(CAPSULE_REQUIREMENTS_BY_OPERATION.edit_phrase.fields);
  for (const operation of [
    "patch_notes",
    "restructure_notes",
    "patch_parameter_curves",
  ]) {
    for (const field of CAPSULE_REQUIREMENTS_BY_OPERATION[operation].fields) {
      assert.ok(phrase.has(field), `edit_phrase must also seal ${field} (from ${operation})`);
    }
  }
  assert.ok(phrase.has("voiceParameters"), "voice patches need a pre-write baseline to compensate");
});

test("universal fields apply to every operation", () => {
  // shared-target 清单是安全前提：被多处引用的 NoteGroup 上的编辑会改变每一处。
  assert.deepEqual([...UNIVERSAL_CAPSULE_FIELDS], ["contextEpoch", "sharedTargetOccurrences"]);
  for (const operation of Object.keys(CAPSULE_REQUIREMENTS_BY_OPERATION)) {
    const fields = capsuleFieldsFor(operation);
    assert.ok(fields.includes("sharedTargetOccurrences"));
    assert.ok(fields.includes("contextEpoch"));
  }
});

test("an incomplete capsule fails before the mutation touches the host", () => {
  const complete = {
    contextEpoch: 1,
    sharedTargetOccurrences: [],
    target: { targetGroupUuid: "uuid-1" },
    referencedNotes: [fingerprint(0)],
    anchorNeighbors: [],
    mergeSpanNotes: [],
    groupNoteCount: 8,
  };
  assert.doesNotThrow(() => assertCapsuleSatisfies("restructure_notes", complete));

  const { groupNoteCount: _dropped, ...missingCount } = complete;
  try {
    assertCapsuleSatisfies("restructure_notes", missingCount);
    assert.fail("expected PLAN_CAPSULE_INCOMPLETE");
  } catch (error) {
    assert.equal(error.code, "PLAN_CAPSULE_INCOMPLETE");
    assert.match(error.message, /groupNoteCount/);
  }
  // null 与缺失同等对待：一个 null 基线不能当成"已经检查过了"。
  assert.equal(
    codeOf(() => assertCapsuleSatisfies("restructure_notes", { ...complete, groupNoteCount: null })),
    "PLAN_CAPSULE_INCOMPLETE"
  );
});

test("an unregistered operation cannot silently get an empty capsule requirement", () => {
  assert.equal(codeOf(() => capsuleFieldsFor("brand_new_mutation")), "INVALID_ARGUMENTS");
  assert.equal(codeOf(() => assertCapsuleSatisfies("brand_new_mutation", {})), "INVALID_ARGUMENTS");
});
