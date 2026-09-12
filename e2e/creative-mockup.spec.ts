import { expect, test } from "@playwright/test";
import sharp from "sharp";
import { DEV_PASSWORD, login } from "./helpers";

/**
 * Previewing artwork on a real sign.
 *
 * Desktop only: the transform is computed from the photo's displayed size at
 * whatever width it is laid out, and the maths is covered in tests/mockup.ts.
 * What needs a browser is that the marking round trip works and that the
 * artwork lands where it was marked.
 */
test.skip(({ isMobile }) => !!isMobile, "one layout is enough for the round trip");

/** Artwork with a mark in one corner, so orientation is checkable. */
async function creativeFile() {
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400">
       <rect width="800" height="400" fill="#e11d48"/>
       <circle cx="60" cy="60" r="34" fill="#fff"/>
     </svg>`
  );
  const path = "/tmp/velto-e2e-creative.png";
  await sharp(svg).png().toFile(path);
  return path;
}

test("an advertiser previews their artwork on the marked face of a sign", async ({ page }) => {
  // The seed marks the face of the first demo listing, so the feature is
  // reachable without an admin step.
  await page.goto("/explore");
  await page.waitForTimeout(2500);

  // Find the one listing whose photo carries a marked face.
  const links = await page.locator('[data-results] [data-asset] a[href^="/assets/"]').evaluateAll(
    (nodes) => nodes.map((n) => (n as HTMLAnchorElement).getAttribute("href"))
  );
  let found: string | null = null;
  for (const href of links) {
    if (!href) continue;
    await page.goto(href);
    if (await page.locator("[data-mockup]").count()) {
      found = href;
      break;
    }
  }
  expect(found, "no listing has a marked sign face").not.toBeNull();

  // The disclaimer is above the picture, not under it.
  await expect(page.getByText("הדמיה בלבד — לא צילום של הפרסום בפועל.")).toBeVisible();

  // Watch for uploads before the file is chosen, or the listener would be
  // registered after the only moment it could have caught one.
  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.method() !== "GET") posts.push(`${r.method()} ${r.url()}`);
  });

  await page.locator("#mockup-file").setInputFiles(await creativeFile());
  await page.waitForTimeout(1200);

  const geometry = await page.evaluate(() => {
    const panel = document.querySelector("[data-mockup]")!;
    const images = panel.querySelectorAll("img");
    if (images.length < 2) return null;
    const photo = images[0].getBoundingClientRect();
    const art = images[1].getBoundingClientRect();
    return {
      transform: getComputedStyle(images[1]).transform,
      x: (art.x - photo.x) / photo.width,
      y: (art.y - photo.y) / photo.height,
      w: art.width / photo.width,
      h: art.height / photo.height,
    };
  });

  expect(geometry, "the artwork did not render").not.toBeNull();

  // It sits on the marked face rather than filling the photo or hiding in a
  // corner: the seeded quad spans x 0.22-0.78 and y 0.28-0.72.
  expect(geometry!.x).toBeGreaterThan(0.15);
  expect(geometry!.x).toBeLessThan(0.3);
  expect(geometry!.w).toBeGreaterThan(0.45);
  expect(geometry!.w).toBeLessThan(0.65);
  expect(geometry!.h).toBeGreaterThan(0.3);
  expect(geometry!.h).toBeLessThan(0.55);

  // And it is a real perspective transform. A browser reports matrix3d only
  // when the matrix is not reducible to 2D - an affine result would come back
  // as matrix(), which is exactly the bug this feature exists to avoid.
  expect(geometry!.transform.startsWith("matrix3d(")).toBe(true);

  // The artwork stayed in the browser. This is the promise the panel makes in
  // so many words, and it is the reason the feature is safe to offer at all:
  // unreleased campaign creative is the most confidential thing an advertiser
  // has. Any non-GET request between choosing the file and now would break it.
  expect(posts).toEqual([]);
});

test("a listing with no marked face is not offered a preview at all", async ({ page }) => {
  // Rather than a broken or guessed rectangle. The seed marks exactly one
  // listing, so any other one proves the negative.
  await page.goto("/explore");
  await page.waitForTimeout(2500);

  const links = await page.locator('[data-results] [data-asset] a[href^="/assets/"]').evaluateAll(
    (nodes) => nodes.map((n) => (n as HTMLAnchorElement).getAttribute("href"))
  );
  let unmarked = 0;
  for (const href of links.slice(0, 6)) {
    if (!href) continue;
    await page.goto(href);
    if ((await page.locator("[data-mockup]").count()) === 0) unmarked++;
  }
  expect(unmarked).toBeGreaterThan(0);
});

test("an admin can mark and clear a sign face", async ({ page }) => {
  await login(page, "admin@velto.dev", DEV_PASSWORD);
  await page.goto("/admin/assets?filter=all");

  // An *unmarked* listing: a marked one shows "... · מסומן", and marking then
  // clearing that one would destroy the seeded fixture the first test needs.
  const open = page.getByRole("button", { name: "סימון פאת השלט", exact: true }).first();
  await open.click();

  const photo = page.locator("img.cursor-crosshair").first();
  // Scroll first, then measure: mouse.click takes viewport coordinates, and a
  // box measured while the panel is below the fold names a point the mouse
  // cannot reach.
  await photo.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  const box = await photo.boundingBox();
  if (!box) throw new Error("no photo to mark");

  // Clockwise from the top-left of the sign's face.
  for (const [fx, fy] of [
    [0.3, 0.35],
    [0.7, 0.4],
    [0.7, 0.6],
    [0.3, 0.68],
  ]) {
    await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
    await page.waitForTimeout(120);
  }

  await page.getByRole("button", { name: "שמירת הסימון" }).first().click();
  await expect(page.getByText("הסימון נשמר.")).toBeVisible();

  // And undone, so this spec leaves the database as it found it.
  await page.reload();
  await page.getByRole("button", { name: /סימון פאת השלט · מסומן/ }).first().click();
  await page.getByRole("button", { name: "מחיקת הסימון" }).first().click();
  await expect(page.getByText("הסימון נמחק.")).toBeVisible();
});
