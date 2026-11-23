import type { Prisma } from "@prisma/client";
import { buildScopeWhere, enforceInTx, fieldSetsForRow, projectFields, resolveScope, withinScope } from "@/server/authz";
import { NotFoundError, pageArgs, toPage, type Actor, type Page } from "@/server/core";
import { jobScopeColumns } from "@/server/customers";
import { withTenant } from "@/server/db";
import { assignedEmployeeIdsByJob, jobResourceRef } from "@/server/jobs";
import { OUTCOME_FIELD_MAP, outcomeRowSelect } from "./fields";
import type { ListOutcomesQuery } from "./schemas";

/**
 * Reads. An outcome is visible to whoever may view its JOB's data in the sense of `job_outcomes.view`:
 * the scope (org unit / legal entity / ASSIGNED) is evaluated against the job the outcome belongs to.
 * An outcome outside the caller's scope is a 404.
 */

/** One outcome (`job_outcomes.view` over its job). */
export async function getJobOutcome(actor: Actor, outcomeId: string): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "job_outcomes.view");
    const row = await tx.jobOutcome.findFirst({ where: { id: outcomeId, tenantId: actor.tenantId }, select: outcomeRowSelect });
    if (!row) throw new NotFoundError();
    const resource = await jobResourceRef(tx, actor.tenantId, row.jobId);
    if (!resource) throw new NotFoundError();
    const decision = await enforceInTx(tx, actor, "job_outcomes.view", resource);
    return projectFields(row, decision, OUTCOME_FIELD_MAP);
  });
}

/**
 * One page of outcomes the caller may see, newest visit first (`occurredAt desc, id desc`). The data scope is part
 * of the query (via the outcome's job); filters narrow it further.
 */
export async function listJobOutcomes(actor: Actor, query: ListOutcomesQuery): Promise<Page<Record<string, unknown>>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "job_outcomes.view");
    const now = new Date();
    const scope = await resolveScope(tx, actor, "job_outcomes.view", now);
    const jobScope = buildScopeWhere(scope, jobScopeColumns, now);

    const filters: Prisma.JobOutcomeWhereInput[] = [];
    if (query.jobId) filters.push({ jobId: query.jobId });
    if (query.outcome) filters.push({ outcome: query.outcome });
    if (query.lostReasonId) filters.push({ lostReasonId: query.lostReasonId });
    if (query.employeeId) filters.push({ employeeId: query.employeeId });
    if (query.customerRequestedFollowUp !== undefined) filters.push({ customerRequestedFollowUp: query.customerRequestedFollowUp });
    if (query.occurredFrom) filters.push({ occurredAt: { gte: query.occurredFrom } });
    if (query.occurredTo) filters.push({ occurredAt: { lt: query.occurredTo } });

    const rows = await tx.jobOutcome.findMany({
      where: withinScope<Prisma.JobOutcomeWhereInput>({ job: jobScope }, { tenantId: actor.tenantId, AND: filters }),
      select: { ...outcomeRowSelect, job: { select: { orgUnitId: true, orgUnit: { select: { legalEntityId: true } } } } },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    const assigned = await assignedEmployeeIdsByJob(tx, actor.tenantId, [...new Set(page.data.map((row) => row.jobId))], now);

    const data = page.data.flatMap(({ job, ...row }) => {
      const fieldSets = fieldSetsForRow(scope, {
        orgUnitIds: [job.orgUnitId],
        legalEntityIds: job.orgUnit.legalEntityId ? [job.orgUnit.legalEntityId] : [],
        assignedEmployeeIds: assigned.get(row.jobId) ?? [],
      });
      return fieldSets.length === 0 ? [] : [projectFields(row, { allowed: true, fieldSets }, OUTCOME_FIELD_MAP)];
    });
    return { data, page: page.page };
  });
}
