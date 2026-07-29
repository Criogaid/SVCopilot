/**
 * 音符指纹读取适配器。
 *
 * 新桥宣告 `read_note_fingerprints_v1` 时走有界批量读取；旧桥（或批量被结构化拒绝）
 * 退回现有逐 getter 路径。两条路径必须输出同一 normalized model —— 上层用
 * isDeepStrictEqual 比对快照里存的指纹，任何字段表示差异都会变成假 STALE_CONTEXT。
 */

export const READ_NOTE_FINGERPRINTS_V1 = "read_note_fingerprints_v1";

// 字段顺序即 normalized model 的键顺序，必须与 snapshot.js / context-target.js 一致。
export const NOTE_FINGERPRINT_FIELDS = Object.freeze([
  "indexInGroup",
  "onsetBlick",
  "durationBlick",
  "pitch",
  "lyrics",
  "phonemesOverride",
  "languageOverride",
  "detuneCents",
]);

const FIELD_GETTERS = Object.freeze({
  indexInGroup: "getIndexInParent",
  onsetBlick: "getOnset",
  durationBlick: "getDuration",
  pitch: "getPitch",
  lyrics: "getLyrics",
  phonemesOverride: "getPhonemes",
  languageOverride: "getLanguageOverride",
  detuneCents: "getDetune",
});

// 与 Lua 侧 BULK_MAX_NOTES / BULK_RESULT_BUDGET / BULK_FIELD_ESTIMATE 保持一致。
// Node 先按同一公式切块，正常情况下不该让宿主返回 FRAME_TOO_LARGE。
const BULK_MAX_NOTES = 200;
const BULK_RESULT_BUDGET = 60 * 1024;
const BULK_FIELD_ESTIMATE = 48;

export function bulkChunkSize(fieldCount) {
  const perNote = 48 + fieldCount * BULK_FIELD_ESTIMATE;
  const fits = Math.floor((BULK_RESULT_BUDGET - 64) / perNote);
  return Math.max(1, Math.min(BULK_MAX_NOTES, fits));
}

export function createBulkStats() {
  return { bulkHostCalls: 0, bulkNotes: 0, bulkFields: 0, fallbackUsed: false, fallbackReason: null };
}

/**
 * 读取一组音符的指纹。
 *
 * 调用方已经为写入解析好 note handle（`notes`，与 `noteIndicesInGroup` 同序），
 * 本适配器只负责字段读取：批量路径完全不碰这些 handle，回退路径直接在它们上面调
 * getter —— 绝不重新 getNote，否则回退路径的 host-call 数会比改造前更差。
 *
 * `stats` 可选，用于把批量诊断计数带回调用方；绝不记录歌词或音素内容。
 */
export async function readNoteFingerprints(
  scope,
  {
    host,
    notes,
    trackIndex,
    groupReferenceIndex,
    expectedGroupUuid = null,
    noteIndicesInGroup,
    fields = NOTE_FINGERPRINT_FIELDS,
    stats = null,
  }
) {
  const indices = [...noteIndicesInGroup];
  if (indices.length === 0) return [];
  if (!Array.isArray(notes) || notes.length !== indices.length) {
    throw codedError(
      "INVALID_ARGUMENTS",
      "notes must be the resolved note handles for noteIndicesInGroup, in the same order"
    );
  }

  const canBulk =
    host?.supportsOp?.(READ_NOTE_FINGERPRINTS_V1) === true &&
    typeof host.bulk === "function" &&
    Number.isSafeInteger(trackIndex) &&
    Number.isSafeInteger(groupReferenceIndex);

  if (canBulk) {
    try {
      return await readViaBulk(host, {
        trackIndex,
        groupReferenceIndex,
        expectedGroupUuid,
        indices,
        fields,
        stats,
      });
    } catch (error) {
      // STALE_GROUP_UUID 是真实的前置条件失败，不是能力问题：必须原样上抛，
      // 否则回退路径会在已经变动的 Group 上重新读一遍并掩盖过期。
      if (!isBulkCapabilityFailure(error)) throw error;
      if (stats) {
        stats.fallbackUsed = true;
        stats.fallbackReason = error.code ?? "BULK_FAILED";
      }
    }
  }

  if (stats && !stats.fallbackUsed) {
    stats.fallbackUsed = true;
    stats.fallbackReason = "HOST_CAPABILITY_ABSENT";
  }
  return readViaGetters(scope, notes, fields);
}

async function readViaBulk(
  host,
  { trackIndex, groupReferenceIndex, expectedGroupUuid, indices, fields, stats }
) {
  const chunkSize = bulkChunkSize(fields.length);
  const byIndex = new Map();
  for (let offset = 0; offset < indices.length; offset += chunkSize) {
    const chunk = indices.slice(offset, offset + chunkSize);
    const command = {
      op: READ_NOTE_FINGERPRINTS_V1,
      trackIndex,
      groupReferenceIndex,
      noteIndicesInGroup: chunk,
      fields: [...fields],
      resultFormat: "typed-v2",
    };
    if (typeof expectedGroupUuid === "string") command.expectedGroupUuid = expectedGroupUuid;

    const result = await host.bulk(command);
    if (stats) {
      stats.bulkHostCalls += 1;
      stats.bulkNotes += chunk.length;
      stats.bulkFields = fields.length;
    }
    const items = Array.isArray(result?.items) ? result.items : [];
    if (items.length !== chunk.length) {
      throw codedError(
        "HOST_CALL_FAILED",
        `bulk fingerprint read returned ${items.length} of ${chunk.length} requested notes`
      );
    }
    for (const item of items) {
      byIndex.set(item.noteIndexInGroup, normalizeFingerprint(item.fingerprint, fields));
    }
  }

  return indices.map((index) => {
    const fingerprint = byIndex.get(index);
    if (!fingerprint) {
      throw codedError("HOST_CALL_FAILED", `bulk fingerprint read omitted note ${index}`);
    }
    return fingerprint;
  });
}

async function readViaGetters(scope, notes, fields) {
  const output = [];
  for (const note of notes) {
    const fingerprint = {};
    for (const field of fields) {
      const raw = await scope.call(note, FIELD_GETTERS[field]);
      fingerprint[field] = field === "indexInGroup" ? toExternalIndex(raw) : raw;
    }
    output.push(fingerprint);
  }
  return output;
}

// 批量路径用 typed-v2 信封无损承载 nil 和特殊数字，逐 getter 的 legacy marshal 不能：
// 那里 nil 变成 undefined（键缺失），NaN/±Inf 被降级成 null。快照里存的指纹来自
// legacy 路径，所以批量结果必须收敛到 legacy 的表示，否则同一音符在两条路径上
// 不深度相等，会被上层误判成 STALE_CONTEXT。
function normalizeFingerprint(fingerprint, fields) {
  const output = {};
  for (const field of fields) {
    const value = fingerprint?.[field];
    if (value === null) {
      output[field] = undefined;
    } else if (isSpecialNumber(value)) {
      output[field] = null;
    } else {
      output[field] = value;
    }
  }
  return output;
}

function isSpecialNumber(value) {
  return value !== null && typeof value === "object" && value.$sv === "number";
}

function isBulkCapabilityFailure(error) {
  return ["UNSUPPORTED_HOST_CAPABILITY", "FRAME_TOO_LARGE", "UNKNOWN_METHOD"].includes(error?.code);
}

function toExternalIndex(luaIndex) {
  return Number.isSafeInteger(luaIndex) ? luaIndex - 1 : null;
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
