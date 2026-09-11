import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

/** The marketing page in front of the app: headline, and both primary CTAs work. */
test("the landing page explains the product and both CTAs navigate correctly", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  await page.getByRole("link", { name: "ראו מה פנוי במפה" }).first().click();
  await page.waitForURL(/\/explore/);
  await expect(page.getByRole("application")).toBeVisible({ timeout: 20_000 });

  await page.goto("/");
  await page.getByRole("link", { name: "פרסמו את השטח שלכם" }).first().click();
  await page.waitForURL(/\/register/);
  await expect(page.locator("#name")).toBeVisible();
});

test("the header map link works from the landing page", async ({ page }) => {
  await page.goto("/");
  // Exact match: the page's CTAs also contain the word "מפה".
  await page.getByRole("link", { name: "מפה", exact: true }).click();
  await page.waitForURL(/\/explore/);
});

test("the landing page counts only real inventory, never demo rows", async ({ page }) => {
  // The invariant, checked against the database rather than against whatever
  // other specs happened to create first: the hero either states the pilot
  // line (no real inventory) or shows a count that excludes demo rows. It must
  // never present the seeded demo assets as commercial inventory.
  const prisma = new PrismaClient();
  let realAssets: number;
  try {
    realAssets = await prisma.mediaAsset.count({ where: { status: "ACTIVE", isDemo: false } });
  } finally {
    await prisma.$disconnect();
  }

  await page.goto("/");

  if (realAssets === 0) {
    await expect(page.getByText(/VELTO בהרצה/)).toBeVisible();
  } else {
    await expect(page.getByText(new RegExp(`${realAssets} שטחים`))).toBeVisible();
  }

  const totalActive = "16";
  await expect(page.getByText(new RegExp(`${totalActive} שטחים`))).toHaveCount(0);
});
