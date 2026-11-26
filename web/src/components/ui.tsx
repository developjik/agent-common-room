// 여러 화면이 같은 모양으로 쓰는 작은 조각들(상태 LED · 빈 상태 · 구역 머리).
import type { ReactNode } from "react";
import { healthLabel } from "../lib/views.js";
import type { RoomHealth } from "../lib/types.js";
import { Icon, type IconName } from "./icons.js";

/** 상태 LED + 문자 라벨. 색만으로 상태를 말하지 않는다(접근성). */
export function StatusLed({ health, label }: { health: RoomHealth | string; label?: string }) {
  const h = healthLabel(health);
  return (
    <span className="led" data-tone={h.tone}>
      <span className="led-dot" aria-hidden="true" />
      {label ?? h.label}
    </span>
  );
}

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
        <Icon name={icon} size={22} />
      </span>
      <p className="empty-title">{title}</p>
      {text ? <p className="empty-text">{text}</p> : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}

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
