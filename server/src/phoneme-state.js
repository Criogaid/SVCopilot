import { getWireArrayMetadata } from "./wire-codec.js";

export function analyzePhonemeResult(
  phonemes,
  expectedNotes,
  { observedIndices, includePhonemes = true } = {}
) {
  const values = Array.isArray(phonemes) ? phonemes : [];
  const indices = normalizeObservedIndices(values, observedIndices);
  const nonEmptyNoteIndices = [];
  const emptyNoteIndices = [];

  for (const index of indices) {
    const value = values[index];
    if (typeof value !== "string") continue;
    if (value.length > 0) nonEmptyNoteIndices.push(index);
    else emptyNoteIndices.push(index);
  }

  const hasExpectedCount = Number.isSafeInteger(expectedNotes);
  const observedItems = indices.length;
  const shapeComplete = hasExpectedCount ? observedItems >= expectedNotes : observedItems > 0;
  const observedIndexSet = new Set(indices);
  const capturedPhonemes = Array.from({ length: values.length }, (_, index) =>
    observedIndexSet.has(index) && typeof values[index] === "string" ? values[index] : null
  );
  const missingNoteIndices = hasExpectedCount
    ? range(expectedNotes).filter((index) => !observedIndexSet.has(index))
    : [];
  const state = expectedNotes === 0 ? "not_applicable" : shapeComplete ? "ready" : "pending";

  return {
    state,
    expectedNotes: expectedNotes ?? null,
    computedItems: observedItems,
    nonEmptyPhonemes: nonEmptyNoteIndices.length,
    emptyPhonemes: emptyNoteIndices.length,
    emptyPhonemeNotes: emptyNoteIndices,
    missingPhonemeNotes: missingNoteIndices,
    shapeComplete,
    ...(includePhonemes ? { phonemes: capturedPhonemes } : {}),
    phonemeCoverage: {
      indexBase: 0,
      totalNotes: expectedNotes ?? null,
      observedNotes: observedItems,
      nonEmptyNotes: nonEmptyNoteIndices.length,
      emptyNotes: emptyNoteIndices.length,
      emptyNoteIndices,
      missingNoteIndices,
    },
  };
}

export function observedArrayIndices(value) {
  if (!Array.isArray(value)) return [];
  const metadata = getWireArrayMetadata(value);
  if (metadata) return [...metadata.observedIndices];
  return Object.keys(value)
    .filter((key) => /^\d+$/.test(key))
    .map(Number)
    .filter((index) => Number.isSafeInteger(index) && index >= 0 && index < value.length)
    .sort((left, right) => left - right);
}

function normalizeObservedIndices(values, override) {
  const indices = override ?? observedArrayIndices(values);
  return [...new Set(indices)].filter(
    (index) => Number.isSafeInteger(index) && index >= 0 && index < values.length
  );
}

function range(length) {
  return Array.from({ length }, (_, index) => index);
}
