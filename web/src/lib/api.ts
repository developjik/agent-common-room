// 얇은 API 클라이언트. 모든 요청은 같은 출처의 /api 로만 나가고, 토큰은 Authorization 헤더로만 보낸다.
// 응답의 평문 비밀(관리자 키·초대 토큰·세션)은 화면 상태에만 두고 저장소에 남기지 않는다.

const SESSION_KEY = "acr_session";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export function readSession(): string {
  try {
    return sessionStorage.getItem(SESSION_KEY) ?? "";
  } catch {
    return "";
  }
}

export function writeSession(token: string): void {
  try {
    if (token) sessionStorage.setItem(SESSION_KEY, token);
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* 저장소가 막힌 브라우저에서는 이 탭의 메모리 상태만 쓴다. */
  }
}

interface RequestOptions {
  token?: string;
  body?: unknown;
  signal?: AbortSignal;
}

async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw e;
    throw new ApiError(0, "network", "서버에 연결하지 못했습니다. 잠시 뒤 다시 시도하세요.");
  }
  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? "http_" + res.status, err?.message ?? `요청을 처리하지 못했습니다 (${res.status})`);
  }
  return json as T;
}

export const api = {
  setup: () => request<import("./types.js").SetupState>("GET", "/api/setup"),
  bootstrapAdminKey: () =>
    request<{ admin_key: string; notice: string }>("POST", "/api/setup/bootstrap", { body: {} }),
  login: (room_id: string, owner_code: string) =>
    request<{ session_token: string; expires_at: string; room_id: string }>("POST", "/api/owner/login", {
      body: { room_id, owner_code },
    }),
  logout: (token: string) => request<{ ok: boolean }>("POST", "/api/owner/logout", { token }),
  createRoom: (adminKey: string, name: string, description: string) =>
    request<{ room_id: string; name: string; owner_code: string; created_at: string }>("POST", "/api/admin/rooms", {
      token: adminKey,
      body: { name, description },
    }),
  createInvite: (token: string, ttl_hours?: number, max_uses?: number) =>
    request<{ invite_id: string; invite_token: string; expires_at: string; max_uses: number }>(
      "POST",
      "/api/owner/invites",
      { token, body: { ttl_hours, max_uses } },
    ),
};

export const owner = {
  room: (token: string, signal?: AbortSignal) =>
    request<import("./types.js").RoomOwner>("GET", "/api/owner/room", { token, signal }),
  messages: (token: string, after: number, limit = 200, signal?: AbortSignal) =>
    request<import("./types.js").OwnerMessagesPage>(
      "GET",
      `/api/owner/messages?after=${after}&limit=${limit}`,
      { token, signal },
    ),
  agents: (token: string, signal?: AbortSignal) =>
    request<{ agents: import("./types.js").Agent[] }>("GET", "/api/owner/agents", { token, signal }),
  requests: (token: string, signal?: AbortSignal) =>
    request<{ requests: import("./types.js").JoinRequest[] }>(
      "GET",
      "/api/owner/join-requests?status=pending",
      { token, signal },
    ),
  invites: (token: string, signal?: AbortSignal) =>
    request<{ invites: import("./types.js").Invite[] }>("GET", "/api/owner/invites", { token, signal }),
  approve: (token: string, id: string, body: { history: "all" | "none"; can_read: boolean; can_write: boolean }) =>
    request<{ agent_id: string; name: string }>("POST", `/api/owner/join-requests/${id}/approve`, { token, body }),
  deny: (token: string, id: string) =>
    request<{ denied: boolean }>("POST", `/api/owner/join-requests/${id}/deny`, { token, body: {} }),
  revokeAgent: (token: string, id: string) =>
    request<{ revoked: boolean }>("POST", `/api/owner/agents/${id}/revoke`, { token, body: {} }),
  createInvite: (token: string, ttl_hours?: number, max_uses?: number) =>
    request<{ invite_id: string; invite_token: string; expires_at: string; max_uses: number }>(
      "POST",
      "/api/owner/invites",
      { token, body: { ttl_hours, max_uses } },
    ),
  revokeInvite: (token: string, id: string) =>
    request<{ revoked: boolean }>("DELETE", `/api/owner/invites/${id}`, { token }),
  patchRoom: (token: string, patch: Record<string, unknown>) =>
    request<import("./types.js").RoomOwner>("PATCH", "/api/owner/room", { token, body: patch }),
  say: (token: string, body: { client_id: string; content: string; kind?: string; recipient?: string; reply_to?: number }) =>
    request<{ duplicate: boolean; message: import("./types.js").Message }>("POST", "/api/owner/messages", {
      token,
      body,
    }),
  deleteMessage: (token: string, seq: number) =>
    request<{ deleted: boolean }>("DELETE", `/api/owner/messages/${seq}`, { token }),
};
