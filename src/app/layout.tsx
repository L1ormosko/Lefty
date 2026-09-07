import type { Metadata, Viewport } from "next";
import "./globals.css";
import { t } from "@/lib/labels";
import { SiteHeader } from "@/components/SiteHeader";
import { getCurrentUser } from "@/server/auth";
import { unreadCount } from "@/server/notifications";

export const metadata: Metadata = {
  title: { default: "VELTO — שטחי פרסום חוץ בישראל", template: "%s | VELTO" },
  description: t("app.tagline"),
  openGraph: {
    title: "VELTO — שטחי פרסום חוץ בישראל",
    description: t("app.tagline"),
    type: "website",
    locale: "he_IL",
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  themeColor: "#191d26",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  const notifications = user ? await unreadCount(user.id) : 0;

  return (
    <html lang="he" dir="rtl">
      <body className="min-h-dvh flex flex-col">
        <a href="#main" className="skip-link">
          {t("nav.skipToContent")}
        </a>
        <SiteHeader user={user} unread={notifications} />
        <div id="main" className="flex-1 flex flex-col">
          {children}
        </div>
      </body>
    </html>
  );
}
