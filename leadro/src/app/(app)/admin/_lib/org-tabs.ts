import type { TranslateFn } from "@/lib/i18n";

export type OrganizationTab = "structure" | "branches" | "history";

/** Tab links shared by the three organization screens. */
export function organizationTabs(t: TranslateFn, current: OrganizationTab) {
  return [
    { href: "/admin/organization", label: t("ADMIN.ORG_TAB_STRUCTURE"), isCurrent: current === "structure" },
    { href: "/admin/organization/branches", label: t("ADMIN.ORG_TAB_BRANCHES"), isCurrent: current === "branches" },
    { href: "/admin/organization/history", label: t("ADMIN.ORG_TAB_HISTORY"), isCurrent: current === "history" },
  ];
}
