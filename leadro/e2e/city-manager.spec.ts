import { expect, test } from "@playwright/test";
import { navigationPaths, signIn, text } from "./helpers";
import { readFixture } from "./setup/fixture";

const fixture = readFixture();

test("the City Manager gets the Hebrew right-to-left UI, a limited menu and a city-scoped employee list", async ({ page }) => {
  // The browser asks for English; the Hebrew UI must come from the user's own saved locale.
  await signIn(page, fixture.cityManager, fixture.password);

  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("html")).toHaveAttribute("lang", "he-IL");

  const paths = await navigationPaths(page, "he-IL");
  expect(paths).toEqual(expect.arrayContaining(["/admin/employees", "/admin/organization"]));
  expect(paths).not.toContain("/admin/localization");
  expect(paths).not.toContain("/admin/company");

  await page.getByRole("link", { name: text("he-IL", "NAV.EMPLOYEES"), exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: text("he-IL", "ADMIN.EMPLOYEES_TITLE") })).toBeVisible();
  // Their own record is listed, but the tenant-wide people (the CEO is E-0001) are not.
  await expect(page.getByRole("cell", { name: fixture.cityManager.employeeNumber, exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "E-0001", exact: true })).toHaveCount(0);
  await expect(page.getByRole("cell", { name: fixture.cityManager.outOfScopeEmployeeNumber, exact: true })).toHaveCount(0);
  const bodyRows = (await page.getByRole("row").count()) - 1;
  expect(bodyRows).toBeGreaterThan(0);
  expect(bodyRows).toBeLessThan(fixture.employeeCount);
});

test("opening the Localization screen directly shows access denied", async ({ page }) => {
  await signIn(page, fixture.cityManager, fixture.password);
  await page.goto("/admin/localization");
  await expect(page.getByText(text("he-IL", "ADMIN.ACCESS_DENIED_TITLE"))).toBeVisible();
});
