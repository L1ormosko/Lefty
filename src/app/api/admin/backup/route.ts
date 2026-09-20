import { requireRole } from "@/server/auth";
import { exportDatabase } from "@/server/backup";
import { rateLimit } from "@/server/rate-limit";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { bearerToken, tokenAuthConfigured, tokenMatches } from "@/lib/backup-token";

/**
 * Download a full database backup.
 *
 * This returns every user's personal data and every password hash in one
 * file. That is the whole security story, and there are exactly two ways in:
 *
 *   1. **An admin session.** A person, signed in, clicking the button on
 *      /admin.
 *   2. **A bearer token**, for the scheduled job. The hosting plan deletes
 *      this database on a fixed date and takes no backups of its own, and the
 *      instance accepts no external connections at all - its IP allow-list is
 *      empty - so `pg_dump` from a scheduler is not available. Going out
 *      through the application over HTTPS is the one route that works, which
 *      means the scheduler needs a credential that is not a browser session.
 *
 * The token path is off unless VELTO_BACKUP_TOKEN is set to something at
 * least 32 characters long. An unset or too-short variable means the door is
 * shut, not open - see lib/backup-token.ts, where that decision and its tests
 * live.
 *
 * Both paths are rate limited and both are written to the audit log, because
 * a full dump of everyone's personal data leaving the building is the single
 * most consequential thing this application can do, whoever asked for it.
 */
export async function GET(request: Request) {
  const configured = process.env.VELTO_BACKUP_TOKEN;
  const presented = bearerToken(request.headers.get("authorization"));

  // Identify the caller first, and refuse before touching the database.
  let actorId: string | null = null;
  let how: "session" | "token";

  if (presented) {
    if (!tokenMatches(presented, configured)) {
      // Deliberately the same response for "wrong token" and "this deployment
      // has no token configured": a caller learns nothing from us about
      // whether the door exists. The distinction goes to the server log only.
      if (!tokenAuthConfigured(configured)) {
        console.error(
          "[velto] backup: a bearer token was presented but VELTO_BACKUP_TOKEN is unset or too short. " +
            "The scheduled backup is NOT running."
        );
      } else {
        console.error("[velto] backup: bearer token rejected.");
      }
      return new Response("Unauthorized", { status: 401 });
    }
    // One shared credential, so the limit is on the credential rather than on
    // a user. A daily job needs one call; this leaves room for a retry.
    if (!rateLimit("backup:token", 6, 60 * 60_000).ok) {
      return new Response("Too many backup requests", { status: 429 });
    }
    how = "token";
  } else {
    // Unchanged from before the token path existed, down to the status code:
    // requireRole throws ForbiddenError, which is answered as 403 below.
    try {
      const admin = await requireRole("ADMIN");
      if (!rateLimit(`backup:${admin.id}`, 5, 60 * 60_000).ok) {
        return new Response("Too many backup requests", { status: 429 });
      }
      actorId = admin.id;
    } catch (err) {
      if (err instanceof AppError) return new Response(err.message, { status: err.httpStatus });
      console.error("[velto] backup auth failed:", err);
      return new Response("backup failed", { status: 500 });
    }
    how = "session";
  }

  let payload;
  try {
    payload = await exportDatabase();
  } catch (err) {
    console.error("[velto] backup failed:", err);
    return new Response("backup failed", { status: 500 });
  }

  // actorId is null for the scheduled job - there is no user behind it, and
  // inventing one would make the log lie about who acted. The summary says
  // which door was used.
  await recordAudit({
    actorId,
    action: "BACKUP_DOWNLOADED",
    targetType: "Database",
    targetId: "backup",
    summary: how === "token" ? "scheduled backup (token)" : "manual download (admin)",
  });

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
