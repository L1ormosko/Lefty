import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as listRecords, POST as createRecord } from "@/app/api/v1/coaching/records/route";
import { GET as getRecord, PATCH as patchRecord } from "@/app/api/v1/coaching/records/[id]/route";
import { POST as shareRecord } from "@/app/api/v1/coaching/records/[id]/share/route";
import { POST as archiveRecord } from "@/app/api/v1/coaching/records/[id]/archive/route";
import { GET as listNotes, POST as createNote } from "@/app/api/v1/coaching/context-notes/route";
import { GET as getNote } from "@/app/api/v1/coaching/context-notes/[id]/route";
import { POST as shareNote } from "@/app/api/v1/coaching/context-notes/[id]/share/route";
import { POST as archiveNote } from "@/app/api/v1/coaching/context-notes/[id]/archive/route";
import { textDigest } from "@/server/coaching";
import { withTenant } from "@/server/db";
import { buildWorld, createPerson, disconnect, grantTemplate, makeRole, type World } from "../authz/fixtures";
import { auditEvents, call, sessionCookie } from "../org/org-helpers";
import { createMetricValue } from "./fixtures";

let w: World;
let hr: string;
let cityManagerA: string;
let cityManagerB: string;
let dispatcher: string;
let techA1: string;
let plainViewer: string;
let selfCoach: { cookie: string; employeeId: string };

const ids = (result: { json: { data: Array<{ id: string }> } }) => result.json.data.map((row) => row.id);

beforeAll(async () => {
  w = await buildWorld("coaching");
  hr = await sessionCookie(w.hr, w.tenantId);
  cityManagerA = await sessionCookie(w.cityManagerA, w.tenantId);
  cityManagerB = await sessionCookie(w.cityManagerB, w.tenantId);
  dispatcher = await sessionCookie(w.dispatcher, w.tenantId);
  techA1 = await sessionCookie(w.techA1, w.tenantId);

  // Metric values without the coaching set (the COO's "Performance: View"): never sees context notes.
  const plainRole = await makeRole(w.tenantId, "plain performance viewer", [{ permission: "performance.view" }, { permission: "performance.edit" }]);
  const plain = await createPerson(w.tenantId, "plain-viewer", { withEmployee: false });
  await grantTemplate(w.tenantId, plain, plainRole, [{ type: "TENANT" }]);
  plainViewer = await sessionCookie(plain, w.tenantId);

  // A coach who is also an employee, to prove nobody coaches themselves.
  const coachRole = await makeRole(w.tenantId, "self coach", [
    { permission: "coaching.create" },
    { permission: "coaching.view" },
    { permission: "performance.edit", conditions: { includeFields: ["coaching"] } },
  ]);
  const person = await createPerson(w.tenantId, "self-coach", { orgUnitId: w.units.cityA, legalEntityId: w.legalEntityId });
  await grantTemplate(w.tenantId, person, coachRole, [{ type: "TENANT" }]);
  selfCoach = { cookie: await sessionCookie(person, w.tenantId), employeeId: person.employeeId as string };
});
afterAll(disconnect);

const record = (cookie: string, body: Record<string, unknown>) => call(createRecord, "POST", "/x", { cookie, body });

describe("coaching records", () => {
  it("a manager writes a private note about an employee in scope; it is audited without its text", async () => {
    const created = await record(cityManagerA, { employeeId: w.techA1.employeeId, body: "Talked about arrival windows." });
    expect(created.status).toBe(201);
    expect(created.json.data).toMatchObject({ employeeId: w.techA1.employeeId, authorId: w.cityManagerA.userId, sharedWithEmployee: false, sharedAt: null });
    const [event] = await auditEvents(w.tenantId, "coaching_record.create", created.json.data.id);
    expect(event.actorUserId).toBe(w.cityManagerA.userId);
    expect(JSON.stringify(event.newValue)).not.toContain("arrival windows");
    expect(event.newValue).toMatchObject({ bodySha256: textDigest("Talked about arrival windows."), sharedWithEmployee: false });
  });

  it("refuses employees outside the scope (404), callers without the permission (403), self-coaching (403) and bad input (400)", async () => {
    expect((await record(cityManagerA, { employeeId: w.techB.employeeId, body: "x" })).status).toBe(404);
    expect((await record(dispatcher, { employeeId: w.techA1.employeeId, body: "x" })).status).toBe(403);
    expect((await record(techA1, { employeeId: w.techA1.employeeId, body: "x" })).status).toBe(403);
    expect((await record(selfCoach.cookie, { employeeId: selfCoach.employeeId, body: "x" })).status).toBe(403);
    expect((await record(cityManagerA, { employeeId: w.techA1.employeeId, body: "   " })).status).toBe(400);
    expect((await record(cityManagerA, { employeeId: w.techA1.employeeId, body: "x", salary: 1 })).status).toBe(400);
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect((await record(cityManagerA, { employeeId: w.techA1.employeeId, body: "x", occurredAt: future })).status).toBe(400);
  });

  it("a linked metric value must be the same employee's", async () => {
    const value = await createMetricValue(w.tenantId, w.techA1.employeeId as string, w.hr.userId);
    const other = await record(cityManagerA, { employeeId: w.techA1Other.employeeId, body: "x", metricValueId: value.id });
    expect(other.status).toBe(400);
    expect(other.json.error.field).toBe("metricValueId");
    expect((await record(cityManagerA, { employeeId: w.techA1.employeeId, body: "About this value", metricValueId: value.id })).status).toBe(201);
  });

  it("reads are scoped by the employee: another unit's manager gets 404 and an empty list", async () => {
    const created = (await record(cityManagerA, { employeeId: w.techA1Other.employeeId, body: "Scoped note" })).json.data;
    expect((await call(getRecord, "GET", "/x", { cookie: cityManagerA, params: { id: created.id } })).status).toBe(200);
    expect((await call(getRecord, "GET", "/x", { cookie: hr, params: { id: created.id } })).status).toBe(200);
    expect((await call(getRecord, "GET", "/x", { cookie: cityManagerB, params: { id: created.id } })).status).toBe(404);
    expect((await call(getRecord, "GET", "/x", { cookie: techA1, params: { id: created.id } })).status).toBe(403);
    expect(ids(await call(listRecords, "GET", "/x", { cookie: cityManagerA, query: { employeeId: w.techA1Other.employeeId as string } }))).toContain(created.id);
    expect(ids(await call(listRecords, "GET", "/x", { cookie: cityManagerB }))).not.toContain(created.id);
  });

  it("only the author edits a private note; sharing is one way and freezes the text; archiving keeps the note", async () => {
    const created = (await record(cityManagerA, { employeeId: w.techA1.employeeId, body: "First draft" })).json.data;
    const patch = (cookie: string, body: Record<string, unknown>) => call(patchRecord, "PATCH", "/x", { cookie, params: { id: created.id }, body });
    expect((await patch(hr, { body: "HR rewrite" })).status).toBe(403);
    const edited = await patch(cityManagerA, { body: "Second draft" });
    expect(edited.status).toBe(200);
    expect(edited.json.data.body).toBe("Second draft");
    const [update] = await auditEvents(w.tenantId, "coaching_record.update", created.id);
    expect(update.previousValue).toMatchObject({ bodySha256: textDigest("First draft") });
    expect(JSON.stringify(update)).not.toContain("draft");

    const shared = await call(shareRecord, "POST", "/x", { cookie: cityManagerA, params: { id: created.id } });
    expect(shared.json.data.sharedWithEmployee).toBe(true);
    expect(shared.json.data.sharedAt).toBeTruthy();
    expect((await call(shareRecord, "POST", "/x", { cookie: cityManagerA, params: { id: created.id } })).status).toBe(200);
    expect((await auditEvents(w.tenantId, "coaching_record.share", created.id)).length).toBe(1);
    expect((await patch(cityManagerA, { body: "Too late" })).status).toBe(409);

    const archived = await call(archiveRecord, "POST", "/x", { cookie: hr, params: { id: created.id } });
    expect(archived.status).toBe(200);
    expect(archived.json.data.archivedAt).toBeTruthy();
    expect(ids(await call(listRecords, "GET", "/x", { cookie: hr, query: { employeeId: w.techA1.employeeId as string } }))).not.toContain(created.id);
    expect(ids(await call(listRecords, "GET", "/x", { cookie: hr, query: { employeeId: w.techA1.employeeId as string, includeArchived: "true" } }))).toContain(created.id);
    const stillThere = await withTenant(w.tenantId, (tx) => tx.coachingRecord.count({ where: { id: created.id } }));
    expect(stillThere).toBe(1);
  });

  it("an archived private note cannot be shared or edited", async () => {
    const created = (await record(cityManagerA, { employeeId: w.techA1.employeeId, body: "Archive me" })).json.data;
    await call(archiveRecord, "POST", "/x", { cookie: cityManagerA, params: { id: created.id } });
    expect((await call(shareRecord, "POST", "/x", { cookie: cityManagerA, params: { id: created.id } })).status).toBe(409);
    expect((await call(patchRecord, "PATCH", "/x", { cookie: cityManagerA, params: { id: created.id }, body: { body: "x" } })).status).toBe(409);
  });

  it("the database refuses deleting a coaching note", async () => {
    const created = (await record(cityManagerA, { employeeId: w.techA1.employeeId, body: "Keep me" })).json.data;
    await expect(withTenant(w.tenantId, (tx) => tx.coachingRecord.delete({ where: { id: created.id } }))).rejects.toThrow(/never deleted/);
  });
});

describe("metric context notes", () => {
  it("a manager adds context to a value of an employee in scope; the employee comes from the value; private by default", async () => {
    const value = await createMetricValue(w.tenantId, w.techA1.employeeId as string, w.hr.userId);
    const created = await call(createNote, "POST", "/x", { cookie: cityManagerA, body: { metricValueId: value.id, body: "Two jobs waited for parts." } });
    expect(created.status).toBe(201);
    expect(created.json.data).toMatchObject({ employeeId: w.techA1.employeeId, metricValueId: value.id, sharedWithEmployee: false, periodStart: null });
    const [event] = await auditEvents(w.tenantId, "metric_context_note.create", created.json.data.id);
    expect(JSON.stringify(event.newValue)).not.toContain("parts");

    expect((await call(createNote, "POST", "/x", { cookie: cityManagerB, body: { metricValueId: value.id, body: "x" } })).status).toBe(404);
    const mismatch = await call(createNote, "POST", "/x", { cookie: cityManagerA, body: { metricValueId: value.id, employeeId: w.techA1Other.employeeId, body: "x" } });
    expect(mismatch.status).toBe(400);
    expect((await call(createNote, "POST", "/x", { cookie: cityManagerA, body: { metricValueId: "nope", body: "x" } })).status).toBe(400);
  });

  it("context on a period needs the employee and a valid period", async () => {
    const body = { employeeId: w.techA1.employeeId, periodStart: "2026-03-01", periodEnd: "2026-04-01", body: "Was on leave for a week." };
    const created = await call(createNote, "POST", "/x", { cookie: cityManagerA, body });
    expect(created.status).toBe(201);
    expect(created.json.data.periodStart).toBe("2026-03-01T00:00:00.000Z");
    expect((await call(createNote, "POST", "/x", { cookie: cityManagerA, body: { ...body, periodEnd: "2026-02-01" } })).status).toBe(400);
    expect((await call(createNote, "POST", "/x", { cookie: cityManagerA, body: { body: "x", periodStart: "2026-03-01", periodEnd: "2026-04-01" } })).status).toBe(400);
  });

  it("a grant without the coaching set never writes or reads context notes; the employee's own view grant does not either", async () => {
    const value = await createMetricValue(w.tenantId, w.techA1.employeeId as string, w.hr.userId);
    expect((await call(createNote, "POST", "/x", { cookie: plainViewer, body: { metricValueId: value.id, body: "x" } })).status).toBe(403);
    const note = (await call(createNote, "POST", "/x", { cookie: hr, body: { metricValueId: value.id, body: "HR context" } })).json.data;
    expect((await call(getNote, "GET", "/x", { cookie: plainViewer, params: { id: note.id } })).status).toBe(404);
    expect(ids(await call(listNotes, "GET", "/x", { cookie: plainViewer }))).toEqual([]);
    expect((await call(getNote, "GET", "/x", { cookie: techA1, params: { id: note.id } })).status).toBe(404);
    expect(ids(await call(listNotes, "GET", "/x", { cookie: techA1 }))).toEqual([]);
    expect((await call(shareNote, "POST", "/x", { cookie: plainViewer, params: { id: note.id } })).status).toBe(404);

    expect((await call(getNote, "GET", "/x", { cookie: cityManagerA, params: { id: note.id } })).status).toBe(200);
    expect(ids(await call(listNotes, "GET", "/x", { cookie: cityManagerA, query: { metricValueId: value.id } }))).toEqual([note.id]);
    expect((await call(getNote, "GET", "/x", { cookie: cityManagerB, params: { id: note.id } })).status).toBe(404);
  });

  it("nobody writes context about themselves", async () => {
    const value = await createMetricValue(w.tenantId, selfCoach.employeeId, w.hr.userId);
    expect((await call(createNote, "POST", "/x", { cookie: selfCoach.cookie, body: { metricValueId: value.id, body: "I was great" } })).status).toBe(403);
  });

  it("sharing is one way, archiving keeps the note, and the text can never change", async () => {
    const value = await createMetricValue(w.tenantId, w.techA1.employeeId as string, w.hr.userId);
    const note = (await call(createNote, "POST", "/x", { cookie: cityManagerA, body: { metricValueId: value.id, body: "Context" } })).json.data;
    const shared = await call(shareNote, "POST", "/x", { cookie: cityManagerA, params: { id: note.id } });
    expect(shared.json.data).toMatchObject({ sharedWithEmployee: true });
    const archived = await call(archiveNote, "POST", "/x", { cookie: cityManagerA, params: { id: note.id } });
    expect(archived.json.data.archivedAt).toBeTruthy();
    expect(ids(await call(listNotes, "GET", "/x", { cookie: cityManagerA, query: { metricValueId: value.id } }))).toEqual([]);
    expect(ids(await call(listNotes, "GET", "/x", { cookie: cityManagerA, query: { metricValueId: value.id, includeArchived: "true" } }))).toEqual([note.id]);
    await expect(withTenant(w.tenantId, (tx) => tx.metricContextNote.update({ where: { id: note.id }, data: { body: "rewritten" } }))).rejects.toThrow();
    expect((await auditEvents(w.tenantId, "metric_context_note.share", note.id)).length).toBe(1);
    expect((await auditEvents(w.tenantId, "metric_context_note.archive", note.id)).length).toBe(1);
  });
});
