import { createHash } from "node:crypto";

// PitchControlPoint / PitchControlCurve 的规范化读模型与身份模型（主计划 P1-C）。
//
// 两类对象都挂在 NoteGroup 上、按 anchor position 升序排列（官方文档明确：
// addPitchControl 返回新索引，且组内始终保持排序——任何增删都会重排，index 不是稳定身份）。
// 官方 API 没有给 PitchControl 发 UUID，因此身份只能来自两条：
//   1. SVCopilot 自建对象写入 namespaced scriptData ID（跨 snapshot 稳定）；
//   2. 外部/无标签对象用 context-scoped controlId + 内容 fingerprint（fingerprint 才是真正身份，
//      indexInGroup 只是捕获时的提示）。
//
// 单位与坐标纪律（不得混用无标签数值，见 GOAL §5.4）：
//   - position 是 group-local 整数 BLICK；occurrence 绝对 BLICK = groupLocal + timeOffsetBlick。
//   - Point.pitch / Curve anchor.pitch 是 group-relative semitone；occurrence 绝对 semitone =
//     groupRelative + pitchOffsetSemitone。
//   - Curve 的每个控制点是 [相对 anchor position 的 BLICK, 相对 anchor pitch 的 semitone]——
//     相对 curve anchor，不相对 group。读模型保持这一原始坐标，绝不提前展开成绝对值。
//   - pitchDelta Automation 用 cents、Note.detune 用 cents，与这里的 semitone 是不同量纲，
//     本模块所有字段名都带单位后缀，从 schema 上阻止混用。

export const PITCH_CONTROL_LIMITS = Object.freeze({
  // 单个 group 一次读取的 PitchControl 上限（超出即预算错误，不做部分读取）。
  controlsPerGroup: 512,
  // 整个 range 内捕获的 PitchControl 总数上限。
  controlsPerSnapshot: 4_000,
  // 单条 Curve 的控制点上限（读与写共用；超出即拒绝）。
  curvePointsPerControl: 2_000,
  // sv_patch_pitch_controls 单请求 operation 上限。
  operationsPerRequest: 32,
});

// SVCopilot 自有标记命名空间。外部脚本标记（mm_Flag、pfb_v1 等）只作来源提示，
// 绝不视为 SVCopilot 所有权。
export const OWNERSHIP = Object.freeze({
  ownerKey: "svcopilot.owner",
  controlIdKey: "svcopilot.controlId",
  generatorKey: "svcopilot.generator",
  schemaVersionKey: "svcopilot.schemaVersion",
  ownerValue: "svcopilot",
});
export const PITCH_CONTROL_SCHEMA_VERSION = "1";

// pitch 比较的绝对 + 相对 epsilon（semitone）。与 Automation 的容差哲学一致：
// 绝对项吸收零附近的 float32 噪声，相对项吸收大数值处的噪声。1e-4 semitone = 0.01 cent，
// 远低于任何可听/可编辑粒度。BLICK 位置与点数量走精确比较，不用 epsilon。
export const PITCH_ABS_EPSILON = 1e-4;
export const PITCH_REL_EPSILON = 1e-6;

// 归一化 Curve 原始 getPoints 结果：[ [time, value], ... ] -> 有序、去重校验后的
// { timeFromAnchorBlick, pitchFromAnchorSemitone }。typed-v2 解码后应是干净的嵌套数组；
// 任何非数组项、NaN/Inf、非整数 time、重复 time 都在此拒绝（HOST_DATA_INVALID 用于读路径，
// 写路径由 patch 模块用 INVALID_ARGUMENTS 自行校验）。
export function normalizeCurvePoints(raw, { errorFactory = hostDataError } = {}) {
  if (!Array.isArray(raw)) {
    throw errorFactory("curve points must be an array");
  }
  const source = raw;
  const points = [];
  for (const entry of source) {
    if (!Array.isArray(entry) || entry.length < 2) {
      throw errorFactory(
        "curve point must be [integer timeFromAnchorBlick, finite pitchFromAnchorSemitone]"
      );
    }
    const time = entry[0];
    const value = entry[1];
    if (!Number.isSafeInteger(time) || !Number.isFinite(value)) {
      throw errorFactory(
        "curve point must be [integer timeFromAnchorBlick, finite pitchFromAnchorSemitone]"
      );
    }
    points.push({ timeFromAnchorBlick: time, pitchFromAnchorSemitone: value });
  }
  points.sort((a, b) => a.timeFromAnchorBlick - b.timeFromAnchorBlick);
  for (let index = 1; index < points.length; index += 1) {
    if (points[index].timeFromAnchorBlick === points[index - 1].timeFromAnchorBlick) {
      throw errorFactory("curve points must have strictly increasing anchor-relative times");
    }
  }
  return points;
}

// 读取一个 group 的全部 PitchControl，返回规范化对象（不含最终 controlId——
// occurrenceId 要在 prepareStoredRange 才确定）与 group fingerprint。
// groupCtx: { group, groupUuid, timeOffsetBlick, pitchOffsetSemitone }
export async function readPitchControlsForGroup(
  capture,
  groupCtx,
  { maxControls = PITCH_CONTROL_LIMITS.controlsPerGroup, maxCurvePoints = PITCH_CONTROL_LIMITS.curvePointsPerControl } = {}
) {
  const count = await capture.call(groupCtx.group, "getNumPitchControls");
  if (!Number.isSafeInteger(count) || count < 0) {
    throw hostDataError("NoteGroup.getNumPitchControls returned a non-integer");
  }
  if (count > maxControls) {
    throw codedError(
      "SNAPSHOT_PITCH_CONTROL_LIMIT_REACHED",
      `the group holds ${count} pitch controls, exceeding the ${maxControls}-control capture limit; narrow the range`
    );
  }
  const controls = [];
  for (let index = 0; index < count; index += 1) {
    // getPitchControl 用 1-based 索引（Lua 约定），返回 Point 或 Curve——宿主只报
    // type:'object'，必须探测 getPoints 才能判别（Curve 独有；Point 抛 no such method）。
    const handle = await capture.call(groupCtx.group, "getPitchControl", [index + 1]);
    if (!handle?.__handle__) {
      throw hostDataError(`getPitchControl(${index + 1}) returned no object`);
    }
    controls.push(await readOnePitchControl(capture, handle, groupCtx, index, { maxCurvePoints }));
  }
  return {
    controls,
    groupFingerprint: computeGroupFingerprint(controls, groupCtx.groupUuid),
  };
}

async function readOnePitchControl(capture, handle, groupCtx, indexInGroup, { maxCurvePoints }) {
  const positionBlick = await capture.call(handle, "getPosition");
  const pitchSemitone = await capture.call(handle, "getPitch");
  if (!Number.isSafeInteger(positionBlick)) {
    throw hostDataError("PitchControl.getPosition returned a non-integer blick");
  }
  if (!Number.isFinite(pitchSemitone)) {
    throw hostDataError("PitchControl.getPitch returned a non-finite semitone");
  }

  let kind = "point";
  let points = null;
  try {
    const rawPoints = await capture.call(handle, "getPoints", [], {
      resultFormat: "typed-v2",
      resultShape: "array",
    });
    kind = "curve";
    points = normalizeCurvePoints(rawPoints);
    if (points.length > maxCurvePoints) {
      throw codedError(
        "SNAPSHOT_PITCH_CONTROL_LIMIT_REACHED",
        `a pitch curve holds ${points.length} points, exceeding the ${maxCurvePoints}-point capture limit`
      );
    }
  } catch (error) {
    if (error?.code === "UNKNOWN_METHOD") {
      kind = "point";
      points = null;
    } else {
      throw error;
    }
  }

  const scriptDataKeys = normalizeScriptDataKeys(
    await capture.call(handle, "getScriptDataKeys", [], {
      resultFormat: "typed-v2",
      resultShape: "array",
    })
  );
  const ownedValues = await readOwnedValues(capture, handle, scriptDataKeys);

  const base = {
    kind,
    indexInGroup,
    ownership: publicOwnership(ownedValues, scriptDataKeys),
    ownedControlId: ownedValues?.controlId ?? null,
    fingerprint: computeControlFingerprint(
      { kind, positionBlick, pitchSemitone, points, ownedValues },
      groupCtx.groupUuid
    ),
  };
  if (kind === "curve") {
    return {
      ...base,
      anchor: {
        groupLocalBlick: positionBlick,
        occurrenceAbsoluteBlick: positionBlick + groupCtx.timeOffsetBlick,
        groupRelativeSemitone: pitchSemitone,
        occurrenceAbsoluteSemitone: pitchSemitone + groupCtx.pitchOffsetSemitone,
      },
      points,
    };
  }
  return {
    ...base,
    position: {
      groupLocalBlick: positionBlick,
      occurrenceAbsoluteBlick: positionBlick + groupCtx.timeOffsetBlick,
    },
    pitch: {
      groupRelativeSemitone: pitchSemitone,
      occurrenceAbsoluteSemitone: pitchSemitone + groupCtx.pitchOffsetSemitone,
    },
  };
}

// 只读取 SVCopilot 命名空间里的值用于身份与所有权判定；外部脚本的任意值不在读模型暴露
// （clone/rollback 需要完整保存 scriptData，那是 patch 模块的 journal 职责，不在此读取）。
// 返回形状与 extractOwnedValues 完全一致（四键、缺省为 null、全空为 null），保证 snapshot
// 与 patch live 读出的 fingerprint 可互相解析。
async function readOwnedValues(capture, handle, scriptDataKeys) {
  const present = (key) => scriptDataKeys.includes(key);
  const read = async (key) =>
    present(key) ? await capture.call(handle, "getScriptData", [key], { resultFormat: "typed-v2" }) : null;
  const owned = {
    owner: (await read(OWNERSHIP.ownerKey)) ?? null,
    controlId: (await read(OWNERSHIP.controlIdKey)) ?? null,
    generator: (await read(OWNERSHIP.generatorKey)) ?? null,
    schemaVersion: (await read(OWNERSHIP.schemaVersionKey)) ?? null,
  };
  for (const key of Object.keys(owned)) {
    if (typeof owned[key] !== "string") owned[key] = null;
  }
  return Object.values(owned).every((value) => value === null) ? null : owned;
}

// 从完整 scriptData map 提取 SVCopilot 命名空间值（fingerprint 的所有权分量）。
// snapshot 读路径与 patch 的 live 读路径都用它，保证两处 fingerprint 严格一致。
export function extractOwnedValues(scriptData) {
  if (!isRecord(scriptData)) return null;
  const owned = {
    owner: typeof scriptData[OWNERSHIP.ownerKey] === "string" ? scriptData[OWNERSHIP.ownerKey] : null,
    controlId:
      typeof scriptData[OWNERSHIP.controlIdKey] === "string" ? scriptData[OWNERSHIP.controlIdKey] : null,
    generator:
      typeof scriptData[OWNERSHIP.generatorKey] === "string" ? scriptData[OWNERSHIP.generatorKey] : null,
    schemaVersion:
      typeof scriptData[OWNERSHIP.schemaVersionKey] === "string"
        ? scriptData[OWNERSHIP.schemaVersionKey]
        : null,
  };
  return Object.values(owned).every((value) => value === null) ? null : owned;
}

function publicOwnership(ownedValues, scriptDataKeys) {
  const isSvcopilot = ownedValues?.owner === OWNERSHIP.ownerValue;
  const ownership = {
    owner: isSvcopilot ? "svcopilot" : "external_or_unknown",
    scriptDataKeys,
  };
  if (isSvcopilot) {
    if (typeof ownedValues.controlId === "string") ownership.controlId = ownedValues.controlId;
    if (typeof ownedValues.generator === "string") ownership.generator = ownedValues.generator;
    if (typeof ownedValues.schemaVersion === "string") {
      ownership.schemaVersion = ownedValues.schemaVersion;
    }
  }
  return ownership;
}

// 单个 PitchControl 的内容 fingerprint：kind + group-local position + group-relative pitch +
// 完整有序 points + SVCopilot 命名空间值 + 目标 group UUID。刻意不含 indexInGroup
// （重排不改变对象本质身份），也不含相邻摘要（那是 group 级 fingerprint 的职责）。
export function computeControlFingerprint(control, groupUuid) {
  return `sha256:${sha256Hex(
    stableStringify({
      v: 1,
      kind: control.kind,
      positionBlick: control.positionBlick,
      pitchSemitone: control.pitchSemitone,
      points: control.points ?? null,
      ownership: control.ownedValues ?? null,
      groupUuid: groupUuid ?? null,
    })
  )}`;
}

// group 级 fingerprint：对象数量 + 有序 per-control fingerprint 序列。任何增删、重排或
// 单对象内容变化都会改变它——这是 target.expectedPitchControlFingerprint 比对的全组守卫。
export function computeGroupFingerprint(controls, groupUuid) {
  return `sha256:${sha256Hex(
    stableStringify({
      v: 1,
      groupUuid: groupUuid ?? null,
      count: controls.length,
      ordered: controls.map((control) => control.fingerprint),
    })
  )}`;
}

// context-scoped controlId：外部/无标签对象用 occurrenceId + 捕获索引。SVCopilot 自有对象
// 直接暴露其 scriptData 里的持久 controlId（跨 snapshot 稳定）。fingerprint 才是真正身份。
export function finalizeControlId(control, occurrenceId) {
  if (typeof control.ownedControlId === "string" && control.ownedControlId) {
    return control.ownedControlId;
  }
  return makeContextControlId(occurrenceId, control.indexInGroup);
}

export function makeContextControlId(occurrenceId, indexInGroup) {
  return `${occurrenceId}:pc:${indexInGroup}`;
}

// 解析 context-scoped controlId，取出 occurrenceId 与捕获索引提示。owned controlId
// （不 match 此格式）返回 null——它不含 occurrence/index 信息。
export function parseContextControlId(controlId) {
  if (typeof controlId !== "string") return null;
  const match = controlId.match(/^(.*):pc:(\d+)$/);
  if (!match) return null;
  return { occurrenceId: match[1], indexInGroup: Number(match[2]) };
}

// pitch 浮点相等（semitone）：绝对 + 相对 epsilon。用于 read-back 验证，不用于 fingerprint
// （fingerprint 直接哈希宿主读回的精确 double，保证同一存储值两次读取指纹一致）。
export function pitchEquals(a, b, { abs = PITCH_ABS_EPSILON, rel = PITCH_REL_EPSILON } = {}) {
  return Math.abs(a - b) <= Math.max(abs, Math.abs(a) * rel, Math.abs(b) * rel);
}

// scriptDataKeys 必须是非 $sv 的字符串数组；typed-v2 解码后的内部信封键不得泄漏为业务数据。
function normalizeScriptDataKeys(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter((key) => typeof key === "string" && !key.startsWith("$sv"));
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function hostDataError(message) {
  return codedError("HOST_DATA_INVALID", message);
}

export function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
