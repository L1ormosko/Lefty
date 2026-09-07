import { requireUser } from "@/server/auth";
import { prisma } from "@/server/db";
import { t } from "@/lib/labels";
import { advertiserNav } from "@/lib/nav";
import { DashboardShell } from "@/components/DashboardShell";
import { Card } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function Profile() {
  const user = await requireUser();
  const company = user.companyId
    ? await prisma.company.findUnique({ where: { id: user.companyId } })
    : null;

  const rows: [string, string][] = [
    [t("auth.name"), user.name],
    [t("auth.email"), user.email],
    [t("auth.phone"), user.phone ?? t("common.notProvided")],
    [t("auth.role"), t(`role.${user.role}`)],
    [t("auth.companyName"), company?.name ?? t("common.notProvided")],
  ];

  return (
    <DashboardShell title={t("dash.profile")} nav={advertiserNav()} current="/dashboard/profile">
      <Card className="p-5">
        <dl className="space-y-3">
          {rows.map(([label, value]) => (
            <div key={label} className="flex gap-4">
              <dt className="w-32 shrink-0 text-sm text-ink-500">{label}</dt>
              <dd className="text-sm text-ink-900">{value}</dd>
            </div>
          ))}
        </dl>
      </Card>
    </DashboardShell>
  );
}
