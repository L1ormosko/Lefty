import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withTenant } from "@/server/db";
import { disconnect } from "../authz/fixtures";
import { assignJob, assignLead, makeCustomer, makeJob, makeLead } from "../customers/fixtures";
import { call } from "../org/org-helpers";
import { buildLeadWorld, type LeadWorld } from "./fixtures";

/**
 * Next.js bundles instrumentation and each route separately; the resolver registry therefore lives on globalThis and
 * the notifications route imports the central registration module. Simulate a route loaded in a process where nothing
 * registered yet: forget the registry and every module, then import ONLY the route.
 */
let w: LeadWorld;
let leadId: string;
let jobId: string;

beforeAll(async () => {
  w = await buildLeadWorld("leads-targets");
  const customer = await makeCustomer(w.tenantId, { orgUnitId: w.units.cityA });
  leadId = await makeLead(w.tenantId, customer.id, { orgUnitId: w.units.cityA });
  await assignLead(w.tenantId, leadId, w.techA1.employeeId as string);
  jobId = await makeJob(w.tenantId, customer.id, w.units.cityA);
  await assignJob(w.tenantId, jobId, { employeeId: w.techA1.employeeId as string });
  await withTenant(w.tenantId, (tx) =>
    tx.notification.createMany({
      data: [
        { tenantId: w.tenantId, recipientId: w.techA1.userId, eventType: "lead.assigned", eventId: leadId, idempotencyKey: `lead.assigned:${leadId}`, templateKey: "NOTIFICATION.LEAD_ASSIGNED", params: { leadNumber: 1 }, targetType: "lead", targetId: leadId, critical: false },
        { tenantId: w.tenantId, recipientId: w.techA1.userId, eventType: "job.assigned", eventId: jobId, idempotencyKey: `job.assigned:${jobId}`, templateKey: "NOTIFICATION.JOB_ASSIGNED", params: { jobNumber: 1 }, targetType: "job", targetId: jobId, critical: false },
      ],
    }),
  );
});
afterAll(disconnect);

describe("notification target resolvers reach the notifications route", () => {
  it("shows lead and job notifications unredacted when only the route module was imported", async () => {
    delete (globalThis as { leadroNotificationTargets?: unknown }).leadroNotificationTargets;
    vi.resetModules();
    const { GET } = await import("@/app/api/v1/notifications/route");
    const { sessionCookie } = await import("../org/org-helpers");
    const cookie = await sessionCookie(w.techA1, w.tenantId);
    const result = await call(GET, "GET", "/api/v1/notifications", { cookie });
    expect(result.status).toBe(200);
    const byTarget = new Map<string, { redacted: boolean }>(result.json.data.map((row: { targetId: string; redacted: boolean }) => [row.targetId, row]));
    expect(byTarget.get(leadId)?.redacted).toBe(false);
    expect(byTarget.get(jobId)?.redacted).toBe(false);
  });

  it("redacts both once the recipient loses access", async () => {
    await withTenant(w.tenantId, async (tx) => {
      await tx.leadAssignment.updateMany({ where: { tenantId: w.tenantId, leadId }, data: { state: "ENDED", endedAt: new Date() } });
      await tx.jobAssignment.updateMany({ where: { tenantId: w.tenantId, jobId }, data: { state: "ENDED", endedAt: new Date() } });
    });
    const { GET } = await import("@/app/api/v1/notifications/route");
    const { sessionCookie } = await import("../org/org-helpers");
    const result = await call(GET, "GET", "/api/v1/notifications", { cookie: await sessionCookie(w.techA1, w.tenantId) });
    expect(result.json.data.filter((row: { redacted: boolean }) => row.redacted)).toHaveLength(2);
  });
});
