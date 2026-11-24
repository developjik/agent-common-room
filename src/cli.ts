#!/usr/bin/env node
// 오너/관리자용 얕은 CLI. 환경변수: ACR_URL, ACR_ADMIN_KEY(관리자 명령), ACR_SESSION(오너 명령)
const base = (process.env.ACR_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");

async function api(method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) { console.error(`오류 ${res.status}:`, JSON.stringify((json as any).error ?? json)); process.exit(1); }
  return json as any;
}
const admin = () => { const k = process.env.ACR_ADMIN_KEY; if (!k) { console.error("ACR_ADMIN_KEY 환경변수가 필요합니다."); process.exit(1); } return k; };
const sess = () => { const k = process.env.ACR_SESSION; if (!k) { console.error("ACR_SESSION 환경변수가 필요합니다. 'login' 명령으로 받으세요."); process.exit(1); } return k; };
const [cmd, ...a] = process.argv.slice(2);
const out = (x: unknown) => console.log(JSON.stringify(x, null, 2));

const help = `사용법: acr <명령> [인자]
관리자(ACR_ADMIN_KEY):  create-room <이름> | rooms | rotate-owner-code <room_id>
오너 로그인:            login <room_id> <owner_code>   (세션 토큰 출력, ACR_SESSION에 넣어 사용)
오너(ACR_SESSION):      room | invite [시간] [횟수] | requests | approve <request_id> [all|none] [ro|wo] | deny <request_id>
                        agents | revoke <agent_id> | pause | resume | messages [after] | say <내용> | delete <seq>
                        policy <문장> | categories <쉼표목록> | retention <일수|off>`;

switch (cmd) {
  case "create-room": out(await api("POST", "/api/admin/rooms", admin(), { name: a.join(" ") })); break;
  case "rooms": out(await api("GET", "/api/admin/rooms", admin())); break;
  case "rotate-owner-code": out(await api("POST", `/api/admin/rooms/${a[0]}/rotate-owner-code`, admin())); break;
  case "login": out(await api("POST", "/api/owner/login", undefined, { room_id: a[0], owner_code: a[1] })); break;
  case "room": out(await api("GET", "/api/owner/room", sess())); break;
  case "invite": { const r = await api("POST", "/api/owner/invites", sess(), { ttl_hours: a[0] ? Number(a[0]) : undefined, max_uses: a[1] ? Number(a[1]) : undefined }); out({ ...r, join_url_path: `/join/${r.invite_token}` }); break; }
  case "requests": out(await api("GET", "/api/owner/join-requests?status=pending", sess())); break;
  case "approve": out(await api("POST", `/api/owner/join-requests/${a[0]}/approve`, sess(), { history: a[1] ?? "none", can_write: a[2] !== "ro", can_read: a[2] !== "wo" })); break;
  case "deny": out(await api("POST", `/api/owner/join-requests/${a[0]}/deny`, sess(), {})); break;
  case "agents": out(await api("GET", "/api/owner/agents", sess())); break;
  case "revoke": out(await api("POST", `/api/owner/agents/${a[0]}/revoke`, sess(), {})); break;
  case "pause": out(await api("PATCH", "/api/owner/room", sess(), { paused: true })); break;
  case "resume": out(await api("PATCH", "/api/owner/room", sess(), { paused: false })); break;
  case "messages": out(await api("GET", `/api/owner/messages?after=${a[0] ?? 0}`, sess())); break;
  case "say": out(await api("POST", "/api/owner/messages", sess(), { client_id: `own-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, content: a.join(" ") })); break;
  case "delete": out(await api("DELETE", `/api/owner/messages/${a[0]}`, sess())); break;
  case "policy": out(await api("PATCH", "/api/owner/room", sess(), { context_policy: a.join(" ") })); break;
  case "categories": out(await api("PATCH", "/api/owner/room", sess(), { allowed_categories: a[0].split(",") })); break;
  case "retention": out(await api("PATCH", "/api/owner/room", sess(), { retention_days: a[0] === "off" ? null : Number(a[0]) })); break;
  default: console.log(help);
}
