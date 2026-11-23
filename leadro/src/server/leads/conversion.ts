import { canTransitionLead, isClosedStatus } from "@/lib/lead-lifecycle";
import { auditContextFields, recordAudit } from "@/server/audit";
import { LEAD_FIELD_MAP, LEAD_WRITE_ALLOWLISTS, assertWritableFields, enforceInTx } from "@/server/authz";
import { ForbiddenError, InvalidStateTransitionError, NotFoundError, ValidationError, type Actor, type RequestContext } from "@/server/core";
import { withTenant } from "@/server/db";
import { assertCustomerUsableForLead } from "./customer-link";
import { confirmLeadCustomerFlag } from "./duplicates";
import { createJobFromLead } from "./job-conversion-port";
import { leadResourceRef } from "./lead-access";
import type { ConvertLeadInput } from "./schemas";
import { applyLeadStatus, isLeadStatus, loadDisabledLeadTransitions } from "./status-change";

/**
 * Lead conversion (§6.3 CONVERTED, §7.1 "a job may be created from a converted lead"): creates the job through the
 * jobs module and marks the lead CONVERTED in ONE transaction. Either both happen or neither does.
 *
 * Authority: the caller must be able to SEE the lead (`leads.view`) and CREATE jobs over the lead's service area
 * (`jobs.create`); the job is created under that authority, so a Dispatcher (jobs.create + dispatch-related leads) and
 * the unit managers can convert, while Lead Operations (no `jobs.create` in the default matrix) hands qualified leads
 * over. The jobs module repeats its own permission check.
 *
 * What the job needs and where it comes from: the customer, one of ITS service addresses and the job type are taken
 * from the request or, when omitted, from the lead (a lead without them must be completed first: no silent guessing).
 * An archived customer takes no new work. Retrying a conversion that already happened returns the existing job
 * (`replayed: true`): a lead has at most one job.
 */

export interface ConvertLeadResult {
  leadId: string;
  status: "CONVERTED";
  job: { id: string; number: number };
  /** True when the lead was already converted: nothing was created. */
  replayed: boolean;
  /** False on a replay (the existing job is returned). */
  created: boolean;
  /** Soft warnings of the jobs module about the new job (e.g. duration vs window, §25.2). */
  warnings: unknown[];
}

export async function convertLead(actor: Actor, ctx: RequestContext, leadId: string, input: ConvertLeadInput): Promise<ConvertLeadResult> {
  return withTenant(actor.tenantId, async (tx): Promise<ConvertLeadResult> => {
    await enforceInTx(tx, actor, "leads.view");
    await enforceInTx(tx, actor, "jobs.create"); // capability: 403 when the caller can never create jobs
    const ref = await leadResourceRef(tx, actor.tenantId, leadId);
    if (!ref) throw new NotFoundError();
    await enforceInTx(tx, actor, "leads.view", ref);
    // Serialise conversions of ONE lead: the second request waits here, then sees CONVERTED and replays the job
    // instead of failing on the unique (leadId) index. Everything below reads after the lock.
    await tx.$queryRaw`SELECT id FROM "Lead" WHERE id = ${leadId} AND "tenantId" = ${actor.tenantId} FOR UPDATE`;
    try {
      await enforceInTx(tx, actor, "jobs.create", { ...(ref.orgUnitId ? { orgUnitId: ref.orgUnitId } : {}), assignedEmployeeIds: [], sets: [] });
    } catch (error) {
      // The caller can see this lead (checked above): "no job rights over its area" is a plain 403, not a hidden record.
      throw error instanceof NotFoundError ? new ForbiddenError() : error;
    }

    const lead = await tx.lead.findFirst({
      where: { id: leadId, tenantId: actor.tenantId },
      select: {
        id: true,
        status: true,
        priority: true,
        archivedAt: true,
        customerId: true,
        customerAddressId: true,
        jobTypeId: true,
        requestedWork: true,
        preferredWindowStart: true,
        preferredWindowEnd: true,
      },
    });
    if (!lead || !isLeadStatus(lead.status)) throw new NotFoundError();

    if (lead.status === "CONVERTED") {
      const existing = await tx.job.findFirst({ where: { tenantId: actor.tenantId, leadId }, select: { id: true, number: true } });
      if (existing) return { leadId, status: "CONVERTED", job: existing, replayed: true, created: false, warnings: [] };
    }
    if (lead.archivedAt) throw new InvalidStateTransitionError({ message: "An archived lead cannot be converted. Restore it first." });
    if (isClosedStatus(lead.status) || !canTransitionLead(lead.status, "CONVERTED", await loadDisabledLeadTransitions(tx, actor.tenantId))) {
      throw new InvalidStateTransitionError({ message: `A ${lead.status} lead cannot be converted to a job.`, field: "status" });
    }

    const customerId = input.customerId ?? lead.customerId;
    if (!customerId) throw new ValidationError({ message: "Link the lead to a customer before converting it.", field: "customerId" });
    if (lead.customerId && lead.customerId !== customerId) {
      throw new ValidationError({ message: "The lead belongs to a different customer.", field: "customerId" });
    }
    const serviceAddressId = input.serviceAddressId ?? lead.customerAddressId;
    if (!serviceAddressId) throw new ValidationError({ message: "Choose the customer's service address for the job.", field: "serviceAddressId" });
    const jobTypeId = input.jobTypeId ?? lead.jobTypeId;
    if (!jobTypeId) throw new ValidationError({ message: "Choose the job type before converting the lead.", field: "jobTypeId" });

    await assertCustomerUsableForLead(tx, actor, customerId, serviceAddressId, ["lead_related", "job_related"]);
    const jobType = await tx.jobType.findFirst({ where: { id: jobTypeId, tenantId: actor.tenantId }, select: { id: true } });
    if (!jobType) throw new ValidationError({ message: "Unknown job type.", field: "jobTypeId" });

    // The job references (lead, customer): the lead must carry the customer first (composite FK on Job). Writing those
    // lead columns is an EDIT of the lead, so a caller who only holds leads.view + jobs.create may convert a lead that
    // is already complete but may not change what it points at (and so may not confirm a duplicate flag either:
    // that is the normal duplicate-resolution permission, leads.edit over the lead).
    const changed = [
      ...(lead.customerId !== customerId ? ["customerId"] : []),
      ...(lead.customerAddressId !== serviceAddressId ? ["customerAddressId"] : []),
      ...(lead.jobTypeId !== jobTypeId ? ["jobTypeId"] : []),
    ];
    if (changed.length > 0) {
      const decision = await enforceInTx(tx, actor, "leads.edit", ref);
      assertWritableFields(decision, changed, LEAD_FIELD_MAP, LEAD_WRITE_ALLOWLISTS);
      await tx.lead.update({ where: { id: leadId }, data: { customerId, customerAddressId: serviceAddressId, jobTypeId } });
      if (lead.customerId !== customerId) await confirmLeadCustomerFlag(tx, actor, leadId, customerId);
    }

    const window =
      input.appointmentWindowStart && input.appointmentWindowEnd
        ? { start: input.appointmentWindowStart, end: input.appointmentWindowEnd }
        : lead.preferredWindowStart && lead.preferredWindowEnd
          ? { start: lead.preferredWindowStart, end: lead.preferredWindowEnd }
          : undefined;
    const job = await createJobFromLead(
      tx,
      actor,
      {
      leadId,
      customerId,
      serviceAddressId,
      jobTypeId,
      description: input.description ?? lead.requestedWork ?? undefined,
      priority: input.priority ?? lead.priority,
      appointmentWindow: window,
      },
      ctx,
    );

    await applyLeadStatus(tx, actor, ctx, { id: lead.id, status: lead.status }, "CONVERTED", {
      reason: `converted to job #${job.number}`,
      assignmentEndedReason: "lead converted to a job",
    });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "lead.convert",
      targetType: "Lead",
      targetId: leadId,
      newValue: { jobId: job.id, jobNumber: job.number, customerId, serviceAddressId, jobTypeId },
    });
    return { leadId, status: "CONVERTED", job: { id: job.id, number: job.number }, replayed: false, created: job.created, warnings: job.warnings };
  });
}
