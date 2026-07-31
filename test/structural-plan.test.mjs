// 结构编辑排序与冲突矩阵的回归（计划 §9.4 / §3.3）。
//
// 计划明确要求性质测试而不是几个固定用例："随机生成 op 组合，与纯内存模型的预期
// 最终序列比对"。因此这里的核心是一个对照实验：
//   - expectedSequence 按**声明式**语义直接算结果（每个快照位置发生了什么）；
//   - applyInPlannedOrder 按编译出的**执行顺序**做 splice。
// 两者独立，因此一致就证明排序规则正确。如果两边共用同一套排序逻辑，测试就只是在
// 重复实现，什么也证明不了。
import assert from "node:assert/strict";
import test from "node:test";

import {
  applyInPlannedOrder,
  expectedSequence,
  planRestructure,
  snapshotIndicesConsumedBy,
} from "../server/src/structural-plan.js";

function codeOf(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    return error.code;
  }
}

// 确定性伪随机：失败可复现。测试不该依赖 Math.random。
function mulberry32(seed) {
  return function next() {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("insert uses `before` as its anchor because it consumes nothing", () => {
  // 只按「最大 consumed index 降序」排会在这里崩掉：insert 的 consumed 是空集合，
  // 空集合上的 max() 无定义，两个 insert before 30 的相对顺序就完全未定义。
  assert.deepEqual(snapshotIndicesConsumedBy({ op: "insert", before: 3 }, 8, "/x"), []);
  const { ordered } = planRestructure({ groupNoteCount: 8 }, [
    { op: "insert", before: 3 },
    { op: "insert", before: 6 },
  ]);
  assert.deepEqual(
    ordered.map((operation) => operation.anchor),
    [6, 3]
  );
});

test("multiple inserts at one position end up in request order", () => {
  // §9.4 补充规则 2。这正是「同锚点按 requestIndex 降序施加」要保证的结果——
  // 按请求顺序施加会让先插入的被后插入的顶到后面，最终顺序反过来。
  const operations = [
    { op: "insert", before: 2, tag: "first" },
    { op: "insert", before: 2, tag: "second" },
    { op: "insert", before: 2, tag: "third" },
  ];
  const { ordered } = planRestructure({ groupNoteCount: 4 }, operations);
  assert.deepEqual(
    ordered.map((operation) => operation.requestIndex),
    [2, 1, 0],
    "same anchor must be applied in descending request order"
  );
  const inserted = applyInPlannedOrder(4, operations)
    .filter((item) => item.kind === "inserted")
    .map((item) => item.requestIndex);
  assert.deepEqual(inserted, [0, 1, 2], "the final sequence must match request order");
});

test("before === groupNoteCount appends", () => {
  const result = applyInPlannedOrder(3, [{ op: "insert", before: 3 }]);
  assert.equal(result.length, 4);
  assert.equal(result.at(-1).kind, "inserted");
  // 超过一位即越界。
  assert.equal(
    codeOf(() => planRestructure({ groupNoteCount: 3 }, [{ op: "insert", before: 4 }])),
    "NOTE_INDEX_OUT_OF_RANGE"
  );
});

test("every index resolves against the snapshot, never against intermediate state", () => {
  // 删除低位 Note 之后，高位 delete 仍然用它的**快照** index：调用方不必预测漂移。
  const result = applyInPlannedOrder(6, [
    { op: "delete", notes: [1] },
    { op: "delete", notes: [4] },
  ]);
  assert.deepEqual(
    result.map((item) => item.snapshotIndex),
    [0, 2, 3, 5]
  );
});

test("two operations claiming the same snapshot note conflict", () => {
  // split + 对同一 Note 的 delete 是计划点名的例子（§3.3 规则 4）。
  const operations = [
    { op: "split", note: 2, atRatio: 0.5 },
    { op: "delete", notes: [2] },
  ];
  try {
    planRestructure({ groupNoteCount: 5 }, operations);
    assert.fail("expected CONFLICTING_OPERATIONS");
  } catch (error) {
    assert.equal(error.code, "CONFLICTING_OPERATIONS");
    assert.equal(error.details.note, 2);
    assert.equal(error.details.path, "/operations/1");
    // 证据里给出首个冲突与计数，而不是列举全部冲突对。
    assert.equal(error.details.conflictsWith, "/operations/0");
    assert.equal(error.details.conflicts, 1);
  }
});

test("an insert next to a delete or merge is not a conflict", () => {
  // §9.4 补充规则 3：insert 不消费 Note，因此与相邻 delete/merge 天然共存。
  assert.doesNotThrow(() =>
    planRestructure({ groupNoteCount: 6 }, [
      { op: "insert", before: 3 },
      { op: "delete", notes: [3] },
      { op: "merge", from: 4, to: 5 },
    ])
  );
});

test("overlapping merge spans conflict", () => {
  // §3.3 规则 5：merge 区间不得与其它操作区间相交。
  assert.equal(
    codeOf(() =>
      planRestructure({ groupNoteCount: 8 }, [
        { op: "merge", from: 1, to: 3 },
        { op: "merge", from: 3, to: 5 },
      ])
    ),
    "CONFLICTING_OPERATIONS"
  );
  // 相邻但不相交是允许的。
  assert.doesNotThrow(() =>
    planRestructure({ groupNoteCount: 8 }, [
      { op: "merge", from: 1, to: 2 },
      { op: "merge", from: 3, to: 4 },
    ])
  );
});

test("merge requires a consecutive span of at least two notes", () => {
  assert.equal(
    codeOf(() => planRestructure({ groupNoteCount: 8 }, [{ op: "merge", from: 3, to: 3 }])),
    "INVALID_ARGUMENTS"
  );
  assert.equal(
    codeOf(() => planRestructure({ groupNoteCount: 8 }, [{ op: "merge", from: 4, to: 2 }])),
    "INVALID_ARGUMENTS"
  );
});

test("delete rejects the same note listed twice", () => {
  // 第二次删除会落到别的音符上——静默接受等于静默删错。
  assert.equal(
    codeOf(() => planRestructure({ groupNoteCount: 5 }, [{ op: "delete", notes: [2, 2] }])),
    "INVALID_ARGUMENTS"
  );
});

test("an unsupported op is refused rather than skipped", () => {
  assert.equal(
    codeOf(() => planRestructure({ groupNoteCount: 5 }, [{ op: "transpose", note: 1 }])),
    "INVALID_ARGUMENTS"
  );
});

test("the declarative model and the planned execution order always agree", () => {
  // 计划要求的性质测试。两个模型独立实现，因此一致就证明排序规则正确。
  const random = mulberry32(0xc0ffee);
  let checked = 0;

  for (let iteration = 0; iteration < 2000; iteration += 1) {
    const groupNoteCount = 3 + Math.floor(random() * 10);
    const claimed = new Set();
    const operations = [];
    const attempts = 1 + Math.floor(random() * 5);

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const kind = Math.floor(random() * 4);
      if (kind === 0) {
        operations.push({ op: "insert", before: Math.floor(random() * (groupNoteCount + 1)) });
        continue;
      }
      if (kind === 1) {
        const note = Math.floor(random() * groupNoteCount);
        if (claimed.has(note)) continue;
        claimed.add(note);
        operations.push({ op: "delete", notes: [note] });
        continue;
      }
      if (kind === 2) {
        const note = Math.floor(random() * groupNoteCount);
        if (claimed.has(note)) continue;
        claimed.add(note);
        operations.push({ op: "split", note, atRatio: 0.5 });
        continue;
      }
      const from = Math.floor(random() * (groupNoteCount - 1));
      const to = from + 1 + Math.floor(random() * Math.min(2, groupNoteCount - from - 1));
      const span = [];
      for (let index = from; index <= to; index += 1) span.push(index);
      if (span.length < 2 || span.some((index) => claimed.has(index))) continue;
      for (const index of span) claimed.add(index);
      operations.push({ op: "merge", from, to });
    }
    if (operations.length === 0) continue;
    // 落在 merge 区间内部的 insert 是**歧义请求**（planRestructure 会拒绝它），
    // 不是排序问题：合并会让它两侧的邻居都消失。生成器跳过这类组合，让性质测试
    // 专注检验执行顺序；拒绝行为由下面的专用用例覆盖。
    const mergeSpans = operations.filter((operation) => operation.op === "merge");
    const insideMerge = operations.some(
      (operation) =>
        operation.op === "insert" &&
        mergeSpans.some((span) => operation.before > span.from && operation.before <= span.to)
    );
    if (insideMerge) continue;

    checked += 1;
    const label = `groupNoteCount=${groupNoteCount} ops=${JSON.stringify(operations)}`;
    assert.deepEqual(
      applyInPlannedOrder(groupNoteCount, operations),
      expectedSequence(groupNoteCount, operations),
      `execution order disagrees with the declarative model: ${label}`
    );
  }
  assert.ok(checked > 1000, `property test must actually exercise cases; ran ${checked}`);
});

test("an insert anchored inside a merge span is an ambiguous request, not a sort problem", () => {
  // `merge from 1 to 3` 把快照 1..3 折成一个音符；`insert before 3` 要求落在快照 2 与 3
  // 之间，而这两个音符都不再存在。合并结果之内/之前/之后三种读法都说得通，因此
  // 服务端不能替调用方猜——只能拒绝，并指出没有歧义的锚点。
  try {
    planRestructure({ groupNoteCount: 5 }, [
      { op: "merge", from: 1, to: 3 },
      { op: "insert", before: 3 },
    ]);
    assert.fail("expected INVALID_INSERT_POSITION");
  } catch (error) {
    assert.equal(error.code, "INVALID_INSERT_POSITION");
    assert.deepEqual(error.details.mergeSpan, [1, 3]);
    // 错误必须给出可执行的替代位置，而不是只说"不行"。
    assert.deepEqual(error.details.unambiguousAnchors, [1, 4]);
  }

  // 边界位置没有歧义，必须放行。
  for (const before of [1, 4]) {
    assert.doesNotThrow(
      () =>
        planRestructure({ groupNoteCount: 5 }, [
          { op: "merge", from: 1, to: 3 },
          { op: "insert", before },
        ]),
      `before ${before} is a boundary and must be accepted`
    );
  }

  // delete/split 不需要这条规则：被删音符之前的位置由它前面的存活音符唯一确定，
  // split 只是把一个音符换成两个，边界不动。
  assert.doesNotThrow(() =>
    planRestructure({ groupNoteCount: 5 }, [
      { op: "delete", notes: [2] },
      { op: "insert", before: 2 },
    ])
  );
  assert.doesNotThrow(() =>
    planRestructure({ groupNoteCount: 5 }, [
      { op: "split", note: 2, atRatio: 0.5 },
      { op: "insert", before: 2 },
    ])
  );
});

test("the planned order never touches an index that already moved", () => {
  // applyInPlannedOrder 的 livePositionOf 在快照 Note 已被移动时抛 INTERNAL_ERROR。
  // 上面的性质测试跑了上千个组合都没触发它，这里再直接确认一次那条防线存在。
  const random = mulberry32(7);
  for (let iteration = 0; iteration < 500; iteration += 1) {
    const groupNoteCount = 4 + Math.floor(random() * 6);
    const note = Math.floor(random() * groupNoteCount);
    const operations = [
      { op: "insert", before: Math.floor(random() * (groupNoteCount + 1)) },
      { op: "split", note, atRatio: 0.5 },
    ];
    assert.doesNotThrow(() => applyInPlannedOrder(groupNoteCount, operations));
  }
});
