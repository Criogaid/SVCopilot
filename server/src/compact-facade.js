// compact-v2 facade：把 41 个 direct tool 的元数据收敛成少量 facade 工具，
// 同时不复制、不改写任何业务 schema。
//
// 三条不可让步的规则：
//   1. facade 不实现业务逻辑。它只做「operation 名 → direct tool 名」的解析，
//      随后交回 index.js 的同一个 dispatch 函数。
//   2. facade 不放宽校验。arguments 用 direct tool 的同一个 Ajv validator 校验，
//      因此 planRef / context guard / shared-target confirmation / dryRun /
//      responseMode / artifact projection 全部照原样生效——facade 没有能力绕过它们。
//   3. 未知 operation 在进入任何 handler 之前失败。
//
// 刻意没有 `sv_delete`：当前 41 个工具里没有「只删除」的工具（`sv_restructure_notes`
// 的 delete 是混合 patch 的一种 op，`sv_release_artifact` 释放的是本进程 artifact，
// 不触及工程）。为一个空 enum 造一个工具只会增加元数据而不增加能力，等真正出现
// 独立删除工具（Phase 4 的 `sv_delete_note_group` 等）时再加。

import { FACADE_ORDER, buildOperationCatalog, operationNameForTool } from "./operation-catalog.js";

export const DESCRIBE_OPERATION_TOOL = "sv_describe_operation";

// 一次 describe 默认只返回 1 个 operation schema，避免 facade 省下的元数据
// 又被一次巨大的 describe 响应吃回去。
export const MAX_DESCRIBE_OPERATIONS = 4;

const FACADE_DESCRIPTIONS = {
  status: "Health check and official Synthesizer V API documentation lookup.",
  read: "Read project, range, curve, voice, and analysis data. Never mutates the project.",
  plan: "Compute an in-memory plan and return an apply envelope. Never mutates the project.",
  edit: "Commit a verified mutation to the project or editor state.",
  audition: "Non-blocking human playback control and A/B comparison.",
  artifact: "Release an immutable artifact lease early.",
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
  const { operations, facades, excluded } = buildOperationCatalog(tools);

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
      // 给出该 facade 自己接受的清单，而不是全部 36 个：模型需要的是下一步能打什么。
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
    const described = [];
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
      described.push({
        operation: entry.operation,
        facade: entry.facade,
        tool: entry.tool,
        summary: entry.summary,
        annotations: entry.annotations,
        inputSchema: entry.inputSchema,
      });
    }
    return { ok: true, status: "succeeded", operations: described };
  }

  function catalog(interfaceVersion) {
    return {
      schemaVersion: interfaceVersion,
      profile: "compact-v2",
      describeTool: DESCRIBE_OPERATION_TOOL,
      maxDescribeOperations: MAX_DESCRIBE_OPERATIONS,
      // 语义与 direct tool 完全一致：facade 只做路由，不改变任何前置条件或失败模型。
      routing: "facade_resolves_operation_then_calls_the_same_direct_tool_handler",
      facades: facadeTools
        .filter((tool) => tool.name !== DESCRIBE_OPERATION_TOOL)
        .map((tool) => ({
          facade: tool.name,
          annotations: tool.annotations,
          operations: tool.inputSchema.properties.operation.enum.map((name) => {
            const entry = operations.get(name);
            return { operation: name, tool: entry.tool, summary: entry.summary };
          }),
        })),
      // 明确告知哪些能力不在 compact profile 内，避免模型以为它们不存在。
      excludedTools: {
        tools: [...excluded].sort(),
        reason: "raw_dispatcher_and_generic_workflow_stay_in_the_raw_or_full_profile",
      },
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
