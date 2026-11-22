import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as listCustomers } from "@/app/api/v1/customers/route";
import { GET as getCustomer, PATCH as patchCustomer } from "@/app/api/v1/customers/[id]/route";
import { POST as createCustomer } from "@/app/api/v1/customers/route";
import { assignedEmployeeIdsByCustomer, customerAssignedToWhere, jobAssignedToWhere, leadAssignedToWhere } from "@/server/customers";
import { withTenant } from "@/server/db";
import { buildWorld, createPerson, disconnect, grantTemplate, type World } from "../authz/fixtures";
import { call, sessionCookie } from "../org/org-helpers";
import { assignJob, assignLead, makeCustomer, makeJob, makeLead } from "./fixtures";

/**
 * ASSIGNED scope (technicians) and record-set grants (Dispatcher `job_related`, Lead Operations
 * `lead_related`): who reaches which customer, in lists and on single records.
 */
let w: World;
let techA1: string;
let techA1Other: string;
let techB: string;
let dispatcher: string;
let leadOps: string;
let leadOpsPerson: Awaited<ReturnType<typeof createPerson>>;

const unique = (label: string) => `${label}${Math.random().toString(36).slice(2, 8)}`;
const list = (cookie: string, query: Record<string, string> = {}) => call(listCustomers, "GET", "/api/v1/customers", { cookie, query });
const get = (cookie: string, id: string) => call(getCustomer, "GET", `/api/v1/customers/${id}`, { cookie, params: { id } });
const ids = (result: { json: { data: Array<{ id: string }> } }) => result.json.data.map((row) => row.id).sort();

interface Fixture {
  direct: string;
  team: string;
  other: string;
  viaLead: string;
  archivedJob: string;
  endedAssignment: string;
  plain: string;
}
let c: Fixture;

beforeAll(async () => {
  w = await buildWorld("customers-assigned");
  techA1 = await sessionCookie(w.techA1, w.tenantId);
  techA1Other = await sessionCookie(w.techA1Other, w.tenantId);
  techB = await sessionCookie(w.techB, w.tenantId);
  dispatcher = await sessionCookie(w.dispatcher, w.tenantId);
  leadOpsPerson = await createPerson(w.tenantId, "lead-ops", { orgUnitId: w.units.state });
  await grantTemplate(w.tenantId, leadOpsPerson, w.roles.LEAD_OPERATIONS_MANAGER, [{ type: "ORG_UNIT", orgUnitId: w.units.state }]);
  leadOps = await sessionCookie(leadOpsPerson, w.tenantId);

  const make = (label: string, orgUnitId: string) => makeCustomer(w.tenantId, { name: unique(`${label} `), orgUnitId, taxId: "SECRET-TAX" });
  const direct = await make("Direct", w.units.cityA);
  const team = await make("Team", w.units.cityA);
  const other = await make("Other", w.units.cityB);
  const viaLead = await make("ViaLead", w.units.cityA);
  const archivedJob = await make("ArchivedJob", w.units.cityA);
  const endedAssignment = await make("Ended", w.units.cityA);
  const plain = await make("Plain", w.units.cityA);

  await assignJob(w.tenantId, await makeJob(w.tenantId, direct.id, w.units.cityA), { employeeId: w.techA1.employeeId! });
  await assignJob(w.tenantId, await makeJob(w.tenantId, team.id, w.units.cityA), { teamOrgUnitId: w.units.teamA1 });
  await assignJob(w.tenantId, await makeJob(w.tenantId, other.id, w.units.cityB), { employeeId: w.techB.employeeId! });
  await assignLead(w.tenantId, await makeLead(w.tenantId, viaLead.id, { orgUnitId: w.units.cityA }), w.techA1.employeeId!);
  await assignJob(w.tenantId, await makeJob(w.tenantId, archivedJob.id, w.units.cityA, { archived: true }), { employeeId: w.techA1.employeeId! });
  await assignJob(w.tenantId, await makeJob(w.tenantId, endedAssignment.id, w.units.cityA), { employeeId: w.techA1.employeeId! }, "ENDED");
  await makeLead(w.tenantId, plain.id, { orgUnitId: w.units.cityA });

  c = {
    direct: direct.id,
    team: team.id,
    other: other.id,
    viaLead: viaLead.id,
    archivedJob: archivedJob.id,
    endedAssignment: endedAssignment.id,
    plain: plain.id,
  };
});
afterAll(disconnect);

describe("ASSIGNED scope (technician)", () => {
  it("lists exactly the customers with an active lead or job assigned to the technician, directly or through the team", async () => {
    expect(ids(await list(techA1))).toEqual([c.direct, c.team, c.viaLead].sort());
    expect(ids(await list(techA1Other))).toEqual([c.team]); // only the team assignment reaches them
    expect(ids(await list(techB))).toEqual([c.other]);
  });

  it("an assignment to the team reaches every member of the team and nobody else (team expansion)", async () => {
    expect((await get(techA1Other, c.team)).status).toBe(200);
    expect((await get(techB, c.team)).status).toBe(404);
    expect((await get(techA1Other, c.direct)).status).toBe(404);
  });

  it("archived jobs and ended assignments grant nothing", async () => {
    expect((await get(techA1, c.archivedJob)).status).toBe(404);
    expect((await get(techA1, c.endedAssignment)).status).toBe(404);
  });

  it("customers in someone else's work are 404 even though they exist", async () => {
    expect((await get(techA1, c.other)).status).toBe(404);
    expect((await get(techA1, c.plain)).status).toBe(404);
  });

  it("a technician gets contact data but never the billing set, and cannot write", async () => {
    const row = (await get(techA1, c.direct)).json.data;
    expect(row.name).toBeTruthy();
    expect(row).not.toHaveProperty("taxId");
    expect(row.addresses.length).toBeGreaterThan(0);
    expect((await call(patchCustomer, "PATCH", "/x", { cookie: techA1, params: { id: c.direct }, body: { name: "Nope" } })).status).toBe(403);
    expect((await call(createCustomer, "POST", "/x", { cookie: techA1, body: { name: "Nope" } })).status).toBe(403);
  });

  it("access follows the assignment: ending it removes the customer", async () => {
    const customer = await makeCustomer(w.tenantId, { orgUnitId: w.units.cityA });
    const jobId = await makeJob(w.tenantId, customer.id, w.units.cityA);
    const assignmentId = await assignJob(w.tenantId, jobId, { employeeId: w.techA1.employeeId! });
    expect((await get(techA1, customer.id)).status).toBe(200);
    await withTenant(w.tenantId, (tx) => tx.jobAssignment.update({ where: { id: assignmentId }, data: { state: "ENDED", endedAt: new Date() } }));
    expect((await get(techA1, customer.id)).status).toBe(404);
  });
});

describe("the shared helper: where-fragment and id-list forms agree", () => {
  it("assignedEmployeeIdsByCustomer matches customerAssignedToWhere for every employee", async () => {
    const employees = [w.techA1, w.techA1Other, w.techB, w.cityManagerA, w.stateManager].map((person) => person.employeeId!);
    await withTenant(w.tenantId, async (tx) => {
      const customers = (await tx.customer.findMany({ where: { tenantId: w.tenantId }, select: { id: true } })).map((row) => row.id);
      const now = new Date();
      const byCustomer = await assignedEmployeeIdsByCustomer(tx, w.tenantId, customers, now);
      for (const employeeId of employees) {
        const viaIds = customers.filter((customerId) => byCustomer.get(customerId)?.includes(employeeId)).sort();
        const viaWhere = (
          await tx.customer.findMany({ where: { tenantId: w.tenantId, ...customerAssignedToWhere(employeeId, now) }, select: { id: true } })
        )
          .map((row) => row.id)
          .sort();
        expect(viaWhere).toEqual(viaIds);
      }
    });
  });

  it("exposes the lead and job fragments the leads and jobs modules reuse", async () => {
    await withTenant(w.tenantId, async (tx) => {
      const now = new Date();
      const jobs = await tx.job.findMany({ where: { tenantId: w.tenantId, ...jobAssignedToWhere(w.techA1Other.employeeId!, now) }, select: { customerId: true } });
      expect(jobs.map((job) => job.customerId)).toEqual([c.team]);
      const leads = await tx.lead.findMany({ where: { tenantId: w.tenantId, ...leadAssignedToWhere(w.techA1.employeeId!) }, select: { customerId: true } });
      expect(leads.map((lead) => lead.customerId)).toEqual([c.viaLead]);
    });
  });
});

describe("record-set grants", () => {
  it("a Dispatcher (customers.view {set: job_related}) reaches only customers that have a job", async () => {
    const reached = ids(await list(dispatcher));
    expect(reached).toEqual(expect.arrayContaining([c.direct, c.team, c.other, c.endedAssignment]));
    expect(reached).not.toContain(c.plain); // only a lead
    expect(reached).not.toContain(c.viaLead); // only a lead
    expect(reached).not.toContain(c.archivedJob); // its only job is archived
    expect((await get(dispatcher, c.plain)).status).toBe(404);
    expect((await get(dispatcher, c.direct)).status).toBe(200);
  });

  it("Lead Operations (customers.view {set: lead_related}) reaches only customers that have a lead", async () => {
    const reached = ids(await list(leadOps));
    expect(reached).toEqual([c.plain, c.viaLead].sort());
    expect((await get(leadOps, c.direct)).status).toBe(404);
    expect((await get(leadOps, c.plain)).status).toBe(200);
  });

  it("a set-qualified create grant can create, and the caller sees only what its view grant covers afterwards", async () => {
    const created = await call(createCustomer, "POST", "/x", { cookie: leadOps, body: { name: unique("FromLeadOps "), orgUnitId: w.units.cityA } });
    expect(created.status).toBe(201);
    // The new customer has no lead yet, so the lead_related view grant does not cover it: id only.
    expect(Object.keys(created.json.data).sort()).toEqual(["id", "possibleDuplicates"]);
    // Another unit outside the grant's scope is refused as usual.
    const outside = await call(createCustomer, "POST", "/x", { cookie: leadOps, body: { name: unique("X "), orgUnitId: w.units.outside } });
    expect(outside.status).toBe(404);
  });

  it("a grant qualified by an unknown record set matches no customer (fail closed)", async () => {
    const { makeRole } = await import("../authz/fixtures");
    const roleId = await makeRole(w.tenantId, "odd set", [{ permission: "customers.view", conditions: { set: "something_else" } }]);
    const person = await createPerson(w.tenantId, "odd", { orgUnitId: w.units.state });
    await grantTemplate(w.tenantId, person, roleId, [{ type: "TENANT" }]);
    const cookie = await sessionCookie(person, w.tenantId);
    expect(ids(await list(cookie))).toEqual([]);
    expect((await get(cookie, c.direct)).status).toBe(404);
  });
});
