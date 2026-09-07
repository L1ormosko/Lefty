import { expect, test } from "@playwright/test";

/** The marketing page in front of the app: headline, and both primary CTAs work. */
test("the landing page explains the product and both CTAs navigate correctly", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  await page.getByRole("link", { name: "גלו שטחי פרסום" }).first().click();
  await page.waitForURL(/\/explore/);
  await expect(page.getByRole("application")).toBeVisible({ timeout: 20_000 });

  await page.goto("/");
  await page.getByRole("link", { name: "פרסמו את השטח שלכם" }).first().click();
  await page.waitForURL(/\/register/);
  await expect(page.locator("#name")).toBeVisible();
});

test("the header map link works from the landing page", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "מפה" }).click();
  await page.waitForURL(/\/explore/);
});
