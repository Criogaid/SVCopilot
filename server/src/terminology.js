export const TERMINOLOGY_SCHEMA_VERSION = "1.0.0";

export const HOST_SEMANTIC_STATUSES = Object.freeze([
  "confirmed",
  "contradicted",
  "partially_observed",
  "unknown",
  "not_observable",
]);

const TERMS = deepFreeze({
  constant: {
    title: "Constant tempo",
    description: "No BPM change occurs inside the measured range.",
  },
  tempo_step: {
    title: "Single tempo change",
    description: "Exactly one BPM change occurs inside the measured range.",
  },
  dense_tempo: {
    title: "Multiple tempo changes",
    description: "At least two BPM changes occur inside the measured range.",
  },
  confirmed: {
    title: "Confirmed",
    description: "The available evidence supports this host behavior.",
  },
  contradicted: {
    title: "Contradicted",
    description: "The available evidence disproves the expected host behavior.",
  },
  partially_observed: {
    title: "Partially observed",
    description: "Some required cases were observed, but coverage is incomplete.",
  },
  unknown: {
    title: "Unknown",
    description: "No sufficient evidence is available for this host behavior.",
  },
  not_observable: {
    title: "Not observable",
    description: "The current probe cannot observe this host behavior reliably.",
  },
  PITCH_CONTROL_CURVE_HOST_SEMANTICS_INCOMPLETE: {
    title: "PitchControlCurve semantics incomplete",
    description:
      "PitchControlCurve writing is disabled because ordering behavior is unknown and pitch-surface interaction is only partially observed.",
  },
  BOUNDED_CLOSED_LOOP_SAFETY_GATES_DISABLED: {
    title: "Closed-loop safety gates disabled",
    description:
      "Automatic bounded correction is disabled because its release safety gates have not been enabled.",
  },
});

export function terminologyEntry(code) {
  const term = TERMS[code];
  if (!term) throw new Error(`unknown terminology code: ${code}`);
  return { code, ...term };
}

export function terminologyDictionary(codes = Object.keys(TERMS)) {
  const dictionary = {};
  for (const code of codes) {
    const term = TERMS[code];
    if (!term) throw new Error(`unknown terminology code: ${code}`);
    dictionary[code] = term;
  }
  return dictionary;
}

export function terminologyCatalog() {
  return {
    schemaVersion: TERMINOLOGY_SCHEMA_VERSION,
    terms: terminologyDictionary(),
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
