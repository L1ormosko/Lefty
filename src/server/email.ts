import "server-only";

/**
 * Transactional email, sent through Resend's REST API via plain fetch - no
 * SDK dependency for one HTTP call.
 *
 * Gated by RESEND_API_KEY. Without it, this no-ops with a console warning
 * instead of throwing: a missing email provider must never break the
 * underlying business operation (a booking still gets approved even if no
 * one could be emailed about it). Wire up the key before relying on this in
 * production - see .env.example.
 *
 * `emailConfigured()` exists because one caller has to ask before acting.
 * Notifications are sent best effort - the notification is in the database
 * either way and the user sees it when they log in - but a password reset IS
 * the email. Telling someone "we have sent you a link" when nothing can be
 * sent leaves them waiting for a message that will never arrive, with no
 * other way into their account.
 */
const RESEND_API_URL = "https://api.resend.com/emails";

let warnedOnce = false;

/**
 * Whether email can be sent at all.
 *
 * A property of the deployment, not of any address - which is what makes it
 * safe to tell an anonymous visitor about.
 */
export function emailConfigured(
  // Only what it reads, so a test can pass a plain object - the same shape
  // seed-config.ts uses for the same reason.
  env: {
    RESEND_API_KEY?: string;
    EMAIL_FROM?: string;
    [key: string]: string | undefined;
  } = process.env
): boolean {
  return !!env.RESEND_API_KEY && !!env.EMAIL_FROM;
}

export type SendResult = "sent" | "not-configured" | "failed";

export async function sendEmail(params: {
  to: string;
  subject: string;
  text: string;
}): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;

  if (!apiKey || !from) {
    if (!warnedOnce) {
      warnedOnce = true;
      console.warn(
        "[velto] RESEND_API_KEY / EMAIL_FROM not configured - emails are not being sent. " +
          "Users only see notifications when they are logged in. See .env.example."
      );
    }
    return "not-configured";
  }

  try {
    const res = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: params.to,
        subject: params.subject,
        text: params.text,
      }),
    });
    if (!res.ok) {
      console.error("[velto] email send failed:", res.status, await res.text().catch(() => ""));
      return "failed";
    }
    return "sent";
  } catch (err) {
    // Same rule as notify(): a failed email must never fail the caller's operation.
    console.error("[velto] email send threw:", err);
    return "failed";
  }
}
