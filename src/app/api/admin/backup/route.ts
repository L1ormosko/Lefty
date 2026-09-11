import { requireRole } from "@/server/auth";
import { exportDatabase } from "@/server/backup";
import { rateLimit } from "@/server/rate-limit";
import { AppError } from "@/server/errors";

/**
 * Download a full database backup.
 *
 * Admin-only, and that is the whole security story: this returns every user's
 * personal data and password hash in one file. requireRole throws for anyone
 * else, and the rate limit is deliberately tight - nobody needs this more than
 * a few times an hour, and a leaked admin session should not be able to pull
 * the database repeatedly.
 */
export async function GET() {
  let payload;
  try {
    const admin = await requireRole("ADMIN");
    if (!rateLimit(`backup:${admin.id}`, 5, 60 * 60_000).ok) {
      return new Response("Too many backup requests", { status: 429 });
    }
    payload = await exportDatabase();
  } catch (err) {
    if (err instanceof AppError) return new Response(err.message, { status: err.httpStatus });
    console.error("[velto] backup failed:", err);
    return new Response("backup failed", { status: 500 });
  }

  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(JSON.stringify(payload), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // SENSITIVE in the name so the file is not mistaken for something
      // harmless once it is sitting in a downloads folder.
      "Content-Disposition": `attachment; filename="velto-backup-SENSITIVE-${stamp}.json"`,
      "Cache-Control": "no-store, private",
    },
  });
}
