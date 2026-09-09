import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { DEV_PASSWORD, login, register, uniqueEmail } from "./helpers";

/**
 * An inquiry is a conversation, not a single exchange.
 *
 * Before this, the owner got one `ownerResponse` field and that was the end:
 * the advertiser could not ask a follow-up and the owner could not correct
 * themselves. This walks the round trip both ways through the real interface.
 */
test("both sides can keep talking on an inquiry", async ({ page, browser }) => {
  const advertiserEmail = uniqueEmail("thread-advertiser");
  await register(page, "ADVERTISER", advertiserEmail);

  // Send an inquiry on a seeded asset.
  const prisma = new PrismaClient();
  let assetId: string;
  let ownerEmail: string;
  try {
    const asset = await prisma.mediaAsset.findFirstOrThrow({
      where: { status: "ACTIVE" },
      include: { owner: { select: { email: true } } },
    });
    assetId = asset.id;
    ownerEmail = asset.owner.email;
  } finally {
    await prisma.$disconnect();
  }

  await page.goto(`/assets/${assetId}`);
  const start = new Date();
  start.setDate(start.getDate() + 30);
  const end = new Date();
  end.setDate(end.getDate() + 45);
  await page.locator("#startDate").fill(start.toISOString().slice(0, 10));
  await page.locator("#endDate").fill(end.toISOString().slice(0, 10));
  await page.locator("#campaignName").fill("שיחה על הקמפיין");
  await page.locator("#contactName").fill("בודק אוטומטי");
  await page.locator("#contactEmail").fill(advertiserEmail);
  await page.getByRole("button", { name: /שליחת הבקשה|שליחה/ }).first().click();

  await page.goto("/dashboard/requests");
  await page.getByRole("link", { name: "פתיחת השיחה" }).first().click();
  await page.waitForURL(/\/dashboard\/requests\/[^/]+$/);
  const threadUrl = page.url();

  // The advertiser writes a follow-up.
  await page.locator('textarea[name="body"]').fill("אפשר גם חודשיים?");
  await page.getByRole("button", { name: "שליחת הודעה" }).click();
  await expect(page.getByText("אפשר גם חודשיים?")).toBeVisible();

  // The owner answers, in their own session.
  const ownerContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  await login(ownerPage, ownerEmail, DEV_PASSWORD);
  await ownerPage.goto("/owner/inquiries");
  await ownerPage.getByRole("link", { name: "פתיחת השיחה" }).first().click();
  await ownerPage.waitForURL(/\/owner\/inquiries\/[^/]+$/);
  await expect(ownerPage.getByText("אפשר גם חודשיים?")).toBeVisible();

  await ownerPage.locator('textarea[name="body"]').fill("כן, אפשר. אחזור עם מחיר.");
  await ownerPage.getByRole("button", { name: "שליחת הודעה" }).click();
  await expect(ownerPage.getByText("כן, אפשר. אחזור עם מחיר.")).toBeVisible();
  await ownerContext.close();

  // And the advertiser sees the reply - the second round the old field could
  // not hold.
  await page.goto(threadUrl);
  await expect(page.getByText("אפשר גם חודשיים?")).toBeVisible();
  await expect(page.getByText("כן, אפשר. אחזור עם מחיר.")).toBeVisible();

  // The notification about that reply points at this thread, not at a list the
  // advertiser then has to search through.
  await page.goto("/dashboard/notifications");
  const link = page.locator(`a[href="${new URL(threadUrl).pathname}"]`).first();
  await expect(link).toBeVisible();
});
