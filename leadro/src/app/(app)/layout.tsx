import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { TopNav } from "@/components/ui";
import { LocaleSwitcherForPage } from "../_components/LocaleSwitcherForPage";
import { loadShellIdentity } from "../_lib/account-queries";
import { getPageContext } from "../_lib/page-context";
import { AppSidebar } from "./_components/AppSidebar";
import { NotificationBell } from "./_components/NotificationBell";
import { UserMenu } from "./_components/UserMenu";
import { getNavigation } from "./navigation";

/**
 * Authenticated workspace shell. The session is checked here, on the server, for every page in
 * the group: no session -> login; password accepted but MFA outstanding -> the MFA step. The
 * navigation is computed from the actor's permissions on the server, so links the user may not
 * use are never sent to the browser.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const { actor, mfaPending, t } = await getPageContext();
  if (!actor) redirect("/login");
  if (mfaPending) redirect("/login/mfa");

  const [identity, navigation] = await Promise.all([loadShellIdentity(actor), getNavigation(actor)]);
  const items = navigation.map((item) => ({ id: item.id, label: t(item.labelKey), href: item.href }));
  const sidebar = (
    <AppSidebar label={t("SHELL.MAIN_NAVIGATION")} productName={t("SHELL.PRODUCT_NAME")} tenantName={identity.tenantName} items={items} />
  );

  return (
    <div className="flex min-h-screen">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:start-2 focus:top-2 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2"
      >
        {t("SHELL.SKIP_TO_CONTENT")}
      </a>
      <div className="sticky top-0 hidden h-screen md:block">{sidebar}</div>
      <div className="flex min-w-0 flex-1 flex-col">
        <TopNav
          start={
            <details className="relative md:hidden">
              <summary className="cursor-pointer list-none rounded border border-line-strong bg-surface px-3 py-1.5 text-sm">
                {t("SHELL.MENU")}
              </summary>
              <div className="absolute start-0 z-20 mt-2 h-96 shadow-overlay">{sidebar}</div>
            </details>
          }
          end={
            <>
              <LocaleSwitcherForPage />
              <NotificationBell t={t} />
              <UserMenu identity={identity} t={t} />
            </>
          }
        />
        <main id="main-content" className="flex-1 p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
