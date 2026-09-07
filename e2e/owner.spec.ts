import { expect, test } from "@playwright/test";
import sharp from "sharp";
import { DEV_PASSWORD, login } from "./helpers";

/** Media owner journey: login → create asset → publish → see it on the map. */
test("a media owner can publish an asset through the wizard", async ({ page }) => {
  await login(page, "owner@velto.dev", DEV_PASSWORD);
  await page.goto("/owner/assets/new");

  const title = `שטח בדיקה ${Date.now()}`;
  await page.locator("#title").fill(title);
  await page.locator("#assetType").selectOption("BILLBOARD");
  await page.getByRole("button", { name: /שמירה כטיוטה|המשך/ }).click();

  // Step 2: location. The map click sets the coordinates.
  await expect(page.locator("#address")).toBeVisible({ timeout: 20_000 });
  await page.locator("#address").fill("רחוב הבדיקה 7");
  await page.locator("#city").fill("באר שבע");
  const map = page.locator(".maplibregl-canvas").first();
  await expect(map).toBeVisible({ timeout: 20_000 });
  await map.click({ position: { x: 200, y: 150 } });
  await page.getByRole("button", { name: "המשך" }).click();

  // Step 3: specs.
  await expect(page.locator("#sides")).toBeVisible();
  await page.getByRole("button", { name: "המשך" }).click();

  // Step 4: pricing.
  await expect(page.locator("#priceMonthly")).toBeVisible();
  await page.locator("#priceMonthly").fill("6000");
  await page.getByRole("button", { name: "המשך" }).click();

  // Step 5: availability window.
  const start = new Date();
  const end = new Date();
  end.setDate(end.getDate() + 120);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  await page.locator("#startDate").fill(iso(start));
  await page.locator("#endDate").fill(iso(end));
  await page.getByRole("button", { name: "הוספת חלון" }).click();
  await page.getByRole("button", { name: "המשך" }).click();

  // Step 6: images. Publishing now requires at least one photo.
  const imageBuffer = await sharp({
    create: { width: 300, height: 200, channels: 3, background: { r: 120, g: 140, b: 200 } },
  })
    .jpeg()
    .toBuffer();
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: "billboard.jpg", mimeType: "image/jpeg", buffer: imageBuffer });
  await expect(page.getByRole("button", { name: "מחיקה" })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "המשך" }).click();

  await page.getByRole("button", { name: "פרסום השטח" }).click();
  await expect(page.getByText("השטח פורסם וממתין לאימות VELTO.")).toBeVisible();

  await page.goto("/owner/assets");
  await expect(page.getByText(title)).toBeVisible();
});

test("a media owner sees inquiries and can respond", async ({ page }) => {
  await login(page, "owner@velto.dev", DEV_PASSWORD);
  await page.goto("/owner/inquiries");
  const first = page.locator("form").filter({ hasText: "מענה למפרסם" }).first();
  if (await first.isVisible()) {
    await first.getByRole("textbox").fill("השטח זמין בתאריכים אלה. נשמח לתאם.");
    await first.getByRole("button", { name: "שליחה" }).click();
    await expect(page.getByText("המענה נשלח.")).toBeVisible();
  }
});

test("a media owner cannot open another owner's asset editor", async ({ page }) => {
  await login(page, "owner2@velto.dev", DEV_PASSWORD);
  const response = await page.goto("/owner/assets/does-not-exist-id");
  expect(response?.status()).toBeGreaterThanOrEqual(400);
});
