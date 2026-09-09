import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_TAG, cleanup, makeAsset, makeUser, prisma } from "./factories";
import { loadThread, postInquiryMessage } from "@/server/inquiries";
import { addDays, todayUtc } from "@/lib/dates";

async function conversation() {
  const owner = await makeUser("MEDIA_OWNER");
  const advertiser = await makeUser("ADVERTISER");
  const asset = await makeAsset(owner.id);
  const inquiry = await prisma.inquiry.create({
    data: {
      assetId: asset.id,
      advertiserId: advertiser.id,
      startDate: todayUtc(),
      endDate: addDays(todayUtc(), 14),
      campaignName: `${TEST_TAG} קמפיין`,
      contactName: "איש קשר",
      contactEmail: advertiser.email,
    },
  });
  return { owner, advertiser, asset, inquiry };
}

beforeEach(async () => {
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("inquiry threads", () => {
  it("carries a conversation past the single answer it used to allow", async () => {
    // The whole point: owner replies, advertiser follows up, owner answers
    // again. The old ownerResponse column could hold only the first of these.
    const { owner, advertiser, inquiry } = await conversation();

    await postInquiryMessage({ inquiryId: inquiry.id, authorId: owner.id, body: "פנוי, 4,000 ₪ לחודש." });
    await postInquiryMessage({ inquiryId: inquiry.id, authorId: advertiser.id, body: "אפשר גם שבועיים?" });
    await postInquiryMessage({ inquiryId: inquiry.id, authorId: owner.id, body: "כן, 2,200 ₪." });

    const thread = await loadThread(inquiry.id);
    expect(thread).toHaveLength(3);
    expect(thread.map((m) => m.author.role)).toEqual(["MEDIA_OWNER", "ADVERTISER", "MEDIA_OWNER"]);
    // Oldest first, so the page reads top to bottom.
    expect(thread[0].createdAt.getTime()).toBeLessThanOrEqual(thread[2].createdAt.getTime());
  });

  it("marks the inquiry responded when the owner answers, not when the advertiser writes", async () => {
    const { owner, advertiser, inquiry } = await conversation();

    await postInquiryMessage({ inquiryId: inquiry.id, authorId: advertiser.id, body: "עדכון קטן לבקשה." });
    expect((await prisma.inquiry.findUniqueOrThrow({ where: { id: inquiry.id } })).status).toBe("PENDING");

    await postInquiryMessage({ inquiryId: inquiry.id, authorId: owner.id, body: "מטפל בזה." });
    const after = await prisma.inquiry.findUniqueOrThrow({ where: { id: inquiry.id } });
    expect(after.status).toBe("RESPONDED");
    expect(after.respondedAt).not.toBeNull();
  });

  it("notifies the other side and links straight to the thread", async () => {
    // The old notification pointed at a list the recipient then had to search.
    const { owner, advertiser, inquiry } = await conversation();
    await postInquiryMessage({ inquiryId: inquiry.id, authorId: owner.id, body: "יש זמינות." });

    const toAdvertiser = await prisma.notification.findFirst({
      where: { userId: advertiser.id },
      orderBy: { createdAt: "desc" },
    });
    expect(toAdvertiser?.linkUrl).toBe(`/dashboard/requests/${inquiry.id}`);

    await postInquiryMessage({ inquiryId: inquiry.id, authorId: advertiser.id, body: "מעולה, נתקדם." });
    const toOwner = await prisma.notification.findFirst({
      where: { userId: owner.id },
      orderBy: { createdAt: "desc" },
    });
    expect(toOwner?.linkUrl).toBe(`/owner/inquiries/${inquiry.id}`);
  });

  it("never notifies the author of their own message", async () => {
    const { owner, inquiry } = await conversation();
    await postInquiryMessage({ inquiryId: inquiry.id, authorId: owner.id, body: "הודעה." });
    expect(await prisma.notification.count({ where: { userId: owner.id } })).toBe(0);
  });

  it("refuses to add to a closed inquiry", async () => {
    const { owner, inquiry } = await conversation();
    await prisma.inquiry.update({ where: { id: inquiry.id }, data: { status: "CLOSED" } });
    await expect(
      postInquiryMessage({ inquiryId: inquiry.id, authorId: owner.id, body: "מאוחר מדי." })
    ).rejects.toThrow();
  });

  it("disposes of the thread when the inquiry goes", async () => {
    const { owner, inquiry } = await conversation();
    await postInquiryMessage({ inquiryId: inquiry.id, authorId: owner.id, body: "הודעה." });
    await prisma.inquiry.delete({ where: { id: inquiry.id } });
    expect(await prisma.inquiryMessage.count({ where: { inquiryId: inquiry.id } })).toBe(0);
  });
});
