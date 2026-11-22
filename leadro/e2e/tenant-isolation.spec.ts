import { expect, test } from "@playwright/test";
import { answerMfaChallenge, submitCredentials } from "./helpers";
import { readFixture } from "./setup/fixture";

const fixture = readFixture();

test("an employee id from another company is not found, while a same-company id renders", async ({ page }) => {
  await submitCredentials(page, fixture.ceo, fixture.password);
  await answerMfaChallenge(page, fixture.ceo.totpSecretBase32);

  // Positive control: the route and id format work, so the 404 below is about the tenant.
  const own = await page.goto(`/admin/employees/${fixture.ownEmployee.id}`);
  expect(own?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: fixture.ownEmployee.fullName })).toBeVisible();

  const foreign = await page.goto(`/admin/employees/${fixture.foreignEmployeeId}`);
  expect(foreign?.status()).toBe(404);
  await expect(page.getByText("This page could not be found.")).toBeVisible();
});
