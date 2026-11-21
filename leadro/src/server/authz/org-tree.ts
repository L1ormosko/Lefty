import type { TenantTx } from "@/server/db";

/**
 * Expands scope roots to the org units they cover, using the org tree AS IT IS NOW.
 *
 * Archived (inactive) units grant nothing: a root that is archived is dropped, and the walk does
 * not pass through an archived unit, so its whole subtree is excluded too. Reparenting a unit
 * therefore changes access on the very next request (spec 25.5); nothing is cached.
 *
 * Runs inside the caller's `withTenant` transaction; the explicit tenantId filter is a second
 * line of defence on top of row-level security.
 */
export async function expandActiveOrgUnits(
  tx: TenantTx,
  tenantId: string,
  rootIds: string[],
  includeDescendants: boolean,
): Promise<string[]> {
  if (rootIds.length === 0) return [];
  if (!includeDescendants) {
    const roots = await tx.orgUnit.findMany({
      where: { tenantId, id: { in: rootIds }, active: true },
      select: { id: true },
    });
    return roots.map((unit) => unit.id);
  }
  const rows = await tx.$queryRaw<{ id: string }[]>`
    WITH RECURSIVE tree(id) AS (
      SELECT id FROM "OrgUnit"
      WHERE "tenantId" = ${tenantId} AND active AND id = ANY(${rootIds}::text[])
      UNION
      SELECT child.id FROM "OrgUnit" child
      JOIN tree parent ON child."parentId" = parent.id
      WHERE child."tenantId" = ${tenantId} AND child.active
    )
    SELECT id FROM tree`;
  return rows.map((row) => row.id);
}
