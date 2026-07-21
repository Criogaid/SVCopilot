import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceDir = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.resolve(sourceDir, "..", "..", "api-docs", "api-manifest.json");

// manifest 是生成产物(`npm run parse:sv-api`)。当它缺失、读不出、不是合法 JSON,
// 或结构不对(如 `null`、`{}`、`classes` 不是对象)时,优雅降级而不是在 import 期崩掉:
// search/describe/资源报告不可用、调用预检跳过,但 dispatcher(sv_ping/sv_call/sv_root/…)
// 照常工作。
function unavailableStub() {
  return Object.freeze({
    schemaVersion: 0,
    generatedAt: null,
    sourceMirror: null,
    summary: {},
    creatableTypes: [],
    classes: {},
    available: false,
  });
}

function isPlausibleManifest(value) {
  if (!isObject(value) || !isObject(value.classes)) return false;
  if (!isObject(value.classes.SV) || !isObject(value.classes.SV.methods)) return false;
  // 每个类条目及其 methods 都必须是对象,否则运行时访问 apiClass.methods[...] 会抛异常,
  // 让已知 handle 的 sv_call 返回 MCP 内部错误而不是转发给宿主。
  for (const entry of Object.values(value.classes)) {
    if (!isObject(entry) || !isObject(entry.methods)) return false;
  }
  return true;
}

// 导出供测试:把解析后的 JSON 转成可用的 manifest;结构不是合法 API 目录时返回 stub。
export function normalizeManifest(parsed) {
  return isPlausibleManifest(parsed) ? Object.freeze(parsed) : unavailableStub();
}

function manifestWarning(reason) {
  return (
    `[sv-copilot] API manifest unavailable at ${manifestPath} (${reason}). ` +
    "Run 'npm run parse:sv-api'. API search/describe and call pre-validation are disabled; the dispatcher still works."
  );
}

function loadManifest() {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    console.error(manifestWarning(error.code || error.message));
    return unavailableStub();
  }
  const manifest = normalizeManifest(parsed);
  if (manifest.available === false) {
    console.error(manifestWarning("manifest is not a valid API catalog (missing or non-object `classes`)"));
  }
  return manifest;
}

export const apiManifest = loadManifest();

// manifest 真正加载成功时为 true;降级 stub 时为 false。让调用方区分
// “API 里没有”和“manifest 不可用”。
export const apiManifestAvailable = apiManifest.available !== false;

export function getApiClass(className) {
  if (typeof className !== "string" || !Object.hasOwn(apiManifest.classes, className)) return null;
  return apiManifest.classes[className];
}

export function getMethodOverloads(className, method) {
  const apiClass = getApiClass(className);
  if (!apiClass || typeof method !== "string" || !Object.hasOwn(apiClass.methods, method)) return null;
  return apiClass.methods[method];
}

export function describeApi(className, method) {
  const apiClass = getApiClass(className);
  if (!apiClass) return null;
  if (method === undefined || method === null || method === "") return apiClass;

  const overloads = getMethodOverloads(className, method);
  if (!overloads) return null;
  return {
    className,
    method,
    overloads,
  };
}

export function searchApi(query, { limit = 25 } = {}) {
  if (typeof query !== "string" || !query.trim()) {
    throw new Error("query must be a non-empty string");
  }

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const maxResults = Math.max(1, Math.min(50, Number.isInteger(limit) ? limit : 25));
  const matches = [];

  for (const [className, apiClass] of Object.entries(apiManifest.classes)) {
    const classText = `${className} ${apiClass.description ?? ""}`.toLocaleLowerCase();
    for (const [method, overloads] of Object.entries(apiClass.methods)) {
      const methodText = [
        className,
        method,
        ...overloads.flatMap((overload) => [
          overload.signature,
          overload.description,
          ...overload.parameters.map((parameter) => `${parameter.name} ${parameter.type}`),
          ...overload.returns,
        ]),
      ]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase();
      const methodIndex = methodText.indexOf(normalizedQuery);
      const classIndex = classText.indexOf(normalizedQuery);
      if (methodIndex < 0 && classIndex < 0) continue;

      const score =
        (method.toLocaleLowerCase() === normalizedQuery ? 100 : 0) +
        (className.toLocaleLowerCase() === normalizedQuery ? 80 : 0) +
        (methodIndex >= 0 ? 40 - Math.min(methodIndex, 30) : 0) +
        (classIndex >= 0 ? 20 - Math.min(classIndex, 15) : 0);
      matches.push({ className, method, overloads, score });
    }
  }

  matches.sort(
    (left, right) =>
      right.score - left.score ||
      left.className.localeCompare(right.className) ||
      left.method.localeCompare(right.method)
  );

  return {
    query: query.trim(),
    total: matches.length,
    results: matches.slice(0, maxResults).map(({ score, ...match }) => match),
  };
}

export function validateApiCall({
  className,
  method,
  args = [],
  hostVersion = null,
  resolveHandleType = () => null,
}) {
  if (!Array.isArray(args)) {
    return invalid("INVALID_ARGUMENTS", "args must be an array");
  }
  if (!className) {
    return { ok: true, skipped: "The target handle type is not known to this MCP session." };
  }

  const apiClass = getApiClass(className);
  if (!apiClass) {
    return invalid("UNKNOWN_TARGET_TYPE", `No API class named ${className}.`);
  }
  const overloads = getMethodOverloads(className, method);
  if (!overloads) {
    return invalid("UNKNOWN_METHOD", `${className}.${String(method)} is not in the official API manifest.`);
  }

  const versioned = overloads.map((overload) => ({
    overload,
    supported: isSupportedByHost(overload, hostVersion),
  }));
  const available = versioned.filter((entry) => entry.supported).map((entry) => entry.overload);
  if (available.length === 0) {
    const required = [...new Set(overloads.flatMap((overload) => overload.supportedSince ?? []))];
    return invalid(
      "VERSION_UNSUPPORTED",
      `${className}.${method} requires Synthesizer V ${required.join(", ")} or later; connected host is ${hostVersion}.`
    );
  }

  const compatible = [];
  const failures = [];
  for (const overload of available) {
    const failure = validateOverloadArguments(overload, args, resolveHandleType);
    if (failure) failures.push({ signature: overload.signature, reason: failure });
    else compatible.push(overload);
  }
  if (compatible.length === 0) {
    const signatures = available.map((overload) => overload.signature).join(" or ");
    const details = failures.map((failure) => `${failure.signature}: ${failure.reason}`).join("; ");
    return invalid(
      "ARGUMENT_MISMATCH",
      `${className}.${method} does not accept ${args.length} argument(s). Expected ${signatures}. ${details}`
    );
  }

  return { ok: true, overloads: compatible };
}

export function inferReturnedHandleType(className, method, args, overloads = null) {
  if (className === "SV" && method === "create" && typeof args[0] === "string") {
    return getApiClass(args[0]) ? args[0] : null;
  }

  const candidates = overloads ?? getMethodOverloads(className, method) ?? [];
  for (const overload of candidates) {
    for (const returnType of overload.returns ?? []) {
      if (getApiClass(returnType)) return returnType;
    }
  }
  return null;
}

function invalid(code, message) {
  return { ok: false, code, message };
}

function isSupportedByHost(overload, hostVersion) {
  if (!hostVersion || !overload.supportedSince?.length) return true;
  return overload.supportedSince.every((requiredVersion) =>
    compareVersions(hostVersion, requiredVersion) >= 0
  );
}

function compareVersions(left, right) {
  const parsedLeft = parseVersion(left);
  const parsedRight = parseVersion(right);
  if (!parsedLeft || !parsedRight) return 0;

  for (let index = 0; index < 3; index += 1) {
    if (parsedLeft.parts[index] !== parsedRight.parts[index]) {
      return parsedLeft.parts[index] - parsedRight.parts[index];
    }
  }
  if (parsedLeft.suffix === parsedRight.suffix) return 0;
  if (!parsedLeft.suffix) return 1;
  if (!parsedRight.suffix) return -1;
  return parsedLeft.suffix.localeCompare(parsedRight.suffix, undefined, { numeric: true });
}

function parseVersion(value) {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?([A-Za-z].*)?$/);
  if (!match) return null;
  return {
    parts: [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)],
    suffix: (match[4] ?? "").toLocaleLowerCase(),
  };
}

function validateOverloadArguments(overload, args, resolveHandleType) {
  const parameters = overload.parameters ?? [];
  const requiredCount = parameters.filter((parameter) => !parameter.optional && !parameter.repeatable).length;
  const repeatable = parameters.at(-1)?.repeatable === true;
  if (args.length < requiredCount || (!repeatable && args.length > parameters.length)) {
    return `expects ${formatArity(parameters)}, received ${args.length}`;
  }

  for (let index = 0; index < args.length; index += 1) {
    const parameter = parameters[Math.min(index, parameters.length - 1)];
    const mismatch = validateValue(args[index], parameter.type, resolveHandleType);
    if (mismatch) return `argument ${index + 1} (${parameter.name}): ${mismatch}`;
  }
  return null;
}

function formatArity(parameters) {
  const requiredCount = parameters.filter((parameter) => !parameter.optional && !parameter.repeatable).length;
  if (parameters.at(-1)?.repeatable) return `at least ${requiredCount}`;
  if (requiredCount === parameters.length) return String(requiredCount);
  return `${requiredCount}-${parameters.length}`;
}

function validateValue(value, expectedType, resolveHandleType) {
  const alternatives = expectedType.split(/\s*\|\s*/);
  const failures = alternatives
    .map((type) => validateSingleType(value, type, resolveHandleType))
    .filter(Boolean);
  return failures.length === alternatives.length ? failures.join(" or ") : null;
}

function validateSingleType(value, expectedType, resolveHandleType) {
  if (expectedType === "any") return null;
  if (expectedType === "number") {
    return typeof value === "number" && Number.isFinite(value) ? null : "must be a finite number";
  }
  if (expectedType === "string" || expectedType === "boolean") {
    return typeof value === expectedType ? null : `must be ${expectedType}`;
  }
  if (expectedType === "function") {
    return "requires a Lua function, which JSON arguments cannot represent";
  }
  if (expectedType === "array") {
    return Array.isArray(value) ? null : "must be an array";
  }
  if (expectedType === "object" || expectedType === "attributes") {
    return isObject(value) ? null : "must be an object";
  }

  const arrayMatch = expectedType.match(/^Array\.<(.+)>$/);
  if (arrayMatch) {
    if (!Array.isArray(value)) return `must be ${expectedType}`;
    for (const item of value) {
      const mismatch = validateValue(item, arrayMatch[1], resolveHandleType);
      if (mismatch) return `must be ${expectedType} (${mismatch})`;
    }
    return null;
  }

  if (getApiClass(expectedType)) {
    const handle = getHandleId(value);
    if (handle === null) return `must be a ${expectedType} handle`;
    const actualType = resolveHandleType(handle);
    if (actualType && !isAssignable(actualType, expectedType)) {
      return `expects ${expectedType} handle, but handle ${handle} is ${actualType}`;
    }
  }
  return null;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getHandleId(value) {
  if (!isObject(value) || !Number.isSafeInteger(value.__handle__)) return null;
  return value.__handle__;
}

// 沿 extends 链递归判断可赋值性;visited 集合防止环导致死循环。
export function isAssignable(actualType, expectedType, visited = new Set()) {
  if (actualType === expectedType) return true;
  if (visited.has(actualType)) return false;
  visited.add(actualType);
  const parents = getApiClass(actualType)?.extends ?? [];
  return parents.some((parent) => isAssignable(parent, expectedType, visited));
}
