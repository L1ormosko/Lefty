type FormValues = Record<string, string | undefined>;

/** Scope types an invitation (and a role assignment) may carry, in the order the forms list them. */
export const GRANTABLE_SCOPE_TYPES = ["ORG_UNIT", "LEGAL_ENTITY", "TENANT", "OWN"] as const;
export type GrantableScopeType = (typeof GRANTABLE_SCOPE_TYPES)[number];

/**
 * The scope object of a form: `scopeType` plus the matching target (`scopeOrgUnitId` or
 * `scopeLegalEntityId`). Org-unit scopes include sub-units unless "this unit only" is ticked.
 * Returns undefined when no scope type was chosen. Targets that do not belong to the chosen type
 * are dropped, so a stale hidden choice cannot widen the grant.
 */
export function scopeFromForm(values: FormValues) {
  const type = values.scopeType;
  if (!type) return undefined;
  return {
    type,
    ...(type === "ORG_UNIT" ? { orgUnitId: values.scopeOrgUnitId, includeDescendants: values.scopeThisUnitOnly !== "on" } : {}),
    ...(type === "LEGAL_ENTITY" ? { legalEntityId: values.scopeLegalEntityId } : {}),
  };
}

/** Input of `inviteEmployeeSchema`: optional email override, and a role only together with its scope. */
export function inviteInputFromForm(values: FormValues) {
  return {
    email: values.email,
    roleId: values.roleId,
    scope: values.roleId ? scopeFromForm(values) : undefined,
  };
}
