import assert from "node:assert";
import { decodeDense, encodeDense } from "../server/src/dense-codec.js";
import { normalizeCurveInput } from "../server/src/parameter-curve.js";

// 简单对象数组：identity 编码。
{
  const profile = {
    schemaVersion: "1",
    columns: [
      { name: "blick", type: "integer" },
      { name: "value", type: "number" },
    ],
  };
  const rows = [
    { blick: 0, value: 1.5 },
    { blick: 100, value: 2.5 },
  ];
  const envelope = encodeDense(rows, profile);
  assert.strictEqual(envelope.encoding, "dense-table-v1");
  assert.deepStrictEqual(envelope.points, [
    [0, 1.5],
    [100, 2.5],
  ]);
  const decoded = decodeDense(envelope);
  assert.deepStrictEqual(decoded, rows);
}

// 曲线写入端接受同一 dense-table-v1，并在业务校验前还原为标准点对象。
{
  const envelope = encodeDense(
    [
      { blick: 0, value: 0.2 },
      { blick: 705600000, value: 0.8 },
    ],
    {
      schemaVersion: "1",
      columns: [
        { name: "blick", type: "integer", encoding: "delta" },
        { name: "value", type: "number" },
      ],
    }
  );
  const normalized = normalizeCurveInput({
    parameter: "tension",
    mode: "replace",
    range: { fromBlick: 0, toBlick: 705600000 },
    points: envelope,
  });
  assert.deepStrictEqual(normalized.points, [
    { kind: "blick", blick: 0, value: 0.2 },
    { kind: "blick", blick: 705600000, value: 0.8 },
  ]);
  assert.throws(
    () =>
      normalizeCurveInput({
        parameter: "tension",
        mode: "replace",
        range: { fromBlick: 0, toBlick: 1 },
        points: encodeDense(
          [{ blick: 0, value: 0.2, typo: 1 }],
          {
            schemaVersion: "1",
            columns: [
              { name: "blick", type: "integer" },
              { name: "value", type: "number" },
              { name: "typo", type: "number" },
            ],
          }
        ),
      }),
    /unknown field: typo/
  );
}

// delta 编码。
{
  const profile = {
    schemaVersion: "1",
    columns: [
      { name: "time", type: "integer", encoding: "delta" },
      { name: "pitch", type: "integer", encoding: "delta" },
    ],
  };
  const rows = [
    { time: 0, pitch: 60 },
    { time: 120, pitch: 62 },
    { time: 240, pitch: 64 },
  ];
  const envelope = encodeDense(rows, profile);
  assert.deepStrictEqual(envelope.points, [
    [0, 60],
    [120, 2],
    [120, 2],
  ]);
  assert.deepStrictEqual(decodeDense(envelope), rows);
}

// qint 编码。
{
  const profile = {
    schemaVersion: "1",
    columns: [
      { name: "time", type: "integer", encoding: "delta" },
      { name: "pitch", unit: "semitone", type: "number", encoding: "qint", scale: 1e-4, maxError: 5e-5 },
    ],
  };
  const rows = [
    { time: 0, pitch: 0 },
    { time: 120, pitch: 0.0035 },
    { time: 120, pitch: -0.0008 },
  ];
  const envelope = encodeDense(rows, profile);
  assert.deepStrictEqual(envelope.points, [
    [0, 0],
    [120, 35],
    [0, -8],
  ]);
  const decoded = decodeDense(envelope);
  assert.strictEqual(decoded[0].pitch, 0);
  assert.strictEqual(decoded[1].pitch, 0.0035);
  assert.strictEqual(decoded[2].pitch, -0.0008);
}

// dictionary 编码只接受 profile 内声明的字符串。
{
  const profile = {
    schemaVersion: "1",
    columns: [
      {
        name: "lyrics",
        type: "string",
        encoding: "dictionary",
        dictionary: ["a", "i"],
      },
    ],
  };
  const envelope = encodeDense([{ lyrics: "a" }, { lyrics: "i" }, { lyrics: "a" }], profile);
  assert.deepStrictEqual(envelope.points, [[0], [1], [0]]);
  assert.deepStrictEqual(decodeDense(envelope), [{ lyrics: "a" }, { lyrics: "i" }, { lyrics: "a" }]);
  assert.throws(() => encodeDense([{ lyrics: "u" }], profile), /not in dictionary/);
}

// 重复列、未知字段、错误标量和精确字段 qint 必须在分配或归一化前拒绝。
{
  assert.throws(
    () =>
      encodeDense([], {
        schemaVersion: "1",
        columns: [
          { name: "x", type: "number" },
          { name: "x", type: "number" },
        ],
      }),
    /duplicate column/
  );
  assert.throws(
    () =>
      encodeDense([{ x: 1, extra: 2 }], {
        schemaVersion: "1",
        columns: [{ name: "x", type: "number" }],
      }),
    /outside the profile/
  );
  assert.throws(
    () =>
      encodeDense([{ x: "1" }], {
        schemaVersion: "1",
        columns: [{ name: "x", type: "number" }],
      }),
    /expected number/
  );
  assert.throws(
    () =>
      encodeDense([], {
        schemaVersion: "1",
        columns: [
          {
            name: "positionBlick",
            unit: "blick",
            type: "number",
            encoding: "qint",
            scale: 1,
            maxError: 0.5,
          },
        ],
      }),
    /exact fields cannot use qint/
  );
}

// 解码端拒绝额外 envelope 字段和超大分配。
{
  assert.throws(
    () =>
      decodeDense({
        encoding: "dense-table-v1",
        schemaVersion: "1",
        columns: [{ name: "x", type: "number" }],
        points: [],
        injected: true,
      }),
    /unknown fields/
  );
  assert.throws(
    () =>
      encodeDense(new Array(100_001).fill({ x: 1 }), {
        schemaVersion: "1",
        columns: [{ name: "x", type: "number" }],
      }),
    { code: "DENSE_ALLOCATION_LIMIT" }
  );
}

// 错误：不支持的编码。
{
  assert.throws(() => {
    encodeDense([], { schemaVersion: "1", columns: [{ name: "x", type: "integer", encoding: "unknown" }] });
  }, { code: "INVALID_DENSE_PROFILE" });
}

// 错误：delta overflow。
{
  const profile = {
    schemaVersion: "1",
    columns: [{ name: "x", type: "integer", encoding: "delta" }],
  };
  assert.throws(() => {
    encodeDense([{ x: Number.MAX_SAFE_INTEGER }, { x: Number.MAX_SAFE_INTEGER + 1 }], profile);
  }, { code: "INVALID_DENSE_VALUE" });
}

console.log("dense-codec.test.mjs passed");
