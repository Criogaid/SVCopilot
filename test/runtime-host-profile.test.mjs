import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  loadRuntimeHostProfiles,
  selectRuntimeHostProfile,
} from "../server/src/runtime-host-profile.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
// 运行时 profile 现在属于服务自身目录（随 npm 包发布），不再放在 test fixtures 下。
const profilesDir = path.resolve(testDir, "..", "server", "host-profiles");

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
