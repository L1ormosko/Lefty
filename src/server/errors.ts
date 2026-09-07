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
 */
export function toUserMessage(err: unknown): string {
  if (err instanceof AppError) return err.message;
  console.error("[velto] unhandled error:", err);
  return "אירעה שגיאה. נסו שוב.";
}
