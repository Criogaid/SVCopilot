import assert from "node:assert/strict";
import test from "node:test";

import { RangeSnapshotService } from "../server/src/musical-range.js";
import {
  OWNERSHIP,
  computeControlFingerprint,
  makeContextControlId,
  normalizeCurvePoints,
  pitchEquals,
} from "../server/src/pitch-control.js";
import { createPitchHostModel } from "./helpers/pitch-host.mjs";

const Q = 705600000;
const BAR = 4 * Q;

function createService(model, options = {}) {
  return new RangeSnapshotService(
    { withExclusive: (task) => task(model.host) },
    { now: () => 1000, ...options }
  );
}

const RANGE = { scope: { kind: "range", from: { bar: 1 }, to: { bar: 20 } } };

test("range snapshot reads Point and Curve with discriminator, units, and dual coordinates", async () => {
  const model = createPitchHostModel({
    timeOffsetBlick: BAR,
    pitchOffsetSemitone: 2,
    controls: [
      { kind: "point", position: Q, pitch: 60, scriptData: { mm_Flag: true } },
      {
        kind: "curve",
        position: 2 * Q,
        pitch: 64,
        points: [
          [-100, -0.2],
          [100, 0.3],
        ],
        scriptData: {
          [OWNERSHIP.ownerKey]: "svcopilot",
          [OWNERSHIP.controlIdKey]: "pc_owned_9",
          [OWNERSHIP.generatorKey]: "manual_pitch_gesture",
          [OWNERSHIP.schemaVersionKey]: "1",
        },
      },
    ],
  });
  const service = createService(model);
  const result = await service.snapshot({ ...RANGE, include: ["pitchControls"] });

  assert.equal(result.ok, true);
  assert.equal(result.data.units.pitch, "midi");
  const controls = result.data.pitchControls;
  assert.equal(controls.length, 2);

  const [point, curve] = controls;
  // Point：外部对象；坐标 = group-local + occurrence absolute。
  assert.equal(point.kind, "point");
  assert.equal(point.indexInGroup, 0);
  assert.equal(point.position.groupLocalBlick, Q);
  assert.equal(point.position.occurrenceAbsoluteBlick, Q + BAR);
  assert.equal(point.pitch.groupRelativeSemitone, 60);
  assert.equal(point.pitch.occurrenceAbsoluteSemitone, 62);
  assert.equal(point.ownership.owner, "external_or_unknown");
  assert.deepEqual(point.ownership.scriptDataKeys, ["mm_Flag"]);
  assert.ok(point.fingerprint.startsWith("sha256:"));
  assert.equal(point.noteId, undefined);
  // context-scoped controlId = o:<occurrence ordinal>:pc:<index>。以前这里嵌的是
  // <contextId>:t:X:r:Y，把一个已死的 contextId 焊进了对外 id 里。
  assert.equal(point.controlId, "o:0:pc:0");

  // Curve：SVCopilot 自有；anchor 双坐标，points 保持 anchor 相对坐标（绝不提前展开）。
  assert.equal(curve.kind, "curve");
  assert.equal(curve.indexInGroup, 1);
  assert.equal(curve.anchor.groupLocalBlick, 2 * Q);
  assert.equal(curve.anchor.occurrenceAbsoluteBlick, 2 * Q + BAR);
  assert.equal(curve.anchor.groupRelativeSemitone, 64);
  assert.equal(curve.anchor.occurrenceAbsoluteSemitone, 66);
  assert.deepEqual(curve.points, [
    { timeFromAnchorBlick: -100, pitchFromAnchorSemitone: -0.2 },
    { timeFromAnchorBlick: 100, pitchFromAnchorSemitone: 0.3 },
  ]);
  assert.equal(curve.ownership.owner, "svcopilot");
  assert.equal(curve.ownership.controlId, "pc_owned_9");
  assert.equal(curve.ownership.generator, "manual_pitch_gesture");
  // 自有对象暴露持久 scriptData controlId，不是 context-scoped id。
  assert.equal(curve.controlId, "pc_owned_9");

  // 全组 fingerprint 出现在 track group 摘要上（供 expectedPitchControlFingerprint）。
  assert.ok(result.data.tracks[0].groups[0].pitchControlGroupFingerprint.startsWith("sha256:"));
});

test("fingerprint identifies content, not index: identical duplicates share a fingerprint", async () => {
  const model = createPitchHostModel({
    controls: [
      { kind: "point", position: Q, pitch: 60 },
      { kind: "point", position: Q, pitch: 60 },
    ],
  });
  const service = createService(model);
  const result = await service.snapshot({ ...RANGE, include: ["pitchControls"] });
  const [first, second] = result.data.pitchControls;
  // indexInGroup 不同（提示），但内容相同 → fingerprint 相同（身份）；controlId 不同。
  assert.equal(first.indexInGroup, 0);
  assert.equal(second.indexInGroup, 1);
  assert.equal(first.fingerprint, second.fingerprint);
  assert.notEqual(first.controlId, second.controlId);
});

test("fingerprint is stable across reads and changes when content changes", async () => {
  const base = { kind: "point", positionBlick: Q, pitchSemitone: 60, points: null, ownedValues: null };
  const a = computeControlFingerprint(base, "uuid-1");
  const a2 = computeControlFingerprint(base, "uuid-1");
  assert.equal(a, a2);
  // 改 pitch、改 group、改 ownership 都应改变 fingerprint；改 indexInGroup 不应（它根本不入参）。
  assert.notEqual(a, computeControlFingerprint({ ...base, pitchSemitone: 61 }, "uuid-1"));
  assert.notEqual(a, computeControlFingerprint(base, "uuid-2"));
  assert.notEqual(
    a,
    computeControlFingerprint({ ...base, ownedValues: { owner: "svcopilot" } }, "uuid-1")
  );
});

test("zero and nonzero offsets both satisfy the local<->absolute formula", async () => {
  for (const [timeOffsetBlick, pitchOffsetSemitone] of [
    [0, 0],
    [BAR, 3],
    [2 * BAR, -4],
  ]) {
    const model = createPitchHostModel({
      timeOffsetBlick,
      pitchOffsetSemitone,
      controls: [{ kind: "point", position: Q, pitch: 60 }],
    });
    const service = createService(model);
    const result = await service.snapshot({ ...RANGE, include: ["pitchControls"] });
    const point = result.data.pitchControls[0];
    assert.equal(point.position.occurrenceAbsoluteBlick, Q + timeOffsetBlick);
    assert.equal(point.pitch.occurrenceAbsoluteSemitone, 60 + pitchOffsetSemitone);
    // round-trip：absolute - offset = local。
    assert.equal(
      point.position.occurrenceAbsoluteBlick - timeOffsetBlick,
      point.position.groupLocalBlick
    );
    assert.equal(
      point.pitch.occurrenceAbsoluteSemitone - pitchOffsetSemitone,
      point.pitch.groupRelativeSemitone
    );
  }
});

test("a group with no pitch controls yields an empty list, not an error", async () => {
  const model = createPitchHostModel({ controls: [] });
  const service = createService(model);
  const result = await service.snapshot({ ...RANGE, include: ["pitchControls"] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.pitchControls, []);
});

test("a point control is returned with its discriminator and no invented curve points", async () => {
  const model = createPitchHostModel({
    controls: [{ kind: "point", position: Q, pitch: 60 }],
  });
  const service = createService(model);
  const result = await service.snapshot({
    ...RANGE,
    include: ["pitchControls"],
  });

  assert.equal(result.ok, true);
  // Point 与 Curve 是不同的对象：point 没有 points 数组，绝不能补一个空数组冒充
  // 「有曲线但没点」。这个区分以前只在 compact 摘要里被断言，而 responseMode 删除后
  // 它属于唯一形状的逐项数据本身。
  assert.equal(result.data.pitchControls.length, 1);
  const control = result.data.pitchControls[0];
  assert.equal(control.kind, "point");
  assert.equal(control.points, undefined);
  assert.equal(control.ownership.owner, "external_or_unknown");
});

test("pitchControls paginate by item budget and cursor pages serve from cache without re-reading the host", async () => {
  const controls = Array.from({ length: 5 }, (_, index) => ({
    kind: "point",
    position: (index + 1) * Q,
    pitch: 60 + index,
  }));
  const model = createPitchHostModel({ controls });
  const service = createService(model);
  const first = await service.snapshot({
    ...RANGE,
    include: ["pitchControls"],
    budgets: { pitchControls: 2 },
  });
  assert.equal(first.data.pitchControls.length, 2);
  assert.equal(first.page.returned.pitchControls, 2);
  assert.equal(first.page.complete, false);
  assert.ok(first.page.nextCursor);

  const callsAfterCapture = model.hostCalls.length;
  const second = await service.snapshot({ cursor: first.page.nextCursor });
  // cursor 页从缓存展开，绝不重新读取宿主。
  assert.equal(model.hostCalls.length, callsAfterCapture);
  assert.equal(second.data.pitchControls.length, 2);
  const third = await service.snapshot({ cursor: second.page.nextCursor });
  assert.equal(third.data.pitchControls.length, 1);
  assert.equal(third.page.complete, true);
  assert.equal(model.hostCalls.length, callsAfterCapture);
});

test("a dense curve is split into cached fragments instead of exceeding the response budget", async () => {
  const points = Array.from({ length: 1_000 }, (_, index) => [
    index * 10_000,
    Math.sin(index / 25),
  ]);
  const model = createPitchHostModel({
    controls: [{ kind: "curve", position: Q, pitch: 60, points }],
  });
  const service = createService(model);
  let page = await service.snapshot({ ...RANGE, include: ["pitchControls"] });
  const callsAfterCapture = model.hostCalls.length;
  const observed = [];

  while (true) {
    const firstFragment = page.data.pitchControls[0];
    const lastFragment = page.data.pitchControls.at(-1);
    assert.equal(firstFragment.continuedFromPreviousPage, firstFragment.fragmentIndex > 0);
    assert.equal(
      lastFragment.continuesOnNextPage,
      lastFragment.fragmentIndex + 1 < lastFragment.fragmentCount
    );
    for (const control of page.data.pitchControls) {
      assert.equal(control.kind, "curve");
      assert.equal(control.fragment, true);
      observed.push(...control.points);
    }
    if (page.page.complete) break;
    page = await service.snapshot({ cursor: page.page.nextCursor });
  }

  assert.equal(model.hostCalls.length, callsAfterCapture);
  assert.deepEqual(observed, points.map(([timeFromAnchorBlick, pitchFromAnchorSemitone]) => ({
    timeFromAnchorBlick,
    pitchFromAnchorSemitone,
  })));
});

test("exceeding the per-group pitch control capture limit fails before over-reading", async () => {
  const controls = Array.from({ length: 3 }, (_, index) => ({
    kind: "point",
    position: (index + 1) * Q,
    pitch: 60,
  }));
  const model = createPitchHostModel({ controls });
  const service = createService(model, { captureLimits: { pitchControls: 2 } });
  await assert.rejects(
    service.snapshot({ ...RANGE, include: ["pitchControls"] }),
    (error) => error.code === "SNAPSHOT_PITCH_CONTROL_LIMIT_REACHED"
  );
});

test("typed-v2 envelope internals never leak into scriptDataKeys", async () => {
  const model = createPitchHostModel({
    controls: [
      {
        kind: "point",
        position: Q,
        pitch: 60,
        scriptData: { mm_Flag: 1, pfb_v1: "x" },
      },
    ],
  });
  const service = createService(model);
  const result = await service.snapshot({ ...RANGE, include: ["pitchControls"] });
  const keys = result.data.pitchControls[0].ownership.scriptDataKeys;
  assert.deepEqual(keys.sort(), ["mm_Flag", "pfb_v1"]);
  assert.ok(keys.every((key) => !key.startsWith("$sv")));
});

test("makeContextControlId and pitchEquals honor identity and float tolerance contracts", () => {
  assert.equal(makeContextControlId(0, 3), "o:0:pc:3");
  // pitch 浮点容差：1e-4 semitone（0.01 cent）内相等，BLICK 不走 epsilon。
  assert.ok(pitchEquals(60, 60 + 1e-5));
  assert.ok(!pitchEquals(60, 60 + 1e-2));
});

test("normalizeCurvePoints rejects malformed host entries instead of silently dropping them", () => {
  assert.throws(
    () => normalizeCurvePoints([[0, 0], "not-a-point", [100, 0.1]]),
    (error) => error.code === "HOST_DATA_INVALID"
  );
});

test("a shared target yields occurrence-specific absolute coordinates under one group fingerprint", async () => {
  // 同一 NoteGroup 被两个 reference 复用，offset 不同：同一 group-local 对象在两个
  // occurrence 下读出不同的绝对坐标，但 group fingerprint 相同（对象集本质是同一个）。
  const model = createPitchHostModel({
    timeOffsetBlick: BAR,
    pitchOffsetSemitone: 2,
    secondReference: { timeOffsetBlick: 2 * BAR, pitchOffsetSemitone: 5 },
    controls: [{ kind: "point", position: Q, pitch: 60 }],
  });
  const service = createService(model);
  const result = await service.snapshot({ ...RANGE, include: ["pitchControls"] });
  assert.equal(result.data.pitchControls.length, 2);

  const byOccurrence = Object.fromEntries(
    result.data.pitchControls.map((control) => [control.occurrence, control])
  );
  const mainPoint = byOccurrence[0];
  const secondPoint = byOccurrence[1];
  assert.equal(mainPoint.position.occurrenceAbsoluteBlick, Q + BAR);
  assert.equal(mainPoint.pitch.occurrenceAbsoluteSemitone, 62);
  assert.equal(secondPoint.position.occurrenceAbsoluteBlick, Q + 2 * BAR);
  assert.equal(secondPoint.pitch.occurrenceAbsoluteSemitone, 65);
  // group-local 与 fingerprint 与 occurrence 无关，两个 occurrence 完全一致。
  assert.equal(mainPoint.position.groupLocalBlick, secondPoint.position.groupLocalBlick);
  assert.equal(mainPoint.fingerprint, secondPoint.fingerprint);

  // 两个 group 摘要都标注 sharedTargetOccurrences，且 group fingerprint 相同。
  const groups = result.data.tracks[0].groups;
  assert.equal(groups.length, 2);
  assert.equal(groups[0].uuid, groups[1].uuid);
  assert.equal(groups[0].pitchControlGroupFingerprint, groups[1].pitchControlGroupFingerprint);
  assert.deepEqual(groups[0].sharedTargetOccurrences, [0, 1]);
});
