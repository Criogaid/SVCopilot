import assert from "node:assert/strict";
import test from "node:test";

import { VoiceProfileService } from "../server/src/voice-profile.js";

// 两轨模型：track0 有 vocal + instrumental group；track 支持 clone/addTrack。
function createVoiceModel() {
  let nextHandle = 700;
  const handle = (type) => ({ __handle__: nextHandle++, __type__: type, __epoch__: 1 });
  const h = { project: handle("Project"), sv: handle("SV") };
  const model = { handles: h, undoCount: 0, tracks: [], failOnAddTrack: false };
  const makeTrack = (name, groups) => {
    const trackHandle = handle("Track");
    const track = { handle: trackHandle, name, groups };
    model.tracks.push(track);
    return track;
  };
  const vocalRef = handle("NoteGroupReference");
  const instRef = handle("NoteGroupReference");
  makeTrack("Lead", [
    {
      handle: vocalRef,
      instrumental: false,
      isMain: true,
      voice: {
        paramLoudness: 0,
        paramTension: 0.3,
        vocalModeParams: { Belt: 0.5, Airy: 0 },
      },
    },
    { handle: instRef, instrumental: true },
  ]);

  model.host = {
    epoch: () => 1,
    roots: async () => ({ project: h.project, sv: h.sv }),
    free: async () => {},
    index: async () => null,
    call: async ({ handle: target, method, args = [] }) => {
      const id = target?.__handle__;
      if (id === h.project.__handle__) {
        if (method === "getNumTracks") return model.tracks.length;
        if (method === "getTrack") return model.tracks[args[0] - 1].handle;
        if (method === "newUndoRecord") return ++model.undoCount;
        if (method === "addTrack") {
          if (model.failOnAddTrack) {
            const error = new Error("addTrack refused");
            error.code = "ARGUMENT_MISMATCH";
            throw error;
          }
          const clone = model.pendingClones.get(args[0].__handle__);
          model.tracks.push(clone);
          return model.tracks.length;
        }
      }
      const track = model.tracks.find((item) => item.handle.__handle__ === id)
        ?? model.pendingClones?.get(id);
      if (track) {
        if (method === "getName") return track.name;
        if (method === "setName") {
          track.name = args[0];
          return null;
        }
        if (method === "getNumGroups") return track.groups.length;
        if (method === "getGroupReference") return track.groups[args[0] - 1].handle;
        if (method === "clone") {
          model.pendingClones = model.pendingClones ?? new Map();
          const cloneHandle = handle("Track");
          const clone = {
            handle: cloneHandle,
            name: track.name,
            groups: track.groups.map((group) => ({ ...group, handle: handle("NoteGroupReference") })),
          };
          model.pendingClones.set(cloneHandle.__handle__, clone);
          return cloneHandle;
        }
      }
      for (const item of model.tracks) {
        const group = item.groups.find((candidate) => candidate.handle.__handle__ === id);
        if (group) {
          if (method === "isInstrumental") return group.instrumental;
          if (method === "isMain") return group.isMain ?? false;
          if (method === "getVoice") return group.voice;
        }
      }
      throw new Error(`unsupported voice call ${id}.${method}`);
    },
  };
  return model;
}

function createService(model) {
  return new VoiceProfileService(
    { withExclusive: (task) => task(model.host) },
    { now: () => 1000 }
  );
}

test("sv_get_voice_profile reports parameters and explicit unobservability", async () => {
  const model = createVoiceModel();
  const service = createService(model);
  const result = await service.getProfile({ trackIndex: 0 });

  assert.equal(result.ok, true);
  assert.equal(result.data.trackName, "Lead");
  assert.equal(result.data.groups.length, 2);
  const vocal = result.data.groups[0];
  assert.equal(vocal.voice.identityStatus, "unobservable");
  assert.deepEqual(vocal.voice.vocalModeNames, ["Belt", "Airy"]);
  assert.equal(vocal.voice.parameters.paramTension, 0.3);
  assert.equal(result.data.groups[1].instrumental, true);
  assert.equal(result.data.capabilities.singerIdentity, "unobservable");
});

test("sv_get_voice_profile normalizes an empty typed Lua table as no vocal modes", async () => {
  const model = createVoiceModel();
  model.tracks[0].groups[0].voice.vocalModeParams = {
    $sv: "table",
    shape: "unknown",
    entries: [],
  };

  const result = await createService(model).getProfile({ trackIndex: 0, groupIndex: 0 });
  const voice = result.data.groups[0].voice;
  assert.deepEqual(voice.parameters.vocalModeParams, {});
  assert.deepEqual(voice.vocalModeNames, []);
});

test("sv_get_voice_profile validates indices", async () => {
  const model = createVoiceModel();
  const service = createService(model);
  await assert.rejects(
    service.getProfile({ trackIndex: 5 }),
    (error) => error.code === "TRACK_INDEX_OUT_OF_RANGE"
  );
  await assert.rejects(
    service.getProfile({ trackIndex: 0, groupIndex: 9 }),
    (error) => error.code === "GROUP_INDEX_OUT_OF_RANGE"
  );
});

test("sv_clone_track_from_template clones, renames, and verifies", async () => {
  const model = createVoiceModel();
  const service = createService(model);
  const result = await service.cloneTrackFromTemplate({
    templateTrackIndex: 0,
    name: "Harmony 1",
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "succeeded");
  assert.equal(result.data.newTrackIndex, 1);
  assert.equal(result.data.trackCountAfter, 2);
  assert.equal(result.data.name, "Harmony 1");
  assert.equal(result.data.groupCount, 2);
  assert.equal(result.data.identityPreservation, "host_opaque");
  assert.equal(model.tracks[1].name, "Harmony 1");
  assert.equal(model.undoCount, 2);
  assert.equal(result.undo.expectedUserUndoSteps, 1);
});

test("sv_clone_track_from_template reports partial on addTrack failure", async () => {
  const model = createVoiceModel();
  model.failOnAddTrack = true;
  const service = createService(model);
  const result = await service.cloneTrackFromTemplate({ templateTrackIndex: 0 });

  assert.equal(result.ok, false);
  assert.equal(result.status, "partial");
  assert.equal(result.effects, "may_remain");
  assert.equal(result.error.code, "ARGUMENT_MISMATCH");
  assert.equal(model.tracks.length, 1);
});
