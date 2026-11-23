import { randomUUID } from "node:crypto";
import type { FollowUpOrigin, FollowUpTargetType, WorkPriority } from "@prisma/client";
import { auditContextFields, recordAudit, type AuditContextFields } from "@/server/audit";
import { enforceInTx } from "@/server/authz";
import { InvalidStateTransitionError, NotFoundError, ValidationError, type Actor, type RequestContext } from "@/server/core";
import type { TenantTx } from "@/server/db";
import { assertTargetViewable } from "./access";
import { validateAssignee } from "./assignee";
import { followUpRowSelect } from "./fields";
import { notifyFollowUpAssignee } from "./notify";
import { runFieldWrite } from "./offline";
import { viewAfterWrite, getFollowUpInTx } from "./read";
import type { CreateFollowUpInput } from "./schemas";
import { targetAccessFor, targetColumns } from "./targets";

/** The system as the creator of a task (the recovery engine, a sweep): no person, no permission check. */
export interface SystemCaller {
  tenantId: string;
  system: true;
}

export type FollowUpCaller = Actor | SystemCaller;

const isSystem = (caller: FollowUpCaller): caller is SystemCaller => "system" in caller;

export interface NewFollowUpTask {
  targetType: FollowUpTargetType;
  targetId: string;
  title: string;
  description?: string | null;
  dueAt: Date;
  priority?: WorkPriority;
  assigneeId?: string | null;
  /** Defaults to MANUAL for a person and SYSTEM for the system. Rules pass RECOVERY_RULE, outcomes OUTCOME. */
  origin?: FollowUpOrigin;
  /**
   * Makes creation idempotent per tenant: a second call with the same key creates nothing and returns the first task
   * (`created: false`). Rules use e.g. `recovery:<caseId>:<ruleId>`.
   */
  dedupeKey?: string;
}

export interface CreatedFollowUpTask {
  id: string;
  /** False when `dedupeKey` matched an existing task. */
  created: boolean;
  /** Hand to `deliverAfterCommit` once the transaction committed. */
  notificationIds: string[];
}

function auditFieldsFor(caller: FollowUpCaller, ctx: RequestContext | undefined): AuditContextFields {
  if (isSystem(caller)) return { tenantId: caller.tenantId, actorUserId: null, sourceApp: "SYSTEM", correlationId: ctx?.correlationId };
  return ctx ? auditContextFields(ctx) : { tenantId: caller.tenantId, actorUserId: caller.userId, sourceApp: "API" };
}

/**
 * Creates a follow-up task inside the caller's transaction. This is the entry point other modules use (the recovery
 * engine, job outcomes); the HTTP path is `createFollowUp`.
 *
 * A person needs `follow_ups.create` over the target's service area AND view access to the target; assigning to someone
 * other than themselves also needs `follow_ups.assign` over that employee (`validateAssignee`). The system skips the
 * permission checks but never the data rules: the target must exist and not be archived, the assignee must be able to work
 * the task. The task copies the target's service-area unit (`orgUnitId`), which drives its scope afterwards.
 */
export async function createFollowUpTaskInTx(
  tx: TenantTx,
  caller: FollowUpCaller,
  input: NewFollowUpTask,
  ctx?: RequestContext,
): Promise<CreatedFollowUpTask> {
  const { tenantId } = caller;
  const person = isSystem(caller) ? null : caller;
  const title = input.title.trim();
  if (!title) throw new ValidationError({ message: "A follow-up needs a title.", field: "title" });

  if (person) await enforceInTx(tx, person, "follow_ups.create");
  const access = targetAccessFor(input.targetType);
  const facts = await access.facts(tx, tenantId, input.targetId);
  if (!facts) throw new NotFoundError();
  const columns = targetColumns(input.targetType, input.targetId);
  const targetRow = { targetType: input.targetType, leadId: null, customerId: null, jobId: null, recoveryCaseId: null, ...columns };
  // Existence and archive state of a record the caller cannot view are not revealed: the view check comes first.
  if (person) await assertTargetViewable(tx, person, targetRow);
  if (facts.archived) throw new InvalidStateTransitionError({ message: "An archived record takes no new follow-ups. Restore it first." });

  if (input.dedupeKey) {
    const existing = await tx.followUpTask.findFirst({ where: { tenantId, dedupeKey: input.dedupeKey }, select: { id: true } });
    if (existing) return { id: existing.id, created: false, notificationIds: [] };
  }

  const creatorEmployeeId = person?.employeeId ?? null;
  if (person) {
    await enforceInTx(tx, person, "follow_ups.create", {
      ...(facts.orgUnitId ? { orgUnitId: facts.orgUnitId } : {}),
      assignedEmployeeIds: input.assigneeId ? [input.assigneeId] : [],
      ...(creatorEmployeeId ? { ownerEmployeeId: creatorEmployeeId } : {}),
    });
  }
  const assignee = input.assigneeId
    ? await validateAssignee(tx, person, tenantId, input.assigneeId, { targetType: input.targetType, targetId: input.targetId, orgUnitId: facts.orgUnitId, creatorEmployeeId })
    : null;

  const now = new Date();
  const id = randomUUID();
  const data = {
    id,
    tenantId,
    targetType: input.targetType,
    ...columns,
    orgUnitId: facts.orgUnitId,
    title,
    description: input.description?.trim() || null,
    priority: input.priority ?? "NORMAL",
    origin: input.origin ?? (person ? "MANUAL" : "SYSTEM"),
    assigneeId: assignee?.employeeId ?? null,
    assignedAt: assignee ? now : null,
    dueAt: input.dueAt,
    dedupeKey: input.dedupeKey ?? null,
    createdById: person?.userId ?? null,
  } as const;

  if (input.dedupeKey) {
    // `ON CONFLICT DO NOTHING`: two concurrent creators of the same key cannot abort each other's transaction.
    const inserted = await tx.followUpTask.createMany({ data: [data], skipDuplicates: true });
    if (inserted.count === 0) {
      const winner = await tx.followUpTask.findFirstOrThrow({ where: { tenantId, dedupeKey: input.dedupeKey }, select: { id: true } });
      return { id: winner.id, created: false, notificationIds: [] };
    }
  } else {
    await tx.followUpTask.create({ data });
  }

  await recordAudit(tx, {
    ...auditFieldsFor(caller, ctx),
    action: "follow_up.create",
    targetType: "FollowUpTask",
    targetId: id,
    // The title and description are free text about a customer: the trail records that they exist, not what they say.
    newValue: {
      targetType: input.targetType,
      targetId: input.targetId,
      origin: data.origin,
      priority: data.priority,
      dueAt: input.dueAt,
      assigneeId: data.assigneeId,
      dedupeKey: input.dedupeKey,
    },
  });

  const row = await tx.followUpTask.findFirstOrThrow({ where: { id, tenantId }, select: followUpRowSelect });
  const notificationIds = assignee
    ? await notifyFollowUpAssignee(tx, tenantId, { eventType: "follow_up.assigned", row, anchor: `assigned:${now.getTime()}`, excludeUserId: person?.userId })
    : [];
  return { id, created: true, notificationIds };
}

/**
 * Creates a follow-up (POST /follow-ups). Accepts the offline fields: a device may queue the creation and replay it; the
 * same `clientEventId` returns the first task instead of creating a second.
 */
export async function createFollowUp(actor: Actor, ctx: RequestContext, input: CreateFollowUpInput): Promise<Record<string, unknown>> {
  const { clientEventId, occurredAt, ...content } = input;
  return runFieldWrite(
    actor,
    { clientEventId, occurredAt },
    {
      type: "follow_up.create",
      content,
      payload: { targetType: input.targetType, targetId: input.targetId, priority: input.priority, assigneeId: input.assigneeId ?? null },
    },
    async (tx) => {
      const created = await createFollowUpTaskInTx(tx, actor, input, ctx);
      return { entityType: "FollowUpTask", entityId: created.id, value: await viewAfterWrite(tx, actor, created.id), notificationIds: created.notificationIds };
    },
    (tx, entityId) => getFollowUpInTx(tx, actor, entityId),
  );
}
