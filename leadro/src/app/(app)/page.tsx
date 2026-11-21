import { EmptyState } from "@/components/ui";
import { loadShellIdentity } from "../_lib/account-queries";
import { getPageContext } from "../_lib/page-context";

/**
 * Home. Honest placeholder: no dashboards exist yet, so nothing is drawn that looks like data.
 * (The layout has already guaranteed a signed-in actor.)
 */
export default async function HomePage() {
  const { actor, t } = await getPageContext();
  if (!actor) return null;
  const identity = await loadShellIdentity(actor);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-2xl font-bold">{t("SHELL.HOME_WELCOME", { name: identity.displayName })}</h1>
      <div className="rounded border border-line bg-surface">
        <EmptyState title={t("SHELL.HOME_EMPTY_TITLE")} description={t("SHELL.HOME_EMPTY_DESCRIPTION")} />
      </div>
    </div>
  );
}
