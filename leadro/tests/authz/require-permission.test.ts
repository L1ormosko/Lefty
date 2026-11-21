import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { listAuditEventsAsActor, requirePermission } from "@/server/authz";
import { defineRoute, ForbiddenError, ok, type Actor } from "@/server/core";
import { recordAudit } from "@/server/audit";
import { withTenant } from "@/server/db";
import { z } from "zod";
import { buildWorld, createPerson, disconnect, grantTemplate, type World } from "./fixtures";

let w: World;

beforeAll(async () => {
  w = await buildWorld("authz-route");
});
afterAll(disconnect);

/** A GET /employees/:id route guarded by the engine, authenticated as the actor named in a header. */
function employeeRoute(actors: Record<string, Actor>) {
  return defineRoute({
    schemas: { params: z.object({ id: z.string() }) },
    authenticate: async (req) => actors[req.headers.get("x-test-user") ?? ""] as Actor,
    authorize: requirePermission("employees.view", (_actor, input: { params: { id: string } }) => ({
      employeeId: input.params.id,
    })),
    handler: async ({ input }) => ok({ id: input.params.id }),
  });
}

const call = (route: ReturnType<typeof employeeRoute>, user: string, employeeId: string) =>
  route(new Request("http://localhost/api/v1/employees/x", { headers: { "x-test-user": user } }), {
    params: Promise.resolve({ id: employeeId }),
  });

describe("requirePermission wired into defineRoute", () => {
  it("lets an in-scope caller through", async () => {
    const route = employeeRoute({ mgr: w.cityManagerA.actor });
    const response = await call(route, "mgr", w.techA1.employeeId!);
    expect(response.status).toBe(200);
  });

  it("answers 404 for out-of-scope, missing and cross-tenant records (existence is not confirmed)", async () => {
    const other = await buildWorld("authz-route-other");
    const route = employeeRoute({ mgr: w.cityManagerA.actor });

    for (const id of [w.techB.employeeId!, "does-not-exist", other.techA1.employeeId!]) {
      const response = await call(route, "mgr", id);
      expect(response.status, id).toBe(404);
      expect((await response.json()).error.code).toBe("NOT_FOUND");
    }
  });

  it("answers 403 when the caller holds no such permission at all", async () => {
    const strict = defineRoute({
      authenticate: async () => w.dispatcher.actor,
      authorize: requirePermission("compensation.configure"),
      handler: async () => ok({}),
    });
    const denied = await strict(new Request("http://localhost/api/v1/x"));
    expect(denied.status).toBe(403);
    expect((await denied.json()).error.code).toBe("FORBIDDEN");
  });

  it("answers 404, not 403, when a condition rules the record out (existence is not confirmed)", async () => {
    const route = defineRoute({
      authenticate: async () => w.dispatcher.actor,
      // Dispatcher may view only job-related customers; this record is not in that set.
      authorize: requirePermission("customers.view", () => ({ orgUnitId: w.units.cityA, sets: [] })),
      handler: async () => ok({}),
    });
    const response = await route(new Request("http://localhost/api/v1/customers/1"));
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("NOT_FOUND");
  });

  it("checks the capability before running the resolver, and treats a null record as 404", async () => {
    let resolverCalls = 0;
    const denied = defineRoute({
      authenticate: async () => w.finance.actor,
      authorize: requirePermission("dispatch.view", () => {
        resolverCalls += 1;
        return { orgUnitId: w.units.cityA };
      }),
      handler: async () => ok({}),
    });
    expect((await denied(new Request("http://localhost/api/v1/x"))).status).toBe(403);
    expect(resolverCalls).toBe(0);

    // The resolver reads inside the same transaction and signals "not found" with null.
    const missing = defineRoute({
      authenticate: async () => w.ceo.actor,
      authorize: requirePermission("employees.view", async (_actor, _input, tx) => {
        const employee = await tx.employee.findFirst({ where: { id: "nope" }, select: { id: true } });
        return employee ? { employeeId: employee.id } : null;
      }),
      handler: async () => ok({}),
    });
    expect((await missing(new Request("http://localhost/api/v1/x"))).status).toBe(404);
  });

  it("does not let an undefined attribute turn a record into a tenant-level one", async () => {
    const route = defineRoute({
      authenticate: async () => w.ceo.actor,
      authorize: requirePermission("employees.view", () => ({ orgUnitId: undefined })),
      handler: async () => ok({}),
    });
    expect((await route(new Request("http://localhost/api/v1/x"))).status).toBe(404);
  });

  it("records every denial in the audit log with outcome DENIED", async () => {
    const person = await createPerson(w.tenantId, "denied-audit", { withEmployee: false });
    const strict = defineRoute({
      authenticate: async () => person.actor,
      authorize: requirePermission("financial_reports.view"),
      handler: async () => ok({}),
    });
    await strict(new Request("http://localhost/api/v1/x"));

    const events = await withTenant(w.tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { actorUserId: person.userId, action: "authz.denied" } }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: "DENIED", targetId: "financial_reports.view" });
  });

  it("fails at definition time for a permission that is not in the catalog", () => {
    expect(() => requirePermission("jobs.fly")).toThrow(/unknown permission/);
  });
});

describe("listAuditEventsAsActor (audit.view gate)", () => {
  it("returns the log to a tenant-wide Owner", async () => {
    await withTenant(w.tenantId, (tx) =>
      recordAudit(tx, { tenantId: w.tenantId, actorUserId: w.ceo.userId, action: "probe.event", sourceApp: "API" }),
    );
    const page = await listAuditEventsAsActor(w.ceo.actor, { filter: { action: "probe.event" } });
    expect(page.data).toHaveLength(1);
  });

  it("refuses roles without audit.view, and audit.view held only on a city scope", async () => {
    await expect(listAuditEventsAsActor(w.cityManagerA.actor)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listAuditEventsAsActor(w.finance.actor)).rejects.toBeInstanceOf(ForbiddenError);

    // A custom role with audit.view, but scoped to one city: the audit log is tenant-level data.
    const person = await createPerson(w.tenantId, "city-auditor", { withEmployee: false });
    const roleId = await withTenant(w.tenantId, async (tx) => {
      const permission = await tx.permission.findUniqueOrThrow({ where: { key: "audit.view" } });
      const role = await tx.role.create({ data: { tenantId: w.tenantId, name: `City auditor ${person.userId}` } });
      await tx.rolePermission.create({ data: { tenantId: w.tenantId, roleId: role.id, permissionId: permission.id } });
      return role.id;
    });
    await grantTemplate(w.tenantId, person, roleId, [{ type: "ORG_UNIT", orgUnitId: w.units.cityA }]);
    await expect(listAuditEventsAsActor(person.actor)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
