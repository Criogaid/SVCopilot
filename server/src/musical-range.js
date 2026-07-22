import { createHash } from "node:crypto";

import {
  blickToMusical,
  musicalToBlick,
  normalizeMeterMarks,
  normalizeMusicalPoint,
  publicMusicalPoint,
} from "./musical-time.js";
import { readAutomationSnapshot } from "./parameter-curve.js";
import { analyzePhonemeResult } from "./phoneme-state.js";
import { ServiceTiming } from "./service-timing.js";
import { SnapshotStore, createHostScope } from "./snapshot.js";
import { normalizeVoiceParameters } from "./voice-parameters.js";

export const RANGE_CAPTURE_LIMITS = Object.freeze({
  notes: 2_000,
  automationPoints: 20_000,
  computedPitchFrames: 20_000,
});
export const RANGE_REQUEST_LIMITS = Object.freeze({
  automationParameters: 16,
  computedPitchFramesPerGroup: 2_000,
});
export const RANGE_PAGE_LIMITS = Object.freeze({
  defaults: Object.freeze({
    notes: 200,
    attributes: 200,
    automationPoints: 2_000,
    computedPitchFrames: 2_000,
    bytes: 48 * 1024,
  }),
  maximums: Object.freeze({
    notes: 2_000,
    attributes: 2_000,
    automationPoints: 20_000,
    computedPitchFrames: 20_000,
    bytes: 60 * 1024,
  }),
});
const MAX_CAPTURED_NOTES = RANGE_CAPTURE_LIMITS.notes;
const MAX_CAPTURED_AUTOMATION_POINTS = RANGE_CAPTURE_LIMITS.automationPoints;
const MAX_CAPTURED_COMPUTED_PITCH_FRAMES = RANGE_CAPTURE_LIMITS.computedPitchFrames;
const DEFAULT_AUTOMATION_PARAMETERS = ["pitchDelta", "tension", "loudness", "breathiness"];
const DEFAULT_BUDGETS = RANGE_PAGE_LIMITS.defaults;
const RESPONSE_ENVELOPE_RESERVE_BYTES = 4 * 1024;
const SUPPORTED_INCLUDES = new Set([
  "notes",
  "tempoMap",
  "meterMap",
  "mixer",
  "voiceParameters",
  "automation",
  "computedPitch",
  "attributes",
  "processing",
]);
// 官方 API 尚无法可靠支持的 include；显式报告而不是静默忽略。
const KNOWN_UNSUPPORTED_INCLUDES = new Set(["retakes"]);

export class RangeSnapshotService {
  constructor(
    session,
    {
      now = () => Date.now(),
      snapshotService = null,
      store = snapshotService?.store,
      captureLimits = {},
    } = {}
  ) {
    this.session = session;
    this.now = now;
    this.store = store ?? new SnapshotStore({ now });
    this.captureLimits = {
      automationPoints:
        captureLimits.automationPoints ?? MAX_CAPTURED_AUTOMATION_POINTS,
      computedPitchFrames:
        captureLimits.computedPitchFrames ?? MAX_CAPTURED_COMPUTED_PITCH_FRAMES,
    };
  }

  async snapshot(request = {}) {
    validateRangeRequestShape(request);
    if (request?.cursor !== undefined) return this._readCursor(request);
    const timer = new ServiceTiming({
      now: this.now,
      phaseNames: ["hostReadMs", "serializationMs"],
    });
    const input = normalizeRequest(request);
    timer.requestCoordinator();
    return this.session.withExclusive(async (host) => {
      timer.acquiredCoordinator();
      const capture = createHostScope(host);
      try {
        const warnings = [];
        for (const item of input.unsupportedIncludes) {
          warnings.push({
            code: "UNSUPPORTED_INCLUDE",
            message: `include "${item}" is not yet available for range snapshots and was skipped.`,
          });
        }
        const captured = await timer.measure("hostReadMs", () =>
          captureRange(capture, host, input, warnings, this.captureLimits)
        );
        // token 是内容 hash，不是宿主 revision：相同 token 只说明两次读取内容一致。
        const snapshotToken = contentToken(captured.data);
        const stored = this.store.create({
          epoch: host.epoch(),
          scope: { kind: "range" },
          observedAt: new Date(this.now()).toISOString(),
          context: { kind: "range", occurrences: [] },
        });
        const prepared = await timer.measure("serializationMs", async () =>
          prepareStoredRange(stored, captured, input, snapshotToken, warnings)
        );
        if (input.sinceToken && input.sinceToken === snapshotToken) {
          return {
            ok: true,
            status: "no_change",
            contextId: stored.contextId,
            snapshotToken,
            observedAt: stored.observedAt,
            contextExpiresAt: new Date(stored.expiresAt).toISOString(),
            consistency: "best-effort",
            data: null,
            page: {
              complete: true,
              nextCursor: null,
              detailCursor: stored.storeCursor,
              returned: {
                notes: 0,
                attributes: 0,
                automationPoints: 0,
                computedPitchFrames: 0,
              },
            },
            warnings,
            timings: timer.finish(),
          };
        }
        return formatStoredRangePage(stored, prepared.initialPage, {
          changedSinceToken: input.sinceToken !== undefined,
          timings: timer.finish(),
        });
      } finally {
        await capture.releaseAll();
      }
    });
  }

  async _readCursor(request) {
    const timer = new ServiceTiming({ now: this.now, phaseNames: ["serializationMs"] });
    if (!isRecord(request) || typeof request.cursor !== "string" || !request.cursor) {
      throw codedError("INVALID_CURSOR", "cursor must be a non-empty string");
    }
    const decoded = this.store.decodeCursor(request.cursor);
    if (!decoded || !["range", "range-detail"].includes(decoded.kind)) {
      throw codedError("INVALID_CURSOR", "cursor is malformed or is not a range cursor");
    }
    const stored = this.store.get(decoded.contextId);
    if (!stored?.rangePages) throw codedError("EXPIRED_CURSOR", "range cursor has expired");
    const pageIndex = decoded.kind === "range-detail" ? 0 : decoded.offset;
    const page = stored.rangePages[pageIndex];
    if (!page) throw codedError("STALE_CURSOR", "range cursor is past the final page");
    timer.requestCoordinator();
    const result = await timer.measure("serializationMs", async () =>
      formatStoredRangePage(stored, page)
    );
    return { ...result, timings: timer.finish() };
  }
}

async function captureRange(capture, host, input, warnings, captureLimits) {
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
  // 不缓存宿主常量，避免 Studio 版本变化后继续使用旧时间基准。
  const quarterBlick = normalizeQuarterBlick(await capture.index("QUARTER"));
  const fromBlick = musicalToBlick(input.from, meterMarks, quarterBlick);
  const toBlick = musicalToBlick(input.to, meterMarks, quarterBlick);
  if (toBlick <= fromBlick) throw codedError("INVALID_RANGE", "range end must be after range start");

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

  const tracks = [];
  const notes = [];
  const attributes = [];
  const automation = [];
  const computedPitch = [];
  const occurrences = [];
  let capturedAutomationPoints = 0;
  let capturedComputedPitchFrames = 0;
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
      if (endBlick <= fromBlick || onsetBlick >= toBlick) continue;
      groupEntries.push({ groupIndex, reference, onsetBlick, endBlick });
    }
    groupEntries.sort((left, right) => left.onsetBlick - right.onsetBlick);

    for (const entry of groupEntries) {
      const occurrenceKey = `${trackIndex}:${entry.groupIndex}`;
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
      const occurrence = {
        occurrenceKey,
        trackIndex,
        groupIndex: entry.groupIndex,
        targetGroupUuid: null,
        timeOffsetBlick: group.timeOffsetBlick,
        noteFingerprints: [],
        group,
      };
      occurrences.push(occurrence);

      if (!group.instrumental) {
        const target = await capture.call(entry.reference, "getTarget", [], {
          inferredType: "NoteGroup",
        });
        group.name = await capture.call(target, "getName");
        group.uuid = await capture.call(target, "getUUID");
        group.targetGroupUuid = group.uuid;
        group.noteCount = await capture.call(target, "getNumNotes");
        occurrence.targetGroupUuid = group.uuid;
        if (input.include.has("voiceParameters") || input.include.has("automation")) {
          group.voice = {
            identityStatus: "unobservable",
            parameters: normalizeVoiceParameters(
              await capture.call(entry.reference, "getVoice", [], { resultFormat: "typed-v2" })
            ),
          };
        }

        if (input.include.has("notes") || input.include.has("attributes")) {
          const emitted = await readGroupNotes(capture, {
            target,
            group,
            occurrenceKey,
            trackIndex,
            fromBlick,
            toBlick,
            meterMarks,
            quarterBlick,
            includeAttributes: input.include.has("attributes"),
            remaining: MAX_CAPTURED_NOTES - notes.length,
          });
          if (emitted.truncated) {
            throw codedError(
              "SNAPSHOT_NOTE_CAPTURE_LIMIT_REACHED",
              `range contains more than ${MAX_CAPTURED_NOTES} notes; narrow the range or track list`
            );
          }
          notes.push(...emitted.notes);
          attributes.push(...emitted.attributes);
          occurrence.noteFingerprints = emitted.fingerprints;
        }

        if (input.include.has("processing")) {
          const phonemes = await capture.call(roots.sv, "getPhonemesForGroup", [entry.reference], {
            resultFormat: "typed-v2",
            resultShape: "array",
            resultLength: group.noteCount,
          });
          group.processing = {
            ...analyzePhonemeResult(phonemes, group.noteCount),
          };
        }

        const curveTarget = {
          roots,
          reference: entry.reference,
          group: target,
          groupOnsetBlick: entry.onsetBlick,
          groupTimeOffsetBlick: group.timeOffsetBlick,
          groupUuid: group.uuid,
        };
        if (input.include.has("automation")) {
          for (const parameter of input.automationParameters) {
            const remainingPoints = captureLimits.automationPoints - capturedAutomationPoints;
            const curve = await readAutomationSnapshot(
              capture,
              curveTarget,
              parameter,
              { coordinate: "absolute", fromBlick, toBlick },
              { maxPoints: remainingPoints }
            );
            capturedAutomationPoints += curve.points.length;
            automation.push({
              occurrenceKey,
              ...curve,
              points: curve.points.map((point) => ({
                ...point,
                musical: blickToMusical(point.absoluteBlick, meterMarks, quarterBlick),
              })),
            });
          }
        }
        if (input.include.has("computedPitch")) {
          const sampling = computedPitchSampling(input.computedPitchSampling, {
            fromBlick,
            toBlick,
          });
          if (
            capturedComputedPitchFrames + sampling.frames >
            captureLimits.computedPitchFrames
          ) {
            throw codedError(
              "SNAPSHOT_COMPUTED_PITCH_CAPTURE_LIMIT_REACHED",
              `range requests more than ${captureLimits.computedPitchFrames} computed-pitch frames; narrow the range, track list, or sampling`
            );
          }
          const raw = await capture.call(
            roots.sv,
            "getComputedPitchForGroup",
            [entry.reference, sampling.startBlick, sampling.intervalBlick, sampling.frames],
            {
              resultFormat: "typed-v2",
              resultShape: "array",
              resultLength: sampling.frames,
            }
          );
          const values = normalizeComputedPitch(raw, sampling.frames);
          capturedComputedPitchFrames += values.length;
          const numericValues = values.filter(Number.isFinite);
          computedPitch.push({
            occurrenceKey,
            ...sampling,
            values,
            evidence: {
              requestedFrames: sampling.frames,
              observedFrames: numericValues.length,
              nullFrameIndices: values.flatMap((value, index) =>
                Number.isFinite(value) ? [] : [index]
              ),
            },
          });
        }
      }
      track.groups.push(group);
    }
    tracks.push(track);
  }

  const data = {
    scope: "range",
    indexBase: 0,
    barBase: 1,
    beatBase: 1,
    units: { time: "blick", pitch: "midi", detune: "cent" },
    timebase: { quarterBlick },
    range: {
      from: { ...publicMusicalPoint(input.from), blick: fromBlick },
      to: { ...publicMusicalPoint(input.to), blick: toBlick },
    },
    trackCount,
    tracks,
    ...(input.include.has("notes") ? { notes } : {}),
    ...(input.include.has("attributes") ? { attributes } : {}),
    ...(input.include.has("automation") ? { automation } : {}),
    ...(input.include.has("computedPitch") ? { computedPitch } : {}),
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
    captureComplete: true,
    capabilities: { singerIdentity: "unobservable", hostRevision: "unavailable" },
  };
  return {
    data,
    occurrences,
    meterMarks,
    tempoMarks,
    quarterBlick,
    epoch: host.epoch(),
  };
}

function prepareStoredRange(stored, captured, input, snapshotToken, warnings) {
  const occurrenceByKey = new Map();
  const occurrencesByTarget = new Map();
  for (const occurrence of captured.occurrences) {
    const occurrenceId = `${stored.contextId}:t:${occurrence.trackIndex}:r:${occurrence.groupIndex}`;
    occurrence.occurrenceId = occurrenceId;
    occurrence.group.occurrenceId = occurrenceId;
    occurrenceByKey.set(occurrence.occurrenceKey, occurrence);
    if (occurrence.targetGroupUuid) {
      const list = occurrencesByTarget.get(occurrence.targetGroupUuid) ?? [];
      list.push(occurrenceId);
      occurrencesByTarget.set(occurrence.targetGroupUuid, list);
    }
  }
  for (const occurrence of captured.occurrences) {
    const sharedTargetOccurrences = occurrence.targetGroupUuid
      ? occurrencesByTarget.get(occurrence.targetGroupUuid)
      : [];
    occurrence.group.sharedTargetOccurrences = sharedTargetOccurrences;
    const noteFingerprints = occurrence.noteFingerprints.map((fingerprint) => {
      const noteId = `${occurrence.occurrenceId}:n:${fingerprint.indexInGroup}`;
      return { ...fingerprint, noteId };
    });
    stored.context.occurrences.push({
      occurrenceId: occurrence.occurrenceId,
      trackIndex: occurrence.trackIndex,
      groupIndex: occurrence.groupIndex,
      targetGroupUuid: occurrence.targetGroupUuid,
      timeOffsetBlick: occurrence.timeOffsetBlick,
      sharedTargetOccurrences,
      noteFingerprints,
    });
  }
  for (const collectionName of ["notes", "attributes", "automation", "computedPitch"]) {
    for (const item of captured.data[collectionName] ?? []) {
      const occurrence = occurrenceByKey.get(item.occurrenceKey);
      item.occurrenceId = occurrence.occurrenceId;
      if (Number.isSafeInteger(item.indexInGroup)) {
        item.noteId = `${occurrence.occurrenceId}:n:${item.indexInGroup}`;
        if (collectionName === "notes") item.id = item.noteId;
      }
      delete item.occurrenceKey;
    }
  }
  stored.context.range = captured.data.range;
  stored.context.quarterBlick = captured.quarterBlick;
  stored.context.meterMarks = captured.meterMarks;
  stored.context.snapshotToken = snapshotToken;
  stored.snapshotToken = snapshotToken;
  stored.warnings = warnings;
  stored.responseMode = input.responseMode;
  stored.rangePages = buildRangePages(captured.data, input.budgets, stored);

  if (input.responseMode === "compact") {
    return { initialPage: compactRangePage(captured.data, stored) };
  }
  return { initialPage: stored.rangePages[0] };
}

function formatStoredRangePage(stored, page, { changedSinceToken = false, timings } = {}) {
  return {
    ok: true,
    status: "succeeded",
    contextId: stored.contextId,
    snapshotToken: stored.snapshotToken,
    ...(changedSinceToken ? { changedSinceToken: true } : {}),
    observedAt: stored.observedAt,
    contextExpiresAt: new Date(stored.expiresAt).toISOString(),
    consistency: "best-effort",
    data: page.data,
    page: page.page,
    warnings: stored.warnings ?? [],
    ...(timings ? { timings } : {}),
  };
}

function compactRangePage(data, stored) {
  const automation = data.automation ?? [];
  const computedPitch = data.computedPitch ?? [];
  return {
    data: {
      ...rangeBaseData(data),
      summaries: {
        notes: { count: data.notes?.length ?? 0 },
        attributes: { count: data.attributes?.length ?? 0 },
        automation: {
          curves: automation.length,
          points: automation.reduce((sum, curve) => sum + curve.points.length, 0),
          parameters: [...new Set(automation.map((curve) => curve.resolvedParameter))],
        },
        computedPitch: {
          groups: computedPitch.length,
          frames: computedPitch.reduce((sum, item) => sum + item.values.length, 0),
          observedFrames: computedPitch.reduce(
            (sum, item) => sum + item.evidence.observedFrames,
            0
          ),
        },
      },
      snapshotComplete: true,
    },
    page: {
      complete: true,
      nextCursor: null,
      detailCursor: stored.storeCursor ?? null,
      returned: { notes: 0, attributes: 0, automationPoints: 0, computedPitchFrames: 0 },
    },
  };
}

function buildRangePages(data, initialBudgets, stored) {
  let budgets = { ...initialBudgets };
  while (true) {
    const pages = paginateRangeData(data, budgets);
    const largest = Math.max(...pages.map((page) => Buffer.byteLength(JSON.stringify(page), "utf8")));
    const pageByteLimit = budgets.bytes - RESPONSE_ENVELOPE_RESERVE_BYTES;
    if (largest <= pageByteLimit) {
      for (let index = 0; index < pages.length; index += 1) {
        pages[index].page.nextCursor =
          index + 1 < pages.length
            ? storedCursor(stored, index + 1, "range")
            : null;
        pages[index].page.complete = index + 1 === pages.length;
        pages[index].data.snapshotComplete = index + 1 === pages.length;
      }
      stored.storeCursor = storedCursor(stored, 0, "range-detail");
      return pages;
    }
    const next = {
      ...budgets,
      notes: Math.max(1, Math.floor(budgets.notes / 2)),
      attributes: Math.max(1, Math.floor(budgets.attributes / 2)),
      automationPoints: Math.max(1, Math.floor(budgets.automationPoints / 2)),
      computedPitchFrames: Math.max(1, Math.floor(budgets.computedPitchFrames / 2)),
    };
    if (
      next.notes === budgets.notes &&
      next.attributes === budgets.attributes &&
      next.automationPoints === budgets.automationPoints &&
      next.computedPitchFrames === budgets.computedPitchFrames
    ) {
      throw codedError(
        "SNAPSHOT_RESPONSE_BUDGET_TOO_SMALL",
        "range metadata alone exceeds the requested byte budget; narrow the range or track list"
      );
    }
    budgets = next;
  }
}

function paginateRangeData(data, budgets) {
  const notes = data.notes ?? [];
  const attributes = data.attributes ?? [];
  const emptyAutomation = (data.automation ?? [])
    .filter((item) => item.points.length === 0)
    .map((item) => ({ ...item, offset: 0, points: [] }));
  const emptyComputedPitch = (data.computedPitch ?? [])
    .filter((item) => item.values.length === 0)
    .map((item) => ({ ...item, offset: 0, values: [] }));
  const automation = flattenSeries(data.automation ?? [], "points");
  const computedPitch = flattenSeries(data.computedPitch ?? [], "values");
  const pageCount = Math.max(
    1,
    Math.ceil(notes.length / budgets.notes),
    Math.ceil(attributes.length / budgets.attributes),
    Math.ceil(automation.length / budgets.automationPoints),
    Math.ceil(computedPitch.length / budgets.computedPitchFrames)
  );
  const pages = [];
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const pageNotes = notes.slice(pageIndex * budgets.notes, (pageIndex + 1) * budgets.notes);
    const pageAttributes = attributes.slice(
      pageIndex * budgets.attributes,
      (pageIndex + 1) * budgets.attributes
    );
    const pageAutomation = groupSeries(
      automation.slice(
        pageIndex * budgets.automationPoints,
        (pageIndex + 1) * budgets.automationPoints
      ),
      "points"
    );
    if (pageIndex === 0) pageAutomation.unshift(...emptyAutomation);
    const pageComputedPitch = groupSeries(
      computedPitch.slice(
        pageIndex * budgets.computedPitchFrames,
        (pageIndex + 1) * budgets.computedPitchFrames
      ),
      "values"
    );
    if (pageIndex === 0) pageComputedPitch.unshift(...emptyComputedPitch);
    pages.push({
      data: {
        ...rangeBaseData(data),
        ...(Object.hasOwn(data, "notes") ? { notes: pageNotes } : {}),
        ...(Object.hasOwn(data, "attributes") ? { attributes: pageAttributes } : {}),
        ...(Object.hasOwn(data, "automation") ? { automation: pageAutomation } : {}),
        ...(Object.hasOwn(data, "computedPitch") ? { computedPitch: pageComputedPitch } : {}),
        snapshotComplete: false,
      },
      page: {
        index: pageIndex,
        complete: false,
        nextCursor: null,
        returned: {
          notes: pageNotes.length,
          attributes: pageAttributes.length,
          automationPoints: pageAutomation.reduce((sum, item) => sum + item.points.length, 0),
          computedPitchFrames: pageComputedPitch.reduce((sum, item) => sum + item.values.length, 0),
        },
      },
    });
  }
  return pages;
}

function rangeBaseData(data) {
  const { notes, attributes, automation, computedPitch, snapshotComplete, ...base } = data;
  return base;
}

function flattenSeries(items, field) {
  const flattened = [];
  for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
    const { [field]: values, ...metadata } = items[itemIndex];
    for (let valueIndex = 0; valueIndex < values.length; valueIndex += 1) {
      flattened.push({ itemIndex, valueIndex, metadata, value: values[valueIndex] });
    }
  }
  return flattened;
}

function groupSeries(flattened, field) {
  const groups = [];
  for (const item of flattened) {
    let group = groups.at(-1);
    if (!group || group._itemIndex !== item.itemIndex) {
      group = {
        ...item.metadata,
        _itemIndex: item.itemIndex,
        offset: item.valueIndex,
        [field]: [],
      };
      groups.push(group);
    }
    group[field].push(item.value);
  }
  for (const group of groups) delete group._itemIndex;
  return groups;
}

function storedCursor(stored, offset, kind) {
  return Buffer.from(
    JSON.stringify({ contextId: stored.contextId, offset, kind }),
    "utf8"
  ).toString("base64url");
}

function computedPitchSampling(request, range) {
  const frames = request.frames;
  // 官方 API 要求 blickStart 使用 occurrence 的绝对 BLICK，不能减去 reference time offset。
  const startBlick = request.startBlick ?? range.fromBlick;
  const absoluteEnd = Math.max(startBlick + 1, range.toBlick);
  const intervalBlick =
    request.intervalBlick ?? Math.max(1, Math.ceil((absoluteEnd - startBlick) / frames));
  return { startBlick, intervalBlick, frames };
}

function normalizeComputedPitch(raw, frames) {
  const source = Array.isArray(raw) ? raw : [];
  return Array.from({ length: frames }, (_, index) =>
    Number.isFinite(source[index]) ? source[index] : null
  );
}

async function readGroupNotes(capture, options) {
  const {
    target,
    group,
    occurrenceKey,
    trackIndex,
    fromBlick,
    toBlick,
    meterMarks,
    quarterBlick,
    includeAttributes,
    remaining,
  } = options;
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
    // getNote 按组内时间顺序返回；保留终点后的首项作为 nextLyrics 后即可停止。
    if (group.timeOffsetBlick + onsetBlick >= toBlick) break;
  }
  all.sort((a, b) => a.onsetBlick - b.onsetBlick);

  const emitted = [];
  const attributes = [];
  const fingerprints = [];
  let truncated = false;
  for (let position = 0; position < all.length; position += 1) {
    const item = all[position];
    // 官方语义：绝对位置 = 组内位置 + getTimeOffset()；getOnset() 已含首音符 onset。
    const absoluteOnset = group.timeOffsetBlick + item.onsetBlick;
    const absoluteEnd = group.timeOffsetBlick + item.endBlick;
    if (absoluteEnd <= fromBlick || absoluteOnset >= toBlick) continue;
    if (emitted.length >= remaining) {
      truncated = true;
      break;
    }
    const previous = all[position - 1] ?? null;
    const next = all[position + 1] ?? null;
    const lyrics = await capture.call(item.handle, "getLyrics");
    const phonemesOverride = await capture.call(item.handle, "getPhonemes");
    const languageOverride = await capture.call(item.handle, "getLanguageOverride");
    const pitch = await capture.call(item.handle, "getPitch");
    const detuneCents = await capture.call(item.handle, "getDetune");
    const fingerprint = {
      indexInGroup: item.indexInGroup,
      onsetBlick: item.onsetBlick,
      durationBlick: item.durationBlick,
      pitch,
      lyrics,
      phonemesOverride,
      languageOverride,
      detuneCents,
    };
    fingerprints.push(fingerprint);
    emitted.push({
      occurrenceKey,
      trackIndex,
      groupIndex: group.index,
      groupUuid: group.uuid ?? null,
      indexInGroup: item.indexInGroup,
      onsetBlick: item.onsetBlick,
      durationBlick: item.durationBlick,
      endBlick: item.endBlick,
      absoluteOnsetBlick: absoluteOnset,
      absoluteEndBlick: absoluteEnd,
      pitch,
      lyrics,
      phonemesOverride,
      languageOverride,
      detuneCents,
      musical: blickToMusical(absoluteOnset, meterMarks, quarterBlick),
      restBeforeBlick: previous ? Math.max(0, item.onsetBlick - previous.endBlick) : null,
      restAfterBlick: next ? Math.max(0, next.onsetBlick - item.endBlick) : null,
      prevLyrics: previous ? await capture.call(previous.handle, "getLyrics") : null,
      nextLyrics: next ? await capture.call(next.handle, "getLyrics") : null,
    });
    if (includeAttributes) {
      attributes.push({
        occurrenceKey,
        trackIndex,
        groupIndex: group.index,
        indexInGroup: item.indexInGroup,
        attributes: await capture.call(item.handle, "getAttributes", [], {
          resultFormat: "typed-v2",
        }),
      });
    }
  }
  return { notes: emitted, attributes, fingerprints, truncated };
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

function normalizeQuarterBlick(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw codedError("HOST_DATA_INVALID", "SV.QUARTER must be a positive safe integer");
  }
  return value;
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
  let from;
  let to;
  try {
    from = normalizeMusicalPoint(scope.from, "scope.from");
    to = normalizeMusicalPoint(scope.to, "scope.to");
  } catch (error) {
    if (error?.code === "INVALID_MUSICAL_POSITION") error.code = "INVALID_SCOPE";
    throw error;
  }
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
  if (request.include !== undefined && !Array.isArray(request.include)) {
    throw codedError("INVALID_ARGUMENTS", "include must be an array");
  }
  const requested = request.include ?? ["notes", "tempoMap", "meterMap"];
  for (const item of requested) {
    if (SUPPORTED_INCLUDES.has(item)) include.add(item);
    else if (KNOWN_UNSUPPORTED_INCLUDES.has(item)) unsupportedIncludes.push(item);
    else throw codedError("INVALID_ARGUMENTS", `unknown include item: ${String(item)}`);
  }
  if (request.sinceToken !== undefined && typeof request.sinceToken !== "string") {
    throw codedError("INVALID_ARGUMENTS", "sinceToken must be a string");
  }
  const responseMode = request.responseMode ?? "standard";
  if (!["compact", "standard", "verbose"].includes(responseMode)) {
    throw codedError("INVALID_ARGUMENTS", "responseMode must be compact, standard, or verbose");
  }
  const automationParameters = normalizeStringList(
    request.automationParameters,
    DEFAULT_AUTOMATION_PARAMETERS,
    "automationParameters",
    16
  );
  const computedPitchSampling = normalizeComputedPitchSampling(request.computedPitchSampling);
  const budgets = normalizeBudgets(request.budgets);
  return {
    from,
    to,
    trackIndices,
    include,
    unsupportedIncludes,
    sinceToken: request.sinceToken,
    responseMode,
    automationParameters,
    computedPitchSampling,
    budgets,
  };
}

function validateRangeRequestShape(request) {
  if (!isRecord(request)) throw codedError("INVALID_ARGUMENTS", "request must be an object");
  assertKnownKeys(
    request,
    [
      "scope",
      "include",
      "automationParameters",
      "computedPitchSampling",
      "budgets",
      "responseMode",
      "sinceToken",
      "cursor",
    ],
    "request"
  );
  const hasScope = request.scope !== undefined;
  const hasCursor = request.cursor !== undefined;
  if (hasScope === hasCursor) {
    throw codedError("INVALID_ARGUMENTS", "provide exactly one of scope or cursor");
  }
  if (hasCursor) {
    if (Object.keys(request).some((key) => key !== "cursor")) {
      throw codedError("INVALID_ARGUMENTS", "cursor reads accept only the cursor field");
    }
    return;
  }
  if (isRecord(request.scope)) {
    assertKnownKeys(request.scope, ["kind", "trackIndices", "from", "to"], "scope");
    validateMusicalPointKeys(request.scope.from, "scope.from");
    validateMusicalPointKeys(request.scope.to, "scope.to");
  }
  if (isRecord(request.computedPitchSampling)) {
    assertKnownKeys(
      request.computedPitchSampling,
      ["frames", "startBlick", "intervalBlick"],
      "computedPitchSampling"
    );
  }
  if (isRecord(request.budgets)) {
    assertKnownKeys(
      request.budgets,
      ["notes", "attributes", "automationPoints", "computedPitchFrames", "bytes"],
      "budgets"
    );
  }
}

function validateMusicalPointKeys(value, label) {
  if (!isRecord(value)) return;
  assertKnownKeys(value, ["bar", "beat"], label);
  if (isRecord(value.beat)) {
    assertKnownKeys(value.beat, ["numerator", "denominator"], `${label}.beat`);
  }
}

function assertKnownKeys(value, allowed, label) {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw codedError("INVALID_ARGUMENTS", `${label} contains unknown field: ${unknown.join(", ")}`);
  }
}

function normalizeComputedPitchSampling(value) {
  if (value === undefined) return { frames: 160 };
  if (!isRecord(value)) {
    throw codedError("INVALID_ARGUMENTS", "computedPitchSampling must be an object");
  }
  return {
    frames: clampInteger(
      value.frames,
      1,
      RANGE_REQUEST_LIMITS.computedPitchFramesPerGroup,
      160,
      "computedPitchSampling.frames"
    ),
    ...(value.startBlick === undefined
      ? {}
      : {
          startBlick: clampInteger(
            value.startBlick,
            0,
            Number.MAX_SAFE_INTEGER,
            undefined,
            "computedPitchSampling.startBlick"
          ),
        }),
    ...(value.intervalBlick === undefined
      ? {}
      : {
          intervalBlick: clampInteger(
            value.intervalBlick,
            1,
            Number.MAX_SAFE_INTEGER,
            undefined,
            "computedPitchSampling.intervalBlick"
          ),
        }),
  };
}

function normalizeBudgets(value) {
  if (value !== undefined && !isRecord(value)) {
    throw codedError("INVALID_ARGUMENTS", "budgets must be an object");
  }
  const source = value ?? {};
  return {
    notes: clampInteger(
      source.notes,
      1,
      RANGE_PAGE_LIMITS.maximums.notes,
      DEFAULT_BUDGETS.notes,
      "budgets.notes"
    ),
    attributes: clampInteger(
      source.attributes,
      1,
      RANGE_PAGE_LIMITS.maximums.attributes,
      DEFAULT_BUDGETS.attributes,
      "budgets.attributes"
    ),
    automationPoints: clampInteger(
      source.automationPoints,
      1,
      RANGE_PAGE_LIMITS.maximums.automationPoints,
      DEFAULT_BUDGETS.automationPoints,
      "budgets.automationPoints"
    ),
    computedPitchFrames: clampInteger(
      source.computedPitchFrames,
      1,
      RANGE_PAGE_LIMITS.maximums.computedPitchFrames,
      DEFAULT_BUDGETS.computedPitchFrames,
      "budgets.computedPitchFrames"
    ),
    bytes: clampInteger(
      source.bytes,
      8_192,
      RANGE_PAGE_LIMITS.maximums.bytes,
      DEFAULT_BUDGETS.bytes,
      "budgets.bytes"
    ),
  };
}

function normalizeStringList(value, fallback, label, maximum) {
  if (value === undefined) return [...fallback];
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > maximum ||
    !value.every((item) => typeof item === "string" && item.length > 0)
  ) {
    throw codedError(
      "INVALID_ARGUMENTS",
      `${label} must contain between 1 and ${maximum} non-empty strings`
    );
  }
  return [...new Set(value)];
}

function clampInteger(value, minimum, maximum, fallback, label) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw codedError("INVALID_ARGUMENTS", `${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
