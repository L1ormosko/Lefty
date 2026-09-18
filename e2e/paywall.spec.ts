import { expect, test } from "@playwright/test";
import { DEV_PASSWORD, login, openResults } from "./helpers";

/**
 * The paywall, from the browser.
 *
 * tests/paywall.test.ts pins what reaches the caller. This pins the half that
 * only a browser can answer: that the screens which used to leak really do not
 * any more, and that a disarmed control is not still sitting on the page.
 */
test.skip(({ isMobile }) => !!isMobile, "a server rule needs one layout, not two");

test("an anonymous visitor gets the brief's ranking without its addresses or prices", async ({
  page,
}) => {
  // This was the largest hole in the audit: /brief had no access check at all,
  // so the matcher handed out the street address, a priced estimate and the
  // date each sign frees up - to anyone, with no account.
  await page.goto("/brief?cities=%D7%91%D7%90%D7%A8%20%D7%A9%D7%91%D7%A2");
  await page.waitForLoadState("networkidle");

  // The ranking is still there - it is a fair sample of the product - and it
  // really did rank something, or this test would pass on an empty page.
  const cards = page.locator("main").getByText("למה הותאם", { exact: false });
  await expect(cards.first()).toBeVisible({ timeout: 15_000 });

  // What it ranked is not: no price, and the withholding is stated rather than
  // rendered as an empty field that reads like "this one has no price".
  await expect(
    page.getByText("מחיר, כתובת ותאריכים פנויים נפתחים עם חשבון.").first()
  ).toBeVisible();
  const body = await page.locator("main").innerText();
  expect(body).not.toMatch(/₪\s*[\d,]/);

  // And the pitch is on the page, because a blurred shortlist is the argument.
  await expect(page.getByRole("link", { name: /פתיחת חשבון/ })).toBeVisible();
});

test("the map hides the filters it will not apply", async ({ page }) => {
  await page.goto("/explore");
  await openResults(page);
  const filtersButton = page.getByRole("button", { name: "מסננים" });
  if (await filtersButton.isVisible().catch(() => false)) await filtersButton.click();

  // City and type filter on things a visitor can see anyway, so they stay.
  await expect(page.locator("#f-city:visible")).toBeVisible();

  // Price and dates are an oracle for exactly what the redaction withholds:
  // maxPrice=4000 matching and maxPrice=3999 not states the price to the
  // shekel. The server ignores them; leaving them on screen would be a control
  // that silently does nothing.
  await expect(page.locator("#f-start")).toHaveCount(0);
  await expect(page.locator("#f-end")).toHaveCount(0);
  await expect(page.getByPlaceholder("מינימום")).toHaveCount(0);
  await expect(page.getByText("סינון לפי מחיר, תאריכים וזמינות נפתח עם חשבון.", { exact: false })).toBeVisible();
});

test("an admin sees the real thing, so the gate is a gate and not a bug", async ({ page }) => {
  await login(page, "admin@velto.dev", DEV_PASSWORD);
  await page.goto("/explore");
  await openResults(page);

  const filtersButton = page.getByRole("button", { name: "מסננים" });
  if (await filtersButton.isVisible().catch(() => false)) await filtersButton.click();

  // The same controls the anonymous visitor was refused.
  await expect(page.locator("#f-start")).toBeVisible();
  await expect(page.getByPlaceholder("מינימום").first()).toBeVisible();
});

test("an image of a listing that is not public is refused to a stranger", async ({ page, request }) => {
  // Holding the id is not permission. The route used to serve any image to
  // anyone who knew the URL, which leaked the photographs of drafts and of
  // listings that had been taken down.
  await login(page, "admin@velto.dev", DEV_PASSWORD);
  await page.goto("/admin/assets?filter=all");
  // The photo lives inside the marking panel, which is collapsed by default.
  await page.locator("[data-admin-asset]").first().getByRole("button", { name: /סימון פאת השלט/ }).first().click();
  const photo = page.locator("[data-admin-asset] img").first();
  await expect(photo).toBeVisible({ timeout: 20_000 });
  const src = await photo.getAttribute("src");
  expect(src).toMatch(/^\/api\/images\//);

  // The admin's own browser can load it.
  const asAdmin = await page.request.get(src!);
  expect(asAdmin.status()).toBe(200);

  // A request with no session cannot - `request` is a fresh context with no
  // cookies, which is exactly the "I pasted the URL to someone" case.
  const anonymous = await request.get(`http://localhost:3000${src}`);
  expect([401, 403, 404]).toContain(anonymous.status());
});

test("the audit log records an admin decision and cannot be edited from the UI", async ({ page }) => {
  await login(page, "admin@velto.dev", DEV_PASSWORD);

  // Do something worth logging first. Asserting on whatever happens to be in
  // the log is a test that passes for the wrong reason - and fails on a fresh
  // database, which is exactly when you want it to work.
  await page.goto("/admin/users");
  const userRow = page.locator('[data-user="advertiser@velto.dev"]');
  await userRow.getByRole("button", { name: /מנוי|אין מנוי/ }).first().click();
  await userRow.locator('input[name="paidThrough"]').fill("2027-01-31");
  await userRow.getByRole("button", { name: "שמירת המנוי" }).first().click();
  await expect(page.getByText("המנוי עודכן.")).toBeVisible();

  await page.goto("/admin/audit");
  await expect(page.getByRole("heading", { name: "יומן פעולות" })).toBeVisible();
  await expect(page.getByText("מנוי עודכן").first()).toBeVisible({ timeout: 10_000 });
  // The actor is named, or the log answers "what happened" without "who".
  await expect(page.getByText("advertiser@velto.dev").first()).toBeVisible();

  // No delete, no edit, no clear. The value of the page is that nothing writes
  // to it but server/audit.ts and nothing at all edits it.
  await expect(page.getByRole("button", { name: /מחיקה|עריכה|ניקוי/ })).toHaveCount(0);
});
