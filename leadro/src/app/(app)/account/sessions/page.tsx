import { EmptyState, StatusBadge, buttonClasses } from "@/components/ui";
import { formatDateTime, isolateLtr } from "@/lib/i18n";
import { listOwnSessions } from "@/server/auth";
import { revokeSessionAction } from "../../../_actions/session";
import { requireFullSession } from "../../../_lib/page-context";

/** The signed-in user's own live sessions, with revoke for every session except the current one. */
export default async function SessionsPage() {
  const { actor, locale, timeZone, t } = await requireFullSession();
  const sessions = await listOwnSessions(actor);
  const when = (date: Date) => formatDateTime(date, { locale, timeZone });

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div>
        <h1 className="text-2xl font-bold">{t("ACCOUNT.SESSIONS_TITLE")}</h1>
        <p className="mt-1 text-sm text-ink-muted">{t("ACCOUNT.SESSIONS_INTRO")}</p>
      </div>
      {sessions.length === 0 ? (
        <div className="rounded border border-line bg-surface">
          <EmptyState title={t("ACCOUNT.SESSIONS_EMPTY_TITLE")} description={t("ACCOUNT.SESSIONS_EMPTY_DESCRIPTION")} />
        </div>
      ) : (
        <div className="overflow-x-auto rounded border border-line bg-surface">
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">{t("ACCOUNT.SESSIONS_TITLE")}</caption>
            <thead className="bg-neutral-soft">
              <tr>
                {(["ACCOUNT.COLUMN_DEVICE", "ACCOUNT.COLUMN_SIGNED_IN", "ACCOUNT.COLUMN_LAST_ACTIVE", "ACCOUNT.COLUMN_EXPIRES"] as const).map((key) => (
                  <th key={key} scope="col" className="px-3 py-2 text-start font-semibold">
                    {t(key)}
                  </th>
                ))}
                <th scope="col" className="px-3 py-2 text-start font-semibold">
                  <span className="sr-only">{t("ACCOUNT.COLUMN_ACTIONS")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => (
                <tr key={session.id} className="border-t border-line">
                  <td className="px-3 py-2 text-start">
                    <div dir="ltr" className="max-w-xs truncate text-start" title={session.userAgent ?? undefined}>
                      {session.userAgent ?? t("ACCOUNT.DEVICE_UNKNOWN")}
                    </div>
                    {session.ipAddress ? <div className="text-xs text-ink-muted">{isolateLtr(session.ipAddress)}</div> : null}
                    {session.isCurrent ? (
                      <div className="mt-1">
                        <StatusBadge tone="info" label={t("ACCOUNT.THIS_DEVICE")} />
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-start">{when(session.createdAt)}</td>
                  <td className="px-3 py-2 text-start">{when(session.lastSeenAt)}</td>
                  <td className="px-3 py-2 text-start">{when(session.expiresAt)}</td>
                  <td className="px-3 py-2 text-end">
                    {session.isCurrent ? null : (
                      <form action={revokeSessionAction}>
                        <input type="hidden" name="sessionId" value={session.id} />
                        <button type="submit" className={buttonClasses.secondary}>
                          {t("ACCOUNT.REVOKE")}
                          <span className="sr-only"> {when(session.createdAt)}</span>
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
