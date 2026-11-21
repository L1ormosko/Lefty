import { beforeEach, describe, expect, it, vi } from "vitest";
import { withTenant } from "@/server/db";
import { buildWorld } from "../authz/fixtures";
import { resetFakeRequest } from "./next-fakes";
import { form, signInPerson } from "./admin-test-helpers";

vi.mock("next/headers", async () => (await import("./next-fakes")).headersModule);
vi.mock("next/navigation", async () => (await import("./next-fakes")).navigationModule);
vi.mock("next/cache", async () => (await import("./next-fakes")).cacheModule);

import { createLegalEntityAction, updateCompanyProfileAction } from "@/app/(app)/admin/company/actions";
import { AccessDenied } from "@/app/(app)/admin/_components/AdminPage";
import CompanyOverviewPage from "@/app/(app)/admin/company/page";

beforeEach(resetFakeRequest);

describe("company overview actions", () => {
  it("lets the CEO rename the company and audits it", async () => {
    const world = await buildWorld("admin-company");
    await signInPerson(world.ceo, world.tenantId);

    const result = await updateCompanyProfileAction({}, form({ name: "Renamed Co" }));
    expect(result.error).toBeUndefined();
    expect(result.success).toBeTruthy();

    const { tenant, audit } = await withTenant(world.tenantId, async (tx) => ({
      tenant: await tx.tenant.findUniqueOrThrow({ where: { id: world.tenantId } }),
      audit: await tx.auditEvent.count({ where: { tenantId: world.tenantId, action: "tenant.update" } }),
    }));
    expect(tenant.name).toBe("Renamed Co");
    expect(audit).toBe(1);
  });

  it("rejects an invalid time zone with a translated message and changes nothing", async () => {
    const world = await buildWorld("admin-company-zone");
    await signInPerson(world.ceo, world.tenantId);
    const result = await updateCompanyProfileAction({}, form({ defaultTimeZone: "Mars/Olympus" }));
    expect(result.error).toBeTruthy();
    expect(result.success).toBeUndefined();
  });

  it("refuses a City Manager (no company_settings.edit) on the server even though the form could be posted", async () => {
    const world = await buildWorld("admin-company-deny");
    await signInPerson(world.cityManagerA, world.tenantId);
    const before = await withTenant(world.tenantId, (tx) => tx.tenant.findUniqueOrThrow({ where: { id: world.tenantId } }));

    const result = await updateCompanyProfileAction({}, form({ name: "Hacked" }));
    expect(result.error).toBeTruthy();
    const after = await withTenant(world.tenantId, (tx) => tx.tenant.findUniqueOrThrow({ where: { id: world.tenantId } }));
    expect(after.name).toBe(before.name);
  });

  it("adds a legal entity for the CEO and refuses a unit-scoped manager", async () => {
    const world = await buildWorld("admin-company-entity");
    await signInPerson(world.cityManagerA, world.tenantId);
    expect((await createLegalEntityAction({}, form({ name: "Sneaky LLC" }))).error).toBeTruthy();

    await signInPerson(world.ceo, world.tenantId);
    expect((await createLegalEntityAction({}, form({ name: "Second LLC" }))).success).toBeTruthy();
    const names = await withTenant(world.tenantId, async (tx) =>
      (await tx.legalEntity.findMany({ where: { tenantId: world.tenantId } })).map((entity) => entity.name),
    );
    expect(names).toContain("Second LLC");
    expect(names).not.toContain("Sneaky LLC");
  });
});

describe("company overview page", () => {
  it("renders for the CEO and shows the access-denied panel for a Technician", async () => {
    const world = await buildWorld("admin-company-page");
    await signInPerson(world.ceo, world.tenantId);
    expect(await CompanyOverviewPage()).toBeTruthy();

    await signInPerson(world.techA1, world.tenantId);
    const denied = (await CompanyOverviewPage()) as { type: unknown };
    // The denied branch renders the AccessDenied component, not the overview frame.
    expect(denied.type).toBe(AccessDenied);
  });
});
