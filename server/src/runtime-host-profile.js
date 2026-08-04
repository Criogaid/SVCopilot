import fs from "node:fs";
import path from "node:path";

const PROFILE_KIND = "svcopilot-host-profile";
const PROFILE_SCHEMA_VERSION = "2.0.0";

export function loadRuntimeHostProfiles(directory) {
  let names;
  try {
    names = fs.readdirSync(directory).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return Object.freeze([]);
  }
  const profiles = [];
  for (const name of names) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
      const profile = normalizeRuntimeProfile(parsed);
      if (profile !== null) profiles.push(profile);
    } catch {
      // 单个损坏的证据文件不能解锁能力，也不能阻止其他精确匹配的 profile 生效。
    }
  }
  return Object.freeze(profiles);
}

export function selectRuntimeHostProfile(profiles, host) {
  if (!Array.isArray(profiles) || !isRecord(host)) return null;
  const matches = profiles.filter((profile) => (
    profile.hostSelector.product === host.hostProduct &&
    profile.hostSelector.version === host.hostVersion &&
    profile.hostSelector.platform === host.platform
  ));
  return matches.length === 1 ? matches[0] : null;
}

function normalizeRuntimeProfile(value) {
  if (!isRecord(value) || value.kind !== PROFILE_KIND || value.schemaVersion !== PROFILE_SCHEMA_VERSION) {
    return null;
  }
  if (!isRecord(value.hostSelector) || !isRecord(value.semantics)) return null;
  const { product, version, platform } = value.hostSelector;
  if (![product, version, platform].every((item) => typeof item === "string" && item.length > 0)) {
    return null;
  }
  if (typeof value.evidenceSha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.evidenceSha256)) {
    return null;
  }
  return deepFreeze(structuredClone(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
