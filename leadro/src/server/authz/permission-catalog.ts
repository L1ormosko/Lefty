/**
 * Permission catalog: the fixed set of (module, action) pairs the platform checks (spec 4.3).
 * Seeded into the global `Permission` table. Roles are tenant-configurable bundles of these;
 * role names never grant access. Keep docs/PERMISSIONS.md in sync with this file.
 */
export const PERMISSION_ACTIONS = [
  "VIEW",
  "CREATE",
  "EDIT",
  "ARCHIVE",
  "ASSIGN",
  "APPROVE",
  "REJECT",
  "EXPORT",
  "MANAGE",
  "CONFIGURE",
] as const;
export type PermissionActionName = (typeof PERMISSION_ACTIONS)[number];

export interface PermissionDef {
  module: string;
  action: PermissionActionName;
  description: string;
  sensitive?: boolean;
}

const mod = (
  module: string,
  label: string,
  actions: PermissionActionName[],
  sensitiveActions: PermissionActionName[] = [],
): PermissionDef[] =>
  actions.map((action) => ({
    module,
    action,
    description: `${action.toLowerCase()} ${label}`,
    sensitive: sensitiveActions.includes(action),
  }));

export const PERMISSION_CATALOG: PermissionDef[] = [
  ...mod("company_settings", "company settings", ["VIEW", "EDIT", "CONFIGURE"], ["CONFIGURE"]),
  ...mod("organization", "organization structure", ["VIEW", "CREATE", "EDIT", "ARCHIVE", "ASSIGN", "MANAGE"]),
  ...mod("users", "user accounts", ["VIEW", "CREATE", "EDIT", "ARCHIVE", "MANAGE"], ["MANAGE"]),
  ...mod("employees", "employee records", ["VIEW", "CREATE", "EDIT", "ARCHIVE", "ASSIGN", "EXPORT"], ["EXPORT"]),
  ...mod("permissions", "roles and access", ["VIEW", "CREATE", "EDIT", "ARCHIVE", "ASSIGN", "APPROVE", "MANAGE"], ["ASSIGN", "MANAGE"]),
  ...mod("audit", "audit log", ["VIEW", "EXPORT"], ["EXPORT"]),
  ...mod("localization", "translations", ["VIEW", "EDIT", "CONFIGURE"]),
  ...mod("customers", "customers", ["VIEW", "CREATE", "EDIT", "ARCHIVE", "EXPORT"]),
  ...mod("leads", "leads", ["VIEW", "CREATE", "EDIT", "ARCHIVE", "ASSIGN", "EXPORT"]),
  ...mod("dispatch", "dispatch", ["VIEW", "CREATE", "EDIT", "ASSIGN", "MANAGE"]),
  ...mod("jobs", "jobs", ["VIEW", "CREATE", "EDIT", "ARCHIVE", "ASSIGN", "APPROVE", "REJECT", "EXPORT"]),
  ...mod("compensation", "compensation", ["VIEW", "CREATE", "EDIT", "APPROVE", "REJECT", "EXPORT", "CONFIGURE"], ["VIEW", "APPROVE", "CONFIGURE"]),
  ...mod("financial_reports", "financial reports", ["VIEW", "EXPORT"], ["VIEW", "EXPORT"]),
  ...mod("performance", "performance data", ["VIEW", "EXPORT"]),
];

export const permissionKey = (p: Pick<PermissionDef, "module" | "action">) =>
  `${p.module}.${p.action.toLowerCase()}`;
