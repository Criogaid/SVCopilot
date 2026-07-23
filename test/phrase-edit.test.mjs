import assert from "node:assert/strict";
import test from "node:test";

import { PhraseEditService } from "../server/src/phrase-edit.js";

const Q = 705600000;

function createPhraseModel({
  shared = false,
  quantizeVoice = false,
  failProcessing = false,
  capturedNoteCount = null,
} = {}) {
  let nextHandle = 1_000;
  let cloneCount = 0;
  const states = new Map();
  const make = (type, state = {}) => {
    const handle = { __handle__: nextHandle++, __type__: type, __epoch__: 1 };
    states.set(handle.__handle__, { type, ...state });
    return handle;
  };
  const h = {
    project: make("Project"),
    sv: make("SV"),
    track: make("Track"),
    reference: make("NoteGroupReference"),
  };
  const definitions = {
    loudness: { typeName: "loudness", displayName: "Loudness", range: [-24, 24], defaultValue: 0 },
  };

  const createNote = (data) => make("Note", { data: { attributes: {}, ...data }, parent: null });
  const createAutomation = (parameter, points) =>
    make("Automation", { parameter, points: points.map((point) => [...point]) });
  const createGroup = (uuid, notes, automationPoints = { loudness: [[0, 0]] }) => {
    const group = make("NoteGroup", {
      uuid,
      name: "Phrase",
      notes: [],
      automations: Object.fromEntries(
        Object.entries(automationPoints).map(([parameter, points]) => [
          parameter,
          createAutomation(parameter, points),
        ])
      ),
    });
    const groupState = states.get(group.__handle__);
    groupState.notes = notes.map((data) => {
      const note = createNote(data);
      states.get(note.__handle__).parent = group;
      return note;
    });
    return group;
  };
  const originalGroup = createGroup("phrase-original", [
    {
      onsetBlick: 0,
      durationBlick: Q,
      pitch: 60,
      lyrics: "when",
      phonemesOverride: "w eh n",
      languageOverride: "english",
      detuneCents: 0,
      attributes: { rapAccent: 0 },
    },
    {
      onsetBlick: Q,
      durationBlick: Q,
      pitch: 62,
      lyrics: "I",
      phonemesOverride: "ay",
      languageOverride: "english",
      detuneCents: 0,
      attributes: { rapAccent: 0 },
    },
  ]);
  let currentTarget = originalGroup;
  let voice = {
    paramTension: 0.2,
    paramBreathiness: 0,
    vocalModeParams: { Clear: 0.1 },
  };
  const model = {
    h,
    states,
    originalGroup,
    undoCount: 0,
    failSetVoiceOnce: false,
    corruptCurveAfterCommit: false,
    commitStarted: false,
    setTargetCalls: 0,
    shared,
    get currentTarget() {
      return currentTarget;
    },
    get voice() {
      return voice;
    },
    get cloneCount() {
      return cloneCount;
    },
  };

  const cloneNote = (source) => {
    const sourceState = states.get(source.__handle__);
    return createNote(structuredClone(sourceState.data));
  };
  const cloneGroup = (source) => {
    const sourceState = states.get(source.__handle__);
    const automationPoints = Object.fromEntries(
      Object.entries(sourceState.automations).map(([parameter, automation]) => [
        parameter,
        states.get(automation.__handle__).points,
      ])
    );
    return createGroup(
      `phrase-clone-${++cloneCount}`,
      sourceState.notes.map((note) => structuredClone(states.get(note.__handle__).data)),
      automationPoints
    );
  };
  const sortGroupNotes = (groupState) => {
    groupState.notes.sort(
      (left, right) =>
        states.get(left.__handle__).data.onsetBlick - states.get(right.__handle__).data.onsetBlick
    );
  };

  model.host = {
    epoch: () => 1,
    roots: async () => ({ project: h.project, sv: h.sv }),
    index: async () => null,
    free: async () => {},
    call: async ({ handle: target, method, args = [] }) => {
      const state = states.get(target?.__handle__);
      if (!state) throw new Error(`unknown phrase handle ${target?.__handle__}`);
      if (state.type === "Project") {
        if (method === "getNumTracks") return 1;
        if (method === "getTrack") return h.track;
        if (method === "newUndoRecord") {
          model.commitStarted = true;
          return ++model.undoCount;
        }
      }
      if (state.type === "Track") {
        if (method === "getNumGroups") return model.shared ? 2 : 1;
        if (method === "getGroupReference") return h.reference;
      }
      if (state.type === "NoteGroupReference") {
        if (method === "isInstrumental") return false;
        if (method === "getTarget") return currentTarget;
        if (method === "setTarget") {
          model.setTargetCalls += 1;
          throw new Error("target is immutable once assigned");
        }
        if (method === "getVoice") return structuredClone(voice);
        if (method === "setVoice") {
          if (model.failSetVoiceOnce) {
            model.failSetVoiceOnce = false;
            const error = new Error("injected setVoice failure");
            error.code = "ARGUMENT_MISMATCH";
            throw error;
          }
          voice = structuredClone(args[0]);
          if (quantizeVoice) voice.paramTension = Math.fround(voice.paramTension);
          return null;
        }
        if (method === "getTimeOffset" || method === "getOnset") return 4 * Q;
      }
      if (state.type === "SV") {
        if (method === "getPhonemesForGroup") {
          if (failProcessing) {
            const error = new Error("injected processing observation failure");
            error.code = "HOST_CALL_FAILED";
            throw error;
          }
          return ["w eh n", "ay"];
        }
        if (method === "create") return createNote({
          onsetBlick: 0,
          durationBlick: Q,
          pitch: 60,
          lyrics: "",
          phonemesOverride: "",
          languageOverride: "",
          detuneCents: 0,
          attributes: {},
        });
      }
      if (state.type === "NoteGroup") {
        if (method === "getUUID") return state.uuid;
        if (method === "getNumNotes") return state.notes.length;
        if (method === "getNote") return state.notes[args[0] - 1] ?? null;
        if (method === "clone") return cloneGroup(target);
        if (method === "getParameter") return state.automations[args[0]] ?? null;
        if (method === "addNote") {
          states.get(args[0].__handle__).parent = target;
          state.notes.push(args[0]);
          sortGroupNotes(state);
          return state.notes.indexOf(args[0]) + 1;
        }
        if (method === "removeNote") {
          const [removed] = state.notes.splice(args[0] - 1, 1);
          if (removed) states.get(removed.__handle__).parent = null;
          return Boolean(removed);
        }
      }
      if (state.type === "Note") {
        const data = state.data;
        const parentState = state.parent ? states.get(state.parent.__handle__) : null;
        if (method === "getIndexInParent") return parentState ? parentState.notes.indexOf(target) + 1 : -1;
        const getters = {
          getOnset: data.onsetBlick,
          getDuration: data.durationBlick,
          getPitch: data.pitch,
          getLyrics: data.lyrics,
          getPhonemes: data.phonemesOverride,
          getLanguageOverride: data.languageOverride,
          getDetune: data.detuneCents,
          getAttributes: structuredClone(data.attributes),
        };
        if (Object.hasOwn(getters, method)) return getters[method];
        if (method === "clone") return cloneNote(target);
        if (method === "setTimeRange") {
          data.onsetBlick = args[0];
          data.durationBlick = args[1];
          if (parentState) sortGroupNotes(parentState);
          return null;
        }
        const setters = {
          setOnset: "onsetBlick",
          setDuration: "durationBlick",
          setPitch: "pitch",
          setLyrics: "lyrics",
          setPhonemes: "phonemesOverride",
          setLanguageOverride: "languageOverride",
          setDetune: "detuneCents",
          setAttributes: "attributes",
        };
        if (setters[method]) {
          if (method === "setAttributes") {
            data.attributes = { ...data.attributes, ...structuredClone(args[0]) };
          } else {
            data[setters[method]] = structuredClone(args[0]);
          }
          if (method === "setOnset" && parentState) sortGroupNotes(parentState);
          return null;
        }
      }
      if (state.type === "Automation") {
        const definition = definitions[state.parameter];
        if (method === "getDefinition") return structuredClone(definition);
        if (method === "getType") return state.parameter;
        if (method === "getInterpolationMethod") return "Linear";
        if (method === "getAllPoints") {
          const originalAutomation = states.get(originalGroup.__handle__).automations[state.parameter];
          if (
            model.corruptCurveAfterCommit &&
            model.commitStarted &&
            target.__handle__ === originalAutomation.__handle__
          ) {
            model.corruptCurveAfterCommit = false;
            return [[0, -9]];
          }
          return state.points.map((point) => [...point]);
        }
        if (method === "get") {
          return state.points.find(([blick]) => blick === args[0])?.[1] ?? definition.defaultValue;
        }
        if (method === "remove") {
          state.points = state.points.filter(([blick]) => blick < args[0] || blick > args[1]);
          return true;
        }
        if (method === "add") {
          const existing = state.points.find(([blick]) => blick === args[0]);
          if (existing) existing[1] = args[1];
          else state.points.push([args[0], args[1]]);
          state.points.sort((left, right) => left[0] - right[0]);
          return true;
        }
        if (method === "simplify") return true;
      }
      throw new Error(`unsupported phrase call ${state.type}.${method}`);
    },
  };

  const contextId = "ctx_phrase";
  const occurrenceId = `${contextId}:t:0:r:0`;
  const originalState = states.get(originalGroup.__handle__);
  const fingerprints = originalState.notes.map((note, index) => {
    const data = states.get(note.__handle__).data;
    return {
      noteId: `${occurrenceId}:n:${index}`,
      indexInGroup: index,
      ...structuredClone(data),
      attributes: undefined,
    };
  });
  for (const fingerprint of fingerprints) delete fingerprint.attributes;
  const capturedFingerprints =
    capturedNoteCount === null ? fingerprints : fingerprints.slice(0, capturedNoteCount);
  const stored = {
    epoch: 1,
    contextId,
    context: {
      kind: "range",
      quarterBlick: Q,
      meterMarks: [{ position: 0, positionBlick: 0, numerator: 4, denominator: 4 }],
      occurrences: [
        {
          occurrenceId,
          trackIndex: 0,
          groupIndex: 0,
          targetGroupUuid: "phrase-original",
          timeOffsetBlick: 4 * Q,
          sharedTargetOccurrences: shared ? [occurrenceId, `${contextId}:t:0:r:1`] : [occurrenceId],
          noteFingerprints: capturedFingerprints,
        },
      ],
    },
  };
  const snapshotService = {
    deleted: [],
    getContext(id, epoch) {
      assert.equal(id, contextId);
      assert.equal(epoch, 1);
      return stored;
    },
    store: {
      delete(id) {
        snapshotService.deleted.push(id);
      },
    },
  };
  const service = new PhraseEditService(
    { withExclusive: (task) => task(model.host) },
    snapshotService,
    { now: () => 1_000 }
  );
  return { model, service, contextId, occurrenceId, fingerprints, snapshotService };
}

function fullRequest(contextId, occurrenceId, overrides = {}) {
  return {
    target: { contextId, occurrenceId, expectedGroupUuid: "phrase-original" },
    notePatches: [
      {
        noteId: `${occurrenceId}:n:0`,
        expected: { lyrics: "when" },
        set: { lyrics: "where", pitch: 61, attributes: { rapAccent: 0.5 } },
      },
    ],
    structureOperations: [
      { op: "split", noteId: `${occurrenceId}:n:1`, atBlick: Q + Q / 2, secondLyrics: "-" },
    ],
    curves: [
      {
        parameter: "loudness",
        mode: "replace",
        range: { coordinate: "local", fromBlick: 0, toBlick: 2 * Q },
        points: [
          { anchor: { noteId: `${occurrenceId}:n:0`, position: "onset" }, value: 2 },
        ],
      },
    ],
    voicePatch: { paramTension: 0.4, vocalModeParams: { Clear: 0.5 } },
    waitFor: "none",
    ...overrides,
  };
}

test("sv_edit_phrase dry-run verifies a detached clone without project mutations", async () => {
  const { model, service, contextId, occurrenceId } = createPhraseModel();
  const result = await service.edit(fullRequest(contextId, occurrenceId, { dryRun: true }));
  assert.equal(result.ok, true);
  assert.equal(result.status, "dry_run");
  assert.equal(result.effects, "none");
  assert.equal(model.currentTarget, model.originalGroup);
  assert.equal(model.undoCount, 0);
  assert.equal(model.voice.paramTension, 0.2);
  assert.equal(result.changes.notePatches.changedNotes, 1);
  assert.equal(result.changes.structure.finalNoteCount, 3);
  assert.equal(result.changes.curves[0].verified, true);
});

test("sv_edit_phrase returns no_change without creating an empty Undo", async () => {
  const { model, service, contextId, occurrenceId } = createPhraseModel({ capturedNoteCount: 1 });
  const result = await service.edit({
    target: { contextId, occurrenceId },
    curves: [
      {
        parameter: "loudness",
        mode: "replace",
        range: { fromBlick: 0, toBlick: Q },
        points: [{ blick: 0, value: 0 }],
      },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "no_change");
  assert.equal(result.effects, "none");
  assert.equal(result.undo.expectedUserUndoSteps, 0);
  assert.equal(model.undoCount, 0);
  assert.equal(result.preflightMode, "live_non_structural");
  assert.equal(result.verification.phase, "live_preflight");
  assert.equal(result.changes.structure.countScope, "target_group");
  assert.equal(result.changes.structure.initialNoteCount, 2);
  assert.equal(result.changes.structure.finalNoteCount, 2);
  assert.equal(result.changes.finalNoteCount, 2);
  assert.equal(model.cloneCount, 0);
});

test("sv_edit_phrase keeps simplify on detached preflight because its effect is host-defined", async () => {
  const { model, service, contextId, occurrenceId } = createPhraseModel();
  const result = await service.edit({
    target: { contextId, occurrenceId },
    curves: [
      {
        parameter: "loudness",
        mode: "replace",
        range: { fromBlick: 0, toBlick: Q },
        points: [{ blick: 0, value: 0 }],
        simplifyThreshold: 0.1,
      },
    ],
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, "no_change");
  assert.equal(result.preflightMode, "detached_note_group");
  assert.equal(model.cloneCount, 2);
  assert.equal(model.undoCount, 0);
});

test("sv_edit_phrase commits note, structure, curve, and voice changes in one Undo", async () => {
  const { model, service, contextId, occurrenceId, snapshotService } = createPhraseModel({ shared: true });
  const result = await service.edit(
    fullRequest(contextId, occurrenceId, {
      target: { contextId, occurrenceId, allowSharedTargetMutation: true },
    })
  );
  assert.equal(result.ok, true);
  assert.equal(result.status, "succeeded");
  assert.equal(result.undo.expectedUserUndoSteps, 1);
  assert.equal(model.undoCount, 2);
  assert.equal(model.currentTarget, model.originalGroup);
  assert.equal(model.setTargetCalls, 0);
  const targetState = model.states.get(model.currentTarget.__handle__);
  assert.equal(targetState.notes.length, 3);
  assert.equal(model.states.get(targetState.notes[0].__handle__).data.lyrics, "where");
  assert.equal(model.states.get(targetState.notes[0].__handle__).data.attributes.rapAccent, 0.5);
  const curve = model.states.get(targetState.automations.loudness.__handle__);
  assert.deepEqual(curve.points, [[0, 2]]);
  assert.equal(model.voice.paramTension, 0.4);
  assert.equal(model.voice.vocalModeParams.Clear, 0.5);
  assert.equal(result.target.targetSemantics, "shared_target_mutated_with_confirmation");
  assert.equal(result.preflightMode, "detached_note_group");
  assert.equal(model.cloneCount, 2);
  assert.deepEqual(snapshotService.deleted, [contextId]);
});

test("sv_edit_phrase keeps noteId bindings stable when an onset patch reorders notes", async () => {
  const { model, service, contextId, occurrenceId } = createPhraseModel();
  const result = await service.edit({
    target: { contextId, occurrenceId, expectedGroupUuid: "phrase-original" },
    notePatches: [
      {
        noteId: `${occurrenceId}:n:0`,
        expected: { lyrics: "when" },
        set: { onsetBlick: 2 * Q },
      },
    ],
    structureOperations: [{ op: "delete", noteId: `${occurrenceId}:n:1` }],
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  const group = model.states.get(model.currentTarget.__handle__);
  assert.equal(group.notes.length, 1);
  const remaining = model.states.get(group.notes[0].__handle__).data;
  assert.equal(remaining.lyrics, "when");
  assert.equal(remaining.onsetBlick, 2 * Q);
});

test("sv_edit_phrase validates merge adjacency after earlier structure operations", async () => {
  const { model, service, contextId, occurrenceId } = createPhraseModel();
  const result = await service.edit({
    target: { contextId, occurrenceId },
    structureOperations: [
      {
        op: "insert",
        note: { onsetBlick: Q / 2, durationBlick: Q / 4, pitch: 61, lyrics: "new" },
      },
      {
        op: "merge",
        noteIds: [`${occurrenceId}:n:0`, `${occurrenceId}:n:1`],
        lyricsJoin: "concat",
      },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "INVALID_ARGUMENTS");
  assert.equal(result.effects, "none");
  assert.equal(model.undoCount, 0);
});

test("sv_edit_phrase accepts float32 voice read-back and rejects scalar type mismatches", async () => {
  const quantized = createPhraseModel({ quantizeVoice: true });
  const succeeded = await quantized.service.edit({
    target: { contextId: quantized.contextId, occurrenceId: quantized.occurrenceId },
    voicePatch: { paramTension: 0.3 },
  });
  assert.equal(succeeded.ok, true, JSON.stringify(succeeded));
  assert.equal(succeeded.verification.evidence.voicePassed, true);
  assert.equal(succeeded.verification.phase, "commit_readback");
  assert.equal(succeeded.verification.evidence.expectedNoteCount, 2);
  assert.equal(succeeded.verification.evidence.observedNoteCount, 2);
  assert.equal(succeeded.preflightMode, "live_non_structural");
  assert.equal(succeeded.target.targetSemantics, "occurrence_voice_mutated");
  assert.equal(quantized.model.cloneCount, 0);

  const invalid = createPhraseModel();
  const rejected = await invalid.service.edit({
    target: { contextId: invalid.contextId, occurrenceId: invalid.occurrenceId },
    voicePatch: { paramTension: "high" },
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, "INVALID_ARGUMENTS");
  assert.equal(invalid.model.undoCount, 0);
});

test("sv_edit_phrase voice-only commit skips shared-target scanning and detached clones", async () => {
  const shared = createPhraseModel({ shared: true });
  const result = await shared.service.edit({
    target: { contextId: shared.contextId, occurrenceId: shared.occurrenceId },
    voicePatch: { paramTension: 0.4 },
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.target.targetSemantics, "occurrence_voice_mutated");
  assert.equal(result.target.knownTargetOccurrenceCount, 2);
  assert.deepEqual(result.target.projectTargetOccurrences, []);
  assert.equal(shared.model.cloneCount, 0);
  assert.equal(shared.model.undoCount, 2);
});

test("sv_edit_phrase fast curve and voice path rolls journals back without a clone", async () => {
  const fixture = createPhraseModel();
  fixture.model.failSetVoiceOnce = true;
  const result = await fixture.service.edit({
    target: { contextId: fixture.contextId, occurrenceId: fixture.occurrenceId },
    curves: [
      {
        parameter: "loudness",
        mode: "replace",
        range: { fromBlick: 0, toBlick: Q },
        points: [{ blick: 0, value: 2 }],
      },
    ],
    voicePatch: { paramTension: 0.4 },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "rolled_back");
  assert.equal(result.rollback.verified, true);
  assert.equal(fixture.model.cloneCount, 0);
  assert.equal(fixture.model.voice.paramTension, 0.2);
  const group = fixture.model.states.get(fixture.model.originalGroup.__handle__);
  assert.deepEqual(fixture.model.states.get(group.automations.loudness.__handle__).points, [[0, 0]]);
});

test("sv_edit_phrase does not roll back a verified commit when processing observation fails", async () => {
  const { model, service, contextId, occurrenceId } = createPhraseModel({ failProcessing: true });
  const result = await service.edit({
    target: { contextId, occurrenceId },
    notePatches: [{ noteId: `${occurrenceId}:n:0`, set: { lyrics: "where" } }],
    waitFor: "phonemes",
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "processing_observation_failed");
  assert.equal(result.effects, "verified");
  assert.equal(result.processing.error.code, "HOST_CALL_FAILED");
  assert.equal(model.undoCount, 2);
  const target = model.states.get(model.currentTarget.__handle__);
  assert.equal(model.states.get(target.notes[0].__handle__).data.lyrics, "where");
});

test("sv_edit_phrase requires confirmation before mutating a shared project target", async () => {
  const { model, service, contextId, occurrenceId } = createPhraseModel({ shared: true });
  const preview = await service.edit(
    fullRequest(contextId, occurrenceId, { dryRun: true })
  );
  assert.equal(preview.ok, true);
  assert.ok(preview.warnings.some((warning) => warning.code === "SHARED_TARGET_DRY_RUN"));
  assert.equal(model.undoCount, 0);

  const result = await service.edit(fullRequest(contextId, occurrenceId));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "SHARED_TARGET_REQUIRES_CONFIRMATION");
  assert.equal(result.effects, "none");
  assert.equal(model.undoCount, 0);
  assert.equal(model.setTargetCalls, 0);
});

test("sv_edit_phrase restores original target and voice when commit fails", async () => {
  const { model, service, contextId, occurrenceId } = createPhraseModel();
  model.failSetVoiceOnce = true;
  const result = await service.edit(fullRequest(contextId, occurrenceId));
  assert.equal(result.ok, false);
  assert.equal(result.status, "rolled_back");
  assert.equal(result.effects, "reverted");
  assert.equal(result.rollback.verified, true);
  assert.equal(model.currentTarget, model.originalGroup);
  assert.equal(model.voice.paramTension, 0.2);
  assert.equal(model.undoCount, 2);
});

test("sv_edit_phrase reports atomicity none and leaves partial effects when atomic is false", async () => {
  const { model, service, contextId, occurrenceId } = createPhraseModel();
  model.failSetVoiceOnce = true;
  const result = await service.edit(
    fullRequest(contextId, occurrenceId, { atomic: false })
  );

  assert.equal(result.ok, false);
  assert.equal(result.status, "partial");
  assert.equal(result.atomicity, "none");
  assert.equal(result.rollback.attempted, false);
  const target = model.states.get(model.currentTarget.__handle__);
  assert.equal(model.states.get(target.notes[0].__handle__).data.lyrics, "where");
});

test("sv_edit_phrase rolls back when committed curve read-back differs from the detached plan", async () => {
  const { model, service, contextId, occurrenceId } = createPhraseModel();
  model.corruptCurveAfterCommit = true;
  const result = await service.edit(fullRequest(contextId, occurrenceId));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "POSTCONDITION_FAILED");
  assert.equal(result.status, "rolled_back");
  assert.equal(result.rollback.verified, true);
  assert.equal(model.currentTarget, model.originalGroup);
});

test("sv_edit_phrase rejects overlapping or duplicate note edits before host access", async () => {
  const { model, service, contextId, occurrenceId } = createPhraseModel();
  const noteId = `${occurrenceId}:n:0`;
  const overlapping = await service.edit({
    target: { contextId, occurrenceId },
    notePatches: [{ noteId, set: { lyrics: "where" } }],
    structureOperations: [{ op: "delete", noteId }],
  });
  assert.equal(overlapping.error.code, "OVERLAPPING_NOTE_EDIT");
  assert.equal(model.undoCount, 0);

  const duplicate = await service.edit({
    target: { contextId, occurrenceId },
    notePatches: [
      { noteId, set: { lyrics: "where" } },
      { noteId, set: { pitch: 61 } },
    ],
  });
  assert.equal(duplicate.error.code, "DUPLICATE_NOTE_ID");
  assert.equal(model.undoCount, 0);
});

test("sv_edit_phrase rejects stale range fingerprints before Undo or live mutation", async () => {
  const { model, service, contextId, occurrenceId } = createPhraseModel();
  const originalState = model.states.get(model.originalGroup.__handle__);
  model.states.get(originalState.notes[0].__handle__).data.pitch = 65;
  const result = await service.edit(fullRequest(contextId, occurrenceId));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "STALE_CONTEXT");
  assert.equal(result.effects, "none");
  assert.equal(model.currentTarget, model.originalGroup);
  assert.equal(model.undoCount, 0);
});

test("sv_edit_phrase rejects unobservable voice fields without project effects", async () => {
  const { model, service, contextId, occurrenceId } = createPhraseModel();
  const result = await service.edit({
    target: { contextId, occurrenceId },
    voicePatch: { singerName: "Not Observable" },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "UNKNOWN_VOICE_PARAMETER");
  assert.equal(model.currentTarget, model.originalGroup);
  assert.equal(model.undoCount, 0);
});

test("sv_edit_phrase sends only requested attributes when old values contain typed sentinels", async () => {
  const { model, service, contextId, occurrenceId } = createPhraseModel();
  const originalState = model.states.get(model.originalGroup.__handle__);
  model.states.get(originalState.notes[0].__handle__).data.attributes.tF0Offset = {
    $sv: "number",
    value: "nan",
  };
  const writes = [];
  const originalCall = model.host.call;
  model.host.call = async (request) => {
    if (request.method === "setAttributes") writes.push(structuredClone(request.args[0]));
    return originalCall(request);
  };

  const result = await service.edit({
    target: { contextId, occurrenceId, expectedGroupUuid: "phrase-original" },
    notePatches: [
      {
        noteId: `${occurrenceId}:n:0`,
        set: { attributes: { rapAccent: 0.5 } },
      },
    ],
    structureOperations: [],
    curves: [],
    waitFor: "none",
    dryRun: true,
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(writes, [{ rapAccent: 0.5 }]);
});
