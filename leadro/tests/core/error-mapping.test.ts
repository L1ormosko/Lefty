import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import {
  ConflictError,
  ForbiddenError,
  InternalError,
  InvalidStateTransitionError,
  NotFoundError,
  RateLimitedError,
  UnauthenticatedError,
  ValidationError,
  toErrorResponse,
  type ErrorBody,
} from "@/server/core";
import { createLogger } from "@/server/logging";

const silent = createLogger({ level: "silent" });
const CID = "corr-12345678";

async function map(error: unknown) {
  const response = toErrorResponse(error, CID, silent);
  return { response, body: (await response.json()) as ErrorBody };
}

describe("toErrorResponse", () => {
  it.each([
    [new UnauthenticatedError(), 401, "UNAUTHENTICATED", false],
    [new ForbiddenError(), 403, "FORBIDDEN", false],
    [new NotFoundError(), 404, "NOT_FOUND", false],
    [new ValidationError(), 400, "VALIDATION_FAILED", false],
    [new ConflictError(), 409, "CONFLICT", false],
    [new InvalidStateTransitionError(), 409, "INVALID_STATE_TRANSITION", false],
    [new RateLimitedError(), 429, "RATE_LIMITED", true],
    [new InternalError(), 500, "INTERNAL", true],
  ])("maps %s to HTTP %i / %s", async (error, status, code, retryable) => {
    const { response, body } = await map(error);
    expect(response.status).toBe(status);
    expect(body.error).toMatchObject({ code, retryable, correlationId: CID });
    expect(response.headers.get("x-correlation-id")).toBe(CID);
  });

  it("includes field and sets Retry-After when provided", async () => {
    const { response } = await map(new RateLimitedError({ retryAfterSeconds: 30 }));
    expect(response.headers.get("retry-after")).toBe("30");
    const field = await map(new ConflictError({ field: "email", message: "Email already used." }));
    expect(field.body.error).toMatchObject({ field: "email", message: "Email already used." });
  });

  it("maps ZodError to VALIDATION_FAILED with per-field issues", async () => {
    const parsed = z.object({ email: z.string().email(), age: z.number() }).safeParse({ email: "nope", age: "x" });
    if (parsed.success) throw new Error("expected failure");
    const { response, body } = await map(parsed.error);
    expect(response.status).toBe(400);
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(body.error.field).toBe("email");
    expect(body.error.details?.map((d) => d.field)).toEqual(["email", "age"]);
  });

  it("never leaks internals of unexpected errors", async () => {
    const secrets = [
      'relation "User" does not exist at /srv/leadro/src/server/db/client.ts:12',
      "postgresql://leadro:leadro@127.0.0.1:5432/leadro",
    ];
    const unexpected = [
      new Error(secrets.join(" | ")),
      new TypeError("Cannot read properties of undefined (reading 'x')"),
      new Prisma.PrismaClientKnownRequestError(secrets[0], { code: "P2002", clientVersion: "6.19.3" }),
      "a thrown string",
    ];
    for (const error of unexpected) {
      const { response, body } = await map(error);
      const raw = JSON.stringify(body);
      expect(response.status).toBe(500);
      expect(body.error).toEqual({ code: "INTERNAL", message: "An internal error occurred.", retryable: true, correlationId: CID });
      expect(raw).not.toMatch(/postgresql:|does not exist|\.ts\b|Cannot read|"stack"|Prisma|thrown string/);
    }
  });

  it("does not expose the cause of an AppError to the client, but logs it", async () => {
    const lines: string[] = [];
    const log = createLogger({ level: "debug", sink: (_l, line) => lines.push(line) });
    const error = new InternalError({ cause: new Error("db password=hunter2 failed") });
    const response = toErrorResponse(error, CID, log);
    const raw = await response.text();
    expect(raw).not.toContain("hunter2");
    expect(lines.join("\n")).toContain("db password=hunter2 failed");
  });
});
