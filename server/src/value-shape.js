// 对象形状判定的唯一权威。
//
// 这两个谓词此前散在 38 处，而**同名函数在不同文件里语义不同**——这比单纯重复危险：
//
//   - `isRecord` 有 34 份，其中 31 份是宽松判定（非 null 的非数组对象），
//     另外 3 份（pitch-gesture-plan、automation-baseline、ir）额外检查原型链。
//   - `isPlainObject` 有 4 份，情况恰好相反：canonical-json 那份是严格的，
//     envelope-omission / result-status / schema-defs 三份是宽松的。
//
// 于是「isRecord」在一个文件里接受 `new Date()`、在另一个文件里拒绝它，而调用方
// 只看名字无从分辨。这里按**行为**而不是按习惯命名，两个语义各留一个：
//
//   isRecord      —— 宽松：能当键值容器用就行。解析宿主/调用方数据时用它，
//                    因为那些值来自 JSON，原型必然是 Object.prototype。
//   isPlainRecord —— 严格：额外要求原型是 Object.prototype 或 null。
//                    需要排除 Date / Map / 自定义类实例时用它（规范化与序列化路径）。

/**
 * 非 null、非数组的对象。不检查原型链。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * 在 isRecord 之上要求原型是 Object.prototype 或 null，因此 Date / Map / RegExp /
 * 类实例全部被拒绝。规范化、hash、深冻结这类"必须逐字段可枚举"的路径要用这个。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isPlainRecord(value) {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
