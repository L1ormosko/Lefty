/**
 * Shared request types. Auth (Task 3) produces an `Actor`; authorization (Task 4) consumes it;
 * both plug into `defineRoute` through its `authenticate` / `authorize` hooks.
 */

/** The authenticated caller of a request. `tenantId` always comes from the session, never the body. */
export interface Actor {
  tenantId: string;
  userId: string;
  employeeId: string | null;
  sessionId: string;
  locale: string | null;
}

export type SourceApp = "WEB" | "MOBILE" | "API" | "SYSTEM";

/** Per-request facts available to handlers, audit and logging. */
export interface RequestContext {
  correlationId: string;
  /** Null for unauthenticated routes (e.g. login) or while no `authenticate` hook is configured. */
  actor: Actor | null;
  sourceApp: SourceApp;
}
