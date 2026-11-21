import type { ReactNode } from "react";
import { LocaleSwitcherForPage } from "../_components/LocaleSwitcherForPage";
import { getPageContext } from "../_lib/page-context";

/** Centered card shell shared by the signed-out screens, with a language switcher (§16). */
export default async function AuthLayout({ children }: { children: ReactNode }) {
  const { t } = await getPageContext();
  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between px-6 py-4">
        <span className="text-lg font-bold text-brand-700">{t("SHELL.PRODUCT_NAME")}</span>
        <LocaleSwitcherForPage />
      </header>
      <main className="flex flex-1 items-start justify-center px-4 pb-12 pt-8">
        <div className="w-full max-w-md rounded border border-line bg-surface p-6 shadow-sm">{children}</div>
      </main>
    </div>
  );
}
