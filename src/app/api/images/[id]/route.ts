import { readImage } from "@/server/storage";

/**
 * Serve an uploaded image.
 *
 * Reachable by id without authentication, which is exactly what the previous
 * `/uploads/<uuid>.webp` static path was: anyone holding the path could fetch
 * the bytes. This route deliberately changes where images are stored and
 * nothing about who may read them - folding an authorization change into a
 * storage change would leave neither properly reviewed. Tightening it (an
 * image of a non-ACTIVE asset should arguably be owner/admin only, the way
 * getPublicAsset already works) is tracked in TODO.md.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const image = await readImage(id);
  if (!image) {
    return new Response("Not found", { status: 404 });
  }

  return new Response(new Uint8Array(image.data), {
    headers: {
      "Content-Type": image.contentType,
      "Content-Length": String(image.data.byteLength),
      // Bytes are never rewritten under an id - a replaced photo is a new row
      // with a new id - so this can be cached as hard as the browser allows.
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Disposition": "inline",
    },
  });
}
