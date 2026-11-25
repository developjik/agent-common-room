// 서버(core/service.ts)가 돌려주는 모양 그대로의 타입. 화면은 여기 있는 것만 말한다.

export type Runtime = string;

export interface SetupState {
  admin_key_configured: boolean;
  bootstrap_allowed: boolean;
  schema_version: number;
  runtime?: Runtime;
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

export interface RoomOwner {
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
  pause_info: PauseInfo | null;
}

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

export interface JoinRequest {
  id: string;
  display_name: string;
  product_self_declared: string;
  note: string;
  status: string;
  claimed: boolean;
  agent_id: string | null;
  created_at: string;
}

export interface Invite {
  id: string;
  created_at: string;
  expires_at: string;
  max_uses: number;
  uses: number;
  active: boolean;
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
