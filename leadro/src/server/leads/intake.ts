import { normalizeAddressKey } from "@/lib/address-key";
import { normalizePhoneE164 } from "@/lib/phone";
import { auditContextFields, recordAudit } from "@/server/audit";
import { ForbiddenError, NotFoundError, ValidationError, conflictOnUniqueViolation, nextNumber, type Actor, type RequestContext, ConflictError } from "@/server/core";
import { LEAD_FIELD_MAP, LEAD_WRITE_ALLOWLISTS, assertWritableFields, canInTx, enforceInTx, type AccessDecision, type ResourceRef } from "@/server/authz";
import { assertCustomerActive, customerResourceRef } from "@/server/customers";
import { withTenant, type TenantTx } from "@/server/db";
import { deliverAfterCommit, notifyInTx, resolveLeadOperationsRecipients } from "@/server/notifications";
import { flagLeadDuplicates, revealableLeadDuplicates, type OpenLeadDuplicate } from "./duplicates";
import { leadResourceRef } from "./lead-access";
import { leadViewAfterWrite } from "./lead-view";
import { assertLeadServiceAreaUsable } from "./service-area";
import type { CreateLeadInput } from "./schemas";

/**
 * Lead intake (§6.2, §25.1): manual entry and the API (webhooks, integrations, imports). Needs `leads.create` over
 * the lead's service-area unit (without a unit the lead is tenant-level and a tenant-wide grant is required).
 *
 *  - A lead may arrive with an incomplete address or before any customer exists; it needs only some way to reach
 *    the customer.
 *  - Idempotent two ways: the `Idempotency-Key` header (replays the stored response) and, for sending systems, the
 *    pair (lead source, `externalId`): a duplicate webhook returns the lead it already created (`replayed: true`)
 *    instead of a second record (§25.1, §20.3).
 *  - Possible duplicates are FLAGGED (customers and recent leads, `duplicates.ts`), never merged and never blocking.
 *  - A new lead is NEW. Lead Operations of its unit are notified that it needs an owner (`lead.needs_owner`).
 */

export interface CreateLeadResult {
  /** The lead as the caller may see it, plus `possibleDuplicates`. */
  data: Record<string, unknown>;
  /** True when `externalId` matched a lead that already existed: nothing was created. */
  replayed: boolean;
}

const definedKeys = (value: object): string[] =>
  Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .map(([key]) => key);

/** The lead's address matching key: only a reasonably complete address can match (§25.1 incomplete addresses simply never match). */
function addressKeyOf(input: {
  addressLine1?: string | null;
  addressLine2?: string | null;
  addressCity?: string | null;
  addressRegion?: string | null;
  addressPostalCode?: string | null;
}): string | null {
  if (!input.addressLine1 || !input.addressCity || !input.addressRegion || !input.addressPostalCode) return null;
  // Leads carry no country: US is assumed, the same default customer addresses use.
  return normalizeAddressKey({
    line1: input.addressLine1,
    line2: input.addressLine2,
    city: input.addressCity,
    region: input.addressRegion,
    postalCode: input.addressPostalCode,
    countryCode: "US",
  });
}

async function resolveSource(tx: TenantTx, tenantId: string, input: CreateLeadInput): Promise<string | null> {
  if (!input.sourceId && !input.sourceCode) return null;
  const source = await tx.leadSource.findFirst({
    where: { tenantId, ...(input.sourceId ? { id: input.sourceId } : { code: input.sourceCode }) },
    select: { id: true, active: true },
  });
  const field = input.sourceId ? "sourceId" : "sourceCode";
  if (!source) throw new ValidationError({ message: "Unknown lead source.", field });
  if (!source.active) throw new ValidationError({ message: "This lead source is switched off.", field });
  return source.id;
}

/** Everything the lead points at must exist in the tenant (a friendly 400 instead of a foreign-key failure). */
async function assertReferences(tx: TenantTx, actor: Actor, input: CreateLeadInput): Promise<void> {
  if (input.jobTypeId) {
    const jobType = await tx.jobType.findFirst({ where: { id: input.jobTypeId, tenantId: actor.tenantId }, select: { id: true } });
    if (!jobType) throw new ValidationError({ message: "Unknown job type.", field: "jobTypeId" });
  }
  if (!input.customerId) return;
  // Archived customers take no new work (customers README); a missing one is a 404.
  await assertCustomerActive(tx, actor.tenantId, input.customerId);
  const ref = await customerResourceRef(tx, actor.tenantId, input.customerId);
  if (!ref) throw new NotFoundError();
  // The new lead will make the customer "lead_related": judge visibility as if it already were (a create has no history yet).
  const decision = await canInTx(tx, actor, "customers.view", { ...ref, sets: [...(ref.sets ?? []), "lead_related"] });
  if (!decision.allowed) throw new NotFoundError();
  if (input.customerAddressId) {
    const address = await tx.customerAddress.findFirst({
      where: { id: input.customerAddressId, customerId: input.customerId, tenantId: actor.tenantId, archivedAt: null },
      select: { id: true },
    });
    if (!address) throw new ValidationError({ message: "The address does not belong to this customer.", field: "customerAddressId" });
  }
}

/** Creates a lead, or returns the existing one for a repeated `(source, externalId)`. */
export async function createLead(actor: Actor, ctx: RequestContext, input: CreateLeadInput): Promise<CreateLeadResult> {
  try {
    return await createLeadOnce(actor, ctx, input);
  } catch (error) {
    // Two copies of one webhook raced: the loser hit the unique (source, externalId) index. Retry once: the lookup now
    // finds the winner's lead and answers with it (200) instead of a 409. Field-level conflicts are real answers.
    if (input.externalId && error instanceof ConflictError && error.field === undefined) return createLeadOnce(actor, ctx, input);
    throw error;
  }
}

async function createLeadOnce(actor: Actor, ctx: RequestContext, input: CreateLeadInput): Promise<CreateLeadResult> {
  let notificationIds: string[] = [];
  const result = await conflictOnUniqueViolation("This lead was just created by another request.", () =>
    withTenant(actor.tenantId, async (tx): Promise<CreateLeadResult> => {
      // A record that does not exist yet has no assignee and belongs to no record set.
      const newRecord: ResourceRef = { assignedEmployeeIds: [], sets: [] };
      let decision: AccessDecision;
      if (input.orgUnitId) {
        decision = await assertLeadServiceAreaUsable(tx, actor, "leads.create", input.orgUnitId, newRecord);
      } else {
        try {
          decision = await enforceInTx(tx, actor, "leads.create", newRecord);
        } catch (error) {
          // Creating has no existing record to hide: a missing tenant-wide grant is a plain 403.
          throw error instanceof NotFoundError ? new ForbiddenError() : error;
        }
      }

      const sourceId = await resolveSource(tx, actor.tenantId, input);
      const { sourceCode: _sourceCode, ...stored } = input;
      assertWritableFields(decision, definedKeys({ ...stored, sourceId: sourceId ?? undefined }), LEAD_FIELD_MAP, LEAD_WRITE_ALLOWLISTS);

      if (sourceId && input.externalId) {
        const existing = await tx.lead.findFirst({ where: { tenantId: actor.tenantId, sourceId, externalId: input.externalId }, select: { id: true } });
        if (existing) return { data: await replayView(tx, actor, existing.id), replayed: true };
      }
      await assertReferences(tx, actor, input);

      const contactPhoneE164 = input.contactPhone ? normalizePhoneE164(input.contactPhone) : null;
      const addressNormalizedKey = addressKeyOf(input);
      // The number is taken IN this transaction (a nested `withTenant` would hold a second pooled connection
      // per request and starve the pool under bursts).
      const number = await nextNumber(tx, actor.tenantId, "lead");

      const lead = await tx.lead.create({
        data: {
          tenantId: actor.tenantId,
          number,
          status: "NEW",
          priority: input.priority,
          sourceId,
          campaign: input.campaign ?? null,
          externalId: input.externalId ?? null,
          customerId: input.customerId ?? null,
          contactName: input.contactName ?? null,
          contactPhone: input.contactPhone ?? null,
          contactPhoneE164,
          contactEmail: input.contactEmail ?? null,
          customerAddressId: input.customerAddressId ?? null,
          addressLine1: input.addressLine1 ?? null,
          addressLine2: input.addressLine2 ?? null,
          addressCity: input.addressCity ?? null,
          addressRegion: input.addressRegion ?? null,
          addressPostalCode: input.addressPostalCode ?? null,
          addressNormalizedKey,
          jobTypeId: input.jobTypeId ?? null,
          serviceCategory: input.serviceCategory ?? null,
          requestedWork: input.requestedWork ?? null,
          preferredWindowStart: input.preferredWindowStart ?? null,
          preferredWindowEnd: input.preferredWindowEnd ?? null,
          preferredTimeNote: input.preferredTimeNote ?? null,
          notes: input.notes ?? null,
          quotedAmountMinor: input.quotedAmountMinor ?? null,
          currency: input.currency,
          orgUnitId: input.orgUnitId ?? null,
          nextFollowUpAt: input.nextFollowUpAt ?? null,
          createdById: actor.userId,
        },
        select: { id: true, number: true },
      });
      await tx.leadStatusHistory.create({
        data: { tenantId: actor.tenantId, leadId: lead.id, fromStatus: null, toStatus: "NEW", actorType: "USER", actorUserId: actor.userId, reason: null },
      });
      await recordAudit(tx, {
        ...auditContextFields(ctx),
        action: "lead.create",
        targetType: "Lead",
        targetId: lead.id,
        newValue: { ...stored, sourceId, contactPhoneE164, number: lead.number },
      });

      notificationIds = await announceNewLead(tx, actor, lead.id, lead.number, input.orgUnitId ?? null);
      const open = await flagLeadDuplicates(tx, ctx, lead.id);
      return { data: await withDuplicates(tx, actor, lead.id, open), replayed: false };
    }),
  );
  // Delivery happens after commit and can never undo the lead (§14).
  await deliverAfterCommit(actor.tenantId, notificationIds);
  return result;
}

/** The response of a replayed `(source, externalId)`: the existing lead, if the caller may see it; otherwise a conflict (nothing is revealed). */
async function replayView(tx: TenantTx, actor: Actor, leadId: string): Promise<Record<string, unknown>> {
  const ref = await leadResourceRef(tx, actor.tenantId, leadId);
  const visible = ref ? (await canInTx(tx, actor, "leads.view", ref)).allowed : false;
  if (!visible) throw new ConflictError({ message: "A lead with this source and external id already exists.", field: "externalId" });
  return { ...(await leadViewAfterWrite(tx, actor, leadId)), possibleDuplicates: [] };
}

async function withDuplicates(tx: TenantTx, actor: Actor, leadId: string, open: OpenLeadDuplicate[]): Promise<Record<string, unknown>> {
  const revealed = await revealableLeadDuplicates(tx, actor, open);
  return { ...(await leadViewAfterWrite(tx, actor, leadId)), possibleDuplicates: revealed };
}

/** Tells Lead Operations of the unit that a lead needs an owner (`lead.needs_owner`); returns the notification ids to deliver after commit. */
async function announceNewLead(tx: TenantTx, actor: Actor, leadId: string, leadNumber: number, orgUnitId: string | null): Promise<string[]> {
  if (!orgUnitId) return []; // an unrouted lead has no unit whose Lead Operations could be told
  const recipients = await resolveLeadOperationsRecipients(tx, actor.tenantId, orgUnitId, { excludeUserIds: [actor.userId] });
  const result = await notifyInTx(tx, {
    tenantId: actor.tenantId,
    eventType: "lead.needs_owner",
    eventId: `${leadId}:created`,
    recipientUserIds: recipients,
    params: { leadNumber },
    target: { targetType: "lead", targetId: leadId, permission: "leads.view", resource: { orgUnitId, assignedEmployeeIds: [], sets: [] } },
  });
  return result.createdNotificationIds;
}
