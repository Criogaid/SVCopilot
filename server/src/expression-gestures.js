// 非音高 expression gesture 展开。音高技法统一由 plan_pitch_gesture 处理。
import { resolveNoteIndex } from "./scope-source.js";
import { codedError } from "./coded-error.js";
import { isRecord } from "./value-shape.js";

// 固定参数顺序，保证相同请求的操作排列和 PlanRef 内容稳定。
export const HAIRPIN_PARAMETER_ORDER = Object.freeze([
  "loudness",
  "tension",
  "breathiness",
  "voicing",
  "gender",
]);

const HAIRPIN_LIMITS = Object.freeze({
  loudness: { max: 24, unit: "dB" },
  tension: { max: 1, unit: "ratio" },
  breathiness: { max: 1, unit: "ratio" },
  voicing: { max: 1, unit: "ratio" },
  gender: { max: 1, unit: "ratio" },
});

const ALLOWED_HAIRPIN_FIELDS = Object.freeze(["type", "from", "to", "peak", "amounts"]);

// 形状校验先于 Context 查询，让调用方先得到自身请求的错误。
export function assertExpressionGestureShapes(gestures) {
  if (!Array.isArray(gestures)) {
    throw codedError("INVALID_ARGUMENTS", "gestures must be an array", { path: "/gestures" });
  }
  for (const [index, gesture] of gestures.entries()) {
    const path = `/gestures/${index}`;
    if (!isRecord(gesture)) {
      throw codedError("INVALID_ARGUMENTS", "gesture must be an object", { path });
    }
    if (gesture.type !== "hairpin") {
      throw codedError(
        "INVALID_ARGUMENTS",
        "plan_expression supports hairpin only; use plan_pitch_gesture for pitch techniques",
        { path: `${path}/type`, rule: "hairpin" },
      );
    }
    assertKnownKeys(gesture, ALLOWED_HAIRPIN_FIELDS, path);
    requireIndex(gesture.from, `${path}/from`);
    requireIndex(gesture.to, `${path}/to`);
    if (gesture.from > gesture.to) {
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
      (parameter) => !HAIRPIN_PARAMETER_ORDER.includes(parameter),
    );
    if (unknown.length > 0) {
      throw codedError(
        "INVALID_ARGUMENTS",
        `hairpin amounts has no such parameter: ${unknown.join(", ")}`,
        { path: `${path}/amounts`, rule: HAIRPIN_PARAMETER_ORDER.join(", ") },
      );
    }
    checkNumber(gesture.peak, 0.05, 0.95, `${path}/peak`);
    for (const parameter of HAIRPIN_PARAMETER_ORDER) {
      if (!Object.hasOwn(gesture.amounts, parameter)) continue;
      const amount = gesture.amounts[parameter];
      checkNumber(amount, -HAIRPIN_LIMITS[parameter].max, HAIRPIN_LIMITS[parameter].max, `${path}/amounts/${parameter}`, { required: true });
      if (amount === 0) {
        throw codedError("INVALID_ARGUMENTS", "hairpin amount must be non-zero", {
          path: `${path}/amounts/${parameter}`,
        });
      }
    }
  }
}

export function expandExpressionGestures({ gestures, scope }) {
  assertExpressionGestureShapes(gestures);
  const expanded = [];
  for (const [requestIndex, gesture] of gestures.entries()) {
    const path = `/gestures/${requestIndex}`;
    const fromNote = resolveNoteIndex(scope, gesture.from, `${path}/from`);
    const toNote = resolveNoteIndex(scope, gesture.to, `${path}/to`);
    for (const parameter of HAIRPIN_PARAMETER_ORDER) {
      if (!Object.hasOwn(gesture.amounts, parameter)) continue;
      expanded.push({
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
  return expanded;
}

function assertKnownKeys(value, allowed, path) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw codedError("INVALID_ARGUMENTS", `unknown field: ${unknown.join(", ")}`, {
      path,
      rule: allowed.join(", "),
    });
  }
}

function requireIndex(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw codedError("INVALID_ARGUMENTS", "note reference must be a non-negative integer index", { path });
  }
}

function checkNumber(value, minimum, maximum, path, { required = false } = {}) {
  if (value === undefined) {
    if (!required) return;
    throw codedError("INVALID_ARGUMENTS", "value is required", { path });
  }
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw codedError("INVALID_ARGUMENTS", `value must be within [${minimum}, ${maximum}]`, {
      path,
      got: value,
    });
  }
}
