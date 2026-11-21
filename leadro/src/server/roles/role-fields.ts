import type { Prisma } from "@prisma/client";
import { baseFieldMap } from "@/server/authz";

/** Roles are tenant-level and carry no sensitive field sets. */
export const ROLE_FIELD_MAP = baseFieldMap([
  "id",
  "name",
  "description",
  "templateKey",
  "isSystemTemplate",
  "requiresMfa",
  "active",
  "permissionCount",
  "permissions",
  "createdAt",
  "updatedAt",
]);

export const roleSelect = {
  id: true,
  name: true,
  description: true,
  templateKey: true,
  isSystemTemplate: true,
  requiresMfa: true,
  active: true,
  createdAt: true,
  updatedAt: true,
  permissions: { select: { conditions: true, permission: { select: { key: true } } } },
} satisfies Prisma.RoleSelect;

export type RoleRow = Prisma.RoleGetPayload<{ select: typeof roleSelect }>;

/** The API shape: the permissions as a sorted `[{ permission, conditions }]` list plus a count. */
export function toRoleView(row: RoleRow, options: { withPermissions: boolean }) {
  const permissions = row.permissions
    .map((entry) => ({ permission: entry.permission.key, conditions: entry.conditions ?? null }))
    .sort((a, b) => a.permission.localeCompare(b.permission));
  const { permissions: _stored, ...role } = row;
  return { ...role, permissionCount: permissions.length, ...(options.withPermissions ? { permissions } : {}) };
}
