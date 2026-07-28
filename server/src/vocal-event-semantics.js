const OFFICIAL_SPECIAL_EVIDENCE = Object.freeze({
  syllable_continuation: "official_documented_special_lyric_plus",
  phonation_continuation: "official_documented_special_lyric_minus",
  breath_event: "official_documented_special_lyric_br",
  glottal_onset: "official_documented_apostrophe_prefix_cl",
});

const SUSPICIOUS_VARIANTS = new Set(["＋", "－", "’", "‘"]);

export function classifyVocalEvent(input = {}) {
  const rawLyrics = typeof input.lyrics === "string" ? input.lyrics : "";
  const phonemeFeatures = classifyPhonemeFeatures(input.phonemes);
  const warnings = [];

  let role = "lexical_head";
  let confidence = "official";
  let melodicEligibleByDefault = true;
  let consumesLyricUnit = true;
  let closesLexicalChain = false;
  let evidenceCode = "official_documented_lexical_lyric";

  if (rawLyrics === "+") {
    role = "syllable_continuation";
    consumesLyricUnit = false;
    evidenceCode = OFFICIAL_SPECIAL_EVIDENCE[role];
  } else if (rawLyrics === "-") {
    role = "phonation_continuation";
    consumesLyricUnit = false;
    evidenceCode = OFFICIAL_SPECIAL_EVIDENCE[role];
  } else if (rawLyrics === "br") {
    role = "breath_event";
    melodicEligibleByDefault = false;
    consumesLyricUnit = false;
    closesLexicalChain = true;
    evidenceCode = OFFICIAL_SPECIAL_EVIDENCE[role];
  } else if (rawLyrics.length > 1 && rawLyrics.startsWith("'")) {
    role = "glottal_onset";
    evidenceCode = OFFICIAL_SPECIAL_EVIDENCE[role];
  } else if (rawLyrics === "'") {
    role = "unknown_special";
    confidence = "heuristic";
    melodicEligibleByDefault = false;
    consumesLyricUnit = false;
    closesLexicalChain = true;
    evidenceCode = "standalone_apostrophe_pending_host_calibration";
    warnings.push({
      code: "STANDALONE_APOSTROPHE_UNCALIBRATED",
      message:
        "A standalone apostrophe is not covered by the current V2 contract; preserve it and require human review.",
    });
  } else if (isSuspiciousVariant(rawLyrics)) {
    confidence = "heuristic";
    evidenceCode = "similar_to_official_special_lyric_but_not_exact";
    warnings.push({
      code: "SUSPICIOUS_SPECIAL_LYRIC_VARIANT",
      message:
        "The lyric resembles a documented special lyric but is not its exact ASCII spelling; it was preserved as lexical text.",
    });
  }

  return {
    rawLyrics,
    role,
    confidence,
    melodicEligibleByDefault,
    consumesLyricUnit,
    closesLexicalChain,
    phonemeFeatures,
    evidenceCode,
    warnings,
  };
}

export function analyzeVocalEventSequence(notes = []) {
  const ordered = notes
    .map((note, originalIndex) => ({
      note,
      originalIndex,
      onsetBlick: noteOnset(note, originalIndex),
      durationBlick: noteDuration(note),
    }))
    .sort(
      (left, right) =>
        left.onsetBlick - right.onsetBlick || left.originalIndex - right.originalIndex
    );

  const events = [];
  const issues = [];
  let activeLexicalHead = null;
  let activePronunciation = false;
  let activeSyllableOrdinal = 0;
  let previousChainEvent = null;

  for (const item of ordered) {
    const classification = classifyVocalEvent({
      lyrics: item.note.lyrics,
      phonemes: item.note.phonemes,
    });
    const event = {
      note: item.note,
      noteId: item.note.noteId,
      onsetBlick: item.onsetBlick,
      endBlick: item.onsetBlick + item.durationBlick,
      semanticRole: classification.role,
      semanticEvidence: classification.evidenceCode,
      classification,
      melodicEligible: classification.melodicEligibleByDefault,
      continuationValid: null,
      chainHeadNoteId: activeLexicalHead?.noteId ?? null,
      syllableOrdinal: null,
    };

    for (const warning of classification.warnings) {
      issues.push({
        ...warning,
        severity: "warning",
        noteIds: event.noteId ? [event.noteId] : [],
        semanticRole: classification.role,
        lyrics: classification.rawLyrics,
        startBlick: event.onsetBlick,
      });
    }

    if (classification.role === "lexical_head" || classification.role === "glottal_onset") {
      activeLexicalHead = event;
      activePronunciation = true;
      activeSyllableOrdinal = 1;
      previousChainEvent = event;
      event.chainHeadNoteId = event.noteId ?? null;
      event.syllableOrdinal = 1;
    } else if (classification.role === "syllable_continuation") {
      if (!activeLexicalHead) {
        event.melodicEligible = false;
        event.continuationValid = false;
        issues.push(
          sequenceIssue(
            "ORPHAN_PLUS",
            "error",
            event,
            '"+" requires a preceding lexical head in the same NoteGroup.'
          )
        );
      } else {
        event.continuationValid = true;
        event.chainHeadNoteId = activeLexicalHead.noteId ?? null;
        activeSyllableOrdinal += 1;
        event.syllableOrdinal = activeSyllableOrdinal;
        appendChainSpacingIssue(issues, previousChainEvent, event);
        activePronunciation = true;
        previousChainEvent = event;
      }
    } else if (classification.role === "phonation_continuation") {
      if (!activePronunciation) {
        event.melodicEligible = false;
        event.continuationValid = false;
        issues.push(
          sequenceIssue(
            "ORPHAN_PHONATION_CONTINUATION",
            "error",
            event,
            '"-" requires a preceding active pronunciation in the same NoteGroup.'
          )
        );
      } else {
        event.continuationValid = true;
        event.chainHeadNoteId = activeLexicalHead?.noteId ?? null;
        event.syllableOrdinal = activeSyllableOrdinal;
        previousChainEvent = event;
      }
    } else if (classification.closesLexicalChain) {
      activeLexicalHead = null;
      activePronunciation = false;
      activeSyllableOrdinal = 0;
      previousChainEvent = null;
    }

    events.push(event);
  }

  return { events, issues };
}

export function summarizeExcludedVocalEvents(events = []) {
  const excluded = events.filter((event) => !event.melodicEligible);
  const byRole = Object.create(null);
  for (const event of excluded) {
    byRole[event.semanticRole] = (byRole[event.semanticRole] ?? 0) + 1;
  }
  return {
    count: excluded.length,
    byRole,
    items: excluded.map((event) => ({
      ...(event.noteId ? { noteId: event.noteId } : {}),
      lyrics: event.classification.rawLyrics,
      semanticRole: event.semanticRole,
      evidence: event.semanticEvidence,
    })),
  };
}

export function isBreathEventLyrics(lyrics) {
  return classifyVocalEvent({ lyrics }).role === "breath_event";
}

function appendChainSpacingIssue(issues, previous, current) {
  if (!previous) return;
  const gapBlick = current.onsetBlick - previous.endBlick;
  if (gapBlick > 0) {
    issues.push({
      ...sequenceIssue(
        "SYLLABLE_CHAIN_GAP",
        "warning",
        current,
        'A "+" syllable continuation is separated from the preceding chain event.'
      ),
      gapBlick,
      noteIds: [previous.noteId, current.noteId].filter(Boolean),
    });
  } else if (gapBlick < 0) {
    issues.push({
      ...sequenceIssue(
        "SYLLABLE_CHAIN_OVERLAP",
        "warning",
        current,
        'A "+" syllable continuation overlaps the preceding chain event.'
      ),
      overlapBlick: -gapBlick,
      noteIds: [previous.noteId, current.noteId].filter(Boolean),
    });
  }
}

function sequenceIssue(code, severity, event, message) {
  return {
    code,
    severity,
    noteIds: event.noteId ? [event.noteId] : [],
    semanticRole: event.semanticRole,
    lyrics: event.classification.rawLyrics,
    startBlick: event.onsetBlick,
    message,
  };
}

function classifyPhonemeFeatures(phonemes) {
  const tokens = Array.isArray(phonemes)
    ? phonemes.flatMap((item) => (typeof item === "string" ? item.split(/\s+/) : []))
    : typeof phonemes === "string"
      ? phonemes.split(/\s+/)
      : [];
  return tokens.includes("cl") ? ["glottal_phoneme"] : [];
}

function isSuspiciousVariant(rawLyrics) {
  if (SUSPICIOUS_VARIANTS.has(rawLyrics)) return true;
  return rawLyrics !== "br" && rawLyrics.trim().toLowerCase() === "br";
}

function noteOnset(note, fallback) {
  for (const value of [note.absOnsetBlick, note.localOnsetBlick, note.onsetBlick]) {
    if (Number.isSafeInteger(value)) return value;
  }
  return fallback;
}

function noteDuration(note) {
  if (Number.isSafeInteger(note.durationBlick) && note.durationBlick >= 0) {
    return note.durationBlick;
  }
  if (Number.isSafeInteger(note.absEndBlick) && Number.isSafeInteger(note.absOnsetBlick)) {
    return Math.max(0, note.absEndBlick - note.absOnsetBlick);
  }
  if (Number.isSafeInteger(note.localEndBlick) && Number.isSafeInteger(note.localOnsetBlick)) {
    return Math.max(0, note.localEndBlick - note.localOnsetBlick);
  }
  return 0;
}
