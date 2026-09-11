/**
 * Restore a backup produced by /api/admin/backup into an empty database.
 *
 *   npx tsx prisma/restore.ts ./velto-backup-SENSITIVE-2026-10-06.json
 *
 * Without this the export is a file nobody can use, which is not a backup.
 *
 * Rows are written in dependency order and the whole thing runs in one
 * transaction, so a restore either completes or leaves the database as it
 * found it - a half-restored database is worse than an empty one, because it
 * looks like it worked.
 */
import { readFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
import { BACKUP_FORMAT, BACKUP_TIMESTAMP_FIELDS, BACKUP_TABLES } from "../src/lib/backup";

const prisma = new PrismaClient();

/**
 * JSON has no date type, so timestamps come back as strings and Prisma needs
 * real Date objects. The rows are parsed JSON and genuinely untyped at this
 * point - Prisma validates the shape when it writes them.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function reviveDates(rows: any[], fields: string[]): any[] {
  return rows.map((row) => {
    const copy = { ...row };
    for (const field of fields) {
      if (typeof copy[field] === "string") copy[field] = new Date(copy[field]);
    }
    return copy;
  });
}

const TIMESTAMPS = BACKUP_TIMESTAMP_FIELDS;

/** Counted here rather than via the server-only module, which tsx cannot load. */
async function restoredCounts(): Promise<Record<string, number>> {
  const [companies, users, assets, images, blobs, periods, inquiries, inquiryMessages, bookings, savedAssets, notifications] =
    await Promise.all([
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
  return { companies, users, assets, images, blobs, periods, inquiries, inquiryMessages, bookings, savedAssets, notifications };
}

async function main() {
  const file = process.argv[2];
  const force = process.argv.includes("--force");
  if (!file) {
    throw new Error("Usage: npx tsx prisma/restore.ts <backup.json> [--force]");
  }

  const backup = JSON.parse(await readFile(file, "utf8"));
  if (backup.format !== BACKUP_FORMAT) {
    throw new Error(
      `Backup format ${backup.format} does not match this code (${BACKUP_FORMAT}). ` +
        "Restore it with the version of the app that produced it."
    );
  }
  console.log(`Restoring backup taken at ${backup.exportedAt}`);

  // Merging a backup into a populated database produces silent duplicates and
  // orphans. Refuse by default; --force is for someone who has decided.
  const existingUsers = await prisma.user.count();
  if (existingUsers > 0 && !force) {
    throw new Error(
      `The target database already has ${existingUsers} user(s). Restore is meant for an ` +
        "empty database. Re-run with --force only if you are certain."
    );
  }

  const d = backup.data;

  await prisma.$transaction(async (tx) => {
    // Order follows the foreign keys: a row is never written before the row it
    // points at exists.
    await tx.company.createMany({ data: reviveDates(d.companies, TIMESTAMPS), skipDuplicates: true });
    await tx.user.createMany({ data: reviveDates(d.users, TIMESTAMPS), skipDuplicates: true });
    await tx.mediaAsset.createMany({ data: reviveDates(d.assets, TIMESTAMPS), skipDuplicates: true });
    await tx.mediaAssetImage.createMany({ data: reviveDates(d.images, TIMESTAMPS), skipDuplicates: true });
    await tx.mediaAssetImageBlob.createMany({
      data: d.blobs.map((b: { imageId: string; contentType: string; dataBase64: string }) => ({
        imageId: b.imageId,
        contentType: b.contentType,
        data: new Uint8Array(Buffer.from(b.dataBase64, "base64")),
      })),
      skipDuplicates: true,
    });
    await tx.availabilityPeriod.createMany({ data: reviveDates(d.periods, TIMESTAMPS), skipDuplicates: true });
    await tx.inquiry.createMany({ data: reviveDates(d.inquiries, TIMESTAMPS), skipDuplicates: true });
    await tx.inquiryMessage.createMany({
      data: reviveDates(d.inquiryMessages, TIMESTAMPS),
      skipDuplicates: true,
    });
    await tx.booking.createMany({ data: reviveDates(d.bookings, TIMESTAMPS), skipDuplicates: true });
    await tx.savedAsset.createMany({ data: reviveDates(d.savedAssets, TIMESTAMPS), skipDuplicates: true });
    await tx.notification.createMany({
      data: reviveDates(d.notifications, TIMESTAMPS),
      skipDuplicates: true,
    });
  });

  const after = await restoredCounts();
  console.log("\nRestored (database row counts):");
  let mismatch = false;
  // Walk the shared table list, so a table added to the export but forgotten
  // here shows up as a missing line rather than passing silently.
  for (const table of BACKUP_TABLES) {
    const count = after[table];
    const expected = d[table]?.length ?? 0;
    const flag = count === expected ? "ok" : `MISMATCH expected ${expected}`;
    if (count !== expected) mismatch = true;
    console.log(`  ${table.padEnd(16)} ${String(count).padStart(5)}  ${flag}`);
  }
  console.log(
    mismatch
      ? "\nSome tables do not match the file. Investigate before relying on this."
      : "\nEvery table matches the backup file."
  );
  // Nobody is signed in after a restore: sessions are deliberately not backed
  // up, which is the correct outcome rather than an omission.
  console.log("Sessions were not restored - everyone signs in again, by design.");
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e instanceof Error ? e.message : e);
    await prisma.$disconnect();
    process.exit(1);
  });
