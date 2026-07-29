import assert from "node:assert";
import { runChunkedMutation } from "../server/src/chunked-mutation.js";

// 所有 chunk 成功。
{
  const applied = [];
  const result = await runChunkedMutation({
    prepareJournal: async () => ({ value: 0 }),
    chunks: [1, 2, 3],
    applyChunk: async (chunk, journal) => {
      journal.value += chunk;
      applied.push(chunk);
      return { ok: true };
    },
    verifyAll: async (journal) => ({ ok: true, value: journal.value }),
    rollbackChunk: async () => {},
    verifyRollback: async () => ({ ok: true }),
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.status, "succeeded");
  assert.strictEqual(result.chunksApplied, 3);
  assert.deepStrictEqual(applied, [1, 2, 3]);
}

// 当前 chunk 写后返回失败时也必须参与逆序补偿。
{
  const state = { value: 0 };
  const applied = [];
  const rolledBack = [];
  const result = await runChunkedMutation({
    prepareJournal: async () => ({ before: state.value }),
    chunks: [1, 2, 3],
    applyChunk: async (chunk) => {
      state.value += chunk;
      applied.push(chunk);
      if (chunk === 2) return { ok: false, error: "chunk 2 failed after write" };
      return { ok: true };
    },
    verifyAll: async () => ({ ok: true }),
    rollbackChunk: async (chunk, _journal, index) => {
      state.value -= chunk;
      rolledBack.push({ chunk, index });
    },
    verifyRollback: async (journal) => ({ ok: state.value === journal.before }),
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.status, "rolled_back");
  assert.strictEqual(result.effects, "none");
  assert.strictEqual(state.value, 0);
  assert.deepStrictEqual(applied, [1, 2]);
  assert.deepStrictEqual(rolledBack, [
    { chunk: 2, index: 1 },
    { chunk: 1, index: 0 },
  ]);
}

// 验证失败触发逆序补偿。
{
  const rolledBack = [];
  const result = await runChunkedMutation({
    prepareJournal: async () => ({}),
    chunks: [1, 2, 3],
    applyChunk: async () => ({ ok: true }),
    verifyAll: async () => ({ ok: false, error: "verification failed" }),
    rollbackChunk: async (chunk, journal, index) => {
      rolledBack.push(index);
    },
    verifyRollback: async () => ({ ok: true }),
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.status, "rolled_back");
  assert.deepStrictEqual(rolledBack, [2, 1, 0]);
}

// 回滚异常必须进入结构化证据，不能谎报 rolled_back。
{
  const result = await runChunkedMutation({
    prepareJournal: async () => ({}),
    chunks: [1],
    applyChunk: async () => {
      throw new Error("transport lost after write");
    },
    verifyAll: async () => ({ ok: true }),
    rollbackChunk: async () => {
      throw new Error("rollback transport lost");
    },
    verifyRollback: async () => ({ ok: true }),
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.status, "rollback_failed");
  assert.strictEqual(result.effects, "may_remain");
  assert.strictEqual(result.rollback.verified, false);
  assert.strictEqual(result.rollback.failures.length, 1);
}

// 宿主结果未知时，调用方可禁止盲目补偿。
{
  const rollbackOrder = [];
  const result = await runChunkedMutation({
    prepareJournal: async () => ["old"],
    chunks: ["a"],
    applyChunk: async () => {
      const error = new Error("bridge detached");
      error.code = "HOST_DISCONNECTED";
      throw error;
    },
    verifyAll: async () => ({ ok: true }),
    rollbackChunk: async (_chunk, _journal, index) => {
      rollbackOrder.push(index);
      return { ok: true };
    },
    shouldRollback: () => false,
    classifyUnknownOutcome: () => "outcome_unknown",
  });
  assert.strictEqual(result.status, "outcome_unknown");
  assert.strictEqual(result.effects, "unknown");
  assert.strictEqual(result.rollback.attempted, false);
  assert.deepStrictEqual(rollbackOrder, []);
}

console.log("chunked-mutation.test.mjs passed");
