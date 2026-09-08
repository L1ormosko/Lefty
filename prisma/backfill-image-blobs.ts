/**
 * One-time backfill: move images that still live on local disk into the
 * database, and clear out the rows whose files are already gone.
 *
 * Run once per environment after deploying the storage change:
 *
 *   UPLOAD_DIR=public/uploads npx tsx prisma/backfill-image-blobs.ts
 *
 * Deliberately not part of the build command. It mutates data, it only ever
 * needs to run once, and a build step that silently deletes rows on every
 * deploy is precisely the class of thing this whole change is fixing.
 *
 * On a host with an ephemeral filesystem the files are already lost, so there
 * is nothing to recover and this mostly deletes dead rows. That is the honest
 * outcome: the photos are gone either way, and a row pointing at a 404 is
 * worse than no row, because the asset page renders a broken image instead of
 * its "no photo" state.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const uploadDir = path.join(process.cwd(), process.env.UPLOAD_DIR || "public/uploads");

  const pending = await prisma.mediaAssetImage.findMany({
    where: { blob: { is: null } },
    select: { id: true, url: true, assetId: true, isPrimary: true },
    orderBy: { createdAt: "asc" },
  });

  if (pending.length === 0) {
    console.log("[backfill] nothing to do - every image already has its bytes in the database.");
    return;
  }

  console.log(`[backfill] ${pending.length} image row(s) without bytes. Looking in ${uploadDir}`);

  let recovered = 0;
  const lostAssetIds = new Set<string>();

  for (const image of pending) {
    // Only ever the basename: url is our own generated value, but reading a
    // file from disk using a stored string deserves the guard regardless.
    const filename = path.basename(image.url);
    let data: Buffer | null = null;
    try {
      data = await readFile(path.join(uploadDir, filename));
    } catch {
      data = null;
    }

    if (data) {
      await prisma.$transaction([
        prisma.mediaAssetImageBlob.create({
          data: { imageId: image.id, data: new Uint8Array(data), contentType: "image/webp" },
        }),
        prisma.mediaAssetImage.update({
          where: { id: image.id },
          data: { url: `/api/images/${image.id}` },
        }),
      ]);
      recovered += 1;
      continue;
    }

    // The file is gone. Drop the row, and hand primary to the next image the
    // same way deleteAssetImageAction does, so an asset never ends up with
    // photos but no primary one.
    await prisma.mediaAssetImage.delete({ where: { id: image.id } });
    if (image.isPrimary) {
      const next = await prisma.mediaAssetImage.findFirst({
        where: { assetId: image.assetId },
        orderBy: { sortOrder: "asc" },
      });
      if (next) {
        await prisma.mediaAssetImage.update({ where: { id: next.id }, data: { isPrimary: true } });
      }
    }
    lostAssetIds.add(image.assetId);
  }

  console.log(`[backfill] recovered ${recovered}, removed ${pending.length - recovered} dead row(s).`);

  if (lostAssetIds.size === 0) return;

  // Name the assets that are now photoless, so someone can decide what to do
  // about them. Publishing requires a photo, but that check runs at publish
  // time, so these stay ACTIVE and simply show the "no photo" state.
  const stranded = await prisma.mediaAsset.findMany({
    where: { id: { in: [...lostAssetIds] }, images: { none: {} } },
    select: { id: true, title: true, status: true },
  });
  if (stranded.length) {
    console.log(`[backfill] ${stranded.length} asset(s) now have no photo at all:`);
    for (const a of stranded) console.log(`  - ${a.id}  [${a.status}]  ${a.title}`);
  }
}

main()
  .catch((err) => {
    console.error("[backfill] failed:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
