import Link from "next/link";
import { requireRole } from "@/server/auth";
import { countOpenRequests, openRequests } from "@/server/access-requests";
import { t } from "@/lib/labels";
import { adminNav } from "@/lib/nav";
import { access, type AccessState } from "@/lib/subscription";
import { formatDate } from "@/lib/dates";
import { DashboardShell } from "@/components/DashboardShell";
import { EmptyState, Num } from "@/components/ui";
import { RowList } from "@/components/lists";
import { StatusPill } from "@/components/badges";
import { ResolveAccessForm } from "@/components/admin/ResolveAccessForm";

export const dynamic = "force-dynamic";

/**
 * Explicit rather than built from the state name: the "none" case is keyed
 * `plan.none`, not `plan.stateNone`, so a template would have silently
 * rendered the key itself - and that is the state most of this queue is in.
 */
const STATE_LABELS: Record<AccessState, string> = {
  paid: "plan.statePaid",
  trial: "plan.stateTrial",
  lapsed: "plan.stateLapsed",
  none: "plan.none",
};

/**
 * The queue of people waiting to be let in.
 *
 * This is the other end of /access. Closing a row here does not grant
 * anything - the subscription goes in on /admin/users against an invoice -
 * and the note at the top says so, because a button labelled "handled" sitting
 * next to a paywall invites exactly that assumption.
 */
export default async function AdminAccessRequests() {
  await requireRole("ADMIN");
  const requests = await openRequests();

  return (
    <DashboardShell title={t("admin.accessRequests")} nav={adminNav({ access: await countOpenRequests() })} current="/admin/access">
      <p className="mb-4 text-sm text-ink-600">{t("admin.accessHint")}</p>

      {requests.length === 0 ? (
        <EmptyState title={t("admin.accessEmpty")} />
      ) : (
        <RowList>
          {requests.map((request) => {
            const state = access(request.user.subscription).state;
            return (
              <div key={request.id} className="p-4">
                <div className="flex flex-wrap items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-ink-900">{request.user.name}</p>
                    <p className="text-sm text-ink-500" dir="ltr">
                      {request.user.email}
                    </p>
                    {request.user.company && (
                      <p className="text-sm text-ink-600">{request.user.company.name}</p>
                    )}
                    {request.user.phone && (
                      <p className="text-sm text-ink-600">
                        <Num>{request.user.phone}</Num>
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <StatusPill label={t(`role.${request.user.role}`)} />
                    <StatusPill
                      label={t(STATE_LABELS[state])}
                      tone={state === "paid" ? "ok" : state === "trial" ? "warn" : "neutral"}
                    />
                    <span className="text-xs text-ink-400">
                      <Num>{formatDate(request.createdAt)}</Num>
                    </span>
                  </div>
                </div>

                {request.message && (
                  <p className="mt-3 border-s-2 border-brand-500 ps-3 text-sm text-ink-800 whitespace-pre-line">
                    {request.message}
                  </p>
                )}

                {/* Straight to where the subscription is actually recorded,
                    pre-searched for this person - the admin should not have to
                    copy an email address between two screens. */}
                <p className="mt-3 text-sm">
                  <Link
                    href={`/admin/users?q=${encodeURIComponent(request.user.email)}`}
                    className="text-brand-600 hover:underline"
                  >
                    {t("admin.accessSetPlan")} ←
                  </Link>
                </p>

                <ResolveAccessForm requestId={request.id} />
              </div>
            );
          })}
        </RowList>
      )}
    </DashboardShell>
  );
}
