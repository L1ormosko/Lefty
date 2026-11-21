import { describe, expect, it } from "vitest";
import { assignEmployeeToUnit, listPlacementHistory } from "@/server/employees";
import { createOrgUnit, listUnitChanges, moveOrgUnit } from "@/server/organization";
import { buildWorld } from "../authz/fixtures";
import { contextFor } from "./org-helpers";

describe("listUnitChanges", () => {
  it("lists structural changes with previous and new parent, who did it and why", async () => {
    const world = await buildWorld("hist-units");
    const ctx = contextFor(world.ceo.actor);
    await moveOrgUnit(world.ceo.actor, ctx, world.units.teamA1, { newParentId: world.units.cityB, reason: "Reorg" });

    const page = await listUnitChanges(world.ceo.actor, { limit: 20, orgUnitId: world.units.teamA1 });
    expect(page.data).toHaveLength(1);
    expect(page.data[0]).toMatchObject({
      action: "org_unit.move",
      orgUnitName: "Team A1",
      previousParentName: "City A",
      newParentName: "City B",
      reason: "Reorg",
    });
    expect(page.data[0].recordedBy).toBeTruthy();
  });

  it("only shows units inside the caller's scope and answers 404 for a unit outside it", async () => {
    const world = await buildWorld("hist-scope");
    await createOrgUnit(world.ceo.actor, contextFor(world.ceo.actor), { type: "TEAM", name: "Team B1", parentId: world.units.cityB });
    await createOrgUnit(world.ceo.actor, contextFor(world.ceo.actor), { type: "TEAM", name: "Team A2", parentId: world.units.cityA });

    const page = await listUnitChanges(world.cityManagerA.actor, { limit: 50 });
    const names = page.data.map((entry) => entry.orgUnitName);
    expect(names).toContain("Team A2");
    expect(names).not.toContain("Team B1");
    await expect(listUnitChanges(world.cityManagerA.actor, { limit: 5, orgUnitId: world.units.cityB })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses a caller without organization.view", async () => {
    const world = await buildWorld("hist-deny");
    await expect(listUnitChanges(world.finance.actor, { limit: 5 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("listPlacementHistory", () => {
  it("shows a transfer with its previous unit and recorder, scoped to the caller's units", async () => {
    const world = await buildWorld("hist-placements");
    const ctx = contextFor(world.ceo.actor);
    await assignEmployeeToUnit(world.ceo.actor, ctx, world.techB.employeeId ?? "", { orgUnitId: world.units.cityA, kind: "PRIMARY" });

    const all = await listPlacementHistory(world.ceo.actor, { limit: 50 });
    const transfer = all.data.find((entry) => entry.employeeId === world.techB.employeeId && entry.orgUnitId === world.units.cityA);
    expect(transfer).toMatchObject({ kind: "PRIMARY", previousOrgUnitId: world.units.cityB });
    expect(transfer?.recordedBy).toBeTruthy();

    // City Manager A sees people placed in City A (including the transferred one), never City B-only people.
    const scoped = await listPlacementHistory(world.cityManagerA.actor, { limit: 50 });
    expect(scoped.data.some((entry) => entry.employeeId === world.techB.employeeId)).toBe(true);
    expect(scoped.data.some((entry) => entry.employeeId === world.cityManagerB.employeeId)).toBe(false);
  });

  it("hides placement history from a field-limited grant (Dispatcher sees availability only)", async () => {
    const world = await buildWorld("hist-placements-fields");
    await expect(listPlacementHistory(world.dispatcher.actor, { limit: 50 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses a caller without employees.view", async () => {
    const world = await buildWorld("hist-placements-deny");
    await expect(listPlacementHistory({ ...world.ceo.actor, userId: "nobody" }, { limit: 5 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
