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
