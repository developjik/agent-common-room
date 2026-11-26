// 화면 아이콘: 인라인 SVG만 쓴다(외부 CDN·data URI 금지, CSP 'self').
import type { SVGProps } from "react";

export type IconName =
  | "menu"
  | "close"
  | "send"
  | "plus"
  | "hash"
  | "users"
  | "settings"
  | "sun"
  | "moon"
  | "monitor"
  | "copy"
  | "reply"
  | "at"
  | "thread"
  | "chevron-down"
  | "chevron-right"
  | "alert"
  | "check"
  | "clock"
  | "trash"
  | "logout"
  | "link"
  | "pause"
  | "play"
  | "inbox"
  | "bolt"
  | "lock"
  | "gauge"
  | "rooms"
  | "bot"
  | "search";

const PATHS: Record<IconName, JSX.Element> = {
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  send: <path d="M4 12l16-8-6 16-3-7-7-1z" />,
  plus: <path d="M12 5v14M5 12h14" />,
  hash: <path d="M10 3L8 21M16 3l-2 18M4 9h16M3 15h16" />,
  users: (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 20a5.5 5.5 0 0 1 11 0" />
      <path d="M16 5.5a3 3 0 0 1 0 5.6M17 14.2a5.5 5.5 0 0 1 3.5 5.1" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2.5M12 18.5V21M4.2 7.5l2.2 1.2M17.6 15.3l2.2 1.2M4.2 16.5l2.2-1.2M17.6 8.7l2.2-1.2" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  moon: <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />,
  monitor: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M9 20h6M12 16v4" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
    </>
  ),
  reply: (
    <>
      <path d="M9 14L4 9l5-5" />
      <path d="M4 9h9.5A6.5 6.5 0 0 1 20 15.5V20" />
    </>
  ),
  at: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M16 8v5a2.5 2.5 0 0 0 5 0v-1a9 9 0 1 0-3.6 7.2" />
    </>
  ),
  thread: <path d="M20 12.5a7.5 7.5 0 0 1-7.5 7.5H8l-4 3v-6.2A7.5 7.5 0 1 1 20 12.5z" />,
  "chevron-down": <path d="M6 9l6 6 6-6" />,
  "chevron-right": <path d="M9 6l6 6-6 6" />,
  alert: (
    <>
      <path d="M12 3.5l9 16.5H3z" />
      <path d="M12 9.5v4.5M12 17h.01" />
    </>
  ),
  check: <path d="M20 6L9 17l-5-5" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.2 2" />
    </>
  ),
  trash: <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 10v6M14 10v6" />,
  logout: <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 8l-4 4 4 4M6 12h9" />,
  link: (
    <>
      <path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1" />
      <path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1" />
    </>
  ),
  pause: (
    <>
      <rect x="7" y="5" width="3.5" height="14" rx="1" />
      <rect x="13.5" y="5" width="3.5" height="14" rx="1" />
    </>
  ),
  play: <path d="M8 5l11 7-11 7z" />,
  inbox: (
    <>
      <path d="M3 13l3-8h12l3 8v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M3 13h5l1.5 2.5h5L16 13h5" />
    </>
  ),
  bolt: <path d="M13 2L5 14h6l-1 8 9-13h-6z" />,
  lock: (
    <>
      <rect x="4.5" y="10" width="15" height="10" rx="2" />
      <path d="M8 10V7.5a4 4 0 0 1 8 0V10" />
    </>
  ),
  gauge: (
    <>
      <path d="M3.5 17a9 9 0 1 1 17 0" />
      <path d="M12 17l4.2-5.4" />
      <circle cx="12" cy="17" r="1.3" />
    </>
  ),
  rooms: (
    <>
      <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" />
    </>
  ),
  bot: (
    <>
      <rect x="4.5" y="8" width="15" height="11.5" rx="3" />
      <path d="M12 8V4.5M9 13h.01M15 13h.01M9.5 16.2h5" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.6-3.6" />
    </>
  ),
};

interface IconProps extends SVGProps<SVGSVGElement> {
  name: IconName;
  size?: number;
}

export function Icon({ name, size = 16, ...rest }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {PATHS[name]}
    </svg>
  );
}
