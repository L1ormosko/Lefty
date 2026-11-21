import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { leadroPrisma?: PrismaClient };

/**
 * The one PrismaClient. It connects as the non-superuser, NOBYPASSRLS `leadro` role, so every
 * query against a tenant-owned table is filtered by row-level security. Querying those tables
 * through this client directly (outside `withTenant`) sees nothing: that is by design.
 */
export const prisma =
  globalForPrisma.leadroPrisma ??
  new PrismaClient({ log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"] });

if (process.env.NODE_ENV !== "production") globalForPrisma.leadroPrisma = prisma;
