/** Domain errors. Never surface raw database errors to a user. */

export class AppError extends Error {
  constructor(message: string, readonly code: string, readonly httpStatus: number) {
    super(message);
    this.name = "AppError";
  }
}

export class AuthError extends AppError {
  constructor(message = "auth.loginRequired") {
    super(message, "UNAUTHENTICATED", 401);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "אין לכם הרשאה לבצע פעולה זו.") {
    super(message, "FORBIDDEN", 403);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "הפריט המבוקש לא נמצא.") {
    super(message, "NOT_FOUND", 404);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, readonly fields?: Record<string, string>) {
    super(message, "VALIDATION", 400);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, "CONFLICT", 409);
  }
}

/**
 * Convert anything thrown into a message safe to show a user, and log the
 * technical detail server-side.
 *
 * This is the funnel every server action's unexpected failure passes through,
 * which is why the error report is sent from here rather than sprinkled over
 * the call sites. An AppError is a decision the code made on purpose - a
 * booking refused, a permission denied - and is not reported; only the ones
 * nobody planned for are.
 *
 * The import is dynamic because this module is imported by client components
 * for its error classes, and server/report.ts is "server-only". A static
 * import would pull that into the browser bundle and fail the build.
 */
export function toUserMessage(err: unknown): string {
  if (err instanceof AppError) return err.message;
  console.error("[velto] unhandled error:", err);
  void import("./report")
    .then((m) => m.reportError(err, "server action"))
    .catch(() => {
      // Reporting must never break the thing it reports on - see report.ts.
    });
  return "אירעה שגיאה. נסו שוב.";
}
