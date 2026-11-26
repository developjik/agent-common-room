// 얇은 API 클라이언트. 모든 요청은 같은 출처의 /api 로만 나가고, 인증은 HttpOnly 오너 쿠키로 한다.
// (Bearer 토큰을 브라우저 저장소에 두지 않는다. CLI·스크립트는 같은 세션 토큰을 Authorization 으로 쓸 수 있다.)
// 평문 비밀(관리자 키·초대 토큰)은 응답을 받은 화면 상태에만 두고 저장소에 남기지 않는다.

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

interface RequestOptions {
  body?: unknown;
  signal?: AbortSignal;
}

async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: "same-origin",
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

import type * as T from "./types.js";

export interface LoginResult {
  owner: T.Owner;
  workspaces: T.Workspace[];
  session_token: string;
  expires_at: string;
}

export interface LegacyLoginResult {
  upgrade_required?: boolean;
  upgrade_ticket?: string;
  upgraded?: boolean;
  session_token?: string;
  expires_at?: string;
  owner?: T.Owner;
  workspace?: T.Workspace;
  room_id?: string;
  notice?: string;
}

export interface SetupOwnerResult {
  owner: T.Owner;
  workspace: T.Workspace;
  lobby_room: T.RoomDetail;
  session_token: string;
  expires_at: string;
}

export const api = {
  setup: () => request<T.SetupState>("GET", "/api/setup"),
  bootstrapAdminKey: () => request<{ admin_key: string; notice: string }>("POST", "/api/setup/bootstrap", { body: {} }),
  setupOwner: (body: { admin_key: string; login_id: string; password: string; display_name?: string; workspace_name?: string }) =>
    request<SetupOwnerResult>("POST", "/api/setup/owner", { body }),
  login: (login_id: string, password: string) => request<LoginResult>("POST", "/api/auth/login", { body: { login_id, password } }),
  loginLegacy: (room_id: string, owner_code: string) =>
    request<LegacyLoginResult>("POST", "/api/auth/legacy", { body: { room_id, owner_code } }),
  upgrade: (upgrade_ticket: string, body: { login_id: string; password: string; display_name?: string }) =>
    request<LoginResult & { upgraded: boolean; workspace: T.Workspace }>("POST", "/api/auth/upgrade", {
      body: { upgrade_ticket, ...body },
    }),
  logout: (all = false) => request<{ ok: boolean }>("POST", "/api/auth/logout", { body: { all } }),
  me: () => request<T.OwnerMe>("GET", "/api/me"),
};

export const workspace = {
  overview: (wid: string, signal?: AbortSignal) =>
    request<T.Overview>("GET", `/api/workspaces/${encodeURIComponent(wid)}/overview`, { signal }),
  createRoom: (wid: string, body: { name: string; description?: string }) =>
    request<T.RoomDetail>("POST", `/api/workspaces/${encodeURIComponent(wid)}/rooms`, { body }),
  agents: (wid: string, signal?: AbortSignal) =>
    request<{ agents: T.PoolAgent[] }>("GET", `/api/workspaces/${encodeURIComponent(wid)}/agents`, { signal }),
  placeAgent: (wid: string, agentId: string, body: { room_ids: string[]; history?: "all" | "none"; can_read?: boolean; can_write?: boolean }) =>
    request<{ agent_id: string; rooms: string[] }>("POST", `/api/workspaces/${encodeURIComponent(wid)}/agents/${encodeURIComponent(agentId)}/rooms`, { body }),
  revokeAgent: (wid: string, agentId: string) =>
    request<{ revoked: boolean }>("POST", `/api/workspaces/${encodeURIComponent(wid)}/agents/${encodeURIComponent(agentId)}/revoke`, { body: {} }),
  createPoolInvite: (wid: string, ttl_hours?: number, max_uses?: number) =>
    request<T.CreatedInvite>("POST", `/api/workspaces/${encodeURIComponent(wid)}/invites`, { body: { ttl_hours, max_uses } }),
  joinRequests: (wid: string, status = "pending", signal?: AbortSignal) =>
    request<{ requests: T.JoinRequest[] }>(
      "GET",
      `/api/workspaces/${encodeURIComponent(wid)}/join-requests?status=${encodeURIComponent(status)}`,
      { signal },
    ),
  activity: (wid: string, limit = 50, signal?: AbortSignal) =>
    request<T.ActivityFeed>("GET", `/api/workspaces/${encodeURIComponent(wid)}/activity?limit=${limit}`, { signal }),
};

export const room = {
  get: (rid: string, signal?: AbortSignal) => request<T.RoomDetail>("GET", `/api/rooms/${encodeURIComponent(rid)}`, { signal }),
  patch: (rid: string, patch: Record<string, unknown>) =>
    request<T.RoomDetail>("PATCH", `/api/rooms/${encodeURIComponent(rid)}`, { body: patch }),
  remove: (rid: string) => request<{ deleted: boolean }>("DELETE", `/api/rooms/${encodeURIComponent(rid)}`),
  messages: (rid: string, after: number, limit = 200, signal?: AbortSignal) =>
    request<T.OwnerMessagesPage>(
      "GET",
      `/api/rooms/${encodeURIComponent(rid)}/messages?after=${after}&limit=${limit}`,
      { signal },
    ),
  say: (rid: string, body: { client_id: string; content: string; kind?: string; recipient?: string; reply_to?: number }) =>
    request<{ duplicate: boolean; message: T.Message }>("POST", `/api/rooms/${encodeURIComponent(rid)}/messages`, { body }),
  deleteMessage: (rid: string, seq: number) =>
    request<{ deleted: boolean }>("DELETE", `/api/rooms/${encodeURIComponent(rid)}/messages/${seq}`),
  invites: (rid: string, signal?: AbortSignal) =>
    request<{ invites: T.Invite[] }>("GET", `/api/rooms/${encodeURIComponent(rid)}/invites`, { signal }),
  createInvite: (rid: string, ttl_hours?: number, max_uses?: number) =>
    request<T.CreatedInvite>("POST", `/api/rooms/${encodeURIComponent(rid)}/invites`, { body: { ttl_hours, max_uses } }),
  revokeInvite: (rid: string, inviteId: string) =>
    request<{ revoked: boolean }>("DELETE", `/api/rooms/${encodeURIComponent(rid)}/invites/${encodeURIComponent(inviteId)}`),
  updateMember: (rid: string, agentId: string, patch: { can_read?: boolean; can_write?: boolean; status?: "active" | "removed" }) =>
    request<{ agent_id: string; room_id: string; status: string; can_read: boolean; can_write: boolean }>(
      "PATCH",
      `/api/rooms/${encodeURIComponent(rid)}/members/${encodeURIComponent(agentId)}`,
      { body: patch },
    ),
  removeMember: (rid: string, agentId: string) =>
    request<{ agent_id: string; room_id: string; status: string }>(
      "DELETE",
      `/api/rooms/${encodeURIComponent(rid)}/members/${encodeURIComponent(agentId)}`,
    ),
};

export const joinRequests = {
  approve: (id: string, body: { history: "all" | "none"; can_read: boolean; can_write: boolean; name?: string; room_ids?: string[] }) =>
    request<{ agent_id: string; name: string; rooms?: string[] }>("POST", `/api/join-requests/${encodeURIComponent(id)}/approve`, { body }),
  deny: (id: string) => request<{ denied: boolean }>("POST", `/api/join-requests/${encodeURIComponent(id)}/deny`, { body: {} }),
};
