// 人类可读投影；全部数值来自 benchmark 的唯一测量路径。
import { measureEfficiencySurface } from "./benchmark-mcp-efficiency.mjs";

const report = await measureEfficiencySurface();
const schemas = report.operationSchemas;
const served = report.servedMcp;

console.log(`operations: ${schemas.operationCount}`);
console.log(`total schema bytes: ${schemas.totalSchemaBytes}`);
console.log(`schemas with $defs dedupe: ${schemas.schemasWithDefs}`);

console.log("\ntop 12 by schema bytes:");
for (const row of schemas.largestOperations) {
  console.log(
    `  ${String(row.schemaBytes).padStart(7)}  ${row.deduped ? "$defs" : "     "}  ${row.facade}/${row.operation}`
  );
}

console.log(`\n--- real sv_describe responses (budget ${served.maxDescribeBytes}) ---`);
for (const item of served.describeCases) {
  const deferred = item.deferred.length > 0 ? ` deferred=${item.deferred.join(",")}` : "";
  console.log(
    `  ${item.label.padEnd(7)} ${String(item.responseBytes).padStart(7)} bytes  returned=${item.returned}${deferred}`
  );
}

console.log(`\noperations whose own describe entry exceeds the budget: ${served.soloOverBudget.length}`);
for (const operation of served.soloOverBudget) console.log(`  ${operation}`);

console.log(
  `\ninternal handler inventory: ${schemas.minifiedBytes} bytes (${schemas.handlerCount} handlers)`
);
console.log(
  `tools/list actually served: ${served.toolsList.minifiedBytes} bytes (${served.toolsList.toolCount} tools)`
);
console.log(`reduction: ${served.reductionVsInternalPercent}%`);
