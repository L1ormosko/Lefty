import { cancelApprovalForSubjectInTx, createApprovalRequestInTx, registerApprovalSubject, type ApprovalOutcomeEvent } from "@/server/approvals";
import { recordAudit } from "@/server/audit";
import { ConflictError, InvalidStateTransitionError, type Actor, type RequestContext } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { deliverAfterCommit } from "@/server/notifications";
import { enforceConfigure, lockDefinitionKey } from "./access";
import { loadDefinition, performanceAuditFields } from "./definitions";
import { definitionRowSelect, definitionView } from "./fields";
import type { ReasonInput, SubmitDefinitionInput } from "./schemas";

/**
 * Publishing a metric definition version through the generic approval engine (subject PERFORMANCE_METRIC_DEFINITION, subject
 * id = the version's id; contract in DECISIONS.md "Phase 5 Task 1").
 *
 * Unlike the Phase 4 subjects, "no policy" never means "apply directly": publication ALWAYS needs an approval request (ruling
 * 3; the CHECK `performance_metric_definition_needs_approval` makes skipping impossible), so a tenant without an active
 * publication policy cannot publish and is told so. The author and the submitter never decide (separation of duties).
 */

export const METRIC_DEFINITION_SUBJECT = "PERFORMANCE_METRIC_DEFINITION" as const;

/**
 * `POST /performance/definitions/{id}/submit`: DRAFT -> PENDING_APPROVAL with a new approval request. Needs
 * `performance.configure` at TENANT scope.
 * @throws ForbiddenError, NotFoundError, InvalidStateTransitionError (not DRAFT),
 *   ConflictError (`performance.publication_policy_missing`: no active policy; or a request is already pending)
 */
export async function submitDefinition(actor: Actor, ctx: RequestContext, definitionId: string, input: SubmitDefinitionInput): Promise<Record<string, unknown>> {
  const result = await withTenant(actor.tenantId, async (tx) => {
    await enforceConfigure(tx, actor);
    const before = await loadDefinition(tx, actor.tenantId, definitionId);
    await lockDefinitionKey(tx, actor.tenantId, before.key);
    const definition = await loadDefinition(tx, actor.tenantId, definitionId);
    if (definition.status !== "DRAFT") throw new InvalidStateTransitionError({ message: `This version is ${definition.status}; only a draft can be submitted.` });
    const published = await tx.performanceMetricDefinition.findFirst({ where: { tenantId: actor.tenantId, key: definition.key, status: "PUBLISHED" }, select: { id: true, version: true } });

    // Each submission is a new request (a rejected one stays in the history), so the key carries the submission count.
    const submissions = await tx.approvalRequest.count({ where: { tenantId: actor.tenantId, subjectType: METRIC_DEFINITION_SUBJECT, subjectId: definitionId } });
    const approval = await createApprovalRequestInTx(tx, ctx, {
      tenantId: actor.tenantId,
      subjectType: METRIC_DEFINITION_SUBJECT,
      subjectId: definitionId,
      reason: input.reason ?? null,
      details: {
        definitionId,
        key: definition.key,
        version: definition.version,
        kind: definition.kind,
        dimension: definition.dimension,
        minSample: definition.minSample,
        replacesDefinitionId: published?.id ?? null,
        replacesVersion: published?.version ?? null,
      },
      // The author of the version may not publish it either (the requester is excluded by the engine already).
      excludedApproverIds: definition.createdById ? [definition.createdById] : [],
      idempotencyKey: `${METRIC_DEFINITION_SUBJECT}:${definitionId}:${submissions + 1}`,
    });
    if (!approval.required) {
      // Ruling 3: refuse instead of publishing directly. Nothing was written, so the transaction has nothing to undo.
      throw new ConflictError({
        message: "No active approval policy covers metric publication. Ask an administrator to configure one; a metric is never published without approval.",
        details: [{ field: "id", code: "performance.publication_policy_missing", message: "Configure the PERFORMANCE_METRIC_DEFINITION approval policy." }],
      });
    }
    const submittedAt = new Date();
    const updated = await tx.performanceMetricDefinition.update({
      where: { id: definitionId },
      data: { status: "PENDING_APPROVAL", submittedAt, approvalRequestId: approval.request.id },
      select: definitionRowSelect,
    });
    await recordAudit(tx, {
      ...performanceAuditFields(actor.tenantId, ctx),
      action: "performance_metric_definition.submit",
      targetType: "PerformanceMetricDefinition",
      targetId: definitionId,
      previousValue: { status: "DRAFT" },
      newValue: { status: "PENDING_APPROVAL", approvalRequestId: approval.request.id, key: definition.key, version: definition.version },
      reason: input.reason,
    });
    return { definition: updated, notificationIds: approval.notificationIds };
  });
  await deliverAfterCommit(actor.tenantId, result.notificationIds);
  return definitionView(result.definition);
}

/**
 * `POST /performance/definitions/{id}/withdraw`: PENDING_APPROVAL -> DRAFT and cancels the approval request (the engine does
 * not call back: this module is the caller). Needs `performance.configure`.
 * @throws ForbiddenError, NotFoundError, InvalidStateTransitionError
 */
export async function withdrawDefinition(actor: Actor, ctx: RequestContext, definitionId: string, input: ReasonInput): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceConfigure(tx, actor);
    const before = await loadDefinition(tx, actor.tenantId, definitionId);
    await lockDefinitionKey(tx, actor.tenantId, before.key);
    const definition = await loadDefinition(tx, actor.tenantId, definitionId);
    if (definition.status !== "PENDING_APPROVAL") throw new InvalidStateTransitionError({ message: `This version is ${definition.status}; only a pending version can be withdrawn.` });
    await cancelApprovalForSubjectInTx(tx, ctx, { tenantId: actor.tenantId, subjectType: METRIC_DEFINITION_SUBJECT, subjectId: definitionId, reason: input.reason });
    return definitionView(await backToDraftInTx(tx, actor.tenantId, ctx, definitionId, "withdrawn", input.reason));
  });
}

/** PENDING_APPROVAL -> DRAFT (withdrawn, rejected, cancelled, expired), audited. The caller holds the key lock. */
async function backToDraftInTx(
  tx: TenantTx,
  tenantId: string,
  ctx: RequestContext | null,
  definitionId: string,
  by: "withdrawn" | "approval_rejected" | "approval_expired" | "approval_cancelled",
  reason: string | null,
) {
  const claim = await tx.performanceMetricDefinition.updateMany({ where: { id: definitionId, tenantId, status: "PENDING_APPROVAL" }, data: { status: "DRAFT" } });
  if (claim.count !== 1) throw new ConflictError({ message: "The metric definition changed at the same time. Reload and try again." });
  await recordAudit(tx, {
    ...performanceAuditFields(tenantId, ctx),
    action: "performance_metric_definition.return_to_draft",
    targetType: "PerformanceMetricDefinition",
    targetId: definitionId,
    previousValue: { status: "PENDING_APPROVAL" },
    newValue: { status: "DRAFT", by },
    reason: reason ?? undefined,
  });
  return tx.performanceMetricDefinition.findFirstOrThrow({ where: { id: definitionId, tenantId }, select: definitionRowSelect });
}

/**
 * The engine's `onApproved`: retires the currently PUBLISHED version of the key (if any) FIRST, then publishes this one (the
 * partial unique index allows one PUBLISHED version per key, checked per statement). Runs in the deciding transaction.
 */
async function onApproved(tx: TenantTx, event: ApprovalOutcomeEvent): Promise<void> {
  const before = await loadDefinition(tx, event.tenantId, event.subjectId);
  await lockDefinitionKey(tx, event.tenantId, before.key);
  const definition = await loadDefinition(tx, event.tenantId, event.subjectId);
  if (definition.status !== "PENDING_APPROVAL") throw new ConflictError({ message: `The metric definition is already ${definition.status}.` });
  const audit = performanceAuditFields(event.tenantId, event.ctx);

  const previous = await tx.performanceMetricDefinition.findFirst({ where: { tenantId: event.tenantId, key: definition.key, status: "PUBLISHED" }, select: { id: true, version: true } });
  if (previous) {
    await tx.performanceMetricDefinition.update({ where: { id: previous.id }, data: { status: "RETIRED", retiredAt: event.now } });
    await recordAudit(tx, {
      ...audit,
      action: "performance_metric_definition.retire",
      targetType: "PerformanceMetricDefinition",
      targetId: previous.id,
      previousValue: { status: "PUBLISHED" },
      newValue: { status: "RETIRED", key: definition.key, version: previous.version, by: "superseded", supersededById: definition.id },
    });
  }
  await tx.performanceMetricDefinition.update({ where: { id: definition.id }, data: { status: "PUBLISHED", publishedAt: event.now } });
  await recordAudit(tx, {
    ...audit,
    action: "performance_metric_definition.publish",
    targetType: "PerformanceMetricDefinition",
    targetId: definition.id,
    previousValue: { status: "PENDING_APPROVAL" },
    newValue: { status: "PUBLISHED", key: definition.key, version: definition.version, approvalRequestId: event.requestId, approverIds: event.approverIds },
  });
}

/** The engine's `onRejected` (rejected, expired, cancelled through the approvals API): back to DRAFT so the author can revise. */
async function onRejected(tx: TenantTx, event: ApprovalOutcomeEvent): Promise<void> {
  const definition = await tx.performanceMetricDefinition.findFirst({ where: { id: event.subjectId, tenantId: event.tenantId }, select: { key: true } });
  if (!definition) return;
  await lockDefinitionKey(tx, event.tenantId, definition.key);
  const locked = await loadDefinition(tx, event.tenantId, event.subjectId);
  // Already ended by this module (withdrawn): nothing to do.
  if (locked.status !== "PENDING_APPROVAL" || locked.approvalRequestId !== event.requestId) return;
  const by = event.outcome === "CANCELLED" ? "approval_cancelled" : event.outcome === "EXPIRED" ? "approval_expired" : "approval_rejected";
  await backToDraftInTx(tx, event.tenantId, event.ctx, locked.id, by, event.reason);
}

/**
 * Registers PERFORMANCE_METRIC_DEFINITION with the approval engine. Definitions are tenant-level, so the request is tenant-level
 * (`{}`): only holders of the policy's permission (`performance.publish`) at TENANT scope decide. Idempotent; called at module
 * load and from `src/server/notification-targets.ts`.
 */
export function registerMetricDefinitionApprovalSubject(): void {
  registerApprovalSubject(METRIC_DEFINITION_SUBJECT, {
    async resolveResource(tx, tenantId, subjectId) {
      const definition = await tx.performanceMetricDefinition.findFirst({ where: { id: subjectId, tenantId }, select: { id: true } });
      return definition ? {} : null;
    },
    onApproved,
    onRejected,
  });
}
