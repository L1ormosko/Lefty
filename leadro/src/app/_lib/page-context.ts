import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { createTranslator, directionOf, type Locale, type TextDirection, type TranslateFn } from "@/lib/i18n";
import { SESSION_COOKIE_NAME, authenticateMfaRequest, requireSession } from "@/server/auth";
import { UnauthenticatedError, type Actor } from "@/server/core";
import { getTranslatorForRequest } from "@/server/i18n";
import { LOCALE_COOKIE_NAME, resolveAnonymousLocale } from "./locale-negotiation";

export interface SessionState {
  actor: Actor;
  /** Password was correct but the second factor is outstanding: only the MFA pages may be used. */
  mfaPending: boolean;
}

/**
 * Who is calling, if anyone. `requireSession` only answers for fully signed-in sessions, so a
 * session still waiting for MFA is detected with the MFA-tolerant authenticator, fed the same
 * cookie. Returns null for "no usable session".
 */
export async function readSessionState(): Promise<SessionState | null> {
  try {
    return { actor: await requireSession(), mfaPending: false };
  } catch (error) {
    if (!(error instanceof UnauthenticatedError)) throw error;
  }
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  try {
    const request = new Request("http://localhost/", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
    });
    return { actor: await authenticateMfaRequest(request), mfaPending: true };
  } catch (error) {
    if (error instanceof UnauthenticatedError) return null;
    throw error;
  }
}

export interface PageContext {
  /** The signed-in actor, MFA-pending or not; null when nobody is signed in. */
  actor: Actor | null;
  mfaPending: boolean;
  locale: Locale;
  direction: TextDirection;
  /** IANA zone for showing timestamps (§16.5); UTC when nobody is signed in. */
  timeZone: string;
  t: TranslateFn;
}

/**
 * Everything a page, layout or action needs to render in the right language: the session, the
 * resolved locale (user -> branch -> company -> en-US when signed in; cookie / Accept-Language
 * otherwise) and a translator with the tenant's reviewed overrides. Memoised per request so the
 * root layout, nested layouts and the page share one lookup.
 */
export const getPageContext = cache(async (): Promise<PageContext> => {
  const session = await readSessionState();
  if (session) {
    const { t, context } = await getTranslatorForRequest(session.actor.tenantId, { userId: session.actor.userId });
    return {
      actor: session.actor,
      mfaPending: session.mfaPending,
      locale: context.locale,
      direction: context.direction,
      timeZone: context.timeZone,
      t,
    };
  }
  const locale = resolveAnonymousLocale(
    (await cookies()).get(LOCALE_COOKIE_NAME)?.value,
    (await headers()).get("accept-language"),
  );
  return {
    actor: null,
    mfaPending: false,
    locale,
    direction: directionOf(locale),
    timeZone: "UTC",
    t: createTranslator({ localeChain: [locale] }),
  };
});

/**
 * The signed-in actor of a FULLY authenticated session, for every page and action that touches
 * user data. No session -> /login; password accepted but MFA outstanding -> /login/mfa. Layouts
 * do not guard their pages (each renders independently), so every (app) page and every
 * data-touching action must call this itself. Only the MFA actions and logout use the tolerant
 * `getPageContext()`.
 */
export async function requireFullSession(): Promise<PageContext & { actor: Actor }> {
  const context = await getPageContext();
  if (!context.actor) redirect("/login");
  if (context.mfaPending) redirect("/login/mfa");
  return context as PageContext & { actor: Actor };
}
