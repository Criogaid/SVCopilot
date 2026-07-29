import assert from "node:assert";
import { ArtifactStore } from "../server/src/artifact-store.js";
import {
  buildPlanArtifact,
  buildPlanContextSnapshot,
  resolvePlanReference,
} from "../server/src/plan-reference.js";
import { SnapshotStore } from "../server/src/snapshot.js";

const sessionId = "sess_plan";

// 成功解析 plan artifact。
{
  const store = new ArtifactStore();
  const planPayload = buildPlanArtifact({
    targetTool: "sv_patch_notes",
    mutationRequest: { patches: [{ noteId: "n1", lyrics: "hello" }] },
    targetGroupUuid: "grp_1",
    occurrenceId: "occ_1",
    expectedTimeOffsetBlick: 100,
  });
  const artifact = store.seal({
    kind: "plan",
    schemaVersion: "1",
    sessionId,
    payload: planPayload.payload,
  });

  const resolved = resolvePlanReference({
    planRef: { artifactId: artifact.id, contentHash: artifact.contentHash },
    action: "commit",
    confirmations: { allowSharedTargetMutation: true },
    executionOptions: { atomic: true, waitFor: "none" },
    expectedTargetTool: "sv_patch_notes",
    sessionId,
    artifactStore: store,
  });

  assert.strictEqual(resolved.targetTool, "sv_patch_notes");
  assert.deepStrictEqual(resolved.mutationRequest, {
    patches: [{ noteId: "n1", lyrics: "hello" }],
    allowSharedTargetMutation: true,
    atomic: true,
    waitFor: "none",
    dryRun: false,
  });
}

// plan artifact 的租期长于可编辑 context；执行时应恢复被 TTL 淘汰的单 occurrence 上下文。
{
  let now = 1000;
  const snapshotStore = new SnapshotStore({ ttlMs: 100, now: () => now });
  const stored = snapshotStore.create({
    epoch: 7,
    scope: { kind: "range" },
    observedAt: new Date(now).toISOString(),
    context: { kind: "range", occurrences: [] },
  });
  const occurrence = {
    occurrenceId: `${stored.contextId}:t:0:r:0`,
    trackIndex: 0,
    groupIndex: 0,
    targetGroupUuid: "grp_restore",
    timeOffsetBlick: 0,
    sharedTargetOccurrences: [],
    noteFingerprints: [],
  };
  stored.context.occurrences.push(occurrence);

  const artifactStore = new ArtifactStore({ now: () => now });
  const { payload } = buildPlanArtifact({
    targetTool: "sv_patch_notes",
    mutationRequest: { contextId: stored.contextId, patches: [] },
    contextSnapshot: buildPlanContextSnapshot(stored, occurrence),
  });
  const artifact = artifactStore.seal({
    kind: "plan",
    schemaVersion: "1",
    sessionId,
    payload,
  });

  now += 101;
  assert.strictEqual(snapshotStore.get(stored.contextId), null);
  resolvePlanReference({
    planRef: { artifactId: artifact.id, contentHash: artifact.contentHash },
    action: "dry_run",
    expectedTargetTool: "sv_patch_notes",
    sessionId,
    artifactStore,
    snapshotStore,
  });
  const restored = snapshotStore.get(stored.contextId);
  assert.strictEqual(restored.epoch, 7);
  assert.strictEqual(restored.context.occurrences[0].occurrenceId, occurrence.occurrenceId);
}

// 目标工具不匹配报错。
{
  const store = new ArtifactStore();
  const { payload } = buildPlanArtifact({
    targetTool: "sv_patch_notes",
    mutationRequest: { patches: [] },
  });
  const artifact = store.seal({ kind: "plan", schemaVersion: "1", sessionId, payload });
  assert.throws(
    () =>
      resolvePlanReference({
        planRef: { artifactId: artifact.id, contentHash: artifact.contentHash },
        action: "dry_run",
        expectedTargetTool: "sv_patch_parameter_curves",
        sessionId,
        artifactStore: store,
      }),
    /PLAN_TARGET_MISMATCH/
  );
}

// contentHash 不匹配报错。
{
  const store = new ArtifactStore();
  const { payload } = buildPlanArtifact({
    targetTool: "sv_patch_notes",
    mutationRequest: { patches: [] },
  });
  const artifact = store.seal({ kind: "plan", schemaVersion: "1", sessionId, payload });
  assert.throws(
    () =>
      resolvePlanReference({
        planRef: { artifactId: artifact.id, contentHash: "sha256_wrong" },
        action: "dry_run",
        expectedTargetTool: "sv_patch_notes",
        sessionId,
        artifactStore: store,
      }),
    /ARTIFACT_HASH_MISMATCH/
  );
}

// action 必须显式；目标工具不支持的执行选项不得泄漏进 mutation 请求。
{
  const store = new ArtifactStore();
  const { payload } = buildPlanArtifact({
    targetTool: "sv_patch_parameter_curves",
    mutationRequest: { target: { contextId: "ctx_1" }, curves: [] },
  });
  const artifact = store.seal({ kind: "plan", schemaVersion: "1", sessionId, payload });
  const planRef = { artifactId: artifact.id, contentHash: artifact.contentHash };
  assert.throws(
    () =>
      resolvePlanReference({
        planRef,
        expectedTargetTool: "sv_patch_parameter_curves",
        sessionId,
        artifactStore: store,
      }),
    /action must be dry_run or commit/
  );
  assert.throws(
    () =>
      resolvePlanReference({
        planRef,
        action: "dry_run",
        executionOptions: { waitFor: "phonemes" },
        expectedTargetTool: "sv_patch_parameter_curves",
        sessionId,
        artifactStore: store,
      }),
    /executionOptions not supported/
  );
}

// 同一规划输入产生确定性 payload，不把封存时间混入 content hash。
{
  const options = {
    targetTool: "sv_patch_notes",
    mutationRequest: { contextId: "ctx_1", patches: [{ noteId: "n1", set: { lyrics: "x" } }] },
  };
  assert.deepStrictEqual(buildPlanArtifact(options), buildPlanArtifact(options));
  assert.strictEqual(Object.hasOwn(buildPlanArtifact(options).payload, "sealedAt"), false);
}

console.log("plan-reference.test.mjs passed");
