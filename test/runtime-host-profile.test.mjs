import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  loadRuntimeHostProfiles,
  selectRuntimeHostProfile,
} from "../server/src/runtime-host-profile.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const profilesDir = path.resolve(testDir, "fixtures", "host-profiles");

test("runtime host profiles require an exact product, version, and platform match", () => {
  const profiles = loadRuntimeHostProfiles(profilesDir);
  assert.equal(profiles.length, 1);
  const selected = selectRuntimeHostProfile(profiles, {
    hostProduct: "Synthesizer V Studio 2 Pro",
    hostVersion: "2.2.1",
    platform: "win32",
  });
  assert.equal(selected?.profileId, "synthv-2.2.1-win32-v2");
  assert.equal(
    selectRuntimeHostProfile(profiles, {
      hostProduct: "Synthesizer V Studio 2",
      hostVersion: "2.2.1",
      platform: "win32",
    }),
    null,
  );
  assert.equal(
    selectRuntimeHostProfile(profiles, {
      hostProduct: "Synthesizer V Studio 2 Pro",
      hostVersion: "2.2.2",
      platform: "win32",
    }),
    null,
  );
});
