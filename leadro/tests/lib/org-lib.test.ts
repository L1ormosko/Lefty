import { describe, expect, it } from "vitest";
import { changedFields } from "@/lib/changed-fields";
import { DEFAULT_HIERARCHY_RULES, explainParentViolation, type OrgUnitTypeName } from "@/lib/org-hierarchy";
import { pageArgs, pageQuerySchema, toPage, ValidationError } from "@/server/core";

describe("org hierarchy rules", () => {
  it("allows the documented nesting and rejects the rest", () => {
    expect(explainParentViolation("STATE", null)).toBeNull();
    expect(explainParentViolation("CITY", "STATE")).toBeNull();
    expect(explainParentViolation("CITY", "REGION")).toBeNull();
    expect(explainParentViolation("BRANCH", "CITY")).toBeNull();
    expect(explainParentViolation("TEAM", "BRANCH")).toBeNull();
    expect(explainParentViolation("TEAM", "STATE")).toMatch(/TEAM cannot be placed under a STATE/);
    expect(explainParentViolation("CITY", null)).toMatch(/top/);
    expect(explainParentViolation("STATE", "CITY")).toBeTruthy();
  });

  it("is acyclic by type, so no sequence of allowed moves can build a cycle of types", () => {
    const types = Object.keys(DEFAULT_HIERARCHY_RULES) as OrgUnitTypeName[];
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (type: OrgUnitTypeName): void => {
      expect(visiting.has(type)).toBe(false); // would be a cycle
      if (done.has(type)) return;
      visiting.add(type);
      DEFAULT_HIERARCHY_RULES[type].allowedParents.forEach(visit);
      visiting.delete(type);
      done.add(type);
    };
    types.forEach(visit);
  });

  it("accepts a custom rule set (the configurable part)", () => {
    const rules = { ...DEFAULT_HIERARCHY_RULES, TEAM: { allowRoot: true, allowedParents: [] } };
    expect(explainParentViolation("TEAM", null, rules)).toBeNull();
    expect(explainParentViolation("TEAM", "BRANCH", rules)).toBeTruthy();
  });
});

describe("changedFields", () => {
  it("reports only fields that really differ, comparing JSON and dates by value", () => {
    const before = { name: "A", code: null, address: { city: "Dallas" }, hired: new Date("2026-01-01T00:00:00Z") };
    const result = changedFields(before, { name: "B", code: null, address: { city: "Dallas" }, hired: new Date("2026-01-01T00:00:00Z") });
    expect(result.changedKeys).toEqual(["name"]);
    expect(result.previous).toEqual({ name: "A" });
    expect(result.next).toEqual({ name: "B" });
  });

  it("treats undefined as 'not in the patch' and null as 'clear it'", () => {
    const result = changedFields({ code: "X1", name: "N" }, { code: null, name: undefined });
    expect(result.changedKeys).toEqual(["code"]);
    expect(result.next).toEqual({ code: null });
    expect(changedFields({ code: null }, { code: null }).changedKeys).toEqual([]);
  });
});

describe("pagination helpers", () => {
  it("defaults and bounds the page size", () => {
    expect(pageQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(pageQuerySchema.parse({ limit: "200" }).limit).toBe(200);
    expect(pageQuerySchema.safeParse({ limit: "201" }).success).toBe(false);
    expect(pageQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
  });

  it("fetches one extra row to know whether another page exists, and round-trips the cursor", () => {
    const rows = [{ id: "a1" }, { id: "b2" }, { id: "c3" }];
    expect(pageArgs({ limit: 2 })).toEqual({ take: 3 });
    const page = toPage(rows, 2);
    expect(page.data.map((row) => row.id)).toEqual(["a1", "b2"]);
    expect(page.page.limit).toBe(2);
    const next = pageArgs({ limit: 2, cursor: page.page.nextCursor! });
    expect(next).toEqual({ take: 3, cursor: { id: "b2" }, skip: 1 });
    expect(toPage(rows.slice(0, 2), 2).page.nextCursor).toBeNull();
  });

  it("rejects cursors that are not an id (control characters, spaces, oversized)", () => {
    for (const bad of ["AAAA", Buffer.from("has space").toString("base64url"), Buffer.from("x".repeat(80)).toString("base64url")]) {
      expect(() => pageArgs({ limit: 5, cursor: bad })).toThrow(ValidationError);
    }
  });
});
