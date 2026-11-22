import { beforeEach, describe, expect, it, vi } from "vitest";
import { CATALOGS } from "@/lib/i18n";
import { withTenant } from "@/server/db";
import { buildWorld } from "../authz/fixtures";
import { NotFoundSignal, resetFakeRequest } from "./next-fakes";
import { form, htmlOf, signInPerson } from "./admin-test-helpers";

vi.mock("next/headers", async () => (await import("./next-fakes")).headersModule);
vi.mock("next/navigation", async () => (await import("./next-fakes")).navigationModule);
vi.mock("next/cache", async () => (await import("./next-fakes")).cacheModule);

import {
  createEmployeeAction,
  endAssignmentAction,
  inviteEmployeeAction,
  terminateEmployeeAction,
  updateEmployeeAction,
} from "@/app/(app)/admin/employees/actions";
import EmployeesPage from "@/app/(app)/admin/employees/page";
import EmployeeProfilePage from "@/app/(app)/admin/employees/[id]/page";
import { assignEmployeeAction } from "@/app/(app)/admin/organization/actions";

beforeEach(resetFakeRequest);
const en = (key: string) => CATALOGS["en-US"].messages[key];
const noParams = { searchParams: Promise.resolve({}) };

describe("employee directory scoping", () => {
  it("shows a City Manager only the people of their own city and the CEO everyone", async () => {
    const world = await buildWorld("admin-emp-scope");
    await signInPerson(world.cityManagerA, world.tenantId);
    const cityA = await htmlOf(EmployeesPage(noParams));
    expect(cityA).toContain("tech-a1 Test"); // techA1 sits in Team A1 below City A
    expect(cityA).not.toContain("tech-b Test");

    await signInPerson(world.ceo, world.tenantId);
    // The CEO has no employee record, but sees all of them.
    const all = await htmlOf(EmployeesPage(noParams));
    expect(all).toContain("tech-b Test");
    expect(all).toContain("tech-a1 Test");
  });

  it("filters by search text through the service", async () => {
    const world = await buildWorld("admin-emp-search");
    await signInPerson(world.ceo, world.tenantId);
    const html = await htmlOf(EmployeesPage({ searchParams: Promise.resolve({ search: "tech-b" }) }));
    expect(html).toContain("tech-b Test");
    expect(html).not.toContain("tech-a1 Test");
  });

  it("marks fields a field-limited grant cannot see as hidden (Dispatcher: availability only)", async () => {
    const world = await buildWorld("admin-emp-fields");
    await signInPerson(world.dispatcher, world.tenantId);
    const html = await htmlOf(EmployeesPage(noParams));
    expect(html).toContain(en("ADMIN.HIDDEN_FIELD"));
    expect(html).not.toContain("tech-a1 Test");
  });
});

describe("employee profile", () => {
  it("renders every base field for HR and only what is allowed for a Dispatcher", async () => {
    const world = await buildWorld("admin-emp-profile");
    const id = world.techA1.employeeId ?? "";
    await signInPerson(world.hr, world.tenantId);
    const hr = await htmlOf(EmployeeProfilePage({ params: Promise.resolve({ id }), ...noParams }));
    expect(hr).toContain("tech-a1 Test");
    expect(hr).not.toContain(en("ADMIN.EMPLOYEE_FIELDS_HIDDEN_NOTE"));

    await signInPerson(world.dispatcher, world.tenantId);
    const dispatcher = await htmlOf(EmployeeProfilePage({ params: Promise.resolve({ id }), ...noParams }));
    expect(dispatcher).not.toContain("tech-a1 Test");
    expect(dispatcher).toContain(en("ADMIN.EMPLOYEE_FIELDS_HIDDEN_NOTE"));
    // A field-limited grant gets no edit button either.
    expect(dispatcher).not.toContain(en("ADMIN.EMPLOYEE_EDIT"));
  });

  it("is a 404 for an employee outside the caller's scope", async () => {
    const world = await buildWorld("admin-emp-404");
    await signInPerson(world.cityManagerA, world.tenantId);
    await expect(EmployeeProfilePage({ params: Promise.resolve({ id: world.techB.employeeId ?? "" }), ...noParams })).rejects.toBeInstanceOf(NotFoundSignal);
  });
});

describe("employee actions", () => {
  it("creates an employee placed in the City Manager's own city but not elsewhere", async () => {
    const world = await buildWorld("admin-emp-create");
    await signInPerson(world.cityManagerA, world.tenantId);
    const ok = await createEmployeeAction({}, form({ firstName: "New", lastName: "Hire", orgUnitId: world.units.cityA, employeeNumber: "E-1" }));
    expect(ok.success).toBe(en("ADMIN.EMPLOYEE_ADDED"));
    const elsewhere = await createEmployeeAction({}, form({ firstName: "Out", lastName: "Side", orgUnitId: world.units.cityB }));
    expect(elsewhere.error).toBe(en("ERROR.NOT_FOUND"));
    const duplicate = await createEmployeeAction({}, form({ firstName: "Dup", lastName: "Number", orgUnitId: world.units.cityA, employeeNumber: "E-1" }));
    expect(duplicate.error).toBe(en("ADMIN.ERROR_FIELD_EMPLOYEE_NUMBER"));
  });

  it("edits an employee and clears a blank optional field", async () => {
    const world = await buildWorld("admin-emp-edit");
    const employeeId = world.techA1.employeeId ?? "";
    await signInPerson(world.hr, world.tenantId);
    const result = await updateEmployeeAction({}, form({ employeeId, firstName: "Renamed", lastName: "Test", jobTitle: "Lead Tech", status: "ON_LEAVE" }));
    expect(result.success).toBe(en("ADMIN.SAVED"));
    const row = await withTenant(world.tenantId, (tx) => tx.employee.findUniqueOrThrow({ where: { id: employeeId } }));
    expect(row).toMatchObject({ firstName: "Renamed", jobTitle: "Lead Tech", status: "ON_LEAVE", email: null });
  });

  it("refuses a Dispatcher (field-limited) and a Technician from editing on the server", async () => {
    const world = await buildWorld("admin-emp-edit-deny");
    const employeeId = world.techA1.employeeId ?? "";
    for (const person of [world.dispatcher, world.techA1Other]) {
      await signInPerson(person, world.tenantId);
      expect((await updateEmployeeAction({}, form({ employeeId, firstName: "Hacked", lastName: "X" }))).error).toBe(en("ERROR.FORBIDDEN"));
    }
    const row = await withTenant(world.tenantId, (tx) => tx.employee.findUniqueOrThrow({ where: { id: employeeId } }));
    expect(row.firstName).toBe("tech-a1");
  });

  it("transfers an employee, ends an extra placement and terminates with a reason", async () => {
    const world = await buildWorld("admin-emp-lifecycle");
    const employeeId = world.techA1Other.employeeId ?? "";
    await signInPerson(world.ceo, world.tenantId);

    expect((await assignEmployeeAction({}, form({ employeeId, orgUnitId: world.units.cityB, kind: "SECONDARY" }))).success).toBeTruthy();
    const extra = await withTenant(world.tenantId, (tx) => tx.organizationalAssignment.findFirstOrThrow({ where: { employeeId, kind: "SECONDARY" } }));
    expect((await endAssignmentAction({}, form({ employeeId, assignmentId: extra.id }))).success).toBe(en("ADMIN.EMPLOYEE_ASSIGNMENT_ENDED"));

    const missingReason = await terminateEmployeeAction({}, form({ employeeId, terminationDate: "2026-01-02" }));
    expect(missingReason.error).toBe(en("ADMIN.ERROR_FIELD_REASON"));
    expect((await terminateEmployeeAction({}, form({ employeeId, terminationDate: "2026-01-02", reason: "Resigned" }))).success).toBe(en("ADMIN.EMPLOYEE_TERMINATED"));
    const row = await withTenant(world.tenantId, (tx) => tx.employee.findUniqueOrThrow({ where: { id: employeeId } }));
    expect(row.status).toBe("TERMINATED");
  });

  it("invites an employee with a role and scope for an authorised inviter and refuses a Technician", async () => {
    const world = await buildWorld("admin-emp-invite");
    await signInPerson(world.ceo, world.tenantId);
    const employee = await createEmployeeAction({}, form({ firstName: "Invitee", lastName: "Person", email: "invitee@example.test", orgUnitId: world.units.cityA }));
    expect(employee.success).toBeTruthy();
    const created = await withTenant(world.tenantId, (tx) => tx.employee.findFirstOrThrow({ where: { tenantId: world.tenantId, firstName: "Invitee" } }));

    await signInPerson(world.techA1, world.tenantId);
    expect((await inviteEmployeeAction({}, form({ employeeId: created.id }))).error).toBe(en("ERROR.FORBIDDEN"));

    await signInPerson(world.ceo, world.tenantId);
    const ok = await inviteEmployeeAction({}, form({ employeeId: created.id, roleId: world.roles.TECHNICIAN, scopeType: "OWN" }));
    expect(ok.success).toBe(en("ADMIN.INVITE_SENT"));
    const noScope = await inviteEmployeeAction({}, form({ employeeId: created.id, roleId: world.roles.TECHNICIAN }));
    expect(noScope.error).toBe(en("ERROR.VALIDATION_FAILED"));
  });
});
