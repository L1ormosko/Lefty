import type { MessageKey, TranslateFn } from "@/lib/i18n";
import { AppError } from "@/server/core";
import { logger } from "@/server/logging";

type ByCode = Partial<Record<AppError["code"], MessageKey>>;

/** Shared texts by error code, for screens that opt in with `useDefaults` (the admin screens). */
const DEFAULT_KEY_BY_CODE: ByCode = {
  FORBIDDEN: "ERROR.FORBIDDEN",
  NOT_FOUND: "ERROR.NOT_FOUND",
  VALIDATION_FAILED: "ERROR.VALIDATION_FAILED",
  CONFLICT: "ERROR.CONFLICT",
  INVALID_STATE_TRANSITION: "ERROR.INVALID_STATE_TRANSITION",
  RATE_LIMITED: "ERROR.RATE_LIMITED",
  UNSUPPORTED_MEDIA_TYPE: "ERROR.UNSUPPORTED_MEDIA_TYPE",
  PAYLOAD_TOO_LARGE: "ERROR.PAYLOAD_TOO_LARGE",
};

export interface ErrorMessageOptions {
  /** Text per field name for a Validation/Conflict error that points at a field the user can fix. */
  byField?: Record<string, MessageKey>;
  /** Fall back to the shared per-code texts (default false: login-style screens stay deliberately generic). */
  useDefaults?: boolean;
}

/**
 * Turns a thrown service error into a translated, non-revealing message for the UI. This is the ONE
 * error-to-text mapping of the web app (auth screens and admin screens both use it).
 *
 * Only the error CODE (and, for field errors, the field name) is used, never `error.message`:
 * service messages are English and some (login) are deliberately generic, so showing our own
 * translated text keeps both the language and the "no account enumeration" promise. `byCode`
 * supplies screen-specific wording; rate limiting always has a text; anything unmatched, and any
 * non-AppError bug, becomes the generic internal-error text.
 */
export function messageForError(
  error: unknown,
  t: TranslateFn,
  byCode: ByCode = {},
  options: ErrorMessageOptions = {},
): string {
  if (error instanceof AppError) {
    if ((error.code === "VALIDATION_FAILED" || error.code === "CONFLICT") && error.field) {
      const fieldKey = options.byField?.[error.field];
      if (fieldKey) return t(fieldKey);
    }
    const key = byCode[error.code] ?? (options.useDefaults || error.code === "RATE_LIMITED" ? DEFAULT_KEY_BY_CODE[error.code] : undefined);
    if (key) return t(key);
  } else {
    logger.error("unexpected error in server action", { error });
  }
  return t("ERROR.INTERNAL");
}
