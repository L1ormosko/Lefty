import { ForbiddenError } from "@/server/core";
import type { TenantTx } from "@/server/db";
import type { ScopeInput } from "./assign-role";
import { canInTx } from "./can";
import { fieldSetsCover } from "./conditions";
import { expandActiveOrgUnits } from "./org-tree";
import { resolveScope, type ScopePart } from "./scope-filter";
import type { AccessSubject, ResourceRef } from "./types";

/** A scope being handed out (or revoked), with the org units it expands to (for ORG_UNIT). */
export interface RequestedScope {
  scope: ScopeInput;
  neededUnits: string[];
}

/**
 * Can this ONE held scope (of one active grant) cover `requested`? TENANT parts cover
 * everything; an org-unit part needs the unit and (with descendants) its whole active subtree;
 * legal-entity scopes need that entity; OWN/ASSIGNED only expose the target's own data, so any
 * part is enough.
 */
function partCovers(part: ScopePart, requested: RequestedScope): boolean {
  if (part.type === "TENANT") return true;
  switch (requested.scope.type) {
    case "TENANT":
      return false;
    case "LEGAL_ENTITY":
      return part.type === "LEGAL_ENTITY" && part.legalEntityIds.includes(requested.scope.legalEntityId ?? "");
    case "ORG_UNIT":
      // An archived (empty) unit is not coverable: fail closed.
      return (
        part.type === "ORG_UNIT" &&
        requested.neededUnits.length > 0 &&
        requested.neededUnits.every((id) => part.orgUnitIds.includes(id))
      );
    case "OWN":
    case "ASSIGNED":
      return true;
  }
}

/**
 * For every requested scope there must be a single held part that covers the scope AND whose own
 * grant reveals the required field sets. Checking scopes and field sets separately would let a
 * financial grant on City A combine with a plain grant on the tenant to hand out financial fields
 * tenant-wide.
 */
export function heldCoversRequest(parts: ScopePart[], requested: RequestedScope[], requiredFieldSets: string[]): boolean {
  return requested.every((request) =>
    parts.some((part) => partCovers(part, request) && fieldSetsCover(part.fieldSets, requiredFieldSets)),
  );
}

export async function expandRequestedScopes(tx: TenantTx, tenantId: string, scopes: ScopeInput[]): Promise<RequestedScope[]> {
  const requested: RequestedScope[] = [];
  for (const scope of scopes) {
    const neededUnits = scope.orgUnitId
      ? await expandActiveOrgUnits(tx, tenantId, [scope.orgUnitId], scope.includeDescendants ?? true)
      : [];
    requested.push({ scope, neededUnits });
  }
  return requested;
}

/**
 * The "may this actor administer access for this target over these scopes" half shared by granting
 * and revoking: the actor needs `permissions.assign` on the TARGET (their employee placement, or
 * tenant-level for users without an employee) and over scopes covering `scopes`. A grant qualified
 * `non_sensitive_roles` (COO) only counts when the role is not sensitive.
 *
 * @returns the expanded scopes, so the caller can reuse them (grants check role permissions too).
 * @throws ForbiddenError
 */
export async function assertMayAdminister(
  tx: TenantTx,
  actor: AccessSubject,
  target: { employeeId: string | null },
  isSensitiveRole: boolean,
  scopes: ScopeInput[],
  now: Date,
): Promise<RequestedScope[]> {
  const assignSets = isSensitiveRole ? [] : ["non_sensitive_roles"];

  const targetRef: ResourceRef = { ...(target.employeeId ? { employeeId: target.employeeId } : {}), sets: assignSets };
  if (!(await canInTx(tx, actor, "permissions.assign", targetRef, now)).allowed) throw new ForbiddenError();

  const requested = await expandRequestedScopes(tx, actor.tenantId, scopes);
  const mayAssign = await resolveScope(tx, actor, "permissions.assign", now, { satisfiedSets: assignSets });
  if (!heldCoversRequest(mayAssign.parts, requested, [])) throw new ForbiddenError();
  return requested;
}
