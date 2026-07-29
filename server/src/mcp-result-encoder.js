// 统一 MCP 工具结果编码：默认 minified，结构化内容保持不变，调试模式可选 pretty。
const DEBUG_PRETTY = process.env.SV_COPILOT_DEBUG_PRETTY === "1";

/**
 * 测量一个 MCP 结果对象的字节成本。
 *
 * @param {object} result - 已封装成 { content, structuredContent, ... } 的结果
 * @returns {{ textUtf8Bytes: number, structuredUtf8Bytes: number, envelopeUtf8Bytes: number }}
 */
export function measureToolEnvelope(result) {
  const textUtf8Bytes = Buffer.byteLength(result.content?.[0]?.text ?? "", "utf8");
  const structuredUtf8Bytes = Buffer.byteLength(JSON.stringify(result.structuredContent ?? null), "utf8");
  const envelopeUtf8Bytes = Buffer.byteLength(JSON.stringify(result, null, DEBUG_PRETTY ? 2 : 0), "utf8");
  return { textUtf8Bytes, structuredUtf8Bytes, envelopeUtf8Bytes };
}

function buildText(value, options = {}) {
  if (options.pretty || DEBUG_PRETTY) {
    return JSON.stringify(value, null, 2);
  }
  return JSON.stringify(value);
}

/**
 * 编码成功工具结果。
 *
 * @param {unknown} value - 工具返回的业务结果；null/undefined 会包装成 { result: value }
 * @param {object} [options]
 * @param {boolean} [options.pretty] - 强制 pretty 输出（默认 false，调试模式 true）
 * @returns {{ content: { type: "text", text: string }[], structuredContent: object }}
 */
export function encodeToolResult(value, options = {}) {
  const normalizedValue = value ?? null;
  const structuredContent =
    normalizedValue !== null && typeof normalizedValue === "object" && !Array.isArray(normalizedValue)
      ? normalizedValue
      : { result: normalizedValue };

  const result = {
    content: [{ type: "text", text: buildText(normalizedValue, options) }],
    structuredContent,
  };

  if (normalizedValue?.ok === false) {
    result.isError = true;
  }

  return result;
}

/**
 * 编码失败工具结果。
 *
 * @param {string} code
 * @param {string} message
 * @param {object} [details]
 * @param {object} [options]
 * @param {boolean} [options.pretty]
 * @returns {{ content: { type: "text", text: string }[], structuredContent: object, isError: true }}
 */
export function encodeToolError(code, message, details, options = {}) {
  const result = {
    ok: false,
    status: "failed",
    error: {
      code,
      message,
      ...(details && typeof details === "object" && !Array.isArray(details) ? details : {}),
    },
  };

  return {
    content: [{ type: "text", text: buildText(result, options) }],
    structuredContent: result,
    isError: true,
  };
}

/**
 * 兼容旧接口：按对象形式编码错误（保留与原 toolError 相同的调用签名）。
 *
 * @param {{ code: string, message: string, details?: object }} errorEnvelope
 * @param {object} [options]
 * @returns {{ content: { type: "text", text: string }[], structuredContent: object, isError: true }}
 */
export function encodeToolErrorEnvelope(errorEnvelope, options = {}) {
  return encodeToolError(errorEnvelope.code, errorEnvelope.message, errorEnvelope.details, options);
}
