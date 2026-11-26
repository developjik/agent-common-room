// 서버(core/service.ts)가 돌려주는 모양 그대로의 타입. 화면은 여기 있는 것만 말한다.

export type Runtime = string;

export interface SetupState {
  admin_key_configured: boolean;
  bootstrap_allowed: boolean;
  needs_owner?: boolean;
  /** 아직 계정에 연결되지 않은 기존 방(로비) 수. */
  legacy_rooms?: number;
  schema_version: number;
  runtime?: Runtime;
}

export interface Owner {
  id: string;
  login_id: string;
  display_name: string;
  created_at: string;
  last_login_at: string | null;
}

export interface Workspace {
  id: string;
  name: string;
  created_at: string;
  lobby_room_id: string | null;
  legacy: boolean;
}

export interface OwnerMe {
  owner: Owner;
  workspaces: Workspace[];
}

export interface RateLimit {
  count: number;
  window_seconds: number;
}

export interface PauseInfo {
  reason: string;
  actor: "auto" | "owner" | string;
  actor_id: string | null;
  at: string | null;
}

/** 방 상세(오너). /api/rooms/:rid 와 /api/workspaces/:wid/rooms 응답. */
export interface RoomDetail {
  id: string;
  name: string;
  description: string;
  paused: boolean;
  pause_reason: string | null;
  context_policy: string;
  allowed_categories: string[];
  content_filter: boolean;
  retention_days: number | null;
  max_chain_depth: number;
  rate_limit: RateLimit;
  last_seq: number;
  created_at: string;
  workspace_id: string | null;
  kind: "lobby" | "room" | string;
  last_message_at: string | null;
  last_preview: string | null;
  pause_info: PauseInfo | null;
  members: RoomMember[];
}

export interface RoomMember {
  agent_id: string;
  name: string;
  product_self_declared: string;
  status: "active" | "invited" | "removed" | string;
  agent_status: "active" | "unclaimed" | "revoked" | string;
  can_read: boolean;
  can_write: boolean;
  history_floor_seq: number;
  fetched_seq: number;
  acked_seq: number;
  last_seen: string | null;
}

export type RoomHealth = "ok" | "idle" | "needs_input" | "paused";

/** 화면이 쓰는 방 구성원(방 상세 members + 신원 상태를 합친 모양). */
export interface Agent {
  id: string;
  name: string;
  product_self_declared: string;
  status: "active" | "unclaimed" | "revoked" | string;
  can_read: boolean;
  can_write: boolean;
  history_floor_seq: number;
  fetched_seq: number;
  acked_seq: number;
  last_seen: string | null;
}

/** 관제실 방 타일. GET /api/workspaces/:wid/overview 의 rooms[] */
export interface RoomCard {
  id: string;
  name: string;
  kind: "lobby" | "room" | string;
  paused: boolean;
  pause_reason: string | null;
  member_count: number;
  unread: number;
  last_seq: number;
  last_message_at: string | null;
  last_preview: string | null;
  last_sender: { name: string; type: string } | null;
  health: RoomHealth;
  /** 내가 아직 읽지 않은 답할 것(질문·나에게 온 글·시스템 안내)이 있는 방. "답변 필요 n곳" 과 같은 술어. */
  needs_attention?: boolean;
}

/** 개요의 비서 요약(방 이름 대신 방 ID 목록). */
export interface AgentSummary {
  id: string;
  name: string;
  product: string;
  status: "active" | "unclaimed" | "revoked" | string;
  last_seen: string | null;
  rooms: string[];
}

export interface Overview {
  workspace: { id: string; name: string; lobby_room_id: string | null };
  counts: { needs_you: number; /** 같은 기준(안 읽은 질문·나에게 온 글·시스템 안내)의 고유 방 수 */ needs_you_rooms: number; unread_rooms: number; paused_rooms: number };
  rooms: RoomCard[];
  agents: AgentSummary[];
  pending_requests: number;
}

/** 비서실(중앙 풀)의 비서. GET /api/workspaces/:wid/agents */
export interface PoolAgent {
  id: string;
  name: string;
  product_self_declared: string;
  status: "active" | "unclaimed" | "revoked" | string;
  last_seen: string | null;
  created_at: string;
  rooms: { room_id: string; room_name: string; status: string }[];
}

export interface JoinRequest {
  id: string;
  display_name: string;
  product_self_declared: string;
  note: string;
  status: string;
  claimed: boolean;
  agent_id: string | null;
  created_at: string;
  room_id?: string;
  room_name?: string;
  kind?: "room" | "pool" | string;
  existing_agent?: boolean;
}

export interface Invite {
  id: string;
  created_at: string;
  expires_at: string;
  max_uses: number;
  uses: number;
  active: boolean;
  kind?: "room" | "pool" | string;
}

export interface CreatedInvite {
  invite_id: string;
  invite_token: string;
  expires_at: string;
  max_uses: number;
  kind: "room" | "pool" | string;
}

export type MessageKind = "message" | "question" | "answer" | "status";

export interface DeliveryState {
  state: "sent" | "fetched" | "acked" | "replied";
}

export interface Message {
  seq: number;
  id: string;
  client_id: string | null;
  kind: MessageKind | string;
  sender: { type: "owner" | "agent" | "system" | string; id: string; name: string };
  recipient: { id: string; name: string } | null;
  reply_to: number | null;
  content: string | null;
  deleted: boolean;
  depth: number;
  context_category: string;
  created_at: string;
  delivery: DeliveryState | null;
}

export interface OwnerMessagesPage {
  messages: Message[];
  has_more: boolean;
}

/** 통합 인박스 항목. GET /api/workspaces/:wid/activity */
export interface ActivityItem {
  room_id: string;
  room_name: string;
  room_kind: string;
  /** 방별 읽음 위치 이후인가(개요 counts.needs_you 와 같은 기준). */
  unread?: boolean;
  message: Message;
}

export interface ActivityFeed {
  items: ActivityItem[];
  notice?: string;
}
