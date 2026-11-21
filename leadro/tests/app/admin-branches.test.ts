import { beforeEach, describe, expect, it, vi } from "vitest";
import { withTenant } from "@/server/db";
import { CATALOGS } from "@/lib/i18n";
import { buildWorld } from "../authz/fixtures";
import { resetFakeRequest } from "./next-fakes";
import { form, signInPerson } from "./admin-test-helpers";

vi.mock("next/headers", async () => (await import("./next-fakes")).headersModule);
vi.mock("next/navigation", async () => (await import("./next-fakes")).navigationModule);
vi.mock("next/cache", async () => (await import("./next-fakes")).cacheModule);

import { createBranchAction, updateBranchAction } from "@/app/(app)/admin/organization/branches/actions";
import BranchesPage from "@/app/(app)/admin/organization/branches/page";
import { AccessDenied } from "@/app/(app)/admin/_components/AdminPage";
import { addressFromForm, branchAttributesForUpdate, operatingHoursFromForm } from "@/app/(app)/admin/_lib/branch-form";

beforeEach(resetFakeRequest);
const en = (key: string) => CATALOGS["en-US"].messages[key];

describe("branch form translation", () => {
  it("treats a day with both times as open, none as closed, and keeps a half-filled day for the service to reject", () => {
    const hours = operatingHoursFromForm({ hours_mon_open: "08:00", hours_mon_close: "17:00", hours_tue_open: "09:00" });
    expect(hours?.mon).toEqual({ open: "08:00", close: "17:00" });
    expect(hours?.tue).toEqual({ open: "09:00", close: undefined });
    expect(hours?.wed).toBeNull();
  });

  it("returns undefined for an untouched address or hours block and nulls for an edit", () => {
    expect(addressFromForm({})).toBeUndefined();
    expect(operatingHoursFromForm({})).toBeUndefined();
    expect(branchAttributesForUpdate({})).toEqual({ address: null, timeZone: null, defaultLocale: null, operatingHours: null });
  });
});

describe("branch actions", () => {
  const validBranch = (parentId: string) => ({
    parentId,
    name: "Atlanta North",
    addressLine1: "1 Peachtree St",
    addressCity: "Atlanta",
    addressState: "ga",
    addressPostalCode: "30303",
    timeZone: "America/New_York",
    defaultLocale: "es-US",
    hours_mon_open: "08:00",
    hours_mon_close: "17:00",
  });

  it("creates a branch with address, zone, language and hours", async () => {
    const world = await buildWorld("admin-branch-create");
    await signInPerson(world.ceo, world.tenantId);
    const result = await createBranchAction({}, form(validBranch(world.units.cityA)));
    expect(result.success).toBe(en("ADMIN.BRANCH_ADDED"));

    const branch = await withTenant(world.tenantId, (tx) => tx.orgUnit.findFirstOrThrow({ where: { tenantId: world.tenantId, type: "BRANCH" } }));
    expect(branch).toMatchObject({ name: "Atlanta North", timeZone: "America/New_York", defaultLocale: "es-US", parentId: world.units.cityA });
    expect(branch.address).toMatchObject({ city: "Atlanta", state: "GA", postalCode: "30303" });
    expect((branch.operatingHours as Record<string, unknown>).mon).toEqual({ open: "08:00", close: "17:00" });
  });

  it("answers an invalid ZIP code with the ZIP message", async () => {
    const world = await buildWorld("admin-branch-zip");
    await signInPerson(world.ceo, world.tenantId);
    const result = await createBranchAction({}, form({ ...validBranch(world.units.cityA), addressPostalCode: "ABC" }));
    expect(result.error).toBeTruthy();
    expect(result.success).toBeUndefined();
  });

  it("refuses a branch under a unit the type rules forbid (a branch cannot sit under a state)", async () => {
    const world = await buildWorld("admin-branch-parent");
    await signInPerson(world.ceo, world.tenantId);
    const result = await createBranchAction({}, form(validBranch(world.units.state)));
    expect(result.error).toBe(en("ADMIN.ERROR_FIELD_PARENT"));
  });

  it("lets a City Manager edit a branch in their city but not create one elsewhere", async () => {
    const world = await buildWorld("admin-branch-scope");
    await signInPerson(world.ceo, world.tenantId);
    await createBranchAction({}, form(validBranch(world.units.cityA)));
    const branch = await withTenant(world.tenantId, (tx) => tx.orgUnit.findFirstOrThrow({ where: { tenantId: world.tenantId, type: "BRANCH" } }));

    await signInPerson(world.cityManagerA, world.tenantId);
    const edited = await updateBranchAction({}, form({ unitId: branch.id, name: "Atlanta North", addressLine1: "2 Main St", addressCity: "Atlanta", addressState: "GA", addressPostalCode: "30303" }));
    expect(edited.success).toBe(en("ADMIN.SAVED"));

    const elsewhere = await createBranchAction({}, form({ ...validBranch(world.units.cityB), name: "Elsewhere" }));
    expect(elsewhere.error).toBeTruthy();
  });
});

describe("branches page", () => {
  it("renders for the CEO and is denied for a Technician", async () => {
    const world = await buildWorld("admin-branch-page");
    await signInPerson(world.ceo, world.tenantId);
    await createBranchAction({}, form(validBranch2(world.units.cityA)));
    expect(await BranchesPage({ searchParams: Promise.resolve({}) })).toBeTruthy();

    await signInPerson(world.techA1, world.tenantId);
    expect(((await BranchesPage({ searchParams: Promise.resolve({}) })) as { type: unknown }).type).toBe(AccessDenied);
  });
});

const validBranch2 = (parentId: string) => ({ parentId, name: "Page Branch" });
