import { avatarTone } from "../lib/format.js";

export function Avatar({ name, small = false, className = "" }: { name: string; small?: boolean; className?: string }) {
  const initial = Array.from(name.trim())[0] ?? "?";
  return (
    <span className={`avatar ${small ? "avatar-sm" : ""} av-${avatarTone(name)} ${className}`} aria-hidden="true">
      {initial.toUpperCase()}
    </span>
  );
}
