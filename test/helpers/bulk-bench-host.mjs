// Phase 1 批量读取基准的共享夹具：一个可参数化音符数的模拟宿主 +
// range context，legacy 与 bulk 两种能力下由同一模型驱动，指标才可比。
//
// 注意：这是模拟宿主，不是真机。它能证明 host-call 数与契约行为的变化，
// 不能替代 SynthV 实机验收。
import { NotePatchService } from "../../server/src/note-patch.js";
import { SnapshotService, SnapshotStore } from "../../server/src/snapshot.js";

const FIELDS = [
  "indexInGroup",
  "onsetBlick",
  "durationBlick",
  "pitch",
  "lyrics",
  "phonemesOverride",
  "languageOverride",
  "detuneCents",
];

const HANDLES = { project: 1, sv: 2, track: 4, groupReference: 5, group: 6 };
const NOTE_HANDLE_BASE = 1000;

function handle(id, type) {
  return { __handle__: id, __type__: type, __epoch__: 1 };
}

function noteState(index) {
  return {
    index,
    onset: index * 705600,
    duration: 705600,
    pitch: 60 + (index % 12),
    lyrics: `s${index}`,
    phonemes: "",
    language: "",
    detune: 0,
    attributes: { tF0Offset: 0, dur: 1 },
  };
}

export function createBenchHost({ noteCount = 373, bulk = false } = {}) {
  const notes = Array.from({ length: noteCount }, (_, index) => noteState(index));
  const noteHandles = notes.map((_, index) => handle(NOTE_HANDLE_BASE + index, "Note"));
  const counters = { hostCalls: 0, setterCalls: 0, undoRecords: 0, bulkOps: 0, getterCalls: 0 };

  const readGetter = (note, method) => {
    const getters = {
      getIndexInParent: note.index + 1,
      getOnset: note.onset,
      getDuration: note.duration,
      getPitch: note.pitch,
      getLyrics: note.lyrics,
      getPhonemes: note.phonemes,
      getLanguageOverride: note.language,
      getDetune: note.detune,
    };
    return Object.hasOwn(getters, method) ? getters[method] : undefined;
  };

  const host = {
    epoch: () => 1,
    counters,
    roots: async () => {
      counters.hostCalls += 1;
      return {
        project: handle(HANDLES.project, "Project"),
        sv: handle(HANDLES.sv, "SV"),
      };
    },
    free: async () => {
      counters.hostCalls += 1;
    },
    index: async () => null,
    call: async ({ handle: target, method, args = [] }) => {
      counters.hostCalls += 1;
      const id = target?.__handle__;
      if (id === HANDLES.project) {
        if (method === "newUndoRecord") return ++counters.undoRecords;
        if (method === "getTrack") return handle(HANDLES.track, "Track");
        if (method === "getNumTracks") return 1;
      }
      if (id === HANDLES.track) {
        if (method === "getNumGroups") return 1;
        if (method === "getGroupReference") return handle(HANDLES.groupReference, "NoteGroupReference");
        if (method === "getName") return "Bench";
        if (method === "getIndexInParent") return 1;
      }
      if (id === HANDLES.groupReference) {
        if (method === "getTarget") return handle(HANDLES.group, "NoteGroup");
        if (method === "isInstrumental") return false;
        if (method === "isMain") return true;
        if (["getOnset", "getTimeOffset", "getPitchOffset"].includes(method)) return 0;
        if (method === "getIndexInParent") return 1;
      }
      if (id === HANDLES.group) {
        if (method === "getUUID") return "bench-group";
        if (method === "getNumNotes") return notes.length;
        if (method === "getNote") return noteHandles[args[0] - 1] ?? null;
        if (method === "getName") return "Bench Group";
      }
      const position = id - NOTE_HANDLE_BASE;
      const note = position >= 0 && position < notes.length ? notes[position] : null;
      if (note) {
        const value = readGetter(note, method);
        if (value !== undefined) {
          counters.getterCalls += 1;
          return value;
        }
        if (method === "getAttributes") return { ...note.attributes };
        if (method.startsWith("set")) {
          counters.setterCalls += 1;
          if (method === "setLyrics") note.lyrics = args[0];
          else if (method === "setPitch") note.pitch = args[0];
          else if (method === "setDetune") note.detune = args[0];
          else if (method === "setPhonemes") note.phonemes = args[0];
          else if (method === "setLanguageOverride") note.language = args[0];
          else if (method === "setAttributes") note.attributes = { ...note.attributes, ...args[0] };
          return null;
        }
      }
      if (id === HANDLES.sv && method === "getPhonemesForGroup") {
        return notes.map((item) => (item.lyrics ? `${item.lyrics}-p` : ""));
      }
      throw new Error(`unsupported call ${id}.${method}`);
    },
  };

  if (bulk) {
    host.supportsOp = (op) => op === "read_note_fingerprints_v1";
    host.bulk = async (command) => {
      counters.hostCalls += 1;
      counters.bulkOps += 1;
      const encode = (field, note) => {
        const raw = {
          indexInGroup: note.index,
          onsetBlick: note.onset,
          durationBlick: note.duration,
          pitch: note.pitch,
          lyrics: note.lyrics,
          phonemesOverride: note.phonemes,
          languageOverride: note.language,
          detuneCents: note.detune,
        }[field];
        return raw === undefined ? null : raw;
      };
      return {
        groupUuid: "bench-group",
        noteCount: notes.length,
        items: command.noteIndicesInGroup.map((index) => ({
          noteIndexInGroup: index,
          fingerprint: Object.fromEntries(
            command.fields.map((field) => [field, encode(field, notes[index])])
          ),
        })),
      };
    };
  }

  return { host, notes, counters };
}

export function createBenchFixture({ noteCount = 373, bulk = false } = {}) {
  const model = createBenchHost({ noteCount, bulk });
  const session = { withExclusive: (task) => task(model.host) };
  const snapshots = new SnapshotService(session, {
    store: new SnapshotStore({ now: () => 1000, ttlMs: 60 * 60_000 }),
    now: () => 1000,
  });
  const service = new NotePatchService(session, snapshots, {
    sleepFn: async () => {},
    now: () => 1000,
  });

  const entry = snapshots.store.create({
    epoch: 1,
    scope: { kind: "range" },
    observedAt: new Date(1000).toISOString(),
    context: { kind: "range", occurrences: [] },
  });
  entry.context.occurrences.push({
    occurrence: 0,
    trackIndex: 0,
    groupIndex: 0,
    targetGroupUuid: "bench-group",
    timeOffsetBlick: 0,
    sharedTargetOccurrences: [0],
    noteFingerprints: model.notes.map((note) => ({
      indexInGroup: note.index,
      onsetBlick: note.onset,
      durationBlick: note.duration,
      pitch: note.pitch,
      lyrics: note.lyrics,
      phonemesOverride: note.phonemes,
      languageOverride: note.language,
      detuneCents: note.detune,
    })),
  });

  return { ...model, snapshots, service, contextId: entry.contextId };
}

export const BENCH_FINGERPRINT_FIELDS = FIELDS;
