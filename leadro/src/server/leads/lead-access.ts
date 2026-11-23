import type { Prisma } from "@prisma/client";
import {
  buildScopeWhere,
  fieldSetsForRow,
  resolveScope,
  withinScope,
  type ResolvedScope,
  type ResourceRef,
  type RowScopeAttributes,
} from "@/server/authz";
import type { Actor } from "@/server/core";
import { leadScopeColumns } from "@/server/customers";
import type { TenantTx } from "@/server/db";

/**
 * How data scopes apply to leads (§4.2, PERMISSIONS.md section 4).
 *
 *  - `ORG_UNIT` / `LEGAL_ENTITY`: the lead's service-area org unit (`Lead.orgUnitId`) and that unit's legal
 *    entity. A lead without a unit is tenant-level: only a TENANT scope reaches it.
 *  - `ASSIGNED`: the caller owns the lead (ACTIVE `LeadAssignment`, shared fragment `leadAssignedToWhere` from
 *    `@/server/customers`; archived leads assign nobody). `OWN` matches nothing.
 *  - Record-set qualifier on a grant (`conditions.set`): `dispatch_related` (Dispatcher) = the lead has reached
 *    dispatch: QUALIFIED, SCHEDULED, DISPATCHED or CONVERTED. Any other set matches no lead (fail closed).
 */

export type LeadRecordSet = "dispatch_related";
export const LEAD_RECORD_SETS: readonly LeadRecordSet[] = ["dispatch_related"];
export const DISPATCH_RELATED_STATUSES = ["QUALIFIED", "SCHEDULED", "DISPATCHED", "CONVERTED"] as const;

const recordSetWhere: Record<LeadRecordSet, Prisma.LeadWhereInput> = {
  dispatch_related: { status: { in: [...DISPATCH_RELATED_STATUSES] } },
};

/** What the scope engine needs to know about one lead row. */
export interface LeadRowAttributes extends RowScopeAttributes {
  assignedEmployeeIds: string[];
  sets: LeadRecordSet[];
}

interface LeadScopeRow {
  id: string;
  status: string;
  orgUnitId: string | null;
  archivedAt: Date | null;
  orgUnit: { legalEntityId: string | null } | null;
}

/** Select fragment the scope attributes of a lead need. */
export const leadScopeSelect = {
  id: true,
  status: true,
  orgUnitId: true,
  archivedAt: true,
  orgUnit: { select: { legalEntityId: true } },
} satisfies Prisma.LeadSelect;

/** Current owners (ACTIVE assignment) of a batch of leads; one query. Leads with no owner are absent. */
export async function activeOwnersByLead(tx: TenantTx, tenantId: string, leadIds: string[]): Promise<Map<string, string>> {
  if (leadIds.length === 0) return new Map();
  const rows = await tx.leadAssignment.findMany({
    where: { tenantId, leadId: { in: leadIds }, state: "ACTIVE" },
    select: { leadId: true, employeeId: true },
  });
  return new Map(rows.map((row) => [row.leadId, row.employeeId]));
}

function belongsToSet(set: LeadRecordSet, row: LeadScopeRow): boolean {
  return set === "dispatch_related" ? (DISPATCH_RELATED_STATUSES as readonly string[]).includes(row.status) : false;
}

/**
 * Scope attributes for a batch of lead rows. The assigned employee of a lead is its ACTIVE assignee: the same
 * rule as `leadAssignedToWhere`, so list queries and single-record checks cannot disagree. An archived lead
 * assigns nobody.
 */
export async function leadRowAttributes(tx: TenantTx, tenantId: string, rows: LeadScopeRow[]): Promise<Map<string, LeadRowAttributes>> {
  const owners = await activeOwnersByLead(tx, tenantId, rows.map((row) => row.id));
  const result = new Map<string, LeadRowAttributes>();
  for (const row of rows) {
    const owner = owners.get(row.id);
    result.set(row.id, {
      orgUnitIds: row.orgUnitId ? [row.orgUnitId] : [],
      legalEntityIds: row.orgUnit?.legalEntityId ? [row.orgUnit.legalEntityId] : [],
      assignedEmployeeIds: owner && !row.archivedAt ? [owner] : [],
      sets: LEAD_RECORD_SETS.filter((set) => belongsToSet(set, row)),
    });
  }
  return result;
}

/** The `ResourceRef` of attributes: always carries assigned ids and sets, so a denial is a 404 and never a 403 that confirms existence. */
export function toLeadResourceRef(row: LeadScopeRow, attributes: LeadRowAttributes): ResourceRef {
  return {
    ...(row.orgUnitId ? { orgUnitId: row.orgUnitId } : {}),
    assignedEmployeeIds: attributes.assignedEmployeeIds,
    sets: attributes.sets,
  };
}

/** The resource reference of ONE lead (route resolver and service pre-check); `null` when the lead does not exist. */
export async function leadResourceRef(tx: TenantTx, tenantId: string, leadId: string): Promise<ResourceRef | null> {
  const row = await tx.lead.findFirst({ where: { id: leadId, tenantId }, select: leadScopeSelect });
  if (!row) return null;
  const attributes = (await leadRowAttributes(tx, tenantId, [row])).get(row.id);
  return attributes ? toLeadResourceRef(row, attributes) : null;
}

export interface LeadListAccess {
  /** Combine with the caller's filters through `withinScope`, never by spreading. */
  where: Prisma.LeadWhereInput;
  /** Field sets the caller may see on a row: the union over every grant variant that covers it. */
  fieldSetsOf: (attributes: LeadRowAttributes) => string[];
}

/**
 * Resolves the caller's coverage of leads for `permission` as ONE query fragment. A grant qualified by a record
 * set cannot be a plain scope fragment, so coverage is the union of the plain grants' scope and, per known set,
 * the scope of plain + that set's grants restricted to leads of the set (the customers module does the same).
 */
export async function resolveLeadListAccess(
  tx: TenantTx,
  actor: Actor,
  permission: string,
  now: Date = new Date(),
): Promise<LeadListAccess> {
  const base = await resolveScope(tx, actor, permission, now);
  const variants: Array<{ scope: ResolvedScope; set: LeadRecordSet | null }> = [{ scope: base, set: null }];
  for (const set of LEAD_RECORD_SETS) {
    const scope = await resolveScope(tx, actor, permission, now, { satisfiedSets: [set] });
    if (scope.parts.length > base.parts.length) variants.push({ scope, set });
  }
  const branches = variants.map(({ scope, set }) => {
    const scopeWhere = buildScopeWhere(scope, leadScopeColumns, now);
    return set ? withinScope(scopeWhere, recordSetWhere[set]) : scopeWhere;
  });
  return {
    where: branches.length === 1 ? branches[0] : { OR: branches },
    fieldSetsOf: (attributes) => [
      ...new Set(
        variants
          .filter(({ set }) => set === null || attributes.sets.includes(set))
          .flatMap(({ scope }) => fieldSetsForRow(scope, attributes)),
      ),
    ],
  };
}

/** Of `leadIds`, the ones the caller may view (`leads.view`): a response never reveals a lead outside the caller's scope. */
export async function visibleLeadIds(tx: TenantTx, actor: Actor, leadIds: string[]): Promise<Set<string>> {
  if (leadIds.length === 0) return new Set();
  const access = await resolveLeadListAccess(tx, actor, "leads.view");
  const rows = await tx.lead.findMany({
    where: withinScope(access.where, { tenantId: actor.tenantId, id: { in: leadIds } }),
    select: { id: true },
  });
  return new Set(rows.map((row) => row.id));
}

/**
 * Locks the lead row (`FOR UPDATE`) for the rest of the transaction. Assignment, release and contact-attempt writes take
 * it BEFORE reading open attempts or the owner, so "is somebody on the phone?" and "who owns it?" cannot change between the
 * check and the write (spec 25.1), and conversions of one lead queue up.
 */
export async function lockLead(tx: TenantTx, tenantId: string, leadId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "Lead" WHERE id = ${leadId} AND "tenantId" = ${tenantId} FOR UPDATE`;
}
