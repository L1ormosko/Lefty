import type { TenantTx } from "@/server/db";

/** Sequence names in `NumberSequence.name`: one counter per tenant and kind of record. */
export type NumberSequenceName = "customer" | "lead" | "job" | "recovery_case";

/**
 * The next human-friendly number (`Customer|Lead|Job.number`) of a tenant, 1, 2, 3...
 *
 * One atomic statement (`INSERT ... ON CONFLICT DO UPDATE ... RETURNING`): two concurrent callers can
 * never receive the same number, and the first call of a tenant creates its counter row. The counter
 * increment is part of the caller's transaction, so a rolled-back create leaves a gap in the numbers
 * rather than reusing one (numbers identify records for people; gaps are acceptable, duplicates are not).
 * Must run inside `withTenant` (row-level security needs the tenant context).
 */
export async function nextNumber(tx: TenantTx, tenantId: string, sequence: NumberSequenceName): Promise<number> {
  const rows = await tx.$queryRaw<{ lastValue: number }[]>`
    INSERT INTO "NumberSequence" (id, "tenantId", name, "lastValue", "updatedAt")
    VALUES (gen_random_uuid()::text, ${tenantId}, ${sequence}, 1, now())
    ON CONFLICT ("tenantId", name)
    DO UPDATE SET "lastValue" = "NumberSequence"."lastValue" + 1, "updatedAt" = now()
    RETURNING "lastValue"`;
  return rows[0].lastValue;
}
