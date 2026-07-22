export function normalizeVoiceParameters(value) {
  if (!isRecord(value)) return value;
  const vocalModeParams = value.vocalModeParams;
  if (!isEmptyUnknownTable(vocalModeParams)) return value;
  // typed-v2 无法从空 Lua table 推断 map/array；voice 契约明确这里是名称到参数的 map。
  return { ...value, vocalModeParams: {} };
}

export function getVocalModeNames(value) {
  const vocalModeParams = value?.vocalModeParams;
  if (!isRecord(vocalModeParams) || vocalModeParams.$sv === "table") return [];
  return Object.keys(vocalModeParams);
}

function isEmptyUnknownTable(value) {
  return (
    isRecord(value) &&
    value.$sv === "table" &&
    value.shape === "unknown" &&
    Array.isArray(value.entries) &&
    value.entries.length === 0
  );
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
