"use client";

import { usePathname } from "next/navigation";
import { Sidebar } from "@/components/ui";

export interface AppSidebarProps {
  /** Accessible name of the navigation landmark (translated). */
  label: string;
  /** Product / company name shown above the links. */
  productName: string;
  tenantName: string;
  /** Items the server already filtered by permission, with translated labels. */
  items: Array<{ id: string; label: string; href: string }>;
}

/** Marks the link of the page the user is on; the server cannot know the pathname in a layout. */
function isCurrentPath(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

export function AppSidebar({ label, productName, tenantName, items }: AppSidebarProps) {
  const pathname = usePathname();
  return (
    <Sidebar
      label={label}
      header={
        <div>
          <p className="text-lg font-bold text-brand-700">{productName}</p>
          <p className="truncate text-xs text-ink-muted">{tenantName}</p>
        </div>
      }
      items={items.map((item) => ({ ...item, isCurrent: isCurrentPath(pathname, item.href) }))}
    />
  );
}
