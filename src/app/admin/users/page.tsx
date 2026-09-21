import { requireRole } from "@/server/auth";
import { prisma } from "@/server/db";
import { t } from "@/lib/labels";
import { adminNav } from "@/lib/nav";
import { countOpenRequests } from "@/server/access-requests";
import { DashboardShell } from "@/components/DashboardShell";
import { Button, Card, EmptyState, LinkButton, Num, inputClass } from "@/components/ui";
import { StatusPill } from "@/components/badges";
import { formatDate } from "@/lib/dates";
import { UserActiveToggle } from "@/components/admin/UserActiveToggle";
import { UserRoleForm } from "@/components/admin/UserRoleForm";
import { OwnerPlanForm } from "@/components/admin/OwnerPlanForm";
import { access } from "@/lib/subscription";
import { Pager, pageFromParam, skipFor, PAGE_SIZE } from "@/components/pager";

export const dynamic = "force-dynamic";

export default async function AdminUsers({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireRole("ADMIN");
  const params = await searchParams;
  const page = pageFromParam(params.page);
  // Moderation starts with "find this person". With the list paged, scrolling
  // is not a search, and an admin handling a support mail has an email address
  // and nothing else.
  const rawQuery = Array.isArray(params.q) ? params.q[0] : params.q;
  const query = (rawQuery ?? "").trim().slice(0, 120);
  const where = query
    ? {
        OR: [
          { email: { contains: query, mode: "insensitive" as const } },
          { name: { contains: query, mode: "insensitive" as const } },
          { company: { name: { contains: query, mode: "insensitive" as const } } },
        ],
      }
    : {};

  const userTotal = await prisma.user.count({ where });
  const users = await prisma.user.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: PAGE_SIZE,
    skip: skipFor(page),
    include: {
      company: { select: { name: true } },
      subscription: {
        select: {
          activeListingLimit: true,
          paidThrough: true,
          committedUntil: true,
          monthlyAmount: true,
          invoiceRef: true,
          trialEndsAt: true,
        },
      },
      _count: { select: { assets: true, inquiries: true, bookings: true } },
    },
  });

  return (
    <DashboardShell title={t("admin.users")} nav={adminNav({ access: await countOpenRequests() })} current="/admin/users">
      {/* A GET form: the search is in the URL, so a result set survives a
          refresh and can be handed to a colleague. */}
      <form method="get" action="/admin/users" className="mb-4 flex flex-wrap gap-2">
        <input
          type="search"
          name="q"
          defaultValue={query}
          placeholder={t("admin.searchUsers")}
          aria-label={t("admin.searchUsers")}
          className={`${inputClass} max-w-xs`}
        />
        <Button type="submit" size="sm" variant="secondary">
          {t("admin.search")}
        </Button>
        {query && (
          <LinkButton href="/admin/users" size="sm" variant="ghost">
            {t("admin.clearSearch")}
          </LinkButton>
        )}
      </form>

      {users.length === 0 ? (
        <EmptyState title={query ? t("admin.noUserMatch") : "אין משתמשים."} />
      ) : (
        <>
        <div className="space-y-2">
          {users.map((u) => (
            // data-user mirrors data-asset on the map results: a stable hook
            // for a row whose text is otherwise all user-supplied.
            <div key={u.id} data-user={u.email}>
            <Card className="p-4 flex flex-wrap items-center gap-3">
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
              {/* How an admin gets appointed. Without this the only admin the
                  platform would ever have is whoever the seed created, because
                  the production database takes no external connections. */}
              <UserRoleForm userId={u.id} role={u.role} />
              {/* Both sides pay: an advertiser subscribes for access to the
                  inventory, an owner for how much of it they may publish.
                  Admins need no record - they already see everything. */}
              {u.role !== "ADMIN" && (
                <OwnerPlanForm
                  userId={u.id}
                  role={u.role}
                  accessState={access(u.subscription).state}
                  limit={u.subscription?.activeListingLimit ?? null}
                  paidThrough={u.subscription?.paidThrough?.toISOString().slice(0, 10) ?? null}
                  committedUntil={u.subscription?.committedUntil?.toISOString().slice(0, 10) ?? null}
                  monthlyAmount={u.subscription?.monthlyAmount ?? null}
                  invoiceRef={u.subscription?.invoiceRef ?? null}
                />
              )}
            </Card>
            </div>
          ))}
        </div>
        <Pager page={page} total={userTotal} basePath="/admin/users" params={{ q: query || undefined }} />
        </>
      )}
    </DashboardShell>
  );
}
