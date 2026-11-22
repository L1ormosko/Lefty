import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as assignRoute } from "@/app/api/v1/jobs/[id]/assign/route";
import { GET as assignmentsRoute } from "@/app/api/v1/jobs/[id]/assignments/route";
import { GET as eventsRoute } from "@/app/api/v1/jobs/[id]/events/route";
import { GET as getJobRoute } from "@/app/api/v1/jobs/[id]/route";
import { POST as unassignRoute } from "@/app/api/v1/jobs/[id]/unassign/route";
import { GET as mineRoute } from "@/app/api/v1/jobs/mine/route";
import { withTenant } from "@/server/db";
import { disconnect } from "../authz/fixtures";
import { auditEvents, call } from "../org/org-helpers";
import { buildJobsWorld, createJobViaApi, type JobsWorld } from "./fixtures";

let w: JobsWorld;
beforeAll(async () => {
  w = await buildJobsWorld("jobs-assign");
});
afterAll(disconnect);

const assign = (cookie: string, jobId: string, body: Record<string, unknown>) => call(assignRoute, "POST", "/x", { cookie, params: { id: jobId }, body });
const unassign = (cookie: string, jobId: string, body: Record<string, unknown> = { reason: "Technician is out sick" }) => call(unassignRoute, "POST", "/x", { cookie, params: { id: jobId }, body });
const get = (cookie: string, jobId: string) => call(getJobRoute, "GET", "/x", { cookie, params: { id: jobId } });
const notificationsOf = (userId: string, eventType: string) =>
  withTenant(w.tenantId, (tx) => tx.notification.findMany({ where: { recipientId: userId, eventType }, orderBy: { createdAt: "asc" } }));

describe("assigning a job", () => {
  it("gives an eligible employee the job: ASSIGNED, MANUAL, one ACTIVE row, history, event, audit, and the technician sees it", async () => {
    const job = await createJobViaApi(w);
    expect((await get(w.cookie.techA1, job.id)).status).toBe(404); // not theirs yet

    const response = await assign(w.cookie.dispatcher, job.id, { employeeId: w.techA1.employeeId });
    expect(response.status).toBe(200);
    expect(response.json.data.status).toBe("ASSIGNED");
    expect(response.json.data.assignments).toEqual([expect.objectContaining({ employeeId: w.techA1.employeeId, teamOrgUnitId: null, role: "LEAD", method: "MANUAL" })]);

    const mine = await call(mineRoute, "GET", "/x", { cookie: w.cookie.techA1 });
    expect(mine.json.data.map((row: { id: string }) => row.id)).toContain(job.id);
    expect((await get(w.cookie.techA1, job.id)).status).toBe(200);

    const [statusRows, events] = await withTenant(w.tenantId, (tx) =>
      Promise.all([tx.jobStatusHistory.findMany({ where: { jobId: job.id, toStatus: "ASSIGNED" } }), tx.jobEvent.findMany({ where: { jobId: job.id, type: "job.assigned" } })]),
    );
    expect(statusRows).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect((await auditEvents(w.tenantId, "job.assign", job.id))[0].actorUserId).toBe(w.dispatcher.userId);
  });

  it("notifies the new assignee in-app with a link, and not the person who assigned", async () => {
    const job = await createJobViaApi(w);
    await assign(w.cookie.dispatcher, job.id, { employeeId: w.techA1.employeeId });
    const received = (await notificationsOf(w.techA1.userId, "job.assigned")).filter((row) => row.targetId === job.id);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ targetType: "job", params: { jobNumber: job.number } });
    expect(await notificationsOf(w.dispatcher.userId, "job.assigned")).toHaveLength(0);
  });

  it("refuses an ineligible employee with the failing reasons (409), leaving the job untouched", async () => {
    const job = await createJobViaApi(w);
    const response = await assign(w.cookie.dispatcher, job.id, { employeeId: w.techA1Other.employeeId }); // no EPA license
    expect(response.status).toBe(409);
    expect(response.json.error.code).toBe("CONFLICT");
    expect(response.json.error.details.map((issue: { code: string }) => issue.code)).toContain("QUALIFICATION_MISSING");
    expect((await get(w.cookie.dispatcher, job.id)).json.data).toMatchObject({ status: "PENDING_ASSIGNMENT", assignments: [] });

    const outOfTerritory = await assign(w.cookie.dispatcher, job.id, { employeeId: w.techB.employeeId });
    expect(outOfTerritory.status).toBe(409);
    expect(outOfTerritory.json.error.details.map((issue: { code: string }) => issue.code)).toEqual(expect.arrayContaining(["OUTSIDE_TERRITORY", "JOB_PERMISSION_MISSING"]));
  });

  it("lets only a jobs.approve holder override, with a reason, recorded as method OVERRIDE, a dispatch.override event and an audit row", async () => {
    const job = await createJobViaApi(w);
    const body = { employeeId: w.techA1Other.employeeId, override: { reason: "License renewal is in the mail; customer is waiting" } };

    expect((await assign(w.cookie.dispatcher, job.id, body)).status).toBe(403); // the Dispatcher holds no jobs.approve
    expect((await assign(w.cookie.dispatcher, job.id, { employeeId: w.techA1Other.employeeId, override: {} })).status).toBe(400); // a reason is mandatory

    const overridden = await assign(w.cookie.ceo, job.id, body);
    expect(overridden.status).toBe(200);
    expect(overridden.json.data.assignments[0]).toMatchObject({ employeeId: w.techA1Other.employeeId, method: "OVERRIDE" });

    const [assignmentRow, overrideEvents] = await withTenant(w.tenantId, (tx) =>
      Promise.all([tx.jobAssignment.findFirstOrThrow({ where: { jobId: job.id, state: "ACTIVE" } }), tx.jobEvent.findMany({ where: { jobId: job.id, type: "dispatch.override" } })]),
    );
    expect(assignmentRow.overrideReason).toContain("License renewal");
    expect(overrideEvents).toHaveLength(1);
    expect(overrideEvents[0]).toMatchObject({ actorUserId: w.ceo.userId });
    expect(overrideEvents[0].payload).toMatchObject({ failureCodes: expect.arrayContaining(["QUALIFICATION_MISSING"]) });
    const [audit] = await auditEvents(w.tenantId, "job.assign", job.id);
    expect(audit.reason).toContain("License renewal");
  });

  it("never lets an override assign a terminated employee", async () => {
    const job = await createJobViaApi(w);
    const terminated = await withTenant(w.tenantId, (tx) => tx.employee.update({ where: { id: w.techA1.employeeId as string }, data: { status: "TERMINATED", terminationDate: new Date("2020-01-01") } }));
    try {
      const response = await assign(w.cookie.ceo, job.id, { employeeId: terminated.id, override: { reason: "Please" } });
      expect(response.status).toBe(409);
      expect(response.json.error.details.map((issue: { code: string }) => issue.code)).toContain("EMPLOYEE_NOT_ACTIVE");
    } finally {
      await withTenant(w.tenantId, (tx) => tx.employee.update({ where: { id: terminated.id }, data: { status: "ACTIVE", terminationDate: null } }));
    }
  });

  it("refuses unknown employees and teams, a team outside the service area, both targets at once, and assigning twice", async () => {
    const job = await createJobViaApi(w);
    expect((await assign(w.cookie.dispatcher, job.id, { employeeId: "nope" })).json.error.field).toBe("employeeId");
    expect((await assign(w.cookie.dispatcher, job.id, { teamOrgUnitId: w.units.cityB })).json.error.field).toBe("teamOrgUnitId"); // a city, not a team
    expect((await assign(w.cookie.dispatcher, job.id, { employeeId: w.techA1.employeeId, teamOrgUnitId: w.units.teamA1 })).status).toBe(400);
    expect((await assign(w.cookie.dispatcher, job.id, {})).status).toBe(400);
    expect((await assign(w.cookie.dispatcher, job.id, { employeeId: w.techA1.employeeId })).status).toBe(200);
    expect((await assign(w.cookie.dispatcher, job.id, { employeeId: w.techA1.employeeId })).status).toBe(409);
  });

  it("is limited by permission and scope: technicians 403, a manager of another city 404", async () => {
    const job = await createJobViaApi(w);
    expect((await assign(w.cookie.techA1, job.id, { employeeId: w.techA1.employeeId })).status).toBe(403);
    expect((await assign(w.cookie.cityManagerB, job.id, { employeeId: w.techA1.employeeId })).status).toBe(404);
  });
});

describe("reassigning and unassigning", () => {
  it("ends the previous assignment (kept as history), starts a new one, keeps the status and notifies both people", async () => {
    const job = await createJobViaApi(w, { jobTypeId: w.ids.reviewType }); // both technicians are eligible for inspections
    await assign(w.cookie.dispatcher, job.id, { employeeId: w.techA1.employeeId });
    const moved = await assign(w.cookie.dispatcher, job.id, { employeeId: w.techA1Other.employeeId, reason: "Closer to the site" });
    expect(moved.status).toBe(200);
    expect(moved.json.data.status).toBe("ASSIGNED");
    expect(moved.json.data.assignments.map((row: { employeeId: string }) => row.employeeId)).toEqual([w.techA1Other.employeeId]);

    const history = await call(assignmentsRoute, "GET", "/x", { cookie: w.cookie.dispatcher, params: { id: job.id } });
    expect(history.json.data.map((row: { employeeId: string; state: string }) => [row.employeeId, row.state])).toEqual([
      [w.techA1Other.employeeId, "ACTIVE"],
      [w.techA1.employeeId, "ENDED"],
    ]);
    expect(history.json.data[1].endedReason).toBe("Closer to the site");

    expect((await get(w.cookie.techA1, job.id)).status).toBe(404); // lost access with the assignment
    expect((await get(w.cookie.techA1Other, job.id)).status).toBe(200);
    expect((await notificationsOf(w.techA1.userId, "job.reassigned")).filter((row) => (row.params as { jobNumber: number }).jobNumber === job.number)).toHaveLength(1);
    expect((await notificationsOf(w.techA1Other.userId, "job.assigned")).filter((row) => row.targetId === job.id)).toHaveLength(1);
    const events = await call(eventsRoute, "GET", "/x", { cookie: w.cookie.dispatcher, params: { id: job.id } });
    expect(events.json.data.map((row: { type: string }) => row.type)).toEqual(expect.arrayContaining(["job.assigned", "job.reassigned"]));
    expect((await auditEvents(w.tenantId, "job.reassign", job.id))).toHaveLength(1);
  });

  it("assigns a whole team: every current member reaches the job, outsiders do not", async () => {
    const job = await createJobViaApi(w, { jobTypeId: w.ids.reviewType });
    const response = await assign(w.cookie.dispatcher, job.id, { teamOrgUnitId: w.units.teamA1 });
    expect(response.status).toBe(200);
    expect(response.json.data.assignments[0]).toMatchObject({ teamOrgUnitId: w.units.teamA1, employeeId: null });
    expect((await get(w.cookie.techA1, job.id)).status).toBe(200);
    expect((await get(w.cookie.techA1Other, job.id)).status).toBe(200);
    expect((await get(w.cookie.techB, job.id)).status).toBe(404);
    expect((await notificationsOf(w.techA1Other.userId, "job.assigned")).filter((row) => row.targetId === job.id)).toHaveLength(1);
  });

  it("refuses a team none of whose members is eligible", async () => {
    const job = await createJobViaApi(w, { customerId: w.customerA.id, serviceAddressId: w.customerA.addressId, jobTypeId: w.ids.repairType });
    // Both A1 technicians are eligible for repairs only through the licence: remove it from techA1 for this check.
    const license = await withTenant(w.tenantId, (tx) => tx.employeeQualification.findFirstOrThrow({ where: { employeeId: w.techA1.employeeId as string, certificationId: w.ids.epa } }));
    await withTenant(w.tenantId, (tx) => tx.employeeQualification.update({ where: { id: license.id }, data: { status: "REVOKED" } }));
    try {
      const response = await assign(w.cookie.dispatcher, job.id, { teamOrgUnitId: w.units.teamA1 });
      expect(response.status).toBe(409);
    } finally {
      await withTenant(w.tenantId, (tx) => tx.employeeQualification.update({ where: { id: license.id }, data: { status: "VERIFIED" } }));
    }
  });

  it("unassigns: the assignment ends, the slot is cleared, the job returns to PENDING_ASSIGNMENT and the technician is told", async () => {
    const job = await createJobViaApi(w);
    await assign(w.cookie.dispatcher, job.id, { employeeId: w.techA1.employeeId });
    const slot = { start: new Date(Date.now() + 3 * 86_400_000).toISOString(), end: new Date(Date.now() + 3 * 86_400_000 + 3_600_000 * 2).toISOString() };
    const { POST: rescheduleRoute } = await import("@/app/api/v1/jobs/[id]/reschedule/route");
    expect((await call(rescheduleRoute, "POST", "/x", { cookie: w.cookie.dispatcher, params: { id: job.id }, body: { scheduledSlot: slot } })).json.data.status).toBe("SCHEDULED");

    expect((await unassign(w.cookie.techA1, job.id)).status).toBe(403);
    expect((await unassign(w.cookie.dispatcher, job.id, {})).status).toBe(400); // a reason is required
    const response = await unassign(w.cookie.dispatcher, job.id);
    expect(response.status).toBe(200);
    expect(response.json.data).toMatchObject({ status: "PENDING_ASSIGNMENT", scheduledStartAt: null, scheduledEndAt: null, assignments: [] });
    expect((await get(w.cookie.techA1, job.id)).status).toBe(404);
    expect((await notificationsOf(w.techA1.userId, "job.reassigned")).some((row) => (row.params as { jobNumber: number }).jobNumber === job.number)).toBe(true);
    expect((await unassign(w.cookie.dispatcher, job.id)).status).toBe(409); // nothing left to remove
  });

  it("refuses to reassign once the technician is on the way", async () => {
    const job = await createJobViaApi(w);
    await assign(w.cookie.dispatcher, job.id, { employeeId: w.techA1.employeeId });
    await withTenant(w.tenantId, (tx) => tx.job.update({ where: { id: job.id }, data: { status: "EN_ROUTE" } }));
    const response = await assign(w.cookie.dispatcher, job.id, { employeeId: w.techA1Other.employeeId, override: { reason: "x" } });
    expect(response.status).toBe(409);
    expect(response.json.error.code).toBe("INVALID_STATE_TRANSITION");
  });
});
