import { PrismaClient } from "@prisma/client";

/**
 * E2E runs create real rows in the development database. Remove them so the
 * seeded demo inventory stays representative.
 */
export default async function globalTeardown() {
  const prisma = new PrismaClient();
  try {
    await prisma.mediaAsset.deleteMany({ where: { title: { startsWith: "שטח בדיקה" } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: "@velto-e2e.local" } } });
  } finally {
    await prisma.$disconnect();
  }
}
