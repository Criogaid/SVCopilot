import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

import {
  CANONICAL_PHASE_LIMIT_RAD,
  canonicalizeTechniques,
  compileFirstPeakTransient,
  compilePitchDeltaTransition,
  solveOpenLoopCorrection,
  TECHNIQUE_IR_NUMERIC_FIELD_SCHEMA,
} from "./model.mjs";
import { encodeToolError } from "../../../server/src/mcp-result-encoder.js";

const requireFromServer = createRequire(new URL("../../../server/package.json", import.meta.url));
const Ajv2020 = requireFromServer("ajv/dist/2020").default;

const plan = fs.readFileSync(
  new URL("../implementation-plan.md", import.meta.url),
  "utf8",
);
const jsonBlocks = [...plan.matchAll(/```json\s*\r?\n([\s\S]*?)```/g)]
  .map((match) => JSON.parse(match[1]));
const gestureSchema = jsonBlocks.find((value) => (
  value.$id === "svcopilot://schemas/plan_pitch_gesture/arguments"
));
const correctionSchema = jsonBlocks.find((value) => (
  value.$id === "svcopilot://schemas/plan_pitch_correction/arguments"
));
const gestureExample = jsonBlocks.find((value) => value.operation === "plan_pitch_gesture");
const correctionExample = jsonBlocks.find((value) => value.operation === "plan_pitch_correction");
const techniqueIrExample = jsonBlocks.find((value) => (
  value.modelVersion === "pitch-techniques-v1"
));

function validatorFor(schema) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  return ajv.compile(schema);
}

function resolveLocalReference(root, reference) {
  if (!reference.startsWith("#/")) return null;
  return reference.slice(2).split("/").reduce((value, segment) => (
    value?.[segment.replaceAll("~1", "/").replaceAll("~0", "~")]
  ), root);
}

function schemaNodeIsNumeric(node, root, seen = new Set()) {
  if (!node || typeof node !== "object" || seen.has(node)) return false;
  if (node.type === "number" || node.type === "integer") return true;
  seen.add(node);
  if (
    typeof node.$ref === "string"
    && schemaNodeIsNumeric(resolveLocalReference(root, node.$ref), root, seen)
  ) return true;
  for (const branchName of ["allOf", "anyOf", "oneOf"]) {
    if ((node[branchName] ?? []).some((branch) => (
      schemaNodeIsNumeric(branch, root, seen)
    ))) return true;
  }
  return false;
}

function collectNumericPropertyNames(node, root, output = new Set(), seen = new Set()) {
  if (!node || typeof node !== "object" || seen.has(node)) return output;
  seen.add(node);
  if (typeof node.$ref === "string") {
    collectNumericPropertyNames(resolveLocalReference(root, node.$ref), root, output, seen);
  }
  for (const [field, child] of Object.entries(node.properties ?? {})) {
    if (schemaNodeIsNumeric(child, root)) output.add(field);
    collectNumericPropertyNames(child, root, output, seen);
  }
  for (const branchName of ["allOf", "anyOf", "oneOf"]) {
    for (const branch of node[branchName] ?? []) {
      collectNumericPropertyNames(branch, root, output, seen);
    }
  }
  for (const childName of ["if", "then", "else", "not", "items"]) {
    collectNumericPropertyNames(node[childName], root, output, seen);
  }
  return output;
}

function validatorForSubschema(schema, root) {
  return validatorFor({ ...schema, $defs: root.$defs });
}

function defaultFromSchema(node, root, seen = new Set()) {
  if (!node || typeof node !== "object" || seen.has(node)) return undefined;
  if (Object.hasOwn(node, "default")) return structuredClone(node.default);
  seen.add(node);
  if (typeof node.$ref === "string") {
    return defaultFromSchema(resolveLocalReference(root, node.$ref), root, seen);
  }
  return undefined;
}

function materializeSelectedDefaults(value, node, root) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) materializeSelectedDefaults(item, node.items, root);
    return;
  }
  if (typeof node.$ref === "string") {
    materializeSelectedDefaults(value, resolveLocalReference(root, node.$ref), root);
  }
  for (const branchName of ["oneOf", "anyOf"]) {
    const branches = node[branchName] ?? [];
    if (branches.length === 0) continue;
    const matching = branches.filter((branch) => validatorForSubschema(branch, root)(value));
    assert.equal(matching.length, 1, `${branchName} must select exactly one branch before defaults`);
    materializeSelectedDefaults(value, matching[0], root);
  }
  for (const [field, child] of Object.entries(node.properties ?? {})) {
    if (!Object.hasOwn(value, field)) {
      const fallback = defaultFromSchema(child, root);
      if (fallback !== undefined) value[field] = fallback;
    }
    if (Object.hasOwn(value, field)) {
      materializeSelectedDefaults(value[field], child, root);
    }
  }
  for (const branch of node.allOf ?? []) {
    if (branch.if) {
      const selected = validatorForSubschema(branch.if, root)(value)
        ? branch.then
        : branch.else;
      materializeSelectedDefaults(value, selected, root);
    } else {
      materializeSelectedDefaults(value, branch, root);
    }
  }
}

function normalizeGestureDefaults(gesture) {
  const normalized = structuredClone(gesture);
  materializeSelectedDefaults(
    normalized,
    gestureSchema.properties.gestures.items,
    gestureSchema,
  );
  if (normalized.type === "vibrato" && normalized.source === "explicit_pitch_delta") {
    normalized.endRateHz ??= normalized.rateHz;
    normalized.endDepthSemitone ??= normalized.depthSemitone;
  }
  return normalized;
}

function normalizeArgumentsDefaults(argumentsValue, schema) {
  const normalized = structuredClone(argumentsValue);
  materializeSelectedDefaults(normalized, schema, schema);
  for (const gesture of normalized.gestures ?? []) {
    if (gesture.type === "vibrato" && gesture.source === "explicit_pitch_delta") {
      gesture.endRateHz ??= gesture.rateHz;
      gesture.endDepthSemitone ??= gesture.depthSemitone;
    }
  }
  return normalized;
}

function collectNumericValueKeys(value, output = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectNumericValueKeys(item, output);
    return output;
  }
  if (!value || typeof value !== "object") return output;
  for (const [field, child] of Object.entries(value)) {
    if (typeof child === "number") output.add(field);
    collectNumericValueKeys(child, output);
  }
  return output;
}

function resolveNumericPropertySchema(node, root, seen = new Set()) {
  if (!node || typeof node !== "object" || seen.has(node)) return null;
  seen.add(node);
  if (node.type === "number" || node.type === "integer") return node;
  if (typeof node.$ref === "string") {
    return resolveNumericPropertySchema(resolveLocalReference(root, node.$ref), root, seen);
  }
  return null;
}

function collectNumericPropertySchemas(node, root, output = [], seen = new Set()) {
  if (!node || typeof node !== "object" || seen.has(node)) return output;
  seen.add(node);
  for (const [field, child] of Object.entries(node.properties ?? {})) {
    const numericSchema = resolveNumericPropertySchema(child, root);
    if (numericSchema) output.push({ field, schema: numericSchema });
    collectNumericPropertySchemas(child, root, output, seen);
  }
  if (typeof node.$ref === "string") {
    collectNumericPropertySchemas(resolveLocalReference(root, node.$ref), root, output, seen);
  }
  for (const branchName of ["allOf", "anyOf", "oneOf"]) {
    for (const branch of node[branchName] ?? []) {
      collectNumericPropertySchemas(branch, root, output, seen);
    }
  }
  for (const childName of ["if", "then", "else", "not", "items"]) {
    collectNumericPropertySchemas(node[childName], root, output, seen);
  }
  return output;
}

test("published schemas and examples remain valid JSON within the request budget", () => {
  assert.ok(gestureSchema);
  assert.ok(correctionSchema);
  assert.ok(gestureExample);
  assert.ok(correctionExample);
  assert.ok(Buffer.byteLength(JSON.stringify(gestureSchema), "utf8") <= 8192);
  assert.ok(Buffer.byteLength(JSON.stringify(correctionSchema), "utf8") <= 8192);
  assert.equal(validatorFor(gestureSchema)(gestureExample.arguments), true);
  assert.equal(validatorFor(correctionSchema)(correctionExample.arguments), true);
});

test("published numeric fields are registered in the authoritative IR field schema", () => {
  const publicFields = new Set([
    ...collectNumericPropertyNames(gestureSchema, gestureSchema),
    ...collectNumericPropertyNames(correctionSchema, correctionSchema),
  ]);
  assert.ok(publicFields.size > 0);
  for (const referencedField of ["startRatio", "endRatio", "priority"]) {
    assert.ok(publicFields.has(referencedField), `numeric $ref field was not resolved: ${referencedField}`);
  }
  for (const field of publicFields) {
    assert.ok(
      Object.hasOwn(TECHNIQUE_IR_NUMERIC_FIELD_SCHEMA, field),
      `numeric field is missing from the IR schema: ${field}`,
    );
  }
});

test("strictly positive public numbers survive canonical quantization", () => {
  const entries = [
    ...collectNumericPropertySchemas(gestureSchema, gestureSchema),
    ...collectNumericPropertySchemas(correctionSchema, correctionSchema),
  ];
  for (const { field, schema } of entries) {
    assert.notEqual(
      schema.exclusiveMinimum,
      0,
      `${field} accepts positive values that canonical quantization can round to zero`,
    );
    if (typeof schema.minimum === "number" && schema.minimum > 0) {
      assert.ok(
        schema.minimum >= TECHNIQUE_IR_NUMERIC_FIELD_SCHEMA[field].quantum,
        `${field} minimum is below its canonical quantum`,
      );
    }
  }
});

test("public integer identities stay inside the canonical safe-integer domain", () => {
  const entries = [
    ...collectNumericPropertySchemas(gestureSchema, gestureSchema),
    ...collectNumericPropertySchemas(correctionSchema, correctionSchema),
  ];
  for (const { field, schema } of entries) {
    const rule = TECHNIQUE_IR_NUMERIC_FIELD_SCHEMA[field];
    if (rule.domain !== "safe_integer") continue;
    assert.equal(schema.type, "integer", `${field} must be exposed as integer`);
    assert.ok(
      Number.isSafeInteger(schema.maximum),
      `${field} must expose a safe-integer maximum`,
    );
  }
});

test("canonical quantization preserves every published numeric boundary", () => {
  const entries = [
    ...collectNumericPropertySchemas(gestureSchema, gestureSchema),
    ...collectNumericPropertySchemas(correctionSchema, correctionSchema),
  ];
  for (const { field, schema } of entries) {
    for (const boundaryName of ["minimum", "maximum"]) {
      if (typeof schema[boundaryName] !== "number") continue;
      const input = schema[boundaryName];
      const [technique] = canonicalizeTechniques([{
        kind: "numeric_boundary_audit",
        model: { [field]: input },
      }]);
      const output = technique.semantic.model[field];
      if (typeof schema.minimum === "number") {
        assert.ok(output >= schema.minimum, `${field} quantized below its public minimum`);
      }
      if (typeof schema.maximum === "number") {
        assert.ok(output <= schema.maximum, `${field} quantized above its public maximum`);
      }
    }
  }
});

test("published phase bounds are exactly aligned to the canonical lattice", () => {
  const phaseSchema = gestureSchema.$defs.explicitVibrato.properties.phaseRad;
  assert.equal(phaseSchema.minimum, -CANONICAL_PHASE_LIMIT_RAD);
  assert.equal(phaseSchema.maximum, CANONICAL_PHASE_LIMIT_RAD);
  assert.equal(
    CANONICAL_PHASE_LIMIT_RAD
      / TECHNIQUE_IR_NUMERIC_FIELD_SCHEMA.phaseRad.quantum,
    Math.trunc(
      CANONICAL_PHASE_LIMIT_RAD
        / TECHNIQUE_IR_NUMERIC_FIELD_SCHEMA.phaseRad.quantum,
    ),
  );
});

test("documented TechniqueIR anchors canonicalize with the authoritative field schema", () => {
  assert.ok(techniqueIrExample);
  const [technique] = canonicalizeTechniques(techniqueIrExample.techniques);
  assert.deepEqual(technique.semantic.anchors, { fromNote: 4, toNote: 5 });
  assert.equal(TECHNIQUE_IR_NUMERIC_FIELD_SCHEMA.fromNote.unit, "index");
  assert.equal(TECHNIQUE_IR_NUMERIC_FIELD_SCHEMA.toNote.unit, "index");
});

test("every numeric field in the documented TechniqueIR is registered", () => {
  assert.ok(techniqueIrExample);
  const numericFields = collectNumericValueKeys(techniqueIrExample);
  assert.ok(numericFields.has("schemaVersion"));
  assert.ok(numericFields.has("maxAbsCents"));
  for (const field of numericFields) {
    assert.ok(
      Object.hasOwn(TECHNIQUE_IR_NUMERIC_FIELD_SCHEMA, field),
      `documented TechniqueIR numeric field is not registered: ${field}`,
    );
  }
});

test("gesture schema rejects removed target and execution semantics", () => {
  const validate = validatorFor(gestureSchema);
  for (const extra of [
    { target: { surface: "pitchDelta" } },
    { surface: "pitchDelta" },
    { referenceFrame: "pitch_delta_contribution_cents" },
    { mode: "add" },
    { execution: { action: "commit" } },
  ]) {
    assert.equal(validate({ ...gestureExample.arguments, ...extra }), false);
  }
});

test("vibrato branches cannot mix explicit and host-envelope fields", () => {
  const validate = validatorFor(gestureSchema);
  const common = { contextId: "ctx_test", occurrence: 0 };
  assert.equal(validate({
    ...common,
    gestures: [{
      type: "vibrato",
      source: "explicit_pitch_delta",
      note: 0,
      rateHz: 5.5,
      envelopeScale: 0.5,
    }],
  }), false);
  assert.equal(validate({
    ...common,
    gestures: [{
      type: "vibrato",
      source: "host_envelope",
      note: 0,
      envelopeScale: 0.5,
      rateHz: 5.5,
    }],
  }), false);
  assert.equal(validate({
    ...common,
    gestures: [{
      type: "transition",
      from: 0,
      to: 1,
      width: { seconds: 0.2 },
      curve: { family: "richards_segment" },
    }],
  }), false);
});

test("explicit vibrato schema rejects hard-edge zero fades", () => {
  const validate = validatorFor(gestureSchema);
  const vibrato = {
    type: "vibrato",
    source: "explicit_pitch_delta",
    note: 0,
    rateHz: 5.5,
    fadeInSeconds: 0.1,
    fadeOutSeconds: 0.1,
  };
  assert.equal(validate({
    contextId: "ctx_test",
    occurrence: 0,
    gestures: [vibrato],
  }), true, JSON.stringify(validate.errors));
  assert.equal(validate({
    contextId: "ctx_test",
    occurrence: 0,
    gestures: [{ ...vibrato, fadeInSeconds: 0 }],
  }), false);
  assert.equal(validate({
    contextId: "ctx_test",
    occurrence: 0,
    gestures: [{ ...vibrato, fadeOutSeconds: 0 }],
  }), false);
});

test("gesture schema enforces the 32-technique request budget", () => {
  const validate = validatorFor(gestureSchema);
  const gesture = {
    type: "transient",
    note: 0,
    intent: "overshoot",
    peakSemitone: 0.2,
    peakTimeSeconds: 0.05,
    spanSeconds: 0.2,
  };
  assert.equal(validate({
    contextId: "ctx_test",
    occurrence: 0,
    gestures: Array.from({ length: 32 }, () => ({ ...gesture })),
  }), true);
  assert.equal(validate({
    contextId: "ctx_test",
    occurrence: 0,
    gestures: Array.from({ length: 33 }, () => ({ ...gesture })),
  }), false);
});

test("transient damping defaults follow the selected Saitou technique", () => {
  const validate = validatorFor(gestureSchema);
  for (const [intent, expectedDampingRatio] of [
    ["overshoot", 0.5422],
    ["preparation", 0.6681],
  ]) {
    const request = {
      contextId: "ctx_test",
      occurrence: 0,
      gestures: [{
        type: "transient",
        note: 0,
        intent,
        peakSemitone: 0.2,
        peakTimeSeconds: 0.05,
        spanSeconds: 0.2,
      }],
    };
    const original = structuredClone(request);
    assert.equal(validate(request), true, JSON.stringify(validate.errors));
    assert.deepEqual(request, original, "schema validation must not mutate the request");
    const normalized = normalizeGestureDefaults(request.gestures[0]);
    assert.equal(normalized.dampingRatio, expectedDampingRatio);
    assert.equal(Object.hasOwn(normalized, "rateHz"), false);
    assert.equal(Object.hasOwn(normalized, "envelopeScale"), false);
    assert.equal(validate({ ...request, gestures: [normalized] }), true);
  }
});

test("gesture defaults materialize only after discriminator selection", () => {
  const validate = validatorFor(gestureSchema);
  const explicit = normalizeGestureDefaults({
    type: "vibrato",
    source: "explicit_pitch_delta",
    note: 0,
  });
  assert.deepEqual(explicit, {
    type: "vibrato",
    source: "explicit_pitch_delta",
    note: 0,
    priority: 0,
    startRatio: 0,
    endRatio: 1,
    rateHz: 5.5,
    depthSemitone: 0.3,
    centerDriftSemitone: 0,
    phaseRad: 0,
    fadeInSeconds: 0.3,
    fadeOutSeconds: 0.2,
    endRateHz: 5.5,
    endDepthSemitone: 0.3,
  });
  assert.equal(validate({ contextId: "ctx", occurrence: 0, gestures: [explicit] }), true);
  const host = normalizeGestureDefaults({
    type: "vibrato",
    source: "host_envelope",
    note: 0,
  });
  assert.deepEqual(host, {
    type: "vibrato",
    source: "host_envelope",
    note: 0,
    priority: 0,
    startRatio: 0,
    endRatio: 1,
    envelopeScale: 1,
  });
  assert.equal(validate({ contextId: "ctx", occurrence: 0, gestures: [host] }), true);
  const transition = normalizeGestureDefaults({
    type: "transition",
    from: 0,
    to: 1,
    width: { seconds: 0.2 },
    curve: { family: "richards" },
  });
  assert.deepEqual(transition.curve, {
    family: "richards",
    inflectionRatio: 0.5,
    sharpness: 6,
    asymmetryLogB: 0,
  });
  assert.equal(validate({ contextId: "ctx", occurrence: 0, gestures: [transition] }), true);
});

test("optional settings objects materialize their documented nested defaults", () => {
  const gestureArguments = normalizeArgumentsDefaults({
    contextId: "ctx",
    occurrence: 0,
    gestures: [{
      type: "vibrato",
      source: "host_envelope",
      note: 0,
    }],
  }, gestureSchema);
  assert.deepEqual(gestureArguments.constraints, {
    maxAbsPeakSemitone: 1.5,
    maxTotalPoints: 1200,
    maxFitErrorCent: 1,
  });
  assert.equal(validatorFor(gestureSchema)(gestureArguments), true);

  const correctionArguments = normalizeArgumentsDefaults({
    sourcePlanRef: "a_plan",
    observedContextId: "ctx_after",
  }, correctionSchema);
  assert.deepEqual(correctionArguments.evidence, {
    minimumCoverage: 0.8,
    minimumRunFrames: 3,
  });
  assert.deepEqual(correctionArguments.regularization, {
    smoothnessLambda: 0.4,
    magnitudeMu: 0.01,
    maxAbsCorrectionCent: 50,
  });
  assert.equal(validatorFor(correctionSchema)(correctionArguments), true);
});

test("undamped transient schema requires an explicit continuous taper", () => {
  const validate = validatorFor(gestureSchema);
  const base = {
    contextId: "ctx_test",
    occurrence: 0,
    gestures: [{
      type: "transient",
      note: 0,
      intent: "overshoot",
      peakSemitone: 0.2,
      peakTimeSeconds: 0.05,
      dampingRatio: 0,
      spanSeconds: 0.2,
    }],
  };
  assert.equal(validate(base), false);
  assert.equal(validate({
    ...base,
    gestures: [{ ...base.gestures[0], tailPolicy: "reject" }],
  }), false);
  assert.equal(validate({
    ...base,
    gestures: [{ ...base.gestures[0], tailPolicy: "continuous_taper" }],
  }), true, JSON.stringify(validate.errors));
});

test("correction schema accepts only the compact PlanRef handoff", () => {
  const validate = validatorFor(correctionSchema);
  assert.equal(validate(correctionExample.arguments), true);
  assert.equal(validate({
    ...correctionExample.arguments,
    occurrence: 0,
  }), false);
  assert.equal(validate({
    ...correctionExample.arguments,
    target: { kind: "artifact", artifactRef: "a_target" },
  }), false);
  assert.equal(validate({
    ...correctionExample.arguments,
    anchors: { preserveTechniqueAnchors: true },
  }), false);
  assert.equal(validate({
    ...correctionExample.arguments,
    weights: { minimumCoverage: 0.8 },
  }), false);
  assert.equal(validate({
    ...correctionExample.arguments,
    regularization: {
      ...correctionExample.arguments.regularization,
      magnitudeMu: 0,
    },
  }), false);
});

test("tail policy documents distinct actionable failure codes", () => {
  const sectionStart = plan.indexOf("### 4.3 F3");
  const sectionEnd = plan.indexOf("### 4.3b F3b");
  assert.ok(sectionStart >= 0 && sectionEnd > sectionStart);
  const tailPolicySection = plan.slice(sectionStart, sectionEnd);
  assert.match(tailPolicySection, /TAIL_NOT_SETTLED/);
  assert.match(tailPolicySection, /TAPER_OVERLAPS_PEAK/);
  assert.match(tailPolicySection, /扩大 span/);
});

test("canonical errors retain machine evidence through the MCP error encoder", () => {
  for (const [invoke, code, field, path] of [
    [
      () => canonicalizeTechniques([{ kind: "audit", model: { unknownNumeric: 0.3 } }]),
      "UNQUANTIZED_SEMANTIC_FIELD",
      "unknownNumeric",
      "$/model/unknownNumeric",
    ],
    [
      () => canonicalizeTechniques([{ kind: "audit", anchors: { note: 0.5 } }]),
      "INVALID_INTEGER_SEMANTIC_FIELD",
      "note",
      "$/anchors/note",
    ],
  ]) {
    let caught;
    try {
      invoke();
    } catch (error) {
      caught = error;
    }
    assert.ok(caught);
    const encoded = encodeToolError(caught.code, caught.message, caught.details);
    assert.equal(encoded.isError, true);
    assert.equal(encoded.structuredContent.error.code, code);
    assert.equal(encoded.structuredContent.error.field, field);
    assert.equal(encoded.structuredContent.error.path, path);
    assert.ok(Object.hasOwn(encoded.structuredContent.error, "value"));
  }
});

test("model, transition, and correction evidence survives MCP error projection", () => {
  const transitionNote = {
    indexInGroup: 0,
    onsetBlick: 0,
    durationBlick: 1000,
    onsetSeconds: 0,
    endSeconds: 1,
    pitchSemitone: 60,
  };
  const cases = [
    {
      invoke: () => compilePitchDeltaTransition({
        fromNote: transitionNote,
        toNote: {
          ...transitionNote,
          indexInGroup: 1,
          onsetBlick: 1001,
          onsetSeconds: 1,
          endSeconds: 2,
          pitchSemitone: 64,
        },
        widthSeconds: 0.4,
        curve: { family: "linear" },
      }),
      code: "TRANSITION_NOT_ADJACENT",
      evidence: { fromEndBlick: 1000, toOnsetBlick: 1001 },
    },
    {
      invoke: () => compileFirstPeakTransient({
        peakSemitone: 0.3,
        peakTimeSeconds: 0.05,
        dampingRatio: 0,
        spanSeconds: 0.4,
        tailPolicy: "reject",
      }),
      code: "UNDAMPED_TAIL_REQUIRES_TAPER",
      evidence: { dampingRatio: 0, tailPolicy: "reject" },
    },
    {
      invoke: () => solveOpenLoopCorrection({
        targetAbsoluteCent: [6000, null, null, null],
        observedComputedMidi: [60, null, null, null],
        currentPitchDeltaCent: [0, null, null, null],
      }, { minimumCoverage: 0.75 }),
      code: "INSUFFICIENT_COMPUTED_PITCH",
      evidence: { observedCoverage: 0.25, requiredCoverage: 0.75 },
    },
  ];

  for (const current of cases) {
    let caught;
    try {
      current.invoke();
    } catch (error) {
      caught = error;
    }
    assert.ok(caught);
    const encoded = encodeToolError(caught.code, caught.message, caught.details);
    assert.equal(encoded.structuredContent.error.code, current.code);
    for (const [field, value] of Object.entries(current.evidence)) {
      assert.equal(encoded.structuredContent.error[field], value);
    }
  }
});

test("transition mapping and the fixed final-review matrix remain explicit", () => {
  const transitionStart = plan.indexOf("### 4.1b F1b");
  const transitionEnd = plan.indexOf("### 4.2 F2");
  assert.ok(transitionStart >= 0 && transitionEnd > transitionStart);
  const transitionSection = plan.slice(transitionStart, transitionEnd);
  for (const required of [
    "C(t) = 100·(P(t)-S(t))",
    "TRANSITION_NOT_ADJACENT",
    "TRANSITION_TIME_MAPPING_INCONSISTENT",
    "TRANSITION_EQUAL_PITCH",
    "TRANSITION_WIDTH_EXCEEDS_ADJACENT_NOTES",
    "TRANSITION_TIME_RESOLUTION_TOO_COARSE",
    "TRANSITION_EXCEEDS_PITCH_DELTA_RANGE",
    'status:"no_change"',
    "compilePitchDeltaTransition()",
    "projectTransitionMandatoryBlickAnchors()",
  ]) {
    assert.match(transitionSection, new RegExp(required.replace(/[()]/g, "\\$&")));
  }

  const matrixStart = plan.indexOf("### 16.6 固定终审矩阵");
  const matrixEnd = plan.indexOf("## 17. 提交序列");
  assert.ok(matrixStart >= 0 && matrixEnd > matrixStart);
  const matrixSection = plan.slice(matrixStart, matrixEnd);
  for (const dimension of [
    "公开业务语义",
    "数值闭包",
    "错误边界",
    "数学与证据来源",
    "运行质量",
  ]) {
    assert.match(matrixSection, new RegExp(dimension));
  }
  for (const transitionCase of [
    "上下行",
    "gap/overlap",
    "时间映射偏差",
    "等音高 no-change",
    "rest",
    "短音符",
    "大音程",
    "BLICK 分辨率",
  ]) {
    assert.match(matrixSection, new RegExp(transitionCase));
  }
});
