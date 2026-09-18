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

/**
 * Turn the preview to the angle photographed head on.
 *
 * Anything measured about the artwork's own shape has to be measured there: on
 * a view from the side the sign is foreshortened, so a square file correctly
 * renders as a non-square box and a test that assumed otherwise would be
 * measuring perspective and calling it distortion.
 */
async function faceOn(page: import("@playwright/test").Page) {
  const stage = page.locator("[data-turntable]");
  if ((await stage.count()) === 0) return;
  const count = Number(await stage.getAttribute("data-turntable"));
  await stage.focus();
  for (let i = 0; i < count; i++) {
    if ((await stage.getAttribute("aria-valuetext")) === "מלפנים") return;
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(150);
  }
  throw new Error("no head-on angle on this listing");
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

  // Every photo of the listing, not only the first: a listing now carries
  // several angles, and one cleared face out of three leaves the preview
  // standing - which is correct behaviour and would make a single clear look
  // like a broken test.
  const openers = row.getByRole("button", { name: /סימון פאת השלט/ });
  const angles = await openers.count();
  expect(angles, "the listing should carry several photographed angles").toBeGreaterThan(1);
  // Always the first still-closed one: an opened panel stops rendering its
  // button, so the locator's second entry is gone by the time nth(1) is asked
  // for.
  for (let i = 0; i < angles; i++) await openers.first().click();

  const clears = row.getByRole("button", { name: "מחיקת הסימון" });
  for (let i = 0; i < angles; i++) {
    await clears.first().click();
    await expect(page.getByText("הסימון נמחק.").first()).toBeVisible();
    await expect.poll(() => clears.count(), { timeout: 10_000 }).toBe(angles - i - 1);
  }

  // With no face marked the preview is not offered at all - rather than
  // offered with a guessed rectangle.
  await page.goto(href!);
  await expect(page.locator("[data-mockup]")).toHaveCount(0);

  // Mark every angle again, by clicking its four corners. All of them, not one:
  // this listing may well be the one a visitor opens first, and leaving it with
  // a single marked photo would quietly delete the turntable for the rest of
  // the suite - and for anyone browsing the dev environment afterwards.
  await page.goto("/admin/assets?filter=all");
  const again = page.locator("[data-admin-asset]").first();

  for (let i = 0; i < angles; i++) {
    await again.getByRole("button", { name: /סימון פאת השלט/ }).first().click();
    // The panel just opened is the last one in the DOM among the open ones -
    // forms opened earlier in this loop are still showing their own photo.
    const photo = again.locator("img.cursor-crosshair").last();
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
    await again.getByRole("button", { name: "שמירת הסימון" }).last().click();
    await expect(page.getByText("הסימון נשמר.").first()).toBeVisible();
    await page.waitForTimeout(400);
  }

  // And the preview is back, with every angle on it.
  await page.goto(href!);
  await expect(page.locator("[data-mockup]")).toHaveCount(1);
  expect(Number(await page.locator("[data-turntable]").getAttribute("data-turntable"))).toBe(angles);
});

test("a square file is not stretched to the shape of the sign", async ({ page }) => {
  // The defect this pins: the artwork used to be mapped onto the whole face,
  // so a square file on a 3:1 billboard rendered three times too wide - a
  // picture of an ad that will never exist.
  await openFirstListing(page);

  await faceOn(page);

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

test("the ad turns with the sign when the angles are scrubbed", async ({ page }) => {
  // The whole point of the turntable, in one assertion: the artwork is
  // re-projected onto each angle's own marked face, so moving between two
  // photographs changes its transform. A slideshow that swapped the photo and
  // left the ad where it was would look like a sticker, and would pass every
  // other test in this file.
  await openFirstListing(page);

  const stage = page.locator("[data-turntable]");
  await expect(stage).toBeVisible();
  expect(Number(await stage.getAttribute("data-turntable"))).toBeGreaterThan(1);

  await page.locator("#mockup-file").setInputFiles(await creativeFile());
  await page.waitForTimeout(1200);

  const art = page.locator("[data-creative]");
  const transform = () => art.evaluate((el) => (el as HTMLElement).style.transform);
  const before = await transform();
  expect(before).toContain("matrix3d");

  // Scroll first, then measure: mouse.move takes viewport coordinates, and the
  // preview sits well below the fold on a listing page - a box measured before
  // scrolling names a point the pointer can never reach, so every event misses
  // and the feature looks broken while working perfectly.
  await stage.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  const box = await stage.boundingBox();
  if (!box) throw new Error("no turntable");
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.7, y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(box.x + box.width * (0.7 - i * 0.05), y);
    await page.waitForTimeout(40);
  }
  await page.mouse.up();
  await page.waitForTimeout(500);

  await expect.poll(transform, { timeout: 5_000 }).not.toBe(before);

  // And it is still on the sign after the move, not slid off the photo.
  const geometry = await page.evaluate(() => {
    const stage = document.querySelector("[data-turntable]")!;
    const photo = stage.querySelector("img")!.getBoundingClientRect();
    const box = document.querySelector("[data-creative]")!.getBoundingClientRect();
    return {
      x: (box.x - photo.x) / photo.width,
      y: (box.y - photo.y) / photo.height,
      w: box.width / photo.width,
      h: box.height / photo.height,
    };
  });
  expect(geometry.x).toBeGreaterThan(0.1);
  expect(geometry.x + geometry.w).toBeLessThan(0.9);
  expect(geometry.y).toBeGreaterThan(0.1);
  expect(geometry.y + geometry.h).toBeLessThan(0.9);
});

test("the angles can be reached without a mouse", async ({ page }) => {
  await openFirstListing(page);
  const stage = page.locator("[data-turntable]");
  await stage.focus();
  await expect(stage).toHaveAttribute("aria-valuenow", "1");
  await page.keyboard.press("ArrowRight");
  await expect(stage).toHaveAttribute("aria-valuenow", "2");
  await page.keyboard.press("ArrowLeft");
  await expect(stage).toHaveAttribute("aria-valuenow", "1");
  // And it stops at the end rather than looping round to an angle nobody
  // photographed from in between.
  await page.keyboard.press("ArrowLeft");
  await expect(stage).toHaveAttribute("aria-valuenow", "1");
});

test("no Street View panel without a Google key", async ({ page }) => {
  // The panel is behind NEXT_PUBLIC_GOOGLE_MAPS_EMBED_KEY, which is unset
  // here. A dead frame saying "unavailable" would be the empty promise this
  // project does not ship.
  test.skip(!!process.env.NEXT_PUBLIC_GOOGLE_MAPS_EMBED_KEY, "a key is configured");
  await openFirstListing(page);
  await expect(page.locator("[data-streetview]")).toHaveCount(0);
});
