import { expect, test } from "@playwright/test";
import { DEV_PASSWORD, login } from "./helpers";

test("a brief in one sentence becomes a shortlist of real inventory", async ({ page }) => {
  await page.goto("/brief");

  // Nothing asked, nothing guessed.
  await expect(page.getByText("מלאו לפחות פרט אחד").first()).toBeVisible();

  await page.locator("#text").fill("קמפיין בבאר שבע בנובמבר, תקציב 30 אלף, ליד הקניון");
  await page.getByRole("button", { name: "מצא לי שטחים" }).click();

  await expect(page.getByText("שטחים שנמצאו")).toBeVisible();

  // The sentence was understood, and the form now shows it so it can be corrected.
  await expect(page.locator("#budget")).toHaveValue("30000");
  await expect(page.locator("#startDate")).toHaveValue("2026-11-01");
  await expect(page.getByRole("checkbox", { name: "באר שבע" })).toBeChecked();

  // Every result explains itself, and the declared-not-measured line is on the
  // page wherever surroundings are shown - that wording is the product promise.
  await expect(page.getByText("למה הותאם").first()).toBeVisible();
  await expect(page.getByText("לפי הצהרת בעל השטח — לא נמדד").first()).toBeVisible();
});

test("a shortlist can be reloaded and shared", async ({ page }) => {
  await page.goto("/brief");
  await page.locator("#text").fill("שלטים בבאר שבע");
  await page.getByRole("button", { name: "מצא לי שטחים" }).click();
  await expect(page.getByText("שטחים שנמצאו")).toBeVisible();

  const url = page.url();
  expect(url).toContain("/brief?");
  await page.goto(url);
  await expect(page.getByText("שטחים שנמצאו")).toBeVisible();
});

test("a media owner sees which of their contracts end soon", async ({ page }) => {
  await login(page, "owner@velto.dev", DEV_PASSWORD);
  await page.goto("/owner");

  await expect(page.getByRole("heading", { name: "חוזים שמסתיימים" })).toBeVisible();
  // The seed approves a booking that ends inside the horizon, so this is a
  // real row rather than an empty state that would pass by default.
  await expect(page.getByText("מסתיים ב").first()).toBeVisible();
});

test("an owner can declare what is around an asset, and it is never called a measurement", async ({
  page,
}) => {
  await login(page, "owner@velto.dev", DEV_PASSWORD);
  await page.goto("/owner/assets");

  await page.getByRole("link", { name: "עריכה" }).first().click();
  await page.getByRole("button", { name: "מפרט" }).click();

  await expect(page.getByText("מה יש מסביב לשטח")).toBeVisible();
  await expect(page.getByText("VELTO לא מודדת חשיפה")).toBeVisible();
});
