import { hasExpired, tallyDecisions } from "@/lib/approval-rules";
import { recordAudit } from "@/server/audit";
import { enforceInTx } from "@/server/authz";
import { ConflictError, ForbiddenError, InvalidStateTransitionError, NotFoundError, type Actor, type RequestContext } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { deliverAfterCommit } from "@/server/notifications";
import {
  evaluateRequestAccess,
  isExcludedFromDeciding,
  loadRequestRow,
  loadVisibleRequest,
  lockRequest,
  moneyVisibleTo,
  requestResource,
  viewerFacts,
  type RequestAccess,
} from "./access";
import { systemAuditFields } from "./audit-fields";
import { expireApprovalRequest } from "./expiry";
import { approvalRequestView, type ApprovalRequestRow } from "./fields";
import { finishRequestInTx } from "./finish";
import type { CancelApprovalInput, DecideApprovalInput } from "./schemas";

/**
 * Deciding and cancelling requests (§21.3).
 *
 * Decide: the caller needs `approvals.view` and the request's `approverPermission` over its scope, and must not be the
 * requester or an excluded editor / submitter (separation of duties; the database trigger refuses it too). Each person
 * decides once (append-only `ApprovalDecision`, unique per decider). Any REJECT ends the request; it is APPROVED when
 * `requiredApprovals` different people approved (dual approval = two). The final decision, the subject handler's callback,
 * the audit and the requester's notification commit together.
 *
 * Concurrency: the request row is locked (`FOR UPDATE`) before anything is read for the decision, so two approvers acting at
 * the same moment are serialized: the second sees the first's decision (and a finished request answers 409).
 */

/** A separation-of-duties refusal (403), audited as a DENIED decision. */
class SeparationOfDutiesError extends ForbiddenError {
  constructor() {
    super({ message: "Separation of duties: the requester or an editor of this change cannot decide it." });
  }
}

/** Raised inside the decision transaction; the caller expires the request in its own transaction and answers 409. */
class RequestExpiredError extends InvalidStateTransitionError {
  constructor() {
    super({ message: "This approval request has expired." });
  }
}

function openRequestOrThrow(row: ApprovalRequestRow, now: Date): void {
  if (row.status !== "PENDING") throw new InvalidStateTransitionError({ message: `This approval request is already ${row.status}.` });
  if (hasExpired(row.expiresAt, now)) throw new RequestExpiredError();
}

/** Re-reads the locked row, so decisions use the state another transaction just committed. */
async function lockAndReload(tx: TenantTx, actor: Actor, requestId: string): Promise<RequestAccess> {
  await lockRequest(tx, actor.tenantId, requestId);
  const row = await loadRequestRow(tx, actor.tenantId, requestId);
  if (!row) throw new NotFoundError();
  return evaluateRequestAccess(tx, actor, row);
}

const viewOf = (access: RequestAccess, actor: Actor, now: Date) => approvalRequestView(access.row, viewerFacts(access, actor.userId, now), moneyVisibleTo(access));

/** Runs `work`; turns the two special refusals into their side effects (expiry, denial audit) after its rollback. */
async function withRefusalEffects<T>(actor: Actor, ctx: RequestContext, requestId: string, action: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof RequestExpiredError) {
      await expireApprovalRequest(actor.tenantId, requestId);
    } else if (error instanceof SeparationOfDutiesError) {
      // The decision transaction rolled back; the refusal is recorded on its own (§21: failed access is audited).
      await withTenant(actor.tenantId, (tx) =>
        recordAudit(tx, {
          ...systemAuditFields(actor.tenantId, ctx),
          action,
          targetType: "ApprovalRequest",
          targetId: requestId,
          newValue: { refused: "SEPARATION_OF_DUTIES" },
          outcome: "DENIED",
        }),
      );
    }
    throw error;
  }
}

/** Records the caller's APPROVE / REJECT on a request. Returns the request as the caller now sees it. */
export async function decideApprovalRequest(actor: Actor, ctx: RequestContext, requestId: string, input: DecideApprovalInput): Promise<Record<string, unknown>> {
  const result = await withRefusalEffects(actor, ctx, requestId, "approval_request.decide", () =>
    withTenant(actor.tenantId, async (tx) => {
      const visible = await loadVisibleRequest(tx, actor, requestId);
      // Who decides is the policy's approver permission over the request's scope; `approvals.view` alone never decides.
      await enforceInTx(tx, actor, visible.row.approverPermission, requestResource(visible.row));
      if (isExcludedFromDeciding(visible.row, actor.userId)) throw new SeparationOfDutiesError();

      const access = await lockAndReload(tx, actor, requestId);
      const now = new Date();
      openRequestOrThrow(access.row, now);
      if (access.row.decisions.some((decision) => decision.deciderId === actor.userId)) {
        throw new ConflictError({ message: "You have already decided this approval request." });
      }

      // Append-only; the trigger re-checks pending status and separation of duties at the database.
      await tx.approvalDecision.create({
        data: { tenantId: actor.tenantId, requestId, deciderId: actor.userId, decision: input.decision, comment: input.comment ?? null, decidedAt: now },
      });
      await recordAudit(tx, {
        ...systemAuditFields(actor.tenantId, ctx),
        action: "approval_request.decide",
        targetType: "ApprovalRequest",
        targetId: requestId,
        newValue: { decision: input.decision, subjectType: access.row.subjectType, subjectId: access.row.subjectId, requiredApprovals: access.row.requiredApprovals },
        reason: input.comment,
      });

      const decisions = [...access.row.decisions, { deciderId: actor.userId, decision: input.decision }];
      const tally = tallyDecisions(access.row.requiredApprovals, decisions);
      if (tally === "PENDING") {
        const reloaded = await lockAndReload(tx, actor, requestId);
        return { view: viewOf(reloaded, actor, now), notificationIds: [] as string[] };
      }
      const finished = await finishRequestInTx(tx, ctx, access.row, { outcome: tally, reason: tally === "REJECTED" ? (input.comment ?? null) : null, now });
      return { view: viewOf({ ...access, row: finished.row }, actor, now), notificationIds: finished.notificationIds };
    }),
  );
  await deliverAfterCommit(actor.tenantId, result.notificationIds);
  return result.view;
}

/**
 * Cancels a pending request through the approvals API: its requester, or an overseer with `approvals.manage` over its scope.
 * The subject handler's `onRejected` runs with outcome CANCELLED (the change is withdrawn).
 */
export async function cancelApprovalRequest(actor: Actor, ctx: RequestContext, requestId: string, input: CancelApprovalInput): Promise<Record<string, unknown>> {
  const result = await withRefusalEffects(actor, ctx, requestId, "approval_request.cancel", () =>
    withTenant(actor.tenantId, async (tx) => {
      const visible = await loadVisibleRequest(tx, actor, requestId);
      if (!visible.isRequester && !visible.isOverseer) throw new ForbiddenError({ message: "Only the requester or an approvals manager can cancel this request." });
      const access = await lockAndReload(tx, actor, requestId);
      const now = new Date();
      openRequestOrThrow(access.row, now);
      const finished = await finishRequestInTx(tx, ctx, access.row, { outcome: "CANCELLED", reason: input.reason, now });
      return { view: viewOf({ ...access, row: finished.row }, actor, now), notificationIds: finished.notificationIds };
    }),
  );
  await deliverAfterCommit(actor.tenantId, result.notificationIds);
  return result.view;
}
