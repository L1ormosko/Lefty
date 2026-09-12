import { expect, test } from "@playwright/test";
import { openResults } from "./helpers";

/**
 * The map is the product's main surface, and these are the two things it used
 * to lose: where you were looking, and what you had filtered.
 */

test("the map remembers where you were looking", async ({ page }) => {
  await page.goto("/explore");
  await page.locator(".maplibregl-canvas").waitFor();
  // Let the first render settle: the camera is only written once the user
  // moves it, so an early drag would be indistinguishable from the default.
  await page.waitForTimeout(2000);

  const box = await page.locator(".maplibregl-canvas").boundingBox();
  if (!box) throw new Error("no canvas");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 90, cy - 70, { steps: 12 });
  await page.mouse.up();

  await expect(page).toHaveURL(/lat=.*lng=/);
  const moved = page.url();

  // Reopening the link puts the camera back rather than snapping to the
  // default centre.
  await page.goto(moved);
  await page.locator(".maplibregl-canvas").waitFor();
  await page.waitForTimeout(2000);
  expect(page.url()).toBe(moved);
});

test("the results sheet can be dragged open, and still opens on a tap", async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, "the sheet only exists on the phone layout");

  await page.goto("/explore");
  await page.waitForTimeout(3000);

  const sheet = page.locator("div.rounded-t-2xl").last();
  const height = async () => (await sheet.boundingBox())?.height ?? 0;
  const collapsed = await height();
  expect(collapsed).toBeLessThan(120);

  const handle = page.getByRole("button", { name: "רשימה" });
  const box = await handle.boundingBox();
  if (!box) throw new Error("no handle");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;

  // Deliberately slow: a fast drag is a flick, and a flick is credited with
  // momentum that carries the sheet past the nearest height on purpose. This
  // one is meant to land where the finger left it.
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(x, y - i * 35);
    await page.waitForTimeout(70);
  }
  await page.mouse.up();
  await page.waitForTimeout(400);

  const viewport = (await page.viewportSize())!.height;
  const opened = await height();
  expect(opened).toBeGreaterThan(collapsed * 3);

  // Landed on the middle height - and stayed there. The release must not also
  // register as a tap, which would cycle it straight on to full.
  expect(opened / viewport).toBeGreaterThan(0.45);
  expect(opened / viewport).toBeLessThan(0.6);

  // Tapping is still a way in, for anyone who never tries the drag.
  await handle.tap();
  await page.waitForTimeout(400);
  expect(await height()).toBeGreaterThan(opened);
});

test("an applied filter is visible as a chip and can be removed on its own", async ({ page }) => {
  await page.goto("/explore");
  await openResults(page);

  // Two filters, set from two different controls.
  const city = page.locator("#f-city").locator("visible=true").first();
  if (!(await city.isVisible().catch(() => false))) {
    // On mobile the panel is a dialog.
    await page.getByRole("button", { name: /מסננים/ }).click();
  }
  await page.locator("#f-city").locator("visible=true").first().selectOption({ index: 1 });
  await page
    .getByText("דיגיטלי בלבד", { exact: true })
    .locator("visible=true")
    .first()
    .click();
  await expect(page).toHaveURL(/city=/);
  await expect(page).toHaveURL(/digitalOnly=1/);

  // On mobile the filters are a full-screen dialog; the chips sit on the map
  // behind it.
  const dialog = page.getByRole("dialog", { name: "מסננים" });
  if (await dialog.isVisible().catch(() => false)) {
    await dialog.getByRole("button", { name: "סגירה" }).click();
    await openResults(page);
  }

  const chip = (name: RegExp) =>
    page.locator(`button[aria-label^="הסרת המסנן"]`).filter({ hasText: name }).locator("visible=true");

  await expect(chip(/דיגיטלי בלבד/).first()).toBeVisible();

  // Removing one leaves the other standing - the bug this guards against is a
  // chip that clears its whole group.
  await chip(/דיגיטלי בלבד/).first().click();
  await expect(page).not.toHaveURL(/digitalOnly=1/);
  await expect(page).toHaveURL(/city=/);
});
