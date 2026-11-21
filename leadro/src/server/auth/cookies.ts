import { SESSION_COOKIE_NAME } from "./config";

/**
 * Finds the session token in a `Cookie` header. Hand-rolled (not `next/headers`) so the same code
 * serves route handlers, tests and the mobile API client.
 */
export function readSessionToken(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === SESSION_COOKIE_NAME) {
      const value = part.slice(separator + 1).trim();
      return value === "" ? null : value;
    }
  }
  return null;
}

/**
 * `Secure` everywhere except `next dev`: browsers refuse Secure cookies on plain-http origins
 * other than localhost, and Safari refuses them even there.
 */
function isSecureCookieRequired(): boolean {
  return process.env.NODE_ENV !== "development";
}

/**
 * Set-Cookie value for a new session: HttpOnly (no script access, limits XSS damage), SameSite=Lax
 * (not sent on cross-site POSTs, the CSRF defence for this JSON API) and Secure.
 */
export function buildSessionCookie(token: string, expiresAt: Date): string {
  const maxAgeSeconds = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  return serialise(token, maxAgeSeconds);
}

/** Set-Cookie value that makes the browser drop the session cookie. */
export function buildClearedSessionCookie(): string {
  return serialise("", 0);
}

function serialise(value: string, maxAgeSeconds: number): string {
  const attributes = [`${SESSION_COOKIE_NAME}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSeconds}`];
  if (isSecureCookieRequired()) attributes.push("Secure");
  return attributes.join("; ");
}
