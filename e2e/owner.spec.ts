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

  // The window must appear in the LIST straight away. This step used to print
  // "saved - reload the page to see the updated list", which is the one thing
  // an owner must not do here: assetId and step live in component state, so a
  // reload drops them back to step one of a half-built asset. With no visible
  // confirmation the obvious move is to submit the same window again.
  //
  // Asserted on the list rows rather than on the success message: an earlier
  // version of this test checked the message and the date, and both are true
  // whether or not the list updates - it passed with the fix reverted.
  const windowRows = page
    .getByRole("listitem")
    .filter({ has: page.getByRole("button", { name: "מחיקה" }) });
  await expect(windowRows).toHaveCount(1, { timeout: 15_000 });
  await expect(windowRows.first()).toContainText(iso(start).split("-").reverse().join("/"));

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

  // The photo must be stored somewhere that survives a restart. The host's
  // filesystem is ephemeral, so an image written to disk is gone on the next
  // deploy while its row remains, and the listing renders a broken picture.
  // Assert both halves: it is served from the database-backed route, and the
  // bytes actually come back.
  const src = await page.locator('img[alt=""]').first().getAttribute("src");
  expect(src, "uploaded images must not be served from the ephemeral disk").toMatch(
    /^\/api\/images\//
  );
  const served = await page.request.get(src!);
  expect(served.status()).toBe(200);
  expect(served.headers()["content-type"]).toBe("image/webp");

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
