import { randomUUID } from "node:crypto";
import type { Cookie, Page } from "@playwright/test";

/**
 * The seeded accounts' password, from the same environment variable the seed
 * reads. Hard-coding it here would have meant the tests kept passing while the
 * real password changed - and the temptation would be to paste the literal
 * back in.
 */
export const DEV_PASSWORD = (() => {
  const value = process.env.SEED_PASSWORD;
  if (!value) {
    throw new Error(
      "SEED_PASSWORD is not set. The e2e suite signs in as the seeded accounts, " +
        "so it needs the same password the seed used. Set it in .env."
    );
  }
  return value;
})();

export function uniqueEmail(prefix: string) {
  return `${prefix}-${randomUUID().slice(0, 8)}@velto-e2e.local`;
}

/**
 * Session cookies already obtained in this worker, keyed by account.
 *
 * The app rate limits logins to 5 per account per 15 minutes - a real security
 * feature we are not going to weaken for tests. Several specs sign in as the
 * same seeded account across two projects, which used to blow through that
 * budget and fail with a login timeout. Reusing the session cookie means each
 * account authenticates once per run.
 */
const sessionCache = new Map<string, Cookie[]>();

export async function login(page: Page, email: string, password = DEV_PASSWORD) {
  const cached = sessionCache.get(email);
  if (cached) {
    await page.context().addCookies(cached);
    await page.goto("/");
    return;
  }

  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "כניסה לחשבון" }).click();
  await page.waitForURL(/\/(dashboard|owner|admin)/);

  const cookies = (await page.context().cookies()).filter((c) => c.name === "velto_session");
  if (cookies.length) sessionCache.set(email, cookies);
}

export async function register(page: Page, role: "ADVERTISER" | "MEDIA_OWNER", email: string) {
  await page.goto(`/register?role=${role}`);
  await page.locator("#name").fill("בודק אוטומטי");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(DEV_PASSWORD);
  await page.locator('input[name="acceptedTerms"]').check();
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
