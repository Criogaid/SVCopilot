// MCP surface 体积测量：tools/list 与 sv_describe 的真实 minified bytes。
//
// 不再模拟"假如一次描述 4 个 operation"：describe 现在有字节预算，会整条推迟放不下
// 的 operation，因此这里直接调用真实的 facade.describe()，测出的就是模型实际收到的。
import { TOOLS } from "../server/src/index.js";
import { createCompactFacade, MAX_DESCRIBE_BYTES } from "../server/src/compact-facade.js";
import { buildOperationCatalog } from "../server/src/operation-catalog.js";

const bytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");

const facade = createCompactFacade(TOOLS);
const { operations } = buildOperationCatalog(TOOLS);
const rows = [...operations.values()]
  .map((entry) => ({
    operation: entry.operation,
    facade: entry.facade,
    schemaBytes: bytes(entry.inputSchema),
    descBytes: Buffer.byteLength(entry.description ?? "", "utf8"),
    deduped: Boolean(entry.inputSchema.$defs),
  }))
  .sort((a, b) => b.schemaBytes - a.schemaBytes);

console.log(`operations: ${rows.length}`);
console.log(`total schema bytes: ${rows.reduce((sum, r) => sum + r.schemaBytes, 0)}`);
console.log(`schemas with $defs dedupe: ${rows.filter((r) => r.deduped).length}`);

console.log(`\ntop 12 by schema bytes:`);
for (const row of rows.slice(0, 12)) {
  console.log(
    `  ${String(row.schemaBytes).padStart(7)}  ${row.deduped ? "$defs" : "     "}  ${row.facade}/${row.operation}`
  );
}
console.log(`\nbottom 5:`);
for (const row of rows.slice(-5)) {
  console.log(`  ${String(row.schemaBytes).padStart(7)}         ${row.facade}/${row.operation}`);
}

// 真实 describe 响应：最坏、中位、最好各取两个（MAX_DESCRIBE_OPERATIONS = 2）。
const mid = Math.floor(rows.length / 2);
const cases = [
  ["worst", rows.slice(0, 2)],
  ["median", rows.slice(mid, mid + 2)],
  ["best", rows.slice(-2)],
];
console.log(`\n--- real sv_describe responses (budget ${MAX_DESCRIBE_BYTES}) ---`);
for (const [label, picked] of cases) {
  const response = facade.describe(picked.map((row) => row.operation));
  const size = bytes(response);
  const deferred = response.deferred?.operations.map((item) => item.operation) ?? [];
  console.log(
    `  ${label.padEnd(7)} ${String(size).padStart(7)} bytes  ${
      size > MAX_DESCRIBE_BYTES ? "OVER BUDGET" : "within budget"
    }  returned=${response.operations.length}${deferred.length ? ` deferred=${deferred.join(",")}` : ""}`
  );
}

// 单个 operation 是否有超预算的：那种情况无法靠推迟解决，必须拆 schema。
const soloOver = rows.filter(
  (row) => bytes(facade.describe([row.operation])) > MAX_DESCRIBE_BYTES
);
console.log(`\noperations whose own describe entry exceeds the budget: ${soloOver.length}`);
for (const row of soloOver) console.log(`  ${row.schemaBytes}  ${row.operation}`);

// tools/list：内部 handler 全量 vs 实际服务的 facade。
const directBytes = bytes(
  TOOLS.map(({ name, description, inputSchema, annotations }) => ({
    name,
    description,
    inputSchema,
    annotations,
  }))
);
const facadeBytes = bytes(facade.tools);
console.log(`\ntools/list if every handler were exposed: ${directBytes} bytes (${TOOLS.length} tools)`);
console.log(`tools/list actually served:              ${facadeBytes} bytes (${facade.tools.length} tools)`);
console.log(`reduction: ${((1 - facadeBytes / directBytes) * 100).toFixed(1)}%`);
