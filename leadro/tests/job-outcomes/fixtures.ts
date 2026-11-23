import { withTenant } from "@/server/db";

/**
 * Stores a SOLD outcome for a job's current visit straight in the database (no service, no status change).
 * For tests that walk a job to CLOSED and only need the "an outcome exists" precondition (§9.1).
 */
export async function storeSoldOutcome(tenantId: string, jobId: string): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const job = await tx.job.findFirstOrThrow({ where: { id: jobId, tenantId }, select: { currentVisitNumber: true } });
    await tx.jobOutcome.create({ data: { tenantId, jobId, visitNumber: job.currentVisitNumber, outcome: "SOLD" } });
  });
}
