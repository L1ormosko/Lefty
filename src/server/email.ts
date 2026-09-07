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
 */
const RESEND_API_URL = "https://api.resend.com/emails";

let warnedOnce = false;

export async function sendEmail(params: { to: string; subject: string; text: string }): Promise<void> {
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
    return;
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
    }
  } catch (err) {
    // Same rule as notify(): a failed email must never fail the caller's operation.
    console.error("[velto] email send threw:", err);
  }
}
