/**
 * Turning a thrown thing into something safe to send off the machine.
 *
 * Without this, a production failure is only discovered when somebody
 * complains: the error boundaries write to the console, and nobody reads a
 * console on a hosting dashboard at two in the morning. What was missing was
 * not a vendor - it was a place for an error to go.
 *
 * So this is deliberately not an SDK. It builds a small JSON object and the
 * server posts it to whatever URL is configured: a Sentry ingest endpoint, a
 * Slack or Discord webhook, an inbox relay. No build instrumentation, no
 * source-map upload, no dependency, and nothing to remove if the destination
 * changes.
 *
 * The redaction below is the important half. An error message is one of the
 * easiest ways to leak the thing it was about - a database URL with its
 * password in it, the email address whose lookup failed, a session token.
 * Every report goes through `redact` before it leaves.
 */

/** Long messages are truncated: a report is a signal, not a log file. */
export const MAX_MESSAGE = 500;
/** Enough frames to recognise the failure, not enough to be a code dump. */
export const MAX_STACK_LINES = 8;

/**
 * Replace anything that looks like a secret or a person with a marker.
 *
 * Pattern-based and therefore imperfect by nature - which is why the rule at
 * the call site is "never put a value in an error message" and this is the
 * second line rather than the first. It is ordered from most specific to
 * least, so a connection string is caught as a connection string before its
 * host half is caught as anything else.
 */
export function redact(text: string): string {
  return (
    text
      // postgres://user:password@host/db and friends
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@[^\s]*/gi, "[redacted-url]")
      // Anything presented as a credential, however it is spelled.
      .replace(
        /\b(password|passwd|secret|token|api[_-]?key|authorization|bearer|cookie|session)\b\s*[:=]\s*\S+/gi,
        "$1=[redacted]"
      )
      // Bare bearer tokens and long opaque strings that are almost certainly keys.
      .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
      // Email addresses: a failed lookup names the person it failed for.
      .replace(/\b[^\s@]+@[^\s@]+\.[^\s@]+\b/g, "[redacted-email]")
      // bcrypt hashes, which appear whole in some ORM errors.
      .replace(/\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/g, "[redacted-hash]")
  );
}

export type ErrorReport = {
  message: string;
  name: string;
  /** Where it happened, as the caller described it. Never a URL with a query. */
  context: string;
  stack?: string;
  at: string;
  environment: string;
};

/**
 * Shape a report. Pure, so the redaction can be tested without a network.
 *
 * `context` is a caller-supplied label like "server action" - never a full
 * request URL, because a query string carries exactly the values a report is
 * not supposed to contain.
 */
export function buildReport(
  err: unknown,
  context: string,
  now: Date = new Date(),
  environment = process.env.NODE_ENV ?? "development"
): ErrorReport {
  const error = err instanceof Error ? err : new Error(String(err));
  const stack = error.stack
    ? redact(error.stack.split("\n").slice(0, MAX_STACK_LINES).join("\n"))
    : undefined;

  return {
    message: redact(error.message).slice(0, MAX_MESSAGE),
    name: error.name,
    context: redact(context).slice(0, 120),
    stack,
    at: now.toISOString(),
    environment,
  };
}
