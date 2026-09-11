import type { Metadata, Viewport } from "next";
import "./globals.css";
import { heebo } from "./fonts";
import { t } from "@/lib/labels";
import { SiteHeader } from "@/components/SiteHeader";
import { getCurrentUser } from "@/server/auth";
import { unreadCount } from "@/server/notifications";

const OG_IMAGE = {
  url: "/og.png",
  width: 1200,
  height: 630,
  alt: "VELTO — שטחי פרסום חוץ בישראל, על מפה אחת",
};

export const metadata: Metadata = {
  title: { default: "VELTO — שטחי פרסום חוץ בישראל", template: "%s | VELTO" },
  description: t("app.tagline"),
  applicationName: t("app.name"),
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icon.png", sizes: "512x512", type: "image/png" },
    ],
    apple: "/apple-icon.png",
  },
  /*
   * The share card. Until this existed, openGraph was declared with no images,
   * so every VELTO link pasted into WhatsApp - the channel this market actually
   * runs on - rendered as a grey box with a default browser icon.
   */
  openGraph: {
    title: "VELTO — שטחי פרסום חוץ בישראל",
    description: t("app.tagline"),
    type: "website",
    locale: "he_IL",
    siteName: t("app.name"),
    images: [OG_IMAGE],
  },
  twitter: {
    card: "summary_large_image",
    title: "VELTO — שטחי פרסום חוץ בישראל",
    description: t("app.tagline"),
    images: [OG_IMAGE.url],
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
    <html lang="he" dir="rtl" className={heebo.variable}>
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
