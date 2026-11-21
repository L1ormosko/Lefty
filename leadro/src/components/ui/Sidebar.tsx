import type { ReactNode } from "react";
import { cx, focusRing } from "./cx";

export interface SidebarItem {
  id: string;
  /** Already-translated link text. */
  label: string;
  href: string;
  icon?: ReactNode;
  /** Marks the page the user is on (aria-current). Computed by the caller. */
  isCurrent?: boolean;
}

export interface SidebarProps {
  /** Accessible name of the navigation landmark. */
  label: string;
  items: SidebarItem[];
  /** Slot above the links, typically the product/tenant name. */
  header?: ReactNode;
  /** Slot below the links, typically a UserProfileCard. */
  footer?: ReactNode;
}

/** Vertical navigation. Presentation only: which items exist and which is current is decided elsewhere. */
export function Sidebar({ label, items, header, footer }: SidebarProps) {
  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-e border-line bg-surface">
      {header ? <div className="border-b border-line p-4">{header}</div> : null}
      <nav aria-label={label} className="flex-1 overflow-y-auto p-2">
        <ul className="space-y-1">
          {items.map((item) => (
            <li key={item.id}>
              <a
                href={item.href}
                aria-current={item.isCurrent ? "page" : undefined}
                className={cx(
                  "flex items-center gap-2 rounded px-3 py-2 text-sm text-start",
                  focusRing,
                  item.isCurrent
                    ? "bg-brand-50 font-semibold text-brand-700"
                    : "text-ink hover:bg-neutral-soft",
                )}
              >
                {item.icon}
                <span>{item.label}</span>
              </a>
            </li>
          ))}
        </ul>
      </nav>
      {footer ? <div className="border-t border-line p-3">{footer}</div> : null}
    </aside>
  );
}
