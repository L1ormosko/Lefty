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
