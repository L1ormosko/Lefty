import { Prisma } from "@prisma/client";
import { ConflictError } from "./errors";

/** True for Prisma's "unique constraint failed" error (P2002). */
export const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";

/**
 * Runs `work` and turns a unique-constraint failure into a client-safe `ConflictError`. A
 * check-then-insert is never race-free, so services keep the friendly pre-check AND wrap the write
 * with this: the loser of a race gets 409 instead of a generic 500. Call it AROUND the
 * `withTenant` block: a failed statement aborts the Postgres transaction, so it cannot be caught
 * and recovered from inside.
 */
export async function conflictOnUniqueViolation<T>(message: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError({ message, cause: error });
    throw error;
  }
}
