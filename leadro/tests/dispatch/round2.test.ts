import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as assignRoute } from "@/app/api/v1/jobs/[id]/assign/route";
import { lockJob } from "@/server/jobs";
import { withTenant } from "@/server/db";
import { createPerson, disconnect, grantTemplate } from "../authz/fixtures";
import { createJobViaApi } from "../jobs/fixtures";
import { call, sessionCookie } from "../org/org-helpers";
import { approve, buildDispatchWorld, candidates, generate, modify, read, type DispatchWorld } from "./fixtures";

let w: DispatchWorld;
beforeAll(async () => {
  w = await buildDispatchWorld("dispatch-round2");
});
afterAll(disconnect);

const inspectionJob = () => createJobViaApi(w, w.inspectionBody);

describe("counts that explain an empty or partial result", () => {
  it("a tenant-wide caller has nobody outside their scope", async () => {
    const job = await inspectionJob();
    const overview = (await candidates(w.cookie.ceo, job.id)).json.data;
    expect(overview.outOfScopeCount).toBe(0);
    const rec = (await generate(w.cookie.ceo, job.id)).json.data;
    expect(rec.outOfScopeCount).toBe(0);
    expect(rec.hiddenCandidateCount).toBe(0);
  });

  it("counts visible employees with neither a territory nor a permission as not relevant (not candidates)", async () => {
    const job = await inspectionJob();
    const overview = (await candidates(w.cookie.ceo, job.id)).json.data;
    expect(overview.notRelevantCount).toBeGreaterThanOrEqual(1); // techB: no territory, no permission
    expect(overview.blocked.map((entry: { employeeId: string }) => entry.employeeId)).not.toContain(w.techB.employeeId);
  });
});

describe("generation takes the job lock", () => {
  it("waits for an assignment in flight and then sees it", async () => {
    const job = await inspectionJob();
    let generated: ReturnType<typeof generate> | undefined;
    let finishedEarly = false;
    await withTenant(w.tenantId, async (tx) => {
      await lockJob(tx, w.tenantId, job.id);
      generated = generate(w.cookie.dispatcher, job.id).then((result) => {
        finishedEarly = true;
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(finishedEarly).toBe(false); // blocked behind our lock
      await tx.jobAssignment.create({ data: { tenantId: w.tenantId, jobId: job.id, employeeId: w.techA1.employeeId as string } });
    });
    const response = await (generated as ReturnType<typeof generate>);
    expect(response.status).toBe(201);
    // The picture was read AFTER the assignment committed: the holder is not offered again.
    expect(response.json.data.candidates.map((candidate: { employeeId: string }) => candidate.employeeId)).not.toContain(w.techA1.employeeId);
  });

  it("a recommendation generated before a later assignment is stale even though clocks cannot tell (snapshot by id)", async () => {
    const job = await inspectionJob();
    const rec = (await generate(w.cookie.dispatcher, job.id)).json.data;
    // Backdated assignedAt: a timestamp comparison would call this "older than the recommendation".
    await withTenant(w.tenantId, (tx) =>
      tx.jobAssignment.create({ data: { tenantId: w.tenantId, jobId: job.id, employeeId: w.techA1Other.employeeId as string, assignedAt: new Date(Date.now() - 3_600_000) } }),
    );
    const response = await approve(w.cookie.dispatcher, rec.id);
    expect(response.status).toBe(409);
    expect(response.json.error.details[0].code).toBe("STALE_RECOMMENDATION");
  });
});

describe("reading and deciding edge cases", () => {
  it("tolerates a recommendation stored as a bare ranked array", async () => {
    const job = await inspectionJob();
    const row = await withTenant(w.tenantId, (tx) =>
      tx.dispatchRecommendation.create({
        data: { tenantId: w.tenantId, jobId: job.id, mode: "AI_ASSISTED", candidates: [{ employeeId: w.techA1.employeeId, rank: 1, score: 50, factors: [], conflicts: [] }] },
      }),
    );
    const view = (await read(w.cookie.dispatcher, row.id)).json.data;
    expect(view.candidates).toHaveLength(1);
    expect(view.scoringVersion).toBe(0);
  });

  it("does not tell a narrower viewer who was chosen when they may not see that person", async () => {
    const job = await inspectionJob();
    const rec = (await generate(w.cookie.ceo, job.id)).json.data;
    const done = await modify(w.cookie.ceo, rec.id, { employeeId: w.techB.employeeId, reason: "Only one", override: { reason: "Urgent" } });
    expect(done.status).toBe(200);
    expect((await read(w.cookie.ceo, rec.id)).json.data.chosenEmployeeId).toBe(w.techB.employeeId);
    expect((await read(w.cookie.cityManagerA, rec.id)).json.data.chosenEmployeeId).toBeNull();
  });

  it("approving a truncated pass with nobody ranked says the evaluation was incomplete", async () => {
    const job = await inspectionJob();
    const row = await withTenant(w.tenantId, (tx) =>
      tx.dispatchRecommendation.create({
        data: {
          tenantId: w.tenantId,
          jobId: job.id,
          mode: "AI_ASSISTED",
          candidates: { scoringVersion: 1, evaluatedCount: 5000, outOfScopeCount: 0, notRelevantCount: 0, poolTruncated: true, ranked: [] },
        },
      }),
    );
    const response = await approve(w.cookie.dispatcher, row.id);
    expect(response.status).toBe(409);
    expect(response.json.error.details[0].code).toBe("EVALUATION_INCOMPLETE");
  });
});

describe("assigning a team (jobs)", () => {
  it("is refused (404) when a current member is outside the caller's employee scope, and works for a caller who sees everyone", async () => {
    const otherEntity = await withTenant(w.tenantId, (tx) => tx.legalEntity.create({ data: { tenantId: w.tenantId, name: "Other LE" } }));
    await createPerson(w.tenantId, "foreign-member", { orgUnitId: w.units.teamA1, legalEntityId: otherEntity.id });

    // A dispatcher limited to the company's own legal entity cannot see the foreign member of the team.
    const limited = await createPerson(w.tenantId, "le-dispatcher", { orgUnitId: w.units.state, legalEntityId: w.legalEntityId });
    await grantTemplate(w.tenantId, limited, w.roles.DISPATCHER, [{ type: "LEGAL_ENTITY", legalEntityId: w.legalEntityId }]);
    const limitedCookie = await sessionCookie(limited, w.tenantId);

    const job = await inspectionJob();
    const assignTeam = (cookie: string) => call(assignRoute, "POST", "/x", { cookie, params: { id: job.id }, body: { teamOrgUnitId: w.units.teamA1 } });
    expect((await assignTeam(limitedCookie)).status).toBe(404);
    expect((await assignTeam(w.cookie.dispatcher)).status).toBe(200);
  });
});
