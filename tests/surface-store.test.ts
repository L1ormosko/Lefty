import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectAndStore } from "@/server/surface";
import { storeImage, imageKey, storage } from "@/server/storage";
import { cleanup, makeAsset, makeUser, prisma } from "./factories";

/**
 * What detection writes, and what it refuses to write.
 *
 * tests/surface-detect.test.ts covers the conversation with the model. This
 * one covers the part that touches the database, because that is where the
 * two rules with teeth live: an admin's marking is never overwritten, and a
 * photograph that has been looked at is recorded as looked at even when
 * nothing was found.
 *
 * The model itself is mocked. A real call needs ANTHROPIC_API_KEY, which this
 * environment does not have, and a test that silently skipped without one
 * would be a green tick meaning nothing.
 */

const square = [
  { x: 0.2, y: 0.3 },
  { x: 0.8, y: 0.3 },
  { x: 0.8, y: 0.6 },
  { x: 0.2, y: 0.6 },
];

const reply = (payload: object) =>
  new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(payload) }] }), {
    status: 200,
  }) as never;

let savedKey: string | undefined;

/** A row with real bytes behind it, since detection reads them back. */
async function makeImage(assetId: string) {
  const id = `img-${Math.random().toString(36).slice(2, 10)}`;
  await prisma.mediaAssetImage.create({
    data: {
      id,
      assetId,
      url: `/api/images/${id}`,
      storageKey: imageKey(assetId, id),
      storageProvider: storage.name,
    },
  });
  await storeImage({ assetId, imageId: id, data: Buffer.from([1, 2, 3, 4]) });
  return id;
}

beforeEach(async () => {
  await cleanup();
  savedKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-test";
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
  vi.restoreAllMocks();
});

afterAll(async () => {
  await cleanup();
});

describe("storing what was found", () => {
  it("records the face, its source and its confidence", async () => {
    const owner = await makeUser("MEDIA_OWNER");
    const asset = await makeAsset(owner.id, { widthCm: 900, heightCm: 300 });
    const imageId = await makeImage(asset.id);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      reply({ found: true, confidence: 0.94, corners: square })
    );

    expect((await detectAndStore(imageId)).status).toBe("found");

    const row = await prisma.mediaAssetImage.findUniqueOrThrow({ where: { id: imageId } });
    expect(row.surfaceSource).toBe("ai");
    expect(row.surfaceConfidence).toBeCloseTo(0.94, 5);
    expect(row.surfaceQuad).toHaveLength(4);
    expect(row.surfaceCheckedAt).not.toBeNull();
  });

  it("stores an unsure detection too, because a person can fix it", async () => {
    const owner = await makeUser("MEDIA_OWNER");
    const asset = await makeAsset(owner.id);
    const imageId = await makeImage(asset.id);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      reply({ found: true, confidence: 0.3, corners: square })
    );

    await detectAndStore(imageId);

    // Stored, and the listing page will not show it - the threshold lives in
    // lib/surface-confidence.ts, not in what reaches the table. Throwing it
    // away here would mean an admin never sees the near miss they could
    // correct in two clicks.
    const row = await prisma.mediaAssetImage.findUniqueOrThrow({ where: { id: imageId } });
    expect(row.surfaceQuad).not.toBeNull();
    expect(row.surfaceConfidence).toBeCloseTo(0.3, 5);
  });

  it("refuses to store four points that are not a face", async () => {
    const owner = await makeUser("MEDIA_OWNER");
    const asset = await makeAsset(owner.id);
    const imageId = await makeImage(asset.id);
    // Corners out of order: a bow tie, which folds artwork through itself.
    const bowtie = [square[0], square[1], square[3], square[2]];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      reply({ found: true, confidence: 0.99, corners: bowtie })
    );

    await detectAndStore(imageId);

    const row = await prisma.mediaAssetImage.findUniqueOrThrow({ where: { id: imageId } });
    // Nothing to show and nothing for a human to confirm, so it is not put in
    // front of one - but the photo is marked as checked, so nothing retries it.
    expect(row.surfaceQuad).toBeNull();
    expect(row.surfaceCheckedAt).not.toBeNull();
  });

  it("marks a photo with no face as checked, not as untouched", async () => {
    const owner = await makeUser("MEDIA_OWNER");
    const asset = await makeAsset(owner.id);
    const imageId = await makeImage(asset.id);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      reply({ found: false, confidence: null, corners: null })
    );

    expect((await detectAndStore(imageId)).status).toBe("none");

    const row = await prisma.mediaAssetImage.findUniqueOrThrow({ where: { id: imageId } });
    expect(row.surfaceQuad).toBeNull();
    // The difference between "nobody has looked" and "we looked and there is
    // nothing here". Without it the backfill asks the same question forever.
    expect(row.surfaceCheckedAt).not.toBeNull();
  });
});

describe("what it will not touch", () => {
  it("leaves an admin's marking exactly where they put it", async () => {
    const owner = await makeUser("MEDIA_OWNER");
    const asset = await makeAsset(owner.id);
    const imageId = await makeImage(asset.id);
    const byHand = [
      { x: 0.11, y: 0.11 },
      { x: 0.42, y: 0.11 },
      { x: 0.42, y: 0.33 },
      { x: 0.11, y: 0.33 },
    ];
    await prisma.mediaAssetImage.update({
      where: { id: imageId },
      data: { surfaceQuad: byHand, surfaceSource: "admin" },
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect((await detectAndStore(imageId)).status).toBe("skipped");

    // Not merely unchanged - never asked about. Silently reverting a
    // correction somebody made by hand is the worst thing this could do, and
    // paying a model to do it would add insult.
    expect(fetchSpy).not.toHaveBeenCalled();
    const row = await prisma.mediaAssetImage.findUniqueOrThrow({ where: { id: imageId } });
    expect(row.surfaceQuad).toEqual(byHand);
  });

  it("does nothing at all without a key", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const owner = await makeUser("MEDIA_OWNER");
    const asset = await makeAsset(owner.id);
    const imageId = await makeImage(asset.id);

    expect((await detectAndStore(imageId)).status).toBe("skipped");

    // Including not marking the photo as checked: it has not been. A photo
    // recorded as checked while detection was switched off would never be
    // looked at once a key is configured.
    const row = await prisma.mediaAssetImage.findUniqueOrThrow({ where: { id: imageId } });
    expect(row.surfaceCheckedAt).toBeNull();
  });

  it("does not fall over on an image that is gone", async () => {
    expect((await detectAndStore("no-such-image")).status).toBe("skipped");
  });
});
