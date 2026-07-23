export function normalizeVoiceParameters(value) {
  if (!isRecord(value)) return value;
  const vocalModeParams = value.vocalModeParams;
  // voice 契约明确 vocalModeParams 是"模式名 → 参数"的 map。typed-v2 解不出普通对象的
  // envelope（空表的 table、非字符串键的 map、tuple 等）统一归一：字符串键的 entries
  // 保留，其余丢弃——绝不把 $sv/shape/entries 泄漏成"模式名"。
  if (!isRecord(vocalModeParams) || typeof vocalModeParams.$sv !== "string") return value;
  const entries = Array.isArray(vocalModeParams.entries) ? vocalModeParams.entries : [];
  const normalized = {};
  for (const entry of entries) {
    if (Array.isArray(entry) && typeof entry[0] === "string") normalized[entry[0]] = entry[1];
  }
  return { ...value, vocalModeParams: normalized };
}

export function getVocalModeNames(value) {
  const vocalModeParams = value?.vocalModeParams;
  if (!isRecord(vocalModeParams) || typeof vocalModeParams.$sv === "string") return [];
  return Object.keys(vocalModeParams);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
