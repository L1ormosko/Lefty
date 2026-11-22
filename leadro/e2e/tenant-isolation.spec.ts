import { expect, test } from "@playwright/test";
import { answerMfaChallenge, submitCredentials } from "./helpers";
import { readFixture } from "./setup/fixture";

const fixture = readFixture();

test("an employee id from another company is simply not found, even for the CEO", async ({ page }) => {
  await submitCredentials(page, fixture.ceo, fixture.password);
  await answerMfaChallenge(page, fixture.ceo.totpSecretBase32);

  const response = await page.goto(`/admin/employees/${fixture.foreignEmployeeId}`);
  expect(response?.status()).toBe(404);
  await expect(page.getByText("This page could not be found.")).toBeVisible();
  // Nothing from the other company leaks onto the page.
  await expect(page.getByRole("heading", { level: 1 })).not.toContainText("E2E other");
});
