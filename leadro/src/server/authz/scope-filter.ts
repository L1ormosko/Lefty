import { withTenant, type TenantTx } from "@/server/db";
import { grantFieldSets } from "./conditions";
import { expandActiveOrgUnits } from "./org-tree";
import { loadGrants, loadSubjectState } from "./load-grants";
import { isPermissionKey } from "./permission-catalog";
import type { AccessSubject } from "./types";

/** The union of the data scopes the subject's ACTIVE grants of one permission cover. */
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
  /** Field sets revealed by the contributing grants (see `AccessDecision.fieldSets`). List routes
   *  project each row with `projectFields` using this. */
  fieldSets: string[];
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
  fieldSets: [],
};

/**
 * Computes which records `subject` may touch with `permission`, as of `now`.
 *
 * Ignored: expired / revoked / not-yet-effective assignments, inactive roles, archived org units
 * (and their subtrees), and everything for a user who is not active. Org units are expanded from
 * the CURRENT tree, so a reparented or archived unit changes the result immediately.
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

  const scopes = grants.flatMap((grant) => grant.scopes);
  const withDescendants = scopes.filter((s) => s.type === "ORG_UNIT" && s.orgUnitId && s.includeDescendants);
  const exactUnits = scopes.filter((s) => s.type === "ORG_UNIT" && s.orgUnitId && !s.includeDescendants);

  const orgUnitIds = new Set([
    ...(await expandActiveOrgUnits(tx, subject.tenantId, withDescendants.map((s) => s.orgUnitId as string), true)),
    ...(await expandActiveOrgUnits(tx, subject.tenantId, exactUnits.map((s) => s.orgUnitId as string), false)),
  ]);

  return {
    tenantWide: scopes.some((s) => s.type === "TENANT"),
    orgUnitIds: [...orgUnitIds],
    legalEntityIds: [...new Set(scopes.flatMap((s) => (s.type === "LEGAL_ENTITY" && s.legalEntityId ? [s.legalEntityId] : [])))],
    ownEmployeeId: scopes.some((s) => s.type === "OWN") ? state.employeeId : null,
    assignedEmployeeId: scopes.some((s) => s.type === "ASSIGNED") ? state.employeeId : null,
    fieldSets: [...new Set(grants.flatMap((grant) => (grant.conditions ? grantFieldSets(grant.conditions) : [])))],
  };
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
 * caller with no grant gets 403 rather than an empty page.
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
