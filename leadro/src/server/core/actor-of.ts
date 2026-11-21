import type { Actor, RequestContext } from "./context";
import { UnauthenticatedError } from "./errors";

/**
 * The authenticated caller of a request. Routes declared with an `authenticate` hook always have
 * one; this makes that explicit (and typed) instead of a non-null assertion at every call site.
 * @throws UnauthenticatedError if the route was wired without `authenticate`.
 */
export function actorOf(ctx: RequestContext): Actor {
  if (!ctx.actor) throw new UnauthenticatedError();
  return ctx.actor;
}
