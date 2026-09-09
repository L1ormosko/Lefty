import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { cleanup, makeAsset, makeUser, prisma } from "./factories";
import { GET as getImage } from "@/app/api/images/[id]/route";
import { MAX_STORED_BYTES, imageUrl, readImage, storeImage } from "@/server/storage";
import { demoImage } from "../prisma/demo-image";
import { ASSET_TYPES } from "@/lib/constants";

let assetId: string;

/** A real encoded image, so the tests move the same kind of bytes the app does. */
async function webp(): Promise<Buffer> {
  return sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 40, b: 200 } },
  })
    .webp()
    .toBuffer();
}

async function makeImage(): Promise<{ id: string; data: Buffer }> {
  const id = randomUUID();
  const data = await webp();
  await prisma.$transaction(async (tx) => {
    await tx.mediaAssetImage.create({
      data: { id, assetId, url: imageUrl(id), isPrimary: false, sortOrder: 0 },
    });
    await storeImage({ imageId: id, data, tx });
  });
  return { id, data };
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
      await storeImage({ imageId: id, data: await webp(), tx });
    });

    await prisma.mediaAsset.delete({ where: { id: doomed.id } });
    expect(await readImage(id)).toBeNull();
  });

  it("caps a single stored image, because the ceiling here is the database", () => {
    expect(MAX_STORED_BYTES).toBeLessThanOrEqual(2 * 1024 * 1024);
  });
});

describe("image route", () => {
  it("serves the bytes with the stored content type", async () => {
    const { id, data } = await makeImage();
    const res = await getImage(new Request(`http://test/api/images/${id}`), {
      params: Promise.resolve({ id }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(Buffer.compare(Buffer.from(await res.arrayBuffer()), data)).toBe(0);
  });

  it("404s on an unknown id rather than erroring", async () => {
    const id = randomUUID();
    const res = await getImage(new Request(`http://test/api/images/${id}`), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(404);
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
