import type { ScopeType } from "@prisma/client";
import { withTenant, type TenantTx } from "@/server/db";
import { grantFieldSets, type GrantConditions } from "./conditions";
import { expandActiveOrgUnits } from "./org-tree";
import { loadGrants, loadSubjectState } from "./load-grants";
import { isPermissionKey } from "./permission-catalog";
import { projectFields, type FieldMap } from "./project-fields";
import type { AccessSubject } from "./types";

/**
 * ONE scope of ONE active grant, with the field sets that same grant reveals. Field sets are
 * deliberately kept per part: unioning them across parts would let a field-limited grant on one
 * unit ("financial" on City A) leak into rows that only a plain grant on another unit covers.
 */
export interface ScopePart {
  type: ScopeType;
  /** ORG_UNIT: the expanded active units (descendants included when the scope says so). */
  orgUnitIds: string[];
  /** LEGAL_ENTITY: the entity. */
  legalEntityIds: string[];
  /** OWN / ASSIGNED: the subject's employee id. */
  employeeId: string | null;
  fieldSets: string[];
}

/** The data scopes the subject's ACTIVE grants of one permission cover. */
export interface ResolvedScope {
  /** A TENANT scope: every record of the tenant (row-level security still applies). */
  tenantWide: boolean;
  /** Org units covered, descendants already expanded; archived units excluded. */
  orgUnitIds: string[];
  legalEntityIds: string[];
  /** Set when an OWN scope applies: the subject's employee id (read from the DB). */
  ownEmployeeId: string | null;
  /** Set when an ASSIGNED scope applies: records assigned to this employee. */
  assignedEmployeeId: string | null;
  /**
   * Every contributing scope with ITS field sets. Never union `fieldSets` across parts to project
   * rows: use `fieldSetsForRow` / `projectRows`, which only count parts the row actually matches.
   */
  parts: ScopePart[];
}

export interface ScopeOptions {
  /**
   * Record sets (`conditions.set`) the caller already restricts its query to. A grant qualified by
   * a set only contributes when its set is listed here; otherwise it is ignored, because a plain
   * where-fragment cannot express "only job-related customers" (fail closed).
   */
  satisfiedSets?: string[];
}

export const EMPTY_SCOPE: ResolvedScope = {
  tenantWide: false,
  orgUnitIds: [],
  legalEntityIds: [],
  ownEmployeeId: null,
  assignedEmployeeId: null,
  parts: [],
};

/**
 * Computes which records `subject` may touch with `permission`, as of `now`.
 *
 * Ignored: expired / revoked / not-yet-effective assignments, inactive roles, archived org units
 * (and their subtrees, together with the field sets of the grant that scoped them), and everything
 * for a user who is not active. Org units are expanded from the CURRENT tree, so a reparented or
 * archived unit changes the result immediately.
 */
export async function resolveScope(
  tx: TenantTx,
  subject: AccessSubject,
  permission: string,
  now: Date = new Date(),
  options: ScopeOptions = {},
): Promise<ResolvedScope> {
  if (!isPermissionKey(permission)) return EMPTY_SCOPE;
  const state = await loadSubjectState(tx, subject);
  if (!state.isActive) return EMPTY_SCOPE;

  const grants = (await loadGrants(tx, subject, permission, now)).filter(
    (grant) =>
      grant.status === "ACTIVE" &&
      grant.conditions !== null &&
      (grant.conditions.set === undefined || (options.satisfiedSets ?? []).includes(grant.conditions.set)),
  );

  const parts: ScopePart[] = [];
  for (const grant of grants) {
    const fieldSets = grantFieldSets(grant.conditions as GrantConditions);
    for (const scope of grant.scopes) {
      const base: ScopePart = { type: scope.type, orgUnitIds: [], legalEntityIds: [], employeeId: null, fieldSets };
      if (scope.type === "TENANT") {
        parts.push(base);
      } else if (scope.type === "LEGAL_ENTITY" && scope.legalEntityId) {
        parts.push({ ...base, legalEntityIds: [scope.legalEntityId] });
      } else if (scope.type === "ORG_UNIT" && scope.orgUnitId) {
        const units = await expandActiveOrgUnits(tx, subject.tenantId, [scope.orgUnitId], scope.includeDescendants);
        // An archived unit expands to nothing: that scope (and its field sets) contributes nothing.
        if (units.length > 0) parts.push({ ...base, orgUnitIds: units });
      } else if ((scope.type === "OWN" || scope.type === "ASSIGNED") && state.employeeId) {
        parts.push({ ...base, employeeId: state.employeeId });
      }
    }
  }

  const ofType = (type: ScopeType) => parts.filter((part) => part.type === type);
  return {
    tenantWide: ofType("TENANT").length > 0,
    orgUnitIds: [...new Set(ofType("ORG_UNIT").flatMap((part) => part.orgUnitIds))],
    legalEntityIds: [...new Set(ofType("LEGAL_ENTITY").flatMap((part) => part.legalEntityIds))],
    ownEmployeeId: ofType("OWN")[0]?.employeeId ?? null,
    assignedEmployeeId: ofType("ASSIGNED")[0]?.employeeId ?? null,
    parts,
  };
}

/** What the caller knows about one fetched row, to decide which scope parts cover it. */
export interface RowScopeAttributes {
  orgUnitIds?: string[];
  legalEntityIds?: string[];
  ownerEmployeeId?: string | null;
  assignedEmployeeIds?: string[];
}

/**
 * Field sets the subject may see on ONE row: the union over the scope parts that row matches
 * (empty when none does). This is the only correct way to derive per-row fields for a list; the
 * where-fragment decides which rows come back, this decides which of their fields.
 */
export function fieldSetsForRow(scope: ResolvedScope, row: RowScopeAttributes): string[] {
  const matched = scope.parts.filter((part) => {
    switch (part.type) {
      case "TENANT":
        return true;
      case "ORG_UNIT":
        return (row.orgUnitIds ?? []).some((id) => part.orgUnitIds.includes(id));
      case "LEGAL_ENTITY":
        return (row.legalEntityIds ?? []).some((id) => part.legalEntityIds.includes(id));
      case "OWN":
        return part.employeeId !== null && row.ownerEmployeeId === part.employeeId;
      case "ASSIGNED":
        return part.employeeId !== null && (row.assignedEmployeeIds ?? []).includes(part.employeeId);
    }
  });
  return [...new Set(matched.flatMap((part) => part.fieldSets))];
}

/**
 * Projects each fetched row to the fields its own scope parts allow (`fieldSetsForRow` +
 * `projectFields`). `attributesOf` extracts the row's org/owner attributes (e.g.
 * `employeeRowAttributes`). Rows no part matches come back empty.
 */
export function projectRows<T extends Record<string, unknown>>(
  rows: T[],
  scope: ResolvedScope,
  fieldMap: FieldMap,
  attributesOf: (row: T) => RowScopeAttributes,
): Array<Partial<T>> {
  return rows.map((row) =>
    projectFields(row, { allowed: true, fieldSets: fieldSetsForRow(scope, attributesOf(row)) }, fieldMap),
  );
}

/**
 * How each scope type is expressed as a where-fragment on one model. A scope type without a
 * mapping contributes nothing (the model has no such notion), which only ever narrows the result.
 */
export interface ScopeColumns<W extends object> {
  orgUnit?: (orgUnitIds: string[], now: Date) => W;
  legalEntity?: (legalEntityIds: string[], now: Date) => W;
  own?: (employeeId: string, now: Date) => W;
  assigned?: (employeeId: string, now: Date) => W;
}

/**
 * Builds the where-fragment for a resolved scope: `{}` for tenant-wide access, otherwise
 * `{ AND: [{ OR: parts }] }`. No coverage yields `{ AND: [{ id: { in: [] } }] }`, which matches no rows
 * (fail closed). The OR is nested in an AND on purpose: a caller that spreads the fragment next to
 * its own `OR` key would silently overwrite a top-level OR and widen access to the whole tenant.
 * Combine with caller filters through `withinScope`, never by spreading.
 */
export function buildScopeWhere<W extends object>(scope: ResolvedScope, columns: ScopeColumns<W>, now: Date): W {
  if (scope.tenantWide) return {} as W;
  const parts: W[] = [];
  if (scope.orgUnitIds.length > 0 && columns.orgUnit) parts.push(columns.orgUnit(scope.orgUnitIds, now));
  if (scope.legalEntityIds.length > 0 && columns.legalEntity) parts.push(columns.legalEntity(scope.legalEntityIds, now));
  if (scope.ownEmployeeId && columns.own) parts.push(columns.own(scope.ownEmployeeId, now));
  if (scope.assignedEmployeeId && columns.assigned) parts.push(columns.assigned(scope.assignedEmployeeId, now));
  // `AND`/`OR`/`id` are where-clause keys on every Prisma model, so these are valid fragments of W.
  // No parts: `OR: []` nested in an AND matches EVERYTHING in Prisma, so deny with an explicit
  // empty `id IN ()` instead (fail closed).
  if (parts.length === 0) return { AND: [{ id: { in: [] } }] } as unknown as W;
  return { AND: [{ OR: parts }] } as unknown as W;
}

/** Combines a scope fragment with the caller's own filter so that neither can overwrite the other. */
export function withinScope<W extends object>(scopeWhere: W, callerWhere: W): W {
  return { AND: [scopeWhere, callerWhere] } as unknown as W;
}

/**
 * Prisma where-fragment limiting a list query to the records `subject` may access with
 * `permission` (descendant expansion of the org tree plus OWN / ASSIGNED scopes). Re-reads the
 * database on every call. Pair it with `can(subject, permission)` (or `requirePermission`) so a
 * caller with no grant gets 403 rather than an empty page. The fragment only selects rows; derive
 * each row's visible fields with `resolveScope` + `projectRows`.
 */
export async function scopeFilter<W extends object>(
  subject: AccessSubject,
  permission: string,
  columns: ScopeColumns<W>,
  options: ScopeOptions = {},
): Promise<W> {
  return withTenant(subject.tenantId, (tx) => scopeFilterInTx(tx, subject, permission, columns, options));
}

/** Same as `scopeFilter`, inside a transaction the caller already opened with `withTenant`. */
export async function scopeFilterInTx<W extends object>(
  tx: TenantTx,
  subject: AccessSubject,
  permission: string,
  columns: ScopeColumns<W>,
  options: ScopeOptions = {},
): Promise<W> {
  const now = new Date();
  return buildScopeWhere(await resolveScope(tx, subject, permission, now, options), columns, now);
}
