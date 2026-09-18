import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { DEV_PASSWORD, login } from "./helpers";

/**
 * What happens when things go wrong.
 *
 * The rest of the suite walks the journeys that work. This one walks the ways
 * each of them fails, because that is where a product stops feeling finished:
 * a blank screen, a raw exception, or - worst - an action that looks like it
 * succeeded and did not.
 *
 * Every assertion here is the same shape: the user is told, in Hebrew, what
 * went wrong and what to do, and the page is still usable afterwards.
 */
test.skip(({ isMobile }) => !!isMobile, "server rules; one layout is enough");

test("signing up with an address that is already registered says so", async ({ page }) => {
  await page.goto("/register?role=ADVERTISER");
  await page.locator("#name").fill("בודק אוטומטי");
  await page.locator("#email").fill("advertiser@velto.dev");
  await page.locator("#password").fill(DEV_PASSWORD);
  await page.locator('input[name="acceptedTerms"]').check();
  await page.getByRole("button", { name: "יצירת חשבון" }).click();

  await expect(page.getByText("כתובת הדוא״ל כבר רשומה במערכת.")).toBeVisible();
  // Still on the form, with the form still usable - not a dead end.
  await expect(page.locator("#email")).toBeVisible();
});

test("a wrong password is refused without revealing which half was wrong", async ({ page }) => {
  await page.goto("/login");
  await page.locator("#email").fill("advertiser@velto.dev");
  await page.locator("#password").fill("definitely-not-the-password");
  await page.getByRole("button", { name: "כניסה לחשבון" }).click();

  const message = page.getByText("דוא״ל או סיסמה שגויים.");
  await expect(message).toBeVisible();

  // The identical message for an address that does not exist: the login form
  // must not be a way to enumerate who has an account here.
  await page.goto("/login");
  await page.locator("#email").fill(`nobody-${Date.now()}@velto-e2e.local`);
  await page.locator("#password").fill("definitely-not-the-password");
  await page.getByRole("button", { name: "כניסה לחשבון" }).click();
  await expect(page.getByText("דוא״ל או סיסמה שגויים.")).toBeVisible();
});

test("an owner cannot publish a listing with no photograph", async ({ page }) => {
  // A billboard nobody can see a picture of is not a credible public listing,
  // and the refusal has to name what is missing rather than just saying no.
  // The seeded owner rather than a fresh registration: signing up is itself
  // rate limited (correctly), and a spec that registers a user per test ends
  // up testing the limiter instead of the thing it came for.
  await login(page, "owner@velto.dev", DEV_PASSWORD);

  await page.goto("/owner/assets/new");
  await page.locator("#title").fill("שטח בלי תמונה");
  // Scoped to the wizard: the page header carries a submit button of its own
  // (logout), and "the first submit on the page" is not this one.
  await page.getByRole("button", { name: "שמירה והמשך" }).click();

  // The later steps unlock once the draft exists.
  //
  // Selected by its text inside the wizard's own list, not by accessible name:
  // the step number and its label are separate text nodes, so the computed
  // name is "7 . סקירה ופרסום" - with a space before the dot - and an exact
  // name match silently never resolves.
  const review = page.locator("ol[aria-label] button", { hasText: "סקירה ופרסום" });
  await expect(review).toBeEnabled({ timeout: 15_000 });
  await review.click();

  await page.getByRole("button", { name: /פרסום/ }).last().click();
  // Names what is missing rather than just refusing.
  await expect(page.getByText(/חסרים פרטים לפני פרסום/).first()).toBeVisible({ timeout: 15_000 });
});

test("requesting dates that are already sold is refused, and says which problem it is", async ({
  page,
}) => {
  // The server refuses two different situations with two different fixes: the
  // owner never offered these dates, or somebody else already bought them.
  const prisma = new PrismaClient();
  let assetId = "";
  let windowStart = "";
  let windowEnd = "";
  try {
    // An asset whose declared window is entirely covered by an approved booking.
    const asset = await prisma.mediaAsset.findFirstOrThrow({
      where: { status: "ACTIVE", bookings: { some: { status: "APPROVED" } } },
      include: {
        bookings: { where: { status: "APPROVED" }, orderBy: { startDate: "asc" }, take: 1 },
      },
    });
    assetId = asset.id;
    const booking = asset.bookings[0];
    windowStart = booking.startDate.toISOString().slice(0, 10);
    windowEnd = booking.endDate.toISOString().slice(0, 10);
  } finally {
    await prisma.$disconnect();
  }

  await login(page, "advertiser@velto.dev", DEV_PASSWORD);
  await page.goto(`/assets/${assetId}`);

  await page.locator("#startDate").fill(windowStart);
  await page.locator("#endDate").fill(windowEnd);
  await page.locator("#campaignName").fill("קמפיין על תאריכים תפוסים");
  await page.locator("#contactName").fill("בודק אוטומטי");
  await page.locator("#contactEmail").fill("advertiser@velto.dev");
  await page.getByRole("button", { name: /שליחת הבקשה|שליחה/ }).first().click();

  // Named, actionable, and in Hebrew - not a database constraint leaking out.
  await expect(
    page.getByText(/כבר תפוסים|אינו מוצע למכירה/).first()
  ).toBeVisible({ timeout: 15_000 });
});

test("an owner cannot open another owner's listing by changing the id", async ({ page }) => {
  const prisma = new PrismaClient();
  let otherAssetId = "";
  try {
    const asset = await prisma.mediaAsset.findFirstOrThrow({
      where: { owner: { email: "owner@velto.dev" } },
    });
    otherAssetId = asset.id;
  } finally {
    await prisma.$disconnect();
  }

  // A different real owner, not a new account: owner2 has their own listings
  // and no business with owner's.
  await login(page, "owner2@velto.dev", DEV_PASSWORD);
  await page.goto(`/owner/assets/${otherAssetId}`);

  // Refused, and refused as a page rather than as a stack trace.
  const body = await page.locator("body").innerText();
  expect(body).not.toContain("PrismaClient");
  expect(body).not.toContain("at Object");
  expect(body.length).toBeGreaterThan(20);
});

test("a URL that does not exist gets the not-found page, not a blank screen", async ({ page }) => {
  await page.goto("/this-page-does-not-exist");
  await expect(page.getByText("העמוד לא נמצא")).toBeVisible();
  // And a way out: the point of the page is not to be a dead end.
  await expect(page.getByRole("link", { name: "מפה" }).first()).toBeVisible();
});

test("an asset id that does not exist is a not-found page, not a crash", async ({ page }) => {
  await login(page, "admin@velto.dev", DEV_PASSWORD);
  await page.goto("/assets/this-id-is-not-real");
  await expect(page.getByText("העמוד לא נמצא")).toBeVisible();
});

test("uploading something that is not an image is refused with a readable reason", async ({
  page,
}) => {
  await login(page, "owner@velto.dev", DEV_PASSWORD);

  await page.goto("/owner/assets/new");
  await page.locator("#title").fill("שטח לבדיקת העלאה");
  await page.getByRole("button", { name: "שמירה והמשך" }).click();

  const images = page.locator("ol[aria-label] button", { hasText: "תמונות" });
  await expect(images).toBeEnabled({ timeout: 15_000 });
  await images.click();

  const input = page.locator('input[type="file"]').first();
  await expect(input).toBeAttached({ timeout: 10_000 });

  await input.setInputFiles({
    name: "not-an-image.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("this is definitely not a photograph of a billboard"),
  });

  // The server re-encodes every upload through sharp, so a text file cannot
  // pass as an image however it is labelled.
  await expect(page.getByText(/פורמט לא נתמך|יש לבחור קובץ תמונה|נכשל/).first()).toBeVisible({
    timeout: 20_000,
  });
});
