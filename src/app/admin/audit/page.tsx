import { requireRole } from "@/server/auth";
import { countAudit, recentAudit } from "@/server/audit";
import { t } from "@/lib/labels";
import { adminNav } from "@/lib/nav";
import { countOpenRequests } from "@/server/access-requests";
import { DashboardShell } from "@/components/DashboardShell";
import { Card, EmptyState, Num } from "@/components/ui";
import { Pager, pageFromParam, PAGE_SIZE } from "@/components/pager";
import { formatDate } from "@/lib/dates";

export const dynamic = "force-dynamic";

/**
 * The audit trail.
 *
 * Read-only, and there is no filter box, no export and no "clear" button. Each
 * of those is a feature somebody would have to trust, and the whole value of
 * this page is that nothing in the product writes to it except server/audit.ts
 * and nothing at all edits it.
 */
export default async function AdminAudit({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireRole("ADMIN");
  const page = pageFromParam((await searchParams).page);
  const [entries, total] = await Promise.all([
    recentAudit(PAGE_SIZE, (page - 1) * PAGE_SIZE),
    countAudit(),
  ]);

  return (
    <DashboardShell title={t("audit.title")} nav={adminNav({ access: await countOpenRequests() })} current="/admin/audit">
      <p className="mb-3 text-sm text-ink-600 max-w-2xl">{t("audit.lead")}</p>

      {entries.length === 0 ? (
        <EmptyState title={t("audit.empty")} />
      ) : (
        <>
          <div className="space-y-2">
            {entries.map((entry) => (
              <Card key={entry.id} className="p-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="font-medium text-ink-900">{t(`audit.${entry.action}`)}</span>
                <span className="text-sm text-ink-600">
                  {/* An anonymized actor has a deleted-*@velto.invalid address;
                      showing that verbatim would be noise, so it is named for
                      what it is. */}
                  {entry.actor
                    ? entry.actor.email.endsWith("@velto.invalid")
                      ? t("audit.deletedActor")
                      : entry.actor.email
                    : t("audit.system")}
                </span>
                {entry.summary && (
                  <span className="text-sm text-ink-700 break-words">{entry.summary}</span>
                )}
                <span className="ms-auto text-xs text-ink-400" dir="ltr">
                  <Num>{formatDate(entry.createdAt)}</Num>{" "}
                  <Num>{entry.createdAt.toISOString().slice(11, 16)}</Num>
                </span>
                <span className="w-full text-xs text-ink-400" dir="ltr">
                  {entry.targetType}/{entry.targetId}
                </span>
              </Card>
            ))}
          </div>
          <Pager page={page} total={total} basePath="/admin/audit" />
        </>
      )}
    </DashboardShell>
  );
}
