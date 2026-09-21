import { expect, test } from "@playwright/test";
import { DEV_PASSWORD, uniqueEmail } from "./helpers";

test("the three legal pages render and link to each other", async ({ page }) => {
  await page.goto("/takanon");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  await page.getByRole("link", { name: "הסכם שימוש" }).first().click();
  await page.waitForURL(/\/terms/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  await page.getByRole("link", { name: "מדיניות פרטיות" }).first().click();
  await page.waitForURL(/\/privacy/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

test("registration is blocked without accepting the terms", async ({ page }) => {
  await page.goto("/register?role=ADVERTISER");
  await page.locator("#name").fill("בודק ללא הסכמה");
  await page.locator("#email").fill(uniqueEmail("noconsent"));
  await page.locator("#password").fill(DEV_PASSWORD);
  // The terms checkbox is left unchecked on purpose.
  await page.getByRole("button", { name: "יצירת חשבון" }).click();
  // A required, unchecked checkbox blocks native form submission - still on /register.
  await expect(page).toHaveURL(/\/register/);
});

/*
 * With no email provider configured - which is the state of this environment
 * and of the deployment - the page says so instead of offering a field.
 *
 * It used to accept an address and answer "if that address is registered, we
 * have sent it a link", while sendEmail quietly did nothing. For anyone who
 * had genuinely forgotten their password that was a dead end disguised as a
 * solution: they went away and waited for a message that was never coming.
 *
 * The no-enumeration property this test used to pin is now covered in
 * tests/forgot-password.test.ts, where the provider can be simulated.
 */
test("forgot-password says so when it cannot send", async ({ page }) => {
  await page.goto("/forgot-password");
  await expect(page.getByText(/שחזור סיסמה בדוא״ל אינו פעיל/)).toBeVisible();
  // No field, no button: nothing to press that would do nothing.
  await expect(page.locator("#email")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "שליחת קישור לאיפוס" })).toHaveCount(0);
});

test("a reset-password link without a token shows an invalid-link message", async ({ page }) => {
  await page.goto("/reset-password");
  await expect(page.getByText(/קישור האיפוס אינו תקין/)).toBeVisible();
});
