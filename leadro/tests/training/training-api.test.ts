import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as listCourses, POST as createCourse } from "@/app/api/v1/training/courses/route";
import { GET as getCourse, PATCH as patchCourse } from "@/app/api/v1/training/courses/[id]/route";
import { POST as archiveCourse } from "@/app/api/v1/training/courses/[id]/archive/route";
import { GET as listAssignments } from "@/app/api/v1/training/assignments/route";
import { GET as getAssignment, PATCH as patchAssignment } from "@/app/api/v1/training/assignments/[id]/route";
import { POST as startAssignment } from "@/app/api/v1/training/assignments/[id]/start/route";
import { POST as cancelAssignment } from "@/app/api/v1/training/assignments/[id]/cancel/route";
import { GET as listRecords } from "@/app/api/v1/training/records/route";
import { GET as getRecord } from "@/app/api/v1/training/records/[id]/route";
import { POST as rejectRecord } from "@/app/api/v1/training/records/[id]/reject/route";
import { POST as revokeRecord } from "@/app/api/v1/training/records/[id]/revoke/route";
import { GET as listExpiring } from "@/app/api/v1/training/records/expiring/route";
import { withTenant } from "@/server/db";
import { buildWorld, disconnect, type World } from "../authz/fixtures";
import { auditEvents, call, sessionCookie } from "../org/org-helpers";
import { assignCourse, newCourse, newTrainingCertification, notificationsOf, recordCourse, selfApprover, tenantToday, unique, verifyRecord } from "./fixtures";

let w: World;
let hr: string;
let ceo: string;
let cityManagerA: string;
let cityManagerB: string;
let dispatcher: string;
let techA1: string;
let techA1Employee: string;

beforeAll(async () => {
  w = await buildWorld("training");
  hr = await sessionCookie(w.hr, w.tenantId);
  ceo = await sessionCookie(w.ceo, w.tenantId);
  cityManagerA = await sessionCookie(w.cityManagerA, w.tenantId);
  cityManagerB = await sessionCookie(w.cityManagerB, w.tenantId);
  dispatcher = await sessionCookie(w.dispatcher, w.tenantId);
  techA1 = await sessionCookie(w.techA1, w.tenantId);
  techA1Employee = w.techA1.employeeId as string;
});
afterAll(disconnect);

const loadQualification = (id: string) => withTenant(w.tenantId, (tx) => tx.employeeQualification.findUniqueOrThrow({ where: { id } }));
const isoOf = (value: Date | null) => (value ? value.toISOString().slice(0, 10) : null);
const ids = (result: { json: { data: Array<{ id: string }> } }) => result.json.data.map((row) => row.id);

describe("course catalog", () => {
  it("HR manages courses; everyone with training.view reads them; managers, dispatchers and technicians cannot change them", async () => {
    const cert = await newTrainingCertification(w.tenantId);
    const course = await newCourse(hr, { category: "safety", certificationId: cert.id, validityDays: 365 });
    expect(course).toMatchObject({ certificationId: cert.id, validityDays: 365 });
    expect((await auditEvents(w.tenantId, "training_course.create", course.id)).length).toBe(1);

    expect((await call(createCourse, "POST", "/x", { cookie: cityManagerA, body: { code: unique("x"), name: "x" } })).status).toBe(403);
    expect((await call(createCourse, "POST", "/x", { cookie: hr, body: { code: course.code, name: "dup" } })).status).toBe(409);
    expect((await call(createCourse, "POST", "/x", { cookie: hr, body: { code: "Bad Code", name: "x" } })).status).toBe(400);

    const listed = await call(listCourses, "GET", "/x", { cookie: techA1, query: { category: "safety" } });
    expect(listed.status).toBe(200);
    expect(ids(listed)).toContain(course.id);
    expect((await call(listCourses, "GET", "/x", { cookie: dispatcher })).status).toBe(403);
    expect((await call(getCourse, "GET", "/x", { cookie: cityManagerA, params: { id: course.id } })).status).toBe(200);

    const patched = await call(patchCourse, "PATCH", "/x", { cookie: hr, params: { id: course.id }, body: { validityDays: 730, category: null } });
    expect(patched.json.data).toMatchObject({ validityDays: 730, category: null });
    expect((await call(patchCourse, "PATCH", "/x", { cookie: hr, params: { id: course.id }, body: { code: "other" } })).status).toBe(400);

    const archived = await call(archiveCourse, "POST", "/x", { cookie: hr, params: { id: course.id }, body: { reason: "replaced" } });
    expect(archived.json.data.active).toBe(false);
    expect((await call(archiveCourse, "POST", "/x", { cookie: hr, params: { id: course.id }, body: {} })).status).toBe(409);
    expect((await call(patchCourse, "PATCH", "/x", { cookie: hr, params: { id: course.id }, body: { name: "y" } })).status).toBe(409);
    expect(ids(await call(listCourses, "GET", "/x", { cookie: hr }))).not.toContain(course.id);
    expect(ids(await call(listCourses, "GET", "/x", { cookie: hr, query: { includeArchived: "true", limit: "200" } }))).toContain(course.id);
  });

  it("only accepts an active TRAINING-type certification", async () => {
    const license = await withTenant(w.tenantId, (tx) => tx.certification.create({ data: { tenantId: w.tenantId, code: unique("lic"), name: "License", type: "LICENSE" } }));
    const result = await call(createCourse, "POST", "/x", { cookie: hr, body: { code: unique("c"), name: "c", certificationId: license.id } });
    expect(result.status).toBe(400);
    expect(result.json.error.field).toBe("certificationId");
  });
});

describe("assignments", () => {
  it("a manager assigns a course in their scope; the employee is notified; one open assignment per course", async () => {
    const course = await newCourse(hr);
    const dueDate = await tenantToday(w.tenantId, 14);
    const created = await assignCourse(cityManagerA, { employeeId: techA1Employee, courseId: course.id, dueDate, note: "before the season" });
    expect(created.status).toBe(201);
    expect(created.json.data).toMatchObject({ status: "ASSIGNED", source: "MANUAL", dueDate, overdue: false, assignedById: w.cityManagerA.userId });
    expect(await notificationsOf(w.tenantId, w.techA1.userId, "training.assigned", created.json.data.id)).toHaveLength(1);
    expect((await auditEvents(w.tenantId, "training_assignment.create", created.json.data.id)).length).toBe(1);

    const duplicate = await assignCourse(hr, { employeeId: techA1Employee, courseId: course.id });
    expect(duplicate.status).toBe(409);
  });

  it("refuses employees outside scope (404), callers without assign (403), past due dates and archived courses (400)", async () => {
    const course = await newCourse(hr);
    expect((await assignCourse(cityManagerA, { employeeId: w.techB.employeeId, courseId: course.id })).status).toBe(404);
    expect((await assignCourse(dispatcher, { employeeId: techA1Employee, courseId: course.id })).status).toBe(403);
    expect((await assignCourse(techA1, { employeeId: techA1Employee, courseId: course.id })).status).toBe(403);
    expect((await assignCourse(cityManagerA, { employeeId: techA1Employee, courseId: course.id, dueDate: await tenantToday(w.tenantId, -2) })).status).toBe(400);
    expect((await assignCourse(cityManagerA, { employeeId: techA1Employee, courseId: course.id, dueDate: "2026-02-31" })).status).toBe(400);
    const archived = await newCourse(hr);
    await call(archiveCourse, "POST", "/x", { cookie: hr, params: { id: archived.id }, body: {} });
    expect((await assignCourse(cityManagerA, { employeeId: techA1Employee, courseId: archived.id })).status).toBe(400);
  });

  it("reads are scoped: the technician sees only their own, another city's manager sees nothing", async () => {
    const course = await newCourse(hr);
    const mine = (await assignCourse(hr, { employeeId: techA1Employee, courseId: course.id })).json.data;
    const other = (await assignCourse(hr, { employeeId: w.techA1Other.employeeId, courseId: course.id })).json.data;

    const own = await call(listAssignments, "GET", "/x", { cookie: techA1, query: { courseId: course.id } });
    expect(ids(own)).toEqual([mine.id]);
    expect((await call(getAssignment, "GET", "/x", { cookie: techA1, params: { id: other.id } })).status).toBe(404);
    expect(ids(await call(listAssignments, "GET", "/x", { cookie: cityManagerB, query: { courseId: course.id } }))).toEqual([]);
    expect((await call(getAssignment, "GET", "/x", { cookie: cityManagerB, params: { id: mine.id } })).status).toBe(404);
    expect(ids(await call(listAssignments, "GET", "/x", { cookie: cityManagerA, query: { courseId: course.id } })).sort()).toEqual([mine.id, other.id].sort());
  });

  it("start, change the due date, cancel with a reason; finished assignments cannot change; overdue is derived", async () => {
    const course = await newCourse(hr);
    const created = (await assignCourse(cityManagerA, { employeeId: techA1Employee, courseId: course.id })).json.data;
    const params = { id: created.id };
    expect((await call(startAssignment, "POST", "/x", { cookie: techA1, params, body: {} })).status).toBe(403);
    expect((await call(startAssignment, "POST", "/x", { cookie: cityManagerA, params, body: {} })).json.data.status).toBe("IN_PROGRESS");
    expect((await call(startAssignment, "POST", "/x", { cookie: cityManagerA, params, body: {} })).status).toBe(409);
    const due = await tenantToday(w.tenantId, 3);
    expect((await call(patchAssignment, "PATCH", "/x", { cookie: cityManagerA, params, body: { dueDate: due } })).json.data.dueDate).toBe(due);
    expect((await call(patchAssignment, "PATCH", "/x", { cookie: cityManagerB, params, body: { note: "x" } })).status).toBe(404);

    // A due date in the past can only exist because time passed: set it in the database and check the derived flag.
    await withTenant(w.tenantId, (tx) => tx.trainingAssignment.update({ where: { id: created.id }, data: { dueDate: new Date("2026-01-05T00:00:00.000Z") } }));
    expect((await call(getAssignment, "GET", "/x", { cookie: cityManagerA, params })).json.data.overdue).toBe(true);
    expect(ids(await call(listAssignments, "GET", "/x", { cookie: cityManagerA, query: { courseId: course.id, overdue: "true" } }))).toEqual([created.id]);

    expect((await call(cancelAssignment, "POST", "/x", { cookie: cityManagerA, params, body: {} })).status).toBe(400);
    const cancelled = await call(cancelAssignment, "POST", "/x", { cookie: cityManagerA, params, body: { reason: "left the team" } });
    expect(cancelled.json.data).toMatchObject({ status: "CANCELLED", cancelReason: "left the team", cancelledById: w.cityManagerA.userId, overdue: false });
    expect((await call(patchAssignment, "PATCH", "/x", { cookie: cityManagerA, params, body: { note: "x" } })).status).toBe(409);
    // A cancelled assignment frees the course for a new one.
    expect((await assignCourse(cityManagerA, { employeeId: techA1Employee, courseId: course.id })).status).toBe(201);
  });
});

describe("records and verification", () => {
  it("HR records a completion with evidence metadata; expiry is the tenant-local completion date plus the validity", async () => {
    const course = await newCourse(hr, { validityDays: 30 });
    const completedAt = new Date(Date.now() - 3_600_000).toISOString();
    const recorded = await recordCourse(hr, {
      employeeId: techA1Employee,
      courseId: course.id,
      completedAt,
      evidence: { reference: "CERT-77", fileName: "card.pdf", contentType: "application/pdf", sizeBytes: 2048, checksumSha256: "a".repeat(64) },
    });
    expect(recorded.status).toBe(201);
    const completedOn = await tenantToday(w.tenantId, -1 / 24);
    const expected = new Date(Date.parse(`${completedOn}T00:00:00.000Z`) + 30 * 86_400_000).toISOString().slice(0, 10);
    expect(recorded.json.data).toMatchObject({ status: "PENDING_VERIFICATION", expiresAt: expected, recordedById: w.hr.userId, qualificationId: null });
    expect(recorded.json.data.evidence).toMatchObject({ reference: "CERT-77", fileName: "card.pdf", sizeBytes: 2048, stored: false });

    expect((await call(getRecord, "GET", "/x", { cookie: techA1, params: { id: recorded.json.data.id } })).status).toBe(200);
    expect((await call(getRecord, "GET", "/x", { cookie: cityManagerB, params: { id: recorded.json.data.id } })).status).toBe(404);
    const queue = await call(listRecords, "GET", "/x", { cookie: hr, query: { status: "PENDING_VERIFICATION", courseId: course.id } });
    expect(ids(queue)).toEqual([recorded.json.data.id]);
  });

  it("refuses managers (no training.create), future completions, half-described files and out-of-scope employees", async () => {
    const course = await newCourse(hr);
    const base = { employeeId: techA1Employee, courseId: course.id, completedAt: new Date().toISOString() };
    expect((await recordCourse(cityManagerA, base)).status).toBe(403);
    expect((await recordCourse(hr, { ...base, completedAt: new Date(Date.now() + 86_400_000).toISOString() })).status).toBe(400);
    expect((await recordCourse(hr, { ...base, evidence: { fileName: "x.pdf" } })).status).toBe(400);
    expect((await recordCourse(hr, { ...base, evidence: { checksumSha256: "b".repeat(64) } })).status).toBe(400);
    expect((await recordCourse(hr, { ...base, courseId: "nope" })).status).toBe(400);
  });

  it("verifying completes the open assignment and creates the TRAINING qualification the eligibility engine reads", async () => {
    const cert = await newTrainingCertification(w.tenantId);
    const course = await newCourse(hr, { certificationId: cert.id, validityDays: 365 });
    const assignment = (await assignCourse(cityManagerA, { employeeId: techA1Employee, courseId: course.id })).json.data;
    const record = (await recordCourse(hr, { employeeId: techA1Employee, courseId: course.id, completedAt: new Date().toISOString() })).json.data;

    expect((await verifyRecord(cityManagerA, record.id)).status).toBe(403);
    const verified = await verifyRecord(hr, record.id);
    expect(verified.status).toBe(200);
    expect(verified.json.data).toMatchObject({ status: "VERIFIED", verifiedById: w.hr.userId });
    expect((await verifyRecord(hr, record.id)).status).toBe(409);

    const qualification = await loadQualification(verified.json.data.qualificationId);
    expect(qualification).toMatchObject({ kind: "TRAINING", certificationId: cert.id, status: "VERIFIED", employeeId: techA1Employee });
    expect(isoOf(qualification.expiresAt)).toBe(record.expiresAt);

    const completed = (await call(getAssignment, "GET", "/x", { cookie: cityManagerA, params: { id: assignment.id } })).json.data;
    expect(completed).toMatchObject({ status: "COMPLETED", trainingRecordId: record.id });
    const [event] = await auditEvents(w.tenantId, "training_record.verify", record.id);
    expect(event.newValue).toMatchObject({ qualificationOutcome: "CREATED", completedAssignmentId: assignment.id });
  });

  it("a later completion renews the qualification; revoking it falls back to the earlier one; revoking the last revokes it", async () => {
    const cert = await newTrainingCertification(w.tenantId);
    const shortCourse = await newCourse(hr, { certificationId: cert.id, validityDays: 100 });
    const longCourse = await newCourse(hr, { certificationId: cert.id, validityDays: 400 });
    const employeeId = w.techA1Other.employeeId as string;
    const first = (await recordCourse(hr, { employeeId, courseId: shortCourse.id, completedAt: new Date().toISOString() })).json.data;
    const firstVerified = (await verifyRecord(hr, first.id)).json.data;
    const second = (await recordCourse(hr, { employeeId, courseId: longCourse.id, completedAt: new Date().toISOString() })).json.data;
    const secondVerified = (await verifyRecord(hr, second.id)).json.data;
    expect(secondVerified.qualificationId).toBe(firstVerified.qualificationId);
    const qualificationId = firstVerified.qualificationId as string;
    expect(isoOf((await loadQualification(qualificationId)).expiresAt)).toBe(second.expiresAt);

    expect((await call(revokeRecord, "POST", "/x", { cookie: hr, params: { id: second.id }, body: {} })).status).toBe(400);
    const revoked = await call(revokeRecord, "POST", "/x", { cookie: hr, params: { id: second.id }, body: { reason: "fake certificate" } });
    expect(revoked.json.data).toMatchObject({ status: "REVOKED", decisionReason: "fake certificate" });
    const restated = await loadQualification(qualificationId);
    expect([restated.status, isoOf(restated.expiresAt)]).toEqual(["VERIFIED", first.expiresAt]);

    await call(revokeRecord, "POST", "/x", { cookie: hr, params: { id: first.id }, body: { reason: "also invalid" } });
    expect((await loadQualification(qualificationId)).status).toBe("REVOKED");
    expect((await call(revokeRecord, "POST", "/x", { cookie: hr, params: { id: first.id }, body: { reason: "again" } })).status).toBe(409);
  });

  it("rejection needs a reason, keeps the assignment open and grants nothing; nobody decides on their own record", async () => {
    const cert = await newTrainingCertification(w.tenantId);
    const course = await newCourse(hr, { certificationId: cert.id });
    const assignment = (await assignCourse(hr, { employeeId: techA1Employee, courseId: course.id })).json.data;
    const record = (await recordCourse(hr, { employeeId: techA1Employee, courseId: course.id, completedAt: new Date().toISOString() })).json.data;
    expect((await call(rejectRecord, "POST", "/x", { cookie: hr, params: { id: record.id }, body: {} })).status).toBe(400);
    const rejected = await call(rejectRecord, "POST", "/x", { cookie: ceo, params: { id: record.id }, body: { reason: "wrong course" } });
    expect(rejected.json.data).toMatchObject({ status: "REJECTED", decisionReason: "wrong course", qualificationId: null, verifiedById: w.ceo.userId });
    expect((await call(getAssignment, "GET", "/x", { cookie: hr, params: { id: assignment.id } })).json.data.status).toBe("ASSIGNED");
    expect((await verifyRecord(hr, record.id)).status).toBe(409);

    const self = await selfApprover(w);
    const own = await recordCourse(self.cookie, { employeeId: self.employeeId, courseId: course.id, completedAt: new Date().toISOString() });
    expect(own.status).toBe(201);
    expect((await verifyRecord(self.cookie, own.json.data.id)).status).toBe(403);
    expect((await verifyRecord(hr, own.json.data.id)).status).toBe(200);
  });

  it("an already-expired completion is verified as history without granting a qualification", async () => {
    const cert = await newTrainingCertification(w.tenantId);
    const course = await newCourse(hr, { certificationId: cert.id, validityDays: 10 });
    const longAgo = new Date(Date.now() - 60 * 86_400_000).toISOString();
    const record = (await recordCourse(hr, { employeeId: w.techB.employeeId, courseId: course.id, completedAt: longAgo })).json.data;
    const verified = await verifyRecord(hr, record.id);
    expect(verified.json.data).toMatchObject({ status: "VERIFIED", qualificationId: null });
    const [event] = await auditEvents(w.tenantId, "training_record.verify", record.id);
    expect(event.newValue).toMatchObject({ qualificationOutcome: "EXPIRED" });
  });
});

describe("expiring records", () => {
  it("lists verified completions expiring within the window with days remaining, leaving superseded and pending ones out", async () => {
    const course = await newCourse(hr, { validityDays: 5 });
    const employeeId = w.techA1Other.employeeId as string;
    const soon = (await recordCourse(hr, { employeeId, courseId: course.id, completedAt: new Date().toISOString() })).json.data;
    await verifyRecord(hr, soon.id);
    const pending = (await recordCourse(hr, { employeeId: techA1Employee, courseId: course.id, completedAt: new Date().toISOString() })).json.data;

    const listed = await call(listExpiring, "GET", "/x", { cookie: cityManagerA, query: { courseId: course.id, withinDays: "10" } });
    expect(listed.status).toBe(200);
    expect(listed.json.data.map((row: { id: string; daysRemaining: number }) => [row.id, row.daysRemaining])).toEqual([[soon.id, 5]]);
    expect(ids(listed)).not.toContain(pending.id);
    expect(ids(await call(listExpiring, "GET", "/x", { cookie: cityManagerA, query: { courseId: course.id, withinDays: "2" } }))).toEqual([]);
    expect(ids(await call(listExpiring, "GET", "/x", { cookie: cityManagerB, query: { courseId: course.id, withinDays: "10" } }))).toEqual([]);

    // A newer, longer-lasting completion of the same course supersedes it.
    await call(patchCourse, "PATCH", "/x", { cookie: hr, params: { id: course.id }, body: { validityDays: 300 } });
    const renewal = (await recordCourse(hr, { employeeId, courseId: course.id, completedAt: new Date().toISOString() })).json.data;
    await verifyRecord(hr, renewal.id);
    expect(ids(await call(listExpiring, "GET", "/x", { cookie: hr, query: { courseId: course.id, withinDays: "10" } }))).toEqual([]);
  });
});
