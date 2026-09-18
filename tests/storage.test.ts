import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { cleanup, makeAsset, makeUser, prisma } from "./factories";
import { MAX_STORED_BYTES, imageUrl, readImage, storeImage } from "@/server/storage";
import { canViewImage } from "@/server/images";
import { demoImage } from "../prisma/demo-image";
import { ASSET_TYPES } from "@/lib/constants";
import { addDays, todayUtc } from "@/lib/dates";

let assetId: string;

/** A real encoded image, so the tests move the same kind of bytes the app does. */
async function webp(): Promise<Buffer> {
  return sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 40, b: 200 } },
  })
    .webp()
    .toBuffer();
}

async function makeImage(onAsset: string = assetId): Promise<{ id: string; data: Buffer }> {
  const id = randomUUID();
  const data = await webp();
  await prisma.$transaction(async (tx) => {
    await tx.mediaAssetImage.create({
      data: { id, assetId: onAsset, url: imageUrl(id), isPrimary: false, sortOrder: 0 },
    });
    await storeImage({ assetId: onAsset, imageId: id, data, tx });
  });
  return { id, data };
}

/** A paid-up subscription, so "has access" is not confused with "is signed in". */
async function grantAccess(userId: string) {
  await prisma.subscription.upsert({
    where: { userId },
    create: { userId, paidThrough: addDays(todayUtc(), 30) },
    update: { paidThrough: addDays(todayUtc(), 30) },
  });
}

beforeAll(async () => {
  await cleanup();
  const owner = await makeUser("MEDIA_OWNER");
  assetId = (await makeAsset(owner.id)).id;
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("image storage", () => {
  it("round-trips the exact bytes it was given", async () => {
    const { id, data } = await makeImage();
    const stored = await readImage(id);
    expect(stored).not.toBeNull();
    expect(stored!.contentType).toBe("image/webp");
    // Byte-for-byte: a storage layer that quietly re-encodes would corrupt
    // images in ways only a human looking at the page would notice.
    expect(Buffer.compare(stored!.data, data)).toBe(0);
  });

  it("returns null for an id that was never stored", async () => {
    expect(await readImage(randomUUID())).toBeNull();
  });

  it("disposes of the bytes when the image row is deleted", async () => {
    // The disk implementation needed a companion unlink and the delete action
    // did not have one, so every deleted photo leaked a file forever. The
    // cascade is what makes that unrepresentable - assert it, or the next
    // storage change can quietly reintroduce the leak.
    const { id } = await makeImage();
    await prisma.mediaAssetImage.delete({ where: { id } });
    expect(await readImage(id)).toBeNull();
    expect(await prisma.mediaAssetImageBlob.count({ where: { imageId: id } })).toBe(0);
  });

  it("disposes of the bytes when the whole asset is deleted", async () => {
    const owner = await makeUser("MEDIA_OWNER");
    const doomed = await makeAsset(owner.id);
    const id = randomUUID();
    await prisma.$transaction(async (tx) => {
      await tx.mediaAssetImage.create({
        data: { id, assetId: doomed.id, url: imageUrl(id), isPrimary: true, sortOrder: 0 },
      });
      await storeImage({ assetId: doomed.id, imageId: id, data: await webp(), tx });
    });

    await prisma.mediaAsset.delete({ where: { id: doomed.id } });
    expect(await readImage(id)).toBeNull();
  });

  it("caps a single stored image, because the ceiling here is the database", () => {
    expect(MAX_STORED_BYTES).toBeLessThanOrEqual(2 * 1024 * 1024);
  });
});

/**
 * Who may see a photograph.
 *
 * Tested here rather than through the route because the route reads a session
 * cookie, and a test that stubs Next's request scope would be asserting on the
 * stub. canViewImage is where the decision actually lives.
 *
 * The rule being pinned: holding the id is not permission. Images used to be
 * served to anyone who knew the URL, which leaked the photographs of listings
 * that were never public and the photographs the subscription gates.
 */
describe("image authorization", () => {
  it("lets the owner see their own listing's photo whatever its status", async () => {
    const owner = await makeUser("MEDIA_OWNER");
    const draft = await makeAsset(owner.id, { status: "DRAFT" });
    const { id } = await makeImage(draft.id);

    expect(await canViewImage(id, { id: owner.id, role: "MEDIA_OWNER" })).toBe(true);
  });

  it("refuses everyone else a photo of a listing that is not public", async () => {
    const owner = await makeUser("MEDIA_OWNER");
    const stranger = await makeUser("ADVERTISER");
    await grantAccess(stranger.id);
    const hidden = await makeAsset(owner.id, { status: "INACTIVE" });
    const { id } = await makeImage(hidden.id);

    // Even a paying advertiser: a listing taken off the map takes its
    // photographs with it.
    expect(await canViewImage(id, { id: stranger.id, role: "ADVERTISER" })).toBe(false);
    expect(await canViewImage(id, null)).toBe(false);
  });

  it("treats a public listing's photo as part of what the subscription buys", async () => {
    const owner = await makeUser("MEDIA_OWNER");
    const live = await makeAsset(owner.id, { status: "ACTIVE" });
    const { id } = await makeImage(live.id);

    const paying = await makeUser("ADVERTISER");
    await grantAccess(paying.id);
    const lapsed = await makeUser("ADVERTISER");

    expect(await canViewImage(id, { id: paying.id, role: "ADVERTISER" })).toBe(true);
    expect(await canViewImage(id, { id: lapsed.id, role: "ADVERTISER" })).toBe(false);
    expect(await canViewImage(id, null)).toBe(false);
  });

  it("lets an admin see everything - a verifier who cannot see the photo is useless", async () => {
    const owner = await makeUser("MEDIA_OWNER");
    const draft = await makeAsset(owner.id, { status: "DRAFT" });
    const { id } = await makeImage(draft.id);
    const admin = await makeUser("ADMIN");

    expect(await canViewImage(id, { id: admin.id, role: "ADMIN" })).toBe(true);
  });

  it("says no to an id that does not exist, without leaking that it does not", async () => {
    expect(await canViewImage(randomUUID(), null)).toBe(false);
  });
});

describe("demo placeholder images", () => {
  it("produces a real WebP for every asset type", async () => {
    // Every type must render: a missing entry in the shape table would
    // otherwise ship a broken or blank picture for that category only, and
    // nobody would notice until a listing of that type appeared.
    for (const assetType of ASSET_TYPES) {
      const buf = await demoImage({ assetType, label: "בדיקה" });
      const meta = await sharp(buf).metadata();
      expect(meta.format, assetType).toBe("webp");
      expect(meta.width, assetType).toBe(1200);
      expect(meta.height, assetType).toBe(675);
      // Small enough that 16 of them are a rounding error against the DB
      // budget documented in storage.ts.
      expect(buf.length, assetType).toBeLessThan(100 * 1024);
    }
  });

  it("survives a title long enough to overflow the plate", async () => {
    const buf = await demoImage({ assetType: "BILLBOARD", label: "כותרת ארוכה מאוד ".repeat(20) });
    expect((await sharp(buf).metadata()).format).toBe("webp");
  });

  it("does not put a picture on an asset that has none", async () => {
    // The honesty rule the placeholder must not break: only demo rows get one.
    // A real listing with no photo still shows the empty state rather than a
    // generated stand-in that could pass for a picture of the site.
    const owner = await makeUser("MEDIA_OWNER");
    const real = await makeAsset(owner.id, { isDemo: false });
    expect(await prisma.mediaAssetImage.count({ where: { assetId: real.id } })).toBe(0);
  });
});
