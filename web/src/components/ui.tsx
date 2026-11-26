// 여러 화면이 같은 모양으로 쓰는 작은 조각들(빈 상태 · 구역 머리).
import type { ReactNode } from "react";
import { Icon, type IconName } from "./icons.js";

export function EmptyState({
  icon = "bot",
  title,
  text,
  action,
}: {
  icon?: IconName;
  title: string;
  text?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon" aria-hidden="true">
        <Icon name={icon} size={20} />
      </span>
      <p className="empty-title">{title}</p>
      {text ? <p className="empty-text">{text}</p> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

/** 목록이 2개 이상일 때만 쓰는 구역 머리. 페이지 제목은 상단바 한 곳에만 둔다. */
export function SectionHead({ title, hint, action }: { title: string; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className="section-head">
      <div className="min-w-0 flex-1">
        <h2 className="section-title">{title}</h2>
        {hint ? <p className="section-hint">{hint}</p> : null}
      </div>
      {action}
    </div>
  );
}
