import { expect, test } from "@playwright/test";
import sharp from "sharp";
import { DEV_PASSWORD, login,  browseAsAdvertiser } from "./helpers";

/**
 * Previewing artwork on a sign.
 *
 * Desktop only: the maths is covered in tests/mockup.ts, and what needs a
 * browser is that the feature is reachable and lands where it was marked.
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

/** The first listing a visitor would actually click. */
async function openFirstListing(page: import("@playwright/test").Page) {
  await browseAsAdvertiser(page);
  await page.goto("/explore");
  const card = page.locator('[data-results]:visible [data-asset] a[href^="/assets/"]').first();
  await expect(card).toBeVisible({ timeout: 20_000 });
  const href = await card.getAttribute("href");
  await page.goto(href!);
  return href!;
}

test("the preview is on the first listing a visitor opens, not hidden on one of them", async ({
  page,
}) => {
  // This is the assertion that was missing. The earlier version walked every
  // listing until it found a marked one, so it passed while exactly one
  // listing of fifteen had a face - and that one sorted last, which meant
  // nobody clicking normally ever saw the feature.
  await openFirstListing(page);
  await expect(page.locator("[data-mockup]")).toHaveCount(1);
  await expect(page.getByText("הדמיה בלבד — לא צילום של הפרסום בפועל.")).toBeVisible();
});

test("the artwork lands on the sign's face", async ({ page }) => {
  await openFirstListing(page);

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
      x: (art.x - photo.x) / photo.width,
      y: (art.y - photo.y) / photo.height,
      w: art.width / photo.width,
      h: art.height / photo.height,
    };
  });

  expect(geometry, "the artwork did not render").not.toBeNull();

  // On the sign rather than filling the photo or hiding in a corner. Every
  // demo face is drawn inside the middle of the frame, whatever the shape.
  expect(geometry!.x).toBeGreaterThan(0.1);
  expect(geometry!.x + geometry!.w).toBeLessThan(0.9);
  expect(geometry!.y).toBeGreaterThan(0.1);
  expect(geometry!.y + geometry!.h).toBeLessThan(0.9);
  // Deliberately a loose floor. Now that artwork is fitted rather than
  // stretched, a 2:1 file on a 0.4:1 totem correctly occupies a thin band -
  // the earlier threshold assumed the artwork always filled the whole face,
  // which is exactly the behaviour this release removed.
  expect(geometry!.w * geometry!.h).toBeGreaterThan(0.002);

  // The artwork stayed in the browser. This is the promise the panel makes in
  // so many words, and it is why the feature is safe to offer at all:
  // unreleased campaign creative is the most confidential thing an advertiser
  // has. Any non-GET request between choosing the file and now would break it.
  expect(posts).toEqual([]);
});

test("an admin can clear a face, which removes the preview, and mark it again", async ({ page }) => {
  // The negative case and the admin round trip in one, so the spec restores
  // whatever it changed instead of leaving a listing without a face.
  await login(page, "admin@velto.dev", DEV_PASSWORD);
  await page.goto("/admin/assets?filter=all");

  const row = page.locator("[data-admin-asset]").first();
  const href = await row.locator('a[href^="/assets/"]').first().getAttribute("href");
  expect(href, "could not identify a listing to mark").not.toBeNull();

  await row.getByRole("button", { name: /סימון פאת השלט/ }).click();
  await row.getByRole("button", { name: "מחיקת הסימון" }).click();
  await expect(page.getByText("הסימון נמחק.")).toBeVisible();

  // With no face marked the preview is not offered at all - rather than
  // offered with a guessed rectangle.
  await page.goto(href!);
  await expect(page.locator("[data-mockup]")).toHaveCount(0);

  // Mark it again, by clicking its four corners.
  await page.goto("/admin/assets?filter=all");
  const again = page.locator("[data-admin-asset]").first();
  await again.getByRole("button", { name: /סימון פאת השלט/ }).click();
  const photo = again.locator("img.cursor-crosshair");
  // Scroll first, then measure: mouse.click takes viewport coordinates, and a
  // box measured while the panel is below the fold names an unreachable point.
  await photo.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  const box = await photo.boundingBox();
  if (!box) throw new Error("no photo to mark");

  for (const [fx, fy] of [
    [0.386, 0.32],
    [0.614, 0.32],
    [0.614, 0.512],
    [0.386, 0.512],
  ]) {
    await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
    await page.waitForTimeout(120);
  }
  await again.getByRole("button", { name: "שמירת הסימון" }).click();
  await expect(page.getByText("הסימון נשמר.")).toBeVisible();

  // And the preview is back.
  await page.goto(href!);
  await expect(page.locator("[data-mockup]")).toHaveCount(1);
});

test("a square file is not stretched to the shape of the sign", async ({ page }) => {
  // The defect this pins: the artwork used to be mapped onto the whole face,
  // so a square file on a 3:1 billboard rendered three times too wide - a
  // picture of an ad that will never exist.
  await openFirstListing(page);

  // The listing states the sign's real proportions before anything is chosen.
  await expect(page.getByText(/מידות השטח: .* יחס/)).toBeVisible();

  const square = "/tmp/velto-e2e-square.png";
  await sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600">
         <rect width="600" height="600" fill="#e11d48"/>
       </svg>`
    )
  )
    .png()
    .toFile(square);

  await page.locator("#mockup-file").setInputFiles(square);
  await page.waitForTimeout(1200);

  const rendered = await page.evaluate(() => {
    const panel = document.querySelector("[data-mockup]")!;
    const art = [...panel.querySelectorAll("img")].find((i) => i.style.transform);
    if (!art) return null;
    const box = art.getBoundingClientRect();
    return box.width / box.height;
  });

  expect(rendered, "the artwork did not render").not.toBeNull();
  // Square in, square out - whatever shape the sign is.
  expect(rendered!).toBeGreaterThan(0.9);
  expect(rendered!).toBeLessThan(1.1);

  // And the mismatch is explained rather than silently absorbed.
  await expect(page.getByText(/הקובץ שבחרתם ביחס/)).toBeVisible();
});

test("no Street View panel without a Google key", async ({ page }) => {
  // The panel is behind NEXT_PUBLIC_GOOGLE_MAPS_EMBED_KEY, which is unset
  // here. A dead frame saying "unavailable" would be the empty promise this
  // project does not ship.
  test.skip(!!process.env.NEXT_PUBLIC_GOOGLE_MAPS_EMBED_KEY, "a key is configured");
  await openFirstListing(page);
  await expect(page.locator("[data-streetview]")).toHaveCount(0);
});
