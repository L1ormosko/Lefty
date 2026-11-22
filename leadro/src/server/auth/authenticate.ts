import { cookies } from "next/headers";
import type { Actor, PreAuthContext } from "@/server/core";
import { CORRELATION_HEADER, UnauthenticatedError } from "@/server/core";
import { clientInfoFromRequest } from "./client-info";
import { SESSION_COOKIE_NAME } from "./config";
import { readSessionToken } from "./cookies";
import { resolveSession } from "./session-service";

/**
 * The `authenticate` hook for `defineRoute`: reads the session cookie and returns the `Actor`
 * (tenant and user come from the session, never from the request body). Sessions still waiting
 * for MFA are refused here; they can only use `authenticateMfaRequest` routes.
 *
 * @throws UnauthenticatedError when there is no valid session.
 */
export function authenticateRequest(req: Request, ctx?: PreAuthContext): Promise<Actor> {
  return authenticateWith(req, false, ctx);
}

/**
 * Like `authenticateRequest` but also accepts a session that has not finished MFA. Use ONLY for
 * the MFA endpoints and logout; everything else must use `authenticateRequest`.
 */
export function authenticateMfaRequest(req: Request, ctx?: PreAuthContext): Promise<Actor> {
  return authenticateWith(req, true, ctx);
}

async function authenticateWith(req: Request, allowMfaPending: boolean, ctx?: PreAuthContext): Promise<Actor> {
  const token = readSessionToken(req);
  if (!token) throw new UnauthenticatedError();
  // Inside defineRoute the context carries the id the pipeline generated (the one echoed in the
  // response header). Direct callers without a context fall back to the raw header.
  const client = clientInfoFromRequest(req, {
    correlationId: ctx?.correlationId ?? req.headers.get(CORRELATION_HEADER) ?? undefined,
    sourceApp: ctx?.sourceApp ?? "API",
  });
  const resolved = await resolveSession(token, { allowMfaPending, client });
  if (!resolved) throw new UnauthenticatedError();
  return resolved.actor;
}

/**
 * For server components and server actions: the signed-in `Actor` from the request's session
 * cookie. Pages that want a redirect instead of an error should catch `UnauthenticatedError`.
 *
 * @throws UnauthenticatedError when there is no valid, MFA-complete session.
 */
export async function requireSession(): Promise<Actor> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!token) throw new UnauthenticatedError();
  const resolved = await resolveSession(token, { client: { sourceApp: "WEB" } });
  if (!resolved) throw new UnauthenticatedError();
  return resolved.actor;
}

/**
 * For the page layer: reads the session from the cookie WITHOUT treating "still waiting for MFA" as
 * a refusal. Returns the actor plus `mfaPending`, or null when there is no usable session.
 *
 * Exists so a page can tell the three states (signed out, MFA pending, signed in) with one lookup.
 * Probing with `requireSession()` first would audit a false `auth.access_denied` row on every render
 * of an MFA-pending page. Callers must still refuse `mfaPending` sessions for anything but the MFA
 * step (see `requireFullSession` in the app layer).
 */
export async function readSession(): Promise<{ actor: Actor; mfaPending: boolean } | null> {
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  return resolveSession(token, { allowMfaPending: true, client: { sourceApp: "WEB" } });
}
