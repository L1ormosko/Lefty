/**
 * Verify a backup file against the live database.
 *
 *   npx tsx prisma/backup-check.ts ./velto-backup-SENSITIVE-2026-10-06.json
 *
 * "I have a file" is not a backup until someone has checked that what is in it
 * matches what is in the database. This is that check, and it is meant to be
 * run against production right after downloading - which is the only way to
 * know the whole route works end to end rather than just locally.
 */
import { readFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
import { BACKUP_FORMAT, BACKUP_TABLES } from "../src/lib/backup";

const prisma = new PrismaClient();

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error("Usage: npx tsx prisma/backup-check.ts <backup.json>");

  const backup = JSON.parse(await readFile(file, "utf8"));
  if (backup.format !== BACKUP_FORMAT) {
    throw new Error(`Backup format ${backup.format} does not match this code (${BACKUP_FORMAT}).`);
  }

  const live: Record<string, number> = {
    companies: await prisma.company.count(),
    users: await prisma.user.count(),
    assets: await prisma.mediaAsset.count(),
    images: await prisma.mediaAssetImage.count(),
    blobs: await prisma.mediaAssetImageBlob.count(),
    periods: await prisma.availabilityPeriod.count(),
    inquiries: await prisma.inquiry.count(),
    inquiryMessages: await prisma.inquiryMessage.count(),
    bookings: await prisma.booking.count(),
    savedAssets: await prisma.savedAsset.count(),
    notifications: await prisma.notification.count(),
  };

  console.log(`Backup taken at ${backup.exportedAt}`);
  console.log(`${"table".padEnd(16)} ${"file".padStart(6)} ${"live".padStart(6)}`);

  let problems = 0;
  for (const table of BACKUP_TABLES) {
    const inFile = backup.data[table]?.length ?? 0;
    const inDb = live[table] ?? 0;
    const ok = inFile === inDb;
    if (!ok) problems++;
    console.log(`${table.padEnd(16)} ${String(inFile).padStart(6)} ${String(inDb).padStart(6)}  ${ok ? "ok" : "MISMATCH"}`);
  }

  // Counts alone can match while the images are empty, which would be a backup
  // that restores a marketplace of blank frames.
  const bytes = (backup.data.blobs ?? []).reduce(
    (sum: number, b: { dataBase64?: string }) => sum + (b.dataBase64?.length ?? 0),
    0
  );
  console.log(`\nImage payload in file: ${Math.round(bytes / 1024)}KB`);
  if ((backup.data.blobs?.length ?? 0) > 0 && bytes === 0) {
    problems++;
    console.log("MISMATCH: blob rows are present but carry no bytes.");
  }

  if (problems > 0) {
    console.log(`\n${problems} problem(s). Do not rely on this file.`);
    process.exitCode = 1;
  } else {
    console.log("\nThe file matches the database.");
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e instanceof Error ? e.message : e);
    await prisma.$disconnect();
    process.exit(1);
  });
