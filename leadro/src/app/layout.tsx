import type { ReactNode } from "react";
import "./globals.css";
import { getPageContext } from "./_lib/page-context";

export const metadata = { title: "LEADRO" };

/**
 * Root layout: sets `<html lang dir>` from the resolved locale (§16.2, §16.4). Signed in:
 * user -> branch -> company -> en-US. Signed out: `leadro_locale` cookie, then Accept-Language,
 * then en-US. `he-IL` therefore renders `dir="rtl"` on every page, with no per-page code.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const { locale, direction } = await getPageContext();
  return (
    <html lang={locale} dir={direction}>
      <body>{children}</body>
    </html>
  );
}
