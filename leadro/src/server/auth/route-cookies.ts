import type { NextRouteContext, RouteHandler } from "@/server/core";
import { buildClearedSessionCookie, buildSessionCookie } from "./cookies";

/**
 * `defineRoute` handlers return only a status and body, so a handler that must set or clear the
 * session cookie records the header here (keyed by the request object) and `withSessionCookie`
 * attaches it to the final response. This keeps core untouched and the handlers testable.
 */
const pendingSetCookies = new WeakMap<Request, string[]>();

function queue(req: Request, headerValue: string): void {
  pendingSetCookies.set(req, [...(pendingSetCookies.get(req) ?? []), headerValue]);
}

/** Ask for the session cookie to be set on this request's response. */
export function queueSessionCookie(req: Request, token: string, expiresAt: Date): void {
  queue(req, buildSessionCookie(token, expiresAt));
}

/** Ask for the session cookie to be cleared on this request's response. */
export function queueClearSessionCookie(req: Request): void {
  queue(req, buildClearedSessionCookie());
}

/** Wraps a `defineRoute` handler so queued cookies are added to its response. */
export function withSessionCookie(handler: RouteHandler): RouteHandler {
  return async (req: Request, routeContext?: NextRouteContext) => {
    const response = await (routeContext ? handler(req, routeContext) : handler(req));
    for (const headerValue of pendingSetCookies.get(req) ?? []) response.headers.append("set-cookie", headerValue);
    pendingSetCookies.delete(req);
    return response;
  };
}
