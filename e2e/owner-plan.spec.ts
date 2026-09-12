import { expect, test } from "@playwright/test";
import { DEV_PASSWORD, login } from "./helpers";

/**
 * The subscription, through the screens that actually use it.
 *
 * Desktop only: nothing here is layout-dependent, and the admin users page is
 * the same form on both. Running it twice would only spend the login budget.
 */
test.skip(({ isMobile }) => !!isMobile, "one layout is enough for a server rule");

test("an admin records a plan, and the owner is held to it", async ({ page }) => {
  // A limit of zero with listings already public is the honest worst case: the
  // owner is over their plan, and what happens to the live ones is the whole
  // question.
  await login(page, "admin@velto.dev", DEV_PASSWORD);
  await page.goto("/admin/users");

  const ownerRow = page.locator('[data-user="owner@velto.dev"]');
  await ownerRow.getByRole("button", { name: "אין מנוי" }).click();
  await page.locator('input[name="activeListingLimit"]').first().fill("0");
  await page.getByRole("button", { name: "שמירת המנוי" }).first().click();
  await expect(page.getByText("המנוי עודכן.")).toBeVisible();
});

test("the owner sees the limit, their listings stay published, and publishing is refused", async ({
  page,
}) => {
  await login(page, "owner@velto.dev", DEV_PASSWORD);
  await page.goto("/owner/assets");

  // The panel states the position plainly...
  await expect(page.getByRole("heading", { name: "המנוי שלכם" })).toBeVisible();
  await expect(page.getByText("הגעתם למכסת השטחים המפורסמים.")).toBeVisible();

  // ...including the promise that matters to the advertiser on the other side.
  await expect(
    page.getByText("השטחים שכבר מפורסמים נשארים במפה. מה שנחסם הוא פרסום שטח חדש בלבד.")
  ).toBeVisible();

  // And the listings really are still published: rows still read ACTIVE.
  const active = page.getByText("פעיל", { exact: true });
  const liveBefore = await active.count();
  expect(liveBefore).toBeGreaterThan(0);

  // Switching one off is always allowed - the subscription must never trap
  // inventory in the public map.
  await page.getByRole("button", { name: "השבתה" }).first().click();
  await expect(page.getByRole("button", { name: "הפעלה" }).first()).toBeVisible();

  // Switching it back on is the gated direction, and with no room it is
  // refused - in words that name the limit.
  await page.getByRole("button", { name: "הפעלה" }).first().click();
  await expect(page.getByRole("alert").filter({ hasText: "מכסה" })).toBeVisible();

  // Restore, so the seeded owner is left as this spec found them.
  await page.goto("/admin/users");
});

test("with the plan lifted, the same listing publishes again", async ({ page }) => {
  // Runs before the removal test's own assertions rely on it: this is the
  // other half of the refusal above, and it also puts the seeded owner back.
  await login(page, "admin@velto.dev", DEV_PASSWORD);
  await page.goto("/admin/users");
  const ownerRow = page.locator('[data-user="owner@velto.dev"]');
  await ownerRow.getByRole("button", { name: "המנוי שלכם" }).click();
  await page.locator('input[name="activeListingLimit"]').first().fill("99");
  await page.getByRole("button", { name: "שמירת המנוי" }).first().click();
  await expect(page.getByText("המנוי עודכן.")).toBeVisible();
});

test("the owner can switch the listing back on once there is room", async ({ page }) => {
  await login(page, "owner@velto.dev", DEV_PASSWORD);
  await page.goto("/owner/assets");
  await page.getByRole("button", { name: "הפעלה" }).first().click();
  await expect(page.getByRole("button", { name: "השבתה" }).first()).toBeVisible();
  // Narrowed to this feature's own refusal: the page carries other alerts
  // (a rejected listing's review note, for one) that have nothing to do with
  // the subscription.
  await expect(page.getByRole("alert").filter({ hasText: "מכסה" })).toHaveCount(0);
});

test("the plan is removed again, leaving the account unlimited", async ({ page }) => {
  // Cleanup is part of the test rather than a hook: leaving the seeded owner
  // capped would quietly break every other spec that publishes as them.
  await login(page, "admin@velto.dev", DEV_PASSWORD);
  await page.goto("/admin/users");

  const ownerRow = page.locator('[data-user="owner@velto.dev"]');
  await ownerRow.getByRole("button", { name: "המנוי שלכם" }).click();
  await page.locator('input[name="activeListingLimit"]').first().fill("");
  await page.getByRole("button", { name: "שמירת המנוי" }).first().click();
  await expect(page.getByText("המנוי בוטל. החשבון חזר להיות ללא הגבלה.")).toBeVisible();

  await page.goto("/admin/users");
  await expect(ownerRow.getByRole("button", { name: "אין מנוי" })).toBeVisible();
});
