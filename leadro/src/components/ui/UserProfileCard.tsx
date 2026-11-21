import type { ReactNode } from "react";

export interface UserProfileCardProps {
  name: string;
  /** Already-translated role/title line. */
  subtitle?: string;
  email?: string;
  /** Optional trailing content, e.g. a StatusBadge or buttons. */
  children?: ReactNode;
}

/** First letters of up to two words; decorative, the full name is always rendered too. */
function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => Array.from(word)[0]?.toUpperCase() ?? "")
    .join("");
}

/** Compact identity card: initials avatar, name, role line, email. */
export function UserProfileCard({ name, subtitle, email, children }: UserProfileCardProps) {
  return (
    <div className="flex items-center gap-3 rounded border border-line bg-surface p-3">
      <span
        aria-hidden="true"
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-100 text-sm font-semibold text-brand-700"
      >
        {initialsOf(name)}
      </span>
      <div className="min-w-0 flex-1 text-start">
        <p className="truncate text-sm font-semibold text-ink">{name}</p>
        {subtitle ? <p className="truncate text-xs text-ink-muted">{subtitle}</p> : null}
        {email ? <p className="truncate text-xs text-ink-muted">{email}</p> : null}
      </div>
      {children ? <div className="shrink-0">{children}</div> : null}
    </div>
  );
}
