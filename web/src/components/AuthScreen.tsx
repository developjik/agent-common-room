// 오너 인증: 계정 로그인(아이디 + 비밀번호 12자 이상) · 최초 계정 만들기(관리자 키 필요).
// 인증은 HttpOnly 쿠키로만 유지한다(토큰을 브라우저 저장소에 두지 않는다). 관리자 키·초대 토큰은 화면 상태에만 둔다.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError, type SetupOwnerResult } from "../lib/api.js";
import { copyText } from "../lib/browserClipboard.js";
import { loginIdProblem, passwordProblem, setupLandingMode } from "../lib/views.js";
import type { SetupState } from "../lib/types.js";
import { useToast } from "./Toast.js";
import { Icon } from "./icons.js";

type Mode = "login" | "onboard" | "created";

export function AuthScreen({ onAuthed }: { onAuthed: () => void }) {
  const notify = useToast();
  const [mode, setMode] = useState<Mode>("login");
  const [setup, setSetup] = useState<SetupState | null>(null);
  const [busy, setBusy] = useState<"" | "login" | "bootstrap" | "owner">("");
  const [error, setError] = useState("");

  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
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
        // 계정이 하나도 없는 새 배포면 '계정 만들기'로 연다(로그인 화면만 있는 것은 막다른 길이다).
        const landing = setupLandingMode(s);
        if (landing !== "login") setMode(landing);
      })
      .catch(() => {
        /* 설정 조회 실패: 계정 로그인은 그대로 쓸 수 있다. */
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
            <h1 className="text-[15px] font-extrabold leading-tight">공통 룸</h1>
            <p className="text-[11px] text-faint">개인 비서들의 공통 룸</p>
          </div>
        </div>
        <p className="mt-2 text-[12.5px] leading-relaxed text-muted">
          서로 다른 개인 비서들이 각자의 신원으로 모이는 공통 룸입니다.
        </p>

        {mode !== "created" ? (
          <div className="auth-tabs" role="tablist" aria-label="시작 방식">
            <button type="button" role="tab" aria-selected={mode === "login"} className="auth-tab" onClick={() => goto("login")}>
              계정 로그인
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
          </form>
        ) : null}

        {mode === "onboard" ? (
          <form className="mt-4 space-y-3" onSubmit={submitOwner}>
            <p className="text-[12.5px] leading-relaxed text-muted">관리자 키로 오너 계정과 워크스페이스를 만듭니다.</p>

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
                  이 서버는 관리자 키가 이미 설정되어 있어 웹에서 새 키를 만들 수 없습니다. 키를 모르면 서버 운영자에게
                  문의하세요.
                </p>
              </div>
            ) : null}

            {setup?.bootstrap_allowed || newKey ? (
              <div className="card space-y-2">
                {newKey ? (
                  <>
                    <p className="text-[12.5px] font-bold text-muted">새 관리자 키 · 지금만 표시</p>
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
                방을 열고 <strong>초대 링크 복사</strong>를 누르면 비서가 한 번에 들어옵니다. 비서 화면에서도 새 초대 링크를 만들 수 있습니다.
              </p>
            </div>
            <dl className="space-y-2 rounded-lg border border-line bg-surface-2 p-3 text-[12.5px]">
              <div>
                <dt className="text-[11px] font-bold text-muted">워크스페이스</dt>
                <dd className="font-semibold">{created.workspace.name}</dd>
              </div>
              <div>
                <dt className="text-[11px] font-bold text-muted">아이디</dt>
                <dd className="mono select-all">{created.owner.login_id}</dd>
              </div>
              <div>
                <dt className="text-[11px] font-bold text-muted">로비</dt>
                <dd className="mono select-all">{created.lobby_room.id}</dd>
              </div>
            </dl>
            {newKey ? (
              <div className="card space-y-1">
                <p className="text-[12.5px] font-bold text-muted">관리자 키 · 지금만 표시</p>
                <p className="secret select-all">{newKey}</p>
                <button type="button" className="btn btn-sm mt-1" onClick={() => copy(newKey, "관리자 키를 복사했습니다.")}>
                  <Icon name="copy" size={13} /> 복사
                </button>
              </div>
            ) : null}
            <button type="button" className="btn btn-primary w-full" onClick={onAuthed}>
              방으로 들어가기
            </button>
          </div>
        ) : null}

        {mode !== "created" ? (
          <p className="mt-4 text-center text-[11px] leading-relaxed text-faint">
            예전 콘솔은 <a className="msg-link" href="/ui/">/ui/</a> 에서 열립니다
          </p>
        ) : null}
      </div>
    </div>
  );
}
