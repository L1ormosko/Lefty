import "server-only";

import { prisma } from "@/server/db";
import { BACKUP_FORMAT } from "@/lib/backup";

/**
 * A full copy of the database, as one JSON object.
 *
 * This exists because of a specific constraint, not as a general feature. The
 * hosting plan's database is deleted on a fixed date and has no backups, and
 * the usual answer - `pg_dump` from a laptop - does not work here: the
 * instance's IP allow-list is empty, so it accepts no external connections at
 * all, and the service's own disk is ephemeral, so dumping to a file inside
 * the container leaves nothing to download. Going out through the app is the
 * one route that works from a browser with no tools installed and no network
 * configuration.
 *
 * What this deliberately does NOT include is Session and PasswordResetToken.
 * Both are transient authentication material: restoring live sessions into a
 * new database would be a security bug rather than a backup, and everyone
 * signing in again after a restore is the correct outcome.
 *
 * It DOES include password hashes, because a restore without them would force
 * a password reset on every user - which makes it not really a backup. They
 * are bcrypt hashes rather than passwords, but the file still deserves to be
 * treated as sensitive; the filename says so.
 *
 * Image bytes are included as base64, which is what makes this a whole backup
 * rather than half of one. The ceiling documented in storage.ts applies here
 * too: at pilot scale this is tens of kilobytes, but the whole object is built
 * in memory, so past roughly a few hundred photographed assets this approach
 * needs replacing with a real pg_dump against a database that permits external
 * connections.
 */

export type Backup = Awaited<ReturnType<typeof exportDatabase>>;

export async function exportDatabase() {
  const [
    companies,
    users,
    assets,
    images,
    blobs,
    periods,
    inquiries,
    inquiryMessages,
    bookings,
    savedAssets,
    notifications,
  ] = await Promise.all([
    prisma.company.findMany(),
    prisma.user.findMany(),
    prisma.mediaAsset.findMany(),
    prisma.mediaAssetImage.findMany(),
    prisma.mediaAssetImageBlob.findMany(),
    prisma.availabilityPeriod.findMany(),
    prisma.inquiry.findMany(),
    prisma.inquiryMessage.findMany(),
    prisma.booking.findMany(),
    prisma.savedAsset.findMany(),
    prisma.notification.findMany(),
  ]);

  return {
    format: BACKUP_FORMAT,
    exportedAt: new Date().toISOString(),
    note:
      "גיבוי מלא של VELTO. הקובץ מכיל נתונים אישיים של כל המשתמשים וגיבוב של " +
      "סיסמאותיהם - יש לשמור אותו במקום מוגן ולא להשאיר אותו בתיקיית הורדות.",
    // Bytes do not survive JSON, so the one binary column is base64.
    data: {
      companies,
      users,
      assets,
      images,
      blobs: blobs.map((b) => ({
        imageId: b.imageId,
        contentType: b.contentType,
        dataBase64: Buffer.from(b.data).toString("base64"),
      })),
      periods,
      inquiries,
      inquiryMessages,
      bookings,
      savedAssets,
      notifications,
    },
  };
}

/** Row counts straight from the database, for comparing a file against it. */
export async function liveCounts(): Promise<Record<string, number>> {
  const [
    companies,
    users,
    assets,
    images,
    blobs,
    periods,
    inquiries,
    inquiryMessages,
    bookings,
    savedAssets,
    notifications,
  ] = await Promise.all([
    prisma.company.count(),
    prisma.user.count(),
    prisma.mediaAsset.count(),
    prisma.mediaAssetImage.count(),
    prisma.mediaAssetImageBlob.count(),
    prisma.availabilityPeriod.count(),
    prisma.inquiry.count(),
    prisma.inquiryMessage.count(),
    prisma.booking.count(),
    prisma.savedAsset.count(),
    prisma.notification.count(),
  ]);
  return {
    companies,
    users,
    assets,
    images,
    blobs,
    periods,
    inquiries,
    inquiryMessages,
    bookings,
    savedAssets,
    notifications,
  };
}
