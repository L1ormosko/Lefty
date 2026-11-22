import { describe, expect, it } from "vitest";
import { narrowScopeToFieldSet, type ResolvedScope, type ScopePart } from "@/server/authz";

const part = (overrides: Partial<ScopePart>): ScopePart => ({ type: "ORG_UNIT", orgUnitIds: [], legalEntityIds: [], employeeId: null, fieldSets: ["base"], ...overrides });

function scopeOf(parts: ScopePart[]): ResolvedScope {
  return {
    tenantWide: parts.some((p) => p.type === "TENANT"),
    orgUnitIds: parts.flatMap((p) => p.orgUnitIds),
    legalEntityIds: parts.flatMap((p) => p.legalEntityIds),
    ownEmployeeId: parts.find((p) => p.type === "OWN")?.employeeId ?? null,
    assignedEmployeeId: null,
    parts,
  };
}

describe("narrowScopeToFieldSet", () => {
  it("drops parts of grants that do not cover the field set and rebuilds the totals from the rest", () => {
    const scope = scopeOf([
      part({ orgUnitIds: ["a", "b"] }),
      part({ orgUnitIds: ["c"], fieldSets: ["availability"] }),
      part({ type: "TENANT", fieldSets: ["financial"] }),
      part({ type: "OWN", employeeId: "me", fieldSets: ["base", "financial"] }),
    ]);
    const narrowed = narrowScopeToFieldSet(scope, "base");
    expect(narrowed.tenantWide).toBe(false); // the TENANT grant only reveals financial fields
    expect(narrowed.orgUnitIds).toEqual(["a", "b"]);
    expect(narrowed.ownEmployeeId).toBe("me");
    expect(narrowed.parts).toHaveLength(2);
  });

  it("is empty when no grant covers the field set", () => {
    const narrowed = narrowScopeToFieldSet(scopeOf([part({ type: "TENANT", fieldSets: ["availability"] })]), "base");
    expect(narrowed.parts).toEqual([]);
    expect(narrowed.tenantWide).toBe(false);
  });
});
