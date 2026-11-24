import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { POST as assignRoute } from "@/app/api/v1/jobs/[id]/assign/route";
import { POST as uploadRoute } from "@/app/api/v1/jobs/[id]/attachments/[attachmentId]/upload/route";
import { GET as listAttachmentsRoute, POST as attachmentRoute } from "@/app/api/v1/jobs/[id]/attachments/route";
import { GET as formForJobRoute } from "@/app/api/v1/jobs/[id]/completion/form/route";
import { GET as listCompletionsRoute, POST as completionRoute } from "@/app/api/v1/jobs/[id]/completion/route";
import { GET as listMaterialsRoute, POST as materialRoute } from "@/app/api/v1/jobs/[id]/materials/route";
import { GET as listNotesRoute, POST as noteRoute } from "@/app/api/v1/jobs/[id]/notes/route";
import { POST as recordOutcomeRoute } from "@/app/api/v1/jobs/[id]/outcome/route";
import { POST as rescheduleRoute } from "@/app/api/v1/jobs/[id]/reschedule/route";
import { POST as transitionRoute } from "@/app/api/v1/jobs/[id]/transition/route";
import { GET as getFormRoute, PATCH as patchFormRoute } from "@/app/api/v1/completion-forms/[id]/route";
import { POST as publishFormRoute } from "@/app/api/v1/completion-forms/[id]/publish/route";
import { GET as listFormsRoute, POST as createFormRoute } from "@/app/api/v1/completion-forms/route";
import { POST as createLostReasonRoute } from "@/app/api/v1/lost-reasons/route";
import { withTenant } from "@/server/db";
import { notConfiguredStorage, setStorageProvider } from "@/server/field-execution";
import { disconnect } from "../authz/fixtures";
import { buildJobsWorld, createJobViaApi, type JobsWorld } from "../jobs/fixtures";
import { auditEvents, call } from "../org/org-helpers";

let w: JobsWorld;
beforeAll(async () => {
  w = await buildJobsWorld("field-execution");
});
afterAll(disconnect);
afterEach(() => setStorageProvider(notConfiguredStorage));

const move = (cookie: string, jobId: string, toStatus: string) => call(transitionRoute, "POST", "/x", { cookie, params: { id: jobId }, body: { toStatus } });
const post = (route: Parameters<typeof call>[0], cookie: string, jobId: string, body: Record<string, unknown>) => call(route, "POST", "/x", { cookie, params: { id: jobId }, body });
const note = (cookie: string, jobId: string, body: Record<string, unknown>) => post(noteRoute, cookie, jobId, body);
const list = (route: Parameters<typeof call>[0], cookie: string, jobId: string) => call(route, "GET", "/x", { cookie, params: { id: jobId }, query: { limit: "50" } });

/** A job assigned to techA1 and taken to `upTo`. */
async function jobAt(upTo: "SCHEDULED" | "EN_ROUTE" | "IN_PROGRESS") {
  const job = await createJobViaApi(w);
  await call(assignRoute, "POST", "/x", { cookie: w.cookie.dispatcher, params: { id: job.id }, body: { employeeId: w.techA1.employeeId } });
  const start = Date.now() + 2 * 86_400_000;
  await call(rescheduleRoute, "POST", "/x", {
    cookie: w.cookie.dispatcher,
    params: { id: job.id },
    body: { scheduledSlot: { start: new Date(start).toISOString(), end: new Date(start + 2 * 3_600_000).toISOString() } },
  });
  const path = ["EN_ROUTE", "ARRIVED", "IN_PROGRESS"];
  const target = upTo === "SCHEDULED" ? [] : path.slice(0, path.indexOf(upTo) + 1);
  for (const status of target) {
    const response = await move(w.cookie.dispatcher, job.id, status);
    if (response.status !== 200) throw new Error(`setup: ${status} -> ${response.status}`);
  }
  return job;
}

describe("field notes (§8.5)", () => {
  it("records notes, additional work with an estimate and the customer's approval, and keeps free text out of events and audit", async () => {
    const job = await jobAt("IN_PROGRESS");
    const plain = await note(w.cookie.techA1, job.id, { body: "Unit is older than the paperwork says" });
    expect(plain.status).toBe(201);
    expect(plain.json.data.note).toMatchObject({ jobId: job.id, kind: "NOTE", employeeId: w.techA1.employeeId, customerApproved: null });

    const extra = await note(w.cookie.techA1, job.id, { kind: "ADDITIONAL_WORK_REQUESTED", body: "Customer wants the vent replaced too", amountMinor: 18000 });
    expect(extra.status).toBe(201);
    expect(extra.json.data.note).toMatchObject({ kind: "ADDITIONAL_WORK_REQUESTED", amountMinor: 18000, currency: "USD" });

    const approval = await note(w.cookie.techA1, job.id, { kind: "CUSTOMER_APPROVAL", body: "Approved on site", customerApproved: true, amountMinor: 18000 });
    expect(approval.json.data.note).toMatchObject({ kind: "CUSTOMER_APPROVAL", customerApproved: true });

    const events = JSON.stringify(
      (await withTenant(w.tenantId, (tx) => tx.jobEvent.findMany({ where: { jobId: job.id, type: { startsWith: "job.field_note" } } }))).map((event) => event.payload),
    );
    expect(events).not.toContain("vent");
    const audit = await auditEvents(w.tenantId, "job_note.record", extra.json.data.note.id);
    expect(JSON.stringify(audit[0].newValue)).not.toContain("vent");
    expect(JSON.stringify(audit[0].newValue)).not.toContain("18000");

    const listed = await list(listNotesRoute, w.cookie.techA1, job.id);
    expect(listed.json.data).toHaveLength(3);
  });

  it("shows amounts only to callers with the financial set, and refuses amounts from callers without it", async () => {
    const job = await jobAt("IN_PROGRESS");
    await note(w.cookie.techA1, job.id, { kind: "ADDITIONAL_WORK_REQUESTED", body: "More work", amountMinor: 5000 });
    const asDispatcher = await list(listNotesRoute, w.cookie.dispatcher, job.id);
    expect(asDispatcher.status).toBe(200);
    expect(asDispatcher.json.data[0]).not.toHaveProperty("amountMinor");
    expect(asDispatcher.json.data[0].body).toBe("More work");
    const dispatcherWithAmount = await note(w.cookie.dispatcher, job.id, { kind: "ADDITIONAL_WORK_REQUESTED", body: "x", amountMinor: 1 });
    expect(dispatcherWithAmount.status).toBe(403);
  });

  it("validates the shape: approval needs a decision, amounts only on additional work / approval, currency must be the job's", async () => {
    const job = await jobAt("IN_PROGRESS");
    expect((await note(w.cookie.techA1, job.id, { kind: "CUSTOMER_APPROVAL", body: "ok" })).status).toBe(400);
    expect((await note(w.cookie.techA1, job.id, { body: "x", amountMinor: 5 })).status).toBe(400);
    expect((await note(w.cookie.techA1, job.id, { body: "x", customerApproved: true })).status).toBe(400);
    expect((await note(w.cookie.techA1, job.id, { kind: "ADDITIONAL_WORK_REQUESTED", body: "x", amountMinor: 5.5 })).status).toBe(400);
    const wrongCurrency = await note(w.cookie.techA1, job.id, { kind: "ADDITIONAL_WORK_REQUESTED", body: "x", amountMinor: 5, currency: "EUR" });
    expect(wrongCurrency.status).toBe(400);
    expect(wrongCurrency.json.error.details[0].code).toBe("job_note.currency_mismatch");
  });

  it("is limited to the field phase and to the technician's own jobs", async () => {
    const early = await jobAt("SCHEDULED");
    const refused = await note(w.cookie.techA1, early.id, { body: "too early" });
    expect(refused.status).toBe(409);
    expect(refused.json.error.details[0].code).toBe("job_field.not_in_field_state");
    const job = await jobAt("IN_PROGRESS");
    expect((await note(w.cookie.techA1Other, job.id, { body: "not mine" })).status).toBe(404);
    expect((await note(w.cookie.cityManagerB, job.id, { body: "other city" })).status).toBe(404);
    expect((await list(listNotesRoute, w.cookie.cityManagerB, job.id)).status).toBe(404);
  });

  it("is idempotent per clientEventId: a replay answers 200 with the first note, a changed body is a 409, a stale time is a 400", async () => {
    const job = await jobAt("IN_PROGRESS");
    const clientEventId = randomUUID();
    const occurredAt = new Date(Date.now() - 3_600_000).toISOString();
    const first = await note(w.cookie.techA1, job.id, { body: "Found a leak", clientEventId, occurredAt });
    expect(first.status).toBe(201);
    const again = await note(w.cookie.techA1, job.id, { body: "Found a leak", clientEventId, occurredAt });
    expect(again.status).toBe(200);
    expect(again.json.data.replayed).toBe(true);
    expect(again.json.data.note.id).toBe(first.json.data.note.id);
    const changed = await note(w.cookie.techA1, job.id, { body: "Found two leaks", clientEventId, occurredAt });
    expect(changed.status).toBe(409);
    expect(changed.json.error.details[0].code).toBe("CLIENT_EVENT_ID_REUSED");

    const stored = await withTenant(w.tenantId, async (tx) => ({
      notes: await tx.jobFieldNote.count({ where: { jobId: job.id } }),
      events: await tx.fieldEvent.findMany({ where: { clientEventId } }),
    }));
    expect(stored.notes).toBe(1);
    expect(stored.events).toHaveLength(1);
    expect(stored.events[0]).toMatchObject({ type: "job.note", result: "ACCEPTED", entityType: "JobFieldNote", jobId: job.id });
    expect(stored.events[0].occurredAt.toISOString()).toBe(occurredAt);
    expect(JSON.stringify(stored.events[0].payload)).not.toContain("leak");

    const stale = await note(w.cookie.techA1, job.id, { body: "old", clientEventId: randomUUID(), occurredAt: new Date(Date.now() - 30 * 86_400_000).toISOString() });
    expect(stale.status).toBe(400);
  });

  it("judges the device time on first delivery only: a replay of an accepted event that has since become 'too old' still answers", async () => {
    const job = await jobAt("IN_PROGRESS");
    const body = { body: "borderline", clientEventId: randomUUID(), occurredAt: new Date(Date.now() - 7 * 86_400_000 + 2000).toISOString() };
    expect((await note(w.cookie.techA1, job.id, body)).status).toBe(201);
    await new Promise((resolve) => setTimeout(resolve, 2500)); // the event is now older than the week the server accepts
    const replay = await note(w.cookie.techA1, job.id, body);
    expect(replay.status).toBe(200);
    expect(replay.json.data.replayed).toBe(true);
    // A new event with the same stale time is refused (a stored verdict: too old will not change).
    expect((await note(w.cookie.techA1, job.id, { ...body, clientEventId: randomUUID() })).status).toBe(400);
  });

  it("re-checks access on a replay: once the technician lost the job, the answer is refused", async () => {
    const job = await jobAt("IN_PROGRESS");
    const body = { body: "before reassignment", clientEventId: randomUUID() };
    expect((await note(w.cookie.techA1, job.id, body)).status).toBe(201);
    await withTenant(w.tenantId, (tx) => tx.jobAssignment.updateMany({ where: { jobId: job.id, state: "ACTIVE" }, data: { state: "ENDED", endedAt: new Date() } }));
    expect([403, 404]).toContain((await note(w.cookie.techA1, job.id, body)).status);
  });
});

describe("materials used (§8.5)", () => {
  it("records quantity with up to three decimals and lists newest first", async () => {
    const job = await jobAt("IN_PROGRESS");
    const first = await post(materialRoute, w.cookie.techA1, job.id, { name: "Copper pipe", quantity: 2.5, unit: "m", materialRef: "SKU-1" });
    expect(first.status).toBe(201);
    expect(first.json.data.material).toMatchObject({ name: "Copper pipe", quantity: 2.5, unit: "m", materialRef: "SKU-1", completionId: null });
    expect((await post(materialRoute, w.cookie.techA1, job.id, { name: "Fitting", quantity: 4 })).json.data.material.unit).toBe("each");
    expect((await post(materialRoute, w.cookie.techA1, job.id, { name: "Bad", quantity: 1.2345 })).status).toBe(400);
    expect((await post(materialRoute, w.cookie.techA1, job.id, { name: "Bad", quantity: 0 })).status).toBe(400);
    expect((await list(listMaterialsRoute, w.cookie.dispatcher, job.id)).json.data).toHaveLength(2);
  });

  it("replays an offline material without recording it twice", async () => {
    const job = await jobAt("IN_PROGRESS");
    const body = { name: "Sealant", quantity: 1, clientEventId: randomUUID() };
    expect((await post(materialRoute, w.cookie.techA1, job.id, body)).status).toBe(201);
    expect((await post(materialRoute, w.cookie.techA1, job.id, body)).status).toBe(200);
    expect(await withTenant(w.tenantId, (tx) => tx.jobMaterialUsage.count({ where: { jobId: job.id } }))).toBe(1);
    expect((await post(materialRoute, w.cookie.techA1, job.id, { ...body, quantity: 2 })).status).toBe(409);
  });
});

describe("attachments and the storage boundary (§8.5, §28.3)", () => {
  const photo = { kind: "PHOTO", fileName: "before.jpg", contentType: "image/jpeg", sizeBytes: 250_000, capturedAt: new Date().toISOString() };

  it("records metadata as PENDING_UPLOAD and says storage is not configured", async () => {
    const job = await jobAt("IN_PROGRESS");
    const recorded = await post(attachmentRoute, w.cookie.techA1, job.id, photo);
    expect(recorded.status).toBe(201);
    expect(recorded.json.data.attachment).toMatchObject({ kind: "PHOTO", status: "PENDING_UPLOAD", storageConfigured: false, fileName: "before.jpg" });
    expect(recorded.json.data.attachment).not.toHaveProperty("storageKey");
    const row = await withTenant(w.tenantId, (tx) => tx.jobAttachment.findFirstOrThrow({ where: { id: recorded.json.data.attachment.id } }));
    expect(row).toMatchObject({ status: "PENDING_UPLOAD", storageKey: null, storageProvider: null });
    expect((await list(listAttachmentsRoute, w.cookie.techA1, job.id)).json.data).toHaveLength(1);
  });

  it("refuses to hand out an upload target while no provider is configured, and changes nothing", async () => {
    const job = await jobAt("IN_PROGRESS");
    const id = (await post(attachmentRoute, w.cookie.techA1, job.id, photo)).json.data.attachment.id;
    const refused = await call(uploadRoute, "POST", "/x", { cookie: w.cookie.techA1, params: { id: job.id, attachmentId: id } });
    expect(refused.status).toBe(409);
    expect(refused.json.error.details[0].code).toBe("storage.not_configured");
    expect((await withTenant(w.tenantId, (tx) => tx.jobAttachment.findFirstOrThrow({ where: { id } }))).status).toBe("PENDING_UPLOAD");
  });

  it("asks a configured provider for the target (the seam a real provider plugs into)", async () => {
    const job = await jobAt("IN_PROGRESS");
    const id = (await post(attachmentRoute, w.cookie.techA1, job.id, photo)).json.data.attachment.id;
    setStorageProvider({
      name: "test",
      configured: true,
      createUploadTarget: async (request) => ({ url: `https://upload.test/${request.attachmentId}`, storageKey: `k/${request.attachmentId}`, expiresAt: new Date(Date.now() + 60_000) }),
    });
    const target = await call(uploadRoute, "POST", "/x", { cookie: w.cookie.techA1, params: { id: job.id, attachmentId: id } });
    expect(target.status).toBe(200);
    expect(target.json.data.url).toBe(`https://upload.test/${id}`);
  });

  it("rejects bad metadata (media type, size, checksum) and another job's attachment id", async () => {
    const job = await jobAt("IN_PROGRESS");
    expect((await post(attachmentRoute, w.cookie.techA1, job.id, { ...photo, contentType: "jpeg" })).status).toBe(400);
    expect((await post(attachmentRoute, w.cookie.techA1, job.id, { ...photo, sizeBytes: 0 })).status).toBe(400);
    expect((await post(attachmentRoute, w.cookie.techA1, job.id, { ...photo, checksumSha256: "abc" })).status).toBe(400);
    const other = await jobAt("IN_PROGRESS");
    const id = (await post(attachmentRoute, w.cookie.techA1, other.id, photo)).json.data.attachment.id;
    expect((await call(uploadRoute, "POST", "/x", { cookie: w.cookie.techA1, params: { id: job.id, attachmentId: id } })).status).toBe(404);
  });
});

describe("completion forms: versioned definitions and validated submissions (§8.6)", () => {
  const fields = (overrides: Record<string, boolean> = {}) => ({
    fields: [
      { key: "outcome", type: "select", required: true, labelKey: "COMPLETION_FORM.FIELD.OUTCOME" },
      { key: "finalChargedAmount", type: "money", required: true, labelKey: "COMPLETION_FORM.FIELD.FINAL_CHARGED_AMOUNT" },
      { key: "materials", type: "materials", required: overrides.materials ?? true, labelKey: "COMPLETION_FORM.FIELD.MATERIALS" },
      { key: "photos", type: "photos", required: true, labelKey: "COMPLETION_FORM.FIELD.PHOTOS" },
      { key: "notes", type: "longtext", required: true, labelKey: "COMPLETION_FORM.FIELD.NOTES" },
      { key: "customerSignature", type: "signature", required: overrides.signature ?? true, labelKey: "COMPLETION_FORM.FIELD.CUSTOMER_SIGNATURE" },
      { key: "followUpRequired", type: "boolean", required: false, labelKey: "COMPLETION_FORM.FIELD.FOLLOW_UP_REQUIRED" },
    ],
  });
  const createForm = (schema: unknown, extra: Record<string, unknown> = {}) =>
    call(createFormRoute, "POST", "/x", { cookie: w.cookie.ceo, body: { jobTypeId: w.ids.repairType, name: "Repair completion", schema, ...extra } });
  const publish = (id: string) => call(publishFormRoute, "POST", "/x", { cookie: w.cookie.ceo, params: { id } });

  it("refuses a completion while the job type has no active form", async () => {
    const job = await jobAt("IN_PROGRESS");
    const refused = await post(completionRoute, w.cookie.techA1, job.id, { notes: "done" });
    expect(refused.status).toBe(409);
    expect(refused.json.error.details[0].code).toBe("completion.no_active_form");
    expect((await list(formForJobRoute, w.cookie.techA1, job.id)).status).toBe(404);
  });

  it("validates definitions, numbers versions, publishes atomically and keeps published versions immutable", async () => {
    expect((await createForm({ fields: [{ key: "outcome", type: "money", required: true, labelKey: "COMPLETION_FORM.FIELD.OUTCOME" }] })).status).toBe(400); // type not allowed for key
    expect((await createForm({ fields: [] })).status).toBe(400);
    expect((await call(createFormRoute, "POST", "/x", { cookie: w.cookie.ceo, body: { name: "x", schema: fields() } })).status).toBe(400); // neither type nor category
    expect((await call(createFormRoute, "POST", "/x", { cookie: w.cookie.dispatcher, body: { jobTypeId: w.ids.repairType, name: "x", schema: fields() } })).status).toBe(403);

    const v1 = await createForm(fields());
    expect(v1.status).toBe(201);
    expect(v1.json.data).toMatchObject({ version: 1, status: "DRAFT", jobTypeId: w.ids.repairType });
    const edited = await call(patchFormRoute, "PATCH", "/x", { cookie: w.cookie.ceo, params: { id: v1.json.data.id }, body: { name: "Repair completion (edited)" } });
    expect(edited.json.data.name).toBe("Repair completion (edited)");
    expect((await publish(v1.json.data.id)).json.data).toMatchObject({ status: "ACTIVE", version: 1 });
    expect((await call(patchFormRoute, "PATCH", "/x", { cookie: w.cookie.ceo, params: { id: v1.json.data.id }, body: { name: "late" } })).status).toBe(409);
    expect((await publish(v1.json.data.id)).status).toBe(409);

    const v2 = await createForm(fields({ signature: false }));
    expect(v2.json.data.version).toBe(2);
    expect((await publish(v2.json.data.id)).json.data.status).toBe("ACTIVE");
    const afterwards = await call(getFormRoute, "GET", "/x", { cookie: w.cookie.techA1, params: { id: v1.json.data.id } });
    expect(afterwards.json.data.status).toBe("RETIRED");
    const active = await call(listFormsRoute, "GET", "/x", { cookie: w.cookie.dispatcher, query: { jobTypeId: w.ids.repairType, status: "ACTIVE" } });
    expect(active.json.data).toHaveLength(1);
    expect(active.json.data[0].version).toBe(2);
  });

  it("validates a submission against the active version, links materials, and keeps the version it was filled in with", async () => {
    // The previous test published v2 (no signature required); publish a v3 with every requirement for this one.
    const draft = await createForm(fields());
    await publish(draft.json.data.id);
    const version = draft.json.data.version as number;

    const job = await jobAt("IN_PROGRESS");
    const form = await list(formForJobRoute, w.cookie.techA1, job.id);
    expect(form.json.data.form).toMatchObject({ id: draft.json.data.id, version });
    expect(form.json.data.progress).toEqual({ hasOutcome: false, materialCount: 0, photoCount: 0 });

    const incomplete = await post(completionRoute, w.cookie.techA1, job.id, { notes: "All good" });
    expect(incomplete.status).toBe(400);
    expect(incomplete.json.error.details.map((detail: { field: string }) => detail.field).sort()).toEqual(["customerSignature", "finalChargedAmount", "materials", "outcome", "photos"]);

    await post(materialRoute, w.cookie.techA1, job.id, { name: "Valve", quantity: 1 });
    await post(attachmentRoute, w.cookie.techA1, job.id, { kind: "PHOTO", fileName: "after.jpg", contentType: "image/jpeg", sizeBytes: 1000 });
    const signature = await post(attachmentRoute, w.cookie.techA1, job.id, { kind: "SIGNATURE", fileName: "sig.png", contentType: "image/png", sizeBytes: 500 });
    const sold = await post(recordOutcomeRoute, w.cookie.techA1, job.id, { outcome: "SOLD", chargedAmountMinor: 9000, collectedAmountMinor: 9000, paymentMethod: "CARD", paymentStatus: "PAID" });
    expect(sold.status).toBe(201);

    // Answers the form does not ask for, and a signature that is not a signature of this job, are refused.
    expect((await post(completionRoute, w.cookie.techA1, job.id, { notes: "x", signatureAttachmentId: "nope" })).json.error.details[0].code).toBe("completion.signature_unknown");

    const submitted = await post(completionRoute, w.cookie.techA1, job.id, { notes: "All good", workPerformed: "Replaced valve", followUpRequired: false, signatureAttachmentId: signature.json.data.attachment.id });
    expect(submitted.status, JSON.stringify(submitted.json)).toBe(201);
    expect(submitted.json.data.completion).toMatchObject({
      jobId: job.id,
      visitNumber: 1,
      formDefinitionId: draft.json.data.id,
      formVersion: version,
      values: { notes: "All good", followUpRequired: false },
      workPerformed: "Replaced valve",
      employeeId: w.techA1.employeeId,
    });
    expect(JSON.stringify(submitted.json.data.completion.values)).not.toContain("9000"); // amounts live in the outcome, not the answers
    const linked = await withTenant(w.tenantId, (tx) => tx.jobMaterialUsage.findMany({ where: { jobId: job.id } }));
    expect(linked.every((row) => row.completionId === submitted.json.data.completion.id)).toBe(true);

    expect((await post(completionRoute, w.cookie.techA1, job.id, { notes: "again" })).json.error.details[0].code).toBe("completion.already_submitted");
    expect((await list(listCompletionsRoute, w.cookie.dispatcher, job.id)).json.data).toHaveLength(1);
    expect((await list(formForJobRoute, w.cookie.techA1, job.id)).json.data.alreadySubmitted).toBe(true);

    // A newer version does not rewrite what was submitted under the old one.
    const next = await createForm(fields({ materials: false }));
    await publish(next.json.data.id);
    const stored = await withTenant(w.tenantId, (tx) => tx.jobCompletion.findFirstOrThrow({ where: { jobId: job.id } }));
    expect(stored.formVersion).toBe(version);
    expect(stored.formDefinitionId).toBe(draft.json.data.id);
  });

  it("only enforces money and signature fields for a SOLD visit, and refuses answers the form does not ask for", async () => {
    const draft = await createForm({
      fields: [
        { key: "outcome", type: "select", required: true, labelKey: "COMPLETION_FORM.FIELD.OUTCOME" },
        { key: "finalChargedAmount", type: "money", required: true, labelKey: "COMPLETION_FORM.FIELD.FINAL_CHARGED_AMOUNT" },
        { key: "notes", type: "text", required: false, labelKey: "COMPLETION_FORM.FIELD.NOTES" },
      ],
    });
    await publish(draft.json.data.id);
    const job = await jobAt("IN_PROGRESS");
    const lost = await post(recordOutcomeRoute, w.cookie.techA1, job.id, { outcome: "ADDITIONAL_APPROVAL_REQUIRED" });
    expect(lost.status).toBe(201);
    // REQUIRES_RETURN_VISIT: not completable, the status guard speaks first.
    const refused = await post(completionRoute, w.cookie.techA1, job.id, { notes: "x" });
    expect([400, 409]).toContain(refused.status);

    const second = await jobAt("IN_PROGRESS");
    expect((await post(completionRoute, w.cookie.techA1, second.id, { followUpRequired: true })).json.error.details[0].code).toBe("completion.field_not_in_form");
    expect((await post(completionRoute, w.cookie.techA1, second.id, { notes: "x" })).json.error.details.map((d: { field: string }) => d.field)).toEqual(["outcome", "finalChargedAmount"]);

    // A visit that did not sell has no charged amount to demand: the outcome alone satisfies the form.
    const reason = (await call(createLostReasonRoute, "POST", "/x", { cookie: w.cookie.ceo, body: { code: `price-${randomUUID().slice(0, 8)}`, name: "Price" } })).json.data.id;
    const third = await jobAt("IN_PROGRESS");
    expect((await post(recordOutcomeRoute, w.cookie.techA1, third.id, { outcome: "NOT_SOLD", lostReasonId: reason })).status).toBe(201);
    expect((await post(completionRoute, w.cookie.techA1, third.id, { notes: "Customer will think about it" })).status).toBe(201);
  });

  it("is idempotent per clientEventId and refuses a replay once the caller lost access", async () => {
    const draft = await createForm({ fields: [{ key: "notes", type: "text", required: true, labelKey: "COMPLETION_FORM.FIELD.NOTES" }] });
    await publish(draft.json.data.id);
    const job = await jobAt("IN_PROGRESS");
    const body = { notes: "Finished", clientEventId: randomUUID() };
    const first = await post(completionRoute, w.cookie.techA1, job.id, body);
    expect(first.status).toBe(201);
    const again = await post(completionRoute, w.cookie.techA1, job.id, body);
    expect(again.status).toBe(200);
    expect(again.json.data.completion.id).toBe(first.json.data.completion.id);
    expect((await post(completionRoute, w.cookie.techA1, job.id, { ...body, notes: "Changed" })).status).toBe(409);
    expect(await withTenant(w.tenantId, (tx) => tx.jobCompletion.count({ where: { jobId: job.id } }))).toBe(1);
  });
});
