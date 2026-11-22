import { describe, it, expect, beforeAll } from "vitest";
import { z } from "zod";
import {
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
  created,
  defineRoute,
  noContent,
  ok,
  resolveCorrelationId,
  type Actor,
  type ErrorBody,
  MAX_JSON_BODY_BYTES,
} from "@/server/core";
import { createTenant } from "../helpers";

const jsonRequest = (body: unknown, headers: Record<string, string> = {}, url = "http://localhost/api/v1/things?limit=5") =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const schemas = {
  body: z.object({ name: z.string().min(1) }),
  query: z.object({ limit: z.coerce.number().int().max(10) }),
};

describe("resolveCorrelationId", () => {
  it("keeps a well-formed id and replaces malformed ones", () => {
    expect(resolveCorrelationId(new Headers({ "x-correlation-id": "abc-12345678" }))).toBe("abc-12345678");
    const generated = resolveCorrelationId({ get: () => "bad id\nwith newline" });
    expect(generated).toMatch(/^[0-9a-f-]{36}$/);
    expect(resolveCorrelationId(new Headers())).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("defineRoute pipeline", () => {
  it("parses input, runs the handler, returns {data} and echoes the correlation id", async () => {
    const route = defineRoute({
      schemas,
      handler: async ({ input, ctx }) => created({ name: input.body.name, limit: input.query.limit, actor: ctx.actor }),
    });
    const response = await route(jsonRequest({ name: "x" }, { "x-correlation-id": "my-corr-id-1" }));
    expect(response.status).toBe(201);
    expect(response.headers.get("x-correlation-id")).toBe("my-corr-id-1");
    expect(await response.json()).toEqual({ data: { name: "x", limit: 5, actor: null } });
  });

  it("generates a correlation id when none is sent, on success and on error", async () => {
    const route = defineRoute({ schemas, handler: async () => noContent() });
    const success = await route(jsonRequest({ name: "x" }));
    expect(success.status).toBe(204);
    expect(success.headers.get("x-correlation-id")).toBeTruthy();

    const failure = await route(jsonRequest({ name: "" }));
    const body = (await failure.json()) as ErrorBody;
    expect(failure.status).toBe(400);
    expect(body.error.correlationId).toBe(failure.headers.get("x-correlation-id"));
  });

  it("returns VALIDATION_FAILED for bad body, bad query and non-JSON, without running the handler", async () => {
    let ran = false;
    const route = defineRoute({ schemas, handler: async () => ((ran = true), ok(null)) });

    const badBody = (await (await route(jsonRequest({ name: 3 }))).json()) as ErrorBody;
    expect(badBody.error).toMatchObject({ code: "VALIDATION_FAILED", field: "body.name" });

    const badQuery = (await (await route(jsonRequest({ name: "x" }, {}, "http://localhost/x?limit=99"))).json()) as ErrorBody;
    expect(badQuery.error).toMatchObject({ code: "VALIDATION_FAILED", field: "query.limit" });

    const notJson = await route(jsonRequest("{oops"));
    expect(notJson.status).toBe(400);
    expect(ran).toBe(false);
  });

  it("validates dynamic route params", async () => {
    const route = defineRoute({
      schemas: { params: z.object({ id: z.string().uuid() }) },
      handler: async ({ input }) => ok({ id: input.params.id }),
    });
    const good = await route(new Request("http://localhost/x"), { params: Promise.resolve({ id: "6f1c1f5e-3c53-4c6a-9d0e-3b0c8f3a1111" }) });
    expect(good.status).toBe(200);
    const bad = await route(new Request("http://localhost/x"), { params: Promise.resolve({ id: "nope" }) });
    expect(bad.status).toBe(400);
  });

  it("runs authenticate, then validation, then authorize, then the handler", async () => {
    const calls: string[] = [];
    const actor: Actor = { tenantId: "t", userId: "u", employeeId: null, sessionId: "s", locale: "en-US" };
    const route = defineRoute({
      schemas,
      authenticate: async () => (calls.push("authenticate"), actor),
      authorize: async (a, input) => {
        calls.push(`authorize:${a.userId}:${input.body.name}`);
      },
      handler: async ({ ctx }) => (calls.push(`handler:${ctx.actor?.userId}`), ok(null)),
    });
    await route(jsonRequest({ name: "n" }));
    expect(calls).toEqual(["authenticate", "authorize:u:n", "handler:u"]);
  });

  it("does not parse input or run the handler for unauthenticated callers", async () => {
    let ran = false;
    const route = defineRoute({
      schemas,
      authenticate: async () => {
        throw new UnauthenticatedError();
      },
      handler: async () => ((ran = true), ok(null)),
    });
    const response = await route(jsonRequest({ name: "" })); // invalid, but we must see 401 not 400
    expect(response.status).toBe(401);
    expect(ran).toBe(false);
  });

  it("maps authorize failures (403 / 404) and skips the handler", async () => {
    const actor: Actor = { tenantId: "t", userId: "u", employeeId: null, sessionId: "s", locale: null };
    let ran = false;
    const handler = async () => ((ran = true), ok(null));
    const denied = defineRoute({ authenticate: async () => actor, authorize: async () => { throw new ForbiddenError(); }, handler });
    const hidden = defineRoute({ authenticate: async () => actor, authorize: async () => { throw new NotFoundError(); }, handler });
    expect((await denied(jsonRequest({}))).status).toBe(403);
    expect((await hidden(jsonRequest({}))).status).toBe(404);
    expect(ran).toBe(false);
  });

  it("rejects wiring mistakes at definition time", () => {
    expect(() => defineRoute({ authorize: async () => undefined, handler: async () => ok(null) })).toThrow(/authorize/);
    expect(() => defineRoute({ idempotent: true, handler: async () => ok(null) })).toThrow(/idempotent/);
  });

  it("turns unexpected handler exceptions into a generic 500 with no internals", async () => {
    const route = defineRoute({
      handler: async () => {
        throw new Error('duplicate key value violates unique constraint "User_email_key" at /srv/app/x.ts');
      },
    });
    const response = await route(jsonRequest({}));
    const text = await response.text();
    expect(response.status).toBe(500);
    expect(text).not.toMatch(/duplicate key|User_email_key|\/srv/);
    expect(JSON.parse(text).error.code).toBe("INTERNAL");
  });
});

describe("defineRoute request body rules", () => {
  const route = defineRoute({ schemas: { body: z.object({ name: z.string() }) }, handler: async () => ok(null) });
  const codeOf = async (response: Response) => ((await response.json()) as ErrorBody).error.code;

  it("refuses a mutating request whose body is not application/json (415)", async () => {
    for (const contentType of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
      const response = await route(new Request("http://localhost/x", { method: "POST", headers: { "content-type": contentType }, body: "name=x" }));
      expect(response.status).toBe(415);
      expect(await codeOf(response)).toBe("UNSUPPORTED_MEDIA_TYPE");
    }
    const noType = await route(new Request("http://localhost/x", { method: "POST", body: '{"name":"x"}' }));
    expect(noType.status).toBe(415);
  });

  it("accepts application/json with a charset parameter", async () => {
    const response = await route(jsonRequest({ name: "x" }, { "content-type": "application/json; charset=utf-8" }));
    expect(response.status).toBe(200);
  });

  it("refuses a body over 1 MB (413), by declared length and by actual bytes", async () => {
    const huge = JSON.stringify({ name: "x".repeat(MAX_JSON_BODY_BYTES + 1) });
    const declared = await route(jsonRequest(huge));
    expect(declared.status).toBe(413);
    expect(await codeOf(declared)).toBe("PAYLOAD_TOO_LARGE");

    // No content-length (streamed): the bytes are counted as they arrive.
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(huge));
        controller.close();
      },
    });
    const streamed = await route(new Request("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: stream, duplex: "half" } as RequestInit));
    expect(streamed.status).toBe(413);
  });
});

describe("defineRoute idempotency", () => {
  let actor: Actor;
  beforeAll(async () => {
    const tenant = await createTenant("route-idem");
    actor = { tenantId: tenant.id, userId: "u", employeeId: null, sessionId: "s", locale: null };
  });

  it("replays the stored response for a repeated Idempotency-Key and runs the handler once", async () => {
    let runs = 0;
    const route = defineRoute({
      schemas: { body: z.object({ name: z.string() }) },
      authenticate: async () => actor,
      idempotent: true,
      handler: async () => created({ runNumber: ++runs }),
    });
    const key = { "idempotency-key": `k-${Date.now()}-a` };
    const first = await route(jsonRequest({ name: "x" }, key));
    const second = await route(jsonRequest({ name: "x" }, key));
    expect(await first.json()).toEqual({ data: { runNumber: 1 } });
    expect(await second.json()).toEqual({ data: { runNumber: 1 } });
    expect(second.status).toBe(201);
    expect(second.headers.get("idempotent-replayed")).toBe("true");
    expect(first.headers.get("idempotent-replayed")).toBeNull();
    expect(runs).toBe(1);
  });

  it("returns 409 CONFLICT when the key is reused with a different body", async () => {
    const route = defineRoute({
      schemas: { body: z.object({ name: z.string() }) },
      authenticate: async () => actor,
      idempotent: true,
      handler: async () => created({}),
    });
    const key = { "idempotency-key": `k-${Date.now()}-b` };
    await route(jsonRequest({ name: "x" }, key));
    const response = await route(jsonRequest({ name: "y" }, key));
    expect(response.status).toBe(409);
    expect(((await response.json()) as ErrorBody).error.code).toBe("CONFLICT");
  });
});

describe("defineRoute idempotency scope", () => {
  it("does not serve one user's stored response to another user with the same key and body", async () => {
    const tenant = await createTenant("route-idem-users");
    let current = "u1";
    let runs = 0;
    const route = defineRoute({
      schemas: { body: z.object({ name: z.string() }) },
      authenticate: async () => ({ tenantId: tenant.id, userId: current, employeeId: null, sessionId: "s", locale: null }),
      idempotent: true,
      handler: async () => created({ runNumber: ++runs }),
    });
    const key = { "idempotency-key": `k-${Date.now()}-users` };
    const first = await route(jsonRequest({ name: "x" }, key));
    current = "u2";
    const second = await route(jsonRequest({ name: "x" }, key));
    expect(await first.json()).toEqual({ data: { runNumber: 1 } });
    expect(await second.json()).toEqual({ data: { runNumber: 2 } });
    expect(second.headers.get("idempotent-replayed")).toBeNull();
  });
});
