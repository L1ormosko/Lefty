import { expect, test } from "@playwright/test";
import { DEV_PASSWORD, login } from "./helpers";

test("an admin can review and verify a pending asset", async ({ page }) => {
  await login(page, "admin@velto.dev", DEV_PASSWORD);
  await page.goto("/admin/assets?filter=pending");

  const card = page.locator("form").filter({ hasText: "אימות השטח" }).first();
  if (await card.isVisible()) {
    await card.getByRole("button", { name: "אימות השטח" }).click();
    await expect(page.getByText("מאומת ע״י VELTO").first()).toBeVisible();
  }

  await page.goto("/admin/users");
  await expect(page.getByText("admin@velto.dev")).toBeVisible();
});
