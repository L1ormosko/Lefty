import type { MessageKey, TranslateFn } from "@/lib/i18n";
import { AppError } from "@/server/core";
import { logger } from "@/server/logging";

/**
 * Turns a thrown service error into a translated, non-revealing message for the UI.
 *
 * Only the error CODE is used, never `error.message`: service messages are English and some
 * (login) are deliberately generic, so showing our own translated text keeps both the language
 * and the "no account enumeration" promise. `byCode` supplies the screen-specific wording; any
 * code it omits (and any non-AppError bug) falls back to a rate-limit or generic text.
 */
export function messageForError(
  error: unknown,
  t: TranslateFn,
  byCode: Partial<Record<AppError["code"], MessageKey>> = {},
): string {
  if (error instanceof AppError) {
    const key = byCode[error.code] ?? (error.code === "RATE_LIMITED" ? "ERROR.RATE_LIMITED" : undefined);
    if (key) return t(key);
  } else {
    logger.error("unexpected error in server action", { error });
  }
  return t("ERROR.INTERNAL");
}
