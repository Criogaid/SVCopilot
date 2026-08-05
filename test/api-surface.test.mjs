// API 表面证据的离线回归。不连宿主、不读采集文件：全部用内联合成 capture。
//
// 这层门禁要守住三件事：
//   1. 三分类语义正确（undocumented / missing / matched），尤其是"类不在文档里"
//      与"类在文档里但少这个方法"必须可区分。
//   2. 未知字段一律拒绝——证据 schema 是白名单，多一个字段就说明采集侧改过而没同步。
//   3. 脱敏：证据将来可能折进 host profile，那里禁止路径分隔符与工程内容键名。
import assert from "node:assert/strict";
import test from "node:test";

import {
  API_SURFACE_CAPTURE_KIND,
  API_SURFACE_EVIDENCE_KIND,
  API_SURFACE_RESULT_CODES,
  API_SURFACE_SCHEMA_VERSION,
  assertEvidenceIsSanitized,
  buildApiSurfaceEvidence,
  diffApiSurface,
  normalizeApiSurfaceCapture,
  summarizeApiSurface,
} from "../tools/lib/api-surface.mjs";

// 一份最小 manifest：Note 有两个方法，PitchControlCurve 有一个。
// 刻意不含 SecretClass，用来验证"整个类都不在文档里"这一分支。
function manifestFixture() {
  return {
    generatedAt: "2026-07-21T02:48:17.036Z",
    classes: {
      Note: { methods: { getPitch: [{}], getOnset: [{}] }, members: {} },
      PitchControlCurve: { methods: { getPoints: [{}] }, members: {} },
    },
  };
}

function captureFixture(overrides = {}) {
  return {
    kind: API_SURFACE_CAPTURE_KIND,
    schemaVersion: API_SURFACE_SCHEMA_VERSION,
    capturedAt: "2026-08-05T00:00:00.000Z",
    host: {
      product: "Synthesizer V Studio 2 Pro",
      version: "2.2.1",
      platform: "win32",
      versionNumber: 131585,
    },
    probe: { name: "SVApiSurfaceProbe", version: "1", readOnly: true, trialCalls: true },
    classes: [
      {
        name: "Note",
        origin: "created",
        available: true,
        members: [
          { name: "getPitch", kind: "function", scope: "own", trial: { status: "ok", returnedType: "number" } },
          { name: "getOnset", kind: "function", scope: "own" },
          { name: "undocumentedThing", kind: "function", scope: "own" },
        ],
      },
    ],
    ...overrides,
  };
}

test("diff separates undocumented, missing and matched members", () => {
  const diff = diffApiSurface(captureFixture(), manifestFixture());
  const summary = summarizeApiSurface(diff);

  assert.equal(summary.matchedCount, 2);
  assert.deepEqual(
    diff.undocumented.map((item) => `${item.className}.${item.member}`),
    ["Note.undocumentedThing"]
  );
  // Note 在文档里，只是少了这个方法——与"整个类都没有"是两回事。
  assert.equal(diff.undocumented[0].classDocumented, true);
  assert.deepEqual(diff.undocumented[0].origins, ["created"]);

  // PitchControlCurve 本次没枚举到，且没登记为 unavailable，因此算 manifest 侧未观测。
  assert.deepEqual(
    diff.missing.map((item) => `${item.className}.${item.member ?? "*"}:${item.reason}`),
    ["PitchControlCurve.*:CLASS_NOT_OBSERVED"]
  );
  assert.equal(summary.resultCode, API_SURFACE_RESULT_CODES.diverged);
});

test("a class absent from the manifest is reported as wholly undocumented", () => {
  const capture = captureFixture({
    classes: [
      {
        name: "SecretClass",
        origin: "live_instance",
        available: true,
        members: [{ name: "getSecret", kind: "function", scope: "own" }],
      },
    ],
  });
  const diff = diffApiSurface(capture, manifestFixture());
  assert.equal(diff.undocumented.length, 1);
  assert.equal(diff.undocumented[0].className, "SecretClass");
  assert.equal(diff.undocumented[0].classDocumented, false);
});

test("members seen on any origin count as observed and merge their origins", () => {
  const capture = captureFixture({
    classes: [
      {
        name: "Note",
        origin: "created",
        available: true,
        members: [{ name: "getPitch", kind: "function", scope: "own" }],
      },
      {
        name: "Note",
        origin: "live_instance",
        available: true,
        members: [
          { name: "getPitch", kind: "function", scope: "own" },
          { name: "getOnset", kind: "function", scope: "own" },
          { name: "liveOnlyMember", kind: "function", scope: "own" },
        ],
      },
    ],
  });
  const diff = diffApiSurface(capture, manifestFixture());
  // 空对象上没有、活实例上才有的成员，必须被算作"实机存在"。
  assert.deepEqual(
    diff.undocumented.map((item) => item.member),
    ["liveOnlyMember"]
  );
  assert.deepEqual(diff.undocumented[0].origins, ["created", "live_instance"]);
  assert.equal(summarizeApiSurface(diff).matchedCount, 2);
});

test("a class the probe could not instantiate is not reported as missing", () => {
  const capture = captureFixture({
    classes: [
      { name: "PitchControlCurve", origin: "created", available: false, reason: "CREATE_FAILED" },
      {
        name: "Note",
        origin: "created",
        available: true,
        members: [
          { name: "getPitch", kind: "function", scope: "own" },
          { name: "getOnset", kind: "function", scope: "own" },
        ],
      },
    ],
  });
  const diff = diffApiSurface(capture, manifestFixture());
  // 没能拿到实例 ≠ 宿主没有这个类；把它算成 missing 会制造假差异。
  assert.deepEqual(diff.missing, []);
  assert.deepEqual(diff.unavailable, [
    { name: "PitchControlCurve", origin: "created", reason: "CREATE_FAILED" },
  ]);
  assert.equal(summarizeApiSurface(diff).resultCode, API_SURFACE_RESULT_CODES.confirmed);
});

test("full parity yields the confirmed result code", () => {
  const capture = captureFixture({
    classes: [
      {
        name: "Note",
        origin: "created",
        available: true,
        members: [
          { name: "getPitch", kind: "function", scope: "own" },
          { name: "getOnset", kind: "function", scope: "own" },
        ],
      },
      {
        name: "PitchControlCurve",
        origin: "created",
        available: true,
        members: [{ name: "getPoints", kind: "function", scope: "own" }],
      },
    ],
  });
  const summary = summarizeApiSurface(diffApiSurface(capture, manifestFixture()));
  assert.equal(summary.resultCode, API_SURFACE_RESULT_CODES.confirmed);
  assert.equal(summary.undocumentedCount, 0);
  assert.equal(summary.missingCount, 0);
  assert.match(summary.resultCode, /^[A-Z0-9_]+$/);
});

test("capture normalization rejects malformed evidence", () => {
  const cases = [
    ["unknown top-level field", (capture) => { capture.extra = 1; }, /unknown field/],
    ["non read-only probe", (capture) => { capture.probe.readOnly = false; }, /readOnly must be true/],
    ["unknown member kind", (capture) => { capture.classes[0].members[0].kind = "method"; }, /kind must be one of/],
    ["unknown origin", (capture) => { capture.classes[0].origin = "guessed"; }, /origin must be one of/],
    ["non-identifier member name", (capture) => { capture.classes[0].members[0].name = "get Pitch"; }, /bare identifier/],
    [
      "duplicate member",
      (capture) => { capture.classes[0].members.push({ name: "getPitch", kind: "function", scope: "own" }); },
      /duplicate entry/,
    ],
    [
      "trial without trialCalls",
      (capture) => { capture.probe.trialCalls = false; },
      /requires capture.probe.trialCalls/,
    ],
    [
      "unavailable class carrying members",
      (capture) => {
        capture.classes[0].available = false;
        capture.classes[0].reason = "CREATE_FAILED";
      },
      /members must be empty/,
    ],
    [
      "unavailable class without a reason",
      (capture) => {
        capture.classes[0].available = false;
        capture.classes[0].members = [];
      },
      /reason must be a non-empty string/,
    ],
    ["malformed timestamp", (capture) => { capture.capturedAt = "yesterday"; }, /ISO-8601/],
    ["empty class list", (capture) => { capture.classes = []; }, /must not be empty/],
  ];

  for (const [label, mutate, pattern] of cases) {
    const capture = captureFixture();
    mutate(capture);
    assert.throws(
      () => normalizeApiSurfaceCapture(capture),
      (error) => {
        assert.equal(error.code, "INVALID_API_SURFACE_EVIDENCE", label);
        assert.match(error.message, pattern, label);
        return true;
      },
      label
    );
  }
});

test("a failed trial keeps only an error class, never the host message", () => {
  const capture = captureFixture();
  capture.classes[0].members[0].trial = { status: "failed", errorKind: "HOST_ERROR" };
  const normalized = normalizeApiSurfaceCapture(capture);
  assert.deepEqual(normalized.classes[0].members.find((m) => m.name === "getPitch").trial, {
    status: "failed",
    errorKind: "HOST_ERROR",
  });

  const leaky = captureFixture();
  leaky.classes[0].members[0].trial = { status: "failed", errorKind: "cannot open C:/Songs/secret.svp" };
  assert.throws(() => normalizeApiSurfaceCapture(leaky), /underscore\/alphanumeric code/);
});

test("evidence carries a conclusion and refuses project content", () => {
  const diff = diffApiSurface(captureFixture(), manifestFixture());
  const summary = summarizeApiSurface(diff);
  const evidence = buildApiSurfaceEvidence({ diff, summary });

  assert.equal(evidence.kind, API_SURFACE_EVIDENCE_KIND);
  assert.equal(evidence.schemaVersion, API_SURFACE_SCHEMA_VERSION);
  assert.equal(evidence.conclusion.semantic, "api.surfaceParity");
  assert.equal(evidence.conclusion.status, "contradicted");
  assert.equal(evidence.truncated.undocumented, false);
  // 证据是只读结论，不该被下游改写。
  assert.equal(Object.isFrozen(evidence), true);

  // 与 host profile 的 privacyLint 同一条线：路径分隔符与工程内容键名都不许出现。
  const windowsPath = `C:${String.fromCharCode(92)}Songs`;
  assert.throws(() => assertEvidenceIsSanitized({ file: windowsPath }), /path-like string/);
  assert.throws(() => assertEvidenceIsSanitized({ url: "https://example.com/a" }), /path-like string/);
  for (const key of ["values", "points", "notes", "lyrics", "phonemes"]) {
    assert.throws(
      () => assertEvidenceIsSanitized({ [key]: 1 }),
      /project-content field/,
      `${key} must be refused`
    );
  }
  assertEvidenceIsSanitized(evidence);
});

test("evidence detail lists are truncated with the drop declared", () => {
  const members = Array.from({ length: 5 }, (_, index) => ({
    name: `undocumented${index}`,
    kind: "function",
    scope: "own",
  }));
  const capture = captureFixture({
    classes: [{ name: "Note", origin: "created", available: true, members }],
  });
  const diff = diffApiSurface(capture, manifestFixture());
  const summary = summarizeApiSurface(diff);
  const evidence = buildApiSurfaceEvidence({ diff, summary, maxDetailItems: 2 });

  assert.equal(evidence.undocumented.length, 2);
  // 计数仍报全量，截断被显式声明——否则"少了几条"会被读成"只有这几条"。
  assert.equal(evidence.summary.undocumentedCount, 5);
  assert.equal(evidence.truncated.undocumented, true);
  assert.equal(evidence.truncated.maxDetailItems, 2);
});

// 2026-08-05 实机回归：第一版探针只认 type(value)=="function"，于是把 2.2.1 上全部
// 527 个成员判成 value，试调门禁一次都没触发，而输出看起来和正常报告毫无区别。
// 那种失败必须能被自动看出来。
test("a capture where nothing was classified callable is flagged as unhealthy", () => {
  const capture = captureFixture({
    probe: { name: "SVApiSurfaceProbe", version: "1", readOnly: true, trialCalls: true },
    classes: [
      {
        name: "Note",
        origin: "created",
        available: true,
        members: [
          { name: "getPitch", kind: "value", scope: "own", luaType: "userdata" },
          { name: "getOnset", kind: "value", scope: "own", luaType: "userdata" },
        ],
      },
    ],
  });
  const diff = diffApiSurface(capture, manifestFixture());
  const summary = summarizeApiSurface(diff);

  assert.deepEqual(summary.captureWarnings, ["NO_CALLABLE_MEMBER_CLASSIFIED"]);
  assert.equal(diff.captureHealth.callableCount, 0);
  assert.equal(diff.captureHealth.memberCount, 2);
  assert.deepEqual(diff.captureHealth.observedLuaTypes, ["userdata"]);
  // 证据必须带上健康度，否则一份不可信的采集会被当成结论归档。
  const evidence = buildApiSurfaceEvidence({ diff, summary });
  assert.deepEqual(evidence.captureHealth.warnings, ["NO_CALLABLE_MEMBER_CLASSIFIED"]);
});

test("trial calls enabled but never executed is flagged", () => {
  const capture = captureFixture({
    classes: [
      {
        name: "Note",
        origin: "created",
        available: true,
        members: [{ name: "getPitch", kind: "function", scope: "own", luaType: "function" }],
      },
    ],
  });
  const summary = summarizeApiSurface(diffApiSurface(capture, manifestFixture()));
  assert.deepEqual(summary.captureWarnings, ["TRIAL_CALLS_ENABLED_BUT_NONE_RAN"]);
});

test("a healthy capture reports no warnings", () => {
  const capture = captureFixture({
    classes: [
      {
        name: "Note",
        origin: "created",
        available: true,
        members: [
          {
            name: "getPitch",
            kind: "function",
            scope: "own",
            luaType: "function",
            trial: { status: "ok", returnedType: "number" },
          },
        ],
      },
    ],
  });
  const summary = summarizeApiSurface(diffApiSurface(capture, manifestFixture()));
  assert.deepEqual(summary.captureWarnings, []);
});

test("luaType is validated against known Lua types", () => {
  const capture = captureFixture();
  capture.classes[0].members[0].luaType = "callable";
  assert.throws(() => normalizeApiSurfaceCapture(capture), /luaType must be one of/);
});

test("summary recomputes from the diff instead of trusting a stored value", () => {
  const diff = diffApiSurface(captureFixture(), manifestFixture());
  const first = summarizeApiSurface(diff);
  const second = summarizeApiSurface(diff);
  assert.deepEqual(first, second);
  assert.equal(first.undocumentedCount, diff.undocumented.length);
  assert.equal(first.missingCount, diff.missing.length);
  assert.equal(first.unavailableCount, diff.unavailable.length);
});
