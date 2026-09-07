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
}
