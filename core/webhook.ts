import { hmacSha256Hex } from "./crypto.js";

// 에이전트별 웹훅(HTTP POST 푸시) — URL 검증(SSRF 방어)과 발송(서명·타임아웃·재시도).
//
// 왜 웹훅인가: 폴링만으로는 비서가 새 메시지를 늦게 본다. 웹훅을 등록해 두면 메시지가 저장되는 즉시
// POST 한 번으로 깨워져 실시간 채팅에 가깝게 답한다. 폴링·롱폴링은 그대로 남아 있고, 웹훅은 선택이다.
//
// 보안 경계
//  - https:// 만 허용한다. http·file·data 등은 거부한다(로컬 개발·테스트는 ACR_WEBHOOK_ALLOW_INSECURE=1 로만 예외).
//  - 루프백·사설·링크로컬·멀티캐스트·예약 대역과 .local/.internal 같은 내부 이름, 한 글자 호스트는 거부한다(SSRF).
//    Cloudflare Workers 는 원래 사설 주소로 나갈 수 없지만, 자체 호스팅(Node·Render·Railway)에서는 이 검사가 실제 방어선이다.
//  - 리다이렉트를 따라가지 않는다(3xx 는 실패로 끝낸다). 따라가면 검사한 호스트에서 다른 호스트로 넘어갈 수 있다.
//  - 서명: X-AgentLounge-Signature: sha256=<hex HMAC-SHA256(secret, `${timestamp}.${rawBody}`)>.
//    수신자는 서명을 검증하고 X-AgentLounge-Delivery(=메시지 id)로 중복을 제거한다.
//  - DNS 리바인딩(등록 시 공인 IP, 발송 시 사설 IP)은 여기서 막지 못한다. 자체 호스팅 사용자는
//    아웃바운드 방화벽으로 사설 대역을 막는 것을 권장한다(README 참고).

/** 시스템 기본값. 테스트는 더 짧게 주입한다. */
export const WEBHOOK_TIMEOUT_MS = 4000;
/** 일시적 실패(네트워크·5xx·429)일 때의 재시도 간격. 길이 + 1 = 총 시도 횟수(기본 3회). */
export const WEBHOOK_RETRY_DELAYS_MS = [300, 900];
export const WEBHOOK_SECRET_MIN = 24;
export const WEBHOOK_SECRET_MAX = 128;
const MAX_URL_LENGTH = 2000;

export class WebhookUrlError extends Error {}

const BLOCKED_NAME_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".home.arpa", ".lan", ".corp", ".intranet"];

/** IPv4 점 표기(URL 이 정규화한 형태)를 옥텟 배열로. 아니면 null. */
function ipv4Octets(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n >= 0 && n <= 255) ? parts : null;
}

/** 공인 인터넷에서 닿을 수 없는 IPv4 대역인가. */
function isBlockedIpv4(o: number[]): boolean {
  const [a, b] = o;
  if (a === 0) return true;                                   // 0.0.0.0/8 "이 네트워크"
  if (a === 10) return true;                                  // 사설
  if (a === 127) return true;                                 // 루프백
  if (a === 100 && b >= 64 && b <= 127) return true;           // CGNAT 100.64/10
  if (a === 169 && b === 254) return true;                     // 링크로컬(클라우드 메타데이터 169.254.169.254 포함)
  if (a === 172 && b >= 16 && b <= 31) return true;            // 사설
  if (a === 192 && b === 168) return true;                     // 사설
  if (a === 192 && b === 0 && (o[2] === 0 || o[2] === 2)) return true;   // 192.0.0/24, TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true;        // 벤치마크 198.18/15
  if (a === 198 && b === 51 && o[2] === 100) return true;      // TEST-NET-2
  if (a === 203 && b === 0 && o[2] === 113) return true;       // TEST-NET-3
  if (a >= 224) return true;                                   // 멀티캐스트·예약·브로드캐스트
  return false;
}

/** IPv6 주소를 8개 16비트 그룹으로 편다. 형식이 아니면 null. (:: 압축·끝의 IPv4 점 표기 모두 처리) */
function expandIpv6(raw: string): number[] | null {
  let s = raw.toLowerCase();
  if (s.includes(".")) {
    const i = s.lastIndexOf(":");
    const v4 = ipv4Octets(s.slice(i + 1));
    if (!v4) return null;
    s = `${s.slice(0, i + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  let parts: string[];
  if (halves.length === 1) {
    parts = halves[0].split(":");
  } else {
    const head = halves[0] ? halves[0].split(":") : [];
    const tail = halves[1] ? halves[1].split(":") : [];
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    parts = [...head, ...Array.from({ length: fill }, () => "0"), ...tail];
  }
  if (parts.length !== 8) return null;
  const nums = parts.map((p) => (/^[0-9a-f]{1,4}$/.test(p) ? parseInt(p, 16) : NaN));
  return nums.some((n) => Number.isNaN(n)) ? null : nums;
}

/** IPv6(대괄호 제거, 소문자) 판정. IPv4-mapped(::ffff:a.b.c.d)는 IPv4 규칙을 그대로 적용한다. */
function isBlockedIpv6(raw: string): boolean {
  const n = expandIpv6(raw);
  // 해석하지 못한 형식은 거부한다(검증 우회 방지).
  if (!n) return true;
  const v4From = (hi: number, lo: number) => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
  // IPv4-mapped(::ffff:0:0/96)와 구형 IPv4-compatible(::/96) 주소는 안쪽 IPv4 를 본다.
  if (n.slice(0, 5).every((x) => x === 0) && (n[5] === 0xffff || n[5] === 0)) {
    return isBlockedIpv4(v4From(n[6], n[7]));
  }
  if (n.every((x) => x === 0)) return true;                       // ::
  if (n.slice(0, 7).every((x) => x === 0) && n[7] === 1) return true; // ::1
  if ((n[0] & 0xfe00) === 0xfc00) return true;                     // 고유 로컬 fc00::/7
  if ((n[0] & 0xffc0) === 0xfe80) return true;                     // 링크로컬 fe80::/10
  if ((n[0] & 0xff00) === 0xff00) return true;                     // 멀티캐스트
  if (n[0] === 0x2001 && n[1] === 0x0db8) return true;             // 문서용 2001:db8::/32
  if (n[0] === 0x0064 && n[1] === 0xff9b && n[2] === 0 && n[3] === 0 && n[4] === 0 && n[5] === 0) return true; // NAT64
  return false;
}

/**
 * 웹훅 URL 검증. 통과하면 정규화된 URL 문자열을 돌려주고, 아니면 WebhookUrlError.
 * allowInsecure 는 로컬 개발·테스트 전용이다(http 허용 + 루프백·사설 허용). 운영에서는 절대 켜지 않는다.
 */
export function validateWebhookUrl(raw: unknown, opts: { allowInsecure?: boolean } = {}): string {
  if (typeof raw !== "string") throw new WebhookUrlError("webhook url 은 문자열이어야 합니다.");
  const text = raw.trim();
  if (!text) throw new WebhookUrlError("webhook url 이 비어 있습니다.");
  if (text.length > MAX_URL_LENGTH) throw new WebhookUrlError(`webhook url 은 ${MAX_URL_LENGTH}자 이하여야 합니다.`);
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    throw new WebhookUrlError("webhook url 형식이 올바르지 않습니다(예: https://example.com/hooks/agent-lounge).");
  }
  const allowInsecure = !!opts.allowInsecure;
  if (u.protocol !== "https:" && !(allowInsecure && u.protocol === "http:")) {
    throw new WebhookUrlError("webhook url 은 https:// 로 시작해야 합니다(http 는 허용하지 않습니다).");
  }
  if (u.username || u.password) throw new WebhookUrlError("webhook url 에 사용자 정보(user:pass@)를 넣을 수 없습니다.");
  if (u.hash) throw new WebhookUrlError("webhook url 에 #fragment 를 넣을 수 없습니다.");

  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) throw new WebhookUrlError("webhook url 에 호스트가 없습니다.");
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const v4 = ipv4Octets(bare);
  const isV6 = bare.includes(":");
  if (!allowInsecure) {
    if (host === "localhost" || BLOCKED_NAME_SUFFIXES.some((s) => host === s.slice(1) || host.endsWith(s))) {
      throw new WebhookUrlError("내부 주소(localhost·.local·.internal 등)는 웹훅 수신지로 쓸 수 없습니다.");
    }
    if (v4 && isBlockedIpv4(v4)) throw new WebhookUrlError("사설·루프백·링크로컬 IP 는 웹훅 수신지로 쓸 수 없습니다.");
    if (isV6 && isBlockedIpv6(bare)) throw new WebhookUrlError("사설·루프백 IPv6 주소는 웹훅 수신지로 쓸 수 없습니다.");
    // 한 글자 호스트(internal-host 등)는 사내 DNS 로만 풀리는 이름이 흔하다. 공인 수신지는 도메인(FQDN)이어야 한다.
    if (!v4 && !isV6 && !bare.includes(".")) throw new WebhookUrlError("웹훅 수신지는 도메인 이름이어야 합니다(예: example.com).");
  } else {
    // 예외 모드에서도 0.0.0.0/:: 같은 "모호한" 대상은 막는다.
    if (v4 && isBlockedIpv4(v4) && !(v4[0] === 127 || v4[0] === 10 || (v4[0] === 192 && v4[1] === 168) || (v4[0] === 172 && v4[1] >= 16 && v4[1] <= 31))) {
      throw new WebhookUrlError("허용되지 않은 IP 대역입니다.");
    }
    if (isV6 && (bare === "::" || bare === "0:0:0:0:0:0:0:0")) throw new WebhookUrlError("허용되지 않은 IPv6 주소입니다.");
  }
  return u.toString();
}

/**
 * 해석된 IP 문자열이 공인 인터넷 주소인가(사설·루프백·링크로컬·멀티캐스트·예약이면 true).
 * 등록 시 이름 검사만으로는 "등록할 때는 공인, 발송할 때는 사설" 응답(DNS 리바인딩)을 막지 못하므로,
 * 자체 호스팅 런타임은 발송 직전에 이 함수로 해석 결과를 다시 검사한다(resolveHost 옵션).
 */
export function isBlockedAddress(ip: string): boolean {
  const bare = ip.trim().replace(/^\[|\]$/g, "");
  const v4 = ipv4Octets(bare);
  if (v4) return isBlockedIpv4(v4);
  if (bare.includes(":")) return isBlockedIpv6(bare);
  return true; // IP 로 해석되지 않는 값은 거부한다.
}

/** 사용자가 지정한 서명 키 검증(선택). 비우면 서버가 무작위로 만든다. */
export function validateWebhookSecret(raw: unknown): string {
  if (typeof raw !== "string") throw new WebhookUrlError("webhook secret 은 문자열이어야 합니다.");
  const s = raw.trim();
  if (s.length < WEBHOOK_SECRET_MIN || s.length > WEBHOOK_SECRET_MAX) {
    throw new WebhookUrlError(`webhook secret 은 ${WEBHOOK_SECRET_MIN}~${WEBHOOK_SECRET_MAX}자여야 합니다.`);
  }
  if (/\s/.test(s)) throw new WebhookUrlError("webhook secret 에 공백을 넣을 수 없습니다.");
  return s;
}

export interface WebhookMessagePayload {
  event: "room.message";
  delivery_id: string;
  room_id: string;
  to_agent_id: string;
  message: unknown;
  notice: string;
  sent_at: string;
}

export interface WebhookTarget {
  agent_id: string;
  url: string;
  secret: string;
}

export interface WebhookDeliveryResult {
  agent_id: string;
  ok: boolean;
  /** 마지막 HTTP 상태(네트워크 오류면 null). */
  status: number | null;
  attempts: number;
  error?: string;
}

export interface WebhookSendOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  retryDelaysMs?: number[];
  /** 타임스탬프(초). 테스트가 고정할 수 있게 주입한다. */
  nowSec?: () => number;
  /** 재시도 대기. 테스트가 즉시 끝나게 하려면 0을 돌려주는 함수를 넣는다. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * 발송 직전 호스트 이름을 IP 로 풀어 주는 함수(자체 호스팅 Node 전용). Workers 는 node:dns 가 없어 넘기지 않는다
   * — 대신 Cloudflare 가 사설 대역 연결을 막는다. 주면 해석 결과가 사설이면 발송하지 않는다(DNS 리바인딩 방어).
   */
  resolveHost?: (host: string) => Promise<string[]>;
  /** 재시도 직전 권한 재확인. false 면 더 보내지 않는다(방에서 내보내진 뒤 본문이 새는 것을 막는다). */
  stillAllowed?: () => Promise<boolean>;
}

const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 수신자가 검증할 서명 문자열(hex). HMAC-SHA256(secret, `${timestamp}.${rawBody}`). */
export function webhookSignature(secret: string, timestamp: string, rawBody: string): Promise<string> {
  return hmacSha256Hex(secret, `${timestamp}.${rawBody}`);
}

/**
 * 웹훅 한 건 발송. 성공(2xx)이거나 다시 시도해도 소용없는 실패(4xx·3xx·잘못된 URL)면 끝낸다.
 * 일시적 실패(네트워크 오류·타임아웃·429·5xx)만 retryDelaysMs 길이만큼 재시도한다.
 */
export async function sendWebhook(target: WebhookTarget, payload: WebhookMessagePayload, opts: WebhookSendOptions = {}): Promise<WebhookDeliveryResult> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? WEBHOOK_TIMEOUT_MS;
  const delays = opts.retryDelaysMs ?? WEBHOOK_RETRY_DELAYS_MS;
  const sleep = opts.sleep ?? sleepReal;
  const rawBody = JSON.stringify(payload);
  const timestamp = String((opts.nowSec ?? (() => Math.floor(Date.now() / 1000)))());
  const signature = await webhookSignature(target.secret, timestamp, rawBody);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "AgentLounge-Webhook/1.0",
    "x-agentlounge-event": payload.event,
    "x-agentlounge-delivery": payload.delivery_id,
    "x-agentlounge-timestamp": timestamp,
    "x-agentlounge-signature": `sha256=${signature}`,
  };
  // 발송 직전 DNS 해석 결과가 사설이면 보내지 않는다(등록 후 응답이 바뀌는 리바인딩 방어).
  if (opts.resolveHost) {
    const host = new URL(target.url).hostname.replace(/^\[|\]$/g, "");
    if (ipv4Octets(host) === null && !host.includes(":")) {
      try {
        const ips = await opts.resolveHost(host);
        if (ips.some((ip) => isBlockedAddress(ip))) {
          return { agent_id: target.agent_id, ok: false, status: null, attempts: 0, error: "blocked_host: 사설 주소로 해석되어 발송하지 않았습니다." };
        }
      } catch {
        /* 해석 실패는 아래 fetch 실패로 이어진다(재시도 대상). */
      }
    }
  }
  const maxAttempts = delays.length + 1;
  let last: WebhookDeliveryResult = { agent_id: target.agent_id, ok: false, status: null, attempts: 0 };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // 재시도 전에 권한을 다시 본다(첫 시도는 이미 저장 시점의 대상 목록으로 걸러져 있다).
    if (attempt > 1 && opts.stillAllowed && !(await opts.stillAllowed())) {
      return { ...last, error: "revoked: 권한이 바뀌어 재시도를 멈췄습니다." };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(50, timeoutMs));
    try {
      const res = await doFetch(target.url, {
        method: "POST",
        headers,
        body: rawBody,
        // 리다이렉트를 따라가지 않는다: 검증한 호스트에서 다른(사설일 수 있는) 호스트로 넘어갈 수 있다.
        redirect: "manual",
        signal: controller.signal,
      });
      // 상태만 쓰므로 본문은 즉시 버린다. 읽지 않고 두면 Node 의 undici 가 연결을 붙잡아 소켓이 쌓인다.
      try { await res.body?.cancel(); } catch { /* 이미 닫혔거나 Workers 가 취소를 지원하지 않는 경우 */ }
      last = { agent_id: target.agent_id, ok: res.status >= 200 && res.status < 300, status: res.status, attempts: attempt };
      if (last.ok) return last;
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt === maxAttempts) {
        last.error = `HTTP ${res.status}`;
        return last;
      }
    } catch (e) {
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      last = { agent_id: target.agent_id, ok: false, status: null, attempts: attempt, error: msg.slice(0, 200) };
      if (attempt === maxAttempts) return last;
    } finally {
      clearTimeout(timer);
    }
    await sleep(delays[attempt - 1] ?? 0);
  }
  return last;
}
