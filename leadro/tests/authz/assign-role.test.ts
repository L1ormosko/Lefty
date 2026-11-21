import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { bootstrapRoleAssignment } from "@/server/authz";
import { ConflictError, NotFoundError, ValidationError } from "@/server/core";
import { withTenant } from "@/server/db";
import { buildWorld, createPerson, disconnect, type World } from "./fixtures";

let w: World;
const HOUR = 3_600_000;

beforeAll(async () => {
  w = await buildWorld("authz-assign");
});
afterAll(disconnect);

const assign = (userId: string, input: Partial<Parameters<typeof bootstrapRoleAssignment>[1]> = {}) =>
  withTenant(w.tenantId, (tx) =>
    bootstrapRoleAssignment(tx, {
      tenantId: w.tenantId,
      userId,
      roleId: w.roles.CITY_MANAGER,
      scopes: [{ type: "ORG_UNIT", orgUnitId: w.units.cityA }],
      ...input,
    }),
  );

describe("role assignment duplicate guard", () => {
  it("rejects the same (user, role, scope) while an overlapping assignment is active", async () => {
    const person = await createPerson(w.tenantId, "dup", { withEmployee: false });
    await assign(person.userId);
    await expect(assign(person.userId)).rejects.toBeInstanceOf(ConflictError);
  });

  it("allows the same role with a different scope, and a different role with the same scope", async () => {
    const person = await createPerson(w.tenantId, "dup-ok", { withEmployee: false });
    await assign(person.userId);
    await expect(assign(person.userId, { scopes: [{ type: "ORG_UNIT", orgUnitId: w.units.cityB }] })).resolves.toBeDefined();
    await expect(assign(person.userId, { roleId: w.roles.TEAM_LEADER })).resolves.toBeDefined();
  });

  it("allows a re-grant for a later, non-overlapping period", async () => {
    const person = await createPerson(w.tenantId, "dup-later", { withEmployee: false });
    await assign(person.userId, { effectiveTo: new Date(Date.now() + HOUR) });
    await expect(assign(person.userId, { effectiveFrom: new Date(Date.now() + 2 * HOUR) })).resolves.toBeDefined();
    await expect(assign(person.userId, { effectiveFrom: new Date(Date.now() + HOUR / 2) })).rejects.toBeInstanceOf(ConflictError);
  });

  it("ignores revoked assignments", async () => {
    const person = await createPerson(w.tenantId, "dup-revoked", { withEmployee: false });
    const { roleAssignmentId } = await assign(person.userId);
    await withTenant(w.tenantId, (tx) => tx.roleAssignment.update({ where: { id: roleAssignmentId }, data: { revokedAt: new Date() } }));
    await expect(assign(person.userId)).resolves.toBeDefined();
  });

  it("lets only one of two concurrent identical grants win", async () => {
    const person = await createPerson(w.tenantId, "dup-race", { withEmployee: false });
    const results = await Promise.allSettled([assign(person.userId), assign(person.userId)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ConflictError);
  });
});

describe("role assignment validation", () => {
  it("requires at least one scope and a consistent target per scope type", async () => {
    const person = await createPerson(w.tenantId, "val", { withEmployee: false });
    await expect(assign(person.userId, { scopes: [] })).rejects.toBeInstanceOf(ValidationError);
    await expect(assign(person.userId, { scopes: [{ type: "ORG_UNIT" }] })).rejects.toBeInstanceOf(ValidationError);
    await expect(assign(person.userId, { scopes: [{ type: "TENANT", orgUnitId: w.units.cityA }] })).rejects.toBeInstanceOf(ValidationError);
    await expect(assign(person.userId, { effectiveTo: new Date(Date.now() - HOUR) })).rejects.toBeInstanceOf(ValidationError);
  });

  it("does not accept a role, user or org unit of another tenant", async () => {
    const other = await buildWorld("authz-assign-other");
    const person = await createPerson(w.tenantId, "val-x", { withEmployee: false });
    await expect(assign(person.userId, { roleId: other.roles.CITY_MANAGER })).rejects.toBeInstanceOf(NotFoundError);
    await expect(assign(person.userId, { scopes: [{ type: "ORG_UNIT", orgUnitId: other.units.cityA }] })).rejects.toBeInstanceOf(NotFoundError);
    await expect(assign(other.ceo.userId)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("writes an audit event with the granted scopes", async () => {
    const person = await createPerson(w.tenantId, "val-audit", { withEmployee: false });
    const { roleAssignmentId } = await assign(person.userId, { reason: "covering for vacation" });
    const events = await withTenant(w.tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: "role_assignment.grant", targetId: roleAssignmentId } }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ reason: "covering for vacation", targetType: "RoleAssignment" });
  });
});
