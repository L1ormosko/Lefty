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

test("an admin can download a database backup from the dashboard", async ({ page }) => {
  await login(page, "admin@velto.dev", DEV_PASSWORD);
  await page.goto("/admin");

  // The hosted database has no backups and is deleted on a fixed date, so this
  // link is the only route the data has out. A backup nobody can find is not a
  // backup: assert the button exists and that following it actually returns a
  // file, not just that the route is there.
  const link = page.getByRole("link", { name: "הורדת גיבוי" });
  await expect(link).toBeVisible();

  const response = await page.request.get("/api/admin/backup");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-disposition"]).toContain("SENSITIVE");
  const body = await response.json();
  expect(body.data.users.length).toBeGreaterThan(0);
});
