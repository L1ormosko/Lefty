import { beforeEach, describe, expect, it, vi } from "vitest";
import { withTenant } from "@/server/db";
import { CATALOGS } from "@/lib/i18n";
import { buildWorld } from "../authz/fixtures";
import { resetFakeRequest } from "./next-fakes";
import { form, signInPerson } from "./admin-test-helpers";

vi.mock("next/headers", async () => (await import("./next-fakes")).headersModule);
vi.mock("next/navigation", async () => (await import("./next-fakes")).navigationModule);
vi.mock("next/cache", async () => (await import("./next-fakes")).cacheModule);

import {
  archiveUnitAction,
  assignEmployeeAction,
  assignManagerAction,
  createUnitAction,
  moveUnitAction,
  unassignManagerAction,
  updateUnitAction,
} from "@/app/(app)/admin/organization/actions";
import OrganizationPage from "@/app/(app)/admin/organization/page";
import { AccessDenied } from "@/app/(app)/admin/_components/AdminPage";

beforeEach(resetFakeRequest);

const en = (key: string) => CATALOGS["en-US"].messages[key];
const parentOf = (tenantId: string, unitId: string) =>
  withTenant(tenantId, async (tx) => (await tx.orgUnit.findUniqueOrThrow({ where: { id: unitId } })).parentId);

describe("organization actions", () => {
  it("shows a translated validation error for a move that would create a cycle, and changes nothing", async () => {
    const world = await buildWorld("admin-org-cycle");
    await signInPerson(world.ceo, world.tenantId);
    const result = await moveUnitAction({}, form({ unitId: world.units.cityA, newParentId: world.units.teamA1 }));
    expect(result.error).toBe(en("ADMIN.ERROR_FIELD_NEW_PARENT"));
    expect(await parentOf(world.tenantId, world.units.cityA)).toBe(world.units.state);
  });

  it("moves a unit to a new parent for an authorised caller", async () => {
    const world = await buildWorld("admin-org-move");
    await signInPerson(world.ceo, world.tenantId);
    const result = await moveUnitAction({}, form({ unitId: world.units.teamA1, newParentId: world.units.cityB }));
    expect(result.success).toBe(en("ADMIN.ORG_UNIT_MOVED"));
    expect(await parentOf(world.tenantId, world.units.teamA1)).toBe(world.units.cityB);
  });

  it("refuses a City Manager who tries to move a unit out of their own city (destination outside scope)", async () => {
    const world = await buildWorld("admin-org-scope");
    await signInPerson(world.cityManagerA, world.tenantId);
    const result = await moveUnitAction({}, form({ unitId: world.units.teamA1, newParentId: world.units.cityB }));
    expect(result.error).toBe(en("ERROR.NOT_FOUND"));
    expect(await parentOf(world.tenantId, world.units.teamA1)).toBe(world.units.cityA);
  });

  it("refuses a Technician every organization action on the server", async () => {
    const world = await buildWorld("admin-org-tech");
    await signInPerson(world.techA1, world.tenantId);
    const results = await Promise.all([
      createUnitAction({}, form({ type: "TEAM", name: "Sneaky", parentId: world.units.cityA })),
      updateUnitAction({}, form({ unitId: world.units.cityA, name: "Hacked" })),
      archiveUnitAction({}, form({ unitId: world.units.teamA1 })),
      assignManagerAction({}, form({ unitId: world.units.cityA, employeeId: world.techA1.employeeId ?? "" })),
    ]);
    for (const result of results) expect(result.error).toBe(en("ERROR.FORBIDDEN"));
    const name = await withTenant(world.tenantId, async (tx) => (await tx.orgUnit.findUniqueOrThrow({ where: { id: world.units.cityA } })).name);
    expect(name).toBe("City A");
  });

  it("adds a unit, renames it and rejects a duplicate sibling name with the name message", async () => {
    const world = await buildWorld("admin-org-create");
    await signInPerson(world.ceo, world.tenantId);
    expect((await createUnitAction({}, form({ type: "TEAM", name: "Team A2", parentId: world.units.cityA }))).success).toBe(en("ADMIN.ORG_UNIT_ADDED"));
    const duplicate = await createUnitAction({}, form({ type: "TEAM", name: "team a2", parentId: world.units.cityA }));
    expect(duplicate.error).toBe(en("ADMIN.ERROR_FIELD_NAME"));
    expect((await updateUnitAction({}, form({ unitId: world.units.cityB, name: "City Bee" }))).success).toBe(en("ADMIN.SAVED"));
  });

  it("assigns and ends a manager, and places an employee (transfer) through the services", async () => {
    const world = await buildWorld("admin-org-people");
    await signInPerson(world.ceo, world.tenantId);
    const employeeId = world.techB.employeeId ?? "";

    expect((await assignManagerAction({}, form({ unitId: world.units.cityB, employeeId, isPrimary: "on" }))).success).toBe(en("ADMIN.ORG_MANAGER_ASSIGNED"));
    const manager = await withTenant(world.tenantId, (tx) => tx.orgUnitManager.findFirstOrThrow({ where: { orgUnitId: world.units.cityB, employeeId } }));
    expect(manager.isPrimary).toBe(true);
    expect((await unassignManagerAction({}, form({ unitId: world.units.cityB, managerId: manager.id }))).success).toBe(en("ADMIN.ORG_MANAGER_ENDED"));

    expect((await assignEmployeeAction({}, form({ employeeId, orgUnitId: world.units.cityA, kind: "PRIMARY" }))).success).toBe(en("ADMIN.ORG_EMPLOYEE_ASSIGNED"));
  });

  it("reports a state error when archiving a unit that still has people placed in it", async () => {
    const world = await buildWorld("admin-org-archive");
    await signInPerson(world.ceo, world.tenantId);
    const result = await archiveUnitAction({}, form({ unitId: world.units.teamA1 }));
    expect(result.error).toBe(en("ERROR.INVALID_STATE_TRANSITION")); // technicians are placed in Team A1
  });
});

describe("organization page", () => {
  it("renders the tree for a City Manager scoped to one city and denies a Technician", async () => {
    const world = await buildWorld("admin-org-page");
    await signInPerson(world.cityManagerA, world.tenantId);
    expect(await OrganizationPage({ searchParams: Promise.resolve({ unit: world.units.cityA }) })).toBeTruthy();

    await signInPerson(world.techA1, world.tenantId);
    const denied = (await OrganizationPage({ searchParams: Promise.resolve({}) })) as { type: unknown };
    expect(denied.type).toBe(AccessDenied);
  });
});
