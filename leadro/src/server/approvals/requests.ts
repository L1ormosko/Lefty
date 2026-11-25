import type { ApprovalSubjectType, Prisma } from "@prisma/client";
import { expiryFrom, normalizeApprovalDetails, type ApprovalAmount } from "@/lib/approval-rules";
import { recordAudit } from "@/server/audit";
import { ConflictError, InternalError, ValidationError, type RequestContext } from "@/server/core";
import type { TenantTx } from "@/server/db";
import { lockRequest } from "./access";
import { approvalRequestRowSelect, type ApprovalRequestRow } from "./fields";
import { notifyApprovers } from "./notify";
import { resolveApprovalPolicyInTx } from "./policies";
import { approvalSubjectHandler } from "./registry";
import { systemAuditFields } from "./audit-fields";

/** What a subject module asks for when it needs a change approved. */
export interface CreateApprovalRequestInput {
  tenantId: string;
  subjectType: ApprovalSubjectType;
  subjectId: string;
  /** The money the change is about (refund, adjustment, write-off). Omit for amount-less subjects (material cost change). */
  amount?: ApprovalAmount | null;
  jobId?: string | null;
  customerId?: string | null;
  /** The requester's reason (shown to approvers). */
  reason?: string | null;
  /** Ids, codes and amounts only (see `normalizeApprovalDetails`): what the approver needs, snapshotted now. */
  details?: Record<string, unknown>;
  /**
   * Separation of duties beyond the requester (§21.3): the users who edited or submitted the subject. They can never decide
   * the request (service check + database trigger). The requester is always excluded and need not be listed.
   */
  excludedApproverIds?: readonly string[];
  /** Deterministic key per subject event: asking again with the same key returns the same request. */
  idempotencyKey?: string | null;
}

export type CreateApprovalRequestResult =
  | { required: false }
  | { required: true; request: ApprovalRequestRow; replayed: boolean; notificationIds: string[] };

/**
 * Opens an approval request for a change, INSIDE the subject module's transaction (so the subject and its request commit
 * together). The requester is `ctx.actor` (null `ctx` = the system).
 *
 * 1. Resolves the active policy by subject type, currency and amount band. No policy => `{ required: false }`: the caller
 *    applies the change directly (and records `approvalRequestId = null`). A subject type with active policies but none in
 *    the amount's currency is REFUSED (ValidationError): approval is never skipped because a currency was not configured.
 * 2. Snapshots the policy (code, version, required approvals, approver permission, expiry) and the excluded approvers; the
 *    database freezes them.
 * 3. One PENDING request per subject (partial unique index): a second one is a ConflictError.
 * 4. Audits `approval_request.create` and notifies the eligible approvers. Deliver `notificationIds` after commit
 *    (`deliverAfterCommit`).
 *
 * The subject module must have registered the subject type (`registerApprovalSubject`); the request's scope is the org unit
 * its `resolveResource` reports.
 * @throws ValidationError for bad details, unknown excluded users, an unknown subject or an uncovered currency;
 *   ConflictError for a second pending request or a reused idempotency key; InternalError for an unregistered subject type.
 */
export async function createApprovalRequestInTx(tx: TenantTx, ctx: RequestContext | null, input: CreateApprovalRequestInput): Promise<CreateApprovalRequestResult> {
  const { tenantId } = input;
  const handler = approvalSubjectHandler(input.subjectType);
  // Programming error: a subject without a handler could never be decided, so it must not be requested either.
  if (!handler) throw new InternalError({ message: `No approval subject handler is registered for ${input.subjectType}.` });
  const requestedById = ctx?.actor?.userId ?? null;

  if (input.idempotencyKey) {
    const existing = await tx.approvalRequest.findFirst({ where: { tenantId, idempotencyKey: input.idempotencyKey }, select: approvalRequestRowSelect });
    if (existing) {
      if (existing.subjectType !== input.subjectType || existing.subjectId !== input.subjectId) {
        throw new ConflictError({ message: "This idempotency key was used for another approval request." });
      }
      return { required: true, request: existing, replayed: true, notificationIds: [] };
    }
  }

  const amount = input.amount ?? null;
  const resolution = await resolveApprovalPolicyInTx(tx, tenantId, input.subjectType, amount);
  if (resolution.kind === "currency_not_covered") {
    throw new ValidationError({ message: `No approval policy covers ${input.subjectType} in ${amount?.currency ?? "this currency"}. Ask an administrator to configure one.`, field: "currency" });
  }
  if (resolution.kind === "none") return { required: false };
  const policy = resolution.policy;

  const resource = await handler.resolveResource(tx, tenantId, input.subjectId);
  if (!resource) throw new ValidationError({ message: "The record to approve does not exist.", field: "subjectId" });

  const normalized = normalizeApprovalDetails(input.details ?? {});
  if (!normalized.ok) throw new ValidationError({ message: `Approval details rejected: ${normalized.problem}`, field: "details" });

  const excluded = [...new Set(input.excludedApproverIds ?? [])].filter((userId) => userId !== requestedById);
  if (excluded.length > 0) {
    const known = await tx.user.count({ where: { tenantId, id: { in: excluded } } });
    if (known !== excluded.length) throw new ValidationError({ message: "An excluded approver is not a user of this tenant.", field: "excludedApproverIds" });
  }

  // One open request per subject; the partial unique index is the backstop for a race between two transactions.
  const pending = await tx.approvalRequest.findFirst({ where: { tenantId, subjectType: input.subjectType, subjectId: input.subjectId, status: "PENDING" }, select: { id: true } });
  if (pending) throw new ConflictError({ message: "This record already has a pending approval request." });

  const now = new Date();
  const created = await tx.approvalRequest.create({
    data: {
      tenantId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      policyId: policy.id,
      policyCode: policy.code,
      policyVersion: policy.version,
      requiredApprovals: policy.requiredApprovals,
      approverPermission: policy.approverPermission,
      amountMinor: amount?.amountMinor ?? null,
      currency: amount?.currency ?? null,
      jobId: input.jobId ?? null,
      customerId: input.customerId ?? null,
      orgUnitId: resource.orgUnitId ?? null,
      reason: input.reason ?? null,
      details: Object.keys(normalized.details).length > 0 ? (normalized.details as Prisma.InputJsonObject) : undefined,
      idempotencyKey: input.idempotencyKey ?? null,
      requestedById,
      excludedApproverIds: excluded,
      requestedAt: now,
      expiresAt: expiryFrom(now, policy.expiresAfterHours),
    },
    select: approvalRequestRowSelect,
  });
  await recordAudit(tx, {
    ...systemAuditFields(tenantId, ctx),
    action: "approval_request.create",
    targetType: "ApprovalRequest",
    targetId: created.id,
    newValue: {
      status: "PENDING",
      subjectType: created.subjectType,
      subjectId: created.subjectId,
      policyCode: created.policyCode,
      policyVersion: created.policyVersion,
      requiredApprovals: created.requiredApprovals,
      approverPermission: created.approverPermission,
      amountMinor: created.amountMinor,
      currency: created.currency,
      orgUnitId: created.orgUnitId,
      excludedApproverIds: created.excludedApproverIds,
      expiresAt: created.expiresAt,
    },
    reason: input.reason ?? undefined,
  });
  const notificationIds = await notifyApprovers(tx, created);
  return { required: true, request: created, replayed: false, notificationIds };
}

/** The PENDING request of a subject, if any (for subject modules that show or guard their own state). */
export function findPendingApprovalForSubjectInTx(tx: TenantTx, tenantId: string, subjectType: ApprovalSubjectType, subjectId: string): Promise<ApprovalRequestRow | null> {
  return tx.approvalRequest.findFirst({ where: { tenantId, subjectType, subjectId, status: "PENDING" }, select: approvalRequestRowSelect });
}

/**
 * Cancels the pending request of a subject because the SUBJECT MODULE withdrew the change (the refund was cancelled, the
 * cost version was withdrawn). Inside the subject module's transaction; its handler is NOT called back (it is the caller).
 * The subject module has already checked its own permission for the withdrawal.
 * @returns the cancelled request id, or null when the subject had no pending request.
 */
export async function cancelApprovalForSubjectInTx(
  tx: TenantTx,
  ctx: RequestContext | null,
  input: { tenantId: string; subjectType: ApprovalSubjectType; subjectId: string; reason: string },
): Promise<string | null> {
  const reason = input.reason.trim();
  if (reason.length === 0) throw new ValidationError({ message: "A cancellation needs a reason.", field: "reason" });
  const pending = await findPendingApprovalForSubjectInTx(tx, input.tenantId, input.subjectType, input.subjectId);
  if (!pending) return null;
  await lockRequest(tx, input.tenantId, pending.id);
  const now = new Date();
  const actorUserId = ctx?.actor?.userId ?? null;
  const claim = await tx.approvalRequest.updateMany({
    where: { id: pending.id, tenantId: input.tenantId, status: "PENDING" },
    data: { status: "CANCELLED", cancelledAt: now, cancelledById: actorUserId, cancelReason: reason },
  });
  if (claim.count !== 1) return null;
  await recordAudit(tx, {
    ...systemAuditFields(input.tenantId, ctx),
    action: "approval_request.cancelled",
    targetType: "ApprovalRequest",
    targetId: pending.id,
    previousValue: { status: "PENDING" },
    newValue: { status: "CANCELLED", by: "subject", subjectType: pending.subjectType, subjectId: pending.subjectId },
    reason,
  });
  return pending.id;
}
