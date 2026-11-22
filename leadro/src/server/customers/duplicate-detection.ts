import type { DuplicateMatchField, Prisma } from "@prisma/client";
import { auditContextFields, recordAudit } from "@/server/audit";
import type { RequestContext } from "@/server/core";
import type { TenantTx } from "@/server/db";

/**
 * Duplicate detection for customers (§6.4). It FLAGS possible duplicates for a human; it never
 * merges, never blocks the write, and never reopens a pair a person already decided on.
 *
 * Matchers are tenant-configurable (`OperationsSettings.duplicateMatchers`, managed by
 * `customers.manage`): phone (E.164 equality), email (lower-case equality), address (equal
 * normalized key on a non-archived address) and name (case-insensitive equality; off by default
 * because common names collide). Detection looks at the WHOLE tenant, not only the caller's scope:
 * a duplicate across two cities is exactly what a scoped user cannot see. What is REVEALED to the
 * caller is filtered separately (`visibleCustomerIds`).
 *
 * The leads module reuses `findDuplicateCustomerCandidates` (lead against existing customers).
 */

export interface DuplicateMatchers {
  phone: boolean;
  email: boolean;
  address: boolean;
  name: boolean;
}

export const DEFAULT_DUPLICATE_MATCHERS: DuplicateMatchers = { phone: true, email: true, address: true, name: false };

/** Reads the stored JSON tolerantly: unknown keys and non-boolean values are ignored, missing keys take the default. */
export function parseDuplicateMatchers(stored: unknown): DuplicateMatchers {
  const result = { ...DEFAULT_DUPLICATE_MATCHERS };
  if (typeof stored !== "object" || stored === null) return result;
  for (const key of Object.keys(result) as Array<keyof DuplicateMatchers>) {
    const value = (stored as Record<string, unknown>)[key];
    if (typeof value === "boolean") result[key] = value;
  }
  return result;
}

/** The tenant's effective matchers (defaults when it never configured any). */
export async function loadDuplicateMatchers(tx: TenantTx, tenantId: string): Promise<DuplicateMatchers> {
  const settings = await tx.operationsSettings.findFirst({ where: { tenantId }, select: { duplicateMatchers: true } });
  return parseDuplicateMatchers(settings?.duplicateMatchers);
}

/** The values a record is matched on. Build them with the same normalizers the customers service stores. */
export interface DuplicateMatchKeys {
  phoneE164?: string | null;
  email?: string | null;
  addressKeys?: string[];
  name?: string | null;
}

export interface DuplicateCandidate {
  customerId: string;
  matchedOn: DuplicateMatchField[];
}

const CANDIDATE_LIMIT = 50;
const normalizeName = (name: string): string => name.trim().replace(/\s+/g, " ");

/**
 * Existing customers (archived ones too: a returning customer is the classic duplicate) that match
 * `keys` on at least one enabled matcher. `excludeCustomerId` removes the record's own row.
 * Tenant-wide (under RLS); the caller decides what to reveal.
 */
export async function findDuplicateCustomerCandidates(
  tx: TenantTx,
  tenantId: string,
  keys: DuplicateMatchKeys,
  matchers: DuplicateMatchers,
  excludeCustomerId?: string,
): Promise<DuplicateCandidate[]> {
  const name = keys.name ? normalizeName(keys.name) : "";
  const addressKeys = keys.addressKeys ?? [];
  const conditions: Prisma.CustomerWhereInput[] = [];
  if (matchers.phone && keys.phoneE164) conditions.push({ phoneE164: keys.phoneE164 });
  if (matchers.email && keys.email) conditions.push({ email: keys.email });
  if (matchers.address && addressKeys.length > 0) {
    conditions.push({ addresses: { some: { normalizedKey: { in: addressKeys }, archivedAt: null } } });
  }
  if (matchers.name && name) conditions.push({ name: { equals: name, mode: "insensitive" } });
  if (conditions.length === 0) return [];

  const rows = await tx.customer.findMany({
    where: { tenantId, OR: conditions, ...(excludeCustomerId ? { id: { not: excludeCustomerId } } : {}) },
    select: { id: true, phoneE164: true, email: true, name: true, addresses: { where: { archivedAt: null }, select: { normalizedKey: true } } },
    orderBy: { id: "asc" },
    take: CANDIDATE_LIMIT,
  });

  return rows.map((row) => {
    const matchedOn: DuplicateMatchField[] = [];
    if (matchers.phone && keys.phoneE164 && row.phoneE164 === keys.phoneE164) matchedOn.push("PHONE");
    if (matchers.email && keys.email && row.email === keys.email) matchedOn.push("EMAIL");
    if (matchers.address && row.addresses.some((address) => addressKeys.includes(address.normalizedKey))) matchedOn.push("ADDRESS");
    if (matchers.name && name && row.name.trim().replace(/\s+/g, " ").toLowerCase() === name.toLowerCase()) matchedOn.push("NAME");
    return { customerId: row.id, matchedOn };
  });
}

/** `DuplicateFlag.pairKey` of two customers: ids in sorted order, so each pair is flagged once (the table CHECK needs the same order). */
export function customerPairKey(customerA: string, customerB: string): { pairKey: string; customerId: string; otherCustomerId: string } {
  const [customerId, otherCustomerId] = customerA < customerB ? [customerA, customerB] : [customerB, customerA];
  return { pairKey: `customer:${customerId}:${otherCustomerId}`, customerId, otherCustomerId };
}

/** An open flag to show the caller after a write. */
export interface OpenDuplicate {
  flagId: string;
  customerId: string;
  matchedOn: DuplicateMatchField[];
}

/**
 * Runs the matchers for ONE stored customer and records the result as `DuplicateFlag` rows:
 *  - a new pair gets an OPEN flag (audited);
 *  - an OPEN pair gets its `matchedOn` refreshed from the current data;
 *  - a pair already decided (NOT_DUPLICATE / CONFIRMED_DUPLICATE) is left alone, so "not a duplicate" sticks.
 * Returns the OPEN flags of the customer's candidates (new and existing).
 */
export async function flagCustomerDuplicates(tx: TenantTx, ctx: RequestContext, customerId: string): Promise<OpenDuplicate[]> {
  const tenantId = ctx.actor?.tenantId;
  if (!tenantId) throw new Error("flagCustomerDuplicates requires an authenticated actor");

  const customer = await tx.customer.findFirst({
    where: { id: customerId, tenantId },
    select: { phoneE164: true, email: true, name: true, addresses: { where: { archivedAt: null }, select: { normalizedKey: true } } },
  });
  if (!customer) return [];

  const matchers = await loadDuplicateMatchers(tx, tenantId);
  const candidates = await findDuplicateCustomerCandidates(
    tx,
    tenantId,
    { ...customer, addressKeys: customer.addresses.map((address) => address.normalizedKey) },
    matchers,
    customerId,
  );
  if (candidates.length === 0) return [];

  const pairs = candidates.map((candidate) => ({ ...customerPairKey(customerId, candidate.customerId), candidate }));
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
        kind: "CUSTOMER_CUSTOMER" as const,
        pairKey: pair.pairKey,
        customerId: pair.customerId,
        otherCustomerId: pair.otherCustomerId,
        matchedOn: pair.candidate.matchedOn,
      })),
      skipDuplicates: true,
    });
  }

  const flags = await tx.duplicateFlag.findMany({
    where: { tenantId, pairKey: { in: pairs.map((pair) => pair.pairKey) } },
    select: { id: true, pairKey: true, status: true },
  });
  const flagByKey = new Map(flags.map((flag) => [flag.pairKey, flag]));

  const open: OpenDuplicate[] = [];
  for (const pair of pairs) {
    const flag = flagByKey.get(pair.pairKey);
    if (!flag || flag.status !== "OPEN") continue;
    const before = existingByKey.get(pair.pairKey);
    if (before && before.matchedOn.join() !== pair.candidate.matchedOn.join()) {
      await tx.duplicateFlag.update({ where: { id: flag.id }, data: { matchedOn: pair.candidate.matchedOn } });
    }
    if (!before) {
      await recordAudit(tx, {
        ...auditContextFields(ctx),
        action: "customer.duplicate_flag",
        targetType: "DuplicateFlag",
        targetId: flag.id,
        newValue: { customerId: pair.customerId, otherCustomerId: pair.otherCustomerId, matchedOn: pair.candidate.matchedOn },
      });
    }
    open.push({ flagId: flag.id, customerId: pair.candidate.customerId, matchedOn: pair.candidate.matchedOn });
  }
  return open;
}
