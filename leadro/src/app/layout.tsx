import type { ReactNode } from "react";

export const metadata = { title: "LEADRO" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-US" dir="ltr">
      <body>{children}</body>
    </html>
  );
}
