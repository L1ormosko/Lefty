import { expect, test } from "@playwright/test";
import { uniqueEmail } from "./helpers";

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
  await page.locator("#password").fill("velto-dev-1234");
  // The terms checkbox is left unchecked on purpose.
  await page.getByRole("button", { name: "יצירת חשבון" }).click();
  // A required, unchecked checkbox blocks native form submission - still on /register.
  await expect(page).toHaveURL(/\/register/);
});

test("forgot-password does not reveal whether an email is registered", async ({ page }) => {
  await page.goto("/forgot-password");
  await page.locator("#email").fill(uniqueEmail("unregistered"));
  await page.getByRole("button", { name: "שליחת קישור לאיפוס" }).click();
  await expect(page.getByText("אם הכתובת רשומה במערכת")).toBeVisible();
});

test("a reset-password link without a token shows an invalid-link message", async ({ page }) => {
  await page.goto("/reset-password");
  await expect(page.getByText(/קישור האיפוס אינו תקין/)).toBeVisible();
});
