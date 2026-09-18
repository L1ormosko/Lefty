import { expect, test } from "@playwright/test";
import { DEV_PASSWORD, login, openResults, register, uniqueEmail } from "./helpers";

/** Advertiser journey: register → map → filter → asset → request → dashboard. */
test("an advertiser can discover an asset and send a request", async ({ page }) => {
  // Registering grants the free trial, so a brand-new account can browse in
  // full from its first minute - which is the whole point of the trial.
  const email = uniqueEmail("advertiser");
  await register(page, "ADVERTISER", email);

  // The map is the entry point and shows real inventory counts.
  await page.goto("/explore");
  // The live inventory count is visible on both layouts (map chip / sheet header).
  await expect(page.locator("text=/שטחי פרסום/").locator("visible=true").first()).toBeVisible();

  await openResults(page);
  const cards = page.locator("[data-results]:visible [data-asset]");
  await expect(cards.first()).toBeVisible({ timeout: 20_000 });

  // Open an asset from the results and check the honesty signals are present.
  //
  // The card's own title is the link. It used to carry a second row with a
  // "check availability and price" link, which repeated on every card and said
  // what opening the listing does anyway; `data-open` is the stable hook for
  // the title, whose text is the listing's name and so differs per row.
  const firstCard = cards.first();
  await firstCard.locator("[data-open]").click();
  await page.waitForURL(/\/assets\//);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByText(/מאומת|ממתין לאימות/).first()).toBeVisible();

  // Save the asset.
  await page.getByRole("button", { name: /שמירה לרשימה/ }).click();
  await expect(page.getByRole("button", { name: /נשמר/ })).toBeVisible();

  // Submit a request.
  const start = new Date();
  start.setDate(start.getDate() + 30);
  const end = new Date();
  end.setDate(end.getDate() + 60);
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  await page.locator("#startDate").fill(iso(start));
  await page.locator("#endDate").fill(iso(end));
  await page.locator("#campaignName").fill("קמפיין בדיקה");
  await page.getByRole("button", { name: "שליחה" }).click();
  await expect(page.getByText("הבקשה נשלחה לבעל השטח.")).toBeVisible();

  // The request appears in the dashboard, and so does the saved asset.
  await page.goto("/dashboard/requests");
  await expect(page.getByText("קמפיין בדיקה")).toBeVisible();
  await page.goto("/dashboard/saved");
  await expect(page.locator("article").first()).toBeVisible();
});

test("an anonymous visitor sees that inventory exists, but not the detail", async ({ page }) => {
  // The map is no longer open to everyone. It is not shut either: a visitor
  // still sees how much inventory is where, because a marketplace nobody can
  // look into cannot attract the side that pays for it. What they do not get
  // is the exact spot, the price, the free dates or the owner's details.
  await page.goto("/explore");
  await openResults(page);

  const card = page.locator("[data-results]:visible [data-asset]").first();
  await expect(card).toBeVisible({ timeout: 20_000 });

  // The pitch, not a locked door.
  // Scoped to what is on screen: the results list renders for both layouts,
  // so an unscoped .first() can match the hidden desktop copy on a phone.
  await expect(
    page.getByText("פתיחת חשבון והתחלת הניסיון").locator("visible=true").first()
  ).toBeVisible();

  // And nothing saleable reached the browser at all - not hidden with CSS,
  // absent from the response.
  const payload = await page.evaluate(async () => {
    const res = await fetch("/api/assets?limit=50");
    return res.text();
  });
  expect(payload).toContain('"restricted":true');
  expect(payload).not.toMatch(/"priceMonthly":\d/);
  expect(payload).not.toMatch(/"address":"[^"]+"/);
});

test("an anonymous visitor opening a listing is offered the trial", async ({ page }) => {
  await page.goto("/explore");
  await openResults(page);
  const card = page.locator("[data-results]:visible [data-asset]").first();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.locator("[data-open]").click();
  await page.waitForURL(/\/assets\//);
  await expect(page.getByRole("heading", { name: "הדף הזה נפתח עם חשבון" })).toBeVisible();
});

test("an advertiser cannot reach the media owner area", async ({ page }) => {
  await login(page, "advertiser@velto.dev", DEV_PASSWORD);
  await page.goto("/owner");
  await expect(page).toHaveURL(/\/dashboard/);
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/dashboard/);
});
