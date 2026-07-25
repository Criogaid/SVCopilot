import {
  appendSharedTargetDryRunWarnings,
  deriveRangeOccurrenceId,
  ensureSharedTargetConfirmed,
  parseContextNoteId,
  resolveContextTarget,
} from "./context-target.js";
import { waitForProcessing } from "./processing.js";

// 结构操作按调用方顺序逐个执行；每步都在执行时读取活动 index，避免删除导致的漂移。
// MAX_OPERATIONS 导出供 harmony 规划器对齐单次可提交批量上限。
export const MAX_OPERATIONS = 64;

export class NoteStructureService {
  constructor(session, snapshotService, { sleepFn, now = () => Date.now() } = {}) {
    this.session = session;
    this.snapshotService = snapshotService;
    this.sleep = sleepFn;
    this.now = now;
  }

  async restructureNotes(request) {
    const input = normalizeRequest(request);
    return this.session.withExclusive(async (host) => {
      let resolved;
      let boundaryCalls = 0;
      let writeAttempted = false;
      const inverses = [];
      const appliedOperations = [];
      const warnings = [];
      const startedAt = this.now();
      const atomicity = input.atomic ? "verified_compensation" : "none";
      try {
        const stored = this.snapshotService.getContext(input.contextId, host.epoch());
        resolved = await resolveContextTarget(host, stored, {
          verify: true,
          acceptRange: true,
          occurrenceId:
            input.occurrenceId ?? deriveRangeOccurrenceId(stored, operationNoteIdList(input)),
        });
        const scope = resolved.scope;
        const initialNoteCount = await scope.call(resolved.target, "getNumNotes");

        const plan = buildPlan(input, resolved, initialNoteCount);
        if (plan.mismatches.length > 0) {
          return {
            ...failedResult(
              "EXPECTED_MISMATCH",
              "One or more expected values did not match the current note state.",
              "none"
            ),
            atomicity,
            data: { mismatches: plan.mismatches, plannedOperations: [] },
            rollback: { attempted: false, verified: null },
          };
        }

        if (input.dryRun) {
          appendSharedTargetDryRunWarnings(resolved, input, warnings);
          return {
            ok: true,
            status: "dry_run",
            effects: "none",
            atomicity,
            data: {
              initialNoteCount,
              expectedNoteCount: initialNoteCount + plan.noteCountDelta,
              plannedOperations: plan.summaries,
              appliedOperations: [],
            },
            rollback: { attempted: false, verified: null },
            undo: undoEvidence(0),
            verification: { attempted: false, passed: null },
            warnings,
            timing: { elapsedMs: this.now() - startedAt },
          };
        }

        await ensureSharedTargetConfirmed(resolved, input);

        await scope.call(resolved.roots.project, "newUndoRecord", []);
        boundaryCalls += 1;

        let applyError = null;
        const checks = [];
        try {
          for (const operation of plan.operations) {
            writeAttempted = true;
            // inverse 条目在每个宿主 mutation 生效后立即入账，op 中途失败也有完整补偿。
            // checks 收集每个 op 的字段级后置条件，统一在写后读回验证。
            const summary = await applyOperation(scope, resolved, operation, inverses, checks);
            appliedOperations.push(summary);
          }
        } catch (error) {
          applyError = error;
        }

        // 读回 getter 抛错也必须走补偿路径，而不是漏到外层 catch。
        let verifyError = null;
        let verification = null;
        if (!applyError) {
          try {
            verification = await verifyStructure(scope, resolved, plan, initialNoteCount, checks);
          } catch (error) {
            verifyError = error;
          }
        }

        if (applyError || verifyError || verification?.passed === false) {
          const causeError = applyError ?? verifyError;
          const failure = causeError
            ? {
                code: typeof causeError?.code === "string" ? causeError.code : "HOST_CALL_FAILED",
                message: causeError instanceof Error ? causeError.message : String(causeError),
              }
            : {
                code: "POSTCONDITION_FAILED",
                message: "The group did not match the planned structure after write-back verification.",
              };
          if (causeError && isUnknownOutcomeError(causeError)) {
            await this._closeBoundary(scope, resolved, warnings, () => (boundaryCalls += 1));
            return {
              ...failedResult(failure.code, failure.message, "unknown"),
              status: "outcome_unknown",
              atomicity,
              data: { plannedOperations: plan.summaries, appliedOperations },
              rollback: { attempted: false, verified: null },
              undo: undoEvidence(boundaryCalls),
              warnings,
              timing: { elapsedMs: this.now() - startedAt },
            };
          }
          if (!input.atomic) {
            await this._closeBoundary(scope, resolved, warnings, () => (boundaryCalls += 1));
            return {
              ...failedResult(failure.code, failure.message, "may_remain"),
              status: "partial",
              atomicity,
              data: { plannedOperations: plan.summaries, appliedOperations },
              rollback: { attempted: false, verified: null },
              undo: undoEvidence(boundaryCalls),
              ...(verification ? { verification } : {}),
              warnings,
              timing: { elapsedMs: this.now() - startedAt },
            };
          }
          const rollback = await rollbackStructure(scope, resolved, inverses, initialNoteCount);
          await this._closeBoundary(scope, resolved, warnings, () => (boundaryCalls += 1));
          return {
            ...failedResult(
              failure.code,
              failure.message,
              rollback.verified ? "reverted" : rollback.outcomeUnknown ? "unknown" : "may_remain"
            ),
            status: rollback.verified ? "rolled_back" : "rollback_failed",
            atomicity,
            data: { plannedOperations: plan.summaries, appliedOperations },
            rollback: {
              attempted: true,
              verified: rollback.verified,
              ...(rollback.error ? { error: rollback.error } : {}),
            },
            undo: undoEvidence(boundaryCalls),
            ...(verification ? { verification } : {}),
            warnings,
            timing: { elapsedMs: this.now() - startedAt },
          };
        }

        await this._closeBoundary(scope, resolved, warnings, () => (boundaryCalls += 1));

        let processing = null;
        if (input.waitFor !== "none") {
          // 提交与结构读回已完成、Undo 边界已关闭；处理观测失败只降级 processing 子结果，
          // 绝不把已验证成功的写入误报为 outcome_unknown/partial（对齐 phrase-edit）。
          try {
            processing = await waitForProcessing(host, {
              roots: resolved.roots,
              group: resolved.group,
              kind: input.waitFor,
              expectedNotes: initialNoteCount + plan.noteCountDelta,
              timeoutMs: input.timeoutMs,
              pollIntervalMs: input.pollIntervalMs,
              sleepFn: this.sleep,
              now: this.now,
            });
            warnings.push(...processing.warnings);
          } catch (error) {
            processing = {
              ok: false,
              status: "processing_observation_failed",
              data: { state: "unknown", attempts: null, elapsedMs: null, evidence: null },
              error: {
                code: typeof error?.code === "string" ? error.code : "HOST_CALL_FAILED",
                message: error instanceof Error ? error.message : String(error),
              },
              warnings: [],
            };
            warnings.push({
              code: "PROCESSING_OBSERVATION_FAILED",
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
        this.snapshotService.store.delete(input.contextId);

        return {
          ok: true,
          status: processing?.status ?? "succeeded",
          effects: "verified",
          atomicity,
          data: {
            initialNoteCount,
            finalNoteCount: verification.evidence.observedNoteCount,
            plannedOperations: plan.summaries,
            appliedOperations,
            ...(processing
              ? {
                  processing: {
                    state: processing.data.state,
                    attempts: processing.data.attempts,
                    elapsedMs: processing.data.elapsedMs,
                    evidence: processing.data.evidence,
                    ...(processing.error ? { error: processing.error } : {}),
                  },
                }
              : {}),
          },
          rollback: { attempted: false, verified: null },
          undo: undoEvidence(boundaryCalls),
          verification,
          warnings,
          timing: { elapsedMs: this.now() - startedAt },
        };
      } catch (error) {
        const unknown = isUnknownOutcomeError(error);
        const effects = writeAttempted ? (unknown ? "unknown" : "may_remain") : "none";
        // 已开启但未关闭的 Undo 边界尽力关闭，失败只记警告。
        if (boundaryCalls === 1 && !unknown && resolved) {
          await this._closeBoundary(resolved.scope, resolved, warnings, () => (boundaryCalls += 1));
        }
        return {
          ...failedResult(
            typeof error?.code === "string" ? error.code : "HOST_CALL_FAILED",
            error instanceof Error ? error.message : String(error),
            effects,
            error?.details
          ),
          status: writeAttempted ? (unknown ? "outcome_unknown" : "partial") : "failed",
          atomicity,
          data: { appliedOperations },
          rollback: { attempted: false, verified: null },
          undo: undoEvidence(boundaryCalls),
          warnings,
        };
      } finally {
        if (writeAttempted) this.snapshotService.store.delete(input.contextId);
        await resolved?.scope.releaseAll();
      }
    });
  }

  async _closeBoundary(scope, resolved, warnings, onSuccess) {
    try {
      await scope.call(resolved.roots.project, "newUndoRecord", []);
      onSuccess();
    } catch (error) {
      warnings.push({
        code: "UNDO_BOUNDARY_CLOSE_FAILED",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function buildPlan(input, resolved, initialNoteCount) {
  const mismatches = [];
  const summaries = [];
  const operations = [];
  const usedPositions = new Set();
  let noteCountDelta = 0;

  const claimPosition = (noteId, position) => {
    if (usedPositions.has(position)) {
      throw codedError("DUPLICATE_NOTE_ID", `noteId is used by more than one operation: ${noteId}`);
    }
    usedPositions.add(position);
  };

  for (const [index, op] of input.operations.entries()) {
    if (op.op === "insert") {
      noteCountDelta += 1;
      operations.push({ ...op });
      summaries.push({ op: "insert", note: op.note });
      continue;
    }
    if (op.op === "delete") {
      const position = parseContextNoteId(op.noteId, input.contextId, resolved);
      claimPosition(op.noteId, position);
      const fingerprint = resolved.fingerprints[position];
      for (const [field, expected] of Object.entries(op.expected ?? {})) {
        if (!deepEqual(fingerprint[field], expected)) {
          mismatches.push({ noteId: op.noteId, field, expected, observed: fingerprint[field] });
        }
      }
      noteCountDelta -= 1;
      operations.push({ ...op, position, note: resolved.notes[position], fingerprint });
      summaries.push({ op: "delete", noteId: op.noteId, indexInGroup: fingerprint.indexInGroup });
      continue;
    }
    if (op.op === "split") {
      const position = parseContextNoteId(op.noteId, input.contextId, resolved);
      claimPosition(op.noteId, position);
      const fingerprint = resolved.fingerprints[position];
      const onset = fingerprint.onsetBlick;
      const end = onset + fingerprint.durationBlick;
      if (op.atBlick <= onset || op.atBlick >= end) {
        throw codedError(
          "INVALID_ARGUMENTS",
          `operations[${index}].atBlick must be strictly inside the note (${onset}, ${end})`
        );
      }
      noteCountDelta += 1;
      operations.push({ ...op, position, note: resolved.notes[position], fingerprint });
      summaries.push({
        op: "split",
        noteId: op.noteId,
        atBlick: op.atBlick,
        secondLyrics: op.secondLyrics,
      });
      continue;
    }
    // merge：noteIds 必须是组内 index 连续的音符，按时间升序合并进第一个。
    const positions = op.noteIds.map((noteId) =>
      parseContextNoteId(noteId, input.contextId, resolved)
    );
    for (const [itemIndex, position] of positions.entries()) claimPosition(op.noteIds[itemIndex], position);
    const fingerprints = positions.map((position) => resolved.fingerprints[position]);
    const sorted = [...fingerprints].sort((a, b) => a.indexInGroup - b.indexInGroup);
    for (let itemIndex = 1; itemIndex < sorted.length; itemIndex += 1) {
      if (sorted[itemIndex].indexInGroup !== sorted[itemIndex - 1].indexInGroup + 1) {
        throw codedError(
          "INVALID_ARGUMENTS",
          `operations[${index}].noteIds must reference consecutive notes in the group`
        );
      }
    }
    const order = positions
      .map((position, itemIndex) => ({
        position,
        fingerprint: fingerprints[itemIndex],
        noteId: op.noteIds[itemIndex],
      }))
      .sort((a, b) => a.fingerprint.indexInGroup - b.fingerprint.indexInGroup);
    noteCountDelta -= op.noteIds.length - 1;
    operations.push({
      ...op,
      ordered: order.map((item) => ({
        position: item.position,
        note: resolved.notes[item.position],
        fingerprint: item.fingerprint,
        noteId: item.noteId,
      })),
    });
    summaries.push({ op: "merge", noteIds: op.noteIds, lyricsJoin: op.lyricsJoin });
  }
  void initialNoteCount;
  return { operations, summaries, mismatches, noteCountDelta };
}

async function applyOperation(scope, resolved, operation, inverses, checks) {
  if (operation.op === "insert") {
    // 未入组的 Note 是 detached 对象；配置阶段失败不需要补偿。
    const note = await scope.call(undefined, "create", ["Note"], { inferredType: "Note" });
    await scope.call(note, "setTimeRange", [
      operation.note.onsetBlick,
      operation.note.durationBlick,
    ]);
    await scope.call(note, "setPitch", [operation.note.pitch]);
    if (operation.note.lyrics !== undefined) {
      await scope.call(note, "setLyrics", [operation.note.lyrics]);
    }
    if (operation.note.phonemesOverride !== undefined) {
      await scope.call(note, "setPhonemes", [operation.note.phonemesOverride]);
    }
    if (operation.note.languageOverride !== undefined) {
      await scope.call(note, "setLanguageOverride", [operation.note.languageOverride]);
    }
    const hostIndex = await scope.call(resolved.target, "addNote", [note]);
    inverses.push({ op: "removeByHandle", note });
    checks.push(
      { op: "insert", note, getter: "getOnset", expected: operation.note.onsetBlick },
      { op: "insert", note, getter: "getDuration", expected: operation.note.durationBlick },
      { op: "insert", note, getter: "getPitch", expected: operation.note.pitch }
    );
    if (operation.note.lyrics !== undefined) {
      checks.push({ op: "insert", note, getter: "getLyrics", expected: operation.note.lyrics });
    }
    if (operation.note.phonemesOverride !== undefined) {
      checks.push({
        op: "insert",
        note,
        getter: "getPhonemes",
        expected: operation.note.phonemesOverride,
      });
    }
    if (operation.note.languageOverride !== undefined) {
      checks.push({
        op: "insert",
        note,
        getter: "getLanguageOverride",
        expected: operation.note.languageOverride,
      });
    }
    return { op: "insert", hostIndex, indexInGroup: hostIndex - 1 };
  }
  if (operation.op === "delete") {
    // 删除前保存深拷贝作为补偿；removeNote 用执行时的活动 index。
    const backup = await scope.call(operation.note, "clone", [], { inferredType: "Note" });
    const liveIndex = await scope.call(operation.note, "getIndexInParent");
    await scope.call(resolved.target, "removeNote", [liveIndex]);
    inverses.push({ op: "addBackup", backup });
    return { op: "delete", noteId: operation.noteId, removedHostIndex: liveIndex };
  }
  if (operation.op === "split") {
    const original = operation.note;
    const onset = operation.fingerprint.onsetBlick;
    const end = onset + operation.fingerprint.durationBlick;
    const second = await scope.call(original, "clone", [], { inferredType: "Note" });
    await scope.call(second, "setTimeRange", [operation.atBlick, end - operation.atBlick]);
    await scope.call(second, "setLyrics", [operation.secondLyrics]);
    const hostIndex = await scope.call(resolved.target, "addNote", [second]);
    inverses.push({ op: "removeByHandle", note: second });
    await scope.call(original, "setDuration", [operation.atBlick - onset]);
    inverses.push({ op: "setDuration", note: original, value: operation.fingerprint.durationBlick });
    checks.push(
      { op: "split", note: original, getter: "getDuration", expected: operation.atBlick - onset },
      { op: "split", note: second, getter: "getOnset", expected: operation.atBlick },
      { op: "split", note: second, getter: "getDuration", expected: end - operation.atBlick },
      { op: "split", note: second, getter: "getLyrics", expected: operation.secondLyrics },
      { op: "split", note: second, getter: "getPitch", expected: operation.fingerprint.pitch }
    );
    return { op: "split", noteId: operation.noteId, secondHostIndex: hostIndex };
  }
  // merge
  const first = operation.ordered[0];
  const last = operation.ordered[operation.ordered.length - 1];
  // 执行期用活动 index 复核相邻性：同请求中先前的 insert/split 可能已把新音符排进
  // 计划相邻的 merge 音符之间，按计划期指纹继续合并会把它静默埋进时值里（对齐 phrase-edit）。
  const liveIndices = [];
  for (const item of operation.ordered) {
    const liveIndex = await scope.call(item.note, "getIndexInParent");
    if (!Number.isSafeInteger(liveIndex) || liveIndex < 1) {
      throw codedError(
        "STALE_CONTEXT",
        `merge note is no longer in the target group: ${item.noteId}`
      );
    }
    liveIndices.push(liveIndex);
  }
  for (let itemIndex = 1; itemIndex < liveIndices.length; itemIndex += 1) {
    if (liveIndices[itemIndex] !== liveIndices[itemIndex - 1] + 1) {
      throw codedError(
        "INVALID_ARGUMENTS",
        "merge noteIds are no longer consecutive at execution time; an earlier operation in this request placed a note between them"
      );
    }
  }
  const span =
    last.fingerprint.onsetBlick + last.fingerprint.durationBlick - first.fingerprint.onsetBlick;
  const mergedLyrics =
    operation.lyricsJoin === "concat"
      ? operation.ordered.map((item) => item.fingerprint.lyrics).join("")
      : first.fingerprint.lyrics;
  for (const item of [...operation.ordered.slice(1)].reverse()) {
    const backup = await scope.call(item.note, "clone", [], { inferredType: "Note" });
    const liveIndex = await scope.call(item.note, "getIndexInParent");
    await scope.call(resolved.target, "removeNote", [liveIndex]);
    inverses.push({ op: "addBackup", backup });
  }
  await scope.call(first.note, "setDuration", [span]);
  inverses.push({ op: "setDuration", note: first.note, value: first.fingerprint.durationBlick });
  if (mergedLyrics !== first.fingerprint.lyrics) {
    await scope.call(first.note, "setLyrics", [mergedLyrics]);
    inverses.push({ op: "setLyrics", note: first.note, value: first.fingerprint.lyrics });
  }
  checks.push(
    { op: "merge", note: first.note, getter: "getDuration", expected: span },
    { op: "merge", note: first.note, getter: "getLyrics", expected: mergedLyrics }
  );
  return { op: "merge", noteIds: operation.noteIds, mergedDurationBlick: span };
}

async function verifyStructure(scope, resolved, plan, initialNoteCount, checks) {
  const observedNoteCount = await scope.call(resolved.target, "getNumNotes");
  const expectedNoteCount = initialNoteCount + plan.noteCountDelta;
  const fieldMismatches = [];
  for (const check of checks) {
    const observed = await scope.call(check.note, check.getter, []);
    if (observed !== check.expected) {
      fieldMismatches.push({
        op: check.op,
        getter: check.getter,
        expected: check.expected,
        observed,
      });
    }
  }
  const passed = observedNoteCount === expectedNoteCount && fieldMismatches.length === 0;
  return {
    attempted: true,
    passed,
    evidence: {
      observedNoteCount,
      expectedNoteCount,
      fieldChecks: checks.length,
      ...(fieldMismatches.length > 0 ? { fieldMismatches } : {}),
    },
  };
}

async function rollbackStructure(scope, resolved, inverses, initialNoteCount) {
  const errors = [];
  // 单个补偿写失败不终止其余补偿；宿主超时/断开才放弃。
  for (const inverse of [...inverses].reverse()) {
    try {
      if (inverse.op === "removeByHandle") {
        const liveIndex = await scope.call(inverse.note, "getIndexInParent");
        await scope.call(resolved.target, "removeNote", [liveIndex]);
      } else if (inverse.op === "addBackup") {
        await scope.call(resolved.target, "addNote", [inverse.backup]);
      } else if (inverse.op === "setDuration") {
        await scope.call(inverse.note, "setDuration", [inverse.value]);
      } else if (inverse.op === "setLyrics") {
        await scope.call(inverse.note, "setLyrics", [inverse.value]);
      }
    } catch (error) {
      if (isUnknownOutcomeError(error)) {
        return { verified: false, outcomeUnknown: true, error: rollbackError(error) };
      }
      errors.push({ op: inverse.op, ...rollbackError(error) });
    }
  }
  try {
    const observedNoteCount = await scope.call(resolved.target, "getNumNotes");
    // 逐项确认恢复效果：setDuration/setLyrics 读回旧值，addBackup 确认已回到组内。
    let fieldsVerified = true;
    for (const inverse of inverses) {
      if (inverse.op === "setDuration") {
        if ((await scope.call(inverse.note, "getDuration", [])) !== inverse.value) fieldsVerified = false;
      } else if (inverse.op === "setLyrics") {
        if ((await scope.call(inverse.note, "getLyrics", [])) !== inverse.value) fieldsVerified = false;
      } else if (inverse.op === "addBackup") {
        const index = await scope.call(inverse.backup, "getIndexInParent", []);
        if (!Number.isSafeInteger(index) || index < 1) fieldsVerified = false;
      }
    }
    const verified =
      errors.length === 0 && observedNoteCount === initialNoteCount && fieldsVerified;
    return {
      verified,
      outcomeUnknown: false,
      ...(errors.length > 0 ? { error: errors[0], errors } : {}),
    };
  } catch (error) {
    return {
      verified: false,
      outcomeUnknown: isUnknownOutcomeError(error),
      error: rollbackError(error),
      ...(errors.length > 0 ? { errors } : {}),
    };
  }
}

function rollbackError(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "ROLLBACK_FAILED",
    message: error instanceof Error ? error.message : String(error),
  };
}

// range occurrence 推导使用的 noteId 全集：insert 没有 noteId,delete/split 一个,merge 多个。
function operationNoteIdList(input) {
  const noteIds = [];
  for (const op of input.operations) {
    if (typeof op.noteId === "string") noteIds.push(op.noteId);
    if (Array.isArray(op.noteIds)) noteIds.push(...op.noteIds.filter((id) => typeof id === "string"));
  }
  return noteIds;
}

function normalizeRequest(request) {
  if (!isRecord(request)) throw codedError("INVALID_ARGUMENTS", "request must be an object");
  if (typeof request.contextId !== "string" || !request.contextId) {
    throw codedError("INVALID_ARGUMENTS", "contextId is required; take it from sv_snapshot");
  }
  if (!Array.isArray(request.operations) || request.operations.length === 0) {
    throw codedError("INVALID_ARGUMENTS", "operations must be a non-empty array");
  }
  if (request.operations.length > MAX_OPERATIONS) {
    throw codedError("INVALID_ARGUMENTS", `operations must contain at most ${MAX_OPERATIONS} items`);
  }
  const operations = request.operations.map((op, index) => normalizeOperation(op, index));
  const waitFor = request.waitFor ?? "phonemes";
  if (!["none", "phonemes", "computedAttributes"].includes(waitFor)) {
    throw codedError("INVALID_ARGUMENTS", "waitFor must be none, phonemes, or computedAttributes");
  }
  if (request.dryRun !== undefined && typeof request.dryRun !== "boolean") {
    throw codedError("INVALID_ARGUMENTS", "dryRun must be a boolean");
  }
  if (request.atomic !== undefined && typeof request.atomic !== "boolean") {
    throw codedError("INVALID_ARGUMENTS", "atomic must be a boolean");
  }
  if (
    request.occurrenceId !== undefined &&
    (typeof request.occurrenceId !== "string" || request.occurrenceId.length === 0)
  ) {
    throw codedError("INVALID_ARGUMENTS", "occurrenceId must be a non-empty string");
  }
  if (
    request.allowSharedTargetMutation !== undefined &&
    typeof request.allowSharedTargetMutation !== "boolean"
  ) {
    throw codedError("INVALID_ARGUMENTS", "allowSharedTargetMutation must be a boolean");
  }
  return {
    contextId: request.contextId,
    operations,
    occurrenceId: request.occurrenceId,
    allowSharedTargetMutation: request.allowSharedTargetMutation === true,
    dryRun: request.dryRun === true,
    atomic: request.atomic !== false,
    waitFor,
    timeoutMs: clampInteger(request.timeoutMs, 0, 30_000, 10_000),
    pollIntervalMs: clampInteger(request.pollIntervalMs, 20, 2_000, 100),
  };
}

function normalizeOperation(op, index) {
  if (!isRecord(op)) throw codedError("INVALID_ARGUMENTS", `operations[${index}] must be an object`);
  const label = `operations[${index}]`;
  if (op.op === "insert") {
    const note = op.note;
    if (!isRecord(note)) throw codedError("INVALID_ARGUMENTS", `${label}.note must be an object`);
    if (!Number.isSafeInteger(note.onsetBlick) || note.onsetBlick < 0) {
      throw codedError("INVALID_ARGUMENTS", `${label}.note.onsetBlick must be a non-negative integer`);
    }
    if (!Number.isSafeInteger(note.durationBlick) || note.durationBlick < 1) {
      throw codedError("INVALID_ARGUMENTS", `${label}.note.durationBlick must be a positive integer`);
    }
    if (!Number.isSafeInteger(note.pitch) || note.pitch < 0 || note.pitch > 127) {
      throw codedError("INVALID_ARGUMENTS", `${label}.note.pitch must be an integer MIDI pitch 0-127`);
    }
    for (const field of ["lyrics", "phonemesOverride", "languageOverride"]) {
      if (note[field] !== undefined && typeof note[field] !== "string") {
        throw codedError("INVALID_ARGUMENTS", `${label}.note.${field} must be a string`);
      }
    }
    return {
      op: "insert",
      note: {
        onsetBlick: note.onsetBlick,
        durationBlick: note.durationBlick,
        pitch: note.pitch,
        lyrics: note.lyrics,
        phonemesOverride: note.phonemesOverride,
        languageOverride: note.languageOverride,
      },
    };
  }
  if (op.op === "delete") {
    if (typeof op.noteId !== "string") {
      throw codedError("INVALID_ARGUMENTS", `${label}.noteId must be a string`);
    }
    if (op.expected !== undefined && !isRecord(op.expected)) {
      throw codedError("INVALID_ARGUMENTS", `${label}.expected must be an object`);
    }
    return { op: "delete", noteId: op.noteId, expected: op.expected };
  }
  if (op.op === "split") {
    if (typeof op.noteId !== "string") {
      throw codedError("INVALID_ARGUMENTS", `${label}.noteId must be a string`);
    }
    if (!Number.isSafeInteger(op.atBlick) || op.atBlick < 1) {
      throw codedError("INVALID_ARGUMENTS", `${label}.atBlick must be a positive integer (group-local blick)`);
    }
    if (op.secondLyrics !== undefined && typeof op.secondLyrics !== "string") {
      throw codedError("INVALID_ARGUMENTS", `${label}.secondLyrics must be a string`);
    }
    return { op: "split", noteId: op.noteId, atBlick: op.atBlick, secondLyrics: op.secondLyrics ?? "-" };
  }
  if (op.op === "merge") {
    if (
      !Array.isArray(op.noteIds) ||
      op.noteIds.length < 2 ||
      !op.noteIds.every((noteId) => typeof noteId === "string")
    ) {
      throw codedError("INVALID_ARGUMENTS", `${label}.noteIds must be an array of at least two noteIds`);
    }
    if (op.lyricsJoin !== undefined && !["first", "concat"].includes(op.lyricsJoin)) {
      throw codedError("INVALID_ARGUMENTS", `${label}.lyricsJoin must be "first" or "concat"`);
    }
    return { op: "merge", noteIds: op.noteIds, lyricsJoin: op.lyricsJoin ?? "first" };
  }
  throw codedError("INVALID_ARGUMENTS", `${label}.op must be insert, delete, split, or merge`);
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function failedResult(code, message, effects, details) {
  return {
    ok: false,
    status: "failed",
    effects,
    error: {
      code,
      message,
      outcome:
        effects === "none" || effects === "reverted"
          ? "unchanged"
          : effects === "unknown"
            ? "unknown"
            : "partial",
      retryable: false,
      ...(details !== undefined ? { details } : {}),
    },
    undo: undoEvidence(0),
    verification: { attempted: false, passed: null },
    warnings: [],
  };
}

function undoEvidence(boundaryCallsCompleted) {
  return {
    boundaryCallsCompleted,
    expectedUserUndoSteps: boundaryCallsCompleted === 2 ? 1 : null,
    automaticRollback: false,
  };
}

function isUnknownOutcomeError(error) {
  if (error?.code === "HOST_TIMEOUT" || error?.code === "HOST_DETACHED") return true;
  return /Timeout waiting|detached|disconnected|EOF/i.test(
    error instanceof Error ? error.message : String(error)
  );
}

function clampInteger(value, minimum, maximum, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw codedError("INVALID_ARGUMENTS", `integer must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
