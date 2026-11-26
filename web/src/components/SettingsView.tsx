// 설정: 테마(라이트/다크)와 로그아웃. 그 외에는 계정 한 줄만 남긴다.
import { Icon } from "./icons.js";
import { useToast } from "./Toast.js";
import { useConfirm } from "./ConfirmDialog.js";
import { api } from "../lib/api.js";
import type { Theme } from "../hooks/useTheme.js";
import type { Owner, Workspace } from "../lib/types.js";

interface Props {
  owner: Owner;
  workspace: Workspace;
  theme: Theme;
  onTheme: (t: Theme) => void;
  onLogout: () => void;
}

export function SettingsView({ owner, workspace, theme, onTheme, onLogout }: Props) {
  const notify = useToast();
  const confirm = useConfirm();
  const dark = theme === "dark" || (theme === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches === true);

  const logoutAll = async () => {
    const ok = await confirm({
      title: "모든 기기에서 로그아웃할까요?",
      text: "이 계정의 모든 브라우저 세션이 사라집니다. 다른 기기에서도 다시 로그인해야 합니다.",
      ok: "모두 로그아웃",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.logout(true);
    } catch (e) {
      notify(e instanceof Error ? e.message : "로그아웃하지 못했습니다.");
    } finally {
      onLogout();
    }
  };

  return (
    <div className="page page-narrow">
      <section className="settings-card">
        <h2 className="section-title">테마</h2>
        <div className="theme-choice mt-2" role="group" aria-label="테마">
          <button type="button" className="theme-btn" aria-pressed={!dark} onClick={() => onTheme("light")}>
            <Icon name="sun" size={16} /> 라이트
          </button>
          <button type="button" className="theme-btn" aria-pressed={dark} onClick={() => onTheme("dark")}>
            <Icon name="moon" size={16} /> 다크
          </button>
        </div>
      </section>

      <section className="settings-card">
        <h2 className="section-title">계정</h2>
        <p className="panel-note mt-2">
          {owner.display_name || owner.login_id} · {workspace.name}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className="btn" onClick={onLogout}>
            <Icon name="logout" size={14} /> 로그아웃
          </button>
          <button type="button" className="btn btn-danger" onClick={() => void logoutAll()}>
            모든 기기에서 로그아웃
          </button>
        </div>
      </section>
    </div>
  );
}
