import { beforeEach, describe, expect, it, vi } from "vitest";
import { CATALOGS } from "@/lib/i18n";
import { withTenant } from "@/server/db";
import { listOverridesAsActor, loadReviewedOverrides } from "@/server/i18n";
import { buildWorld, createPerson, grantTemplate } from "../authz/fixtures";
import { resetFakeRequest } from "./next-fakes";
import { form, htmlOf, signInPerson } from "./admin-test-helpers";

vi.mock("next/headers", async () => (await import("./next-fakes")).headersModule);
vi.mock("next/navigation", async () => (await import("./next-fakes")).navigationModule);
vi.mock("next/cache", async () => (await import("./next-fakes")).cacheModule);

import { deleteOverrideAction, reviewOverrideAction, saveOverrideAction } from "@/app/(app)/admin/localization/actions";
import LocalizationPage from "@/app/(app)/admin/localization/page";
import { AccessDenied } from "@/app/(app)/admin/_components/AdminPage";

beforeEach(resetFakeRequest);
const en = (key: string) => CATALOGS["en-US"].messages[key];
const KEY = "COMMON.SAVE";

describe("localization override admin", () => {
  it("saves unreviewed, rejects self-approval, approves the exact text seen, then serves it", async () => {
    const world = await buildWorld("admin-loc");
    await signInPerson(world.ceo, world.tenantId);
    expect((await saveOverrideAction({}, form({ locale: "en-US", key: KEY, value: "Store" }))).success).toBe(en("ADMIN.LOCALIZATION_SAVED"));
    expect(await loadReviewedOverrides(world.tenantId)).toEqual({});

    // The editor may not approve their own text.
    expect((await reviewOverrideAction({}, form({ locale: "en-US", key: KEY, reviewedValue: "Store" }))).error).toBe(en("ERROR.FORBIDDEN"));

    // A second administrator with localization.configure reviews it.
    const reviewer = await createPerson(world.tenantId, "reviewer", { withEmployee: false });
    await grantTemplate(world.tenantId, reviewer, world.roles.OWNER_CEO, [{ type: "TENANT" }]);
    await signInPerson(reviewer, world.tenantId);
    expect((await reviewOverrideAction({}, form({ locale: "en-US", key: KEY, reviewedValue: "Other text" }))).error).toBe(en("ERROR.CONFLICT")); // not the text on the server
    expect((await reviewOverrideAction({}, form({ locale: "en-US", key: KEY, reviewedValue: "Store" }))).success).toBe(en("ADMIN.LOCALIZATION_REVIEWED"));
    expect((await loadReviewedOverrides(world.tenantId))["en-US"]?.[KEY]).toBe("Store");

    // The page lists it for the reviewer; deleting restores the built-in text.
    expect(await htmlOf(LocalizationPage({ searchParams: Promise.resolve({}) }))).toContain(KEY);
    expect((await deleteOverrideAction({}, form({ locale: "en-US", key: KEY }))).success).toBe(en("ADMIN.LOCALIZATION_DELETED"));
    expect(await loadReviewedOverrides(world.tenantId)).toEqual({});
  });

  it("shows a translated message for an unknown key or a lost placeholder", async () => {
    const world = await buildWorld("admin-loc-validation");
    await signInPerson(world.ceo, world.tenantId);
    expect((await saveOverrideAction({}, form({ locale: "en-US", key: "NO.SUCH_KEY", value: "x" }))).error).toBe(en("ADMIN.ERROR_FIELD_KEY"));
    expect((await saveOverrideAction({}, form({ locale: "en-US", key: "COMMON.PAGE_OF", value: "Page" }))).error).toBe(en("ADMIN.ERROR_FIELD_VALUE"));
  });

  it("refuses edits without permission and denies the page to a Technician; unauthorised users cannot list", async () => {
    const world = await buildWorld("admin-loc-deny");
    await signInPerson(world.cityManagerA, world.tenantId);
    expect((await saveOverrideAction({}, form({ locale: "en-US", key: KEY, value: "Hack" }))).error).toBe(en("ERROR.FORBIDDEN"));
    const rows = await withTenant(world.tenantId, (tx) => tx.translationResource.count({ where: { tenantId: world.tenantId } }));
    expect(rows).toBe(0);

    await signInPerson(world.techA1, world.tenantId);
    expect(((await LocalizationPage({ searchParams: Promise.resolve({}) })) as { type: unknown }).type).toBe(AccessDenied);
    await expect(listOverridesAsActor(world.techA1.actor, { limit: 5 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
