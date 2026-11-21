import { afterEach, describe, expect, it } from "vitest";
import { RateLimitedError } from "@/server/core";
import { enforceIpRateLimit, resolveClientIp, type ClientInfo } from "@/server/auth/client-info";
import { resetAuthTestState } from "./auth-helpers";

resetAuthTestState();

const originalHops = process.env.LEADRO_TRUSTED_PROXY_HOPS;
afterEach(() => {
  if (originalHops === undefined) delete process.env.LEADRO_TRUSTED_PROXY_HOPS;
  else process.env.LEADRO_TRUSTED_PROXY_HOPS = originalHops;
});

const headers = (forwardedFor: string) => new Headers({ "x-forwarded-for": forwardedFor });

describe("resolveClientIp", () => {
  it("ignores X-Forwarded-For entirely by default (no trusted proxy)", () => {
    delete process.env.LEADRO_TRUSTED_PROXY_HOPS;
    expect(resolveClientIp(headers("1.2.3.4"))).toBeUndefined();
    process.env.LEADRO_TRUSTED_PROXY_HOPS = "0";
    expect(resolveClientIp(headers("1.2.3.4"))).toBeUndefined();
    process.env.LEADRO_TRUSTED_PROXY_HOPS = "garbage";
    expect(resolveClientIp(headers("1.2.3.4"))).toBeUndefined();
  });

  it("takes the Nth entry from the right, so attacker-chosen leading entries are ignored", () => {
    process.env.LEADRO_TRUSTED_PROXY_HOPS = "1";
    expect(resolveClientIp(headers("6.6.6.6, 7.7.7.7, 198.51.100.5"))).toBe("198.51.100.5");
    process.env.LEADRO_TRUSTED_PROXY_HOPS = "2";
    expect(resolveClientIp(headers("6.6.6.6, 198.51.100.5, 10.0.0.1"))).toBe("198.51.100.5");
  });

  it("returns nothing when the header has fewer entries than trusted proxies", () => {
    process.env.LEADRO_TRUSTED_PROXY_HOPS = "2";
    expect(resolveClientIp(headers("198.51.100.5"))).toBeUndefined();
    expect(resolveClientIp(new Headers())).toBeUndefined();
  });
});

describe("per-IP rate limiting", () => {
  const rule = { limit: 2, windowMs: 60_000 };
  const clientAt = (ipAddress?: string): ClientInfo => ({ sourceApp: "API", ipAddress });

  it("a spoofed leading X-Forwarded-For entry does not create a fresh bucket", () => {
    process.env.LEADRO_TRUSTED_PROXY_HOPS = "1";
    const resolve = (spoof: string) => clientAt(resolveClientIp(headers(`${spoof}, 192.0.2.50`)));
    enforceIpRateLimit(resolve("1.1.1.1"), "test:ip", rule);
    enforceIpRateLimit(resolve("2.2.2.2"), "test:ip", rule);
    expect(() => enforceIpRateLimit(resolve("3.3.3.3"), "test:ip", rule)).toThrow(RateLimitedError);
  });

  it("is skipped, not shared by everyone, when no client IP is known", () => {
    for (let attempt = 0; attempt < 10; attempt++) enforceIpRateLimit(clientAt(undefined), "test:noip", rule);
  });
});
