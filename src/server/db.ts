import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * Query logging, off unless asked for.
 *
 * `VELTO_LOG_QUERIES=1 npm run dev` prints every statement Prisma issues. It
 * is how the N+1 question gets answered by counting rather than by reading -
 * load a screen, count the lines. Deliberately not on by default even in
 * development: a page that issues forty queries is invisible in a log that is
 * always forty lines long.
 *
 * Never enable it in production. Query logs contain the values being queried,
 * which here means email addresses and session token hashes.
 */
const logLevels: ("query" | "warn" | "error")[] =
  process.env.VELTO_LOG_QUERIES === "1"
    ? ["query", "warn", "error"]
    : process.env.NODE_ENV === "development"
      ? ["warn", "error"]
      : ["error"];

export const prisma = globalForPrisma.prisma ?? new PrismaClient({ log: logLevels });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
