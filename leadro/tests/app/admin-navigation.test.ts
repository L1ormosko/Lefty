import { describe, expect, it } from "vitest";
import { withTenant } from "@/server/db";
import { NAVIGATION_ITEMS, canSeeAdminModule, getNavigation } from "@/app/(app)/navigation";
import { buildWorld, createPerson, grantTemplate } from "../authz/fixtures";

const ids = (items: Array<{ id: string }>) => items.map((item) => item.id);

describe("administration navigation is scope-aware", () => {
  it("hides every administration item from a Technician (own-record and assigned scopes only)", async () => {
    const world = await buildWorld("admin-nav-tech");
    expect(ids(await getNavigation(world.techA1.actor))).toEqual(["overview"]);
    expect(await canSeeAdminModule(world.techA1.actor, "employees", "employees.edit")).toBe(false);
    expect(await canSeeAdminModule(world.techA1.actor, "localization", "localization.configure")).toBe(false);
  });

  it("shows a Team Leader the organization and employee screens but not users, roles or company", async () => {
    const world = await buildWorld("admin-nav-lead");
    const lead = await createPerson(world.tenantId, "team-lead", { orgUnitId: world.units.teamA1, legalEntityId: world.legalEntityId });
    await grantTemplate(world.tenantId, lead, world.roles.TEAM_LEADER, [{ type: "ORG_UNIT", orgUnitId: world.units.teamA1 }]);

    const shown = ids(await getNavigation(lead.actor));
    expect(shown).toContain("organization");
    expect(shown).toContain("employees");
    expect(shown).not.toContain("users");
    expect(shown).not.toContain("roles");
    expect(shown).not.toContain("company");
  });

  it("shows the CEO every available administration screen", async () => {
    const world = await buildWorld("admin-nav-ceo");
    const shown = ids(await getNavigation(world.ceo.actor));
    const available = NAVIGATION_ITEMS.filter((item) => item.isAvailable).map((item) => item.id);
    expect(shown).toEqual(available);
  });

  it("re-reads the database: a revoked assignment removes the item on the next call", async () => {
    const world = await buildWorld("admin-nav-revoke");
    expect(await canSeeAdminModule(world.cityManagerA.actor, "employees", "employees.edit")).toBe(true);
    await withTenant(world.tenantId, (tx) =>
      tx.user.update({ where: { id: world.cityManagerA.userId }, data: { status: "DEACTIVATED" } }),
    );
    expect(await canSeeAdminModule(world.cityManagerA.actor, "employees", "employees.edit")).toBe(false);
  });
});
