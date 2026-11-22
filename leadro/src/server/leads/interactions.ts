import type { ContactOutcome, Prisma } from "@prisma/client";
import { canTransitionLead, isClosedStatus, type LeadStatusValue } from "@/lib/lead-lifecycle";
import { auditContextFields, recordAudit } from "@/server/audit";
import { LEAD_FIELD_MAP, LEAD_WRITE_ALLOWLISTS, assertWritableFields, enforceInTx } from "@/server/authz";
import {
  InvalidStateTransitionError,
  NotFoundError,
  ValidationError,
  pageArgs,
  toPage,
  type Actor,
  type Page,
  type RequestContext,
} from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { leadResourceRef } from "./lead-access";
import type { CloseInteractionInput, CreateInteractionInput, ListInteractionsQuery } from "./schemas";
import { applyLeadStatus, isLeadStatus, loadDisabledLeadTransitions } from "./status-change";

/**
 * Interactions on a lead: contact attempts, notes, customer messages and follow-ups (§6.2, §25.1).
 *
 * A CONTACT_ATTEMPT is "open" (§25.1) while it has no `closedAt` and is younger than the tenant's
 * `contactAttemptOpenMinutes` (default 30): somebody is, as far as the system knows, on the phone with the customer.
 * Reassigning the lead meanwhile needs an explicit confirmation (`assignment.ts`). An attempt recorded with its
 * `outcome` is already finished; one without an outcome stays open until `closeInteraction`.
 *
 * Writing an interaction needs `leads.edit` over the lead with a grant that may write the lead's `notes` (the base
 * set): a status-only grant (Technician) can move the status but cannot log customer contact.
 */

export const DEFAULT_OPEN_ATTEMPT_MINUTES = 30;
/** Clock skew tolerated for a client-supplied `occurredAt` (a future time is refused). */
const FUTURE_SKEW_MS = 60_000;
/** Outcomes that settle the question the follow-up was about: the follow-up date is cleared. */
const SETTLING_OUTCOMES: readonly ContactOutcome[] = ["REACHED", "DECLINED", "WRONG_NUMBER"];

const interactionSelect = {
  id: true,
  leadId: true,
  kind: true,
  direction: true,
  channel: true,
  outcome: true,
  body: true,
  occurredAt: true,
  closedAt: true,
  durationSeconds: true,
  followUpAt: true,
  authorId: true,
  createdAt: true,
} satisfies Prisma.LeadInteractionSelect;

/** The tenant's "open contact attempt" window in minutes. */
export async function loadOpenAttemptMinutes(tx: TenantTx, tenantId: string): Promise<number> {
  const settings = await tx.operationsSettings.findFirst({ where: { tenantId }, select: { contactAttemptOpenMinutes: true } });
  return settings?.contactAttemptOpenMinutes ?? DEFAULT_OPEN_ATTEMPT_MINUTES;
}

/** The lead's open contact attempts (§25.1): not closed and younger than the tenant's window. */
export async function findOpenContactAttempts(
  tx: TenantTx,
  tenantId: string,
  leadId: string,
  now: Date = new Date(),
): Promise<Array<{ id: string; authorId: string | null }>> {
  const minutes = await loadOpenAttemptMinutes(tx, tenantId);
  return tx.leadInteraction.findMany({
    where: { tenantId, leadId, kind: "CONTACT_ATTEMPT", closedAt: null, occurredAt: { gte: new Date(now.getTime() - minutes * 60_000) } },
    select: { id: true, authorId: true },
    orderBy: { occurredAt: "asc" },
  });
}

/** Loads the lead for an interaction write: it must exist in scope, with a grant that may write notes. */
async function enforceInteractionWrite(tx: TenantTx, actor: Actor, leadId: string, extraFields: string[]): Promise<void> {
  await enforceInTx(tx, actor, "leads.edit");
  const ref = await leadResourceRef(tx, actor.tenantId, leadId);
  if (!ref) throw new NotFoundError();
  const decision = await enforceInTx(tx, actor, "leads.edit", ref);
  assertWritableFields(decision, ["notes", ...extraFields], LEAD_FIELD_MAP, LEAD_WRITE_ALLOWLISTS);
}

/**
 * A contact attempt moves a freshly assigned lead along: ASSIGNED -> CONTACT_ATTEMPTED, and a reached customer ->
 * CONTACTED. Only forward from those two statuses, and only when the machine (with the tenant's narrowing) allows
 * it: recording a call on a QUALIFIED lead must never pull it backwards.
 */
async function advanceAfterContact(
  tx: TenantTx,
  actor: Actor,
  ctx: RequestContext,
  lead: { id: string; status: LeadStatusValue },
  outcome: ContactOutcome | null | undefined,
): Promise<void> {
  if (lead.status !== "ASSIGNED" && lead.status !== "CONTACT_ATTEMPTED") return;
  const target: LeadStatusValue = outcome === "REACHED" ? "CONTACTED" : "CONTACT_ATTEMPTED";
  if (target === lead.status) return;
  const disabled = await loadDisabledLeadTransitions(tx, actor.tenantId);
  if (!canTransitionLead(lead.status, target, disabled)) return;
  await applyLeadStatus(tx, actor, ctx, lead, target, { reason: "contact attempt recorded" });
}

async function loadWritableLead(tx: TenantTx, actor: Actor, leadId: string, needsOpenLead: boolean) {
  const lead = await tx.lead.findFirst({ where: { id: leadId, tenantId: actor.tenantId }, select: { id: true, status: true, archivedAt: true } });
  if (!lead || !isLeadStatus(lead.status)) throw new NotFoundError();
  if (lead.archivedAt) throw new InvalidStateTransitionError({ message: "An archived lead cannot be changed. Restore it first." });
  if (needsOpenLead && isClosedStatus(lead.status)) {
    throw new InvalidStateTransitionError({ message: `A ${lead.status} lead takes no more contact attempts or follow-ups. Reopen it first.` });
  }
  return { id: lead.id, status: lead.status };
}

/** Records an interaction on a lead (see the module comment). Returns the stored interaction. */
export async function createInteraction(
  actor: Actor,
  ctx: RequestContext,
  leadId: string,
  input: CreateInteractionInput,
): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInteractionWrite(tx, actor, leadId, input.followUpAt ? ["nextFollowUpAt"] : []);
    const needsOpenLead = input.kind === "CONTACT_ATTEMPT" || input.kind === "FOLLOW_UP";
    const lead = await loadWritableLead(tx, actor, leadId, needsOpenLead);

    const now = new Date();
    const occurredAt = input.occurredAt ?? now;
    if (occurredAt.getTime() > now.getTime() + FUTURE_SKEW_MS) {
      throw new ValidationError({ message: "An interaction cannot happen in the future.", field: "occurredAt" });
    }
    const direction =
      input.direction ?? (input.kind === "CONTACT_ATTEMPT" ? "OUTBOUND" : input.kind === "CUSTOMER_MESSAGE" ? "INBOUND" : "INTERNAL");
    // With its outcome a contact attempt is already finished; without one it is in progress (open, §25.1).
    const closedAt = input.kind === "CONTACT_ATTEMPT" && input.outcome ? now : null;

    const interaction = await tx.leadInteraction.create({
      data: {
        tenantId: actor.tenantId,
        leadId,
        kind: input.kind,
        direction,
        channel: input.channel ?? null,
        outcome: input.outcome ?? null,
        body: input.body ?? null,
        occurredAt,
        closedAt: closedAt && closedAt < occurredAt ? occurredAt : closedAt,
        durationSeconds: input.durationSeconds ?? null,
        followUpAt: input.followUpAt ?? null,
        authorId: actor.userId,
      },
      select: interactionSelect,
    });

    await syncFollowUp(tx, actor, leadId, input.followUpAt, input.outcome);
    if (input.kind === "CONTACT_ATTEMPT") await advanceAfterContact(tx, actor, ctx, lead, input.outcome);

    // The body can hold anything the customer said: the audit trail records that it exists, not what it says.
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "lead.interaction_create",
      targetType: "Lead",
      targetId: leadId,
      newValue: { interactionId: interaction.id, kind: input.kind, channel: input.channel, outcome: input.outcome, followUpAt: input.followUpAt, hasBody: Boolean(input.body) },
    });
    return interaction;
  });
}

/** Sets or clears the lead's next follow-up date after an interaction. */
async function syncFollowUp(
  tx: TenantTx,
  actor: Actor,
  leadId: string,
  followUpAt: Date | undefined,
  outcome: ContactOutcome | null | undefined,
): Promise<void> {
  if (followUpAt) {
    await tx.lead.update({ where: { id: leadId }, data: { nextFollowUpAt: followUpAt } });
  } else if (outcome && SETTLING_OUTCOMES.includes(outcome)) {
    await tx.lead.updateMany({ where: { id: leadId, tenantId: actor.tenantId }, data: { nextFollowUpAt: null } });
  }
}

/**
 * Finishes an open contact attempt with its outcome. Closing an attempt that is already closed is refused (the
 * recorded outcome is history).
 */
export async function closeInteraction(
  actor: Actor,
  ctx: RequestContext,
  leadId: string,
  interactionId: string,
  input: CloseInteractionInput,
): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInteractionWrite(tx, actor, leadId, input.followUpAt ? ["nextFollowUpAt"] : []);
    const lead = await loadWritableLead(tx, actor, leadId, false);
    const attempt = await tx.leadInteraction.findFirst({
      where: { id: interactionId, tenantId: actor.tenantId, leadId },
      select: { id: true, kind: true, closedAt: true, occurredAt: true },
    });
    if (!attempt) throw new NotFoundError();
    if (attempt.kind !== "CONTACT_ATTEMPT") throw new InvalidStateTransitionError({ message: "Only a contact attempt can be closed." });
    if (attempt.closedAt) throw new InvalidStateTransitionError({ message: "This contact attempt is already closed." });

    const now = new Date();
    // Guarded on `closedAt IS NULL` so two people closing the same attempt cannot both win.
    const updated = await tx.leadInteraction.updateMany({
      where: { id: interactionId, tenantId: actor.tenantId, closedAt: null },
      data: {
        closedAt: now < attempt.occurredAt ? attempt.occurredAt : now,
        outcome: input.outcome,
        durationSeconds: input.durationSeconds ?? undefined,
        body: input.body ?? undefined,
        followUpAt: input.followUpAt ?? undefined,
      },
    });
    if (updated.count === 0) throw new InvalidStateTransitionError({ message: "This contact attempt is already closed." });

    await syncFollowUp(tx, actor, leadId, input.followUpAt, input.outcome);
    if (!isClosedStatus(lead.status)) await advanceAfterContact(tx, actor, ctx, lead, input.outcome);
    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "lead.interaction_close",
      targetType: "Lead",
      targetId: leadId,
      newValue: { interactionId, outcome: input.outcome },
    });
    return tx.leadInteraction.findFirstOrThrow({ where: { id: interactionId, tenantId: actor.tenantId }, select: interactionSelect });
  });
}

/** Interactions of a lead, newest first. Needs `leads.view` over the lead. */
export async function listInteractions(actor: Actor, leadId: string, query: ListInteractionsQuery): Promise<Page<Record<string, unknown>>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "leads.view");
    const ref = await leadResourceRef(tx, actor.tenantId, leadId);
    if (!ref) throw new NotFoundError();
    await enforceInTx(tx, actor, "leads.view", ref);
    const rows = await tx.leadInteraction.findMany({
      where: { tenantId: actor.tenantId, leadId, ...(query.kind ? { kind: query.kind } : {}) },
      select: interactionSelect,
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      ...pageArgs(query),
    });
    return toPage(rows, query.limit);
  });
}
