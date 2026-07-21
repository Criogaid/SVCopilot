import { isDeepStrictEqual } from "node:util";

import { createHostScope } from "./snapshot.js";

export async function resolveContextTarget(host, stored, { verify = true } = {}) {
  if (!stored?.context || !["selection", "group"].includes(stored.context.kind)) {
    throw codedError("INVALID_CONTEXT", "context does not identify an editable note group");
  }
  const scope = createHostScope(host);
  try {
    const roots = await scope.roots();
    const track = await scope.call(roots.project, "getTrack", [stored.context.trackIndex + 1], {
      inferredType: "Track",
    });
    const group = await scope.call(track, "getGroupReference", [stored.context.groupIndex + 1], {
      inferredType: "NoteGroupReference",
    });
    const target = await scope.call(group, "getTarget", [], { inferredType: "NoteGroup" });
    const expectedGroupUuid =
      stored.baseData.group?.uuid ?? stored.baseData.tracks?.[0]?.groups?.[0]?.uuid ?? null;
    if (expectedGroupUuid !== null) {
      const currentGroupUuid = await scope.call(target, "getUUID");
      if (currentGroupUuid !== expectedGroupUuid) {
        throw codedError("STALE_CONTEXT", "the target note group changed after snapshot capture");
      }
    }
    const notes = [];
    const fingerprints = [];
    for (const index of stored.context.noteIndices) {
      const note = await scope.call(target, "getNote", [index + 1], { inferredType: "Note" });
      if (!note?.__handle__) throw codedError("STALE_CONTEXT", `note ${index} no longer exists`);
      notes.push(note);
      fingerprints.push(await readFingerprint(scope, note));
    }

    if (verify && !isDeepStrictEqual(fingerprints, stored.context.fingerprints)) {
      throw codedError("STALE_CONTEXT", "notes changed after the snapshot was captured");
    }
    return { scope, roots, track, group, target, notes, fingerprints };
  } catch (error) {
    await scope.releaseAll();
    if (error?.code === "STALE_CONTEXT" || error?.code === "INVALID_CONTEXT") throw error;
    throw codedError(
      "STALE_CONTEXT",
      `could not resolve snapshot target: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export function contextGroupNoteCount(stored, fallback = null) {
  const candidates = [
    stored?.baseData?.group?.noteCount,
    stored?.baseData?.tracks?.[0]?.groups?.[0]?.noteCount,
    fallback,
  ];
  return candidates.find((value) => Number.isSafeInteger(value) && value >= 0) ?? null;
}

async function readFingerprint(scope, note) {
  return {
    indexInGroup: toExternalIndex(await scope.call(note, "getIndexInParent")),
    onsetBlick: await scope.call(note, "getOnset"),
    durationBlick: await scope.call(note, "getDuration"),
    pitch: await scope.call(note, "getPitch"),
    lyrics: await scope.call(note, "getLyrics"),
    phonemesOverride: await scope.call(note, "getPhonemes"),
    languageOverride: await scope.call(note, "getLanguageOverride"),
  };
}

function toExternalIndex(luaIndex) {
  return Number.isSafeInteger(luaIndex) ? luaIndex - 1 : null;
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
