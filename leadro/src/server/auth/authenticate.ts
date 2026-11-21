import { cookies } from "next/headers";
import type { Actor } from "@/server/core";
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
export function authenticateRequest(req: Request): Promise<Actor> {
  return authenticateWith(req, false);
}

/**
 * Like `authenticateRequest` but also accepts a session that has not finished MFA. Use ONLY for
 * the MFA endpoints and logout; everything else must use `authenticateRequest`.
 */
export function authenticateMfaRequest(req: Request): Promise<Actor> {
  return authenticateWith(req, true);
}

async function authenticateWith(req: Request, allowMfaPending: boolean): Promise<Actor> {
  const token = readSessionToken(req);
  if (!token) throw new UnauthenticatedError();
  // The route pipeline has not built its RequestContext yet, so take the correlation id from the header.
  const client = clientInfoFromRequest(req, {
    correlationId: req.headers.get(CORRELATION_HEADER) ?? undefined,
    sourceApp: "API",
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
