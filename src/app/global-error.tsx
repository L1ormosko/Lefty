"use client";

import { useEffect } from "react";

/**
 * The last resort: an error in the root layout itself.
 *
 * This one replaces <html> entirely, so it cannot use the site header, the
 * fonts or anything else from the layout that just failed - which is also why
 * its text is inline rather than from labels.ts. Keeping it dependency-free is
 * the whole point: a global error handler that can itself throw leaves the
 * user with a genuinely blank page.
 */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    console.error("[velto] global error:", error);
  }, [error]);

  return (
    <html lang="he" dir="rtl">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          fontFamily: "system-ui, sans-serif",
          background: "#f7f8fa",
          color: "#191d26",
          padding: "1.5rem",
        }}
      >
        <main style={{ textAlign: "center", maxWidth: "32rem" }}>
          <h1 style={{ fontSize: "1.25rem", margin: "0 0 0.5rem" }}>אירעה שגיאה בטעינת האתר</h1>
          <p style={{ margin: "0 0 1.5rem", color: "#5b6472" }}>
            נסו לרענן את העמוד. אם זה חוזר, כתבו לנו ל־support@velto.co.il.
          </p>
          <a
            href="/"
            style={{
              display: "inline-block",
              background: "#1f45d6",
              color: "#fff",
              padding: "0.625rem 1.25rem",
              borderRadius: "0.375rem",
              textDecoration: "none",
            }}
          >
            חזרה לדף הבית
          </a>
          {error.digest && (
            <p style={{ marginTop: "1.5rem", fontSize: "0.75rem", color: "#9aa3b2" }}>
              מזהה תקלה: <span dir="ltr">{error.digest}</span>
            </p>
          )}
        </main>
      </body>
    </html>
  );
}
