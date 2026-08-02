// 统一 MCP 工具结果编码。
//
// structuredContent 是唯一完整的机器结果；content[0].text 只是一行状态摘要。
// 早期实现把完整 JSON.stringify 同时写进两处，wire bytes 精确是 payload 的两倍，
// 而两路承载的信息完全相同——这是全链路最便宜的一处浪费。
import { omitDerivableFields } from "./envelope-omission.js";
import {
  assertStatusEnvelope,
  fillCanonicalEffects,
  isErrorStatus,
  projectStatusEnvelope,
} from "./result-status.js";
import { classifyRootField } from "./root-envelope.js";

const TEXT_SUMMARY_MAX_BYTES = 512;

export { isErrorStatus };

/**
 * 测量一个 MCP 结果对象的字节成本。
 *
 * @param {object} result - 已封装成 { content, structuredContent, ... } 的结果
 * @returns {{ textUtf8Bytes: number, structuredUtf8Bytes: number, envelopeUtf8Bytes: number }}
 */
export function measureToolEnvelope(result) {
  const textUtf8Bytes = Buffer.byteLength(result.content?.[0]?.text ?? "", "utf8");
  const structuredUtf8Bytes = Buffer.byteLength(
    JSON.stringify(result.structuredContent ?? null),
    "utf8"
  );
  const envelopeUtf8Bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
  return { textUtf8Bytes, structuredUtf8Bytes, envelopeUtf8Bytes };
}

/**
 * content[0].text 与 structuredContent 的重复字节数。门禁要求恒为 0：
 * 摘要行只允许携带 status 和关键短引用，不得复制整个 payload。
 *
 * @param {object} result
 * @returns {number}
 */
export function fullPayloadDuplicationBytes(result) {
  const text = result.content?.[0]?.text ?? "";
  if (result.structuredContent === undefined) return 0;
  const structured = JSON.stringify(result.structuredContent);
  return text.includes(structured) ? Buffer.byteLength(structured, "utf8") : 0;
}

function truncateUtf8(value, maxBytes) {
  const text = String(value);
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const buffer = Buffer.from(text, "utf8");
  // 截断必须落在码点边界：直接切字节会产出替换字符。
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString("utf8");
}

function shortReference(value) {
  if (typeof value !== "string" || value === "") return null;
  return value;
}

function buildStatusLine(structured) {
  if (structured === null || typeof structured !== "object" || Array.isArray(structured)) {
    return "succeeded";
  }

  const data = structured.data && typeof structured.data === "object" ? structured.data : {};
  const parts = [structured.status ?? (structured.error ? "failed" : "succeeded")];

  const error = structured.error;
  if (error && typeof error === "object") {
    for (const key of ["code", "path", "reason"]) {
      const reference = shortReference(error[key]);
      if (reference) parts.push(reference);
    }
    return parts.join(" ");
  }

  const apply = structured.apply ?? data.apply;
  if (apply && typeof apply === "object") {
    const operation = shortReference(apply.operation ?? apply.tool);
    if (operation) parts.push(`apply=${operation}`);
    const planRef = shortReference(apply.planRef);
    if (planRef) parts.push(planRef);
  }

  for (const key of ["contextId", "id"]) {
    const reference = shortReference(structured[key] ?? data[key]);
    if (reference) parts.push(reference);
  }

  return parts.join(" ");
}

/**
 * 单行状态摘要：`<status> <关键短引用>`，不是 JSON。
 *
 * @param {unknown} structured
 * @returns {string}
 */
export function summarizeLine(structured) {
  const line = buildStatusLine(structured).replace(/[\r\n]+/g, " ").trim();
  return truncateUtf8(line, TEXT_SUMMARY_MAX_BYTES);
}

/**
 * 把迁移期仍在根级的业务字段收进 `data`（计划 §10.2.1 / §15 步骤 5）。
 *
 * 为什么在编码器而不是在每个服务里做：根信封的字段全集是一条**跨 operation** 的
 * 契约，而每个服务只知道自己返回什么。分散到 40 多处 return 去改，等于把同一条规则
 * 抄 40 遍，并且下一个新服务默认又是违规的。这里是所有 MCP 结果的唯一出口，因此
 * 在这里折叠一次，契约就对整个 surface 成立。
 *
 * 三条边界：
 * 1. 只在存在 `status` 时折叠。没有信封的 operation（sv_raw 的 handle 图、官方文档
 *    查询）直接透出宿主值，把它们塞进 `data` 会改变一个尚未定义信封的形状——那属于
 *    STATUSLESS_OPERATIONS 登记的欠迁移项，不是这里能顺手解决的。
 * 2. `detail` 有固定层级（DETAIL_PATHS）：根级的它必须落到 `data.detail`，而不是与
 *    「错误证据」的 error.detail 混成一处。
 * 3. 服务已经在 `data` 里放了同名字段时以 `data` 为准：那是服务自己给出的规范位置，
 *    根级的那份只是旧写法的残留，覆盖它会用旧值盖掉新值。
 */
function foldLegacyRootFields(envelope) {
  if (typeof envelope.status !== "string") return envelope;
  const legacy = Object.keys(envelope).filter(
    (field) => classifyRootField(field) === "legacy"
  );
  if (legacy.length === 0) return envelope;

  const folded = {};
  const movedData = {};
  for (const [field, value] of Object.entries(envelope)) {
    if (classifyRootField(field) === "legacy") movedData[field] = value;
    else folded[field] = value;
  }
  const existingData =
    envelope.data !== null && typeof envelope.data === "object" && !Array.isArray(envelope.data)
      ? envelope.data
      : null;
  // data 原本是标量/数组（例如 range 的 no_change 返回 data:null）时不折叠：把它
  // 换成对象会改变一条已定型的读取路径，而新造一个根级字段来存放这些值同样是违规。
  // 这类信封仍留在 LEGACY 登记表里，由后续按 operation 定义各自的 data 形状。
  if (envelope.data !== undefined && existingData === null) return envelope;
  // 展开顺序即优先级：服务自己写进 data 的值覆盖同名的根级残留（边界 3）。
  folded.data = { ...movedData, ...(existingData ?? {}) };
  return folded;
}

/**
 * 编码成功工具结果。
 *
 * @param {unknown} value - 工具返回的业务结果；标量会包装成 { result: value }
 * @returns {{ content: { type: "text", text: string }[], structuredContent: object, isError?: true }}
 */
export function encodeToolResult(value) {
  const normalizedValue = value ?? null;
  const isPlainObject =
    normalizedValue !== null && typeof normalizedValue === "object" && !Array.isArray(normalizedValue);
  if (!isPlainObject) {
    const structuredContent = { result: normalizedValue };
    return {
      content: [{ type: "text", text: summarizeLine(structuredContent) }],
      structuredContent,
    };
  }

  // 四步规范化，顺序不可换：先把服务内部 status（audition 状态机、processing 观测
  // 结论）投影进冻结矩阵，再补齐可由 status 唯一推导的 effects，接着折叠迁移期的
  // 根级业务字段，最后省略可推导字段。
  //
  // 省略必须排在补齐**之后**：fillCanonicalEffects 要读 status 才能定 effects，
  // 而省略只看最终值。反过来先省略会让「本该补上的 effects」因为暂时缺席而被跳过。
  const projected = omitDerivableFields(
    foldLegacyRootFields(
      fillCanonicalEffects(projectStatusEnvelope(stripRedundantOk(normalizedValue)))
    )
  );
  // 校验放在最后，才是在检查「模型真正看到的那一份」。省略 retryable:false 不影响
  // 相容性判定：assertStatusEnvelope 只对 retryable === true 设约束。
  if (typeof projected.status === "string") assertStatusEnvelope(projected);

  const result = {
    content: [{ type: "text", text: summarizeLine(projected) }],
    structuredContent: projected,
  };

  if (isErrorStatus(projected.status)) {
    result.isError = true;
  }

  return result;
}

// status 完全决定成败，MCP 传输层的 isError 决定客户端分支，因此与 status 并存的
// ok 布尔只是第三份同义信息。服务内部仍可用 ok 串联事务，但它不进入 MCP surface。
//
// 只在存在 status 时剥离：sv_doctor 的 ok 是安装健康结论
// （!findings.some(severity === "error")），没有任何 status 承载它，剥掉就是丢信息。
function stripRedundantOk(value) {
  if (typeof value.ok !== "boolean") return value;
  if (typeof value.status !== "string") return value;
  // 不改调用方的对象：服务可能继续持有它做后续判断。
  const { ok: _ok, ...rest } = value;
  return rest;
}

/**
 * 编码失败工具结果。
 *
 * @param {string} code
 * @param {string} message
 * @param {object} [details]
 * @returns {{ content: { type: "text", text: string }[], structuredContent: object, isError: true }}
 */
export function encodeToolError(code, message, details) {
  const structuredContent = {
    status: "failed",
    error: {
      code,
      message,
      ...(details && typeof details === "object" && !Array.isArray(details) ? details : {}),
    },
  };

  return {
    content: [{ type: "text", text: summarizeLine(structuredContent) }],
    structuredContent,
    isError: true,
  };
}

/**
 * 按对象形式编码错误（与 toolError 相同的调用签名）。
 *
 * @param {{ code: string, message: string, details?: object }} errorEnvelope
 * @returns {{ content: { type: "text", text: string }[], structuredContent: object, isError: true }}
 */
export function encodeToolErrorEnvelope(errorEnvelope) {
  return encodeToolError(errorEnvelope.code, errorEnvelope.message, errorEnvelope.details);
}
