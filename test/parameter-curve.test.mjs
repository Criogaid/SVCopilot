import assert from "node:assert/strict";
import test from "node:test";

import { ParameterCurveService } from "../server/src/parameter-curve.js";

const Q = 705600;

// Automation 模型：有序控制点数组 + 线性插值 + 朴素 simplify（移除线性可省略点）。
function createCurveModel() {
  let nextHandle = 300;
  const handle = (type) => ({ __handle__: nextHandle++, __type__: type, __epoch__: 1 });
  const h = {
    project: handle("Project"),
    sv: handle("SV"),
    track: handle("Track"),
    ref: handle("NoteGroupReference"),
    instrumentalRef: handle("NoteGroupReference"),
    group: handle("NoteGroup"),
    automation: handle("Automation"),
  };
  const model = {
    handles: h,
    points: [
      [0, 0],
      [Q, 0.5],
      [2 * Q, 1],
    ],
    undoCount: 0,
    failures: [],
    groupOnset: 4 * Q,
    definition: {
      displayName: "Loudness",
      typeName: "loudness",
      range: [-24, 24],
      defaultValue: 0,
    },
  };
  const sortPoints = () => model.points.sort((a, b) => a[0] - b[0]);
  const inRange = (from, to) => model.points.filter(([b]) => b >= from && b <= to);
  const interpolate = (b) => {
    sortPoints();
    if (model.points.length === 0) return model.definition.defaultValue;
    if (b <= model.points[0][0]) return model.points[0][1];
    const last = model.points[model.points.length - 1];
    if (b >= last[0]) return last[1];
    for (let index = 1; index < model.points.length; index += 1) {
      const [b1, v1] = model.points[index - 1];
      const [b2, v2] = model.points[index];
      if (b >= b1 && b <= b2) return v1 + ((v2 - v1) * (b - b1)) / (b2 - b1);
    }
    return model.definition.defaultValue;
  };
  model.host = {
    epoch: () => 1,
    roots: async () => ({ project: h.project, sv: h.sv }),
    free: async () => {},
    index: async () => null,
    call: async ({ handle: target, method, args = [] }) => {
      const failure = model.failures.find(
        (item) => item.method === method && item.remainingSkips-- <= 0
      );
      if (failure) {
        model.failures.splice(model.failures.indexOf(failure), 1);
        const error = new Error(failure.message ?? `injected failure for ${method}`);
        if (failure.code) error.code = failure.code;
        throw error;
      }
      const id = target?.__handle__;
      if (id === h.project.__handle__) {
        if (method === "getNumTracks") return 1;
        if (method === "getTrack") return h.track;
        if (method === "newUndoRecord") return ++model.undoCount;
      }
      if (id === h.track.__handle__) {
        if (method === "getNumGroups") return 2;
        if (method === "getGroupReference") return args[0] === 1 ? h.ref : h.instrumentalRef;
      }
      if (id === h.instrumentalRef.__handle__ && method === "isInstrumental") return true;
      if (id === h.ref.__handle__) {
        if (method === "isInstrumental") return false;
        if (method === "getTarget") return h.group;
        if (method === "getOnset") return model.groupOnset;
      }
      if (id === h.group.__handle__) {
        if (method === "getParameter") {
          return String(args[0]).toLowerCase() === "loudness" ? h.automation : null;
        }
        if (method === "getUUID") return "curve-group";
      }
      if (id === h.automation.__handle__) {
        if (method === "getDefinition") return { ...model.definition, range: [...model.definition.range] };
        if (method === "getType") return model.definition.typeName;
        if (method === "getInterpolationMethod") return "Linear";
        if (method === "getAllPoints") return sortPoints().map((point) => [...point]);
        if (method === "getPoints") return inRange(args[0], args[1]).map((point) => [...point]);
        if (method === "get") return interpolate(args[0]);
        if (method === "add") {
          const existing = model.points.find(([b]) => b === args[0]);
          if (existing) existing[1] = args[1];
          else model.points.push([args[0], args[1]]);
          sortPoints();
          return true;
        }
        if (method === "remove") {
          const before = model.points.length;
          model.points = model.points.filter(([b]) => b < args[0] || b > args[1]);
          return model.points.length !== before;
        }
        if (method === "simplify") {
          const [from, to, threshold = 0] = args;
          // 朴素实现：移除范围内可被相邻两点线性插值近似的点。
          let changed = false;
          for (let index = model.points.length - 2; index >= 1; index -= 1) {
            const [b, v] = model.points[index];
            if (b < from || b > to) continue;
            const [b1, v1] = model.points[index - 1];
            const [b2, v2] = model.points[index + 1];
            const linear = v1 + ((v2 - v1) * (b - b1)) / (b2 - b1);
            if (Math.abs(linear - v) <= threshold) {
              model.points.splice(index, 1);
              changed = true;
            }
          }
          return changed;
        }
      }
      throw new Error(`unsupported curve call ${id}.${method}`);
    },
  };
  return model;
}

function createService(model) {
  return new ParameterCurveService(
    { withExclusive: (task) => task(model.host) },
    { now: () => 1000 }
  );
}

const TARGET = { trackIndex: 0, groupIndex: 0 };

test("sv_get_parameter_curve reports definition, dual coordinates, and stats", async () => {
  const model = createCurveModel();
  const service = createService(model);
  const result = await service.getCurve({ target: TARGET, parameter: "loudness" });

  assert.equal(result.ok, true);
  assert.deepEqual(result.data.definition.range, [-24, 24]);
  assert.equal(result.data.interpolationMethod, "Linear");
  assert.deepEqual(result.data.points[1], {
    localBlick: Q,
    absoluteBlick: 4 * Q + Q,
    value: 0.5,
  });
  assert.deepEqual(result.data.stats, { count: 3, min: 0, max: 1, mean: 0.5 });
  assert.equal(result.data.group.uuid, "curve-group");
});

test("sv_get_parameter_curve supports absolute-coordinate ranges", async () => {
  const model = createCurveModel();
  const service = createService(model);
  const result = await service.getCurve({
    target: TARGET,
    parameter: "loudness",
    range: { fromBlick: 4 * Q + Q, toBlick: 4 * Q + 3 * Q, coordinate: "absolute" },
  });
  assert.deepEqual(
    result.data.points.map((point) => point.localBlick),
    [Q, 2 * Q]
  );
  assert.equal(result.data.range.localFromBlick, Q);
});

test("sv_patch_parameter_curve replace: dryRun has no side effects, real write verifies exactly", async () => {
  const model = createCurveModel();
  const service = createService(model);
  const request = {
    target: TARGET,
    parameter: "loudness",
    mode: "replace",
    range: { fromBlick: 0, toBlick: 2 * Q },
    points: [
      { blick: 0, value: 1 },
      { blick: Q, value: 2 },
    ],
  };

  const plan = await service.patchCurve({ ...request, dryRun: true });
  assert.equal(plan.status, "dry_run");
  assert.equal(plan.data.before.pointCount, 3);
  assert.equal(plan.data.planned.pointCount, 2);
  assert.equal(model.undoCount, 0);
  assert.equal(model.points.length, 3);

  const result = await service.patchCurve(request);
  assert.equal(result.ok, true);
  assert.equal(result.status, "succeeded");
  assert.equal(result.effects, "verified");
  assert.equal(result.verification.mode, "exact");
  assert.equal(result.verification.passed, true);
  assert.deepEqual(model.points, [
    [0, 1],
    [Q, 2],
  ]);
  assert.equal(model.undoCount, 2);
  assert.equal(result.data.after.pointCount, 2);
  assert.equal(result.data.after.stats.max, 2);
});

test("sv_patch_parameter_curve add mode shifts existing control points and clamps to range", async () => {
  const model = createCurveModel();
  model.points = [
    [0, 23],
    [Q, 0],
  ];
  const service = createService(model);
  const result = await service.patchCurve({
    target: TARGET,
    parameter: "loudness",
    mode: "add",
    amount: 5,
    range: { fromBlick: 0, toBlick: 2 * Q },
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.clampedCount, 1);
  assert.ok(result.warnings.some((warning) => warning.code === "CLAMPED_TO_RANGE"));
  assert.deepEqual(model.points, [
    [0, 24],
    [Q, 5],
  ]);
});

test("sv_patch_parameter_curve scale mode multiplies control points", async () => {
  const model = createCurveModel();
  const service = createService(model);
  const result = await service.patchCurve({
    target: TARGET,
    parameter: "loudness",
    mode: "scale",
    amount: 2,
    range: { fromBlick: Q, toBlick: 2 * Q },
  });
  assert.equal(result.ok, true);
  // 范围外的 [0,0] 不受影响。
  assert.deepEqual(model.points, [
    [0, 0],
    [Q, 1],
    [2 * Q, 2],
  ]);
});

test("sv_patch_parameter_curve rejects explicit out-of-range values before writing", async () => {
  const model = createCurveModel();
  const service = createService(model);
  const result = await service.patchCurve({
    target: TARGET,
    parameter: "loudness",
    mode: "replace",
    range: { fromBlick: 0, toBlick: Q },
    points: [{ blick: 0, value: 99 }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "VALUE_OUT_OF_RANGE");
  assert.equal(result.effects, "none");
  assert.equal(model.undoCount, 0);
  assert.equal(model.points.length, 3);
});

test("sv_patch_parameter_curve atomic mode restores journaled points on mid-apply failure", async () => {
  const model = createCurveModel();
  model.failures.push({ method: "add", remainingSkips: 1, code: "ARGUMENT_MISMATCH" });
  const service = createService(model);
  const result = await service.patchCurve({
    target: TARGET,
    parameter: "loudness",
    mode: "replace",
    range: { fromBlick: 0, toBlick: 2 * Q },
    points: [
      { blick: 0, value: 1 },
      { blick: Q, value: 2 },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "rolled_back");
  assert.equal(result.rollback.verified, true);
  assert.equal(result.effects, "reverted");
  assert.deepEqual(model.points, [
    [0, 0],
    [Q, 0.5],
    [2 * Q, 1],
  ]);
});

test("sv_patch_parameter_curve simplify uses tolerance-sampled verification", async () => {
  const model = createCurveModel();
  const service = createService(model);
  const result = await service.patchCurve({
    target: TARGET,
    parameter: "loudness",
    mode: "replace",
    range: { fromBlick: 0, toBlick: 4 * Q },
    // 中间两点均在两端线性插值上，simplify 应移除它们。
    points: [
      { blick: 0, value: 0 },
      { blick: Q, value: 1 },
      { blick: 2 * Q, value: 2 },
      { blick: 3 * Q, value: 3 },
    ],
    simplifyThreshold: 0.01,
  });

  assert.equal(result.ok, true);
  assert.equal(result.verification.mode, "tolerance_sampled");
  assert.equal(result.verification.passed, true);
  assert.equal(result.data.after.pointCount, 2);
  assert.ok(result.verification.evidence.maxDeviation <= 0.01);
});

test("sv_patch_parameter_curve validates target and parameter", async () => {
  const model = createCurveModel();
  const service = createService(model);
  const instrumental = await service.patchCurve({
    target: { trackIndex: 0, groupIndex: 1 },
    parameter: "loudness",
    mode: "add",
    amount: 1,
    range: { fromBlick: 0, toBlick: Q },
  });
  assert.equal(instrumental.error.code, "INVALID_TARGET");

  const unknown = await service.patchCurve({
    target: TARGET,
    parameter: "nonexistent",
    mode: "add",
    amount: 1,
    range: { fromBlick: 0, toBlick: Q },
  });
  assert.equal(unknown.error.code, "UNKNOWN_PARAMETER");

  await assert.rejects(
    service.patchCurve({
      target: TARGET,
      parameter: "loudness",
      mode: "replace",
      range: { fromBlick: 0, toBlick: Q },
    }),
    (error) => error.code === "INVALID_ARGUMENTS"
  );
});
