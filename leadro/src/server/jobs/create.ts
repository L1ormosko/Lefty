import type { JobOrigin, JobStatus, WorkPriority } from "@prisma/client";
import { appointmentWarnings, type JobWarning } from "@/lib/job-lifecycle";
import { auditContextFields, recordAudit, type AuditContextFields } from "@/server/audit";
import { JOB_FIELD_MAP, JOB_WRITE_ALLOWLISTS, assertWritableFields, enforceInTx } from "@/server/authz";
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
  nextNumber,
  type Actor,
  type RequestContext,
} from "@/server/core";
import { assertCustomerActive } from "@/server/customers";
import { withTenant, type TenantTx } from "@/server/db";
import { orgUnitAncestry } from "@/server/qualifications";
import { requirementSeedsForNewJob } from "./eligibility-inputs";
import { recordJobEvent, recordStatusHistory } from "./events";
import { viewJobAfterWrite } from "./read";
import type { CreateJobInput } from "./schemas";

/**
 * Job creation (§7.1): by a person (`createJob`, the API) or as part of converting a lead
 * (`createJobFromLead`, called by the leads module inside ITS transaction). Both go through
 * `insertJob`, so a job is born the same way whatever its origin: status CREATED then, as an automatic
 * step, PENDING_ASSIGNMENT (two history rows), the job type's requirements copied onto the job,
 * a `job.created` event and an audit row.
 */

interface JobDraft {
  customerId: string;
  serviceAddressId: string;
  jobTypeId: string;
  orgUnitId?: string;
  origin: JobOrigin;
  leadId?: string;
  parentJobId?: string;
  title?: string;
  description?: string;
  instructions?: string;
  priority?: WorkPriority;
  appointmentWindow?: { start: Date; end: Date };
  estimatedDurationMinutes?: number;
  timeZone?: string;
  quotedAmountMinor?: bigint;
  currency?: string;
  additionalRequirements?: CreateJobInput["additionalRequirements"];
}

interface JobContext {
  jobType: { id: string; name: string; defaultDurationMinutes: number; defaultPriority: WorkPriority };
  /** The unit the job will live in. */
  orgUnitId: string;
  /** The unit the customer's address (or the customer) already belongs to; null = tenant-level customer. */
  derivedOrgUnitId: string | null;
}

/**
 * Loads and validates everything a new job points at, all inside the caller's tenant (RLS) and
 * transaction: an active customer, one of ITS active addresses, an active job type, the service-area
 * unit, the parent job and manual requirement ids. The unit is the address's, else the customer's;
 * an explicit `orgUnitId` is accepted only inside that unit (a dispatcher cannot move a customer's
 * work into a unit the customer is not part of); with none of them, `fallbackOrgUnitId` (the lead's
 * unit) or an explicit one is needed.
 */
async function loadJobContext(tx: TenantTx, tenantId: string, draft: JobDraft, fallbackOrgUnitId: string | null): Promise<JobContext> {
  await assertCustomerActive(tx, tenantId, draft.customerId);
  const customer = await tx.customer.findFirst({ where: { id: draft.customerId, tenantId }, select: { orgUnitId: true } });
  if (!customer) throw new NotFoundError();
  const address = await tx.customerAddress.findFirst({
    where: { id: draft.serviceAddressId, customerId: draft.customerId, tenantId, archivedAt: null },
    select: { orgUnitId: true },
  });
  if (!address) throw new ValidationError({ message: "Unknown or archived service address for this customer.", field: "serviceAddressId" });
  const jobType = await tx.jobType.findFirst({
    where: { id: draft.jobTypeId, tenantId, active: true },
    select: { id: true, name: true, defaultDurationMinutes: true, defaultPriority: true },
  });
  if (!jobType) throw new ValidationError({ message: "Unknown or inactive job type.", field: "jobTypeId" });

  const derivedOrgUnitId = address.orgUnitId ?? customer.orgUnitId ?? null;
  let orgUnitId = derivedOrgUnitId ?? fallbackOrgUnitId;
  if (draft.orgUnitId) {
    if (derivedOrgUnitId && draft.orgUnitId !== derivedOrgUnitId && !(await orgUnitAncestry(tx, tenantId, draft.orgUnitId)).includes(derivedOrgUnitId)) {
      throw new ValidationError({ message: "The service area must be inside the customer's own unit.", field: "orgUnitId" });
    }
    orgUnitId = draft.orgUnitId;
  }
  if (!orgUnitId) throw new ValidationError({ message: "This customer has no service-area unit: give orgUnitId.", field: "orgUnitId" });
  if (!(await tx.orgUnit.findFirst({ where: { id: orgUnitId, tenantId, active: true }, select: { id: true } }))) {
    throw new ValidationError({ message: "Unknown or archived organization unit.", field: "orgUnitId" });
  }

  if (draft.parentJobId && !(await tx.job.findFirst({ where: { id: draft.parentJobId, tenantId, customerId: draft.customerId }, select: { id: true } }))) {
    throw new ValidationError({ message: "The parent job must be an existing job of the same customer.", field: "parentJobId" });
  }
  const skillIds = (draft.additionalRequirements?.skills ?? []).map((skill) => skill.skillId);
  if (skillIds.length > 0 && (await tx.skill.count({ where: { tenantId, id: { in: skillIds } } })) !== new Set(skillIds).size) {
    throw new ValidationError({ message: "Unknown skill.", field: "additionalRequirements.skills" });
  }
  const certificationIds = draft.additionalRequirements?.certificationIds ?? [];
  if (certificationIds.length > 0 && (await tx.certification.count({ where: { tenantId, id: { in: certificationIds } } })) !== new Set(certificationIds).size) {
    throw new ValidationError({ message: "Unknown certification.", field: "additionalRequirements.certificationIds" });
  }
  return { jobType, orgUnitId, derivedOrgUnitId };
}

/** Money is recorded by NAME only: audit readers need not hold the financial grant. */
const auditSafe = (values: Record<string, unknown>): Record<string, unknown> => {
  const { quotedAmountMinor, currency, ...rest } = values;
  return quotedAmountMinor !== undefined || currency !== undefined ? { ...rest, financialFieldsSet: true } : rest;
};

interface InsertedJob {
  id: string;
  number: number;
  warnings: JobWarning[];
}

async function insertJob(
  tx: TenantTx,
  tenantId: string,
  creator: { userId: string },
  audit: AuditContextFields,
  number: number,
  draft: JobDraft,
  context: JobContext,
): Promise<InsertedJob> {
  const settings = await tx.operationsSettings.findUnique({ where: { tenantId }, select: { defaultCurrency: true } });
  const estimatedDurationMinutes = draft.estimatedDurationMinutes ?? context.jobType.defaultDurationMinutes;
  const initialStatus: JobStatus = "PENDING_ASSIGNMENT";
  const job = await tx.job.create({
    data: {
      tenantId,
      number,
      customerId: draft.customerId,
      serviceAddressId: draft.serviceAddressId,
      jobTypeId: draft.jobTypeId,
      orgUnitId: context.orgUnitId,
      leadId: draft.leadId ?? null,
      parentJobId: draft.parentJobId ?? null,
      origin: draft.origin,
      status: initialStatus,
      priority: draft.priority ?? context.jobType.defaultPriority,
      title: draft.title ?? context.jobType.name,
      description: draft.description ?? null,
      instructions: draft.instructions ?? null,
      appointmentWindowStart: draft.appointmentWindow?.start ?? null,
      appointmentWindowEnd: draft.appointmentWindow?.end ?? null,
      timeZone: draft.timeZone ?? null,
      estimatedDurationMinutes,
      quotedAmountMinor: draft.quotedAmountMinor ?? null,
      currency: draft.currency ?? settings?.defaultCurrency ?? "USD",
      createdById: creator.userId,
    },
    select: { id: true, priority: true, title: true, currency: true },
  });

  const seeds = await requirementSeedsForNewJob(tx, tenantId, draft.jobTypeId, {
    skills: draft.additionalRequirements?.skills,
    certificationIds: draft.additionalRequirements?.certificationIds,
  });
  if (seeds.length > 0) {
    await tx.jobRequirement.createMany({
      data: seeds.map((seed) => ({
        tenantId,
        jobId: job.id,
        skillId: seed.skillId ?? null,
        certificationId: seed.certificationId ?? null,
        minLevel: seed.minLevel ?? null,
        source: seed.source,
      })),
    });
  }

  // The initial status is a row with no previous status; moving on to PENDING_ASSIGNMENT is automatic.
  await recordStatusHistory(tx, tenantId, job.id, { from: null, to: "CREATED", actor: creator });
  await recordStatusHistory(tx, tenantId, job.id, { from: "CREATED", to: initialStatus, actor: null, reason: "Created: waiting for assignment" });
  await recordJobEvent(tx, tenantId, job.id, {
    type: "job.created",
    actor: creator,
    payload: { origin: draft.origin, jobTypeId: draft.jobTypeId, leadId: draft.leadId ?? null },
  });
  await recordAudit(tx, {
    ...audit,
    action: "job.create",
    targetType: "Job",
    targetId: job.id,
    newValue: auditSafe({
      number,
      origin: draft.origin,
      customerId: draft.customerId,
      serviceAddressId: draft.serviceAddressId,
      jobTypeId: draft.jobTypeId,
      orgUnitId: context.orgUnitId,
      leadId: draft.leadId ?? null,
      parentJobId: draft.parentJobId ?? null,
      priority: job.priority,
      title: job.title,
      estimatedDurationMinutes,
      // Money stays out of the trail: it records WHICH money fields were set, never the amount (same rule as outcomes).
      moneyFields: [...(draft.quotedAmountMinor !== undefined && draft.quotedAmountMinor !== null ? ["quotedAmountMinor"] : []), ...(draft.currency ? ["currency"] : [])],
    }),
  });

  return { id: job.id, number, warnings: appointmentWarnings({ estimatedDurationMinutes, window: draft.appointmentWindow }) };
}

/** The Job columns a create request sets, for the field-level write check (`assertWritableFields`). */
function sentColumns(input: CreateJobInput): string[] {
  const keys = Object.entries(input)
    .filter(([key, value]) => value !== undefined && key !== "additionalRequirements" && key !== "appointmentWindow")
    .map(([key]) => key);
  return input.appointmentWindow ? [...keys, "appointmentWindowStart", "appointmentWindowEnd"] : keys;
}

/**
 * Creates a job by hand (§7.1 manual administrative action, customer follow-up). Needs `jobs.create`
 * over the service-area unit (and over the customer's own unit when the job goes to a unit inside
 * it); a customer with no unit at all needs a tenant-wide `jobs.create`, because attaching a job
 * would otherwise make a tenant-level customer visible to a unit manager. Money needs the financial grant.
 * Refuses an archived customer. The response carries `warnings` (§25.2: duration longer than the
 * appointment window) which never block the job.
 */
export async function createJob(actor: Actor, ctx: RequestContext, input: CreateJobInput): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "jobs.create");
    const draft: JobDraft = { ...input };
    const context = await loadJobContext(tx, actor.tenantId, draft, null);

    const newJob = { assignedEmployeeIds: [], sets: [] };
    const decision = await enforceInTx(tx, actor, "jobs.create", { orgUnitId: context.orgUnitId, ...newJob });
    if (context.derivedOrgUnitId === null) {
      // A creation has no record to hide, so a missing tenant-wide grant is a plain 403.
      await enforceInTx(tx, actor, "jobs.create", {}).catch((error: unknown) => {
        throw error instanceof NotFoundError ? new ForbiddenError() : error;
      });
    } else if (context.derivedOrgUnitId !== context.orgUnitId) {
      await enforceInTx(tx, actor, "jobs.create", { orgUnitId: context.derivedOrgUnitId, ...newJob });
    }
    assertWritableFields(decision, sentColumns(input), JOB_FIELD_MAP, JOB_WRITE_ALLOWLISTS);

    // The number is taken IN this transaction, after every check passed (a nested `withTenant` would need a
    // second pooled connection per request and starve the pool under bursts). A rolled-back create rolls
    // the counter back with it.
    const number = await nextNumber(tx, actor.tenantId, "job");
    const inserted = await insertJob(tx, actor.tenantId, actor, auditContextFields(ctx), number, draft, context);
    return viewJobAfterWrite(tx, actor, inserted.id, decision, { warnings: inserted.warnings });
  });
}

export interface JobFromLeadInput {
  leadId: string;
  customerId: string;
  serviceAddressId: string;
  jobTypeId: string;
  description?: string;
  priority?: WorkPriority;
  appointmentWindow?: { start: Date; end: Date };
}

export interface JobFromLeadResult {
  id: string;
  number: number;
  /** False when the lead already had a job: the existing one is returned and nothing was written. */
  created: boolean;
  warnings: JobWarning[];
}

/**
 * Creates the job of a converted lead INSIDE the leads module's transaction (`tx`), so the lead
 * becomes CONVERTED if and only if its job exists. Idempotent per lead: a second call (a retried
 * conversion) returns the existing job with `created: false`. Concurrent calls for one lead queue on
 * an advisory lock, and the unique `(leadId, tenantId)` index is the last line of defence.
 *
 * Authorization is the CALLER's: the leads service has already checked that this actor may convert
 * this lead, and that decision is not repeated as `jobs.create` (a Lead Operations manager converts
 * leads without holding job rights). Everything else is validated as for a manual job: the customer
 * must be active and own the address, the lead must exist and belong to that customer, the job type
 * must be active. The service-area unit is the address's, else the customer's, else the lead's.
 * `ctx` (optional) carries the request's correlation id and source app into the audit row.
 */
export async function createJobFromLead(
  tx: TenantTx,
  actor: Actor,
  input: JobFromLeadInput,
  ctx?: Pick<RequestContext, "correlationId" | "sourceApp">,
): Promise<JobFromLeadResult> {
  const { tenantId } = actor;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`job-from-lead:${tenantId}:${input.leadId}`}))`;

  const existing = await tx.job.findFirst({ where: { tenantId, leadId: input.leadId }, select: { id: true, number: true } });
  if (existing) return { id: existing.id, number: existing.number, created: false, warnings: [] };

  const lead = await tx.lead.findFirst({ where: { id: input.leadId, tenantId }, select: { customerId: true, orgUnitId: true } });
  if (!lead) throw new NotFoundError();
  if (lead.customerId !== input.customerId) {
    throw new ValidationError({ message: "The customer does not match the lead's customer.", field: "customerId" });
  }

  const draft: JobDraft = { ...input, origin: "LEAD_CONVERSION" };
  const context = await loadJobContext(tx, tenantId, draft, lead.orgUnitId);
  const number = await nextNumber(tx, tenantId, "job");
  const audit: AuditContextFields = { tenantId, actorUserId: actor.userId, sourceApp: ctx?.sourceApp ?? "API", correlationId: ctx?.correlationId };
  const inserted = await insertJob(tx, tenantId, actor, audit, number, draft, context);
  return { id: inserted.id, number, created: true, warnings: inserted.warnings };
}
