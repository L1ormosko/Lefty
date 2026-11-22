import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as listRoles, POST as createRole } from "@/app/api/v1/roles/route";
import { GET as getRole, PATCH as patchRole } from "@/app/api/v1/roles/[id]/route";
import { PUT as putPermissions } from "@/app/api/v1/roles/[id]/permissions/route";
import { POST as cloneRole } from "@/app/api/v1/roles/[id]/clone/route";
import { POST as archiveRole } from "@/app/api/v1/roles/[id]/archive/route";
import { GET as roleHistory } from "@/app/api/v1/roles/[id]/history/route";
import { can, provisionRoleTemplates } from "@/server/authz";
import { withTenant } from "@/server/db";
import { buildWorld, createPerson, disconnect, grantTemplate, makeRole, type Person, type World } from "../authz/fixtures";
import { auditEvents, call, sessionCookie } from "../org/org-helpers";

let w: World;
let ceo: string;
let admin: Person;
let adminCookie: string;
let adminRoleId: string;

beforeAll(async () => {
  w = await buildWorld("roles");
  ceo = await sessionCookie(w.ceo, w.tenantId);
  // A delegated role administrator: may define roles, but itself only holds jobs.view.
  adminRoleId = await makeRole(w.tenantId, "Role administrator", [
    { permission: "permissions.view" },
    { permission: "permissions.create" },
    { permission: "permissions.edit" },
    { permission: "permissions.archive" },
    { permission: "jobs.view" },
  ]);
  admin = await createPerson(w.tenantId, "role-admin", { withEmployee: false });
  await grantTemplate(w.tenantId, admin, adminRoleId, [{ type: "TENANT" }]);
  adminCookie = await sessionCookie(admin, w.tenantId);
});
afterAll(disconnect);

const unique = (label: string) => `${label} ${Math.random().toString(36).slice(2, 8)}`;
const create = (cookie: string, body: Record<string, unknown>) => call(createRole, "POST", "/api/v1/roles", { cookie, body });
const permissionKeys = (role: { permissions: Array<{ permission: string }> }) => role.permissions.map((entry) => entry.permission).sort();

describe("creating roles", () => {
  it("creates a role with qualified permissions and audits the definition", async () => {
    const name = unique("Scheduler");
    const result = await create(ceo, {
      name,
      description: "Plans jobs",
      permissions: [{ permission: "jobs.view" }, { permission: "jobs.edit", conditions: { fields: "operational" } }],
    });
    expect(result.status).toBe(201);
    expect(result.json.data).toMatchObject({ name, requiresMfa: false, isSystemTemplate: false, templateKey: null, permissionCount: 2, active: true });
    expect(result.json.data.permissions).toEqual([
      { permission: "jobs.edit", conditions: { fields: "operational" } },
      { permission: "jobs.view", conditions: null },
    ]);
    const [event] = await auditEvents(w.tenantId, "role.create", result.json.data.id);
    expect(event).toMatchObject({ actorUserId: w.ceo.userId });
    expect((event.newValue as { permissions: unknown[] }).permissions).toHaveLength(2);
  });

  it("forces MFA on roles that can change who may do what, however they are named", async () => {
    const result = await create(ceo, { name: unique("Helper"), requiresMfa: false, permissions: [{ permission: "permissions.assign" }] });
    expect(result.json.data.requiresMfa).toBe(true);
    const configure = await create(ceo, { name: unique("Configurer"), permissions: [{ permission: "company_settings.configure" }] });
    expect(configure.json.data.requiresMfa).toBe(true);
  });

  it("validates input: duplicate name, unknown permission, malformed conditions, repeated permission", async () => {
    const name = unique("Dup");
    expect((await create(ceo, { name, permissions: [] })).status).toBe(201);
    expect((await create(ceo, { name, permissions: [] })).status).toBe(409);
    const unknown = await create(ceo, { name: unique("X"), permissions: [{ permission: "nope.fly" }] });
    expect(unknown.status).toBe(400);
    expect((await create(ceo, { name: unique("X"), permissions: [{ permission: "jobs.view", conditions: { bogus: true } }] })).status).toBe(400);
    expect((await create(ceo, { name: unique("X"), permissions: [{ permission: "jobs.view" }, { permission: "jobs.view" }] })).status).toBe(400);
  });

  it("a user cannot grant permissions they do not hold, nor sensitive field sets they do not hold", async () => {
    // holds jobs.view (base) only
    expect((await create(adminCookie, { name: unique("Mine"), permissions: [{ permission: "jobs.view" }] })).status).toBe(201);
    expect((await create(adminCookie, { name: unique("Dispatch"), permissions: [{ permission: "dispatch.assign" }] })).status).toBe(403);
    expect((await create(adminCookie, { name: unique("Fin"), permissions: [{ permission: "jobs.view", conditions: { includeFields: ["financial"] } }] })).status).toBe(403);
    expect((await create(adminCookie, { name: unique("Fin2"), permissions: [{ permission: "jobs.view", conditions: { fields: "financial" } }] })).status).toBe(403);
    // including permissions.assign (which they lack) is how an admin would try to mint a super-role
    expect((await create(adminCookie, { name: unique("Super"), permissions: [{ permission: "permissions.assign" }] })).status).toBe(403);
  });

  it("requires a tenant-wide permissions.create and authentication", async () => {
    expect((await create(await sessionCookie(w.techA1, w.tenantId), { name: unique("X"), permissions: [] })).status).toBe(403);
    expect((await create(await sessionCookie(w.cityManagerA, w.tenantId), { name: unique("X"), permissions: [] })).status).toBe(403);
    expect((await call(createRole, "POST", "/x", { body: { name: "x", permissions: [] } })).status).toBe(401);
  });
});

describe("cloning", () => {
  it("copies a template under a new name without becoming the template", async () => {
    const result = await call(cloneRole, "POST", "/x", { cookie: ceo, params: { id: w.roles.DISPATCHER }, body: { name: unique("Night dispatcher") } });
    expect(result.status).toBe(201);
    const original = await call(getRole, "GET", "/x", { cookie: ceo, params: { id: w.roles.DISPATCHER } });
    expect(permissionKeys(result.json.data)).toEqual(permissionKeys(original.json.data));
    expect(result.json.data).toMatchObject({ templateKey: null, isSystemTemplate: false });
    // qualifiers (e.g. Dispatcher's availability-only employee grant) are copied too
    expect(result.json.data.permissions.find((p: { permission: string }) => p.permission === "employees.view").conditions).toEqual({ fields: "availability" });

    // re-provisioning still points the template at the ORIGINAL role, never at the clone
    const mapping = await withTenant(w.tenantId, (tx) => provisionRoleTemplates(tx, w.tenantId));
    expect(mapping.DISPATCHER).toBe(w.roles.DISPATCHER);
    const [event] = await auditEvents(w.tenantId, "role.clone", result.json.data.id);
    expect((event.newValue as { clonedFromRoleId: string }).clonedFromRoleId).toBe(w.roles.DISPATCHER);
  });

  it("refuses to clone a role containing permissions the cloner does not hold, and a duplicate name", async () => {
    expect((await call(cloneRole, "POST", "/x", { cookie: adminCookie, params: { id: w.roles.DISPATCHER }, body: { name: unique("Stolen") } })).status).toBe(403);
    const name = unique("Same");
    expect((await call(cloneRole, "POST", "/x", { cookie: ceo, params: { id: w.roles.TEAM_LEADER }, body: { name } })).status).toBe(201);
    expect((await call(cloneRole, "POST", "/x", { cookie: ceo, params: { id: w.roles.TEAM_LEADER }, body: { name } })).status).toBe(409);
  });

  it("the clone of an MFA-mandatory role stays MFA-mandatory", async () => {
    const result = await call(cloneRole, "POST", "/x", { cookie: ceo, params: { id: w.roles.FINANCE_DIRECTOR }, body: { name: unique("Finance copy") } });
    expect(result.json.data.requiresMfa).toBe(true);
  });
});

describe("editing permissions", () => {
  it("replaces the permission set, records what was added/removed/changed, and serves it as history", async () => {
    const role = (await create(ceo, { name: unique("Evolving"), permissions: [{ permission: "jobs.view" }, { permission: "leads.view" }] })).json.data;
    const result = await call(putPermissions, "PUT", "/x", {
      cookie: ceo,
      params: { id: role.id },
      body: { permissions: [{ permission: "jobs.view", conditions: { fields: "operational" } }, { permission: "customers.view" }], reason: "Quarterly review" },
    });
    expect(result.status).toBe(200);
    expect(permissionKeys(result.json.data)).toEqual(["customers.view", "jobs.view"]);

    const history = await call(roleHistory, "GET", "/x", { cookie: ceo, params: { id: role.id } });
    expect(history.status).toBe(200);
    const [change, creation] = history.json.data;
    expect(creation.action).toBe("role.create");
    expect(change).toMatchObject({ action: "role.permissions_change", reason: "Quarterly review", actor: { userId: w.ceo.userId } });
    expect(change.changes).toEqual({
      permissionsAdded: ["customers.view"],
      permissionsRemoved: ["leads.view"],
      permissionsChanged: ["jobs.view"],
      fieldsChanged: [],
    });
    expect(creation.changes.permissionsAdded.sort()).toEqual(["jobs.view", "leads.view"]);

    // History is an explicit projection: no network data, no raw audit values, no qualifiers.
    const serialized = JSON.stringify(history.json.data);
    for (const leaked of ["ipAddress", "userAgent", "previousValue", "newValue", "correlationId", "tenantId", "conditions", "operational"]) {
      expect(serialized).not.toContain(leaked);
    }
    expect(Object.keys(change).sort()).toEqual(["action", "actor", "changes", "id", "occurredAt", "reason"]);

    const paged = await call(roleHistory, "GET", "/x", { cookie: ceo, params: { id: role.id }, query: { limit: "1" } });
    expect(paged.json.data).toHaveLength(1);
    expect(paged.json.page.nextCursor).toBeTruthy();
  });

  it("requires MFA for custom roles holding a sensitive permission or a sensitive field set, not for harmless ones", async () => {
    const harmless = await create(ceo, { name: unique("Harmless"), permissions: [{ permission: "jobs.view" }] });
    expect(harmless.json.data.requiresMfa).toBe(false);
    const money = await create(ceo, { name: unique("Money"), requiresMfa: false, permissions: [{ permission: "financial_reports.view" }] });
    expect(money.json.data.requiresMfa).toBe(true);
    const exporter = await create(ceo, { name: unique("Exporter"), permissions: [{ permission: "employees.export" }] });
    expect(exporter.json.data.requiresMfa).toBe(true);
    const financialFields = await create(ceo, { name: unique("FinFields"), permissions: [{ permission: "employees.view", conditions: { includeFields: ["financial"] } }] });
    expect(financialFields.json.data.requiresMfa).toBe(true);

    // Editing a harmless role into a sensitive one raises the flag on save.
    const raised = await call(putPermissions, "PUT", "/x", { cookie: ceo, params: { id: harmless.json.data.id }, body: { permissions: [{ permission: "jobs.view" }, { permission: "compensation.view" }] } });
    expect(raised.json.data.requiresMfa).toBe(true);
  });

  it("a no-op replacement writes nothing; adding an MFA-triggering permission raises the MFA flag", async () => {
    const role = (await create(ceo, { name: unique("Stable"), permissions: [{ permission: "jobs.view" }] })).json.data;
    const same = await call(putPermissions, "PUT", "/x", { cookie: ceo, params: { id: role.id }, body: { permissions: [{ permission: "jobs.view" }] } });
    expect(same.status).toBe(200);
    expect((await auditEvents(w.tenantId, "role.permissions_change", role.id)).length).toBe(0);

    const raised = await call(putPermissions, "PUT", "/x", { cookie: ceo, params: { id: role.id }, body: { permissions: [{ permission: "jobs.view" }, { permission: "permissions.manage" }] } });
    expect(raised.json.data.requiresMfa).toBe(true);
  });

  it("an editor may remove permissions they do not hold but may not add them", async () => {
    const role = (await create(ceo, { name: unique("Mixed"), permissions: [{ permission: "jobs.view" }, { permission: "dispatch.assign" }] })).json.data;
    const removal = await call(putPermissions, "PUT", "/x", { cookie: adminCookie, params: { id: role.id }, body: { permissions: [{ permission: "jobs.view" }] } });
    expect(removal.status).toBe(200);
    const addition = await call(putPermissions, "PUT", "/x", { cookie: adminCookie, params: { id: role.id }, body: { permissions: [{ permission: "jobs.view" }, { permission: "dispatch.assign" }] } });
    expect(addition.status).toBe(403);
  });

  it("cannot edit a role assigned to yourself (separation of duties), but can edit others", async () => {
    // The administrator holds `adminRoleId` themselves.
    expect((await call(patchRole, "PATCH", "/x", { cookie: adminCookie, params: { id: adminRoleId }, body: { description: "I am the boss" } })).status).toBe(403);
    expect((await call(putPermissions, "PUT", "/x", { cookie: adminCookie, params: { id: adminRoleId }, body: { permissions: [{ permission: "jobs.view" }, { permission: "permissions.edit" }] } })).status).toBe(403);
    expect((await call(archiveRole, "POST", "/x", { cookie: adminCookie, params: { id: adminRoleId }, body: { reason: "x" } })).status).toBe(403);
    const unchanged = await withTenant(w.tenantId, (tx) => tx.role.findUniqueOrThrow({ where: { id: adminRoleId } }));
    expect(unchanged.active).toBe(true);
    expect(unchanged.description).toBeNull();

    const other = (await create(adminCookie, { name: unique("Other"), permissions: [{ permission: "jobs.view" }] })).json.data;
    expect((await call(patchRole, "PATCH", "/x", { cookie: adminCookie, params: { id: other.id }, body: { description: "fine" } })).status).toBe(200);
    // the Owner is not exempt either: their own role cannot be edited by themselves
    expect((await call(patchRole, "PATCH", "/x", { cookie: ceo, params: { id: w.roles.OWNER_CEO }, body: { description: "mine" } })).status).toBe(403);
  });

  it("MFA can be raised but not lowered while permissions or the template make it mandatory", async () => {
    const result = await call(patchRole, "PATCH", "/x", { cookie: ceo, params: { id: w.roles.FINANCE_DIRECTOR }, body: { requiresMfa: false } });
    expect(result.status).toBe(400);
    expect(result.json.error.field).toBe("requiresMfa");
    const plain = (await create(ceo, { name: unique("Plain"), permissions: [{ permission: "jobs.view" }] })).json.data;
    expect((await call(patchRole, "PATCH", "/x", { cookie: ceo, params: { id: plain.id }, body: { requiresMfa: true, name: unique("Plain2") } })).json.data.requiresMfa).toBe(true);
  });
});

describe("archiving, reading and isolation", () => {
  it("an archived role stops granting access immediately and cannot be edited", async () => {
    const roleId = await makeRole(w.tenantId, "Soon archived", [{ permission: "jobs.view" }]);
    const person = await createPerson(w.tenantId, "holder", { withEmployee: false });
    await grantTemplate(w.tenantId, person, roleId, [{ type: "TENANT" }]);
    expect((await can(person.actor, "jobs.view")).allowed).toBe(true);

    const result = await call(archiveRole, "POST", "/x", { cookie: ceo, params: { id: roleId }, body: { reason: "Obsolete" } });
    expect(result.status).toBe(200);
    expect(result.json.data.active).toBe(false);
    expect((await can(person.actor, "jobs.view")).allowed).toBe(false);
    expect((await call(archiveRole, "POST", "/x", { cookie: ceo, params: { id: roleId }, body: { reason: "again" } })).status).toBe(409);
    expect((await call(patchRole, "PATCH", "/x", { cookie: ceo, params: { id: roleId }, body: { description: "x" } })).status).toBe(409);
    expect((await auditEvents(w.tenantId, "role.archive", roleId))[0].reason).toBe("Obsolete");
  });

  it("lists roles with pagination and filters; unit-scoped holders of permissions.view see none", async () => {
    const first = await call(listRoles, "GET", "/api/v1/roles", { cookie: ceo, query: { limit: "5" } });
    expect(first.status).toBe(200);
    expect(first.json.data).toHaveLength(5);
    expect(first.json.data[0].permissions).toBeUndefined(); // summaries only; the detail has them
    expect(typeof first.json.data[0].permissionCount).toBe("number");
    expect(first.json.page.nextCursor).toBeTruthy();

    const search = await call(listRoles, "GET", "/x", { cookie: ceo, query: { search: "Dispatcher" } });
    expect(search.json.data.some((role: { id: string }) => role.id === w.roles.DISPATCHER)).toBe(true);

    const viewerRole = await makeRole(w.tenantId, "Unit role viewer", [{ permission: "permissions.view" }]);
    const viewer = await createPerson(w.tenantId, "unit-viewer", { orgUnitId: w.units.cityA });
    await grantTemplate(w.tenantId, viewer, viewerRole, [{ type: "ORG_UNIT", orgUnitId: w.units.cityA }]);
    const cookie = await sessionCookie(viewer, w.tenantId);
    const scoped = await call(listRoles, "GET", "/x", { cookie });
    expect(scoped.status).toBe(200);
    expect(scoped.json.data).toEqual([]); // role definitions are tenant-level
    expect((await call(getRole, "GET", "/x", { cookie, params: { id: w.roles.DISPATCHER } })).status).toBe(403);
    expect((await call(listRoles, "GET", "/x", { cookie: await sessionCookie(w.techA1, w.tenantId) })).status).toBe(403);
  });

  it("never lets one tenant see or change another tenant's roles", async () => {
    const other = await buildWorld("roles-other");
    expect((await call(getRole, "GET", "/x", { cookie: ceo, params: { id: other.roles.DISPATCHER } })).status).toBe(404);
    expect((await call(patchRole, "PATCH", "/x", { cookie: ceo, params: { id: other.roles.DISPATCHER }, body: { description: "x" } })).status).toBe(404);
    expect((await call(cloneRole, "POST", "/x", { cookie: ceo, params: { id: other.roles.DISPATCHER }, body: { name: unique("Leak") } })).status).toBe(404);
    expect((await call(roleHistory, "GET", "/x", { cookie: ceo, params: { id: other.roles.DISPATCHER } })).status).toBe(404);
    const row = await withTenant(other.tenantId, (tx) => tx.role.findUniqueOrThrow({ where: { id: other.roles.DISPATCHER } }));
    expect(row.description).not.toBe("x");
    const listed = await call(listRoles, "GET", "/x", { cookie: ceo, query: { limit: "200" } });
    expect(listed.json.data.some((role: { id: string }) => role.id === other.roles.DISPATCHER)).toBe(false);
  });
});

describe("editing a role that is already assigned", () => {
  /** An editor who may edit roles tenant-wide but holds employees.view only over City A. */
  async function narrowEditor() {
    const editRole = await makeRole(w.tenantId, "Role editor", [{ permission: "permissions.view" }, { permission: "permissions.edit" }]);
    const viewRole = await makeRole(w.tenantId, "City A employee viewer", [{ permission: "employees.view" }, { permission: "customers.view" }]);
    const editor = await createPerson(w.tenantId, "narrow-editor", { withEmployee: false });
    await grantTemplate(w.tenantId, editor, editRole, [{ type: "TENANT" }]);
    await grantTemplate(w.tenantId, editor, viewRole, [{ type: "ORG_UNIT", orgUnitId: w.units.cityA }]);
    return sessionCookie(editor, w.tenantId);
  }
  const withEmployeeView = [{ permission: "jobs.view" }, { permission: "employees.view" }];

  it("refuses to add a permission to a role held over scopes the editor could not grant it in", async () => {
    const cookie = await narrowEditor();
    const role = (await create(ceo, { name: unique("Tenant-wide holders"), permissions: [{ permission: "jobs.view" }] })).json.data;
    const holder = await createPerson(w.tenantId, "tenant-holder", { withEmployee: false });
    await grantTemplate(w.tenantId, holder, role.id, [{ type: "TENANT" }]);

    const result = await call(putPermissions, "PUT", "/x", { cookie, params: { id: role.id }, body: { permissions: withEmployeeView } });
    expect(result.status).toBe(403);
    expect(permissionKeys((await call(getRole, "GET", "/x", { cookie: ceo, params: { id: role.id } })).json.data)).toEqual(["jobs.view"]);
  });

  it("allows it when every live holder is inside the editor's reach; revoked and expired holders do not count", async () => {
    const cookie = await narrowEditor();
    const role = (await create(ceo, { name: unique("City A holders"), permissions: [{ permission: "jobs.view" }] })).json.data;
    const insider = await createPerson(w.tenantId, "city-holder", { orgUnitId: w.units.cityA });
    await grantTemplate(w.tenantId, insider, role.id, [{ type: "ORG_UNIT", orgUnitId: w.units.cityA }]);
    // a tenant-wide holder whose assignment is already revoked must not block the edit
    const gone = await createPerson(w.tenantId, "former-holder", { withEmployee: false });
    const goneAssignment = await grantTemplate(w.tenantId, gone, role.id, [{ type: "TENANT" }]);
    await withTenant(w.tenantId, (tx) => tx.roleAssignment.update({ where: { id: goneAssignment }, data: { revokedAt: new Date() } }));

    const result = await call(putPermissions, "PUT", "/x", { cookie, params: { id: role.id }, body: { permissions: withEmployeeView } });
    expect(result.status).toBe(200);

    // and a new tenant-wide holder afterwards makes the next edit impossible. The editor DOES hold
    // customers.view (over City A), so the permission itself passes assertMayDefineGrants; only the holder
    // check (assertMayGrantToExistingHolders) can refuse it.
    const wide = await createPerson(w.tenantId, "late-holder", { withEmployee: false });
    await grantTemplate(w.tenantId, wide, role.id, [{ type: "TENANT" }]);
    const more = await call(putPermissions, "PUT", "/x", { cookie, params: { id: role.id }, body: { permissions: [...withEmployeeView, { permission: "customers.view" }] } });
    expect(more.status).toBe(403);
    expect(more.json.error.message).toMatch(/assigned over scopes/); // the holder check, not "do not hold"
    // control: the same addition on a role with only a City A holder is fine
    const control = (await create(ceo, { name: unique("Control"), permissions: [{ permission: "jobs.view" }] })).json.data;
    const local = await createPerson(w.tenantId, "control-holder", { orgUnitId: w.units.cityA });
    await grantTemplate(w.tenantId, local, control.id, [{ type: "ORG_UNIT", orgUnitId: w.units.cityA }]);
    expect((await call(putPermissions, "PUT", "/x", { cookie, params: { id: control.id }, body: { permissions: [{ permission: "jobs.view" }, { permission: "customers.view" }] } })).status).toBe(200);
  });

  it("a tenant-wide editor who holds the permission tenant-wide may edit any role", async () => {
    const role = (await create(ceo, { name: unique("Anyone"), permissions: [{ permission: "jobs.view" }] })).json.data;
    const holder = await createPerson(w.tenantId, "any-holder", { withEmployee: false });
    await grantTemplate(w.tenantId, holder, role.id, [{ type: "TENANT" }]);
    expect((await call(putPermissions, "PUT", "/x", { cookie: ceo, params: { id: role.id }, body: { permissions: withEmployeeView } })).status).toBe(200);
  });
});
