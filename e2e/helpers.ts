import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";

export const DEV_PASSWORD = "velto-dev-1234";

export function uniqueEmail(prefix: string) {
  return `${prefix}-${randomUUID().slice(0, 8)}@velto-e2e.local`;
}

export async function login(page: Page, email: string, password = DEV_PASSWORD) {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "כניסה לחשבון" }).click();
  await page.waitForURL(/\/(dashboard|owner|admin)/);
}

export async function register(page: Page, role: "ADVERTISER" | "MEDIA_OWNER", email: string) {
  await page.goto(`/register?role=${role}`);
  await page.locator("#name").fill("בודק אוטומטי");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(DEV_PASSWORD);
  await page.getByRole("button", { name: "יצירת חשבון" }).click();
  await page.waitForURL(/\/(dashboard|owner)/);
}

/**
 * On mobile the results live in a collapsed bottom sheet; open it before
 * looking for cards. On desktop the list is already visible.
 */
export async function openResults(page: Page) {
  const sheetToggle = page.getByRole("button", { name: "רשימה" });
  if (await sheetToggle.isVisible().catch(() => false)) {
    await sheetToggle.click();
  }
}
