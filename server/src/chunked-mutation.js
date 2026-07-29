// 服务端内部批量 mutation runner：把多个 chunk 合并为一个逻辑事务。
// 调用方负责 Undo 边界、业务预检和具体写入；runner 负责顺序、逆序补偿与结果诚实性。

function codedError(code, message) {
  const error = new Error(`[${code}] ${message}`);
  error.code = code;
  return error;
}

export async function runChunkedMutation({
  prepareJournal,
  chunks,
  applyChunk,
  verifyAll,
  rollbackChunk,
  verifyRollback,
  classifyUnknownOutcome = () => "outcome_unknown",
  shouldRollback = () => true,
}) {
  validateCallbacks({
    prepareJournal,
    chunks,
    applyChunk,
    verifyAll,
    rollbackChunk,
    verifyRollback,
    shouldRollback,
  });

  let journal;
  try {
    journal = await prepareJournal();
  } catch (error) {
    return {
      ok: false,
      status: "failed",
      effects: "none",
      chunksAttempted: 0,
      chunksApplied: 0,
      error: serializeError(error),
    };
  }

  const attempted = [];
  const applied = [];
  let failure = null;
  try {
    for (let index = 0; index < chunks.length; index += 1) {
      // 宿主调用抛错也可能已产生副作用，因此调用前就纳入补偿集合。
      attempted.push(index);
      const result = await applyChunk(chunks[index], journal, index);
      if (!result?.ok) {
        failure = {
          phase: "apply",
          index,
          error: result?.error ?? codedError("CHUNK_APPLY_FAILED", `chunk ${index} failed`),
        };
        break;
      }
      applied.push(index);
    }

    if (!failure) {
      const verification = await verifyAll(journal);
      if (!verification?.ok) {
        failure = {
          phase: "verify",
          error: verification?.error ?? codedError("POSTCONDITION_FAILED", "verification failed"),
        };
      }
    }
  } catch (error) {
    failure = {
      phase: "unknown",
      index: attempted.at(-1) ?? null,
      error,
      classifiedStatus: classifyUnknownOutcome(error),
    };
  }

  if (!failure) {
    return {
      ok: true,
      status: "succeeded",
      effects: "verified",
      chunksAttempted: attempted.length,
      chunksApplied: applied.length,
      rollback: { attempted: false, verified: null, failures: [] },
    };
  }

  if (!shouldRollback(failure.error, failure)) {
    const status = failure.classifiedStatus ?? classifyUnknownOutcome(failure.error);
    return {
      ok: false,
      status,
      effects: status === "outcome_unknown" ? "unknown" : "may_remain",
      chunksAttempted: attempted.length,
      chunksApplied: applied.length,
      failedChunkIndex: failure.index ?? null,
      error: serializeError(failure.error),
      rollback: { attempted: false, verified: null, failures: [] },
    };
  }

  const rollbackFailures = [];
  for (const index of [...attempted].reverse()) {
    try {
      const result = await rollbackChunk(chunks[index], journal, index);
      if (result?.ok === false) {
        rollbackFailures.push({ index, error: serializeError(result.error ?? "rollback rejected") });
      }
    } catch (error) {
      rollbackFailures.push({ index, error: serializeError(error) });
    }
  }

  let rollbackVerification = null;
  if (rollbackFailures.length === 0 && verifyRollback) {
    try {
      rollbackVerification = await verifyRollback(journal);
    } catch (error) {
      rollbackVerification = { ok: false, error: serializeError(error) };
    }
  }
  const rollbackVerified = rollbackVerification?.ok === true;
  const rollbackFailed =
    rollbackFailures.length > 0 || (verifyRollback && rollbackVerification?.ok !== true);
  const status = rollbackVerified
    ? "rolled_back"
    : rollbackFailed
      ? "rollback_failed"
      : failure.classifiedStatus ?? "rollback_unverified";

  return {
    ok: false,
    status,
    effects: rollbackVerified ? "none" : rollbackFailed ? "may_remain" : "unknown",
    chunksAttempted: attempted.length,
    chunksApplied: applied.length,
    failedChunkIndex: failure.index ?? null,
    error: serializeError(failure.error),
    rollback: {
      attempted: attempted.length > 0,
      verified: verifyRollback ? rollbackVerified : null,
      failures: rollbackFailures,
      ...(rollbackVerification?.evidence !== undefined
        ? { evidence: rollbackVerification.evidence }
        : {}),
      ...(rollbackVerification?.error !== undefined
        ? { verificationError: serializeError(rollbackVerification.error) }
        : {}),
    },
  };
}

function validateCallbacks({
  prepareJournal,
  chunks,
  applyChunk,
  verifyAll,
  rollbackChunk,
  verifyRollback,
  shouldRollback,
}) {
  if (!Array.isArray(chunks)) throw codedError("INVALID_ARGUMENTS", "chunks must be an array");
  for (const [name, value] of Object.entries({
    prepareJournal,
    applyChunk,
    verifyAll,
    rollbackChunk,
  })) {
    if (typeof value !== "function") {
      throw codedError("INVALID_ARGUMENTS", `${name} must be a function`);
    }
  }
  if (verifyRollback !== undefined && typeof verifyRollback !== "function") {
    throw codedError("INVALID_ARGUMENTS", "verifyRollback must be a function");
  }
  if (typeof shouldRollback !== "function") {
    throw codedError("INVALID_ARGUMENTS", "shouldRollback must be a function");
  }
}

function serializeError(error) {
  if (error && typeof error === "object") {
    return {
      code: typeof error.code === "string" ? error.code : "OPERATION_FAILED",
      message: error instanceof Error ? error.message : String(error.message ?? error),
      ...(typeof error.phase === "string" ? { phase: error.phase } : {}),
      ...(Number.isSafeInteger(error.curveIndex) ? { curveIndex: error.curveIndex } : {}),
      ...(typeof error.parameter === "string" ? { parameter: error.parameter } : {}),
      ...(typeof error.requestedParameter === "string"
        ? { requestedParameter: error.requestedParameter }
        : {}),
      ...(typeof error.resolvedParameter === "string"
        ? { resolvedParameter: error.resolvedParameter }
        : {}),
    };
  }
  return { code: "OPERATION_FAILED", message: String(error) };
}
