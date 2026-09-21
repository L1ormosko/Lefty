import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { DEV_PASSWORD, login } from "./helpers";

/**
 * What a signed-in customer without access is told.
 *
 * The bug this pins was visible in a screenshot: a user whose own name was in
 * the header, on a listing page, reading "this page opens with an account",
 * a button saying "open an account and start the trial", and a link asking
 * "do you already have an account?". Four wrong statements at once, because
 * the access check knew whether the account had paid and not whether there
 * was an account at all.
 *
 * These tests are deliberately about the words on the screen. The underlying
 * rule has unit coverage; what broke here was what the product said to a
 * person, and only a rendered page can catch that.
 */
test.skip(({ isMobile }) => !!isMobile, "server-rendered copy; one layout is enough");

/** A signed-in account deliberately left with no subscription at all. */
const LOCKED_OUT = "locked-out@velto-e2e.local";

test.beforeAll(async () => {
  const prisma = new PrismaClient();
  try {
    const bcrypt = await import("bcryptjs");
    const passwordHash = await bcrypt.default.hash(DEV_PASSWORD, 10);
    await prisma.user.deleteMany({ where: { email: LOCKED_OUT } });
    await prisma.user.create({
      data: {
        email: LOCKED_OUT,
        passwordHash,
        name: "בודק ללא מנוי",
        role: "ADVERTISER",
        termsAcceptedAt: new Date(),
        // No subscription row: the exact state that produced "none" and,
        // with it, the stranger's pitch.
      },
    });
  } finally {
    await prisma.$disconnect();
  }
});

test.afterAll(async () => {
  const prisma = new PrismaClient();
  try {
    await prisma.user.deleteMany({ where: { email: LOCKED_OUT } });
  } finally {
    await prisma.$disconnect();
  }
});

test("a signed-in visitor is never told to register or to sign in", async ({ page }) => {
  await login(page, LOCKED_OUT, DEV_PASSWORD);

  const prisma = new PrismaClient();
  let assetId = "";
  try {
    const asset = await prisma.mediaAsset.findFirstOrThrow({ where: { status: "ACTIVE" } });
    assetId = asset.id;
  } finally {
    await prisma.$disconnect();
  }

  await page.goto(`/assets/${assetId}`);

  // The header proves there is a session - without this the rest of the test
  // would pass for an anonymous visitor too. It used to check the logout
  // button; that now lives inside the account menu, so the check is the menu
  // itself, which only renders for a signed-in reader.
  await expect(page.locator("[data-account-menu]")).toBeVisible();

  const body = await page.locator("main").innerText();
  expect(body).not.toContain("פתיחת חשבון");
  expect(body).not.toContain("יש לכם כבר חשבון");
  expect(body).not.toContain("אחרי הרשמה");

  // And it says something true instead, with a way forward.
  await expect(page.getByRole("link", { name: "בקשת גישה" })).toBeVisible();
});

test("the map says the same thing to the same person", async ({ page }) => {
  // The notice renders on three surfaces; a fix applied to one of them is the
  // shape this bug had in the first place.
  await login(page, LOCKED_OUT, DEV_PASSWORD);
  await page.goto("/explore");

  const notice = page.locator("[data-results]:visible").first();
  await expect(notice).toBeVisible({ timeout: 20_000 });
  const text = await notice.innerText();
  expect(text).not.toContain("פתיחת חשבון");
  expect(text).not.toContain("יש לכם כבר חשבון");
});

test("the request button reaches a form that works", async ({ page }) => {
  await login(page, LOCKED_OUT, DEV_PASSWORD);
  await page.goto("/access");

  await expect(page.getByRole("heading", { name: "גישה לחשבון" })).toBeVisible();
  // The state is named rather than implied.
  await expect(page.getByText("אין כרגע מנוי על החשבון.")).toBeVisible();

  await page.locator("#message").fill("בדיקה אוטומטית — חמישה שלטים בבאר שבע");
  await page.getByRole("button", { name: "שליחת הבקשה" }).click();

  /*
   * The confirmation is the pending state, not a success banner.
   *
   * The action revalidates /access, the page re-renders, sees an open request
   * and swaps the form for "sent, waiting". The form unmounts with it, so its
   * own success Alert never appears - and should not: two confirmations for
   * one press is one too many, and this one survives a refresh.
   */
  await expect(page.getByText("הבקשה שלכם נשלחה ומחכה לטיפול.")).toBeVisible({ timeout: 15_000 });
  // The form is gone, so pressing twice is not even offered.
  await expect(page.getByRole("button", { name: "שליחת הבקשה" })).toHaveCount(0);

  // And it survives a reload, rather than being a message that existed once.
  await page.goto("/access");
  await expect(page.getByText("הבקשה שלכם נשלחה ומחכה לטיפול.")).toBeVisible();
});

test("an admin sees the request in a queue and can close it", async ({ page }) => {
  await login(page, "admin@velto.dev", DEV_PASSWORD);
  await page.goto("/admin/access");

  await expect(page.getByRole("heading", { name: "בקשות גישה" })).toBeVisible();
  // Closing a request is not granting access, and the screen says so.
  await expect(page.getByText(/סגירת בקשה אינה פותחת גישה/)).toBeVisible();

  // The request the previous test filed.
  const row = page.getByText(LOCKED_OUT).first();
  await expect(row).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: "סמנו כטופל" }).first().click();

  /*
   * Closing revalidates the queue, the row is no longer OPEN, and it leaves -
   * taking its form and that form's success message with it. Leaving the
   * queue IS the confirmation, and it is the one that matters: an admin needs
   * to see the pile shrink, not a banner on a row that is still sitting there.
   */
  await expect(row).toHaveCount(0, { timeout: 15_000 });
});

test("a paying customer is shown nothing about access at all", async ({ page }) => {
  // The seeded advertiser is paid up. The notice is for people who need it.
  await login(page, "advertiser@velto.dev", DEV_PASSWORD);
  await page.goto("/explore");

  const results = page.locator("[data-results]:visible").first();
  await expect(results).toBeVisible({ timeout: 20_000 });
  const text = await results.innerText();
  expect(text).not.toContain("בקשת גישה");
  expect(text).not.toContain("פתיחת חשבון");
});
