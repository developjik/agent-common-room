// 워크스페이스 한 곳의 상태와 폴링. 화면 컴포넌트는 이 훅이 준 값만 읽는다.
//
// 요청 예산(Free 플랜 보호):
//  - 관제실: overview 1회
//  - 방 집중: overview + 방 상세 + 메시지 = 3회
//  - 비서실: overview + 비서 목록 + 승인 대기 = 3회
//  - 인박스: overview + 활동 = 2회
// 폴링은 탭이 보일 때만 돌고(숨으면 20초 간격으로 쉼), 새 메시지가 없으면 4→6→10→15→20초로 늦춘다.
//
// 전달 상태 실시간 갱신: 증분 API(after=)는 커서 이후만 주므로 기존 메시지의 delivery.state 가
// 바뀌어도 화면이 그대로였다. 매 폴링마다 최근 구간(DELIVERY_WINDOW)을 되읽어 같은 seq 를 합친다.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, joinRequests, room as roomApi, workspace as wsApi } from "../lib/api.js";
import { countNew, memberToAgent, nextFetchAfter } from "../lib/views.js";
import type {
  ActivityItem,
  Agent,
  JoinRequest,
  Message,
  Overview,
  PoolAgent,
  RoomDetail,
  Workspace,
} from "../lib/types.js";
import type { View } from "../lib/route.js";

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

export interface SendInput {
  content: string;
  kind?: string;
  recipient?: string;
  reply_to?: number;
}

export interface WorkspaceStore {
  /** 방 집중 뷰의 방. 아직 못 읽었으면 null. */
  room: RoomDetail | null;
  /** 방 구성원(멘션·상태 점이 쓰는 모양). */
  agents: Agent[];
  overview: Overview | null;
  pool: PoolAgent[];
  requests: JoinRequest[];
  activity: ActivityItem[];
  messages: Message[];
  ready: boolean;
  error: string | null;
  syncedAt: number | null;
  pendingCount: number;
  refresh: (opts?: { full?: boolean; desk?: boolean; inbox?: boolean }) => Promise<number>;
  createRoom: (name: string, description: string) => Promise<RoomDetail>;
  listInvites: (rid: string) => Promise<import("../lib/types.js").Invite[]>;
  createInvite: (rid: string, ttlHours: number, maxUses: number) => Promise<import("../lib/types.js").CreatedInvite>;
  createPoolInvite: (ttlHours: number, maxUses: number) => Promise<import("../lib/types.js").CreatedInvite>;
  revokeInvite: (rid: string, inviteId: string) => Promise<void>;
  approve: (id: string, body: { history: "all" | "none"; can_read: boolean; can_write: boolean; name?: string }) => Promise<string>;
  deny: (id: string) => Promise<void>;
  placeAgent: (agentId: string, roomIds: string[], opts?: { history?: "all" | "none"; can_read?: boolean; can_write?: boolean }) => Promise<void>;
  revokeAgent: (agentId: string) => Promise<void>;
  updateMember: (rid: string, agentId: string, patch: { can_read?: boolean; can_write?: boolean; status?: "active" | "removed" }) => Promise<void>;
  removeMember: (rid: string, agentId: string) => Promise<void>;
  send: (rid: string, input: SendInput) => Promise<Message>;
  deleteMessage: (rid: string, seq: number) => Promise<void>;
  patchRoom: (rid: string, patch: Record<string, unknown>) => Promise<void>;
  deleteRoom: (rid: string) => Promise<void>;
}

interface Params {
  workspace: Workspace;
  roomId: string | null;
  view: View;
  onUnauthorized: () => void;
}

export function useWorkspace({ workspace, roomId, view, onUnauthorized }: Params): WorkspaceStore {
  const wid = workspace.id;
  const [room, setRoom] = useState<RoomDetail | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [pool, setPool] = useState<PoolAgent[]>([]);
  const [requests, setRequests] = useState<JoinRequest[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncedAt, setSyncedAt] = useState<number | null>(null);

  const lastSeq = useRef(0);
  const tick = useRef(0);
  const quiet = useRef(0);
  const alive = useRef(true);
  const refreshing = useRef<Promise<number> | null>(null);
  const roomRef = useRef<string | null>(roomId);
  const viewRef = useRef<View>(view);
  const gen = useRef(0);

  roomRef.current = roomId;
  viewRef.current = view;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const fail = useCallback(
    (e: unknown): string => {
      if (e instanceof ApiError && e.status === 401) {
        onUnauthorized();
        return "세션이 만료되었습니다. 다시 로그인하세요.";
      }
      if (e instanceof ApiError) return e.message;
      return e instanceof Error ? e.message : "알 수 없는 오류가 발생했습니다.";
    },
    [onUnauthorized],
  );

  const pullMessages = useCallback(
    async (rid: string, full: boolean, generation: number): Promise<number> => {
      const previousLast = full ? 0 : lastSeq.current;
      let after = nextFetchAfter(previousLast, full);
      const collected: Message[] = [];
      let lastFetched = previousLast;
      for (;;) {
        const page = await roomApi.messages(rid, after, 200);
        if (!alive.current || generation !== gen.current) return 0;
        collected.push(...page.messages);
        if (page.messages.length) {
          after = page.messages[page.messages.length - 1].seq;
          lastFetched = Math.max(lastFetched, after);
        }
        if (!page.has_more) break;
      }
      if (generation !== gen.current) return 0;
      if (full) {
        // 전체 재조회 중에 보낸 새 메시지(로컬 낙관 반영)는 남겨 둔다.
        setMessages((prev) => mergeMessages(collected, prev.filter((m) => m.seq > lastFetched)));
      } else if (collected.length) {
        setMessages((prev) => mergeMessages(prev, collected));
      }
      lastSeq.current = lastFetched;
      return countNew(previousLast, collected.map((m) => m.seq));
    },
    [],
  );

  const refresh = useCallback(
    async (opts: { full?: boolean; desk?: boolean; inbox?: boolean } = {}): Promise<number> => {
      if (refreshing.current) return refreshing.current;
      const generation = gen.current;
      const rid = roomRef.current;
      const currentView = viewRef.current;
      // 자기 자신의 프라미스만 해제한다. 방을 바꿔 새 갱신이 시작된 뒤 이전 요청이 끝나도
      // 새 요청의 잠금을 풀지 않는다(중복 폴링 방지).
      let self: Promise<number>;
      const run = async (): Promise<number> => {
        try {
          const [ov, detail] = await Promise.all([wsApi.overview(wid), rid ? roomApi.get(rid) : Promise.resolve(null)]);
          if (!alive.current || generation !== gen.current) return 0;
          setOverview(ov);
          if (rid) setRoom(detail);
          setError(null);

          const wantDesk = opts.desk || currentView === "desk";
          const wantInbox = opts.inbox || currentView === "inbox";
          if (wantDesk) {
            const [poolRes, reqRes] = await Promise.all([wsApi.agents(wid), wsApi.joinRequests(wid, "pending")]);
            if (!alive.current || generation !== gen.current) return 0;
            setPool(poolRes.agents);
            setRequests(reqRes.requests);
          }
          if (wantInbox) {
            const feed = await wsApi.activity(wid, 50);
            if (!alive.current || generation !== gen.current) return 0;
            setActivity(feed.items);
          }

          tick.current += 1;
          let added = 0;
          if (rid) {
            // 30번째 폴링·방 진입은 전체를 다시 읽어 오래된 메시지의 전달 상태와 삭제도 맞춘다.
            added = await pullMessages(rid, !!opts.full || tick.current % 30 === 0, generation);
          }
          if (!alive.current || generation !== gen.current) return 0;
          setReady(true);
          setSyncedAt(Date.now());
          return added;
        } catch (e) {
          const message = fail(e);
          if (alive.current && generation === gen.current) setError(message);
          setReady(true);
          return 0;
        } finally {
          if (refreshing.current === self) refreshing.current = null;
        }
      };
      self = run();
      refreshing.current = self;
      return self;
    },
    [wid, pullMessages, fail],
  );

  // 방이 바뀌면 즉시 전체 재조회. 이전 방의 응답은 generation 으로 버린다.
  useEffect(() => {
    gen.current += 1;
    if (refreshing.current) refreshing.current = null; // 진행 중이던 응답은 generation 비교로 폐기된다.
    lastSeq.current = 0;
    setMessages([]);
    setRoom(null);
    setReady(false);
    if (roomId) void refresh({ full: true });
  }, [roomId, refresh]);

  // 뷰가 바뀌면 필요한 목록을 바로 채운다(폴링을 기다리지 않는다).
  useEffect(() => {
    void refresh({ desk: view === "desk", inbox: view === "inbox" });
  }, [view, refresh]);

  // 첫 로드 + 적응형 폴링
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

  const agents = useMemo(() => (room ? room.members.filter((m) => m.status !== "removed").map(memberToAgent) : []), [room]);

  const createRoom = useCallback(
    async (name: string, description: string) => {
      const created = await wsApi.createRoom(wid, { name, description });
      await refresh({ full: true });
      return created;
    },
    [wid, refresh],
  );

  const listInvites = useCallback((rid: string) => roomApi.invites(rid).then((r) => r.invites), []);
  const createInvite = useCallback((rid: string, ttlHours: number, maxUses: number) => roomApi.createInvite(rid, ttlHours, maxUses), []);
  const createPoolInvite = useCallback(
    (ttlHours: number, maxUses: number) => wsApi.createPoolInvite(wid, ttlHours, maxUses),
    [wid],
  );
  const revokeInvite = useCallback(async (rid: string, inviteId: string) => {
    await roomApi.revokeInvite(rid, inviteId);
  }, []);

  const approve: WorkspaceStore["approve"] = useCallback(
    async (id, body) => {
      const res = await joinRequests.approve(id, body);
      await refresh({ desk: true });
      return res.name;
    },
    [refresh],
  );

  const deny = useCallback(
    async (id: string) => {
      await joinRequests.deny(id);
      await refresh({ desk: true });
    },
    [refresh],
  );

  const placeAgent: WorkspaceStore["placeAgent"] = useCallback(
    async (agentId, roomIds, opts = {}) => {
      await wsApi.placeAgent(wid, agentId, { room_ids: roomIds, ...opts });
      await refresh({ desk: true, full: !!roomRef.current });
    },
    [wid, refresh],
  );

  const revokeAgent = useCallback(
    async (agentId: string) => {
      await wsApi.revokeAgent(wid, agentId);
      await refresh({ desk: true, full: !!roomRef.current });
    },
    [wid, refresh],
  );

  const updateMember: WorkspaceStore["updateMember"] = useCallback(
    async (rid, agentId, patch) => {
      await roomApi.updateMember(rid, agentId, patch);
      await refresh();
    },
    [refresh],
  );

  const removeMember = useCallback(
    async (rid: string, agentId: string) => {
      await roomApi.removeMember(rid, agentId);
      await refresh();
    },
    [refresh],
  );

  const send: WorkspaceStore["send"] = useCallback(
    async (rid, input) => {
      const body: { client_id: string; content: string; kind?: string; recipient?: string; reply_to?: number } = {
        client_id: `own-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        content: input.content,
        kind: input.kind ?? "message",
      };
      if (input.recipient) body.recipient = input.recipient;
      if (input.reply_to) body.reply_to = input.reply_to;
      const res = await roomApi.say(rid, body);
      if (rid === roomRef.current) await pullMessages(rid, false, gen.current);
      return res.message;
    },
    [pullMessages],
  );

  const deleteMessage = useCallback(
    async (rid: string, seq: number) => {
      await roomApi.deleteMessage(rid, seq);
      setMessages((prev) => prev.map((m) => (m.seq === seq ? { ...m, deleted: true, content: null } : m)));
      void refresh();
    },
    [refresh],
  );

  const patchRoom = useCallback(
    async (rid: string, patch: Record<string, unknown>) => {
      const next = await roomApi.patch(rid, patch);
      if (rid === roomRef.current) setRoom(next);
      void refresh();
    },
    [refresh],
  );

  const deleteRoom = useCallback(
    async (rid: string) => {
      await roomApi.remove(rid);
      await refresh({ full: true });
    },
    [refresh],
  );

  return {
    room,
    agents,
    overview,
    pool,
    requests,
    activity,
    messages,
    ready,
    error,
    syncedAt,
    pendingCount: requests.length,
    refresh,
    createRoom,
    listInvites,
    createInvite,
    createPoolInvite,
    revokeInvite,
    approve,
    deny,
    placeAgent,
    revokeAgent,
    updateMember,
    removeMember,
    send,
    deleteMessage,
    patchRoom,
    deleteRoom,
  };
}
