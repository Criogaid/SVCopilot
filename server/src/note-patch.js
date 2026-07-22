import { contextGroupNoteCount, resolveContextTarget } from "./context-target.js";
import { waitForProcessing } from "./processing.js";

// 字段表同时决定确定性写入顺序：先时间/音高结构，再文本，再表达属性。
const FIELD_SPECS = [
  { field: "onsetBlick", getter: "getOnset", setter: "setOnset", kind: "nonNegativeInteger" },
  { field: "durationBlick", getter: "getDuration", setter: "setDuration", kind: "positiveInteger" },
  { field: "pitch", getter: "getPitch", setter: "setPitch", kind: "midiPitch" },
  { field: "lyrics", getter: "getLyrics", setter: "setLyrics", kind: "string" },
  { field: "phonemesOverride", getter: "getPhonemes", setter: "setPhonemes", kind: "string" },
  {
    field: "languageOverride",
    getter: "getLanguageOverride",
    setter: "setLanguageOverride",
    kind: "string",
  },
  { field: "detuneCents", getter: "getDetune", setter: "setDetune", kind: "finiteNumber" },
  { field: "attributes", getter: "getAttributes", setter: "setAttributes", kind: "attributes" },
];
const FIELD_BY_NAME = new Map(FIELD_SPECS.map((spec) => [spec.field, spec]));
const PROCESSING_FIELDS = new Set(["lyrics", "phonemesOverride", "languageOverride"]);
const MAX_PATCHES = 200;

export class NotePatchService {
  constructor(session, snapshotService, { sleepFn, now = () => Date.now() } = {}) {
    this.session = session;
    this.snapshotService = snapshotService;
    this.sleep = sleepFn;
    this.now = now;
  }

  async patchNotes(request) {
    const input = normalizeRequest(request);
    return this.session.withExclusive(async (host) => {
      let resolved;
      let boundaryCalls = 0;
      let writeAttempted = false;
      const appliedDiff = [];
      const warnings = [];
      const startedAt = this.now();
      const atomicity = input.atomic ? "verified_compensation" : "none";
      try {
        const stored = this.snapshotService.getContext(input.contextId, host.epoch());
        resolved = await resolveContextTarget(host, stored, { verify: true });
        const targets = resolveNoteTargets(input, resolved);
        const targetByPosition = new Map(targets.map((target) => [target.position, target]));

        // 写入前读取每个将被 set/expected 触碰的字段当前值：既做冲突检查，也是补偿日志。
        for (const target of targets) {
          target.current = {};
          for (const field of target.touchedFields) {
            target.current[field] = await readField(host, target.note, FIELD_BY_NAME.get(field));
          }
        }

        const expectedMismatches = collectExpectedMismatches(targets);
        if (expectedMismatches.length > 0) {
          return {
            ...failed(
              "EXPECTED_MISMATCH",
              "One or more expected values did not match the current note state.",
              "none"
            ),
            atomicity,
            data: {
              processedNotes: targets.length,
              plannedChangedNotes: 0,
              actuallyChangedNotes: 0,
              mismatches: expectedMismatches,
            },
            rollback: { attempted: false, verified: null },
          };
        }

        const plannedDiff = buildPlannedDiff(targets);
        const plannedChangedNotes = new Set(plannedDiff.map((entry) => entry.noteId)).size;
        if (plannedDiff.some((entry) => entry.field === "onsetBlick")) {
          warnings.push({
            code: "NOTE_ORDER_MAY_CHANGE",
            message:
              "Changing note onsets may reorder notes inside the group; stored indexInGroup values become stale after this write.",
          });
        }

        if (input.dryRun) {
          return {
            ok: true,
            status: "dry_run",
            effects: "none",
            atomicity,
            data: {
              processedNotes: targets.length,
              plannedChangedNotes,
              actuallyChangedNotes: 0,
              plannedDiff,
              appliedDiff: [],
            },
            rollback: { attempted: false, verified: null },
            undo: undoEvidence(0),
            verification: { attempted: false, passed: null },
            warnings,
            timing: { elapsedMs: this.now() - startedAt },
          };
        }

        if (plannedDiff.length === 0) {
          this.snapshotService.store.delete(input.contextId);
          return {
            ok: true,
            status: "no_change",
            effects: "none",
            atomicity,
            data: {
              processedNotes: targets.length,
              plannedChangedNotes: 0,
              actuallyChangedNotes: 0,
              plannedDiff: [],
              appliedDiff: [],
            },
            rollback: { attempted: false, verified: null },
            undo: undoEvidence(0),
            verification: { attempted: true, passed: true, evidence: { observed: {} } },
            warnings,
            timing: { elapsedMs: this.now() - startedAt },
          };
        }

        await host.call({ handle: resolved.roots.project, method: "newUndoRecord", args: [] });
        boundaryCalls += 1;

        let applyError = null;
        try {
          for (const entry of plannedDiff) {
            const spec = FIELD_BY_NAME.get(entry.field);
            const target = targetByPosition.get(entry.position);
            writeAttempted = true;
            await host.call({
              handle: target.note,
              method: spec.setter,
              args: [entry.to],
            });
            appliedDiff.push(entry);
          }
        } catch (error) {
          applyError = error;
        }

        // 读回 getter 本身也可能抛错；该错误必须走与 apply 失败相同的补偿路径，
        // 而不是漏到外层 catch 后既不回滚也不关闭 Undo 边界。
        let verifyError = null;
        let verificationEvidence = null;
        let verificationPassed = null;
        if (!applyError) {
          try {
            const verified = await this._verifyReadBack(host, targetByPosition, plannedDiff);
            verificationEvidence = verified.evidence;
            verificationPassed = verified.passed;
          } catch (error) {
            verifyError = error;
          }
        }

        if (applyError || verifyError || verificationPassed === false) {
          const causeError = applyError ?? verifyError;
          const failure = causeError
            ? {
                code: causeError?.code ?? "HOST_CALL_FAILED",
                message: causeError instanceof Error ? causeError.message : String(causeError),
              }
            : {
                code: "POSTCONDITION_FAILED",
                message: "One or more values did not match after write-back verification.",
              };
          if (causeError && isUnknownOutcomeError(causeError)) {
            // 宿主超时/断开后连已写入多少都不可知；此时补偿写入只会更不可信。
            await this._closeUndoBoundary(host, resolved, warnings, () => (boundaryCalls += 1));
            return {
              ...failed(failure.code, failure.message, "unknown"),
              status: "outcome_unknown",
              atomicity,
              data: patchResultData(targets, plannedDiff, appliedDiff),
              rollback: { attempted: false, verified: null },
              undo: undoEvidence(boundaryCalls),
              warnings,
              timing: { elapsedMs: this.now() - startedAt },
            };
          }
          if (!input.atomic) {
            await this._closeUndoBoundary(host, resolved, warnings, () => (boundaryCalls += 1));
            return {
              ...failed(failure.code, failure.message, "may_remain"),
              status: "partial",
              atomicity,
              data: patchResultData(targets, plannedDiff, appliedDiff),
              rollback: { attempted: false, verified: null },
              undo: undoEvidence(boundaryCalls),
              ...(verificationEvidence
                ? {
                    verification: {
                      attempted: true,
                      passed: false,
                      evidence: verificationEvidence,
                    },
                  }
                : {}),
              warnings,
              timing: { elapsedMs: this.now() - startedAt },
            };
          }
          const rollback = await this._rollback(host, targetByPosition, appliedDiff);
          await this._closeUndoBoundary(host, resolved, warnings, () => (boundaryCalls += 1));
          return {
            ...failed(
              failure.code,
              failure.message,
              rollback.verified ? "reverted" : rollback.outcomeUnknown ? "unknown" : "may_remain"
            ),
            status: rollback.verified ? "rolled_back" : "rollback_failed",
            atomicity,
            data: patchResultData(targets, plannedDiff, appliedDiff),
            rollback: {
              attempted: true,
              verified: rollback.verified,
              ...(rollback.error ? { error: rollback.error } : {}),
              ...(rollback.evidence ? { evidence: rollback.evidence } : {}),
            },
            undo: undoEvidence(boundaryCalls),
            ...(verificationEvidence
              ? {
                  verification: { attempted: true, passed: false, evidence: verificationEvidence },
                }
              : {}),
            warnings,
            timing: { elapsedMs: this.now() - startedAt },
          };
        }

        await this._closeUndoBoundary(host, resolved, warnings, () => (boundaryCalls += 1));

        let processing = null;
        // phonemes 关注文本字段；computedAttributes 还会因 attributes/pitch/detune 变化而重算。
        const processingFields =
          input.waitFor === "computedAttributes"
            ? new Set([...PROCESSING_FIELDS, "attributes", "pitch", "detuneCents"])
            : PROCESSING_FIELDS;
        const touchesProcessing = plannedDiff.some((entry) => processingFields.has(entry.field));
        if (input.waitFor !== "none" && touchesProcessing) {
          processing = await waitForProcessing(host, {
            roots: resolved.roots,
            group: resolved.group,
            kind: input.waitFor,
            expectedNotes: contextGroupNoteCount(stored, resolved.notes.length),
            timeoutMs: input.timeoutMs,
            pollIntervalMs: input.pollIntervalMs,
            sleepFn: this.sleep,
            now: this.now,
          });
          warnings.push(...processing.warnings);
        }
        this.snapshotService.store.delete(input.contextId);

        return {
          ok: true,
          status: processing?.status ?? "succeeded",
          effects: "verified",
          atomicity,
          data: {
            ...patchResultData(targets, plannedDiff, appliedDiff),
            ...(processing
              ? {
                  processing: {
                    state: processing.data.state,
                    attempts: processing.data.attempts,
                    elapsedMs: processing.data.elapsedMs,
                    evidence: processing.data.evidence,
                  },
                }
              : {}),
          },
          rollback: { attempted: false, verified: null },
          undo: undoEvidence(boundaryCalls),
          verification: { attempted: true, passed: true, evidence: verificationEvidence },
          warnings,
          timing: { elapsedMs: this.now() - startedAt },
        };
      } catch (error) {
        const unknown = isUnknownOutcomeError(error);
        const effects = writeAttempted ? (unknown ? "unknown" : "may_remain") : "none";
        // 已开启但未关闭的 Undo 边界尽力关闭，失败只记警告。
        if (boundaryCalls === 1 && !unknown && resolved) {
          await this._closeUndoBoundary(host, resolved, warnings, () => (boundaryCalls += 1));
        }
        return {
          ...failed(
            typeof error?.code === "string" ? error.code : "HOST_CALL_FAILED",
            error instanceof Error ? error.message : String(error),
            effects
          ),
          status: writeAttempted ? (unknown ? "outcome_unknown" : "partial") : "failed",
          atomicity,
          data: {
            processedNotes: resolved?.notes.length ?? 0,
            plannedChangedNotes: null,
            actuallyChangedNotes: new Set(appliedDiff.map((entry) => entry.noteId)).size,
          },
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

  async _verifyReadBack(host, targetByPosition, plannedDiff) {
    const observed = {};
    let passed = true;
    for (const entry of plannedDiff) {
      const target = targetByPosition.get(entry.position);
      const spec = FIELD_BY_NAME.get(entry.field);
      const value = await readField(host, target.note, spec);
      observed[entry.noteId] = observed[entry.noteId] ?? {};
      observed[entry.noteId][entry.field] = value;
      if (!fieldMatches(spec, entry.to, value)) passed = false;
    }
    return { passed, evidence: { observed } };
  }

  // 补偿回滚只恢复已确认写出的字段，逆序执行并逐项读回确认。
  // 单个补偿写失败不终止其余补偿；宿主超时/断开才放弃（继续写只会更不可信）。
  async _rollback(host, targetByPosition, appliedDiff) {
    const evidence = { restored: {} };
    const errors = [];
    for (const entry of [...appliedDiff].reverse()) {
      const spec = FIELD_BY_NAME.get(entry.field);
      try {
        await host.call({
          handle: targetByPosition.get(entry.position).note,
          method: spec.setter,
          args: [entry.from],
        });
      } catch (error) {
        if (isUnknownOutcomeError(error)) {
          return {
            verified: false,
            evidence,
            outcomeUnknown: true,
            error: {
              code: typeof error?.code === "string" ? error.code : "ROLLBACK_FAILED",
              message: error instanceof Error ? error.message : String(error),
            },
          };
        }
        errors.push({
          noteId: entry.noteId,
          field: entry.field,
          code: typeof error?.code === "string" ? error.code : "ROLLBACK_FAILED",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    let verified = errors.length === 0;
    try {
      for (const entry of appliedDiff) {
        const spec = FIELD_BY_NAME.get(entry.field);
        const value = await readField(host, targetByPosition.get(entry.position).note, spec);
        evidence.restored[entry.noteId] = evidence.restored[entry.noteId] ?? {};
        evidence.restored[entry.noteId][entry.field] = value;
        if (!fieldMatches(spec, entry.from, value)) verified = false;
      }
    } catch (error) {
      verified = false;
      errors.push({
        code: typeof error?.code === "string" ? error.code : "ROLLBACK_VERIFY_FAILED",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return {
      verified,
      evidence,
      outcomeUnknown: false,
      ...(errors.length > 0 ? { error: errors[0], errors } : {}),
    };
  }

  async _closeUndoBoundary(host, resolved, warnings, onSuccess) {
    try {
      await host.call({ handle: resolved.roots.project, method: "newUndoRecord", args: [] });
      onSuccess();
    } catch (error) {
      warnings.push({
        code: "UNDO_BOUNDARY_CLOSE_FAILED",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function readField(host, note, spec) {
  return host.call({
    handle: note,
    method: spec.getter,
    args: [],
    ...(spec.kind === "attributes" ? { resultFormat: "typed-v2" } : {}),
  });
}

function resolveNoteTargets(input, resolved) {
  const seen = new Set();
  const targets = [];
  for (const patch of input.patches) {
    const position = parseNoteId(patch.noteId, input.contextId, resolved.notes.length);
    if (seen.has(position)) {
      throw codedError("DUPLICATE_NOTE_ID", `noteId appears more than once: ${patch.noteId}`);
    }
    seen.add(position);
    const touchedFields = new Set([
      ...Object.keys(patch.set),
      ...Object.keys(patch.expected ?? {}),
    ]);
    targets.push({
      noteId: patch.noteId,
      position,
      note: resolved.notes[position],
      indexInGroup: resolved.fingerprints[position].indexInGroup,
      set: patch.set,
      expected: patch.expected ?? {},
      touchedFields,
    });
  }
  // 目标按上下文位置升序排列，保证写入顺序确定。
  targets.sort((a, b) => a.position - b.position);
  targets.forEach((target, index) => (target.order = index));
  return targets;
}

function parseNoteId(noteId, contextId, noteCount) {
  const prefix = `${contextId}:n:`;
  if (!noteId.startsWith(prefix)) {
    throw codedError(
      "INVALID_NOTE_ID",
      `noteId must be of the form ${prefix}<index> from the same snapshot context`
    );
  }
  const suffix = noteId.slice(prefix.length);
  const position = Number(suffix);
  if (!/^\d+$/.test(suffix) || !Number.isSafeInteger(position)) {
    throw codedError("INVALID_NOTE_ID", `noteId index is not a non-negative integer: ${noteId}`);
  }
  if (position >= noteCount) {
    throw codedError(
      "NOTE_INDEX_OUT_OF_RANGE",
      `noteId ${noteId} refers to position ${position}, but the context has ${noteCount} note(s)`
    );
  }
  return position;
}

function collectExpectedMismatches(targets) {
  const mismatches = [];
  for (const target of targets) {
    for (const [field, expectedValue] of Object.entries(target.expected)) {
      const spec = FIELD_BY_NAME.get(field);
      const current = target.current[field];
      const matches =
        spec.kind === "attributes"
          ? attributeKeysMatch(expectedValue, current)
          : jsonValueEquals(current, expectedValue);
      if (!matches) {
        mismatches.push({ noteId: target.noteId, field, expected: expectedValue, observed: current });
      }
    }
  }
  return mismatches;
}

function buildPlannedDiff(targets) {
  const diff = [];
  for (const spec of FIELD_SPECS) {
    for (const target of targets) {
      if (!Object.hasOwn(target.set, spec.field)) continue;
      const from = target.current[spec.field];
      const to = target.set[spec.field];
      if (fieldMatches(spec, to, from)) continue;
      diff.push({
        noteId: target.noteId,
        position: target.position,
        indexInGroup: target.indexInGroup,
        field: spec.field,
        from,
        to,
      });
    }
  }
  // 按 (note 位置, 字段表顺序) 排序，得到确定性的逐音符写入序列。
  const fieldOrder = new Map(FIELD_SPECS.map((spec, index) => [spec.field, index]));
  diff.sort(
    (a, b) => a.position - b.position || fieldOrder.get(a.field) - fieldOrder.get(b.field)
  );
  return diff;
}

function fieldMatches(spec, requested, observed) {
  if (spec.kind !== "attributes") return jsonValueEquals(observed, requested);
  return attributeKeysMatch(requested, observed);
}

// attributes 是部分写：只要求请求过的 key 与观测值一致，其余 key 不参与比较。
function attributeKeysMatch(requested, observed) {
  if (!isRecord(requested)) return false;
  if (!isRecord(observed)) return false;
  return Object.entries(requested).every(([key, value]) => jsonValueEquals(observed[key], value));
}

// 管道解码出的嵌套对象是 null-prototype；比较必须按 JSON 值结构进行，
// 不能用 isDeepStrictEqual（它区分 prototype，会把合法读回判为不等）。
function jsonValueEquals(a, b) {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") {
    return Number.isNaN(a) && Number.isNaN(b);
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => jsonValueEquals(item, b[index]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every((key) => Object.hasOwn(b, key) && jsonValueEquals(a[key], b[key]));
  }
  return false;
}

function patchResultData(targets, plannedDiff, appliedDiff) {
  return {
    processedNotes: targets.length,
    plannedChangedNotes: new Set(plannedDiff.map((entry) => entry.noteId)).size,
    actuallyChangedNotes: new Set(appliedDiff.map((entry) => entry.noteId)).size,
    plannedDiff,
    appliedDiff,
  };
}

function normalizeRequest(request) {
  if (!isRecord(request)) throw codedError("INVALID_ARGUMENTS", "request must be an object");
  if (typeof request.contextId !== "string" || !request.contextId) {
    throw codedError("INVALID_ARGUMENTS", "contextId is required; take it from sv_snapshot");
  }
  if (!Array.isArray(request.patches) || request.patches.length === 0) {
    throw codedError("INVALID_ARGUMENTS", "patches must be a non-empty array");
  }
  if (request.patches.length > MAX_PATCHES) {
    throw codedError("INVALID_ARGUMENTS", `patches must contain at most ${MAX_PATCHES} items`);
  }
  const patches = request.patches.map((patch, index) => {
    if (!isRecord(patch)) throw codedError("INVALID_ARGUMENTS", `patches[${index}] must be an object`);
    if (typeof patch.noteId !== "string" || !patch.noteId) {
      throw codedError("INVALID_ARGUMENTS", `patches[${index}].noteId must be a string`);
    }
    if (!isRecord(patch.set) || Object.keys(patch.set).length === 0) {
      throw codedError("INVALID_ARGUMENTS", `patches[${index}].set must set at least one field`);
    }
    validateFieldObject(patch.set, `patches[${index}].set`, true);
    if (patch.expected !== undefined) {
      if (!isRecord(patch.expected)) {
        throw codedError("INVALID_ARGUMENTS", `patches[${index}].expected must be an object`);
      }
      validateFieldObject(patch.expected, `patches[${index}].expected`, false);
    }
    return { noteId: patch.noteId, set: patch.set, expected: patch.expected };
  });
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
  return {
    contextId: request.contextId,
    patches,
    dryRun: request.dryRun === true,
    atomic: request.atomic !== false,
    waitFor,
    timeoutMs: clampInteger(request.timeoutMs, 0, 30_000, 10_000),
    pollIntervalMs: clampInteger(request.pollIntervalMs, 20, 2_000, 100),
  };
}

function validateFieldObject(record, label, validateValues) {
  for (const [field, value] of Object.entries(record)) {
    const spec = FIELD_BY_NAME.get(field);
    if (!spec) {
      throw codedError(
        "UNKNOWN_FIELD",
        `${label}.${field} is not a patchable note field; supported: ${[...FIELD_BY_NAME.keys()].join(", ")}`
      );
    }
    if (validateValues) validateFieldValue(spec, value, `${label}.${field}`);
  }
}

function validateFieldValue(spec, value, label) {
  switch (spec.kind) {
    case "string":
      if (typeof value !== "string") throw codedError("INVALID_ARGUMENTS", `${label} must be a string`);
      return;
    case "nonNegativeInteger":
      if (!Number.isSafeInteger(value) || value < 0) {
        throw codedError("INVALID_ARGUMENTS", `${label} must be a non-negative integer (blick)`);
      }
      return;
    case "positiveInteger":
      if (!Number.isSafeInteger(value) || value < 1) {
        throw codedError("INVALID_ARGUMENTS", `${label} must be a positive integer (blick)`);
      }
      return;
    case "midiPitch":
      if (!Number.isSafeInteger(value) || value < 0 || value > 127) {
        throw codedError("INVALID_ARGUMENTS", `${label} must be an integer MIDI pitch 0-127`);
      }
      return;
    case "finiteNumber":
      if (!Number.isFinite(value)) {
        throw codedError("INVALID_ARGUMENTS", `${label} must be a finite number (cents)`);
      }
      return;
    case "attributes":
      if (!isRecord(value) || Object.keys(value).length === 0) {
        throw codedError("INVALID_ARGUMENTS", `${label} must be a non-empty plain object`);
      }
      return;
    default:
      throw codedError("INVALID_ARGUMENTS", `${label} has an unsupported field kind`);
  }
}

function failed(code, message, effects) {
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
