import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { cleanup, makeAsset, makeUser, prisma } from "./factories";
import { BACKUP_TABLES } from "@/lib/backup";
import { resetRateLimit } from "@/server/rate-limit";
import { ForbiddenError } from "@/server/errors";

/**
 * The backup exists because the hosting plan's database is deleted on a fixed
 * date and has no backups. All three properties below were verified by hand
 * once; without a test they break silently, and a backup that is quietly wrong
 * is worse than none, because nobody finds out until they need it.
 */

/** requireRole reads cookies(), which has no request scope under Vitest. */
const requireRoleMock = vi.hoisted(() => vi.fn());
vi.mock("@/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth")>()),
  requireRole: requireRoleMock,
}));

// Imported after the mock is declared, so the route picks up the stub.
const { GET: getBackup } = await import("@/app/api/admin/backup/route");
const { exportDatabase } = await import("@/server/backup");
const { imageUrl, storeImage } = await import("@/server/storage");

let admin: { id: string; email: string; role: string };
let advertiser: { id: string; email: string; role: string };
let imageBytes: Buffer;
let imageId: string;

beforeAll(async () => {
  await cleanup();
  admin = await makeUser("ADMIN");
  advertiser = await makeUser("ADVERTISER");

  const asset = await makeAsset((await makeUser("MEDIA_OWNER")).id);
  imageId = randomUUID();
  imageBytes = await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 40, b: 200 } },
  })
    .webp()
    .toBuffer();
  await prisma.$transaction(async (tx) => {
    await tx.mediaAssetImage.create({
      data: { id: imageId, assetId: asset.id, url: imageUrl(imageId), isPrimary: true, sortOrder: 0 },
    });
    await storeImage({ imageId, data: imageBytes, tx });
  });

  // A live session, so "sessions are excluded" is asserted against a database
  // that actually has one rather than against an empty table.
  await prisma.session.create({
    data: {
      tokenHash: randomBytes(32).toString("hex"),
      userId: advertiser.id,
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

beforeEach(() => {
  requireRoleMock.mockReset();
  // The route allows 5 exports per admin per hour; without this the second
  // test in a run would fail on the quota rather than on what it asserts.
  resetRateLimit();
});

describe("backup export", () => {
  it("covers exactly the tables the restore script walks", async () => {
    const backup = await exportDatabase();
    // Restore iterates BACKUP_TABLES. A table added to one side and not the
    // other silently disappears from every backup taken after that.
    expect(Object.keys(backup.data).sort()).toEqual([...BACKUP_TABLES].sort());
  });

  it("leaves sessions and reset tokens out, even when one is live", async () => {
    const liveSessions = await prisma.session.count();
    expect(liveSessions).toBeGreaterThan(0);

    const backup = await exportDatabase();
    const serialized = JSON.stringify(backup);
    // Restoring live authentication material into a new database would be a
    // security bug, not a backup: everyone signing in again is correct.
    expect(Object.keys(backup.data)).not.toContain("sessions");
    expect(Object.keys(backup.data)).not.toContain("passwordResetTokens");
    expect(serialized).not.toContain("tokenHash");
  });

  it("keeps password hashes, because a restore that forces a reset is not a backup", async () => {
    const backup = await exportDatabase();
    const row = backup.data.users.find((u) => u.id === admin.id);
    expect(row?.passwordHash).toMatch(/^\$2[aby]\$/);
  });

  it("carries the actual image bytes, not just the blob rows", async () => {
    const backup = await exportDatabase();
    const blob = backup.data.blobs.find((b) => b.imageId === imageId);
    expect(blob).toBeDefined();
    // Byte-for-byte: counts can match while every image restores blank.
    expect(Buffer.from(blob!.dataBase64, "base64").equals(imageBytes)).toBe(true);
  });
});

describe("backup route", () => {
  it("refuses anyone who is not an admin", async () => {
    requireRoleMock.mockRejectedValue(new ForbiddenError());
    const res = await getBackup();
    expect(res.status).toBe(403);
  });

  it("serves an admin a file whose name says it is sensitive", async () => {
    requireRoleMock.mockResolvedValue({ id: admin.id, role: "ADMIN" });
    const res = await getBackup();
    expect(res.status).toBe(200);
    // The name is the only warning attached to the file once it is sitting in
    // a downloads folder with every user's personal data in it.
    expect(res.headers.get("content-disposition")).toContain("SENSITIVE");
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = await res.json();
    expect(body.data.users.length).toBeGreaterThan(0);
  });
});
