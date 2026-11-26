// 런타임 공통 암호 유틸 (WebCrypto). Node 22·Workers·Vercel 어디서나 같은 전역 crypto를 쓴다.
// 토큰은 발급 시에만 평문으로 존재하고, 저장은 항상 SHA-256 해시다.
// 오너 비밀번호만 예외적으로 PBKDF2(솔트+반복)를 쓴다 — 아래 PBKDF2_ITERATIONS 주석 참고.

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function bytesOfHex(h: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function newToken(prefix: string): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `${prefix}_${base64url(bytes)}`;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return hex(new Uint8Array(digest));
}

export const hashToken = sha256Hex;

export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export async function hmacSha256Hex(secret: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
  return hex(new Uint8Array(sig));
}

// ---------- 오너 비밀번호 (PBKDF2) ----------
// Cloudflare Workers는 PBKDF2 반복을 100,000회까지만 허용하고(workerd #1346), Free 플랜은 요청당
// CPU 10 ms다. 실측(100k ≈ 23~34 ms, 30k ≈ 5 ms)을 기준으로 25,000회를 기본값으로 둔다.
// OWASP 권고(600k)보다 약하므로 비밀번호 최소 12자 + 계정/IP 단위 강한 시도 제한으로 보완한다.
// 반복 횟수는 계정 행(pw_iter)에 함께 저장해, 나중에 올려도 기존 계정의 로그인은 그대로 동작한다.
export const PBKDF2_ITERATIONS = 25_000;
export const PBKDF2_MIN_ITERATIONS = 10_000;
export const PBKDF2_MAX_ITERATIONS = 100_000;

/** 16바이트 무작위 솔트(hex). 계정마다 다르다. */
export function newSaltHex(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return hex(bytes);
}

export async function pbkdf2Hex(password: string, saltHex: string, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: bytesOfHex(saltHex), iterations, hash: "SHA-256" },
    key,
    256,
  );
  return hex(new Uint8Array(bits));
}

export async function passwordHash(password: string, saltHex: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  // 도메인 분리(pepper 성격): 같은 비밀번호라도 PBKDF2 입력이 앱 컨텍스트를 포함한다.
  // 이 문자열은 **바꾸지 않는다**. 바꾸면 기존 오너 계정의 저장된 해시와 맞지 않아 로그인이 막힌다.
  // (제품명 Agent Lounge 리브랜딩 때도 옛 이름 그대로 유지)
  return pbkdf2Hex(`agent-common-room/owner\x00${password}`, saltHex, iterations);
}

/** 관리자 재발급용 임시 비밀번호. 사람이 옮겨 적을 수 있는 길이(24자)로 만든다. */
export function newPassword(length = 24): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return base64url(bytes).slice(0, length);
}
