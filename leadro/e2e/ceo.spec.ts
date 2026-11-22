import { expect, test } from "@playwright/test";
import { answerMfaChallenge, navigationPaths, submitCredentials, text } from "./helpers";
import { readFixture } from "./setup/fixture";

const fixture = readFixture();

test("the CEO signs in with MFA, sees every admin screen and the whole employee list", async ({ page }) => {
  await submitCredentials(page, fixture.ceo, fixture.password);
  await answerMfaChallenge(page, fixture.ceo.totpSecretBase32);

  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  expect(await navigationPaths(page)).toEqual([
    "/",
    "/admin/company",
    "/admin/organization",
    "/admin/employees",
    "/admin/users",
    "/admin/roles",
    "/admin/localization",
  ]);

  await page.getByRole("link", { name: text("en-US", "NAV.ORGANIZATION"), exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: text("en-US", "ADMIN.ORG_TITLE") })).toBeVisible();

  await page.getByRole("link", { name: text("en-US", "NAV.EMPLOYEES"), exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: text("en-US", "ADMIN.EMPLOYEES_TITLE") })).toBeVisible();
  // One body row per employee of the tenant (the header row is not counted).
  await expect(page.getByRole("row")).toHaveCount(fixture.employeeCount + 1);
  await expect(page.getByRole("cell", { name: "E-0001", exact: true })).toBeVisible();

  await page.getByRole("link", { name: text("en-US", "NAV.ROLES_AND_ACCESS"), exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: text("en-US", "ADMIN.ROLES_TITLE") })).toBeVisible();
});

test("a wrong MFA code is refused and keeps the CEO on the MFA step", async ({ page }) => {
  await submitCredentials(page, fixture.ceo, fixture.password);
  await expect(page).toHaveURL(/\/login\/mfa$/);
  await page.getByLabel(text("en-US", "AUTH_UI.MFA_CODE_LABEL")).fill("000000");
  await page.getByRole("button", { name: text("en-US", "AUTH_UI.MFA_VERIFY") }).click();
  await expect(page.getByText(text("en-US", "AUTH_UI.MFA_CODE_INVALID"))).toBeVisible();
  await expect(page).toHaveURL(/\/login\/mfa$/);
});
