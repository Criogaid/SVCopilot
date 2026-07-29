import assert from "node:assert/strict";
import test from "node:test";

import {
  NOTE_FINGERPRINT_FIELDS,
  READ_NOTE_FINGERPRINTS_V1,
  bulkChunkSize,
  createBulkStats,
  readNoteFingerprints,
} from "../server/src/note-fingerprint-reader.js";
import { createHostScope } from "../server/src/snapshot.js";

// 共享音符模型：第 2 个音符的 languageOverride 为未设置，第 3 个的 detune 是 NaN。
// 这两项正是两条路径表示最容易分叉的地方，必须由同一模型同时驱动。
function createNotes(count) {
  return Array.from({ length: count }, (_, index) => ({
    index,
    onset: index * 705600,
    duration: 705600,
    pitch: 60 + (index % 12),
    lyrics: `a${index}`,
    phonemes: "",
    language: index === 1 ? undefined : "mandarin",
    detune: index === 2 ? Number.NaN : 0,
  }));
}

function handle(id, type) {
  return { __handle__: id, __type__: type, __epoch__: 1 };
}

// legacy 宿主：只有逐 getter。marshal 会把 NaN 降级成 JSON null，未设置的字段返回
// undefined —— 夹具复现这两点，否则测不出批量路径是否真的收敛到同一表示。
function createLegacyHost(notes, { groupUuid = "group-1" } = {}) {
  const noteHandles = notes.map((_, index) => handle(100 + index, "Note"));
  const calls = [];
  const host = {
    epoch: () => 1,
    roots: async () => ({ project: handle(1, "Project") }),
    free: async () => {},
    index: async () => null,
    call: async ({ handle: target, method, args = [] }) => {
      calls.push(method);
      if (target?.__handle__ === 10) {
        if (method === "getUUID") return groupUuid;
        if (method === "getNumNotes") return notes.length;
        if (method === "getNote") return noteHandles[args[0] - 1] ?? null;
      }
      const position = noteHandles.findIndex((item) => item.__handle__ === target?.__handle__);
      if (position >= 0) {
        const note = notes[position];
        const getters = {
          getIndexInParent: note.index + 1,
          getOnset: note.onset,
          getDuration: note.duration,
          getPitch: note.pitch,
          getLyrics: note.lyrics,
          getPhonemes: note.phonemes,
          getLanguageOverride: note.language,
          getDetune: Number.isNaN(note.detune) ? null : note.detune,
        };
        if (Object.hasOwn(getters, method)) return getters[method];
      }
      throw new Error(`unsupported call ${target?.__handle__}.${method}`);
    },
  };
  return { host, noteHandles, calls };
}

// 新桥：宣告 opcode 并实现批量读取，nil 与特殊数字用 typed-v2 信封承载
// （decodeWireValue 会把 {$sv:"nil"} 解成 null）。
function createBulkHost(notes, { groupUuid = "group-1", onBulk } = {}) {
  const legacy = createLegacyHost(notes, { groupUuid });
  const bulkCommands = [];
  const host = {
    ...legacy.host,
    supportsOp: (op) => op === READ_NOTE_FINGERPRINTS_V1,
    bulk: async (command) => {
      bulkCommands.push(command);
      if (onBulk) {
        const override = onBulk(command, bulkCommands.length);
        if (override !== undefined) return override;
      }
      if (command.expectedGroupUuid !== undefined && command.expectedGroupUuid !== groupUuid) {
        const error = new Error(`STALE_GROUP_UUID: target group is ${groupUuid}`);
        error.code = "STALE_GROUP_UUID";
        throw error;
      }
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
        if (raw === undefined) return null;
        if (typeof raw === "number" && Number.isNaN(raw)) return { $sv: "number", value: "nan" };
        return raw;
      };
      return {
        groupUuid,
        noteCount: notes.length,
        items: command.noteIndicesInGroup.map((index) => ({
          noteIndexInGroup: index,
          fingerprint: Object.fromEntries(
            command.fields.map((field) => [field, encode(field, notes[index])])
          ),
        })),
      };
    },
  };
  return { host, noteHandles: legacy.noteHandles, calls: legacy.calls, bulkCommands };
}

async function readWith(hostBundle, indices, options = {}) {
  const scope = createHostScope(hostBundle.host);
  const stats = createBulkStats();
  const target = handle(10, "NoteGroup");
  const notes = [];
  for (const index of indices) {
    notes.push(await scope.call(target, "getNote", [index + 1], { inferredType: "Note" }));
  }
  const resolveCalls = hostBundle.calls.length;
  const fingerprints = await readNoteFingerprints(scope, {
    host: hostBundle.host,
    notes,
    trackIndex: 0,
    groupReferenceIndex: 0,
    noteIndicesInGroup: indices,
    stats,
    ...options,
  });
  return { fingerprints, stats, fieldCalls: hostBundle.calls.length - resolveCalls };
}

test("bulk and legacy fingerprint reads produce deep-equal normalized models", async () => {
  const indices = [0, 1, 2, 5, 9];
  const bulk = await readWith(createBulkHost(createNotes(12)), indices);
  const legacy = await readWith(createLegacyHost(createNotes(12)), indices);

  // 这是整个 Phase 1 的核心契约：上层用 isDeepStrictEqual 比对快照里存的指纹，
  // 两条路径任何表示差异都会变成假 STALE_CONTEXT。
  assert.deepStrictEqual(bulk.fingerprints, legacy.fingerprints);
  assert.equal(bulk.fingerprints.length, indices.length);
  assert.deepEqual(Object.keys(bulk.fingerprints[0]), [...NOTE_FINGERPRINT_FIELDS]);
});

test("both paths agree on unset overrides and host special numbers", async () => {
  const bulk = await readWith(createBulkHost(createNotes(4)), [1, 2]);
  const legacy = await readWith(createLegacyHost(createNotes(4)), [1, 2]);

  // 未设置的 languageOverride 在 legacy 下是 undefined，批量下是 typed-v2 nil。
  assert.equal(bulk.fingerprints[0].languageOverride, undefined);
  assert.equal(legacy.fingerprints[0].languageOverride, undefined);
  // NaN 在 legacy marshal 里降级成 null；批量不得把 typed-v2 信封原样漏给上层。
  assert.equal(bulk.fingerprints[1].detuneCents, null);
  assert.equal(legacy.fingerprints[1].detuneCents, null);
  assert.deepStrictEqual(bulk.fingerprints, legacy.fingerprints);
});

test("bulk collapses per-note getter round-trips into one host call", async () => {
  const indices = [0, 1, 2, 3, 4, 5, 6];
  const bulk = await readWith(createBulkHost(createNotes(8)), indices);
  const legacy = await readWith(createLegacyHost(createNotes(8)), indices);

  // 7 个音符 × 8 个字段 = 56 次 getter 往返，批量后是 1 次 internal op。
  assert.equal(legacy.fieldCalls, indices.length * NOTE_FINGERPRINT_FIELDS.length);
  assert.equal(bulk.fieldCalls, 0);
  assert.equal(bulk.stats.bulkHostCalls, 1);
  assert.equal(bulk.stats.bulkNotes, indices.length);
  assert.equal(bulk.stats.bulkFields, NOTE_FINGERPRINT_FIELDS.length);
  assert.equal(bulk.stats.fallbackUsed, false);
});

test("bulk chunks large index sets within the frame budget", async () => {
  const chunk = bulkChunkSize(NOTE_FINGERPRINT_FIELDS.length);
  assert.ok(chunk >= 1 && chunk <= 200);

  const total = chunk * 2 + 1;
  const notes = createNotes(total);
  const bundle = createBulkHost(notes);
  const indices = notes.map((note) => note.index);
  const { fingerprints, stats } = await readWith(bundle, indices);

  assert.equal(fingerprints.length, total);
  assert.equal(stats.bulkHostCalls, 3);
  assert.equal(stats.bulkNotes, total);
  assert.ok(bundle.bulkCommands.every((command) => command.noteIndicesInGroup.length <= chunk));
  // 分块只是传输细节：结果顺序必须仍与请求顺序一致。
  assert.deepEqual(
    fingerprints.map((item) => item.indexInGroup),
    indices
  );
});

test("an old bridge without the opcode silently falls back to per-note getters", async () => {
  const indices = [0, 2];
  const bundle = createLegacyHost(createNotes(4));
  const { fingerprints, stats, fieldCalls } = await readWith(bundle, indices);

  assert.equal(stats.fallbackUsed, true);
  assert.equal(stats.fallbackReason, "HOST_CAPABILITY_ABSENT");
  assert.equal(stats.bulkHostCalls, 0);
  assert.equal(fieldCalls, indices.length * NOTE_FINGERPRINT_FIELDS.length);
  assert.equal(fingerprints.length, indices.length);
});

test("a structurally refused bulk read falls back instead of failing the operation", async () => {
  const bundle = createBulkHost(createNotes(4), {
    onBulk: () => {
      const error = new Error("FRAME_TOO_LARGE: result is 70000 bytes");
      error.code = "FRAME_TOO_LARGE";
      throw error;
    },
  });
  const { fingerprints, stats, fieldCalls } = await readWith(bundle, [0, 1]);

  assert.equal(stats.fallbackUsed, true);
  assert.equal(stats.fallbackReason, "FRAME_TOO_LARGE");
  assert.equal(fieldCalls, 2 * NOTE_FINGERPRINT_FIELDS.length);
  assert.deepStrictEqual(
    fingerprints,
    (await readWith(createLegacyHost(createNotes(4)), [0, 1])).fingerprints
  );
});

test("a stale group uuid propagates and never re-reads through the fallback", async () => {
  const bundle = createBulkHost(createNotes(4), { groupUuid: "group-current" });
  const scope = createHostScope(bundle.host);
  const target = handle(10, "NoteGroup");
  const notes = [await scope.call(target, "getNote", [1], { inferredType: "Note" })];
  const before = bundle.calls.length;

  // 过期是真实的前置条件失败，不是能力问题：静默回退等于在已经变动的 Group 上
  // 重新读一遍并掩盖过期。
  await assert.rejects(
    readNoteFingerprints(scope, {
      host: bundle.host,
      notes,
      trackIndex: 0,
      groupReferenceIndex: 0,
      expectedGroupUuid: "group-from-snapshot",
      noteIndicesInGroup: [0],
    }),
    (error) => error.code === "STALE_GROUP_UUID"
  );
  assert.equal(bundle.calls.length, before);
});

test("bulk forwards the expected group uuid and never asks for a handle", async () => {
  const bundle = createBulkHost(createNotes(3));
  await readWith(bundle, [0, 1], { expectedGroupUuid: "group-1" });

  const [command] = bundle.bulkCommands;
  assert.equal(command.op, READ_NOTE_FINGERPRINTS_V1);
  assert.equal(command.expectedGroupUuid, "group-1");
  assert.equal(command.resultFormat, "typed-v2");
  assert.deepEqual(command.noteIndicesInGroup, [0, 1]);
  assert.deepEqual(command.fields, [...NOTE_FINGERPRINT_FIELDS]);
});

test("bulk diagnostics count notes and fields but never record lyric content", async () => {
  const bundle = createBulkHost(createNotes(3));
  const { stats } = await readWith(bundle, [0, 1, 2]);

  assert.deepEqual(Object.keys(stats).sort(), [
    "bulkFields",
    "bulkHostCalls",
    "bulkNotes",
    "fallbackReason",
    "fallbackUsed",
  ]);
  const serialized = JSON.stringify(stats);
  for (const note of createNotes(3)) assert.equal(serialized.includes(note.lyrics), false);
});

test("a short or misaligned bulk response fails instead of returning shifted fingerprints", async () => {
  const dropped = createBulkHost(createNotes(4), {
    onBulk: (command) => ({
      groupUuid: "group-1",
      noteCount: 4,
      items: command.noteIndicesInGroup.slice(1).map((index) => ({
        noteIndexInGroup: index,
        fingerprint: { pitch: 60 },
      })),
    }),
  });
  await assert.rejects(readWith(dropped, [0, 1, 2]), (error) => error.code === "HOST_CALL_FAILED");

  const relabelled = createBulkHost(createNotes(4), {
    onBulk: (command) => ({
      groupUuid: "group-1",
      noteCount: 4,
      items: command.noteIndicesInGroup.map((index) => ({
        noteIndexInGroup: index + 100,
        fingerprint: { pitch: 60 },
      })),
    }),
  });
  await assert.rejects(readWith(relabelled, [0, 1]), (error) => error.code === "HOST_CALL_FAILED");
});

test("callers must pass the resolved handles that match the requested indices", async () => {
  const bundle = createLegacyHost(createNotes(4));
  const scope = createHostScope(bundle.host);

  await assert.rejects(
    readNoteFingerprints(scope, {
      host: bundle.host,
      notes: [],
      trackIndex: 0,
      groupReferenceIndex: 0,
      noteIndicesInGroup: [0, 1],
    }),
    (error) => error.code === "INVALID_ARGUMENTS"
  );
});

test("an empty index set reads nothing at all", async () => {
  const bundle = createBulkHost(createNotes(2));
  const scope = createHostScope(bundle.host);
  const stats = createBulkStats();

  const fingerprints = await readNoteFingerprints(scope, {
    host: bundle.host,
    notes: [],
    trackIndex: 0,
    groupReferenceIndex: 0,
    noteIndicesInGroup: [],
    stats,
  });

  assert.deepEqual(fingerprints, []);
  assert.equal(stats.bulkHostCalls, 0);
  assert.equal(bundle.bulkCommands.length, 0);
  assert.equal(stats.fallbackUsed, false);
});
