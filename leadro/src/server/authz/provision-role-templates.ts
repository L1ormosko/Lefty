import type { Prisma } from "@prisma/client";
import { ConflictError } from "@/server/core";
import type { TenantTx } from "@/server/db";
import { PERMISSION_CATALOG, permissionKey } from "./permission-catalog";
import { ROLE_TEMPLATES } from "./role-templates";

/**
 * Makes sure every catalog permission exists in the global `Permission` table and returns
 * `key -> id`. Idempotent; existing rows are left alone. `Permission` is not tenant-owned (no RLS).
 */
export async function syncPermissionCatalog(tx: TenantTx): Promise<Map<string, string>> {
  await tx.permission.createMany({
    data: PERMISSION_CATALOG.map((def) => ({
      key: permissionKey(def),
      module: def.module,
      action: def.action,
      description: def.description,
      sensitive: def.sensitive ?? false,
    })),
    skipDuplicates: true,
  });
  const rows = await tx.permission.findMany({ select: { id: true, key: true } });
  return new Map(rows.map((row) => [row.key, row.id]));
}

/**
 * Creates the spec 4.4 role templates as ordinary roles of `tenantId` (`isSystemTemplate` marks
 * their origin; `templateKey` records which template they came from). Run it inside
 * `withTenant(tenantId, tx => ...)`; Task 5's seed calls it when creating a tenant.
 *
 * Idempotent and non-destructive: a role that already exists for a template is left exactly as the
 * tenant edited it, so re-running never resets customised permissions.
 *
 * @returns `templateKey -> roleId` for every template (existing or newly created).
 * @throws ConflictError when a role with a template's name exists but was not created from it.
 */
export async function provisionRoleTemplates(tx: TenantTx, tenantId: string): Promise<Record<string, string>> {
  const permissionIds = await syncPermissionCatalog(tx);
  const existing = await tx.role.findMany({
    where: { tenantId },
    select: { id: true, name: true, templateKey: true },
  });
  const roleIdByTemplate: Record<string, string> = {};

  for (const template of ROLE_TEMPLATES) {
    const already = existing.find((role) => role.templateKey === template.key);
    if (already) {
      roleIdByTemplate[template.key] = already.id;
      continue;
    }
    if (existing.some((role) => role.name === template.name)) {
      throw new ConflictError({ message: `A role named "${template.name}" already exists and is not that template.` });
    }

    const role = await tx.role.create({
      data: {
        tenantId,
        name: template.name,
        description: template.description,
        templateKey: template.key,
        isSystemTemplate: true,
        requiresMfa: template.requiresMfa,
      },
      select: { id: true },
    });
    await tx.rolePermission.createMany({
      data: template.grants.map((grant) => {
        const permissionId = permissionIds.get(grant.permission);
        if (!permissionId) throw new Error(`Permission "${grant.permission}" missing after catalog sync`);
        return {
          tenantId,
          roleId: role.id,
          permissionId,
          conditions: grant.conditions ? (grant.conditions as Prisma.InputJsonValue) : undefined,
        };
      }),
    });
    roleIdByTemplate[template.key] = role.id;
  }
  return roleIdByTemplate;
}
