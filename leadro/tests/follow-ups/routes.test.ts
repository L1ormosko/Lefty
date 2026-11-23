import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as assignRoute } from "@/app/api/v1/follow-ups/[id]/assign/route";
import { POST as cancelRoute } from "@/app/api/v1/follow-ups/[id]/cancel/route";
import { POST as completeRoute } from "@/app/api/v1/follow-ups/[id]/complete/route";
import { GET as getRoute, PATCH as patchRoute } from "@/app/api/v1/follow-ups/[id]/route";
import { POST as statusRoute } from "@/app/api/v1/follow-ups/[id]/status/route";
import { GET as listRoute, POST as createRoute } from "@/app/api/v1/follow-ups/route";
import { withTenant } from "@/server/db";
import { disconnect } from "../authz/fixtures";
import { makeJob } from "../customers/fixtures";
import { call, sessionCookie } from "../org/org-helpers";
import { buildFollowUpWorld, hoursFromNow, makeFollowUp, type FollowUpWorld } from "./fixtures";

let w: FollowUpWorld;
const iso = (hours: number) => hoursFromNow(hours).toISOString();

beforeAll(async () => {
  w = await buildFollowUpWorld("followups-routes");
});
afterAll(disconnect);

describe("POST /api/v1/follow-ups", () => {
  it("creates a task (201) and shows it in GET /follow-ups/{id} and the list", async () => {
    const created = await call(createRoute, "POST", "/api/v1/follow-ups", {
      cookie: w.cookies.cityManagerA,
      body: { targetType: "JOB", targetId: w.jobA, title: "Check the invoice", dueAt: iso(24), priority: "HIGH", assigneeId: w.techA1.employeeId },
    });
    expect(created.status).toBe(201);
    expect(created.json.data).toMatchObject({ targetType: "JOB", jobId: w.jobA, status: "OPEN", priority: "HIGH", assigneeId: w.techA1.employeeId });
    expect(created.json.data).not.toHaveProperty("tenantId");
    expect(created.json.data).not.toHaveProperty("dueSoonNotifiedAt");
    const id = created.json.data.id;

    const one = await call(getRoute, "GET", `/api/v1/follow-ups/${id}`, { cookie: w.cookies.techA1, params: { id } });
    expect(one.status).toBe(200);
    const list = await call(listRoute, "GET", "/api/v1/follow-ups", { cookie: w.cookies.techA1, query: { assigneeEmployeeId: "me", status: "open" } });
    expect(list.status).toBe(200);
    expect(list.json.data.map((row: { id: string }) => row.id)).toContain(id);
    expect(list.json.page).toHaveProperty("nextCursor");
  });

  it("validates the body: unknown fields, missing title, bad dates and a non-UUID clientEventId are 400", async () => {
    const bad = (body: unknown) => call(createRoute, "POST", "/api/v1/follow-ups", { cookie: w.cookies.cityManagerA, body });
    const base = { targetType: "JOB", targetId: w.jobA, title: "x", dueAt: iso(1) };
    expect((await bad({ ...base, origin: "SYSTEM" })).status).toBe(400); // origin is not settable by a person
    expect((await bad({ ...base, dedupeKey: "k" })).status).toBe(400);
    expect((await bad({ ...base, title: "  " })).status).toBe(400);
    expect((await bad({ ...base, dueAt: "tomorrow-ish" })).status).toBe(400);
    expect((await bad({ ...base, clientEventId: "abc" })).status).toBe(400);
    expect((await bad({ ...base, targetType: "ORDER" })).status).toBe(400);
  });

  it("answers 401 without a session, 403 without the permission, 404 for a target out of scope", async () => {
    const body = { targetType: "JOB", targetId: w.jobA, title: "x", dueAt: iso(1) };
    expect((await call(createRoute, "POST", "/api/v1/follow-ups", { body })).status).toBe(401);
    const finance = await call(createRoute, "POST", "/api/v1/follow-ups", { cookie: await sessionCookie(w.finance, w.tenantId), body });
    expect(finance.status).toBe(403);
    const outOfScope = await call(createRoute, "POST", "/api/v1/follow-ups", { cookie: w.cookies.cityManagerB, body });
    expect(outOfScope.status).toBe(404);
  });

  it("replays an offline creation: the same clientEventId returns the same task", async () => {
    const body = { targetType: "JOB", targetId: w.jobA, title: "From the van", dueAt: iso(12), assigneeId: w.techA1.employeeId, clientEventId: randomUUID(), occurredAt: iso(-1) };
    const first = await call(createRoute, "POST", "/api/v1/follow-ups", { cookie: w.cookies.techA1, body });
    const second = await call(createRoute, "POST", "/api/v1/follow-ups", { cookie: w.cookies.techA1, body });
    expect(first.status).toBe(201);
    expect(second.json.data.id).toBe(first.json.data.id);
    const changed = await call(createRoute, "POST", "/api/v1/follow-ups", { cookie: w.cookies.techA1, body: { ...body, title: "Different" } });
    expect(changed.status).toBe(409);
  });
});

describe("the task lifecycle over HTTP", () => {
  it("edits, assigns, starts, completes and reopens", async () => {
    const id = await makeFollowUp(w.cityManagerA, { targetType: "JOB", targetId: w.jobA });
    const params = { id };
    const patched = await call(patchRoute, "PATCH", `/api/v1/follow-ups/${id}`, { cookie: w.cookies.cityManagerA, params, body: { title: "Renamed", priority: "URGENT" } });
    expect(patched.json.data).toMatchObject({ title: "Renamed", priority: "URGENT" });

    const assigned = await call(assignRoute, "POST", `/api/v1/follow-ups/${id}/assign`, { cookie: w.cookies.cityManagerA, params, body: { assigneeId: w.techA1.employeeId } });
    expect(assigned.json.data.assigneeId).toBe(w.techA1.employeeId);

    const started = await call(statusRoute, "POST", `/api/v1/follow-ups/${id}/status`, { cookie: w.cookies.techA1, params, body: { status: "IN_PROGRESS" } });
    expect(started.json.data.status).toBe("IN_PROGRESS");
    const done = await call(completeRoute, "POST", `/api/v1/follow-ups/${id}/complete`, { cookie: w.cookies.techA1, params, body: { note: "Reached them" } });
    expect(done.json.data).toMatchObject({ status: "DONE", completionNote: "Reached them" });
    const again = await call(completeRoute, "POST", `/api/v1/follow-ups/${id}/complete`, { cookie: w.cookies.techA1, params, body: {} });
    expect(again.status).toBe(409);
    const reopened = await call(statusRoute, "POST", `/api/v1/follow-ups/${id}/status`, { cookie: w.cookies.cityManagerA, params, body: { status: "OPEN" } });
    expect(reopened.json.data.status).toBe("OPEN");
  });

  it("cancels with a mandatory reason", async () => {
    const id = await makeFollowUp(w.cityManagerA, { targetType: "JOB", targetId: w.jobA });
    const params = { id };
    expect((await call(cancelRoute, "POST", `/api/v1/follow-ups/${id}/cancel`, { cookie: w.cookies.cityManagerA, params, body: {} })).status).toBe(400);
    const cancelled = await call(cancelRoute, "POST", `/api/v1/follow-ups/${id}/cancel`, { cookie: w.cookies.cityManagerA, params, body: { reason: "Duplicate" } });
    expect(cancelled.json.data).toMatchObject({ status: "CANCELLED", cancelReason: "Duplicate" });
  });

  it("answers 404 for tasks outside the caller's reach and 403 where the permission is missing", async () => {
    const id = await makeFollowUp(w.cityManagerA, { targetType: "JOB", targetId: w.jobA });
    const params = { id };
    for (const cookie of [w.cookies.cityManagerB, w.cookies.techB, w.cookies.techA1]) {
      expect((await call(getRoute, "GET", `/api/v1/follow-ups/${id}`, { cookie, params })).status).toBe(404);
      expect((await call(completeRoute, "POST", `/api/v1/follow-ups/${id}/complete`, { cookie, params, body: {} })).status).toBe(404);
    }
    // A Technician lacks follow_ups.assign: refused at the route gate before the record is looked at.
    expect((await call(assignRoute, "POST", `/api/v1/follow-ups/${id}/assign`, { cookie: w.cookies.techA1, params, body: { assigneeId: w.techA1.employeeId } })).status).toBe(403);
    expect((await call(getRoute, "GET", "/api/v1/follow-ups/nope", { cookie: w.cookies.ceo, params: { id: "nope" } })).status).toBe(404);
  });

  it("rejects an assignee outside the caller's employee scope with a field error", async () => {
    const id = await makeFollowUp(w.cityManagerA, { targetType: "JOB", targetId: w.jobA });
    const result = await call(assignRoute, "POST", `/api/v1/follow-ups/${id}/assign`, { cookie: w.cookies.cityManagerA, params: { id }, body: { assigneeId: w.techB.employeeId } });
    expect(result.status).toBe(400);
    expect(JSON.stringify(result.json)).toContain("assigneeId");
  });
});

describe("notifications link to follow-ups and respect read-time access", () => {
  it("shows the assignment notification through the notifications route when only that route is loaded, then redacts it once the target is lost", async () => {
    const job = await makeJob(w.tenantId, w.customerA, w.units.cityA);
    await withTenant(w.tenantId, (tx) => tx.jobAssignment.create({ data: { tenantId: w.tenantId, jobId: job, employeeId: w.techA1.employeeId as string, state: "ACTIVE", assignedAt: new Date() } }));
    const id = await makeFollowUp(w.cityManagerA, { targetType: "JOB", targetId: job, assigneeId: w.techA1.employeeId });

    delete (globalThis as { leadroNotificationTargets?: unknown }).leadroNotificationTargets;
    vi.resetModules();
    const { GET } = await import("@/app/api/v1/notifications/route");
    const fetchInbox = async () => (await call(GET, "GET", "/api/v1/notifications", { cookie: w.cookies.techA1 })).json.data as Array<{ targetId: string | null; redacted: boolean; eventType: string }>;

    const visible = (await fetchInbox()).find((row) => row.eventType === "follow_up.assigned" && row.targetId === id);
    expect(visible).toMatchObject({ redacted: false });

    await withTenant(w.tenantId, (tx) => tx.jobAssignment.updateMany({ where: { jobId: job }, data: { state: "ENDED", endedAt: new Date() } }));
    const after = (await fetchInbox()).filter((row) => row.eventType === "follow_up.assigned");
    expect(after.some((row) => row.targetId === id)).toBe(false); // the link is gone
    expect(after.some((row) => row.redacted)).toBe(true);
  });
});
