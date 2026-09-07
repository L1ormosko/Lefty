import { requireRole } from "@/server/auth";
import { prisma } from "@/server/db";
import { t } from "@/lib/labels";
import { adminNav } from "@/lib/nav";
import { DashboardShell } from "@/components/DashboardShell";
import { Card, EmptyState, Num } from "@/components/ui";
import { StatusPill } from "@/components/badges";
import { formatDate } from "@/lib/dates";
import { UserActiveToggle } from "@/components/admin/UserActiveToggle";

export const dynamic = "force-dynamic";

export default async function AdminUsers() {
  await requireRole("ADMIN");
  const users = await prisma.user.findMany({
    orderBy: { createdAt: "desc" },
    take: 200,
    include: {
      company: { select: { name: true } },
      _count: { select: { assets: true, inquiries: true, bookings: true } },
    },
  });

  return (
    <DashboardShell title={t("admin.users")} nav={adminNav()} current="/admin/users">
      {users.length === 0 ? (
        <EmptyState title="אין משתמשים." />
      ) : (
        <div className="space-y-2">
          {users.map((u) => (
            <Card key={u.id} className="p-4 flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="font-medium text-ink-900">{u.name}</p>
                <p className="text-sm text-ink-500" dir="ltr">
                  {u.email}
                </p>
                {u.company && <p className="text-sm text-ink-600">{u.company.name}</p>}
              </div>
              <div className="text-xs text-ink-500">
                <Num>{u._count.assets}</Num> {t("admin.assets")} · <Num>{u._count.inquiries}</Num>{" "}
                {t("dash.requests")} · <Num>{u._count.bookings}</Num> {t("dash.bookings")}
              </div>
              <div className="flex items-center gap-2">
                <StatusPill label={t(`role.${u.role}`)} />
                <StatusPill
                  label={u.isActive ? t("status.ACTIVE") : t("status.INACTIVE")}
                  tone={u.isActive ? "ok" : "bad"}
                />
                <span className="text-xs text-ink-400">
                  <Num>{formatDate(u.createdAt)}</Num>
                </span>
                <UserActiveToggle userId={u.id} isActive={u.isActive} />
              </div>
            </Card>
          ))}
        </div>
      )}
    </DashboardShell>
  );
}
