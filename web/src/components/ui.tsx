// 여러 화면이 같은 모양으로 쓰는 작은 조각들(상태 LED · 빈 상태 · 구역 머리).
import type { ReactNode } from "react";
import { healthLabel } from "../lib/views.js";
import type { RoomHealth } from "../lib/types.js";
import { Icon, type IconName } from "./icons.js";

/**
 * 상태 LED + 문자 라벨. 색만으로 상태를 말하지 않는다(접근성).
 * 정상(ok·idle)은 아무것도 그리지 않는다 — "정상은 침묵한다". 근거는 title 로만 남긴다.
 */
export function StatusLed({ health, label }: { health: RoomHealth | string; label?: string }) {
  const h = healthLabel(health);
  if (h.quiet && !label) return null;
  return (
    <span className="led" data-tone={h.tone} title={h.hint}>
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
