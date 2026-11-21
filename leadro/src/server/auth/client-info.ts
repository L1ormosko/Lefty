import type { SourceApp } from "@/server/core";

/** Facts about the calling client that auth events, audit and rate limits need. */
export interface ClientInfo {
  ipAddress?: string;
  userAgent?: string;
  correlationId?: string;
  sourceApp: SourceApp;
}

/**
 * Builds `ClientInfo` from a request. The IP comes from the first `x-forwarded-for` entry, so it is
 * only trustworthy behind a reverse proxy that overwrites that header (deployment requirement,
 * see README). It feeds login history and rate limiting, never an access decision.
 */
export function clientInfoFromRequest(req: Request, ctx: { correlationId?: string; sourceApp: SourceApp }): ClientInfo {
  const forwardedFor = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return {
    ipAddress: forwardedFor || undefined,
    userAgent: req.headers.get("user-agent")?.slice(0, 500) || undefined,
    correlationId: ctx.correlationId,
    sourceApp: ctx.sourceApp,
  };
}

/** Rate-limit bucket for a client; clients without a known IP share one bucket. */
export function clientKey(client: ClientInfo): string {
  return client.ipAddress ?? "unknown";
}
