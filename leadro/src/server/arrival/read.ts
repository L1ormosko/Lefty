import { enforceInTx, projectFields } from "@/server/authz";
import { NotFoundError, type Actor } from "@/server/core";
import { withTenant } from "@/server/db";
import { jobResourceRef } from "@/server/jobs";
import { ARRIVAL_FIELD_MAP, arrivalSelect, arrivalView } from "./fields";

/**
 * The arrivals recorded for a job, newest first (several rows are normal: return visits, corrections; the latest
 * non-rejected one is the arrival). Needs `location.view` over the job. Rows hold distances, accuracy and verdicts, never coordinates.
 */
export async function listJobArrivals(actor: Actor, jobId: string): Promise<Record<string, unknown>[]> {
  return withTenant(actor.tenantId, async (tx) => {
    const ref = await jobResourceRef(tx, actor.tenantId, jobId);
    if (!ref) throw new NotFoundError();
    const decision = await enforceInTx(tx, actor, "location.view", ref);
    const rows = await tx.arrivalVerification.findMany({ where: { tenantId: actor.tenantId, jobId }, orderBy: [{ arrivedAt: "desc" }, { id: "desc" }], select: arrivalSelect });
    return rows.map((row) => projectFields(arrivalView(row), decision, ARRIVAL_FIELD_MAP));
  });
}
