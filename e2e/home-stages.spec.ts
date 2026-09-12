import { expect, test } from "@playwright/test";
import { DEV_PASSWORD, login, register, uniqueEmail } from "./helpers";

/**
 * The two sides must not land on the same page, and neither may open on a row
 * of counters that can only read zero.
 *
 * A brand-new owner used to see four stat tiles reading 0, 0, 0, ₪0 — the
 * product telling them it has nothing for them, in the place where it should
 * be making its case. These tests pin the replacement.
 */

/** Digits standing alone, i.e. a stat tile's value rather than a date or a price. */
async function standaloneZeros(page: import("@playwright/test").Page) {
  return page.evaluate(() => (document.body.innerText.match(/(^|\s)0(\s|$)/g) ?? []).length);
}

test("a brand-new media owner gets first steps, not a row of zeros", async ({ page }) => {
  await register(page, "MEDIA_OWNER", uniqueEmail("fresh-owner"));
  await page.waitForURL(/\/owner/);

  await expect(page.getByRole("heading", { name: "שלושה צעדים לשטח הראשון" })).toBeVisible();
  await expect(page.getByRole("link", { name: "הוספת שטח פרסום" }).first()).toBeVisible();

  // The whole point: no metric is rendered that could only say zero.
  expect(await standaloneZeros(page)).toBe(0);
});

test("a brand-new advertiser gets a different first screen than an owner", async ({ page }) => {
  await register(page, "ADVERTISER", uniqueEmail("fresh-adv"));
  await page.waitForURL(/\/dashboard/);

  await expect(page.getByRole("heading", { name: "איך מוצאים שטח" })).toBeVisible();
  // Owner language must not appear on the buyer's side.
  await expect(page.getByText("שלושה צעדים לשטח הראשון")).toHaveCount(0);
  expect(await standaloneZeros(page)).toBe(0);
});

// One account per test: login() navigates to /login, and an already-signed-in
// visitor is redirected away from it, so signing in twice in one test hangs
// waiting for a field that will never render.
test("the owner's home is titled for a seller", async ({ page }) => {
  await login(page, "owner@velto.dev", DEV_PASSWORD);
  await page.goto("/owner");
  await expect(page.getByRole("heading", { name: "לוח הבקרה שלכם", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "מה מחכה לכם" })).toBeVisible();
});

test("the advertiser's home is titled for a buyer", async ({ page }) => {
  await login(page, "advertiser@velto.dev", DEV_PASSWORD);
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "הקמפיינים שלכם", level: 1 })).toBeVisible();
  // Seller language must not leak onto the buyer's side.
  await expect(page.getByText("המלאי שלכם")).toHaveCount(0);
});

test("an owner with listings is not told to add their first one", async ({ page }) => {
  // The seeded owner has live assets. The inquiries page used to show
  // "add your first space" unconditionally, which is wrong and reads badly.
  await login(page, "owner@velto.dev", DEV_PASSWORD);
  await page.goto("/owner/inquiries");
  await expect(page.getByText("הוסיפו את השטח הראשון שלכם")).toHaveCount(0);
});
