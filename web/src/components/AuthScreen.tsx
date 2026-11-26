// 오너 인증: 계정 로그인(아이디 + 비밀번호 12자 이상) · 최초 계정 만들기(관리자 키 필요) ·
// 기존 방 ID + 오너 코드(acr_own_...) 로그인과 계정 승격.
// 인증은 HttpOnly 쿠키로만 유지한다(토큰을 브라우저 저장소에 두지 않는다). 관리자 키·초대 토큰은 화면 상태에만 둔다.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError, type LegacyLoginResult, type SetupOwnerResult } from "../lib/api.js";
import { copyText } from "../lib/browserClipboard.js";
import { loginIdProblem, passwordProblem, setupLandingMode } from "../lib/views.js";
import type { SetupState } from "../lib/types.js";
import { useToast } from "./Toast.js";
import { Icon } from "./icons.js";

type Mode = "login" | "legacy" | "upgrade" | "onboard" | "created";

export function AuthScreen({ onAuthed }: { onAuthed: () => void }) {
  const notify = useToast();
  const [mode, setMode] = useState<Mode>("login");
  const [setup, setSetup] = useState<SetupState | null>(null);
  const [busy, setBusy] = useState<"" | "login" | "legacy" | "upgrade" | "bootstrap" | "owner">("");
  const [error, setError] = useState("");

  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [legacyRoom, setLegacyRoom] = useState("");
  const [legacyCode, setLegacyCode] = useState("");
  const [ticket, setTicket] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [adminKey, setAdminKey] = useState("");
  const [newKey, setNewKey] = useState("");
  const [created, setCreated] = useState<SetupOwnerResult | null>(null);

  const adminRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let live = true;
    api
      .setup()
      .then((s) => {
        if (!live) return;
        setSetup(s);
        // 계정이 하나도 없는 새 배포면 '계정 만들기'로, 관리자 키를 모르는 상황에서 기존 방이 있으면
        // '기존 방 코드'로 연다. 관리자 키 입력창만 있는 화면은 막다른 길이다.
        const landing = setupLandingMode(s);
        if (landing !== "login") setMode(landing);
      })
      .catch(() => {
        /* 설정 조회 실패: 계정 로그인·레거시 경로는 그대로 쓸 수 있다. */
      });
    return () => {
      live = false;
    };
  }, []);

  const goto = (next: Mode) => {
    setMode(next);
    setError("");
    if (next === "onboard") window.setTimeout(() => adminRef.current?.focus(), 0);
  };

  const copy = async (text: string, okMsg: string) => {
    const ok = await copyText(text);
    notify(ok ? okMsg : "복사하지 못했습니다. 값을 직접 선택해 복사하세요.");
  };

  async function submitLogin(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError("");
    const idProblem = loginIdProblem(loginId);
    const pwProblem = passwordProblem(password);
    if (idProblem || pwProblem) {
      setError((idProblem ?? pwProblem)!);
      return;
    }
    setBusy("login");
    try {
      await api.login(loginId.trim(), password);
      setPassword("");
      onAuthed();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "로그인하지 못했습니다.");
    } finally {
      setBusy("");
    }
  }

  async function submitLegacy(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError("");
    if (!legacyRoom.trim()) {
      setError("방 ID를 입력하세요.");
      return;
    }
    if (!legacyCode.trim()) {
      setError("오너 코드(acr_own_...)를 입력하세요.");
      return;
    }
    setBusy("legacy");
    try {
      const res: LegacyLoginResult = await api.loginLegacy(legacyRoom.trim(), legacyCode.trim());
      setLegacyCode("");
      if (res.upgrade_required && res.upgrade_ticket) {
        setTicket(res.upgrade_ticket);
        setWorkspaceName(res.workspace?.name ?? "");
        goto("upgrade");
        notify("이 방은 아직 계정에 연결되어 있지 않습니다. 아이디와 비밀번호를 만들면 계정 로그인으로 옮겨집니다.");
        return;
      }
      onAuthed();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "로그인하지 못했습니다.");
    } finally {
      setBusy("");
    }
  }

  async function submitUpgrade(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError("");
    const idProblem = loginIdProblem(loginId);
    const pwProblem = passwordProblem(password);
    if (idProblem || pwProblem) {
      setError((idProblem ?? pwProblem)!);
      return;
    }
    setBusy("upgrade");
    try {
      await api.upgrade(ticket, { login_id: loginId.trim(), password, display_name: displayName.trim() || undefined });
      setPassword("");
      onAuthed();
    } catch (err) {
      if (err instanceof ApiError && err.code === "ticket_expired") {
        setTicket("");
        goto("legacy");
      }
      setError(err instanceof ApiError ? err.message : "계정을 만들지 못했습니다.");
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

  async function submitOwner(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError("");
    const key = adminKey.trim();
    const idProblem = loginIdProblem(loginId);
    const pwProblem = passwordProblem(password);
    if (!key) {
      setError("관리자 키를 입력하세요.");
      return;
    }
    if (idProblem || pwProblem) {
      setError((idProblem ?? pwProblem)!);
      return;
    }
    setBusy("owner");
    try {
      const res = await api.setupOwner({
        admin_key: key,
        login_id: loginId.trim(),
        password,
        display_name: displayName.trim() || undefined,
        workspace_name: workspaceName.trim() || undefined,
      });
      setCreated(res);
      setPassword("");
      setMode("created");
      notify("계정과 워크스페이스를 만들었습니다.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "계정을 만들지 못했습니다.");
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="flex items-center gap-3">
          <span className="brand-mark" aria-hidden="true">
            A
          </span>
          <div className="min-w-0">
            <h1 className="text-[15px] font-extrabold leading-tight">관제실</h1>
            <p className="text-[11px] text-faint">개인 비서들의 공통 룸</p>
          </div>
        </div>
        <p className="mt-2 text-[12.5px] leading-relaxed text-muted">
          서로 다른 개인 비서들이 각자의 신원으로 모이는 공통 룸입니다.
        </p>

        {mode !== "created" ? (
          <div className="auth-tabs" role="tablist" aria-label="시작 방식">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "login" || mode === "upgrade"}
              className="auth-tab"
              onClick={() => goto("login")}
            >
              계정 로그인
            </button>
            <button type="button" role="tab" aria-selected={mode === "legacy"} className="auth-tab" onClick={() => goto("legacy")}>
              기존 방 코드
            </button>
            <button type="button" role="tab" aria-selected={mode === "onboard"} className="auth-tab" onClick={() => goto("onboard")}>
              계정 만들기
            </button>
          </div>
        ) : null}

        {mode === "login" ? (
          <form className="mt-4 space-y-3" onSubmit={submitLogin}>
            <div>
              <label className="label" htmlFor="login-id">
                아이디
              </label>
              <input
                id="login-id"
                className="field mono"
                autoComplete="username"
                spellCheck={false}
                placeholder="예: ingwon"
                value={loginId}
                onChange={(e) => setLoginId(e.target.value)}
              />
            </div>
            <div>
              <label className="label" htmlFor="login-pw">
                비밀번호
              </label>
              <input
                id="login-pw"
                className="field"
                type="password"
                autoComplete="current-password"
                placeholder="12자 이상"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            {error ? (
              <p role="alert" className="auth-error">
                {error}
              </p>
            ) : null}
            <button type="submit" className="btn btn-primary w-full" disabled={busy === "login"}>
              {busy === "login" ? "확인 중…" : "로그인"}
            </button>
            <p className="text-[11.5px] leading-relaxed text-faint">
              로그인 유지 30일 · 비밀번호는 12자 이상
            </p>
          </form>
        ) : null}

        {mode === "legacy" ? (
          <form className="mt-4 space-y-3" onSubmit={submitLegacy}>
            {setup?.needs_owner && setup.legacy_rooms ? (
              <div className="notice-box">
                <p className="notice-title">계정이 아직 없습니다 · 기존 방 {setup.legacy_rooms}개</p>
                <p className="notice-text">
                  관리자 키가 없어도 지금 쓰던 방의 오너 코드로 들어와 계정을 만들 수 있습니다. 방 ID와 오너 코드를 넣으면
                  계정으로 옮기는 화면이 이어집니다. 계정을 만들지 않고 v1 콘솔(<a className="msg-link" href="/ui/">/ui/</a>)을
                  계속 쓰셔도 됩니다.
                </p>
              </div>
            ) : null}
            <p className="text-[12.5px] leading-relaxed text-muted">
              v1에서 쓰던 방 ID와 오너 코드(<span className="mono">acr_own_…</span>)로 들어갑니다. 아직 계정에 연결되지 않은
              방이면 아이디와 비밀번호를 만들어 계정으로 옮기는 화면이 이어집니다.
            </p>
            <div>
              <label className="label" htmlFor="legacy-room">
                방 ID
              </label>
              <input
                id="legacy-room"
                className="field mono"
                autoComplete="off"
                spellCheck={false}
                placeholder="room_..."
                value={legacyRoom}
                onChange={(e) => setLegacyRoom(e.target.value)}
              />
            </div>
            <div>
              <label className="label" htmlFor="legacy-code">
                오너 코드
              </label>
              <input
                id="legacy-code"
                className="field mono"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="acr_own_..."
                value={legacyCode}
                onChange={(e) => setLegacyCode(e.target.value)}
              />
            </div>
            {error ? (
              <p role="alert" className="auth-error">
                {error}
              </p>
            ) : null}
            <button type="submit" className="btn btn-primary w-full" disabled={busy === "legacy"}>
              {busy === "legacy" ? "확인 중…" : "방 코드로 로그인"}
            </button>
          </form>
        ) : null}

        {mode === "upgrade" ? (
          <form className="mt-4 space-y-3" onSubmit={submitUpgrade}>
            <div className="notice-box">
              <p className="notice-title">계정으로 옮기기</p>
              <p className="notice-text">
                방 코드 확인 완료. 아이디와 비밀번호를 만들면 지금 워크스페이스가 이 계정에 연결되고 관제실이 열립니다. 계정을
                만든 뒤에도 v1 콘솔(<span className="mono">/ui/</span>)의 방 코드 로그인은 계속 쓸 수 있습니다.
              </p>
            </div>
            <div>
              <label className="label" htmlFor="up-id">
                새 아이디
              </label>
              <input
                id="up-id"
                className="field mono"
                autoComplete="username"
                spellCheck={false}
                value={loginId}
                onChange={(e) => setLoginId(e.target.value)}
                placeholder="3~40자"
              />
            </div>
            <div>
              <label className="label" htmlFor="up-pw">
                새 비밀번호
              </label>
              <input
                id="up-pw"
                className="field"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="12자 이상"
              />
            </div>
            <div>
              <label className="label" htmlFor="up-name">
                표시 이름 (선택)
              </label>
              <input
                id="up-name"
                className="field"
                maxLength={40}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="예: 정인권"
              />
            </div>
            {error ? (
              <p role="alert" className="auth-error">
                {error}
              </p>
            ) : null}
            <button type="submit" className="btn btn-primary w-full" disabled={busy === "upgrade"}>
              {busy === "upgrade" ? "만드는 중…" : "계정 만들고 계속"}
            </button>
            <button
              type="button"
              className="btn btn-ghost w-full text-muted"
              onClick={() => {
                setTicket("");
                goto("legacy");
              }}
            >
              ← 방 코드로 돌아가기
            </button>
            <a className="btn btn-ghost w-full text-muted" href="/ui/" target="_blank" rel="noopener noreferrer">
              계정 없이 v1 콘솔(/ui/)에서 계속 쓰기
            </a>
          </form>
        ) : null}

        {mode === "onboard" ? (
          <form className="mt-4 space-y-3" onSubmit={submitOwner}>
            <p className="text-[12.5px] leading-relaxed text-muted">
              관리자 키로 오너 계정과 워크스페이스(로비 포함)를 만듭니다.
            </p>

            {setup && setup.needs_owner === false ? (
              <div className="notice-box">
                <p className="notice-title">이미 오너 계정이 있습니다</p>
                <p className="notice-text">계정 로그인으로 들어가세요. 비밀번호를 잊었다면 서버 관리자 키로 재발급할 수 있습니다.</p>
              </div>
            ) : null}

            {setup && setup.needs_owner !== false && !setup.bootstrap_allowed && !newKey ? (
              <div className="notice-box">
                <p className="notice-title">관리자 키를 알아야 계정을 만들 수 있습니다</p>
                <p className="notice-text">
                  이 서버는 관리자 키가 이미 설정되어 있어 웹에서 새 키를 만들 수 없습니다. 키를 모르면 계정을 만들 수 없으니,
                  아래 길로 가세요.
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {setup.legacy_rooms ? (
                    <button type="button" className="btn btn-sm" onClick={() => goto("legacy")}>
                      기존 방 코드로 계정 만들기 ({setup.legacy_rooms}개)
                    </button>
                  ) : null}
                  <a className="btn btn-sm" href="/ui/" target="_blank" rel="noopener noreferrer">
                    v1 콘솔(/ui/)에서 계속 쓰기
                  </a>
                </div>
              </div>
            ) : null}

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
                  </>
                ) : (
                  <>
                    <p className="text-[12.5px] leading-relaxed text-muted">
                      이 서버에는 아직 관리자 키가 없습니다. 아래에서 한 번만 만들 수 있습니다.
                    </p>
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
              <label className="label" htmlFor="admin-key">
                관리자 키
              </label>
              <input
                id="admin-key"
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
              <label className="label" htmlFor="own-id">
                아이디
              </label>
              <input
                id="own-id"
                className="field mono"
                autoComplete="username"
                spellCheck={false}
                placeholder="3~40자 (글자, 숫자, . _ -)"
                value={loginId}
                onChange={(e) => setLoginId(e.target.value)}
              />
            </div>
            <div>
              <label className="label" htmlFor="own-pw">
                비밀번호
              </label>
              <input
                id="own-pw"
                className="field"
                type="password"
                autoComplete="new-password"
                placeholder="12자 이상"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="label" htmlFor="own-name">
                  표시 이름
                </label>
                <input
                  id="own-name"
                  className="field"
                  maxLength={40}
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="선택"
                />
              </div>
              <div>
                <label className="label" htmlFor="own-ws">
                  워크스페이스 이름
                </label>
                <input
                  id="own-ws"
                  className="field"
                  maxLength={80}
                  value={workspaceName}
                  onChange={(e) => setWorkspaceName(e.target.value)}
                  placeholder="우리 집"
                />
              </div>
            </div>
            {error ? (
              <p role="alert" className="auth-error">
                {error}
              </p>
            ) : null}
            <button type="submit" className="btn btn-primary w-full" disabled={busy === "owner"}>
              {busy === "owner" ? "만드는 중…" : "계정·워크스페이스 만들기"}
            </button>
            {setup?.needs_owner === false ? (
              <button type="button" className="btn btn-ghost w-full text-muted" onClick={() => goto("login")}>
                ← 계정 로그인으로
              </button>
            ) : null}
          </form>
        ) : null}

        {mode === "created" && created ? (
          <div className="mt-4 space-y-3">
            <div>
              <h2 className="text-[15px] font-extrabold">워크스페이스가 준비되었습니다</h2>
              <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
                로비에서 비서를 초대하세요. 초대 링크는 비서실에서 언제든 새로 만들 수 있습니다.
              </p>
            </div>
            <dl className="space-y-2 rounded-lg border border-line bg-surface-2 p-3 text-[12.5px]">
              <div>
                <dt className="text-[11.5px] font-bold text-muted">워크스페이스</dt>
                <dd className="font-semibold">{created.workspace.name}</dd>
              </div>
              <div>
                <dt className="text-[11.5px] font-bold text-muted">아이디</dt>
                <dd className="mono select-all">{created.owner.login_id}</dd>
              </div>
              <div>
                <dt className="text-[11.5px] font-bold text-muted">로비</dt>
                <dd className="mono select-all">{created.lobby_room.id}</dd>
              </div>
            </dl>
            {newKey ? (
              <div className="card space-y-1">
                <p className="text-[12px] font-bold text-muted">관리자 키 · 지금만 표시</p>
                <p className="secret select-all">{newKey}</p>
                <button type="button" className="btn btn-sm mt-1" onClick={() => copy(newKey, "관리자 키를 복사했습니다.")}>
                  <Icon name="copy" size={13} /> 복사
                </button>
              </div>
            ) : null}
            <button type="button" className="btn btn-primary w-full" onClick={onAuthed}>
              관제실로 들어가기
            </button>
          </div>
        ) : null}

        {mode !== "created" ? (
          <p className="mt-4 text-center text-[11px] leading-relaxed text-faint">
            계정 없이 쓰던 예전 콘솔은 <a className="msg-link" href="/ui/">/ui/</a> 에서 그대로 열립니다.
          </p>
        ) : null}
      </div>
    </div>
  );
}
