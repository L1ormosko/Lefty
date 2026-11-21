import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME } from "@/server/auth";

/**
 * Cookie attributes mirror the API routes' cookie (auth README): HttpOnly keeps the token away
 * from scripts, SameSite=Lax withholds it on cross-site POSTs (the CSRF defence), and Secure is
 * required everywhere except `next dev`, where browsers refuse it on plain http.
 */
function cookieAttributes(expires: Date) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV !== "development",
    path: "/",
    expires,
  };
}

/** Stores a freshly issued session token (login, or the rotated token after MFA). */
export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  (await cookies()).set(SESSION_COOKIE_NAME, token, cookieAttributes(expiresAt));
}

/** Makes the browser drop the session cookie. */
export async function clearSessionCookie(): Promise<void> {
  (await cookies()).set(SESSION_COOKIE_NAME, "", cookieAttributes(new Date(0)));
}
