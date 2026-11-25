// 오너 방 하나의 상태와 폴링. 화면 컴포넌트는 이 훅이 준 값만 읽는다.
// 폴링은 탭이 보일 때만 돌고(숨으면 20초 간격으로 쉼), 새 메시지가 없으면 4→6→10→15→20초로 늦춘다.
// 서버 한도(무료 플랜) 보호를 위해 초대 목록은 관리 패널을 열 때·10번째 폴링에만 싣는다.
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, owner } from "../lib/api.js";
import type { Agent, Invite, JoinRequest, Message, RoomOwner } from "../lib/types.js";

const POLL_STEPS = [4000, 6000, 10000, 15000, 20000];

function mergeMessages(prev: Message[], next: Message[]): Message[] {
  if (next.length === 0) return prev;
  const bySeq = new Map(prev.map((m) => [m.seq, m]));
  let changed = false;
  for (const m of next) {
    const old = bySeq.get(m.seq);
    if (!old || JSON.stringify(old) !== JSON.stringify(m)) {
      bySeq.set(m.seq, m);
      changed = true;
    }
  }
  if (!changed) return prev;
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

export interface RoomStore {
  room: RoomOwner | null;
  agents: Agent[];
  requests: JoinRequest[];
  invites: Invite[];
  invitesLoaded: boolean;
  messages: Message[];
  ready: boolean;
  error: string | null;
  syncedAt: number | null;
  pendingCount: number;
  refresh: (opts?: { full?: boolean; invites?: boolean }) => Promise<number>;
  requestInvites: () => void;
  send: (input: { content: string; kind?: string; recipient?: string; reply_to?: number }) => Promise<Message>;
  patchRoom: (patch: Record<string, unknown>) => Promise<void>;
  approve: (id: string, body: { history: "all" | "none"; can_read: boolean; can_write: boolean }) => Promise<string>;
  deny: (id: string) => Promise<void>;
  revokeAgent: (id: string) => Promise<void>;
  createInvite: (ttlHours: number, maxUses: number) => Promise<{ invite_token: string; expires_at: string; max_uses: number }>;
  revokeInvite: (id: string) => Promise<void>;
  deleteMessage: (seq: number) => Promise<void>;
}

export function useOwnerRoom(token: string, onUnauthorized: () => void): RoomStore {
  const [room, setRoom] = useState<RoomOwner | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [requests, setRequests] = useState<JoinRequest[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [invitesLoaded, setInvitesLoaded] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncedAt, setSyncedAt] = useState<number | null>(null);

  const lastSeq = useRef(0);
  const tick = useRef(0);
  const quiet = useRef(0);
  const wantInvites = useRef(false);
  const alive = useRef(true);
  const refreshing = useRef<Promise<number> | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const fail = useCallback(
    (e: unknown): never | string => {
      if (e instanceof ApiError && e.status === 401) {
        onUnauthorized();
        return "세션이 만료되었습니다.";
      }
      if (e instanceof ApiError) return e.message;
      return e instanceof Error ? e.message : "알 수 없는 오류가 발생했습니다.";
    },
    [onUnauthorized],
  );

  const pullMessages = useCallback(
    async (full: boolean): Promise<number> => {
      if (full) {
        lastSeq.current = 0;
        setMessages([]);
      }
      const before = lastSeq.current;
      let added = 0;
      for (;;) {
        const page = await owner.messages(token, lastSeq.current, 200);
        if (!alive.current) return added;
        if (page.messages.length) {
          const fresh = page.messages.filter((m) => m.seq > before);
          added += fresh.length;
          lastSeq.current = page.messages[page.messages.length - 1].seq;
          setMessages((prev) => mergeMessages(prev, page.messages));
        }
        if (!page.has_more) break;
      }
      return added;
    },
    [token],
  );

  const refresh = useCallback(
    async (opts: { full?: boolean; invites?: boolean } = {}): Promise<number> => {
      if (refreshing.current) return refreshing.current;
      const job = (async () => {
        try {
          const [r, a, q] = await Promise.all([owner.room(token), owner.agents(token), owner.requests(token)]);
          if (!alive.current) return 0;
          setRoom(r);
          setAgents(a.agents);
          setRequests(q.requests);
          setError(null);
          const withInvites = opts.invites || wantInvites.current || tick.current % 10 === 0;
          if (withInvites) {
            const inv = await owner.invites(token);
            wantInvites.current = false;
            if (alive.current) {
              setInvites(inv.invites);
              setInvitesLoaded(true);
            }
          }
          tick.current += 1;
          const added = await pullMessages(!!opts.full);
          if (!alive.current) return 0;
          setReady(true);
          setSyncedAt(Date.now());
          return added;
        } catch (e) {
          const message = fail(e);
          if (alive.current) setError(message);
          setReady(true);
          return 0;
        } finally {
          refreshing.current = null;
        }
      })();
      refreshing.current = job;
      return job;
    },
    [token, pullMessages, fail],
  );

  // 첫 로드 + 적응형 폴링. refresh는 stable하며, 언마운트 시 타이머를 정리한다.
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    const schedule = () => {
      if (cancelled) return;
      timer = window.setTimeout(loop, POLL_STEPS[quiet.current]);
    };
    const loop = async () => {
      if (cancelled) return;
      if (document.hidden) {
        schedule();
        return;
      }
      const added = await refresh();
      quiet.current = added > 0 ? 0 : Math.min(quiet.current + 1, POLL_STEPS.length - 1);
      schedule();
    };
    const onVisible = () => {
      if (document.hidden || cancelled) return;
      quiet.current = 0;
      window.clearTimeout(timer);
      void loop();
    };

    void loop();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  const requestInvites = useCallback(() => {
    wantInvites.current = true;
    void refresh({ invites: true });
  }, [refresh]);

  const send: RoomStore["send"] = useCallback(
    async (input) => {
      const body: Record<string, unknown> = {
        client_id: `own-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        content: input.content,
        kind: input.kind ?? "message",
      };
      if (input.recipient) body.recipient = input.recipient;
      if (input.reply_to) body.reply_to = input.reply_to;
      const res = await owner.say(token, body as Parameters<typeof owner.say>[1]);
      await pullMessages(false);
      return res.message;
    },
    [token, pullMessages],
  );

  const patchRoom = useCallback(
    async (patch: Record<string, unknown>) => {
      const next = await owner.patchRoom(token, patch);
      if (alive.current) setRoom(next);
    },
    [token],
  );

  const approve: RoomStore["approve"] = useCallback(
    async (id, body) => {
      const res = await owner.approve(token, id, body);
      await refresh({ invites: true });
      return res.name;
    },
    [token, refresh],
  );

  const deny = useCallback(
    async (id: string) => {
      await owner.deny(token, id);
      await refresh();
    },
    [token, refresh],
  );

  const revokeAgent = useCallback(
    async (id: string) => {
      await owner.revokeAgent(token, id);
      await refresh();
    },
    [token, refresh],
  );

  const createInvite = useCallback(
    async (ttlHours: number, maxUses: number) => {
      const res = await owner.createInvite(token, ttlHours, maxUses);
      const inv = await owner.invites(token);
      if (alive.current) {
        setInvites(inv.invites);
        setInvitesLoaded(true);
      }
      return res;
    },
    [token],
  );

  const revokeInvite = useCallback(
    async (id: string) => {
      await owner.revokeInvite(token, id);
      const inv = await owner.invites(token);
      if (alive.current) setInvites(inv.invites);
    },
    [token],
  );

  const deleteMessage = useCallback(
    async (seq: number) => {
      await owner.deleteMessage(token, seq);
      setMessages((prev) => prev.map((m) => (m.seq === seq ? { ...m, deleted: true, content: null } : m)));
    },
    [token],
  );

  return {
    room,
    agents,
    requests,
    invites,
    invitesLoaded,
    messages,
    ready,
    error,
    syncedAt,
    pendingCount: requests.length,
    refresh,
    requestInvites,
    send,
    patchRoom,
    approve,
    deny,
    revokeAgent,
    createInvite,
    revokeInvite,
    deleteMessage,
  };
}