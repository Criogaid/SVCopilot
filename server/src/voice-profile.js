import { createHostScope } from "./snapshot.js";

// 官方 API 无 singer 枚举/身份/分配接口；这里只暴露可观测的 voice 参数，
// singer 身份一律报告 unobservable / host_opaque，不伪造。
export class VoiceProfileService {
  constructor(session, { now = () => Date.now() } = {}) {
    this.session = session;
    this.now = now;
  }

  async getProfile(request) {
    const input = normalizeProfileRequest(request);
    return this.session.withExclusive(async (host) => {
      const capture = createHostScope(host);
      try {
        const roots = await capture.roots();
        const track = await resolveTrack(capture, roots, input.trackIndex);
        const groupCount = await capture.call(track.handle, "getNumGroups");
        const groupIndices =
          input.groupIndex !== undefined ? [input.groupIndex] : [...Array(groupCount).keys()];
        if (input.groupIndex !== undefined && input.groupIndex >= groupCount) {
          throw codedError(
            "GROUP_INDEX_OUT_OF_RANGE",
            `groupIndex ${input.groupIndex} is outside 0-${Math.max(0, groupCount - 1)} (native index ${input.groupIndex + 1})`
          );
        }
        const groups = [];
        for (const groupIndex of groupIndices) {
          const reference = await capture.call(track.handle, "getGroupReference", [groupIndex + 1], {
            inferredType: "NoteGroupReference",
          });
          const instrumental = await capture.call(reference, "isInstrumental");
          if (instrumental) {
            groups.push({ index: groupIndex, instrumental: true, voice: null });
            continue;
          }
          const voice = await capture.call(reference, "getVoice", [], {
            resultFormat: "typed-v2",
          });
          const vocalModeNames = isRecord(voice?.vocalModeParams)
            ? Object.keys(voice.vocalModeParams)
            : [];
          groups.push({
            index: groupIndex,
            instrumental: false,
            isMain: await capture.call(reference, "isMain"),
            voice: {
              identityStatus: "unobservable",
              parameters: voice,
              vocalModeNames,
            },
          });
        }
        return {
          ok: true,
          status: "succeeded",
          observedAt: new Date(this.now()).toISOString(),
          data: {
            trackIndex: input.trackIndex,
            trackName: track.name,
            groupCount,
            groups,
            capabilities: {
              singerIdentity: "unobservable",
              installedCatalog: "unobservable",
              assignment: "unobservable",
            },
          },
          warnings: [],
        };
      } finally {
        await capture.releaseAll();
      }
    });
  }

  async cloneTrackFromTemplate(request) {
    const input = normalizeCloneRequest(request);
    return this.session.withExclusive(async (host) => {
      const capture = createHostScope(host);
      let boundaryCalls = 0;
      let writeAttempted = false;
      let addedHostIndex = null;
      const warnings = [];
      const startedAt = this.now();
      let rootsRef = null;
      try {
        const roots = await capture.roots();
        rootsRef = roots;
        const template = await resolveTrack(capture, roots, input.templateTrackIndex);
        const trackCountBefore = await capture.call(roots.project, "getNumTracks");

        await capture.call(roots.project, "newUndoRecord", []);
        boundaryCalls += 1;
        writeAttempted = true;
        const clone = await capture.call(template.handle, "clone", [], { inferredType: "Track" });
        const hostIndex = await capture.call(roots.project, "addTrack", [clone]);
        addedHostIndex = hostIndex;
        if (input.name !== undefined) {
          await capture.call(clone, "setName", [input.name]);
        }
        try {
          await capture.call(roots.project, "newUndoRecord", []);
          boundaryCalls += 1;
        } catch (error) {
          warnings.push({
            code: "UNDO_BOUNDARY_CLOSE_FAILED",
            message: error instanceof Error ? error.message : String(error),
          });
        }

        const trackCountAfter = await capture.call(roots.project, "getNumTracks");
        const observedName = await capture.call(clone, "getName");
        const observedGroupCount = await capture.call(clone, "getNumGroups");
        const verified =
          trackCountAfter === trackCountBefore + 1 &&
          (input.name === undefined || observedName === input.name) &&
          observedGroupCount === template.groupCount;

        return {
          ok: verified,
          status: verified ? "succeeded" : "verification_failed",
          effects: verified ? "verified" : "may_remain",
          ...(verified
            ? {}
            : {
                error: {
                  code: "POSTCONDITION_FAILED",
                  message: "The cloned track did not match the template after read-back.",
                  outcome: "partial",
                  retryable: false,
                },
              }),
          data: {
            templateTrackIndex: input.templateTrackIndex,
            newTrackIndex: hostIndex - 1,
            trackCountBefore,
            trackCountAfter,
            name: observedName,
            groupCount: observedGroupCount,
            // Track.clone 只承诺深拷贝；隐藏 singer 状态是否随 clone 保留宿主不透明。
            identityPreservation: "host_opaque",
          },
          undo: {
            boundaryCallsCompleted: boundaryCalls,
            expectedUserUndoSteps: boundaryCalls === 2 ? 1 : null,
            automaticRollback: false,
          },
          verification: {
            attempted: true,
            passed: verified,
            evidence: { trackCountBefore, trackCountAfter, observedName, observedGroupCount },
          },
          warnings,
          timing: { elapsedMs: this.now() - startedAt },
        };
      } catch (error) {
        const unknown = isUnknownOutcomeError(error);
        // 已开启但未关闭的 Undo 边界尽力关闭；addTrack 已生效时返回新轨索引供恢复。
        if (boundaryCalls === 1 && !unknown && rootsRef) {
          try {
            await capture.call(rootsRef.project, "newUndoRecord", []);
            boundaryCalls += 1;
          } catch (closeError) {
            warnings.push({
              code: "UNDO_BOUNDARY_CLOSE_FAILED",
              message: closeError instanceof Error ? closeError.message : String(closeError),
            });
          }
        }
        return {
          ok: false,
          status: writeAttempted ? (unknown ? "outcome_unknown" : "partial") : "failed",
          effects: writeAttempted ? (unknown ? "unknown" : "may_remain") : "none",
          error: {
            code: typeof error?.code === "string" ? error.code : "HOST_CALL_FAILED",
            message: error instanceof Error ? error.message : String(error),
            outcome: writeAttempted ? (unknown ? "unknown" : "partial") : "unchanged",
            retryable: false,
          },
          data: {
            templateTrackIndex: input.templateTrackIndex,
            // addTrack 已执行时提供索引，调用方可手动移除或继续配置该轨。
            newTrackIndex: addedHostIndex === null ? null : addedHostIndex - 1,
          },
          undo: {
            boundaryCallsCompleted: boundaryCalls,
            expectedUserUndoSteps: null,
            automaticRollback: false,
          },
          verification: { attempted: false, passed: null },
          warnings,
        };
      } finally {
        await capture.releaseAll();
      }
    });
  }
}

async function resolveTrack(capture, roots, trackIndex) {
  const trackCount = await capture.call(roots.project, "getNumTracks");
  if (trackIndex >= trackCount) {
    throw codedError(
      "TRACK_INDEX_OUT_OF_RANGE",
      `trackIndex ${trackIndex} is outside 0-${Math.max(0, trackCount - 1)} (native index ${trackIndex + 1})`
    );
  }
  const handle = await capture.call(roots.project, "getTrack", [trackIndex + 1], {
    inferredType: "Track",
  });
  return {
    handle,
    name: await capture.call(handle, "getName"),
    groupCount: await capture.call(handle, "getNumGroups"),
  };
}

function normalizeProfileRequest(request) {
  if (!isRecord(request)) throw codedError("INVALID_ARGUMENTS", "request must be an object");
  if (!Number.isSafeInteger(request.trackIndex) || request.trackIndex < 0) {
    throw codedError("INVALID_ARGUMENTS", "trackIndex must be a non-negative integer (0-based)");
  }
  if (
    request.groupIndex !== undefined &&
    (!Number.isSafeInteger(request.groupIndex) || request.groupIndex < 0)
  ) {
    throw codedError("INVALID_ARGUMENTS", "groupIndex must be a non-negative integer (0-based)");
  }
  return { trackIndex: request.trackIndex, groupIndex: request.groupIndex };
}

function normalizeCloneRequest(request) {
  if (!isRecord(request)) throw codedError("INVALID_ARGUMENTS", "request must be an object");
  if (!Number.isSafeInteger(request.templateTrackIndex) || request.templateTrackIndex < 0) {
    throw codedError(
      "INVALID_ARGUMENTS",
      "templateTrackIndex must be a non-negative integer (0-based)"
    );
  }
  if (request.name !== undefined && (typeof request.name !== "string" || !request.name)) {
    throw codedError("INVALID_ARGUMENTS", "name must be a non-empty string");
  }
  return { templateTrackIndex: request.templateTrackIndex, name: request.name };
}

function isUnknownOutcomeError(error) {
  if (error?.code === "HOST_TIMEOUT" || error?.code === "HOST_DETACHED") return true;
  return /Timeout waiting|detached|disconnected|EOF/i.test(
    error instanceof Error ? error.message : String(error)
  );
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
