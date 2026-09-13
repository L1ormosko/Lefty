import { expect, test, type Page } from "@playwright/test";
import { openResults } from "./helpers";

const cardsOf = (page: Page) => page.locator("[data-results]:visible [data-asset]");

/** Desktop shows the filter rail inline; mobile hides it behind a dialog. */
async function selectFirstCity(page: Page): Promise<string> {
  const filtersButton = page.getByRole("button", { name: "מסננים" });
  if (await filtersButton.isVisible().catch(() => false)) await filtersButton.click();

  const city = page.locator("#f-city:visible");
  const options = await city.locator("option").allTextContents();
  // Option 0 is the "all cities" placeholder.
  const target = options[1];
  expect(target, "the seeded map should offer at least one city").toBeTruthy();
  await city.selectOption({ label: target });

  const apply = page.getByRole("button", { name: /^הצגת/ });
  if (await apply.isVisible().catch(() => false)) {
    await apply.click();
    await expect(page.getByRole("dialog", { name: "מסננים" })).toBeHidden();
  }
  return target;
}

/**
 * Filtering must never navigate the user off the map.
 *
 * A regression this suite missed once already: Discover wrote its filter state
 * back with a hard-coded `router.replace("/?" + qs)`. After the map moved from
 * "/" to "/explore" that threw the user onto the marketing page the instant
 * they touched any filter - the search still "worked", so nothing failed, the
 * app just quietly ejected them. Assert the pathname, not only the results.
 */
test("filtering narrows the results and keeps the user on the map", async ({ page }) => {
  await page.goto("/explore");
  await openResults(page);
  await expect(cardsOf(page).first()).toBeVisible({ timeout: 20_000 });
  expect(await cardsOf(page).count()).toBeGreaterThan(0);

  const label = await selectFirstCity(page);

  await expect(page).toHaveURL(/\/explore\?.*city=/);

  await openResults(page);
  await expect(cardsOf(page).first()).toBeVisible({ timeout: 20_000 });

  // Every result is in the chosen city.
  //
  // This used to assert "fewer results than before", which is not actually the
  // property under test and fails whenever it happens not to hold: the
  // unfiltered list is bounded by the map viewport, which is centred on the
  // pilot city, so once enough listings exist there the two counts are equal
  // and a correct filter looks broken. The city label carries a count -
  // "באר שבע (10)" - so compare on the name alone.
  const city = label.replace(/\s*\(\d+\)\s*$/, "").trim();
  await expect
    .poll(
      async () => {
        const texts = await cardsOf(page).allInnerTexts();
        return texts.length > 0 && texts.every((t) => t.includes(city));
      },
      { timeout: 10_000 }
    )
    .toBe(true);
});

test("a filtered URL can be reloaded and shared", async ({ page }) => {
  // Filters live in the query string so a result set survives a refresh and can
  // be pasted to a colleague.
  await page.goto("/explore");
  await openResults(page);
  await expect(cardsOf(page).first()).toBeVisible({ timeout: 20_000 });

  await selectFirstCity(page);
  await expect(page).toHaveURL(/city=/);
  const url = page.url();

  await openResults(page);
  await expect(cardsOf(page).first()).toBeVisible({ timeout: 20_000 });
  const filtered = await cardsOf(page).count();

  await page.goto(url);
  await openResults(page);
  await expect(cardsOf(page).first()).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => cardsOf(page).count(), { timeout: 10_000 }).toBe(filtered);
});
