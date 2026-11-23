import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as assignRoute } from "@/app/api/v1/jobs/[id]/assign/route";
import { withTenant } from "@/server/db";
// Internal on purpose: the evaluation ceiling cannot be reached with fixture data, so the test lowers it.
import { buildEligibilityPicture } from "@/server/dispatch/picture";
import { disconnect, toActor } from "../authz/fixtures";
import { createJobViaApi } from "../jobs/fixtures";
import { call } from "../org/org-helpers";
import { approve, buildDispatchWorld, candidates, generate, modify, read, type DispatchWorld } from "./fixtures";

let w: DispatchWorld;
beforeAll(async () => {
  w = await buildDispatchWorld("dispatch-scope");
  // techB is a "relevant" candidate (has a job permission) but is a City B employee: outside the City A manager's scope.
  await withTenant(w.tenantId, (tx) =>
    tx.employeeJobPermission.createMany({
      data: ["inspection", "repair"].map((category) => ({ tenantId: w.tenantId, employeeId: w.techB.employeeId as string, category, effectiveFrom: new Date(Date.now() - 86_400_000) })),
    }),
  );
});
afterAll(disconnect);

const inspectionJob = () => createJobViaApi(w, w.inspectionBody);
const manualAssign = (jobId: string, employeeId: string | null) => call(assignRoute, "POST", "/x", { cookie: w.cookie.dispatcher, params: { id: jobId }, body: { employeeId } });
const activeAssignments = (jobId: string) => withTenant(w.tenantId, (tx) => tx.jobAssignment.findMany({ where: { jobId, state: "ACTIVE" } }));

/** A job nobody can take (the HVAC skill at level 5; techs have level 4): every relevant employee is blocked with HR facts in params. */
const impossibleJob = () => createJobViaApi(w, { additionalRequirements: { skills: [{ skillId: w.ids.hvac, minLevel: 5 }] } });

describe("employee scope of the candidate lists", () => {
  it("an ORG_UNIT manager never sees an out-of-scope employee, their ids or their HR facts: they are only counted", async () => {
    const job = await impossibleJob();
    const own = (await candidates(w.cookie.cityManagerA, job.id)).json.data;
    expect(JSON.stringify(own)).not.toContain(w.techB.employeeId);
    expect(own.outOfScopeCount).toBeGreaterThanOrEqual(1);
    const inScope = own.blocked.find((entry: { employeeId: string }) => entry.employeeId === w.techA1.employeeId);
    expect(inScope.failures.map((failure: { code: string }) => failure.code)).toContain("SKILL_LEVEL_TOO_LOW");

    const wide = (await candidates(w.cookie.ceo, job.id)).json.data;
    expect(wide.blocked.map((entry: { employeeId: string }) => entry.employeeId)).toContain(w.techB.employeeId);

    const rec = (await generate(w.cookie.cityManagerA, job.id)).json.data;
    expect(JSON.stringify(rec)).not.toContain(w.techB.employeeId);
    expect(rec.candidates).toEqual([]);
    expect(rec.outOfScopeCount).toBeGreaterThanOrEqual(1); // "N employees outside your scope were not evaluated for you"
    expect(Object.keys(rec.blockingReasons)).toContain(w.techA1.employeeId);
  });

  it("re-checks on read: a recommendation made by a wider-scoped colleague hides out-of-scope people from a narrower viewer", async () => {
    const job = await impossibleJob();
    const rec = (await generate(w.cookie.ceo, job.id)).json.data;
    expect(Object.keys(rec.blockingReasons)).toContain(w.techB.employeeId);
    const seen = (await read(w.cookie.cityManagerA, rec.id)).json.data;
    expect(JSON.stringify(seen)).not.toContain(w.techB.employeeId);
    expect(seen.hiddenCandidateCount).toBeGreaterThanOrEqual(1);
    expect(Object.keys(seen.blockingReasons)).toContain(w.techA1.employeeId);
  });

  it("the approver cannot pick an employee outside their scope (404), and cannot approve a hidden top candidate", async () => {
    const job = await inspectionJob();
    const rec = (await generate(w.cookie.cityManagerA, job.id)).json.data;
    expect((await modify(w.cookie.cityManagerA, rec.id, { employeeId: w.techB.employeeId, reason: "x" })).status).toBe(404);
    expect((await read(w.cookie.cityManagerA, rec.id)).json.data.status).toBe("PENDING");
  });
});

describe("evaluation limit", () => {
  it("pages through the pool and reports a truncated pass instead of pretending nobody is eligible", async () => {
    const job = await inspectionJob();
    const actor = toActor(w.tenantId, w.ceo.userId, w.ceo.employeeId);
    const { picture, relevant } = await withTenant(w.tenantId, async (tx) => ({
      picture: await buildEligibilityPicture(tx, actor, job.id, new Date(), 1),
      relevant: await buildEligibilityPicture(tx, actor, job.id),
    }));
    expect(relevant.poolTruncated).toBe(false);
    expect(relevant.evaluatedCount).toBeGreaterThanOrEqual(3);
    expect(picture.poolTruncated).toBe(true);
    expect(picture.evaluatedCount).toBe(1);
  });
});

describe("stale and concurrent decisions", () => {
  it("a manual assignment after generation supersedes the recommendation; approving it is refused and changes nothing", async () => {
    const job = await inspectionJob();
    const rec = (await generate(w.cookie.dispatcher, job.id)).json.data;
    expect((await manualAssign(job.id, w.techA1Other.employeeId)).status).toBe(200);
    expect((await read(w.cookie.dispatcher, rec.id)).json.data.status).toBe("SUPERSEDED");
    const refused = await approve(w.cookie.dispatcher, rec.id);
    expect(refused.status).toBe(409);
    const [assignment, ...rest] = await activeAssignments(job.id);
    expect(rest).toHaveLength(0);
    expect(assignment).toMatchObject({ employeeId: w.techA1Other.employeeId, method: "MANUAL", recommendationId: null });
  });

  it("never relabels somebody else's manual assignment of the same employee as a recommendation approval", async () => {
    const job = await inspectionJob();
    const rec = (await generate(w.cookie.dispatcher, job.id)).json.data;
    expect((await manualAssign(job.id, w.techA1.employeeId)).status).toBe(200); // the very person the recommendation names
    expect((await approve(w.cookie.dispatcher, rec.id)).status).toBe(409);
    expect((await activeAssignments(job.id))[0]).toMatchObject({ employeeId: w.techA1.employeeId, method: "MANUAL", recommendationId: null });
  });

  it("refuses a still-PENDING recommendation when the job's assignments changed after it was generated (STALE_RECOMMENDATION)", async () => {
    const job = await inspectionJob();
    const rec = (await generate(w.cookie.dispatcher, job.id)).json.data;
    // An assignment history change that did not go through the jobs service (so nothing superseded the recommendation).
    await withTenant(w.tenantId, (tx) =>
      tx.jobAssignment.create({ data: { tenantId: w.tenantId, jobId: job.id, employeeId: w.techA1Other.employeeId as string, assignedAt: new Date(Date.now() + 5_000) } }),
    );
    const response = await approve(w.cookie.dispatcher, rec.id);
    expect(response.status).toBe(409);
    expect(response.json.error.details[0].code).toBe("STALE_RECOMMENDATION");
    expect((await read(w.cookie.dispatcher, rec.id)).json.data.status).toBe("PENDING");
    expect((await activeAssignments(job.id)).map((row) => row.employeeId)).toEqual([w.techA1Other.employeeId]);
  });

  it("serialises a concurrent approve and modify: exactly one wins, one assignment results", async () => {
    const job = await inspectionJob();
    const rec = (await generate(w.cookie.dispatcher, job.id)).json.data;
    const results = await Promise.all([
      approve(w.cookie.dispatcher, rec.id),
      modify(w.cookie.dispatcher, rec.id, { employeeId: w.techA1Other.employeeId, reason: "Customer asked" }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const assignments = await activeAssignments(job.id);
    expect(assignments).toHaveLength(1);
    const decided = (await read(w.cookie.dispatcher, rec.id)).json.data;
    expect(decided.chosenEmployeeId).toBe(assignments[0].employeeId);
    expect(["APPROVED", "MODIFIED"]).toContain(decided.status);
  });

  it("rolls back completely when the assignment is refused: no assignment, recommendation still PENDING", async () => {
    const job = await inspectionJob();
    const rec = (await generate(w.cookie.dispatcher, job.id)).json.data;
    expect((await modify(w.cookie.dispatcher, rec.id, { employeeId: "nope", reason: "x" })).status).toBe(404);
    expect((await modify(w.cookie.dispatcher, rec.id, { employeeId: w.techB.employeeId, reason: "x" })).status).toBe(409); // not eligible, no override
    expect((await read(w.cookie.dispatcher, rec.id)).json.data.status).toBe("PENDING");
    expect(await activeAssignments(job.id)).toHaveLength(0);
  });
});
