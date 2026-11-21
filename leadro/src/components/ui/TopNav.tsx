import type { ReactNode } from "react";

export interface TopNavProps {
  /** Leading slot: menu toggle, product name, breadcrumb. */
  start?: ReactNode;
  /** Middle slot: usually a Search. */
  center?: ReactNode;
  /** Trailing slot: notifications, language switcher, user menu. */
  end?: ReactNode;
}

/** Top bar shell (banner landmark) with three slots; it contains no behaviour of its own. */
export function TopNav({ start, center, end }: TopNavProps) {
  return (
    <header className="flex items-center gap-4 border-b border-line bg-surface px-4 py-2">
      <div className="flex items-center gap-2">{start}</div>
      <div className="min-w-0 flex-1">{center}</div>
      <div className="flex items-center gap-2">{end}</div>
    </header>
  );
}
