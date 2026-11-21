import type { MessageKey } from "@/lib/i18n";
import { can } from "@/server/authz";
import type { Actor } from "@/server/core";

/**
 * One entry of the workspace navigation (§5). This file is the single place that says which
 * screens exist in the sidebar and what each one requires.
 */
export interface NavigationItem {
  id: string;
  labelKey: MessageKey;
  href: string;
  /** Catalog permission (`module.action`) needed to see the item; omitted = every signed-in user. */
  permission?: string;
  /**
   * False while the destination page does not exist yet. Such items are defined here so their
   * permission rule is settled and tested, but they are never shown: a link to a 404 is worse
   * than no link. The task that builds the page flips this to true.
   */
  isAvailable: boolean;
}

export const NAVIGATION_ITEMS: readonly NavigationItem[] = [
  { id: "overview", labelKey: "NAV.OVERVIEW", href: "/", isAvailable: true },
  // Administration screens arrive with Task 8 (admin UI). They are gated on MANAGEMENT permissions
  // where a plain `view` is also held by self-service roles: a Technician holds employees.view and
  // localization.view (own record only), which must not surface the employee directory or the
  // translation editor. Capability checks ignore data scope, so the item permission has to be one
  // that only managers hold.
  { id: "organization", labelKey: "NAV.ORGANIZATION", href: "/admin/organization", permission: "organization.view", isAvailable: false },
  { id: "employees", labelKey: "NAV.EMPLOYEES", href: "/admin/employees", permission: "employees.edit", isAvailable: false },
  { id: "users", labelKey: "NAV.USERS", href: "/admin/users", permission: "users.view", isAvailable: false },
  { id: "roles", labelKey: "NAV.ROLES_AND_ACCESS", href: "/admin/roles", permission: "permissions.view", isAvailable: false },
  { id: "audit", labelKey: "NAV.AUDIT_LOG", href: "/admin/audit", permission: "audit.view", isAvailable: false },
  { id: "localization", labelKey: "NAV.LOCALIZATION", href: "/admin/localization", permission: "localization.edit", isAvailable: false },
];

/**
 * The items this actor may see, decided on the server from granted permissions only (never from
 * role names, §4.2). Each check re-reads the database (§25.5), so a revoked grant disappears on
 * the next page load. Hiding a link is a convenience: every destination page and API route still
 * enforces the permission itself.
 *
 * `items` is injectable so tests can exercise the permission rules of not-yet-built pages.
 */
export async function getNavigation(
  actor: Actor,
  items: readonly NavigationItem[] = NAVIGATION_ITEMS,
): Promise<NavigationItem[]> {
  const candidates = items.filter((item) => item.isAvailable);
  const allowed = await Promise.all(
    candidates.map(async (item) => !item.permission || (await can(actor, item.permission)).allowed),
  );
  return candidates.filter((_, index) => allowed[index]);
}
