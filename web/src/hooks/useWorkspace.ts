// 워크스페이스 한 곳의 상태와 폴링. 화면 컴포넌트는 이 훅이 준 값만 읽는다.
//
// 요청 예산(Free 플랜 보호):
//  - 방 화면: overview + 방 상세 + 메시지 = 3회
//  - 방 목록(방을 열지 않음): overview 1회
//  - 비서 화면: overview + 비서 목록 + 승인 대기(레거시) = 3회
// 폴링은 탭이 보일 때만 돌고(숨으면 쉼), 새 메시지가 없으면 4→6→10→15→20초로 늦춘다.
// 단, 내가 보낸 메시지의 전달 배지를 기다리는 동안은 4초 간격을 유지한다.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, joinRequests, room as roomApi, workspace as wsApi } from "../lib/api.js";
import { awaitingDelivery, countNew, memberToAgent, nextFetchAfter, POLL_STEPS, pollDelay } from "../lib/views.js";
import type { Agent, JoinRequest, Message, Overview, PoolAgent, RoomDetail, Workspace } from "../lib/types.js";
import type { View } from "../lib/route.js";

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
  /** 예전 방식(승인 필요) 초대로 남은 대기 요청. 즉시 입장에는 없다. */
  requests: JoinRequest[];
  messages: Message[];
  ready: boolean;
  error: string | null;
  syncedAt: number | null;
  pendingCount: number;
  refresh: (opts?: { full?: boolean; agentsView?: boolean }) => Promise<number>;
  createRoom: (name: string) => Promise<RoomDetail>;
  createInvite: (rid: string, ttlHours: number, maxUses: number) => Promise<import("../lib/types.js").CreatedInvite>;
  createPoolInvite: (ttlHours: number, maxUses: number) => Promise<import("../lib/types.js").CreatedInvite>;
  approve: (id: string, body: { history: "all" | "none"; can_read: boolean; can_write: boolean; name?: string }) => Promise<string>;
  deny: (id: string) => Promise<void>;
  /** 이 비서가 있어야 할 방 목록을 통째로 바꾼다(비서 화면의 방 토글). */
  /** 이 비서가 있어야 할 방 목록으로 맞춘다(비서 화면의 방 토글). 빠진 방은 내보내고, 새 방만 배치한다. */
  setAgentRooms: (agentId: string, currentRoomIds: string[], targetRoomIds: string[]) => Promise<void>;
  revokeAgent: (agentId: string) => Promise<void>;
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
  const messagesRef = useRef<Message[]>([]);
  // 이 세션에서 지운 방. 화면 경로가 아직 그 방을 가리키는 짧은 사이에 다시 읽어
  // 404(방을 찾을 수 없습니다)를 만들지 않는다.
  const removedRooms = useRef<Set<string>>(new Set());
  const loopRef = useRef<() => void>(() => {});
  const timerRef = useRef<number | undefined>(undefined);

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

  const pullMessages = useCallback(async (rid: string, full: boolean, generation: number): Promise<number> => {
    const before = lastSeq.current;
    const previousLast = before;
    let after = full ? 0 : nextFetchAfter(before, false);
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
  }, []);

  const refresh = useCallback(
    async (opts: { full?: boolean; agentsView?: boolean } = {}): Promise<number> => {
      if (refreshing.current) return refreshing.current;
      const generation = gen.current;
      const rid = roomRef.current;
      const currentView = viewRef.current;
      let self: Promise<number>;
      const run = async (): Promise<number> => {
        try {
          const gone = rid ? removedRooms.current.has(rid) : false;
          const [ov, detail] = await Promise.all([wsApi.overview(wid), rid && !gone ? roomApi.get(rid) : Promise.resolve(null)]);
          if (!alive.current || generation !== gen.current) return 0;
          setOverview(ov);
          if (rid && detail) setRoom(detail);
          setError(null);

          if (opts.agentsView || currentView === "agents") {
            const [poolRes, reqRes] = await Promise.all([wsApi.agents(wid), wsApi.joinRequests(wid, "pending")]);
            if (!alive.current || generation !== gen.current) return 0;
            setPool(poolRes.agents);
            setRequests(reqRes.requests);
          }

          tick.current += 1;
          let added = 0;
          if (rid && !gone) {
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
    if (refreshing.current) refreshing.current = null;
    lastSeq.current = 0;
    setMessages([]);
    setRoom(null);
    setReady(false);
    if (roomId) void refresh({ full: true });
  }, [roomId, refresh]);

  // 화면이 바뀌면 필요한 목록을 바로 채운다(폴링을 기다리지 않는다).
  useEffect(() => {
    void refresh({ agentsView: view === "agents" });
  }, [view, refresh]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  /** 폴링을 즉시 한 번 돌리고 간격을 처음(4초)으로 되돌린다. 전송 직후 배지 갱신에 쓴다. */
  const nudge = useCallback(() => {
    quiet.current = 0;
    window.clearTimeout(timerRef.current);
    loopRef.current();
  }, []);

  // 첫 로드 + 적응형 폴링
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    let running = false;

    const schedule = () => {
      if (cancelled) return;
      window.clearTimeout(timer);
      const delay = pollDelay(quiet.current, awaitingDelivery(messagesRef.current));
      timer = window.setTimeout(loop, delay);
      timerRef.current = timer;
    };
    const loop = async () => {
      if (cancelled || running) return;
      running = true;
      try {
        if (document.hidden) return;
        const added = await refresh();
        const waiting = awaitingDelivery(messagesRef.current);
        quiet.current = added > 0 || waiting ? 0 : Math.min(quiet.current + 1, POLL_STEPS.length - 1);
      } finally {
        running = false;
        schedule();
      }
    };
    loopRef.current = () => void loop();
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
      loopRef.current = () => {};
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  const agents = useMemo(() => (room ? room.members.filter((m) => m.status !== "removed").map(memberToAgent) : []), [room]);

  const createRoom = useCallback(
    async (name: string) => {
      const created = await wsApi.createRoom(wid, { name });
      await refresh({ full: true });
      return created;
    },
    [wid, refresh],
  );

  const createInvite = useCallback((rid: string, ttlHours: number, maxUses: number) => roomApi.createInvite(rid, ttlHours, maxUses), []);
  const createPoolInvite = useCallback(
    (ttlHours: number, maxUses: number) => wsApi.createPoolInvite(wid, ttlHours, maxUses),
    [wid],
  );

  const approve: WorkspaceStore["approve"] = useCallback(
    async (id, body) => {
      const res = await joinRequests.approve(id, body);
      await refresh({ agentsView: true });
      return res.name;
    },
    [refresh],
  );

  const deny = useCallback(
    async (id: string) => {
      await joinRequests.deny(id);
      await refresh({ agentsView: true });
    },
    [refresh],
  );

  const setAgentRooms: WorkspaceStore["setAgentRooms"] = useCallback(
    async (agentId, currentRoomIds, targetRoomIds) => {
      const current = new Set(currentRoomIds);
      const target = new Set(targetRoomIds);
      const added = [...target].filter((id) => !current.has(id));
      const removed = [...current].filter((id) => !target.has(id));
      // 새로 넣는 방은 지난 대화 없이, 이미 있던 방은 서버가 권한·커서를 보존한다.
      if (added.length) await wsApi.placeAgent(wid, agentId, { room_ids: added });
      for (const rid of removed) await roomApi.removeMember(rid, agentId);
      await refresh({ agentsView: true, full: !!roomRef.current });
    },
    [wid, refresh],
  );

  const revokeAgent = useCallback(
    async (agentId: string) => {
      await wsApi.revokeAgent(wid, agentId);
      await refresh({ agentsView: true, full: !!roomRef.current });
    },
    [wid, refresh],
  );

  const removeMember = useCallback(
    async (rid: string, agentId: string) => {
      await roomApi.removeMember(rid, agentId);
      await refresh({ agentsView: viewRef.current === "agents" });
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
      nudge();
      return res.message;
    },
    [pullMessages, nudge],
  );

  const deleteMessage = useCallback(
    async (rid: string, seq: number) => {
      await roomApi.deleteMessage(rid, seq);
      setMessages((prev) => prev.map((m) => (m.seq === seq ? { ...m, deleted: true, content: null } : m)));
      // 삭제 전에 시작된 폴링(개요 스냅샷)이 아직 날아오는 중이면 그 응답에는 삭제된 본문이 들어 있다.
      // refresh() 는 진행 중이면 그 약속을 그대로 돌려주므로, 먼저 끝나게 한 뒤 한 번 더 읽는다
      // (예전에는 이 경합에 걸리면 다음 폴링(최대 20초)까지 방 목록에 삭제된 본문이 남았다).
      if (refreshing.current) {
        try {
          await refreshing.current;
        } catch {
          /* 실패한 폴링은 아래 refresh 가 다시 시도한다. */
        }
      }
      await refresh();
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
      removedRooms.current.add(rid);
      if (rid === roomRef.current) {
        gen.current += 1;
        roomRef.current = null;
        lastSeq.current = 0;
        setRoom(null);
        setMessages([]);
      }
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
    messages,
    ready,
    error,
    syncedAt,
    pendingCount: requests.length,
    refresh,
    createRoom,
    createInvite,
    createPoolInvite,
    approve,
    deny,
    setAgentRooms,
    revokeAgent,
    removeMember,
    send,
    deleteMessage,
    patchRoom,
    deleteRoom,
  };
}
