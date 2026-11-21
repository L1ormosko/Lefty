import { PrismaClient } from "@prisma/client";
import { PERMISSION_CATALOG, permissionKey } from "../src/server/authz";

/**
 * Seeds the global permission catalog (idempotent). Tenant data (roles, org tree, users) is
 * created by the bootstrap/onboarding flows in later tasks, not here.
 */
async function main() {
  const prisma = new PrismaClient();
  try {
    for (const def of PERMISSION_CATALOG) {
      await prisma.permission.upsert({
        where: { key: permissionKey(def) },
        update: { description: def.description, sensitive: def.sensitive ?? false },
        create: {
          key: permissionKey(def),
          module: def.module,
          action: def.action,
          description: def.description,
          sensitive: def.sensitive ?? false,
        },
      });
    }
    console.log(`seeded ${PERMISSION_CATALOG.length} permissions`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
