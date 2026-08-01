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
 * 把一个**已封存的 plan capsule**投影成 CAPSULE_REQUIREMENTS_BY_OPERATION 使用的
 * 词汇，然后校验它。
 *
 * 为什么需要这一层：需求表用的是概念名（`target`、`referencedNotes`、
 * `anchorNeighbors`），而 capsule 存的是具体字段（`targetGroupUuid`、
 * `noteFingerprints`、`groupNoteCount`）。两套名字直接对撞会让校验永远失败，
 * 于是这个校验器就只能一直躺在测试里——它此前正是这个状态，而 capsule 漏掉
 * `groupNoteCount` 的真实缺陷因此一直没人发现。
 *
 * 映射只声明**证据从哪来**，不放宽任何一条要求：某项要求若在 capsule 里找不到
 * 对应证据，仍然是 PLAN_CAPSULE_INCOMPLETE。
 *
 * @param {string} operation
 * @param {object} capsule - buildPlanContextSnapshot 产出的 snapshot（含 context.occurrences[0]）
 * @param {number} epoch
 * @returns {void}
 */
export function assertSealedCapsuleSatisfies(operation, capsule, epoch) {
  const occurrence = capsule?.context?.occurrences?.[0];
  if (!occurrence) {
    throw codedError("PLAN_CAPSULE_INCOMPLETE", "capsule must seal exactly one occurrence");
  }
  const fingerprints = Array.isArray(occurrence.noteFingerprints)
    ? occurrence.noteFingerprints
    : null;
  // 概念 -> capsule 里承载它的证据。undefined/null 一律视为缺失（与
  // assertCapsuleSatisfies 同一判定：null 基线不能冒充"已经检查过了"）。
  const evidence = {
    contextEpoch: epoch,
    sharedTargetOccurrences: occurrence.sharedTargetOccurrences,
    target: occurrence.targetGroupUuid,
    referencedNotes: fingerprints,
    // 结构编辑的越界判定依赖组内音符总数；capsule 通常只封存被触及的那几个指纹，
    // 因此它必须独立存在，不能由 noteFingerprints.length 推导。
    groupNoteCount: occurrence.groupNoteCount,
    // 邻居与 merge 区间都从被封存的指纹集合读出：调用方封存哪些音符由 planner 的
    // noteIndexes 决定，这里只要求"指纹集合存在"。
    anchorNeighbors: fingerprints,
    mergeSpanNotes: fingerprints,
    timeOffsetBlick: occurrence.timeOffsetBlick,
    // 下面两项目前没有独立封存字段：曲线基线与 PitchControl 邻接关系都由执行期的
    // live preflight 重新读取（宿主在每次 add/remove 后重排，封存的索引本就不可信）。
    // 因此以指纹集合作为"这份 capsule 描述了哪个音符范围"的证据，而真正的防重复叠加
    // 由 plan-ledger 负责——它才是"这个计划是否已经提交过"的权威。
    curveBaseline: fingerprints,
    pitchControlAdjacency: fingerprints,
    voiceParameters: occurrence.voiceParameters ?? null,
  };
  assertCapsuleSatisfies(operation, evidence);
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
  // capsule 与 store entry **是同一个形状**，因此这里读的字段与 fromSnapshot 完全一致。
  //
  // 以前这个分支读的是一套自己的扁平字段（contextEpoch / occurrence / groupNoteCount），
  // 而生产路径封存出来的 capsule 是 store-entry 形状（epoch / context.occurrences[0]）。
  // 两套词汇谁都不认识谁，于是这个分支只有测试走得通——真实 capsule 从 getContext()
  // 的替身路径进入下游，绕过了这里的全部检查。`groupNoteCount` 被漏封存的缺陷正是
  // 藏在这道缝里：没有任何一处同时看得见"要求什么"和"实际封存了什么"。
  //
  // 让 capsule 就是 entry，缝就没有了：它必须通过 fromSnapshot 的每一条一致性检查
  // （ordinal 与数组位置相符、非空捕获），差别只剩来源标签与 contextId。
  const occurrences = Array.isArray(capsule.context?.occurrences)
    ? capsule.context.occurrences
    : null;
  if (!occurrences || occurrences.length === 0) {
    throw codedError("PLAN_CAPSULE_INCOMPLETE", "capsule must seal its occurrence");
  }
  if (occurrences.length !== 1) {
    throw codedError(
      "PLAN_CAPSULE_INCOMPLETE",
      `a plan capsule seals exactly one occurrence; got ${occurrences.length}`
    );
  }
  return buildScope({
    sourceKind: "plan_capsule",
    // capsule 刻意不带 contextId：它不在 store 里，让下游拿它去 get() 只会得到 null。
    contextId: null,
    epoch: capsule.epoch,
    occurrence: occurrences[0],
    ordinal: 0,
  });
}

/**
 * 按 ordinal 选定 occurrence，供**所有** range-scoped operation 共用。
 *
 * 为什么必须共用一处：以前每个消费者各写一遍「显式 id → find / 省略 → 唯一候选 →
 * 否则 AMBIGUOUS_CONTEXT」，于是同一件事有十几份实现，错误码与候选形状各自漂移。
 * ordinal 迁移把这件事收成一个参数化函数：唯一变化的是「什么算合格候选」。
 *
 * 三条语义是契约（§3.1）：
 * 1. 显式 ordinal 索引**完整** occurrences 数组，与是否合格无关——按合格情况过滤会
 *    让同一个 Context 在不同请求里给出不同编号。
 * 2. 省略时只在恰好一个合格候选时自动选择。
 * 3. 多个合格候选时 AMBIGUOUS_CONTEXT，候选是 **ordinal 列表**，不是字符串 id。
 *
 * @param {object[]} occurrences - Context 的完整 occurrences 数组
 * @param {number|undefined} requestedOrdinal
 * @param {object} options
 * @param {(occurrence: object) => boolean} options.eligible - 省略 ordinal 时的候选判据
 * @param {string} options.noneCode - 零合格候选时的错误码
 * @param {string} options.noneMessage
 * @param {string} options.ambiguousMessage
 * @param {string} [options.ineligibleCode] - 显式 ordinal 指向不合格 occurrence 时的码
 * @param {string} [options.ineligibleMessage]
 * @returns {{ occurrence: object, ordinal: number }}
 */
export function selectOccurrenceByOrdinal(
  occurrences,
  requestedOrdinal,
  { eligible, noneCode, noneMessage, ambiguousMessage, ineligibleCode, ineligibleMessage } = {}
) {
  const all = Array.isArray(occurrences) ? occurrences : [];
  if (requestedOrdinal !== undefined) {
    if (!Number.isSafeInteger(requestedOrdinal) || requestedOrdinal < 0) {
      throw codedError("INVALID_ARGUMENTS", "occurrence must be a non-negative safe integer", {
        got: requestedOrdinal,
      });
    }
    const occurrence = all[requestedOrdinal];
    if (!occurrence) {
      throw codedError(
        "OCCURRENCE_INDEX_OUT_OF_RANGE",
        "occurrence ordinal is outside the context",
        { got: requestedOrdinal, max: all.length - 1 }
      );
    }
    // 显式点名一个不合格的 occurrence 与「越界」不是一回事：前者存在但用不了，
    // 需要不同的补救动作，因此码也必须不同。
    if (eligible && !eligible(occurrence) && ineligibleCode) {
      throw codedError(ineligibleCode, ineligibleMessage, { got: requestedOrdinal });
    }
    return { occurrence, ordinal: requestedOrdinal };
  }
  const candidates = [];
  for (const [ordinal, occurrence] of all.entries()) {
    if (!eligible || eligible(occurrence)) candidates.push({ occurrence, ordinal });
  }
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) {
    throw codedError(noneCode ?? "INVALID_CONTEXT", noneMessage ?? "context has no usable occurrence");
  }
  const error = codedError(
    "AMBIGUOUS_CONTEXT",
    ambiguousMessage ?? "context has multiple occurrences; pass one occurrence ordinal"
  );
  // 候选是 ordinal 列表：模型拿到的就是它下一步该填进 `occurrence` 的值。
  error.details = { candidates: candidates.map((entry) => entry.ordinal) };
  error.candidateOrdinals = error.details.candidates;
  throw error;
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
