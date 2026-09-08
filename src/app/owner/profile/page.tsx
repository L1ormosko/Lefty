import { loadAccountPage } from "@/server/account-page";
import { t } from "@/lib/labels";
import { ownerNav } from "@/lib/nav";
import { DashboardShell } from "@/components/DashboardShell";
import { AccountForms } from "@/components/account/AccountForms";

export const dynamic = "force-dynamic";

/**
 * Media owners had no account page at all - ownerNav simply did not have one -
 * so a media owner could never correct a mistyped phone number, let alone see
 * or delete their data. Same surface as the advertiser page, different shell.
 */
export default async function OwnerProfile() {
  const { data, deletionBlocked } = await loadAccountPage();

  return (
    <DashboardShell title={t("dash.profile")} nav={ownerNav()} current="/owner/profile">
      <AccountForms data={data} deletionBlocked={deletionBlocked} />
    </DashboardShell>
  );
}
