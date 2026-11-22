import { expect, test } from "@playwright/test";
import { signIn, submitCredentials, text } from "./helpers";
import { readFixture } from "./setup/fixture";

const fixture = readFixture();
const GENERIC_ERROR = text("en-US", "AUTH.LOGIN_FAILED");

test("a wrong password gets one generic error that does not reveal which part was wrong", async ({ page }) => {
  await submitCredentials(page, fixture.technician, "not-the-password-0123");
  await expect(page.getByText(GENERIC_ERROR)).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);

  // An unknown email in a real company gets the very same message (no account enumeration).
  await submitCredentials(page, { ...fixture.technician, email: `nobody@${fixture.technician.tenantSlug}.example.test` }, "not-the-password-0123");
  await expect(page.getByText(GENERIC_ERROR)).toBeVisible();
});

test("repeated failures lock the account, and the screen still only says the generic error", async ({ page }) => {
  // LOCKOUT_MAX_FAILURES is 5 (src/server/auth/config.ts).
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await submitCredentials(page, fixture.lockoutTarget, `wrong-password-${attempt}-xyz`);
    await expect(page.getByText(GENERIC_ERROR)).toBeVisible();
  }

  // Locked now: even the CORRECT password is refused, with no "locked" hint for an attacker.
  await submitCredentials(page, fixture.lockoutTarget, fixture.password);
  await expect(page.getByText(GENERIC_ERROR)).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);

  // Other accounts of the same company are not affected.
  await signIn(page, fixture.technician, fixture.password);
});
