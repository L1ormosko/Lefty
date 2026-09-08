import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import sharp from "sharp";
import { prisma } from "@/server/db";
import { requireUser } from "@/server/auth";
import { loadOwnedAsset } from "@/server/authz";
import { AppError } from "@/server/errors";
import { rateLimit } from "@/server/rate-limit";
import { MAX_STORED_BYTES, imageUrl, storeImage } from "@/server/storage";

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_DIMENSION = 8000;
const MAX_IMAGES_PER_ASSET = 12;
const ALLOWED = new Set(["jpeg", "png", "webp", "avif"]);

/**
 * Image upload.
 *
 * The uploaded bytes are never stored as-is: sharp decodes them and re-encodes
 * to WebP, which both proves the file really is an image and strips any
 * embedded payload or EXIF. The filename is generated server-side, so no user
 * input reaches the filesystem path.
 */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    if (!rateLimit(`upload:${user.id}`, 40, 60 * 60_000).ok) {
      return NextResponse.json({ error: "יותר מדי העלאות. נסו שוב מאוחר יותר." }, { status: 429 });
    }

    const form = await request.formData();
    const assetId = String(form.get("assetId") ?? "");
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "לא נבחר קובץ." }, { status: 400 });
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: "הקובץ גדול מ־8MB." }, { status: 413 });
    }

    const asset = await loadOwnedAsset(assetId, user);
    const existing = await prisma.mediaAssetImage.count({ where: { assetId: asset.id } });
    if (existing >= MAX_IMAGES_PER_ASSET) {
      return NextResponse.json({ error: `ניתן להעלות עד ${MAX_IMAGES_PER_ASSET} תמונות.` }, { status: 400 });
    }

    const input = Buffer.from(await file.arrayBuffer());
    const meta = await sharp(input).metadata();
    if (!meta.format || !ALLOWED.has(meta.format)) {
      return NextResponse.json({ error: "פורמט לא נתמך. יש להעלות JPG, PNG או WebP." }, { status: 400 });
    }
    if ((meta.width ?? 0) > MAX_DIMENSION || (meta.height ?? 0) > MAX_DIMENSION) {
      return NextResponse.json({ error: "מידות התמונה גדולות מדי." }, { status: 400 });
    }

    const output = await sharp(input)
      .rotate()
      .resize({ width: 1920, height: 1920, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });

    if (output.info.size > MAX_STORED_BYTES) {
      return NextResponse.json({ error: "התמונה גדולה מדי לאחסון. נסו תמונה קטנה יותר." }, { status: 413 });
    }

    // The id is minted here so the row can carry its own final url, and both
    // writes go in one transaction: an image row without bytes would render as
    // a broken picture, which is the exact failure this replaces.
    const id = randomUUID();
    const image = await prisma.$transaction(async (tx) => {
      const row = await tx.mediaAssetImage.create({
        data: {
          id,
          assetId: asset.id,
          url: imageUrl(id),
          width: output.info.width,
          height: output.info.height,
          sizeBytes: output.info.size,
          isPrimary: existing === 0,
          sortOrder: existing,
        },
      });
      await storeImage({ imageId: id, data: output.data, tx });
      return row;
    });

    return NextResponse.json({ image });
  } catch (err) {
    if (err instanceof AppError) {
      return NextResponse.json({ error: err.message }, { status: err.httpStatus });
    }
    console.error("[velto] upload failed:", err);
    return NextResponse.json({ error: "העלאת התמונה נכשלה. נסו שוב." }, { status: 500 });
  }
}
