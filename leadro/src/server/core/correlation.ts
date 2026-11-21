import { randomUUID } from "node:crypto";

export const CORRELATION_HEADER = "x-correlation-id";

// Conservative charset/length so a client-supplied id can be safely logged and stored (no log
// injection via newlines, bounded size).
const VALID_CORRELATION_ID = /^[A-Za-z0-9._-]{8,128}$/;

/**
 * Returns the caller's `x-correlation-id` when it is well-formed, otherwise a fresh UUID.
 * Malformed values are replaced silently rather than rejected: tracing must never fail a request.
 */
export function resolveCorrelationId(headers: Pick<Headers, "get">): string {
  const supplied = headers.get(CORRELATION_HEADER);
  return supplied !== null && VALID_CORRELATION_ID.test(supplied) ? supplied : randomUUID();
}
