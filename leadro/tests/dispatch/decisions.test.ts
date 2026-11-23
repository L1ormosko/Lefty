import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "@/server/db";
import { disconnect } from "../authz/fixtures";
import { auditEvents } from "../org/org-helpers";
import { createJobViaApi } from "../jobs/fixtures";
import { approve, buildDispatchWorld, generate, modify, read, reject, type DispatchWorld } from "./fixtures";

let w: DispatchWorld;
beforeAll(async () => {
  w = await buildDispatchWorld("dispatch-decide");
});
afterAll(disconnect);

const inspectionJob = () => createJobViaApi(w, w.inspectionBody);
const assignmentsOf = (jobId: string) => withTenant(w.tenantId, (tx) => tx.jobAssignment.findMany({ where: { jobId }, orderBy: { assignedAt: "asc" } }));
const statusOf = async (jobId: string) => (await withTenant(w.tenantId, (tx) => tx.job.findFirstOrThrow({ where: { id: jobId }, select: { status: true } }))).status;

describe("approving", () => {
  it("assigns the top candidate: method RECOMMENDATION_APPROVED, linked to the recommendation, decision recorded and audited", async () => {
    const job = await inspectionJob();
    const rec = (await generate(w.cookie.dispatcher, job.id)).json.data;
    const response = await approve(w.cookie.dispatcher, rec.id, { reason: "Closest and free" });
    expect(response.status).toBe(200);
    expect(response.json.data).toMatchObject({
      status: "APPROVED",
      chosenEmployeeId: w.techA1.employeeId,
      decidedById: w.dispatcher.userId,
      decisionReason: "Closest and free",
    });
    expect(response.json.data.decidedAt).toBeTruthy();

    expect(await statusOf(job.id)).toBe("ASSIGNED");
    const [assignment] = await assignmentsOf(job.id);
    expect(assignment).toMatchObject({ employeeId: w.techA1.employeeId, state: "ACTIVE", method: "RECOMMENDATION_APPROVED", recommendationId: rec.id });
    const [event] = await auditEvents(w.tenantId, "dispatch.recommendation_approve", rec.id);
    expect(event.actorUserId).toBe(w.dispatcher.userId);
    expect(event.newValue).toMatchObject({ chosenEmployeeId: w.techA1.employeeId, chosenRank: 1, assignmentMethod: "RECOMMENDATION_APPROVED", overrideUsed: false });
  });

  it("cannot be decided twice, and a superseded recommendation cannot be approved", async () => {
    const job = await inspectionJob();
    const first = (await generate(w.cookie.dispatcher, job.id)).json.data;
    const second = (await generate(w.cookie.dispatcher, job.id)).json.data;
    expect((await approve(w.cookie.dispatcher, first.id)).status).toBe(409); // superseded
    expect((await approve(w.cookie.dispatcher, second.id)).status).toBe(200);
    const again = await approve(w.cookie.dispatcher, second.id);
    expect(again.status).toBe(409);
    expect(again.json.error.code).toBe("INVALID_STATE_TRANSITION");
    expect((await assignmentsOf(job.id)).filter((row) => row.state === "ACTIVE")).toHaveLength(1);
  });

  it("re-checks hard eligibility at approval: a candidate who became ineligible is refused with reasons", async () => {
    const job = await inspectionJob();
    const rec = (await generate(w.cookie.dispatcher, job.id)).json.data;
    await withTenant(w.tenantId, (tx) =>
      tx.employeeJobPermission.updateMany({ where: { employeeId: w.techA1.employeeId as string, category: "inspection" }, data: { effectiveTo: new Date(Date.now() - 1000) } }),
    );
    const response = await approve(w.cookie.dispatcher, rec.id);
    await withTenant(w.tenantId, (tx) =>
      tx.employeeJobPermission.updateMany({ where: { employeeId: w.techA1.employeeId as string, category: "inspection" }, data: { effectiveTo: null } }),
    );
    expect(response.status).toBe(409);
    expect(response.json.error.details.map((detail: { code: string }) => detail.code)).toContain("JOB_PERMISSION_MISSING");
    expect((await read(w.cookie.dispatcher, rec.id)).json.data.status).toBe("PENDING");
    expect(await statusOf(job.id)).toBe("PENDING_ASSIGNMENT");
  });

  it("refuses to approve when nobody was eligible", async () => {
    const job = await createJobViaApi(w, { customerId: w.customerB.id, serviceAddressId: w.customerB.addressId }, w.cookie.ceo);
    const rec = (await generate(w.cookie.ceo, job.id)).json.data;
    const response = await approve(w.cookie.ceo, rec.id);
    expect(response.status).toBe(409);
    expect(await statusOf(job.id)).toBe("PENDING_ASSIGNMENT");
  });
});

describe("modifying", () => {
  it("assigns the chosen eligible employee with method RECOMMENDATION_MODIFIED and records the departure from rank 1", async () => {
    const job = await inspectionJob();
    const rec = (await generate(w.cookie.dispatcher, job.id)).json.data;
    const response = await modify(w.cookie.dispatcher, rec.id, { employeeId: w.techA1Other.employeeId, reason: "Customer asked for this technician" });
    expect(response.status).toBe(200);
    expect(response.json.data).toMatchObject({ status: "MODIFIED", chosenEmployeeId: w.techA1Other.employeeId, decisionReason: "Customer asked for this technician" });
    const [assignment] = await assignmentsOf(job.id);
    expect(assignment).toMatchObject({ employeeId: w.techA1Other.employeeId, method: "RECOMMENDATION_MODIFIED", recommendationId: rec.id });
    const [event] = await auditEvents(w.tenantId, "dispatch.recommendation_modify", rec.id);
    expect(event.newValue).toMatchObject({ chosenRank: 2, overrideUsed: false });
    expect(event.reason).toBe("Customer asked for this technician");
  });

  it("requires a reason and refuses the recommended employee (that is an approval)", async () => {
    const job = await inspectionJob();
    const rec = (await generate(w.cookie.dispatcher, job.id)).json.data;
    expect((await modify(w.cookie.dispatcher, rec.id, { employeeId: w.techA1Other.employeeId })).status).toBe(400);
    const same = await modify(w.cookie.dispatcher, rec.id, { employeeId: w.techA1.employeeId, reason: "x" });
    expect(same.status).toBe(400);
    expect(same.json.error.field).toBe("employeeId");
    expect((await read(w.cookie.dispatcher, rec.id)).json.data.status).toBe("PENDING");
  });

  it("refuses an ineligible choice with the reasons, and without approval rights even with an override", async () => {
    const job = await inspectionJob();
    const rec = (await generate(w.cookie.dispatcher, job.id)).json.data;
    const plain = await modify(w.cookie.dispatcher, rec.id, { employeeId: w.techB.employeeId, reason: "Nearest to depot" });
    expect(plain.status).toBe(409);
    expect(plain.json.error.details.length).toBeGreaterThan(0);
    const overridden = await modify(w.cookie.dispatcher, rec.id, { employeeId: w.techB.employeeId, reason: "Nearest", override: { reason: "Urgent, license waived" } });
    expect(overridden.status).toBe(403); // the Dispatcher template does not hold jobs.approve
    expect((await read(w.cookie.dispatcher, rec.id)).json.data.status).toBe("PENDING");
    expect(await assignmentsOf(job.id)).toHaveLength(0);
  });

  it("records a manual override (OVERRIDE, reason, event, audit) when someone with approval rights chooses an ineligible employee", async () => {
    const job = await inspectionJob();
    const rec = (await generate(w.cookie.ceo, job.id)).json.data;
    const response = await modify(w.cookie.ceo, rec.id, { employeeId: w.techB.employeeId, reason: "Only one nearby", override: { reason: "Urgent, license waived" } });
    expect(response.status).toBe(200);
    expect(response.json.data.status).toBe("MODIFIED");
    const [assignment] = await assignmentsOf(job.id);
    expect(assignment).toMatchObject({ employeeId: w.techB.employeeId, method: "OVERRIDE", overrideReason: "Urgent, license waived", recommendationId: rec.id });
    const events = await withTenant(w.tenantId, (tx) => tx.jobEvent.findMany({ where: { jobId: job.id, type: "dispatch.override" } }));
    expect(events).toHaveLength(1);
    const [audit] = await auditEvents(w.tenantId, "dispatch.recommendation_modify", rec.id);
    expect(audit.newValue).toMatchObject({ chosenRank: null, assignmentMethod: "OVERRIDE", overrideUsed: true });
    expect(audit.reason).toBe("Urgent, license waived");
  });
});

describe("rejecting", () => {
  it("records who rejected and why, leaves the job pending and assigns nobody", async () => {
    const job = await inspectionJob();
    const rec = (await generate(w.cookie.dispatcher, job.id)).json.data;
    expect((await reject(w.cookie.dispatcher, rec.id, {})).status).toBe(400); // reason required
    const response = await reject(w.cookie.dispatcher, rec.id, { reason: "I know a better fit" });
    expect(response.status).toBe(200);
    expect(response.json.data).toMatchObject({ status: "REJECTED", decidedById: w.dispatcher.userId, decisionReason: "I know a better fit", chosenEmployeeId: null });
    expect(await statusOf(job.id)).toBe("PENDING_ASSIGNMENT");
    expect(await assignmentsOf(job.id)).toHaveLength(0);
    expect((await auditEvents(w.tenantId, "dispatch.recommendation_reject", rec.id))[0].reason).toBe("I know a better fit");
    expect((await approve(w.cookie.dispatcher, rec.id)).status).toBe(409); // decided
  });
});
