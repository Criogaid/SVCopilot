import { codedError } from "./coded-error.js";
import { isRecord } from "./value-shape.js";
// Schema-described Dense Codec：只做有界结构转换，不解释音乐语义。
const ALLOWED_TYPES = new Set(["integer", "number", "string", "boolean"]);
const ALLOWED_ENCODINGS = new Set(["delta", "qint", "identity", "dictionary"]);
const PROFILE_KEYS = new Set(["schemaVersion", "kind", "columns", "maxRows"]);
const COLUMN_KEYS = new Set([
  "name",
  "unit",
  "type",
  "encoding",
  "scale",
  "maxError",
  "default",
  "dictionary",
  "nullable",
]);
const ENVELOPE_KEYS = new Set(["encoding", "schemaVersion", "kind", "columns", "points"]);
const MAX_COLUMNS = 64;
const MAX_ROWS = 100_000;
const MAX_CELLS = 2_000_000;

export const AUTOMATION_POINT_DENSE_PROFILE = Object.freeze({
  schemaVersion: "1",
  kind: "automation-points",
  columns: Object.freeze([
    Object.freeze({ name: "localBlick", unit: "blick", type: "integer", encoding: "delta" }),
    Object.freeze({ name: "absoluteBlick", unit: "blick", type: "integer", encoding: "delta" }),
    Object.freeze({ name: "value", type: "number", encoding: "identity" }),
    Object.freeze({ name: "bar", type: "integer", encoding: "delta" }),
    Object.freeze({ name: "beat", type: "integer", encoding: "identity" }),
    Object.freeze({ name: "tickInBeatBlick", unit: "blick", type: "integer", encoding: "identity" }),
    Object.freeze({ name: "numerator", type: "integer", encoding: "identity" }),
    Object.freeze({ name: "denominator", type: "integer", encoding: "identity" }),
  ]),
});

export const NOTE_DENSE_PROFILE = Object.freeze({
  schemaVersion: "1",
  kind: "notes",
  maxRows: 2_000,
  columns: Object.freeze(
    [
      { name: "occurrence", type: "integer" },
      { name: "trackIndex", type: "integer", encoding: "delta" },
      { name: "groupIndex", type: "integer", encoding: "delta" },
      { name: "groupUuid", type: "string", nullable: true },
      { name: "indexInGroup", type: "integer", encoding: "delta" },
      { name: "onsetBlick", unit: "blick", type: "integer", encoding: "delta" },
      { name: "durationBlick", unit: "blick", type: "integer" },
      { name: "endBlick", unit: "blick", type: "integer", encoding: "delta" },
      { name: "absoluteOnsetBlick", unit: "blick", type: "integer", encoding: "delta" },
      { name: "absoluteEndBlick", unit: "blick", type: "integer", encoding: "delta" },
      { name: "pitch", unit: "midi", type: "number" },
      { name: "lyrics", type: "string" },
      { name: "phonemesOverride", type: "string" },
      { name: "languageOverride", type: "string" },
      { name: "detuneCents", unit: "cent", type: "number" },
      { name: "musical.bar", type: "integer", encoding: "delta" },
      { name: "musical.beat", type: "integer" },
      { name: "musical.tickInBeatBlick", unit: "blick", type: "integer" },
      { name: "musical.numerator", type: "integer" },
      { name: "musical.denominator", type: "integer" },
      { name: "restBeforeBlick", unit: "blick", type: "integer", nullable: true },
      { name: "restAfterBlick", unit: "blick", type: "integer", nullable: true },
      { name: "prevLyrics", type: "string", nullable: true },
      { name: "nextLyrics", type: "string", nullable: true },
    ].map((column) => Object.freeze(column))
  ),
});

export function encodeDense(rows, profile) {
  const normalized = validateProfile(profile);
  if (!Array.isArray(rows)) throw codedError("INVALID_DENSE_ROWS", "rows must be an array");
  assertAllocation(rows.length, normalized.columns.length, normalized.maxRows);

  const accumulators = Object.create(null);
  const points = rows.map((row, rowIndex) => {
    if (!isRecord(row)) {
      throw codedError("INVALID_DENSE_ROWS", `rows[${rowIndex}] must be an object`);
    }
    const allowed = new Set(normalized.columns.map((column) => column.name));
    const unknown = Object.keys(row).filter((name) => !allowed.has(name));
    if (unknown.length > 0) {
      throw codedError(
        "INVALID_DENSE_ROWS",
        `rows[${rowIndex}] contains fields outside the profile: ${unknown.join(", ")}`
      );
    }
    return normalized.columns.map((column) => {
      const value = Object.hasOwn(row, column.name) ? row[column.name] : column.default;
      if (value === undefined) {
        throw codedError(
          "INVALID_DENSE_VALUE",
          `row ${rowIndex} column ${column.name}: value is required`
        );
      }
      return encodeValue(value, column, rowIndex, accumulators);
    });
  });

  return {
    encoding: "dense-table-v1",
    schemaVersion: normalized.schemaVersion,
    ...(normalized.kind ? { kind: normalized.kind } : {}),
    columns: normalized.columns.map((column) => ({ ...column })),
    points,
  };
}

export function decodeDense(envelope) {
  if (!isRecord(envelope)) {
    throw codedError("INVALID_DENSE_ENVELOPE", "envelope must be an object");
  }
  assertKnownKeys(envelope, ENVELOPE_KEYS, "envelope", "INVALID_DENSE_ENVELOPE");
  if (envelope.encoding !== "dense-table-v1") {
    throw codedError("INVALID_DENSE_ENVELOPE", `unsupported encoding: ${envelope.encoding}`);
  }
  const profile = validateProfile({
    schemaVersion: envelope.schemaVersion,
    ...(envelope.kind !== undefined ? { kind: envelope.kind } : {}),
    columns: envelope.columns,
  });
  validateTupleRows(envelope.points, profile);
  const accumulators = Object.create(null);
  return envelope.points.map((tuple, rowIndex) =>
    profile.columns.reduce((row, column, columnIndex) => {
      row[column.name] = decodeValue(tuple[columnIndex], column, rowIndex, accumulators);
      return row;
    }, {})
  );
}

function validateProfile(profile) {
  if (!isRecord(profile)) {
    throw codedError("INVALID_DENSE_PROFILE", "profile must be an object");
  }
  assertKnownKeys(profile, PROFILE_KEYS, "profile", "INVALID_DENSE_PROFILE");
  if (typeof profile.schemaVersion !== "string" || !profile.schemaVersion) {
    throw codedError("INVALID_DENSE_PROFILE", "profile.schemaVersion must be a non-empty string");
  }
  if (profile.kind !== undefined && (typeof profile.kind !== "string" || !profile.kind)) {
    throw codedError("INVALID_DENSE_PROFILE", "profile.kind must be a non-empty string");
  }
  if (
    !Array.isArray(profile.columns) ||
    profile.columns.length === 0 ||
    profile.columns.length > MAX_COLUMNS
  ) {
    throw codedError(
      "INVALID_DENSE_PROFILE",
      `profile.columns must contain 1-${MAX_COLUMNS} columns`
    );
  }
  const names = new Set();
  const columns = profile.columns.map((column, index) => {
    if (!isRecord(column)) {
      throw codedError("INVALID_DENSE_PROFILE", `columns[${index}] must be an object`);
    }
    assertKnownKeys(column, COLUMN_KEYS, `columns[${index}]`, "INVALID_DENSE_PROFILE");
    if (typeof column.name !== "string" || !column.name) {
      throw codedError("INVALID_DENSE_PROFILE", `columns[${index}].name must be non-empty`);
    }
    if (names.has(column.name)) {
      throw codedError("INVALID_DENSE_PROFILE", `duplicate column name: ${column.name}`);
    }
    names.add(column.name);
    if (!ALLOWED_TYPES.has(column.type)) {
      throw codedError("INVALID_DENSE_PROFILE", `unsupported type for ${column.name}`);
    }
    const encoding = column.encoding ?? "identity";
    if (!ALLOWED_ENCODINGS.has(encoding)) {
      throw codedError("INVALID_DENSE_PROFILE", `unsupported encoding for ${column.name}`);
    }
    validateColumnEncoding({ ...column, encoding });
    if (column.nullable !== undefined && typeof column.nullable !== "boolean") {
      throw codedError("INVALID_DENSE_PROFILE", `column ${column.name}: nullable must be boolean`);
    }
    if (column.default !== undefined) validateScalar(column.default, column, "default");
    return { ...column, encoding };
  });
  const maxRows = profile.maxRows ?? MAX_ROWS;
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > MAX_ROWS) {
    throw codedError("INVALID_DENSE_PROFILE", `profile.maxRows must be 1-${MAX_ROWS}`);
  }
  return {
    schemaVersion: profile.schemaVersion,
    kind: profile.kind,
    columns,
    maxRows,
  };
}

function validateColumnEncoding(column) {
  if (column.encoding === "delta" && column.type !== "integer") {
    throw codedError("INVALID_DENSE_PROFILE", `column ${column.name}: delta requires integer`);
  }
  if (column.encoding === "qint") {
    if (column.type !== "number") {
      throw codedError("INVALID_DENSE_PROFILE", `column ${column.name}: qint requires number`);
    }
    if (column.unit === "blick" || /(?:blick|index|count)$/i.test(column.name)) {
      throw codedError("INVALID_DENSE_PROFILE", `column ${column.name}: exact fields cannot use qint`);
    }
    if (!Number.isFinite(column.scale) || column.scale <= 0) {
      throw codedError("INVALID_DENSE_PROFILE", `column ${column.name}: qint requires scale > 0`);
    }
    if (!Number.isFinite(column.maxError) || column.maxError < column.scale / 2) {
      throw codedError(
        "INVALID_DENSE_PROFILE",
        `column ${column.name}: qint requires maxError >= scale/2`
      );
    }
  }
  if (column.encoding === "dictionary") {
    if (column.type !== "string") {
      throw codedError("INVALID_DENSE_PROFILE", `column ${column.name}: dictionary requires string`);
    }
    if (
      !Array.isArray(column.dictionary) ||
      column.dictionary.length === 0 ||
      !column.dictionary.every((value) => typeof value === "string") ||
      new Set(column.dictionary).size !== column.dictionary.length
    ) {
      throw codedError(
        "INVALID_DENSE_PROFILE",
        `column ${column.name}: dictionary must contain unique strings`
      );
    }
  }
}

function validateTupleRows(rows, profile) {
  if (!Array.isArray(rows)) throw codedError("INVALID_DENSE_ROWS", "points must be an array");
  assertAllocation(rows.length, profile.columns.length, profile.maxRows);
  for (let index = 0; index < rows.length; index += 1) {
    if (!Array.isArray(rows[index]) || rows[index].length !== profile.columns.length) {
      throw codedError(
        "INVALID_DENSE_ROWS",
        `points[${index}] must be a tuple of length ${profile.columns.length}`
      );
    }
  }
}

function encodeValue(value, column, rowIndex, accumulators) {
  validateScalar(value, column, `row ${rowIndex}`);
  if (value === null) return null;
  if (column.encoding === "qint") {
    const encoded = Math.round(value / column.scale);
    if (!Number.isSafeInteger(encoded)) {
      throw codedError("INVALID_DENSE_VALUE", `row ${rowIndex} column ${column.name}: qint overflow`);
    }
    return encoded;
  }
  if (column.encoding === "delta") {
    const delta = value - (accumulators[column.name] ?? 0);
    if (!Number.isSafeInteger(delta)) {
      throw codedError("INVALID_DENSE_VALUE", `row ${rowIndex} column ${column.name}: delta overflow`);
    }
    accumulators[column.name] = value;
    return delta;
  }
  if (column.encoding === "dictionary") {
    const index = column.dictionary.indexOf(value);
    if (index < 0) {
      throw codedError(
        "INVALID_DENSE_VALUE",
        `row ${rowIndex} column ${column.name}: value is not in dictionary`
      );
    }
    return index;
  }
  return value;
}

function decodeValue(value, column, rowIndex, accumulators) {
  if (value === null) {
    validateScalar(value, column, `row ${rowIndex}`);
    return null;
  }
  if (column.encoding === "qint") {
    if (!Number.isSafeInteger(value)) {
      throw codedError("INVALID_DENSE_VALUE", `row ${rowIndex} column ${column.name}: invalid qint`);
    }
    return value * column.scale;
  }
  if (column.encoding === "delta") {
    if (!Number.isSafeInteger(value)) {
      throw codedError("INVALID_DENSE_VALUE", `row ${rowIndex} column ${column.name}: invalid delta`);
    }
    const current = (accumulators[column.name] ?? 0) + value;
    if (!Number.isSafeInteger(current)) {
      throw codedError(
        "INVALID_DENSE_VALUE",
        `row ${rowIndex} column ${column.name}: delta accumulated overflow`
      );
    }
    accumulators[column.name] = current;
    return current;
  }
  if (column.encoding === "dictionary") {
    if (!Number.isSafeInteger(value) || value < 0 || value >= column.dictionary.length) {
      throw codedError(
        "INVALID_DENSE_VALUE",
        `row ${rowIndex} column ${column.name}: dictionary index out of bounds`
      );
    }
    return column.dictionary[value];
  }
  validateScalar(value, column, `row ${rowIndex}`);
  return value;
}

function validateScalar(value, column, label) {
  if (value === null && column.nullable === true) return;
  const valid =
    column.type === "integer"
      ? Number.isSafeInteger(value)
      : column.type === "number"
        ? typeof value === "number" && Number.isFinite(value)
        : typeof value === column.type;
  if (!valid) {
    throw codedError(
      "INVALID_DENSE_VALUE",
      `${label} column ${column.name}: expected ${column.type}`
    );
  }
}

function assertAllocation(rows, columns, maxRows) {
  if (rows > maxRows || rows > MAX_ROWS || rows * columns > MAX_CELLS) {
    throw codedError(
      "DENSE_ALLOCATION_LIMIT",
      `dense table ${rows}x${columns} exceeds configured allocation limits`
    );
  }
}

function assertKnownKeys(value, allowed, label, code) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw codedError(code, `${label} contains unknown fields: ${unknown.join(", ")}`);
  }
}
