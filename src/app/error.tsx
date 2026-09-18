"use client";

import { useEffect } from "react";
import Link from "next/link";
import { t } from "@/lib/labels";
import { buttonClass } from "@/components/ui";

/**
 * What a user sees when a page throws.
 *
 * Without this file Next.js renders its own screen: in production a bare
 * "Application error: a client-side exception has occurred", in Hebrew-less
 * English, on a white page with no way back. That is the blank-screen failure
 * the brief rules out.
 *
 * Two deliberate choices:
 *
 *  - The user is told what to do, not what broke. A stack trace or a database
 *    message tells an attacker about the schema and tells everyone else
 *    nothing.
 *  - The detail still reaches the console, and the digest - the id Next.js
 *    assigns to the server-side error - is shown, because it is the one string
 *    that connects "it broke for me at 14:20" to a line in the server log.
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[velto] page error:", error);
  }, [error]);

  return (
    <main className="mx-auto w-full max-w-lg px-4 py-16 text-center">
      <h1 className="text-xl font-semibold text-ink-900">{t("error.title")}</h1>
      <p className="mt-2 text-ink-600">{t("error.body")}</p>

      <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
        <button type="button" onClick={reset} className={buttonClass("primary")}>
          {t("error.retry")}
        </button>
        <Link href="/explore" className={buttonClass("secondary")}>
          {t("nav.explore")}
        </Link>
      </div>

      {error.digest && (
        <p className="mt-6 text-xs text-ink-400">
          {t("error.reference")}: <span dir="ltr">{error.digest}</span>
        </p>
      )}
    </main>
  );
}
