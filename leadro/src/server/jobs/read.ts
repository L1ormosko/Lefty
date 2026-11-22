import type { Prisma } from "@prisma/client";
import { TERMINAL_JOB_STATUSES } from "@/lib/job-lifecycle";
import {
  buildScopeWhere,
  canInTx,
  enforceInTx,
  fieldSetsForRow,
  projectFields,
  resolveScope,
  withinScope,
  type AccessDecision,
} from "@/server/authz";
import { jobAssignedToWhere, jobScopeColumns } from "@/server/customers";
import { NotFoundError, pageArgs, toPage, type Actor, type Page } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { JOB_API_FIELD_MAP, jobRowSelect, jobView, type JobRequirementView, type JobRow } from "./fields";
import { jobRowAttributes, loadJobAccessFacts, toJobResourceRef, type JobAccessFacts } from "./job-access";
import type { ListJobsQuery, ListMyJobsQuery } from "./schemas";

/**
 * Reads: one job, the scope-filtered list, and the technician's own jobs. Every read needs `jobs.view`
 * over the job's scope; fields follow the grants that cover THAT row (money only for a grant naming
 * the `financial` set), and a job outside the caller's scope is a 404.
 */

async function requirementViews(tx: TenantTx, tenantId: string, jobId: string): Promise<JobRequirementView[]> {
  return tx.jobRequirement.findMany({
    where: { tenantId, jobId },
    select: { skillId: true, certificationId: true, minLevel: true, source: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

/** One job (`jobs.view` over it) with its active assignments and requirements, projected to the caller's grant. */
export async function getJob(actor: Actor, jobId: string): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "jobs.view");
    const row = await tx.job.findFirst({ where: { id: jobId, tenantId: actor.tenantId }, select: jobRowSelect });
    if (!row) throw new NotFoundError();
    const facts = (await loadJobAccessFacts(tx, actor.tenantId, [row.id])).get(row.id);
    const decision = await enforceInTx(tx, actor, "jobs.view", toJobResourceRef(row, facts));
    const view = jobView(row, { assignments: facts?.assignments ?? [], requirements: await requirementViews(tx, actor.tenantId, row.id) });
    return projectFields(view, decision, JOB_API_FIELD_MAP);
  });
}

/**
 * What a write may show its caller: the `jobs.view` decision on the job AFTER the change, limited to the
 * field sets the write grant also covers (never wider than the caller could write or view). Falls back
 * to `{ id }` when the caller can no longer see the job (e.g. it was unassigned from them).
 */
export async function viewJobAfterWrite(
  tx: TenantTx,
  actor: Actor,
  jobId: string,
  writeDecision: AccessDecision,
  extras: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const row = await tx.job.findFirst({ where: { id: jobId, tenantId: actor.tenantId }, select: jobRowSelect });
  if (!row) throw new NotFoundError();
  const facts = (await loadJobAccessFacts(tx, actor.tenantId, [row.id])).get(row.id);
  const view = await canInTx(tx, actor, "jobs.view", toJobResourceRef(row, facts));
  if (!view.allowed) return { id: row.id };
  const shared = view.fieldSets.filter((set) => set === "base" || writeDecision.fieldSets.includes(set));
  const body = jobView(row, { assignments: facts?.assignments ?? [], requirements: await requirementViews(tx, actor.tenantId, row.id) });
  return { ...projectFields(body, { allowed: true, fieldSets: shared }, JOB_API_FIELD_MAP), ...(shared.includes("base") ? extras : {}) };
}

interface ListOptions {
  /** Conditions added to the caller's filters (the "mine" restriction, default status exclusions). */
  extraConditions: Prisma.JobWhereInput[];
  orderBy: Prisma.JobOrderByWithRelationInput[];
  /** True when any filter narrows by a BASE column (see the oracle note in `listJobsInternal`). */
  filtered: boolean;
}

async function listJobsInternal(
  tx: TenantTx,
  actor: Actor,
  query: { cursor?: string; limit: number },
  options: ListOptions,
  now: Date,
): Promise<Page<Record<string, unknown>>> {
  const scope = await resolveScope(tx, actor, "jobs.view", now);
  const scopeWhere = buildScopeWhere(scope, jobScopeColumns, now);
  const rows: JobRow[] = await tx.job.findMany({
    where: withinScope(scopeWhere, { tenantId: actor.tenantId, AND: options.extraConditions }),
    select: jobRowSelect,
    orderBy: options.orderBy,
    ...pageArgs(query),
  });
  const page = toPage(rows, query.limit);
  const facts = await loadJobAccessFacts(tx, actor.tenantId, page.data.map((row) => row.id), now);

  const data = page.data.flatMap((row) => {
    const rowFacts: JobAccessFacts | undefined = facts.get(row.id);
    const fieldSets = fieldSetsForRow(scope, jobRowAttributes(row, rowFacts));
    // Filters match BASE columns (status, priority, unit...). A row the caller sees only through a
    // financial-only grant (Finance) must not be findable that way, or a filter becomes an oracle for hidden values.
    if (options.filtered && !fieldSets.includes("base")) return [];
    return [projectFields(jobView(row, { assignments: rowFacts?.assignments ?? [] }), { allowed: true, fieldSets }, JOB_API_FIELD_MAP)];
  });
  return { data, page: page.page };
}

const searchCondition = (term: string): Prisma.JobWhereInput => {
  const numeric = /^#?(\d{1,9})$/.exec(term);
  return { OR: [{ title: { contains: term, mode: "insensitive" } }, ...(numeric ? [{ number: Number(numeric[1]) }] : [])] };
};

/**
 * One page of jobs the caller may see, newest first (`createdAt desc, id desc`). The data scope is
 * part of the query and each row is projected with the field sets of the grants covering THAT row.
 */
export async function listJobs(actor: Actor, query: ListJobsQuery): Promise<Page<Record<string, unknown>>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "jobs.view");
    const now = new Date();
    const conditions: Prisma.JobWhereInput[] = [];
    if (query.archived === "exclude") conditions.push({ archivedAt: null });
    if (query.archived === "only") conditions.push({ archivedAt: { not: null } });
    if (query.status) conditions.push({ status: { in: query.status } });
    if (query.priority) conditions.push({ priority: query.priority });
    if (query.orgUnitId) conditions.push({ orgUnitId: query.orgUnitId });
    if (query.customerId) conditions.push({ customerId: query.customerId });
    if (query.jobTypeId) conditions.push({ jobTypeId: query.jobTypeId });
    if (query.assignedEmployeeId) conditions.push(jobAssignedToWhere(query.assignedEmployeeId, now));
    if (query.unassigned === true) conditions.push({ assignments: { none: { state: "ACTIVE" } } });
    if (query.unassigned === false) conditions.push({ assignments: { some: { state: "ACTIVE" } } });
    if (query.scheduledFrom) conditions.push({ scheduledStartAt: { gte: query.scheduledFrom } });
    if (query.scheduledTo) conditions.push({ scheduledStartAt: { lt: query.scheduledTo } });
    if (query.q) conditions.push(searchCondition(query.q));
    const filtered = query.archived !== "exclude" || [query.status, query.priority, query.orgUnitId, query.customerId, query.jobTypeId, query.assignedEmployeeId, query.unassigned, query.scheduledFrom, query.scheduledTo, query.q].some((value) => value !== undefined);
    return listJobsInternal(
      tx,
      actor,
      query,
      { extraConditions: conditions, orderBy: [{ createdAt: "desc" }, { id: "desc" }], filtered },
      now,
    );
  });
}

/**
 * The caller's own jobs (technician view, §5.10): jobs assigned to their employee directly or through a
 * team they currently belong to, within the scope their `jobs.view` grant covers. Soonest appointment first;
 * unscheduled work last. Closed and cancelled jobs are hidden unless `includeFinished` or an explicit
 * `status` filter asks for them. A user with no employee record has no jobs.
 */
export async function listMyJobs(actor: Actor, query: ListMyJobsQuery): Promise<Page<Record<string, unknown>>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "jobs.view");
    if (!actor.employeeId) return { data: [], page: { nextCursor: null, limit: query.limit } };
    const now = new Date();
    const conditions: Prisma.JobWhereInput[] = [jobAssignedToWhere(actor.employeeId, now)];
    if (query.status) conditions.push({ status: { in: query.status } });
    else if (!query.includeFinished) conditions.push({ status: { notIn: [...TERMINAL_JOB_STATUSES] } });
    if (query.scheduledFrom) conditions.push({ scheduledStartAt: { gte: query.scheduledFrom } });
    if (query.scheduledTo) conditions.push({ scheduledStartAt: { lt: query.scheduledTo } });
    return listJobsInternal(
      tx,
      actor,
      query,
      {
        extraConditions: conditions,
        orderBy: [{ scheduledStartAt: { sort: "asc", nulls: "last" } }, { appointmentWindowStart: { sort: "asc", nulls: "last" } }, { id: "asc" }],
        filtered: Boolean(query.status || query.scheduledFrom || query.scheduledTo),
      },
      now,
    );
  });
}
