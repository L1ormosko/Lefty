import { describe, it, expect, beforeAll } from "vitest";
import { ConflictError, ValidationError, hashIdempotentRequest, withIdempotency } from "@/server/core";
import { withTenant } from "@/server/db";
import { createTenant } from "../helpers";

let tenantA: { id: string };
let tenantB: { id: string };
let counter = 0;
const uniqueKey = () => `key-${Date.now().toString(36)}-${++counter}`;
const scope = (body: unknown = { amount: 1 }) => ({ method: "POST", path: "/api/v1/jobs", body });

beforeAll(async () => {
  tenantA = await createTenant("idem-a");
  tenantB = await createTenant("idem-b");
});

describe("hashIdempotentRequest", () => {
  it("ignores key order and method case but not content", () => {
    const a = hashIdempotentRequest({ method: "post", path: "/p", body: { x: 1, y: { b: 2, a: 1 } } });
    const b = hashIdempotentRequest({ method: "POST", path: "/p", body: { y: { a: 1, b: 2 }, x: 1 } });
    expect(a).toBe(b);
    expect(hashIdempotentRequest({ method: "POST", path: "/p", body: { x: 2 } })).not.toBe(a);
    expect(hashIdempotentRequest({ method: "POST", path: "/other", body: { x: 1 } })).not.toBe(a);
  });
});

describe("withIdempotency", () => {
  it("runs fn once and replays the identical response to a sequential duplicate", async () => {
    const key = uniqueKey();
    let runs = 0;
    const fn = async () => ({ status: 201, body: { id: `job-${++runs}` } });

    const first = await withIdempotency(tenantA.id, key, scope(), fn);
    const second = await withIdempotency(tenantA.id, key, scope(), fn);

    expect(runs).toBe(1);
    expect(first).toEqual({ status: 201, body: { id: "job-1" }, replayed: false });
    expect(second).toEqual({ status: 201, body: { id: "job-1" }, replayed: true });
  });

  it("runs fn exactly once when duplicates arrive concurrently; the others get a retryable CONFLICT", async () => {
    const key = uniqueKey();
    let runs = 0;
    const fn = async () => {
      runs += 1;
      await new Promise((resolve) => setTimeout(resolve, 300)); // keep the first one in flight
      return { status: 201, body: { ok: true } };
    };

    const results = await Promise.allSettled(Array.from({ length: 5 }, () => withIdempotency(tenantA.id, key, scope(), fn)));

    expect(runs).toBe(1);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(4);
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(ConflictError);
      expect((r.reason as ConflictError).retryable).toBe(true);
    }

    // After the winner finished, a retry gets the stored response.
    const retry = await withIdempotency(tenantA.id, key, scope(), fn);
    expect(retry).toMatchObject({ status: 201, replayed: true });
    expect(runs).toBe(1);
  });

  it("rejects the same key with a different payload as CONFLICT and does not run fn", async () => {
    const key = uniqueKey();
    await withIdempotency(tenantA.id, key, scope({ amount: 1 }), async () => ({ status: 200, body: {} }));
    let ran = false;
    const attempt = withIdempotency(tenantA.id, key, scope({ amount: 2 }), async () => ((ran = true), { status: 200, body: {} }));
    await expect(attempt).rejects.toMatchObject({ code: "CONFLICT", retryable: false });
    expect(ran).toBe(false);
  });

  it("releases the claim when fn throws so the client can retry", async () => {
    const key = uniqueKey();
    await expect(
      withIdempotency(tenantA.id, key, scope(), async () => {
        throw new Error("transient");
      }),
    ).rejects.toThrow("transient");

    const retry = await withIdempotency(tenantA.id, key, scope(), async () => ({ status: 200, body: { ok: 1 } }));
    expect(retry).toEqual({ status: 200, body: { ok: 1 }, replayed: false });
  });

  it("keeps keys separate per tenant", async () => {
    const key = uniqueKey();
    let runs = 0;
    const fn = async () => ({ status: 200, body: { run: ++runs } });
    const a = await withIdempotency(tenantA.id, key, scope(), fn);
    const b = await withIdempotency(tenantB.id, key, scope(), fn);
    expect(runs).toBe(2);
    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(false);
  });

  it("allows a key to be reused after its record expired", async () => {
    const key = uniqueKey();
    let runs = 0;
    const fn = async () => ({ status: 200, body: { run: ++runs } });
    await withIdempotency(tenantA.id, key, scope(), fn);
    await withTenant(tenantA.id, (tx) =>
      tx.idempotencyRecord.updateMany({ where: { key }, data: { expiresAt: new Date(Date.now() - 1000) } }),
    );
    const again = await withIdempotency(tenantA.id, key, scope(), fn);
    expect(again).toMatchObject({ body: { run: 2 }, replayed: false });
  });

  it("replays an empty (204) response", async () => {
    const key = uniqueKey();
    await withIdempotency(tenantA.id, key, scope(), async () => ({ status: 204, body: null }));
    const replay = await withIdempotency(tenantA.id, key, scope(), async () => ({ status: 500, body: "should not run" }));
    expect(replay).toEqual({ status: 204, body: null, replayed: true });
  });

  it("rejects empty and over-long keys", async () => {
    const fn = async () => ({ status: 200, body: {} });
    await expect(withIdempotency(tenantA.id, "", scope(), fn)).rejects.toBeInstanceOf(ValidationError);
    await expect(withIdempotency(tenantA.id, "k".repeat(129), scope(), fn)).rejects.toBeInstanceOf(ValidationError);
  });
});
