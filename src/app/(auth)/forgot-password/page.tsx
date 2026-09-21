import type { Metadata } from "next";
import { emailConfigured } from "@/server/email";
import { ForgotPasswordForm } from "./ForgotPasswordForm";

export const metadata: Metadata = { title: "שכחתי סיסמה" };
// The answer depends on the host's configuration, so it cannot be decided at
// build time and baked into a static page.
export const dynamic = "force-dynamic";

/**
 * Asked here rather than only in the action, so the page never shows a form
 * that cannot do anything. A control that does nothing is worse than one that
 * is absent: pressing it and being told "we have sent you a link" is how
 * somebody ends up waiting a day for an email that was never going to come.
 */
export default function ForgotPasswordPage() {
  return <ForgotPasswordForm available={emailConfigured()} />;
}
