import "server-only";

import { buildReport } from "@/lib/report";
import { rateLimit } from "./rate-limit";

/**
 * Send an error somewhere a person will see it.
 *
 * Off unless VELTO_ERROR_WEBHOOK is set, and that is the whole configuration.
 * The destination can be a Sentry ingest URL, a Slack or Discord webhook, or
 * anything else that accepts a JSON POST - see lib/report.ts for why this is
 * not an SDK.
 *
 * Three rules, and they are the same three that govern the audit log and the
 * email sender:
 *
 *  1. **It never breaks the thing it is reporting on.** Every failure here is
 *     swallowed. An error that could not be reported is still an error that
 *     was handled; turning that into a second, fatal error would be the worst
 *     possible trade.
 *  2. **It never blocks.** The POST is not awaited by the caller. A slow or
 *     dead webhook must not add its timeout to somebody's page load.
 *  3. **It rate limits itself.** A hot loop - a failing query on a page being
 *     polled - would otherwise send thousands of identical reports, bury the
 *     signal and, on a paid plan, cost money. Twenty an hour is enough to
 *     notice a problem and not enough to drown in it.
 */
export function reportError(err: unknown, context: string): void {
  const endpoint = process.env.VELTO_ERROR_WEBHOOK;
  if (!endpoint) return;

  // Keyed on the context rather than globally, so a flood from one screen does
  // not silence a different, rarer failure somewhere else.
  if (!rateLimit(`report:${context}`, 20, 60 * 60_000).ok) return;

  const report = buildReport(err, context);

  // Deliberately not awaited: rule 2. The catch is attached to the promise
  // rather than wrapped in try/catch, because the throw happens later.
  void fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(report),
    // A report is not worth holding a socket open for.
    signal: AbortSignal.timeout(5000),
  }).catch((sendFailure) => {
    // Rule 1. One line, and never a loop - this failure is not itself
    // reported, or a dead webhook would report its own death forever.
    console.error("[velto] error report could not be sent:", sendFailure);
  });
}
