import { requireRole } from "@/server/auth";
import { t } from "@/lib/labels";
import { ownerNav } from "@/lib/nav";
import { DashboardShell } from "@/components/DashboardShell";
import { NotificationsList } from "@/components/NotificationsList";

export const dynamic = "force-dynamic";

export default async function OwnerNotifications() {
  const user = await requireRole("MEDIA_OWNER");
  return (
    <DashboardShell title={t("nav.notifications")} nav={ownerNav()} current="/owner/notifications">
      <NotificationsList userId={user.id} />
    </DashboardShell>
  );
}
