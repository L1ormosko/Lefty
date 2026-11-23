import type { AssignmentMethod } from "@prisma/client";
import { ConflictError } from "@/server/core";
import type { TenantTx } from "@/server/db";

/**
 * The one thing the dispatch module needs beyond `assignJob`: after a dispatcher accepts (or modifies)
 * a recommendation, the new assignment must say where it came from (§7.4: every decision is recorded).
 * `assignJob` creates the assignment as MANUAL (or OVERRIDE); this stamps the recommendation link and the
 * recommendation method on it. An OVERRIDE keeps its method (and its reason), because "an ineligible
 * employee was assigned on someone's authority" is the stronger fact; it still gets the link.
 *
 * Runs in the caller's transaction. Does not authorize (dispatch did).
 * @returns the assignment id and the method it now carries.
 * @throws ConflictError when the employee has no ACTIVE assignment on the job.
 */
export async function linkAssignmentToRecommendation(
  tx: TenantTx,
  tenantId: string,
  link: { jobId: string; employeeId: string; recommendationId: string; method: "RECOMMENDATION_APPROVED" | "RECOMMENDATION_MODIFIED" },
): Promise<{ assignmentId: string; method: AssignmentMethod }> {
  const assignment = await tx.jobAssignment.findFirst({
    where: { tenantId, jobId: link.jobId, employeeId: link.employeeId, state: "ACTIVE" },
    select: { id: true, method: true },
  });
  if (!assignment) throw new ConflictError({ message: "The employee is not assigned to the job." });
  const method = assignment.method === "OVERRIDE" ? "OVERRIDE" : link.method;
  await tx.jobAssignment.update({ where: { id: assignment.id }, data: { method, recommendationId: link.recommendationId } });
  return { assignmentId: assignment.id, method };
}
