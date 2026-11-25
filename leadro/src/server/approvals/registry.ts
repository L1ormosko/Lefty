import type { ApprovalSubjectType } from "@prisma/client";
import type { ResourceRef } from "@/server/authz";
import type { RequestContext } from "@/server/core";
import type { TenantTx } from "@/server/db";

/** How a request ended. `onApproved` gets APPROVED; `onRejected` gets every way of ending WITHOUT approval. */
export type ApprovalOutcome = "APPROVED" | "REJECTED" | "EXPIRED" | "CANCELLED";

/** What a subject module is told when one of its requests ends. Runs INSIDE the transaction that ends the request. */
export interface ApprovalOutcomeEvent {
  tenantId: string;
  requestId: string;
  subjectType: ApprovalSubjectType;
  subjectId: string;
  outcome: ApprovalOutcome;
  /** The person whose decision or cancellation ended the request; null for the system (expiry sweep). */
  actorUserId: string | null;
  /** Everyone who approved, in decision order (two people for dual approval). */
  approverIds: string[];
  /** The rejecting comment or the cancel reason, when there is one. */
  reason: string | null;
  /** The request context of the deciding call (null for the system), for the subject's own audit event. */
  ctx: RequestContext | null;
  now: Date;
}

/**
 * The contract a subject module (materials, refunds, adjustments, chargebacks) fulfils to use the engine.
 * - `resolveResource`: the subject's scope attributes read from the database (org unit; `{}` = tenant-level), or null when
 *   the subject does not exist. Called when the request is created; the request snapshots `orgUnitId` from it, so the
 *   approver queue can be filtered in SQL and every later check uses the same scope.
 * - `onApproved` / `onRejected`: move the subject on (cost version APPROVED, refund APPROVED, ...). They run in the same
 *   transaction as the final decision: if they throw, the decision rolls back too, so the request and the subject never
 *   disagree. `onRejected` covers REJECTED, EXPIRED and CANCELLED (by a person through the approvals API).
 *   A subject module that cancels its own request (`cancelApprovalForSubjectInTx`) is NOT called back: it is the caller.
 */
export interface ApprovalSubjectHandler {
  resolveResource(tx: TenantTx, tenantId: string, subjectId: string): Promise<ResourceRef | null>;
  onApproved(tx: TenantTx, event: ApprovalOutcomeEvent): Promise<void>;
  onRejected(tx: TenantTx, event: ApprovalOutcomeEvent): Promise<void>;
}

/**
 * The registry lives on `globalThis` (same pattern as the notification target resolvers): Next.js bundles
 * `instrumentation.ts` and each route separately, so a module-level Map would be filled in one bundle and empty in another.
 */
const globalForSubjects = globalThis as unknown as { leadroApprovalSubjects?: Map<ApprovalSubjectType, ApprovalSubjectHandler> };
const handlers: Map<ApprovalSubjectType, ApprovalSubjectHandler> = (globalForSubjects.leadroApprovalSubjects ??= new Map());

/**
 * Plugs a subject type into the engine. Call it once when the owning module loads AND from
 * `src/server/notification-targets.ts`, so the handler exists whichever entry point runs first. Idempotent (last one wins).
 * An unregistered subject type cannot get a request (`createApprovalRequestInTx` refuses) and a request whose subject type
 * has no handler cannot be decided (fail closed: 409).
 */
export function registerApprovalSubject(subjectType: ApprovalSubjectType, handler: ApprovalSubjectHandler): void {
  handlers.set(subjectType, handler);
}

/** The handler of a subject type, or undefined when none is registered. */
export function approvalSubjectHandler(subjectType: ApprovalSubjectType): ApprovalSubjectHandler | undefined {
  return handlers.get(subjectType);
}

/** Test hook: forget one registration (or all). */
export function unregisterApprovalSubject(subjectType?: ApprovalSubjectType): void {
  if (subjectType) handlers.delete(subjectType);
  else handlers.clear();
}
