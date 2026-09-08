import { expect, test } from "@playwright/test";
import { DEV_PASSWORD, register, uniqueEmail } from "./helpers";

/**
 * The three rights /privacy promises, exercised through the interface a real
 * user has: see the data, correct it, delete the account.
 */
test("a user can correct their details, download their data, and close the account", async ({ page }) => {
  const email = uniqueEmail("account");
  await register(page, "ADVERTISER", email);

  await page.goto("/dashboard/profile");

  // Correct.
  await page.locator("#name").fill("שם מתוקן");
  await page.locator("#phone").fill("050-1112222");
  await page.getByRole("button", { name: "שמירה" }).click();
  await expect(page.getByText("הפרטים נשמרו.")).toBeVisible();

  await page.reload();
  await expect(page.locator("#name")).toHaveValue("שם מתוקן");
  await expect(page.locator("#phone")).toHaveValue("050-1112222");

  // See. The export is a real download, so check the response rather than
  // relying on the browser's save dialog.
  const exported = await page.request.get("/api/account/export");
  expect(exported.status()).toBe(200);
  expect(exported.headers()["content-disposition"]).toContain("attachment");
  const body = await exported.json();
  expect(body.email).toBe(email);
  expect(body.name).toBe("שם מתוקן");
  // The export must never carry credential material.
  expect(JSON.stringify(body)).not.toContain("passwordHash");

  // Delete.
  await page.getByRole("button", { name: "מחיקת החשבון", exact: true }).click();
  await page.locator("#del-password").fill(DEV_PASSWORD);
  await page.locator("#del-confirm").fill("מחיקה");
  await page.getByRole("button", { name: "מחיקת החשבון לצמיתות" }).click();

  await page.waitForURL(/\/login/);
  await expect(page.getByText(/החשבון נמחק/)).toBeVisible();

  // The credentials no longer work.
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(DEV_PASSWORD);
  await page.getByRole("button", { name: "כניסה לחשבון" }).click();
  await expect(page).toHaveURL(/\/login/);
});

test("a media owner has an account page too", async ({ page }) => {
  // Media owners previously had no profile route at all, so a mistyped phone
  // number was permanent for them.
  const email = uniqueEmail("owner-account");
  await register(page, "MEDIA_OWNER", email);

  await page.getByRole("link", { name: "פרופיל" }).click();
  await page.waitForURL(/\/owner\/profile/);
  await expect(page.locator("#name")).toBeVisible();
});

test("changing the password requires the current one", async ({ page }) => {
  const email = uniqueEmail("password");
  await register(page, "ADVERTISER", email);
  await page.goto("/dashboard/profile");

  await page.locator("#currentPassword").fill("not-the-password");
  await page.locator("#password").fill("a-brand-new-password");
  await page.getByRole("button", { name: "עדכון סיסמה" }).click();
  await expect(page.getByText("הסיסמה הנוכחית שגויה.")).toBeVisible();
});
