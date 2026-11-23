import type { DuplicateKind, DuplicateMatchField, Prisma } from "@prisma/client";
import { auditContextFields, recordAudit } from "@/server/audit";
import { enforceInTx } from "@/server/authz";
import {
  ConflictError,
  InvalidStateTransitionError,
  NotFoundError,
  pageArgs,
  toPage,
  type Actor,
  type Page,
  type RequestContext,
} from "@/server/core";
import {
  customerResourceRef,
  findDuplicateCustomerCandidates,
  loadDuplicateMatchers,
  resolveCustomerListAccess,
  visibleCustomerIds,
  type DuplicateMatchers,
} from "@/server/customers";
import { withTenant, type TenantTx } from "@/server/db";
import { leadResourceRef, resolveLeadListAccess, visibleLeadIds } from "./lead-access";
import type { ListLeadDuplicatesQuery, ResolveLeadDuplicateInput } from "./schemas";

/**
 * Duplicate detection for leads (§6.4, §25.1). Like the customers matcher it FLAGS for a human: it never merges,
 * never blocks the write and never reopens a pair a person already decided on. Matchers are the tenant's
 * (`OperationsSettings.duplicateMatchers`, shared with customers).
 *
 * Two kinds of pairs:
 *  - LEAD_CUSTOMER: the lead's phone / email / address matches an existing customer (archived ones too: a
 *    returning customer is the classic duplicate), found with the customers module's `findDuplicateCustomerCandidates`.
 *  - LEAD_LEAD: another non-archived lead created in the last `RECENT_LEAD_WINDOW_DAYS` days ("recent history", §6.4)
 *    matches on an enabled matcher.
 * Detection looks at the whole tenant; what the CALLER is told is filtered to records they may view.
 */

/** "Recent history" of §6.4: only leads this young are considered duplicates of a new lead (a years-old lead is history, not a duplicate). */
export const RECENT_LEAD_WINDOW_DAYS = 30;
const CANDIDATE_LIMIT = 50;

/** An open flag to show the caller after a write. */
export interface OpenLeadDuplicate {
  flagId: string;
  kind: "LEAD_LEAD" | "LEAD_CUSTOMER";
  /** The other lead (LEAD_LEAD) or the customer (LEAD_CUSTOMER). */
  otherId: string;
  matchedOn: DuplicateMatchField[];
}

/** `DuplicateFlag.pairKey` of two leads: ids in sorted order (the table CHECK needs the same order). */
export function leadPairKey(leadA: string, leadB: string): { pairKey: string; leadId: string; otherLeadId: string } {
  const [leadId, otherLeadId] = leadA < leadB ? [leadA, leadB] : [leadB, leadA];
  return { pairKey: `lead:${leadId}:${otherLeadId}`, leadId, otherLeadId };
}

/** `DuplicateFlag.pairKey` of a lead and a customer. */
export const leadCustomerPairKey = (leadId: string, customerId: string): string => `lead_customer:${leadId}:${customerId}`;

interface LeadMatchKeys {
  phoneE164: string | null;
  email: string | null;
  addressKey: string | null;
  name: string | null;
}

const normalizeName = (name: string): string => name.trim().replace(/\s+/g, " ").toLowerCase();

function matchedFields(keys: LeadMatchKeys, other: LeadMatchKeys, matchers: DuplicateMatchers): DuplicateMatchField[] {
  const fields: DuplicateMatchField[] = [];
  if (matchers.phone && keys.phoneE164 && keys.phoneE164 === other.phoneE164) fields.push("PHONE");
  if (matchers.email && keys.email && keys.email === other.email) fields.push("EMAIL");
  if (matchers.address && keys.addressKey && keys.addressKey === other.addressKey) fields.push("ADDRESS");
  if (matchers.name && keys.name && other.name && normalizeName(keys.name) === normalizeName(other.name)) fields.push("NAME");
  return fields;
}

/** Other recent leads matching `keys` on at least one enabled matcher. */
async function findDuplicateLeadCandidates(
  tx: TenantTx,
  tenantId: string,
  leadId: string,
  keys: LeadMatchKeys,
  matchers: DuplicateMatchers,
  now: Date,
): Promise<Array<{ leadId: string; matchedOn: DuplicateMatchField[] }>> {
  const conditions: Prisma.LeadWhereInput[] = [];
  if (matchers.phone && keys.phoneE164) conditions.push({ contactPhoneE164: keys.phoneE164 });
  if (matchers.email && keys.email) conditions.push({ contactEmail: keys.email });
  if (matchers.address && keys.addressKey) conditions.push({ addressNormalizedKey: keys.addressKey });
  if (matchers.name && keys.name) conditions.push({ contactName: { equals: keys.name.trim().replace(/\s+/g, " "), mode: "insensitive" } });
  if (conditions.length === 0) return [];

  const since = new Date(now.getTime() - RECENT_LEAD_WINDOW_DAYS * 86_400_000);
  const rows = await tx.lead.findMany({
    where: { tenantId, id: { not: leadId }, archivedAt: null, createdAt: { gte: since }, OR: conditions },
    select: { id: true, contactPhoneE164: true, contactEmail: true, addressNormalizedKey: true, contactName: true },
    orderBy: { id: "asc" },
    take: CANDIDATE_LIMIT,
  });
  return rows.map((row) => ({
    leadId: row.id,
    matchedOn: matchedFields(
      keys,
      { phoneE164: row.contactPhoneE164, email: row.contactEmail, addressKey: row.addressNormalizedKey, name: row.contactName },
      matchers,
    ),
  }));
}

interface PairToFlag {
  pairKey: string;
  kind: Extract<DuplicateKind, "LEAD_LEAD" | "LEAD_CUSTOMER">;
  leadId: string;
  otherLeadId: string | null;
  customerId: string | null;
  otherId: string;
  matchedOn: DuplicateMatchField[];
}

/**
 * Runs the matchers for ONE stored lead and records the result as `DuplicateFlag` rows: a new pair gets an OPEN
 * flag (audited), an OPEN pair has its `matchedOn` refreshed, a decided pair (NOT_DUPLICATE / CONFIRMED_DUPLICATE) is
 * left alone so "not a duplicate" sticks. Returns the OPEN flags of the lead's candidates.
 */
export async function flagLeadDuplicates(tx: TenantTx, ctx: RequestContext, leadId: string): Promise<OpenLeadDuplicate[]> {
  const tenantId = ctx.actor?.tenantId;
  if (!tenantId) throw new Error("flagLeadDuplicates requires an authenticated actor");
  const lead = await tx.lead.findFirst({
    where: { id: leadId, tenantId },
    select: { contactPhoneE164: true, contactEmail: true, addressNormalizedKey: true, contactName: true, customerId: true },
  });
  if (!lead) return [];

  const matchers = await loadDuplicateMatchers(tx, tenantId);
  const keys: LeadMatchKeys = {
    phoneE164: lead.contactPhoneE164,
    email: lead.contactEmail,
    addressKey: lead.addressNormalizedKey,
    name: lead.contactName,
  };
  const customerCandidates = await findDuplicateCustomerCandidates(
    tx,
    tenantId,
    { phoneE164: keys.phoneE164, email: keys.email, addressKeys: keys.addressKey ? [keys.addressKey] : [], name: keys.name },
    matchers,
    lead.customerId ?? undefined, // the customer the lead is already linked to is not "a duplicate" of it
  );
  const leadCandidates = await findDuplicateLeadCandidates(tx, tenantId, leadId, keys, matchers, new Date());

  const pairs: PairToFlag[] = [
    ...customerCandidates.map((candidate) => ({
      pairKey: leadCustomerPairKey(leadId, candidate.customerId),
      kind: "LEAD_CUSTOMER" as const,
      leadId,
      otherLeadId: null,
      customerId: candidate.customerId,
      otherId: candidate.customerId,
      matchedOn: candidate.matchedOn,
    })),
    ...leadCandidates.map((candidate) => {
      const key = leadPairKey(leadId, candidate.leadId);
      return {
        pairKey: key.pairKey,
        kind: "LEAD_LEAD" as const,
        leadId: key.leadId,
        otherLeadId: key.otherLeadId,
        customerId: null,
        otherId: candidate.leadId,
        matchedOn: candidate.matchedOn,
      };
    }),
  ];
  if (pairs.length === 0) return [];

  const existing = await tx.duplicateFlag.findMany({
    where: { tenantId, pairKey: { in: pairs.map((pair) => pair.pairKey) } },
    select: { id: true, pairKey: true, status: true, matchedOn: true },
  });
  const existingByKey = new Map(existing.map((flag) => [flag.pairKey, flag]));

  // skipDuplicates (ON CONFLICT DO NOTHING): two requests flagging the same pair at once must not abort the transaction.
  const missing = pairs.filter((pair) => !existingByKey.has(pair.pairKey));
  if (missing.length > 0) {
    await tx.duplicateFlag.createMany({
      data: missing.map((pair) => ({
        tenantId,
        kind: pair.kind,
        pairKey: pair.pairKey,
        leadId: pair.leadId,
        otherLeadId: pair.otherLeadId,
        customerId: pair.customerId,
        matchedOn: pair.matchedOn,
      })),
      skipDuplicates: true,
    });
  }
  const flags = await tx.duplicateFlag.findMany({
    where: { tenantId, pairKey: { in: pairs.map((pair) => pair.pairKey) } },
    select: { id: true, pairKey: true, status: true },
  });
  const flagByKey = new Map(flags.map((flag) => [flag.pairKey, flag]));

  const open: OpenLeadDuplicate[] = [];
  for (const pair of pairs) {
    const flag = flagByKey.get(pair.pairKey);
    if (!flag || flag.status !== "OPEN") continue;
    const before = existingByKey.get(pair.pairKey);
    if (before && before.matchedOn.join() !== pair.matchedOn.join()) {
      await tx.duplicateFlag.update({ where: { id: flag.id }, data: { matchedOn: pair.matchedOn } });
    }
    if (!before) {
      await recordAudit(tx, {
        ...auditContextFields(ctx),
        action: "lead.duplicate_flag",
        targetType: "DuplicateFlag",
        targetId: flag.id,
        newValue: { kind: pair.kind, leadId: pair.leadId, otherId: pair.otherId, matchedOn: pair.matchedOn },
      });
    }
    open.push({ flagId: flag.id, kind: pair.kind, otherId: pair.otherId, matchedOn: pair.matchedOn });
  }
  return open;
}

/**
 * Open duplicates the caller may be told about: LEAD_LEAD only when they may view the other lead, LEAD_CUSTOMER
 * only when they may view the customer. Detection is tenant-wide, so EVERY response that carries
 * `possibleDuplicates` must pass through this (an id outside the caller's scope must not leak).
 */
export async function revealableLeadDuplicates(tx: TenantTx, actor: Actor, open: OpenLeadDuplicate[]): Promise<OpenLeadDuplicate[]> {
  const visibleLeads = await visibleLeadIds(tx, actor, open.filter((entry) => entry.kind === "LEAD_LEAD").map((entry) => entry.otherId));
  const visibleCustomers = await visibleCustomerIds(tx, actor, open.filter((entry) => entry.kind === "LEAD_CUSTOMER").map((entry) => entry.otherId));
  return open.filter((entry) => (entry.kind === "LEAD_LEAD" ? visibleLeads : visibleCustomers).has(entry.otherId));
}

const flagSelect = {
  id: true,
  kind: true,
  leadId: true,
  otherLeadId: true,
  customerId: true,
  matchedOn: true,
  reason: true,
  status: true,
  detectedAt: true,
  resolvedAt: true,
  resolvedById: true,
  resolutionNote: true,
} satisfies Prisma.DuplicateFlagSelect;

/**
 * The lead duplicate review queue, newest detection first. Needs `leads.view`; a flag is listed only when the caller
 * may view the lead AND its other side (the other lead, or the customer), otherwise the queue would reveal records
 * outside the caller's scope.
 */
export async function listLeadDuplicateFlags(actor: Actor, query: ListLeadDuplicatesQuery): Promise<Page<Record<string, unknown>>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "leads.view");
    const leadAccess = await resolveLeadListAccess(tx, actor, "leads.view");
    // No customers.view grant resolves to an empty scope (nothing matches), so LEAD_CUSTOMER flags simply do not show.
    const customerAccess = await resolveCustomerListAccess(tx, actor, "customers.view");
    const where: Prisma.DuplicateFlagWhereInput = {
      AND: [
        { tenantId: actor.tenantId, kind: { in: ["LEAD_LEAD", "LEAD_CUSTOMER"] }, status: query.status },
        { lead: leadAccess.where },
        {
          OR: [
            { kind: "LEAD_LEAD", otherLead: leadAccess.where },
            { kind: "LEAD_CUSTOMER", customer: customerAccess.where },
          ],
        },
        ...(query.leadId ? [{ OR: [{ leadId: query.leadId }, { otherLeadId: query.leadId }] }] : []),
      ],
    };
    const rows = await tx.duplicateFlag.findMany({
      where,
      select: flagSelect,
      orderBy: [{ detectedAt: "desc" }, { id: "desc" }],
      ...pageArgs(query),
    });
    return toPage(rows, query.limit);
  });
}

/**
 * Records a person's decision on a lead duplicate flag. `NOT_DUPLICATE` keeps the pair from being flagged again;
 * `CONFIRMED_DUPLICATE` records that they are the same party (the lead is then moved to DUPLICATE with the status
 * action, or linked to the customer: nothing is merged here). Needs `leads.edit` over the lead (and the other lead,
 * or `customers.view` over the customer). An out-of-scope side makes the whole flag a 404.
 */
export async function resolveLeadDuplicateFlag(
  actor: Actor,
  ctx: RequestContext,
  flagId: string,
  input: ResolveLeadDuplicateInput,
): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    await enforceInTx(tx, actor, "leads.edit");
    const flag = await tx.duplicateFlag.findFirst({
      where: { id: flagId, tenantId: actor.tenantId, kind: { in: ["LEAD_LEAD", "LEAD_CUSTOMER"] } },
      select: flagSelect,
    });
    if (!flag || !flag.leadId) throw new NotFoundError();

    for (const leadId of [flag.leadId, flag.otherLeadId]) {
      if (!leadId) continue;
      const ref = await leadResourceRef(tx, actor.tenantId, leadId);
      if (!ref) throw new NotFoundError();
      await enforceInTx(tx, actor, "leads.edit", ref);
    }
    if (flag.customerId) {
      const ref = await customerResourceRef(tx, actor.tenantId, flag.customerId);
      if (!ref) throw new NotFoundError();
      await enforceInTx(tx, actor, "customers.view", ref);
    }
    if (flag.status === input.resolution) {
      throw new InvalidStateTransitionError({ message: "The duplicate flag already has this resolution." });
    }

    const now = new Date();
    // Optimistic guard: a concurrent decision changes the status, and the loser gets a 409.
    const updated = await tx.duplicateFlag.updateMany({
      where: { id: flag.id, tenantId: actor.tenantId, status: flag.status },
      data: { status: input.resolution, resolvedAt: now, resolvedById: actor.userId, resolutionNote: input.note ?? null },
    });
    if (updated.count === 0) throw new ConflictError({ message: "The duplicate flag was changed by someone else." });

    await recordAudit(tx, {
      ...auditContextFields(ctx),
      action: "lead.duplicate_resolve",
      targetType: "DuplicateFlag",
      targetId: flag.id,
      previousValue: { status: flag.status },
      newValue: { status: input.resolution, kind: flag.kind, leadId: flag.leadId, otherLeadId: flag.otherLeadId, customerId: flag.customerId },
      reason: input.note,
    });
    return { ...flag, status: input.resolution, resolvedAt: now, resolvedById: actor.userId, resolutionNote: input.note ?? null };
  });
}

/** Marks the OPEN lead-customer flag of a pair as a confirmed duplicate: linking a lead to a customer IS that human decision. */
export async function confirmLeadCustomerFlag(tx: TenantTx, actor: Actor, leadId: string, customerId: string): Promise<void> {
  await tx.duplicateFlag.updateMany({
    where: { tenantId: actor.tenantId, pairKey: leadCustomerPairKey(leadId, customerId), status: "OPEN" },
    data: { status: "CONFIRMED_DUPLICATE", resolvedAt: new Date(), resolvedById: actor.userId, resolutionNote: "Lead linked to this customer" },
  });
}
