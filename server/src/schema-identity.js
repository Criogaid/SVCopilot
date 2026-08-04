import { createHash } from "node:crypto";

// hash 对应服务实际发送的 minified JSON 字节；客户端只比较它，不自行重建序列化顺序。
export function jsonContentHash(value) {
  return `sha256_${createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")}`;
}
