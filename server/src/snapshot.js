import { randomUUID } from "node:crypto";

import { analyzePhonemeResult, observedArrayIndices } from "./phoneme-state.js";
import { collectHandleRefs } from "./wire-codec.js";
import { normalizeVoiceParameters } from "./voice-parameters.js";

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
    const pageSize = normalizePageSize(request.pageSize);
    if (request.cursor !== undefined) return this._readCursor(request.cursor, pageSize);

    const scope = normalizeScope(request.scope);
    const include = new Set(
      Array.isArray(request.include)
        ? request.include
        : scope.kind === "selection"
          ? ["notes", "voiceParameters", "processing"]
          : ["structure"]
    );

    return this.session.withExclusive(async (host) => {
      const capture = createHostScope(host);
      try {
        const roots = await capture.roots();
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
          return await captureProjectPage(capture, roots, stored, pageSize, this.store);
        }
        const captured =
          scope.kind === "selection"
            ? await captureSelection(capture, roots, include)
            : await captureGroup(capture, roots, scope, include);
        const stored = this.store.create({
          epoch: host.epoch(),
          scope,
          observedAt,
          baseData: captured.baseData,
          notes: captured.notes,
          context: captured.context,
        });
        return formatSnapshotPage(stored, 0, pageSize, this.store);
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

  async _readCursor(cursor, pageSize) {
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
      return this.session.withExclusive(async (host) => {
        if (stored.epoch !== host.epoch()) {
          throw codedError(
            "STALE_CONTEXT",
            `snapshot belongs to bridge epoch ${stored.epoch}; current epoch is ${host.epoch()}`
          );
        }
        const capture = createHostScope(host);
        try {
          const roots = await capture.roots();
          return await captureProjectPage(capture, roots, stored, pageSize, this.store);
        } finally {
          await capture.releaseAll();
        }
      });
    }
    return formatSnapshotPage(stored, decoded.offset, pageSize, this.store);
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

  while (state.trackIndex < state.trackCount && emitted < effectivePageSize) {
    const trackIndex = state.trackIndex;
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
      state.trackIndex += 1;
      state.groupIndex = 0;
      state.noteIndex = 0;
      emitted += 1;
      continue;
    }

    while (state.groupIndex < trackSummary.groupCount && emitted < effectivePageSize) {
      const groupIndex = state.groupIndex;
      const groupHandle = await capture.call(trackHandle, "getGroupReference", [groupIndex + 1], {
        inferredType: "NoteGroupReference",
      });
      const group = await readGroupSummary(capture, groupHandle, groupIndex, include);
      if (include.has("processing")) {
        group.processing = await readProcessingSummary(capture, roots, groupHandle, group);
      }
      pageTrack.groups.push(group);

      if (!includeNotes || group.noteCount === 0 || group.instrumental) {
        state.groupIndex += 1;
        state.noteIndex = 0;
        emitted += 1;
        continue;
      }

      const target = await capture.call(groupHandle, "getTarget", [], { inferredType: "NoteGroup" });
      while (state.noteIndex < group.noteCount && emitted < effectivePageSize) {
        const noteIndex = state.noteIndex;
        const noteHandle = await capture.call(target, "getNote", [noteIndex + 1], {
          inferredType: "Note",
        });
        notes.push({ trackIndex, groupIndex, ...(await readNote(capture, noteHandle)) });
        state.noteIndex += 1;
        emitted += 1;
      }
      if (state.noteIndex < group.noteCount) break;
      state.groupIndex += 1;
      state.noteIndex = 0;
    }

    if (state.groupIndex < trackSummary.groupCount) break;
    state.trackIndex += 1;
    state.groupIndex = 0;
    state.noteIndex = 0;
  }

  state.page += 1;
  state.emitted += emitted;
  const complete = state.trackIndex >= state.trackCount;
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
  return {
    indexInGroup: note.indexInGroup,
    onsetBlick: note.onsetBlick,
    durationBlick: note.durationBlick,
    pitch: note.pitch,
    lyrics: note.lyrics,
    phonemesOverride: note.phonemesOverride,
    languageOverride: note.languageOverride,
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
