import type { TenantTx } from "@/server/db";

/**
 * Serialises every structural change of one tenant's org tree (create, move, archive) for the
 * rest of the transaction (T1 review: two concurrent re-parents can each pass the cycle check and
 * then both commit, e.g. A under B while B goes under A; the database trigger only sees committed
 * rows, so it can lose that race). A transaction-scoped advisory lock keyed by tenant is enough
 * because tree changes are rare, and it is released automatically on commit or rollback.
 *
 * Must be the first statement of the write transaction, before any read the decision depends on.
 */
export async function lockOrgTree(tx: TenantTx, tenantId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`org-tree:${tenantId}`}))`;
}

/**
 * Ids of `rootId` and every unit below it, archived ones included (a cycle through an archived unit
 * is still a cycle). Used to refuse moving a unit under its own descendant.
 */
export async function subtreeIds(tx: TenantTx, tenantId: string, rootId: string): Promise<string[]> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    WITH RECURSIVE subtree(id) AS (
      SELECT id FROM "OrgUnit" WHERE "tenantId" = ${tenantId} AND id = ${rootId}
      UNION
      SELECT child.id FROM "OrgUnit" child
      JOIN subtree parent ON child."parentId" = parent.id
      WHERE child."tenantId" = ${tenantId}
    )
    SELECT id FROM subtree`;
  return rows.map((row) => row.id);
}
