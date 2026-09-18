import { getCurrentUser } from "@/server/auth";
import { canViewImage } from "@/server/images";
import { readImage } from "@/server/storage";

/**
 * Serve an uploaded image.
 *
 * Holding the id is not permission. This used to be reachable by anyone who
 * knew the URL, inherited from the static `/uploads/<uuid>.webp` path it
 * replaced, and a UUID is an identifier rather than a credential: it appears
 * in server-rendered HTML, in shared links, in browser history and in any
 * proxy log along the way. Two things leaked because of it - the photographs
 * of listings that were never public (a draft, a deactivated listing, one an
 * admin rejected) and the photographs the subscription is supposed to gate.
 *
 * So the decision is made from the asset the image belongs to, in
 * server/images.ts, and this route only serves what that allows.
 *
 * Cache-Control is private for the same reason: a shared cache holding a
 * photograph of a non-public listing would undo the check on the next request.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  const viewer = await getCurrentUser();
  const allowed = await canViewImage(id, viewer);
  if (!allowed) {
    // Deliberately 404 rather than 403: whether an image exists is itself
    // information about a listing that is not public.
    return new Response("Not found", { status: 404 });
  }

  const image = await readImage(id);
  if (!image) {
    return new Response("Not found", { status: 404 });
  }

  return new Response(new Uint8Array(image.data), {
    headers: {
      "Content-Type": image.contentType,
      "Content-Length": String(image.data.byteLength),
      // Bytes are never rewritten under an id - a replaced photo is a new row
      // with a new id - so the browser may hold it as long as it likes. Private
      // because the response depends on who asked.
      "Cache-Control": "private, max-age=31536000, immutable",
      "Content-Disposition": "inline",
      // The answer varies by session cookie; without this any cache that does
      // honour private storage could still serve one user's hit to another.
      Vary: "Cookie",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
