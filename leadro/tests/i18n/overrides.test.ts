import { describe, expect, it } from "vitest";
import { createTranslator } from "@/lib/i18n";
import { prisma, withTenant } from "@/server/db";
import {
  TranslationOverrideError,
  deleteOverride,
  getTranslatorForRequest,
  loadReviewedOverrides,
  markOverrideReviewed,
  resolveLocaleContext,
  saveOverride,
} from "@/server/i18n";
import { createTenant } from "../helpers";

async function createUser(tenantId: string, data: { email: string; locale?: string; timeZone?: string }) {
  return withTenant(tenantId, (tx) => tx.user.create({ data: { tenantId, ...data } }));
}

describe("translation overrides (spec 16.6)", () => {
  it("does not serve an override until it has been reviewed", async () => {
    const tenant = await createTenant("i18n");
    const editor = await createUser(tenant.id, { email: "editor@example.com" });
    const reviewer = await createUser(tenant.id, { email: "reviewer@example.com" });

    await saveOverride(tenant.id, { locale: "es-US", key: "COMMON.SAVE", value: "Salvar", editorUserId: editor.id });
    expect(await loadReviewedOverrides(tenant.id)).toEqual({});

    await markOverrideReviewed(tenant.id, { locale: "es-US", key: "COMMON.SAVE", reviewerUserId: reviewer.id });
    const overrides = await loadReviewedOverrides(tenant.id);
    expect(overrides).toEqual({ "es-US": { "COMMON.SAVE": "Salvar" } });
    expect(createTranslator({ localeChain: ["es-US"], overrides })("COMMON.SAVE")).toBe("Salvar");
  });

  it("returns an edited override to unreviewed so it stops being served", async () => {
    const tenant = await createTenant("i18n");
    const user = await createUser(tenant.id, { email: "a@example.com" });
    const base = { locale: "en-US", key: "COMMON.SAVE", editorUserId: user.id };
    await saveOverride(tenant.id, { ...base, value: "Keep" });
    await markOverrideReviewed(tenant.id, { locale: "en-US", key: "COMMON.SAVE", reviewerUserId: user.id });
    expect(await loadReviewedOverrides(tenant.id)).toEqual({ "en-US": { "COMMON.SAVE": "Keep" } });

    await saveOverride(tenant.id, { ...base, value: "Keep it" });
    expect(await loadReviewedOverrides(tenant.id)).toEqual({});
  });

  it("isolates overrides between tenants", async () => {
    const [a, b] = [await createTenant("i18n-a"), await createTenant("i18n-b")];
    const user = await createUser(a.id, { email: "a@example.com" });
    await saveOverride(a.id, { locale: "en-US", key: "COMMON.SAVE", value: "A-save", editorUserId: user.id });
    await markOverrideReviewed(a.id, { locale: "en-US", key: "COMMON.SAVE", reviewerUserId: user.id });
    expect(await loadReviewedOverrides(b.id)).toEqual({});
    await expect(
      markOverrideReviewed(b.id, { locale: "en-US", key: "COMMON.SAVE", reviewerUserId: user.id }),
    ).rejects.toBeInstanceOf(TranslationOverrideError);
  });

  it("rejects unknown keys, unsupported locales and dropped placeholders", async () => {
    const tenant = await createTenant("i18n");
    const user = await createUser(tenant.id, { email: "a@example.com" });
    const base = { editorUserId: user.id };
    await expect(saveOverride(tenant.id, { ...base, locale: "en-US", key: "NO.SUCH_KEY", value: "x" })).rejects.toMatchObject({ code: "UNKNOWN_KEY" });
    await expect(saveOverride(tenant.id, { ...base, locale: "fr-FR", key: "COMMON.SAVE", value: "x" })).rejects.toMatchObject({ code: "UNSUPPORTED_LOCALE" });
    await expect(saveOverride(tenant.id, { ...base, locale: "en-US", key: "COMMON.PAGE_OF", value: "Page {page}" })).rejects.toMatchObject({ code: "PLACEHOLDER_MISMATCH" });
  });

  it("deletes an override so built-in text is used again", async () => {
    const tenant = await createTenant("i18n");
    const user = await createUser(tenant.id, { email: "a@example.com" });
    await saveOverride(tenant.id, { locale: "en-US", key: "COMMON.SAVE", value: "Keep", editorUserId: user.id });
    await markOverrideReviewed(tenant.id, { locale: "en-US", key: "COMMON.SAVE", reviewerUserId: user.id });
    await deleteOverride(tenant.id, { locale: "en-US", key: "COMMON.SAVE" });
    expect(await loadReviewedOverrides(tenant.id)).toEqual({});
  });

  it("enforces the review consistency CHECK in the database", async () => {
    const tenant = await createTenant("i18n");
    await expect(
      withTenant(tenant.id, (tx) =>
        tx.translationResource.create({
          data: { tenantId: tenant.id, locale: "en-US", key: "COMMON.SAVE", value: "x", reviewed: true },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe("resolveLocaleContext (spec 16.2, 16.5)", () => {
  it("falls back user → branch → company and carries direction and time zone", async () => {
    const tenant = await createTenant("i18n-ctx");
    await prisma.tenant.update({ where: { id: tenant.id }, data: { defaultLocale: "en-US", defaultTimeZone: "America/New_York" } });

    const { branchId, teamId } = await withTenant(tenant.id, async (tx) => {
      const branch = await tx.orgUnit.create({
        data: { tenantId: tenant.id, name: "Haifa", type: "BRANCH", defaultLocale: "he-IL", timeZone: "Asia/Jerusalem" },
      });
      const team = await tx.orgUnit.create({
        data: { tenantId: tenant.id, name: "Team 1", type: "TEAM", parentId: branch.id },
      });
      return { branchId: branch.id, teamId: team.id };
    });
    const plainUser = await createUser(tenant.id, { email: "plain@example.com" });
    const spanishUser = await createUser(tenant.id, { email: "es@example.com", locale: "es-US", timeZone: "America/Chicago" });

    // Company only.
    expect(await resolveLocaleContext(tenant.id, { userId: plainUser.id })).toMatchObject({
      locale: "en-US", direction: "ltr", timeZone: "America/New_York",
    });
    // Branch inherited by a team below it.
    expect(await resolveLocaleContext(tenant.id, { userId: plainUser.id, orgUnitId: teamId })).toMatchObject({
      locale: "he-IL", direction: "rtl", timeZone: "Asia/Jerusalem", localeChain: ["he-IL", "en-US"],
    });
    // User preference wins, branch remains in the fallback chain.
    expect(await resolveLocaleContext(tenant.id, { userId: spanishUser.id, orgUnitId: branchId })).toMatchObject({
      locale: "es-US", direction: "ltr", timeZone: "America/Chicago", localeChain: ["es-US", "he-IL", "en-US"],
    });
  });

  it("uses the employee's current primary assignment when no org unit is given", async () => {
    const tenant = await createTenant("i18n-ctx");
    const user = await createUser(tenant.id, { email: "emp@example.com" });
    await withTenant(tenant.id, async (tx) => {
      const unit = await tx.orgUnit.create({
        data: { tenantId: tenant.id, name: "Branch", type: "BRANCH", defaultLocale: "es-US" },
      });
      const employee = await tx.employee.create({
        data: { tenantId: tenant.id, userId: user.id, firstName: "E", lastName: "E" },
      });
      await tx.organizationalAssignment.create({
        data: { tenantId: tenant.id, employeeId: employee.id, orgUnitId: unit.id, kind: "PRIMARY" },
      });
    });
    const { t, context } = await getTranslatorForRequest(tenant.id, { userId: user.id });
    expect(context.locale).toBe("es-US");
    expect(t("COMMON.CANCEL")).toBe("Cancelar");
  });
});
