import type { Prisma } from "@prisma/client";
import {
  buildScopeWhere,
  fieldSetsForRow,
  resolveScope,
  withinScope,
  type ResolvedScope,
  type ResourceRef,
  type RowScopeAttributes,
  type ScopeColumns,
} from "@/server/authz";
import { InvalidStateTransitionError, NotFoundError, type Actor } from "@/server/core";
import type { TenantTx } from "@/server/db";
import { assignedEmployeeIdsByCustomer, customerAssignedToWhere } from "./assignment-access";
import type { OpenDuplicate } from "./duplicate-detection";

/**
 * How data scopes apply to customers (§4.2, PERMISSIONS.md section 4).
 *
 *  - `ORG_UNIT` / `LEGAL_ENTITY`: the customer's service-area org unit (`Customer.orgUnitId`, the
 *    branch or city) and that unit's legal entity. A customer without a unit is tenant-level: only a
 *    TENANT scope reaches it.
 *  - `ASSIGNED`: some lead or job of the customer is assigned to the caller (`assignment-access.ts`).
 *  - `OWN` has no meaning for customers and contributes nothing.
 *  - Record-set qualifiers on a grant (`conditions.set`): `job_related` (Dispatcher) = the customer
 *    has a job; `lead_related` (Lead Operations) = the customer has a lead OR a lead recovery case (a
 *    case can exist without a lead, and Lead Ops must still open its customer; a role holds one grant per permission, so the
 *    one `lead_related` grant covers both). Archived leads and jobs do not count. A grant with any other set matches no customer (fail closed).
 */

export type CustomerRecordSet = "job_related" | "lead_related";
export const CUSTOMER_RECORD_SETS: readonly CustomerRecordSet[] = ["job_related", "lead_related"];

export const customerScopeColumns: ScopeColumns<Prisma.CustomerWhereInput> = {
  orgUnit: (orgUnitIds) => ({ orgUnitId: { in: orgUnitIds } }),
  legalEntity: (legalEntityIds) => ({ orgUnit: { legalEntityId: { in: legalEntityIds } } }),
  assigned: customerAssignedToWhere,
};

/** The customer rows a set-qualified grant may cover: only customers that belong to the set. */
const recordSetWhere: Record<CustomerRecordSet, Prisma.CustomerWhereInput> = {
  job_related: { jobs: { some: { archivedAt: null } } },
  lead_related: { OR: [{ leads: { some: { archivedAt: null } } }, { recoveryCases: { some: {} } }] },
};

/** What the scope engine needs to know about one customer row. */
export interface CustomerRowAttributes extends RowScopeAttributes {
  assignedEmployeeIds: string[];
  sets: CustomerRecordSet[];
}

interface CustomerScopeRow {
  id: string;
  orgUnitId: string | null;
  orgUnit: { legalEntityId: string | null } | null;
}

/** Select fragment the scope attributes of a customer row need. Merge it into the query's `select`. */
export const customerScopeSelect = {
  id: true,
  orgUnitId: true,
  orgUnit: { select: { legalEntityId: true } },
} satisfies Prisma.CustomerSelect;

/**
 * Scope attributes for a batch of customer rows: placement, assigned employees (team expansion
 * included) and record sets. Four queries however many rows there are.
 */
export async function customerRowAttributes(
  tx: TenantTx,
  tenantId: string,
  rows: CustomerScopeRow[],
  now: Date = new Date(),
): Promise<Map<string, CustomerRowAttributes>> {
  const ids = rows.map((row) => row.id);
  const result = new Map<string, CustomerRowAttributes>();
  if (ids.length === 0) return result;

  const assigned = await assignedEmployeeIdsByCustomer(tx, tenantId, ids, now);
  const withJobs = new Set(
    (await tx.job.groupBy({ by: ["customerId"], where: { tenantId, customerId: { in: ids }, archivedAt: null } })).map(
      (group) => group.customerId,
    ),
  );
  const withLeads = new Set(
    (await tx.lead.groupBy({ by: ["customerId"], where: { tenantId, customerId: { in: ids }, archivedAt: null } }))
      .map((group) => group.customerId)
      .filter((customerId): customerId is string => customerId !== null),
  );
  const withCases = new Set(
    (await tx.leadRecoveryCase.groupBy({ by: ["customerId"], where: { tenantId, customerId: { in: ids } } })).map((group) => group.customerId),
  );

  for (const row of rows) {
    const sets: CustomerRecordSet[] = [];
    if (withJobs.has(row.id)) sets.push("job_related");
    if (withLeads.has(row.id) || withCases.has(row.id)) sets.push("lead_related");
    result.set(row.id, {
      orgUnitIds: row.orgUnitId ? [row.orgUnitId] : [],
      legalEntityIds: row.orgUnit?.legalEntityId ? [row.orgUnit.legalEntityId] : [],
      assignedEmployeeIds: assigned.get(row.id) ?? [],
      sets,
    });
  }
  return result;
}

/** The `ResourceRef` of attributes, for `can` / `enforceInTx`. Always carries assigned ids and sets so a denial is a 404, never a 403. */
export function toResourceRef(row: CustomerScopeRow, attributes: CustomerRowAttributes): ResourceRef {
  return {
    ...(row.orgUnitId ? { orgUnitId: row.orgUnitId } : {}),
    assignedEmployeeIds: attributes.assignedEmployeeIds,
    sets: attributes.sets,
  };
}

/**
 * The resource reference of ONE customer, read from the database in the caller's transaction.
 * Returns `null` when the customer does not exist in the tenant (callers answer 404). Routes use it as
 * the `requirePermission` resolver; services use it before `enforceInTx`.
 */
export async function customerResourceRef(
  tx: TenantTx,
  tenantId: string,
  customerId: string,
  now: Date = new Date(),
): Promise<ResourceRef | null> {
  const row = await tx.customer.findFirst({ where: { id: customerId, tenantId }, select: customerScopeSelect });
  if (!row) return null;
  const attributes = (await customerRowAttributes(tx, tenantId, [row], now)).get(row.id);
  return attributes ? toResourceRef(row, attributes) : null;
}

/** The customers a caller may reach with one permission, as a where-fragment, plus per-row field sets. */
export interface CustomerListAccess {
  /** Combine with the caller's filters through `withinScope`, never by spreading. */
  where: Prisma.CustomerWhereInput;
  /** Field sets the caller may see on a row: the union over every grant variant that covers it. */
  fieldSetsOf: (attributes: CustomerRowAttributes) => string[];
}

/**
 * Resolves the caller's coverage of customers for `permission` as ONE query fragment.
 *
 * A grant qualified by a record set cannot be expressed by a plain scope fragment, so the coverage
 * is the union of: the plain grants' scope, and, for each known set, the scope of plain + that
 * set's grants restricted to customers of the set. Each variant is a subset of what the caller may
 * really see, so the union is exact. Field sets are derived the same way, per row.
 */
export async function resolveCustomerListAccess(
  tx: TenantTx,
  actor: Actor,
  permission: string,
  now: Date = new Date(),
): Promise<CustomerListAccess> {
  const base = await resolveScope(tx, actor, permission, now);
  const variants: Array<{ scope: ResolvedScope; set: CustomerRecordSet | null }> = [{ scope: base, set: null }];
  for (const set of CUSTOMER_RECORD_SETS) {
    const scope = await resolveScope(tx, actor, permission, now, { satisfiedSets: [set] });
    if (scope.parts.length > base.parts.length) variants.push({ scope, set });
  }

  const branches = variants.map(({ scope, set }) => {
    const scopeWhere = buildScopeWhere(scope, customerScopeColumns, now);
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

/** Of `customerIds`, the ones the caller may view (`customers.view`), for revealing nothing about the rest. */
export async function visibleCustomerIds(
  tx: TenantTx,
  actor: Actor,
  customerIds: string[],
  now: Date = new Date(),
): Promise<Set<string>> {
  if (customerIds.length === 0) return new Set();
  const access = await resolveCustomerListAccess(tx, actor, "customers.view", now);
  const rows = await tx.customer.findMany({
    where: withinScope(access.where, { tenantId: actor.tenantId, id: { in: customerIds } }),
    select: { id: true },
  });
  return new Set(rows.map((row) => row.id));
}

/**
 * Duplicate flags the caller may be told about: only those whose other customer they may view. Detection is
 * tenant-wide, so EVERY response that carries `possibleDuplicates` must pass through this (a duplicate in
 * someone else's scope must not leak its id, flag id or matched fields).
 */
export async function revealableDuplicates(tx: TenantTx, actor: Actor, open: OpenDuplicate[]): Promise<OpenDuplicate[]> {
  const visible = await visibleCustomerIds(tx, actor, open.map((entry) => entry.customerId));
  return open.filter((entry) => visible.has(entry.customerId));
}

/** One guard for every write under a customer: archived customers are read-only until restored (404 if missing). */
export async function assertCustomerActive(tx: TenantTx, tenantId: string, customerId: string): Promise<void> {
  const row = await tx.customer.findFirst({ where: { id: customerId, tenantId }, select: { archivedAt: true } });
  if (!row) throw new NotFoundError();
  if (row.archivedAt) throw new InvalidStateTransitionError({ message: "An archived customer cannot be changed. Restore it first." });
}
