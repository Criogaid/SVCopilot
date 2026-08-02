import { scanTargetOccurrences } from "./parameter-curve.js";
import {
  OWNERSHIP,
  PITCH_CONTROL_LIMITS,
  PITCH_CONTROL_SCHEMA_VERSION,
  codedError,
  computeControlFingerprint,
  computeGroupFingerprint,
  extractOwnedValues,
  isRecord,
  normalizeCurvePoints,
  parseContextControlId,
  pitchEquals,
} from "./pitch-control.js";
import { nestedProcessingStatus, waitForProcessing } from "./processing.js";
import { resolvePlanReference, settlePlanLedger } from "./plan-reference.js";
import { resolveMutationScope } from "./scope-source.js";
import { ServiceTiming } from "./service-timing.js";
import { createHostScope } from "./snapshot.js";
import { dryRunFromAction } from "./mutation-action.js";

// sv_patch_pitch_controls —— PitchControl 的原子事务写面（主计划 P1-C）。
//
// 事务诚实性契约（与 sv_restructure_notes / sv_patch_parameter_curves 一致，绝不放宽）：
//   - dry-run / no-change 不调用任何宿主写 API、不创建 Undo。
//   - 正式提交最多一个用户可见 Undo（开边界 + 关边界 = 2 次 newUndoRecord）。
//   - 第一次宿主写之前建立完整 journal：每个将被改/删的对象都 clone + 抓取完整 scriptData
//     （含外部脚本值——必须保留，绝不调 clearScriptData）。
//   - 每一步写入后都以宿主读回为准，不信任 setter/remove 的返回值。
//   - 失败时逆序补偿并再次读回；无法证明恢复就诚实报 rollback_failed / outcome_unknown。
//   - 已验证成功的提交，后续 processing 观测失败只降级为 warning，绝不重分类为可重试失败。
//
// PitchControl 特有约束：
//   - 官方不发 UUID，身份 = fingerprint（内容 + SVCopilot 命名空间值 + group UUID）；
//     indexInGroup 只是捕获提示，addPitchControl/removePitchControl 会触发重排，
//     所以定位与回滚一律用执行时的 live getIndexInParent，绝不复用旧索引。
//   - 修改采用原位 set（setPosition/setPitch/setPoints），保留 scriptData 与对象身份；
//     补偿用 journal 里保存的旧值逆序还原。clone→replace 是 Phase 0 真机确认后的备选策略。
//   - 单位纪律：position 是 group-local 整数 BLICK，pitch 是 group-relative semitone，
//     Curve 点相对 anchor。绝不与 pitchDelta 的 cents 或 Note.detune 的 cents 混用。

const MAX_OPERATIONS = PITCH_CONTROL_LIMITS.operationsPerRequest;
const MAX_CURVE_POINTS = PITCH_CONTROL_LIMITS.curvePointsPerControl;

export class PitchControlPatchService {
  constructor(
    session,
    snapshotService,
    { sleepFn, now = () => Date.now(), idGenerator, artifactStore = null, sessionId = null } = {}
  ) {
    this.session = session;
    this.snapshotService = snapshotService;
    this.sleep = sleepFn;
    this.now = now;
    this.artifactStore = artifactStore;
    this.sessionId = sessionId;
    // 自建对象的持久 controlId 生成器；测试注入确定性值，线上用随机 UUID。
    this.newControlId =
      idGenerator ?? (() => `pc_${globalThis.crypto?.randomUUID?.() ?? `${this.now()}_${Math.random()}`}`);
  }

  async patch(request) {
    const serviceStartedAt = this.now();
    let resolvedRequest = request;
    let ledgerRef = null;
    let planScopeSource = null;
    // 如果请求携带 planRef，先从 artifact 展开为规范 mutation 请求。
    if (request?.planRef && this.artifactStore && this.sessionId) {
      const resolved = resolvePlanReference({
        planRef: request.planRef,
        action: request.action,
        confirmations: request.confirmations,
        executionOptions: request.executionOptions,
        expectedTargetTool: "sv_patch_pitch_controls",
        sessionId: this.sessionId,
        artifactStore: this.artifactStore,
        planLedger: this.artifactStore.planLedger ?? null,
      });
      resolvedRequest = resolved.mutationRequest;
      ledgerRef = resolved.ledgerRef;
      planScopeSource = resolved.scopeSource;
    }
    let input;
    try {
      input = normalizeRequest(resolvedRequest);
    } catch (error) {
      const failure = formatValidationFailure(resolvedRequest, error, {
        elapsedMs: elapsed(serviceStartedAt, this.now()),
      });
      return settlePlanLedger(this.artifactStore?.planLedger ?? null, ledgerRef, failure);
    }
    const coordinatorRequestedAt = this.now();
    const result = await this.session.withExclusive(async (host) => {
      const acquiredAt = this.now();
      const scope = createHostScope(host);
      try {
        const transaction = await this._execute(scope, host, input, {
          serviceStartedAt,
          coordinatorRequestedAt,
          acquiredAt,
          planScopeSource,
        });
        return transaction;
      } finally {
        await scope.releaseAll();
      }
    });
    return settlePlanLedger(this.artifactStore?.planLedger ?? null, ledgerRef, result);
  }

  async _execute(scope, host, input, clock) {
    const timer = new ServiceTiming({
      now: this.now,
      phaseNames: ["preflightReadMs", "hostWriteMs", "verificationMs", "rollbackMs"],
    });
    timer.values.validationMs = elapsed(clock.serviceStartedAt, clock.coordinatorRequestedAt);
    timer.values.coordinatorQueueMs = elapsed(clock.coordinatorRequestedAt, clock.acquiredAt);
    timer.serviceStartedAt = clock.serviceStartedAt;
    timer.coordinatorRequestedAt = clock.coordinatorRequestedAt;
    timer.acquiredAt = clock.acquiredAt;

    const tx = {
      ok: false,
      status: "failed",
      effects: "none",
      target: null,
      plans: [],
      changes: { planned: input.operations.length, actuallyChanged: 0, added: 0, updated: 0, deleted: 0 },
      failure: null,
      rollback: { attempted: false, verified: null, operations: [] },
      boundaryCalls: 0,
      warnings: [],
      processing: null,
    };

    let phase = "preflight";
    let failedOpIndex = null;
    const inverses = [];
    try {
      const source = clock.planScopeSource ?? {
        kind: "snapshot",
        stored: this.snapshotService.getContext(input.contextId, host.epoch()),
      };
      const target = await timer.measure("preflightReadMs", () =>
        resolvePitchTarget(scope, source, input, host.epoch())
      );
      tx.target = target;

      // 全组 fingerprint 守卫：任何增删/重排/单对象变化都会改变它，在归一化 plan 前先失败。
      if (
        input.target.expectedPitchControlFingerprint !== undefined &&
        input.target.expectedPitchControlFingerprint !== target.groupFingerprint
      ) {
        throw withOpFailure(
          codedError(
            "TARGET_CONFLICT",
            "the group's pitch-control set changed after snapshot: expectedPitchControlFingerprint mismatch; re-snapshot and re-plan"
          ),
          null,
          "preflight"
        );
      }

      const plans = await timer.measure("preflightReadMs", () => buildPlan(scope, target, input));
      tx.plans = plans;
      tx.warnings.push(...plans.flatMap((plan) => plan.warnings));

      if (input.dryRun) {
        tx.ok = true;
        tx.status = "dry_run";
        appendSharedTargetDryRunWarnings(target, input, tx.warnings);
        return finish(tx, timer, input);
      }

      // no-change：所有 operation 解析为空操作（update 值全等）。dry-run 之外的数学空操作
      // 不开 Undo、不触碰宿主（与 parameter-curve 的黑盒审计 F-06 一致）。
      if (plans.every((plan) => plan.noop)) {
        tx.ok = true;
        tx.status = "no_change";
        tx.effects = "none";
        for (const plan of plans) plan.status = "no_change";
        return finish(tx, timer, input);
      }

      await timer.measure("preflightReadMs", () => ensureSharedTargetConfirmed(scope, target, input));

      // journal：第一次写之前，为每个将被改/删的对象 clone + 抓取完整 scriptData。
      const journaled = await timer.measure("preflightReadMs", () =>
        captureJournal(scope, plans)
      );
      tx.journal = journaled;

      phase = "execute";
      await timer.measure("hostWriteMs", async () => {
        await scope.call(target.roots.project, "newUndoRecord", []);
        tx.boundaryCalls += 1;
      });

      for (const plan of plans) {
        failedOpIndex = plan.index;
        plan.status = "writing";
        // 一旦为某个写 op 发出宿主调用即置位：此后任何 HOST_TIMEOUT/DETACHED 都无法证明
        // 宿主最终状态，必须诚实报 outcome_unknown，绝不按"未写入"误报为 failed。
        if (!plan.noop) tx.writeAttempted = true;
        await timer.measure("hostWriteMs", () =>
          applyOperation(scope, target, plan, inverses, this)
        );
        plan.status = "written";
      }

      phase = "verify";
      await timer.measure("verificationMs", async () => {
        const verification = await verifyTransaction(scope, target, plans, inverses);
        tx.verification = verification;
        if (!verification.passed) {
          throw withOpFailure(
            postconditionError(verification),
            verification.failedOpIndex ?? null,
            "verify"
          );
        }
      });
      for (const plan of plans) plan.status = "succeeded";
      tx.changes = summarizeChanges(plans);

      await closeBoundary(scope, target, tx, timer);

      phase = "observe";
      tx.processing = await this._observeProcessing(host, target, input, tx);

      tx.ok = true;
      // 提交与读回验证均已完成，因此根级恒为 succeeded；processing 观察的结论降级为
      // 嵌套 processing.status（§4.5 / §10.6 规则 4）。
      tx.status = "succeeded";
      tx.effects = "verified";
      this.snapshotService.store.delete(input.contextId);
      return finish(tx, timer, input);
    } catch (error) {
      tx.failure = failureEvidence(error, phase, failedOpIndex);
      const writeAttempted = tx.writeAttempted === true || inverses.length > 0;
      if (!writeAttempted) {
        for (const plan of tx.plans) if (plan.status !== "no_change") plan.status = "not_applied";
        tx.status = error?.code === "TARGET_CONFLICT" ? "conflict" : "failed";
        return finish(tx, timer, input);
      }

      const unknown = isUnknownOutcomeError(error);
      if (unknown || !input.atomic) {
        await closeBoundary(scope, tx.target, tx, timer);
        tx.status = unknown ? "outcome_unknown" : "partial";
        tx.effects = unknown ? "unknown" : "may_remain";
        tx.failure.outcome = unknown ? "unknown" : "partial";
        return finish(tx, timer, input);
      }

      phase = "rollback";
      tx.rollback.attempted = true;
      await timer.measure("rollbackMs", async () => {
        const rollback = await rollbackTransaction(scope, tx.target, inverses, tx.journal);
        tx.rollback.verified = rollback.verified;
        tx.rollback.operations = rollback.operations;
        tx.rollback.error = rollback.error;
        tx.rollback.outcomeUnknown = rollback.outcomeUnknown;
      });
      await closeBoundary(scope, tx.target, tx, timer);
      tx.status = tx.rollback.verified ? "rolled_back" : "rollback_failed";
      tx.effects = tx.rollback.verified
        ? "reverted"
        : tx.rollback.outcomeUnknown
          ? "unknown"
          : "may_remain";
      tx.failure.outcome = tx.rollback.verified
        ? "unchanged"
        : tx.effects === "unknown"
          ? "unknown"
          : "partial";
      return finish(tx, timer, input);
    } finally {
      if (tx.writeAttempted === true || inverses.length > 0) {
        this.snapshotService.store.delete(input.contextId);
      }
    }
  }

  async _observeProcessing(host, target, input, tx) {
    if (input.waitFor === "none") return null;
    // 提交与读回验证完成、Undo 边界已关闭；processing 观测失败只降级为子结果 + warning，
    // 绝不把已验证成功的写入误报为 outcome_unknown/partial（对齐 note-structure）。
    try {
      const processing = await waitForProcessing(host, {
        roots: target.roots,
        group: target.reference,
        kind: input.waitFor,
        startBlick: target.observationStartBlick,
        intervalBlick: target.observationIntervalBlick,
        frames: target.observationFrames,
        timeoutMs: input.timeoutMs,
        pollIntervalMs: input.pollIntervalMs,
        sleepFn: this.sleep,
        now: this.now,
      });
      tx.warnings.push(...(processing.warnings ?? []));
      return processing;
    } catch (error) {
      tx.warnings.push({
        code: "PROCESSING_OBSERVATION_FAILED",
        message: error instanceof Error ? error.message : String(error),
      });
      return {
        ok: false,
        status: "processing_observation_failed",
        data: { state: "unknown" },
        error: {
          code: typeof error?.code === "string" ? error.code : "HOST_CALL_FAILED",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
}

// 解析目标：定位 range occurrence、比对 target UUID、读取 live offset、枚举全部 PitchControl
// 并计算 live 全组 fingerprint。shared-target 的工程级扫描延迟到 commit（dry-run 保持无副作用）。
async function resolvePitchTarget(scope, source, input, epoch) {
  const mutationScope = resolveMutationScope({
    source,
    occurrence: input.occurrence,
    expectedEpoch: epoch,
    requireCapturedNotes: false,
  });
  const occurrence = mutationScope.occurrence;
  if (typeof occurrence.targetGroupUuid !== "string" || occurrence.targetGroupUuid.length === 0) {
    throw codedError("INVALID_TARGET", "instrumental occurrences have no pitch controls to edit");
  }

  const roots = await scope.roots();
  const track = await scope.call(roots.project, "getTrack", [occurrence.trackIndex + 1], {
    inferredType: "Track",
  });
  const reference = await scope.call(track, "getGroupReference", [occurrence.groupIndex + 1], {
    inferredType: "NoteGroupReference",
  });
  if (await scope.call(reference, "isInstrumental")) {
    throw codedError("INVALID_TARGET", "instrumental occurrences have no pitch controls to edit");
  }
  const group = await scope.call(reference, "getTarget", [], { inferredType: "NoteGroup" });
  const groupUuid = await scope.call(group, "getUUID");
  const expectedGroupUuid = input.target.expectedGroupUuid ?? occurrence.targetGroupUuid;
  if (expectedGroupUuid !== groupUuid) {
    throw codedError(
      input.target.expectedGroupUuid !== undefined ? "TARGET_CONFLICT" : "STALE_CONTEXT",
      `expected group UUID ${expectedGroupUuid}, observed ${groupUuid}`
    );
  }
  const timeOffsetBlick = await scope.call(reference, "getTimeOffset");
  const pitchOffsetSemitone = await scope.call(reference, "getPitchOffset");
  if (
    input.target.expectedTimeOffsetBlick !== undefined &&
    input.target.expectedTimeOffsetBlick !== timeOffsetBlick
  ) {
    throw codedError(
      "STALE_CONTEXT",
      `the group reference moved after snapshot: expected timeOffsetBlick ${input.target.expectedTimeOffsetBlick}, observed ${timeOffsetBlick}; re-snapshot and re-plan`
    );
  }
  if (
    input.target.expectedPitchOffsetSemitone !== undefined &&
    input.target.expectedPitchOffsetSemitone !== pitchOffsetSemitone
  ) {
    throw codedError(
      "STALE_CONTEXT",
      `the group reference pitch offset changed after snapshot: expected ${input.target.expectedPitchOffsetSemitone}, observed ${pitchOffsetSemitone}; re-snapshot and re-plan`
    );
  }
  // 音符锚点漂移守卫（sv_plan_pitch_gesture 经 apply 传入）：PitchControl 不锚定音符，但
  // 音高变化曲线是按快照音符位置/音高计算的——音符被移动（UUID/offset 不变）时绝对坐标曲线会落到
  // 错误位置，逐条核对快照指纹，漂移即 STALE_CONTEXT（发生在任何写入之前，effects 保持 none）。
  if (input.target.expectedNotes) {
    for (const expected of input.target.expectedNotes) {
      await verifyAnchoredNote(scope, group, expected);
    }
  }

  const controls = await readLivePitchControls(scope, group, groupUuid);
  const onsetBlick = await scope.call(reference, "getOnset");
  const endBlick = await scope.call(reference, "getEnd");
  const span = Math.max(1, endBlick - onsetBlick);
  const frames = 160;
  return {
    scope,
    roots,
    track,
    reference,
    group,
    groupUuid,
    occurrence,
    timeOffsetBlick,
    pitchOffsetSemitone,
    controls,
    controlById: new Map(controls.map((control) => [control.fingerprint, control])),
    groupFingerprint: computeGroupFingerprint(controls, groupUuid),
    sharedTargetOccurrences: occurrence.sharedTargetOccurrences ?? [],
    mutationScope,
    observationStartBlick: onsetBlick,
    observationIntervalBlick: Math.max(1, Math.ceil(span / frames)),
    observationFrames: frames,
  };
}

// 读取 group 全部 PitchControl 的完整可变状态（含完整 scriptData map）。这是 patch 的
// live 真值来源，也是 journal/rollback 的 scriptData 来源。
async function readLivePitchControls(scope, group, groupUuid) {
  const count = await scope.call(group, "getNumPitchControls");
  const controls = [];
  for (let index = 0; index < count; index += 1) {
    const handle = await scope.call(group, "getPitchControl", [index + 1]);
    controls.push(await readLivePitchControl(scope, handle, groupUuid, index));
  }
  return controls;
}

async function readLivePitchControl(scope, handle, groupUuid, indexInGroup) {
  const positionBlick = await scope.call(handle, "getPosition");
  const pitchSemitone = await scope.call(handle, "getPitch");
  let kind = "point";
  let points = null;
  try {
    const rawPoints = await scope.call(handle, "getPoints", [], {
      resultFormat: "typed-v2",
      resultShape: "array",
    });
    kind = "curve";
    points = normalizeCurvePoints(rawPoints);
  } catch (error) {
    if (error?.code !== "UNKNOWN_METHOD") throw error;
  }
  const scriptDataKeys = normalizeKeyList(
    await scope.call(handle, "getScriptDataKeys", [], {
      resultFormat: "typed-v2",
      resultShape: "array",
    })
  );
  const scriptData = {};
  for (const key of scriptDataKeys) {
    scriptData[key] = await scope.call(handle, "getScriptData", [key], { resultFormat: "typed-v2" });
  }
  const ownedValues = extractOwnedValues(scriptData);
  const fingerprint = computeControlFingerprint(
    { kind, positionBlick, pitchSemitone, points, ownedValues },
    groupUuid
  );
  return {
    handle,
    kind,
    indexInGroup,
    positionBlick,
    pitchSemitone,
    points,
    scriptData,
    scriptDataKeys,
    ownedValues,
    ownedControlId: ownedValues?.controlId ?? null,
    fingerprint,
  };
}

function normalizeKeyList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter((key) => typeof key === "string" && !key.startsWith("$sv"));
}

// 与 parameter-curve 的 verifyAnchoredNote 同语义：按 indexInGroup 取活音符，逐字段严格比对
// 快照指纹；任何漂移抛 STALE_CONTEXT（写路径在任何写入之前触发，effects 保持 none）。
async function verifyAnchoredNote(scope, group, expected) {
  const note = await scope.call(group, "getNote", [expected.indexInGroup + 1], {
    inferredType: "Note",
  });
  if (!note?.__handle__) {
    throw codedError("STALE_CONTEXT", `anchored note ${expected.indexInGroup} no longer exists`);
  }
  const observed = {
    indexInGroup: (await scope.call(note, "getIndexInParent")) - 1,
    onsetBlick: await scope.call(note, "getOnset"),
    durationBlick: await scope.call(note, "getDuration"),
    pitch: await scope.call(note, "getPitch"),
    lyrics: await scope.call(note, "getLyrics"),
    phonemesOverride: await scope.call(note, "getPhonemes"),
    languageOverride: await scope.call(note, "getLanguageOverride"),
    detuneCents: await scope.call(note, "getDetune"),
  };
  const comparableExpected = {
    indexInGroup: expected.indexInGroup,
    onsetBlick: expected.onsetBlick,
    durationBlick: expected.durationBlick,
    pitch: expected.pitch,
    lyrics: expected.lyrics,
    phonemesOverride: expected.phonemesOverride,
    languageOverride: expected.languageOverride,
    detuneCents: expected.detuneCents,
  };
  if (JSON.stringify(observed) !== JSON.stringify(comparableExpected)) {
    const error = codedError(
      "STALE_CONTEXT",
      `anchored note ${expected.indexInGroup} changed after snapshot`
    );
    error.expectedFingerprint = comparableExpected;
    error.observedFingerprint = observed;
    throw error;
  }
  return observed;
}

// 归一化 plan：把每个 operation 解析到 live 对象（按 fingerprint + ownership 唯一匹配），
// 计算 noop 与期望终态。add 永远是 change；delete 目标不存在即 UNKNOWN_CONTROL；
// update 的 set 与现值全等（pitch 用 epsilon、BLICK/点数精确）即 noop。
async function buildPlan(scope, target, input) {
  const plans = [];
  const claimed = new Set();
  for (const operation of input.operations) {
    const plan = { index: operation.index, op: operation.op, status: "prepared", warnings: [] };
    if (operation.op === "add") {
      plan.control = operation.control;
      plan.noop = false;
      plans.push(plan);
      continue;
    }
    // update / delete：先解析目标对象。
    const resolved = resolveTargetControl(target, operation);
    plan.targetControl = resolved;
    if (claimed.has(resolved.fingerprint)) {
      throw withOpFailure(
        codedError(
          "DUPLICATE_CONTROL",
          `operations[${operation.index}] and an earlier operation both target the same pitch control`
        ),
        operation.index,
        "preflight"
      );
    }
    claimed.add(resolved.fingerprint);
    if (operation.op === "delete") {
      plan.noop = false;
      plans.push(plan);
      continue;
    }
    // update
    validateUpdateSetForKind(operation.set, resolved.kind, operation.index);
    plan.set = operation.set;
    plan.newDefinition = computeUpdatedDefinition(resolved, operation.set);
    plan.noop = definitionMatchesControl(plan.newDefinition, resolved);
    if (plan.noop) plan.status = "no_change";
    plans.push(plan);
  }
  return plans;
}

// Point 与 Curve 的 set 字段不得混用：point 用 positionBlick/pitchSemitone，curve 用
// anchorPositionBlick/anchorPitchSemitone/points。跨 kind 字段显式拒绝，绝不静默忽略。
function validateUpdateSetForKind(set, kind, opIndex) {
  const pointOnly = ["positionBlick", "pitchSemitone"].filter((field) => set[field] !== undefined);
  const curveOnly = ["anchorPositionBlick", "anchorPitchSemitone", "points"].filter(
    (field) => set[field] !== undefined
  );
  if (kind === "point" && curveOnly.length > 0) {
    throw withOpFailure(
      codedError(
        "INVALID_ARGUMENTS",
        `operations[${opIndex}]: target is a point; ${curveOnly.join(", ")} only apply to curves`
      ),
      opIndex,
      "preflight"
    );
  }
  if (kind === "curve" && pointOnly.length > 0) {
    throw withOpFailure(
      codedError(
        "INVALID_ARGUMENTS",
        `operations[${opIndex}]: target is a curve; use anchorPositionBlick/anchorPitchSemitone/points, not ${pointOnly.join(", ")}`
      ),
      opIndex,
      "preflight"
    );
  }
}

// 按 expectedFingerprint 在 live 集合中唯一匹配；零匹配 UNKNOWN_CONTROL，多匹配
// AMBIGUOUS_CONTROL，绝不"取第一个"。controlId（owned / context-scoped 两种）作交叉检查。
function resolveTargetControl(target, operation) {
  const matches = target.controls.filter(
    (control) => control.fingerprint === operation.expectedFingerprint
  );
  if (matches.length === 0) {
    const error = codedError(
      "UNKNOWN_CONTROL",
      `operations[${operation.index}]: no pitch control matches the expected fingerprint; the group changed after snapshot (re-snapshot and re-plan)`
    );
    error.controlId = operation.controlId;
    throw withOpFailure(error, operation.index, "preflight");
  }
  if (matches.length > 1) {
    const error = codedError(
      "AMBIGUOUS_CONTROL",
      `operations[${operation.index}]: ${matches.length} pitch controls match the expected fingerprint; identical duplicates cannot be addressed safely (re-snapshot and disambiguate)`
    );
    error.controlId = operation.controlId;
    error.matchCount = matches.length;
    throw withOpFailure(error, operation.index, "preflight");
  }
  const control = matches[0];
  // controlId 交叉检查：context-scoped id 的索引提示与解析结果的 live 索引可以不同（重排），
  // 但 owned controlId 必须与解析结果的 ownership 一致。
  const parsed = parseContextControlId(operation.controlId);
  if (parsed === null && control.ownedControlId !== operation.controlId) {
    const error = codedError(
      "CONTROL_ID_MISMATCH",
      `operations[${operation.index}]: controlId ${operation.controlId} does not match the resolved control's ownership`
    );
    error.controlId = operation.controlId;
    throw withOpFailure(error, operation.index, "preflight");
  }
  return control;
}

// 计算 update 后的完整定义（未提供的字段沿用现值；points 一旦提供即整体替换）。
function computeUpdatedDefinition(control, set) {
  if (control.kind === "point") {
    return {
      kind: "point",
      positionBlick: set.positionBlick ?? control.positionBlick,
      pitchSemitone: set.pitchSemitone ?? control.pitchSemitone,
      points: null,
    };
  }
  return {
    kind: "curve",
    positionBlick: set.anchorPositionBlick ?? control.positionBlick,
    pitchSemitone: set.anchorPitchSemitone ?? control.pitchSemitone,
    points: set.points ?? control.points,
  };
}

// 期望终态与 live 现值是否全等（noop 判定）。BLICK 精确、pitch epsilon、点数与逐点精确+epsilon。
function definitionMatchesControl(definition, control) {
  if (definition.kind !== control.kind) return false;
  if (definition.positionBlick !== control.positionBlick) return false;
  if (!pitchEquals(definition.pitchSemitone, control.pitchSemitone)) return false;
  if (definition.kind === "curve") {
    const planned = definition.points ?? [];
    const current = control.points ?? [];
    if (planned.length !== current.length) return false;
    for (let index = 0; index < planned.length; index += 1) {
      if (planned[index].timeFromAnchorBlick !== current[index].timeFromAnchorBlick) return false;
      if (!pitchEquals(planned[index].pitchFromAnchorSemitone, current[index].pitchFromAnchorSemitone)) {
        return false;
      }
    }
  }
  return true;
}

// journal：为每个将被改/删的对象 clone + 抓取完整 scriptData（含外部脚本值），在第一次写之前完成。
// liveHandle 一并保存：update 是原位 set（对象 handle 不变），回滚直接在同一 handle 上还原旧值。
async function captureJournal(scope, plans) {
  const journal = new Map();
  for (const plan of plans) {
    if (plan.op === "add" || plan.noop) continue;
    const control = plan.targetControl;
    if (journal.has(control.fingerprint)) continue;
    const backup = await scope.call(control.handle, "clone", []);
    journal.set(control.fingerprint, {
      fingerprint: control.fingerprint,
      kind: control.kind,
      positionBlick: control.positionBlick,
      pitchSemitone: control.pitchSemitone,
      points: control.points ? control.points.map((point) => ({ ...point })) : null,
      scriptData: { ...control.scriptData },
      backup,
      liveHandle: control.handle,
    });
  }
  return journal;
}

async function applyOperation(scope, target, plan, inverses, service) {
  if (plan.noop) return;
  if (plan.op === "add") {
    const controlId = service.newControlId();
    const handle = await scope.call(undefined, "create", [
      plan.control.kind === "curve" ? "PitchControlCurve" : "PitchControlPoint",
    ]);
    plan.createdHandle = handle;
    plan.createdControlId = controlId;
    await scope.call(handle, "setPosition", [plan.control.positionBlick]);
    await scope.call(handle, "setPitch", [plan.control.pitchSemitone]);
    if (plan.control.kind === "curve") {
      await scope.call(handle, "setPoints", [
        plan.control.points.map((point) => [point.timeFromAnchorBlick, point.pitchFromAnchorSemitone]),
      ]);
    }
    // SVCopilot 自有标记：持久 controlId + generator + schemaVersion，供跨 snapshot 身份与所有权。
    await scope.call(handle, "setScriptData", [OWNERSHIP.ownerKey, OWNERSHIP.ownerValue]);
    await scope.call(handle, "setScriptData", [OWNERSHIP.controlIdKey, controlId]);
    await scope.call(handle, "setScriptData", [OWNERSHIP.generatorKey, plan.control.generator]);
    await scope.call(handle, "setScriptData", [OWNERSHIP.schemaVersionKey, PITCH_CONTROL_SCHEMA_VERSION]);
    plan.hostIndex = await scope.call(target.group, "addPitchControl", [handle]);
    // inverse：删除刚加入的对象（用执行时 live index，addPitchControl 可能已触发重排）。
    inverses.push({ op: "removeAdded", handle });
    return;
  }
  if (plan.op === "delete") {
    const control = plan.targetControl;
    const liveIndex = await scope.call(control.handle, "getIndexInParent");
    if (!Number.isSafeInteger(liveIndex) || liveIndex < 1) {
      throw codedError("STALE_CONTEXT", "delete target is no longer attached to the group");
    }
    await scope.call(target.group, "removePitchControl", [liveIndex]);
    // inverse：把 journal 里的 clone 备份重新加入，并显式还原完整 scriptData。
    inverses.push({ op: "readdBackup", fingerprint: control.fingerprint });
    return;
  }
  // update：原位 set，保留 scriptData 与对象身份。
  const control = plan.targetControl;
  const definition = plan.newDefinition;
  // 多字段更新的任一 setter 都可能失败，必须先登记补偿，才能还原此前已成功的 setter。
  inverses.push({ op: "restoreInPlace", fingerprint: control.fingerprint });
  if (definition.positionBlick !== control.positionBlick) {
    await scope.call(control.handle, "setPosition", [definition.positionBlick]);
  }
  if (!pitchEquals(definition.pitchSemitone, control.pitchSemitone)) {
    await scope.call(control.handle, "setPitch", [definition.pitchSemitone]);
  }
  if (definition.kind === "curve" && definition.points !== control.points) {
    await scope.call(control.handle, "setPoints", [
      definition.points.map((point) => [point.timeFromAnchorBlick, point.pitchFromAnchorSemitone]),
    ]);
  }
}

// 读回验证：重新枚举全组，比对终态数量与每个受影响对象的字段（pitch epsilon、BLICK/点数精确）。
async function verifyTransaction(scope, target, plans, inverses) {
  const observed = await readLivePitchControls(scope, target.group, target.groupUuid);
  const evidence = { observedCount: observed.length, checks: 0, mismatches: [] };
  let failedOpIndex = null;
  const expectedDelta = plans.reduce(
    (sum, plan) => sum + (plan.noop ? 0 : plan.op === "add" ? 1 : plan.op === "delete" ? -1 : 0),
    0
  );
  const expectedCount = target.controls.length + expectedDelta;
  evidence.expectedCount = expectedCount;
  let passed = observed.length === expectedCount;

  for (const plan of plans) {
    if (plan.noop) continue;
    if (plan.op === "add") {
      const handle = plan.createdHandle;
      const liveIndex = await scope.call(handle, "getIndexInParent");
      evidence.checks += 1;
      if (!Number.isSafeInteger(liveIndex) || liveIndex < 1) {
        passed = false;
        failedOpIndex = plan.index;
        evidence.mismatches.push({ op: "add", reason: "added control not attached", controlId: plan.createdControlId });
        continue;
      }
      const observedControl = await readLivePitchControl(scope, handle, target.groupUuid, liveIndex - 1);
      if (!definitionMatchesControl(plan.control, observedControl)) {
        passed = false;
        failedOpIndex = plan.index;
        evidence.mismatches.push({ op: "add", reason: "added control fields mismatch", controlId: plan.createdControlId });
      }
      // 自有标记必须已写入。
      if (observedControl.ownedControlId !== plan.createdControlId) {
        passed = false;
        failedOpIndex = plan.index;
        evidence.mismatches.push({ op: "add", reason: "ownership tag mismatch", controlId: plan.createdControlId });
      }
      continue;
    }
    if (plan.op === "delete") {
      evidence.checks += 1;
      // 被删对象的 fingerprint 不应再出现在 live 集合（内容级消失）。
      if (observed.some((control) => control.fingerprint === plan.targetControl.fingerprint)) {
        passed = false;
        failedOpIndex = plan.index;
        evidence.mismatches.push({ op: "delete", reason: "control still present after delete", controlId: plan.targetControl.ownedControlId });
      }
      continue;
    }
    // update：对象身份不变（fingerprint 含 pitch，会随 set 改变），用 handle 重新读回比对期望终态。
    const liveIndex = await scope.call(plan.targetControl.handle, "getIndexInParent");
    evidence.checks += 1;
    if (!Number.isSafeInteger(liveIndex) || liveIndex < 1) {
      passed = false;
      failedOpIndex = plan.index;
      evidence.mismatches.push({ op: "update", reason: "updated control detached" });
      continue;
    }
    const observedControl = await readLivePitchControl(scope, plan.targetControl.handle, target.groupUuid, liveIndex - 1);
    if (!definitionMatchesControl(plan.newDefinition, observedControl)) {
      passed = false;
      failedOpIndex = plan.index;
      evidence.mismatches.push({ op: "update", reason: "updated control fields mismatch" });
    }
  }
  return { attempted: true, passed, basis: "host_read_back", evidence, failedOpIndex };
}

// 逆序补偿：删除新增、还原修改、重加删除（重加后显式还原完整 scriptData）。全程用 live index。
async function rollbackTransaction(scope, target, inverses, journal) {
  const errors = [];
  const operations = [];
  for (const inverse of [...inverses].reverse()) {
    try {
      if (inverse.op === "removeAdded") {
        const liveIndex = await scope.call(inverse.handle, "getIndexInParent");
        if (Number.isSafeInteger(liveIndex) && liveIndex >= 1) {
          await scope.call(target.group, "removePitchControl", [liveIndex]);
        }
        operations.push({ op: inverse.op, ok: true });
      } else if (inverse.op === "restoreInPlace") {
        const entry = journal.get(inverse.fingerprint);
        await restoreUpdatedControl(scope, entry);
        operations.push({ op: inverse.op, ok: true });
      } else if (inverse.op === "readdBackup") {
        const entry = journal.get(inverse.fingerprint);
        await scope.call(target.group, "addPitchControl", [entry.backup]);
        await restoreScriptData(scope, entry.backup, entry.scriptData);
        operations.push({ op: inverse.op, ok: true });
      }
    } catch (error) {
      if (isUnknownOutcomeError(error)) {
        operations.push({ op: inverse.op, ok: false, error: rollbackError(error) });
        return { verified: false, outcomeUnknown: true, operations, error: rollbackError(error) };
      }
      errors.push(rollbackError(error));
      operations.push({ op: inverse.op, ok: false, error: rollbackError(error) });
    }
  }
  // 恢复效果读回：全组 fingerprint 应回到事务前（增删改全部还原）。fingerprint 含 ownership
  // scriptData 值，因此本验证的正确性依赖 clone 保留 scriptData（官方文档称 clone 为深拷贝，
  // 但 scriptData 是否随之拷贝是 Phase 0 真机确认项）。补偿重加时已用 journal 里抓取的完整
  // scriptData 显式回填作为双保险；若真机证明 clone 丢 scriptData，此验证会如实报 rollback_failed。
  try {
    const observed = await readLivePitchControls(scope, target.group, target.groupUuid);
    const restored = computeGroupFingerprint(observed, target.groupUuid) === target.groupFingerprint;
    const verified = errors.length === 0 && restored;
    return {
      verified,
      outcomeUnknown: false,
      operations,
      ...(errors.length > 0 ? { error: errors[0], errors } : {}),
    };
  } catch (error) {
    return {
      verified: false,
      outcomeUnknown: isUnknownOutcomeError(error),
      operations,
      error: rollbackError(error),
      ...(errors.length > 0 ? { errors } : {}),
    };
  }
}

// restoreInPlace：update 是原位 set（对象 handle 不变），直接在同一 live handle 上 set 回
// journal 保存的旧 position/pitch/points。BLICK 精确、points 整体还原。
async function restoreUpdatedControl(scope, journalEntry) {
  const liveHandle = journalEntry.liveHandle;
  if (!liveHandle) throw codedError("ROLLBACK_FAILED", "missing live handle for in-place restore");
  await scope.call(liveHandle, "setPosition", [journalEntry.positionBlick]);
  await scope.call(liveHandle, "setPitch", [journalEntry.pitchSemitone]);
  if (journalEntry.kind === "curve" && journalEntry.points) {
    await scope.call(liveHandle, "setPoints", [
      journalEntry.points.map((point) => [point.timeFromAnchorBlick, point.pitchFromAnchorSemitone]),
    ]);
  }
}

async function restoreScriptData(scope, handle, scriptData) {
  for (const [key, value] of Object.entries(scriptData)) {
    await scope.call(handle, "setScriptData", [key, value]);
  }
}

async function ensureSharedTargetConfirmed(scope, target, input) {
  const projectTargetOccurrences = await scanTargetOccurrences(
    scope,
    target.roots.project,
    target.groupUuid
  );
  const knownCount = Math.max(
    projectTargetOccurrences.length,
    target.sharedTargetOccurrences.length
  );
  if (knownCount > 1 && input.target.allowSharedTargetMutation !== true) {
    const error = codedError(
      "SHARED_TARGET_REQUIRES_CONFIRMATION",
      "the target NoteGroup has multiple project occurrences; set allowSharedTargetMutation:true to confirm a project-wide edit"
    );
    error.projectTargetOccurrences = projectTargetOccurrences;
    error.details = { projectTargetOccurrences };
    throw error;
  }
  target.projectTargetOccurrences = projectTargetOccurrences;
}

function appendSharedTargetDryRunWarnings(target, input, warnings) {
  warnings.push({
    code: "SHARED_TARGET_CHECK_DEFERRED",
    message: "Project-wide shared-target scanning is deferred to commit; dry-run remains side-effect free.",
  });
  if (target.sharedTargetOccurrences.length > 1 && input.target.allowSharedTargetMutation !== true) {
    warnings.push({
      code: "SHARED_TARGET_DRY_RUN",
      message:
        "This dry-run is safe, but commit requires allowSharedTargetMutation:true because every occurrence shares one target NoteGroup.",
    });
  }
}

async function closeBoundary(scope, target, tx, timer) {
  if (!target) return;
  try {
    await timer.measure("hostWriteMs", async () => {
      await scope.call(target.roots.project, "newUndoRecord", []);
      tx.boundaryCalls += 1;
    });
  } catch (error) {
    tx.warnings.push({
      code: "UNDO_BOUNDARY_CLOSE_FAILED",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function summarizeChanges(plans) {
  const changes = { planned: plans.length, actuallyChanged: 0, added: 0, updated: 0, deleted: 0 };
  for (const plan of plans) {
    if (plan.noop) continue;
    changes.actuallyChanged += 1;
    if (plan.op === "add") changes.added += 1;
    else if (plan.op === "update") changes.updated += 1;
    else if (plan.op === "delete") changes.deleted += 1;
  }
  return changes;
}

function postconditionError(verification) {
  const error = codedError(
    "POSTCONDITION_FAILED",
    "the group's pitch controls did not match the planned end state after write-back verification"
  );
  error.details = verification.evidence;
  return error;
}

function finish(tx, timer, input) {
  const timings = timer.finish();
  return {
    ok: tx.ok,
    status: tx.status,
    effects: tx.effects,
    atomicity: input.atomic ? "verified_compensation" : "none",
    indexBase: 0,
    target: formatTarget(tx.target, input),
    changes: tx.changes,
    operations: formatOperations(tx, input),
    undo: {
      boundaryCallsCompleted: tx.boundaryCalls,
      recordCreated: tx.boundaryCalls >= 1,
      expectedUserUndoSteps:
        tx.status === "no_change" || tx.status === "dry_run"
          ? 0
          : tx.boundaryCalls === 2
            ? 1
            : null,
      automaticRollback: tx.rollback.attempted,
    },
    verification: tx.verification ?? { attempted: false, passed: null },
    rollback: {
      attempted: tx.rollback.attempted,
      verified: tx.rollback.verified,
      ...(tx.rollback.error ? { error: tx.rollback.error } : {}),
    },
    // 只投影出嵌套契约需要的字段，而不是把内部结果整个摊开：tx.processing 带着自己的
    // `ok` 与内部 status 词汇（processing_pending 等），原样透出就等于在响应里放了
    // 第二套成败结论。
    ...(tx.processing
      ? {
          processing: {
            status: nestedProcessingStatus(tx.processing),
            state: tx.processing.data?.state ?? null,
            ...(tx.processing.data?.evidence !== undefined
              ? { evidence: tx.processing.data.evidence }
              : {}),
            ...(tx.processing.error ? { error: tx.processing.error } : {}),
          },
        }
      : {}),
    ...(tx.failure ? { error: tx.failure } : {}),
    warnings: tx.warnings,
    timings,
  };
}

function formatTarget(target, input) {
  if (!target) {
    return {
      contextId: input.contextId,
      occurrence: input.occurrence,
      ...(input.target.expectedGroupUuid ? { expectedGroupUuid: input.target.expectedGroupUuid } : {}),
    };
  }
  return {
    contextId: input.contextId,
    occurrence: input.occurrence,
    trackIndex: target.occurrence.trackIndex,
    groupIndex: target.occurrence.groupIndex,
    targetGroupUuid: target.groupUuid,
    // shared-target 清单描述"还有哪些 occurrence 指向同一个 NoteGroup"，一律是
    // ordinal——与调用方传入的 occurrence 同一种身份，可以直接回传。
    affectedOccurrences: target.sharedTargetOccurrences.length > 0
      ? target.sharedTargetOccurrences
      : [target.occurrence.occurrence],
    ...(target.projectTargetOccurrences?.length > 1
      ? { projectTargetOccurrences: target.projectTargetOccurrences }
      : {}),
  };
}

function formatOperations(tx, input) {
  const plansByIndex = new Map(tx.plans.map((plan) => [plan.index, plan]));
  return input.operations.map((operation, index) => {
    const plan = plansByIndex.get(index);
    if (!plan) {
      const isFailure = tx.failure?.opIndex === index;
      return {
        op: operation.op,
        status: isFailure ? "failed" : "not_attempted",
        ...(isFailure ? { error: tx.failure } : {}),
      };
    }
    const output = { op: plan.op, status: plan.status };
    if (plan.op !== "add" && plan.targetControl) {
      output.controlId = plan.targetControl.ownedControlId ?? operation.controlId;
      output.kind = plan.targetControl.kind;
    }
    if (plan.op === "add") {
      output.kind = plan.control.kind;
      if (plan.createdControlId) output.controlId = plan.createdControlId;
      if (Number.isSafeInteger(plan.hostIndex)) output.hostIndex = plan.hostIndex;
    }
    // 单一形状（§10.6 规则 14）：planned 恒定返回。它是 dry-run 唯一的可审内容，
    // 由调用方选档会让"我看到的就是将要写入的"变成一句要先猜对参数才成立的话。
    if (plan.op === "update" && plan.newDefinition) output.planned = publicDefinition(plan.newDefinition);
    if (plan.op === "add") output.planned = publicDefinition(plan.control);
    if (plan.noop) output.noChange = true;
    return output;
  });
}

function publicDefinition(definition) {
  if (definition.kind === "curve") {
    return {
      kind: "curve",
      anchorPositionBlick: definition.positionBlick,
      anchorPitchSemitone: definition.pitchSemitone,
      points: (definition.points ?? []).map((point) => ({ ...point })),
    };
  }
  return {
    kind: "point",
    positionBlick: definition.positionBlick,
    pitchSemitone: definition.pitchSemitone,
  };
}

function formatValidationFailure(request, error, { elapsedMs }) {
  const operations = Array.isArray(request?.operations) ? request.operations : [];
  const failure = failureEvidence(error, "validate", null);
  return {
    ok: false,
    status: "failed",
    effects: "none",
    atomicity: request?.atomic === false ? "none" : "verified_compensation",
    indexBase: 0,
    target: isRecord(request?.target)
      ? {
          ...(typeof request.target.expectedGroupUuid === "string"
            ? { expectedGroupUuid: request.target.expectedGroupUuid }
            : {}),
        }
      : null,
    changes: { planned: operations.length, actuallyChanged: 0, added: 0, updated: 0, deleted: 0 },
    operations: operations.map((operation, index) => ({
      op: typeof operation?.op === "string" ? operation.op : null,
      status: failure.opIndex === index ? "failed" : "not_attempted",
      ...(failure.opIndex === index ? { error: failure } : {}),
    })),
    undo: { boundaryCallsCompleted: 0, recordCreated: false, expectedUserUndoSteps: 0, automaticRollback: false },
    verification: { attempted: false, passed: null },
    rollback: { attempted: false, verified: null },
    error: failure,
    warnings: [],
    timings: {
      dispatcherQueueMs: null,
      validationMs: elapsedMs,
      coordinatorQueueMs: null,
      preflightReadMs: 0,
      hostWriteMs: 0,
      verificationMs: 0,
      rollbackMs: 0,
      operationMs: 0,
      serviceTotalMs: elapsedMs,
    },
  };
}

function withOpFailure(error, opIndex, phase) {
  const wrapped = error instanceof Error ? error : new Error(String(error));
  wrapped.opIndex = opIndex;
  wrapped.phase = phase;
  return wrapped;
}

function failureEvidence(error, fallbackPhase, fallbackOpIndex) {
  return {
    code: typeof error?.code === "string" ? error.code : "HOST_CALL_FAILED",
    message: error instanceof Error ? error.message : String(error),
    phase: error?.phase ?? fallbackPhase,
    opIndex: Number.isSafeInteger(error?.opIndex) ? error.opIndex : fallbackOpIndex,
    ...(typeof error?.controlId === "string" ? { controlId: error.controlId } : {}),
    ...(error?.details && typeof error.details === "object" ? { details: error.details } : {}),
    outcome: isUnknownOutcomeError(error) ? "unknown" : "unchanged",
    retryable: isUnknownOutcomeError(error),
  };
}

function rollbackError(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "ROLLBACK_FAILED",
    message: error instanceof Error ? error.message : String(error),
  };
}

// --------------------------------------------------------------------------- //
// 请求归一化（schema 之外的语义校验；schema 层由 MCP 的 ajv 先挡一道）。
// --------------------------------------------------------------------------- //

function normalizeRequest(request) {
  if (!isRecord(request)) throw codedError("INVALID_ARGUMENTS", "request must be an object");
  if (typeof request.contextId !== "string" || !request.contextId) {
    throw codedError("INVALID_ARGUMENTS", "contextId is required; take it from sv_snapshot_range");
  }
  if (!Number.isSafeInteger(request.occurrence) || request.occurrence < 0) {
    throw codedError(
      "INVALID_ARGUMENTS",
      "occurrence is required: the 0-based occurrence ordinal from sv_snapshot_range"
    );
  }
  if (!Array.isArray(request.operations) || request.operations.length === 0) {
    throw codedError("INVALID_ARGUMENTS", "operations must be a non-empty array");
  }
  if (request.operations.length > MAX_OPERATIONS) {
    throw codedError("INVALID_ARGUMENTS", `operations must contain at most ${MAX_OPERATIONS} items`);
  }
  if (request.atomic === false) {
    throw codedError(
      "INVALID_ARGUMENTS",
      "atomic:false is not supported in this version; every patch is one verified-compensation transaction"
    );
  }
  const waitFor = request.waitFor ?? "none";
  if (!["none", "computedPitch"].includes(waitFor)) {
    throw codedError("INVALID_ARGUMENTS", "waitFor must be none or computedPitch");
  }
  return {
    contextId: request.contextId,
    occurrence: request.occurrence,
    target: normalizeTarget(request.target),
    operations: request.operations.map((operation, index) => normalizeOperation(operation, index)),
    atomic: true,
    dryRun: dryRunFromAction(request.action),
    waitFor,
    timeoutMs: clampInteger(request.timeoutMs, 0, 30_000, 10_000),
    pollIntervalMs: clampInteger(request.pollIntervalMs, 20, 2_000, 100),
  };
}

function normalizeTarget(target) {
  if (target === undefined) return {};
  if (!isRecord(target)) throw codedError("INVALID_ARGUMENTS", "target must be an object");
  for (const field of ["expectedGroupUuid", "expectedPitchControlFingerprint"]) {
    if (target[field] !== undefined && (typeof target[field] !== "string" || !target[field])) {
      throw codedError("INVALID_ARGUMENTS", `target.${field} must be a non-empty string`);
    }
  }
  if (
    target.expectedTimeOffsetBlick !== undefined &&
    !Number.isSafeInteger(target.expectedTimeOffsetBlick)
  ) {
    throw codedError("INVALID_ARGUMENTS", "target.expectedTimeOffsetBlick must be a safe integer");
  }
  if (
    target.expectedPitchOffsetSemitone !== undefined &&
    !Number.isFinite(target.expectedPitchOffsetSemitone)
  ) {
    throw codedError("INVALID_ARGUMENTS", "target.expectedPitchOffsetSemitone must be a finite number");
  }
  if (
    target.allowSharedTargetMutation !== undefined &&
    typeof target.allowSharedTargetMutation !== "boolean"
  ) {
    throw codedError("INVALID_ARGUMENTS", "target.allowSharedTargetMutation must be a boolean");
  }
  const expectedNotes = normalizeExpectedNotes(target.expectedNotes);
  return {
    ...(target.expectedGroupUuid !== undefined ? { expectedGroupUuid: target.expectedGroupUuid } : {}),
    ...(target.expectedPitchControlFingerprint !== undefined
      ? { expectedPitchControlFingerprint: target.expectedPitchControlFingerprint }
      : {}),
    ...(target.expectedTimeOffsetBlick !== undefined
      ? { expectedTimeOffsetBlick: target.expectedTimeOffsetBlick }
      : {}),
    ...(target.expectedPitchOffsetSemitone !== undefined
      ? { expectedPitchOffsetSemitone: target.expectedPitchOffsetSemitone }
      : {}),
    ...(expectedNotes !== undefined ? { expectedNotes } : {}),
    allowSharedTargetMutation: target.allowSharedTargetMutation === true,
  };
}

const MAX_EXPECTED_NOTES = 256;

// target.expectedNotes：音高变化曲线锚定的音符快照指纹（sv_plan_pitch_gesture 经 apply 传入）。
// 与 parameter-curve 同契约：缺字段会导致必然失败的假 STALE_CONTEXT，宁可归一化阶段拒绝。
function normalizeExpectedNotes(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw codedError("INVALID_ARGUMENTS", "target.expectedNotes must be a non-empty array when provided");
  }
  if (value.length > MAX_EXPECTED_NOTES) {
    throw codedError("INVALID_ARGUMENTS", `target.expectedNotes must contain at most ${MAX_EXPECTED_NOTES} items`);
  }
  return value.map((note, index) => {
    const label = `target.expectedNotes[${index}]`;
    if (!isRecord(note)) throw codedError("INVALID_ARGUMENTS", `${label} must be an object`);
    if (!Number.isSafeInteger(note.indexInGroup) || note.indexInGroup < 0) {
      throw codedError("INVALID_ARGUMENTS", `${label}.indexInGroup must be a non-negative integer`);
    }
    for (const field of ["onsetBlick", "durationBlick"]) {
      if (!Number.isSafeInteger(note[field]) || note[field] < 0) {
        throw codedError("INVALID_ARGUMENTS", `${label}.${field} must be a non-negative safe integer`);
      }
    }
    if (!Number.isSafeInteger(note.pitch)) {
      throw codedError("INVALID_ARGUMENTS", `${label}.pitch must be an integer MIDI pitch`);
    }
    if (!Number.isFinite(note.detuneCents)) {
      throw codedError("INVALID_ARGUMENTS", `${label}.detuneCents must be a finite number`);
    }
    for (const field of ["lyrics", "phonemesOverride", "languageOverride"]) {
      if (typeof note[field] !== "string" && note[field] !== null) {
        throw codedError("INVALID_ARGUMENTS", `${label}.${field} must be a string or null`);
      }
    }
    return {
      indexInGroup: note.indexInGroup,
      onsetBlick: note.onsetBlick,
      durationBlick: note.durationBlick,
      pitch: note.pitch,
      lyrics: note.lyrics,
      phonemesOverride: note.phonemesOverride,
      languageOverride: note.languageOverride,
      detuneCents: note.detuneCents,
    };
  });
}

function normalizeOperation(operation, index) {
  const label = `operations[${index}]`;
  if (!isRecord(operation)) throw codedError("INVALID_ARGUMENTS", `${label} must be an object`);
  if (operation.op === "add") {
    return { index, op: "add", control: normalizeControlSpec(operation.control, `${label}.control`) };
  }
  if (operation.op === "update") {
    const base = normalizeTargeting(operation, label);
    if (!isRecord(operation.set) || Object.keys(operation.set).length === 0) {
      throw codedError("INVALID_ARGUMENTS", `${label}.set must be a non-empty object`);
    }
    return { index, op: "update", ...base, set: normalizeUpdateSet(operation.set, `${label}.set`) };
  }
  if (operation.op === "delete") {
    return { index, op: "delete", ...normalizeTargeting(operation, label) };
  }
  throw codedError("INVALID_ARGUMENTS", `${label}.op must be add, update, or delete`);
}

function normalizeTargeting(operation, label) {
  if (typeof operation.controlId !== "string" || !operation.controlId) {
    throw codedError("INVALID_ARGUMENTS", `${label}.controlId must be a non-empty string`);
  }
  if (typeof operation.expectedFingerprint !== "string" || !operation.expectedFingerprint) {
    throw codedError(
      "INVALID_ARGUMENTS",
      `${label}.expectedFingerprint must be a non-empty string from sv_snapshot_range (it is the write-time identity guard)`
    );
  }
  return { controlId: operation.controlId, expectedFingerprint: operation.expectedFingerprint };
}

// add 的完整对象定义。坐标一律 group-local BLICK / group-relative semitone；Curve 点相对 anchor。
function normalizeControlSpec(control, label) {
  if (!isRecord(control)) throw codedError("INVALID_ARGUMENTS", `${label} must be an object`);
  if (control.kind === "point") {
    return {
      kind: "point",
      positionBlick: requireSafeInteger(control.positionBlick, `${label}.positionBlick`),
      pitchSemitone: requireFinite(control.pitchSemitone, `${label}.pitchSemitone`),
      generator: normalizeGenerator(control.generator, label),
    };
  }
  if (control.kind === "curve") {
    return {
      kind: "curve",
      positionBlick: requireSafeInteger(control.anchorPositionBlick, `${label}.anchorPositionBlick`),
      pitchSemitone: requireFinite(control.anchorPitchSemitone, `${label}.anchorPitchSemitone`),
      points: normalizeInputPoints(control.points, `${label}.points`),
      generator: normalizeGenerator(control.generator, label),
    };
  }
  throw codedError("INVALID_ARGUMENTS", `${label}.kind must be point or curve`);
}

function normalizeUpdateSet(set, label) {
  const normalized = {};
  if (set.positionBlick !== undefined) {
    normalized.positionBlick = requireSafeInteger(set.positionBlick, `${label}.positionBlick`);
  }
  if (set.pitchSemitone !== undefined) {
    normalized.pitchSemitone = requireFinite(set.pitchSemitone, `${label}.pitchSemitone`);
  }
  if (set.anchorPositionBlick !== undefined) {
    normalized.anchorPositionBlick = requireSafeInteger(set.anchorPositionBlick, `${label}.anchorPositionBlick`);
  }
  if (set.anchorPitchSemitone !== undefined) {
    normalized.anchorPitchSemitone = requireFinite(set.anchorPitchSemitone, `${label}.anchorPitchSemitone`);
  }
  if (set.points !== undefined) {
    normalized.points = normalizeInputPoints(set.points, `${label}.points`);
  }
  if (Object.keys(normalized).length === 0) {
    throw codedError(
      "INVALID_ARGUMENTS",
      `${label} must set at least one of positionBlick/pitchSemitone (point) or anchorPositionBlick/anchorPitchSemitone/points (curve)`
    );
  }
  return normalized;
}

function normalizeInputPoints(points, label) {
  if (!Array.isArray(points) || points.length === 0) {
    throw codedError("INVALID_ARGUMENTS", `${label} must be a non-empty array`);
  }
  if (points.length > MAX_CURVE_POINTS) {
    throw codedError("INVALID_ARGUMENTS", `${label} must contain at most ${MAX_CURVE_POINTS} points`);
  }
  return normalizeCurvePoints(
    points.map((point, index) => {
      if (!isRecord(point)) {
        throw codedError("INVALID_ARGUMENTS", `${label}[${index}] must be an object`);
      }
      return [point.timeFromAnchorBlick, point.pitchFromAnchorSemitone];
    }),
    {
      errorFactory: (message) => codedError("INVALID_ARGUMENTS", `${label}: ${message}`),
    }
  );
}

function normalizeGenerator(generator, label) {
  if (generator === undefined) return "sv_patch_pitch_controls";
  if (typeof generator !== "string" || !generator || generator.length > 100) {
    throw codedError("INVALID_ARGUMENTS", `${label}.generator must be a non-empty string up to 100 chars`);
  }
  return generator;
}

function requireSafeInteger(value, label) {
  if (!Number.isSafeInteger(value)) {
    throw codedError("INVALID_ARGUMENTS", `${label} must be a safe integer BLICK (group-local)`);
  }
  return value;
}

function requireFinite(value, label) {
  if (!Number.isFinite(value)) {
    throw codedError("INVALID_ARGUMENTS", `${label} must be a finite semitone (group-relative)`);
  }
  return value;
}

function clampInteger(value, minimum, maximum, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw codedError("INVALID_ARGUMENTS", `integer must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function elapsed(startedAt, endedAt) {
  return Math.max(0, endedAt - startedAt);
}

function isUnknownOutcomeError(error) {
  if (error?.code === "HOST_TIMEOUT" || error?.code === "HOST_DETACHED") return true;
  return /Timeout waiting|detached|disconnected|EOF/i.test(
    error instanceof Error ? error.message : String(error)
  );
}
