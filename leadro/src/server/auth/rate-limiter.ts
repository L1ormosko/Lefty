/**
 * In-memory fixed-window rate limiter for the unauthenticated auth endpoints (§22.1).
 *
 * Trade-off (documented in README): state is per server process, so with N instances the
 * effective limit is up to N times higher. That is acceptable here because the per-account
 * lockout (stored in the database) is the real brute-force control; this limiter only blunts
 * floods and cheap enumeration. Swap for a shared store (Redis/DB) when running multiple instances.
 */
import { RateLimitedError } from "@/server/core";

export interface RateLimit {
  limit: number;
  windowMs: number;
}

interface Window {
  startedAt: number;
  count: number;
}

const MAX_TRACKED_KEYS = 50_000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const windows = new Map<string, Window>();

function evictExpired(now: number): void {
  for (const [key, window] of windows) {
    // Windows have different lengths; anything older than a day is certainly expired.
    if (now - window.startedAt > ONE_DAY_MS) windows.delete(key);
  }
}

/**
 * Counts one hit for `key`.
 * @returns whether the hit is within the limit, and how long until the window resets.
 */
export function hitRateLimit(
  key: string,
  { limit, windowMs }: RateLimit,
  now = Date.now(),
): { allowed: boolean; retryAfterSeconds: number } {
  if (windows.size > MAX_TRACKED_KEYS) evictExpired(now);
  let window = windows.get(key);
  if (!window || now - window.startedAt >= windowMs) {
    window = { startedAt: now, count: 0 };
    windows.set(key, window);
  }
  window.count += 1;
  return {
    allowed: window.count <= limit,
    retryAfterSeconds: Math.max(1, Math.ceil((window.startedAt + windowMs - now) / 1000)),
  };
}

/** Like `hitRateLimit` but throws `RateLimitedError` (HTTP 429 + Retry-After) when exceeded. */
export function enforceRateLimit(key: string, rule: RateLimit): void {
  const result = hitRateLimit(key, rule);
  if (!result.allowed) throw new RateLimitedError({ retryAfterSeconds: result.retryAfterSeconds });
}

/** Test helper: forget all counters. */
export function resetRateLimits(): void {
  windows.clear();
}
