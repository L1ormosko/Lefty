import type { SourceApp } from "@/server/core";
import { logger } from "@/server/logging";
import { enforceRateLimit, type RateLimit } from "./rate-limiter";

/** Facts about the calling client that auth events, audit and rate limits need. */
export interface ClientInfo {
  /** Undefined when no trustworthy client IP is known (see `resolveClientIp`). */
  ipAddress?: string;
  userAgent?: string;
  correlationId?: string;
  sourceApp: SourceApp;
}

const TRUSTED_PROXY_HOPS_ENV = "LEADRO_TRUSTED_PROXY_HOPS";

/** Number of reverse proxies in front of the app that append to `x-forwarded-for`. Default 0. */
function trustedProxyHops(): number {
  const parsed = Number.parseInt(process.env[TRUSTED_PROXY_HOPS_ENV] ?? "0", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * The client IP, or undefined if it cannot be known safely.
 *
 * Every proxy APPENDS the address it saw to `x-forwarded-for`, so the LEFT entries are whatever
 * the client chose to send and are forgeable. Only the entries the trusted proxies wrote, counted
 * from the right, can be believed. With `LEADRO_TRUSTED_PROXY_HOPS=N` we take the Nth entry from
 * the right (N=1: the address your single proxy saw). With the default 0 the header is ignored
 * entirely, because without a proxy that overwrites it, it is pure attacker input. The IP feeds
 * login history and per-IP rate limits, so a forgeable value would bypass both.
 */
export function resolveClientIp(headers: Pick<Headers, "get">): string | undefined {
  const hops = trustedProxyHops();
  if (hops === 0) return undefined;
  const entries = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length < hops) return undefined; // fewer entries than trusted proxies: header was not set by them
  const candidate = entries[entries.length - hops];
  return candidate.length <= 64 ? candidate : undefined;
}

/** Builds `ClientInfo` from a request (IP rules: see `resolveClientIp`). */
export function clientInfoFromRequest(req: Request, ctx: { correlationId?: string; sourceApp: SourceApp }): ClientInfo {
  return {
    ipAddress: resolveClientIp(req.headers),
    userAgent: req.headers.get("user-agent")?.slice(0, 500) || undefined,
    correlationId: ctx.correlationId,
    sourceApp: ctx.sourceApp,
  };
}

/**
 * Applies a per-IP rate limit. When no trustworthy IP is known the limit is skipped (and logged)
 * instead of putting every client into one shared bucket, which would let one attacker lock all
 * users out. The per-account limits and the DB lockout still apply in that case.
 */
export function enforceIpRateLimit(client: ClientInfo, name: string, rule: RateLimit): void {
  if (!client.ipAddress) {
    logger.warn("per-IP rate limit skipped: client IP unknown (set LEADRO_TRUSTED_PROXY_HOPS behind a proxy)", {
      limit: name,
    });
    return;
  }
  enforceRateLimit(`${name}:${client.ipAddress}`, rule);
}
