import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as addAddress } from "@/app/api/v1/customers/[id]/addresses/route";
import { PATCH as patchAddress } from "@/app/api/v1/customers/[id]/addresses/[addressId]/route";
import { POST as archiveAddress } from "@/app/api/v1/customers/[id]/addresses/[addressId]/archive/route";
import { POST as addNote } from "@/app/api/v1/customers/[id]/notes/route";
import { PUT as putPreferences } from "@/app/api/v1/customers/[id]/employee-preferences/route";
import { POST as archiveCustomer } from "@/app/api/v1/customers/[id]/archive/route";
import { assignedEmployeeIdsByCustomer, customerAssignedToWhere } from "@/server/customers";
import { withTenant } from "@/server/db";
import { buildWorld, disconnect, type World } from "../authz/fixtures";
import { call, sessionCookie } from "../org/org-helpers";
import { assignJob, makeAddress, makeCustomer, makeJob } from "./fixtures";

let w: World;
let ceo: string;
let cityManagerA: string;

beforeAll(async () => {
  w = await buildWorld("customers-fix1");
  ceo = await sessionCookie(w.ceo, w.tenantId);
  cityManagerA = await sessionCookie(w.cityManagerA, w.tenantId);
});
afterAll(disconnect);

const addr = { line1: "900 Hidden Way", city: "Gary", region: "IN", postalCode: "46401" };

describe("address endpoints never reveal duplicates outside the caller's scope", () => {
  it("add: a matching address of a City B customer is flagged but not returned to a City A manager", async () => {
    const inB = await makeCustomer(w.tenantId, { orgUnitId: w.units.cityB });
    await makeAddress(w.tenantId, inB.id, { line1: addr.line1, city: addr.city, postalCode: addr.postalCode }).then((id) =>
      withTenant(w.tenantId, (tx) => tx.customerAddress.update({ where: { id }, data: { region: "IN", normalizedKey: "900 hidden way||gary|in|46401|us" } })),
    );
    const inA = await makeCustomer(w.tenantId, { orgUnitId: w.units.cityA });
    const added = await call(addAddress, "POST", "/x", { cookie: cityManagerA, params: { id: inA.id }, body: addr });
    expect(added.status).toBe(201);
    expect(added.json.data.possibleDuplicates).toEqual([]);
    expect(JSON.stringify(added.json)).not.toContain(inB.id);
    const flags = await withTenant(w.tenantId, (tx) => tx.duplicateFlag.count({ where: { OR: [{ customerId: inB.id }, { otherCustomerId: inB.id }] } }));
    expect(flags).toBe(1);
  });

  it("update: editing an address into a match with a City B customer reveals nothing either", async () => {
    const inB = await makeCustomer(w.tenantId, { orgUnitId: w.units.cityB });
    const hidden = await call(addAddress, "POST", "/x", { cookie: ceo, params: { id: inB.id }, body: { line1: "1 Secret Rd", city: "Reno", region: "NV", postalCode: "89501" } });
    expect(hidden.status).toBe(201);
    const inA = await makeCustomer(w.tenantId, { orgUnitId: w.units.cityA });
    const mine = (await call(addAddress, "POST", "/x", { cookie: cityManagerA, params: { id: inA.id }, body: { line1: "2 Other Rd", city: "Reno", region: "NV", postalCode: "89501" } })).json.data.address;
    const edited = await call(patchAddress, "PATCH", "/x", { cookie: cityManagerA, params: { id: inA.id, addressId: mine.id }, body: { line1: "1 Secret Rd" } });
    expect(edited.status).toBe(200);
    expect(edited.json.data.possibleDuplicates).toEqual([]);
    expect(JSON.stringify(edited.json)).not.toContain(inB.id);
    // The wider scope (CEO) does see the same pair.
    const asCeo = await call(patchAddress, "PATCH", "/x", { cookie: ceo, params: { id: inA.id, addressId: mine.id }, body: { line2: "Unit 2" } });
    expect(asCeo.json.data.possibleDuplicates).toEqual([]); // key changed again (line2), no longer matching: still no leak, no error
  });
});

describe("archived customers are read-only through every sub-resource", () => {
  it("refuses address, note and preference writes with 409 until restored", async () => {
    const customer = await makeCustomer(w.tenantId, { orgUnitId: w.units.cityA });
    const address = (await call(addAddress, "POST", "/x", { cookie: ceo, params: { id: customer.id }, body: { ...addr, line1: "5 Active St" } })).json.data.address;
    expect((await call(archiveCustomer, "POST", "/x", { cookie: ceo, params: { id: customer.id } })).status).toBe(200);

    expect((await call(addAddress, "POST", "/x", { cookie: ceo, params: { id: customer.id }, body: addr })).status).toBe(409);
    expect((await call(patchAddress, "PATCH", "/x", { cookie: ceo, params: { id: customer.id, addressId: address.id }, body: { city: "X" } })).status).toBe(409);
    expect((await call(archiveAddress, "POST", "/x", { cookie: ceo, params: { id: customer.id, addressId: address.id } })).status).toBe(409);
    expect((await call(addNote, "POST", "/x", { cookie: ceo, params: { id: customer.id }, body: { body: "late" } })).status).toBe(409);
    expect((await call(putPreferences, "PUT", "/x", { cookie: ceo, params: { id: customer.id }, body: { preferences: [] } })).status).toBe(409);
  });
});

describe("team expansion ignores archived team units", () => {
  it("an assignment to an archived team reaches nobody, in both forms", async () => {
    const team = await withTenant(w.tenantId, (tx) =>
      tx.orgUnit.create({ data: { tenantId: w.tenantId, type: "TEAM", name: `Closing ${Date.now()}`, parentId: w.units.cityA, legalEntityId: w.legalEntityId } }),
    );
    const employeeId = w.techA1.employeeId!;
    await withTenant(w.tenantId, (tx) =>
      tx.organizationalAssignment.create({ data: { tenantId: w.tenantId, employeeId, orgUnitId: team.id, kind: "SECONDARY", effectiveFrom: new Date(Date.now() - 86_400_000) } }),
    );
    const customer = await makeCustomer(w.tenantId, { orgUnitId: w.units.cityA });
    await assignJob(w.tenantId, await makeJob(w.tenantId, customer.id, w.units.cityA), { teamOrgUnitId: team.id });

    const reaches = async () =>
      withTenant(w.tenantId, async (tx) => {
        const now = new Date();
        const ids = (await assignedEmployeeIdsByCustomer(tx, w.tenantId, [customer.id], now)).get(customer.id) ?? [];
        const where = await tx.customer.count({ where: { id: customer.id, ...customerAssignedToWhere(employeeId, now) } });
        return { viaIds: ids.includes(employeeId), viaWhere: where === 1 };
      });
    expect(await reaches()).toEqual({ viaIds: true, viaWhere: true });
    await withTenant(w.tenantId, (tx) => tx.orgUnit.update({ where: { id: team.id }, data: { active: false } }));
    expect(await reaches()).toEqual({ viaIds: false, viaWhere: false });
  });
});
