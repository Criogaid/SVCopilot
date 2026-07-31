// Grouped expression gesture 展开（计划 §3.4 / §9.3）。
//
// 外部请求把重复的东西合并表达：一个 hairpin 覆盖多个参数，一个 vibrato 覆盖多个
// Note，scoop/fall 用 [noteIndex, depthCents] tuple。展开成 canonical gesture 后，
// 现有的 constraints / sampling / merge / point-budget 逻辑一行不改地继续工作。
//
// 这是纯数据转换：不访问宿主，不持有 handle，只把紧凑引用解析成 Context 内被冻结的
// fingerprint 对象引用（§3.5 规则 4）。
//
// 为什么不用 Dense Codec 表达 gesture：gesture 是异构的（hairpin 有范围和多参数，
// vibrato 有一组 Note 和共享参数，scoop/fall 是 tuple），塞进一个通用表格 codec 会
// 造出第二套 DSL，而模型每次都要先学会它。小而业务明确的 schema 更便宜。

import { resolveNoteIndex } from "./scope-source.js";

// 展开顺序固定：请求顺序 → Note 顺序 → 参数白名单顺序（§3.4）。
// 顺序必须确定，否则同一请求两次规划会产出不同的 operation 序列，
// 而 point-budget 的截断点也会随之漂移。
export const HAIRPIN_PARAMETER_ORDER = Object.freeze([
  "pitchDelta",
  "loudness",
  "tension",
  "breathiness",
  "voicing",
  "gender",
]);

// 各参数的单位与合法幅度。amounts 用显式白名单而不是任意键：
// 一个拼错的参数名如果被静默忽略，模型会以为它生效了。
const HAIRPIN_LIMITS = Object.freeze({
  pitchDelta: { max: 1200, unit: "cent" },
  loudness: { max: 24, unit: "dB" },
  tension: { max: 1, unit: "ratio" },
  breathiness: { max: 1, unit: "ratio" },
  voicing: { max: 1, unit: "ratio" },
  gender: { max: 1, unit: "ratio" },
});

// defaults 只允许对应 gesture 类型已声明的可选字段（§3.4）。
const DEFAULT_FIELDS_BY_TYPE = Object.freeze({
  vibrato: Object.freeze([
    "surface",
    "rateHz",
    "onsetDelayQuarter",
    "rampQuarter",
    "fadeOutQuarter",
    "level",
  ]),
  scoop: Object.freeze(["lengthQuarter", "shapePower"]),
  fall: Object.freeze(["lengthQuarter", "shapePower"]),
  // portamento 不在计划 §3.4 的示例里，但 planner 一直支持它。删掉它是能力回退，
  // 而计划要求的是替换身份、不缩减语义（§B2 步骤 7 同一原则）。
  portamento: Object.freeze(["lengthQuarter", "maxCents"]),
});

const MAX_GROUPED_NOTES = 512;
const MAX_GROUPED_TARGETS = 512;

/**
 * 校验 defaults。未知 gesture 类型或未声明字段一律拒绝——静默忽略会让调用方
 * 以为自己设置的默认值生效了。
 *
 * @param {object} [rawDefaults]
 * @returns {object}
 */
export function normalizeExpressionDefaults(rawDefaults) {
  if (rawDefaults === undefined) return {};
  if (!isRecord(rawDefaults)) {
    throw codedError("INVALID_ARGUMENTS", "defaults must be an object", { path: "/defaults" });
  }
  const result = {};
  for (const [type, values] of Object.entries(rawDefaults)) {
    const allowed = DEFAULT_FIELDS_BY_TYPE[type];
    if (!allowed) {
      throw codedError("INVALID_ARGUMENTS", `defaults has no such gesture type: ${type}`, {
        path: `/defaults/${type}`,
        rule: `one of ${Object.keys(DEFAULT_FIELDS_BY_TYPE).join(", ")}`,
      });
    }
    if (!isRecord(values)) {
      throw codedError("INVALID_ARGUMENTS", `defaults.${type} must be an object`, {
        path: `/defaults/${type}`,
      });
    }
    const unknown = Object.keys(values).filter((key) => !allowed.includes(key));
    if (unknown.length > 0) {
      throw codedError(
        "INVALID_ARGUMENTS",
        `defaults.${type} does not accept: ${unknown.join(", ")}`,
        { path: `/defaults/${type}`, rule: `one of ${allowed.join(", ")}` }
      );
    }
    result[type] = { ...values };
  }
  return result;
}

/**
 * 把 grouped gesture 展开成 canonical gesture 列表。
 *
 * canonical gesture 持有 **fingerprint 对象引用**（`note` / `fromNote` / `toNote`），
 * 不再持有任何字符串 Note ID：身份就是 Context 里那个被冻结的对象（§3.2 结尾）。
 *
 * @param {object} options
 * @param {object[]} options.gestures - 外部 grouped gesture
 * @param {object} options.defaults - normalizeExpressionDefaults 的返回值
 * @param {object} options.scope - resolveMutationScope 的返回值
 * @returns {object[]} canonical gesture
 */
// 各 gesture 类型允许的字段。展开与前置形状检查共用同一份表，因此不会出现
// "前置放过、展开拒绝"或反之的漂移。
const ALLOWED_FIELDS_BY_TYPE = Object.freeze({
  hairpin: Object.freeze(["type", "from", "to", "peak", "amounts"]),
  vibrato: Object.freeze([
    "type",
    "notes",
    "surface",
    "depthCents",
    "rateHz",
    "onsetDelayQuarter",
    "rampQuarter",
    "fadeOutQuarter",
    "level",
  ]),
  scoop: Object.freeze(["type", "targets", "lengthQuarter", "shapePower"]),
  fall: Object.freeze(["type", "targets", "lengthQuarter", "shapePower"]),
  portamento: Object.freeze(["type", "transitions", "lengthQuarter", "maxCents"]),
});

// 每个类型承载 Note 引用的字段，以及它的形状。前置检查只看形状，不解析身份
// ——身份要等 Context 解析出来才能判断。
const REFERENCE_FIELD_BY_TYPE = Object.freeze({
  hairpin: Object.freeze({ fields: Object.freeze(["from", "to"]), shape: "index" }),
  vibrato: Object.freeze({ fields: Object.freeze(["notes"]), shape: "indexList" }),
  scoop: Object.freeze({ fields: Object.freeze(["targets"]), shape: "tupleList" }),
  fall: Object.freeze({ fields: Object.freeze(["targets"]), shape: "tupleList" }),
  portamento: Object.freeze({ fields: Object.freeze(["transitions"]), shape: "tupleList" }),
});

/**
 * 请求形状的前置校验：**不接触 SnapshotStore、不解析身份**。
 *
 * 为什么必须单独存在：形状错误（拼错的键、缺失的 targets、超范围的 depthCents）与
 * contextId 是否存在无关，理应先报出来。若等到展开阶段才校验，一个形状错误的请求
 * 会先撞上 UNKNOWN_CONTEXT，模型收到的是"上下文没了"，于是去重新快照——而真正的
 * 问题在它自己的请求里，重新快照多少次都不会变好。
 *
 * @param {object[]} gestures
 * @returns {void}
 */
export function assertExpressionGestureShapes(gestures) {
  if (!Array.isArray(gestures)) {
    throw codedError("INVALID_ARGUMENTS", "gestures must be an array", { path: "/gestures" });
  }
  for (const [requestIndex, gesture] of gestures.entries()) {
    const path = `/gestures/${requestIndex}`;
    if (!isRecord(gesture)) {
      throw codedError("INVALID_ARGUMENTS", "gesture must be an object", { path });
    }
    const allowed = ALLOWED_FIELDS_BY_TYPE[gesture.type];
    if (!allowed) {
      throw codedError("INVALID_ARGUMENTS", "unsupported gesture type", {
        path: `${path}/type`,
        rule: Object.keys(ALLOWED_FIELDS_BY_TYPE).join(" | "),
      });
    }
    assertKnownKeys(gesture, allowed, path);
    const reference = REFERENCE_FIELD_BY_TYPE[gesture.type];
    for (const field of reference.fields) {
      const value = gesture[field];
      const fieldPath = `${path}/${field}`;
      if (value === undefined) {
        throw codedError("INVALID_ARGUMENTS", `${gesture.type} requires ${field}`, {
          path: fieldPath,
        });
      }
      if (reference.shape === "index" && !Number.isSafeInteger(value)) {
        throw codedError("INVALID_ARGUMENTS", "note reference must be an integer index", {
          path: fieldPath,
        });
      }
      if (reference.shape === "indexList") {
        requireIndexList(value, fieldPath, MAX_GROUPED_NOTES);
      }
      if (reference.shape === "tupleList") {
        if (!Array.isArray(value) || value.length === 0) {
          throw codedError("INVALID_ARGUMENTS", `${field} must be a non-empty array`, {
            path: fieldPath,
          });
        }
        if (value.length > MAX_GROUPED_TARGETS) {
          throw codedError("INVALID_ARGUMENTS", `${field} accepts at most ${MAX_GROUPED_TARGETS} items`, {
            path: fieldPath,
          });
        }
        for (const [position, tuple] of value.entries()) {
          if (!Array.isArray(tuple) || tuple.length !== 2) {
            throw codedError("INVALID_ARGUMENTS", "expected a 2-element tuple", {
              path: `${fieldPath}/${position}`,
              rule: "array of exactly 2 numbers",
            });
          }
        }
      }
    }
    // 数值范围与互斥规则同样与身份无关，因此也放在前置。这里调用的就是展开阶段
    // 用的同一个函数，因此不会出现"前置放过、展开拒绝"的漂移。
    assertGestureValues(gesture, path, {});
  }
}

// 与身份无关的值校验：范围、互斥、非零。展开阶段与前置检查共用。
//
// defaults 参与校验，因为 gesture 字段覆盖 defaults 之后才是最终值——只校验
// gesture 自身会放过一个由 defaults 带进来的越界值。前置阶段传 {} 是刻意的：
// 那时还没有 defaults 语境，而 defaults 自身的合法性由 normalizeExpressionDefaults
// 单独负责。
function assertGestureValues(gesture, path, defaults) {
  switch (gesture.type) {
    case "hairpin": {
      if (
        gesture.from !== undefined &&
        gesture.to !== undefined &&
        gesture.from > gesture.to
      ) {
        throw codedError("INVALID_ARGUMENTS", "hairpin needs from <= to", {
          path: `${path}/to`,
          rule: "to >= from",
        });
      }
      if (!isRecord(gesture.amounts) || Object.keys(gesture.amounts).length === 0) {
        throw codedError("INVALID_ARGUMENTS", "hairpin needs a non-empty amounts object", {
          path: `${path}/amounts`,
        });
      }
      const unknown = Object.keys(gesture.amounts).filter(
        (parameter) => !HAIRPIN_PARAMETER_ORDER.includes(parameter)
      );
      if (unknown.length > 0) {
        throw codedError(
          "INVALID_ARGUMENTS",
          `hairpin amounts has no such parameter: ${unknown.join(", ")}`,
          { path: `${path}/amounts`, rule: `one of ${HAIRPIN_PARAMETER_ORDER.join(", ")}` }
        );
      }
      checkNumber(gesture.peak, 0.05, 0.95, `${path}/peak`);
      for (const parameter of HAIRPIN_PARAMETER_ORDER) {
        if (!Object.hasOwn(gesture.amounts, parameter)) continue;
        const limit = HAIRPIN_LIMITS[parameter];
        const amount = gesture.amounts[parameter];
        checkNumber(amount, -limit.max, limit.max, `${path}/amounts/${parameter}`);
        if (amount === 0) {
          throw codedError("INVALID_ARGUMENTS", "hairpin amount must be non-zero", {
            path: `${path}/amounts/${parameter}`,
          });
        }
      }
      return;
    }
    case "vibrato": {
      const merged = { ...(defaults.vibrato ?? {}), ...omit(gesture, ["type", "notes"]) };
      if (merged.surface !== undefined && !["pitchDelta", "vibratoEnv"].includes(merged.surface)) {
        throw codedError("INVALID_ARGUMENTS", "vibrato surface must be pitchDelta or vibratoEnv", {
          path: `${path}/surface`,
        });
      }
      checkNumber(merged.depthCents, 1, 600, `${path}/depthCents`);
      checkNumber(merged.rateHz, 0.5, 12, `${path}/rateHz`);
      checkNumber(merged.onsetDelayQuarter, 0, 16, `${path}/onsetDelayQuarter`);
      checkNumber(merged.rampQuarter, 0, 16, `${path}/rampQuarter`);
      checkNumber(merged.fadeOutQuarter, 0, 16, `${path}/fadeOutQuarter`);
      checkNumber(merged.level, 0, 2, `${path}/level`);
      // vibratoEnv 与 pitchDelta 的参数集合互斥：混用说明调用方没弄清写的是哪条曲线。
      if (
        merged.surface === "vibratoEnv" &&
        (merged.depthCents !== undefined || merged.fadeOutQuarter !== undefined)
      ) {
        throw codedError(
          "INVALID_ARGUMENTS",
          "vibratoEnv takes level/onsetDelayQuarter/rampQuarter, not depthCents/fadeOutQuarter",
          { path }
        );
      }
      return;
    }
    case "scoop":
    case "fall": {
      const merged = { ...(defaults[gesture.type] ?? {}), ...omit(gesture, ["type", "targets"]) };
      checkNumber(merged.lengthQuarter, 0.01, 16, `${path}/lengthQuarter`);
      checkNumber(merged.shapePower, 0.5, 8, `${path}/shapePower`);
      for (const [position, tuple] of (gesture.targets ?? []).entries()) {
        if (!Array.isArray(tuple) || tuple.length !== 2) continue; // 形状已在别处报错
        checkNumber(tuple[1], 1, 600, `${path}/targets/${position}/1`, { required: true });
      }
      return;
    }
    case "portamento": {
      const merged = {
        ...(defaults.portamento ?? {}),
        ...omit(gesture, ["type", "transitions"]),
      };
      checkNumber(merged.lengthQuarter, 0.01, 4, `${path}/lengthQuarter`);
      checkNumber(merged.maxCents, 10, 1200, `${path}/maxCents`);
      return;
    }
    default:
      throw codedError("INVALID_ARGUMENTS", "unsupported gesture type", {
        path: `${path}/type`,
        rule: Object.keys(ALLOWED_FIELDS_BY_TYPE).join(" | "),
      });
  }
}

export function expandExpressionGestures({ gestures, defaults = {}, scope }) {
  if (!Array.isArray(gestures)) {
    throw codedError("INVALID_ARGUMENTS", "gestures must be an array", { path: "/gestures" });
  }
  const expanded = [];
  for (const [requestIndex, gesture] of gestures.entries()) {
    const path = `/gestures/${requestIndex}`;
    if (!isRecord(gesture)) {
      throw codedError("INVALID_ARGUMENTS", "gesture must be an object", { path });
    }
    switch (gesture.type) {
      case "hairpin":
        expandHairpin(gesture, { path, requestIndex, scope, into: expanded });
        break;
      case "vibrato":
        expandVibrato(gesture, { path, requestIndex, scope, defaults, into: expanded });
        break;
      case "scoop":
      case "fall":
        expandScoopOrFall(gesture, { path, requestIndex, scope, defaults, into: expanded });
        break;
      case "portamento":
        expandPortamento(gesture, { path, requestIndex, scope, defaults, into: expanded });
        break;
      default:
        throw codedError("INVALID_ARGUMENTS", "unsupported gesture type", {
          path: `${path}/type`,
          rule: "hairpin | vibrato | scoop | fall | portamento",
        });
    }
  }
  return expanded;
}

function expandHairpin(gesture, { path, requestIndex, scope, into }) {
  assertKnownKeys(gesture, ALLOWED_FIELDS_BY_TYPE.hairpin, path);
  assertGestureValues(gesture, path, {});
  const fromNote = resolveNoteIndex(scope, gesture.from, `${path}/from`);
  const toNote = resolveNoteIndex(scope, gesture.to, `${path}/to`);

  // 按参数白名单顺序展开，而不是按 Object.keys 的插入顺序：后者会让语义相同的
  // 两个请求（只是键序不同）产出不同的 operation 序列。
  for (const parameter of HAIRPIN_PARAMETER_ORDER) {
    if (!Object.hasOwn(gesture.amounts, parameter)) continue;
    into.push({
      type: "hairpin",
      fromNote,
      toNote,
      parameter,
      amount: gesture.amounts[parameter],
      ...(gesture.peak === undefined ? {} : { peakPosition: gesture.peak }),
      source: { requestIndex, parameter },
    });
  }
}

function expandVibrato(gesture, { path, requestIndex, scope, defaults, into }) {
  assertKnownKeys(gesture, ALLOWED_FIELDS_BY_TYPE.vibrato, path);
  const notes = requireIndexList(gesture.notes, `${path}/notes`, MAX_GROUPED_NOTES);
  assertGestureValues(gesture, path, defaults);
  // gesture 自身字段覆盖 defaults（§3.4）。
  const merged = { ...(defaults.vibrato ?? {}), ...omit(gesture, ["type", "notes"]) };

  for (const [notePosition, index] of notes.entries()) {
    into.push({
      type: "vibrato",
      note: resolveNoteIndex(scope, index, `${path}/notes/${notePosition}`),
      ...merged,
      source: { requestIndex, notePosition },
    });
  }
}

function expandScoopOrFall(gesture, { path, requestIndex, scope, defaults, into }) {
  assertKnownKeys(gesture, ["type", "targets", "lengthQuarter", "shapePower"], path);
  if (!Array.isArray(gesture.targets) || gesture.targets.length === 0) {
    throw codedError("INVALID_ARGUMENTS", `${gesture.type} needs a non-empty targets array`, {
      path: `${path}/targets`,
    });
  }
  if (gesture.targets.length > MAX_GROUPED_TARGETS) {
    throw codedError("INVALID_ARGUMENTS", `targets accepts at most ${MAX_GROUPED_TARGETS} items`, {
      path: `${path}/targets`,
    });
  }
  const merged = { ...(defaults[gesture.type] ?? {}), ...omit(gesture, ["type", "targets"]) };
  checkNumber(merged.lengthQuarter, 0.01, 16, `${path}/lengthQuarter`);
  checkNumber(merged.shapePower, 0.5, 8, `${path}/shapePower`);

  for (const [targetPosition, tuple] of gesture.targets.entries()) {
    const tuplePath = `${path}/targets/${targetPosition}`;
    // tuple 固定为 [noteIndexInGroup, depthCents]（§3.4）。长度不对就是位置歧义，
    // 不能按"缺省补齐"处理——那会把 depth 当成 index 用。
    if (!Array.isArray(tuple) || tuple.length !== 2) {
      throw codedError("INVALID_ARGUMENTS", "target must be [noteIndex, depthCents]", {
        path: tuplePath,
        rule: "array of exactly 2 numbers",
      });
    }
    const [noteIndex, depthCents] = tuple;
    checkNumber(depthCents, 1, 600, `${tuplePath}/1`, { required: true });
    into.push({
      type: gesture.type,
      note: resolveNoteIndex(scope, noteIndex, `${tuplePath}/0`),
      depthCents,
      ...merged,
      source: { requestIndex, targetPosition },
    });
  }
}

// portamento 的紧凑形式与 scoop/fall 同构，但 tuple 的两个位置都是 Note index：
// `transitions: [[fromIndex, toIndex], ...]`。一次请求常包含多个过渡且共享
// lengthQuarter/maxCents，这正是 grouping 要省掉的重复。
//
// 相邻性不在这里检查：那要比较 onset 与 end，属于 planner 的乐理判断
// （PORTAMENTO_NOT_ADJACENT）。展开层只解析身份。
function expandPortamento(gesture, { path, requestIndex, scope, defaults, into }) {
  assertKnownKeys(gesture, ["type", "transitions", "lengthQuarter", "maxCents"], path);
  if (!Array.isArray(gesture.transitions) || gesture.transitions.length === 0) {
    throw codedError("INVALID_ARGUMENTS", "portamento needs a non-empty transitions array", {
      path: `${path}/transitions`,
    });
  }
  if (gesture.transitions.length > MAX_GROUPED_TARGETS) {
    throw codedError("INVALID_ARGUMENTS", `transitions accepts at most ${MAX_GROUPED_TARGETS} items`, {
      path: `${path}/transitions`,
    });
  }
  const merged = { ...(defaults.portamento ?? {}), ...omit(gesture, ["type", "transitions"]) };
  checkNumber(merged.lengthQuarter, 0.01, 4, `${path}/lengthQuarter`);
  checkNumber(merged.maxCents, 10, 1200, `${path}/maxCents`);

  for (const [transitionPosition, tuple] of gesture.transitions.entries()) {
    const tuplePath = `${path}/transitions/${transitionPosition}`;
    if (!Array.isArray(tuple) || tuple.length !== 2) {
      throw codedError("INVALID_ARGUMENTS", "transition must be [fromIndex, toIndex]", {
        path: tuplePath,
        rule: "array of exactly 2 numbers",
      });
    }
    into.push({
      type: "portamento",
      fromNote: resolveNoteIndex(scope, tuple[0], `${tuplePath}/0`),
      toNote: resolveNoteIndex(scope, tuple[1], `${tuplePath}/1`),
      ...merged,
      source: { requestIndex, transitionPosition },
    });
  }
}

function requireIndexList(value, path, maximum) {
  if (!Array.isArray(value) || value.length === 0) {
    throw codedError("INVALID_ARGUMENTS", "expected a non-empty array of note indices", { path });
  }
  if (value.length > maximum) {
    throw codedError("INVALID_ARGUMENTS", `at most ${maximum} items`, { path });
  }
  return value;
}

function omit(source, keys) {
  return Object.fromEntries(Object.entries(source).filter(([key]) => !keys.includes(key)));
}

function assertKnownKeys(value, allowed, path) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw codedError("INVALID_ARGUMENTS", `unknown field: ${unknown.join(", ")}`, {
      path,
      rule: `one of ${allowed.join(", ")}`,
    });
  }
}

function checkNumber(value, minimum, maximum, path, { required = false } = {}) {
  if (value === undefined) {
    if (!required) return;
    throw codedError("INVALID_ARGUMENTS", "value is required", { path });
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw codedError("INVALID_ARGUMENTS", "value must be a finite number", { path });
  }
  if (value < minimum || value > maximum) {
    throw codedError("INVALID_ARGUMENTS", `value must be within [${minimum}, ${maximum}]`, {
      path,
      got: value,
    });
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function codedError(code, message, details) {
  const error = new Error(`[${code}] ${message}`);
  error.code = code;
  if (details) error.details = details;
  return error;
}
