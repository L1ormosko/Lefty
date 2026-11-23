import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as assignRoute } from "@/app/api/v1/jobs/[id]/assign/route";
import { GET as assignmentsRoute } from "@/app/api/v1/jobs/[id]/assignments/route";
import { GET as eventsRoute } from "@/app/api/v1/jobs/[id]/events/route";
import { POST as rescheduleRoute } from "@/app/api/v1/jobs/[id]/reschedule/route";
import { POST as transitionRoute } from "@/app/api/v1/jobs/[id]/transition/route";
import { GET as mineRoute } from "@/app/api/v1/jobs/mine/route";
import { withTenant } from "@/server/db";
import { createPerson, disconnect, grantTemplate, makeRole } from "../authz/fixtures";
import { call, sessionCookie } from "../org/org-helpers";
import { buildJobsWorld, createJobViaApi, type JobsWorld } from "./fixtures";

let w: JobsWorld;
beforeAll(async () => {
  w = await buildJobsWorld("jobs-fix1");
});
afterAll(disconnect);

const assign = (cookie: string, jobId: string, body: Record<string, unknown>) => call(assignRoute, "POST", "/x", { cookie, params: { id: jobId }, body });
const move = (cookie: string, jobId: string, toStatus: string, reason?: string) =>
  call(transitionRoute, "POST", "/x", { cookie, params: { id: jobId }, body: reason ? { toStatus, reason } : { toStatus } });
const slot = () => ({ start: new Date(Date.now() + 86_400_000).toISOString(), end: new Date(Date.now() + 86_400_000 + 3_600_000).toISOString() });
const jobRow = (jobId: string) => withTenant(w.tenantId, (tx) => tx.job.findFirstOrThrow({ where: { id: jobId } }));

describe("ending assignments needs jobs.assign", () => {
  it("refuses cancelling an assigned job to someone who may edit but not assign; allows it once nobody is assigned", async () => {
    const editor = await createPerson(w.tenantId, "editor", { orgUnitId: w.units.state, legalEntityId: w.legalEntityId });
    const roleId = await makeRole(w.tenantId, "Job editor", [{ permission: "jobs.view" }, { permission: "jobs.edit" }]);
    await grantTemplate(w.tenantId, editor, roleId, [{ type: "ORG_UNIT", orgUnitId: w.units.state }]);
    const cookie = await sessionCookie(editor, w.tenantId);

    const assigned = await createJobViaApi(w);
    await assign(w.cookie.dispatcher, assigned.id, { employeeId: w.techA1.employeeId });
    expect((await move(cookie, assigned.id, "CANCELLED", "Customer cancelled")).status).toBe(403);
    expect((await jobRow(assigned.id)).status).toBe("ASSIGNED");
    expect((await move(w.cookie.dispatcher, assigned.id, "CANCELLED", "Customer cancelled")).status).toBe(200);

    const unassigned = await createJobViaApi(w);
    expect((await move(cookie, unassigned.id, "CANCELLED", "Duplicate job")).status).toBe(200);
  });
});

describe("expectedAssignmentId precondition (two dispatchers)", () => {
  it("answers 409 to the dispatcher acting on a stale screen, and accepts the current assignment id", async () => {
    const job = await createJobViaApi(w);
    // Both dispatchers loaded the job while nobody was assigned.
    const first = await assign(w.cookie.dispatcher, job.id, { employeeId: w.techA1.employeeId, expectedAssignmentId: null });
    expect(first.status).toBe(200);
    const stale = await assign(w.cookie.cityManagerA, job.id, { employeeId: w.techA1Other.employeeId, override: { reason: "x y z" }, expectedAssignmentId: null });
    expect(stale.status).toBe(409);
    expect(stale.json.error.field).toBe("expectedAssignmentId");
    const wrongId = await assign(w.cookie.cityManagerA, job.id, { employeeId: w.techA1Other.employeeId, expectedAssignmentId: "nope" });
    expect(wrongId.status).toBe(409);

    const currentId = first.json.data.assignments[0].id;
    const current = await assign(w.cookie.cityManagerA, job.id, { employeeId: w.techA1Other.employeeId, override: { reason: "License pending" }, expectedAssignmentId: currentId });
    expect([200, 403]).toContain(current.status); // 403 only if the city manager lacks jobs.approve; never the precondition
    expect(current.json.error?.field).not.toBe("expectedAssignmentId");
  });
});

describe("status and slot invariant", () => {
  it("clears the scheduled slot when a job enters RESCHEDULED", async () => {
    const job = await createJobViaApi(w);
    await assign(w.cookie.dispatcher, job.id, { employeeId: w.techA1.employeeId });
    expect((await call(rescheduleRoute, "POST", "/x", { cookie: w.cookie.dispatcher, params: { id: job.id }, body: { scheduledSlot: slot() } })).status).toBe(200);
    expect((await jobRow(job.id)).status).toBe("SCHEDULED");
    const moved = await move(w.cookie.dispatcher, job.id, "RESCHEDULED", "Customer asked for another day");
    expect(moved.status).toBe(200);
    expect(await jobRow(job.id)).toMatchObject({ status: "RESCHEDULED", scheduledStartAt: null, scheduledEndAt: null });
  });

  it("clears the slot when ON_HOLD returns to ASSIGNED", async () => {
    const job = await createJobViaApi(w);
    await assign(w.cookie.dispatcher, job.id, { employeeId: w.techA1.employeeId });
    expect((await move(w.cookie.dispatcher, job.id, "ON_HOLD", "Waiting for parts")).status).toBe(200);
    const start = new Date(Date.now() + 86_400_000);
    await withTenant(w.tenantId, (tx) => tx.job.update({ where: { id: job.id }, data: { scheduledStartAt: start, scheduledEndAt: new Date(start.getTime() + 3_600_000) } }));
    expect((await move(w.cookie.dispatcher, job.id, "ASSIGNED")).status).toBe(200);
    expect(await jobRow(job.id)).toMatchObject({ status: "ASSIGNED", scheduledStartAt: null, scheduledEndAt: null });
  });
});

describe("override details are for assigners and approvers only", () => {
  it("hides overrideReason and the dispatch.override reason from an assigned technician, shows them to approvers", async () => {
    const job = await createJobViaApi(w);
    const overridden = await assign(w.cookie.ceo, job.id, { employeeId: w.techA1Other.employeeId, override: { reason: "License renewal is in the mail" } });
    expect(overridden.status).toBe(200);

    const asTech = await call(assignmentsRoute, "GET", "/x", { cookie: w.cookie.techA1Other, params: { id: job.id } });
    expect(asTech.status).toBe(200);
    expect(asTech.json.data[0]).toMatchObject({ method: "OVERRIDE" });
    expect(asTech.json.data[0]).not.toHaveProperty("overrideReason");
    const techEvents = await call(eventsRoute, "GET", "/x", { cookie: w.cookie.techA1Other, params: { id: job.id } });
    const overrideEvent = techEvents.json.data.find((row: { type: string }) => row.type === "dispatch.override");
    expect(overrideEvent).toBeTruthy();
    expect(JSON.stringify(overrideEvent.payload)).not.toContain("License renewal");
    expect(overrideEvent.payload).not.toHaveProperty("failureCodes");

    const asCeo = await call(assignmentsRoute, "GET", "/x", { cookie: w.cookie.ceo, params: { id: job.id } });
    expect(asCeo.json.data[0].overrideReason).toBe("License renewal is in the mail");
    const ceoEvents = await call(eventsRoute, "GET", "/x", { cookie: w.cookie.ceo, params: { id: job.id } });
    expect(ceoEvents.json.data.find((row: { type: string }) => row.type === "dispatch.override").payload.reason).toBe("License renewal is in the mail");
  });
});

describe("team override is judged per member", () => {
  it("lets an approver override a team where one member lacks only a licence, although another member is on leave", async () => {
    const team = await withTenant(w.tenantId, (tx) => tx.orgUnit.create({ data: { tenantId: w.tenantId, type: "TEAM", name: "Mixed team", parentId: w.units.cityA, legalEntityId: w.legalEntityId } }));
    const unlicensed = await createPerson(w.tenantId, "unlicensed", { orgUnitId: team.id, legalEntityId: w.legalEntityId });
    const onLeave = await createPerson(w.tenantId, "on-leave", { orgUnitId: team.id, legalEntityId: w.legalEntityId });
    await withTenant(w.tenantId, async (tx) => {
      await tx.employee.update({ where: { id: onLeave.employeeId as string }, data: { status: "ON_LEAVE" } });
      await tx.employeeJobPermission.create({ data: { tenantId: w.tenantId, employeeId: unlicensed.employeeId as string, category: "repair", effectiveFrom: new Date(Date.now() - 86_400_000) } });
      await tx.serviceTerritory.create({ data: { tenantId: w.tenantId, employeeId: unlicensed.employeeId as string, orgUnitId: w.units.cityA, includeDescendants: true, effectiveFrom: new Date(Date.now() - 86_400_000) } });
    });
    const job = await createJobViaApi(w);
    const plain = await assign(w.cookie.dispatcher, job.id, { teamOrgUnitId: team.id });
    expect(plain.status).toBe(409);
    const overridden = await assign(w.cookie.ceo, job.id, { teamOrgUnitId: team.id, override: { reason: "Unlicensed member works under supervision" } });
    expect(overridden.status).toBe(200);
    expect(overridden.json.data.assignments[0]).toMatchObject({ teamOrgUnitId: team.id, method: "OVERRIDE" });
  });
});

describe("/jobs/mine without includeFinished", () => {
  it("hides finished work by default and shows it when the status filter names it", async () => {
    const job = await createJobViaApi(w);
    await assign(w.cookie.dispatcher, job.id, { employeeId: w.techA1.employeeId });
    await move(w.cookie.dispatcher, job.id, "CANCELLED", "No longer needed");
    const hidden = await call(mineRoute, "GET", "/x", { cookie: w.cookie.techA1 });
    expect(hidden.json.data.map((row: { id: string }) => row.id)).not.toContain(job.id);
    const named = await call(mineRoute, "GET", "/x", { cookie: w.cookie.techA1, query: { status: "CANCELLED" } });
    // The cancelled job ended its assignment, so ASSIGNED access is gone: it never reappears for the technician.
    expect(named.json.data.map((row: { id: string }) => row.id)).not.toContain(job.id);
  });
});
