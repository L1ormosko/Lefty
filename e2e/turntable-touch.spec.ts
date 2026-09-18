import { expect, test } from "@playwright/test";
import { browseAsAdvertiser, openResults } from "./helpers";

/**
 * The turntable on a touch screen.
 *
 * Its own file because the rest of creative-mockup.spec.ts is desktop-only,
 * and this is the one thing about the gesture that can only go wrong on a
 * phone: a pointer capture taken on the first move swallows vertical
 * scrolling, and the listing becomes unreadable while the preview itself looks
 * perfect in every screenshot.
 *
 * Two halves, because scrolling is shared between the browser and the page.
 * The browser will only scroll a vertical swipe if touch-action permits it,
 * and the page must not consume the swipe itself.
 */
test.skip(({ isMobile }) => !isMobile, "the gesture conflict only exists on touch");

test("a vertical swipe belongs to the page, not to the turntable", async ({ page }) => {
  await browseAsAdvertiser(page);
  await page.goto("/explore");
  // On a phone the results live in a collapsed sheet.
  await openResults(page);
  const cards = page.locator('[data-results]:visible [data-asset] a[href^="/assets/"]');
  await expect(cards.first()).toBeVisible({ timeout: 20_000 });

  // Whether the *first* listing carries a turntable is the desktop suite's
  // question, and it asserts it. This spec is about the gesture, so it opens
  // the first listing that has one: the map also carries assets other specs
  // created along the way, which have no photographs at all.
  const hrefs = await cards.evaluateAll((links) =>
    links.map((l) => (l as HTMLAnchorElement).getAttribute("href")!)
  );
  const stage = page.locator("[data-turntable]");
  let found = false;
  for (const href of hrefs.slice(0, 12)) {
    await page.goto(href);
    await page.waitForTimeout(400);
    if ((await stage.count()) > 0) {
      found = true;
      break;
    }
  }
  expect(found, "no listing on the map has several marked angles").toBe(true);
  await expect(stage).toBeVisible();
  await stage.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);

  // The browser's half: vertical panning is left to it. Without this the
  // compositor hands the whole gesture to the page and the listing is stuck.
  const touchAction = await stage.evaluate((el) => getComputedStyle(el).touchAction);
  expect(touchAction).toContain("pan-y");

  // The page's half: a vertical drag does not spin the sign.
  const box = await stage.boundingBox();
  if (!box) throw new Error("no turntable");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(x, y - i * 18);
    await page.waitForTimeout(30);
  }
  await page.mouse.up();
  await page.waitForTimeout(300);
  await expect(stage).toHaveAttribute("aria-valuenow", "1");

  // A horizontal one does, so the gate is not simply "ignore every gesture".
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(x - i * 18, y);
    await page.waitForTimeout(30);
  }
  await page.mouse.up();
  await page.waitForTimeout(400);
  await expect(stage).not.toHaveAttribute("aria-valuenow", "1");
});
