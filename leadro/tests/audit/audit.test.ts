import { describe, it, expect, beforeAll } from "vitest";
import { auditContextFields, listAuditEvents, recordAudit } from "@/server/audit";
import type { RequestContext } from "@/server/core";
import { prisma, withTenant } from "@/server/db";
import { createTenant } from "../helpers";

let tenantA: { id: string };
let tenantB: { id: string };

beforeAll(async () => {
  tenantA = await createTenant("audit-a");
  tenantB = await createTenant("audit-b");
});

const baseEvent = (tenantId: string, action: string) => ({
  tenantId,
  actorUserId: null,
  action,
  sourceApp: "API" as const,
});

describe("recordAudit", () => {
  it("stores actor, target, values, outcome, source app and correlation id", async () => {
    const id = await withTenant(tenantA.id, (tx) =>
      recordAudit(tx, {
        ...baseEvent(tenantA.id, "employee.update"),
        actorUserId: "user-1",
        targetType: "Employee",
        targetId: "emp-1",
        previousValue: { title: "Tech" },
        newValue: { title: "Lead Tech" },
        reason: "promotion",
        outcome: "SUCCESS",
        sourceApp: "WEB",
        correlationId: "corr-1234567",
        ipAddress: "203.0.113.5",
      }),
    );
    const row = await withTenant(tenantA.id, (tx) => tx.auditEvent.findUniqueOrThrow({ where: { id } }));
    expect(row).toMatchObject({
      tenantId: tenantA.id,
      actorType: "USER",
      actorUserId: "user-1",
      action: "employee.update",
      targetType: "Employee",
      targetId: "emp-1",
      previousValue: { title: "Tech" },
      newValue: { title: "Lead Tech" },
      reason: "promotion",
      outcome: "SUCCESS",
      sourceApp: "WEB",
      correlationId: "corr-1234567",
      ipAddress: "203.0.113.5",
    });
  });

  it("redacts sensitive keys in previous and new values before storing", async () => {
    const id = await withTenant(tenantA.id, (tx) =>
      recordAudit(tx, {
        ...baseEvent(tenantA.id, "user.update"),
        previousValue: { email: "a@b.test", passwordHash: "$argon2id$old" },
        newValue: { email: "c@d.test", passwordHash: "$argon2id$new", mfa: { mfaSecret: "JBSWY3DP", enabled: true }, sessions: [{ token: "tok" }] },
      }),
    );
    const row = await withTenant(tenantA.id, (tx) => tx.auditEvent.findUniqueOrThrow({ where: { id } }));
    expect(row.previousValue).toEqual({ email: "a@b.test", passwordHash: "[REDACTED]" });
    expect(row.newValue).toEqual({
      email: "c@d.test",
      passwordHash: "[REDACTED]",
      mfa: { mfaSecret: "[REDACTED]", enabled: true },
      sessions: [{ token: "[REDACTED]" }],
    });
    expect(JSON.stringify(row)).not.toMatch(/argon2id|JBSWY3DP|"tok"/);
  });

  it("marks events without an actor as SYSTEM and defaults the outcome to SUCCESS", async () => {
    const id = await withTenant(tenantA.id, (tx) => recordAudit(tx, { ...baseEvent(tenantA.id, "job.expire"), sourceApp: "SYSTEM" }));
    const row = await withTenant(tenantA.id, (tx) => tx.auditEvent.findUniqueOrThrow({ where: { id } }));
    expect(row).toMatchObject({ actorType: "SYSTEM", outcome: "SUCCESS", sourceApp: "SYSTEM" });
  });

  it("rolls back with the surrounding transaction", async () => {
    const action = `rollback.test.${Date.now()}`;
    await expect(
      withTenant(tenantA.id, async (tx) => {
        await recordAudit(tx, baseEvent(tenantA.id, action));
        throw new Error("business failure");
      }),
    ).rejects.toThrow("business failure");
    const page = await listAuditEvents(tenantA.id, { filter: { action } });
    expect(page.data).toHaveLength(0);
  });

  it("refuses to write an event for another tenant (row-level security)", async () => {
    await expect(withTenant(tenantA.id, (tx) => recordAudit(tx, baseEvent(tenantB.id, "cross.tenant")))).rejects.toThrow();
  });

  it("is append-only: UPDATE and DELETE are rejected by the database", async () => {
    const id = await withTenant(tenantA.id, (tx) => recordAudit(tx, baseEvent(tenantA.id, "immutable.check")));
    await expect(withTenant(tenantA.id, (tx) => tx.auditEvent.update({ where: { id }, data: { action: "tampered" } }))).rejects.toThrow(/append-only/);
    await expect(withTenant(tenantA.id, (tx) => tx.auditEvent.delete({ where: { id } }))).rejects.toThrow(/append-only/);
  });
});

describe("auditContextFields", () => {
  it("takes tenant, actor, source app and correlation id from the request context", () => {
    const ctx: RequestContext = {
      correlationId: "corr-abcdefgh",
      sourceApp: "MOBILE",
      actor: { tenantId: "t1", userId: "u1", employeeId: null, sessionId: "s1", locale: null },
    };
    expect(auditContextFields(ctx)).toEqual({ tenantId: "t1", actorUserId: "u1", sourceApp: "MOBILE", correlationId: "corr-abcdefgh" });
  });

  it("throws without an actor rather than writing an anonymous event", () => {
    expect(() => auditContextFields({ correlationId: "c", sourceApp: "API", actor: null })).toThrow();
  });
});

describe("listAuditEvents", () => {
  it("returns only the tenant's own events", async () => {
    const marker = `isolation.${Date.now()}`;
    await withTenant(tenantA.id, (tx) => recordAudit(tx, baseEvent(tenantA.id, marker)));
    await withTenant(tenantB.id, (tx) => recordAudit(tx, baseEvent(tenantB.id, marker)));

    const a = await listAuditEvents(tenantA.id, { filter: { action: marker } });
    const b = await listAuditEvents(tenantB.id, { filter: { action: marker } });
    expect(a.data).toHaveLength(1);
    expect(b.data).toHaveLength(1);
    expect(a.data[0].id).not.toBe(b.data[0].id);

    // Even with no filter, tenant A's timeline never contains tenant B's event.
    const all = await listAuditEvents(tenantA.id, { limit: 200 });
    expect(all.data.map((e) => e.id)).not.toContain(b.data[0].id);
    // The raw client without tenant context sees nothing at all (RLS fail-closed).
    expect(await prisma.auditEvent.count({ where: { action: marker } })).toBe(0);
  });

  it("paginates newest-first without gaps or duplicates", async () => {
    const tenant = await createTenant("audit-page");
    const base = Date.now() - 60_000;
    // Several events share a timestamp to exercise the id tiebreak.
    await withTenant(tenant.id, async (tx) => {
      for (let i = 0; i < 7; i++) {
        await tx.auditEvent.create({
          data: { tenantId: tenant.id, action: "page.test", sourceApp: "API", occurredAt: new Date(base + Math.floor(i / 2) * 1000) },
        });
      }
    });

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await listAuditEvents(tenant.id, { limit: 3, cursor });
      seen.push(...page.data.map((e) => e.id));
      cursor = page.page.nextCursor ?? undefined;
      pages += 1;
    } while (cursor);

    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(7);
    const times = (await listAuditEvents(tenant.id, { limit: 200 })).data.map((e) => e.occurredAt.getTime());
    expect(times).toEqual([...times].sort((x, y) => y - x));
  });

  it("filters by target, actor, outcome and time range", async () => {
    const tenant = await createTenant("audit-filter");
    await withTenant(tenant.id, async (tx) => {
      await recordAudit(tx, { ...baseEvent(tenant.id, "a.one"), actorUserId: "u1", targetType: "Job", targetId: "j1" });
      await recordAudit(tx, { ...baseEvent(tenant.id, "a.two"), actorUserId: "u2", targetType: "Job", targetId: "j2", outcome: "DENIED" });
    });
    const byTarget = await listAuditEvents(tenant.id, { filter: { targetType: "Job", targetId: "j1" } });
    expect(byTarget.data.map((e) => e.action)).toEqual(["a.one"]);
    expect((await listAuditEvents(tenant.id, { filter: { actorUserId: "u2" } })).data.map((e) => e.action)).toEqual(["a.two"]);
    expect((await listAuditEvents(tenant.id, { filter: { outcome: "DENIED" } })).data.map((e) => e.action)).toEqual(["a.two"]);
    expect((await listAuditEvents(tenant.id, { filter: { from: new Date(Date.now() + 60_000) } })).data).toHaveLength(0);
  });

  it("rejects a malformed cursor and clamps the limit", async () => {
    await expect(listAuditEvents(tenantA.id, { cursor: "not-a-cursor" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect((await listAuditEvents(tenantA.id, { limit: 100000 })).page.limit).toBe(200);
    expect((await listAuditEvents(tenantA.id, { limit: 0 })).page.limit).toBe(1);
  });
});
