/**
 * Which kind of org unit may sit under which (§3.2). Pure data + one predicate, no database, so it
 * can be unit-tested and swapped for a per-tenant configuration later.
 *
 * DEFAULT, CONFIGURABLE: the spec lists the unit types but not the nesting rules, so these are the
 * sensible US-company defaults (company -> state -> region -> city -> branch -> team). They are a
 * constant on purpose today; making them tenant-configurable means loading a map of this shape
 * from tenant settings and passing it to `isParentAllowed`. Recorded in docs/DECISIONS.md (Task 5).
 */
export type OrgUnitTypeName = "BUSINESS_UNIT" | "STATE" | "REGION" | "CITY" | "BRANCH" | "DEPARTMENT" | "TEAM";

export interface ParentRule {
  /** May a unit of this type sit at the top of the tree (no parent)? */
  allowRoot: boolean;
  /** Types of unit this type may be placed under. */
  allowedParents: readonly OrgUnitTypeName[];
}

export type HierarchyRules = Record<OrgUnitTypeName, ParentRule>;

export const DEFAULT_HIERARCHY_RULES: HierarchyRules = {
  BUSINESS_UNIT: { allowRoot: true, allowedParents: [] },
  STATE: { allowRoot: true, allowedParents: ["BUSINESS_UNIT"] },
  REGION: { allowRoot: true, allowedParents: ["BUSINESS_UNIT", "STATE"] },
  CITY: { allowRoot: false, allowedParents: ["STATE", "REGION"] },
  BRANCH: { allowRoot: false, allowedParents: ["CITY", "REGION"] },
  DEPARTMENT: { allowRoot: false, allowedParents: ["BUSINESS_UNIT", "STATE", "REGION", "CITY", "BRANCH"] },
  TEAM: { allowRoot: false, allowedParents: ["BRANCH", "CITY", "DEPARTMENT"] },
};

/**
 * May a unit of `type` be placed under a parent of type `parentType` (`null` = at the top)?
 * Returns a human-readable reason when it may not, `null` when it may.
 */
export function explainParentViolation(
  type: OrgUnitTypeName,
  parentType: OrgUnitTypeName | null,
  rules: HierarchyRules = DEFAULT_HIERARCHY_RULES,
): string | null {
  const rule = rules[type];
  if (parentType === null) {
    return rule.allowRoot ? null : `A ${type} cannot be at the top of the organization.`;
  }
  return rule.allowedParents.includes(parentType) ? null : `A ${type} cannot be placed under a ${parentType}.`;
}
