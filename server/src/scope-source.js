// ScopeSource：Context 与 Plan capsule 的共同解析入口（计划 §4.3.2）。
//
// 两种来源产出同一个值：mutation handler 从 SnapshotStore 读 Context；PlanRef 展开出
// 一个只读 capsule。capsule **不写回 store**——写回会让只读证据变成一条可被别人查到、
// 可被 LRU 淘汰、还会与真实快照混淆的条目（§4.3.2），所以它随 resolvePlanReference
// 的返回值交给调用方，由调用方显式传给 getContext。
//
// 光有 `capsule` 参数还不够：target resolution、fingerprint lookup、shared-target
// 检查全都直接读 `stored.context.occurrences`。因此这里把「范围作用域」定义成一个与
// 来源无关的值（ResolvedRangeScope），两条来源各自产出它，下游只消费它。
//
// 这个模块**不访问宿主**：它只做纯数据解析（§3.5 规则 4）。live preflight 仍然
// 完整执行——scope 只是告诉执行器"计划基于什么"，从不代替对活宿主的校验。

/**
 * capsule 的最小完整字段集，按 operation 声明。
 *
 * 为什么不能笼统只存「被引用的 Note fingerprints」：几个 operation 的正确性依赖
 * 被引用集合**之外**的数据。逐 operation 列出来，是为了让"capsule 存少了"变成
 * 可机械判定的，而不是等某次 apply 在真实工程上出错才发现。
 */
export const CAPSULE_REQUIREMENTS_BY_OPERATION = Object.freeze({
  patch_notes: Object.freeze({
    fields: Object.freeze(["target", "referencedNotes"]),
    reason: "逐 Note 改字段：只需目标身份与被引用 Note 的指纹。",
  }),
  set_lyrics: Object.freeze({
    fields: Object.freeze(["target", "referencedNotes"]),
    reason: "同 patch_notes；音素观察在写入后进行，不需要额外快照数据。",
  }),
  restructure_notes: Object.freeze({
    // insert 需要 anchor 两侧邻居来验证 onset 落在正确位置；merge 需要区间内全部
    // Note；delete/split 会改变编号，因此必须知道 group 的总数才能判断越界。
    fields: Object.freeze([
      "target",
      "referencedNotes",
      "anchorNeighbors",
      "mergeSpanNotes",
      "groupNoteCount",
    ]),
    reason:
      "结构编辑改变编号：insert 要用 anchor 两侧邻居验证 onset 解析到 before，" +
      "merge 要求区间连续，越界判定需要 groupNoteCount。只存被引用 Note 不够。",
  }),
  patch_parameter_curves: Object.freeze({
    // mode:"add" 按相对量叠加，因此必须能判断"这段是否已经加过"——这正是 ledger
    // （plan-ledger.js）与 curveBaseline 共同回答的问题。
    fields: Object.freeze([
      "target",
      "referencedNotes",
      "timeOffsetBlick",
      "curveBaseline",
    ]),
    reason:
      "曲线锚定在 Note 位置上，因此需要 time offset 换算；mode:\"add\" 需要基线" +
      "来防止重复叠加。",
  }),
  patch_pitch_controls: Object.freeze({
    fields: Object.freeze([
      "target",
      "referencedNotes",
      "timeOffsetBlick",
      "pitchControlAdjacency",
    ]),
    reason:
      "PitchControl 按 anchor 与相邻间隙定位，宿主在每次 add/remove 后重排，" +
      "因此必须封存邻接关系而不是索引。",
  }),
  bake_computed_pitch: Object.freeze({
    fields: Object.freeze(["target", "referencedNotes", "timeOffsetBlick", "curveBaseline"]),
    reason: "写入一条新曲线，坐标换算与防重复依据同 patch_parameter_curves。",
  }),
  edit_phrase: Object.freeze({
    // 组合事务：它可能同时做 note/structure/curve/voice，因此要求上面各项的并集。
    fields: Object.freeze([
      "target",
      "referencedNotes",
      "anchorNeighbors",
      "mergeSpanNotes",
      "groupNoteCount",
      "timeOffsetBlick",
      "curveBaseline",
      "voiceParameters",
    ]),
    reason:
      "一个 Undo 内组合 note/structure/curve/voice 编辑，因此需要各子编辑要求的并集；" +
      "voice 补丁还需要写入前的 voice parameters 作为补偿基线。",
  }),
});

/**
 * 所有 capsule 都必须携带的字段。shared-target 清单是安全前提而不是优化：
 * 一个被多处引用的 NoteGroup 上的编辑会改变每一处，模型必须先得到确认。
 */
export const UNIVERSAL_CAPSULE_FIELDS = Object.freeze([
  "contextEpoch",
  "sharedTargetOccurrences",
]);

/**
 * @param {string} operation
 * @returns {string[]} 该 operation 的 capsule 必需字段（含通用字段）
 */
export function capsuleFieldsFor(operation) {
  const entry = CAPSULE_REQUIREMENTS_BY_OPERATION[operation];
  if (!entry) {
    throw codedError(
      "INVALID_ARGUMENTS",
      `operation "${operation}" has no capsule requirements; register it in scope-source.js`
    );
  }
  return [...UNIVERSAL_CAPSULE_FIELDS, ...entry.fields];
}

/**
 * 校验一个 capsule 是否满足目标 operation 的最小集合。缺字段就抛错，而不是让
 * apply 在真实工程上走到一半才发现少了判据。
 *
 * @param {string} operation
 * @param {object} capsule
 * @returns {void}
 */
export function assertCapsuleSatisfies(operation, capsule) {
  if (capsule === null || typeof capsule !== "object" || Array.isArray(capsule)) {
    throw codedError("INVALID_ARGUMENTS", "capsule must be an object");
  }
  const missing = capsuleFieldsFor(operation).filter(
    (field) => capsule[field] === undefined || capsule[field] === null
  );
  if (missing.length > 0) {
    throw codedError(
      "PLAN_CAPSULE_INCOMPLETE",
      `capsule for ${operation} is missing: ${missing.join(", ")}`
    );
  }
}

/**
 * 解析范围作用域。两种来源产出同一个形状，因此下游不需要知道自己在跟哪一种打交道。
 *
 * @param {object} options
 * @param {{kind: "snapshot", stored: object} | {kind: "plan_capsule", capsule: object}} options.source
 * @param {number} [options.occurrence] - Context 内 0-based ordinal；单 occurrence 时可省略
 * @returns {{
 *   sourceKind: "snapshot" | "plan_capsule",
 *   contextId: string | null,
 *   epoch: number,
 *   occurrence: object,
 *   occurrenceOrdinal: number,
 *   noteByIndex: Map<number, object>,
 *   groupNoteCount: number,
 *   sharedTargetOccurrences: string[],
 * }}
 */
export function resolveMutationScope({ source, occurrence } = {}) {
  if (source?.kind === "snapshot") return fromSnapshot(source.stored, occurrence);
  if (source?.kind === "plan_capsule") return fromCapsule(source.capsule, occurrence);
  throw codedError(
    "INVALID_ARGUMENTS",
    'source.kind must be "snapshot" or "plan_capsule"'
  );
}

function fromSnapshot(stored, requestedOrdinal) {
  if (stored?.context?.kind !== "range") {
    throw codedError("INVALID_CONTEXT", "operation requires a range context");
  }
  const all = Array.isArray(stored.context.occurrences) ? stored.context.occurrences : [];
  const { occurrence, ordinal } = selectOccurrence(all, requestedOrdinal);
  return buildScope({
    sourceKind: "snapshot",
    contextId: stored.contextId ?? null,
    epoch: stored.epoch,
    occurrence,
    ordinal,
  });
}

function fromCapsule(capsule, requestedOrdinal) {
  if (capsule === null || typeof capsule !== "object" || Array.isArray(capsule)) {
    throw codedError("INVALID_ARGUMENTS", "plan capsule must be an object");
  }
  // capsule 只封存计划真正引用的 occurrence，因此它的 ordinal 恒为 0。
  // 显式传入别的值说明调用方把 Context ordinal 与 capsule ordinal 混淆了——
  // 静默接受会让它读到错误的 occurrence。
  if (requestedOrdinal !== undefined && requestedOrdinal !== 0) {
    throw codedError(
      "OCCURRENCE_INDEX_OUT_OF_RANGE",
      "a plan capsule seals exactly one occurrence; its ordinal is always 0"
    );
  }
  const occurrence = capsule.occurrence;
  if (!occurrence) {
    throw codedError("PLAN_CAPSULE_INCOMPLETE", "capsule must seal its occurrence");
  }
  return buildScope({
    sourceKind: "plan_capsule",
    contextId: null,
    epoch: capsule.contextEpoch,
    occurrence,
    ordinal: 0,
    sharedTargetOccurrences: capsule.sharedTargetOccurrences,
    groupNoteCount: capsule.groupNoteCount,
  });
}

function selectOccurrence(all, requestedOrdinal) {
  if (requestedOrdinal !== undefined) {
    if (!Number.isSafeInteger(requestedOrdinal) || requestedOrdinal < 0) {
      throw codedError("INVALID_ARGUMENTS", "occurrence must be a non-negative safe integer");
    }
    // ordinal 索引**完整**数组，与"是否捕获到 Note"无关（§3.1 规则 1）：
    // 按捕获情况过滤会让同一个 Context 在不同请求里给出不同编号。
    const occurrence = all[requestedOrdinal];
    if (!occurrence) {
      throw codedError("OCCURRENCE_INDEX_OUT_OF_RANGE", "occurrence ordinal is outside the context", {
        got: requestedOrdinal,
        max: all.length - 1,
      });
    }
    return { occurrence, ordinal: requestedOrdinal };
  }
  if (all.length === 1) return { occurrence: all[0], ordinal: 0 };
  if (all.length === 0) {
    throw codedError("INVALID_CONTEXT", "range context contains no occurrence");
  }
  throw codedError("AMBIGUOUS_CONTEXT", "context has multiple occurrences; pass one ordinal", {
    // 候选是全部 ordinal，不按 capturedNotes 过滤：若全部为空捕获，过滤后会返回
    // 空数组，模型就拿不到任何下一步（§9.2 注释）。
    candidates: all.map((_, index) => index),
  });
}

function buildScope({
  sourceKind,
  contextId,
  epoch,
  occurrence,
  ordinal,
  sharedTargetOccurrences,
  groupNoteCount,
}) {
  // Context 自己记录的 ordinal 必须与数组位置一致。不一致意味着有人过滤或重排过
  // occurrences 数组，而那会让同一个 ordinal 在不同请求里指向不同的 occurrence。
  if (Number.isSafeInteger(occurrence.occurrence) && occurrence.occurrence !== ordinal) {
    throw codedError(
      "INVALID_CONTEXT",
      `occurrence ordinal ${ordinal} does not match the stored ordinal ${occurrence.occurrence}; the occurrences array was filtered or reordered`
    );
  }
  const fingerprints = Array.isArray(occurrence.noteFingerprints)
    ? occurrence.noteFingerprints
    : [];
  // 空捕获检查放在 occurrence 选定之后，两条分支共用（§9.2）：只在显式 ordinal
  // 分支检查会让"单 occurrence 省略 ordinal"漏过，随后退化成 NOTE_NOT_IN_CONTEXT
  // ——那正是 §3.1 规则 3 禁止的降级。
  if (fingerprints.length === 0) {
    throw codedError("OCCURRENCE_NOT_CAPTURED", "the selected occurrence captured no notes", {
      got: ordinal,
    });
  }
  // 稀疏是正常的：range 可以只捕获乐句内的 Note。
  const noteByIndex = new Map(
    fingerprints.map((fingerprint) => [fingerprint.indexInGroup, fingerprint])
  );
  const resolvedGroupNoteCount =
    groupNoteCount ?? occurrence.groupNoteCount ?? fingerprints.length;
  return Object.freeze({
    sourceKind,
    contextId,
    epoch,
    occurrence,
    occurrenceOrdinal: ordinal,
    noteByIndex,
    groupNoteCount: resolvedGroupNoteCount,
    sharedTargetOccurrences:
      sharedTargetOccurrences ?? occurrence.sharedTargetOccurrences ?? [],
  });
}

/**
 * 把 0-based NoteGroup index 解析成 Context 内被冻结的 fingerprint 引用。
 *
 * 两种失败必须分开（§3.2 规则 5）：越界靠重试永远不会成功，未捕获则需要重新捕获
 * 更宽的范围。合并成一个错误码会让模型分不清该怎么办。
 *
 * @param {object} scope - resolveMutationScope 的返回值
 * @param {number} index
 * @param {string} path - JSON Pointer，用于错误定位
 * @returns {object} 冻结的 fingerprint 引用
 */
export function resolveNoteIndex(scope, index, path) {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw codedError("INVALID_ARGUMENTS", "note index must be a non-negative safe integer", {
      path,
      rule: "non-negative integer",
    });
  }
  if (index >= scope.groupNoteCount) {
    throw codedError("NOTE_INDEX_OUT_OF_RANGE", "note index is outside the note group", {
      path,
      got: index,
      max: scope.groupNoteCount - 1,
    });
  }
  const note = scope.noteByIndex.get(index);
  if (!note) {
    throw codedError("NOTE_NOT_IN_CONTEXT", "this note exists but was not captured", {
      path,
      got: index,
      // 有界摘要：数百个合法 index 全部回显会撑爆错误预算（§9.2）。
      captured: summarizeIndexRuns(scope.noteByIndex.keys(), { maxRuns: 8 }),
    });
  }
  return note;
}

/**
 * 把一组 index 压成最多 maxRuns 段连续区间 `[from, to]`。
 *
 * @param {Iterable<number>} indices
 * @param {object} [options]
 * @param {number} [options.maxRuns]
 * @returns {Array<[number, number]>}
 */
export function summarizeIndexRuns(indices, { maxRuns = 8 } = {}) {
  const sorted = [...indices].sort((a, b) => a - b);
  const runs = [];
  for (const index of sorted) {
    const last = runs.at(-1);
    if (last && index === last[1] + 1) {
      last[1] = index;
      continue;
    }
    runs.push([index, index]);
  }
  return runs.slice(0, maxRuns);
}

function codedError(code, message, details) {
  const error = new Error(`[${code}] ${message}`);
  error.code = code;
  if (details) error.details = details;
  return error;
}
