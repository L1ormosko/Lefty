import type { z, ZodTypeAny } from "zod";
import { stringifyJson } from "@/lib/money";
import { logger, type Logger } from "@/server/logging";
import type { Actor, RequestContext, SourceApp } from "./context";
import { CORRELATION_HEADER, resolveCorrelationId } from "./correlation";
import { toErrorResponse, zodIssuesToFieldIssues } from "./error-mapping";
import { InternalError, UnauthenticatedError, ValidationError } from "./errors";
import { withIdempotency } from "./idempotency";
import { assertJsonContentType, parseJsonText, readRequestText } from "./request-body";

export const IDEMPOTENCY_HEADER = "idempotency-key";
export const CLIENT_APP_HEADER = "x-leadro-client";

/** What a handler returns; build it with `ok`, `created`, `noContent` or `respond`. */
export interface RouteResult {
  status: number;
  /** Serialised as the JSON body; `undefined`/`null` produces an empty body. */
  body: unknown;
}

/** 200 with `{ data }`. */
export const ok = (data: unknown): RouteResult => ({ status: 200, body: { data } });
/** 201 with `{ data }`. */
export const created = (data: unknown): RouteResult => ({ status: 201, body: { data } });
/** 204, no body. */
export const noContent = (): RouteResult => ({ status: 204, body: null });
/** Any status/body, e.g. a collection `{ data, page }`. */
export const respond = (status: number, body: unknown): RouteResult => ({ status, body });

/** Optional Zod schemas for the three input sources. A missing schema means "not used". */
export interface RouteSchemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

type Parsed<S extends ZodTypeAny | undefined> = S extends ZodTypeAny ? z.output<S> : undefined;

/** Validated input handed to `authorize` and the handler. */
export interface RouteInput<S extends RouteSchemas> {
  body: Parsed<S["body"]>;
  query: Parsed<S["query"]>;
  params: Parsed<S["params"]>;
}

export interface RouteHandlerArgs<S extends RouteSchemas> {
  req: Request;
  ctx: RequestContext;
  input: RouteInput<S>;
  /**
   * The request body exactly as received ("" when there was none). Only for handlers that must check a signature over the
   * raw bytes (the payment provider intake, spec 18.3); every other handler uses the validated `input`.
   */
  rawBody: string;
  /** Logger already bound to the correlation id (and tenant/user when authenticated). */
  log: Logger;
}

/** What is known before authentication: the id defineRoute generated/accepted and the client app. */
export type PreAuthContext = Pick<RequestContext, "correlationId" | "sourceApp">;

export interface RouteDefinition<S extends RouteSchemas> {
  schemas?: S;
  /**
   * Resolves the caller from the request (Task 3 plugs the session check in here) or throws
   * `UnauthenticatedError`. Omit for public routes: `ctx.actor` is then null.
   */
  authenticate?: (req: Request, ctx: PreAuthContext) => Promise<Actor>;
  /**
   * Permission/scope check (Task 4). Runs after authentication and input validation, so it can
   * look at the target ids. Throws `ForbiddenError` or `NotFoundError`. It receives the request
   * context so denials can be audited with the same correlation id the client sees.
   */
  authorize?: (actor: Actor, input: RouteInput<S>, ctx: RequestContext) => Promise<void>;
  /**
   * When true and the request carries `Idempotency-Key`, the handler runs through
   * `withIdempotency` (requires `authenticate`). The handler's JSON result is stored and replayed.
   */
  idempotent?: boolean;
  handler: (args: RouteHandlerArgs<S>) => Promise<RouteResult>;
}

/** Next.js passes dynamic route params (a Promise in Next 15) as the second argument. */
export interface NextRouteContext {
  params: Promise<Record<string, string | string[]>>;
}

/**
 * A Next.js route handler. Written as overloads on purpose: Next's build-time route validator reads
 * the LAST signature and rejects an optional second parameter ("NextRouteContext | undefined is not a
 * valid type"), while tests and server code may call a static route with just the request. Keep the
 * two-argument signature last.
 */
export interface RouteHandler {
  (req: Request): Promise<Response>;
  (req: Request, routeContext: NextRouteContext): Promise<Response>;
}

/** Informational only (audit `sourceApp`): the client declares itself; it is not a security claim. */
function resolveSourceApp(req: Request): SourceApp {
  const declared = req.headers.get(CLIENT_APP_HEADER)?.toLowerCase();
  if (declared === "web") return "WEB";
  if (declared === "mobile") return "MOBILE";
  return "API";
}

function buildResponse(result: RouteResult, correlationId: string, extraHeaders?: Record<string, string>): Response {
  const headers = new Headers({ [CORRELATION_HEADER]: correlationId, ...extraHeaders });
  if (result.status === 204 || result.body === null || result.body === undefined) {
    return new Response(null, { status: result.status, headers });
  }
  headers.set("content-type", "application/json");
  // Money is a bigint in server code and a decimal string on the wire (docs/API_CONVENTIONS.md "Money").
  return new Response(stringifyJson(result.body), { status: result.status, headers });
}

function parseWith(schema: ZodTypeAny | undefined, value: unknown, source: string): unknown {
  if (!schema) return undefined;
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issues = zodIssuesToFieldIssues(result.error).map((issue) => ({
    ...issue,
    // Prefix with the source so "name" in the body and "name" in the query stay distinguishable.
    field: [source, issue.field].filter(Boolean).join("."),
  }));
  throw new ValidationError({ field: issues[0]?.field, details: issues });
}

async function parseInput<S extends RouteSchemas>(
  schemas: S | undefined,
  req: Request,
  bodyText: string,
  routeContext: NextRouteContext | undefined,
): Promise<RouteInput<S>> {
  const body = schemas?.body ? parseWith(schemas.body, parseJsonText(bodyText), "body") : undefined;
  const query = schemas?.query
    ? parseWith(schemas.query, Object.fromEntries(new URL(req.url).searchParams), "query")
    : undefined;
  const params = schemas?.params
    ? parseWith(schemas.params, routeContext?.params ? await routeContext.params : {}, "params")
    : undefined;
  return { body, query, params } as RouteInput<S>;
}

/**
 * Builds a Next.js route handler for `/api/v1`. The fixed pipeline (§20.1) is:
 *
 *   correlation id -> authenticate hook -> JSON content type -> Zod parse -> authorize hook -> handler -> error mapping
 *
 * Authentication runs before parsing so unauthenticated callers learn nothing about the input
 * contract. Every response, success or error, carries `x-correlation-id`. Any thrown value is
 * mapped by `toErrorResponse`, so no stack trace or internal message can reach the client.
 */
export function defineRoute<S extends RouteSchemas = RouteSchemas>(definition: RouteDefinition<S>): RouteHandler {
  // Wiring mistakes fail at definition (module load), not per request, so they can never reach a
  // client and are caught by the first test/boot that imports the route.
  if (definition.authorize && !definition.authenticate) {
    throw new Error("defineRoute: `authorize` requires `authenticate` (there would be no actor to check)");
  }
  if (definition.idempotent && !definition.authenticate) {
    throw new Error("defineRoute: `idempotent` requires `authenticate` (idempotency keys are per tenant)");
  }

  const handler = async (req: Request, routeContext?: NextRouteContext): Promise<Response> => {
    const startedAt = Date.now();
    const correlationId = resolveCorrelationId(req.headers);
    const sourceApp = resolveSourceApp(req);
    let log = logger.child({ correlationId, method: req.method, path: new URL(req.url).pathname });

    try {
      // The hooks get defineRoute's own correlation id (never the raw header, which may be absent
      // or malformed) so their audit events line up with the response header.
      const actor = definition.authenticate ? await definition.authenticate(req, { correlationId, sourceApp }) : null;
      if (definition.authenticate && !actor) throw new UnauthenticatedError();
      if (actor) log = log.child({ tenantId: actor.tenantId, userId: actor.userId });

      // After authentication, so anonymous callers learn nothing about the contract; before parsing.
      // The body is read first and the content type enforced only when bytes arrived (see
      // assertJsonContentType): bodyless POST/DELETE routes carry no Content-Type.
      const bodyText = await readRequestText(req);
      assertJsonContentType(req, bodyText);
      const input = await parseInput(definition.schemas, req, bodyText, routeContext);
      const ctx: RequestContext = { correlationId, actor, sourceApp };
      if (actor && definition.authorize) await definition.authorize(actor, input, ctx);

      const run = (): Promise<RouteResult> => definition.handler({ req, ctx, input, rawBody: bodyText, log });

      const idempotencyKey = definition.idempotent ? req.headers.get(IDEMPOTENCY_HEADER) : null;
      let response: Response;
      if (idempotencyKey !== null) {
        // Unreachable: defineRoute() rejects `idempotent` without `authenticate`, which yields an actor.
        if (!actor) throw new InternalError({ cause: new Error("idempotent route ran without an actor") });
        const outcome = await withIdempotency(
          actor.tenantId,
          idempotencyKey,
          { actorUserId: actor.userId, method: req.method, path: new URL(req.url).pathname, body: input.body },
          run,
        );
        response = buildResponse(outcome, correlationId, outcome.replayed ? { "Idempotent-Replayed": "true" } : undefined);
      } else {
        response = buildResponse(await run(), correlationId);
      }

      log.info("request completed", { status: response.status, durationMs: Date.now() - startedAt });
      return response;
    } catch (error) {
      return toErrorResponse(error, correlationId, log);
    }
  };
  return handler;
}
