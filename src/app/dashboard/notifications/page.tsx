import { requireUser } from "@/server/auth";
import { t } from "@/lib/labels";
import { advertiserNav } from "@/lib/nav";
import { DashboardShell } from "@/components/DashboardShell";
import { NotificationsList } from "@/components/NotificationsList";

export const dynamic = "force-dynamic";

export default async function AdvertiserNotifications() {
  const user = await requireUser();
  return (
    <DashboardShell title={t("nav.notifications")} nav={advertiserNav()} current="/dashboard/notifications">
      <NotificationsList userId={user.id} />
    </DashboardShell>
  );
}
