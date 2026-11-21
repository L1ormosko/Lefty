/**
 * The AppError hierarchy (§20.4). Services throw these; `toErrorResponse` (error-mapping.ts) turns
 * them into HTTP responses. Anything that is NOT an AppError is treated as a bug and reported to
 * clients as a generic INTERNAL error.
 */

export const ERROR_CODES = [
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "VALIDATION_FAILED",
  "CONFLICT",
  "INVALID_STATE_TRANSITION",
  "RATE_LIMITED",
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** HTTP status per error code (see docs/API_CONVENTIONS.md). */
export const HTTP_STATUS_BY_CODE: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 400,
  CONFLICT: 409,
  INVALID_STATE_TRANSITION: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

/** One field-level problem, e.g. from Zod validation. */
export interface FieldIssue {
  field: string;
  code: string;
  message: string;
}

export interface AppErrorOptions {
  /** Client-safe message. Never put internal detail (SQL, paths, ids of other tenants) here. */
  message?: string;
  /** The offending input field, for field-level validation problems. */
  field?: string;
  details?: FieldIssue[];
  /** Whether the client may retry the same request unchanged. */
  retryable?: boolean;
  /** The underlying error. It is logged but NEVER sent to clients. */
  cause?: unknown;
}

/** Base class: a failure whose message is safe to show to the client. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly field?: string;
  readonly details?: FieldIssue[];
  readonly retryable: boolean;

  constructor(code: ErrorCode, defaultMessage: string, options: AppErrorOptions = {}) {
    super(options.message ?? defaultMessage, { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.httpStatus = HTTP_STATUS_BY_CODE[code];
    this.field = options.field;
    this.details = options.details;
    this.retryable = options.retryable ?? false;
  }
}

/** No valid session. */
export class UnauthenticatedError extends AppError {
  constructor(options?: AppErrorOptions) {
    super("UNAUTHENTICATED", "Authentication is required.", options);
  }
}

/** Authenticated but lacking the permission or data scope. */
export class ForbiddenError extends AppError {
  constructor(options?: AppErrorOptions) {
    super("FORBIDDEN", "You do not have access to this action.", options);
  }
}

/** Missing, or out of the caller's scope (existence of other tenants' data is never confirmed). */
export class NotFoundError extends AppError {
  constructor(options?: AppErrorOptions) {
    super("NOT_FOUND", "The requested resource was not found.", options);
  }
}

export class ValidationError extends AppError {
  constructor(options?: AppErrorOptions) {
    super("VALIDATION_FAILED", "The request is invalid.", options);
  }
}

/** Uniqueness or concurrent-modification conflict. */
export class ConflictError extends AppError {
  constructor(options?: AppErrorOptions) {
    super("CONFLICT", "The request conflicts with the current state.", options);
  }
}

/** A lifecycle change that the current status does not allow (e.g. completing a cancelled job). */
export class InvalidStateTransitionError extends AppError {
  constructor(options?: AppErrorOptions) {
    super("INVALID_STATE_TRANSITION", "This change is not allowed in the current state.", options);
  }
}

export class RateLimitedError extends AppError {
  /** Seconds the client should wait; sent as the `Retry-After` header. */
  readonly retryAfterSeconds?: number;

  constructor(options: AppErrorOptions & { retryAfterSeconds?: number } = {}) {
    super("RATE_LIMITED", "Too many requests. Please retry later.", { retryable: true, ...options });
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/** An expected-but-unrecoverable server failure. The message stays generic for clients. */
export class InternalError extends AppError {
  constructor(options?: AppErrorOptions) {
    super("INTERNAL", "An internal error occurred.", { retryable: true, ...options });
  }
}
