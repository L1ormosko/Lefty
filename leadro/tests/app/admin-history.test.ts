import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildWorld } from "../authz/fixtures";
import { NotFoundSignal, resetFakeRequest } from "./next-fakes";
import { form, signInPerson } from "./admin-test-helpers";

vi.mock("next/headers", async () => (await import("./next-fakes")).headersModule);
vi.mock("next/navigation", async () => (await import("./next-fakes")).navigationModule);
vi.mock("next/cache", async () => (await import("./next-fakes")).cacheModule);

import { moveUnitAction } from "@/app/(app)/admin/organization/actions";
import OrganizationHistoryPage from "@/app/(app)/admin/organization/history/page";
import { AccessDenied } from "@/app/(app)/admin/_components/AdminPage";

beforeEach(resetFakeRequest);
const noParams = { searchParams: Promise.resolve({}) };

describe("organization history page", () => {
  it("renders for the CEO after a move", async () => {
    const world = await buildWorld("admin-history");
    await signInPerson(world.ceo, world.tenantId);
    await moveUnitAction({}, form({ unitId: world.units.teamA1, newParentId: world.units.cityB, reason: "Reorg" }));
    const page = (await OrganizationHistoryPage(noParams)) as { type: unknown };
    expect(page.type).not.toBe(AccessDenied);
  });

  it("is denied to a user with neither organization.view nor an employees.view grant covering base fields", async () => {
    const world = await buildWorld("admin-history-deny");
    await signInPerson(world.finance, world.tenantId);
    expect(((await OrganizationHistoryPage(noParams)) as { type: unknown }).type).toBe(AccessDenied);
  });

  it("answers 404 for a unit outside a City Manager's scope", async () => {
    const world = await buildWorld("admin-history-scope");
    await signInPerson(world.cityManagerA, world.tenantId);
    await expect(OrganizationHistoryPage({ searchParams: Promise.resolve({ unit: world.units.cityB }) })).rejects.toBeInstanceOf(NotFoundSignal);
  });
});
