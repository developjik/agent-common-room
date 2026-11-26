// 설정: 계정·워크스페이스 정보, 테마, 세션 로그아웃. (정책·웹훅은 기존 콘솔 /ui/ 로 안내)
import { useState } from "react";
import { Icon } from "./icons.js";
import { useToast } from "./Toast.js";
import { useConfirm } from "./ConfirmDialog.js";
import { api } from "../lib/api.js";
import { fmtFull, relTime } from "../lib/format.js";
import type { Theme } from "../hooks/useTheme.js";
import type { Owner, Workspace } from "../lib/types.js";

interface Props {
  owner: Owner;
  workspace: Workspace;
  theme: Theme;
  onTheme: (t: Theme) => void;
  onLogout: () => void;
  syncedAt: number | null;
}

const THEMES: { key: Theme; label: string; icon: "sun" | "moon" | "monitor" }[] = [
  { key: "light", label: "라이트", icon: "sun" },
  { key: "dark", label: "다크", icon: "moon" },
  { key: "system", label: "시스템", icon: "monitor" },
];

export function SettingsView({ owner, workspace, theme, onTheme, onLogout, syncedAt }: Props) {
  const notify = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);

  const logoutAll = async () => {
    const ok = await confirm({
      title: "모든 기기에서 로그아웃할까요?",
      text: "이 계정의 모든 브라우저 세션이 사라집니다. 다른 기기에서도 다시 로그인해야 합니다.",
      ok: "모두 로그아웃",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.logout(true);
    } catch (e) {
      notify(e instanceof Error ? e.message : "로그아웃하지 못했습니다.");
    } finally {
      setBusy(false);
      onLogout();
    }
  };

  return (
    <div className="page page-narrow">
      <section className="settings-card">
        <h2 className="section-title">계정</h2>
        <dl className="kv mt-2">
          <div>
            <dt>표시 이름</dt>
            <dd>{owner.display_name || "(없음)"}</dd>
          </div>
          <div>
            <dt>아이디</dt>
            <dd className="mono select-all">{owner.login_id}</dd>
          </div>
          <div>
            <dt>만든 시각</dt>
            <dd>{fmtFull(owner.created_at)}</dd>
          </div>
          <div>
            <dt>마지막 로그인</dt>
            <dd>{owner.last_login_at ? `${fmtFull(owner.last_login_at)} (${relTime(owner.last_login_at)})` : "-"}</dd>
          </div>
        </dl>
        <p className="panel-note mt-2">로그인 유지 30일</p>
      </section>

      <section className="settings-card">
        <h2 className="section-title">워크스페이스</h2>
        <dl className="kv mt-2">
          <div>
            <dt>이름</dt>
            <dd>{workspace.name}</dd>
          </div>
          <div>
            <dt>ID</dt>
            <dd className="mono select-all">{workspace.id}</dd>
          </div>
          <div>
            <dt>로비</dt>
            <dd className="mono select-all">{workspace.lobby_room_id ?? "-"}</dd>
          </div>
        </dl>
        {workspace.legacy ? (
          <p className="notice-box mt-3">
            <span className="notice-title">v1 방에서 옮겨 온 워크스페이스</span>
            <span className="notice-text">기존 방 코드 로그인도 계속 동작합니다. 계정 로그인으로 옮겨 두면 새 기기에서도 편합니다.</span>
          </p>
        ) : null}
      </section>

      <section className="settings-card">
        <h2 className="section-title">화면</h2>
        <div className="theme-choice mt-2" role="group" aria-label="테마">
          {THEMES.map((t) => (
            <button key={t.key} type="button" className="theme-btn" aria-pressed={theme === t.key} onClick={() => onTheme(t.key)}>
              <Icon name={t.icon} size={16} />
              {t.label}
            </button>
          ))}
        </div>
        <p className="panel-note mt-2">계정을 만들지 않고 v1 콘솔(<a className="msg-link" href="/ui/">/ui/</a>)을 쓸 수 있습니다</p>
      </section>

      <section className="settings-card">
        <h2 className="section-title">연결</h2>
        <p className="panel-note mt-2">
          마지막 동기화 {syncedAt ? relTime(new Date(syncedAt).toISOString()) : "아직 없음"}
        </p>
        <p className="panel-note mt-2">
          방 정책·보존 기간·웹훅은 방에서 <strong>구성원 → 방</strong> 탭에서 바꿉니다.
        </p>
      </section>

      <section className="settings-card">
        <h2 className="section-title">세션</h2>
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" className="btn" onClick={onLogout}>
            <Icon name="logout" size={14} /> 이 브라우저에서 로그아웃
          </button>
          <button type="button" className="btn btn-danger" onClick={() => void logoutAll()} disabled={busy}>
            모든 기기에서 로그아웃
          </button>
        </div>
      </section>
    </div>
  );
}
