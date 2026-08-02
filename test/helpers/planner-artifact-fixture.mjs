import { ArtifactStore } from "../../server/src/artifact-store.js";

const FIXTURE_ARTIFACTS = Symbol("plannerFixtureArtifacts");
let fixtureSequence = 0;

export function createPlannerService(
  Service,
  { store, method = "plan", now = () => 2000, artifactStore = null } = {}
) {
  fixtureSequence += 1;
  const ownedArtifactStore = artifactStore ?? new ArtifactStore({ now });
  const sessionId = `sess_planner_fixture_${fixtureSequence}`;
  const service = new Service({ store, now, artifactStore: ownedArtifactStore, sessionId });
  const invoke = service[method]?.bind(service);
  if (!invoke) throw new Error(`planner fixture method ${method} is not callable`);

  // 测试必须读取真正封存的 mutationRequest；不可枚举 Symbol 不会改变响应 JSON 或预算。
  service[method] = async (...args) => {
    const result = await invoke(...args);
    if (result && typeof result === "object") {
      Object.defineProperty(result, FIXTURE_ARTIFACTS, {
        value: { artifactStore: ownedArtifactStore, sessionId },
      });
    }
    return result;
  };
  return service;
}

export function sealedPlannerRequest(plan, callIndex = 0) {
  const fixture = plan?.[FIXTURE_ARTIFACTS];
  if (!fixture) throw new Error("planner result is not associated with a fixture ArtifactStore");
  const call =
    callIndex === 0
      ? plan.apply
      : plan.apply?.additionalCalls?.[callIndex - 1];
  const planRef = call?.arguments?.planRef;
  if (typeof planRef !== "string") {
    throw new Error(`apply call ${callIndex} carries no planRef: ${JSON.stringify(call?.arguments)}`);
  }
  const artifact = fixture.artifactStore.resolve({
    artifactId: planRef,
    expectedKind: "plan",
    sessionId: fixture.sessionId,
  });
  return {
    tool: artifact.payload.targetTool,
    arguments: artifact.payload.mutationRequest,
  };
}

export function allSealedPlannerRequests(plan) {
  if (!plan.apply?.arguments) return [];
  const callCount = 1 + (plan.apply.additionalCalls?.length ?? 0);
  return Array.from({ length: callCount }, (_, index) => sealedPlannerRequest(plan, index));
}
