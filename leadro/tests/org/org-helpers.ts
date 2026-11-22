import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Actor, RequestContext } from "@/server/core";
import { withTenant } from "@/server/db";
import type { Person } from "../authz/fixtures";

/**
 * Creates a live session for a fixture person (as if any MFA challenge had already been passed:
 * `mfaVerifiedAt` is set) and returns the cookie header value a browser would send. */
export async function sessionCookie(person: Person, tenantId: string): Promise<string> {
  const token = `${tenantId}.${randomBytes(32).toString("base64url")}`;
  await withTenant(tenantId, (tx) =>
    tx.session.create({
      data: {
        tenantId,
        userId: person.userId,
        tokenHash: createHash("sha256").update(token).digest("hex"),
        expiresAt: new Date(Date.now() + 3_600_000),
        mfaVerifiedAt: new Date(),
      },
    }),
  );
  return `leadro_session=${token}`;
}

/** A request context as defineRoute would build it, for calling services directly. */
export const contextFor = (actor: Actor): RequestContext => ({ correlationId: randomUUID(), actor, sourceApp: "API" });

type RouteHandler = (req: Request, routeContext?: { params?: Promise<Record<string, string | string[]>> }) => Promise<Response>;

export interface CallOptions {
  cookie?: string;
  body?: unknown;
  params?: Record<string, string>;
  query?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface CallResult {
  status: number;
  json: any;
  correlationId: string | null;
}

/** Invokes a route handler exactly like Next.js would, and parses the JSON response. */
export async function call(handler: RouteHandler, method: string, path: string, options: CallOptions = {}): Promise<CallResult> {
  const url = new URL(`http://localhost${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value);
  const headers = new Headers(options.headers);
  if (options.cookie) headers.set("cookie", options.cookie);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  const response = await handler(
    new Request(url, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) }),
    { params: Promise.resolve(options.params ?? {}) },
  );
  const text = await response.text();
  return {
    status: response.status,
    json: text ? JSON.parse(text) : null,
    correlationId: response.headers.get("x-correlation-id"),
  };
}

/** Every audit event of one tenant for an action, newest first (RLS-scoped through withTenant). */
export const auditEvents = (tenantId: string, action: string, targetId?: string) =>
  withTenant(tenantId, (tx) =>
    tx.auditEvent.findMany({
      where: { tenantId, action, ...(targetId ? { targetId } : {}) },
      orderBy: { occurredAt: "desc" },
    }),
  );
