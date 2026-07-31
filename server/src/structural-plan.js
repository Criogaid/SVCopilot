// 结构编辑的快照基准解析与执行顺序（计划 §9.4 / §3.3）。
//
// 契约：请求里出现的每个 index 都相对**同一份快照**解析，绝不相对同一请求内的中间
// 状态。调用方因此永远不需要预测 index 漂移——推导执行顺序是服务端的工作。
//
// 为什么不能只按「最大 snapshot index 降序」排：`insert` 不消费任何现有 Note，
// 它的 consumed 集合是空的，空集合上的 max() 无定义。两个 `insert before 30` 的
// 相对顺序会因此完全未定义。所以 insert 用 `before` 作为排序锚点，并且需要第二个
// 排序键。
//
// 降序执行的真正理由：执行 `insert before N` 时，所有锚点 > N 的操作都已完成
// （它们位于更高的索引，不会移动 N），而所有锚点 < N 的操作尚未执行（低位索引
// 未被移动）。因此这一刻 N 恰好就是宿主索引，不需要任何重算。这才是"调用方不必
// 预测漂移"能够成立的机制。

/**
 * 编译执行计划。纯数据：不访问宿主，不持有 handle。
 *
 * @param {object} scope - resolveMutationScope 的返回值（提供 groupNoteCount）
 * @param {object[]} operations - 外部请求里的结构操作，index 全部相对快照
 * @returns {{ordered: object[], conflicts: number}}
 */
export function planRestructure(scope, operations) {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw codedError("INVALID_ARGUMENTS", "operations must be a non-empty array");
  }
  const groupNoteCount = scope?.groupNoteCount;
  if (!Number.isSafeInteger(groupNoteCount) || groupNoteCount < 0) {
    throw codedError("INVALID_ARGUMENTS", "scope.groupNoteCount is required to resolve indices");
  }

  // 第一遍：解析每个操作消费的快照 index，并检测同一 Note 被两个操作争用。
  const claimedBy = new Map();
  const resolved = operations.map((operation, requestIndex) => {
    const path = `/operations/${requestIndex}`;
    const consumed = snapshotIndicesConsumedBy(operation, groupNoteCount, path);
    for (const index of consumed) {
      if (claimedBy.has(index)) {
        // 两个操作指向同一个快照 Note（例如对同一 Note 同时 split 和 delete）。
        // 只报首个冲突与冲突计数：把全部冲突对列出来会让错误信封失控。
        throw codedError("CONFLICTING_OPERATIONS", "two operations target the same snapshot note", {
          path,
          note: index,
          conflictsWith: `/operations/${claimedBy.get(index)}`,
          conflicts: countConflicts(operations, groupNoteCount),
        });
      }
      claimedBy.set(index, requestIndex);
    }
    return {
      ...operation,
      requestIndex,
      consumed,
      // insert 靠 before 定位；其余靠它消费的最高 index。
      anchor: operation.op === "insert" ? operation.before : Math.max(...consumed),
    };
  });

  // insert 的锚点不得落在 merge 区间**内部**。§9.4 补充规则 3 说"insert 与相邻的
  // delete/merge 不冲突"，那是对的——但"相邻"指边界。落在内部时请求本身是歧义的：
  // `merge from 1 to 3` 把快照 1..3 折成一个音符，而 `insert before 3` 要求落在
  // 快照 2 与 3 之间，这两个音符都不再存在。合并结果之内、之前、之后三种读法都
  // 说得通，因此无法在不猜测意图的前提下执行。
  //
  // 边界位置没有歧义：`before === from` 是合并音符之前，`before === to + 1` 是它
  // 之后。delete/split 也不需要这条规则——被删音符之前的位置由它前面的存活音符
  // 唯一确定，split 只是把一个音符换成两个，边界不动。
  for (const operation of resolved) {
    if (operation.op !== "insert") continue;
    const enclosing = resolved.find(
      (candidate) =>
        candidate.op === "merge" &&
        operation.before > candidate.from &&
        operation.before <= candidate.to
    );
    if (enclosing) {
      throw codedError(
        "INVALID_INSERT_POSITION",
        "insert anchor falls inside a merge span, where its neighbouring notes cease to exist",
        {
          path: `/operations/${operation.requestIndex}/before`,
          got: operation.before,
          mergeSpan: [enclosing.from, enclosing.to],
          // 给出两个明确的替代位置，而不是只说"不行"。
          unambiguousAnchors: [enclosing.from, enclosing.to + 1],
        }
      );
    }
  }

  // 第二遍：(a) 锚点降序，使每一步都不移动尚未处理的低位索引；
  // (b) 锚点相同时按 requestIndex **降序**。
  //
  // (b) 的反转是必需的而不是随意选择：同一 before 上的多个 insert 若按请求顺序施加，
  // 先插入的会被后插入的顶到后面，最终顺序与请求顺序相反。降序施加才让最终顺序
  // 等于请求顺序（§9.4 补充规则 2）。
  const ordered = [...resolved].sort(
    (left, right) => right.anchor - left.anchor || right.requestIndex - left.requestIndex
  );
  return { ordered, conflicts: 0 };
}

/**
 * 一个操作消费的快照 index 集合。insert 返回空集合——它不消费现有 Note，因此与
 * 相邻的 delete/merge 天然不冲突（§9.4 补充规则 3）。
 *
 * @param {object} operation
 * @param {number} groupNoteCount
 * @param {string} path
 * @returns {number[]}
 */
export function snapshotIndicesConsumedBy(operation, groupNoteCount, path) {
  const op = operation?.op;
  if (op === "insert") {
    // before === groupNoteCount 表示追加到末尾，因此上界是"含"。
    assertIndex(operation.before, groupNoteCount, `${path}/before`, { inclusive: true });
    return [];
  }
  if (op === "delete") {
    if (!Array.isArray(operation.notes) || operation.notes.length === 0) {
      throw codedError("INVALID_ARGUMENTS", "delete requires a non-empty notes array", { path });
    }
    for (const [position, note] of operation.notes.entries()) {
      assertIndex(note, groupNoteCount, `${path}/notes/${position}`);
    }
    const unique = new Set(operation.notes);
    if (unique.size !== operation.notes.length) {
      // 同一次 delete 内重复列出同一个 Note：第二次删除会落到别的音符上。
      throw codedError("INVALID_ARGUMENTS", "delete lists the same note twice", { path });
    }
    return [...unique];
  }
  if (op === "split") {
    assertIndex(operation.note, groupNoteCount, `${path}/note`);
    return [operation.note];
  }
  if (op === "merge") {
    assertIndex(operation.from, groupNoteCount, `${path}/from`);
    assertIndex(operation.to, groupNoteCount, `${path}/to`);
    if (operation.to < operation.from) {
      throw codedError("INVALID_ARGUMENTS", "merge requires from <= to", { path: `${path}/to` });
    }
    // 区间必须在快照中连续（§3.3 规则 5）。不连续的 merge 在宿主上没有对应语义。
    const span = [];
    for (let index = operation.from; index <= operation.to; index += 1) span.push(index);
    if (span.length < 2) {
      throw codedError("INVALID_ARGUMENTS", "merge needs at least two notes", { path });
    }
    return span;
  }
  throw codedError("INVALID_ARGUMENTS", `unsupported structural operation: ${String(op)}`, {
    path: `${path}/op`,
  });
}

// 冲突总数：用于错误证据里的 conflicts 计数。这里不抛错，只统计。
function countConflicts(operations, groupNoteCount) {
  const seen = new Set();
  let conflicts = 0;
  for (const [requestIndex, operation] of operations.entries()) {
    let consumed;
    try {
      consumed = snapshotIndicesConsumedBy(operation, groupNoteCount, `/operations/${requestIndex}`);
    } catch {
      // 统计阶段忽略无效操作：它们由第一遍的严格解析负责报错。
      continue;
    }
    for (const index of consumed) {
      if (seen.has(index)) conflicts += 1;
      else seen.add(index);
    }
  }
  return conflicts;
}

/**
 * 纯内存参考模型：按**声明式**语义直接算出提交后的序列，不涉及任何执行顺序。
 *
 * 它的价值在于独立性：执行顺序是否正确，靠"操作模型与这个声明式模型结果一致"来
 * 证明，而不是靠重复同一套排序逻辑。
 *
 * @param {number} groupNoteCount
 * @param {object[]} operations
 * @returns {Array<{kind: string, requestIndex: number|null, snapshotIndex: number|null, part?: number}>}
 */
export function expectedSequence(groupNoteCount, operations) {
  const insertsBefore = new Map();
  const consumers = new Map();
  for (const [requestIndex, operation] of operations.entries()) {
    if (operation.op === "insert") {
      if (!insertsBefore.has(operation.before)) insertsBefore.set(operation.before, []);
      insertsBefore.get(operation.before).push(requestIndex);
      continue;
    }
    for (const index of snapshotIndicesConsumedBy(operation, groupNoteCount, "/x")) {
      consumers.set(index, { requestIndex, operation });
    }
  }

  const out = [];
  const emitInserts = (position) => {
    // 同一位置的多个 insert 按请求顺序出现（§9.4 补充规则 2）。
    for (const requestIndex of insertsBefore.get(position) ?? []) {
      out.push({ kind: "inserted", requestIndex, snapshotIndex: null });
    }
  };

  for (let index = 0; index < groupNoteCount; index += 1) {
    emitInserts(index);
    const consumer = consumers.get(index);
    if (!consumer) {
      out.push({ kind: "kept", requestIndex: null, snapshotIndex: index });
      continue;
    }
    const { operation, requestIndex } = consumer;
    if (operation.op === "delete") continue;
    if (operation.op === "split") {
      out.push({ kind: "split", requestIndex, snapshotIndex: index, part: 0 });
      out.push({ kind: "split", requestIndex, snapshotIndex: index, part: 1 });
      continue;
    }
    // merge：只在区间起点产出一个合并结果，其余位置消失。
    if (operation.op === "merge" && index === operation.from) {
      out.push({ kind: "merged", requestIndex, snapshotIndex: index });
    }
  }
  emitInserts(groupNoteCount);
  return out;
}

/**
 * 操作模型：按编译出的顺序对一个活动数组施加 splice，返回最终序列。
 * 用于与 expectedSequence 对比，从而检验排序规则。
 *
 * @param {number} groupNoteCount
 * @param {object[]} operations
 * @returns {Array<object>}
 */
export function applyInPlannedOrder(groupNoteCount, operations) {
  const live = Array.from({ length: groupNoteCount }, (_, index) => ({
    kind: "kept",
    requestIndex: null,
    snapshotIndex: index,
  }));
  const { ordered } = planRestructure({ groupNoteCount }, operations);

  for (const operation of ordered) {
    if (operation.op === "insert") {
      // 降序执行的收益就在这一行：`before` 此刻恰好是宿主索引，无需重算。
      live.splice(operation.before, 0, {
        kind: "inserted",
        requestIndex: operation.requestIndex,
        snapshotIndex: null,
      });
      continue;
    }
    if (operation.op === "delete") {
      // 从高到低删，避免同一操作内的后续索引漂移。
      for (const index of [...operation.consumed].sort((a, b) => b - a)) {
        live.splice(livePositionOf(live, index), 1);
      }
      continue;
    }
    if (operation.op === "split") {
      live.splice(livePositionOf(live, operation.note), 1, {
        kind: "split",
        requestIndex: operation.requestIndex,
        snapshotIndex: operation.note,
        part: 0,
      }, {
        kind: "split",
        requestIndex: operation.requestIndex,
        snapshotIndex: operation.note,
        part: 1,
      });
      continue;
    }
    const start = livePositionOf(live, operation.from);
    live.splice(start, operation.to - operation.from + 1, {
      kind: "merged",
      requestIndex: operation.requestIndex,
      snapshotIndex: operation.from,
    });
  }
  return live;
}

// 找到某个快照 index 当前所在的位置。降序执行保证它一定还在（未被更低位操作移动）。
function livePositionOf(live, snapshotIndex) {
  const position = live.findIndex(
    (item) => item.kind === "kept" && item.snapshotIndex === snapshotIndex
  );
  if (position < 0) {
    throw codedError(
      "INTERNAL_ERROR",
      `snapshot note ${snapshotIndex} is no longer live; the execution order is wrong`
    );
  }
  return position;
}

function assertIndex(value, groupNoteCount, path, { inclusive = false } = {}) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw codedError("INVALID_ARGUMENTS", "index must be a non-negative safe integer", {
      path,
      rule: "non-negative integer",
    });
  }
  const max = inclusive ? groupNoteCount : groupNoteCount - 1;
  if (value > max) {
    throw codedError("NOTE_INDEX_OUT_OF_RANGE", "index is outside the note group", {
      path,
      got: value,
      max,
    });
  }
}

function codedError(code, message, details) {
  const error = new Error(`[${code}] ${message}`);
  error.code = code;
  if (details) error.details = details;
  return error;
}
