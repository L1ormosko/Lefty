import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as assignRoute } from "@/app/api/v1/jobs/[id]/assign/route";
import { GET as listNotificationsRoute } from "@/app/api/v1/notifications/route";
import { POST as transitionRoute } from "@/app/api/v1/jobs/[id]/transition/route";
import { assignedEmployeeIdsByCustomer, jobAssignedToWhere } from "@/server/customers";
import { withTenant } from "@/server/db";
import { assignedEmployeeIdsByJob, getJobEligibilityInputs } from "@/server/jobs";
import { requirementsFromInputs } from "@/server/qualifications";
import { disconnect } from "../authz/fixtures";
import { call } from "../org/org-helpers";
import { assignJob, makeCustomer, makeJob } from "../customers/fixtures";
import { buildJobsWorld, createJobViaApi, type JobsWorld } from "./fixtures";

let w: JobsWorld;
beforeAll(async () => {
  w = await buildJobsWorld("jobs-access");
});
afterAll(disconnect);

describe("ASSIGNED scope derivation (shared with customers)", () => {
  it("derives assignedEmployeeIds from active direct and team assignments, and agrees with the query-side helper", async () => {
    const customer = await makeCustomer(w.tenantId, { orgUnitId: w.units.cityA });
    const direct = await makeJob(w.tenantId, customer.id, w.units.cityA);
    const team = await makeJob(w.tenantId, customer.id, w.units.cityA);
    const ended = await makeJob(w.tenantId, customer.id, w.units.cityA);
    const archived = await makeJob(w.tenantId, customer.id, w.units.cityA, { archived: true });
    const unassigned = await makeJob(w.tenantId, customer.id, w.units.cityA);
    await assignJob(w.tenantId, direct, { employeeId: w.techB.employeeId as string });
    await assignJob(w.tenantId, team, { teamOrgUnitId: w.units.teamA1 });
    await assignJob(w.tenantId, ended, { employeeId: w.techA1.employeeId as string }, "ENDED");
    await assignJob(w.tenantId, archived, { employeeId: w.techA1.employeeId as string });

    const now = new Date();
    const derived = await withTenant(w.tenantId, (tx) => assignedEmployeeIdsByJob(tx, w.tenantId, [direct, team, ended, archived, unassigned], now));
    expect(derived.get(direct)).toEqual([w.techB.employeeId]);
    expect((derived.get(team) ?? []).sort()).toEqual([w.techA1.employeeId, w.techA1Other.employeeId].sort()); // team expansion
    expect(derived.get(ended)).toEqual([]);
    expect(derived.get(archived)).toEqual([]);
    expect(derived.get(unassigned)).toEqual([]);

    // The query form of the same rule returns exactly the jobs whose derived ids contain the employee.
    for (const employee of [w.techA1, w.techA1Other, w.techB]) {
      const viaQuery = await withTenant(w.tenantId, (tx) => tx.job.findMany({ where: { tenantId: w.tenantId, customerId: customer.id, ...jobAssignedToWhere(employee.employeeId as string, now) }, select: { id: true } }));
      const viaIds = [direct, team, ended, archived, unassigned].filter((jobId) => (derived.get(jobId) ?? []).includes(employee.employeeId as string));
      expect(viaQuery.map((row) => row.id).sort()).toEqual(viaIds.sort());
    }

    // ...and the customer-level helper is the union of its jobs' employees.
    const byCustomer = await withTenant(w.tenantId, (tx) => assignedEmployeeIdsByCustomer(tx, w.tenantId, [customer.id], now));
    expect((byCustomer.get(customer.id) ?? []).sort()).toEqual([...new Set([...(derived.get(direct) ?? []), ...(derived.get(team) ?? [])])].sort());
  });

  it("expands an archived team to nobody and a member who left the team no longer reaches its jobs", async () => {
    const customer = await makeCustomer(w.tenantId, { orgUnitId: w.units.cityA });
    const job = await makeJob(w.tenantId, customer.id, w.units.cityA);
    await assignJob(w.tenantId, job, { teamOrgUnitId: w.units.teamA1 });
    await withTenant(w.tenantId, (tx) =>
      tx.organizationalAssignment.updateMany({ where: { employeeId: w.techA1Other.employeeId as string, orgUnitId: w.units.teamA1 }, data: { effectiveTo: new Date(Date.now() - 1000) } }),
    );
    try {
      const derived = await withTenant(w.tenantId, (tx) => assignedEmployeeIdsByJob(tx, w.tenantId, [job]));
      expect(derived.get(job)).toEqual([w.techA1.employeeId]);
    } finally {
      await withTenant(w.tenantId, (tx) => tx.organizationalAssignment.updateMany({ where: { employeeId: w.techA1Other.employeeId as string, orgUnitId: w.units.teamA1 }, data: { effectiveTo: null } }));
    }
  });
});

describe("eligibility inputs for the qualification engine", () => {
  it("hands over the job's own requirement rows, category, unit and zone, and the engine accepts them", async () => {
    const job = await createJobViaApi(w, { timeZone: "America/Chicago" });
    const inputs = await withTenant(w.tenantId, (tx) => getJobEligibilityInputs(tx, w.tenantId, job.id));
    expect(inputs).toMatchObject({ jobTypeId: w.ids.repairType, jobCategory: "repair", orgUnitId: w.units.cityA, timeZone: "America/Chicago" });
    expect(inputs.requirements.map((row) => row.skillId ?? row.certificationId).sort()).toEqual([w.ids.hvac, w.ids.epa].sort());

    const { requirements, timeZone } = await withTenant(w.tenantId, (tx) => requirementsFromInputs(tx, w.tenantId, inputs));
    expect(timeZone).toBe("America/Chicago");
    expect(requirements.skills).toEqual([{ skillId: w.ids.hvac, minLevel: 3, name: "HVAC" }]);
    expect(requirements.serviceArea?.orgUnitId).toBe(w.units.cityA);
    await expect(withTenant(w.tenantId, (tx) => getJobEligibilityInputs(tx, w.tenantId, "nope"))).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("notification links to jobs", () => {
  it("redacts the job link once the recipient has lost access to the job (read-time check through the registered resolver)", async () => {
    const job = await createJobViaApi(w, { jobTypeId: w.ids.reviewType });
    const assignTo = (employeeId: string) => call(assignRoute, "POST", "/x", { cookie: w.cookie.dispatcher, params: { id: job.id }, body: { employeeId } });
    await assignTo(w.techA1.employeeId as string);

    const visible = await call(listNotificationsRoute, "GET", "/x", { cookie: w.cookie.techA1 });
    const entry = visible.json.data.find((row: { targetId: string | null }) => row.targetId === job.id);
    expect(entry).toMatchObject({ eventType: "job.assigned", redacted: false, params: { jobNumber: job.number } });

    await assignTo(w.techA1Other.employeeId as string); // techA1 loses the job
    const after = await call(listNotificationsRoute, "GET", "/x", { cookie: w.cookie.techA1 });
    expect(after.json.data.some((row: { targetId: string | null }) => row.targetId === job.id)).toBe(false);
    const redacted = after.json.data.find((row: { id: string }) => row.id === entry.id);
    expect(redacted).toMatchObject({ redacted: true, targetId: null, params: {} });
    // The "taken off you" notice carries the number only: the recipient already knew it.
    expect(after.json.data.some((row: { eventType: string; params: { jobNumber?: number } }) => row.eventType === "job.reassigned" && row.params.jobNumber === job.number)).toBe(true);
  });

  it("never exposes a job, or acts on it, from another tenant", async () => {
    const job = await createJobViaApi(w, { jobTypeId: w.ids.reviewType });
    await call(assignRoute, "POST", "/x", { cookie: w.cookie.dispatcher, params: { id: job.id }, body: { employeeId: w.techA1.employeeId } });
    const other = await buildJobsWorld("jobs-access-other");
    const foreign = await call(transitionRoute, "POST", "/x", { cookie: other.cookie.ceo, params: { id: job.id }, body: { toStatus: "CANCELLED", reason: "x" } });
    expect(foreign.status).toBe(404);
    expect(await withTenant(other.tenantId, (tx) => tx.notification.count({ where: { targetId: job.id } }))).toBe(0);
  });
});
