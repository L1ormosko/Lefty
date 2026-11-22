import type { MessageKey } from "@/lib/i18n";
import { can, resolveScope } from "@/server/authz";
import type { Actor } from "@/server/core";
import { withTenant } from "@/server/db";

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
   * Scope-aware rule for administration screens (instead of `permission`): visible with a
   * non-OWN `<module>.view` scope or the module's administrative permission.
   */
  adminModule?: { module: string; adminPermission: string; /** The screen shows tenant-level records, so only a TENANT-scoped grant is useful. */ tenantLevel?: boolean };
  /**
   * False while the destination page does not exist yet. Such items are defined here so their
   * permission rule is settled and tested, but they are never shown: a link to a 404 is worse
   * than no link. The task that builds the page flips this to true.
   */
  isAvailable: boolean;
}

export const NAVIGATION_ITEMS: readonly NavigationItem[] = [
  { id: "overview", labelKey: "NAV.OVERVIEW", href: "/", isAvailable: true },
  // Administration screens (Task 8). Their visibility is scope-aware (see `canSeeAdminModule`): a
  // Technician holds employees.view / localization.view over their OWN record only, which must not
  // surface the employee directory or the translation editor.
  { id: "company", labelKey: "NAV.COMPANY_OVERVIEW", href: "/admin/company", adminModule: { module: "company_settings", adminPermission: "company_settings.configure", tenantLevel: true }, isAvailable: true },
  { id: "organization", labelKey: "NAV.ORGANIZATION", href: "/admin/organization", adminModule: { module: "organization", adminPermission: "organization.manage" }, isAvailable: true },
  { id: "employees", labelKey: "NAV.EMPLOYEES", href: "/admin/employees", adminModule: { module: "employees", adminPermission: "employees.edit" }, isAvailable: true },
  { id: "users", labelKey: "NAV.USERS", href: "/admin/users", adminModule: { module: "users", adminPermission: "users.manage" }, isAvailable: true },
  { id: "roles", labelKey: "NAV.ROLES_AND_ACCESS", href: "/admin/roles", adminModule: { module: "permissions", adminPermission: "permissions.manage" }, isAvailable: true },
  { id: "audit", labelKey: "NAV.AUDIT_LOG", href: "/admin/audit", permission: "audit.view", isAvailable: false },
  { id: "localization", labelKey: "NAV.LOCALIZATION", href: "/admin/localization", adminModule: { module: "localization", adminPermission: "localization.configure", tenantLevel: true }, isAvailable: true },
];

/**
 * Whether an administration module belongs in this actor's navigation: they hold `<module>.view`
 * over at least one scope beyond their own record (tenant, legal entity or org unit), or hold the module's administrative permission outright. Capability checks alone
 * ignore data scope, so a Technician (view of their own record) would wrongly qualify.
 * Decided from granted permissions only (never role names, §4.2) and re-read on every call (§25.5).
 */
export async function canSeeAdminModule(actor: Actor, module: string, adminPermission: string, tenantLevel = false): Promise<boolean> {
  // Tenant-level screens (company profile, translations) reject unit-scoped grants in their
  // services, so a unit-scoped `view` must not surface the link (it would lead to access denied).
  if (tenantLevel) return (await can(actor, `${module}.view`, {})).allowed;
  const scope = await withTenant(actor.tenantId, (tx) => resolveScope(tx, actor, `${module}.view`));
  // OWN is the person's own record; ASSIGNED is "records assigned to me" (jobs, leads) and means
  // nothing for administration data. Neither makes a directory or an editor worth showing.
  if (scope.parts.some((part) => part.type === "TENANT" || part.type === "LEGAL_ENTITY" || part.type === "ORG_UNIT")) return true;
  return (await can(actor, adminPermission)).allowed;
}

async function isVisible(actor: Actor, item: NavigationItem): Promise<boolean> {
  if (item.adminModule) return canSeeAdminModule(actor, item.adminModule.module, item.adminModule.adminPermission, item.adminModule.tenantLevel);
  return !item.permission || (await can(actor, item.permission)).allowed;
}

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
  const allowed = await Promise.all(candidates.map((item) => isVisible(actor, item)));
  return candidates.filter((_, index) => allowed[index]);
}
