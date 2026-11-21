import { ZodError } from "zod";
import { serializeError, type Logger } from "@/server/logging";
import { AppError, RateLimitedError, HTTP_STATUS_BY_CODE, type ErrorCode, type FieldIssue } from "./errors";
import { CORRELATION_HEADER } from "./correlation";

/** The JSON error body (§20.4, docs/API_CONVENTIONS.md). */
export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    field?: string;
    details?: FieldIssue[];
    retryable: boolean;
    correlationId: string;
  };
}

/** Converts a Zod failure into field issues. Only paths and Zod's own messages are used, never input values. */
export function zodIssuesToFieldIssues(error: ZodError): FieldIssue[] {
  return error.issues.map((issue) => ({
    field: issue.path.join("."),
    code: issue.code,
    message: issue.message,
  }));
}

const GENERIC_INTERNAL_MESSAGE = "An internal error occurred.";

/**
 * Maps ANY thrown value to a client-safe response.
 *
 * - AppError: its code/message/field are sent as-is (they were written to be client-safe).
 * - ZodError: VALIDATION_FAILED with field issues.
 * - Everything else (Prisma errors, TypeErrors, ...): logged with stack and cause, then reported
 *   as a generic INTERNAL error. Internals must never leak (§20.4).
 */
export function toErrorResponse(error: unknown, correlationId: string, log: Logger): Response {
  let code: ErrorCode;
  let message: string;
  let field: string | undefined;
  let details: FieldIssue[] | undefined;
  let retryable: boolean;
  const headers = new Headers({ [CORRELATION_HEADER]: correlationId });

  if (error instanceof AppError) {
    ({ code, message, field, details, retryable } = error);
    if (error instanceof RateLimitedError && error.retryAfterSeconds !== undefined) {
      headers.set("Retry-After", String(error.retryAfterSeconds));
    }
    // Client mistakes are expected; log at warn. Server-side AppErrors (INTERNAL) at error.
    const level = error.httpStatus >= 500 ? "error" : "warn";
    log[level]("request failed", { code, error: serializeError(error), cause: serializeCause(error) });
  } else if (error instanceof ZodError) {
    const issues = zodIssuesToFieldIssues(error);
    code = "VALIDATION_FAILED";
    message = "The request is invalid.";
    field = issues[0]?.field || undefined;
    details = issues;
    retryable = false;
    log.warn("request failed", { code });
  } else {
    code = "INTERNAL";
    message = GENERIC_INTERNAL_MESSAGE;
    retryable = true;
    log.error("unhandled error", { code, error: serializeError(error) });
  }

  const body: ErrorBody = {
    error: {
      code,
      message,
      ...(field ? { field } : {}),
      ...(details ? { details } : {}),
      retryable,
      correlationId,
    },
  };
  return Response.json(body, { status: HTTP_STATUS_BY_CODE[code], headers });
}

function serializeCause(error: AppError): unknown {
  return error.cause === undefined ? undefined : serializeError(error.cause);
}
