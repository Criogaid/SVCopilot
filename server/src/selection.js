import { createHostScope, unknownContextError } from "./snapshot.js";
import { selectOccurrenceByOrdinal } from "./scope-source.js";
import { codedError } from "./coded-error.js";
import { isRecord } from "./value-shape.js";

// sv_set_selection：高层 selection 操作（主计划 P1-E）。
//
// 存在的理由：真实宿主上已观察到 `unselectNote()` **改变了状态却返回 false**。
// raw 层必须原样透传宿主返回值，但 LLM 需要可信的高层结果，因此本服务：
// - 操作前后各读一次 selection，用**读回差异**判定 changed，绝不以宿主 boolean 为证据；
// - 同时保留 hostResults 原始布尔值供调试对照，并在两者矛盾时发警告；
// - selection 是 UI 状态，不创建 Undo 记录（官方 API 也没有为它提供 Undo）。
//
// 身份：组内序号（indexInGroup），只在签发它的 contextId 内有效。本服务按该序号
// 定位音符，因此 context 与宿主之间的结构漂移会被 NOTE_INDEX_OUT_OF_RANGE 拦住，
// 而不是悄悄选中另一个音符。

const OPERATIONS = Object.freeze(["clear", "select", "add", "remove"]);
const MAX_NOTE_IDS = 200;

const PROVENANCE = Object.freeze({
  changedBasis: "read_back_before_after_comparison_not_host_boolean",
  hostBooleanReliability: "unreliable_observed_state_change_with_false_return",
  undoRecord: "none_selection_is_ui_state",
  scope: "current_editor_track_inner_selection",
});

export class SelectionService {
  constructor(session, { snapshotService, now = () => Date.now() } = {}) {
    if (!snapshotService) throw new Error("SelectionService requires the SnapshotService");
    this.session = session;
    this.snapshotService = snapshotService;
    this.now = now;
  }

  async setSelection(request) {
    const input = normalizeRequest(request);
    return this.session.withExclusive(async (host) => {
      const scope = createHostScope(host);
      const warnings = [];
      try {
        const roots = await scope.roots();
        const selection = await scope.call(roots.mainEditor, "getSelection", [], {
          inferredType: "TrackInnerSelectionState",
        });
        const currentGroup = await scope.call(roots.mainEditor, "getCurrentGroup", [], {
          inferredType: "NoteGroupReference",
        });
        const target = await scope.call(currentGroup, "getTarget", [], {
          inferredType: "NoteGroup",
        });

        const before = await readSelectedIndices(scope, selection);
        const positions =
          input.operation === "clear"
            ? []
            : await resolvePositions(this, input, scope, target, warnings);

        const hostResults = await applyOperation(scope, selection, target, input, positions);
        const after = await readSelectedIndices(scope, selection);

        // 唯一可信的判定：读回比较。宿主 boolean 只作为对照证据。
        const changed = !sameIndices(before, after);
        const hostClaimedChange = hostResults.some((entry) => entry.hostReturn === true);
        if (hostClaimedChange !== changed) {
          warnings.push({
            code: "HOST_RETURN_DISAGREES_WITH_READBACK",
            message: `The host return value(s) claimed change=${hostClaimedChange} but reading the selection back showed change=${changed}. The read-back is authoritative; SynthV is known to mutate selection state while returning false.`,
          });
        }

        const notes = await describeNotes(scope, target, after);
        return {
          ok: true,
          status: "succeeded",
          observedAt: new Date(this.now()).toISOString(),
          operation: input.operation,
          changed,
          data: {
            before: { indexInGroup: before, count: before.length },
            after: { indexInGroup: after, count: after.length },
            notes,
            requestedPositions: positions,
            hostResults,
          },
          // selection 不进 Undo：这不是"我们选择不记录"，而是宿主本就不为它建 Undo。
          undo: { recordCreated: false, reason: "selection_is_ui_state" },
          verification: { attempted: true, passed: true, method: "selection_read_back" },
          provenance: PROVENANCE,
          warnings,
        };
      } finally {
        await scope.releaseAll();
      }
    });
  }
}

// ---------- 宿主读写 ----------

async function readSelectedIndices(scope, selection) {
  const notes = await scope.call(selection, "getSelectedNotes", [], {
    resultFormat: "typed-v2",
    resultShape: "array",
    inferredType: "Note",
  });
  const indices = [];
  for (const note of Array.isArray(notes) ? notes : []) {
    if (!note) continue;
    const native = await scope.call(note, "getIndexInParent");
    if (Number.isSafeInteger(native)) indices.push(native - 1);
  }
  return indices.sort((left, right) => left - right);
}

async function applyOperation(scope, selection, target, input, positions) {
  const results = [];
  if (input.operation === "clear") {
    const hostReturn = await scope.call(selection, "clearNotes");
    results.push({ action: "clearNotes", hostReturn });
    return results;
  }
  if (input.operation === "select") {
    // "select" = 替换：先清空再逐个选中。清空的 boolean 同样不作为证据。
    const cleared = await scope.call(selection, "clearNotes");
    results.push({ action: "clearNotes", hostReturn: cleared });
  }
  for (const position of positions) {
    const note = await scope.call(target, "getNote", [position + 1], { inferredType: "Note" });
    const method = input.operation === "remove" ? "unselectNote" : "selectNote";
    const hostReturn = await scope.call(selection, method, [note]);
    results.push({ action: method, indexInGroup: position, hostReturn });
  }
  return results;
}

async function describeNotes(scope, target, indices) {
  const notes = [];
  for (const position of indices) {
    const note = await scope.call(target, "getNote", [position + 1], { inferredType: "Note" });
    notes.push({
      indexInGroup: position,
      lyrics: await scope.call(note, "getLyrics"),
      pitch: await scope.call(note, "getPitch"),
      onsetBlick: await scope.call(note, "getOnset"),
      durationBlick: await scope.call(note, "getDuration"),
    });
  }
  return notes;
}

// ---------- 目标解析 ----------

async function resolvePositions(service, input, scope, target, warnings) {
  const noteCount = await scope.call(target, "getNumNotes");
  const positions = [];
  if (input.contextId !== undefined) {
    const stored = service.snapshotService.store.get(input.contextId);
    if (!stored) {
      throw unknownContextError(service.snapshotService.store, input.contextId);
    }
    let rangeOccurrence = null;
    if (stored.context?.kind === "range") {
      rangeOccurrence = selectOccurrenceByOrdinal(
        stored.context.occurrences,
        input.occurrence,
        {
          eligible: (item) =>
            typeof item.targetGroupUuid === "string" &&
            item.targetGroupUuid.length > 0 &&
            Array.isArray(item.noteFingerprints) &&
            item.noteFingerprints.length > 0,
          noneCode: "OCCURRENCE_NOT_CAPTURED",
          noneMessage: "range context contains no captured vocal occurrence",
          ambiguousMessage:
            "range context has multiple captured vocal occurrences; pass one occurrence ordinal",
          ineligibleCode: "OCCURRENCE_NOT_CAPTURED",
          ineligibleMessage: "the selected occurrence has no captured selectable notes",
        }
      ).occurrence;
    } else if (input.occurrence !== undefined) {
      throw codedError(
        "INVALID_CONTEXT",
        "occurrence is only valid with a range snapshot context"
      );
    }
    const expectedGroupUuids = new Set();
    for (const noteIndex of input.notes) {
      const resolved = resolveContextNotePosition(stored, noteIndex, rangeOccurrence);
      positions.push(resolved.indexInGroup);
      expectedGroupUuids.add(resolved.targetGroupUuid);
    }
    if (expectedGroupUuids.size !== 1 || expectedGroupUuids.has(null)) {
      throw codedError(
        "INVALID_CONTEXT",
        "the supplied notes do not identify exactly one target NoteGroup"
      );
    }
    const expectedGroupUuid = expectedGroupUuids.values().next().value;
    const observedGroupUuid = await scope.call(target, "getUUID");
    if (observedGroupUuid !== expectedGroupUuid) {
      const error = codedError(
        "CURRENT_GROUP_MISMATCH",
        `the note context targets group ${expectedGroupUuid}, but the current editor group is ${observedGroupUuid}; open the captured group and retry`
      );
      error.details = { expectedGroupUuid, observedGroupUuid };
      throw error;
    }
  } else {
    positions.push(...input.indexInGroup);
  }
  const unique = [...new Set(positions)].sort((left, right) => left - right);
  if (unique.length !== positions.length) {
    warnings.push({
      code: "DUPLICATE_SELECTION_TARGETS",
      message: "Duplicate note targets were collapsed; each note is selected or removed once.",
    });
  }
  for (const position of unique) {
    if (position >= noteCount) {
      // 结构在快照之后变了：宁可失败，也不能悄悄选中另一个音符。
      throw codedError(
        "NOTE_INDEX_OUT_OF_RANGE",
        `note index ${position} is outside the current group's ${noteCount} note(s); the group changed after the snapshot — re-snapshot and retry`
      );
    }
  }
  return unique;
}

// context 内的引用一律是组内 index（§3.1）。本服务只作用于宿主"当前编辑组"，
// 因此 occurrence 与当前组不一致时必须明确拒绝（组 UUID 比对在调用方完成）。
function resolveContextNotePosition(stored, noteIndex, rangeOccurrence) {
  if (stored.context?.kind === "range") {
    const fingerprint = (rangeOccurrence?.noteFingerprints ?? []).find(
      (item) => item.indexInGroup === noteIndex
    );
    if (fingerprint) {
      return {
        indexInGroup: fingerprint.indexInGroup,
        targetGroupUuid:
          typeof rangeOccurrence.targetGroupUuid === "string"
            ? rangeOccurrence.targetGroupUuid
            : null,
      };
    }
    throw codedError(
      "NOTE_NOT_IN_CONTEXT",
      `note ${noteIndex} is not part of the selected range occurrence`,
      { got: noteIndex }
    );
  }
  // group/selection 上下文：stored.notes 是捕获顺序，每项带自己的 indexInGroup。
  // 按 indexInGroup 查而不是按数组下标——快照可能只捕获了组内的一个子集，
  // 用下标会静默选中另一个音符。
  const note = (stored.notes ?? []).find((item) => item.indexInGroup === noteIndex);
  if (!note || !Number.isSafeInteger(note.indexInGroup)) {
    throw codedError(
      "NOTE_NOT_IN_CONTEXT",
      `note ${noteIndex} is not present in the supplied snapshot context`,
      { got: noteIndex }
    );
  }
  return {
    indexInGroup: note.indexInGroup,
    targetGroupUuid:
      stored.baseData?.group?.uuid ??
      stored.baseData?.tracks?.[0]?.groups?.[0]?.uuid ??
      null,
  };
}

// ---------- 请求校验 ----------

function normalizeRequest(request) {
  if (!isRecord(request)) throw codedError("INVALID_ARGUMENTS", "request must be an object");
  assertKnownKeys(request, ["operation", "contextId", "occurrence", "notes", "indexInGroup"], "request");
  const operation = request.operation;
  if (!OPERATIONS.includes(operation)) {
    throw codedError("INVALID_ARGUMENTS", `operation must be one of ${OPERATIONS.join(", ")}`);
  }
  if (operation === "clear") {
    for (const key of ["contextId", "occurrence", "notes", "indexInGroup"]) {
      if (request[key] !== undefined) {
        throw codedError("INVALID_ARGUMENTS", `operation "clear" does not accept ${key}`);
      }
    }
    return { operation };
  }
  const hasNotes = request.notes !== undefined;
  const hasIndices = request.indexInGroup !== undefined;
  if (hasNotes === hasIndices) {
    throw codedError(
      "INVALID_ARGUMENTS",
      'provide exactly one of notes (with contextId) or indexInGroup'
    );
  }
  if (hasNotes) {
    if (typeof request.contextId !== "string" || request.contextId.length === 0) {
      throw codedError("INVALID_ARGUMENTS", "notes requires a non-empty contextId");
    }
    assertIndexArray(request.notes, "notes");
    if (
      request.occurrence !== undefined &&
      (!Number.isSafeInteger(request.occurrence) || request.occurrence < 0)
    ) {
      throw codedError(
        "INVALID_ARGUMENTS",
        "occurrence must be a non-negative occurrence ordinal when provided"
      );
    }
    return {
      operation,
      contextId: request.contextId,
      occurrence: request.occurrence,
      notes: request.notes,
    };
  }
  if (request.contextId !== undefined || request.occurrence !== undefined) {
    throw codedError(
      "INVALID_ARGUMENTS",
      "indexInGroup addresses the host's current group directly and does not accept contextId/occurrence"
    );
  }
  if (
    !Array.isArray(request.indexInGroup) ||
    request.indexInGroup.length === 0 ||
    request.indexInGroup.length > MAX_NOTE_IDS
  ) {
    throw codedError(
      "INVALID_ARGUMENTS",
      `indexInGroup must be an array of 1-${MAX_NOTE_IDS} integers`
    );
  }
  for (const value of request.indexInGroup) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw codedError("INVALID_ARGUMENTS", "indexInGroup entries must be non-negative integers");
    }
  }
  return { operation, indexInGroup: request.indexInGroup };
}

function assertIndexArray(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_NOTE_IDS) {
    throw codedError(
      "INVALID_ARGUMENTS",
      `${label} must be an array of 1-${MAX_NOTE_IDS} note indexes`
    );
  }
  for (const entry of value) {
    if (!Number.isSafeInteger(entry) || entry < 0) {
      throw codedError("INVALID_ARGUMENTS", `${label} entries must be non-negative integers`);
    }
  }
}

function sameIndices(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertKnownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw codedError("INVALID_ARGUMENTS", `${label} has an unknown field: ${key}`);
    }
  }
}
