import { randomUUID } from "node:crypto";
import { PrismaClient, type Prisma, type Role } from "@prisma/client";
import { hashPassword } from "@/server/auth";
import { addDays, todayUtc } from "@/lib/dates";

export const prisma = new PrismaClient();

/** Everything created by tests carries this marker so cleanup is exact. */
export const TEST_TAG = "velto-test";

export async function makeUser(role: Role = "ADVERTISER") {
  return prisma.user.create({
    data: {
      email: `${randomUUID()}@${TEST_TAG}.local`,
      passwordHash: await hashPassword("test-password-123"),
      name: `${TEST_TAG} ${role}`,
      role,
    },
  });
}

export async function makeAsset(
  ownerId: string,
  overrides: Partial<Prisma.MediaAssetUncheckedCreateInput> = {}
) {
  return prisma.mediaAsset.create({
    data: {
      ownerId,
      title: `${TEST_TAG} asset`,
      assetType: "BILLBOARD",
      address: "רחוב הבדיקה 1",
      city: "באר שבע",
      latitude: 31.25,
      longitude: 34.79,
      status: "ACTIVE",
      verificationStatus: "VERIFIED",
      minimumBookingDays: 1,
      priceMonthly: 3000,
      periods: {
        create: [{ startDate: todayUtc(), endDate: addDays(todayUtc(), 400) }],
      },
      ...overrides,
    },
  });
}

export async function cleanup() {
  await prisma.mediaAsset.deleteMany({ where: { title: { contains: TEST_TAG } } });
  await prisma.user.deleteMany({ where: { email: { contains: TEST_TAG } } });
  // Anonymization overwrites the email, so a user the account tests erased no
  // longer carries TEST_TAG and the rule above would never find it. Tombstones
  // are unmistakable (deletedAt set, reserved .invalid domain) and setup.ts
  // already refuses to run against anything but a VELTO development database.
  await prisma.user.deleteMany({
    where: { deletedAt: { not: null }, email: { endsWith: "@velto.invalid" } },
  });
  await prisma.company.deleteMany({ where: { name: { contains: TEST_TAG } } });
}
