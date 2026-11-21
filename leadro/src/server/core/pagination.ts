import { z } from "zod";
import { ValidationError } from "./errors";

/** Default and maximum page size of every collection endpoint (docs/API_CONVENTIONS.md). */
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

/** Query parameters every collection endpoint accepts. Extend it with the endpoint's own filters. */
export const pageQuerySchema = z.object({
  cursor: z.string().min(1).max(300).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});
export type PageQuery = z.infer<typeof pageQuerySchema>;

/** The response shape of a collection: `{ data, page: { nextCursor, limit } }`. */
export interface Page<T> {
  data: T[];
  page: { nextCursor: string | null; limit: number };
}

const encodeCursor = (id: string): string => Buffer.from(id, "utf8").toString("base64url");

// Row ids are cuids. Anything else (NUL bytes, spaces, huge strings) is rejected here, before it can
// reach the database as a bind parameter and turn a bad cursor into a 500.
const CURSOR_ID = /^[A-Za-z0-9_-]{1,64}$/;

function decodeCursor(cursor: string): string {
  const id = Buffer.from(cursor, "base64url").toString("utf8");
  if (!CURSOR_ID.test(id)) throw new ValidationError({ message: "The cursor is invalid.", field: "cursor" });
  return id;
}

/**
 * Prisma arguments for keyset pagination over a stable `orderBy` that ends in `id`: fetch one row
 * more than the page size (to know whether another page exists) and start after the cursor row.
 * Spread the result into `findMany`. A cursor that names no visible row simply yields an empty
 * page, so a tampered cursor cannot reveal rows of another tenant or outside the caller's scope.
 */
export function pageArgs({ cursor, limit }: PageQuery): { take: number; cursor?: { id: string }; skip?: number } {
  return cursor ? { take: limit + 1, cursor: { id: decodeCursor(cursor) }, skip: 1 } : { take: limit + 1 };
}

/** Trims the extra row fetched by `pageArgs` and builds the collection response. */
export function toPage<T extends { id: string }>(rows: T[], limit: number): Page<T> {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  return { data, page: { nextCursor: hasMore ? encodeCursor(data[data.length - 1].id) : null, limit } };
}
