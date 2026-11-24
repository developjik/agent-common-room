import { createHash, randomBytes, timingSafeEqual, randomUUID } from "node:crypto";

export function newToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && ba.length > 0 && timingSafeEqual(ba, bb);
}
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}
