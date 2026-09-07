import { prisma } from "@/server/db";
import { t } from "@/lib/labels";
import { formatDate } from "@/lib/dates";
import { Card, EmptyState, Num } from "./ui";
import Link from "next/link";
import { markAllReadAction } from "@/app/actions/notifications";

export async function NotificationsList({ userId }: { userId: string }) {
  const items = await prisma.notification.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  if (items.length === 0) return <EmptyState title={t("notif.empty")} />;

  return (
    <div className="space-y-3">
      <form action={markAllReadAction}>
        <button type="submit" className="text-sm text-brand-600 hover:underline">
          {t("notif.markRead")}
        </button>
      </form>
      {items.map((n) => {
        const body = (
          <>
            <div className="flex items-start gap-2">
              {!n.readAt && <span className="mt-1.5 size-2 rounded-full bg-brand-600 shrink-0" aria-label="חדש" />}
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink-900">{n.title}</p>
                {n.body && <p className="text-sm text-ink-600 mt-0.5">{n.body}</p>}
                <p className="text-xs text-ink-400 mt-1">
                  <Num>{formatDate(n.createdAt)}</Num>
                </p>
              </div>
            </div>
          </>
        );
        return (
          <Card key={n.id} className="p-4">
            {n.linkUrl ? (
              <Link href={n.linkUrl} className="block hover:opacity-80">
                {body}
              </Link>
            ) : (
              body
            )}
          </Card>
        );
      })}
    </div>
  );
}
