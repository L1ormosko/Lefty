import { describe, expect, it } from "vitest";
import { saveRoleDefinition } from "@/server/roles";
import { withTenant } from "@/server/db";
import { buildWorld, makeRole } from "../authz/fixtures";
import { auditEvents, contextFor } from "../org/org-helpers";

describe("saveRoleDefinition", () => {
  it("renames and re-permissions in one transaction, keeping conditions of grants that stay", async () => {
    const world = await buildWorld("save-role");
    const roleId = await makeRole(world.tenantId, "Editable", [
      { permission: "employees.view", conditions: { fields: "financial" } },
      { permission: "jobs.view" },
    ]);
    await saveRoleDefinition(world.ceo.actor, contextFor(world.ceo.actor), roleId, {
      update: { name: "Renamed role" },
      permissionKeys: ["employees.view", "leads.view"],
      reason: "tidy",
    });
    const row = await withTenant(world.tenantId, (tx) =>
      tx.role.findUniqueOrThrow({ where: { id: roleId }, include: { permissions: { include: { permission: true } } } }),
    );
    expect(row.name).toBe("Renamed role");
    const byKey = new Map(row.permissions.map((entry) => [entry.permission.key, entry.conditions]));
    expect([...byKey.keys()].sort()).toEqual(["employees.view", "leads.view"]);
    expect(byKey.get("employees.view")).toEqual({ fields: "financial" });
  });

  it("leaves the name and the audit trail untouched when the permission change fails", async () => {
    const world = await buildWorld("save-role-atomic");
    const roleId = await makeRole(world.tenantId, "Stays", [{ permission: "jobs.view" }]);
    await expect(
      saveRoleDefinition(world.ceo.actor, contextFor(world.ceo.actor), roleId, {
        update: { name: "Should not stick" },
        permissionKeys: ["jobs.view", "not.a_permission"],
      }),
    ).rejects.toBeTruthy();
    const role = await withTenant(world.tenantId, (tx) => tx.role.findUniqueOrThrow({ where: { id: roleId } }));
    expect(role.name).toMatch(/^Stays/);
    expect(await auditEvents(world.tenantId, "role.update", roleId)).toHaveLength(0);
  });

  it("answers 403 before any lookup for a caller without permissions.edit", async () => {
    const world = await buildWorld("save-role-deny");
    await expect(
      saveRoleDefinition(world.cityManagerA.actor, contextFor(world.cityManagerA.actor), "does-not-exist", { update: { name: "x" }, permissionKeys: [] }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
