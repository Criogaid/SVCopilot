import { createHash } from "node:crypto";

import { createHostScope } from "./snapshot.js";

// SV.QUARTER 的官方常量；一个 blick 全音符 = 4 * QUARTER。
const QUARTER_BLICK = 705600;
const WHOLE_BLICK = QUARTER_BLICK * 4;
const MAX_RANGE_NOTES = 800;
const SUPPORTED_INCLUDES = new Set(["notes", "tempoMap", "meterMap", "mixer", "voiceParameters"]);
// 官方 API 尚无法可靠支持的 include；显式报告而不是静默忽略。
const KNOWN_UNSUPPORTED_INCLUDES = new Set(["automation", "attributes", "retakes"]);

export class RangeSnapshotService {
  constructor(session, { now = () => Date.now() } = {}) {
    this.session = session;
    this.now = now;
  }

  async snapshot(request = {}) {
    const input = normalizeRequest(request);
    return this.session.withExclusive(async (host) => {
      const capture = createHostScope(host);
      try {
        const roots = await capture.roots();
        const timeAxis = await capture.call(roots.project, "getTimeAxis", [], {
          inferredType: "TimeAxis",
        });
        const meterMarks = normalizeMeterMarks(
          await capture.call(timeAxis, "getAllMeasureMarks", [], {
            resultFormat: "typed-v2",
            resultShape: "array",
          })
        );
        const tempoMarks = normalizeTempoMarks(
          await capture.call(timeAxis, "getAllTempoMarks", [], {
            resultFormat: "typed-v2",
            resultShape: "array",
          })
        );

        const fromBlick = musicalToBlick(input.from, meterMarks);
        const toBlick = musicalToBlick(input.to, meterMarks);
        if (toBlick <= fromBlick) {
          throw codedError("INVALID_RANGE", "range end must be after range start");
        }

        const trackCount = await capture.call(roots.project, "getNumTracks");
        const trackIndices = input.trackIndices ?? [...Array(trackCount).keys()];
        for (const index of trackIndices) {
          if (index >= trackCount) {
            throw codedError(
              "TRACK_INDEX_OUT_OF_RANGE",
              `trackIndex ${index} is outside 0-${Math.max(0, trackCount - 1)} (native index ${index + 1})`
            );
          }
        }

        const warnings = [];
        for (const item of input.unsupportedIncludes) {
          warnings.push({
            code: "UNSUPPORTED_INCLUDE",
            message: `include "${item}" is not yet available for range snapshots and was skipped.`,
          });
        }

        const tracks = [];
        const notes = [];
        let truncated = false;
        for (const trackIndex of trackIndices) {
          const trackHandle = await capture.call(roots.project, "getTrack", [trackIndex + 1], {
            inferredType: "Track",
          });
          const track = {
            index: trackIndex,
            name: await capture.call(trackHandle, "getName"),
            groupCount: await capture.call(trackHandle, "getNumGroups"),
            groups: [],
          };
          if (input.include.has("mixer")) {
            const mixer = await capture.call(trackHandle, "getMixer", [], {
              inferredType: "TrackMixer",
            });
            track.mixer = {
              gainDecibel: await capture.call(mixer, "getGainDecibel"),
              pan: await capture.call(mixer, "getPan"),
              muted: await capture.call(mixer, "isMuted"),
              solo: await capture.call(mixer, "isSolo"),
            };
          }

          const groupEntries = [];
          for (let groupIndex = 0; groupIndex < track.groupCount; groupIndex += 1) {
            const reference = await capture.call(trackHandle, "getGroupReference", [groupIndex + 1], {
              inferredType: "NoteGroupReference",
            });
            const onsetBlick = await capture.call(reference, "getOnset");
            const endBlick = await capture.call(reference, "getEnd");
            // 范围外 group 只读 onset/end 即跳过，不展开 target 和 notes。
            if (endBlick <= fromBlick || onsetBlick >= toBlick) continue;
            groupEntries.push({ groupIndex, reference, onsetBlick, endBlick });
          }
          groupEntries.sort((a, b) => a.onsetBlick - b.onsetBlick);

          for (const entry of groupEntries) {
            const group = {
              index: entry.groupIndex,
              onsetBlick: entry.onsetBlick,
              endBlick: entry.endBlick,
              instrumental: await capture.call(entry.reference, "isInstrumental"),
              isMain: await capture.call(entry.reference, "isMain"),
              timeOffsetBlick: await capture.call(entry.reference, "getTimeOffset"),
              pitchOffsetSemitone: await capture.call(entry.reference, "getPitchOffset"),
              noteCount: 0,
            };
            if (!group.instrumental) {
              const target = await capture.call(entry.reference, "getTarget", [], {
                inferredType: "NoteGroup",
              });
              group.name = await capture.call(target, "getName");
              group.uuid = await capture.call(target, "getUUID");
              group.noteCount = await capture.call(target, "getNumNotes");
              if (input.include.has("voiceParameters")) {
                group.voice = {
                  identityStatus: "unobservable",
                  parameters: await capture.call(entry.reference, "getVoice", [], {
                    resultFormat: "typed-v2",
                  }),
                };
              }
              if (input.include.has("notes")) {
                const emitted = await readGroupNotes(capture, {
                  target,
                  group,
                  trackIndex,
                  fromBlick,
                  toBlick,
                  meterMarks,
                  remaining: MAX_RANGE_NOTES - notes.length,
                });
                notes.push(...emitted.notes);
                if (emitted.truncated) truncated = true;
              }
            }
            track.groups.push(group);
          }
          tracks.push(track);
        }

        if (truncated) {
          warnings.push({
            code: "RANGE_NOTE_LIMIT_REACHED",
            message: `range snapshot returns at most ${MAX_RANGE_NOTES} notes; narrow the range or track list to read the rest.`,
          });
        }

        const data = {
          scope: "range",
          indexBase: 0,
          barBase: 1,
          beatBase: 1,
          units: { time: "blick", pitch: "midi", detune: "cent" },
          range: {
            from: { ...input.from, blick: fromBlick },
            to: { ...input.to, blick: toBlick },
          },
          trackCount,
          tracks,
          ...(input.include.has("notes") ? { notes } : {}),
          ...(input.include.has("tempoMap") ? { tempoMap: tempoMarks } : {}),
          ...(input.include.has("meterMap")
            ? {
                meterMap: meterMarks.map((mark) => ({
                  bar: mark.position + 1,
                  positionBlick: mark.positionBlick,
                  numerator: mark.numerator,
                  denominator: mark.denominator,
                })),
              }
            : {}),
          snapshotComplete: !truncated,
          capabilities: { singerIdentity: "unobservable", hostRevision: "unavailable" },
        };
        // token 是内容 hash，不是宿主 revision：相同 token 只说明两次读取内容一致。
        const snapshotToken = contentToken(data);
        if (input.sinceToken && input.sinceToken === snapshotToken) {
          return {
            ok: true,
            status: "no_change",
            snapshotToken,
            observedAt: new Date(this.now()).toISOString(),
            consistency: "best-effort",
            data: null,
            warnings,
          };
        }
        return {
          ok: true,
          status: "succeeded",
          snapshotToken,
          ...(input.sinceToken ? { changedSinceToken: true } : {}),
          observedAt: new Date(this.now()).toISOString(),
          consistency: "best-effort",
          data,
          warnings,
        };
      } finally {
        await capture.releaseAll();
      }
    });
  }
}

async function readGroupNotes(capture, options) {
  const { target, group, trackIndex, fromBlick, toBlick, meterMarks, remaining } = options;
  // 为了计算休止和相邻歌词需要整组音符；只有落入范围的音符会被输出。
  const all = [];
  for (let noteIndex = 0; noteIndex < group.noteCount; noteIndex += 1) {
    const note = await capture.call(target, "getNote", [noteIndex + 1], { inferredType: "Note" });
    const onsetBlick = await capture.call(note, "getOnset");
    const durationBlick = await capture.call(note, "getDuration");
    all.push({
      indexInGroup: noteIndex,
      handle: note,
      onsetBlick,
      durationBlick,
      endBlick: onsetBlick + durationBlick,
    });
  }
  all.sort((a, b) => a.onsetBlick - b.onsetBlick);

  const emitted = [];
  let truncated = false;
  for (let position = 0; position < all.length; position += 1) {
    const item = all[position];
    const absoluteOnset = group.onsetBlick + item.onsetBlick;
    if (absoluteOnset < fromBlick || absoluteOnset >= toBlick) continue;
    if (emitted.length >= remaining) {
      truncated = true;
      break;
    }
    const previous = all[position - 1] ?? null;
    const next = all[position + 1] ?? null;
    emitted.push({
      trackIndex,
      groupIndex: group.index,
      groupUuid: group.uuid ?? null,
      indexInGroup: item.indexInGroup,
      onsetBlick: item.onsetBlick,
      durationBlick: item.durationBlick,
      endBlick: item.endBlick,
      absoluteOnsetBlick: absoluteOnset,
      absoluteEndBlick: group.onsetBlick + item.endBlick,
      pitch: await capture.call(item.handle, "getPitch"),
      lyrics: await capture.call(item.handle, "getLyrics"),
      phonemesOverride: await capture.call(item.handle, "getPhonemes"),
      languageOverride: await capture.call(item.handle, "getLanguageOverride"),
      detuneCents: await capture.call(item.handle, "getDetune"),
      musical: blickToMusical(absoluteOnset, meterMarks),
      restBeforeBlick: previous ? Math.max(0, item.onsetBlick - previous.endBlick) : null,
      restAfterBlick: next ? Math.max(0, next.onsetBlick - item.endBlick) : null,
      prevLyrics: previous ? await capture.call(previous.handle, "getLyrics") : null,
      nextLyrics: next ? await capture.call(next.handle, "getLyrics") : null,
    });
  }
  return { notes: emitted, truncated };
}

// 宿主 measure 号为 0 基；对外 bar/beat 一律 1 基，barBase/beatBase 显式返回。
function musicalToBlick(point, meterMarks) {
  const hostMeasure = point.bar - 1;
  let active = meterMarks[0];
  for (const mark of meterMarks) {
    if (mark.position <= hostMeasure) active = mark;
    else break;
  }
  if (!active) throw codedError("INVALID_RANGE", "the project has no measure marks");
  const barLength = (active.numerator * WHOLE_BLICK) / active.denominator;
  const beatLength = WHOLE_BLICK / active.denominator;
  return (
    active.positionBlick + (hostMeasure - active.position) * barLength + (point.beat - 1) * beatLength
  );
}

function blickToMusical(blick, meterMarks) {
  let active = meterMarks[0];
  for (const mark of meterMarks) {
    if (mark.positionBlick <= blick) active = mark;
    else break;
  }
  const barLength = (active.numerator * WHOLE_BLICK) / active.denominator;
  const beatLength = WHOLE_BLICK / active.denominator;
  const offset = blick - active.positionBlick;
  const barInSegment = Math.floor(offset / barLength);
  const withinBar = offset - barInSegment * barLength;
  const beat = Math.floor(withinBar / beatLength);
  return {
    bar: active.position + barInSegment + 1,
    beat: beat + 1,
    tickInBeatBlick: withinBar - beat * beatLength,
    numerator: active.numerator,
    denominator: active.denominator,
  };
}

function normalizeMeterMarks(raw) {
  const marks = (Array.isArray(raw) ? raw : [])
    .filter(isRecord)
    .map((mark) => ({
      position: mark.position,
      positionBlick: mark.positionBlick,
      numerator: mark.numerator,
      denominator: mark.denominator,
    }))
    .filter(
      (mark) =>
        Number.isSafeInteger(mark.position) &&
        Number.isFinite(mark.positionBlick) &&
        Number.isSafeInteger(mark.numerator) &&
        mark.numerator >= 1 &&
        Number.isSafeInteger(mark.denominator) &&
        mark.denominator >= 1
    )
    .sort((a, b) => a.position - b.position);
  if (marks.length === 0) {
    throw codedError("HOST_DATA_INVALID", "TimeAxis returned no usable measure marks");
  }
  return marks;
}

function normalizeTempoMarks(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter(isRecord)
    .map((mark) => ({
      positionBlick: mark.position,
      positionSeconds: mark.positionSeconds,
      bpm: mark.bpm,
    }))
    .filter((mark) => Number.isFinite(mark.positionBlick) && Number.isFinite(mark.bpm))
    .sort((a, b) => a.positionBlick - b.positionBlick);
}

function contentToken(data) {
  return `snap_${createHash("sha256").update(stableStringify(data)).digest("hex").slice(0, 32)}`;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function normalizeRequest(request) {
  if (!isRecord(request)) throw codedError("INVALID_ARGUMENTS", "request must be an object");
  const scope = request.scope;
  if (!isRecord(scope) || scope.kind !== "range") {
    throw codedError("INVALID_SCOPE", 'scope.kind must be "range"');
  }
  const from = normalizePoint(scope.from, "scope.from");
  const to = normalizePoint(scope.to, "scope.to");
  let trackIndices = null;
  if (scope.trackIndices !== undefined) {
    if (
      !Array.isArray(scope.trackIndices) ||
      scope.trackIndices.length === 0 ||
      !scope.trackIndices.every((index) => Number.isSafeInteger(index) && index >= 0)
    ) {
      throw codedError(
        "INVALID_SCOPE",
        "scope.trackIndices must be a non-empty array of non-negative integers"
      );
    }
    trackIndices = [...new Set(scope.trackIndices)].sort((a, b) => a - b);
  }
  const include = new Set();
  const unsupportedIncludes = [];
  const requested = Array.isArray(request.include)
    ? request.include
    : ["notes", "tempoMap", "meterMap"];
  for (const item of requested) {
    if (SUPPORTED_INCLUDES.has(item)) include.add(item);
    else if (KNOWN_UNSUPPORTED_INCLUDES.has(item)) unsupportedIncludes.push(item);
    else throw codedError("INVALID_ARGUMENTS", `unknown include item: ${String(item)}`);
  }
  if (request.sinceToken !== undefined && typeof request.sinceToken !== "string") {
    throw codedError("INVALID_ARGUMENTS", "sinceToken must be a string");
  }
  return { from, to, trackIndices, include, unsupportedIncludes, sinceToken: request.sinceToken };
}

function normalizePoint(point, label) {
  if (!isRecord(point)) throw codedError("INVALID_SCOPE", `${label} must be {bar, beat?}`);
  const { bar, beat = 1 } = point;
  if (!Number.isSafeInteger(bar) || bar < 1) {
    throw codedError("INVALID_SCOPE", `${label}.bar must be an integer >= 1 (bars are 1-based)`);
  }
  if (!Number.isSafeInteger(beat) || beat < 1) {
    throw codedError("INVALID_SCOPE", `${label}.beat must be an integer >= 1 (beats are 1-based)`);
  }
  return { bar, beat };
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
