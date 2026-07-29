import { randomUUID } from "node:crypto";
import { canonicalClone } from "./canonical-json.js";

import { analyzePhonemeResult, observedArrayIndices } from "./phoneme-state.js";
import { collectHandleRefs } from "./wire-codec.js";
import { normalizeVoiceParameters } from "./voice-parameters.js";
import { ServiceTiming } from "./service-timing.js";

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 200;
const MAX_SNAPSHOT_NOTES = 2_000;
export const MAX_PROJECT_PAGE_ITEMS = 16;

export class SnapshotStore {
  constructor({ ttlMs = 5 * 60_000, maxEntries = 64, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.entries = new Map();
  }

  create(snapshot) {
    this._prune();
    while (this.entries.size >= this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value);
    }
    const contextId = `ctx_${randomUUID()}`;
    this.entries.set(contextId, {
      ...snapshot,
      contextId,
      createdAt: this.now(),
      expiresAt: this.now() + this.ttlMs,
    });
    return this.entries.get(contextId);
  }

  get(contextId) {
    this._prune();
    return this.entries.get(contextId) ?? null;
  }

  restore(contextId, snapshot) {
    this._prune();
    if (this.entries.has(contextId)) return this.entries.get(contextId);
    if (typeof contextId !== "string" || !contextId || !snapshot || typeof snapshot !== "object") {
      throw codedError("INVALID_ARGUMENTS", "restored snapshot requires contextId and snapshot");
    }
    while (this.entries.size >= this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value);
    }
    const restored = {
      ...canonicalClone(snapshot),
      contextId,
      createdAt: this.now(),
      expiresAt: this.now() + this.ttlMs,
    };
    this.entries.set(contextId, restored);
    return restored;
  }

  delete(contextId) {
    return this.entries.delete(contextId);
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

  _prune() {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
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

  getContext(contextId, epoch) {
    const entry = this.store.get(contextId);
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
