"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { isSupportedLocale } from "@/lib/i18n";
import { updateOwnLocale } from "@/server/users";
import { LOCALE_COOKIE_NAME } from "../_lib/locale-negotiation";
import { readSessionState } from "../_lib/page-context";
import { getClientInfo } from "../_lib/request-client";

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/**
 * Switches the interface language (§16.2). Always remembered in the `leadro_locale` cookie (used
 * on pages with no signed-in user). When someone is signed in it also updates THAT user's own
 * `locale` — never anyone else's: the target id comes from the session, not from the form — and
 * writes an audit event in the same transaction (`users.updateOwnLocale`).
 *
 * @returns false when `locale` is not a supported locale (nothing changed).
 */
export async function changeLocaleAction(locale: string): Promise<boolean> {
  if (!isSupportedLocale(locale)) return false;

  const session = await readSessionState();
  // A password-only (MFA-pending) session must not write user data: it only gets the cookie.
  if (session && !session.mfaPending) {
    await updateOwnLocale(session.actor, await getClientInfo(), locale);
  }

  (await cookies()).set(LOCALE_COOKIE_NAME, locale, {
    path: "/",
    sameSite: "lax",
    maxAge: ONE_YEAR_SECONDS,
    secure: process.env.NODE_ENV !== "development",
  });
  revalidatePath("/", "layout");
  return true;
}
