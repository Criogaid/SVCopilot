import { isDeepStrictEqual } from "node:util";

import { contextGroupNoteCount, resolveContextTarget } from "./context-target.js";
import { waitForProcessing } from "./processing.js";

export class LyricsService {
  constructor(session, snapshotService, { sleepFn, now = () => Date.now() } = {}) {
    this.session = session;
    this.snapshotService = snapshotService;
    this.sleep = sleepFn;
    this.now = now;
  }

  async setLyrics(request) {
    const input = normalizeRequest(request);
    let contextId = input.contextId;
    if (!contextId) {
      const snapshot = await this.snapshotService.snapshot({
        scope: { kind: "selection" },
        include: ["notes", "processing"],
        pageSize: 200,
      });
      contextId = snapshot.contextId;
      if (snapshot.status === "no_change") {
        return failed("NO_SELECTED_NOTES", "No notes are selected.", "none");
      }
    }

    return this.session.withExclusive(async (host) => {
      let resolved;
      let boundaryCalls = 0;
      const mutatedNoteIndices = new Set();
      let processedNotes = 0;
      let plannedChangedNotes = 0;
      let writeAttempted = false;
      const warnings = [];
      const startedAt = this.now();
      try {
        const stored = this.snapshotService.getContext(contextId, host.epoch());
        resolved = await resolveContextTarget(host, stored, { verify: true });
        if (resolved.notes.length !== input.lyrics.length) {
          return failed(
            "LYRIC_COUNT_MISMATCH",
            `Selected ${resolved.notes.length} note(s), but received ${input.lyrics.length} lyric item(s).`,
            "none"
          );
        }
        if (resolved.notes.length === 0) {
          return failed("NO_SELECTED_NOTES", "The snapshot context contains no notes.", "none");
        }
        if (input.phonemes && input.phonemes.length !== resolved.notes.length) {
          return failed(
            "PHONEME_COUNT_MISMATCH",
            `Selected ${resolved.notes.length} note(s), but received ${input.phonemes.length} phoneme item(s).`,
            "none"
          );
        }

        processedNotes = resolved.notes.length;
        const changes = resolved.fingerprints.map((current, index) => ({
          lyrics: current.lyrics !== input.lyrics[index],
          phonemes:
            input.phonemes?.[index] !== null &&
            input.phonemes?.[index] !== undefined &&
            current.phonemesOverride !== input.phonemes[index],
          language:
            input.languageOverride !== undefined &&
            current.languageOverride !== input.languageOverride,
        }));
        plannedChangedNotes = changes.filter(
          (change) => change.lyrics || change.phonemes || change.language
        ).length;
        if (plannedChangedNotes === 0) {
          this.snapshotService.store.delete(contextId);
          return {
            ok: true,
            status: "no_change",
            effects: "none",
            data: {
              processedNotes,
              actuallyChangedNotes: 0,
              changedNotes: 0,
              lyrics: resolved.fingerprints.map((item) => item.lyrics),
              ...(input.phonemes
                ? { phonemes: resolved.fingerprints.map((item) => item.phonemesOverride) }
                : {}),
              ...(input.languageOverride !== undefined
                ? {
                    languageOverride: input.languageOverride,
                    languages: resolved.fingerprints.map((item) => item.languageOverride),
                  }
                : {}),
            },
            undo: undoEvidence(0),
            verification: {
              attempted: true,
              passed: true,
              evidence: verificationEvidence(
                resolved.fingerprints.map((item) => item.lyrics),
                input.phonemes
                  ? resolved.fingerprints.map((item) => item.phonemesOverride)
                  : null,
                input.languageOverride !== undefined
                  ? resolved.fingerprints.map((item) => item.languageOverride)
                  : null
              ),
            },
            warnings,
            timing: { elapsedMs: this.now() - startedAt },
          };
        }

        await host.call({
          handle: resolved.roots.project,
          method: "newUndoRecord",
          args: [],
        });
        boundaryCalls += 1;

        try {
          for (let index = 0; index < resolved.notes.length; index += 1) {
            const note = resolved.notes[index];
            if (changes[index].lyrics) {
              writeAttempted = true;
              await host.call({ handle: note, method: "setLyrics", args: [input.lyrics[index]] });
              mutatedNoteIndices.add(index);
            }
            if (changes[index].phonemes) {
              writeAttempted = true;
              await host.call({
                handle: note,
                method: "setPhonemes",
                args: [input.phonemes[index]],
              });
              mutatedNoteIndices.add(index);
            }
            if (changes[index].language) {
              writeAttempted = true;
              await host.call({
                handle: note,
                method: "setLanguageOverride",
                args: [input.languageOverride],
              });
              mutatedNoteIndices.add(index);
            }
          }
        } finally {
          try {
            await host.call({
              handle: resolved.roots.project,
              method: "newUndoRecord",
              args: [],
            });
            boundaryCalls += 1;
          } catch (error) {
            warnings.push({
              code: "UNDO_BOUNDARY_CLOSE_FAILED",
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }

        const observedLyrics = [];
        const observedPhonemes = [];
        const observedLanguages = [];
        for (const note of resolved.notes) {
          observedLyrics.push(await host.call({ handle: note, method: "getLyrics", args: [] }));
          if (input.phonemes) {
            observedPhonemes.push(
              await host.call({ handle: note, method: "getPhonemes", args: [] })
            );
          }
          if (input.languageOverride !== undefined) {
            observedLanguages.push(
              await host.call({ handle: note, method: "getLanguageOverride", args: [] })
            );
          }
        }

        const lyricsVerified = isDeepStrictEqual(observedLyrics, input.lyrics);
        const phonemesVerified =
          !input.phonemes ||
          input.phonemes.every(
            (expected, index) => expected === null || expected === observedPhonemes[index]
          );
        const languageVerified =
          input.languageOverride === undefined ||
          observedLanguages.every((value) => value === input.languageOverride);
        if (!lyricsVerified || !phonemesVerified || !languageVerified) {
          return {
            ok: false,
            status: "verification_failed",
            effects: "may_remain",
            error: {
              code: "POSTCONDITION_FAILED",
              message: "One or more note values did not match after write-back verification.",
              outcome: "partial",
              retryable: false,
            },
            data: {
              processedNotes,
              plannedChangedNotes,
              actuallyChangedNotes: mutatedNoteIndices.size,
              appliedNotes: mutatedNoteIndices.size,
              observedLyrics,
              observedPhonemes,
              observedLanguages,
            },
            undo: undoEvidence(boundaryCalls),
            verification: {
              attempted: true,
              passed: false,
              evidence: verificationEvidence(
                observedLyrics,
                input.phonemes ? observedPhonemes : null,
                input.languageOverride !== undefined ? observedLanguages : null
              ),
            },
            warnings,
          };
        }

        let processing = null;
        if (input.waitFor !== "none") {
          processing = await waitForProcessing(host, {
            roots: resolved.roots,
            group: resolved.group,
            kind: input.waitFor,
            expectedNotes: contextGroupNoteCount(stored, resolved.notes.length),
            requireNonEmpty: input.requireNonEmptyPhonemes,
            timeoutMs: input.timeoutMs,
            pollIntervalMs: input.pollIntervalMs,
            sleepFn: this.sleep,
            now: this.now,
          });
          warnings.push(...processing.warnings);
        }
        this.snapshotService.store.delete(contextId);

        return {
          ok: true,
          status: processing?.status ?? "succeeded",
          effects: "verified",
          data: {
            processedNotes,
            actuallyChangedNotes: plannedChangedNotes,
            changedNotes: plannedChangedNotes,
            lyrics: observedLyrics,
            ...(input.phonemes ? { phonemes: observedPhonemes } : {}),
            ...(input.languageOverride !== undefined
              ? { languageOverride: input.languageOverride }
              : {}),
            ...(processing
              ? {
                  processing: {
                    state: processing.data.state,
                    attempts: processing.data.attempts,
                    elapsedMs: processing.data.elapsedMs,
                    evidence: processing.data.evidence,
                  },
                }
              : {}),
          },
          undo: undoEvidence(boundaryCalls),
          verification: {
            attempted: true,
            passed: true,
            evidence: verificationEvidence(
              observedLyrics,
              input.phonemes ? observedPhonemes : null,
              input.languageOverride !== undefined ? observedLanguages : null
            ),
          },
          warnings,
          timing: { elapsedMs: this.now() - startedAt },
        };
      } catch (error) {
        const outcome = writeAttempted
          ? isUnknownOutcomeError(error)
            ? "unknown"
            : "partial"
          : "none";
        return {
          ...failed(
            error?.code ?? "HOST_CALL_FAILED",
            error instanceof Error ? error.message : String(error),
            outcome === "none" ? "none" : outcome === "unknown" ? "unknown" : "may_remain"
          ),
          status: outcome === "unknown" ? "outcome_unknown" : outcome === "partial" ? "partial" : "failed",
          data: {
            processedNotes,
            plannedChangedNotes,
            actuallyChangedNotes: mutatedNoteIndices.size,
            appliedNotes: mutatedNoteIndices.size,
          },
          undo: undoEvidence(boundaryCalls),
          warnings,
        };
      } finally {
        if (writeAttempted) this.snapshotService.store.delete(contextId);
        await resolved?.scope.releaseAll();
      }
    });
  }
}

function normalizeRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw codedError("INVALID_ARGUMENTS", "request must be an object");
  }
  if (!Array.isArray(request.lyrics) || !request.lyrics.every((item) => typeof item === "string")) {
    throw codedError("INVALID_ARGUMENTS", "lyrics must be an array of strings");
  }
  if (
    request.phonemes !== undefined &&
    (!Array.isArray(request.phonemes) ||
      !request.phonemes.every((item) => item === null || typeof item === "string"))
  ) {
    throw codedError("INVALID_ARGUMENTS", "phonemes must be an array of strings or null values");
  }
  if (request.languageOverride !== undefined && typeof request.languageOverride !== "string") {
    throw codedError("INVALID_ARGUMENTS", "languageOverride must be a string");
  }
  if (
    request.requireNonEmptyPhonemes !== undefined &&
    typeof request.requireNonEmptyPhonemes !== "boolean"
  ) {
    throw codedError("INVALID_ARGUMENTS", "requireNonEmptyPhonemes must be a boolean");
  }
  const waitFor = request.waitFor ?? "phonemes";
  if (!["none", "phonemes", "computedAttributes"].includes(waitFor)) {
    throw codedError("INVALID_ARGUMENTS", "waitFor must be none, phonemes, or computedAttributes");
  }
  return {
    contextId: request.contextId,
    lyrics: request.lyrics,
    phonemes: request.phonemes,
    languageOverride: request.languageOverride,
    waitFor,
    requireNonEmptyPhonemes: request.requireNonEmptyPhonemes === true,
    timeoutMs: clampInteger(request.timeoutMs, 0, 30_000, 10_000),
    pollIntervalMs: clampInteger(request.pollIntervalMs, 20, 2_000, 100),
  };
}

function verificationEvidence(observedLyrics, observedPhonemes, observedLanguages) {
  return {
    observedLyrics,
    ...(observedPhonemes ? { observedPhonemes } : {}),
    ...(observedLanguages ? { observedLanguages } : {}),
  };
}

function failed(code, message, effects) {
  return {
    ok: false,
    status: "failed",
    effects,
    error: { code, message, outcome: effects === "none" ? "unchanged" : "partial", retryable: false },
    undo: undoEvidence(0),
    verification: { attempted: false, passed: null },
    warnings: [],
  };
}

function undoEvidence(boundaryCallsCompleted) {
  return {
    boundaryCallsCompleted,
    expectedUserUndoSteps: boundaryCallsCompleted === 2 ? 1 : null,
    automaticRollback: false,
  };
}

function isUnknownOutcomeError(error) {
  return /Timeout waiting|detached|disconnected|EOF/i.test(
    error instanceof Error ? error.message : String(error)
  );
}

function clampInteger(value, minimum, maximum, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw codedError("INVALID_ARGUMENTS", `integer must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
