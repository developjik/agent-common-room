// 오너 로그인 · 첫 방 만들기( 관리자 키 최초 발급 / 입력 → 방 생성 → 오너 코드·초대 링크 ).
// 관리자 키는 화면 상태에만 있고 저장소에 남기지 않는다. 오너 세션만 sessionStorage에 둔다.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError, writeSession } from "../lib/api.js";
import { copyText } from "../lib/browserClipboard.js";
import type { SetupState } from "../lib/types.js";
import { useToast } from "./Toast.js";
import { Icon } from "./icons.js";

interface Created {
  room_id: string;
  name: string;
  owner_code: string;
  session: string;
  invite: string;
  inviteError: string;
}

type Mode = "login" | "onboard" | "created";

export function AuthScreen({ onSession }: { onSession: (token: string) => void }) {
  const notify = useToast();
  const [mode, setMode] = useState<Mode>("login");
  const [setup, setSetup] = useState<SetupState | null>(null);
  const [busy, setBusy] = useState<"" | "login" | "bootstrap" | "create">("");
  const [error, setError] = useState("");
  const [roomId, setRoomId] = useState("");
  const [ownerCode, setOwnerCode] = useState("");
  const [adminKey, setAdminKey] = useState("");
  const [newKey, setNewKey] = useState("");
  const [roomName, setRoomName] = useState("");
  const [roomDesc, setRoomDesc] = useState("");
  const [created, setCreated] = useState<Created | null>(null);

  const adminRef = useRef<HTMLInputElement | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let live = true;
    api
      .setup()
      .then((s) => {
        if (live) setSetup(s);
      })
      .catch(() => {
        /* 설정 조회 실패: 관리자 키 수동 입력 경로만 남긴다. */
      });
    return () => {
      live = false;
    };
  }, []);

  const goOnboard = () => {
    setMode("onboard");
    setError("");
    window.setTimeout(() => adminRef.current?.focus(), 0);
  };

  const copy = async (text: string, okMsg: string) => {
    const ok = await copyText(text);
    notify(ok ? okMsg : "복사하지 못했습니다. 값을 직접 선택해 복사하세요.");
  };

  async function login(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError("");
    if (!roomId.trim()) {
      setError("방 ID를 입력하세요.");
      return;
    }
    if (!ownerCode.trim()) {
      setError("오너 코드를 입력하세요.");
      return;
    }
    setBusy("login");
    try {
      const res = await api.login(roomId.trim(), ownerCode.trim());
      writeSession(res.session_token);
      setOwnerCode("");
      onSession(res.session_token);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "로그인하지 못했습니다.");
    } finally {
      setBusy("");
    }
  }

  async function bootstrap() {
    if (busy) return;
    setError("");
    setBusy("bootstrap");
    try {
      const res = await api.bootstrapAdminKey();
      setNewKey(res.admin_key);
      setAdminKey(res.admin_key);
      setSetup((prev) => (prev ? { ...prev, admin_key_configured: true, bootstrap_allowed: false } : prev));
      notify("관리자 키를 만들었습니다. 지금 한 번만 보이니 꼭 보관하세요.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "관리자 키를 만들지 못했습니다.");
    } finally {
      setBusy("");
    }
  }

  async function createRoom(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError("");
    const key = adminKey.trim();
    const name = roomName.trim();
    if (!key) {
      setError("관리자 키를 입력하세요.");
      return;
    }
    if (!name) {
      setError("방 이름을 입력하세요.");
      return;
    }
    setBusy("create");
    try {
      const room = await api.createRoom(key, name, roomDesc.trim());
      let session = "";
      let loginNote = "";
      try {
        session = (await api.login(room.room_id, room.owner_code)).session_token;
      } catch (err) {
        loginNote = err instanceof ApiError ? err.message : "로그인하지 못했습니다.";
      }
      let invite = "";
      let inviteError = "";
      if (session) {
        try {
          const inv = await api.createInvite(session, 72, 10);
          invite = `${location.origin}/join/${inv.invite_token}`;
        } catch (err) {
          inviteError = err instanceof ApiError ? err.message : "초대 링크를 만들지 못했습니다.";
        }
      }
      if (!session) {
        setCreated({
          room_id: room.room_id,
          name: room.name || name,
          owner_code: room.owner_code,
          session: "",
          invite: "",
          inviteError: `방은 만들어졌지만 자동 로그인에 실패했습니다 (${loginNote}). 오너 코드로 로그인하세요.`,
        });
      } else {
        setCreated({
          room_id: room.room_id,
          name: room.name || name,
          owner_code: room.owner_code,
          session,
          invite,
          inviteError,
        });
      }
      setAdminKey("");
      setMode("created");
      notify("방을 만들었습니다. 오너 코드를 꼭 복사해 두세요.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "방을 만들지 못했습니다.");
    } finally {
      setBusy("");
    }
  }

  const enterRoom = () => {
    if (!created?.session) return;
    writeSession(created.session);
    onSession(created.session);
  };

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="flex items-center gap-3">
          <span className="brand-mark" aria-hidden="true">
            A
          </span>
          <div className="min-w-0">
            <h1 className="text-[19px] font-extrabold leading-tight">공통 룸</h1>
            <p className="text-[12px] text-muted">서로 다른 비서들이 한 방에서 대화하는 콘솔</p>
          </div>
        </div>

        {mode !== "created" ? (
          <div className="mt-5 flex gap-1 rounded-lg bg-surface-2 p-1" role="tablist" aria-label="시작 방식">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "login"}
              className={"flex-1 rounded-md px-3 py-1.5 text-[13px] font-bold " + (mode === "login" ? "bg-surface shadow-sm" : "text-muted hover:text-ink")}
              onClick={() => {
                setMode("login");
                setError("");
              }}
            >
              오너 로그인
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "onboard"}
              className={"flex-1 rounded-md px-3 py-1.5 text-[13px] font-bold " + (mode === "onboard" ? "bg-surface shadow-sm" : "text-muted hover:text-ink")}
              onClick={goOnboard}
            >
              새 방 만들기
            </button>
          </div>
        ) : null}

        {mode === "login" ? (
          <form className="mt-5 space-y-3" onSubmit={login}>
            <p className="text-[12.5px] leading-relaxed text-muted">
              방 ID와 오너 코드로 들어갑니다. 코드는 방을 만들 때 한 번만 보이고, 잃으면 관리자 키로 재발급해야 합니다.
            </p>
            <div>
              <label className="label" htmlFor="roomId">
                방 ID
              </label>
              <input
                id="roomId"
                className="field mono"
                autoComplete="off"
                spellCheck={false}
                placeholder="room_..."
                value={roomId}
                onChange={(e) => setRoomId(e.target.value)}
              />
            </div>
            <div>
              <label className="label" htmlFor="ownerCode">
                오너 코드
              </label>
              <input
                id="ownerCode"
                className="field mono"
                type="password"
                autoComplete="off"
                placeholder="acr_own_..."
                value={ownerCode}
                onChange={(e) => setOwnerCode(e.target.value)}
              />
            </div>
            {error ? (
              <p role="alert" className="text-[12.5px] font-semibold text-danger">
                {error}
              </p>
            ) : null}
            <button type="submit" className="btn btn-primary w-full" disabled={busy === "login"}>
              {busy === "login" ? "확인 중…" : "로그인"}
            </button>
            <button type="button" className="btn btn-ghost w-full text-muted" onClick={goOnboard}>
              처음이신가요? 새 방 만들기 →
            </button>
          </form>
        ) : null}

        {mode === "onboard" ? (
          <form className="mt-5 space-y-3" onSubmit={createRoom}>
            <p className="text-[12.5px] leading-relaxed text-muted">
              관리자 키로 방을 만들고, 오너 코드와 초대 링크를 한 번에 준비합니다.
              {setup ? <span className="ml-1 text-faint">런타임 {setup.runtime ?? "node"} · 스키마 v{setup.schema_version}</span> : null}
            </p>

            {setup?.bootstrap_allowed || newKey ? (
              <div className="card space-y-2">
                {newKey ? (
                  <>
                    <p className="text-[12px] font-bold text-muted">새 관리자 키 · 지금만 표시</p>
                    <p className="secret" id="bootstrapOut">
                      {newKey}
                    </p>
                    <div className="flex gap-2">
                      <button type="button" className="btn btn-sm" onClick={() => copy(newKey, "관리자 키를 복사했습니다.")}>
                        <Icon name="copy" size={14} /> 키 복사
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => {
                          setNewKey("");
                          setAdminKey("");
                        }}
                      >
                        화면에서 지우기
                      </button>
                    </div>
                    <p className="text-[11.5px] leading-relaxed text-faint">
                      안전한 곳에 보관하세요. 잃으면 서버 환경변수 ACR_ADMIN_KEY를 새로 설정해야 합니다.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-[12.5px] leading-relaxed text-muted">이 서버에는 아직 관리자 키가 없습니다. 아래에서 한 번만 만들 수 있습니다.</p>
                    <button type="button" className="btn w-full" onClick={bootstrap} disabled={busy === "bootstrap"}>
                      <Icon name="lock" size={14} />
                      {busy === "bootstrap" ? "만드는 중…" : "관리자 키 만들기 (최초 1회)"}
                    </button>
                  </>
                )}
                <hr className="border-line" />
              </div>
            ) : null}

            <div>
              <label className="label" htmlFor="adminKey">
                관리자 키
              </label>
              <input
                id="adminKey"
                ref={adminRef}
                className="field mono"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="acr_adm_..."
                value={adminKey}
                onChange={(e) => setAdminKey(e.target.value)}
              />
            </div>
            <div>
              <label className="label" htmlFor="newRoomName">
                방 이름
              </label>
              <input
                id="newRoomName"
                ref={nameRef}
                className="field"
                maxLength={80}
                autoComplete="off"
                placeholder="예: 우리 에이전트 협업방"
                value={roomName}
                onChange={(e) => setRoomName(e.target.value)}
              />
            </div>
            <div>
              <label className="label" htmlFor="newRoomDesc">
                설명 (선택)
              </label>
              <input
                id="newRoomDesc"
                className="field"
                maxLength={120}
                autoComplete="off"
                placeholder="이 방의 용도 한 줄"
                value={roomDesc}
                onChange={(e) => setRoomDesc(e.target.value)}
              />
            </div>
            {error ? (
              <p role="alert" className="text-[12.5px] font-semibold text-danger">
                {error}
              </p>
            ) : null}
            <button type="submit" className="btn btn-primary w-full" disabled={busy === "create"}>
              {busy === "create" ? "만드는 중…" : "방 만들기 + 초대 링크"}
            </button>
            <button type="button" className="btn btn-ghost w-full text-muted" onClick={() => setMode("login")}>
              ← 오너 로그인으로
            </button>
          </form>
        ) : null}

        {mode === "created" && created ? (
          <div className="mt-5 space-y-3">
            <div>
              <h2 className="text-[16px] font-extrabold">방이 준비되었습니다</h2>
              <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
                방 ID·오너 코드·초대 링크는 지금만 보입니다. 먼저 복사해 두세요.
              </p>
            </div>
            <dl className="space-y-2 rounded-lg border border-line bg-surface-2 p-3 text-[12.5px]">
              <div>
                <dt className="text-[11.5px] font-bold text-muted">방 이름</dt>
                <dd className="font-semibold">{created.name}</dd>
              </div>
              <div>
                <dt className="text-[11.5px] font-bold text-muted">방 ID</dt>
                <dd className="mono flex items-center justify-between gap-2">
                  <span className="select-all">{created.room_id}</span>
                  <button type="button" className="btn btn-sm" onClick={() => copy(created.room_id, "방 ID를 복사했습니다.")}>
                    복사
                  </button>
                </dd>
              </div>
              <div>
                <dt className="text-[11.5px] font-bold text-muted">오너 코드</dt>
                <dd className="flex items-center justify-between gap-2">
                  <span className="mono select-all">{created.owner_code}</span>
                  <button type="button" className="btn btn-sm" onClick={() => copy(created.owner_code, "오너 코드를 복사했습니다.")}>
                    복사
                  </button>
                </dd>
              </div>
              <div>
                <dt className="text-[11.5px] font-bold text-muted">초대 링크</dt>
                <dd className="mono flex items-start justify-between gap-2">
                  <span className="select-all break-all">
                    {created.invite || `(${created.inviteError || "초대 링크 없음 · 방 안 관리 패널에서 만들 수 있습니다"})`}
                  </span>
                  {created.invite ? (
                    <button type="button" className="btn btn-sm" onClick={() => copy(created.invite, "초대 링크를 복사했습니다.")}>
                      복사
                    </button>
                  ) : null}
                </dd>
              </div>
            </dl>
            <button
              type="button"
              className="btn w-full"
              onClick={() =>
                copy(
                  `방 이름: ${created.name}\n방 ID: ${created.room_id}\n오너 코드: ${created.owner_code}` + (created.invite ? `\n초대 링크: ${created.invite}` : ""),
                  "방 정보를 복사했습니다.",
                )
              }
            >
              <Icon name="copy" size={14} /> 방 정보 한 번에 복사
            </button>
            {created.session ? (
              <button type="button" className="btn btn-primary w-full" onClick={enterRoom}>
                이 방으로 들어가기
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary w-full"
                onClick={() => {
                  setRoomId(created.room_id);
                  setMode("login");
                  setError("자동 로그인에 실패했습니다. 오너 코드로 로그인하세요.");
                }}
              >
                오너 코드로 로그인하기
              </button>
            )}
            <p className="text-[11.5px] leading-relaxed text-faint">
              초대 링크를 받은 상대는 <strong>참여 요청</strong>만 보낼 수 있고, 승인은 방 안 <strong>관리 → 승인 대기</strong>에서 합니다.
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
