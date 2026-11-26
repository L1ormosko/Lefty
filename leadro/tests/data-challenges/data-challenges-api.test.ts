import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as listChallenges, POST as raise } from "@/app/api/v1/data-challenges/route";
import { GET as getChallenge } from "@/app/api/v1/data-challenges/[id]/route";
import { POST as assign } from "@/app/api/v1/data-challenges/[id]/assign/route";
import { POST as uphold } from "@/app/api/v1/data-challenges/[id]/uphold/route";
import { POST as reject } from "@/app/api/v1/data-challenges/[id]/reject/route";
import { POST as withdraw } from "@/app/api/v1/data-challenges/[id]/withdraw/route";
import { POST as createRecord } from "@/app/api/v1/coaching/records/route";
import { POST as rejectQualification } from "@/app/api/v1/qualifications/[id]/reject/route";
import { POST as rejectTrainingRecord } from "@/app/api/v1/training/records/[id]/reject/route";
import { GET as listNotifications } from "@/app/api/v1/notifications/route";
import { withTenant } from "@/server/db";
import { buildWorld, disconnect, type World } from "../authz/fixtures";
import { createMetricValue, createQualificationRecord, createTrainingRecord } from "../coaching/fixtures";
import { auditEvents, call, sessionCookie } from "../org/org-helpers";

let w: World;
let hr: string;
let ceo: string;
let cityManagerA: string;
let cityManagerB: string;
let dispatcher: string;
let techA1: string;
let techA1Other: string;

beforeAll(async () => {
  w = await buildWorld("challenges");
  hr = await sessionCookie(w.hr, w.tenantId);
  ceo = await sessionCookie(w.ceo, w.tenantId);
  cityManagerA = await sessionCookie(w.cityManagerA, w.tenantId);
  cityManagerB = await sessionCookie(w.cityManagerB, w.tenantId);
  dispatcher = await sessionCookie(w.dispatcher, w.tenantId);
  techA1 = await sessionCookie(w.techA1, w.tenantId);
  techA1Other = await sessionCookie(w.techA1Other, w.tenantId);
});
afterAll(disconnect);

const techA1Employee = () => w.techA1.employeeId as string;
const raiseAs = (cookie: string, body: Record<string, unknown>) => call(raise, "POST", "/x", { cookie, body });
const assignTo = (cookie: string, id: string, reviewerUserId: string) => call(assign, "POST", "/x", { cookie, params: { id }, body: { reviewerUserId } });
const upholdAs = (cookie: string, id: string, body: Record<string, unknown>) => call(uphold, "POST", "/x", { cookie, params: { id }, body });
const notificationsOf = (userId: string, eventType: string) =>
  withTenant(w.tenantId, (tx) => tx.notification.findMany({ where: { recipientId: userId, eventType } }));

async function metricChallenge(statement = "Two of these were cancelled by the customer.") {
  const value = await createMetricValue(w.tenantId, techA1Employee(), w.hr.userId);
  const raised = await raiseAs(techA1, { targetType: "PERFORMANCE_METRIC_VALUE", targetId: value.id, statement });
  expect(raised.status).toBe(201);
  return { value, challenge: raised.json.data as { id: string } };
}

async function underReview() {
  const { challenge } = await metricChallenge();
  expect((await assignTo(cityManagerA, challenge.id, w.hr.userId)).status).toBe(200);
  return challenge;
}

describe("raising a challenge (self-service)", () => {
  it("an employee challenges their own published metric value; routers are notified; the statement is not audited", async () => {
    const { value, challenge } = await metricChallenge("The numbers miss my Tuesday jobs.");
    const stored = await call(getChallenge, "GET", "/x", { cookie: hr, params: { id: challenge.id } });
    expect(stored.json.data).toMatchObject({
      status: "OPEN",
      employeeId: techA1Employee(),
      raisedById: w.techA1.userId,
      targetType: "PERFORMANCE_METRIC_VALUE",
      targetId: value.id,
      metricValueId: value.id,
      reviewerId: null,
    });
    const [event] = await auditEvents(w.tenantId, "data_challenge.raise", challenge.id);
    expect(event.actorUserId).toBe(w.techA1.userId);
    expect(JSON.stringify(event)).not.toContain("Tuesday");

    const toManager = await notificationsOf(w.cityManagerA.userId, "data_challenge.raised");
    expect(toManager.map((row) => row.targetId)).toContain(challenge.id);
    expect((await notificationsOf(w.hr.userId, "data_challenge.raised")).map((row) => row.targetId)).toContain(challenge.id);
    expect((await notificationsOf(w.cityManagerB.userId, "data_challenge.raised")).map((row) => row.targetId)).not.toContain(challenge.id);
    expect((await notificationsOf(w.techA1.userId, "data_challenge.raised")).length).toBe(0);
  });

  it("refuses another employee's record, an unpublished value and an unshared coaching note (404), a second open challenge (409)", async () => {
    const othersValue = await createMetricValue(w.tenantId, w.techA1Other.employeeId as string, w.hr.userId);
    expect((await raiseAs(techA1, { targetType: "PERFORMANCE_METRIC_VALUE", targetId: othersValue.id, statement: "x" })).status).toBe(404);
    const draftValue = await createMetricValue(w.tenantId, techA1Employee(), w.hr.userId, { published: false });
    expect((await raiseAs(techA1, { targetType: "PERFORMANCE_METRIC_VALUE", targetId: draftValue.id, statement: "x" })).status).toBe(404);
    const privateNote = await call(createRecord, "POST", "/x", { cookie: cityManagerA, body: { employeeId: techA1Employee(), body: "Private" } });
    expect((await raiseAs(techA1, { targetType: "COACHING_RECORD", targetId: privateNote.json.data.id, statement: "x" })).status).toBe(404);
    // A record of the wrong type under a valid id is not found either.
    expect((await raiseAs(techA1, { targetType: "TRAINING_RECORD", targetId: othersValue.id, statement: "x" })).status).toBe(404);

    const { value } = await metricChallenge();
    expect((await raiseAs(techA1, { targetType: "PERFORMANCE_METRIC_VALUE", targetId: value.id, statement: "again" })).status).toBe(409);
  });

  it("refuses an account without an employee record (403) and bad input (400)", async () => {
    const value = await createMetricValue(w.tenantId, techA1Employee(), w.hr.userId);
    expect((await raiseAs(hr, { targetType: "PERFORMANCE_METRIC_VALUE", targetId: value.id, statement: "x" })).status).toBe(403);
    expect((await raiseAs(techA1, { targetType: "JOB", targetId: value.id, statement: "x" })).status).toBe(400);
    expect((await raiseAs(techA1, { targetType: "PERFORMANCE_METRIC_VALUE", targetId: value.id, statement: " " })).status).toBe(400);
    expect((await call(raise, "POST", "/x", { body: { targetType: "PERFORMANCE_METRIC_VALUE", targetId: value.id, statement: "x" } })).status).toBe(401);
  });

  it("the raiser withdraws an open challenge; nobody else can; a withdrawn challenge stays", async () => {
    const { challenge } = await metricChallenge();
    expect((await call(withdraw, "POST", "/x", { cookie: techA1Other, params: { id: challenge.id } })).status).toBe(404);
    expect((await call(withdraw, "POST", "/x", { cookie: hr, params: { id: challenge.id } })).status).toBe(404);
    const withdrawn = await call(withdraw, "POST", "/x", { cookie: techA1, params: { id: challenge.id } });
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.json.data.status).toBe("WITHDRAWN");
    expect(withdrawn.json.data.withdrawnAt).toBeTruthy();
    expect((await call(withdraw, "POST", "/x", { cookie: techA1, params: { id: challenge.id } })).status).toBe(409);
    expect((await assignTo(cityManagerA, challenge.id, w.hr.userId)).status).toBe(409);
    await expect(withTenant(w.tenantId, (tx) => tx.dataChallenge.delete({ where: { id: challenge.id } }))).rejects.toThrow(/never deleted/);
  });
});

describe("reading challenges", () => {
  it("is scoped by the challenged employee and needs data_challenges.view", async () => {
    const { challenge } = await metricChallenge();
    const listedIds = async (cookie: string) => (await call(listChallenges, "GET", "/x", { cookie, query: { status: "OPEN" } })).json.data?.map((row: { id: string }) => row.id);
    expect(await listedIds(hr)).toContain(challenge.id);
    expect(await listedIds(cityManagerA)).toContain(challenge.id);
    expect(await listedIds(cityManagerB)).not.toContain(challenge.id);
    expect((await call(getChallenge, "GET", "/x", { cookie: cityManagerB, params: { id: challenge.id } })).status).toBe(404);
    expect((await call(listChallenges, "GET", "/x", { cookie: techA1 })).status).toBe(403);
    expect((await call(listChallenges, "GET", "/x", { cookie: dispatcher })).status).toBe(403);
  });
});

describe("routing to a reviewer", () => {
  it("a manager routes it to HR; the reviewer is notified; re-routing keeps it under review", async () => {
    const { challenge } = await metricChallenge();
    const assigned = await assignTo(cityManagerA, challenge.id, w.hr.userId);
    expect(assigned.status).toBe(200);
    expect(assigned.json.data).toMatchObject({ status: "UNDER_REVIEW", reviewerId: w.hr.userId });
    expect((await notificationsOf(w.hr.userId, "data_challenge.assigned")).map((row) => row.targetId)).toContain(challenge.id);
    expect((await auditEvents(w.tenantId, "data_challenge.assign", challenge.id)).length).toBe(1);
    // The link survives the read-time access check for someone who may see the challenge.
    const inbox = (await call(listNotifications, "GET", "/x", { cookie: hr, query: { limit: "200" } })).json.data as Array<{ eventType: string; targetId: string | null; redacted: boolean }>;
    expect(inbox.find((row) => row.eventType === "data_challenge.assigned" && row.targetId === challenge.id)?.redacted).toBe(false);

    const rerouted = await assignTo(hr, challenge.id, w.ceo.userId);
    expect(rerouted.json.data).toMatchObject({ status: "UNDER_REVIEW", reviewerId: w.ceo.userId });
    expect((await notificationsOf(w.ceo.userId, "data_challenge.assigned")).map((row) => row.targetId)).toContain(challenge.id);
  });

  it("refuses a reviewer who cannot decide, the raiser and the employee (400), and callers outside the scope or without assign", async () => {
    const { challenge } = await metricChallenge();
    for (const reviewer of [w.cityManagerA.userId, w.techA1.userId, w.dispatcher.userId, "nope"]) {
      const refused = await assignTo(cityManagerA, challenge.id, reviewer);
      expect(refused.status).toBe(400);
      expect(refused.json.error.field).toBe("reviewerUserId");
    }
    expect((await assignTo(cityManagerB, challenge.id, w.hr.userId)).status).toBe(404);
    expect((await assignTo(techA1, challenge.id, w.hr.userId)).status).toBe(403);
    expect((await assignTo(dispatcher, challenge.id, w.hr.userId)).status).toBe(403);
  });
});

describe("deciding", () => {
  it("only the assigned reviewer upholds; an annotation is stored and the employee is notified without a link", async () => {
    const challenge = await underReview();
    expect((await upholdAs(cityManagerA, challenge.id, { resolutionKind: "ANNOTATED", resolution: "x" })).status).toBe(403);
    expect((await upholdAs(ceo, challenge.id, { resolutionKind: "ANNOTATED", resolution: "x" })).status).toBe(403);
    const upheld = await upholdAs(hr, challenge.id, { resolutionKind: "ANNOTATED", resolution: "Two jobs were customer cancellations." });
    expect(upheld.status).toBe(200);
    expect(upheld.json.data).toMatchObject({ status: "UPHELD", resolutionKind: "ANNOTATED", resolution: "Two jobs were customer cancellations.", resolvedById: w.hr.userId });
    const [notice] = await notificationsOf(w.techA1.userId, "data_challenge.decided").then((rows) => rows.filter((row) => row.eventId === `${challenge.id}:decided`));
    expect(notice).toMatchObject({ targetType: null, targetId: null });
    const [event] = await auditEvents(w.tenantId, "data_challenge.uphold", challenge.id);
    expect(JSON.stringify(event)).not.toContain("cancellations");
    expect((await upholdAs(hr, challenge.id, { resolutionKind: "ANNOTATED", resolution: "again" })).status).toBe(409);
  });

  it("an open challenge must be routed before it is decided", async () => {
    const { challenge } = await metricChallenge();
    expect((await upholdAs(hr, challenge.id, { resolutionKind: "ANNOTATED", resolution: "x" })).status).toBe(409);
  });

  it("rejects with a reason shown to the employee", async () => {
    const challenge = await underReview();
    expect((await call(reject, "POST", "/x", { cookie: cityManagerA, params: { id: challenge.id }, body: { reason: "x" } })).status).toBe(403);
    const rejected = await call(reject, "POST", "/x", { cookie: hr, params: { id: challenge.id }, body: { reason: "The jobs were counted correctly." } });
    expect(rejected.status).toBe(200);
    expect(rejected.json.data).toMatchObject({ status: "REJECTED", resolution: "The jobs were counted correctly.", resolutionKind: null });
    expect((await notificationsOf(w.techA1.userId, "data_challenge.decided")).map((row) => row.eventId)).toContain(`${challenge.id}:decided`);
  });

  it("metric values can be annotated but not marked corrected (no correction API yet)", async () => {
    const challenge = await underReview();
    const refused = await upholdAs(hr, challenge.id, { resolutionKind: "CORRECTED", resolution: "Fixed" });
    expect(refused.status).toBe(400);
    expect(refused.json.error.field).toBe("resolutionKind");
    expect((await upholdAs(hr, challenge.id, { resolutionKind: "ANNOTATED", resolution: "Two were customer cancellations." })).status).toBe(200);
  });

  it("a training record is corrected through the training module's reject / revoke; the uphold names that audit event", async () => {
    const record = await createTrainingRecord(w.tenantId, techA1Employee(), w.hr.userId);
    const raised = await raiseAs(techA1, { targetType: "TRAINING_RECORD", targetId: record.id, statement: "I completed it in February." });
    expect(raised.status).toBe(201);
    const id = raised.json.data.id;
    await assignTo(hr, id, w.hr.userId);
    expect((await upholdAs(hr, id, { resolutionKind: "CORRECTED", resolution: "x" })).json.error.field).toBe("correctionAuditEventId");
    // Another action on the record (here the challenge's own audit event is about something else entirely) is not proof.
    const [unrelated] = await auditEvents(w.tenantId, "data_challenge.raise", id);
    expect((await upholdAs(hr, id, { resolutionKind: "CORRECTED", resolution: "x", correctionAuditEventId: unrelated.id })).status).toBe(400);

    const rejected = await call(rejectTrainingRecord, "POST", "/x", { cookie: hr, params: { id: record.id }, body: { reason: "Wrong completion date" } });
    expect(rejected.status).toBe(200);
    const [correction] = await auditEvents(w.tenantId, "training_record.reject", record.id);
    const upheld = await upholdAs(hr, id, { resolutionKind: "CORRECTED", resolution: "Rejected; please record the February completion.", correctionAuditEventId: correction.id });
    expect(upheld.status).toBe(200);
    expect(upheld.json.data.resolutionDetails).toEqual({ auditEventId: correction.id, action: "training_record.reject" });
  });

  it("a shared coaching note is corrected through the coaching module: the challenged version is archived, a corrected copy is created", async () => {
    const note = (await call(createRecord, "POST", "/x", { cookie: cityManagerA, body: { employeeId: techA1Employee(), body: "Late three times.", shareWithEmployee: true } })).json.data;
    const raised = await raiseAs(techA1, { targetType: "COACHING_RECORD", targetId: note.id, statement: "It was twice." });
    expect(raised.status).toBe(201);
    const id = raised.json.data.id;
    await assignTo(cityManagerA, id, w.hr.userId);
    expect((await upholdAs(hr, id, { resolutionKind: "CORRECTED", resolution: "Corrected to twice." })).json.error.field).toBe("correctedBody");

    const upheld = await upholdAs(hr, id, { resolutionKind: "CORRECTED", resolution: "Corrected to twice.", correctedBody: "Late twice." });
    expect(upheld.status).toBe(200);
    const details = upheld.json.data.resolutionDetails as { auditEventId: string; correctedCoachingRecordId: string };
    const [correction] = await auditEvents(w.tenantId, "coaching_record.correct", note.id);
    expect(details.auditEventId).toBe(correction.id);
    const [original, corrected] = await withTenant(w.tenantId, (tx) =>
      Promise.all([tx.coachingRecord.findUniqueOrThrow({ where: { id: note.id } }), tx.coachingRecord.findUniqueOrThrow({ where: { id: details.correctedCoachingRecordId } })]),
    );
    expect(original.body).toBe("Late three times.");
    expect(original.archivedAt).not.toBeNull();
    expect(corrected).toMatchObject({ body: "Late twice.", employeeId: techA1Employee(), sharedWithEmployee: true, authorId: w.hr.userId, archivedAt: null });
    expect(JSON.stringify(correction)).not.toContain("Late");
  });

  it("a qualification is corrected through the qualifications API first; the uphold names that audit event", async () => {
    const qualification = await createQualificationRecord(w.tenantId, techA1Employee());
    const raised = await raiseAs(techA1, { targetType: "EMPLOYEE_QUALIFICATION", targetId: qualification.id, statement: "My level is 4." });
    const id = raised.json.data.id;
    await assignTo(hr, id, w.hr.userId);
    expect((await upholdAs(hr, id, { resolutionKind: "CORRECTED", resolution: "x" })).json.error.field).toBe("correctionAuditEventId");
    // An audit event about something else is not proof of this correction.
    const [unrelated] = await auditEvents(w.tenantId, "data_challenge.raise", id);
    expect((await upholdAs(hr, id, { resolutionKind: "CORRECTED", resolution: "x", correctionAuditEventId: unrelated.id })).status).toBe(400);

    expect((await call(rejectQualification, "POST", "/x", { cookie: hr, params: { id: qualification.id }, body: { reason: "Wrong level recorded" } })).status).toBe(200);
    const [correction] = await auditEvents(w.tenantId, "qualification.reject", qualification.id);
    const upheld = await upholdAs(hr, id, { resolutionKind: "CORRECTED", resolution: "Sent back for re-recording.", correctionAuditEventId: correction.id });
    expect(upheld.status).toBe(200);
    expect(upheld.json.data.resolutionDetails).toEqual({ auditEventId: correction.id, action: "qualification.reject" });
  });
});
