import {
  appendSharedTargetDryRunWarnings,
  ensureSharedTargetConfirmed,
  resolveContextTarget,
} from "./context-target.js";
import { settlePlanLedger } from "./plan-reference.js";
import { createOperationDiagnostics } from "./operation-diagnostics.js";
import { waitForProcessing } from "./processing.js";
import { dryRunFromAction } from "./mutation-action.js";

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
export const MAX_PATCHES = 200;

export class NotePatchService {
  constructor(
    session,
    snapshotService,
    { sleepFn, now = () => Date.now(), artifactStore = null, sessionId = null } = {}
  ) {
    this.session = session;
    this.snapshotService = snapshotService;
    this.sleep = sleepFn;
    this.now = now;
    this.artifactStore = artifactStore;
    this.sessionId = sessionId;
  }

  async patchNotes(request) {
    const diagnostics = createOperationDiagnostics({
      enabled: request?.diagnostics === true,
      now: this.now,
    });
    let resolvedRequest = request;
    let ledgerRef = null;
    let planScopeSource = null;
    // 如果请求携带 planRef，先从 artifact 展开为规范 mutation 请求。
    if (request?.planRef && this.artifactStore && this.sessionId) {
      const { resolvePlanReference } = await import("./plan-reference.js");
      const resolved = resolvePlanReference({
        planRef: request.planRef,
        action: request.action,
        confirmations: request.confirmations,
        executionOptions: request.executionOptions,
        expectedTargetTool: "sv_patch_notes",
        sessionId: this.sessionId,
        artifactStore: this.artifactStore,
        planLedger: this.artifactStore.planLedger ?? null,
      });
      resolvedRequest = resolved.mutationRequest;
      ledgerRef = resolved.ledgerRef;
      planScopeSource = resolved.scopeSource;
    }
    if (diagnostics && resolvedRequest !== request) {
      resolvedRequest = { ...resolvedRequest, diagnostics: true };
    }
    const input = normalizeRequest(resolvedRequest);
    diagnostics?.markValidationComplete();
    diagnostics?.markCoordinatorRequested();
    const result = await this.session.withExclusive(async (hostLease) => {
      diagnostics?.markCoordinatorAcquired();
      const host = diagnostics ? diagnostics.instrumentHost(hostLease) : hostLease;
      let resolved;
      let boundaryCalls = 0;
      let writeAttempted = false;
      const appliedDiff = [];
      const warnings = [];
      const startedAt = this.now();
      const atomicity = input.atomic ? "verified_compensation" : "none";
      try {
        const source = diagnostics
          ? diagnostics.measureSync("contextRestoreMs", () =>
              planScopeSource ?? {
                kind: "snapshot",
                stored: this.snapshotService.getContext(input.contextId, host.epoch()),
              }
            )
          : planScopeSource ?? {
              kind: "snapshot",
              stored: this.snapshotService.getContext(input.contextId, host.epoch()),
            };
        resolved = await resolveContextTarget(host, source, {
          verify: true,
          acceptRange: true,
          // index 身份不含 occurrence 前缀，因此不能从引用里推导 occurrence。
          // 单 occurrence 自动选择与 AMBIGUOUS_CONTEXT 由 resolveContextTarget 负责。
          occurrence: input.occurrence,
          noteIndicesInGroup: input.patches.map((patch) => patch.note),
          diagnostics,
        });
        const targets = resolveNoteTargets(input, resolved);
        const targetByPosition = new Map(targets.map((target) => [target.position, target]));

        // 写入前读取每个将被 set/expected 触碰的字段当前值：既做冲突检查，也是补偿日志。
        const readPreflight = async () => {
          for (const target of targets) {
            target.current = {};
            for (const field of target.touchedFields) {
              // 指纹刚在同一 host lease 中完成 live 校验；attributes 不在指纹中，仍需单独读取。
              target.current[field] =
                field === "attributes"
                  ? await readField(host, target.note, FIELD_BY_NAME.get(field))
                  : target.fingerprint[field];
            }
          }
        };
        if (diagnostics) {
          await diagnostics.measure("preflightReadMs", readPreflight);
        } else {
          await readPreflight();
        }

        let expectedMismatches;
        let plannedDiff;
        if (diagnostics) {
          diagnostics.measureSync("planningMs", () => {
            expectedMismatches = collectExpectedMismatches(targets);
            plannedDiff = expectedMismatches.length === 0 ? buildPlannedDiff(targets) : [];
          });
        } else {
          expectedMismatches = collectExpectedMismatches(targets);
          plannedDiff = expectedMismatches.length === 0 ? buildPlannedDiff(targets) : [];
        }
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
              attemptedChangedNotes: 0,
              remainingChangedNotes: 0,
              actuallyChangedNotes: 0,
              mismatches: expectedMismatches,
            },
            rollback: { attempted: false, verified: null },
          };
        }

        const plannedChangedNotes = new Set(plannedDiff.map((entry) => entry.indexInGroup)).size;
        if (plannedDiff.some((entry) => entry.field === "onsetBlick")) {
          warnings.push({
            code: "NOTE_ORDER_MAY_CHANGE",
            message:
              "Changing note onsets may reorder notes inside the group; stored indexInGroup values become stale after this write.",
          });
        }

        if (input.dryRun) {
          appendSharedTargetDryRunWarnings(resolved, input, warnings);
          return {
            ok: true,
            status: "dry_run",
            effects: "none",
            atomicity,
            data: {
              processedNotes: targets.length,
              plannedChangedNotes,
              attemptedChangedNotes: 0,
              remainingChangedNotes: 0,
              actuallyChangedNotes: 0,
              plannedDiff: publicDiff(plannedDiff),
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
          // no_change 没有写入，context 仍然准确；保留它让调用方免于无谓的重新快照
          // （与 dry_run/EXPECTED_MISMATCH 路径一致）。
          return {
            ok: true,
            status: "no_change",
            effects: "none",
            atomicity,
            data: {
              processedNotes: targets.length,
              plannedChangedNotes: 0,
              attemptedChangedNotes: 0,
              remainingChangedNotes: 0,
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

        await ensureSharedTargetConfirmed(resolved, input);

        await host.call({ handle: resolved.roots.project, method: "newUndoRecord", args: [] });
        boundaryCalls += 1;

        let applyError = null;
        try {
          const applyWrites = async () => {
            for (const entry of plannedDiff) {
              const spec = FIELD_BY_NAME.get(entry.field);
              const target = targetByPosition.get(entry.targetPosition);
              writeAttempted = true;
              await host.call({
                handle: target.note,
                method: spec.setter,
                args: [entry.writeValue],
              });
              appliedDiff.push(entry);
            }
          };
          if (diagnostics) {
            await diagnostics.measure("writeMs", applyWrites);
          } else {
            await applyWrites();
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
            const verified = diagnostics
              ? await diagnostics.measure("verificationMs", () =>
                  this._verifyReadBack(host, targetByPosition, plannedDiff)
                )
              : await this._verifyReadBack(host, targetByPosition, plannedDiff);
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
              data: patchResultData(targets, plannedDiff, appliedDiff, null),
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
          const rollback = diagnostics
            ? await diagnostics.measure("rollbackMs", () =>
                this._rollback(host, targetByPosition, appliedDiff)
              )
            : await this._rollback(host, targetByPosition, appliedDiff);
          await this._closeUndoBoundary(host, resolved, warnings, () => (boundaryCalls += 1));
          return {
            ...failed(
              failure.code,
              failure.message,
              rollback.verified ? "reverted" : rollback.outcomeUnknown ? "unknown" : "may_remain"
            ),
            status: rollback.verified ? "rolled_back" : "rollback_failed",
            atomicity,
            data: patchResultData(
              targets,
              plannedDiff,
              appliedDiff,
              rollback.outcomeUnknown ? null : (rollback.unrestoredNoteIndexes?.length ?? 0)
            ),
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
          // 提交与逐字段读回已完成、Undo 边界已关闭；处理观测只是后续附加信息。
          // 观测失败绝不能把已验证成功的写入降级为 outcome_unknown/partial（对齐 phrase-edit）。
          try {
            const observeProcessing = () =>
              waitForProcessing(host, {
                roots: resolved.roots,
                group: resolved.group,
                kind: input.waitFor,
                expectedNotes:
                  resolved.groupNoteCount ?? resolved.targetNoteCount ?? resolved.notes.length,
                timeoutMs: input.timeoutMs,
                pollIntervalMs: input.pollIntervalMs,
                sleepFn: this.sleep,
                now: this.now,
              });
            processing = diagnostics
              ? await diagnostics.measure("processingMs", observeProcessing)
              : await observeProcessing();
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
            ...patchResultData(targets, plannedDiff, appliedDiff),
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
          verification: { attempted: true, passed: true, evidence: verificationEvidence },
          warnings,
          timing: { elapsedMs: this.now() - startedAt },
        };
      } catch (error) {
        const unknown = isUnknownOutcomeError(error);
        const effects = writeAttempted ? (unknown ? "unknown" : "may_remain") : "none";
        const attemptedChangedNotes = new Set(appliedDiff.map((entry) => entry.indexInGroup)).size;
        const remainingChangedNotes = writeAttempted
          ? unknown
            ? null
            : attemptedChangedNotes
          : 0;
        // 已开启但未关闭的 Undo 边界尽力关闭，失败只记警告。
        if (boundaryCalls === 1 && !unknown && resolved) {
          await this._closeUndoBoundary(host, resolved, warnings, () => (boundaryCalls += 1));
        }
        return {
          ...failed(
            typeof error?.code === "string" ? error.code : "HOST_CALL_FAILED",
            error instanceof Error ? error.message : String(error),
            effects,
            error?.details
          ),
          status: writeAttempted ? (unknown ? "outcome_unknown" : "partial") : "failed",
          atomicity,
          data: {
            processedNotes: resolved?.notes.length ?? 0,
            plannedChangedNotes: null,
            attemptedChangedNotes,
            remainingChangedNotes,
            actuallyChangedNotes: remainingChangedNotes,
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
    settlePlanLedger(this.artifactStore?.planLedger ?? null, ledgerRef, result);
    return diagnostics ? { ...result, diagnostics: diagnostics.finish() } : result;
  }

  async _verifyReadBack(host, targetByPosition, plannedDiff) {
    const observed = {};
    let passed = true;
    for (const entry of plannedDiff) {
      const target = targetByPosition.get(entry.targetPosition);
      const spec = FIELD_BY_NAME.get(entry.field);
      const value = await readField(host, target.note, spec);
      observed[entry.indexInGroup] = observed[entry.indexInGroup] ?? {};
      observed[entry.indexInGroup][entry.field] = value;
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
          handle: targetByPosition.get(entry.targetPosition).note,
          method: spec.setter,
          args: [entry.rollbackValue],
        });
      } catch (error) {
        if (isUnknownOutcomeError(error)) {
          return {
            verified: false,
            evidence,
            outcomeUnknown: true,
            unrestoredNoteIndexes: [...new Set(appliedDiff.map((entry) => entry.indexInGroup))],
            error: {
              code: typeof error?.code === "string" ? error.code : "ROLLBACK_FAILED",
              message: error instanceof Error ? error.message : String(error),
            },
          };
        }
        errors.push({
          note: entry.indexInGroup,
          field: entry.field,
          code: typeof error?.code === "string" ? error.code : "ROLLBACK_FAILED",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    let verified = errors.length === 0;
    const unrestoredNoteIndexes = new Set(
      errors.filter((entry) => entry.note !== undefined).map((entry) => entry.note)
    );
    try {
      for (const entry of appliedDiff) {
        const spec = FIELD_BY_NAME.get(entry.field);
        const value = await readField(host, targetByPosition.get(entry.targetPosition).note, spec);
        evidence.restored[entry.indexInGroup] = evidence.restored[entry.indexInGroup] ?? {};
        evidence.restored[entry.indexInGroup][entry.field] = value;
        // 回滚后比较完整旧值；官方部分更新无法删除新增 key，此时如实报告未恢复。
        const restoredMatches =
          spec.kind === "attributes"
            ? jsonValueCloseEnough(value, entry.from)
            : fieldMatches(spec, entry.from, value);
        if (!restoredMatches) {
          verified = false;
          unrestoredNoteIndexes.add(entry.indexInGroup);
        }
      }
    } catch (error) {
      verified = false;
      for (const entry of appliedDiff) unrestoredNoteIndexes.add(entry.indexInGroup);
      errors.push({
        code: typeof error?.code === "string" ? error.code : "ROLLBACK_VERIFY_FAILED",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return {
      verified,
      evidence,
      outcomeUnknown: false,
      unrestoredNoteIndexes: [...unrestoredNoteIndexes],
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
  const value = await host.call({
    handle: note,
    method: spec.getter,
    args: [],
    ...(spec.kind === "attributes" ? { resultFormat: "typed-v2" } : {}),
  });
  return spec.kind === "attributes" ? normalizeAttributes(value) : value;
}

function resolveNoteTargets(input, resolved) {
  const seen = new Set();
  const targets = [];
  for (const patch of input.patches) {
    const { position, outputPosition } = resolvePatchReference(patch, input, resolved);
    if (seen.has(position)) {
      throw codedError(
        "DUPLICATE_NOTE_INDEX",
        `the same note appears more than once: ${patch.note}`
      );
    }
    seen.add(position);
    const touchedFields = new Set([
      ...Object.keys(patch.set),
      ...Object.keys(patch.expected ?? {}),
    ]);
    targets.push({
      position,
      outputPosition,
      note: resolved.notes[position],
      fingerprint: resolved.fingerprints[position],
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

// 组内 index → 上下文位置。三种上下文都用同一条路径：指纹数组里找 indexInGroup。
//
// 越界与"合法但未捕获"必须分开（§3.2 规则 5）：越界靠重试永远不会成功，未捕获则
// 需要重新捕获更宽的范围——合并成一个码会让模型分不清该怎么办。
function resolvePatchReference(patch, input, resolved) {
  const position = resolved.fingerprints.findIndex(
    (fingerprint) => fingerprint.indexInGroup === patch.note
  );
  if (position < 0) {
    const groupNoteCount =
      resolved.occurrence?.groupNoteCount ?? resolved.fingerprints.length;
    if (patch.note >= groupNoteCount) {
      throw codedError(
        "NOTE_INDEX_OUT_OF_RANGE",
        `note index ${patch.note} is outside the note group`,
        { got: patch.note, max: groupNoteCount - 1 }
      );
    }
    throw codedError(
      "NOTE_NOT_IN_CONTEXT",
      `note ${patch.note} exists but was not captured in this context`,
      { got: patch.note }
    );
  }
  return {
    position,
    outputPosition:
      resolved.contextKind === "range"
        ? resolved.contextPositionByIndexInGroup.get(patch.note)
        : position,
  };
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
          : spec.kind === "finiteNumber"
            ? numbersClose(current, expectedValue)
            : jsonValueEquals(current, expectedValue);
      if (!matches) {
        mismatches.push({
          note: target.indexInGroup,
          field,
          expected: expectedValue,
          observed: current,
        });
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
      // 官方 setAttributes 是部分更新；只把请求字段送回宿主，避免把 typed-v2 的
      // NaN/Inf 信封或空 table 形状标记误当作 Note 属性写入。
      const writeValue = target.set[spec.field];
      const to =
        spec.kind === "attributes"
          ? { ...from, ...writeValue }
          : target.set[spec.field];
      if (fieldMatches(spec, to, from)) continue;
      diff.push({
        targetPosition: target.position,
        position: target.outputPosition,
        indexInGroup: target.indexInGroup,
        field: spec.field,
        from,
        to,
        writeValue,
        rollbackValue:
          spec.kind === "attributes"
            ? pickAttributeValues(from, Object.keys(writeValue))
            : from,
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
  // 写入的 attributes 已是全量合并对象，读回按完整对象比较（含浮点容差）。
  if (spec.kind === "attributes") return jsonValueCloseEnough(observed, requested);
  // 宿主可能以 float32 存储 detune 等浮点字段，读回带量化误差；精确比较会误触发回滚。
  if (spec.kind === "finiteNumber") return numbersClose(observed, requested);
  return jsonValueEquals(observed, requested);
}

// attributes 的 expected 仍是部分匹配：只要求请求过的 key 与观测值一致。
function attributeKeysMatch(requested, observed) {
  if (!isRecord(requested)) return false;
  if (!isRecord(observed)) return false;
  return Object.entries(requested).every(([key, value]) =>
    jsonValueCloseEnough(observed[key], value)
  );
}

// 浮点相对容差比较：覆盖 float32 量化（相对误差 ~1.2e-7 < 1e-6）。
// 只用于浮点字段；blick/pitch 等整数结构字段必须精确比较。
function numbersClose(a, b) {
  if (a === b) return true;
  if (typeof a !== "number" || typeof b !== "number") return false;
  if (Number.isNaN(a) && Number.isNaN(b)) return true;
  return Math.abs(a - b) <= Math.max(1e-6, Math.abs(b) * 1e-6);
}

function jsonValueCloseEnough(a, b) {
  if (typeof a === "number" || typeof b === "number") return numbersClose(a, b);
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => jsonValueCloseEnough(item, b[index]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every((key) => Object.hasOwn(b, key) && jsonValueCloseEnough(a[key], b[key]));
  }
  return false;
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

// attemptedChangedNotes 是"曾写过"的音符数；remainingChangedNotes 是最终仍偏离原值的数量
// （成功 = attempted；已验证回滚 = 0；结果不可知 = null）。actuallyChangedNotes 与后者同义。
function patchResultData(targets, plannedDiff, appliedDiff, remainingChangedNotes) {
  const attempted = new Set(appliedDiff.map((entry) => entry.indexInGroup)).size;
  const remaining = remainingChangedNotes === undefined ? attempted : remainingChangedNotes;
  return {
    processedNotes: targets.length,
    plannedChangedNotes: new Set(plannedDiff.map((entry) => entry.indexInGroup)).size,
    attemptedChangedNotes: attempted,
    remainingChangedNotes: remaining,
    actuallyChangedNotes: remaining,
    plannedDiff: publicDiff(plannedDiff),
    appliedDiff: publicDiff(appliedDiff),
  };
}

function publicDiff(diff) {
  return diff.map(
    ({
      writeValue: _writeValue,
      rollbackValue: _rollbackValue,
      targetPosition: _targetPosition,
      ...entry
    }) => entry
  );
}

function pickAttributeValues(source, keys) {
  const selected = {};
  for (const key of keys) {
    if (Object.hasOwn(source, key)) selected[key] = source[key];
  }
  return selected;
}

function normalizeAttributes(value) {
  if (
    isRecord(value) &&
    value.$sv === "table" &&
    value.shape === "unknown" &&
    Array.isArray(value.entries) &&
    value.entries.length === 0
  ) {
    return {};
  }
  return isRecord(value) ? value : {};
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
    // 身份只有一种写法：组内 index（§3.1）。三种上下文（range/group/selection）的
    // 指纹都带 indexInGroup，且 selection/group 都锁定单个 group，因此 index 在
    // 每种上下文内都唯一。
    if (!Number.isSafeInteger(patch.note) || patch.note < 0) {
      throw codedError(
        "INVALID_ARGUMENTS",
        `patches[${index}].note must be a non-negative note index in the group`
      );
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
    return {
      note: patch.note,
      set: patch.set,
      expected: patch.expected,
    };
  });
  const waitFor = request.waitFor ?? "phonemes";
  if (!["none", "phonemes", "computedAttributes"].includes(waitFor)) {
    throw codedError("INVALID_ARGUMENTS", "waitFor must be none, phonemes, or computedAttributes");
  }
  if (request.atomic !== undefined && typeof request.atomic !== "boolean") {
    throw codedError("INVALID_ARGUMENTS", "atomic must be a boolean");
  }
  if (request.diagnostics !== undefined && typeof request.diagnostics !== "boolean") {
    throw codedError("INVALID_ARGUMENTS", "diagnostics must be a boolean");
  }
  if (
    request.occurrence !== undefined &&
    (!Number.isSafeInteger(request.occurrence) || request.occurrence < 0)
  ) {
    throw codedError(
      "INVALID_ARGUMENTS",
      "occurrence must be a non-negative occurrence ordinal when provided"
    );
  }
  if (
    request.allowSharedTargetMutation !== undefined &&
    typeof request.allowSharedTargetMutation !== "boolean"
  ) {
    throw codedError("INVALID_ARGUMENTS", "allowSharedTargetMutation must be a boolean");
  }
  return {
    contextId: request.contextId,
    patches,
    occurrence: request.occurrence,
    allowSharedTargetMutation: request.allowSharedTargetMutation === true,
    dryRun: dryRunFromAction(request.action),
    atomic: request.atomic !== false,
    diagnostics: request.diagnostics === true,
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

function failed(code, message, effects, details) {
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
