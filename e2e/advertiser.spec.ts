import { expect, test } from "@playwright/test";
import { DEV_PASSWORD, login, openResults, register, uniqueEmail } from "./helpers";

/** Advertiser journey: register → map → filter → asset → request → dashboard. */
test("an advertiser can discover an asset and send a request", async ({ page }) => {
  const email = uniqueEmail("advertiser");
  await register(page, "ADVERTISER", email);

  // The map is the entry point and shows real inventory counts.
  await page.goto("/");
  // The live inventory count is visible on both layouts (map chip / sheet header).
  await expect(page.locator("text=/שטחי פרסום/").locator("visible=true").first()).toBeVisible();

  await openResults(page);
  const cards = page.locator("[data-results]:visible [data-asset]");
  await expect(cards.first()).toBeVisible({ timeout: 20_000 });

  // Open an asset from the results and check the honesty signals are present.
  const firstCard = cards.first();
  await firstCard.getByRole("link", { name: /בדיקת זמינות/ }).click();
  await page.waitForURL(/\/assets\//);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByText(/מאומת|ממתין לאימות/).first()).toBeVisible();

  // Save the asset.
  await page.getByRole("button", { name: /שמירה לרשימה/ }).click();
  await expect(page.getByRole("button", { name: /נשמר/ })).toBeVisible();

  // Submit a request.
  const start = new Date();
  start.setDate(start.getDate() + 30);
  const end = new Date();
  end.setDate(end.getDate() + 60);
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  await page.locator("#startDate").fill(iso(start));
  await page.locator("#endDate").fill(iso(end));
  await page.locator("#campaignName").fill("קמפיין בדיקה");
  await page.getByRole("button", { name: "שליחה" }).click();
  await expect(page.getByText("הבקשה נשלחה לבעל השטח.")).toBeVisible();

  // The request appears in the dashboard, and so does the saved asset.
  await page.goto("/dashboard/requests");
  await expect(page.getByText("קמפיין בדיקה")).toBeVisible();
  await page.goto("/dashboard/saved");
  await expect(page.locator("article").first()).toBeVisible();
});

test("an anonymous visitor is asked to sign in before requesting", async ({ page }) => {
  await page.goto("/");
  await openResults(page);
  const card = page.locator("[data-results]:visible [data-asset]").first();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.getByRole("link", { name: /בדיקת זמינות/ }).click();
  await page.waitForURL(/\/assets\//);
  await expect(page.getByText("יש להתחבר כדי להמשיך.")).toBeVisible();
});

test("an advertiser cannot reach the media owner area", async ({ page }) => {
  await login(page, "advertiser@velto.dev", DEV_PASSWORD);
  await page.goto("/owner");
  await expect(page).toHaveURL(/\/dashboard/);
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/$|\/dashboard/);
});
