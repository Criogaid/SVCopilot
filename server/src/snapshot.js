import { randomBytes } from "node:crypto";
import { canonicalClone } from "./canonical-json.js";

import { analyzePhonemeResult, observedArrayIndices } from "./phoneme-state.js";
import { collectHandleRefs } from "./wire-codec.js";
import { normalizeVoiceParameters } from "./voice-parameters.js";
import { ServiceTiming } from "./service-timing.js";

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 200;
const MAX_SNAPSHOT_NOTES = 2_000;
export const MAX_PROJECT_PAGE_ITEMS = 16;

// TTL 从 5 分钟提高到 30 分钟，消除「读大 Artifact -> 分析 -> 生成大请求 ->
// UNKNOWN_CONTEXT」整轮重做。但延长租期必须与字节配额同时落地：否则 64 个
// 373-note Context 可以长期共存，把 TTL 收益换成无界驻留内存。
export const DEFAULT_CONTEXT_TTL_MS = 30 * 60_000;
export const MAX_CONTEXT_TTL_MS = 60 * 60_000;
export const DEFAULT_CONTEXT_QUOTAS = Object.freeze({
  maxEntries: 64,
  maxContextBytes: 8 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  // tombstone 让 UNKNOWN_CONTEXT 能区分 expired / evicted_by_quota /
  // invalidated_by_mutation / epoch_changed，而不是一律报 unknown。
  maxTombstones: 256,
});

// Context 失效原因。伪造的 ID 只能是 unknown，不得声称可恢复。
export const CONTEXT_UNAVAILABLE_REASONS = Object.freeze([
  "unknown",
  "expired",
  "epoch_changed",
  "invalidated_by_mutation",
  "evicted_by_quota",
]);

export class SnapshotStore {
  constructor({
    ttlMs = DEFAULT_CONTEXT_TTL_MS,
    maxEntries,
    quotas = {},
    now = () => Date.now(),
  } = {}) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new TypeError("SnapshotStore ttlMs must be a positive safe integer");
    }
    this.ttlMs = Math.min(ttlMs, MAX_CONTEXT_TTL_MS);
    this.quotas = {
      ...DEFAULT_CONTEXT_QUOTAS,
      ...quotas,
      // maxEntries 是旧构造参数，保留为配额的别名而不是第二套限制。
      ...(maxEntries === undefined ? {} : { maxEntries }),
    };
    this.now = now;
    this.entries = new Map();
    // contextId -> { reason, at }。只登记失效原因和时间，不留内容。
    this.tombstones = new Map();
    this.accountedBytes = 0;
    this.evictions = 0;
    this._pinned = new Set();
  }

  create(snapshot) {
    this._prune();
    const contextId = createContextId();
    const entry = {
      ...snapshot,
      contextId,
      createdAt: this.now(),
      expiresAt: this.now() + this.ttlMs,
    };
    entry.accountedBytes = estimateRetainedBytes(entry);
    this._admit(entry);
    return this.entries.get(contextId);
  }

  get(contextId) {
    this._prune();
    return this.entries.get(contextId) ?? null;
  }

  /**
   * Context 不可用的原因。有界 tombstone 之外一律是 unknown——伪造的 ID
   * 不得被描述成"过期"，那会让调用方以为重试或重新快照必然可行。
   *
   * @param {string} contextId
   * @returns {"unknown"|"expired"|"epoch_changed"|"invalidated_by_mutation"|"evicted_by_quota"}
   */
  reasonFor(contextId) {
    this._prune();
    if (this.entries.has(contextId)) return null;
    return this.tombstones.get(contextId)?.reason ?? "unknown";
  }

  /**
   * 在解析期固定 Context，避免另一个 snapshot 请求把它按 LRU 淘汰。
   *
   * @param {string} contextId
   * @returns {() => void} 释放函数
   */
  pin(contextId) {
    this._pinned.add(contextId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this._pinned.delete(contextId);
    };
  }


  delete(contextId, reason = "invalidated_by_mutation") {
    const entry = this.entries.get(contextId);
    if (!entry) return false;
    this.accountedBytes -= entry.accountedBytes ?? 0;
    this.entries.delete(contextId);
    this._tombstone(contextId, reason);
    return true;
  }

  /**
   * 失效所有指向同一个 NoteGroup 的 Context（§4.6）。
   *
   * 单删发起写入的那一个是不够的：同一个 NoteGroup 可以被多个 Context 捕获
   * （不同 range、不同 track 的引用、或先后两次快照），它们全都在这次写入后过期。
   * 只删一个会让剩下的继续被信任，而它们的 fingerprint 已经不再描述宿主。
   *
   * @param {string} targetGroupUuid
   * @param {string} [reason]
   * @returns {string[]} 被失效的 contextId
   */
  invalidateContextsForTarget(targetGroupUuid, reason = "invalidated_by_mutation") {
    if (typeof targetGroupUuid !== "string" || targetGroupUuid === "") return [];
    const affected = [];
    for (const [contextId, entry] of this.entries) {
      if (contextTouchesTarget(entry, targetGroupUuid)) affected.push(contextId);
    }
    for (const contextId of affected) this.delete(contextId, reason);
    return affected;
  }

  /**
   * 失效受工程结构变化影响的全部 Context（§4.6 的 clone_track 行）。
   *
   * clone_track 插入一条轨道，于是**所有** Context 里记录的 trackIndex 都可能指向
   * 别的轨道了。按 NoteGroup 失效在这里不够：受影响的不是某个音符组，而是索引本身
   * 的含义。因此这是唯一一处全量失效。
   *
   * @param {string} [reason]
   * @returns {string[]}
   */
  invalidateAllForProjectStructureChange(reason = "invalidated_by_mutation") {
    const affected = [...this.entries.keys()];
    for (const contextId of affected) this.delete(contextId, reason);
    return affected;
  }

  /**
   * 存储可观测面，供 doctor 报告。accountedBytes 是逻辑驻留字节
   * （canonical payload 的 UTF-8 bytes），不是 V8 heap 实测值。
   */
  stats() {
    this._prune();
    return {
      entries: this.entries.size,
      accountedBytes: this.accountedBytes,
      evictions: this.evictions,
      ttlMs: this.ttlMs,
      maxTotalBytes: this.quotas.maxTotalBytes,
    };
  }

  encodeCursor(contextId, offset, kind = "notes") {
    return Buffer.from(JSON.stringify({ contextId, offset, kind }), "utf8").toString("base64url");
  }

  decodeCursor(cursor) {
    try {
      const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      if (
        typeof parsed.contextId !== "string" ||
        !Number.isSafeInteger(parsed.offset) ||
        (parsed.kind !== undefined && typeof parsed.kind !== "string")
      ) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  _admit(entry) {
    if (entry.accountedBytes > this.quotas.maxContextBytes) {
      throw codedError(
        "CONTEXT_CAPACITY_EXCEEDED",
        `snapshot context ${entry.accountedBytes} bytes exceeds max ${this.quotas.maxContextBytes}`
      );
    }
    this.entries.set(entry.contextId, entry);
    this.accountedBytes += entry.accountedBytes;
    this.tombstones.delete(entry.contextId);
    this._enforceQuotas(entry.contextId);
  }

  // LRU 只淘汰非活跃 Context：正在被 planner 解析的 Context 必须留下，
  // 否则一次并发 snapshot 会让解析中途的 contextId 突然消失。
  _enforceQuotas(protectedId) {
    while (
      this.entries.size > this.quotas.maxEntries ||
      this.accountedBytes > this.quotas.maxTotalBytes
    ) {
      const victim = this._oldestEvictable(protectedId);
      if (victim === null) break;
      const entry = this.entries.get(victim);
      this.accountedBytes -= entry.accountedBytes ?? 0;
      this.entries.delete(victim);
      this._tombstone(victim, "evicted_by_quota");
      this.evictions += 1;
    }
  }

  _oldestEvictable(protectedId) {
    for (const key of this.entries.keys()) {
      if (key === protectedId || this._pinned.has(key)) continue;
      return key;
    }
    return null;
  }

  _tombstone(contextId, reason) {
    this.tombstones.set(contextId, { reason, at: this.now() });
    while (this.tombstones.size > this.quotas.maxTombstones) {
      this.tombstones.delete(this.tombstones.keys().next().value);
    }
  }

  _prune() {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.accountedBytes -= entry.accountedBytes ?? 0;
        this.entries.delete(key);
        this._tombstone(key, "expired");
      }
    }
    // tombstone 也必须有界：按 TTL 之外再留一个 TTL 的诊断窗口。
    const cutoff = now - this.ttlMs;
    for (const [key, record] of this.tombstones) {
      if (record.at <= cutoff) this.tombstones.delete(key);
    }
  }
}

/**
 * 统一的 UNKNOWN_CONTEXT 错误。Context 失效有五种原因，调用方的正确动作各不相同：
 * expired / evicted_by_quota 重新快照即可；epoch_changed 说明桥重连过；
 * invalidated_by_mutation 说明写入已生效；unknown 则可能根本是伪造的 ID。
 * 只报一个笼统的"not found or expired"会让模型猜。
 *
 * @param {SnapshotStore} store
 * @param {string} contextId
 * @param {string} [label] - 多 context 请求里用于定位是哪一个
 * @returns {Error}
 */
export function unknownContextError(store, contextId, label) {
  const reason = store?.reasonFor?.(contextId) ?? "unknown";
  const prefix = label ? `${label}: ` : "";
  const error = new Error(
    `${prefix}contextId is not available (${reason}); re-run sv_snapshot_range`
  );
  error.code = "UNKNOWN_CONTEXT";
  error.details = { reason };
  return error;
}

// 96-bit Base64URL 随机值，不再使用 UUID 文本：短、无结构、不编码时间或宿主身份。
// 一个 Context 是否捕获了给定 NoteGroup。三种 context kind 记录目标的方式不同：
// range 在每个 occurrence 上带 targetGroupUuid；group/selection 只记 track/group 索引，
// 拿不到 UUID。
//
// 对后两者返回 true 是刻意的保守选择：宁可多失效一个仍然有效的 Context（代价是一次
// 重新快照），也不能让一个已经过期的 Context 继续被信任（代价是基于错误 fingerprint
// 的写入）。B2 让 group/selection 也记录 targetGroupUuid 后可以收紧。
function contextTouchesTarget(entry, targetGroupUuid) {
  const context = entry?.context;
  if (!context) return false;
  if (context.kind === "range") {
    const occurrences = Array.isArray(context.occurrences) ? context.occurrences : [];
    return occurrences.some((occurrence) => occurrence.targetGroupUuid === targetGroupUuid);
  }
  return context.kind === "group" || context.kind === "selection";
}

function createContextId() {
  return `c_${randomBytes(12).toString("base64url")}`;
}

// 逻辑驻留字节：canonical payload 的 UTF-8 bytes。这不是 V8 heap 实测值，
// 字段名（accountedBytes）必须体现这一点，避免被当成真实内存占用。
function estimateRetainedBytes(entry) {
  try {
    return Buffer.byteLength(JSON.stringify(entry) ?? "", "utf8");
  } catch {
    // 循环引用等无法序列化的情况不应让快照失败；退化为 0 并继续按条数配额约束。
    return 0;
  }
}

export class SnapshotService {
  constructor(session, { store = new SnapshotStore(), now = () => Date.now() } = {}) {
    this.session = session;
    this.store = store;
    this.now = now;
  }

  async snapshot(request = {}) {
    const timer = new ServiceTiming({ now: this.now, phaseNames: ["hostReadMs", "serializationMs"] });
    const pageSize = normalizePageSize(request.pageSize);
    if (request.cursor !== undefined) return this._readCursor(request.cursor, pageSize, timer);

    const scope = normalizeScope(request.scope);
    const include = new Set(
      Array.isArray(request.include)
        ? request.include
        : scope.kind === "selection"
          ? ["notes", "voiceParameters", "processing"]
          : ["structure"]
    );

    timer.requestCoordinator();
    return this.session.withExclusive(async (host) => {
      timer.acquiredCoordinator();
      const capture = createHostScope(host);
      try {
        const roots = await timer.measure("hostReadMs", () => capture.roots());
        const observedAt = new Date(this.now()).toISOString();
        if (scope.kind === "project") {
          const trackCount = await capture.call(roots.project, "getNumTracks");
          const stored = this.store.create({
            epoch: host.epoch(),
            scope,
            observedAt,
            context: { kind: "project" },
            // 跨页只保存位置和纯数据，绝不让 Lua handle 跨请求存活。
            traversal: {
              page: 0,
              emitted: 0,
              trackCount,
              trackIndex: 0,
              groupIndex: 0,
              noteIndex: 0,
              trackSummaries: Object.create(null),
            },
            include: [...include],
          });
          // 必须等待整页结束；外层 finally 会释放本页登记的全部 handle。
          const result = await timer.measure("hostReadMs", () =>
            captureProjectPage(capture, roots, stored, pageSize, this.store)
          );
          return { ...result, timings: timer.finish() };
        }
        const captured = await timer.measure("hostReadMs", () =>
          scope.kind === "selection"
            ? captureSelection(capture, roots, include)
            : captureGroup(capture, roots, scope, include)
        );
        const stored = this.store.create({
          epoch: host.epoch(),
          scope,
          observedAt,
          baseData: captured.baseData,
          notes: captured.notes,
          context: captured.context,
        });
        const result = await timer.measure("serializationMs", async () =>
          formatSnapshotPage(stored, 0, pageSize, this.store)
        );
        return { ...result, timings: timer.finish() };
      } finally {
        await capture.releaseAll();
      }
    });
  }

  /**
   * 取上下文。`capsule` 是 PlanRef 展开出的**只读**范围快照：它不进 store，
   * 因此不可被别人查到、不参与 LRU、也不会与真实快照混淆（§4.3.2）。
   *
   * 这正是 restore() 写回路径被删除的原因——写回让一份只读证据变成了看起来
   * 像真实快照的 store 条目，而它既没有真实快照的来源，也不该有它的生命周期。
   *
   * @param {string} contextId
   * @param {number} epoch
   * @param {object} [options]
   * @param {object} [options.capsule] - 计划封存的最小完整范围快照
   */
  getContext(contextId, epoch, { capsule = null } = {}) {
    const entry = this.store.get(contextId) ?? capsule ?? null;
    if (!entry) throw codedError("UNKNOWN_CONTEXT", `snapshot context not found: ${contextId}`);
    if (entry.epoch !== epoch) {
      throw codedError(
        "STALE_CONTEXT",
        `snapshot belongs to bridge epoch ${entry.epoch}; current epoch is ${epoch}`
      );
    }
    return entry;
  }

  async _readCursor(cursor, pageSize, timer) {
    if (typeof cursor !== "string" || !cursor) {
      throw codedError("INVALID_CURSOR", "cursor must be a non-empty string");
    }
    const decoded = this.store.decodeCursor(cursor);
    if (!decoded) throw codedError("INVALID_CURSOR", "cursor is malformed");
    const stored = this.store.get(decoded.contextId);
    if (!stored) throw codedError("EXPIRED_CURSOR", "cursor snapshot has expired");
    if (stored.traversal) {
      if (decoded.kind !== "project" || decoded.offset !== stored.traversal.page) {
        throw codedError("STALE_CURSOR", "project cursor has already been consumed");
      }
      timer.requestCoordinator();
      return this.session.withExclusive(async (host) => {
        timer.acquiredCoordinator();
        if (stored.epoch !== host.epoch()) {
          throw codedError(
            "STALE_CONTEXT",
            `snapshot belongs to bridge epoch ${stored.epoch}; current epoch is ${host.epoch()}`
          );
        }
        const capture = createHostScope(host);
        try {
          const roots = await capture.roots();
          const result = await timer.measure("hostReadMs", () =>
            captureProjectPage(capture, roots, stored, pageSize, this.store)
          );
          return { ...result, timings: timer.finish() };
        } finally {
          await capture.releaseAll();
        }
      });
    }
    const result = await timer.measure("serializationMs", async () =>
      formatSnapshotPage(stored, decoded.offset, pageSize, this.store)
    );
    return { ...result, timings: timer.finish() };
  }
}

async function captureSelection(capture, roots, include) {
  const currentTrack = await capture.call(roots.mainEditor, "getCurrentTrack", [], {
    inferredType: "Track",
  });
  const currentGroup = await capture.call(roots.mainEditor, "getCurrentGroup", [], {
    inferredType: "NoteGroupReference",
  });
  const selection = await capture.call(roots.mainEditor, "getSelection", [], {
    inferredType: "TrackInnerSelectionState",
  });
  const selectedNotes = await capture.call(selection, "getSelectedNotes", [], {
    resultFormat: "typed-v2",
    resultShape: "array",
    inferredType: "Note",
  });

  const trackIndex = toExternalIndex(await capture.call(currentTrack, "getIndexInParent"));
  const groupIndex = toExternalIndex(await capture.call(currentGroup, "getIndexInParent"));
  const track = await readTrackSummary(capture, currentTrack, trackIndex);
  const group = await readGroupSummary(capture, currentGroup, groupIndex, include);
  const notes = [];
  for (const note of Array.isArray(selectedNotes) ? selectedNotes : []) {
    notes.push(await readNote(capture, note));
  }

  let processing;
  if (include.has("processing")) {
    if (notes.length === 0) {
      processing = analyzePhonemeResult([], 0);
    } else {
      const groupPhonemes = await capture.call(roots.sv, "getPhonemesForGroup", [currentGroup], {
        resultFormat: "typed-v2",
        resultShape: "array",
        resultLength: group.noteCount,
      });
      const phonemeValues = Array.isArray(groupPhonemes) ? groupPhonemes : [];
      const observedGroupIndices = new Set(observedArrayIndices(phonemeValues));
      const selectedObservedIndices = [];
      const selectedPhonemes = notes.map((note, selectedIndex) => {
        if (observedGroupIndices.has(note.indexInGroup)) selectedObservedIndices.push(selectedIndex);
        return phonemeValues[note.indexInGroup] ?? null;
      });
      processing = analyzePhonemeResult(selectedPhonemes, notes.length, {
        observedIndices: selectedObservedIndices,
      });
    }
  }

  return {
    baseData: {
      scope: "selection",
      emptyReason: notes.length === 0 ? "NO_SELECTED_NOTES" : null,
      indexBase: 0,
      units: { time: "blick", pitch: "midi", detune: "cent" },
      track,
      group,
      ...(processing ? { processing } : {}),
      capabilities: { singerIdentity: "unobservable" },
    },
    notes,
    context: {
      kind: "selection",
      trackIndex,
      groupIndex,
      noteIndices: notes.map((note) => note.indexInGroup),
      fingerprints: notes.map(noteFingerprint),
    },
  };
}

async function captureGroup(capture, roots, scope, include) {
  const project = roots.project;
  const trackCount = await capture.call(project, "getNumTracks");
  if (scope.trackIndex >= trackCount) {
    throw codedError(
      "TRACK_INDEX_OUT_OF_RANGE",
      `trackIndex ${scope.trackIndex} is outside 0-${Math.max(0, trackCount - 1)} (native index ${scope.trackIndex + 1})`
    );
  }
  const tracks = [];
  const notes = [];
  const targetTrackIndices = [scope.trackIndex];

  for (const trackIndex of targetTrackIndices) {
    const trackHandle = await capture.call(project, "getTrack", [trackIndex + 1], {
      inferredType: "Track",
    });
    const track = await readTrackSummary(capture, trackHandle, trackIndex);
    if (scope.groupIndex >= track.groupCount) {
      throw codedError(
        "GROUP_INDEX_OUT_OF_RANGE",
        `groupIndex ${scope.groupIndex} is outside 0-${Math.max(0, track.groupCount - 1)} for trackIndex ${trackIndex} (native index ${scope.groupIndex + 1})`
      );
    }
    track.groups = [];
    const groupIndices = [scope.groupIndex];
    for (const groupIndex of groupIndices) {
      const groupHandle = await capture.call(trackHandle, "getGroupReference", [groupIndex + 1], {
        inferredType: "NoteGroupReference",
      });
      const group = await readGroupSummary(capture, groupHandle, groupIndex, include);
      if (include.has("processing")) {
        group.processing = await readProcessingSummary(capture, roots, groupHandle, group);
      }
      track.groups.push(group);
      if (include.has("notes") && !group.instrumental) {
        const target = await capture.call(groupHandle, "getTarget", [], { inferredType: "NoteGroup" });
        const noteCount = await capture.call(target, "getNumNotes");
        for (let noteIndex = 0; noteIndex < noteCount; noteIndex += 1) {
          if (notes.length >= MAX_SNAPSHOT_NOTES) break;
          const noteHandle = await capture.call(target, "getNote", [noteIndex + 1], {
            inferredType: "Note",
          });
          notes.push({
            trackIndex,
            groupIndex,
            ...(await readNote(capture, noteHandle)),
          });
        }
      }
    }
    tracks.push(track);
  }

  const groupContext = {
    kind: "group",
    trackIndex: scope.trackIndex,
    groupIndex: scope.groupIndex,
    noteIndices: notes.map((note) => note.indexInGroup),
    fingerprints: notes.map(noteFingerprint),
  };
  const processing = tracks[0]?.groups[0]?.processing;
  return {
    baseData: {
      scope: "group",
      indexBase: 0,
      units: { time: "blick", pitch: "midi", detune: "cent" },
      trackCount,
      tracks,
      ...(processing ? { processing } : {}),
      capabilities: { singerIdentity: "unobservable" },
      snapshotNoteLimitReached: notes.length >= MAX_SNAPSHOT_NOTES,
    },
    notes,
    context: groupContext,
  };
}

async function captureProjectPage(capture, roots, stored, requestedPageSize, store) {
  const state = stored.traversal;
  // 遍历只推进影子游标；整页成功后一次性提交回 stored.traversal。
  // 否则中途宿主报错（如不改 epoch 的 HOST_TIMEOUT）会把已推进的索引留在游标里，
  // 同 cursor 重试时静默跳过这些音符/组，最后还谎报 snapshotComplete。
  const shadow = {
    trackIndex: state.trackIndex,
    groupIndex: state.groupIndex,
    noteIndex: state.noteIndex,
  };
  const startedMidTrack = shadow.groupIndex > 0 || shadow.noteIndex > 0;
  const startTrackIndex = shadow.trackIndex;
  const include = new Set(stored.include);
  const includeNotes = include.has("notes");
  const effectivePageSize = Math.min(requestedPageSize, MAX_PROJECT_PAGE_ITEMS);
  const pageTracks = [];
  const pageTrackMap = new Map();
  const notes = [];
  let emitted = 0;

  const addTrack = (summary) => {
    let track = pageTrackMap.get(summary.index);
    if (!track) {
      track = { ...summary, groups: [] };
      pageTrackMap.set(summary.index, track);
      pageTracks.push(track);
    }
    return track;
  };

  while (shadow.trackIndex < state.trackCount && emitted < effectivePageSize) {
    const trackIndex = shadow.trackIndex;
    const trackHandle = await capture.call(roots.project, "getTrack", [trackIndex + 1], {
      inferredType: "Track",
    });
    let trackSummary = state.trackSummaries[trackIndex];
    if (!trackSummary) {
      trackSummary = await readTrackSummary(capture, trackHandle, trackIndex);
      state.trackSummaries[trackIndex] = trackSummary;
    }
    const pageTrack = addTrack(trackSummary);

    if (trackSummary.groupCount === 0) {
      shadow.trackIndex += 1;
      shadow.groupIndex = 0;
      shadow.noteIndex = 0;
      emitted += 1;
      continue;
    }

    while (shadow.groupIndex < trackSummary.groupCount && emitted < effectivePageSize) {
      const groupIndex = shadow.groupIndex;
      const groupHandle = await capture.call(trackHandle, "getGroupReference", [groupIndex + 1], {
        inferredType: "NoteGroupReference",
      });
      const group = await readGroupSummary(capture, groupHandle, groupIndex, include);
      if (include.has("processing")) {
        group.processing = await readProcessingSummary(capture, roots, groupHandle, group);
      }
      pageTrack.groups.push(group);

      if (!includeNotes || group.noteCount === 0 || group.instrumental) {
        shadow.groupIndex += 1;
        shadow.noteIndex = 0;
        emitted += 1;
        continue;
      }

      const target = await capture.call(groupHandle, "getTarget", [], { inferredType: "NoteGroup" });
      while (shadow.noteIndex < group.noteCount && emitted < effectivePageSize) {
        const noteIndex = shadow.noteIndex;
        const noteHandle = await capture.call(target, "getNote", [noteIndex + 1], {
          inferredType: "Note",
        });
        notes.push({ trackIndex, groupIndex, ...(await readNote(capture, noteHandle)) });
        shadow.noteIndex += 1;
        emitted += 1;
      }
      if (shadow.noteIndex < group.noteCount) break;
      shadow.groupIndex += 1;
      shadow.noteIndex = 0;
    }

    if (shadow.groupIndex < trackSummary.groupCount) break;
    shadow.trackIndex += 1;
    shadow.groupIndex = 0;
    shadow.noteIndex = 0;
  }

  // 整页宿主读取全部成功，才提交游标推进；此前任何 await 抛错都会保持游标不变，
  // 让同一 cursor 的重试从本页页首重新读取。
  state.trackIndex = shadow.trackIndex;
  state.groupIndex = shadow.groupIndex;
  state.noteIndex = shadow.noteIndex;
  state.page += 1;
  state.emitted += emitted;
  const complete = state.trackIndex >= state.trackCount;
  // 单轨可能跨页出现（每页只带它的一部分 group/note）；显式标注让调用方知道必须
  // 按 track index 合并跨页分片，而不是把每页的 groups 当作该轨的全集。
  const endedMidTrack = !complete && (state.groupIndex > 0 || state.noteIndex > 0);
  const firstTrack = pageTrackMap.get(startTrackIndex);
  if (startedMidTrack && firstTrack) firstTrack.continuedFromPreviousPage = true;
  const lastTrack = pageTracks[pageTracks.length - 1];
  if (endedMidTrack && lastTrack) lastTrack.continuesOnNextPage = true;
  for (const track of pageTracks) {
    if (track.continuedFromPreviousPage || track.continuesOnNextPage) track.fragment = true;
  }
  const nextCursor = complete ? null : store.encodeCursor(stored.contextId, state.page, "project");
  const returnedGroups = pageTracks.reduce((count, track) => count + track.groups.length, 0);
  const warnings = [];
  if (requestedPageSize > effectivePageSize) {
    warnings.push({
      code: "PROJECT_PAGE_LIMIT_APPLIED",
      message: `Project traversal is limited to ${MAX_PROJECT_PAGE_ITEMS} host-backed items per page.`,
    });
  }
  return {
    ok: true,
    status: "succeeded",
    contextId: stored.contextId,
    observedAt: stored.observedAt,
    contextExpiresAt: new Date(stored.expiresAt).toISOString(),
    consistency: "best-effort-paged",
    data: {
      scope: "project",
      indexBase: 0,
      units: { time: "blick", pitch: "midi", detune: "cent" },
      trackCount: state.trackCount,
      tracks: pageTracks,
      notes,
      snapshotComplete: complete,
      capabilities: { singerIdentity: "unobservable" },
    },
    page: {
      unit: "traversalItems",
      offset: state.emitted - emitted,
      count: emitted,
      total: null,
      returned: {
        tracks: pageTracks.length,
        groups: returnedGroups,
        notes: notes.length,
      },
      requestedSize: requestedPageSize,
      effectiveSize: effectivePageSize,
      nextCursor,
      truncated: !complete,
    },
    warnings,
  };
}

async function readTrackSummary(capture, track, index) {
  return {
    index,
    name: await capture.call(track, "getName"),
    groupCount: await capture.call(track, "getNumGroups"),
  };
}

async function readGroupSummary(capture, groupReference, index, include) {
  const instrumental = await capture.call(groupReference, "isInstrumental");
  const summary = {
    index,
    instrumental,
    isMain: await capture.call(groupReference, "isMain"),
    onsetBlick: await capture.call(groupReference, "getOnset"),
    timeOffsetBlick: await capture.call(groupReference, "getTimeOffset"),
    pitchOffsetSemitone: await capture.call(groupReference, "getPitchOffset"),
    noteCount: 0,
  };
  if (!instrumental) {
    const target = await capture.call(groupReference, "getTarget", [], {
      inferredType: "NoteGroup",
    });
    summary.name = await capture.call(target, "getName");
    summary.uuid = await capture.call(target, "getUUID");
    summary.noteCount = await capture.call(target, "getNumNotes");
  }
  if (include.has("voiceParameters")) {
    summary.voice = {
      identityStatus: "unobservable",
      parameters: normalizeVoiceParameters(
        await capture.call(groupReference, "getVoice", [], {
          resultFormat: "typed-v2",
        })
      ),
    };
  }
  return summary;
}

async function readProcessingSummary(capture, roots, groupReference, group) {
  if (group.instrumental) {
    return {
      state: "not_applicable",
      expectedNotes: 0,
      computedItems: 0,
      nonEmptyPhonemes: 0,
    };
  }
  const phonemes = await capture.call(roots.sv, "getPhonemesForGroup", [groupReference], {
    resultFormat: "typed-v2",
    resultShape: "array",
    resultLength: group.noteCount,
  });
  return analyzePhonemeResult(phonemes, group.noteCount);
}

async function readNote(capture, note) {
  const indexInGroup = toExternalIndex(await capture.call(note, "getIndexInParent"));
  const onsetBlick = await capture.call(note, "getOnset");
  const durationBlick = await capture.call(note, "getDuration");
  return {
    indexInGroup,
    onsetBlick,
    durationBlick,
    endBlick: onsetBlick + durationBlick,
    pitch: await capture.call(note, "getPitch"),
    lyrics: await capture.call(note, "getLyrics"),
    phonemesOverride: await capture.call(note, "getPhonemes"),
    languageOverride: await capture.call(note, "getLanguageOverride"),
    detuneCents: await capture.call(note, "getDetune"),
  };
}

export function createHostScope(host) {
  const handles = new Map();
  const remember = (value) => collectHandleRefs(value, handles);
  return {
    async roots() {
      const value = await host.roots();
      remember(value);
      return value;
    },
    async call(handle, method, args = [], options = {}) {
      const value = await host.call({ handle, method, args, ...options });
      remember(value);
      return value;
    },
    async index(field, handle) {
      const value = await host.index({ handle, field });
      remember(value);
      return value;
    },
    async releaseAll() {
      for (const handle of [...handles.keys()].reverse()) {
        await host.free(handle).catch(() => {});
      }
    },
  };
}

function formatSnapshotPage(stored, offset, pageSize, store) {
  const notes = stored.notes.slice(offset, offset + pageSize).map((note, pageIndex) => ({
    id: `${stored.contextId}:n:${offset + pageIndex}`,
    ...note,
  }));
  const nextOffset = offset + notes.length;
  const nextCursor =
    nextOffset < stored.notes.length ? store.encodeCursor(stored.contextId, nextOffset) : null;
  return {
    ok: true,
    status:
      stored.scope.kind === "selection" && stored.context.noteIndices.length === 0
        ? "no_change"
        : "succeeded",
    contextId: stored.contextId,
    observedAt: stored.observedAt,
    // 每个 Context 引用携带自己的到期时间；调用方不必从 doctor 聚合值反推。
    contextExpiresAt: new Date(stored.expiresAt).toISOString(),
    consistency: "best-effort",
    data: { ...stored.baseData, notes },
    page: {
      offset,
      count: notes.length,
      total: stored.notes.length,
      nextCursor,
      truncated: nextCursor !== null,
    },
    warnings: [],
  };
}

function noteFingerprint(note) {
  // 字段集合必须与 context-target.js 的 readFingerprint 一致（含 detuneCents，与 range 指纹对齐）。
  return {
    indexInGroup: note.indexInGroup,
    onsetBlick: note.onsetBlick,
    durationBlick: note.durationBlick,
    pitch: note.pitch,
    lyrics: note.lyrics,
    phonemesOverride: note.phonemesOverride,
    languageOverride: note.languageOverride,
    detuneCents: note.detuneCents,
  };
}

function normalizeScope(scope) {
  if (scope === undefined) return { kind: "selection" };
  if (!isRecord(scope) || !["selection", "project", "group"].includes(scope.kind)) {
    throw codedError("INVALID_SCOPE", "scope.kind must be selection, project, or group");
  }
  if (scope.kind === "group") {
    if (!Number.isSafeInteger(scope.trackIndex) || scope.trackIndex < 0) {
      throw codedError("INVALID_SCOPE", "group scope needs a non-negative trackIndex");
    }
    if (!Number.isSafeInteger(scope.groupIndex) || scope.groupIndex < 0) {
      throw codedError("INVALID_SCOPE", "group scope needs a non-negative groupIndex");
    }
  }
  return scope;
}

function normalizePageSize(value) {
  if (value === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE_SIZE) {
    throw codedError("INVALID_PAGE_SIZE", `pageSize must be 1-${MAX_PAGE_SIZE}`);
  }
  return value;
}

function toExternalIndex(luaIndex) {
  return Number.isSafeInteger(luaIndex) ? luaIndex - 1 : null;
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
