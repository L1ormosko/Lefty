import type { Prisma } from "@prisma/client";
import { activePlacementWhere } from "@/server/authz";
import type { TenantTx } from "@/server/db";

/**
 * THE shared definition of "assigned to an employee" for ASSIGNED data scopes (§4.2, PERMISSIONS.md
 * section 4). Customers, leads and jobs all derive ASSIGNED access from the same rows, so the rule
 * lives here once and the leads/jobs modules import it from `@/server/customers`:
 *
 *  - a lead is assigned to the employee of its ACTIVE `LeadAssignment`;
 *  - a job is assigned to the employee of an ACTIVE `JobAssignment`, or, when the row names a team
 *    (`teamOrgUnitId`), to every employee with an ACTIVE placement in that team org unit right now
 *    ("team expansion": a technician in the team sees the team's jobs without a personal row);
 *  - a customer is assigned to everyone any of its leads or jobs is assigned to;
 *  - archived leads and jobs assign nobody. Assignment rows of closed or completed work count until
 *    their owner ENDS them (state ENDED): leads and jobs services end the assignment when the work
 *    reaches a state that should stop granting access.
 *
 * Two forms of the same rule must agree (a test pins this): Prisma where-fragments (list queries,
 * `*AssignedToWhere`) and the per-record employee ids (`assignedEmployeeIdsByCustomer`, for the
 * `ResourceRef.assignedEmployeeIds` of single-record checks). Team members are the employees with a
 * placement in exactly that org unit; teams are leaf units, so descendants are not expanded.
 */

/** Leads whose ACTIVE assignment is `employeeId` (use as `ScopeColumns.assigned` of the leads module). */
export const leadAssignedToWhere = (employeeId: string): Prisma.LeadWhereInput => ({
  archivedAt: null,
  assignments: { some: { employeeId, state: "ACTIVE" } },
});

/** Jobs assigned to `employeeId` directly or through an ACTIVE team assignment (use as `ScopeColumns.assigned` of the jobs module). */
export const jobAssignedToWhere = (employeeId: string, now: Date): Prisma.JobWhereInput => ({
  archivedAt: null,
  assignments: {
    some: {
      state: "ACTIVE",
      OR: [
        { employeeId },
        { teamOrgUnit: { assignments: { some: { employeeId, ...activePlacementWhere(now) } } } },
      ],
    },
  },
});

/** Customers with at least one lead or job assigned to `employeeId` (the customers ASSIGNED scope column). */
export const customerAssignedToWhere = (employeeId: string, now: Date): Prisma.CustomerWhereInput => ({
  OR: [{ leads: { some: leadAssignedToWhere(employeeId) } }, { jobs: { some: jobAssignedToWhere(employeeId, now) } }],
});

/**
 * Employees each customer's work is assigned to (ACTIVE lead assignments, ACTIVE job assignments,
 * team assignments expanded to the team's current members). Customers with no assignment map to `[]`.
 * Batched: three queries whatever the number of customers.
 */
export async function assignedEmployeeIdsByCustomer(
  tx: TenantTx,
  tenantId: string,
  customerIds: string[],
  now: Date = new Date(),
): Promise<Map<string, string[]>> {
  const assigned = new Map<string, Set<string>>(customerIds.map((customerId) => [customerId, new Set<string>()]));
  if (customerIds.length === 0) return new Map();

  const leadRows = await tx.leadAssignment.findMany({
    where: { tenantId, state: "ACTIVE", lead: { customerId: { in: customerIds }, archivedAt: null } },
    select: { employeeId: true, lead: { select: { customerId: true } } },
  });
  for (const row of leadRows) {
    if (row.lead.customerId) assigned.get(row.lead.customerId)?.add(row.employeeId);
  }

  const jobRows = await tx.jobAssignment.findMany({
    where: { tenantId, state: "ACTIVE", job: { customerId: { in: customerIds }, archivedAt: null } },
    select: { employeeId: true, teamOrgUnitId: true, job: { select: { customerId: true } } },
  });
  const teamIds = [...new Set(jobRows.map((row) => row.teamOrgUnitId).filter((team): team is string => team !== null))];
  const membersByTeam = new Map<string, string[]>();
  if (teamIds.length > 0) {
    const placements = await tx.organizationalAssignment.findMany({
      where: { tenantId, orgUnitId: { in: teamIds }, ...activePlacementWhere(now) },
      select: { orgUnitId: true, employeeId: true },
    });
    for (const placement of placements) {
      membersByTeam.set(placement.orgUnitId, [...(membersByTeam.get(placement.orgUnitId) ?? []), placement.employeeId]);
    }
  }
  for (const row of jobRows) {
    const members = assigned.get(row.job.customerId);
    if (!members) continue;
    if (row.employeeId) members.add(row.employeeId);
    if (row.teamOrgUnitId) for (const memberId of membersByTeam.get(row.teamOrgUnitId) ?? []) members.add(memberId);
  }

  return new Map([...assigned].map(([customerId, employeeIds]) => [customerId, [...employeeIds]]));
}
