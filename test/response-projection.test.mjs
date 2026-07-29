import assert from "node:assert";
import { project, registerProjection, registeredProjectionKinds } from "../server/src/response-projection.js";

// 注册前必须提供 summarize。
{
  assert.throws(() => registerProjection("x", {}), /summarize/);
}

// 完整 policy 走通三种 mode。
registerProjection("test-range", {
  summarize: (canonical) => ({ noteCount: canonical.notes.length }),
  chooseRepresentativeItems: (canonical) => ({ firstNote: canonical.notes[0] }),
  paginateDetail: (canonical) => ({ allNotes: canonical.notes }),
});

const canonical = { notes: [{ id: "n1" }, { id: "n2" }, { id: "n3" }] };

// compact：只有 summary。
{
  const result = project({ kind: "test-range", canonical, mode: "compact" });
  assert.deepStrictEqual(result.summary, { noteCount: 3 });
  assert.strictEqual(result.representative, undefined);
  assert.strictEqual(result.detail, undefined);
}

// standard：summary + representative。
{
  const result = project({ kind: "test-range", canonical, mode: "standard" });
  assert.deepStrictEqual(result.summary, { noteCount: 3 });
  assert.deepStrictEqual(result.representative, { firstNote: { id: "n1" } });
  assert.strictEqual(result.detail, undefined);
}

// audit：summary + representative + detail。
{
  const result = project({ kind: "test-range", canonical, mode: "audit" });
  assert.deepStrictEqual(result.summary, { noteCount: 3 });
  assert.deepStrictEqual(result.representative, { firstNote: { id: "n1" } });
  assert.deepStrictEqual(result.detail, { allNotes: [{ id: "n1" }, { id: "n2" }, { id: "n3" }] });
}

// 未注册 kind 报错。
{
  assert.throws(() => project({ kind: "unknown", canonical: {} }), /unknown projection kind/);
  assert.throws(
    () => project({ kind: "test-range", canonical, mode: "verbose" }),
    /unsupported projection mode/
  );
}

// kind 列表包含 test-range。
{
  assert.ok(registeredProjectionKinds().includes("test-range"));
}

console.log("response-projection.test.mjs passed");
