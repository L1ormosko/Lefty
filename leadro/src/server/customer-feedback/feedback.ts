import { createHash } from "node:crypto";
import type { CustomerFeedback, Prisma } from "@prisma/client";
import { auditContextFields, recordAudit } from "@/server/audit";
import { buildScopeWhere, enforceInTx, resolveScope, withinScope, type ResourceRef, type ScopeColumns } from "@/server/authz";
import { ForbiddenError, InvalidStateTransitionError, NotFoundError, ValidationError, pageArgs, toPage, type Actor, type Page, type RequestContext } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import type { ListFeedbackQuery, RecordFeedbackInput, VoidFeedbackInput } from "./schemas";

/**
 * Customer feedback, recorded by hand (spec 5.9 Customer Relations, 10.2 "customer feedback"; there is no survey provider,
 * so the channel is always MANUAL). Permissions `customer_feedback.view / .create / .edit` (EDIT = void). The data scope is
 * the JOB's org unit, copied onto the row when it is recorded (`orgUnitId`), like follow-up tasks.
 *
 * - What the customer said is never edited (DB trigger); a mis-recorded entry is voided once, with a reason, and stays
 *   readable (`includeVoided=true`). Rows are never deleted (DB trigger).
 * - The customer is always the job's (copied, composite FK); the employee, when named, must have been assigned to the job.
 * - Feedback becomes a performance input only through a published CUSTOMER_FEEDBACK_AVERAGE definition (performance
 *   module), and only non-voided entries with a rating count there.
 * - No free text in audit events: the comment and the void reason are audited as SHA-256 digests.
 */

const VIEW = "customer_feedback.view";

export type CustomerFeedbackView = Omit<CustomerFeedback, "tenantId">;
export function toFeedbackView(row: CustomerFeedback): CustomerFeedbackView {
  const { tenantId: _tenantId, ...view } = row;
  return view;
}

const feedbackScopeColumns: ScopeColumns<Prisma.CustomerFeedbackWhereInput> = {
  orgUnit: (orgUnitIds) => ({ orgUnitId: { in: orgUnitIds } }),
  legalEntity: (legalEntityIds) => ({ orgUnit: { is: { legalEntityId: { in: legalEntityIds } } } }),
};

/** The scope reference of a row: its org unit, or tenant-level (only TENANT scopes) when it has none. */
const resourceOf = (orgUnitId: string | null): ResourceRef => (orgUnitId ? { orgUnitId } : {});

const digest = (text: string | null): string | null => (text === null ? null : createHash("sha256").update(text, "utf8").digest("hex"));

/** A little clock skew is tolerated; feedback "received tomorrow" is not. */
const FUTURE_TOLERANCE_MS = 5 * 60_000;

async function assertEmployeeOnJob(tx: TenantTx, tenantId: string, jobId: string, employeeId: string): Promise<void> {
  const assignment = await tx.jobAssignment.findFirst({ where: { tenantId, jobId, employeeId }, select: { id: true } });
  if (!assignment) {
    throw new ValidationError({ message: "The employee was not assigned to this job.", field: "employeeId" });
  }
}

/**
 * `POST /customer-feedback`: records feedback about a job in the caller's `customer_feedback.create` scope (the job's org
 * unit). An unknown job and a job outside the scope are both a 404.
 * @throws ForbiddenError, NotFoundError, ValidationError
 */
export async function recordCustomerFeedback(actor: Actor, ctx: RequestContext, input: RecordFeedbackInput): Promise<CustomerFeedbackView> {
  const now = new Date();
  if (input.receivedAt && input.receivedAt.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) {
    throw new ValidationError({ message: "Feedback cannot be received in the future.", field: "receivedAt" });
  }
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "customer_feedback.create");
    const job = await tx.job.findFirst({ where: { id: input.jobId, tenantId: actor.tenantId }, select: { id: true, customerId: true, orgUnitId: true } });
    if (!job) throw new NotFoundError();
    await enforceInTx(tx, actor, "customer_feedback.create", resourceOf(job.orgUnitId));
    // Review P5-R5: feedback about the recorder would feed their own CUSTOMER_FEEDBACK_AVERAGE; someone else records it.
    if (input.employeeId && input.employeeId === actor.employeeId) {
      throw new ForbiddenError({ message: "You cannot record customer feedback about yourself." });
    }
    if (input.employeeId) await assertEmployeeOnJob(tx, actor.tenantId, job.id, input.employeeId);
    const row = await tx.customerFeedback.create({
      data: {
        tenantId: actor.tenantId,
        jobId: job.id,
        customerId: job.customerId,
        employeeId: input.employeeId ?? null,
        rating: input.rating ?? null,
        comment: input.comment ?? null,
        channel: "MANUAL",
        orgUnitId: job.orgUnitId,
        receivedAt: input.receivedAt ?? now,
        recordedById: actor.userId,
        recordedAt: now,
      },
    });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "customer_feedback.record",
      targetType: "CustomerFeedback",
      targetId: row.id,
      newValue: {
        jobId: row.jobId,
        customerId: row.customerId,
        employeeId: row.employeeId,
        rating: row.rating,
        commentSha256: digest(row.comment),
        channel: row.channel,
        receivedAt: row.receivedAt.toISOString(),
      },
    });
    return toFeedbackView(row);
  });
}

/**
 * `POST /customer-feedback/{id}/void`: voids a mis-recorded entry once (`customer_feedback.edit`), with a reason. A second
 * void is a 409; the entry stays readable.
 * @throws ForbiddenError, NotFoundError, InvalidStateTransitionError
 */
export async function voidCustomerFeedback(actor: Actor, ctx: RequestContext, feedbackId: string, input: VoidFeedbackInput): Promise<CustomerFeedbackView> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "customer_feedback.edit");
    await tx.$queryRaw`SELECT "id" FROM "CustomerFeedback" WHERE "id" = ${feedbackId} AND "tenantId" = ${actor.tenantId} FOR UPDATE`;
    const before = await tx.customerFeedback.findFirst({ where: { id: feedbackId, tenantId: actor.tenantId } });
    if (!before) throw new NotFoundError();
    await enforceInTx(tx, actor, VIEW, resourceOf(before.orgUnitId));
    await enforceInTx(tx, actor, "customer_feedback.edit", resourceOf(before.orgUnitId));
    // Review P5-R5: voiding feedback about yourself would remove it from your own metric.
    if (before.employeeId !== null && before.employeeId === actor.employeeId) {
      throw new ForbiddenError({ message: "You cannot void customer feedback about yourself." });
    }
    if (before.voidedAt) throw new InvalidStateTransitionError({ message: "This feedback is already voided." });
    const after = await tx.customerFeedback.update({
      where: { id: before.id },
      data: { voidedAt: new Date(), voidedById: actor.userId, voidReason: input.reason },
    });
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "customer_feedback.void",
      targetType: "CustomerFeedback",
      targetId: after.id,
      previousValue: { voided: false },
      newValue: { voided: true, voidReasonSha256: digest(after.voidReason) },
    });
    return toFeedbackView(after);
  });
}

/** `GET /customer-feedback/{id}` (`customer_feedback.view` over the job's org unit; outside the scope 404). */
export async function getCustomerFeedback(actor: Actor, feedbackId: string): Promise<CustomerFeedbackView> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, VIEW);
    const row = await tx.customerFeedback.findFirst({ where: { id: feedbackId, tenantId: actor.tenantId } });
    if (!row) throw new NotFoundError();
    await enforceInTx(tx, actor, VIEW, resourceOf(row.orgUnitId));
    return toFeedbackView(row);
  });
}

/** `GET /customer-feedback`: entries in the caller's scope, newest received first. Voided ones only with `includeVoided=true`. */
export async function listCustomerFeedback(actor: Actor, query: ListFeedbackQuery): Promise<Page<CustomerFeedbackView>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, VIEW);
    const now = new Date();
    const scope = await resolveScope(tx, actor, VIEW, now);
    const callerWhere: Prisma.CustomerFeedbackWhereInput = {
      tenantId: actor.tenantId,
      ...(query.jobId ? { jobId: query.jobId } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.employeeId ? { employeeId: query.employeeId } : {}),
      ...(query.includeVoided ? {} : { voidedAt: null }),
    };
    const rows = await tx.customerFeedback.findMany({
      where: withinScope(buildScopeWhere(scope, feedbackScopeColumns, now), callerWhere),
      orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return { data: page.data.map(toFeedbackView), page: page.page };
  });
}
