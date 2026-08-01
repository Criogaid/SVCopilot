// $defs 去重回归（计划 §13.7）。
//
// 去重的唯一正当性是「同样的约束、更少的字节」。因此这里不只断言变小，而是把 $ref
// 展开回去证明约束逐字段不变，并用真实 Ajv 编译每一份去重后的 schema——一份能通过
// review 却编译不了的 schema 会让工具彻底不可用。
import assert from "node:assert/strict";
import test from "node:test";

import AjvModule from "../server/node_modules/ajv/dist/ajv.js";
import { TOOLS } from "../server/src/index.js";
import { dedupeSchema } from "../server/src/schema-defs.js";

const Ajv = AjvModule.default ?? AjvModule;
const bytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");

function compile(schema) {
  // 与 index.js 相同的 Ajv 配置，确保判定一致。
  return new Ajv({ allErrors: true, strict: false, discriminator: true }).compile(schema);
}

// 把 $ref 全部展开，用于证明等价性。
function expand(node, defs) {
  if (Array.isArray(node)) return node.map((item) => expand(item, defs));
  if (node === null || typeof node !== "object") return node;
  if (typeof node.$ref === "string") {
    assert.equal(
      Object.keys(node).length,
      1,
      `a $ref must not carry sibling keywords: ${JSON.stringify(node)}`
    );
    const name = node.$ref.replace("#/$defs/", "");
    assert.ok(defs[name], `dangling $ref: ${node.$ref}`);
    return expand(defs[name], defs);
  }
  return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, expand(value, defs)]));
}

test("every served schema is self-contained and compiles on its own", () => {
  // 调用方最自然的用法就是把 inputSchema 直接交给校验器。若 $defs 提到了 describe
  // 响应根（那样更省字节），这一步就会失败——这条断言正是把「schema 自包含」钉死。
  for (const tool of TOOLS) {
    assert.doesNotThrow(() => compile(tool.inputSchema), `${tool.name} must compile standalone`);
    const refs = JSON.stringify(tool.inputSchema).match(/"\$ref":"[^"]+"/g) ?? [];
    for (const ref of refs) {
      // 允许 #/$defs/（本次去重产出）与 #/definitions/（个别 schema 本来就自带的
      // draft-07 定义表）。两者都是 schema 文档内部锚点，唯一禁止的是外部引用。
      assert.match(
        ref,
        /"#\/(\$defs|definitions)\//,
        `${tool.name} may only reference anchors inside itself: ${ref}`
      );
    }
  }
});

test("dedupe preserves the constraints exactly", () => {
  // index.js 在启动时就地去重了 TOOLS，因此这里拿不到去重前的原件。改为验证双向
  // 往返：展开必须消掉所有 $ref 且仍能编译，再次去重必须逐字节回到同一结果。
  // 两个方向都成立时，$ref 形式与展开形式只能是同一套约束的两种写法。
  let dedupedCount = 0;
  for (const tool of TOOLS) {
    const again = dedupeSchema(tool.inputSchema);
    assert.equal(
      JSON.stringify(again),
      JSON.stringify(tool.inputSchema),
      `${tool.name} dedupe must be idempotent`
    );

    if (!tool.inputSchema.$defs) continue;
    dedupedCount += 1;
    const { $defs, ...body } = tool.inputSchema;
    const expanded = expand(body, $defs);
    // 注意不能断言 expand -> dedupe 逐字节回到原件：去重按对象身份判定，而展开会
    // 造出一批结构相等但身份不同的新对象。身份判定正是刻意的选择（结构相等会把两个
    // 恰好同形、语义不同的片段合并），因此这里验证的是展开件本身自洽且可编译。
    assert.equal(
      JSON.stringify(expanded).includes('"#/$defs/'),
      false,
      `${tool.name}: expansion must leave no unresolved $defs ref`
    );
    assert.doesNotThrow(() => compile(expanded), `${tool.name} expanded form must compile`);
    // $defs 里不得有死条目：每个都必须真的被引用，否则它只是白占字节。
    const refs = new Set(
      (JSON.stringify(body).match(/"#\/\$defs\/([^"]+)"/g) ?? []).map((ref) =>
        ref.replace(/"#\/\$defs\/|"/g, "")
      )
    );
    for (const name of Object.keys($defs)) {
      const referencedByBody = refs.has(name);
      const referencedByDefs = JSON.stringify($defs).includes(`"#/$defs/${name}"`);
      assert.ok(
        referencedByBody || referencedByDefs,
        `${tool.name}: $defs.${name} is never referenced`
      );
    }
  }
  assert.ok(dedupedCount >= 5, `expected several deduped schemas, got ${dedupedCount}`);
});

test("a deduped schema accepts and rejects exactly what the expanded one does", () => {
  // 结构性论证之外再加一层行为验证：同一批 payload 在 $ref 形式与展开形式下必须
  // 得到相同裁决。这才是「约束没变」对调用方的实际含义。
  const curves = TOOLS.find((tool) => tool.name === "sv_patch_parameter_curves");
  const { $defs, ...body } = curves.inputSchema;
  const deduped = compile(curves.inputSchema);
  const plain = compile(expand(body, $defs));

  const target = { contextId: "c_x", occurrence: 0 };
  const payloads = [
    // 合法：BLICK 范围 + 显式点。
    {
      target,
      action: "dry_run",
      curves: [
        {
          parameter: "loudness",
          mode: "replace",
          range: { fromBlick: 0, toBlick: 100 },
          points: [{ blick: 0, value: 1 }],
        },
      ],
    },
    // 合法：语义范围 + note anchor（正是被提取成 $defs 的那些片段）。
    {
      target,
      action: "dry_run",
      curves: [
        {
          parameter: "tension",
          mode: "replace",
          range: {
            from: { anchor: { note: 0, position: "onset" } },
            to: { anchor: { note: 0, position: "end" } },
          },
          points: [{ anchor: { note: 0, position: "center" }, value: 1 }],
        },
      ],
    },
    // 非法：anchor 缺 position（required 必须穿过 $ref 继续生效）。
    {
      target,
      action: "dry_run",
      curves: [
        {
          parameter: "tension",
          mode: "replace",
          range: { from: { anchor: { note: 0 } }, to: { blick: 10 } },
          points: [{ blick: 0, value: 1 }],
        },
      ],
    },
    // 非法：anchor 里多出未知字段（additionalProperties:false 必须继续生效）。
    {
      target,
      action: "dry_run",
      curves: [
        {
          parameter: "tension",
          mode: "replace",
          range: {
            from: { anchor: { note: 0, position: "onset", bogus: 1 } },
            to: { blick: 10 },
          },
          points: [{ blick: 0, value: 1 }],
        },
      ],
    },
    // 非法：ratio 超界（数值约束必须继续生效）。
    {
      target,
      action: "dry_run",
      curves: [
        {
          parameter: "tension",
          mode: "replace",
          range: {
            from: { anchor: { note: 0, position: "ratio", ratio: 9 } },
            to: { blick: 10 },
          },
          points: [{ blick: 0, value: 1 }],
        },
      ],
    },
  ];

  for (const [index, payload] of payloads.entries()) {
    assert.equal(
      deduped(payload),
      plain(payload),
      `payload ${index}: $ref and expanded forms must agree`
    );
  }
  // 前两个必须通过、后三个必须被拒——否则"两者一致"可能只是都错。
  assert.deepEqual(
    payloads.map((payload) => plain(payload)),
    [true, true, false, false, false]
  );
});

test("dedupe only lifts real schema positions, never literal data", () => {
  // properties/default/const/enum 里的对象是映射表或字面数据，不是 schema。
  // 把它们换成 $ref 会产出无效 schema（Ajv 拒绝）或把 $ref 当成用户数据。
  // 片段要大于提取阈值（120 bytes）才会被提到 $defs，否则一个 $ref 反而更贵。
  const shared = {
    type: "object",
    additionalProperties: false,
    description: "a shared fragment large enough to be worth lifting into $defs",
    properties: { a: { type: "string" }, b: { type: "integer", minimum: 0 } },
    required: ["a"],
  };
  const literal = { note: "x".repeat(200), nested: { deep: true } };
  const schema = {
    type: "object",
    properties: {
      first: shared,
      second: shared,
      // 同一个字面对象出现两次，但它是 default 值，不得被提取。
      third: { type: "object", default: literal },
      fourth: { type: "object", default: literal },
    },
  };
  const result = dedupeSchema(schema);
  assert.ok(result.$defs, "the repeated schema fragment must be lifted");
  assert.deepEqual(result.properties.first, { $ref: "#/$defs/s0" });
  assert.deepEqual(result.properties.second, { $ref: "#/$defs/s0" });
  // default 里的字面数据原样保留。
  assert.deepEqual(result.properties.third.default, literal);
  assert.deepEqual(result.properties.fourth.default, literal);
  assert.doesNotThrow(() => compile(result));
});

test("dedupe leaves a schema untouched when nothing repeats", () => {
  const schema = { type: "object", properties: { a: { type: "string" } } };
  assert.equal(dedupeSchema(schema), schema, "no shared fragments means the same object back");
});

test("the largest schemas actually got smaller", () => {
  // 去重是为了省字节；如果最大的几份 schema 没有 $defs，说明提取条件失效了。
  const biggest = [...TOOLS].sort((a, b) => bytes(b.inputSchema) - bytes(a.inputSchema)).slice(0, 3);
  for (const tool of biggest) {
    assert.ok(tool.inputSchema.$defs, `${tool.name} is large and should have been deduped`);
  }
  const total = TOOLS.reduce((sum, tool) => sum + bytes(tool.inputSchema), 0);
  assert.ok(total < 80_000, `total served schema bytes should stay under 80 KB; got ${total}`);
});
