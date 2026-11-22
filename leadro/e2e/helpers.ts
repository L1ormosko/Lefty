import { expect, type Locator, type Page } from "@playwright/test";
import { generateTotp, base32Decode } from "@/lib/totp";
import enUS from "@/lib/i18n/catalogs/en-US.json";
import heIL from "@/lib/i18n/catalogs/he-IL.json";
import type { E2eUser } from "./setup/fixture";

type Catalog = { messages: Record<string, string> };
const CATALOGS: Record<"en-US" | "he-IL", Catalog> = { "en-US": enUS, "he-IL": heIL };

/**
 * UI text for a catalog key. Specs look text up here instead of hard-coding it, so a wording
 * change in the catalog does not break them; only a renamed or removed key does (loudly).
 */
export function text(locale: keyof typeof CATALOGS, key: string): string {
  const value = CATALOGS[locale].messages[key];
  if (value === undefined) throw new Error(`Unknown message key ${key} in ${locale}`);
  return value;
}

/** Fills and submits the first login step. Returns once the form has been submitted. */
export async function submitCredentials(page: Page, user: E2eUser, password: string, locale: keyof typeof CATALOGS = "en-US"): Promise<void> {
  await page.goto("/login");
  await page.getByLabel(text(locale, "AUTH.COMPANY_CODE")).fill(user.tenantSlug);
  await page.getByLabel(text(locale, "AUTH.EMAIL")).fill(user.email);
  await page.getByLabel(text(locale, "AUTH.PASSWORD")).fill(password);
  await page.getByRole("button", { name: text(locale, "AUTH.SIGN_IN") }).click();
}

/** Signs a user without a second factor in and waits for the workspace. */
export async function signIn(page: Page, user: E2eUser, password: string, locale: keyof typeof CATALOGS = "en-US"): Promise<void> {
  await submitCredentials(page, user, password, locale);
  await expect(page).toHaveURL(/\/$/);
}

/** Completes the MFA step with the code an authenticator holding `secretBase32` would show now. */
export async function answerMfaChallenge(page: Page, secretBase32: string): Promise<void> {
  await expect(page).toHaveURL(/\/login\/mfa$/);
  const code = generateTotp(base32Decode(secretBase32), Date.now());
  await page.getByLabel(text("en-US", "AUTH_UI.MFA_CODE_LABEL")).fill(code);
  await page.getByRole("button", { name: text("en-US", "AUTH_UI.MFA_VERIFY") }).click();
  await expect(page).toHaveURL(/\/$/);
}

/** The sidebar links (desktop layout), in page order. */
export function navigationLinks(page: Page, locale: keyof typeof CATALOGS = "en-US"): Locator {
  return page.getByRole("navigation", { name: text(locale, "SHELL.MAIN_NAVIGATION") }).getByRole("link");
}

/** Paths of the sidebar links, e.g. `["/", "/admin/employees"]`. */
export async function navigationPaths(page: Page, locale: keyof typeof CATALOGS = "en-US"): Promise<string[]> {
  const hrefs = await navigationLinks(page, locale).evaluateAll((links) => links.map((link) => link.getAttribute("href") ?? ""));
  return hrefs;
}
