// Plan 执行 ledger：同一个 planRef 不得被重复 commit（计划 §4.3.1）。
//
// Plan Artifact 是不可变的，所以执行状态不能写回 artifact 本身——那会让"不可变"
// 变成一句空话，也让 contentHash 不再稳定。因此执行状态放在这个独立、有配额的
// ledger 里，与 artifact 同租期、同实例隔离。
//
// 为什么必须有它：没有 ledger 时同一个 planRef 可以被无限次 commit，而重放对某些
// mutation 不是幂等的。最直接的例子是 `mode:"add"` 的曲线补丁——它按相对量叠加，
// Note fingerprint 并未改变，因此第二次 commit 能照样通过 live preflight，然后把
// 同一段 Automation 再加一遍。preflight 无法发现这一点：工程状态确实符合计划的前提，
// 只是计划已经生效过了。这个信息只存在于"我们是否已经执行过"，别处没有。
//
// 状态机（§4.3.1）：
//   sealed → dry_run_seen → committing → committed | rolled_back | uncertain
//
// `committing` 是必需的中间态而不是实现细节：宿主调用可能在返回前失败或超时，
// 那时我们既不能说"已提交"也不能说"未提交"。落在 committing 上的 planRef 一律
// 禁止重放——重放会在一个未知状态上再叠一次写入。

export const PLAN_LEDGER_STATES = Object.freeze([
  "sealed",
  "dry_run_seen",
  "committing",
  "committed",
  "rolled_back",
  "uncertain",
]);

// 终态：到达后该 planRef 永久不可再 commit。
const TERMINAL_STATES = new Set(["committed", "rolled_back", "uncertain"]);

// 允许 commit 的前置状态。只有 dry_run_seen——sealed 表示还没 dry-run 过。
const COMMITTABLE_STATES = new Set(["dry_run_seen"]);

// 结果 status -> 终态。矩阵（result-status.js）里的写入结论在这里落到 ledger 上。
const TERMINAL_BY_STATUS = Object.freeze({
  succeeded: "committed",
  no_change: "committed",
  // 补偿已读回验证成功：宿主回到原状，但正确的下一步仍是重新快照再规划，
  // 因此不允许重放同一 payload（§4.5 的 retryable 语义）。
  rolled_back: "rolled_back",
  // 以下三类都无法证明宿主的最终状态，重放会在未知之上再写一次。
  rollback_failed: "uncertain",
  partial: "uncertain",
  outcome_unknown: "uncertain",
  // 零写入的失败：计划仍然可以在修正外部条件后重试，因此回到 dry_run_seen 而非终态。
  failed: null,
  conflict: null,
});

export class PlanExecutionLedger {
  /**
   * @param {object} [options]
   * @param {() => number} [options.now]
   * @param {number} [options.ttlMs] - 与 Artifact 租期一致；过期条目按 TTL 回收
   * @param {number} [options.maxEntries] - 条数配额，避免无界增长
   */
  constructor({ now = () => Date.now(), ttlMs = 60 * 60 * 1000, maxEntries = 256 } = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.entries = new Map();
  }

  /**
   * 登记一个刚封存的 plan。重复 seal 同一个 planRef 是实现 bug（artifactId 是随机的）。
   *
   * @param {string} planRef
   * @param {object} [options]
   * @param {string} [options.ownerInstanceId] - 与 ArtifactStore 同一个实例归属键
   */
  register(planRef, { ownerInstanceId = null } = {}) {
    this._prune();
    if (this.entries.has(planRef)) {
      throw codedError("PLAN_ALREADY_REGISTERED", `planRef already in the ledger: ${planRef}`);
    }
    this.entries.set(planRef, {
      state: "sealed",
      ownerInstanceId,
      registeredAt: this.now(),
      expiresAt: this.now() + this.ttlMs,
      dryRunCount: 0,
      commitAttempts: 0,
    });
    this._enforceQuota(planRef);
    return this.entries.get(planRef);
  }

  /**
   * @param {string} planRef
   * @returns {object|null}
   */
  get(planRef) {
    this._prune();
    return this.entries.get(planRef) ?? null;
  }

  /**
   * dry-run 可重复执行且不推进终态（§4.3.1 规则 1）：它零 setter、零 Undo，
   * 反复审阅同一个计划是正常用法。
   *
   * @param {string} planRef
   * @param {object} [options]
   * @param {string} [options.ownerInstanceId]
   */
  noteDryRun(planRef, { ownerInstanceId = null } = {}) {
    const entry = this._require(planRef, ownerInstanceId);
    if (TERMINAL_STATES.has(entry.state)) {
      // 终态后连 dry-run 都不该继续：计划已经生效（或状态未知），再"预览"它
      // 只会让调用方以为还能提交。
      throw codedError(
        "PLAN_ALREADY_EXECUTED",
        `planRef is ${entry.state}; re-snapshot and re-plan instead of reusing it`
      );
    }
    entry.dryRunCount += 1;
    entry.state = "dry_run_seen";
    return entry;
  }

  /**
   * 进入 commit。未经 dry-run 的 commit 被拒绝（§4.3.1 规则 2）——这把「先 dry-run
   * 再 commit」从文档建议变成服务端强制约束。
   *
   * 返回的 token 必须在写入结束后交给 settle()，否则条目会永久停在 committing，
   * 从而拒绝一切后续 commit。那是刻意的失败方向：宁可要求重新规划，也不在
   * 未知状态上重放写入。
   *
   * @param {string} planRef
   * @param {object} [options]
   * @param {string} [options.ownerInstanceId]
   */
  beginCommit(planRef, { ownerInstanceId = null } = {}) {
    const entry = this._require(planRef, ownerInstanceId);
    if (TERMINAL_STATES.has(entry.state) || entry.state === "committing") {
      throw codedError(
        "PLAN_ALREADY_EXECUTED",
        `planRef is ${entry.state}; a sealed plan may be committed at most once`
      );
    }
    if (!COMMITTABLE_STATES.has(entry.state)) {
      throw codedError(
        "PLAN_DRY_RUN_REQUIRED",
        "submit the same planRef with action:\"dry_run\" and read plannedDiff before committing"
      );
    }
    entry.state = "committing";
    entry.commitAttempts += 1;
    return entry;
  }

  /**
   * 用写入结果推进终态。零写入的失败（failed/conflict）退回 dry_run_seen：
   * 计划本身仍然有效，修正外部条件后可以再提交。
   *
   * @param {string} planRef
   * @param {string} status - 冻结矩阵里的 status
   * @param {object} [options]
   * @param {string} [options.ownerInstanceId]
   */
  settle(planRef, status, { ownerInstanceId = null } = {}) {
    const entry = this._require(planRef, ownerInstanceId);
    if (!Object.hasOwn(TERMINAL_BY_STATUS, status)) {
      throw codedError(
        "INVALID_ARGUMENTS",
        `status "${status}" cannot settle a plan ledger entry; it is not a write conclusion`
      );
    }
    const terminal = TERMINAL_BY_STATUS[status];
    entry.state = terminal ?? "dry_run_seen";
    entry.settledStatus = status;
    return entry;
  }

  /**
   * 可观测面，供 doctor 报告。
   */
  stats() {
    this._prune();
    const byState = Object.create(null);
    for (const entry of this.entries.values()) {
      byState[entry.state] = (byState[entry.state] ?? 0) + 1;
    }
    return { entries: this.entries.size, byState, ttlMs: this.ttlMs, maxEntries: this.maxEntries };
  }

  _require(planRef, ownerInstanceId) {
    this._prune();
    const entry = this.entries.get(planRef);
    if (!entry) {
      // 找不到条目与"artifact 已过期"是同一个结论：无法证明这个计划没被执行过，
      // 因此不能放行 commit。
      throw codedError(
        "UNKNOWN_PLAN_REF",
        `planRef is not in the execution ledger (expired or never sealed): ${planRef}`
      );
    }
    if (ownerInstanceId !== null && entry.ownerInstanceId !== null && entry.ownerInstanceId !== ownerInstanceId) {
      throw codedError("PLAN_TARGET_MISMATCH", "planRef belongs to a different server instance");
    }
    return entry;
  }

  _enforceQuota(protectedRef) {
    while (this.entries.size > this.maxEntries) {
      const victim = [...this.entries.keys()].find((key) => key !== protectedRef);
      if (victim === undefined) break;
      this.entries.delete(victim);
    }
  }

  _prune() {
    const now = this.now();
    for (const [planRef, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(planRef);
    }
  }
}

function codedError(code, message) {
  const error = new Error(`[${code}] ${message}`);
  error.code = code;
  return error;
}
