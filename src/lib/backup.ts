/**
 * Shape shared between the backup export, the restore script and the checker.
 *
 * Kept out of src/server/backup.ts because that module is "server-only", which
 * cannot be imported from a plain `tsx` script - and the restore script is
 * exactly that. Verified the hard way: importing the server module from a
 * script fails with "Cannot find module 'server-only'".
 */

/** Bumped if the shape changes, so a restore can refuse a file it cannot read. */
export const BACKUP_FORMAT = 1;

/**
 * Every table in a backup, in foreign-key order: a row is never written before
 * the row it points at exists. Restore walks this list, so adding a table to
 * the export means adding it here too.
 */
export const BACKUP_TABLES = [
  "companies",
  "users",
  "assets",
  "images",
  "blobs",
  "periods",
  "inquiries",
  "inquiryMessages",
  "bookings",
  "savedAssets",
  "notifications",
] as const;

export type BackupTable = (typeof BACKUP_TABLES)[number];

/** JSON has no date type; these come back as strings and must be revived. */
export const BACKUP_TIMESTAMP_FIELDS = [
  "createdAt",
  "updatedAt",
  "expiresAt",
  "lastUsedAt",
  "usedAt",
  "termsAcceptedAt",
  "deletedAt",
  "verifiedAt",
  "respondedAt",
  "decidedAt",
  "readAt",
  "startDate",
  "endDate",
];
