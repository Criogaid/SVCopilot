import { isPlainRecord } from "./value-shape.js";
// 带 code 的错误的唯一构造入口。
//
// 这个工厂此前在 44 个模块里各抄一份，并且抄出了两套互不兼容的行为：
//
//   1. 9 份把 code 拼进 message（`[${code}] ${message}`），35 份不拼。而 index.js
//      的错误编码同时上报 `error.code` 与 `error.message`，于是前一类在 surface 上
//      把同一个 code 说了两遍：
//        code: "ARTIFACT_NOT_FOUND"
//        message: "[ARTIFACT_NOT_FOUND] artifact not found: a_x"
//      这里统一不拼。`error.code` 是这个标识符的结构化归属，重复一遍只是消耗
//      响应预算，并且让模型看到的形状随「错误来自哪个模块」而变。
//
//   2. details 的写入条件有四种写法：`if (details)`、`if (details !== undefined)`、
//      无条件赋值、以及完全不支持第三参。因此 `details: null` 的含义取决于是哪个
//      文件抛的错——同一个 surface 上不该有这种分歧。
//
// 统一规则：只有 plain record 才成为 details。null / undefined / 数组 / Date / Map /
// Error / 类实例一律视为「没有 details」。错误证据最终进入 JSON surface；要求它由
// 明确命名的字段组成，列表应放在对象字段内，不能把带隐式序列化语义的实例带到边界。

/**
 * @param {string} code - 稳定机器码；调用方按它分支，不解析 message
 * @param {string} message - 面向人的说明，不含 code
 * @param {object} [details] - 结构化证据；非 plain record 一律忽略
 * @returns {Error & {code: string, details?: object}}
 */
export function codedError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (isPlainRecord(details)) error.details = details;
  return error;
}
