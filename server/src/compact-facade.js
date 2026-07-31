// 唯一 MCP surface：把 42 个 direct tool 的元数据收敛成 8 个 facade 工具，
// 同时不复制、不改写任何业务 schema。
//
// 三条不可让步的规则：
//   1. facade 不实现业务逻辑。它只做「operation 名 → direct tool 名」的解析，
//      随后交回 index.js 的同一个 dispatch 函数。
//   2. facade 不放宽校验。arguments 用 direct tool 的同一个 Ajv validator 校验，
//      因此 planRef / context guard / shared-target confirmation / dryRun /
//      artifact projection 全部照原样生效——facade 没有能力绕过它们。
//   3. 未知 operation 在进入任何 handler 之前失败。
//
// 刻意没有 `sv_delete`：当前没有「只删除」的工具（`sv_restructure_notes` 的 delete
// 是混合 patch 的一种 op，artifact release 释放的是本进程 artifact，不触及工程）。
// 为一个空 enum 造一个工具只会增加元数据而不增加能力。

import { FACADE_ORDER, buildOperationCatalog, operationNameForTool } from "./operation-catalog.js";

export const DESCRIBE_OPERATION_TOOL = "sv_describe";

// 一次最多请求 2 个 operation。这只是上界，真正的约束是下面的字节预算。
export const MAX_DESCRIBE_OPERATIONS = 2;

// 单次 describe 响应的字节预算，与 artifact 直读上限一致。条数上限拦不住体积：
// 最大的两份 schema 即使 $defs 去重后仍有约 18 KiB，所以预算必须按字节判定。
export const MAX_DESCRIBE_BYTES = 16 * 1024;

const FACADE_DESCRIPTIONS = {
  status: "Health check and official Synthesizer V API documentation lookup.",
  read: "Read project, range, curve, voice, and analysis data. Never mutates the project.",
  plan: "Compute an in-memory plan and return an apply envelope. Never mutates the project.",
  edit: "Commit a verified mutation to the project or editor state.",
  audition: "Non-blocking human playback control and A/B comparison.",
  artifact: "Read or release an immutable artifact lease.",
  raw: "Escape hatch for official SV2 API surface the high-level tools do not cover yet. Host-native indexing and semantics; integer handles.",
};

/**
 * 构建 compact facade。
 *
 * @param {object[]} tools - index.js 的完整 TOOLS 数组
 * @returns {{
 *   tools: object[],
 *   toolNames: string[],
 *   resolveOperation: (facadeTool: string, operation: string) => object,
 *   describe: (operations: string[]) => object,
 *   catalog: object,
 * }}
 */
export function createCompactFacade(tools) {
  const { operations, facades } = buildOperationCatalog(tools);

  const facadeTools = [];
  for (const group of FACADE_ORDER) {
    const groupOperations = facades.get(group);
    // 没有 operation 的分组不产出工具：空 enum 是死元数据。
    if (!groupOperations || groupOperations.length === 0) continue;
    const names = groupOperations.map((operation) => operation.operation).sort();
    facadeTools.push({
      name: `sv_${group}`,
      description: `${FACADE_DESCRIPTIONS[group]} Read ${DESCRIBE_OPERATION_TOOL} for one operation's exact arguments schema before calling it.`,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          operation: { enum: names },
          arguments: {
            type: "object",
            description: `Arguments for the chosen operation, validated against the same schema the direct tool uses. Get it from ${DESCRIBE_OPERATION_TOOL}.`,
          },
        },
        required: ["operation"],
      },
      annotations: groupAnnotations(groupOperations),
    });
  }

  facadeTools.push({
    name: DESCRIBE_OPERATION_TOOL,
    description:
      "Read the exact arguments schema for named operations. Call this before a first-time operation instead of guessing fields.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        operations: {
          type: "array",
          items: { type: "string", minLength: 1 },
          minItems: 1,
          maxItems: MAX_DESCRIBE_OPERATIONS,
        },
      },
      required: ["operations"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  });

  const facadeByName = new Map(facadeTools.map((tool) => [tool.name, tool]));

  function resolveOperation(facadeTool, operation) {
    const entry = operations.get(operation);
    if (!entry) {
      const error = new Error(
        `unknown operation "${operation}"; call ${DESCRIBE_OPERATION_TOOL} or read svcopilot://operations`
      );
      error.code = "UNKNOWN_OPERATION";
      // 给出该 facade 自己接受的清单，而不是全部 42 个：模型需要的是下一步能打什么。
      error.details = {
        facadeOperations: (facades.get(facadeTool.replace(/^sv_/, "")) ?? [])
          .map((candidate) => candidate.operation)
          .sort(),
      };
      throw error;
    }
    // operation 存在但属于另一个 facade 分组时不静默转发：分组本身携带
    // read-only / destructive 语义，跨组调用会让 annotations 变成谎言。
    if (entry.facade !== facadeTool) {
      const error = new Error(
        `operation "${operation}" belongs to ${entry.facade}, not ${facadeTool}`
      );
      error.code = "UNKNOWN_OPERATION";
      throw error;
    }
    return entry;
  }

  function describe(requested) {
    const seen = new Set();
    const resolved = [];
    for (const name of requested) {
      if (seen.has(name)) continue;
      seen.add(name);
      const entry = operations.get(name);
      if (!entry) {
        const error = new Error(`unknown operation "${name}"`);
        error.code = "UNKNOWN_OPERATION";
        error.details = { availableOperations: [...operations.keys()].sort() };
        throw error;
      }
      resolved.push({
        operation: entry.operation,
        // `facade` 不再返回：`tool` 已完整表达同一信息。
        tool: entry.facade,
        // 完整描述而不是首句摘要：Undo 边界、human_only、能力缺口等安全语义都在
        // description 里，模型没有别的地方能读到它们。
        description: entry.description,
        annotations: entry.annotations,
        inputSchema: entry.inputSchema,
      });
    }

    // 字节预算按整个 operation 取舍，绝不截断 schema：一份被截断的 schema 看起来
    // 仍然可用，模型照它构造的请求却必然被 Ajv 拒绝——那比"这次没给你"更糟。
    // 第一个 operation 无论多大都要返回，否则请求会毫无进展。
    const described = [];
    const deferred = [];
    let budget = MAX_DESCRIBE_BYTES;
    for (const item of resolved) {
      const size = Buffer.byteLength(JSON.stringify(item), "utf8");
      if (described.length > 0 && size > budget) {
        deferred.push({ operation: item.operation, bytes: size });
        continue;
      }
      described.push(item);
      budget -= size;
    }

    return {
      status: "succeeded",
      operations: described,
      ...(deferred.length > 0
        ? {
            // 如实报告被推迟的部分及其体积，并给出可执行的下一步，而不是静默丢弃。
            deferred: {
              operations: deferred,
              reason: "response_byte_budget_exhausted",
              budgetBytes: MAX_DESCRIBE_BYTES,
              remedy: "call sv_describe again with these operations alone",
            },
          }
        : {}),
    };
  }

  function catalog(interfaceVersion) {
    return {
      schemaVersion: interfaceVersion,
      describeTool: DESCRIBE_OPERATION_TOOL,
      maxDescribeOperations: MAX_DESCRIBE_OPERATIONS,
      // 语义与内部 handler 完全一致：facade 只做路由，不改变任何前置条件或失败模型。
      routing: "facade_resolves_operation_then_calls_the_same_handler",
      facades: facadeTools
        .filter((tool) => tool.name !== DESCRIBE_OPERATION_TOOL)
        .map((tool) => ({
          facade: tool.name,
          annotations: tool.annotations,
          operations: tool.inputSchema.properties.operation.enum.map((name) => {
            const entry = operations.get(name);
            return { operation: name, summary: entry.summary };
          }),
        })),
    };
  }

  return {
    tools: facadeTools,
    toolNames: facadeTools.map((tool) => tool.name),
    isFacadeTool: (name) => facadeByName.has(name),
    resolveOperation,
    describe,
    catalog,
    operationNames: [...operations.keys()].sort(),
    // operation 总数从这里派生，不在别处硬编码。
    operationCount: operations.size,
  };
}

// facade 的 annotations 必须是分组内最保守的取值：
// 只有全部 operation 只读时才敢声明 readOnlyHint，任一 destructive 即整组 destructive。
function groupAnnotations(groupOperations) {
  return {
    readOnlyHint: groupOperations.every((entry) => entry.annotations?.readOnlyHint === true),
    destructiveHint: groupOperations.some((entry) => entry.annotations?.destructiveHint === true),
    idempotentHint: groupOperations.every((entry) => entry.annotations?.idempotentHint === true),
  };
}

export { operationNameForTool };
